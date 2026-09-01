import {
  SOL_MINT,
  USDC_MINT,
  type LeaderSwap,
  type PublicKeyString,
  type RejectedSourceAction,
  type TransactionSignature
} from "@copylab/shared";
import { asRecord, finiteNumber, stringValue } from "./http.js";

export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const JUPITER_V4_PROGRAM_ID = "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB";
export const ORCA_WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const RAYDIUM_AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

export const DIRECT_SPOT_SWAP_PROGRAM_IDS: ReadonlySet<string> = new Set([
  ORCA_WHIRLPOOL_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID
]);

export const DEFAULT_SPOT_SWAP_PROGRAM_IDS: ReadonlySet<string> = new Set([
  JUPITER_V6_PROGRAM_ID,
  JUPITER_V4_PROGRAM_ID,
  ...DIRECT_SPOT_SWAP_PROGRAM_IDS
]);

const JUPITER_SPOT_SWAP_PROGRAM_IDS: ReadonlySet<string> = new Set([
  JUPITER_V6_PROGRAM_ID,
  JUPITER_V4_PROGRAM_ID
]);

const ORCA_SWAP_DISCRIMINATOR = [248, 198, 158, 145, 225, 117, 135, 200] as const;
const ORCA_SWAP_V2_DISCRIMINATOR = [43, 4, 237, 11, 26, 201, 30, 98] as const;
const RAYDIUM_SWAP_DISCRIMINATOR = [248, 198, 158, 145, 225, 117, 135, 200] as const;
const RAYDIUM_SWAP_V2_DISCRIMINATOR = [43, 4, 237, 11, 26, 201, 30, 98] as const;
const RAYDIUM_SWAP_ROUTER_BASE_IN_DISCRIMINATOR = [69, 125, 115, 218, 245, 186, 242, 196] as const;
const RAYDIUM_SWAP_BASE_INPUT_DISCRIMINATOR = [143, 190, 90, 218, 196, 30, 51, 222] as const;
const RAYDIUM_SWAP_BASE_OUTPUT_DISCRIMINATOR = [55, 217, 98, 86, 163, 74, 180, 173] as const;
const RAYDIUM_AMM_V4_SWAP_OPCODES: ReadonlySet<number> = new Set([9, 11, 16, 17]);
const METEORA_SWAP_EXACT_OUT_DISCRIMINATOR = [250, 73, 101, 33, 38, 207, 75, 184] as const;
const METEORA_SWAP_WITH_PRICE_IMPACT_DISCRIMINATOR = [56, 173, 230, 208, 173, 228, 156, 205] as const;
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const ANCHOR_EVENT_CPI_DISCRIMINATOR = [228, 69, 165, 46, 81, 203, 154, 29] as const;
const JUPITER_SWAP_EVENT_DISCRIMINATOR = [64, 198, 205, 232, 38, 8, 113, 226] as const;
const JUPITER_SWAPS_EVENT_DISCRIMINATOR = [152, 47, 78, 235, 192, 96, 110, 106] as const;
const METEORA_SWAP_EVENT_DISCRIMINATOR = [81, 108, 227, 190, 205, 208, 10, 196] as const;
const METEORA_SWAP2_EVENT_DISCRIMINATOR = [46, 116, 82, 215, 148, 27, 84, 77] as const;
const JUPITER_V4_ROUTE_DISCRIMINATOR = [229, 23, 203, 151, 122, 227, 173, 42] as const;
const MAX_ROUTE_STEPS = 16;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_VALUES = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));
const MAX_INSTRUCTION_DATA_BASE58_LENGTH = 2_048;

export interface SpotSwapDecodeContext {
  signature: TransactionSignature;
  wallet: PublicKeyString;
  detectedAt: Date;
  recovered: boolean;
  solPriceUsd?: number;
  allowedSpotProgramIds?: ReadonlySet<string>;
}

export type SpotSwapDecodeResult =
  | { status: "ACCEPTED"; swap: LeaderSwap }
  | {
      status: "REJECTED";
      action: RejectedSourceAction;
      researchAction: RejectedSwapResearchAction;
      reason: string;
    }
  | { status: "IGNORED" };

/**
 * Exact fill evidence for a rejected route's isolated paper-research lane.
 * The source identity is nested and leaderPriceUsd is deliberately absent, so
 * this type is not structurally assignable to LeaderSwap and cannot enter the
 * executable copy path by accident.
 */
export interface RejectedSwapResearchAction {
  kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY";
  source: RejectedSourceAction;
  baseAmountAtomic: string;
  targetAmountAtomic: string;
  baseAmountUi: number;
  targetAmountUi: number;
}

export interface RejectedSwapObservation {
  action: RejectedSourceAction;
  researchAction: RejectedSwapResearchAction;
  reason: string;
}

/**
 * Exact wallet inventory evidence for the isolated paper-research lane.
 * It deliberately has no side, base mint, output amount, price, or executable
 * swap shape, so an ignored transaction can never be promoted into LeaderSwap.
 */
export interface WalletTokenDecreaseObservation {
  kind: "WALLET_TOKEN_DECREASE_RESEARCH_ONLY";
  signature: TransactionSignature;
  wallet: PublicKeyString;
  slot: number;
  blockTime: string;
  detectedAt: string;
  recovered: boolean;
  mint: PublicKeyString;
  amountAtomic: string;
  amountUi: number;
}

interface MintDelta {
  mint: string;
  amountAtomic: bigint;
  decimals: number;
}

export class SpotSwapTransactionMalformedError extends Error {
  constructor(message: string) {
    super(`Spot-swap transaction is malformed: ${message}.`);
    this.name = "SpotSwapTransactionMalformedError";
  }
}

interface HistoryMintDelta {
  mint: string;
  amountUi: number;
  grossAmountUi: number;
}

const HISTORY_NATIVE_SOL_PSEUDO_MINT = "__helius_native_sol__";
const HISTORY_NATIVE_SOL_ALIASES = new Set([
  "SOL",
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111111"
]);
const HISTORY_ANALYTICS_DECIMALS = 9;
const HISTORY_NET_ABSOLUTE_EPSILON = 1e-12;
const HISTORY_NET_RELATIVE_EPSILON = 1e-9;

function validDecimals(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 18;
}

function validUnixSeconds(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000
  );
}

function accountKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return stringValue(asRecord(value)?.pubkey);
}

function instructionProgramId(value: unknown, keys: readonly string[]): string | undefined {
  const instruction = asRecord(value);
  if (!instruction) return undefined;
  const direct = stringValue(instruction.programId);
  if (direct) return direct;
  const index = finiteNumber(instruction.programIdIndex);
  return Number.isSafeInteger(index) && (index ?? -1) >= 0 ? keys[index as number] : undefined;
}

function decodeBase58InstructionData(value: unknown): Uint8Array | undefined {
  const encoded = stringValue(value);
  if (!encoded || encoded.length > MAX_INSTRUCTION_DATA_BASE58_LENGTH) return undefined;
  let decoded = 0n;
  for (const character of encoded) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) return undefined;
    decoded = decoded * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (decoded > 0n) {
    body.unshift(Number(decoded & 0xffn));
    decoded >>= 8n;
  }
  let leadingZeroes = 0;
  while (encoded[leadingZeroes] === "1") leadingZeroes += 1;
  return Uint8Array.from([...Array<number>(leadingZeroes).fill(0), ...body]);
}

function hasPrefix(data: Uint8Array, prefix: readonly number[]): boolean {
  return data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte);
}

function hasNonZeroLittleEndianInteger(data: Uint8Array, offset: number, length: number): boolean {
  return data.slice(offset, offset + length).some((byte) => byte !== 0);
}

function isBooleanByte(value: number | undefined): boolean {
  return value === 0 || value === 1;
}

const TOKEN_PROGRAM_IDS: ReadonlySet<string> = new Set([
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
]);

