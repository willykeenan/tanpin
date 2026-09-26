# Contributing to Tanpin

Tanpin is a public, zero-dependency Node inventory engine. The core promise is: **Node 22, `node:*` built-ins only, no runtime `package.json` dependencies, no build step, no TypeScript.** Keep it that way.

## Setup

```bash
git clone <this-repo>
cd tanpin
node bin/tanpin serve
```

Node.js 22 or newer. Nothing to install. The server binds [http://localhost:4173](http://localhost:4173). Click **Load demo data** (or `POST /api/seed`) for a sample catalog.

## Tests

Run the suite serially:

```bash
npm test
# same as:
node --test --test-concurrency=1 test/
```

Tests boot the real HTTP server on an ephemeral port. No mocks. Add a test for every new endpoint or engine rule.

Focused files:

- `test/engine.test.js` — forecast, reorder, ETA math
- `test/api.test.js` — HTTP surface (auth, SKUs, idempotency, POs, webhooks, CSV)
- `test/mcp.test.js` — MCP handshake and tools against a live server

## Layout

| Path | Role |
|---|---|
| `bin/tanpin` | CLI: `serve`, `daemon`, `mcp` (`seed` is reserved; use `POST /api/seed`) |
| `src/server.js` | HTTP routing, auth, dashboard static files |
| `src/daemon.js` | Auto-management loop |
| `src/mcp.js` | MCP server (JSON-RPC over stdio) |
| `src/openapi.js` | OpenAPI 3.1 spec served at `/openapi.json` |
| `src/engine/` | Pure planning math; I/O only at `store.js`, `email.js`, `webhooks.js` |
| `src/plugin.js` | Optional `TANPIN_PLUGIN` hook |
| `src/seed.js` | Demo catalog used by `POST /api/seed` |
| `public/` | Vanilla JS dashboard (`tw.css` is a local utility sheet — no CDN) |
| `examples/` | POS sync, agent reorder, webhook receiver |
| `docs/` | Human docs (this folder) |

CommonJS throughout. Small pure functions. Comments explain constraints.

## Contract discipline

If you add or change an HTTP endpoint, update all of:

1. The route in `src/server.js` (and the `ENDPOINTS` / `apiIndex()` list)
2. `src/openapi.js`
3. `public/llms.txt` and `public/llms-full.txt`
4. `docs/API.md`
5. `src/mcp.js` plus `docs/MCP.md` when the change deserves a tool

`GET /api` and `GET /openapi.json` are the machine-readable contracts. Keep them aligned.

## Data

Default store is a single JSON document at `data/inventory.json`, written atomically via temp-file rename. `data/` and `outbox/` are gitignored runtime state — do not commit them.

## Style

- Match the file you are in.
- Prefer editing an existing module over adding a parallel framework.
- Do not add npm dependencies.
- Do not load CSS/JS from a CDN; add classes to `public/tw.css` if the dashboard needs new utilities.

## Pull requests

- One concern per PR.
- Tests green: `node --test --test-concurrency=1`.
- Docs updated when behavior changes.
- Changelog entry under `[Unreleased]` in `CHANGELOG.md`.

## License

MIT. By contributing you agree your changes are licensed under the same terms. See [LICENSE](LICENSE).
