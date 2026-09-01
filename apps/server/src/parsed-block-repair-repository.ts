import { createHash } from "node:crypto";
import { SOL_MINT, type IndexedSpotSwap, type WalletIndexTransaction } from "@copylab/shared";
import { redactSensitiveText } from "@copylab/providers";
import type { Repository } from "./repository.js";
import {
  KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
  KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
  KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
  PARSED_BLOCK_REPAIR_DECODER_VERSION,
  PARSED_BLOCK_REPAIR_VERSION,
  type ApplyParsedBlockRepairInput,
  type CreateParsedBlockRepairManifestInput,
  type ParsedBlockRepairCoverage,
  type ParsedBlockRepairItem,
  type ParsedBlockRepairItemStatus,
  type ParsedBlockRepairManifest,
  type ParsedBlockRepairManifestStatus
} from "./parsed-block-repair-types.js";

const DEFAULT_MAXIMUM_REPAIR_ITEMS = 100_000;
const ABSOLUTE_MAXIMUM_REPAIR_ITEMS = 250_000;

const encode = (value: unknown): string => JSON.stringify(value);
const decode = <T>(value: string): T => JSON.parse(value) as T;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

interface ManifestRow {
  id: string;
  repair_version: string;
  decoder_version: string;
  source_run_id: string;
  source_run_started_at: string;
  cutoff_at: string;
  status: ParsedBlockRepairManifestStatus;
  maximum_items: number;
  item_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
}

interface ItemRow {
  manifest_id: string;
  signature: string;
  slot: number;
  source_programs_json: string;
  source_indexed_at: string;
  source_transaction_digest: string;
  status: ParsedBlockRepairItemStatus;
  attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  leased_at: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  result_swap_count: number | null;
  hydration_provenance: ParsedBlockRepairItem["hydrationProvenance"] | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function manifestFromRow(row: ManifestRow): ParsedBlockRepairManifest {
  return {
    id: row.id,
    repairVersion: row.repair_version,
    decoderVersion: row.decoder_version,
    sourceRunId: row.source_run_id,
    sourceRunStartedAt: row.source_run_started_at,
    cutoffAt: row.cutoff_at,
    status: row.status,
    maximumItems: row.maximum_items,
    itemCount: row.item_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {})
  };
}

function itemFromRow(row: ItemRow): ParsedBlockRepairItem {
  return {
    manifestId: row.manifest_id,
    signature: row.signature,
    slot: row.slot,
    sourcePrograms: decode<string[]>(row.source_programs_json),
    sourceIndexedAt: row.source_indexed_at,
    sourceTransactionDigest: row.source_transaction_digest,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.leased_at ? { leasedAt: row.leased_at } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.result_swap_count !== null ? { resultSwapCount: row.result_swap_count } : {}),
    ...(row.hydration_provenance ? { hydrationProvenance: row.hydration_provenance } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {})
  };
}

function boundedMaximum(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAXIMUM_REPAIR_ITEMS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > ABSOLUTE_MAXIMUM_REPAIR_ITEMS) {
    throw new RangeError(
      `Parsed-block repair maximumItems must be between 1 and ${ABSOLUTE_MAXIMUM_REPAIR_ITEMS}.`
    );
  }
  return maximum;
}