class BorshReader {
  private offset: number;

  constructor(private readonly bytes: Uint8Array, offset = 0) {
    this.offset = offset;
  }

  readU8(): number | undefined {
    const value = this.bytes[this.offset];
    if (value === undefined) return undefined;
    this.offset += 1;
    return value;
  }

  readU16(): number | undefined {
    if (this.offset + 2 > this.bytes.length) return undefined;
    const value = (this.bytes[this.offset] ?? 0) | ((this.bytes[this.offset + 1] ?? 0) << 8);
    this.offset += 2;
    return value;
  }

  readU32(): number | undefined {
    if (this.offset + 4 > this.bytes.length) return undefined;
    const value = (
      (this.bytes[this.offset] ?? 0) |
      ((this.bytes[this.offset + 1] ?? 0) << 8) |
      ((this.bytes[this.offset + 2] ?? 0) << 16) |
      ((this.bytes[this.offset + 3] ?? 0) << 24)
    ) >>> 0;
    this.offset += 4;
    return value;
  }

  readU64(): bigint | undefined {
    if (this.offset + 8 > this.bytes.length) return undefined;
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      value |= BigInt(this.bytes[this.offset + index] ?? 0) << BigInt(index * 8);
    }
    this.offset += 8;
    return value;
  }

  skip(length: number): boolean {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) return false;
    this.offset += length;
    return true;
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function transactionAccountKeys(transaction: Record<string, unknown>): string[] | undefined {
  const message = asRecord(asRecord(transaction.transaction)?.message);
  const meta = asRecord(transaction.meta);
  const loaded = asRecord(meta?.loadedAddresses);
  if (!Array.isArray(message?.accountKeys)) return undefined;
  const values = [
    ...message.accountKeys,
    ...(Array.isArray(loaded?.writable) ? loaded.writable : []),
    ...(Array.isArray(loaded?.readonly) ? loaded.readonly : [])
  ];
  const keys = values.map(accountKey);
  return keys.some((key) => key === undefined) ? undefined : keys as string[];
}

function instructionAccounts(value: unknown, keys: readonly string[]): string[] | undefined {
  const accounts = asRecord(value)?.accounts;
  if (!Array.isArray(accounts)) return undefined;
  const resolved = accounts.map((account) => {
    if (typeof account === "string" && account.length > 0) return account;
    const index = finiteNumber(account);
    return Number.isSafeInteger(index) && (index ?? -1) >= 0 ? keys[index as number] : undefined;
  });
  return resolved.some((account) => account === undefined) ? undefined : resolved as string[];
}

interface InstructionOccurrence {
  instruction: unknown;
  outerIndex: number;
  isInner: boolean;
}

function allTransactionInstructions(
  transaction: Record<string, unknown>
): InstructionOccurrence[] | undefined {
  const message = asRecord(asRecord(transaction.transaction)?.message);
  const meta = asRecord(transaction.meta);
  if (!Array.isArray(message?.instructions)) return undefined;
  const outer = message.instructions;
  const innerGroups = Array.isArray(meta?.innerInstructions) ? meta.innerInstructions : [];
  const indices = new Set<number>();
  const inner: InstructionOccurrence[] = [];
  for (const group of innerGroups) {
    const record = asRecord(group);
    const index = finiteNumber(record?.index);
    if (
      !Number.isSafeInteger(index) || (index ?? -1) < 0 || (index as number) >= outer.length ||
      indices.has(index as number) || !Array.isArray(record?.instructions)
    ) return undefined;
    indices.add(index as number);
    inner.push(...record.instructions.map((instruction) => ({
      instruction,
      outerIndex: index as number,
      isInner: true
    })));
  }
  return [
    ...outer.map((instruction, outerIndex) => ({ instruction, outerIndex, isInner: false })),
    ...inner
  ];
}

function readAllowedV6Swap(reader: BorshReader): boolean {
  const variant = reader.readU8();
  if (variant === undefined) return false;
  // Only protocols with an independently exact direct decoder are accepted.
  if (variant === 7 || variant === 26 || variant === 38 || variant === 40 || variant === 46) {
    return true;
  }
  if (variant === 17) return isBooleanByte(reader.readU8());
  return false;
}

function readV6RoutePlan(reader: BorshReader, bps: boolean): boolean {
  const length = reader.readU32();
  if (length === undefined || length < 1 || length > MAX_ROUTE_STEPS) return false;
  for (let index = 0; index < length; index += 1) {
    if (!readAllowedV6Swap(reader)) return false;
    const allocation = bps ? reader.readU16() : reader.readU8();
    const inputIndex = reader.readU8();
    const outputIndex = reader.readU8();
    if (
      allocation === undefined || allocation < 1 || allocation > (bps ? 10_000 : 100) ||
      inputIndex === undefined || outputIndex === undefined || inputIndex === outputIndex
    ) return false;
  }
  return true;
}

function readPositiveU64(reader: BorshReader): boolean {
  const value = reader.readU64();
  return value !== undefined && value > 0n;
}

type V6RouteShape =
  | "ROUTE"
  | "EXACT_OUT"
  | "LEDGER"
  | "SHARED_ROUTE"
  | "SHARED_EXACT_OUT"
  | "SHARED_LEDGER"
  | "ROUTE_V2"
  | "EXACT_OUT_V2"
  | "SHARED_ROUTE_V2"
  | "SHARED_EXACT_OUT_V2";

interface JupiterV6InstructionSpec {
  discriminator: readonly number[];
  shape: V6RouteShape;
  minimumAccounts: number;
  authorityIndex: number;
  tokenProgramRequirements: readonly (readonly [number, "TOKEN" | "TOKEN_2022" | "EITHER"])[];
  eventAuthorityIndex: number;
  programIndex: number;
}

const JUPITER_V6_INSTRUCTION_SPECS: readonly JupiterV6InstructionSpec[] = [
  { discriminator: JUPITER_V4_ROUTE_DISCRIMINATOR, shape: "ROUTE", minimumAccounts: 9, authorityIndex: 1, tokenProgramRequirements: [[0, "TOKEN"]], eventAuthorityIndex: 7, programIndex: 8 },
  { discriminator: [208, 51, 239, 151, 123, 43, 237, 92], shape: "EXACT_OUT", minimumAccounts: 11, authorityIndex: 1, tokenProgramRequirements: [[0, "TOKEN"], [8, "TOKEN_2022"]], eventAuthorityIndex: 9, programIndex: 10 },
  { discriminator: [150, 86, 71, 116, 167, 93, 14, 104], shape: "LEDGER", minimumAccounts: 10, authorityIndex: 1, tokenProgramRequirements: [[0, "TOKEN"]], eventAuthorityIndex: 8, programIndex: 9 },
  { discriminator: [193, 32, 155, 51, 65, 214, 156, 129], shape: "SHARED_ROUTE", minimumAccounts: 13, authorityIndex: 2, tokenProgramRequirements: [[0, "TOKEN"], [10, "TOKEN_2022"]], eventAuthorityIndex: 11, programIndex: 12 },
  { discriminator: [176, 209, 105, 168, 154, 125, 69, 62], shape: "SHARED_EXACT_OUT", minimumAccounts: 13, authorityIndex: 2, tokenProgramRequirements: [[0, "TOKEN"], [10, "TOKEN_2022"]], eventAuthorityIndex: 11, programIndex: 12 },
  { discriminator: [230, 121, 143, 80, 119, 159, 106, 170], shape: "SHARED_LEDGER", minimumAccounts: 14, authorityIndex: 2, tokenProgramRequirements: [[0, "TOKEN"], [10, "TOKEN_2022"]], eventAuthorityIndex: 12, programIndex: 13 },
  { discriminator: [187, 100, 250, 204, 49, 196, 175, 20], shape: "ROUTE_V2", minimumAccounts: 10, authorityIndex: 0, tokenProgramRequirements: [[5, "EITHER"], [6, "EITHER"]], eventAuthorityIndex: 8, programIndex: 9 },
  { discriminator: [157, 138, 184, 82, 21, 244, 243, 36], shape: "EXACT_OUT_V2", minimumAccounts: 10, authorityIndex: 0, tokenProgramRequirements: [[5, "EITHER"], [6, "EITHER"]], eventAuthorityIndex: 8, programIndex: 9 },
  { discriminator: [209, 152, 83, 147, 124, 254, 216, 233], shape: "SHARED_ROUTE_V2", minimumAccounts: 12, authorityIndex: 1, tokenProgramRequirements: [[8, "EITHER"], [9, "EITHER"]], eventAuthorityIndex: 10, programIndex: 11 },
  { discriminator: [53, 96, 229, 202, 216, 187, 250, 24], shape: "SHARED_EXACT_OUT_V2", minimumAccounts: 12, authorityIndex: 1, tokenProgramRequirements: [[8, "EITHER"], [9, "EITHER"]], eventAuthorityIndex: 10, programIndex: 11 }
];

