# AGENTS.md — Tanpin

Instructions for AI agents working **with** this system (integrating, operating a store) or **on** it (developing). Tanpin is open-source item-by-item inventory built on the tanpin kanri (単品管理) method popularized by Japanese convenience retail.

## Operating the inventory (most common)

You have three equivalent ways in, pick whichever your harness supports:

1. **MCP (best):** run `node src/mcp.js` as an MCP server. Env: `INVENTORY_URL` (default `http://localhost:4173`), `INVENTORY_API_KEY` if required. Call `get_overview` first.
2. **HTTP:** read `GET <base>/llms.txt` (concise) or `/llms-full.txt` (complete). The full contract is `GET /openapi.json`.
3. **Dashboard:** a human-facing UI exists at `/` — prefer the API.

Ground rules:
- **Address products by SKU** everywhere (`/api/products/COFFEE-HOT`, `{"sku": "...", "qty": 2}`). Never scrape internal ids.
- **`GET /api/state`** returns everything in one call — use it instead of many small GETs.
- **Ordering flow:** `GET /api/recommendations` (dry run, grouped by supplier, includes `heldBelowMinimum`) → `POST /api/purchase-orders {"supplierId": ..., "fromRecommendations": true}` → optionally `"autoSend": true` to email the supplier. The response carries the delivery `eta`.
- **Send `Idempotency-Key`** on POSTs you might retry (sales, purchase orders). Same key within 24h = safe replay.
- **Expecting demand change?** `POST /api/hypotheses {"note", "multiplier", "category"|"sku"}` — forecasts and auto-orders adjust immediately. This is the intended way to encode weather, events, promotions.
- Prefer **webhooks** (`POST /api/webhooks`) over polling when you need to react to `stock.low`, `po.received`, etc. Verify `X-Inventory-Signature` = `sha256=HMAC-SHA256(secret, raw_body)`.
- Errors are `{"error": "<message>", "code": "<machine_code>"}` — branch on `code`.
- Auth: `Authorization: Bearer <key>` or `X-API-Key`. Direct local requests (loopback peer + loopback Host + no forwarding headers) need no key by default; proxied, containerized or cross-origin requests do. Never return secrets from a read endpoint.

## Developing on this codebase

- **Stack:** pure Node ≥22, **zero npm dependencies** — keep it that way; it is the product's core promise. No TypeScript, no build step.
- **Layout:** `engine/` is pure logic (no I/O except `store.js`/`email.js`/`webhooks.js` at the edges); `server.js` is routing; `public/` is a vanilla-JS SPA with a local utility stylesheet (`tw.css` — add classes there if you use new ones, nothing loads from a CDN).
- **Run:** `node bin/tanpin serve` (env `PORT`, `TANPIN_DB`, `TANPIN_NO_DAEMON=1`).
- **Test:** `npm test` (node --test --test-concurrency=1). Tests boot the real server on an ephemeral port — no mocks. Add tests for any new endpoint or engine rule.
- **Contract discipline:** if you add/change an endpoint, update all three of `openapi.js`, `public/llms.txt`/`llms-full.txt`, and the `apiIndex()` list in `server.js`, plus `mcp.js` if it deserves a tool.
- **Data:** single JSON document at `data/inventory.json`, atomic writes via temp-file rename. `data/` and `outbox/` are gitignored runtime state — never commit them.
- **Style:** CommonJS, small pure functions, comments explain *constraints* not narration.
