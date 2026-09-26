# Integration examples

Runnable against a local server (`node ../bin/tanpin serve`). Set `INVENTORY_URL` / `INVENTORY_API_KEY` for remote instances.

| File | Shows |
|---|---|
| `pos-end-of-day.sh` | Syncing a day of POS sales in one idempotent call |
| `agent-reorder.js` | The "agent morning routine": read state → get recommendations → place orders |
| `webhook-receiver.js` | Receiving webhooks and verifying the HMAC signature |

MCP setup (no code at all):

```bash
claude mcp add tanpin -- node /path/to/tanpin/src/mcp.js
```
