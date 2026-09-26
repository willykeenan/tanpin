# Sales sources and supplier email

Tanpin records sales from Stripe Checkout, Shopify, Square, and CSV files, and sends purchase-order email over SMTP or HTTPS. There are no runtime npm dependencies; everything uses `node:*` built-ins.

The HTTP server mounts inbound endpoints by calling `require('./integrations/routes').register(route)` with the same `route({ method, path, public, summary, handler })` registrar used for plugin routes in `src/server.js`. Webhook routes are `public: true` (the provider signature is the credential). CSV import requires an API key.

## Endpoints

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| POST | `/api/integrations/stripe` | `Stripe-Signature` | Checkout (and similar) events. Decrements stock. |
| POST | `/api/integrations/stripe-sales` | same | Alias of `/stripe`. |
| POST | `/api/integrations/shopify` | `X-Shopify-Hmac-Sha256` | `orders/*` webhooks. |
| POST | `/api/integrations/square` | `x-square-hmacsha256-signature` | Order webhooks. |
| POST | `/api/integrations/csv-sales` | API key | CSV body with a header row. |

After a valid signature the handler returns 2xx, including unknown SKUs, ignored event types, and duplicate event ids. Providers retry on 5xx; returning 2xx is what stops a retry from decrementing twice. Forged signatures return `400` `{ "code": "invalid_signature" }`. Missing secrets return `503` `{ "code": "not_configured" }`. If Tanpin has to call the provider's API for line items and that call fails, it returns `502` `{ "code": "provider_fetch_failed" }` so the provider retries later (nothing was recorded).

Idempotency is the provider event id (`evt_…`, Shopify order id, Square order id, or a CSV `id` column), claimed atomically so two processes cannot both record it. Retries of the same id are no-ops. Event ids are kept for seven days. **An id is only consumed when at least one sale from it was recorded**: an event that maps to nothing (unknown SKUs, no line items, API key not configured yet) answers `200` with `"consumed": false` and usually a `hint`, and can be replayed from the provider's dashboard once the mapping is fixed. The same holds for CSV rows.

## SKU mapping

Stock moves through the same sale path as `POST /api/sales`: look up the product by SKU, decrement `currentStock` (never below 0), append a `sale` movement, recompute the forecast.

- **Stripe** — `checkout.session.completed` only. The event Stripe actually sends **does not contain line items**, so Tanpin fetches them: `GET /v1/checkout/sessions/{id}/line_items?expand[]=data.price.product` with `STRIPE_API_KEY` (a restricted key with *read* access to Checkout Sessions is enough; `rk_…`). SKU per line, first match wins: line `metadata.sku` → the Price's **`lookup_key`** → `price.metadata.sku` → the Product's `metadata.sku`. So: set each Price's lookup key (or the Product's `sku` metadata) to the Tanpin SKU. Without an API key, only a session-level `metadata.sku` (optional `metadata.qty`) can be used. Other event types return 200 ignored so they cannot double-decrement.
- **Shopify** — `orders/create` only (`line_items[].sku` and `quantity` are in the payload). Give each variant the Tanpin SKU in Shopify's SKU field. `orders/updated`, `orders/paid`, and `orders/cancelled` return 200 ignored.
- **Square** — `order.created` only. The notification carries only `data.object.order_created.order_id`, and Square line items have **no `sku` field**, so Tanpin fetches the order (`GET /v2/orders/{id}`) and its item variations (`POST /v2/catalog/batch-retrieve`) with `SQUARE_ACCESS_TOKEN` (scopes `ORDERS_READ`, `ITEMS_READ`). SKU per line: line-item `metadata.sku` → the catalog **ItemVariation's `sku`**. So: set each variation's SKU in the Square catalog to the Tanpin SKU. `SQUARE_ENVIRONMENT=sandbox` targets the sandbox API. Configure the webhook URL exactly as Tanpin receives it; Square signs `notificationUrl + rawBody`.
- **CSV** — header row required. Columns: `sku` (required), `qty` or `quantity` (default 1), optional `at`/`date`/`timestamp`, optional `id`/`event_id`/`ref` for idempotency. Dates with `Z` or an offset are exact instants; a date-only value (`2026-01-15`, placed at 12:00) or a local date-time without offset (`2026-01-15 14:30`) is read in the **store timezone** (`settings.timezone`), so an end-of-day export lands on the day it names. Epoch milliseconds are accepted too.

