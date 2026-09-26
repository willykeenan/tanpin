# MCP server

Tanpin ships a Model Context Protocol server with **zero npm dependencies**. It speaks newline-delimited JSON-RPC 2.0 on stdio and calls the HTTP API of a running `tanpin serve`.

```bash
# terminal 1
npx tanpin serve

# terminal 2
INVENTORY_URL=http://localhost:4173 npx tanpin mcp
```

From a checkout: `node bin/tanpin mcp` or `node src/mcp.js`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `INVENTORY_URL` | `http://localhost:4173` | Base URL of the inventory HTTP server |
| `INVENTORY_API_KEY` | empty | Sent as `Authorization: Bearer …` when the server requires a key |

The MCP process is a client of the REST API. Start `tanpin serve` first.

## Client configs

### Claude Code

```bash
claude mcp add tanpin --env INVENTORY_URL=http://localhost:4173 -- npx -y tanpin mcp
```

Project `.mcp.json`:

```json
{
  "mcpServers": {
    "tanpin": {
      "command": "npx",
      "args": ["-y", "tanpin", "mcp"],
      "env": {
        "INVENTORY_URL": "http://localhost:4173"
      }
    }
  }
}
```

Local checkout:

```json
{
  "mcpServers": {
    "tanpin": {
      "command": "node",
      "args": ["src/mcp.js"],
      "env": {
        "INVENTORY_URL": "http://localhost:4173"
      }
    }
  }
}
```

### Codex

`~/.codex/config.toml` (or the project Codex config):

```toml
[mcp_servers.tanpin]
command = "npx"
args = ["-y", "tanpin", "mcp"]

[mcp_servers.tanpin.env]
INVENTORY_URL = "http://localhost:4173"
```

With a key:

```toml
[mcp_servers.tanpin.env]
INVENTORY_URL = "http://localhost:4173"
INVENTORY_API_KEY = "<your-key>"
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tanpin": {
      "command": "npx",
      "args": ["-y", "tanpin", "mcp"],
      "env": {
        "INVENTORY_URL": "http://localhost:4173"
      }
    }
  }
}
```

## Protocol

- JSON-RPC 2.0, one message per line on stdin/stdout
- `initialize` echoes the client’s `protocolVersion` (fallback `2025-06-18`)
- `tools/list`, `tools/call`, `ping`
- `notifications/initialized` and `notifications/cancelled` are acknowledged with silence
- Tool results are `content: [{ type: "text", text: "<json>" }]`

Call **`get_overview` first**. Products are addressed by SKU.

Typical ordering flow:

1. `get_overview`
2. `get_reorder_recommendations`
3. `create_purchase_order` with `from_recommendations: true` (and `auto_send: true` to email)

Demand spike: `add_demand_hypothesis` — forecasts and automatic orders adjust on the next recompute.

## Tools

Source of truth: `src/mcp.js` (`TOOLS`).

### `get_overview`

Snapshot of the store. Start here.

- Input: `{}`
- Returns: `kpis`, `lowStock`, `deadStock`, `openPurchaseOrders` (with ETAs), `lastCycle`, `settings` (`autoManage`, `autoSend`, `serviceLevel`, `targetDaysOfSupply`)

### `list_products`

Live forecast and reorder fields.

| Argument | Type | Notes |
|---|---|---|
| `low_stock` | boolean | Only items at/below reorder point |
| `category` | string | Exact category match |

### `get_product`

Full detail for one product: forecast breakdown, safety stock, reorder point, EOQ, days of supply.

| Argument | Type | Required |
|---|---|---|
| `sku` | string | yes (SKU or internal id) |

### `create_product`

Adds a catalog row. `supplier_name` is matched or created.

| Argument | Type | Required |
|---|---|---|
| `sku` | string | yes |
| `name` | string | yes |
| `category` | string | |
| `supplier_name` | string | created if new |
| `unit_cost` | number | |
| `price` | number | |
| `current_stock` | number | |
| `lead_time_days` | number | |
| `pack_size` | number | |
| `min_order_qty` | number | |

### `record_sale`

Decrements stock, re-forecasts, may fire `stock.low`.

| Argument | Type | Required |
|---|---|---|
| `sku` | string | yes |
| `qty` | number | default `1` |

### `adjust_stock`

Stocktake, shrinkage, damage. `delta` may be negative (floored at 0 on hand).

| Argument | Type | Required |
|---|---|---|
| `sku` | string | yes |
| `delta` | number | yes |
| `reason` | string | |

### `get_reorder_recommendations`

Dry run of the auto-ordering engine, grouped by supplier, with quantities, costs, and `heldBelowMinimum`. Use before `create_purchase_order`.

- Input: `{}`

### `create_purchase_order`

Creates a PO. Either pass explicit `lines` or set `from_recommendations` for that supplier. Returns the PO with its delivery ETA.

| Argument | Type | Required |
|---|---|---|
| `supplier` | string | yes (id or exact name) |
| `lines` | `[{sku, qty}]` | when not using recommendations |
| `from_recommendations` | boolean | |
| `auto_send` | boolean | mark sent and email immediately |

### `list_purchase_orders`

| Argument | Type | Notes |
|---|---|---|
| `status` | string | `open`, `draft`, `sent`, `received`, `cancelled` (`open` = not received and not cancelled) |

### `send_purchase_order`

Marks a draft sent and emails the supplier (SMTP or outbox).

| Argument | Type | Required |
|---|---|---|
| `po_id` | string | yes |

### `receive_purchase_order`

Receives a PO into stock (receipt movements + on-hand).

| Argument | Type | Required |
|---|---|---|
| `po_id` | string | yes |

### `list_suppliers`

Lead times, delivery windows, cut-off hours, minimum order values. No arguments.

### `create_supplier`

| Argument | Type | Required |
|---|---|---|
| `name` | string | yes |
| `email` | string | order address |
| `lead_time_days` | number | |
| `delivery_windows` | string | comma-separated hours, e.g. `"8,13,19"` |
| `cutoff_hour` | number | later orders start lead time tomorrow |
| `min_order_value` | number | |

### `add_demand_hypothesis`

Forward-looking tanpin kanri move. `multiplier` 1.4 means +40% demand.

| Argument | Type | Required |
|---|---|---|
| `note` | string | yes (e.g. `"Local festival this weekend"`) |
| `multiplier` | number | yes |
| `category` | string | whole category |
| `sku` | string | one product |
| `days` | number | duration, default `7` |

### `run_management_cycle`

One full cycle now: re-forecast every SKU, reclassify ABC, raise draft POs for anything below reorder point, email if auto-send is on, flag dead stock. Returns the cycle summary.

- Input: `{}`

### `get_movements`

Stock movement audit trail, newest first.

| Argument | Type | Notes |
|---|---|---|
| `sku` | string | filter to one product |
| `limit` | number | default `50` |

## Ground rules for agents

- Address products by SKU.
- Prefer `get_overview` over many small reads (`GET /api/state` under the hood).
- Errors from the HTTP API surface as tool `isError` text. If the HTTP server is down, the text includes a hint to start it (`node server.js` in this tree; `tanpin serve` is the same process).
