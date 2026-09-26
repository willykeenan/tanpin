# Changelog

All notable changes to Tanpin are documented here.

## [Unreleased]

### Security
- A reverse proxy on the same host no longer makes every client "local": the key-free path now requires a loopback peer, a loopback `Host` and no forwarding headers.
- Cross-origin browser requests need a key for reads too (including `TANPIN_CORS_ORIGINS` origins).
- Secrets are write-only: webhook signing secrets and `settings.integrations` credentials are masked in every read.
- Dashboard: escaped the hypothesis category and webhook delivery error (stored XSS); every response now carries a CSP without inline script.
- Webhook SSRF guard moved into the engine (applies to the standalone daemon and `DEMO_MODE` there too), resolves once through a validating `lookup` (no DNS-rebinding window), and blocks CGNAT, IETF, benchmark, documentation, NAT64, 6to4 and Teredo ranges.
- `tools/check.js` removed from the public tree.

### Fixed
- `tanpin daemon` and `tanpin seed` now run when started through the CLI; the standalone daemon uses `TANPIN_DATA_DIR` / `TANPIN_DB` like `serve`.
- Stock changes are deltas applied inside the SQLite write transaction, so the server and a standalone daemon cannot overwrite each other's stock; PO receive/cancel/send re-check the current status. Rows another process adds to newest-first logs sort to the front.
- Saves write only changed rows (a sale on 100k movements: ~0.5 s → ~25 ms); bulk sales are one transaction; the backtest runs on a worker thread and reuses per-SKU day totals (27 s → ~2.6 s for 300 SKUs / 100k movements).
- `settings.timezone` now drives forecasts, PO ETAs (API and daemon), supplier email times and CSV dates.
- Forecast series start at the SKU's first sale / creation and exclude today's partial day; the backtest scores completed days only.
- Reorder point = lead-time forecast + safety stock, so hypotheses, weekday and trend move the trigger; hypotheses recompute forecasts immediately.
- Stripe and Square webhooks fetch line items from the provider API when the payload has none (`STRIPE_API_KEY`, `SQUARE_ACCESS_TOKEN`); an event that records nothing is not consumed and can be replayed.
- Docker / Space: demo writes work from non-local clients, `SPACE_HOST` is trusted, and the dashboard asks for an API key instead of redirecting to a missing login page.

## 0.1.0 — 2026-09-25

Initial public release.

### Added

- Per-SKU demand forecast: recency-weighted moving average, weekday seasonality, short-term trend, compounding demand hypotheses
- Reorder math: safety stock at a configurable service level, reorder point, EOQ, pack-size rounding, MOQ, JIT cap (`maxDaysOfSupply`)
- ABC classification by revenue contribution and dead/slow-stock delist flags
- Auto-management daemon (in-process with `tanpin serve`, or standalone `tanpin daemon`): forecast → reorder → draft POs → optional email → optional auto-receive
- Supplier model with lead time, delivery windows, order cut-off hour, and minimum order value
- Delivery ETAs (UTC) snapped to the next delivery window
- REST API with SKU addressing, `/api` and `/api/v1` aliases, OpenAPI 3.1 at `/openapi.json`, agent guides at `/llms.txt` and `/llms-full.txt`
- Dashboard (vanilla JS) for products, purchase orders, suppliers, forecast/hypotheses, activity, API keys/webhooks, settings
- MCP server (`tanpin mcp`) — JSON-RPC 2.0 over stdio, tools for overview, catalog, sales, reorder, POs, suppliers, hypotheses, cycles, movements
- HMAC-signed outbound webhooks
- CSV product import/export and movement export
- API keys stored as SHA-256 hashes; loopback open by default; `TANPIN_REQUIRE_API_KEY` and `TANPIN_ADMIN_KEY`
- `Idempotency-Key` replay (24h) on sales and purchase-order POSTs
- SMTP implicit TLS (port 465) with local `.eml` outbox fallback
- JSON document store with atomic writes; `TANPIN_PLUGIN` hook for extra routes and usage limits
- CLI: `tanpin serve | daemon | mcp` (`tanpin seed` is reserved; demo data loads via `POST /api/seed` or the dashboard)
- Hugging Face Docker Space files under `space/`
- Examples: end-of-day POS sync, agent reorder routine, webhook receiver