function readLegacyV6Args(reader: BorshReader, shape: V6RouteShape): boolean {
  const shared = shape.startsWith("SHARED_");
  if (shared) {
    const id = reader.readU8();
    if (id === undefined || id > 15) return false;
  }
  if (!readV6RoutePlan(reader, false)) return false;
  if (shape === "ROUTE" || shape === "SHARED_ROUTE") {
    if (!readPositiveU64(reader) || !readPositiveU64(reader)) return false;
  } else if (shape === "EXACT_OUT" || shape === "SHARED_EXACT_OUT") {
    if (!readPositiveU64(reader) || !readPositiveU64(reader)) return false;
  } else if (!readPositiveU64(reader)) {
    return false;
  }
  const slippage = reader.readU16();
  return slippage !== undefined && slippage <= 10_000 && reader.readU8() !== undefined && reader.done;
}

function readV2Args(reader: BorshReader, shape: V6RouteShape): boolean {
  if (shape.startsWith("SHARED_")) {
    const id = reader.readU8();
    if (id === undefined || id > 15) return false;
  }
  if (!readPositiveU64(reader) || !readPositiveU64(reader)) return false;
  const slippage = reader.readU16();
  const platformFee = reader.readU16();
  const positiveSlippage = reader.readU16();
  if (
    slippage === undefined || slippage > 10_000 ||
    platformFee === undefined || platformFee > 10_000 ||
    positiveSlippage === undefined || positiveSlippage > 10_000
  ) return false;
  return readV6RoutePlan(reader, true) && reader.done;
}

function readAllowedV4Swap(reader: BorshReader): boolean {
  const variant = reader.readU8();
  if (variant === 7 || variant === 26) return true;
  return variant === 17 && isBooleanByte(reader.readU8());
}

function readV4SwapLegSwap(reader: BorshReader): boolean {
  return reader.readU8() === 2 && readAllowedV4Swap(reader);
}

function readBoundedVector(reader: BorshReader, readItem: (reader: BorshReader) => boolean): boolean {
  const length = reader.readU32();
  if (length === undefined || length < 1 || length > MAX_ROUTE_STEPS) return false;
  for (let index = 0; index < length; index += 1) if (!readItem(reader)) return false;
  return true;
}

function readV4SwapLegDeeper(reader: BorshReader): boolean {
  const variant = reader.readU8();
  if (variant === 0) return readBoundedVector(reader, readV4SwapLegSwap);
  if (variant === 1) return readBoundedVector(reader, (value) => {
    const percent = value.readU8();
    return percent !== undefined && percent >= 1 && percent <= 100 && readV4SwapLegSwap(value);
  });
  return variant === 2 && readAllowedV4Swap(reader);
}

function readV4SwapLeg(reader: BorshReader): boolean {
  const variant = reader.readU8();
  if (variant === 0) return readBoundedVector(reader, readV4SwapLegDeeper);
  if (variant === 1) return readBoundedVector(reader, (value) => {
    const percent = value.readU8();
    return percent !== undefined && percent >= 1 && percent <= 100 && readV4SwapLegDeeper(value);
  });
  return variant === 2 && readAllowedV4Swap(reader);
}

function isJupiterV4RouteData(data: Uint8Array): boolean {
  if (!hasPrefix(data, JUPITER_V4_ROUTE_DISCRIMINATOR)) return false;
  const reader = new BorshReader(data, 8);
  if (!readV4SwapLeg(reader) || !readPositiveU64(reader) || !readPositiveU64(reader)) return false;
  const slippage = reader.readU16();
  return slippage !== undefined && slippage <= 10_000 && reader.readU8() !== undefined && reader.done;
}

interface RecognizedJupiterInstruction {
  eventAuthority: string;
}

function recognizedJupiterInstruction(
  programId: string,
  instruction: unknown,
  wallet: string,
  keys: readonly string[]
): RecognizedJupiterInstruction | undefined {
  const data = decodeBase58InstructionData(asRecord(instruction)?.data);
  const accounts = instructionAccounts(instruction, keys);
  if (!data || !accounts) return undefined;
  if (programId === JUPITER_V4_PROGRAM_ID) {
    return accounts.length >= 3 && accounts[0] === TOKEN_PROGRAM_ID && accounts[1] === wallet &&
      isJupiterV4RouteData(data)
      ? { eventAuthority: "" }
      : undefined;
  }
  const spec = JUPITER_V6_INSTRUCTION_SPECS.find((candidate) => hasPrefix(data, candidate.discriminator));
  if (!spec || accounts.length < spec.minimumAccounts) return undefined;
  if (
    accounts[spec.authorityIndex] !== wallet ||
    accounts[spec.programIndex] !== JUPITER_V6_PROGRAM_ID ||
    spec.tokenProgramRequirements.some(([index, requirement]) => {
      const account = accounts[index];
      if (requirement === "TOKEN") return account !== TOKEN_PROGRAM_ID;
      if (requirement === "TOKEN_2022") return account !== TOKEN_2022_PROGRAM_ID;
      return !TOKEN_PROGRAM_IDS.has(account ?? "");
    })
  ) return undefined;
  const eventAuthority = accounts[spec.eventAuthorityIndex];
  if (eventAuthority !== JUPITER_EVENT_AUTHORITY) return undefined;
  const reader = new BorshReader(data, 8);
  const valid = spec.shape.endsWith("_V2")
    ? readV2Args(reader, spec.shape)
    : readLegacyV6Args(reader, spec.shape);
  return valid ? { eventAuthority } : undefined;
}

/**
 * Recognizes only the immutable Jupiter instruction envelope, without
 * accepting the route payload. This is deliberately weaker than
 * `recognizedJupiterInstruction` and may therefore be used only to retain an
 * audit-only rejection. Executable decoding must continue through the full
 * route parser above.
 */
function recognizedJupiterInstructionEnvelope(
  programId: string,
  instruction: unknown,
  wallet: string,
  keys: readonly string[]
): boolean {
  const data = decodeBase58InstructionData(asRecord(instruction)?.data);
  const accounts = instructionAccounts(instruction, keys);
  if (!data || !accounts) return false;
  if (programId === JUPITER_V4_PROGRAM_ID) {
    return accounts.length >= 3 &&
      accounts[0] === TOKEN_PROGRAM_ID &&
      accounts[1] === wallet &&
      hasPrefix(data, JUPITER_V4_ROUTE_DISCRIMINATOR);
  }
  if (programId !== JUPITER_V6_PROGRAM_ID) return false;
  const spec = JUPITER_V6_INSTRUCTION_SPECS.find((candidate) =>
    hasPrefix(data, candidate.discriminator)
  );
  if (!spec || accounts.length < spec.minimumAccounts) return false;
  if (
    accounts[spec.authorityIndex] !== wallet ||
    accounts[spec.programIndex] !== JUPITER_V6_PROGRAM_ID ||
    spec.tokenProgramRequirements.some(([index, requirement]) => {
      const account = accounts[index];
      if (requirement === "TOKEN") return account !== TOKEN_PROGRAM_ID;
      if (requirement === "TOKEN_2022") return account !== TOKEN_2022_PROGRAM_ID;
      return !TOKEN_PROGRAM_IDS.has(account ?? "");
    })
  ) return false;
  return accounts[spec.eventAuthorityIndex] === JUPITER_EVENT_AUTHORITY;
}

