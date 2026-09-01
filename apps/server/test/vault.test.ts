import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { SecretVault } from "../src/vault.js";

describe("SecretVault", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it.runIf(process.platform === "win32")("round-trips credentials through CurrentUser DPAPI", () => {
    db = openDatabase(":memory:");
    const vault = new SecretVault(new Repository(db));
    const credentials = {
      birdeyeApiKey: "birdeye-secret",
      heliusApiKey: "helius-secret",
      jupiterApiKey: "jupiter-secret",
      pythBenchmarksApiKey: "pyth-benchmarks-secret"
    };
    vault.setCredentials(credentials);
    expect(vault.getCredentials()).toEqual(credentials);
    const encrypted = new Repository(db).getSecretCiphertext("provider-credentials") ?? "";
    expect(encrypted).not.toContain(credentials.pythBenchmarksApiKey);
  });

  it.runIf(process.platform === "win32")("keeps Alpaca Paper credentials in a separate DPAPI envelope", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const credentials = {
      apiKey: "alpaca-paper-api-key",
      secretKey: "alpaca-paper-secret-key"
    };
    vault.setAlpacaPaperCredentials(credentials);
    expect(vault.getAlpacaPaperCredentials()).toEqual(credentials);
    expect(vault.hasAlpacaPaperCredentials()).toBe(true);
    const encrypted = repository.getSecretCiphertext("alpaca-paper-credentials") ?? "";
    expect(encrypted).not.toContain(credentials.apiKey);
    expect(encrypted).not.toContain(credentials.secretKey);
    expect(repository.getSecretCiphertext("provider-credentials")).toBeUndefined();
    vault.clearAlpacaPaperCredentials();
    expect(vault.hasAlpacaPaperCredentials()).toBe(false);
  });

  it.runIf(process.platform === "win32")("encrypts self-hosted RPC endpoints and defaults legacy installs to managed", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    expect(vault.getDataProviderProfile()).toEqual({ mode: "MANAGED" });

    vault.setDataProviderProfile({
      mode: "SHADOW",
      solanaHttpUrl: "http://127.0.0.1:8899/?token=private",
      solanaWsUrl: "ws://127.0.0.1:8900/?token=private"
    });

    expect(vault.getDataProviderProfile()).toEqual({
      mode: "SHADOW",
      solanaHttpUrl: "http://127.0.0.1:8899/?token=private",
      solanaWsUrl: "ws://127.0.0.1:8900/?token=private"
    });
    const encrypted = repository.getSecretCiphertext("data-provider-profile") ?? "";
    expect(encrypted).not.toContain("token=private");
  });

  it("creates a passphrase-encrypted recovery envelope and rejects the wrong passphrase", () => {
    db = openDatabase(":memory:");
    const vault = new SecretVault(new Repository(db));
    const keypair = Keypair.generate();
    const envelope = vault.createRecoveryEnvelope(
      keypair.publicKey.toBase58(),
      keypair.secretKey,
      "correct horse battery staple"
    );

    expect(
      Array.from(vault.restoreRecoveryEnvelope(envelope, "correct horse battery staple"))
    ).toEqual(Array.from(keypair.secretKey));
    expect(() => vault.restoreRecoveryEnvelope(envelope, "this is the wrong passphrase")).toThrow(
      "invalid"
    );
  }, 15_000);
});
