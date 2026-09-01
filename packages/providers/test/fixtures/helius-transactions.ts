import { SOL_MINT, USDC_MINT } from "@copylab/shared";
import {
  JUPITER_V4_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID
} from "../../src/helius-decoder.js";

export const TEST_WALLET = "7YttLkHDoNj9wyDur5KrsbG7k9QWgxsWUcJpm5bLzZx1";
export const TARGET_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
export const OTHER_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export const TEST_SIGNATURE =
  "4vJ9JU1bJJE96FWSJKvHsmmF7UK8iAtZVYhV6Qq7xV6LrQx4P2jDnYqfLwzY8nVdBX2mYh6Xh8Zs8WzH7aY6uPq";

// Reduced from finalized mainnet transaction slot 431881026, fetched through
// getTransaction(jsonParsed) on 2026-07-09. Keeping the public signature makes
// it possible to refresh the complete capture independently.
export const PUBLIC_SWAP_SIGNATURE =
  "4Xwyv79hMUBC2sQtcd6V89AAf3j3aa5noEtuEwPAXnUawMjsyfojzTtHaKWGcVPvu6wsiEQUsKEP5km2VD5dAusv";
export const PUBLIC_SWAP_WALLET = "AsqjH9tdEcDTZeYLaGdRSs8rZ2aXqeMC6Xh9Ngy1wBgF";
export const PUBLIC_SWAP_TARGET = "EUFdqYcKPrNrraJuKjHGtAahxmG9Y5NM8voqSbp1pump";

const JUPITER_V6 = JUPITER_V6_PROGRAM_ID;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const EPHEMERAL_TOKEN_ACCOUNT = "EphemeralWsolTokenAccount1111111111111111111";
const CAPTURED_RAYDIUM_CPMM_SWAP_INSTRUCTION = {
  programId: RAYDIUM_CPMM_PROGRAM_ID,
  accounts: [],
  data: "E73fXHPWvSR8VCr6ujjfVSBYgv1v9V5Dy"
};
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: readonly number[]): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return `${"1".repeat(leadingZeroes)}${encoded}`;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u64(value: bigint): number[] {
  return Array.from({ length: 8 }, (_unused, index) => Number((value >> BigInt(index * 8)) & 0xffn));
}

function legacyJupiterRouteData(inAmount: bigint, quotedOutAmount: bigint): string {
  return base58Encode([
    229, 23, 203, 151, 122, 227, 173, 42,
    ...u32(1),
    7, 100, 0, 1,
    ...u64(inAmount),
    ...u64(quotedOutAmount),
    ...u16(50),
    0
  ]);
}

function jupiterRouteV2Data(inAmount: bigint, quotedOutAmount: bigint): string {
  return base58Encode([
    187, 100, 250, 204, 49, 196, 175, 20,
    ...u64(inAmount),
    ...u64(quotedOutAmount),
    ...u16(50),
    ...u16(0),
    ...u16(0),
    ...u32(1),
    7, ...u16(10_000), 0, 1
  ]);
}

function jupiterV6LegacyAccounts(wallet = TEST_WALLET): string[] {
  return [
    TOKEN_PROGRAM,
    wallet,
    "UserSourceTokenAccount11111111111111111111111",
    "UserDestinationTokenAccount111111111111111111",
    "DestinationTokenAccount1111111111111111111111",
    TARGET_MINT,
    JUPITER_V6,
    JUPITER_EVENT_AUTHORITY,
    JUPITER_V6
  ];
}

function jupiterV6RouteV2Accounts(wallet = TEST_WALLET): string[] {
  return [
    wallet,
    "UserSourceTokenAccount11111111111111111111111",
    "UserDestinationTokenAccount111111111111111111",
    USDC_MINT,
    TARGET_MINT,
    TOKEN_PROGRAM,
    TOKEN_PROGRAM,
    JUPITER_V6,
    JUPITER_EVENT_AUTHORITY,
    JUPITER_V6
  ];
}

