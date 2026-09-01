import { PublicKey } from "@solana/web3.js";

const DAY_MS = 86_400_000;
const REQUIRED_HISTORY_DAYS = 90;
const DEFAULT_SNIPER_WINDOW_SECONDS = 60;
const DEFAULT_FIRST_POOL_CLOCK_SKEW_SECONDS = 5;
const DEFAULT_MINIMUM_COORDINATED_WALLETS = 3;

export const LOCAL_WALLET_IDENTITY_SOURCE = "local_onchain_90d_v1" as const;

export type LocalWalletIdentityTag = "dev" | "bundler" | "sniper" | "insider";
export type LocalWalletIdentityStatus = "UNKNOWN" | "VERIFIED" | "REJECTED";

export interface WalletIdentityScanCoverage {
  expectedSignatureCount: number;
  hydratedSignatureCount: number;
  reachedWindowStart: boolean;
  signatureHistoryComplete: boolean;
  transactionHydrationComplete: boolean;
  coordinatedBuyScanComplete: boolean;
}

export interface WalletIdentityMintCreationEvidence {
  mint: string;
  /** Wallet derived from the mint initialization's funding/authority instruction path. */
  creatorWallet: string;
  mintAuthority?: string;
}

export interface WalletIdentityOwnerTokenDelta {
  mint: string;
  owner: string;
  /** Signed, base-10 owner-level net delta aggregated across every token account. */
  amountDeltaAtomic: string;
}

export interface WalletIdentityTransactionEvidence {
  signature: string;
  slot: number;
  blockTime: string;
  success: boolean;
  signers: string[];
  walletMentioned: boolean;
  instructionScanComplete: boolean;
  tokenBalanceScanComplete: boolean;
  swapScanComplete: boolean;
  mintCreations: WalletIdentityMintCreationEvidence[];
  ownerTokenDeltas: WalletIdentityOwnerTokenDelta[];
}

/** Durable row form; the classifier itself already receives wallet at scan level. */
export interface WalletIdentityTransactionEvidenceRecord extends WalletIdentityTransactionEvidence {
  wallet: string;
}

export interface WalletIdentitySwapEvidence {
  signature: string;
  swapIndex: number;
  wallet: string;
  slot: number;
  blockTime: string;
  side: "BUY" | "SELL";
  targetMint: string;
  inputAmountAtomic: string;
  outputAmountAtomic: string;
}

export interface WalletIdentityCoordinatedBuyEvidence {
  signature: string;
  wallet: string;
  slot: number;
  blockTime: string;
  side: "BUY" | "SELL";
  targetMint: string;
  outputAmountAtomic: string;
}

export interface JupiterFirstPoolEvidence {
  mint: string;
  source: "JUPITER";
  /** Null means Jupiter did not return a usable first pool and cannot prove a clean identity. */
  firstPoolAt: string | null;
  checkedAt: string;
}

export interface LocalWalletIdentityScanInput {
  wallet: string;
  windowStart: string;
  windowEnd: string;
  coverage: WalletIdentityScanCoverage;
  /** Complete wallet-address history for the frozen window, including failed transactions. */
  transactions: WalletIdentityTransactionEvidence[];
  /** Complete normalized swaps for the subject wallet in the same frozen window. */
  swaps: WalletIdentitySwapEvidence[];
  /**
   * All indexed buys sharing the subject's buy slots. The integration adapter
   * may keep this bounded to subject buy slot/mint pairs, but it must attest
   * coordinatedBuyScanComplete only after every configured spot program has
   * crossed those slots.
   */
  coordinatedBuys: WalletIdentityCoordinatedBuyEvidence[];
  /** One current Jupiter firstPoolAt result for every target mint in swaps. */
  firstPools: JupiterFirstPoolEvidence[];
}

