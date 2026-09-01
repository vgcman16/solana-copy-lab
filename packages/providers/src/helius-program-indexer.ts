import {
  SOL_MINT,
  USDC_MINT,
  type PublicKeyString,
  type TradeSide,
  type TransactionSignature
} from "@copylab/shared";
import { asRecord, finiteNumber, stringValue } from "./http.js";
import {
  DEFAULT_SPOT_SWAP_PROGRAM_IDS,
  decodeSpotSwapTransaction
} from "./helius-decoder.js";
import {
  type HeliusRpcClient,
  type HeliusSignatureInfo,
  type HeliusSignaturePageRequest
} from "./helius-rpc-client.js";

export interface HeliusIndexRpc {
  getSignaturesForAddress(
    address: PublicKeyString,
    request?: HeliusSignaturePageRequest
  ): Promise<HeliusSignatureInfo[]>;
  getTransaction(signature: TransactionSignature): Promise<unknown | null>;
  /** Optional slot hydration seam used to amortize transaction discovery. */
  getBlock?(slot: number): Promise<unknown | null>;
}

export interface ProgramSignaturePage {
  programId: PublicKeyString;
  signatures: HeliusSignatureInfo[];
  nextBefore?: TransactionSignature;
  exhausted: boolean;
}

export interface IndexedSpotSwapObservation {
  sourceSignature: TransactionSignature;
  sourceProgram: PublicKeyString;
  wallet: PublicKeyString;
  slot: number;
  blockTime: string;
  side: TradeSide;
  baseMint: typeof SOL_MINT | typeof USDC_MINT;
  targetMint: PublicKeyString;
  baseAmountAtomic: string;
  targetAmountAtomic: string;
  baseAmountUi: number;
  targetAmountUi: number;
  baseValueUsd?: number;
  indexedAt: string;
}

export interface ConfirmedTransactionMetadata {
  slot: number;
  blockTime: string;
  success: boolean;
  feePayer?: PublicKeyString;
  signers: PublicKeyString[];
  accountKeys: PublicKeyString[];
  programIds: PublicKeyString[];
  transactionVersion?: string;
}

export interface WalletActivityPreScreen {
  wallet: PublicKeyString;
  sampledAt: string;
  successfulTransactions: number;
  historyDays: number;
  activeWeeks: number;
  reachedHistoryCutoff: boolean;
  truncated: boolean;
  passed: boolean;
  reasons: string[];
}

export interface HeliusProgramIndexerOptions {
  programIds?: ReadonlySet<string>;
  signaturePageSize?: number;
  activityPageSize?: number;
  maximumActivityPages?: number;
  now?: () => Date;
}

function accountKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return stringValue(asRecord(value)?.pubkey);
}

export function confirmedTransactionSigners(value: unknown): PublicKeyString[] {
  const root = asRecord(value);
  const transaction = asRecord(root?.transaction);
  const message = asRecord(transaction?.message);
  const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const explicitlySigned = keys.flatMap((key) => {
    const record = asRecord(key);
    const pubkey = accountKey(key);
    return record?.signer === true && pubkey ? [pubkey] : [];
  });
  if (explicitlySigned.length > 0) return [...new Set(explicitlySigned)];

  const header = asRecord(message?.header);
  const required = finiteNumber(header?.numRequiredSignatures);
  if (
    typeof header?.numRequiredSignatures !== "number" ||
    !Number.isSafeInteger(required) ||
    (required ?? 0) <= 0
  ) return [];
  return keys
    .slice(0, required)
    .map(accountKey)
    .filter((key): key is string => key !== undefined);
}

