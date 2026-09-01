# CopyLab Pilot Marketplace

## Product outcome

CopyLab adds an operator-controlled catalog for comparing implemented PAPER pilots and proposed research models. The first release can allocate isolated virtual capital to the two enrollable pilots, track enrollments, pause/resume/switch them, preview dollar-allocation changes, and record marketplace actions without enabling real brokerage orders.

## Screenshot-derived capability map

| Reference capability | CopyLab implementation |
| --- | --- |
| Curated strategy marketplace | Searchable and filterable Pilot catalog with categories, risk, asset class, availability, evidence, and methodology |
| Expert portfolios | Locally evidence-backed wallet cohorts; no unsupported claim that a person is a professional adviser |
| AI portfolios | Existing autonomous crypto and stock-learning engines |
| Thematic portfolios | Proposed research model, explicitly unavailable for enrollment until an execution model exists |
| Hedge-fund trackers | 13F disclosure research pilot, clearly marked as filing-delayed rather than real-time |
| Politician trackers | Public-disclosure research pilot, clearly marked as disclosure-delayed rather than real-time |
| Transparent performance | Runtime-captured returns, P&L, drawdown, sample size, capture timestamps, pricing completeness, recorded history, and evidence warnings |
| Mix and match | Multiple isolated PAPER enrollments with dollar allocations or an explicit percentage-of-reference-NAV allocation |
| Pause, switch, rebalance | CSRF-protected local controls with preview-before-apply, current-NAV transfer on switch, and append-only decision records |
| Provider and routing status | CopyLab's isolated PAPER ledger is active, Alpaca can supply stock data when separately configured and healthy, and no marketplace order is routed to an external broker |
| Automatic trade mirroring | Only committed strict-wallet and stock-momentum PAPER ledger fills are eligible; proportional exits, marks, and crash recovery are handled internally while every broker/live route remains locked |

## Non-negotiable truth and safety rules

- CopyLab is not an investment adviser, broker-dealer, custodian, fiduciary, or SEC-registered adviser.
- The UI never promises profit or describes historical returns as predictive.
- PAPER results are labeled simulated and separated from live balances.
- 13F and politician disclosures are labeled delayed; they are not described as real-time insider signals.
- Robinhood, Schwab, or any other broker is never connected through password/session scraping or an unofficial API.
- Robinhood is shown as not connected and unavailable in CopyLab; no Robinhood setup or routing flow is implemented.
- Marketplace controls never bypass the existing CopyLab risk, mode, signer, provider-health, or operational-hold gates.
- The remote Tailscale dashboard stays read-only. Marketplace mutations require the loopback session and CSRF token.
- Automatic pilots in this release are **Strict Wallet Copy** and **US Stock Momentum**. High-risk wallet, autonomous crypto, thematic, 13F, and public-official pilots remain view-only research.
- Research-only pilots report `paperAvailable: false`; a catalog card never implies that an unimplemented research source is enrollable.
- Mirroring reads committed SQLite source evidence only. Transient dashboard events cannot create a fill, and the internal fill/mark functions are not exposed over HTTP.
- Performance snapshots are captured by the runtime after committed source updates and at startup. Marketplace GET requests are read-only and do not create evidence.
- A zero-exposure switch transfers the source account's executable NAV/cash into a fresh target performance baseline. The source enrollment retains its realized history, so gains or losses are neither discarded nor attributed to the new pilot.

## Primary journey

1. Open **Pilot Marketplace** from the command center.
2. Filter by asset class, strategy category, risk, and availability.
3. Open a pilot to inspect methodology, recorded evidence, performance, allocation limits, and disclosures.
4. Choose a PAPER allocation and confirm enrollment.
5. Monitor each isolated enrollment under **My Pilots**.
6. Inspect the enrollment's committed positions, fills, and latest audit events.
7. Pause/resume, switch, preview and apply a dollar rebalance, or unenroll after exposure reaches zero.
8. Review every change in the local audit ledger.

## Release boundary

This build delivers a local PAPER marketplace interface and control paths for Strict Wallet Copy and US Stock Momentum. The remaining catalog entries are research-only concepts or views and are not enrollable marketplace engines. Live brokerage execution is intentionally not part of the release boundary. A future live connector must use an official broker API, encrypted credentials/OAuth, decoded and bounded orders, idempotency, reconciliation, explicit user authorization, and the existing live-promotion gates.