function tokenBalance(
  accountIndex: number,
  mint: string,
  amount: string,
  decimals: number,
  owner = TEST_WALLET
) {
  return {
    accountIndex,
    mint,
    owner,
    uiTokenAmount: { amount, decimals, uiAmount: null, uiAmountString: "0" }
  };
}

// Reduced, jsonParsed getTransaction fixture retaining the exact fields used by
// the decoder. Addresses and shapes match public Solana/Helius RPC responses.
export const capturedUsdcSpotSwap = {
  slot: 302_000_001,
  blockTime: 1_720_000_000,
  meta: {
    err: null,
    fee: 5_000,
    preBalances: [10_000_000_000, 0, 0],
    postBalances: [9_999_995_000, 0, 0],
    preTokenBalances: [
      tokenBalance(1, USDC_MINT, "5000000", 6),
      tokenBalance(2, TARGET_MINT, "0", 6)
    ],
    postTokenBalances: [
      tokenBalance(1, USDC_MINT, "1000000", 6),
      tokenBalance(2, TARGET_MINT, "2000000", 6)
    ],
    innerInstructions: [{ index: 0, instructions: [CAPTURED_RAYDIUM_CPMM_SWAP_INSTRUCTION] }],
    logMessages: [`Program ${JUPITER_V6} invoke [1]`]
  },
  transaction: {
    message: {
      accountKeys: [
        { pubkey: TEST_WALLET, signer: true, writable: true },
        { pubkey: "UsdcTokenAccount11111111111111111111111111", signer: false, writable: true },
        { pubkey: "TargetTokenAccount111111111111111111111111", signer: false, writable: true }
      ],
      instructions: [{
        programId: JUPITER_V6,
        accounts: jupiterV6LegacyAccounts(),
        data: legacyJupiterRouteData(4_000_000n, 2_000_000n)
      }]
    },
    signatures: [TEST_SIGNATURE]
  }
};

export const capturedSolSpotSwap = {
  slot: 302_000_002,
  blockTime: 1_720_000_001,
  meta: {
    err: null,
    fee: 5_000,
    preBalances: [10_000_000_000, 0],
    postBalances: [8_999_995_000, 0],
    preTokenBalances: [tokenBalance(1, TARGET_MINT, "0", 6)],
    postTokenBalances: [tokenBalance(1, TARGET_MINT, "100000000", 6)],
    innerInstructions: [{ index: 0, instructions: [CAPTURED_RAYDIUM_CPMM_SWAP_INSTRUCTION] }],
    logMessages: [`Program ${JUPITER_V6} invoke [1]`]
  },
  transaction: {
    message: {
      accountKeys: [TEST_WALLET, "TargetTokenAccount111111111111111111111111"],
      instructions: [{
        programId: JUPITER_V6,
        accounts: jupiterV6LegacyAccounts(),
        data: legacyJupiterRouteData(1_000_000_000n, 100_000_000n)
      }]
    },
    signatures: [TEST_SIGNATURE]
  }
};

export const capturedJupiterV4SpotSwap = {
  ...capturedUsdcSpotSwap,
  meta: {
    ...capturedUsdcSpotSwap.meta,
    logMessages: [`Program ${JUPITER_V4_PROGRAM_ID} invoke [1]`]
  },
  transaction: {
    ...capturedUsdcSpotSwap.transaction,
    message: {
      ...capturedUsdcSpotSwap.transaction.message,
      instructions: [{
        programId: JUPITER_V4_PROGRAM_ID,
        accounts: [TOKEN_PROGRAM, TEST_WALLET, "DestinationTokenAccount1111111111111111111111"],
        data: base58Encode([
          229, 23, 203, 151, 122, 227, 173, 42,
          2, 7,
          ...u64(4_000_000n),
          ...u64(2_000_000n),
          ...u16(50),
          0
        ])
      }]
    }
  }
};