```csv
sku,qty,at
WIDGET-1,2,2026-01-15T12:00:00Z
```

## Secrets

Read from environment, or from `settings.integrations` if the dashboard saved them:

| Provider | Env | Settings path |
| --- | --- | --- |
| Stripe | `STRIPE_WEBHOOK_SECRET` | `integrations.stripe.webhookSecret` |
| Shopify | `SHOPIFY_WEBHOOK_SECRET` | `integrations.shopify.webhookSecret` |
| Square | `SQUARE_SIGNATURE_KEY` | `integrations.square.signatureKey` |
| Square URL | `SQUARE_NOTIFICATION_URL` | `integrations.square.notificationUrl` |
| Stripe API (line items) | `STRIPE_API_KEY` | `integrations.stripe.apiKey` |
| Square API (orders + catalog) | `SQUARE_ACCESS_TOKEN` (+ `SQUARE_ENVIRONMENT=sandbox`) | `integrations.square.accessToken` / `.environment` |

Secrets saved in settings are write-only: reads return `hasWebhookSecret: true` / `hasAccessToken: true` instead. `STRIPE_API_BASE` / `SQUARE_API_BASE` override the API origin (used by the tests' local fakes).

Square falls back to `ctx.baseUrl + path` (honours `X-Forwarded-Proto`) when no notification URL is set. If you sit behind a proxy, set `SQUARE_NOTIFICATION_URL` to the public URL Square was given.

## Signature checks

- **Stripe** — `t=<unix>,v1=<hex>`. HMAC-SHA256 of `` `${t}.${rawBody}` `` with the webhook secret. Timestamps older than five minutes are rejected.
- **Shopify** — base64 HMAC-SHA256 of the raw body with the webhook secret.
- **Square** — base64 HMAC-SHA256 of `notificationUrl + rawBody` with the signature key (`x-square-hmacsha256-signature`).

Comparisons are timing-safe. Do not parse JSON before verifying: HMAC is over the exact bytes.

## Supplier email

`src/engine/email.js` picks a transport automatically (`EMAIL_TRANSPORT` overrides):

1. `RESEND_API_KEY` → Resend (`POST /emails`). Override host with `RESEND_API_URL` (tests use a local server).
2. `POSTMARK_SERVER_TOKEN` → Postmark. Override with `POSTMARK_API_URL`.
3. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` → SES v2 over HTTPS with SigV4, no AWS SDK. Region: `AWS_REGION` (default `us-east-1`). Override with `AWS_SES_ENDPOINT`.
4. `SMTP_HOST` → SMTP. Port **465** is implicit TLS; port **587** upgrades with **STARTTLS**. `SMTP_AUTH=login` or `plain` (otherwise PLAIN if the server advertises it, else LOGIN). `SMTP_USER` / `SMTP_PASS`. Set `SMTP_TLS_REJECT_UNAUTHORIZED=0` only for a local self-signed test server.
5. Otherwise every message is written to the outbox directory as `.eml`.

A failed live send falls back to the outbox and never throws; the daemon must keep running.

Pass `purchaseOrder` (or `attachments`) to `sendEmail` to attach a CSV of PO lines (`sku,name,qty,unitCost,lineTotal`). The MIME message is `multipart/mixed` with a base64 part.

## Local testing

Tests speak only to in-process fake SMTP/HTTP servers. They never call Stripe, Shopify, Square, Resend, Postmark, or SES. Run:

```
node --test --test-concurrency=1 test/integrations.test.js
```
