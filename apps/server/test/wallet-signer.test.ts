import { afterEach, describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  type DataProviderProfile
} from "@copylab/shared";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { SecretVault } from "../src/vault.js";
import {
  DpapiTransactionSigner,
  ActiveDataProviderRpcConnectionResolver,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  JUPITER_EVENT_AUTHORITY,
  JUPITER_V6_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  type SignerRpcConnection,
  WalletManager
} from "../src/wallet.js";

function associatedTokenAddress(wallet: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
  )[0];
}

function transactionFor(
  wallet: PublicKey,
  program: PublicKey,
  inputAmount = 5_000_000n,
  destinationOwner = wallet,
  extraSigner?: PublicKey,
  priorityMicroLamports = 0n,
  routeOptions: {
    platformFeeBps?: number;
    positiveSlippageBps?: number;
    routeVariant?: number;
    optionalDestination?: PublicKey;
    routeProgram?: PublicKey;
    extraRouteAccount?: PublicKey;
    lookupTable?: AddressLookupTableAccount;
  } = {}
): string {
  const inputMint = new PublicKey(USDC_MINT);
  const outputMint = new PublicKey(SOL_MINT);
  const data = Buffer.alloc(39);
  Buffer.from([187, 100, 250, 204, 49, 196, 175, 20]).copy(data, 0);
  data.writeBigUInt64LE(inputAmount, 8);
  data.writeBigUInt64LE(5_000_000n, 16);
  data.writeUInt16LE(10, 24);
  data.writeUInt16LE(routeOptions.platformFeeBps ?? 0, 26);
  data.writeUInt16LE(routeOptions.positiveSlippageBps ?? 0, 28);
  data.writeUInt32LE(1, 30);
  data[34] = routeOptions.routeVariant ?? 7;
  data.writeUInt16LE(10_000, 35);
  data[37] = 0;
  data[38] = 1;
  const keys = [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: associatedTokenAddress(wallet, inputMint), isSigner: false, isWritable: true },
    { pubkey: associatedTokenAddress(destinationOwner, outputMint), isSigner: false, isWritable: true },
    { pubkey: inputMint, isSigner: false, isWritable: false },
    { pubkey: outputMint, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    {
      pubkey: routeOptions.optionalDestination ?? new PublicKey(JUPITER_V6_PROGRAM_ID),
      isSigner: false,
      isWritable: false
    },
    { pubkey: new PublicKey(JUPITER_EVENT_AUTHORITY), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(JUPITER_V6_PROGRAM_ID), isSigner: false, isWritable: false },
    {
      pubkey: routeOptions.routeProgram ?? new PublicKey(RAYDIUM_AMM_V4_PROGRAM_ID),
      isSigner: false,
      isWritable: false
    }
  ];
  if (routeOptions.extraRouteAccount) {
    keys.push({ pubkey: routeOptions.extraRouteAccount, isSigner: false, isWritable: false });
  }
  if (extraSigner) keys.push({ pubkey: extraSigner, isSigner: true, isWritable: false });
  const instruction = new TransactionInstruction({
    programId: program,
    keys,
    data
  });
  const instructions = priorityMicroLamports > 0n
    ? [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
        instruction
      ]
    : [instruction];
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: "11111111111111111111111111111111",
    instructions
  }).compileToV0Message(routeOptions.lookupTable ? [routeOptions.lookupTable] : []);
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

