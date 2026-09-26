# REST API

Tanpin’s HTTP API. The live machine contract is `GET /openapi.json` (OpenAPI 3.1, built from `src/openapi.js`). `GET /api` returns the same route list the server actually serves. `GET /llms.txt` and `GET /llms-full.txt` are the agent-oriented guides.

Base URL: the origin of `tanpin serve` (default `http://localhost:4173`). `/api/...` and `/api/v1/...` are equivalent. Bodies are JSON unless noted. Timestamps are unix milliseconds.

## Auth

Send `Authorization: Bearer <key>` or `X-API-Key: <key>`.

- Direct local requests need no key by default — that is how the dashboard works on the server's machine. "Direct local" means all three: the TCP peer is loopback, `Host` is a loopback name, and there is no forwarding header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`, ...). Requests through a reverse proxy or a container port mapping need a key; the dashboard prompts for one.
- Browser requests from another origin (reads too, even for `TANPIN_CORS_ORIGINS`) need a key.
- Secrets are never returned by reads: `settings.integrations.*` secret fields read back as `hasWebhookSecret: true` (etc.), webhooks as `hasSecret: true`. A webhook's secret is returned once, by `POST /api/webhooks`. PUT the masked view back unchanged and the stored secrets are kept; send a secret field as `null` to clear it.
- `TANPIN_REQUIRE_API_KEY=1` requires a key on every request.
- `TANPIN_ADMIN_KEY` is an always-valid master key (timing-safe compare).
- Create keys: `POST /api/keys` `{"name":"pos"}` — the `key` field appears **once**. Stored as SHA-256. Revoke: `DELETE /api/keys/{id}`.

Unauthenticated: `GET /api/health`, `GET /api`, `GET /openapi.json`, static dashboard files.

## Errors

Non-2xx bodies:

```json
{"error": "<human message>", "code": "<machine_code>"}
```

Codes include `missing_api_key`, `invalid_api_key`, `product_not_found`, `duplicate_sku`, `invalid_request`, `nothing_to_order`, `already_received`, `invalid_json`, `payload_too_large`.

## Idempotency

Header `Idempotency-Key: <any-unique-string>` on:

- `POST /api/sales`
- `POST /api/sales/bulk`
- `POST /api/purchase-orders`

A retry with the same key within 24 hours returns the original status and body with `Idempotency-Replayed: true`.

## Products are SKUs

Every product route accepts the internal id (`pro_…`) **or** the SKU (`COFFEE-HOT`). Prefer SKUs.

## Discovery

### `GET /api/health`

Liveness. No auth.

```json
{"ok":true,"name":"tanpin","version":"0.1.0","time":1770000000000,"skus":10,"daemonLastRun":1770000000000}
```

### `GET /api`

Endpoint index (method, path, summary), auth notes, MCP note, links to OpenAPI and `/llms.txt`. No auth. This is the route list this process serves.

### `GET /api/state`

Everything in one call: `version`, `settings`, `kpis` (`skuCount`, `stockValue`, `retailValue`, `lowStock`, `deadStock`, `openPOs`, `incomingUnits`), enriched `products`, `suppliers`, open `purchaseOrders` with `etaLabel`, `hypotheses`, `daemonLog`, outbox, masked keys, webhooks, `serverTime`.

### `GET /openapi.json`

OpenAPI 3.1 document. Server URL is the request origin.

### `POST /api/seed`

Replace all data with the demo convenience-store catalog and run one management cycle. Destructive. Returns `GET /api/state`.

### `POST /api/reset`

Wipe the store to empty defaults. Destructive.

## Products

Enriched product fields (recomputed on sales and each cycle):

`id`, `sku`, `name`, `category`, `supplierId`, `unitCost`, `price`, `currentStock`, `onOrder`, `stockPosition`, `belowReorder`, `daysOfSupply`, `leadTimeDays`, `packSize`, `minOrderQty`, `avgDailyDemand`, `dailyForecast`, `dailyStdDev`, `safetyStock`, `reorderPoint`, `eoq`, `abcClass` (`A`|`B`|`C`), `delistFlagged` (`dead`|`slow`|`null`), plus a `forecast` breakdown (`weekdayFactor`, `trendFactor`, `hypothesisMultiplier`, `horizonForecast`, `series`).

