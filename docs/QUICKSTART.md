# Quickstart

Node 22+, zero install. This is the 60-second path plus the first sale and first purchase order.

## 1. Start the server

```bash
npx tanpin serve
```

From a clone:

```bash
node bin/tanpin serve
```

The process prints the origin (default [http://localhost:4173](http://localhost:4173)), the data file, the outbox directory, and whether the daemon is running.

Open the origin in a browser. Click **Load demo data**. That replaces the store with a convenience-store catalog, about 35 days of sales with weekday seasonality, and a beverage demand hypothesis — then runs one management cycle so forecasts and reorder points are live.

Equivalent HTTP:

```bash
curl -X POST http://localhost:4173/api/seed
```

`POST /api/seed` and `POST /api/reset` are destructive.

## 2. Docker

Build from the repository root so `bin/`, `src/`, and `public/` are in the context:

```bash
docker build -f space/Dockerfile -t tanpin .
docker run --rm -p 7860:7860 tanpin
```

Open [http://localhost:7860](http://localhost:7860). The image runs:

```
DEMO_MODE=1 PORT=7860 HOST=0.0.0.0 node bin/tanpin serve
```

`DEMO_MODE=1` is the public-demo posture: reads are open, the demo writes (sales, adjustments, POs, hypotheses, **Load demo data**, cycles) need no key even though Docker's port mapping means requests are not local, and webhooks/SMTP are off.

For a real (non-demo) container, use the root `Dockerfile` or `compose.yml` with `TANPIN_ADMIN_KEY` set; the dashboard asks for that key the first time it loads.

Persist the JSON store:

```bash
docker run --rm -p 7860:7860 -v tanpin-data:/app/data tanpin
```

## 3. Look at the store

```bash
curl http://localhost:4173/api/health
curl http://localhost:4173/api/state
curl http://localhost:4173/api/recommendations
```

`GET /api/state` is the one-call snapshot: KPIs, every product with live forecast/reorder fields, open POs with ETAs, suppliers, hypotheses, daemon log.

`GET /api/recommendations` is a dry run of the ordering engine, grouped by supplier. `heldBelowMinimum: true` means the draft would miss that supplier’s minimum order value — the daemon holds it.

## 4. Record a sale

```bash
curl -X POST http://localhost:4173/api/sales \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: sale-demo-1' \
  -d '{"sku":"COFFEE-HOT","qty":2}'
```

Stock decrements, the SKU is re-forecasted, and `stock.low` fires if the item crosses its reorder point. Retrying with the same `Idempotency-Key` within 24 hours replays the original response.

End-of-day POS sync (see `examples/pos-end-of-day.sh`):

```bash
curl -X POST http://localhost:4173/api/sales/bulk \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pos-sync-2026-09-25' \
  -d '{"sales":[{"sku":"COFFEE-HOT","qty":214},{"sku":"ONIGIRI-TUNA","qty":167}]}'
```

## 5. Place an order

```bash
curl -X POST http://localhost:4173/api/purchase-orders \
  -H 'Content-Type: application/json' \
  -d '{"supplierId":"FreshFoods Distribution","fromRecommendations":true,"autoSend":true}'
```

`supplierId` accepts an internal id or the exact supplier name. `fromRecommendations: true` uses the engine’s quantities for that supplier. `autoSend: true` marks the PO sent and emails it (SMTP if configured, otherwise an `.eml` in the outbox). The response includes `eta` (unix ms) and `etaLabel`.

Receive it into stock when the delivery arrives:

```bash
curl -X POST http://localhost:4173/api/purchase-orders/<po-id>/receive
```

## 6. Tell it the future

```bash
curl -X POST http://localhost:4173/api/hypotheses \
  -H 'Content-Type: application/json' \
  -d '{"note":"local festival this weekend","multiplier":1.4,"category":"beverage"}'
```

The HTTP body uses `startsAt` / `endsAt` (unix ms). Omit them and the hypothesis starts now and lasts 7 days. The MCP tool `add_demand_hypothesis` also accepts `days` (default 7) and turns that into `endsAt`. Forecasts and automatic orders pick up the multiplier on the next recompute.

## 7. MCP

In another terminal, with the server still running:

```bash
INVENTORY_URL=http://localhost:4173 npx tanpin mcp
```

Then add the server to Claude Code, Codex, or Cursor — snippets are in the root [README.md](../README.md) and [MCP.md](MCP.md). Call `get_overview` first.

## 8. Auth for anything that is not localhost

```bash
curl -X POST http://localhost:4173/api/keys \
  -H 'Content-Type: application/json' \
  -d '{"name":"pos"}'
```

Save the `key` field — it is shown once. Then:

```bash
export TANPIN_REQUIRE_API_KEY=1
# restart serve, then:
curl http://localhost:4173/api/state -H "Authorization: Bearer <key>"
```

## Next

- REST reference: [API.md](API.md)
- MCP tools: [MCP.md](MCP.md)
- Runnable samples: [`examples/`](../examples/)
- Lights-out: `PUT /api/settings` with `{"autoManage":true,"autoSend":true}` and keep the daemon running
