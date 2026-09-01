import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction
} from "@solana/web3.js";
import {
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  type PublicKeyString,
  type Signer,
  type SignerValidation
} from "@copylab/shared";
import type { RecoveryEnvelope, SecretVault } from "./vault.js";
import type { Repository } from "./repository.js";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
export const RAYDIUM_AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const RAYDIUM_CP_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const ORCA_WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const PERMITTED_JUPITER_ROUTE_PROGRAMS = Object.freeze([
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_CP_PROGRAM_ID,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID
]);
const ROUTE_V2_DISCRIMINATOR = Buffer.from([187, 100, 250, 204, 49, 196, 175, 20]);
const SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR = Buffer.from([209, 152, 83, 147, 124, 254, 216, 233]);
const LAMPORTS_PER_SIGNATURE = 5_000;

export const DEFAULT_ALLOWED_PROGRAMS = Object.freeze([
  ComputeBudgetProgram.programId.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID
]);

function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
  )[0];
}

function sameKey(actual: PublicKey | undefined, expected: PublicKey, label: string): void {
  if (!actual?.equals(expected)) throw new Error(`Unexpected ${label}.`);
}

function readU64(data: Buffer, offset: number, label: string): bigint {
  if (data.length < offset + 8) throw new Error(`Jupiter ${label} is truncated.`);
  return data.readBigUInt64LE(offset);
}

interface DecodedJupiterRoute {
  inputAmount: bigint;
  quotedOutput: bigint;
  slippageBps: number;
  platformFeeBps: number;
  positiveSlippageBps: number;
  accountLayout: "route-v2";
  routeFamily: string;
  routeProgramId: string;
}

const DIRECT_ROUTE_FAMILIES = new Map<number, {
  label: string;
  programId: string;
  payload: "NONE" | "BOOL";
}>([
  [7, { label: "Raydium", programId: RAYDIUM_AMM_V4_PROGRAM_ID, payload: "NONE" }],
  [17, { label: "Orca Whirlpool", programId: ORCA_WHIRLPOOL_PROGRAM_ID, payload: "BOOL" }],
  [26, { label: "Raydium CLMM", programId: RAYDIUM_CLMM_PROGRAM_ID, payload: "NONE" }],
  [38, { label: "Meteora DLMM", programId: METEORA_DLMM_PROGRAM_ID, payload: "NONE" }],
  [46, { label: "Raydium CP", programId: RAYDIUM_CP_PROGRAM_ID, payload: "NONE" }]
]);

function decodeJupiterRoute(dataBytes: Uint8Array): DecodedJupiterRoute {
  const data = Buffer.from(dataBytes);
  let offset: number;
  let accountLayout: DecodedJupiterRoute["accountLayout"];
  if (data.subarray(0, 8).equals(ROUTE_V2_DISCRIMINATOR)) {
    offset = 8;
    accountLayout = "route-v2";
  } else if (data.subarray(0, 8).equals(SHARED_ACCOUNTS_ROUTE_V2_DISCRIMINATOR)) {
    throw new Error("Shared-account Jupiter routes are not permitted by the v1 signer.");
  } else {
    throw new Error("Unknown or non-ExactIn Jupiter instruction variant.");
  }
  if (data.length < offset + 26) throw new Error("Jupiter route instruction is truncated.");
  const inputAmount = readU64(data, offset, "input amount");
  const quotedOutput = readU64(data, offset + 8, "quoted output");
  const slippageBps = data.readUInt16LE(offset + 16);
  const platformFeeBps = data.readUInt16LE(offset + 18);
  const positiveSlippageBps = data.readUInt16LE(offset + 20);
  const routeSteps = data.readUInt32LE(offset + 22);
  if (routeSteps !== 1) throw new Error("Only a single direct Jupiter route step is permitted.");
  if (slippageBps > 10_000 || platformFeeBps > 10_000 || positiveSlippageBps > 10_000) {
    throw new Error("Jupiter route basis-point fields are invalid.");
  }
  let cursor = offset + 26;
  if (cursor >= data.length) throw new Error("Jupiter direct route plan is truncated.");
  const variant = data[cursor++]!;
  const family = DIRECT_ROUTE_FAMILIES.get(variant);
  if (!family) throw new Error(`Jupiter route family ${variant} is not permitted by v1.`);
  if (family.payload === "BOOL") {
    if (cursor >= data.length || (data[cursor] !== 0 && data[cursor] !== 1)) {
      throw new Error("Jupiter route family payload is malformed.");
    }
    cursor += 1;
  }
  if (data.length !== cursor + 4) throw new Error("Jupiter route plan contains trailing or truncated data.");
  const allocationBps = data.readUInt16LE(cursor);
  const inputIndex = data[cursor + 2];
  const outputIndex = data[cursor + 3];
  if (allocationBps !== 10_000 || inputIndex !== 0 || outputIndex !== 1) {
    throw new Error("Jupiter direct route allocation or token indices are invalid.");
  }
  return {
    inputAmount,
    quotedOutput,
    slippageBps,
    platformFeeBps,
    positiveSlippageBps,
    accountLayout,
    routeFamily: family.label,
    routeProgramId: family.programId
  };
}

