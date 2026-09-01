import { TOKEN_PROGRAM_ID } from "@copylab/shared";
import {
  asRecord,
  confirmedTransactionMetadata,
  finiteNumber,
  stringValue
} from "@copylab/providers";
import type {
  WalletIdentityMintCreationEvidence,
  WalletIdentityOwnerTokenDelta,
  WalletIdentityTransactionEvidenceRecord
} from "./local-wallet-identity.js";

interface TokenBalanceRow {
  accountIndex: number;
  mint: string;
  owner?: string;
  amount: bigint;
}

interface ParsedTokenBalances {
  rows: Map<string, TokenBalanceRow>;
  complete: boolean;
}

export interface NormalizeWalletIdentityEvidenceOptions {
  signature: string;
  wallets: readonly string[];
  swapScanComplete: boolean;
}

function accountKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return stringValue(asRecord(value)?.pubkey);
}

function unsignedAtomic(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function parseTokenBalances(value: unknown): ParsedTokenBalances {
  if (!Array.isArray(value)) return { rows: new Map(), complete: false };
  const rows = new Map<string, TokenBalanceRow>();
  let complete = true;
  for (const entry of value) {
    const record = asRecord(entry);
    const accountIndex = finiteNumber(record?.accountIndex);
    const mint = stringValue(record?.mint);
    const owner = stringValue(record?.owner);
    const amount = unsignedAtomic(stringValue(asRecord(record?.uiTokenAmount)?.amount));
    if (
      !Number.isSafeInteger(accountIndex) ||
      (accountIndex ?? -1) < 0 ||
      !mint ||
      amount === undefined
    ) {
      complete = false;
      continue;
    }
    const key = `${accountIndex}:${mint}`;
    if (rows.has(key)) {
      complete = false;
      continue;
    }
    rows.set(key, {
      accountIndex: accountIndex as number,
      mint,
      ...(owner ? { owner } : {}),
      amount
    });
  }
  return { rows, complete };
}

function ownerTokenDeltas(
  preValue: unknown,
  postValue: unknown,
  wallets: ReadonlySet<string>
): { deltas: WalletIdentityOwnerTokenDelta[]; complete: boolean } {
  const pre = parseTokenBalances(preValue);
  const post = parseTokenBalances(postValue);
  let complete = pre.complete && post.complete;
  const keys = new Set([...pre.rows.keys(), ...post.rows.keys()]);
  const byOwnerMint = new Map<string, bigint>();
  for (const key of keys) {
    const before = pre.rows.get(key);
    const after = post.rows.get(key);
    const owner = after?.owner ?? before?.owner;
    if (before?.owner && after?.owner && before.owner !== after.owner) {
      complete = false;
      continue;
    }
    if (!owner) {
      complete = false;
      continue;
    }
    if (!wallets.has(owner)) continue;
    const mint = after?.mint ?? before?.mint;
    if (!mint) {
      complete = false;
      continue;
    }
    const delta = (after?.amount ?? 0n) - (before?.amount ?? 0n);
    const ownerMint = `${owner}:${mint}`;
    byOwnerMint.set(ownerMint, (byOwnerMint.get(ownerMint) ?? 0n) + delta);
  }
  const deltas = [...byOwnerMint]
    .filter(([, amount]) => amount !== 0n)
    .map(([key, amount]) => {
      const separator = key.indexOf(":");
      return {
        owner: key.slice(0, separator),
        mint: key.slice(separator + 1),
        amountDeltaAtomic: amount.toString()
      };
    })
    .sort((left, right) => left.owner.localeCompare(right.owner) || left.mint.localeCompare(right.mint));
  return { deltas, complete };
}

function collectInstructions(raw: unknown): {
  instructions: unknown[];
  accountKeys: string[];
  complete: boolean;
} {
  const root = asRecord(raw);
  const message = asRecord(asRecord(root?.transaction)?.message);
  const meta = asRecord(root?.meta);
  if (!Array.isArray(message?.instructions)) {
    return { instructions: [], accountKeys: [], complete: false };
  }
  const loaded = asRecord(meta?.loadedAddresses);
  const keyValues = [
    ...(Array.isArray(message.accountKeys) ? message.accountKeys : []),
    ...(Array.isArray(loaded?.writable) ? loaded.writable : []),
    ...(Array.isArray(loaded?.readonly) ? loaded.readonly : [])
  ];
  const parsedKeys = keyValues.map(accountKey);
  const accountKeys = parsedKeys.filter((key): key is string => key !== undefined);
  const instructions = [...message.instructions];
  let complete = accountKeys.length === parsedKeys.length;
  let innerGroups: unknown[] = [];
  if (Array.isArray(meta?.innerInstructions)) {
    innerGroups = meta.innerInstructions;
  } else {
    // Some RPCs serialize no-CPI transactions with innerInstructions=null.
    // Complete, non-truncated logs can prove that no depth-2 invocation
    // occurred; otherwise the missing inner list remains fail-closed.
    const logs = Array.isArray(meta?.logMessages)
      ? meta.logMessages.filter((log): log is string => typeof log === "string")
      : [];
    const logsComplete = Array.isArray(meta?.logMessages) &&
      !logs.some((log) => /log truncated/i.test(log));
    const hasCpi = logs.some((log) => /^Program [1-9A-HJ-NP-Za-km-z]+ invoke \[(?:[2-9]|[1-9][0-9]+)\]/.test(log));
    if (!logsComplete || hasCpi) complete = false;
  }
  for (const group of innerGroups) {
    const nested = asRecord(group)?.instructions;
    if (!Array.isArray(nested)) {
      complete = false;
      continue;
    }
    instructions.push(...nested);
  }
  return { instructions, accountKeys, complete };
}

function mintCreations(
  raw: unknown,
  signers: ReadonlySet<string>
): { creations: WalletIdentityMintCreationEvidence[]; complete: boolean } {
  const collected = collectInstructions(raw);
  let complete = collected.complete;
  const creations = new Map<string, WalletIdentityMintCreationEvidence>();
  for (const instruction of collected.instructions) {
    const record = asRecord(instruction);
    const programIndex = finiteNumber(record?.programIdIndex);
    const programId = stringValue(record?.programId) ?? (
      Number.isSafeInteger(programIndex) && (programIndex ?? -1) >= 0
        ? collected.accountKeys[programIndex as number]
        : undefined
    );
    if (!programId) {
      complete = false;
      continue;
    }
    if (programId !== TOKEN_PROGRAM_ID) continue;
    const parsed = asRecord(record?.parsed);
    const type = stringValue(parsed?.type);
    if (!parsed || !type) {
      // A compiled SPL Token instruction could be initializeMint. The local
      // classifier must not claim a clean scan when the RPC omitted parsing.
      complete = false;
      continue;
    }
    if (type !== "initializeMint" && type !== "initializeMint2") continue;
    const info = asRecord(parsed.info);
    const mint = stringValue(info?.mint);
    const mintAuthority = stringValue(info?.mintAuthority);
    if (!mint || !mintAuthority || !signers.has(mintAuthority)) {
      complete = false;
      continue;
    }
    creations.set(`${mint}:${mintAuthority}`, {
      mint,
      creatorWallet: mintAuthority,
      mintAuthority
    });
  }
  return { creations: [...creations.values()], complete };
}

/**
 * Converts one confirmed jsonParsed transaction into the minimal durable
 * identity evidence needed by the fail-closed classifier. Failed transactions
 * are retained in coverage but cannot have committed token/mint effects.
 */
export function normalizeWalletIdentityTransactionEvidence(
  raw: unknown,
  options: NormalizeWalletIdentityEvidenceOptions
): WalletIdentityTransactionEvidenceRecord[] {
  const metadata = confirmedTransactionMetadata(raw);
  if (!metadata) throw new Error("Confirmed transaction metadata is malformed for wallet identity evidence");
  const uniqueWallets = [...new Set(options.wallets.filter((wallet) => wallet.length > 0))];
  if (uniqueWallets.length === 0) return [];
  const root = asRecord(raw);
  const meta = asRecord(root?.meta);
  const signers = new Set(metadata.signers);
  const wallets = new Set(uniqueWallets);
  const failed = !metadata.success;
  const tokenEvidence = failed
    ? { deltas: [] as WalletIdentityOwnerTokenDelta[], complete: true }
    : ownerTokenDeltas(meta?.preTokenBalances, meta?.postTokenBalances, wallets);
  const mintEvidence = failed
    ? { creations: [] as WalletIdentityMintCreationEvidence[], complete: true }
    : mintCreations(raw, signers);
  const mentioned = new Set(metadata.accountKeys.filter((account) => wallets.has(account)));
  for (const delta of tokenEvidence.deltas) mentioned.add(delta.owner);

  return uniqueWallets.map((wallet) => ({
    wallet,
    signature: options.signature,
    slot: metadata.slot,
    blockTime: metadata.blockTime,
    success: metadata.success,
    signers: metadata.signers,
    walletMentioned: mentioned.has(wallet),
    instructionScanComplete: mintEvidence.complete,
    tokenBalanceScanComplete: tokenEvidence.complete,
    swapScanComplete: failed || options.swapScanComplete,
    mintCreations: mintEvidence.creations,
    ownerTokenDeltas: tokenEvidence.deltas.filter((delta) => delta.owner === wallet)
  }));
}