export const capturedJupiterV6RouteV2SpotSwap = {
  ...capturedUsdcSpotSwap,
  transaction: {
    ...capturedUsdcSpotSwap.transaction,
    message: {
      ...capturedUsdcSpotSwap.transaction.message,
      instructions: [{
        programId: JUPITER_V6,
        accounts: jupiterV6RouteV2Accounts(),
        data: jupiterRouteV2Data(4_000_000n, 2_000_000n)
      }]
    }
  }
};

export const capturedArbitraryJupiterInstruction = {
  ...capturedUsdcSpotSwap,
  transaction: {
    ...capturedUsdcSpotSwap.transaction,
    message: {
      ...capturedUsdcSpotSwap.transaction.message,
      instructions: [{
        programId: JUPITER_V6,
        accounts: jupiterV6LegacyAccounts(),
        data: base58Encode([62, 198, 214, 193, 213, 159, 108, 210, 0])
      }]
    }
  }
};

export const capturedJupiterWithUnknownProgram = {
  ...capturedUsdcSpotSwap,
  transaction: {
    ...capturedUsdcSpotSwap.transaction,
    message: {
      ...capturedUsdcSpotSwap.transaction.message,
      instructions: [
        ...capturedUsdcSpotSwap.transaction.message.instructions,
        {
          programId: "UnknownAuxiliaryProgram111111111111111111111",
          accounts: [],
          data: "2"
        }
      ]
    }
  }
};

export const capturedJupiterLogSpoof = {
  ...capturedUsdcSpotSwap,
  transaction: {
    ...capturedUsdcSpotSwap.transaction,
    message: { ...capturedUsdcSpotSwap.transaction.message, instructions: [] }
  }
};

export const capturedSolSpotSwapWithAtaRent = {
  ...capturedSolSpotSwap,
  meta: {
    ...capturedSolSpotSwap.meta,
    postBalances: [8_997_955_720, 0],
    innerInstructions: [{
      index: 0,
      instructions: [{
        program: "system",
        programId: SYSTEM_PROGRAM,
        stackHeight: 2,
        parsed: {
          type: "createAccount",
          info: {
            source: TEST_WALLET,
            newAccount: EPHEMERAL_TOKEN_ACCOUNT,
            lamports: 2_039_280,
            space: 165,
            owner: TOKEN_PROGRAM
          }
        }
      }]
    }, {
      // The Jupiter route moves to outer index 1 when the ATA instruction is
      // prepended; its direct DEX CPI must remain causally attached to it.
      index: 1,
      instructions: [...capturedSolSpotSwap.meta.innerInstructions[0]!.instructions]
    }]
  },
  transaction: {
    ...capturedSolSpotSwap.transaction,
    message: {
      ...capturedSolSpotSwap.transaction.message,
      instructions: [
        {
          program: "spl-associated-token-account",
          programId: ASSOCIATED_TOKEN_PROGRAM,
          stackHeight: 1,
          parsed: {
            type: "createIdempotent",
            info: {
              account: EPHEMERAL_TOKEN_ACCOUNT,
              mint: SOL_MINT,
              source: TEST_WALLET,
              systemProgram: SYSTEM_PROGRAM,
              tokenProgram: TOKEN_PROGRAM,
              wallet: TEST_WALLET
            }
          }
        },
        ...capturedSolSpotSwap.transaction.message.instructions
      ]
    }
  }
};

export const capturedSolSellWithAccountClosure = {
  ...capturedSolSpotSwap,
  meta: {
    ...capturedSolSpotSwap.meta,
    preBalances: [10_000_000_000, 2_039_280],
    postBalances: [10_502_034_280, 0],
    preTokenBalances: [tokenBalance(1, TARGET_MINT, "100000000", 6)],
    postTokenBalances: [tokenBalance(1, TARGET_MINT, "0", 6)]
  },
  transaction: {
    ...capturedSolSpotSwap.transaction,
    message: {
      ...capturedSolSpotSwap.transaction.message,
      instructions: [
        ...capturedSolSpotSwap.transaction.message.instructions,
        {
          program: "spl-token",
          programId: TOKEN_PROGRAM,
          stackHeight: 1,
          parsed: {
            type: "closeAccount",
            info: {
              account: "TargetTokenAccount111111111111111111111111",
              destination: TEST_WALLET,
              owner: TEST_WALLET
            }
          }
        }
      ]
    }
  }
};