function isOrcaSwapV2Data(data: Uint8Array): boolean {
  if (
    !hasPrefix(data, ORCA_SWAP_V2_DISCRIMINATOR) ||
    data.length < 43 ||
    !hasNonZeroLittleEndianInteger(data, 8, 8) ||
    !isBooleanByte(data[40]) ||
    !isBooleanByte(data[41])
  ) return false;
  const option = data[42];
  if (option === 0) return data.length === 43;
  if (option !== 1 || data.length < 47) return false;
  const sliceCount =
    (data[43] ?? 0) |
    ((data[44] ?? 0) << 8) |
    ((data[45] ?? 0) << 16) |
    ((data[46] ?? 0) << 24);
  if (sliceCount < 0 || sliceCount > 255 || data.length !== 47 + sliceCount * 2) return false;
  for (let index = 0; index < sliceCount; index += 1) {
    // The official AccountsType enum currently has variants 0 through 12.
    if ((data[47 + index * 2] ?? 255) > 12) return false;
  }
  return true;
}

function isDirectSpotSwapInstruction(
  programId: string,
  instruction: unknown,
  wallet?: string,
  keys: readonly string[] = []
): boolean {
  const data = decodeBase58InstructionData(asRecord(instruction)?.data);
  if (!data) return false;
  if (programId === ORCA_WHIRLPOOL_PROGRAM_ID) {
    return (
      (data.length === 42 &&
        hasPrefix(data, ORCA_SWAP_DISCRIMINATOR) &&
        hasNonZeroLittleEndianInteger(data, 8, 8) &&
        isBooleanByte(data[40]) &&
        isBooleanByte(data[41])) ||
      isOrcaSwapV2Data(data)
    );
  }
  if (programId === RAYDIUM_CPMM_PROGRAM_ID) {
    return data.length === 24 &&
      hasNonZeroLittleEndianInteger(data, 8, 8) &&
      (hasPrefix(data, RAYDIUM_SWAP_BASE_INPUT_DISCRIMINATOR) ||
        hasPrefix(data, RAYDIUM_SWAP_BASE_OUTPUT_DISCRIMINATOR));
  }
  if (programId === RAYDIUM_CLMM_PROGRAM_ID) {
    const singlePoolSwap = data.length === 41 &&
      hasNonZeroLittleEndianInteger(data, 8, 8) &&
      isBooleanByte(data[40]) &&
      (hasPrefix(data, RAYDIUM_SWAP_DISCRIMINATOR) ||
        hasPrefix(data, RAYDIUM_SWAP_V2_DISCRIMINATOR));
    const routedSwap = data.length === 24 &&
      hasNonZeroLittleEndianInteger(data, 8, 8) &&
      hasPrefix(data, RAYDIUM_SWAP_ROUTER_BASE_IN_DISCRIMINATOR);
    return singlePoolSwap || routedSwap;
  }
  if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
    return data.length === 17 &&
      hasNonZeroLittleEndianInteger(data, 1, 8) &&
      RAYDIUM_AMM_V4_SWAP_OPCODES.has(data[0] ?? -1);
  }
  if (programId === METEORA_DLMM_PROGRAM_ID) {
    const accounts = instructionAccounts(instruction, keys);
    if (
      !wallet || !accounts || accounts.length < 15 || accounts[10] !== wallet ||
      !TOKEN_PROGRAM_IDS.has(accounts[11] ?? "") ||
      !TOKEN_PROGRAM_IDS.has(accounts[12] ?? "") ||
      accounts[14] !== METEORA_DLMM_PROGRAM_ID
    ) return false;
    if (
      data.length === 24 &&
      (hasPrefix(data, ORCA_SWAP_DISCRIMINATOR) ||
        hasPrefix(data, METEORA_SWAP_EXACT_OUT_DISCRIMINATOR))
    ) {
      return hasNonZeroLittleEndianInteger(data, 8, 8) &&
        hasNonZeroLittleEndianInteger(data, 16, 8);
    }
    if (!hasPrefix(data, METEORA_SWAP_WITH_PRICE_IMPACT_DISCRIMINATOR)) return false;
    if (!hasNonZeroLittleEndianInteger(data, 8, 8)) return false;
    const option = data[16];
    const bpsOffset = option === 0 ? 17 : option === 1 ? 21 : -1;
    if (bpsOffset < 0 || data.length !== bpsOffset + 2) return false;
    const bps = (data[bpsOffset] ?? 0) | ((data[bpsOffset + 1] ?? 0) << 8);
    return bps <= 10_000;
  }
  return false;
}

function parsedInstruction(value: unknown): { type: string; info: Record<string, unknown> } | undefined {
  const parsed = asRecord(asRecord(value)?.parsed);
  const type = stringValue(parsed?.type);
  const info = asRecord(parsed?.info);
  return type && info ? { type, info } : undefined;
}

/**
 * Block batching is safe only when the RPC honored `jsonParsed` for the
 * instruction families whose policy checks depend on parsed fields. Returning
 * false lets the indexer fall back to its ordinary per-signature
 * `getTransaction(jsonParsed)` path instead of silently treating a valid swap
 * as an unsupported raw instruction.
 */
export function hasParsedSpotSwapSafetyInstructions(value: unknown): boolean {
  const transaction = asRecord(value);
  if (!transaction) return false;
  const keys = transactionAccountKeys(transaction);
  const instructions = allTransactionInstructions(transaction);
  if (!keys || !instructions) return false;
  return instructions.every(({ instruction }) => {
    const programId = instructionProgramId(instruction, keys);
    if (!programId) return false;
    if (
      programId !== SYSTEM_PROGRAM_ID &&
      programId !== ASSOCIATED_TOKEN_PROGRAM_ID &&
      !TOKEN_PROGRAM_IDS.has(programId)
    ) return true;
    return parsedInstruction(instruction) !== undefined;
  });
}

