# Strict Solana spot-swap decoder

The provider package accepts a confirmed transaction as a spot swap only when
all of the following are true:

- the transaction succeeded;
- the tracked wallet has exactly two material token deltas, with SOL or USDC as
  exactly one leg and opposite delta signs;
- a supported swap program has an exact recognized instruction discriminator,
  Borsh argument layout, and required account prefix; and
- every other outer or inner instruction is an exact supported swap, a bounded
  auxiliary instruction, or a known Anchor swap-event CPI.

Exactly one supported top-level route is required. Jupiter must be that
top-level route, and its independently decoded direct-DEX evidence must be an
inner CPI attached to the same outer-instruction index. A second top-level swap
or a valid-looking CPI attached to another outer instruction is rejected as a
bundle.

Program-invoke logs are never evidence of swap intent. An arbitrary Jupiter
instruction, a log spoof, a direct deposit/withdraw/liquidity instruction, a
truncated or extended instruction, an unknown program, or a mixed swap/LP
bundle fails closed even when wallet balance deltas look like a trade.

## Jupiter aggregator allowlist

`JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB` accepts only the v4 `route`
discriminator `[229,23,203,151,122,227,173,42]`. Its full bounded nested
`SwapLeg` Borsh shape is consumed, the Token Program and tracked transfer
authority accounts are required in their documented positions, and only
Raydium AMM v4, Orca Whirlpool, and Raydium CLMM route variants are accepted.

`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` accepts these exact route
families:

| Family | Accepted discriminators |
| --- | --- |
| Legacy | `route` `[229,23,203,151,122,227,173,42]`; `exact_out_route` `[208,51,239,151,123,43,237,92]`; `route_with_token_ledger` `[150,86,71,116,167,93,14,104]` |
| Legacy shared accounts | `shared_accounts_route` `[193,32,155,51,65,214,156,129]`; `shared_accounts_exact_out_route` `[176,209,105,168,154,125,69,62]`; `shared_accounts_route_with_token_ledger` `[230,121,143,80,119,159,106,170]` |
| V2 | `route_v2` `[187,100,250,204,49,196,175,20]`; `exact_out_route_v2` `[157,138,184,82,21,244,243,36]` |
| V2 shared accounts | `shared_accounts_route_v2` `[209,152,83,147,124,254,216,233]`; `shared_accounts_exact_out_route_v2` `[53,96,229,202,216,187,250,24]` |

For every v6 route, the complete Borsh payload must be consumed with no trailing
bytes, amounts must be positive, slippage/fee fields must be bounded, route
vectors are capped at 16 steps, and the transfer authority, Token/Token-2022
program accounts, event authority, and Jupiter program account must occupy the
exact fixed positions. Route plans accept only the independently supported
Raydium AMM v4, Orca Whirlpool, Raydium CLMM, Raydium CPMM, and Meteora DLMM
variants. Staking, perps, liquidity operations, lending, and every unimplemented
DEX variant are rejected at the route-plan byte.