export const capturedSolSwapWithBundledTransfer = {
  ...capturedSolSpotSwap,
  transaction: {
    ...capturedSolSpotSwap.transaction,
    message: {
      ...capturedSolSpotSwap.transaction.message,
      instructions: [
        ...capturedSolSpotSwap.transaction.message.instructions,
        {
          program: "system",
          programId: SYSTEM_PROGRAM,
          stackHeight: 1,
          parsed: {
            type: "transfer",
            info: {
              source: TEST_WALLET,
              // Even a wallet-owned non-WSOL token account cannot be used to
              // disguise an unrelated lamport transfer as swap input.
              destination: "TargetTokenAccount111111111111111111111111",
              lamports: 50_000_000
            }
          }
        }
      ]
    }
  }
};

export const recordedPublicSolSell = {
  slot: 431_881_026,
  blockTime: 1_783_633_197,
  meta: {
    err: null,
    fee: 25_719,
    preBalances: [1_524_482_392],
    postBalances: [1_662_709_681],
    preTokenBalances: [
      tokenBalance(5, PUBLIC_SWAP_TARGET, "181449172111", 6, PUBLIC_SWAP_WALLET)
    ],
    postTokenBalances: [
      tokenBalance(5, PUBLIC_SWAP_TARGET, "1", 6, PUBLIC_SWAP_WALLET)
    ],
    innerInstructions: [],
    logMessages: [`Program ${JUPITER_V6} invoke [1]`, "Program log: Instruction: RouteV2"]
  },
  transaction: {
    message: {
      accountKeys: [
        { pubkey: PUBLIC_SWAP_WALLET, signer: true, writable: true },
        "PublicFixtureAccount1111111111111111111111111",
        "PublicFixtureAccount2222222222222222222222222",
        "PublicFixtureAccount3333333333333333333333333",
        "PublicFixtureAccount4444444444444444444444444",
        "PublicFixtureTargetTokenAccount1111111111111111"
      ],
      // Exact top-level RouteV2 instruction from the finalized public
      // transaction. Its PumpSwap route variant is deliberately unsupported.
      instructions: [{
        programId: JUPITER_V6,
        accounts: [
          PUBLIC_SWAP_WALLET,
          "BZtSkAN3nFoV5ai5Yj1wgUX37aTBozf4kgybB2NpNfcj",
          "5nuHNjwX77i7SRZs5dzMhN6EcBnHvCc21gx9up4mseTA",
          PUBLIC_SWAP_TARGET,
          SOL_MINT,
          TOKEN_2022_PROGRAM,
          TOKEN_PROGRAM,
          JUPITER_V6,
          JUPITER_EVENT_AUTHORITY,
          JUPITER_V6
        ],
        data: "37MZM8vwf4KG7qHAh1HBarWuAe5zpv3tGKsiQyyTLCZQ9GDnvmxZ8t"
      }]
    },
    signatures: [PUBLIC_SWAP_SIGNATURE]
  }
};

export const capturedTokenToTokenRotation = {
  ...capturedUsdcSpotSwap,
  meta: {
    ...capturedUsdcSpotSwap.meta,
    preTokenBalances: [
      tokenBalance(1, OTHER_MINT, "5000000", 6),
      tokenBalance(2, TARGET_MINT, "0", 6)
    ],
    postTokenBalances: [
      tokenBalance(1, OTHER_MINT, "1000000", 6),
      tokenBalance(2, TARGET_MINT, "2000000", 6)
    ]
  }
};

