import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { Dpapi, isPlatformSupported } from "@primno/dpapi";
import type {
  AlpacaPaperCredentials,
  DataProviderProfile,
  ProviderCredentials
} from "@copylab/shared";
import type { Repository } from "./repository.js";
import { normalizeDataProviderProfile } from "./provider-profile.js";

const ENTROPY = new TextEncoder().encode("solana-copy-lab:v1:current-user");
const CREDENTIALS_KEY = "provider-credentials";
const ALPACA_PAPER_CREDENTIALS_KEY = "alpaca-paper-credentials";
const PROVIDER_PROFILE_KEY = "data-provider-profile";
const WALLET_KEY = "bot-wallet-secret";

export interface RecoveryEnvelope {
  version: 1;
  algorithm: "aes-256-gcm+scrypt";
  address: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
}

function ensureDpapi(): void {
  if (!isPlatformSupported) {
    throw new Error("Windows DPAPI is unavailable. Live credentials and signing are disabled.");
  }
}

export class SecretVault {
  constructor(private readonly repository: Repository) {}

  private encryptCurrentUser(value: Uint8Array): string {
    ensureDpapi();
    return Buffer.from(Dpapi.protectData(value, ENTROPY, "CurrentUser")).toString("base64");
  }

  private decryptCurrentUser(ciphertext: string): Uint8Array {
    ensureDpapi();
    return Dpapi.unprotectData(Buffer.from(ciphertext, "base64"), ENTROPY, "CurrentUser");
  }

  setCredentials(credentials: ProviderCredentials): void {
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    try {
      this.repository.setSecretCiphertext(CREDENTIALS_KEY, this.encryptCurrentUser(plaintext));
    } finally {
      plaintext.fill(0);
    }
  }

  getCredentials(): ProviderCredentials | undefined {
    const ciphertext = this.repository.getSecretCiphertext(CREDENTIALS_KEY);
    if (!ciphertext) return undefined;
    const plaintext = Buffer.from(this.decryptCurrentUser(ciphertext));
    try {
      return JSON.parse(plaintext.toString("utf8")) as ProviderCredentials;
    } finally {
      plaintext.fill(0);
    }
  }

  hasCredentials(): boolean {
    return this.repository.hasSecret(CREDENTIALS_KEY);
  }

  clearCredentials(): void {
    this.repository.deleteSecret(CREDENTIALS_KEY);
  }

  setAlpacaPaperCredentials(credentials: AlpacaPaperCredentials): void {
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    try {
      this.repository.setSecretCiphertext(
        ALPACA_PAPER_CREDENTIALS_KEY,
        this.encryptCurrentUser(plaintext)
      );
    } finally {
      plaintext.fill(0);
    }
  }

  getAlpacaPaperCredentials(): AlpacaPaperCredentials | undefined {
    const ciphertext = this.repository.getSecretCiphertext(ALPACA_PAPER_CREDENTIALS_KEY);
    if (!ciphertext) return undefined;
    const plaintext = Buffer.from(this.decryptCurrentUser(ciphertext));
    try {
      return JSON.parse(plaintext.toString("utf8")) as AlpacaPaperCredentials;
    } finally {
      plaintext.fill(0);
    }
  }

  hasAlpacaPaperCredentials(): boolean {
    return this.repository.hasSecret(ALPACA_PAPER_CREDENTIALS_KEY);
  }

  clearAlpacaPaperCredentials(): void {
    this.repository.deleteSecret(ALPACA_PAPER_CREDENTIALS_KEY);
  }

  setDataProviderProfile(profile: DataProviderProfile): void {
    const normalized = normalizeDataProviderProfile(profile);
    const plaintext = Buffer.from(JSON.stringify(normalized), "utf8");
    try {
      this.repository.setSecretCiphertext(PROVIDER_PROFILE_KEY, this.encryptCurrentUser(plaintext));
    } finally {
      plaintext.fill(0);
    }
  }

  getDataProviderProfile(): DataProviderProfile {
    const ciphertext = this.repository.getSecretCiphertext(PROVIDER_PROFILE_KEY);
    if (!ciphertext) return { mode: "MANAGED" };
    const plaintext = Buffer.from(this.decryptCurrentUser(ciphertext));
    try {
      return normalizeDataProviderProfile(JSON.parse(plaintext.toString("utf8")) as DataProviderProfile);
    } finally {
      plaintext.fill(0);
    }
  }

  hasDataProviderProfile(): boolean {
    return this.repository.hasSecret(PROVIDER_PROFILE_KEY);
  }

  storeWalletSecret(secretKey: Uint8Array): void {
    const copy = Buffer.from(secretKey);
    try {
      this.repository.setSecretCiphertext(WALLET_KEY, this.encryptCurrentUser(copy));
    } finally {
      copy.fill(0);
    }
  }

  loadWalletSecret(): Uint8Array | undefined {
    const ciphertext = this.repository.getSecretCiphertext(WALLET_KEY);
    return ciphertext ? this.decryptCurrentUser(ciphertext) : undefined;
  }

  hasWallet(): boolean {
    return this.repository.hasSecret(WALLET_KEY);
  }

  createRecoveryEnvelope(address: string, secretKey: Uint8Array, passphrase: string): RecoveryEnvelope {
    if (passphrase.length < 12) throw new Error("Recovery passphrase must be at least 12 characters.");
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(secretKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    key.fill(0);
    return {
      version: 1,
      algorithm: "aes-256-gcm+scrypt",
      address,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: encrypted.toString("base64"),
      createdAt: new Date().toISOString()
    };
  }

  restoreRecoveryEnvelope(envelope: RecoveryEnvelope, passphrase: string): Uint8Array {
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm+scrypt") {
      throw new Error("Unsupported recovery backup format.");
    }
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const key = scryptSync(passphrase, salt, 32, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
      ]);
    } catch {
      throw new Error("Recovery backup or passphrase is invalid.");
    } finally {
      key.fill(0);
    }
  }
}