The old v6 IDL and discriminator/account layouts are pinned from Jupiter's
official repository at [`cc068c9`](https://github.com/jup-ag/jupiter-amm-implementation/tree/cc068c9d1df0060c62f9a8a4fc37ea13ea7b9b39).
The V2 layout is cross-checked against the current generated
[`RouteV2`](https://docs.rs/jupiter-solana-client/1.0.2/src/jupiter_solana_client/generated/instructions/route_v2.rs.html)
bindings and finalized mainnet transaction
[`4Xwy…dAusv`](https://explorer.solana.com/tx/4Xwyv79hMUBC2sQtcd6V89AAf3j3aa5noEtuEwPAXnUawMjsyfojzTtHaKWGcVPvu6wsiEQUsKEP5km2VD5dAusv).
[Jupiter's official integration guide](https://developers.jup.ag/docs/guides/how-to-build-a-custom-swap-with-metis)
documents that current builds use `instructionVersion=V2` and that route AMMs
are CPI-invoked.

The v4 deployed-program shape is pinned from the generated IDL capture at
[`67dc692`](https://github.com/pinax-network/substreams-solana-idls/tree/67dc692c5000b616f3d942973ac3d58bffee204a/src/jupiter/v4)
and corroborated by public finalized v4 instruction bytes. Jupiter no longer
publishes a maintained first-party v4 source tree, so v4 remains intentionally
limited to the single proven `route` entrypoint.

## Direct DEX allowlist

| Program | Mainnet program ID | Accepted instruction encodings |
| --- | --- | --- |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Anchor `swap` `[248,198,158,145,225,117,135,200]`; `swap_v2` `[43,4,237,11,26,201,30,98]` |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | Anchor `swap_base_input` `[143,190,90,218,196,30,51,222]`; `swap_base_output` `[55,217,98,86,163,74,180,173]` |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Anchor `swap`, `swap_v2`, and `swap_router_base_in` `[69,125,115,218,245,186,242,196]` |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | one-byte opcodes `9`, `11`, `16`, and `17` with the official 16-byte argument layout |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Anchor `swap` `[248,198,158,145,225,117,135,200]`; `swap_exact_out` `[250,73,101,33,38,207,75,184]`; `swap_with_price_impact` `[56,173,230,208,173,228,156,205]`, with the exact 15-account prefix |

Primary direct-program sources are pinned to the audited revisions:

- [Orca Whirlpools at `c5e63fb`](https://github.com/orca-so/whirlpools/tree/c5e63fb74db1286ec37e8239dda54145893ffe2a), including generated `swap` and `swap_v2` clients.
- [Raydium CPMM at `78f254e`](https://github.com/raydium-io/raydium-cp-swap/tree/78f254e1023751e706df7dc15c453fc3e046697c) and [SDK v2 at `fb2d829`](https://github.com/raydium-io/raydium-sdk-V2/tree/fb2d829a559f9b6ca95922e4e6c69e3b5bddc95c).
- [Raydium CLMM at `f68fd42`](https://github.com/raydium-io/raydium-clmm/tree/f68fd4286821905b5d1f8a8762f0c51a7f33c578).
- [Raydium AMM v4 at `c613c87`](https://github.com/raydium-io/raydium-amm/tree/c613c87c41edbe21112c9b8341774a70009c6d7b).
- [Meteora DLMM official IDL at `4eaaeaa`](https://github.com/MeteoraAg/dlmm-sdk/blob/4eaaeaa6b832999db0ec4044cffe620658b4c8d9/idls/dlmm.json).

## Bounded auxiliary instructions and native SOL

Only exact Compute Budget instructions, wallet-owned Associated Token Account
creation, a narrow set of parsed SPL Token/Token-2022 transfer/account
instructions, and wallet-to-wallet-owned-token-account System instructions are
allowed. A top-level bundled token transfer, System transfer to an unrelated
recipient, memo, tip, referral/fee helper, bridge, staking, lending, or unknown
program rejects the whole transaction.

Native SOL deltas are normalized using instruction evidence:

- the fee payer's network fee is removed;
- rent paid by the wallet for a proven wallet-owned token account is added back;
- rent refunded by a proven `closeAccount` to the wallet is subtracted; and
- System transfers are accepted only when they fund a proven wallet-owned token
  account, so an unrelated bundled transfer cannot inflate or deflate a fill.

Account creation and closure evidence must reconcile. Missing account keys,
balances, owners, parsed instruction fields, or rent evidence fails closed.

## Deliberately unsupported

The decoder still rejects PumpSwap/Pump.fun, Meteora DAMM v1/v2 and dynamic
bonding curve, Raydium Stable/Launchpad, Jupiter's WhirlpoolSwapV2 route variant,
all other Jupiter route-plan DEXes, arbitrary fee/tip programs, and any newly
introduced discriminator until its official layout and adversarial fixtures are
added. This is a coverage limitation, not a fallback to heuristic decoding.
