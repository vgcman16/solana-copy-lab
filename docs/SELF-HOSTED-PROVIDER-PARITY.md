# Self-hosted provider parity

## Horizon

CopyLab will be able to replace every Birdeye and Helius capability it consumes at runtime. This does not attempt to clone unrelated commercial products. Jupiter remains the token-risk, quote, and execution provider in this horizon.

Managed providers remain available only as explicit, fail-closed fallbacks until shadow replay proves parity. No provider switch may enable live signing or bypass the existing PAPER and promotion gates.

## Source contracts

| Capability | Current source | Self-hosted owner | Required proof | Status |
| --- | --- | --- | --- | --- |
| Weekly winner and loser discovery | Birdeye `gainers-losers` | SQLite wallet/swap ledger | Deterministic 30d/90d rankings with stable ties, newest-COMPLETE generation selection, immutable wallet/swap digests, exact shared ranks, and preserved loser controls | Implemented; point-in-time managed adapter blocked |
| Aggregate 30d/90d realized PnL | Birdeye wallet PnL summary | Local FIFO lot accounting | Recorded-wallet fixture parity, strictly at-or-before SOL marks, and incomplete pricing fails closed | Implemented; real 90-day price coverage pending |
| Wallet 90-day history summary | Helius RPC/history | Standard Solana RPC plus local swap decoder | History days, exits, active weeks, hold time, and concentration replay parity | Implemented; shadow proof pending |
| Confirmed live observation | Helius WebSocket | Standard Solana `logsSubscribe` at `confirmed` | Reconnect, duplicate, and multi-address fixture tests | Implemented; seven-day shadow proof pending |
| Full transaction fetch and decode | Helius RPC | Standard Solana `getTransaction` | Existing swap/transfer/LP/failed fixtures decode identically | Implemented and fixture-tested |
| Gap repair | Helius history | Standard Solana `getSignaturesForAddress` plus `getTransaction` | Bounded since-time repair, dedupe, recovered events remain analysis-only | Implemented and fixture-tested |
| Program-wide wallet indexing | Helius RPC | Standard Solana RPC/archive node | Crash-safe checkpoints, pagination, hydration, monthly-provider independence | Implemented; node/load proof pending |
| SOL and SPL balance reads | Helius RPC | Standard Solana `getBalance` and `getTokenAccountsByOwner` | Reconciliation fixtures and fail-closed mismatch behavior | Implemented and fixture-tested |
| Provider health and usage | Birdeye/Helius diagnostics | Local RPC/index/database diagnostics | Freshness, slot lag, archive depth, WSS state, queue lag, disk usage, and errors | Local and operator telemetry implemented; production-host proof pending |
| Provider selection and fallback | Hard-coded managed providers | Encrypted provider profile | `MANAGED`, `SHADOW`, and `SELF_HOSTED` transitions with typed confirmation | Implemented; independent SELF-only PAPER soak proof pending |
| Local-node deployment | External managed infrastructure | Solana validator/RPC profile and operator checks | Documented hardware/storage, catch-up, retention, backup, and upgrade drills | Artifacts implemented; production host unavailable |

## Production invariants