describe("DpapiTransactionSigner", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("resolves every signing operation from the current provider profile without caching", () => {
    const endpoints: string[] = [];
    const connection = {
      getMultipleAccountsInfo: async () => [],
      getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null })
    } as unknown as SignerRpcConnection;
    let profile: DataProviderProfile = {
      mode: "SELF_HOSTED",
      solanaHttpUrl: "https://self.example.test/rpc?token=self",
      solanaWsUrl: "wss://self.example.test/ws?token=self",
      emergencySolanaHttpUrl: "https://exit.example.test/rpc?token=exit"
    };
    const resolver = new ActiveDataProviderRpcConnectionResolver({
      getDataProviderProfile: () => profile,
      getCredentials: () => ({
        birdeyeApiKey: "birdeye",
        heliusApiKey: "managed-key",
        jupiterApiKey: "jupiter"
      })
    }, {
      createConnection: (endpoint) => {
        endpoints.push(endpoint);
        return connection;
      }
    });

    expect(resolver.resolve().usageProvider).toBe("solana_rpc");
    expect(resolver.resolve(true).usageProvider).toBe("solana_rpc");
    profile = { mode: "MANAGED" };
    expect(resolver.resolve().usageProvider).toBe("helius");
    profile = {
      mode: "SHADOW",
      solanaHttpUrl: "https://self.example.test/rpc-b",
      solanaWsUrl: "wss://self.example.test/ws-b"
    };
    expect(resolver.resolve().usageProvider).toBe("helius");

    expect(endpoints[0]).toBe("https://self.example.test/rpc?token=self");
    expect(endpoints[0]).not.toContain("helius-rpc.com");
    expect(endpoints.slice(1)).toEqual([
      "https://exit.example.test/rpc?token=exit",
      "https://mainnet.helius-rpc.com/?api-key=managed-key",
      "https://mainnet.helius-rpc.com/?api-key=managed-key"
    ]);

    profile = {
      mode: "SELF_HOSTED",
      solanaHttpUrl: "https://self.example.test/rpc",
      solanaWsUrl: "wss://self.example.test/ws"
    };
    expect(() => resolver.resolve(true)).toThrow("emergency-exit signer RPC is not configured");

    profile = {
      mode: "SELF_HOSTED",
      solanaHttpUrl: "https://self.example.test/rpc?token=must-not-leak",
      solanaWsUrl: "wss://self.example.test/ws"
    };
    const rejecting = new ActiveDataProviderRpcConnectionResolver({
      getDataProviderProfile: () => profile,
      getCredentials: () => undefined
    }, {
      createConnection: (endpoint) => { throw new Error(endpoint); }
    });
    expect(() => rejecting.resolve()).toThrow("could not be created; signing fails closed");
    try {
      rejecting.resolve();
    } catch (error) {
      expect(String(error)).not.toContain("must-not-leak");
    }
  });

  it.runIf(process.platform === "win32")("signs only after backup confirmation and rejects unknown programs", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const manager = new WalletManager(vault, repository);
    const created = manager.create("correct horse battery staple");
    expect(manager.pendingRecovery(created.address)).toEqual(created.recovery);
    manager.confirmBackup(created.address);
    expect(() => manager.pendingRecovery(created.address)).toThrow("already confirmed");
    const signer = new DpapiTransactionSigner(vault, repository, {
      loadExecutableAccounts: async () => new Set([RAYDIUM_AMM_V4_PROGRAM_ID])
    });
    const validation = {
      wallet: created.address,
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      maximumInputAtomic: "5000000",
      quotedOutputAtomic: "5000000",
      minimumOutputAtomic: "4995000",
      expectedSlippageBps: 10,
      signatureFeeLamports: 5000,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
      expectedRouter: "iris",
      maximumFeeLamports: 100000,
      allowedPrograms: [JUPITER_V6_PROGRAM_ID],
      expectedPlatformFeeBps: 0,
      allowedFeeAccounts: [],
      allowedRoutePrograms: [RAYDIUM_AMM_V4_PROGRAM_ID],
      exitOnlyRpcAuthorized: false
    };

    const signed = await signer.signValidatedTransaction(
      transactionFor(new PublicKey(created.address), new PublicKey(JUPITER_V6_PROGRAM_ID)),
      validation
    );
    expect(VersionedTransaction.deserialize(Buffer.from(signed, "base64")).signatures[0]).not.toEqual(
      new Uint8Array(64)
    );

    await expect(
      signer.signValidatedTransaction(
        transactionFor(new PublicKey(created.address), Keypair.generate().publicKey),
        validation
      )
    ).rejects.toThrow("unapproved program");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(new PublicKey(created.address), new PublicKey(JUPITER_V6_PROGRAM_ID), 5_000_001n),
        validation
      )
    ).rejects.toThrow("authorized amount");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          Keypair.generate().publicKey
        ),
        validation
      )
    ).rejects.toThrow("destination token account");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          new PublicKey(created.address),
          Keypair.generate().publicKey
        ),
        validation
      )
    ).rejects.toThrow("Unexpected transaction signers");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(new PublicKey(created.address), new PublicKey(JUPITER_V6_PROGRAM_ID)),
        { ...validation, maximumFeeLamports: 4_999 }
      )
    ).rejects.toThrow("fees exceed");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          new PublicKey(created.address),
          undefined,
          2_000_000n
        ),
        {
          ...validation,
          allowedPrograms: [JUPITER_V6_PROGRAM_ID, ComputeBudgetProgram.programId.toBase58()]
        }
      )
    ).rejects.toThrow("priority fee");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          new PublicKey(created.address),
          undefined,
          0n,
          { platformFeeBps: 1 }
        ),
        validation
      )
    ).rejects.toThrow("unauthorized platform fee");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          new PublicKey(created.address),
          undefined,
          0n,
          { positiveSlippageBps: 1 }
        ),
        validation
      )
    ).rejects.toThrow("positive-slippage fee");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          new PublicKey(created.address),
          undefined,
          0n,
          { optionalDestination: Keypair.generate().publicKey }
        ),
        validation
      )
    ).rejects.toThrow("fee recipient");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          new PublicKey(created.address),
          undefined,
          0n,
          { routeVariant: 255 }
        ),
        validation
      )
    ).rejects.toThrow("route family 255");

    await expect(
      signer.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          new PublicKey(created.address),
          undefined,
          0n,
          { routeProgram: Keypair.generate().publicKey }
        ),
        validation
      )
    ).rejects.toThrow("program account is missing");

    const unexpectedProgram = Keypair.generate().publicKey;
    const executableSigner = new DpapiTransactionSigner(vault, repository, {
      loadExecutableAccounts: async (addresses) => new Set(addresses.map((address) => address.toBase58()))
    });
    await expect(
      executableSigner.signValidatedTransaction(
        transactionFor(
          new PublicKey(created.address),
          new PublicKey(JUPITER_V6_PROGRAM_ID),
          5_000_000n,
          new PublicKey(created.address),
          undefined,
          0n,
          { extraRouteAccount: unexpectedProgram }
        ),
        validation
      )
    ).rejects.toThrow("unapproved executable program account");
  });

  it.runIf(process.platform === "win32")(
    "restores a dedicated signer from its encrypted recovery envelope without accepting overwrite",
    () => {
      const sourceDb = openDatabase(":memory:");
      let recovery!: ReturnType<WalletManager["create"]>;
      try {
        const sourceRepository = new Repository(sourceDb);
        const sourceVault = new SecretVault(sourceRepository);
        recovery = new WalletManager(sourceVault, sourceRepository).create("correct horse battery staple");
      } finally {
        sourceDb.close();
      }

      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      const manager = new WalletManager(vault, repository);
      expect(manager.restore(recovery.recovery, "correct horse battery staple")).toEqual({
        address: recovery.address,
        backupConfirmed: true
      });
      expect(manager.status()).toEqual({
        exists: true,
        address: recovery.address,
        backupConfirmed: true
      });
      expect(() => manager.restore(recovery.recovery, "correct horse battery staple")).toThrow(
        "will not overwrite"
      );
      expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "wallet_restored", severity: "warning" })
      ]));
    }
  );

  it.runIf(process.platform === "win32")(
    "uses only SELF_HOSTED RPC for lookup and executable reads, then switches safely after profile changes",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      const manager = new WalletManager(vault, repository);
      const created = manager.create("correct horse battery staple");
      manager.confirmBackup(created.address);
      vault.setCredentials({
        birdeyeApiKey: "birdeye",
        heliusApiKey: "managed-key",
        jupiterApiKey: "jupiter"
      });
      const selfHostedEndpoint = "https://self.example.test/rpc?token=self-only";
      vault.setDataProviderProfile({
        mode: "SELF_HOSTED",
        solanaHttpUrl: selfHostedEndpoint,
        solanaWsUrl: "wss://self.example.test/ws?token=self-only"
      });
      const extraRouteAccount = Keypair.generate().publicKey;
      const lookupTable = new AddressLookupTableAccount({
        key: Keypair.generate().publicKey,
        state: {
          deactivationSlot: 18_446_744_073_709_551_615n,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: [extraRouteAccount]
        }
      });
      const endpoints: string[] = [];
      const connection = {
        getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map((address) => ({
          executable: address.toBase58() === RAYDIUM_AMM_V4_PROGRAM_ID
        })),
        getAddressLookupTable: async () => ({ context: { slot: 1 }, value: lookupTable })
      } as unknown as SignerRpcConnection;
      const resolver = new ActiveDataProviderRpcConnectionResolver(vault, {
        createConnection: (endpoint) => {
          endpoints.push(endpoint);
          return connection;
        }
      });
      const signer = new DpapiTransactionSigner(vault, repository, {
        rpcConnectionResolver: resolver
      });
      const validation = {
        wallet: created.address,
        inputMint: USDC_MINT,
        outputMint: SOL_MINT,
        maximumInputAtomic: "5000000",
        quotedOutputAtomic: "5000000",
        minimumOutputAtomic: "4995000",
        expectedSlippageBps: 10,
        signatureFeeLamports: 5000,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        expectedRouter: "iris",
        maximumFeeLamports: 100000,
        allowedPrograms: [JUPITER_V6_PROGRAM_ID],
        expectedPlatformFeeBps: 0,
        allowedFeeAccounts: [],
        allowedRoutePrograms: [RAYDIUM_AMM_V4_PROGRAM_ID],
        exitOnlyRpcAuthorized: false
      };
      const unsigned = transactionFor(
        new PublicKey(created.address),
        new PublicKey(JUPITER_V6_PROGRAM_ID),
        5_000_000n,
        new PublicKey(created.address),
        undefined,
        0n,
        { extraRouteAccount, lookupTable }
      );

      await signer.signValidatedTransaction(unsigned, validation);
      expect(endpoints).toEqual([selfHostedEndpoint]);
      expect(endpoints.some((endpoint) => endpoint.includes("helius-rpc.com"))).toBe(false);

      vault.setDataProviderProfile({ mode: "MANAGED" });
      await signer.signValidatedTransaction(unsigned, validation);
      vault.setDataProviderProfile({
        mode: "SHADOW",
        solanaHttpUrl: "https://self.example.test/shadow-rpc",
        solanaWsUrl: "wss://self.example.test/shadow-ws"
      });
      await signer.signValidatedTransaction(unsigned, validation);

      expect(endpoints).toEqual([
        selfHostedEndpoint,
        "https://mainnet.helius-rpc.com/?api-key=managed-key",
        "https://mainnet.helius-rpc.com/?api-key=managed-key"
      ]);
      const usage = new Map(repository.usageSince("1970-01-01").map((entry) => [entry.provider, entry.requests]));
      expect(usage.get("solana_rpc")).toBe(2);
      expect(usage.get("helius")).toBe(4);
    }
  );
});