function walletOwnedTokenAccounts(
  transaction: Record<string, unknown>,
  wallet: string,
  keys: readonly string[]
): Map<string, string> | undefined {
  const meta = asRecord(transaction.meta);
  if (!Array.isArray(meta?.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return undefined;
  const result = new Map<string, string>();
  for (const item of [...meta.preTokenBalances, ...meta.postTokenBalances]) {
    const balance = asRecord(item);
    const index = finiteNumber(balance?.accountIndex);
    const owner = stringValue(balance?.owner);
    if (owner !== wallet) continue;
    const mint = stringValue(balance?.mint);
    if (!Number.isSafeInteger(index) || (index ?? -1) < 0 || !keys[index as number] || !mint) return undefined;
    const account = keys[index as number] as string;
    if (result.has(account) && result.get(account) !== mint) return undefined;
    result.set(account, mint);
  }
  return result;
}

interface CreatedAssociatedTokenAccount {
  account: string;
  mint: string;
}

function associatedTokenAccountCreatedForWallet(
  instruction: unknown,
  wallet: string
): CreatedAssociatedTokenAccount | undefined {
  const parsed = parsedInstruction(instruction);
  if (!parsed || (parsed.type !== "create" && parsed.type !== "createIdempotent")) return undefined;
  const account = stringValue(parsed.info.account);
  const mint = stringValue(parsed.info.mint);
  const source = stringValue(parsed.info.source);
  const owner = stringValue(parsed.info.wallet);
  const systemProgram = stringValue(parsed.info.systemProgram);
  const tokenProgram = stringValue(parsed.info.tokenProgram);
  return account && mint && source === wallet && owner === wallet && systemProgram === SYSTEM_PROGRAM_ID &&
    tokenProgram !== undefined && TOKEN_PROGRAM_IDS.has(tokenProgram)
    ? { account, mint }
    : undefined;
}

function isComputeBudgetInstruction(instruction: unknown, keys: readonly string[]): boolean {
  const accounts = instructionAccounts(instruction, keys);
  const data = decodeBase58InstructionData(asRecord(instruction)?.data);
  if (!accounts || accounts.length !== 0 || !data) return false;
  const opcode = data[0];
  return (
    (opcode === 0 && data.length === 9) ||
    ((opcode === 1 || opcode === 2 || opcode === 4) && data.length === 5) ||
    (opcode === 3 && data.length === 9)
  );
}

interface RentEvidence {
  created: Map<string, bigint>;
  closed: Set<string>;
}

function isSafeTokenInstruction(
  instruction: unknown,
  wallet: string,
  walletAccounts: ReadonlyMap<string, string>,
  evidence: RentEvidence
): boolean {
  const parsed = parsedInstruction(instruction);
  if (!parsed) return false;
  const account = stringValue(parsed.info.account);
  if (parsed.type === "getAccountDataSize") return Boolean(stringValue(parsed.info.mint));
  if (
    parsed.type === "initializeAccount" ||
    parsed.type === "initializeAccount2" ||
    parsed.type === "initializeAccount3" ||
    parsed.type === "initializeImmutableOwner" ||
    parsed.type === "syncNative"
  ) return account !== undefined && walletAccounts.has(account);
  if (parsed.type === "transfer" || parsed.type === "transferChecked") {
    const stackHeight = finiteNumber(asRecord(instruction)?.stackHeight);
    return Number.isSafeInteger(stackHeight) && (stackHeight ?? 0) >= 2 &&
      Boolean(stringValue(parsed.info.source)) && Boolean(stringValue(parsed.info.destination));
  }
  if (parsed.type === "closeAccount") {
    const destination = stringValue(parsed.info.destination);
    const owner = stringValue(parsed.info.owner);
    if (!account || destination !== wallet || owner !== wallet || !walletAccounts.has(account)) return false;
    if (evidence.closed.has(account)) return false;
    evidence.closed.add(account);
    return true;
  }
  return false;
}

function isSafeSystemInstruction(
  instruction: unknown,
  wallet: string,
  walletAccounts: ReadonlyMap<string, string>,
  evidence: RentEvidence
): boolean {
  const parsed = parsedInstruction(instruction);
  if (!parsed) return false;
  const source = stringValue(parsed.info.source);
  if (parsed.type === "createAccount") {
    const account = stringValue(parsed.info.newAccount);
    const owner = stringValue(parsed.info.owner);
    const lamports = finiteNumber(parsed.info.lamports);
    const space = finiteNumber(parsed.info.space);
    if (
      source !== wallet || !account || !walletAccounts.has(account) || owner !== TOKEN_PROGRAM_ID ||
      !Number.isSafeInteger(lamports) || (lamports ?? -1) < 0 || space !== 165 || evidence.created.has(account)
    ) return false;
    evidence.created.set(account, BigInt(lamports as number));
    return true;
  }
  if (parsed.type === "transfer") {
    const destination = stringValue(parsed.info.destination);
    const lamports = finiteNumber(parsed.info.lamports);
    return source === wallet && destination !== undefined && walletAccounts.get(destination) === SOL_MINT &&
      Number.isSafeInteger(lamports) && (lamports ?? 0) > 0;
  }
  return false;
}

function isKnownAnchorEventInstruction(
  programId: string,
  instruction: unknown,
  keys: readonly string[],
  allowedEventAuthorities: ReadonlySet<string>
): boolean {
  const accounts = instructionAccounts(instruction, keys);
  const data = decodeBase58InstructionData(asRecord(instruction)?.data);
  if (
    !accounts || accounts.length !== 1 || !allowedEventAuthorities.has(accounts[0] ?? "") ||
    !data || !hasPrefix(data, ANCHOR_EVENT_CPI_DISCRIMINATOR)
  ) return false;
  if (programId === JUPITER_V6_PROGRAM_ID) {
    if (hasPrefix(data.slice(8), JUPITER_SWAP_EVENT_DISCRIMINATOR)) return data.length === 128;
    if (!hasPrefix(data.slice(8), JUPITER_SWAPS_EVENT_DISCRIMINATOR) || data.length < 100) return false;
    const count = (
      (data[16] ?? 0) |
      ((data[17] ?? 0) << 8) |
      ((data[18] ?? 0) << 16) |
      ((data[19] ?? 0) << 24)
    ) >>> 0;
    return count >= 1 && count <= MAX_ROUTE_STEPS && data.length === 20 + count * 80;
  }
  if (programId === METEORA_DLMM_PROGRAM_ID) {
    return (
      hasPrefix(data.slice(8), METEORA_SWAP_EVENT_DISCRIMINATOR) && data.length === 145
    ) || (
      hasPrefix(data.slice(8), METEORA_SWAP2_EVENT_DISCRIMINATOR) && data.length === 163
    );
  }
  return false;
}

function closeAccountRent(
  transaction: Record<string, unknown>,
  wallet: string,
  keys: readonly string[],
  account: string,
  createdRent: bigint | undefined
): bigint | undefined {
  if (createdRent !== undefined) return createdRent;
  const index = keys.indexOf(account);
  const meta = asRecord(transaction.meta);
  if (index < 0 || !Array.isArray(meta?.preBalances)) return undefined;
  const nativeBalance = finiteNumber(meta.preBalances[index]);
  if (!Number.isSafeInteger(nativeBalance) || (nativeBalance ?? -1) < 0) return undefined;
  const tokenBalance = Array.isArray(meta.preTokenBalances)
    ? meta.preTokenBalances.map(asRecord).find((balance) =>
      finiteNumber(balance?.accountIndex) === index && stringValue(balance?.owner) === wallet)
    : undefined;
  if (stringValue(tokenBalance?.mint) !== SOL_MINT) return BigInt(nativeBalance as number);
  const amount = stringValue(asRecord(tokenBalance?.uiTokenAmount)?.amount);
  if (!amount || !/^\d+$/.test(amount)) return undefined;
  const reserve = BigInt(nativeBalance as number) - BigInt(amount);
  return reserve >= 0n ? reserve : undefined;
}

interface InstructionPolicyResult {
  rentAdjustmentAtomic: bigint;
}

function validateInstructionPolicy(
  transaction: Record<string, unknown>,
  context: SpotSwapDecodeContext,
  allowed: ReadonlySet<string>
): InstructionPolicyResult | undefined {
  const keys = transactionAccountKeys(transaction);
  if (!keys) return undefined;
  const instructions = allTransactionInstructions(transaction);
  if (!instructions || instructions.length === 0) return undefined;
  const walletAccounts = walletOwnedTokenAccounts(transaction, context.wallet, keys);
  if (!walletAccounts) return undefined;
  for (const { instruction } of instructions) {
    if (instructionProgramId(instruction, keys) !== ASSOCIATED_TOKEN_PROGRAM_ID) continue;
    const created = associatedTokenAccountCreatedForWallet(instruction, context.wallet);
    if (!created) return undefined;
    if (walletAccounts.has(created.account) && walletAccounts.get(created.account) !== created.mint) return undefined;
    walletAccounts.set(created.account, created.mint);
  }

  const jupiterSwaps = new Map<unknown, RecognizedJupiterInstruction>();
  const directSwaps = new Set<unknown>();
  const eventAuthorities = new Map<string, Set<string>>();
  const addEventAuthority = (programId: string, authority: string | undefined) => {
    if (!authority) return;
    const values = eventAuthorities.get(programId) ?? new Set<string>();
    values.add(authority);
    eventAuthorities.set(programId, values);
  };
  for (const occurrence of instructions) {
    const { instruction } = occurrence;
    const programId = instructionProgramId(instruction, keys);
    if (!programId) return undefined;
    if (JUPITER_SPOT_SWAP_PROGRAM_IDS.has(programId)) {
      const recognized = recognizedJupiterInstruction(programId, instruction, context.wallet, keys);
      // Copy attribution only accepts Jupiter as the transaction's explicit
      // top-level intent. A Jupiter CPI behind an arbitrary outer program is a
      // bundled/custom execution whose full semantics are not known here.
      if (recognized && !occurrence.isInner) {
        jupiterSwaps.set(instruction, recognized);
        addEventAuthority(programId, recognized.eventAuthority);
      }
      continue;
    }
    if (DIRECT_SPOT_SWAP_PROGRAM_IDS.has(programId) &&
      isDirectSpotSwapInstruction(programId, instruction, context.wallet, keys)) {
      directSwaps.add(instruction);
      if (programId === METEORA_DLMM_PROGRAM_ID) {
        addEventAuthority(programId, instructionAccounts(instruction, keys)?.[13]);
      }
    }
  }

  const allowedJupiterRoutes = instructions.filter(({ instruction, isInner }) =>
    !isInner && jupiterSwaps.has(instruction) &&
    allowed.has(instructionProgramId(instruction, keys) ?? ""));
  const allowedDirectRoutes = instructions.filter(({ instruction, isInner }) =>
    !isInner && directSwaps.has(instruction) &&
    allowed.has(instructionProgramId(instruction, keys) ?? ""));
  if (allowedJupiterRoutes.length + allowedDirectRoutes.length !== 1) return undefined;
  const route = allowedJupiterRoutes[0] ?? allowedDirectRoutes[0];
  if (!route) return undefined;
  const hasAllowedJupiter = allowedJupiterRoutes.length === 1;
  // Every recognized swap CPI must be causally nested under the one accepted
  // route. This rejects a valid-looking Jupiter instruction bundled beside an
  // unrelated top-level direct swap (or vice versa).
  for (const occurrence of instructions) {
    if (!directSwaps.has(occurrence.instruction)) continue;
    if (!occurrence.isInner && occurrence !== route) return undefined;
    if (occurrence.isInner && occurrence.outerIndex !== route.outerIndex) return undefined;
  }
  // A Jupiter route executes its route plan through CPI. Missing inner swap
  // evidence means the RPC response is incomplete and cannot be audited.
  if (hasAllowedJupiter && !instructions.some((occurrence) =>
    occurrence.isInner && occurrence.outerIndex === route.outerIndex &&
    directSwaps.has(occurrence.instruction))) return undefined;

  const evidence: RentEvidence = { created: new Map(), closed: new Set() };
  for (const occurrence of instructions) {
    const { instruction } = occurrence;
    const programId = instructionProgramId(instruction, keys);
    if (!programId) return undefined;
    if (JUPITER_SPOT_SWAP_PROGRAM_IDS.has(programId)) {
      if (jupiterSwaps.has(instruction)) {
        if (!allowed.has(programId)) return undefined;
        continue;
      }
      if (isKnownAnchorEventInstruction(
        programId,
        instruction,
        keys,
        eventAuthorities.get(programId) ?? new Set()
      ) && occurrence.isInner && occurrence.outerIndex === route.outerIndex) continue;
      return undefined;
    }
    if (DIRECT_SPOT_SWAP_PROGRAM_IDS.has(programId)) {
      if (directSwaps.has(instruction)) {
        if (!allowed.has(programId) && !hasAllowedJupiter) return undefined;
        continue;
      }
      if (isKnownAnchorEventInstruction(
        programId,
        instruction,
        keys,
        eventAuthorities.get(programId) ?? new Set()
      ) && occurrence.isInner && occurrence.outerIndex === route.outerIndex) continue;
      return undefined;
    }
    if (programId === COMPUTE_BUDGET_PROGRAM_ID) {
      if (!isComputeBudgetInstruction(instruction, keys)) return undefined;
      continue;
    }
    if (programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
      if (!associatedTokenAccountCreatedForWallet(instruction, context.wallet)) return undefined;
      continue;
    }
    if (TOKEN_PROGRAM_IDS.has(programId)) {
      if (!isSafeTokenInstruction(instruction, context.wallet, walletAccounts, evidence)) return undefined;
      continue;
    }
    if (programId === SYSTEM_PROGRAM_ID) {
      if (!isSafeSystemInstruction(instruction, context.wallet, walletAccounts, evidence)) return undefined;
      continue;
    }
    // No arbitrary auxiliary program is accepted: bridges, staking, lending,
    // LP, tip, fee, memo, and unknown instructions all fail closed here.
    return undefined;
  }

  let rentAdjustmentAtomic = 0n;
  for (const value of evidence.created.values()) rentAdjustmentAtomic += value;
  for (const account of evidence.closed) {
    const rent = closeAccountRent(transaction, context.wallet, keys, account, evidence.created.get(account));
    if (rent === undefined) return undefined;
    rentAdjustmentAtomic -= rent;
  }
  return { rentAdjustmentAtomic };
}

function parseTokenBalances(
  transaction: Record<string, unknown>,
  wallet: string
): MintDelta[] {
  const meta = asRecord(transaction.meta);
  if (!meta) throw new SpotSwapTransactionMalformedError("metadata is missing");
  if (!Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) {
    throw new SpotSwapTransactionMalformedError("token-balance arrays are missing");
  }
  const pre = meta.preTokenBalances;
  const post = meta.postTokenBalances;
  const ownerByIndex = new Map<number, string>();
  for (const item of [...pre, ...post]) {
    const balance = asRecord(item);
    const index = finiteNumber(balance?.accountIndex);
    const owner = stringValue(balance?.owner);
    if (index !== undefined && owner) ownerByIndex.set(index, owner);
  }

  const totals = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  const add = (item: unknown, side: "pre" | "post") => {
    const balance = asRecord(item);
    if (!balance) throw new SpotSwapTransactionMalformedError("a token-balance entry is not an object");
    const index = finiteNumber(balance.accountIndex);
    const owner = stringValue(balance.owner) ?? (index === undefined ? undefined : ownerByIndex.get(index));
    if (owner !== wallet) return;
    const mint = stringValue(balance.mint);
    const ui = asRecord(balance.uiTokenAmount);
    const amount = stringValue(ui?.amount);
    const decimals = finiteNumber(ui?.decimals);
    if (
      !Number.isSafeInteger(index) || (index ?? -1) < 0 ||
      !mint || !amount || !/^\d+$/.test(amount) || !validDecimals(decimals)
    ) {
      throw new SpotSwapTransactionMalformedError("a wallet token balance has invalid fields");
    }
    const current = totals.get(mint) ?? { pre: 0n, post: 0n, decimals };
    if (current.decimals !== decimals) {
      throw new SpotSwapTransactionMalformedError("token decimals changed within one transaction");
    }
    current[side] += BigInt(amount);
    totals.set(mint, current);
  };
  pre.forEach((item) => add(item, "pre"));
  post.forEach((item) => add(item, "post"));

  return [...totals].flatMap(([mint, value]) => {
    const amountAtomic = value.post - value.pre;
    return amountAtomic === 0n ? [] : [{ mint, amountAtomic, decimals: value.decimals }];
  });
}

/**
 * Returns confirmed-transaction inventory decreases independently of the
 * strict swap decoder. Callers must only publish these through an isolated
 * research callback after the strict result is IGNORED.
 */
export function decodeWalletTokenDecreases(
  value: unknown,
  context: SpotSwapDecodeContext
): WalletTokenDecreaseObservation[] {
  const transaction = asRecord(value);
  const meta = asRecord(transaction?.meta);
  if (!transaction || !meta || meta.err !== null) return [];
  const slot = finiteNumber(transaction.slot);
  const blockTime = finiteNumber(transaction.blockTime);
  if (
    slot === undefined ||
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    blockTime === undefined ||
    !validUnixSeconds(blockTime) ||
    !Number.isFinite(context.detectedAt.getTime())
  ) return [];

  return parseTokenBalances(transaction, context.wallet).flatMap((delta) => {
    if (delta.amountAtomic >= 0n || delta.mint === SOL_MINT || delta.mint === USDC_MINT) {
      return [];
    }
    const amountAtomic = -delta.amountAtomic;
    return [{
      kind: "WALLET_TOKEN_DECREASE_RESEARCH_ONLY" as const,
      signature: context.signature,
      wallet: context.wallet,
      slot,
      blockTime: new Date(blockTime * 1_000).toISOString(),
      detectedAt: context.detectedAt.toISOString(),
      recovered: context.recovered,
      mint: delta.mint,
      amountAtomic: amountAtomic.toString(),
      amountUi: Number(amountAtomic) / 10 ** delta.decimals
    }];
  });
}

function nativeSolDelta(
  transaction: Record<string, unknown>,
  wallet: string,
  rentAdjustmentAtomic: bigint
): MintDelta | undefined {
  const tx = asRecord(transaction.transaction);
  const message = asRecord(tx?.message);
  if (!Array.isArray(message?.accountKeys)) {
    throw new SpotSwapTransactionMalformedError("account keys are missing");
  }
  const keys = message.accountKeys.map(accountKey);
  if (keys.some((key) => key === undefined)) {
    throw new SpotSwapTransactionMalformedError("an account key is invalid");
  }
  const walletIndex = keys.indexOf(wallet);
  if (walletIndex < 0) return undefined;
  const meta = asRecord(transaction.meta);
  if (!Array.isArray(meta?.preBalances) || !Array.isArray(meta.postBalances)) {
    throw new SpotSwapTransactionMalformedError("native balance arrays are missing");
  }
  const preBalances = meta.preBalances;
  const postBalances = meta.postBalances;
  const before = finiteNumber(preBalances[walletIndex]);
  const after = finiteNumber(postBalances[walletIndex]);
  const fee = finiteNumber(meta?.fee) ?? 0;
  if (
    before === undefined ||
    after === undefined ||
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after) ||
    !Number.isSafeInteger(fee) ||
    fee < 0
  ) throw new SpotSwapTransactionMalformedError("wallet native balances are invalid");
  let amountAtomic = BigInt(Math.trunc(after)) - BigInt(Math.trunc(before));
  if (walletIndex === 0) amountAtomic += BigInt(fee);
  amountAtomic += rentAdjustmentAtomic;
  return amountAtomic === 0n
    ? undefined
    : { mint: SOL_MINT, amountAtomic, decimals: 9 };
}

function buildLeaderSwap(
  deltas: MintDelta[],
  slot: number,
  blockTimeSeconds: number,
  context: SpotSwapDecodeContext
): LeaderSwap | null {
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    !validUnixSeconds(blockTimeSeconds) ||
    !Number.isFinite(context.detectedAt.getTime())
  ) return null;
  if (deltas.length !== 2) return null;
  const bases = deltas.filter((delta) => delta.mint === SOL_MINT || delta.mint === USDC_MINT);
  if (bases.length !== 1) return null;
  const base = bases[0];
  const target = deltas.find((delta) => delta !== base);
  if (!base || !target || base.amountAtomic * target.amountAtomic >= 0n) return null;
  const baseAmountAtomic = base.amountAtomic < 0n ? -base.amountAtomic : base.amountAtomic;
  const targetAmountAtomic = target.amountAtomic < 0n ? -target.amountAtomic : target.amountAtomic;
  const baseAmountUi = Number(baseAmountAtomic) / 10 ** base.decimals;
  const targetAmountUi = Number(targetAmountAtomic) / 10 ** target.decimals;
  if (!Number.isFinite(baseAmountUi) || !Number.isFinite(targetAmountUi) || targetAmountUi <= 0) {
    return null;
  }
  const baseUsd =
    base.mint === USDC_MINT
      ? baseAmountUi
      : baseAmountUi * (context.solPriceUsd ?? Number.NaN);
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) return null;
  const baseMint = base.mint === SOL_MINT ? SOL_MINT : USDC_MINT;

  return {
    sourceSignature: context.signature,
    sourceWallet: context.wallet,
    slot,
    blockTime: new Date(blockTimeSeconds * 1_000).toISOString(),
    detectedAt: context.detectedAt.toISOString(),
    side: base.amountAtomic < 0n ? "BUY" : "SELL",
    baseMint,
    targetMint: target.mint,
    baseAmountAtomic: baseAmountAtomic.toString(),
    targetAmountAtomic: targetAmountAtomic.toString(),
    baseAmountUi,
    targetAmountUi,
    leaderPriceUsd: baseUsd / targetAmountUi,
    recovered: context.recovered
  };
}