- Bind the dashboard and local provider APIs only to loopback by default.
- Treat RPC URLs as secrets because they may contain credentials; store them with Windows DPAPI.
- Never accept the primary-wallet seed and never reuse the bot signer as a validator identity.
- Use `confirmed` observation, then fetch the full transaction and run the existing decoder and risk policy.
- Deduplicate every source signature and preserve the existing 20-second recovered-event rule.
- Freeze every completed generation's wallet records and ordered swap inputs behind SHA-256 digests so later aggregate/index changes cannot recalculate an historical ranking. A wallet may be targeted again in a later immutable generation, but never twice inside one generation.
- Price SOL-legged swaps only from a local at-or-before SOL/USD point within the configured tolerance. Missing marks remain in a resumable reprice ledger and block any generation that owns them. Readiness and worker retries cover the supported 90-day Pyth horizon plus tolerance; older pending rows remain unpriced and visible for audit without permanently blocking that supported horizon.
- Promotion parity observations must belong to one persisted ACTIVE proof epoch whose endpoint fingerprint, cutoff, 90-day window, stratified subject manifest, input digest, and result digest all verify. Legacy, rolling, unbound, or mixed-epoch rows remain audit-only.
- Empty gap-repair arrays are never positive replay evidence. Every frozen gap comparison retains an explicit since/cutoff and the same non-empty signature set on both paths.
- Mark any wallet/window with incomplete history, missing decimals, or missing executable pricing as ineligible.
- Local wallet PnL currently excludes network fees, rent, priority fees, and protocol fees. The transaction index does not yet prove an unambiguous per-swap allocation for those costs, so they are disclosed rather than estimated; no Birdeye cost-equivalence claim is made.
- Keep managed fallback read-only in PAPER during shadow comparison. Fallback cannot silently resume live signing.
- A provider-profile change pauses new entries, clears cached quotes, reconnects observation, and requires balance reconciliation.
- Provider-profile and credential changes quiesce the old provider composition behind a generation fence before vault mutation. Timers and in-flight discovery, history, index, stream, and research callbacks from the old generation cannot commit after a successful switch. Failure restores and resumes the previous composition or stays critically quiesced if rollback cannot be proven.
- Reserve managed-provider quota before each physical request. Birdeye compute-unit accounting includes retries and failures, and Helius usage remains separated from standard-RPC usage.
- Persist one scalar, idempotent signal outcome for each terminal source-action branch. Operator views may expose public leader and bot transaction links, but never serialized provider responses, transaction bytes, credentials, or signing material.
- Existing token, quote, reserve, drawdown, promotion, signing, and emergency-exit policies are unchanged.

## Rollout gates

1. **Local unit parity:** all recorded provider fixtures pass through the self-hosted implementations.
2. **Historical replay parity:** source signatures, eligible swaps, wallet summaries, and rankings agree on a frozen window. Differences are explained and persisted.
3. **Shadow parity:** managed and self-hosted paths run concurrently in PAPER for at least seven consecutive days with no unexplained missed confirmed swap, duplicate, or unsafe classification.
4. **Failure drills:** restart, RPC outage, WSS reconnect, stale node, pruned history, disk pressure, malformed response, and database crash recovery all fail closed.
5. **Load proof:** the configured node and indexer sustain head traffic plus backfill without stale monitoring or exhausting disk/queue limits.
6. **Self-hosted PAPER:** managed reads are disabled; the exact HTTP/WSS endpoint pair must persist at least seven continuous healthy PAPER days with gaps no longer than fifteen minutes and a heartbeat no older than ten minutes. Local discovery, full RPC/WSS diagnostics, index-head checkpoints, and SOL/USD coverage must all stay healthy; an unhealthy interval or profile change resets the durable epoch.
7. **Live eligibility:** requires the existing paper/manual gates plus an explicit provider-mode confirmation. Provider parity alone never unlocks live mode.

## Unresolved seam queue

1. Implement the two managed point-in-time adapters required by the schema-20 baseline coordinator: Birdeye discovery plus PnL over a closed historical interval, and Helius history plus gap repair with an enforced upper cutoff. The local side is already pinned to one immutable COMPLETE generation and its verified wallet/swap digests. The CSRF-protected operator capture freezes the endpoint fingerprint, generation cutoff, and five stratified subjects first; records paired acquisition timestamps/skew and SHA-256 input/result bindings; and activates only after all 21 comparisons pass with non-empty gap signatures. Current managed interfaces expose rolling reads, so production capture persists exact managed `*_AS_OF_UNSUPPORTED` blocker codes and remains PREPARED instead of mislabeling them as frozen.
2. Save the optional Pyth bearer key through the DPAPI-backed dashboard control, explicitly start the resumable SOL/USD bootstrap, and complete its 90-day ten-minute grid. The worker remains dormant until that typed operator authorization.
3. Run the exact endpoint pair in `SHADOW` for seven continuous days after the frozen baseline is sealed, and resolve every history, PnL, gap, and live divergence.
4. After SHADOW promotion, run the independent seven-day `SELF_HOSTED` PAPER soak; the dashboard and live preflight now enforce it, but real endpoint evidence does not exist yet.
5. Prove operator disk/retention warning behavior before ledger pruning or disk exhaustion.
6. Execute restart, outage, stale-node, pruned-history, database-recovery, and sustained-load drills on the production-class node.
7. Provision the dedicated Ubuntu RPC host; the current 16 GB Windows PC fails the documented mainnet hardware gate.