function validDate(value: string, label: string): void {
  if (!value.trim() || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
}

/**
 * An isolated repository for the repair queue. It intentionally receives the
 * main Repository only to share its SQLite handle and redacted audit sink;
 * none of the original wallet-index run counters are updated here.
 */
export class ParsedBlockRepairRepository {
  constructor(private readonly repository: Repository) {}

  createManifest(input: CreateParsedBlockRepairManifestInput): ParsedBlockRepairManifest {
    const repairVersion = input.repairVersion ?? PARSED_BLOCK_REPAIR_VERSION;
    const decoderVersion = input.decoderVersion ?? PARSED_BLOCK_REPAIR_DECODER_VERSION;
    const maximumItems = boundedMaximum(input.maximumItems);
    const createdAt = (input.at ?? new Date()).toISOString();
    const cutoffAt = input.cutoffAt;
    if (!input.sourceRunId.trim()) throw new Error("Parsed-block repair source run is required.");
    if (!repairVersion.trim() || !decoderVersion.trim()) {
      throw new Error("Parsed-block repair and decoder versions are required.");
    }
    validDate(input.sourceRunStartedAt, "Parsed-block repair source run start");
    validDate(cutoffAt, "Parsed-block repair cutoff");
    if (Date.parse(cutoffAt) > Date.parse(createdAt)) {
      throw new Error("The repair cutoff cannot be later than manifest creation.");
    }

    const existing = this.repository.db.prepare(`
      SELECT * FROM parsed_block_repair_manifests
      WHERE source_run_id = ? AND repair_version = ?
    `).get(input.sourceRunId, repairVersion) as ManifestRow | undefined;
    if (existing) {
      if (
        existing.source_run_started_at !== input.sourceRunStartedAt ||
        existing.cutoff_at !== cutoffAt ||
        existing.decoder_version !== decoderVersion ||
        existing.maximum_items !== maximumItems
      ) {
        throw new Error("The existing repair manifest does not match the requested immutable configuration.");
      }
      return manifestFromRow(existing);
    }

    const manifestId = `parsed-block:${digest(`${input.sourceRunId}:${repairVersion}`).slice(0, 32)}`;
    const created = this.repository.db.transaction(() => {
      const sourceRun = this.repository.db.prepare(`
        SELECT id, started_at FROM wallet_index_runs WHERE id = ?
      `).get(input.sourceRunId) as { id: string; started_at: string } | undefined;
      if (!sourceRun || sourceRun.started_at !== input.sourceRunStartedAt) {
        throw new Error("The affected wallet-index run and exact start timestamp were not found.");
      }
      if (Date.parse(cutoffAt) < Date.parse(sourceRun.started_at)) {
        throw new Error("The repair cutoff predates the affected wallet-index run.");
      }

      const candidates = this.repository.db.prepare(`
        WITH successful_run_rows AS (
          SELECT indexed_tx.signature,
                 indexed_tx.slot,
                 indexed_tx.indexed_at,
                 indexed_tx.transaction_json
          FROM indexed_transactions AS indexed_tx
          JOIN index_signature_queue AS queue ON queue.signature = indexed_tx.signature
          WHERE indexed_tx.success = 1
            AND indexed_tx.slot IS NOT NULL
            AND indexed_tx.slot >= 0
            AND indexed_tx.indexed_at >= ?
            AND indexed_tx.indexed_at <= ?
            AND EXISTS (
              SELECT 1 FROM index_signature_sources AS source
              WHERE source.signature = indexed_tx.signature
                AND source.source = 'helius-program-signature'
                AND (source.first_run_id = ? OR source.last_run_id = ?)
            )
        ), eligible_slots AS (
          SELECT slot
          FROM successful_run_rows
          GROUP BY slot
          HAVING COUNT(*) >= 2
        )
        SELECT row.signature,
               row.slot,
               row.indexed_at,
               row.transaction_json,
               (
                 SELECT json_group_array(program.source_address)
                 FROM (
                   SELECT DISTINCT source.source_address
                   FROM index_signature_sources AS source
                   WHERE source.signature = row.signature
                     AND source.source = 'helius-program-signature'
                     AND (source.first_run_id = ? OR source.last_run_id = ?)
                   ORDER BY source.source_address
                 ) AS program
               ) AS source_programs_json
        FROM successful_run_rows AS row
        JOIN eligible_slots AS slot ON slot.slot = row.slot
        WHERE NOT EXISTS (
          SELECT 1 FROM index_signature_sources AS deep_source
          WHERE deep_source.signature = row.signature
            AND deep_source.source = 'helius-wallet-deep-history'
        )
          AND NOT EXISTS (
            SELECT 1 FROM indexed_spot_swaps AS swap
            WHERE swap.signature = row.signature
          )
        ORDER BY row.slot, row.indexed_at, row.signature
        LIMIT ?
      `).all(
        sourceRun.started_at,
        cutoffAt,
        input.sourceRunId,
        input.sourceRunId,
        input.sourceRunId,
        input.sourceRunId,
        maximumItems + 1
      ) as Array<{
        signature: string;
        slot: number;
        indexed_at: string;
        transaction_json: string;
        source_programs_json: string;
      }>;
      if (candidates.length > maximumItems) {
        throw new Error(
          `The frozen repair selection exceeds its ${maximumItems}-item safety bound; no manifest was created.`
        );
      }

      this.repository.db.prepare(`
        INSERT INTO parsed_block_repair_manifests(
          id, repair_version, decoder_version, source_run_id,
          source_run_started_at, cutoff_at, status, maximum_items,
          item_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
      `).run(
        manifestId,
        repairVersion,
        decoderVersion,
        input.sourceRunId,
        sourceRun.started_at,
        cutoffAt,
        maximumItems,
        candidates.length,
        createdAt,
        createdAt
      );
      const insertItem = this.repository.db.prepare(`
        INSERT INTO parsed_block_repair_items(
          manifest_id, signature, slot, source_programs_json,
          source_indexed_at, source_transaction_digest, status, attempts,
          available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)
      `);
      for (const candidate of candidates) {
        const programs = decode<unknown>(candidate.source_programs_json);
        if (!Array.isArray(programs) || programs.length === 0 || programs.some((value) => typeof value !== "string")) {
          throw new Error("A frozen repair candidate has no valid program source.");
        }
        insertItem.run(
          manifestId,
          candidate.signature,
          candidate.slot,
          candidate.source_programs_json,
          candidate.indexed_at,
          digest(candidate.transaction_json),
          createdAt,
          createdAt,
          createdAt
        );
      }
      return this.getManifest(manifestId);
    })();
    if (!created) throw new Error("The parsed-block repair manifest was not persisted.");
    this.repository.audit(
      "parsed_block_repair_manifest_created",
      "A bounded parsed-block repair manifest was frozen; no historical row was changed.",
      {
        manifestId: created.id,
        repairVersion: created.repairVersion,
        decoderVersion: created.decoderVersion,
        sourceRunId: created.sourceRunId,
        sourceRunStartedAt: created.sourceRunStartedAt,
        cutoffAt: created.cutoffAt,
        itemCount: created.itemCount,
        maximumItems: created.maximumItems
      }
    );
    return created.itemCount === 0
      ? this.refreshManifestStatus(created.id, input.at ?? new Date()) ?? created
      : created;
  }

  /**
   * Runtime startup calls this once. Machines without the exact affected run
   * are untouched; machines with it freeze the one versioned manifest at the
   * known pre-fix horizon and can then resume it idempotently.
   */
  ensureKnownAffectedManifest(at = new Date()): ParsedBlockRepairManifest | undefined {
    const sourceRun = this.repository.getWalletIndexRun(KNOWN_AFFECTED_WALLET_INDEX_RUN_ID);
    if (!sourceRun) return undefined;
    if (sourceRun.startedAt !== KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT) {
      throw new Error("The known affected wallet-index run id has an unexpected start timestamp.");
    }
    return this.createManifest({
      sourceRunId: KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
      sourceRunStartedAt: KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
      cutoffAt: KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
      at
    });
  }

  manifestPrograms(manifestId: string): string[] {
    return (this.repository.db.prepare(`
      SELECT DISTINCT value AS program
      FROM parsed_block_repair_items AS item, json_each(item.source_programs_json)
      WHERE item.manifest_id = ? AND json_each.type = 'text'
      ORDER BY value
    `).all(manifestId) as Array<{ program: string }>).map((row) => row.program);
  }

  getManifest(id: string): ParsedBlockRepairManifest | undefined {
    const row = this.repository.db.prepare(`
      SELECT * FROM parsed_block_repair_manifests WHERE id = ?
    `).get(id) as ManifestRow | undefined;
    return row ? manifestFromRow(row) : undefined;
  }

  activeManifest(): ParsedBlockRepairManifest | undefined {
    const row = this.repository.db.prepare(`
      SELECT * FROM parsed_block_repair_manifests
      WHERE status IN ('PENDING', 'RUNNING')
      ORDER BY created_at, id LIMIT 1
    `).get() as ManifestRow | undefined;
    return row ? manifestFromRow(row) : undefined;
  }

  latestManifest(): ParsedBlockRepairManifest | undefined {
    const row = this.repository.db.prepare(`
      SELECT * FROM parsed_block_repair_manifests ORDER BY created_at DESC, id DESC LIMIT 1
    `).get() as ManifestRow | undefined;
    return row ? manifestFromRow(row) : undefined;
  }

  listItems(manifestId: string, limit = 1_000): ParsedBlockRepairItem[] {
    const bounded = Math.max(0, Math.min(250_000, Math.trunc(limit)));
    return (this.repository.db.prepare(`
      SELECT * FROM parsed_block_repair_items
      WHERE manifest_id = ? ORDER BY slot, source_indexed_at, signature LIMIT ?
    `).all(manifestId, bounded) as ItemRow[]).map(itemFromRow);
  }

  getItem(manifestId: string, signature: string): ParsedBlockRepairItem | undefined {
    const row = this.repository.db.prepare(`
      SELECT * FROM parsed_block_repair_items WHERE manifest_id = ? AND signature = ?
    `).get(manifestId, signature) as ItemRow | undefined;
    return row ? itemFromRow(row) : undefined;
  }

  coverage(manifestId?: string, at = new Date()): ParsedBlockRepairCoverage {
    const manifest = manifestId ? this.getManifest(manifestId) : this.latestManifest();
    if (!manifest) {
      return {
        capturedAt: at.toISOString(),
        total: 0,
        pending: 0,
        leased: 0,
        retry: 0,
        recovered: 0,
        validZero: 0,
        failed: 0,
        recoveredSwaps: 0
      };
    }
    const rows = this.repository.db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(result_swap_count), 0) AS swaps
      FROM parsed_block_repair_items WHERE manifest_id = ? GROUP BY status
    `).all(manifest.id) as Array<{ status: ParsedBlockRepairItemStatus; count: number; swaps: number }>;
    const counts = new Map(rows.map((row) => [row.status, row]));
    return {
      manifest,
      capturedAt: at.toISOString(),
      total: manifest.itemCount,
      pending: counts.get("PENDING")?.count ?? 0,
      leased: counts.get("LEASED")?.count ?? 0,
      retry: counts.get("RETRY")?.count ?? 0,
      recovered: counts.get("RECOVERED")?.count ?? 0,
      validZero: counts.get("VALID_ZERO")?.count ?? 0,
      failed: counts.get("FAILED")?.count ?? 0,
      recoveredSwaps: counts.get("RECOVERED")?.swaps ?? 0
    };
  }

  recoverExpiredLeases(at = new Date()): number {
    const timestamp = at.toISOString();
    const changed = this.repository.db.prepare(`
      UPDATE parsed_block_repair_items SET
        status = 'RETRY', available_at = ?, lease_owner = NULL,
        lease_token = NULL, leased_at = NULL, lease_expires_at = NULL,
        last_error = COALESCE(last_error, 'Repair lease expired before acknowledgement.'),
        updated_at = ?
      WHERE status = 'LEASED' AND lease_expires_at <= ?
    `).run(timestamp, timestamp, timestamp).changes;
    if (changed > 0) this.refreshAllManifestStatuses(at);
    return changed;
  }

  leaseNextSlot(
    manifestId: string,
    workerId: string,
    limit = 250,
    leaseDurationSeconds = 120,
    at = new Date()
  ): ParsedBlockRepairItem[] {
    if (!workerId.trim()) throw new Error("Parsed-block repair worker id is required.");
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    if (!Number.isFinite(leaseDurationSeconds) || leaseDurationSeconds <= 0) {
      throw new Error("Parsed-block repair lease duration must be positive.");
    }
    const leasedAt = at.toISOString();
    const expiresAt = new Date(at.getTime() + leaseDurationSeconds * 1_000).toISOString();
    return this.repository.db.transaction(() => {
      const manifest = this.getManifest(manifestId);
      if (!manifest || !["PENDING", "RUNNING"].includes(manifest.status)) return [];
      const slot = this.repository.db.prepare(`
        SELECT slot FROM parsed_block_repair_items
        WHERE manifest_id = ? AND status IN ('PENDING', 'RETRY') AND available_at <= ?
        ORDER BY slot, source_indexed_at, signature LIMIT 1
      `).get(manifestId, leasedAt) as { slot: number } | undefined;
      if (!slot) return [];
      const ready = this.repository.db.prepare(`
        SELECT signature FROM parsed_block_repair_items
        WHERE manifest_id = ? AND slot = ?
          AND status IN ('PENDING', 'RETRY') AND available_at <= ?
        ORDER BY source_indexed_at, signature LIMIT ?
      `).all(manifestId, slot.slot, leasedAt, boundedLimit) as Array<{ signature: string }>;
      const claim = this.repository.db.prepare(`
        UPDATE parsed_block_repair_items SET
          status = 'LEASED', attempts = attempts + 1,
          lease_owner = ?, lease_token = ?, leased_at = ?, lease_expires_at = ?,
          last_error = NULL, updated_at = ?
        WHERE manifest_id = ? AND signature = ?
          AND status IN ('PENDING', 'RETRY') AND available_at <= ?
      `);
      const leased: ParsedBlockRepairItem[] = [];
      for (const row of ready) {
        const token = digest(`${workerId}:${manifestId}:${row.signature}:${leasedAt}:${Math.random()}`);
        const changed = claim.run(
          workerId,
          token,
          leasedAt,
          expiresAt,
          leasedAt,
          manifestId,
          row.signature,
          leasedAt
        );
        if (changed.changes !== 1) continue;
        const item = this.getItem(manifestId, row.signature);
        if (item) leased.push(item);
      }
      if (leased.length > 0) {
        this.repository.db.prepare(`
          UPDATE parsed_block_repair_manifests SET status = 'RUNNING', updated_at = ?
          WHERE id = ? AND status = 'PENDING'
        `).run(leasedAt, manifestId);
      }
      return leased;
    })();
  }

  apply(input: ApplyParsedBlockRepairInput): boolean {
    const at = input.at ?? new Date();
    const completedAt = at.toISOString();
    const leaseToken = input.item.leaseToken;
    if (!leaseToken) return false;
    const status = input.swaps.length === 0 ? "VALID_ZERO" : "RECOVERED";
    const applied = this.repository.db.transaction(() => {
      const row = this.repository.db.prepare(`
        SELECT item.*, manifest.repair_version, manifest.decoder_version,
               manifest.source_run_id, manifest.source_run_started_at, manifest.cutoff_at,
               indexed_tx.success, indexed_tx.slot AS transaction_slot,
               indexed_tx.indexed_at, indexed_tx.transaction_json,
               indexed_tx.source_wallets_json
        FROM parsed_block_repair_items AS item
        JOIN parsed_block_repair_manifests AS manifest ON manifest.id = item.manifest_id
        JOIN indexed_transactions AS indexed_tx ON indexed_tx.signature = item.signature
        WHERE item.manifest_id = ? AND item.signature = ?
      `).get(input.item.manifestId, input.item.signature) as (ItemRow & {
        repair_version: string;
        decoder_version: string;
        source_run_id: string;
        source_run_started_at: string;
        cutoff_at: string;
        success: number | null;
        transaction_slot: number | null;
        indexed_at: string;
        transaction_json: string;
        source_wallets_json: string;
      }) | undefined;
      if (!row || row.status !== "LEASED" || row.lease_token !== leaseToken) return false;
      const failGuard = (reason: string): false => {
        this.repository.db.prepare(`
          UPDATE parsed_block_repair_items SET
            status = 'FAILED', lease_owner = NULL, lease_token = NULL,
            leased_at = NULL, lease_expires_at = NULL, last_error = ?,
            updated_at = ?, completed_at = ?
          WHERE manifest_id = ? AND signature = ? AND status = 'LEASED' AND lease_token = ?
        `).run(
          redactSensitiveText(`Repair guard rejected application: ${reason}`, 1_000),
          completedAt,
          completedAt,
          input.item.manifestId,
          input.item.signature,
          leaseToken
        );
        return false;
      };
      if (row.decoder_version !== input.decoderVersion) return failGuard("decoder version changed");
      if (
        row.success !== 1 ||
        row.transaction_slot !== input.item.slot ||
        row.indexed_at !== input.item.sourceIndexedAt ||
        row.indexed_at < row.source_run_started_at ||
        row.indexed_at > row.cutoff_at ||
        digest(row.transaction_json) !== input.item.sourceTransactionDigest
      ) return failGuard("frozen transaction evidence changed");
      if (
        input.transaction.signature !== input.item.signature ||
        input.transaction.success !== true ||
        input.transaction.slot !== input.item.slot ||
        input.transaction.blockTime === undefined
      ) return failGuard("hydrated transaction metadata does not match the manifest item");
      if (input.swaps.some((swap) =>
        swap.signature !== input.item.signature || swap.slot !== input.item.slot
      )) return failGuard("decoded swap does not match the manifest item");

      const sourceGuard = this.repository.db.prepare(`
        SELECT
          EXISTS (
            SELECT 1 FROM index_signature_sources AS source
            WHERE source.signature = ?
              AND source.source = 'helius-program-signature'
              AND (source.first_run_id = ? OR source.last_run_id = ?)
          ) AS has_program_source,
          EXISTS (
            SELECT 1 FROM index_signature_sources AS source
            WHERE source.signature = ? AND source.source = 'helius-wallet-deep-history'
          ) AS has_deep_history,
          EXISTS (
            SELECT 1 FROM indexed_spot_swaps AS swap WHERE swap.signature = ?
          ) AS has_swap,
          (SELECT COUNT(*) FROM parsed_block_repair_items AS peer
           WHERE peer.manifest_id = ? AND peer.slot = ?) AS slot_items
      `).get(
        input.item.signature,
        row.source_run_id,
        row.source_run_id,
        input.item.signature,
        input.item.signature,
        input.item.manifestId,
        input.item.slot
      ) as { has_program_source: number; has_deep_history: number; has_swap: number; slot_items: number };
      if (
        sourceGuard.has_program_source !== 1 ||
        sourceGuard.has_deep_history !== 0 ||
        sourceGuard.has_swap !== 0 ||
        sourceGuard.slot_items < 2
      ) return failGuard("source, no-swap, deep-history, or grouped-slot eligibility changed");

      const existingWallets = decode<string[]>(row.source_wallets_json);
      const sourceWallets = [...new Set([...existingWallets, ...input.swaps.map((swap) => swap.wallet)])].sort();
      const persisted: WalletIndexTransaction = {
        ...input.transaction,
        status: "PROCESSED",
        attempts: input.item.attempts,
        priority: 0,
        discoveredAt: input.item.createdAt,
        availableAt: input.item.availableAt,
        sourceWallets,
        indexedAt: row.indexed_at,
        processedAt: input.transaction.processedAt ?? completedAt,
        updatedAt: completedAt
      };
      this.repository.db.prepare(`
        UPDATE indexed_transactions SET
          slot = ?, block_time = ?, success = 1, fee_payer = ?,
          source_wallets_json = ?, account_keys_json = ?, program_ids_json = ?,
          transaction_json = ?, hydration_provenance = ?, decoder_version = ?, hydrated_at = ?
        WHERE signature = ? AND success = 1 AND indexed_at = ?
      `).run(
        persisted.slot ?? null,
        persisted.blockTime ?? null,
        persisted.feePayer ?? null,
        encode(sourceWallets),
        persisted.accountKeys ? encode(persisted.accountKeys) : null,
        persisted.programIds ? encode(persisted.programIds) : null,
        encode(persisted),
        input.provenance,
        input.decoderVersion,
        completedAt,
        input.item.signature,
        input.item.sourceIndexedAt
      );

      const insertSwap = this.repository.db.prepare(`
        INSERT INTO indexed_spot_swaps(
          id, signature, wallet, swap_index, slot, block_time, side, base_mint,
          target_mint, input_mint, output_mint, input_amount_atomic,
          output_amount_atomic, eligible, closes_position, holding_minutes,
          realized_pnl_usd, swap_json, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const enqueueReprice = this.repository.db.prepare(`
        INSERT OR IGNORE INTO indexed_swap_reprice_queue(
          swap_id, status, attempts, available_at, last_error, updated_at
        ) VALUES (?, 'PENDING', 0, ?, NULL, ?)
      `);
      const markDirty = this.repository.db.prepare(`
        INSERT INTO wallet_index_dirty(wallet, marked_at, last_signature)
        VALUES (?, ?, ?)
        ON CONFLICT(wallet) DO UPDATE SET
          marked_at = excluded.marked_at, last_signature = excluded.last_signature
      `);
      for (const swap of input.swaps) {
        insertSwap.run(
          swap.id,
          swap.signature,
          swap.wallet,
          swap.swapIndex,
          swap.slot,
          swap.blockTime,
          swap.side,
          swap.baseMint,
          swap.targetMint,
          swap.inputMint,
          swap.outputMint,
          swap.inputAmountAtomic,
          swap.outputAmountAtomic,
          swap.eligible ? 1 : 0,
          swap.closesPosition ? 1 : 0,
          swap.holdingMinutes ?? null,
          swap.realizedPnlUsd ?? null,
          encode(swap),
          swap.indexedAt
        );
        if (
          swap.baseMint === SOL_MINT &&
          (swap.priceUsd === undefined || !Number.isFinite(swap.priceUsd) || swap.priceUsd <= 0)
        ) enqueueReprice.run(swap.id, completedAt, completedAt);
        markDirty.run(swap.wallet, completedAt, swap.signature);
      }
      const changed = this.repository.db.prepare(`
        UPDATE parsed_block_repair_items SET
          status = ?, lease_owner = NULL, lease_token = NULL,
          leased_at = NULL, lease_expires_at = NULL, last_error = NULL,
          result_swap_count = ?, hydration_provenance = ?,
          updated_at = ?, completed_at = ?
        WHERE manifest_id = ? AND signature = ? AND status = 'LEASED' AND lease_token = ?
      `).run(
        status,
        input.swaps.length,
        input.provenance,
        completedAt,
        completedAt,
        input.item.manifestId,
        input.item.signature,
        leaseToken
      );
      if (changed.changes !== 1) throw new Error("The repair item lease changed during atomic application.");
      this.refreshManifestStatus(input.item.manifestId, at);
      // Keep the immutable per-item audit evidence in the same SQLite commit
      // as the repair result. A separate autocommit for every historical item
      // doubles WAL/checkpoint pressure while the large repair queue drains and
      // can starve unrelated loopback requests on slower Windows disks.
      this.repository.audit(
        status === "RECOVERED" ? "parsed_block_repair_recovered" : "parsed_block_repair_valid_zero",
        status === "RECOVERED"
          ? "Strict parsed-block repair recovered one or more indexed spot swaps."
          : "Strict parsed-block repair validated the transaction and produced zero eligible swaps.",
        {
          manifestId: input.item.manifestId,
          signature: input.item.signature,
          slot: input.item.slot,
          swapCount: input.swaps.length,
          provenance: input.provenance,
          decoderVersion: input.decoderVersion
        }
      );
      return true;
    })();
    if (!applied) {
      this.refreshManifestStatus(input.item.manifestId, at);
    }
    return applied;
  }

  retry(
    item: ParsedBlockRepairItem,
    error: unknown,
    retryDelayMs = 30_000,
    maximumAttempts = 8,
    at = new Date()
  ): ParsedBlockRepairItemStatus | undefined {
    if (!item.leaseToken) return undefined;
    const timestamp = at.toISOString();
    const status: ParsedBlockRepairItemStatus = item.attempts >= maximumAttempts ? "FAILED" : "RETRY";
    const availableAt = new Date(at.getTime() + Math.max(0, retryDelayMs)).toISOString();
    const reason = redactSensitiveText(error instanceof Error ? error.message : String(error), 1_000);
    const changed = this.repository.db.prepare(`
      UPDATE parsed_block_repair_items SET
        status = ?, available_at = ?, lease_owner = NULL, lease_token = NULL,
        leased_at = NULL, lease_expires_at = NULL, last_error = ?,
        updated_at = ?, completed_at = ?
      WHERE manifest_id = ? AND signature = ? AND status = 'LEASED' AND lease_token = ?
    `).run(
      status,
      availableAt,
      reason,
      timestamp,
      status === "FAILED" ? timestamp : null,
      item.manifestId,
      item.signature,
      item.leaseToken
    );
    if (changed.changes !== 1) return undefined;
    this.refreshManifestStatus(item.manifestId, at);
    if (status === "FAILED") {
      this.repository.audit(
        "parsed_block_repair_item_failed",
        "A parsed-block repair item exhausted its bounded retries.",
        { manifestId: item.manifestId, signature: item.signature, slot: item.slot, attempts: item.attempts },
        "warning"
      );
    }
    return status;
  }

  private refreshAllManifestStatuses(at: Date): void {
    const rows = this.repository.db.prepare(`
      SELECT id FROM parsed_block_repair_manifests WHERE status IN ('PENDING', 'RUNNING')
    `).all() as Array<{ id: string }>;
    for (const row of rows) this.refreshManifestStatus(row.id, at);
  }

  refreshManifestStatus(manifestId: string, at = new Date()): ParsedBlockRepairManifest | undefined {
    const timestamp = at.toISOString();
    // Most calls happen while tens of thousands of items remain open. Probe
    // the covering (manifest_id, status, ...) index and stop at the first open
    // row instead of aggregating the complete manifest after every item.
    const open = this.repository.db.prepare(`
      SELECT 1 AS found FROM parsed_block_repair_items
      WHERE manifest_id = ? AND status IN ('PENDING', 'LEASED', 'RETRY')
      LIMIT 1
    `).get(manifestId) as { found: number } | undefined;
    if (!open) {
      const failed = Boolean(this.repository.db.prepare(`
        SELECT 1 AS found FROM parsed_block_repair_items
        WHERE manifest_id = ? AND status = 'FAILED'
        LIMIT 1
      `).get(manifestId));
      const changed = this.repository.db.prepare(`
        UPDATE parsed_block_repair_manifests SET
          status = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?,
          last_error = CASE WHEN ? = 1 THEN 'One or more bounded repair items failed.' ELSE NULL END
        WHERE id = ? AND status IN ('PENDING', 'RUNNING')
      `).run(failed ? "FAILED" : "COMPLETE", timestamp, timestamp, failed ? 1 : 0, manifestId);
      if (changed.changes === 1) {
        const coverage = this.coverage(manifestId, at);
        this.repository.audit(
          "parsed_block_repair_manifest_finished",
          failed
            ? "The bounded parsed-block repair finished with one or more failed items."
            : "The bounded parsed-block repair completed under the frozen strict decoder policy.",
          {
            manifestId,
            status: failed ? "FAILED" : "COMPLETE",
            recovered: coverage.recovered,
            validZero: coverage.validZero,
            failed: coverage.failed,
            recoveredSwaps: coverage.recoveredSwaps
          },
          failed ? "warning" : "info"
        );
      }
    }
    return this.getManifest(manifestId);
  }
}