Input (`sku` and `name` required on create): `sku`, `name`, `category`, `supplierId`, `supplierName` (bulk/CSV: resolved or created by name), `unitCost`, `price`, `currentStock`, `leadTimeDays`, `packSize`, `minOrderQty`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/products` | Query `low_stock=true`, `category=` |
| `POST` | `/api/products` | 201; 409 `duplicate_sku` |
| `GET` | `/api/products/{idOrSku}` | 404 `product_not_found` |
| `PUT` | `/api/products/{idOrSku}` | Partial update |
| `DELETE` | `/api/products/{idOrSku}` | `{removed:true}` |
| `POST` | `/api/products/bulk` | Array or `{products:[…]}`; upsert by SKU |

## Stock

Sale input: `{sku|productId, qty=1, at?}`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/sales` | Decrements stock, re-forecasts, may emit `sale.recorded` / `stock.low`. Idempotent. |
| `POST` | `/api/sales/bulk` | Array or `{sales:[…]}` → `{recorded, failed, results}`. Idempotent. |
| `POST` | `/api/adjust` | `{sku|productId, delta, reason?}`. `delta` may be negative; on-hand floors at 0. |
| `GET` | `/api/movements` | Query `product=` (id or SKU), `limit=` (default 100, max 1000). Newest first. Types: `sale`, `receipt`, `adjustment`. |

## Ordering

### `GET /api/recommendations`

Dry run of the daemon’s ordering pass.

```json
{
  "recommendations": [
    {
      "supplierId": "sup_…",
      "supplierName": "FreshFoods Distribution",
      "lines": [{"productId":"…","sku":"ONIGIRI-TUNA","name":"Tuna Mayo Onigiri","qty":48,"unitCost":0.85}],
      "total": 40.8,
      "minOrderValue": 50,
      "heldBelowMinimum": true
    }
  ],
  "notes": [],
  "generatedAt": 1770000000000
}
```

`heldBelowMinimum` is true when the draft total is under the supplier minimum — the daemon holds it.

### Purchase orders

Create body: `{supplierId, lines?:[{sku|productId, qty}], fromRecommendations?:bool, autoSend?:bool}`. `supplierId` is an id or the exact name.

Statuses: `draft`, `sent`, `in_transit`, `received`, `cancelled`. Response includes `eta`, `etaLabel` (e.g. `"in 2 days"`), `leadTimeDays`, `auto` (raised by the daemon).

ETA = order time + supplier lead time, snapped to the next delivery window, with the cut-off hour applied. Windows and cut-offs are civil hours in the store timezone (`settings.timezone`, else the host zone).

`receive`, `cancel` and `send` re-check the PO's current status inside the write transaction: receiving twice or cancelling a received PO returns `409` even when another process (the standalone daemon) changed it.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/purchase-orders` | Query `status=open\|draft\|sent\|in_transit\|received\|cancelled` |
| `POST` | `/api/purchase-orders` | 201; 422 `nothing_to_order` when `fromRecommendations` finds no lines. Idempotent. |
| `GET` | `/api/purchase-orders/{id}` | |
| `POST` | `/api/purchase-orders/{id}/send` | Mark sent + email (SMTP or outbox) |
| `POST` | `/api/purchase-orders/{id}/receive` | Stock in; 409 if already received/cancelled |
| `POST` | `/api/purchase-orders/{id}/cancel` | 409 if already received |

## Suppliers

`{id, name, email, leadTimeDays, deliveryWindows:[hours 0–23], cutoffHour, minOrderValue}`

`deliveryWindows` on write: array of hours or a comma-separated string (`"8,13,19"`).

| Method | Path |
|---|---|
| `GET` | `/api/suppliers` |
| `POST` | `/api/suppliers` |
| `PUT` | `/api/suppliers/{id}` |
| `DELETE` | `/api/suppliers/{id}` |

## Forecasting

Demand hypotheses are the forward-looking half of tanpin kanri. Multipliers compound and apply while `startsAt ≤ now ≤ endsAt`.

```bash
POST /api/hypotheses
{"note":"heatwave next week","multiplier":1.4,"category":"beverage"}
```

Scope with `category` and/or `sku` / `productId`. Override the window with `startsAt` / `endsAt` (unix ms). The HTTP body has no `days` field; omit the window and it starts now and lasts 7 days. The MCP tool `add_demand_hypothesis` accepts `days` and sends `endsAt`.

| Method | Path |
|---|---|
| `GET` | `/api/hypotheses` |
| `POST` | `/api/hypotheses` |
| `DELETE` | `/api/hypotheses/{id}` |

Per-SKU daily forecast:

```
dailyForecast = weightedMovingAverage(sales, halfLife=7d)
              × weekdayFactor × trendFactor × hypothesisMultiplier
safetyStock   = z(serviceLevel) × dailyStdDev × √leadTimeDays
reorderPoint  = forecast demand over leadTimeDays (weekday × trend × hypothesis)
              + safetyStock
holdingCost   = unitCost × holdingCostRate
EOQ           = √(2 × annualDemand × orderCost / holdingCost)
orderQty      = clamp(targetDaysOfSupply × forecast − (onHand+onOrder),
                      floor = max(EOQ, MOQ),
                      cap   = maxDaysOfSupply × forecast − (onHand+onOrder))
                rounded up to packSize
```

