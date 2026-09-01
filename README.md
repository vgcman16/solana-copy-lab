# Solana Copy Lab

[![CI](https://github.com/vgcman16/solana-copy-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/vgcman16/solana-copy-lab/actions/workflows/ci.yml)

Solana Copy Lab is a local Windows dashboard for testing whether profitable public wallets can still be profitable after their trades are copied with a small bankroll. This run starts with a simulated $141 portfolio and cannot enter unattended live mode until the full paper and manual-live gates pass.

This is a controlled experiment, not a promise of income. It can lose money. Historical wallet profit does not guarantee future results, and the computer must remain awake and online while monitoring.

## Continuous integration and public-source boundary

Every push and pull request runs a clean Windows verification job that installs
the frozen dependency graph, typechecks all packages, executes the complete test
suite, and builds the production application. CI receives no trading keys,
wallet material, runtime databases, learning ledgers, logs, recovery files, or
local provider data. Those remain excluded by `.gitignore` and are never needed
by the test suite.

The repository is public so it can use GitHub's standard hosted CI runners. No
open-source license is granted by publication alone. Provider names and marks
remain the property of their respective owners and are used only to identify
interoperating services; their appearance does not imply endorsement.

## One-click setup

1. Install [Node.js 24 LTS or newer](https://nodejs.org/).
2. Double-click `Setup-CopyLab.cmd` once. It installs the locked dependencies, runs all tests, and builds the dashboard.
3. Double-click `Start-CopyLab.cmd`. The local dashboard opens at `http://127.0.0.1:4310`.
4. Obtain free API keys from [Birdeye](https://bds.birdeye.so/), [Helius](https://www.helius.dev/), and [Jupiter](https://portal.jup.ag/), then enter them in the setup wizard.
5. Initialize the fixed $141 paper portfolio. Do not add further funds during paper mode.

Use `Stop-CopyLab.cmd` to stop monitoring. Closing the browser alone does not stop the local service.

`Start-CopyLab.cmd` now launches a hidden same-user supervisor rather than a
detached Node process. The supervisor owns one exclusive lock, adopts an already
verified CopyLab child during an upgrade, probes only
`http://127.0.0.1:4310/api/setup/status`, and restarts failed/unhealthy children
with bounded exponential backoff. Five failures inside ten minutes are reported
as a crash loop and enter a fifteen-minute recovery cooldown instead of creating
a restart storm. Redacted JSON-line events are written to
`data\supervisor.log`; the current non-secret state is published atomically in
`data\supervisor.status.json`. `Stop-CopyLab.cmd` signals both the supervisor and
child, waits for a graceful SQLite/runtime shutdown, validates both PIDs before
any bounded force-stop fallback, and prevents the supervisor from restarting an
intentional stop.

To run that supervisor after sign-in, double-click
`Install-CopyLab-AutoStart.cmd`. The scheduled task runs hidden as the current
interactive user with limited privileges, has no execution-time cutoff, and
uses an ignore-new instance policy in addition to the supervisor lock. It does
not start the task during installation. `Remove-CopyLab-AutoStart.cmd` removes
future logon startup but leaves current monitoring running; invoke
`Remove-CopyLab-AutoStart.ps1 -StopRunning` when removal should also stop the
verified supervisor and child. Re-run the installer after this upgrade to
replace an older task action that points at `Start-CopyLab.ps1`.

`Test-CopyLab-Operations.ps1` parses every operations script, checks the
supervisor/maintenance/backup/isolation contracts, validates runtime
prerequisites, and builds both scheduled-task definitions through `-WhatIf`.
It does not change a process, database, or task. Add `-InspectInstalledTasks`
only after installation to confirm the live task actions match this version.

## Private remote viewing

Double-click `Enable-CopyLab-Remote.cmd` to make the running dashboard viewable
from your own Tailscale devices. CopyLab still binds only to
`127.0.0.1:4310`; Tailscale Serve exposes a separate tailnet-only address and
proxies it back to loopback. The exact generated `*.ts.net` origin is saved in
`data\remote-readonly-origin.txt`. Remote requests can read dashboards and live
events. Every remote mutation remains blocked except the exact Alpaca PAPER
credential form, which still requires the same-origin session, CSRF token,
`CONNECT ALPACA PAPER` confirmation, SETUP/PAPER mode, and successful validation
against fixed Alpaca paper-trading and free market-data endpoints. It cannot change
Solana credentials, modes, wallets, safety holds, approvals, or trading controls.
The private route is never configured as a public Tailscale Funnel.

On the phone or work device, install Tailscale, sign in with the same account,
turn it on, and open the URL printed by the enable helper. The home PC must stay
awake, online, signed into Tailscale, and running CopyLab. Double-click
`Disable-CopyLab-Remote.cmd` to remove the private route and restore the original
loopback-only policy.

Double-click `Backup-CopyLab.cmd` for an integrity-checked SQLite backup under
`Documents\CopyLab Backups`. If monitoring is running, the helper pauses it,
backs up both the main audit ledger and the separate learning ledger in one
quiescent window, writes a SHA-256 sidecar for each, publishes a manifest binding
the two files to one timestamp, and restarts PAPER monitoring without opening
another browser window. DPAPI-encrypted secrets in the main database remain tied
to the same Windows account. Local retention keeps four complete, manifest-bound
five-file generations by default, always including the pair just verified. Use
`Backup-CopyLab.ps1 -LocalRetentionCount N` to select 1-52 generations. Only
exact direct-child artifacts belonging to an expired complete pair can be
removed; partial, malformed, linked, unknown, and nested content remains for
inspection. `Documents\CopyLab Recovery` is never part of this cleanup.

With the supervisor running, backup uses an explicit maintenance handshake:
the backup owns `data\backup.lock`, creates
`data\supervisor.maintenance.request`, waits for the supervisor to publish
`MAINTENANCE` with no child PID, runs the existing verified paired-backup and
retention helpers, and removes only its own request. The still-running
supervisor then starts the child and proves loopback health. This prevents a
watchdog restart from racing the quiescent SQLite snapshot. If another backup or
maintenance owner is active, the new attempt fails closed.

For unattended local backups, double-click
`Install-CopyLab-BackupTask.cmd`. Its default is Saturday at 03:15 local time,
inside a same-day 00:00-06:00 market-quiet window. A missed `StartWhenAvailable`
launch outside that window is logged and skipped, not run during an active
session. The task runs only as the current interactive Windows user, so the PC
must be awake and that user signed in. It creates the same verified local pair;
it does not infer, discover, or automatically select a cloud/network/removable
destination. The scheduled local copy also retains four complete generations by
default; `Install-CopyLab-BackupTask.ps1 -LocalRetentionCount N` makes that
policy explicit without changing the separate off-device retention setting.

An off-device or cloud-synced secondary copy is opt-in only. Install from
PowerShell with an explicit operator-controlled path, for example:

```powershell
.\Install-CopyLab-BackupTask.ps1 -OffDeviceDestination "E:\CopyLab Backups" -OffDeviceRetentionCount 8
```

The operator is responsible for confirming that the path is actually off this
device and available to the same Windows user. Database files and sidecars are
copied through incomplete names, rehashed at the destination, and the pair
manifest is published last. Secondary retention removes only complete,
recognized, manifest-bound pairs beyond the configured count; malformed,
partial, nested, linked, and unknown content is left for inspection. Use
`Remove-CopyLab-BackupTask.cmd` to remove the weekly task.

Run `Test-CopyLab-RestoreDrill.cmd` after a fresh backup (or pass an explicit
`-BackupPath`/`-BackupDirectory` to the PowerShell script). It verifies the pair,
restores both ledgers under a unique `CopyLab-RestoreDrills` directory in the
Windows temporary folder, reopens each restored ledger through the existing
SQLite verification helper, and removes the temporary drill by default. It
explicitly rejects both production database paths and never stops monitoring or
overwrites `data\copylab.db`/`data\learning.db`. `-KeepArtifacts` is available
only for deliberate forensic inspection; ensure enough temporary disk space for
the multi-gigabyte production ledger. Add `-RunRestoreDrill` to the backup-task
installer only when every weekly backup should incur that extra time and disk
I/O.

Double-click `Restore-CopyLab.cmd` only for disaster recovery. Select the main
database from a complete timestamped pair. The helper requires the exact phrase
`RESTORE COPYLAB DATABASES`, verifies both SHA-256 sidecars and their pair
manifest, stops the service, creates fresh pre-restore copies, and restores both
`data\copylab.db` and `data\learning.db`. Each replacement is staged and checked;
if the second ledger fails, the first is rolled back. Restore validation rejects
newer application schemas, compares the complete current table/column/index/
trigger shape, and runs SQLite integrity and foreign-key checks. Legacy main-ledger
restore is intentionally fail-closed: schema
18 is the oldest accepted backup manifest, and every data-bearing table required
by that version must exist before migration so missing ledgers cannot be silently
recreated as empty. A persisted live mode is forced to `PAUSED` after
every restart and must pass the complete live preflight before an explicit
resume.

To create the dedicated bot wallet early, double-click `Create-CopyLab-Wallet.cmd`. Enter the recovery passphrase only in the local PowerShell window, secure the encrypted JSON it saves under `Documents\CopyLab Recovery`, and type `SAVED` only after making a second safe copy. Creating or funding the wallet does not bypass the paper or manual-live gates.

If the database is lost but that encrypted recovery JSON remains safe, use the
dashboard's **Restore encrypted backup** control. Recovery is allowed only in
SETUP/PAPER, requires its passphrase plus `RESTORE COPYLAB WALLET`, and never
overwrites an existing dedicated wallet.

## Wallet intelligence pipeline

The local index starts with 5,000 distinct wallets before spending scarce provider depth on a shortlist:

1. Recent discovery scans confirmed Jupiter program activity, accepts only attributable SOL/USDC spot swaps, and globally deduplicates signatures.
2. The coarse 90-day screen proves wallet age, at least 50 successful transactions, and activity in three of the latest four weeks.
3. Deep local history reconstructs eligible swaps, closed exits, holding times, and activity from the normalized SQLite ledger.
4. Provider depth adds Birdeye realized PnL and Helius history/identity evidence only for stronger candidates. The unchanged qualification policy still decides whether a wallet enters paper evaluation.

Every stage is resumable through SQLite checkpoints, leases, retries, and a durable signature queue. Pre-screen evidence and its aggregate commit atomically. Deep-history targets are frozen in versioned generations with cohort-specific signature manifests, per-wallet checkpoints, immutable record/swap digests, and a 100-page safety ceiling. In MANAGED mode, a below-15-minute frozen coarse holding-time snapshot creates an insert-only `COARSE_COPYABILITY_SKIP`: it only defers expensive work, creates no exact evidence or rejection, and can terminate a batch only as `MANAGED_SCREENED`, never local `COMPLETE`. Newly exact structural survivors are handed to authoritative Birdeye/Helius scoring in digest-keyed batches of 1–5; qualified results accumulate until exactly three can be frozen, then further paid depth pauses automatically. A wallet can be evaluated again in a later generation but cannot appear twice in the same generation; local self-hosted discovery still uses only the newest durably COMPLETE generation and never borrows a managed-screened, stale, or partially processed batch. SOL-legged swaps use a strictly at-or-before local SOL/USD mark. Missing marks stay in a resumable reprice queue and block every local ranking generation that owns them rather than being estimated. Automated retries and provider-readiness counts are scoped to the supported 90-day Pyth horizon plus tolerance; older pending rows remain unpriced and visible for audit without permanently blocking that horizon. Retryable provider outages use a bounded multi-day retry window; malformed or unsafe data still fails closed after five attempts. Default monthly ceilings reserve 250,000 Helius credits for indexing and cap combined Helius use at 750,000 credits; the crawler pauses before exceeding either ceiling. Index-run progress labels local survivors as structural candidates; only the separate provider score can call a wallet qualified. The rolling confirmed program head is maintained even during long frozen-history work, and the safety hold clears only after every head gap is continuous and every head transaction is hydrated. The dashboard shows the two research funnels separately and browses the local universe in bounded pages instead of placing thousands of wallets in every dashboard refresh.

Birdeye usage is reserved durably before every physical request, including retries and failed attempts. The dashboard reports both request count and compute-unit consumption, and the worker stops before the configured monthly guard instead of assuming that only successful responses consume quota.

The intended scale is designed for the providers' free tiers, so no upgrade is required. Free-tier throttles or unavailable depth endpoints can make research slower; the system backs off or pauses instead of weakening qualification rules. Keep the PC awake, online, and the local service running for discovery and monitoring to continue.

## Self-hosted data path

The dashboard now supports three encrypted, typed-confirmation data modes:

- `MANAGED` keeps Birdeye and Helius active.
- `SHADOW` keeps managed results primary while the same work is independently replayed through an operator-supplied standard Solana HTTP/WSS node and the local SQLite PnL engine. Every provider profile drains activity-proven history in bounded, crash-safe cohorts; self-hosted RPC work does not apply Helius credit ceilings.
- `SELF_HOSTED` disables Birdeye/Helius runtime reads only after the exact shadow-tested endpoints pass every RPC/WSS capability check, retain 90 days of full block history, accumulate continuous local SOL/USD prices, and complete seven gap-free days of matching evidence. Changing either endpoint resets that evidence.

Provider changes are allowed only in `SETUP` or `PAPER` with zero open bot-created positions. They never enable live mode or bypass wallet, paper, manual-live, risk, signing, or reconciliation gates. Full endpoint URLs stay in Windows DPAPI; the API/dashboard expose origins and redacted diagnostics only.

Credential and endpoint changes use a bounded quiesce-and-generation fence. Old discovery, history, stream, and research work must drain or lose commit authority before the encrypted vault changes. A successful change starts only the newly selected provider composition; a failed change restores and resumes the previous composition, while an unsafe rollback stays quiesced and records a critical audit event.

Shadow promotion evidence is bound to one schema-20 proof epoch: the exact endpoint fingerprint, immutable 90-day cutoff, five winner/control subjects, comparison inputs, and results all have deterministic SHA-256 bindings. An explicit CSRF-protected capture freezes that manifest before any acquisition and records the paired completion timestamps and skew. The local side is pinned to one immutable COMPLETE generation; empty gap results, legacy rows, mixed windows, and rolling evidence never count. Observation/acquisition writes and final epoch/run activation are atomic, and an interrupted exact PREPARED/CAPTURING run resumes without reacquiring completed comparisons. The current managed Birdeye/Helius interfaces cannot request every historical `asOf` boundary, so production capture reports machine-readable managed `*_AS_OF_UNSUPPORTED` blockers and remains fail-closed until those two point-in-time adapters exist.

The server includes an optional, explicitly started Pyth Benchmarks bootstrap for the stable SOL/USD feed. It freezes a 90-day ten-minute grid (12,961 points), advances an atomic SQLite cursor at no more than one request per second, and never overwrites an existing Jupiter timestamp. The dashboard exposes typed-confirmation controls to save or replace a Pyth bearer key, start or resume the worker, and pause it safely; the key is validated, stored with Windows DPAPI, never returned, and changing it never auto-resumes a download. The worker is deliberately not started at boot. Even after bootstrap, ongoing Jupiter captures and every other self-hosted promotion gate remain required. `PYTH_API_KEY` remains an optional environment fallback, while dashboard setup is the normal path; Pyth documents Benchmarks authentication as mandatory after July 31, 2026. [Pyth historical-price API](https://docs.pyth.network/price-feeds/core/use-historical-price-data)

A production mainnet RPC node does **not** fit on this PC. Run `Test-SelfHosted-Rpc-Host.ps1` for the local evidence report. Ubuntu/Agave operator templates are under `infra\solana-rpc\`; they require a separate production-class host and a private network path to CopyLab.

Indexed or recovered history is research-only. It cannot sign, create a copy order, or trigger a trade.

Every observed source action receives a durable, idempotent scalar outcome such as analysis-only, blocked, rejected, simulated, awaiting approval, submitted, unresolved, confirmed, or failed. The dashboard exposes the reason and separate leader/bot explorer links without returning provider payloads, unsigned or signed transactions, credentials, or private wallet material.

## How capital grows

Strict PAPER and live sizing compound conservatively. Each strict entry is 10% of current executable NAV: $141 starts at $14.10, $200 uses $20, and $250 reaches the $25 ceiling. A single strict entry is capped at $25, at most three positions may be open, and no more than 30% of NAV may be deployed. The system keeps at least $5 of SOL and $10 of total liquid SOL/USDC uncommitted.

The isolated `high-risk-paper-v2` comparison targets 20% of each independent wallet's current NAV, capped at $25, for future simulated entries. On a $141 paper book that is a $25 target; it scales down below $125 NAV. Its existing positions are never resized, its total deployed cost including modeled entry fees remains capped at 30%, and it still keeps at least $10 liquid. This larger sizing never reaches strict PAPER, promotion evidence, approvals, signing, or live execution.

## Autonomous learning and Replay Lab

The isolated autonomous high-risk bot uses deterministic adaptive sizing from
current executable NAV, current market/quote evidence, drawdown, exposure, and
its own completed PAPER trades. Version 8 adds a controlled exploration arm for
static-safe tokens that narrowly miss only one or two organic-flow thresholds.
It never waives missing evidence, mint/freeze authority, suspicious-token,
liquidity-drain, vertical-pump, SOL-regime, quote-cost, reserve, deployment, or
drawdown gates. Exploration and normal momentum outcomes train separate reward
contexts, so an exploratory win or loss cannot silently resize the normal arm.

Version 10 adds six causal strategy arms, a SOL-and-market-breadth regime model,
and a separate `learning.db`. Version 11 separates research eligibility from
champion-capital eligibility: controlled exploration remains trainable while it
is forbidden from spending champion NAV. Each scan may open at most twelve new
quote-only shadow episodes, no more than 120 may be active, and research consumes at most 40%
of its bounded provider-work lane. Executable full-position quotes create 15,
45, and 180-minute labels. Unpriced, unsafe, and hindsight replay paths cannot
train the champion.

Version 12 starts a clean, policy-isolated evidence cohort while keeping all V11
history visible and immutable. It records executable exit marks every five
minutes, benchmarks each result against SOL, trains four model families on a
purged training set, and reports calibration only from a mint-separated held-out
set. Transient quote failures receive three bounded retries; structural safety
failures remain immediate rejections. Hard-safe opportunities that match no
entry arm are sampled as negative controls and can never receive champion
capital. Challenger selection uses development data only, while its displayed
performance comes from untouched holdout paths. A V12 arm/regime stays
research-only until its 45m and 180m
lower confidence returns, path/mint/day breadth, profit factor, cost stress, and
four independently validated models all pass. Event training runs after ten new 45m labels
or five new 180m labels, with a thirty-minute debounce and nightly fallback.

The V12 PAPER bankroll retains V11's high-risk capital envelope after evidence admission: ordinary entries risk 3% of current
NAV at the frozen 10% stop, model-confirmed entries may risk 4%, and controlled
exploration risks 2%. Each position remains capped at 40% of NAV, with at most
four open positions, 90% deployed, a $10 liquid reserve, and a 45% developer/
launchpad-cluster ceiling. A 12% UTC-day loss pauses entries and a 25% peak
drawdown locks the lane. These percentages compound with NAV; there is no flat
$50 position ceiling.

Each actual v8 PAPER position starts one causal Replay Lab path. The ledger
keeps the exact entry, every full-position executable sell mark, the actual
exit, and post-exit follow-through for three hours. A quote outage is stored as
`UNPRICED`; no price is invented. After the path completes, exactly 1,000 frozen
exit-policy variants are evaluated against that same evidence, including weak-
momentum and no-progress timing that the original grid held fixed. These are 1,000
correlated what-if calculations over one independent trade, not 1,000 trades.
The hindsight-best result is visibly labeled research-only, has zero calibration
weight, and cannot alter NAV, sizing, policy, promotion, signing, or execution.
It answers “which tested exit would have worked better on this path?” without
claiming that the answer was knowable in advance or guaranteed to work again.

## Isolated stock PAPER and 24/5 data

The US-stock lane has its own $141 ledger, positions, P&L, strategy-arm
statistics, adaptive sizing, and 1,000-variant exit replay. It never shares
capital or learning evidence with the crypto lanes. The Alpaca integration is
market-data-only: CopyLab has no broker order-submission path and every order in
the stock ledger is explicitly a local PAPER intent.

The engine scans each active Alpaca session. Regular, premarket, and after-hours
cycles use the free IEX feed. From 8:00 PM to 4:00 AM Eastern on eligible
weeknights it switches to the free `overnight` snapshot feed and uses delayed
`boats` history only as labeled background context. Overnight symbols must be
reported as overnight-tradable and not halted. Every entry still requires a
current indicative quote and causal minute bar. The free derived overnight bars
are normally about 15 minutes behind, so that feed has an explicit 20-minute
freshness ceiling and 25-minute PAPER limit-confirmation window; IEX retains its
four-minute bar ceiling. A delayed bar can inform a decision only after it is
received, and a fill still requires a strictly later completed bar. Extended-session entries additionally require high
conviction and a spread no wider than 0.60%, use at most two positions, receive
a 45% size reduction, and include a conservative modeled-fill penalty. Missing
or stale extended-hours data produces no simulated trade.

Stock PAPER v3 keeps those simulated intents across restarts and resolves them
only from later complete minute bars. Its fill model includes limit confirmation,
partial fills capped by bar participation, expiry, spread/impact costs, and
conservative stop/target collision and gap-through handling. The dashboard shows
the resulting order ledger, quote/bar ages, coverage, pending orders, feed
readiness, rate-budget pressure, calendar verification, corporate-action blocks,
and WebSocket health. A 30-symbol hotlist uses Alpaca's IEX or overnight
market-data stream while REST snapshots remain the reconciliation source.

Every ranked opportunity is also written as an immutable v3 observation,
including rejects and no-trades. Strict 15/45/180-minute outcomes record missing
data instead of inventing a price. Four frozen shadow policies are compared with
modeled costs, and their results are analysis-only: they cannot promote a policy,
change sizing, or place a PAPER or broker order.

Outcome-quality reporting is separated into regular, premarket, after-hours, and
overnight sessions so sparse derived overnight history cannot obscure IEX
regular-session coverage. Learning v4 also distinguishes expected legacy trades
from completed trades opened after the durable v41 event ledger began; only the
latter trigger an evidence-health alert when excluded. Missing outcomes remain
immutable. Retrospective relabeling is deferred until a versioned repair ledger is
designed, and regime/correlation analysis remains deferred until adjusted,
aligned full-session daily-return evidence exists. Neither gap is filled with
synthetic or subsequently observed prices.

## Promotion gates

- `PAPER`: its clock stays at zero until exactly three research-qualified wallets are frozen into a forward cohort. It then requires 30 consecutive observed days with durable runtime heartbeats, 50 completed exits, positive cost-adjusted return, profit factor at least 1.2, executable-NAV drawdown no more than 10% (including marked open exposure), three profitable weeks, diversified profits, two independently qualifying wallets, and a non-negative doubled-cost/five-second-delay replay. Downtime gaps, stale marks, unpriced exposure, or a different cohort fail closed.
- `MANUAL_LIVE`: requires an explicitly created dedicated bot wallet, encrypted recovery download, confirmed backup, and at least $6 of SOL plus 135 USDC in that wallet. Five dollars remains the protected SOL reserve and the extra dollar is the fee buffer. Twenty live orders must be manually approved and five positions completed.
- `AUTO_LIVE`: requires explicit confirmation, zero policy violations, and live execution shortfall no worse than the paper run's 95th percentile.

Wallet rotation is never automatic. Newly qualified wallets enter a shadow signal-capture queue and cannot affect live trades. They may only be considered in a later, explicitly started paper cohort that must pass the same promotion gates.

## Safety boundary

- Never enter a primary-wallet seed. The application only creates a new dedicated keypair.
- Provider credentials and the bot key are encrypted with Windows DPAPI for the current Windows account.
- Recovery data is encrypted with the passphrase you choose and downloaded by the browser. Losing both the passphrase and backup can make funds unrecoverable.
- The API binds only to `127.0.0.1`, rejects unconfigured Host/Origin values, uses an HttpOnly local session cookie, and requires CSRF tokens for mutations. Optional remote viewing accepts one exact tailnet-only `*.ts.net` origin through a loopback proxy and rejects every remote mutation except the isolated Alpaca PAPER credential route described above.
- Live v1 accepts only standard SPL assets and single-step, explicitly allowlisted Iris/Jupiter ExactIn route families. It resolves address lookup tables and verifies the only signer, wallet ATAs, mints, recipient, exact input, quoted/minimum output, slippage, zero platform/positive-slippage fees, executable route programs, compute-budget fees, rent cap, and every top-level program before signing. Anything unknown fails closed. Both live promotions require the exact typed confirmation phrase in the protected API request, and every live resume repeats provider, wallet-backup, promotion, unresolved-submission, balance, and operational-stop preflight checks.
- Confirmed fills have an idempotent application ledger and are replayed after a crash. Startup reconciles recorded lots against the dedicated wallet; unrelated excess deposits are left untouched, while shortages or unresolved submissions pause signing.
- A 5% daily loss pauses new entries. A 10% loss from live-start NAV or 10% peak-to-trough drawdown durably locks live mode before liquidation I/O, cancels approvals, and attempts to liquidate bot-created lots to USDC. The live-start limit is calculated from the recorded live-start NAV ($14.10 at $141), not a fixed dollar amount. Each emergency lot has a stable operation id; an ambiguous broadcast is reconciled by its deterministic Solana signature and is never blindly resubmitted.
- New-entry safety holds persist their exact reasons in the dashboard. Transient provider holds clear only after a healthy recheck, daily-loss holds last through the UTC day, and balance/manual-review holds require an explicit CSRF-protected safety recheck.

## Local data

SQLite data and logs are under `data\` and are excluded from Git. Important files are:

- `data\copylab.db` — audit ledger, resumable wallet index, deduplicated signatures, normalized swaps, cohorts, signals, quotes, fills, positions, NAV, and gates.
- `data\learning.db` — isolated executable shadow episodes, causal labels, deterministic model artifacts, arm/regime scores, challengers, and promotion evidence.
- `data\server-out.log` and `data\server-error.log` — local service logs.
- `data\server.pid` — used by the safe start/stop launchers.
- `data\remote-readonly-origin.txt` — optional exact Tailscale Serve origin; it contains no credential and is removed when remote viewing is disabled.

Back up the recovery JSON separately. Do not copy DPAPI-encrypted database secrets to another Windows account and assume they can be decrypted there.

## Developer commands

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`pnpm check` runs TypeScript checks, all unit/integration/security tests, and production builds. Development mode serves the API on port 4310 and Vite on port 4173.