export const capturedFailedSwap = {
  ...capturedUsdcSpotSwap,
  meta: { ...capturedUsdcSpotSwap.meta, err: { InstructionError: [2, 6001] } }
};

export const capturedTransfer = {
  ...capturedUsdcSpotSwap,
  meta: { ...capturedUsdcSpotSwap.meta, logMessages: ["Program 11111111111111111111111111111111 invoke [1]"] },
  transaction: {
    ...capturedUsdcSpotSwap.transaction,
    message: {
      ...capturedUsdcSpotSwap.transaction.message,
      instructions: [{ programId: "11111111111111111111111111111111", accounts: [], data: "" }]
    }
  }
};

function directDexUsdcSwap(programId: string, data: string) {
  return {
    ...capturedUsdcSpotSwap,
    meta: {
      ...capturedUsdcSpotSwap.meta,
      innerInstructions: [],
      logMessages: [`Program ${programId} invoke [1]`]
    },
    transaction: {
      ...capturedUsdcSpotSwap.transaction,
      message: {
        ...capturedUsdcSpotSwap.transaction.message,
        instructions: [{ programId, accounts: [], data }]
      }
    }
  };
}

function meteoraDlmmUsdcSwap(data: string) {
  const fixture = directDexUsdcSwap(METEORA_DLMM_PROGRAM_ID, data);
  return {
    ...fixture,
    transaction: {
      ...fixture.transaction,
      message: {
        ...fixture.transaction.message,
        instructions: [{
          programId: METEORA_DLMM_PROGRAM_ID,
          accounts: [
            "MeteoraLbPair11111111111111111111111111111",
            METEORA_DLMM_PROGRAM_ID,
            "MeteoraReserveX111111111111111111111111111",
            "MeteoraReserveY111111111111111111111111111",
            "UsdcTokenAccount11111111111111111111111111",
            "TargetTokenAccount111111111111111111111111",
            USDC_MINT,
            TARGET_MINT,
            "MeteoraOracle11111111111111111111111111111",
            METEORA_DLMM_PROGRAM_ID,
            TEST_WALLET,
            TOKEN_PROGRAM,
            TOKEN_PROGRAM,
            "MeteoraEventAuthority1111111111111111111111",
            METEORA_DLMM_PROGRAM_ID
          ],
          data
        }]
      }
    }
  };
}

