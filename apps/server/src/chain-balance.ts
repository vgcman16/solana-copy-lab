import { Connection, PublicKey, type FetchFn } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@copylab/shared";

export interface ChainBalances {
  solLamports: bigint;
  tokenAmounts: Map<string, bigint>;
}

export interface BalanceReader {
  read(owner: string): Promise<ChainBalances>;
  readMint(owner: string, mint: string): Promise<bigint>;
}

export interface SolanaRpcBalanceReaderOptions {
  fetch?: FetchFn;
  /** Called immediately before each physical JSON-RPC request. */
  onRequest?: (method: "getBalance" | "getTokenAccountsByOwner") => void;
}

function rpcEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Solana balance RPC endpoint must be an absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Solana balance RPC endpoint must use http: or https:.");
  }
  if (url.hash) throw new Error("Solana balance RPC endpoint cannot include a URL fragment.");
  return url.toString();
}

export class SolanaRpcBalanceReader implements BalanceReader {
  private readonly connection: Connection;
  private readonly onRequest: NonNullable<SolanaRpcBalanceReaderOptions["onRequest"]>;

  constructor(rpcUrl: string, options: SolanaRpcBalanceReaderOptions = {}) {
    this.onRequest = options.onRequest ?? (() => undefined);
    this.connection = new Connection(rpcEndpoint(rpcUrl), {
      commitment: "confirmed",
      ...(options.fetch ? { fetch: options.fetch } : {})
    });
  }

  async read(ownerAddress: string): Promise<ChainBalances> {
    const owner = new PublicKey(ownerAddress);
    const readSol = (): ReturnType<Connection["getBalance"]> => {
      this.onRequest("getBalance");
      return this.connection.getBalance(owner, "confirmed");
    };
    const readTokens = (): ReturnType<Connection["getTokenAccountsByOwner"]> => {
      this.onRequest("getTokenAccountsByOwner");
      return this.connection.getTokenAccountsByOwner(
        owner,
        { programId: new PublicKey(TOKEN_PROGRAM_ID) },
        "confirmed"
      );
    };
    const [solLamports, tokenAccounts] = await Promise.all([
      readSol(),
      readTokens()
    ]);
    const tokenAmounts = new Map<string, bigint>();
    for (const account of tokenAccounts.value) {
      const data = account.account.data;
      if (data.length < 72) throw new Error("Solana RPC returned a truncated SPL token account.");
      const mint = new PublicKey(data.subarray(0, 32)).toBase58();
      const amount = data.readBigUInt64LE(64);
      tokenAmounts.set(mint, (tokenAmounts.get(mint) ?? 0n) + amount);
    }
    return { solLamports: BigInt(solLamports), tokenAmounts };
  }

  async readMint(ownerAddress: string, mintAddress: string): Promise<bigint> {
    const owner = new PublicKey(ownerAddress);
    const mint = new PublicKey(mintAddress);
    this.onRequest("getTokenAccountsByOwner");
    const tokenAccounts = await this.connection.getTokenAccountsByOwner(
      owner,
      { mint },
      "confirmed"
    );
    let total = 0n;
    for (const account of tokenAccounts.value) {
      const data = account.account.data;
      if (data.length < 72) throw new Error("Solana RPC returned a truncated SPL token account.");
      total += data.readBigUInt64LE(64);
    }
    return total;
  }
}

export class HeliusBalanceReader extends SolanaRpcBalanceReader {
  constructor(apiKey: string, options: SolanaRpcBalanceReaderOptions = {}) {
    if (!apiKey.trim()) throw new Error("Helius API key is required for balance reconciliation.");
    super(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, options);
  }
}