function hasSingleRecognizedTopLevelJupiterIntent(
  transaction: Record<string, unknown>,
  context: SpotSwapDecodeContext
): boolean {
  const keys = transactionAccountKeys(transaction);
  const instructions = allTransactionInstructions(transaction);
  if (!keys || !instructions) return false;
  return instructions.filter(({ instruction, isInner }) => {
    if (isInner) return false;
    const programId = instructionProgramId(instruction, keys);
    return programId !== undefined &&
      JUPITER_SPOT_SWAP_PROGRAM_IDS.has(programId) &&
      recognizedJupiterInstructionEnvelope(programId, instruction, context.wallet, keys);
  }).length === 1;
}

function rejectedSourceAction(swap: LeaderSwap): RejectedSourceAction {
  return {
    sourceSignature: swap.sourceSignature,
    sourceWallet: swap.sourceWallet,
    slot: swap.slot,
    blockTime: swap.blockTime,
    detectedAt: swap.detectedAt,
    side: swap.side,
    baseMint: swap.baseMint,
    targetMint: swap.targetMint,
    recovered: swap.recovered
  };
}

function rejectedSwapResearchAction(
  swap: LeaderSwap,
  source: RejectedSourceAction
): RejectedSwapResearchAction {
  return {
    kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY",
    source,
    baseAmountAtomic: swap.baseAmountAtomic,
    targetAmountAtomic: swap.targetAmountAtomic,
    baseAmountUi: swap.baseAmountUi,
    targetAmountUi: swap.targetAmountUi
  };
}

