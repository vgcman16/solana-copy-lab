# Broker Connector Matrix

Status reviewed 2026-07-18 against official provider documentation.

| Connector | CopyLab state | Product wording |
| --- | --- | --- |
| Alpaca Paper | `CONNECTED_LOCAL_SIMULATION` | Authenticated official PAPER/data capability feeds CopyLab's isolated internal PAPER ledger. The UI labels this as data/provider access; no orders are sent to Alpaca. |
| Alpaca broker paper routing | `BROKER_PAPER_ROUTING_PENDING` | Official order API exists, but an idempotent order/reconciliation adapter has not been implemented. |
| Alpaca Live | `LOCKED_NOT_IMPLEMENTED` | Real-money order submission is physically absent and remains locked. |
| Schwab Trader API | `OFFICIAL_ACCESS_REQUIRED` | Requires an approved individual-developer app, brokerage account, callback URL, and delegated OAuth authorization. |
| Robinhood Agentic Trading | `NOT_CONNECTED_NOT_IMPLEMENTED` | CopyLab has no Robinhood connector or setup flow. Any separate official Robinhood service is outside this PAPER release, and CopyLab does not connect or route orders to it. |
| Robinhood Crypto | `NOT_CONFIGURED_LIVE_LOCKED` | A separate official US crypto API exists, but it is not a stock or PAPER connector and has not been implemented. |

## Official sources

- [Alpaca Paper Trading](https://docs.alpaca.markets/us/docs/paper-trading)
- [Alpaca Trading API](https://docs.alpaca.markets/us/docs/trading-api)
- [Alpaca Working with Orders](https://docs.alpaca.markets/us/docs/working-with-orders)
- [Schwab Trader API - Individual](https://developer.schwab.com/products/trader-api--individual)
- [Schwab individual developer role](https://developer.schwab.com/user-guides/individual-developer/about-individual-developer-role)
- [Schwab OAuth](https://developer.schwab.com/user-guides/get-started/authenticate-with-oauth)
- [Schwab create an app](https://developer.schwab.com/user-guides/apis-and-apps/create-an-app)
- [Schwab sandbox](https://developer.schwab.com/user-guides/apis-and-apps/test-in-sandbox)
- [Robinhood third-party connections](https://robinhood.com/us/en/support/articles/third-party-connections/)
- [Robinhood Agentic Trading overview](https://robinhood.com/us/en/support/articles/agentic-trading-overview/)
- [Robinhood Trading with your agent](https://robinhood.com/us/en/support/articles/trading-with-your-agent/)
- [Robinhood Crypto API](https://docs.robinhood.com/)

## Required before broker-hosted Alpaca PAPER mirroring

1. Fixed-origin order adapter for create, query, cancel, positions, account, and streaming order updates.
2. Deterministic `client_order_id` derived from pilot, signal, account, symbol, and action.
3. `SUBMITTED_UNRESOLVED` handling for ambiguous timeouts; query by client ID before any retry.
4. Partial-fill, cancel, reject, fee, lot-attribution, and reconnect-gap handling.
5. Startup reconciliation of cash, positions, and open orders; unrelated holdings are never touched.
6. Separate broker PAPER routing from the current internal simulator so one signal cannot fill twice.
7. Security tests for CSRF, host/origin, encrypted credential namespaces, redaction, idempotency, and reconciliation.

No paid subscription is required for the current internal Alpaca-backed PAPER phase.

Any future Robinhood integration would require a separate official onboarding flow and explicit
authorization. No such connector is implemented here, and external service availability does not
unlock live CopyLab trading.