// Reduced direct-program fixtures. Instruction bytes are the official swap
// discriminator/opcode followed by a valid minimal argument layout, encoded as
// Solana jsonParsed getTransaction's base58 `data` string.
export const capturedOrcaWhirlpoolSwap = directDexUsdcSwap(
  ORCA_WHIRLPOOL_PROGRAM_ID,
  "59p8WydnSZtTGLkUFA6QDBYeuqNRb83TT1CzzFppUFTjLmWMmiYRJ8PFmJ"
);
export const capturedOrcaWhirlpoolSwapV2 = directDexUsdcSwap(
  ORCA_WHIRLPOOL_PROGRAM_ID,
  "4AoQRYXBdnCD6jpZFTFxu8ocbatC6sNW8U23n4CBPPEuEbQsxBxdxqTfEkX"
);
export const capturedRaydiumCpmmBaseInputSwap = directDexUsdcSwap(
  RAYDIUM_CPMM_PROGRAM_ID,
  "E73fXHPWvSR8VCr6ujjfVSBYgv1v9V5Dy"
);
export const capturedRaydiumCpmmBaseOutputSwap = directDexUsdcSwap(
  RAYDIUM_CPMM_PROGRAM_ID,
  "66JafaVu7KMqDSxymnNTDpVf19xKKeQkX"
);
export const capturedRaydiumClmmSwap = directDexUsdcSwap(
  RAYDIUM_CLMM_PROGRAM_ID,
  "wZRp7wZ3czsoyas8HZVNLcGPPjv9dwUk3mQZTU9VNrZFSwgbbndmfNor"
);
export const capturedRaydiumClmmSwapV2 = directDexUsdcSwap(
  RAYDIUM_CLMM_PROGRAM_ID,
  "ASCsAbe1UnE6nLLP4UnACd74YRJBdPzjGPu4jGQNsBkGXmez4qxm2JuE"
);
export const capturedRaydiumClmmRouterSwap = directDexUsdcSwap(
  RAYDIUM_CLMM_PROGRAM_ID,
  "7LRuqK6r6YisCecPVn9XA4m4FEsZzhHTD"
);
export const capturedRaydiumAmmV4BaseInputSwap = directDexUsdcSwap(
  RAYDIUM_AMM_V4_PROGRAM_ID,
  "63SvtuRSHA7tvWpDNJqHUkP"
);
export const capturedRaydiumAmmV4BaseOutputSwap = directDexUsdcSwap(
  RAYDIUM_AMM_V4_PROGRAM_ID,
  "78fvEpvFTLikvCJNrnu4DSF"
);
export const capturedRaydiumAmmV4BaseInputV2Swap = directDexUsdcSwap(
  RAYDIUM_AMM_V4_PROGRAM_ID,
  "9rjPbdfHPoDuuQ1nb14V49u"
);
export const capturedRaydiumAmmV4BaseOutputV2Swap = directDexUsdcSwap(
  RAYDIUM_AMM_V4_PROGRAM_ID,
  "AQLtGbQgytXLuEksLF6NRVq"
);
export const capturedMeteoraDlmmSwap = meteoraDlmmUsdcSwap(base58Encode([
  248, 198, 158, 145, 225, 117, 135, 200,
  ...u64(4_000_000n),
  ...u64(2_000_000n)
]));
export const capturedMeteoraDlmmSwapExactOut = meteoraDlmmUsdcSwap(base58Encode([
  250, 73, 101, 33, 38, 207, 75, 184,
  ...u64(4_000_000n),
  ...u64(2_000_000n)
]));
export const capturedMeteoraDlmmSwapWithPriceImpact = meteoraDlmmUsdcSwap(base58Encode([
  56, 173, 230, 208, 173, 228, 156, 205,
  ...u64(4_000_000n),
  0,
  ...u16(50)
]));

// LP/deposit lookalikes intentionally retain the exact same two wallet deltas
// as a spot swap. Only their official non-swap instruction bytes differ.
export const capturedOrcaWhirlpoolLiquidityChange = directDexUsdcSwap(
  ORCA_WHIRLPOOL_PROGRAM_ID,
  "3KLKPPgnNhbK6JUiSg2JkqHEfNDJxaPQUwo7LoBhAR3xW2w8jZEqZmy"
);
export const capturedRaydiumCpmmDeposit = directDexUsdcSwap(
  RAYDIUM_CPMM_PROGRAM_ID,
  "HJDJa2VrXJbNUhAavrZaXUuTxL8QP3r132EQwv4VAgUX"
);
export const capturedRaydiumClmmLiquidityChange = directDexUsdcSwap(
  RAYDIUM_CLMM_PROGRAM_ID,
  "7ccwXHskQftezmTiVjeGVUz7QvH483zymiZHaz4yCLHZaJ6Bmnziahu"
);
export const capturedRaydiumAmmV4Deposit = directDexUsdcSwap(
  RAYDIUM_AMM_V4_PROGRAM_ID,
  "2D1oxKts8YPdTJRG5FzxTNpMtWmq8hkVx3"
);
export const capturedMeteoraDlmmLiquidityChange = meteoraDlmmUsdcSwap(base58Encode([
  59, 152, 193, 48, 57, 196, 162, 26,
  ...u64(4_000_000n),
  ...u64(2_000_000n)
]));

export const walletHistoryUsdcBuy = {
  signature: TEST_SIGNATURE,
  type: "SWAP",
  timestamp: 1_720_000_000,
  slot: 302_000_001,
  error: null,
  balanceChanges: [
    { mint: USDC_MINT, amount: -4, decimals: 6 },
    { mint: TARGET_MINT, amount: 2, decimals: 6 }
  ]
};