export function decodeSpotSwapTransactionResult(
  value: unknown,
  context: SpotSwapDecodeContext
): SpotSwapDecodeResult {
  const transaction = asRecord(value);
  const meta = asRecord(transaction?.meta);
  if (!transaction || !meta || meta.err !== null) return { status: "IGNORED" };
  const slot = finiteNumber(transaction.slot);
  const blockTime = finiteNumber(transaction.blockTime);
  if (slot === undefined || blockTime === undefined) return { status: "IGNORED" };
  if (!Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) {
    throw new SpotSwapTransactionMalformedError("token-balance arrays are missing");
  }
  const policy = validateInstructionPolicy(
    transaction,
    context,
    context.allowedSpotProgramIds ?? DEFAULT_SPOT_SWAP_PROGRAM_IDS
  );
  if (!policy && hasSingleRecognizedTopLevelJupiterIntent(transaction, context)) {
    // A strict instruction-policy rejection must never become executable. If
    // exact wallet deltas still identify one SOL/USDC spot-like action, retain
    // only that scalar attribution so operators can see what was blocked.
    // Native SOL uses a zero rent adjustment here because the unknown program
    // cannot provide trusted rent evidence; the candidate is audit-only.
    try {
      const tokenDeltas = parseTokenBalances(transaction, context.wallet);
      const hasUsdc = tokenDeltas.some((delta) => delta.mint === USDC_MINT);
      const hasWrappedSol = tokenDeltas.some((delta) => delta.mint === SOL_MINT);
      let diagnosticDeltas = tokenDeltas;
      if (!hasUsdc && !hasWrappedSol && tokenDeltas.length === 1) {
        const native = nativeSolDelta(transaction, context.wallet, 0n);
        if (native) diagnosticDeltas = [...tokenDeltas, native];
      }
      const candidate = buildLeaderSwap(diagnosticDeltas, slot, blockTime, context);
      if (candidate) {
        const action = rejectedSourceAction(candidate);
        return {
          status: "REJECTED",
          action,
          researchAction: rejectedSwapResearchAction(candidate, action),
          reason: "A recognized Jupiter SOL/USDC swap intent used an unsupported or ambiguous route or auxiliary program and remained blocked by the strict decoder allowlist."
        };
      }
    } catch {
      // Malformed evidence behind a rejected policy is ignored rather than
      // being upgraded into a provider outage. No executable swap exists.
    }
    return { status: "IGNORED" };
  }
  if (!policy) return { status: "IGNORED" };

  const tokenDeltas = parseTokenBalances(transaction, context.wallet);
  const hasUsdc = tokenDeltas.some((delta) => delta.mint === USDC_MINT);
  const hasWrappedSol = tokenDeltas.some((delta) => delta.mint === SOL_MINT);
  let deltas = tokenDeltas;
  if (!hasUsdc && !hasWrappedSol && tokenDeltas.length === 1) {
    const native = nativeSolDelta(transaction, context.wallet, policy.rentAdjustmentAtomic);
    if (native) deltas = [...tokenDeltas, native];
  }
  // Native SOL fee/rent changes are deliberately ignored when a token USDC or
  // wrapped-SOL leg already identifies the base asset.
  const swap = buildLeaderSwap(deltas, slot, blockTime, context);
  return swap ? { status: "ACCEPTED", swap } : { status: "IGNORED" };
}