function validateAssociatedTokenInstruction(
  instruction: TransactionInstruction,
  wallet: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey
): void {
  const data = Buffer.from(instruction.data);
  if (!(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) {
    throw new Error("Unknown associated-token instruction variant.");
  }
  if (instruction.keys.length < 6) throw new Error("Associated-token instruction is truncated.");
  sameKey(instruction.keys[0]?.pubkey, wallet, "associated-token payer");
  sameKey(instruction.keys[2]?.pubkey, wallet, "associated-token owner");
  const mint = instruction.keys[3]?.pubkey;
  if (!mint || (!mint.equals(inputMint) && !mint.equals(outputMint))) {
    throw new Error("Associated-token instruction uses an unexpected mint.");
  }
  sameKey(instruction.keys[1]?.pubkey, associatedTokenAddress(wallet, mint), "associated-token recipient");
  sameKey(instruction.keys[4]?.pubkey, new PublicKey(SYSTEM_PROGRAM_ID), "associated-token system program");
  sameKey(instruction.keys[5]?.pubkey, new PublicKey(TOKEN_PROGRAM_ID), "associated-token token program");
}

function validateJupiterAccounts(
  instruction: TransactionInstruction,
  route: DecodedJupiterRoute,
  wallet: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey
): void {
  const inputAta = associatedTokenAddress(wallet, inputMint);
  const outputAta = associatedTokenAddress(wallet, outputMint);
  const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
  const keys = instruction.keys.map((key) => key.pubkey);
  if (keys.length < 11) throw new Error("Jupiter direct-route account list is truncated.");
  sameKey(keys[0], wallet, "Jupiter transfer authority");
  sameKey(keys[1], inputAta, "Jupiter source token account");
  sameKey(keys[2], outputAta, "Jupiter destination token account");
  sameKey(keys[3], inputMint, "Jupiter source mint");
  sameKey(keys[4], outputMint, "Jupiter destination mint");
  sameKey(keys[5], tokenProgram, "Jupiter source token program");
  sameKey(keys[6], tokenProgram, "Jupiter destination token program");
  const optionalDestination = keys[7];
  if (
    !optionalDestination ||
    (!optionalDestination.equals(outputAta) && !optionalDestination.equals(new PublicKey(JUPITER_V6_PROGRAM_ID)))
  ) {
    throw new Error("Unexpected Jupiter optional destination or fee recipient account.");
  }
  sameKey(keys[8], new PublicKey(JUPITER_EVENT_AUTHORITY), "Jupiter event authority");
  sameKey(keys[9], new PublicKey(JUPITER_V6_PROGRAM_ID), "Jupiter program account");
  if (!instruction.keys[0]?.isSigner || !instruction.keys[1]?.isWritable || !instruction.keys[2]?.isWritable) {
    throw new Error("Jupiter direct-route account permissions are invalid.");
  }
  if (instruction.keys.slice(1).some((key) => key.isSigner)) {
    throw new Error("Jupiter route contains an unexpected signer account.");
  }
  if (!keys.slice(10).some((key) => key.equals(new PublicKey(route.routeProgramId)))) {
    throw new Error(`Jupiter ${route.routeFamily} program account is missing from the route.`);
  }
}

export interface CreatedWallet {
  address: string;
  recovery: RecoveryEnvelope;
}

export class WalletManager {
  constructor(
    private readonly vault: SecretVault,
    private readonly repository: Repository
  ) {}

  create(passphrase: string): CreatedWallet {
    if (this.vault.hasWallet()) throw new Error("A dedicated bot wallet already exists.");
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    try {
      const recovery = this.vault.createRecoveryEnvelope(address, keypair.secretKey, passphrase);
      this.repository.db.transaction(() => {
        this.vault.storeWalletSecret(keypair.secretKey);
        this.repository.setSetting("wallet_address", address);
        this.repository.setSetting("wallet_backup_confirmed", false);
        this.repository.setSetting("wallet_pending_recovery", recovery);
        this.repository.audit("wallet_created", "Dedicated bot wallet created; funding remains blocked.", {
          address
        });
      })();
      return { address, recovery };
    } finally {
      keypair.secretKey.fill(0);
    }
  }

  restore(recovery: RecoveryEnvelope, passphrase: string): { address: string; backupConfirmed: true } {
    const mode = this.repository.getSetting<string>("mode") ?? "SETUP";
    if (mode !== "SETUP" && mode !== "PAPER") {
      throw new Error("Wallet recovery is allowed only in SETUP or PAPER mode.");
    }
    if (this.vault.hasWallet() || this.repository.getSetting<string>("wallet_address")) {
      throw new Error("A dedicated bot wallet already exists; recovery will not overwrite it.");
    }
    if (
      this.repository.listPositions("PAPER", true).length > 0 ||
      this.repository.listPositions("LIVE", true).length > 0
    ) {
      throw new Error("Close every bot-created position before restoring a wallet.");
    }
    const secret = this.vault.restoreRecoveryEnvelope(recovery, passphrase);
    try {
      const keypair = Keypair.fromSecretKey(secret);
      const address = keypair.publicKey.toBase58();
      if (address !== recovery.address) {
        throw new Error("Recovery backup address does not match its decrypted key.");
      }
      this.repository.db.transaction(() => {
        this.vault.storeWalletSecret(secret);
        this.repository.setSetting("wallet_address", address);
        this.repository.setSetting("wallet_backup_confirmed", true);
        this.repository.setSetting("wallet_pending_recovery", null);
        this.repository.audit(
          "wallet_restored",
          "The dedicated bot wallet was restored from an encrypted recovery backup.",
          { address },
          "warning"
        );
      })();
      return { address, backupConfirmed: true };
    } finally {
      secret.fill(0);
    }
  }

  confirmBackup(address: string): void {
    const stored = this.repository.getSetting<string>("wallet_address");
    if (!stored || stored !== address) throw new Error("Wallet address does not match the stored bot wallet.");
    this.repository.setSetting("wallet_backup_confirmed", true);
    this.repository.setSetting("wallet_pending_recovery", null);
    this.repository.audit("wallet_backup_confirmed", "Encrypted recovery backup was confirmed.", {
      address
    });
  }

  pendingRecovery(address: string): RecoveryEnvelope {
    const stored = this.repository.getSetting<string>("wallet_address");
    if (!stored || stored !== address) throw new Error("Wallet address does not match the stored bot wallet.");
    if (this.repository.getSetting<boolean>("wallet_backup_confirmed")) {
      throw new Error("The recovery backup is already confirmed and is no longer exportable.");
    }
    const recovery = this.repository.getSetting<RecoveryEnvelope>("wallet_pending_recovery");
    if (!recovery || recovery.address !== address || recovery.version !== 1) {
      throw new Error("No pending encrypted recovery envelope is available for this wallet.");
    }
    this.repository.audit(
      "wallet_recovery_reexported",
      "The pending encrypted wallet recovery envelope was exported again before backup confirmation.",
      { address },
      "warning"
    );
    return recovery;
  }

  status(): { exists: boolean; address?: string; backupConfirmed: boolean } {
    const address = this.repository.getSetting<string>("wallet_address");
    return {
      exists: this.vault.hasWallet(),
      ...(address ? { address } : {}),
      backupConfirmed: this.repository.getSetting<boolean>("wallet_backup_confirmed") ?? false
    };
  }
}

export interface DpapiTransactionSignerOptions {
  loadExecutableAccounts?: (addresses: readonly PublicKey[]) => Promise<ReadonlySet<string>>;
  rpcConnectionResolver?: SignerRpcConnectionResolver;
}

export type SignerRpcConnection = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getAddressLookupTable"
>;

export interface ResolvedSignerRpcConnection {
  connection: SignerRpcConnection;
  usageProvider: "helius" | "solana_rpc";
}

export interface SignerRpcConnectionResolver {
  /** Resolve from the encrypted profile for each signing operation. */
  resolve(exitOnlyRpcAuthorized?: boolean): ResolvedSignerRpcConnection;
}

export interface ActiveDataProviderRpcConnectionResolverOptions {
  createConnection?: (endpoint: string) => SignerRpcConnection;
}

/**
 * Resolves signer reads from the current encrypted data-provider profile.
 * No connection is cached, so a completed profile transition takes effect on
 * the next signing operation. SHADOW deliberately keeps managed Helius as the
 * executable source of truth until SELF_HOSTED promotion is complete.
 */
export class ActiveDataProviderRpcConnectionResolver implements SignerRpcConnectionResolver {
  private readonly createConnection: (endpoint: string) => SignerRpcConnection;

  constructor(
    private readonly vault: Pick<SecretVault, "getDataProviderProfile" | "getCredentials">,
    options: ActiveDataProviderRpcConnectionResolverOptions = {}
  ) {
    this.createConnection = options.createConnection ?? ((endpoint) => new Connection(endpoint, "confirmed"));
  }

  resolve(exitOnlyRpcAuthorized = false): ResolvedSignerRpcConnection {
    const profile = this.vault.getDataProviderProfile();
    if (profile.mode === "SELF_HOSTED") {
      if (exitOnlyRpcAuthorized) {
        if (!profile.emergencySolanaHttpUrl) {
          throw new Error(
            "An independent emergency-exit signer RPC is not configured; exit signing fails closed."
          );
        }
        return this.createResolvedConnection(profile.emergencySolanaHttpUrl, "solana_rpc");
      }
      if (!profile.solanaHttpUrl) {
        throw new Error("SELF_HOSTED signer RPC endpoint is unavailable; signing fails closed.");
      }
      return this.createResolvedConnection(profile.solanaHttpUrl, "solana_rpc");
    }
    const credentials = this.vault.getCredentials();
    const heliusApiKey = credentials?.heliusApiKey?.trim();
    if (!heliusApiKey) {
      throw new Error("Managed signer RPC credentials are unavailable; signing fails closed.");
    }
    return this.createResolvedConnection(
      `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusApiKey)}`,
      "helius"
    );
  }

  private createResolvedConnection(
    endpoint: string,
    usageProvider: ResolvedSignerRpcConnection["usageProvider"]
  ): ResolvedSignerRpcConnection {
    try {
      return { connection: this.createConnection(endpoint), usageProvider };
    } catch {
      // Connection adapters may include the full endpoint in their error. Do
      // not let encrypted query-string credentials escape into execution logs.
      throw new Error("Active signer RPC connection could not be created; signing fails closed.");
    }
  }
}

interface SigningRpcContext {
  resolved?: ResolvedSignerRpcConnection;
  exitOnlyRpcAuthorized: boolean;
}

export class DpapiTransactionSigner implements Signer {
  constructor(
    private readonly vault: SecretVault,
    private readonly repository: Repository,
    private readonly options: DpapiTransactionSignerOptions = {}
  ) {}

  async getAddress(): Promise<PublicKeyString> {
    const address = this.repository.getSetting<string>("wallet_address");
    if (!address) throw new Error("No dedicated bot wallet exists.");
    return address;
  }

  async signValidatedTransaction(
    transactionBase64: string,
    validation: SignerValidation
  ): Promise<string> {
    const storedAddress = await this.getAddress();
    if (storedAddress !== validation.wallet) throw new Error("Signer wallet does not match the intent.");
    if (!this.repository.getSetting<boolean>("wallet_backup_confirmed")) {
      throw new Error("Recovery backup must be confirmed before signing.");
    }
    if (validation.inputMint === validation.outputMint) throw new Error("Input and output mints match.");
    if (![validation.inputMint, validation.outputMint].includes(SOL_MINT) &&
        ![validation.inputMint, validation.outputMint].includes(USDC_MINT)) {
      throw new Error("A permitted SOL or USDC base leg is required.");
    }
    if (validation.expectedRouter.toLowerCase() !== "iris") {
      throw new Error("Only the Iris on-chain Jupiter router is permitted by the v1 signer.");
    }
    if (
      validation.expectedPlatformFeeBps !== 0 ||
      validation.allowedFeeAccounts.length !== 0
    ) {
      throw new Error("V1 does not authorize Jupiter platform fees or external fee recipients.");
    }
    const declaredFees =
      validation.signatureFeeLamports +
      validation.prioritizationFeeLamports +
      validation.rentFeeLamports;
    if (
      !Number.isSafeInteger(validation.maximumFeeLamports) ||
      !Number.isSafeInteger(declaredFees) ||
      validation.signatureFeeLamports < LAMPORTS_PER_SIGNATURE ||
      validation.prioritizationFeeLamports < 0 ||
      validation.rentFeeLamports < 0 ||
      declaredFees > validation.maximumFeeLamports
    ) {
      throw new Error("Declared signature, priority, or rent fees exceed the signing policy.");
    }

    const secret = this.vault.loadWalletSecret();
    if (!secret) throw new Error("Encrypted wallet secret is unavailable.");
    try {
      const keypair = Keypair.fromSecretKey(secret);
      const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
      if (transaction.message.version !== 0) throw new Error("Only Solana v0 transactions are permitted.");
      const staticKeys = transaction.message.staticAccountKeys.map((key) => key.toBase58());
      if (staticKeys[0] !== storedAddress) throw new Error("Unexpected transaction fee payer.");
      if (transaction.message.header.numRequiredSignatures !== 1 || transaction.signatures.length !== 1) {
        throw new Error("Unexpected transaction signers.");
      }
      if (transaction.signatures.some((signature) => signature.some((byte) => byte !== 0))) {
        throw new Error("Jupiter transaction unexpectedly arrived with an existing signature.");
      }

      // Resolve lazily and at most once so lookup-table and executable-account
      // reads cannot mix providers within one signature. The context is local
      // to this call and is never retained across profile changes.
      const rpcContext: SigningRpcContext = {
        exitOnlyRpcAuthorized: validation.exitOnlyRpcAuthorized === true
      };
      const lookupTables = await this.resolveLookupTables(transaction.message.addressTableLookups.map(
        (lookup) => lookup.accountKey
      ), rpcContext);
      const message = TransactionMessage.decompile(transaction.message, {
        addressLookupTableAccounts: lookupTables
      });
      const wallet = new PublicKey(storedAddress);
      const inputMint = new PublicKey(validation.inputMint);
      const outputMint = new PublicKey(validation.outputMint);
      const callerAllowed = new Set(validation.allowedPrograms);
      const hardAllowed = new Set(DEFAULT_ALLOWED_PROGRAMS);
      let computeUnitLimit = 0n;
      let computeUnitPriceMicroLamports = 0n;
      let sawJupiter = false;
      let sawLimit = false;
      let sawPrice = false;

      for (const instruction of message.instructions) {
        const program = instruction.programId.toBase58();
        if (!hardAllowed.has(program) || !callerAllowed.has(program)) {
          throw new Error(`Transaction uses an unapproved program: ${program}`);
        }
        if (program === ComputeBudgetProgram.programId.toBase58()) {
          const data = Buffer.from(instruction.data);
          const kind = data[0];
          if (kind === 1 || kind === 4) {
            if (data.length !== 5) throw new Error("Malformed compute-budget instruction.");
          } else if (kind === 2) {
            if (data.length !== 5 || sawLimit) throw new Error("Malformed or duplicate compute-unit limit.");
            computeUnitLimit = BigInt(data.readUInt32LE(1));
            sawLimit = true;
          } else if (kind === 3) {
            if (data.length !== 9 || sawPrice) throw new Error("Malformed or duplicate compute-unit price.");
            computeUnitPriceMicroLamports = data.readBigUInt64LE(1);
            sawPrice = true;
          } else {
            throw new Error("Unknown compute-budget instruction variant.");
          }
          continue;
        }
        if (program === ASSOCIATED_TOKEN_PROGRAM_ID) {
          validateAssociatedTokenInstruction(instruction, wallet, inputMint, outputMint);
          continue;
        }
        if (program === JUPITER_V6_PROGRAM_ID) {
          if (sawJupiter) throw new Error("Multiple Jupiter swap instructions are not permitted.");
          const route = decodeJupiterRoute(instruction.data);
          validateJupiterAccounts(instruction, route, wallet, inputMint, outputMint);
          if (route.inputAmount !== BigInt(validation.maximumInputAtomic)) {
            throw new Error("Jupiter instruction input does not equal the authorized amount.");
          }
          if (route.quotedOutput !== BigInt(validation.quotedOutputAtomic)) {
            throw new Error("Jupiter instruction output quote does not match the authorized quote.");
          }
          if (route.slippageBps !== validation.expectedSlippageBps) {
            throw new Error("Jupiter instruction slippage does not match the authorized quote.");
          }
          if (route.platformFeeBps !== validation.expectedPlatformFeeBps) {
            throw new Error("Jupiter instruction contains an unauthorized platform fee.");
          }
          if (route.positiveSlippageBps !== 0) {
            throw new Error("Jupiter instruction contains an unauthorized positive-slippage fee.");
          }
          await this.validateRoutePrograms(
            instruction,
            route,
            validation.allowedRoutePrograms,
            rpcContext
          );
          const programMinimum =
            (route.quotedOutput * BigInt(10_000 - route.slippageBps)) / 10_000n;
          if (programMinimum !== BigInt(validation.minimumOutputAtomic)) {
            throw new Error("Jupiter instruction minimum output does not match the authorized minimum.");
          }
          sawJupiter = true;
        }
      }
      if (!sawJupiter) throw new Error("A single recognized Jupiter ExactIn instruction is required.");

      const computedPriorityFee =
        (computeUnitLimit * computeUnitPriceMicroLamports + 999_999n) / 1_000_000n;
      if (computedPriorityFee > BigInt(validation.prioritizationFeeLamports)) {
        throw new Error("Transaction compute budget exceeds the authorized priority fee.");
      }

      transaction.sign([keypair]);
      this.repository.audit("transaction_signed", "A policy-validated transaction was signed.", {
        wallet: storedAddress,
        inputMint: validation.inputMint,
        outputMint: validation.outputMint
      });
      return Buffer.from(transaction.serialize()).toString("base64");
    } finally {
      secret.fill(0);
    }
  }

  private async validateRoutePrograms(
    instruction: TransactionInstruction,
    route: DecodedJupiterRoute,
    callerAllowedPrograms: readonly string[],
    rpcContext: SigningRpcContext
  ): Promise<void> {
    const hardAllowed = new Set(PERMITTED_JUPITER_ROUTE_PROGRAMS);
    const callerAllowed = new Set(callerAllowedPrograms);
    if (!hardAllowed.has(route.routeProgramId) || !callerAllowed.has(route.routeProgramId)) {
      throw new Error(`Jupiter ${route.routeFamily} is not in the permitted route-program policy.`);
    }
    const remaining = instruction.keys.slice(10).map((key) => key.pubkey);
    if (remaining.length === 0 || remaining.length > 64) {
      throw new Error("Jupiter route account count is outside the v1 signing policy.");
    }
    const executable = await this.loadExecutableAccounts(remaining, rpcContext);
    if (!executable.has(route.routeProgramId)) {
      throw new Error(`Jupiter ${route.routeFamily} program account is not executable on-chain.`);
    }
    const permittedExecutable = new Set([
      route.routeProgramId,
      TOKEN_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      JUPITER_V6_PROGRAM_ID
    ]);
    for (const program of executable) {
      if (!permittedExecutable.has(program)) {
        throw new Error(`Jupiter route contains an unapproved executable program account: ${program}`);
      }
    }
  }

  private resolveRpcConnection(context: SigningRpcContext): ResolvedSignerRpcConnection {
    if (context.resolved) return context.resolved;
    const resolver = this.options.rpcConnectionResolver;
    if (!resolver) throw new Error("Signer RPC connection resolver is unavailable; signing fails closed.");
    try {
      context.resolved = resolver.resolve(context.exitOnlyRpcAuthorized);
      if (context.exitOnlyRpcAuthorized) {
        this.repository.audit(
          "exit_only_rpc_selected",
          "A recorded-position exit selected the independent emergency RPC for signer verification.",
          undefined,
          "warning"
        );
      }
    } catch {
      throw new Error("Active signer RPC connection resolution failed; signing fails closed.");
    }
    return context.resolved;
  }

  private async loadExecutableAccounts(
    addresses: readonly PublicKey[],
    context: SigningRpcContext
  ): Promise<ReadonlySet<string>> {
    if (this.options.loadExecutableAccounts) return this.options.loadExecutableAccounts(addresses);
    const { connection, usageProvider } = this.resolveRpcConnection(context);
    this.repository.incrementUsage(usageProvider);
    let values: Awaited<ReturnType<SignerRpcConnection["getMultipleAccountsInfo"]>>;
    try {
      values = await connection.getMultipleAccountsInfo([...addresses], "confirmed");
    } catch {
      throw new Error("Signer executable-account RPC verification failed; signing fails closed.");
    }
    const executable = new Set<string>();
    values.forEach((value, index) => {
      if (value?.executable) executable.add(addresses[index]!.toBase58());
    });
    return executable;
  }

  private async resolveLookupTables(
    keys: PublicKey[],
    context: SigningRpcContext
  ): Promise<AddressLookupTableAccount[]> {
    if (keys.length === 0) return [];
    const { connection, usageProvider } = this.resolveRpcConnection(context);
    const values = await Promise.all(keys.map(async (key) => {
      this.repository.incrementUsage(usageProvider);
      let lookup: Awaited<ReturnType<SignerRpcConnection["getAddressLookupTable"]>>;
      try {
        lookup = await connection.getAddressLookupTable(key);
      } catch {
        throw new Error("Signer address-lookup-table RPC verification failed; signing fails closed.");
      }
      if (!lookup.value) throw new Error(`Address lookup table ${key.toBase58()} is unavailable.`);
      return lookup.value;
    }));
    return values;
  }
}