export function confirmedTransactionMetadata(value: unknown): ConfirmedTransactionMetadata | undefined {
  const root = asRecord(value);
  const transaction = asRecord(root?.transaction);
  const message = asRecord(transaction?.message);
  const meta = asRecord(root?.meta);
  const slot = finiteNumber(root?.slot);
  const blockTime = finiteNumber(root?.blockTime);
  if (
    !root ||
    !transaction ||
    !message ||
    !meta ||
    typeof root.slot !== "number" ||
    typeof root.blockTime !== "number" ||
    !Number.isSafeInteger(slot) ||
    (slot ?? -1) < 0 ||
    !Number.isSafeInteger(blockTime) ||
    (blockTime ?? -1) < 0 ||
    (blockTime ?? Number.POSITIVE_INFINITY) > 8_640_000_000_000
  ) return undefined;
  const loaded = asRecord(meta.loadedAddresses);
  const keySlots = [
    ...(Array.isArray(message.accountKeys) ? message.accountKeys.map(accountKey) : []),
    ...(Array.isArray(loaded?.writable) ? loaded.writable.map(accountKey) : []),
    ...(Array.isArray(loaded?.readonly) ? loaded.readonly.map(accountKey) : [])
  ];
  if (keySlots.some((key) => key === undefined)) return undefined;
  const keys = keySlots as string[];
  const signers = confirmedTransactionSigners(root);
  const programs = new Set<string>();
  const collectInstruction = (instruction: unknown): void => {
    const record = asRecord(instruction);
    const direct = stringValue(record?.programId);
    if (direct) programs.add(direct);
    const index = finiteNumber(record?.programIdIndex);
    if (Number.isSafeInteger(index) && (index ?? -1) >= 0 && keys[index as number]) {
      programs.add(keys[index as number] as string);
    }
  };
  if (Array.isArray(message.instructions)) message.instructions.forEach(collectInstruction);
  if (Array.isArray(meta.innerInstructions)) {
    for (const group of meta.innerInstructions) {
      const instructions = asRecord(group)?.instructions;
      if (Array.isArray(instructions)) instructions.forEach(collectInstruction);
    }
  }
  if (Array.isArray(meta.logMessages)) {
    for (const log of meta.logMessages) {
      if (typeof log !== "string") continue;
      const match = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke/.exec(log);
      if (match?.[1]) programs.add(match[1]);
    }
  }
  const version = root.version;
  return {
    slot: slot as number,
    blockTime: new Date((blockTime as number) * 1_000).toISOString(),
    success: meta.err === null,
    ...(signers[0] ? { feePayer: signers[0] } : {}),
    signers,
    accountKeys: keys,
    programIds: [...programs],
    ...(typeof version === "string" || typeof version === "number"
      ? { transactionVersion: String(version) }
      : {})
  };
}

export class HeliusProgramIndexer {
  private readonly programIds: ReadonlySet<string>;
  private readonly signaturePageSize: number;
  private readonly activityPageSize: number;
  private readonly maximumActivityPages: number;
  private readonly now: () => Date;

  constructor(
    private readonly rpc: HeliusIndexRpc | HeliusRpcClient,
    options: HeliusProgramIndexerOptions = {}
  ) {
    this.programIds = options.programIds ?? DEFAULT_SPOT_SWAP_PROGRAM_IDS;
    this.signaturePageSize = this.pageSize(options.signaturePageSize ?? 1_000, "signature");
    this.activityPageSize = this.pageSize(options.activityPageSize ?? 1_000, "activity");
    this.maximumActivityPages = options.maximumActivityPages ?? 10;
    if (!Number.isSafeInteger(this.maximumActivityPages) || this.maximumActivityPages < 1) {
      throw new RangeError("maximumActivityPages must be a positive integer");
    }
    this.now = options.now ?? (() => new Date());
  }

  listPrograms(): string[] {
    return [...this.programIds];
  }

  async fetchProgramSignatures(
    programId: PublicKeyString,
    before?: TransactionSignature,
    until?: TransactionSignature
  ): Promise<ProgramSignaturePage> {
    if (!this.programIds.has(programId)) throw new Error("Program is not approved for wallet discovery");
    const signatures = await this.rpc.getSignaturesForAddress(programId, {
      limit: this.signaturePageSize,
      ...(before ? { before } : {}),
      ...(until ? { until } : {})
    });
    const tail = signatures.at(-1)?.signature;
    if (before && tail === before) throw new Error("Helius program signature cursor did not advance");
    return {
      programId,
      signatures,
      ...(tail ? { nextBefore: tail } : {}),
      exhausted: signatures.length < this.signaturePageSize
    };
  }

  async hydrateProgramSignature(
    programId: PublicKeyString,
    signature: TransactionSignature,
    detectedAt = this.now()
  ): Promise<IndexedSpotSwapObservation[]> {
    if (!this.programIds.has(programId)) throw new Error("Program is not approved for wallet discovery");
    const transaction = await this.rpc.getTransaction(signature);
    if (transaction === null) return [];
    return this.decodeProgramTransaction(programId, signature, transaction, detectedAt);
  }

  decodeProgramTransaction(
    programId: PublicKeyString,
    signature: TransactionSignature,
    transaction: unknown,
    detectedAt = this.now()
  ): IndexedSpotSwapObservation[] {
    if (!this.programIds.has(programId)) throw new Error("Program is not approved for wallet discovery");
    const signers = confirmedTransactionSigners(transaction);
    // Program-specific authority parsing is required to safely attribute a
    // multi-signer bundle. Reject ambiguity until that parser exists.
    if (signers.length !== 1) return [];
    const observations = new Map<string, IndexedSpotSwapObservation>();
    for (const wallet of signers) {
      const swap = decodeSpotSwapTransaction(transaction, {
        signature,
        wallet,
        detectedAt,
        recovered: true,
        solPriceUsd: 1,
        allowedSpotProgramIds: new Set([programId])
      });
      if (!swap) continue;
      observations.set(wallet, {
        sourceSignature: swap.sourceSignature,
        sourceProgram: programId,
        wallet,
        slot: swap.slot,
        blockTime: swap.blockTime,
        side: swap.side,
        baseMint: swap.baseMint,
        targetMint: swap.targetMint,
        baseAmountAtomic: swap.baseAmountAtomic,
        targetAmountAtomic: swap.targetAmountAtomic,
        baseAmountUi: swap.baseAmountUi,
        targetAmountUi: swap.targetAmountUi,
        ...(swap.baseMint === USDC_MINT ? { baseValueUsd: swap.baseAmountUi } : {}),
        indexedAt: detectedAt.toISOString()
      });
    }
    return [...observations.values()];
  }