export interface LocalWalletIdentityFinding {
  tag: LocalWalletIdentityTag;
  heuristic:
    | "SIGNER_CREATED_TRADED_MINT"
    | "PRE_POOL_RECEIPT_THEN_SALE"
    | "NON_SWAP_RECEIPT_THEN_SALE"
    | "FIRST_POOL_BUY"
    | "COORDINATED_SAME_SLOT_BUY";
  message: string;
  signature: string;
  slot: number;
  mint: string;
  relatedWallets?: string[];
}

export interface LocalWalletIdentityResult {
  wallet: string;
  status: LocalWalletIdentityStatus;
  tags: LocalWalletIdentityTag[];
  source: typeof LOCAL_WALLET_IDENTITY_SOURCE;
  checkedAt: string;
  windowStart: string;
  windowEnd: string;
  reasons: string[];
  findings: LocalWalletIdentityFinding[];
  metrics: {
    expectedSignatures: number;
    hydratedSignatures: number;
    inspectedTransactions: number;
    successfulTransactions: number;
    inspectedSwaps: number;
    inspectedMints: number;
    coordinatedBuyRows: number;
  };
}

export interface LocalWalletIdentityOptions {
  now?: Date;
  sniperWindowSeconds?: number;
  firstPoolClockSkewSeconds?: number;
  minimumCoordinatedWallets?: number;
}

interface ParsedPool {
  mint: string;
  firstPoolAtMs: number;
  checkedAtMs: number;
}

const TAG_ORDER: readonly LocalWalletIdentityTag[] = ["dev", "bundler", "sniper", "insider"];

function finiteTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function canonicalPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function safeSlot(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveAtomic(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function signedAtomic(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(value) || value === "-0") return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function positiveFiniteOption(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function positiveIntegerOption(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 2) throw new RangeError(`${label} must be an integer of at least two`);
  return value;
}

function follows(
  later: Pick<WalletIdentitySwapEvidence, "slot" | "blockTime" | "signature">,
  earlier: Pick<WalletIdentityTransactionEvidence, "slot" | "blockTime" | "signature">
): boolean {
  if (later.signature === earlier.signature) return false;
  if (later.slot !== earlier.slot) return later.slot > earlier.slot;
  return (finiteTimestamp(later.blockTime) ?? Number.NEGATIVE_INFINITY) >
    (finiteTimestamp(earlier.blockTime) ?? Number.POSITIVE_INFINITY);
}

function findingKey(finding: LocalWalletIdentityFinding): string {
  return [finding.tag, finding.heuristic, finding.signature, finding.slot, finding.mint].join(":");
}

/**
 * Deterministic, fail-closed on-chain identity classification.
 *
 * The function deliberately accepts an already normalized evidence bundle.
 * RPC parsing, owner-level token-delta aggregation, mint-instruction decoding,
 * and checkpoint completeness are integration responsibilities. Any missing,
 * malformed, conflicting, or partial evidence returns UNKNOWN unless a
 * positive disallowed finding already requires REJECTED.
 */
export function classifyLocalWalletIdentity(
  input: LocalWalletIdentityScanInput,
  options: LocalWalletIdentityOptions = {}
): LocalWalletIdentityResult {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError("now must be a valid date");
  const sniperWindowSeconds = positiveFiniteOption(
    options.sniperWindowSeconds ?? DEFAULT_SNIPER_WINDOW_SECONDS,
    "sniperWindowSeconds"
  );
  const firstPoolClockSkewSeconds = positiveFiniteOption(
    options.firstPoolClockSkewSeconds ?? DEFAULT_FIRST_POOL_CLOCK_SKEW_SECONDS,
    "firstPoolClockSkewSeconds"
  );
  const minimumCoordinatedWallets = positiveIntegerOption(
    options.minimumCoordinatedWallets ?? DEFAULT_MINIMUM_COORDINATED_WALLETS,
    "minimumCoordinatedWallets"
  );
  const issues = new Set<string>();
  const findingsByKey = new Map<string, LocalWalletIdentityFinding>();
  const addFinding = (finding: LocalWalletIdentityFinding): void => {
    findingsByKey.set(findingKey(finding), finding);
  };

  if (!canonicalPublicKey(input.wallet)) issues.add("subject wallet is not a canonical Solana public key");
  const windowStartMs = finiteTimestamp(input.windowStart);
  const windowEndMs = finiteTimestamp(input.windowEnd);
  if (windowStartMs === undefined || windowEndMs === undefined || windowEndMs <= windowStartMs) {
    issues.add("identity scan window is invalid");
  } else if (windowEndMs - windowStartMs < REQUIRED_HISTORY_DAYS * DAY_MS) {
    issues.add("identity scan covers fewer than 90 complete days");
  }

  const coverage = input.coverage;
  if (!nonNegativeInteger(coverage.expectedSignatureCount) || coverage.expectedSignatureCount === 0) {
    issues.add("signature history contains no complete wallet evidence");
  }
  if (!nonNegativeInteger(coverage.hydratedSignatureCount)) {
    issues.add("hydrated signature count is invalid");
  }
  if (coverage.expectedSignatureCount !== coverage.hydratedSignatureCount) {
    issues.add("not every wallet-history signature was hydrated");
  }
  if (!coverage.reachedWindowStart) issues.add("wallet history did not reach the frozen 90-day boundary");
  if (!coverage.signatureHistoryComplete) issues.add("wallet signature pagination is incomplete");
  if (!coverage.transactionHydrationComplete) issues.add("wallet transaction hydration is incomplete");
  if (!coverage.coordinatedBuyScanComplete) issues.add("coordinated-buy slot coverage is incomplete");

  const transactionBySignature = new Map<string, WalletIdentityTransactionEvidence>();
  for (const transaction of input.transactions) {
    if (typeof transaction.signature !== "string" || transaction.signature.length === 0) {
      issues.add("a hydrated transaction has no signature");
      continue;
    }
    if (transactionBySignature.has(transaction.signature)) {
      issues.add(`duplicate hydrated transaction: ${transaction.signature}`);
      continue;
    }
    transactionBySignature.set(transaction.signature, transaction);
    const blockTimeMs = finiteTimestamp(transaction.blockTime);
    if (!safeSlot(transaction.slot) || blockTimeMs === undefined) {
      issues.add(`transaction ${transaction.signature} has invalid confirmed metadata`);
    } else if (
      windowStartMs !== undefined &&
      windowEndMs !== undefined &&
      (blockTimeMs < windowStartMs || blockTimeMs > windowEndMs)
    ) {
      issues.add(`transaction ${transaction.signature} falls outside the frozen scan window`);
    }
    if (!transaction.walletMentioned) {
      issues.add(`transaction ${transaction.signature} does not prove subject-wallet participation`);
    }
    if (!transaction.instructionScanComplete) {
      issues.add(`transaction ${transaction.signature} has incomplete instruction evidence`);
    }
    if (!transaction.tokenBalanceScanComplete) {
      issues.add(`transaction ${transaction.signature} has incomplete token-balance evidence`);
    }
    if (!transaction.swapScanComplete) {
      issues.add(`transaction ${transaction.signature} has incomplete swap evidence`);
    }
    if (!Array.isArray(transaction.signers) || transaction.signers.some((signer) => !canonicalPublicKey(signer))) {
      issues.add(`transaction ${transaction.signature} has malformed signer evidence`);
    }
  }
  if (
    nonNegativeInteger(coverage.hydratedSignatureCount) &&
    transactionBySignature.size !== coverage.hydratedSignatureCount
  ) {
    issues.add("hydrated transaction rows do not match the attested signature count");
  }

  const validSwaps: WalletIdentitySwapEvidence[] = [];
  const relevantMints = new Set<string>();
  const swapKeys = new Set<string>();
  // Absence-based receipt heuristics are unsafe when a candidate swap for the
  // same transaction/mint was present but malformed. Preserve the UNKNOWN
  // result without manufacturing an insider tag from that parse failure.
  const untrustedSwapPairs = new Set<string>();
  for (const swap of input.swaps) {
    const key = `${swap.signature}:${swap.swapIndex}:${swap.wallet}`;
    const pair = typeof swap.signature === "string" && typeof swap.targetMint === "string"
      ? `${swap.signature}:${swap.targetMint}`
      : undefined;
    if (swapKeys.has(key)) {
      issues.add(`duplicate normalized swap: ${key}`);
      continue;
    }
    swapKeys.add(key);
    const transaction = transactionBySignature.get(swap.signature);
    const blockTimeMs = finiteTimestamp(swap.blockTime);
    const inputAmount = positiveAtomic(swap.inputAmountAtomic);
    const outputAmount = positiveAtomic(swap.outputAmountAtomic);
    if (
      swap.wallet !== input.wallet ||
      !nonNegativeInteger(swap.swapIndex) ||
      !safeSlot(swap.slot) ||
      blockTimeMs === undefined ||
      !canonicalPublicKey(swap.targetMint) ||
      inputAmount === undefined ||
      outputAmount === undefined ||
      (swap.side !== "BUY" && swap.side !== "SELL")
    ) {
      issues.add(`swap ${key} is malformed or attributed to another wallet`);
      if (pair) untrustedSwapPairs.add(pair);
      continue;
    }
    if (!transaction) {
      issues.add(`swap ${key} has no hydrated wallet transaction`);
      if (pair) untrustedSwapPairs.add(pair);
      continue;
    }
    if (!transaction.success) {
      issues.add(`swap ${key} is attached to a failed transaction`);
      if (pair) untrustedSwapPairs.add(pair);
      continue;
    }
    if (transaction.slot !== swap.slot || finiteTimestamp(transaction.blockTime) !== blockTimeMs) {
      issues.add(`swap ${key} conflicts with confirmed transaction metadata`);
      if (pair) untrustedSwapPairs.add(pair);
      continue;
    }
    validSwaps.push(swap);
    relevantMints.add(swap.targetMint);
  }

  const poolsByMint = new Map<string, ParsedPool>();
  for (const pool of input.firstPools) {
    const firstPoolAtMs = finiteTimestamp(pool.firstPoolAt ?? undefined);
    const checkedAtMs = finiteTimestamp(pool.checkedAt);
    if (
      !canonicalPublicKey(pool.mint) ||
      pool.source !== "JUPITER" ||
      firstPoolAtMs === undefined ||
      checkedAtMs === undefined ||
      firstPoolAtMs > checkedAtMs ||
      checkedAtMs > now.getTime() + 5 * 60_000
    ) {
      issues.add(`Jupiter first-pool evidence is missing or malformed for ${pool.mint}`);
      continue;
    }
    const existing = poolsByMint.get(pool.mint);
    if (existing && existing.firstPoolAtMs !== firstPoolAtMs) {
      issues.add(`Jupiter first-pool evidence conflicts for ${pool.mint}`);
      continue;
    }
    poolsByMint.set(pool.mint, { mint: pool.mint, firstPoolAtMs, checkedAtMs });
  }
  for (const mint of relevantMints) {
    if (!poolsByMint.has(mint)) issues.add(`Jupiter firstPoolAt is unavailable for traded mint ${mint}`);
  }

  for (const transaction of transactionBySignature.values()) {
    if (!transaction.success || !safeSlot(transaction.slot)) continue;
    const signers = new Set(transaction.signers);
    for (const creation of transaction.mintCreations) {
      if (!canonicalPublicKey(creation.mint) || !canonicalPublicKey(creation.creatorWallet)) {
        issues.add(`transaction ${transaction.signature} contains malformed mint-creation evidence`);
        continue;
      }
      if (
        relevantMints.has(creation.mint) &&
        creation.creatorWallet === input.wallet &&
        signers.has(input.wallet)
      ) {
        addFinding({
          tag: "dev",
          heuristic: "SIGNER_CREATED_TRADED_MINT",
          message: "The wallet signed creation of a mint it later traded.",
          signature: transaction.signature,
          slot: transaction.slot,
          mint: creation.mint
        });
      }
    }
  }

  const sellsByMint = new Map<string, WalletIdentitySwapEvidence[]>();
  const buysBySignatureMint = new Map<string, bigint>();
  for (const swap of validSwaps) {
    if (swap.side === "SELL") {
      const sells = sellsByMint.get(swap.targetMint) ?? [];
      sells.push(swap);
      sellsByMint.set(swap.targetMint, sells);
    } else {
      const amount = positiveAtomic(swap.outputAmountAtomic);
      if (amount !== undefined) {
        const key = `${swap.signature}:${swap.targetMint}`;
        buysBySignatureMint.set(key, (buysBySignatureMint.get(key) ?? 0n) + amount);
      }
      const pool = poolsByMint.get(swap.targetMint);
      const swapAtMs = finiteTimestamp(swap.blockTime);
      if (pool && swapAtMs !== undefined) {
        const offsetMs = swapAtMs - pool.firstPoolAtMs;
        if (
          offsetMs >= -firstPoolClockSkewSeconds * 1_000 &&
          offsetMs <= sniperWindowSeconds * 1_000
        ) {
          addFinding({
            tag: "sniper",
            heuristic: "FIRST_POOL_BUY",
            message: `The wallet bought within ${sniperWindowSeconds} seconds of Jupiter firstPoolAt.`,
            signature: swap.signature,
            slot: swap.slot,
            mint: swap.targetMint
          });
        } else if (offsetMs < -firstPoolClockSkewSeconds * 1_000) {
          issues.add(`swap ${swap.signature} materially predates Jupiter firstPoolAt for ${swap.targetMint}`);
        }
      }
    }
  }

  for (const transaction of transactionBySignature.values()) {
    if (!transaction.success || !safeSlot(transaction.slot)) continue;
    const ownerDeltaByMint = new Map<string, bigint>();
    for (const delta of transaction.ownerTokenDeltas) {
      const amount = signedAtomic(delta.amountDeltaAtomic);
      if (!canonicalPublicKey(delta.mint) || !canonicalPublicKey(delta.owner) || amount === undefined) {
        issues.add(`transaction ${transaction.signature} contains malformed owner token-delta evidence`);
        continue;
      }
      if (delta.owner !== input.wallet) continue;
      ownerDeltaByMint.set(delta.mint, (ownerDeltaByMint.get(delta.mint) ?? 0n) + amount);
    }
    const receivedAtMs = finiteTimestamp(transaction.blockTime);
    for (const [mint, receivedAmount] of ownerDeltaByMint) {
      if (receivedAmount <= 0n || !relevantMints.has(mint) || receivedAtMs === undefined) continue;
      const laterSale = (sellsByMint.get(mint) ?? []).find((sell) => follows(sell, transaction));
      if (!laterSale) continue;
      const boughtAmount = buysBySignatureMint.get(`${transaction.signature}:${mint}`) ?? 0n;
      const nonSwapAmount = receivedAmount - boughtAmount;
      const pool = poolsByMint.get(mint);
      if (pool && receivedAtMs < pool.firstPoolAtMs) {
        addFinding({
          tag: "insider",
          heuristic: "PRE_POOL_RECEIPT_THEN_SALE",
          message: "The wallet received the target token before Jupiter firstPoolAt and later sold it.",
          signature: transaction.signature,
          slot: transaction.slot,
          mint
        });
      }
      if (nonSwapAmount > 0n && !untrustedSwapPairs.has(`${transaction.signature}:${mint}`)) {
        addFinding({
          tag: "insider",
          heuristic: "NON_SWAP_RECEIPT_THEN_SALE",
          message: "The wallet received target inventory not explained by a decoded buy and later sold it.",
          signature: transaction.signature,
          slot: transaction.slot,
          mint
        });
      }
    }
  }

  const coordinatedKeys = new Set<string>();
  const coordinatedRows: WalletIdentityCoordinatedBuyEvidence[] = [];
  for (const buy of input.coordinatedBuys) {
    const amount = positiveAtomic(buy.outputAmountAtomic);
    const blockTimeMs = finiteTimestamp(buy.blockTime);
    const key = `${buy.signature}:${buy.wallet}:${buy.slot}:${buy.targetMint}:${buy.outputAmountAtomic}:${buy.side}`;
    if (coordinatedKeys.has(key)) continue;
    coordinatedKeys.add(key);
    if (
      typeof buy.signature !== "string" ||
      buy.signature.length === 0 ||
      !canonicalPublicKey(buy.wallet) ||
      !canonicalPublicKey(buy.targetMint) ||
      !safeSlot(buy.slot) ||
      blockTimeMs === undefined ||
      amount === undefined ||
      (buy.side !== "BUY" && buy.side !== "SELL")
    ) {
      issues.add("coordinated-buy evidence contains a malformed row");
      continue;
    }
    coordinatedRows.push(buy);
  }
  for (const subjectBuy of validSwaps.filter((swap) => swap.side === "BUY")) {
    const peers = coordinatedRows.filter((buy) =>
      buy.side === "BUY" &&
      buy.slot === subjectBuy.slot &&
      buy.targetMint === subjectBuy.targetMint &&
      buy.outputAmountAtomic === subjectBuy.outputAmountAtomic
    );
    const wallets = [...new Set(peers.map((buy) => buy.wallet))].sort();
    if (!wallets.includes(input.wallet)) {
      issues.add(`coordinated-buy evidence omits the subject buy ${subjectBuy.signature}`);
      continue;
    }
    if (wallets.length >= minimumCoordinatedWallets) {
      addFinding({
        tag: "bundler",
        heuristic: "COORDINATED_SAME_SLOT_BUY",
        message: `${wallets.length} wallets bought the same mint and exact atomic amount in one slot.`,
        signature: subjectBuy.signature,
        slot: subjectBuy.slot,
        mint: subjectBuy.targetMint,
        relatedWallets: wallets
      });
    }
  }

  const findings = [...findingsByKey.values()].sort((left, right) =>
    TAG_ORDER.indexOf(left.tag) - TAG_ORDER.indexOf(right.tag) ||
    left.slot - right.slot ||
    left.signature.localeCompare(right.signature) ||
    left.mint.localeCompare(right.mint)
  );
  const tags = TAG_ORDER.filter((tag) => findings.some((finding) => finding.tag === tag));
  const status: LocalWalletIdentityStatus = tags.length > 0
    ? "REJECTED"
    : issues.size > 0
      ? "UNKNOWN"
      : "VERIFIED";
  const reasons = status === "VERIFIED"
    ? ["Complete 90-day on-chain identity scan found no disallowed behavior."]
    : [
        ...findings.map((finding) => finding.message),
        ...[...issues].sort()
      ];
  return {
    wallet: input.wallet,
    status,
    tags,
    source: LOCAL_WALLET_IDENTITY_SOURCE,
    checkedAt: now.toISOString(),
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    reasons,
    findings,
    metrics: {
      expectedSignatures: nonNegativeInteger(coverage.expectedSignatureCount)
        ? coverage.expectedSignatureCount
        : 0,
      hydratedSignatures: nonNegativeInteger(coverage.hydratedSignatureCount)
        ? coverage.hydratedSignatureCount
        : 0,
      inspectedTransactions: transactionBySignature.size,
      successfulTransactions: [...transactionBySignature.values()].filter((transaction) => transaction.success).length,
      inspectedSwaps: validSwaps.length,
      inspectedMints: relevantMints.size,
      coordinatedBuyRows: coordinatedRows.length
    }
  };
}