export const walletHistoryUsdcSell = {
  signature: `${TEST_SIGNATURE.slice(0, -1)}R`,
  type: "SWAP",
  timestamp: 1_720_086_400,
  slot: 302_100_001,
  error: null,
  balanceChanges: [
    { mint: TARGET_MINT, amount: -2, decimals: 6 },
    { mint: USDC_MINT, amount: 5, decimals: 6 }
  ]
};

// Reduced from the live Helius Wallet History `balanceChanges` shape observed
// on 2026-07-09. `amount` is already human-readable even though `decimals` is
// frequently zero; pseudo-native SOL includes duplicate/fee/rent movement and
// the intermediary mint cancels after aggregation.
export const HELIUS_NATIVE_SOL_PSEUDO_MINT =
  "So11111111111111111111111111111111111111111";

export const recordedWalletHistoryUsdcBuy = {
  signature: `${TEST_SIGNATURE.slice(0, -1)}S`,
  timestamp: 1_720_000_000,
  slot: 302_000_001,
  error: null,
  balanceChanges: [
    { mint: USDC_MINT, amount: -4.25, decimals: 0, rawAmount: "-4250000" },
    { mint: TARGET_MINT, amount: 1, decimals: 0, rawAmount: "1000000" },
    { mint: TARGET_MINT, amount: 1.5, decimals: 0, rawAmount: "1500000" },
    { mint: OTHER_MINT, amount: 750, decimals: 0 },
    { mint: OTHER_MINT, amount: -750.0000002, decimals: 0 },
    { mint: HELIUS_NATIVE_SOL_PSEUDO_MINT, amount: -0.00203928, decimals: 0 },
    { mint: HELIUS_NATIVE_SOL_PSEUDO_MINT, amount: -0.000005, decimals: 0 }
  ]
};

export const recordedWalletHistoryUsdcSell = {
  signature: `${TEST_SIGNATURE.slice(0, -1)}T`,
  timestamp: 1_720_086_400,
  slot: 302_100_001,
  error: null,
  balanceChanges: [
    { mint: TARGET_MINT, amount: -2.5, decimals: 0, rawAmount: "-2500000" },
    { mint: USDC_MINT, amount: 5, decimals: 0, rawAmount: "5000000" },
    { mint: HELIUS_NATIVE_SOL_PSEUDO_MINT, amount: -0.000005, decimals: 0 }
  ]
};

export const recordedWalletHistorySolBuy = {
  signature: `${TEST_SIGNATURE.slice(0, -1)}U`,
  timestamp: 1_720_172_800,
  slot: 302_200_001,
  error: null,
  balanceChanges: [
    { mint: SOL_MINT, amount: -0.5, decimals: 0, rawAmount: "-500000000" },
    { mint: TARGET_MINT, amount: 100, decimals: 0, rawAmount: "100000000" },
    { mint: HELIUS_NATIVE_SOL_PSEUDO_MINT, amount: -0.500005, decimals: 0 },
    { mint: HELIUS_NATIVE_SOL_PSEUDO_MINT, amount: 0.5, decimals: 0 }
  ]
};

export const recordedWalletHistorySolSell = {
  signature: `${TEST_SIGNATURE.slice(0, -1)}V`,
  timestamp: 1_720_259_200,
  slot: 302_300_001,
  error: null,
  balanceChanges: [
    { mint: TARGET_MINT, amount: -100, decimals: 0, rawAmount: "-100000000" },
    { mint: SOL_MINT, amount: 0.55, decimals: 0, rawAmount: "550000000" },
    { mint: HELIUS_NATIVE_SOL_PSEUDO_MINT, amount: 0.55, decimals: 0 },
    { mint: HELIUS_NATIVE_SOL_PSEUDO_MINT, amount: -0.55203928, decimals: 0 }
  ]
};

export { SOL_MINT, USDC_MINT };