  async preScreenWalletActivity(
    wallet: PublicKeyString,
    options: {
      historyDays?: number;
      minimumSuccessfulTransactions?: number;
      minimumActiveWeeks?: number;
    } = {}
  ): Promise<WalletActivityPreScreen> {
    const requiredHistoryDays = options.historyDays ?? 90;
    const minimumTransactions = options.minimumSuccessfulTransactions ?? 50;
    const minimumActiveWeeks = options.minimumActiveWeeks ?? 3;
    if (!Number.isSafeInteger(requiredHistoryDays) || requiredHistoryDays < 1) {
      throw new RangeError("historyDays must be a positive integer");
    }
    if (!Number.isSafeInteger(minimumTransactions) || minimumTransactions < 1) {
      throw new RangeError("minimumSuccessfulTransactions must be a positive integer");
    }
    if (!Number.isSafeInteger(minimumActiveWeeks) || minimumActiveWeeks < 1 || minimumActiveWeeks > 4) {
      throw new RangeError("minimumActiveWeeks must be an integer between 1 and 4");
    }
    const sampledAt = this.now();
    const cutoff = sampledAt.getTime() - requiredHistoryDays * 86_400_000;
    const seen = new Set<string>();
    const successfulTimes: number[] = [];
    let before: string | undefined;
    let reachedHistoryCutoff = false;
    let exhausted = false;

    for (let page = 0; page < this.maximumActivityPages; page += 1) {
      const signatures = await this.rpc.getSignaturesForAddress(wallet, {
        limit: this.activityPageSize,
        ...(before ? { before } : {})
      });
      const seenBefore = seen.size;
      for (const signature of signatures) {
        if (seen.has(signature.signature)) continue;
        seen.add(signature.signature);
        if (!signature.failed && signature.blockTime !== undefined) {
          successfulTimes.push(signature.blockTime * 1_000);
          if (signature.blockTime * 1_000 <= cutoff) reachedHistoryCutoff = true;
        }
      }
      if (reachedHistoryCutoff || signatures.length < this.activityPageSize) {
        exhausted = signatures.length < this.activityPageSize;
        break;
      }
      const nextBefore = signatures.at(-1)?.signature;
      if (!nextBefore) throw new Error("Helius activity page was full but had no pagination cursor");
      if (before && nextBefore === before) throw new Error("Helius wallet activity cursor did not advance");
      if (seen.size === seenBefore) throw new Error("Helius wallet activity page contained no unseen signatures");
      before = nextBefore;
    }

    const recentWeeks = new Set(
      successfulTimes
        .map((time) => Math.floor((sampledAt.getTime() - time) / (7 * 86_400_000)))
        .filter((week) => week >= 0 && week < 4)
    );
    const oldest = successfulTimes.length > 0 ? Math.min(...successfulTimes) : sampledAt.getTime();
    const historyDays = reachedHistoryCutoff
      ? requiredHistoryDays
      : Math.min(requiredHistoryDays, Math.max(0, Math.floor((sampledAt.getTime() - oldest) / 86_400_000)));
    const truncated = !reachedHistoryCutoff && !exhausted;
    const reasons: string[] = [];
    if (!reachedHistoryCutoff && !truncated) reasons.push("wallet activity is younger than the history threshold");
    if (truncated) reasons.push("wallet age was not proven before the pagination cap");
    if (successfulTimes.length < minimumTransactions) {
      reasons.push("insufficient successful activity for detailed screening");
    }
    if (recentWeeks.size < minimumActiveWeeks) reasons.push("insufficient recent active weeks");
    const passed = reasons.length === 0 && reachedHistoryCutoff;
    return {
      wallet,
      sampledAt: sampledAt.toISOString(),
      successfulTransactions: successfulTimes.length,
      historyDays,
      activeWeeks: recentWeeks.size,
      reachedHistoryCutoff,
      truncated,
      passed,
      reasons
    };
  }

  private pageSize(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw new RangeError(`${label} page size must be between 1 and 1000`);
    }
    return value;
  }
}
