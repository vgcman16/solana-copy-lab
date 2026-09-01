import { describe, expect, it } from "vitest";
import { PublicKey, type FetchFn } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, USDC_MINT } from "@copylab/shared";
import { SolanaRpcBalanceReader } from "../src/chain-balance.js";

const OWNER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function rpcFetch(tokenDataLength = 165): FetchFn {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (request.method === "getBalance") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { context: { slot: 42 }, value: 123_456 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (request.method !== "getTokenAccountsByOwner") {
      throw new Error(`Unexpected RPC method ${request.method}`);
    }
    const data = Buffer.alloc(tokenDataLength);
    if (tokenDataLength >= 32) new PublicKey(USDC_MINT).toBuffer().copy(data, 0);
    if (tokenDataLength >= 72) data.writeBigUInt64LE(8_765_432n, 64);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        context: { slot: 42 },
        value: [{
          pubkey: OWNER,
          account: {
            lamports: 2_039_280,
            data: [data.toString("base64"), "base64"],
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            rentEpoch: 1,
            space: tokenDataLength
          }
        }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function mintRpcFetch(
  amounts: readonly bigint[],
  requests: Array<{ method: string; params: unknown[] }>,
  tokenDataLength = 165
): FetchFn {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    requests.push({ method: request.method, params: request.params });
    if (request.method !== "getTokenAccountsByOwner") {
      throw new Error(`Unexpected RPC method ${request.method}`);
    }
    const value = amounts.map((amount, index) => {
      const data = Buffer.alloc(tokenDataLength);
      if (tokenDataLength >= 32) new PublicKey(USDC_MINT).toBuffer().copy(data, 0);
      if (tokenDataLength >= 72) data.writeBigUInt64LE(amount, 64);
      return {
        pubkey: index === 0 ? OWNER : TOKEN_PROGRAM_ID,
        account: {
          lamports: 2_039_280,
          data: [data.toString("base64"), "base64"],
          owner: index % 2 === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
          executable: false,
          rentEpoch: 1,
          space: tokenDataLength
        }
      };
    });
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { context: { slot: 42 }, value }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("SolanaRpcBalanceReader", () => {
  it("reads SOL and standard SPL balances from an explicit standard RPC endpoint", async () => {
    const requestedMethods: string[] = [];
    const reader = new SolanaRpcBalanceReader("http://127.0.0.1:8899", {
      fetch: rpcFetch(),
      onRequest: (method) => requestedMethods.push(method)
    });
    const balances = await reader.read(OWNER);
    expect(balances.solLamports).toBe(123_456n);
    expect(balances.tokenAmounts.get(USDC_MINT)).toBe(8_765_432n);
    expect(requestedMethods.sort()).toEqual(["getBalance", "getTokenAccountsByOwner"].sort());
  });

  it("reads one mint across every owner token account using the mint filter", async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const requestedMethods: string[] = [];
    const reader = new SolanaRpcBalanceReader("http://127.0.0.1:8899", {
      fetch: mintRpcFetch([2_000n, 3_500n], requests),
      onRequest: (method) => requestedMethods.push(method)
    });

    await expect(reader.readMint(OWNER, USDC_MINT)).resolves.toBe(5_500n);
    expect(requestedMethods).toEqual(["getTokenAccountsByOwner"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("getTokenAccountsByOwner");
    expect(requests[0]?.params[0]).toBe(OWNER);
    expect(requests[0]?.params[1]).toEqual({ mint: USDC_MINT });
  });

  it("fails closed when a mint-filtered token account is truncated", async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const reader = new SolanaRpcBalanceReader("https://rpc.example.test", {
      fetch: mintRpcFetch([1n], requests, 71)
    });

    await expect(reader.readMint(OWNER, USDC_MINT)).rejects.toThrow("truncated SPL token account");
  });

  it("fails closed on truncated token data and unsafe endpoint schemes", async () => {
    const reader = new SolanaRpcBalanceReader("https://rpc.example.test", { fetch: rpcFetch(16) });
    await expect(reader.read(OWNER)).rejects.toThrow("truncated SPL token account");
    expect(() => new SolanaRpcBalanceReader("file:///validator-ledger")).toThrow("http: or https:");
  });
});