ABC: A = top 80% of annual value, B = next 15%, C = last 5%. Delist: `dead` (on-hand, no demand) or `slow` (≥ 120 days of supply).

## Automation

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/daemon/run` | One cycle now: forecast → ABC → draft POs → optional email → optional auto-receive → delist flags |
| `GET` | `/api/daemon/log` | Recent cycle summaries, newest first |
| `GET` | `/api/settings` | |
| `PUT` | `/api/settings` | Partial |
| `GET` | `/api/outbox` | Emails the system has sent (POs and digests) |

Cycle summary: `{at, trigger: daemon|manual, recomputed, ordersCreated, orderLines, emailsSent, received, delistFlags, notes}`.

Settings keys: `currency`, `serviceLevel` (0–1 in-stock target), `targetDaysOfSupply`, `maxDaysOfSupply`, `orderCost`, `holdingCostRate`, `autoManage`, `autoSend`, `autoReceive`, `autoEmailAlerts`, `daemonIntervalMinutes`, `notifyEmail`, `fromEmail`, `companyName`.

`tanpin serve` runs the daemon in-process unless `TANPIN_NO_DAEMON=1`. Interval is `max(60s, daemonIntervalMinutes × 60s)`.

## Integration

### API keys

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/keys` | Masked (`prefix`, never the full key) |
| `POST` | `/api/keys` | `{name?}` — response includes `key` once |
| `DELETE` | `/api/keys/{id}` | Revoke |

### Webhooks

Register: `POST /api/webhooks` `{"url":"https://example.invalid/hook","events":["stock.low","po.created"]}`. `events` defaults to `["*"]`. `secret` is generated if omitted.

Delivery: JSON POST

```json
{"id":"evt_…","event":"po.created","at":1770000000000,"data":{}}
```

Headers:

- `X-Inventory-Event: po.created`
- `X-Inventory-Signature: sha256=<HMAC-SHA256(secret, raw_body)>`
- `User-Agent: tanpin-webhook/<version>`

Events: `sale.recorded`, `stock.adjusted`, `stock.low`, `po.created`, `po.sent`, `po.received`, `po.cancelled`, `product.delist_flagged`, `cycle.completed`.

Deliveries are fire-and-forget (10s timeout). `GET /api/webhooks` returns `{webhooks, events, recentDeliveries}`.

| Method | Path |
|---|---|
| `GET` | `/api/webhooks` |
| `POST` | `/api/webhooks` |
| `POST` | `/api/webhooks/{id}/test` |
| `DELETE` | `/api/webhooks/{id}` |

See `examples/webhook-receiver.js`.

### CSV

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/export/products.csv` | Catalog plus live planning fields |
| `GET` | `/api/export/movements.csv` | Audit trail |
| `POST` | `/api/import/products` | JSON array or `text/csv`. Upsert by SKU; `supplierName` creates suppliers. |

Import columns: `sku,name,category,supplierName,unitCost,price,currentStock,leadTimeDays,packSize,minOrderQty`.

Product export adds `avgDailyDemand,reorderPoint,safetyStock,abcClass`. Movement export columns: `id,sku,productId,type,qty,at,atIso,ref`.

## Plugins

`TANPIN_PLUGIN` points at a CommonJS module:

```js
module.exports = {
  name: 'my-plugin',
  routes: [{ method: 'GET', path: '/api/plan', handler: (ctx) => ({ plan: 'free' }) }],
  limits: { maxProducts: 20, maxApiKeys: 1, autoSend: false },
};
```

Plugin routes run before core routes. A handler that returns `false` without writing a response falls through. `POST /api/products` and `POST /api/keys` return HTTP 402 `limit_reached` when `maxProducts` / `maxApiKeys` would be exceeded. Bulk import skips overflowing rows instead. `autoSend: false` blocks turning on automatic PO email.

## Recipes

End-of-day POS sync (`examples/pos-end-of-day.sh`):

```http
POST /api/sales/bulk
Idempotency-Key: pos-sync-2026-09-25
{"sales":[{"sku":"COFFEE-HOT","qty":214},{"sku":"ONIGIRI-TUNA","qty":167}]}
```

Order everything the engine wants (`examples/agent-reorder.js`):

```http
GET /api/recommendations
POST /api/purchase-orders
{"supplierId":"<id or name>","fromRecommendations":true,"autoSend":true}
```

Lights-out: `PUT /api/settings` `{"autoManage":true,"autoSend":true}` and leave the daemon running.