export function decodeSpotSwapTransaction(
  value: unknown,
  context: SpotSwapDecodeContext
): LeaderSwap | null {
  const result = decodeSpotSwapTransactionResult(value, context);
  return result.status === "ACCEPTED" ? result.swap : null;
}

function decimalToAtomic(value: unknown, decimals: number): bigint | undefined {
  const amount = finiteNumber(value);
  if (amount === undefined || !validDecimals(decimals) || Math.abs(amount) >= 1e21) {
    return undefined;
  }
  try {
    const fixed = Math.abs(amount).toFixed(decimals);
    if (/[eE]/.test(fixed)) return undefined;
    const [whole = "0", fraction = ""] = fixed.split(".");
    const atomic = BigInt(`${whole}${fraction.padEnd(decimals, "0")}` || "0");
    return amount < 0 ? -atomic : atomic;
  } catch {
    return undefined;
  }
}

function isNearZeroHistoryNet(delta: HistoryMintDelta): boolean {
  return Math.abs(delta.amountUi) <= Math.max(
    HISTORY_NET_ABSOLUTE_EPSILON,
    delta.grossAmountUi * HISTORY_NET_RELATIVE_EPSILON
  );
}

function buildHistoryLeaderSwap(
  deltas: HistoryMintDelta[],
  slot: number,
  blockTimeSeconds: number,
  context: SpotSwapDecodeContext
): LeaderSwap | null {
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    !validUnixSeconds(blockTimeSeconds) ||
    !Number.isFinite(context.detectedAt.getTime()) ||
    deltas.length !== 2
  ) return null;
  const bases = deltas.filter((delta) => delta.mint === SOL_MINT || delta.mint === USDC_MINT);
  if (bases.length !== 1) return null;
  const base = bases[0];
  const target = deltas.find((delta) => delta !== base);
  if (!base || !target || base.amountUi * target.amountUi >= 0) return null;

  const baseAmountUi = Math.abs(base.amountUi);
  const targetAmountUi = Math.abs(target.amountUi);
  if (
    !Number.isFinite(baseAmountUi) ||
    !Number.isFinite(targetAmountUi) ||
    baseAmountUi <= 0 ||
    targetAmountUi <= 0
  ) return null;
  const baseUsd = base.mint === USDC_MINT
    ? baseAmountUi
    : baseAmountUi * (context.solPriceUsd ?? Number.NaN);
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) return null;

  // Wallet History documents `amount` as human-readable, while live `decimals`
  // values are not consistently token decimals. These fixed-scale integers are
  // analytics placeholders only. Gap repair always hydrates getTransaction and
  // replaces them with exact atomic wallet deltas before a swap can be copied.
  const baseAmountAtomic = decimalToAtomic(baseAmountUi, HISTORY_ANALYTICS_DECIMALS);
  const targetAmountAtomic = decimalToAtomic(targetAmountUi, HISTORY_ANALYTICS_DECIMALS);
  if (!baseAmountAtomic || !targetAmountAtomic) return null;

  return {
    sourceSignature: context.signature,
    sourceWallet: context.wallet,
    slot,
    blockTime: new Date(blockTimeSeconds * 1_000).toISOString(),
    detectedAt: context.detectedAt.toISOString(),
    side: base.amountUi < 0 ? "BUY" : "SELL",
    baseMint: base.mint === SOL_MINT ? SOL_MINT : USDC_MINT,
    targetMint: target.mint,
    baseAmountAtomic: baseAmountAtomic.toString(),
    targetAmountAtomic: targetAmountAtomic.toString(),
    baseAmountUi,
    targetAmountUi,
    leaderPriceUsd: baseUsd / targetAmountUi,
    recovered: context.recovered
  };
}

export function decodeWalletHistorySwap(
  value: unknown,
  context: SpotSwapDecodeContext
): LeaderSwap | null {
  const entry = asRecord(value);
  if (!entry || (entry.type !== undefined && entry.type !== "SWAP") || entry.error != null) return null;
  const signature = stringValue(entry.signature);
  const slot = finiteNumber(entry.slot);
  const timestamp = finiteNumber(entry.timestamp);
  const changes = Array.isArray(entry.balanceChanges) ? entry.balanceChanges : [];
  if (!signature || slot === undefined || timestamp === undefined) return null;

  const totals = new Map<string, HistoryMintDelta>();
  for (const item of changes) {
    const change = asRecord(item);
    const rawMint = stringValue(change?.mint);
    const amountUi = finiteNumber(change?.amount);
    if (
      !rawMint ||
      amountUi === undefined ||
      !Number.isFinite(amountUi) ||
      Math.abs(amountUi) >= 1e21
    ) return null;
    if (amountUi === 0) continue;
    const mint = HISTORY_NATIVE_SOL_ALIASES.has(rawMint)
      ? HISTORY_NATIVE_SOL_PSEUDO_MINT
      : rawMint;
    const current = totals.get(mint) ?? { mint, amountUi: 0, grossAmountUi: 0 };
    current.amountUi += amountUi;
    current.grossAmountUi += Math.abs(amountUi);
    if (!Number.isFinite(current.amountUi) || !Number.isFinite(current.grossAmountUi)) return null;
    totals.set(mint, current);
  }
  const netDeltas = [...totals.values()].filter((delta) => !isNearZeroHistoryNet(delta));
  const canonicalBases = netDeltas.filter(
    (delta) => delta.mint === SOL_MINT || delta.mint === USDC_MINT
  );
  // Pseudo-native changes can include the same SOL movement plus transaction
  // fees and account rent. They are ignored only when one canonical base mint
  // independently identifies the swap; otherwise native-only history is
  // ambiguous and remains rejected.
  const materialDeltas = canonicalBases.length === 1
    ? netDeltas.filter((delta) => delta.mint !== HISTORY_NATIVE_SOL_PSEUDO_MINT)
    : netDeltas;
  return buildHistoryLeaderSwap(materialDeltas, slot, timestamp, { ...context, signature });
}
