# Tanpin security model

Tanpin is meant to run on the operator's machine (or a host they control). The dashboard is a same-origin SPA talking to `/api`. Remote clients (POS, MCP, scripts) use an API key.

## Bind address

`tanpin serve` listens on `127.0.0.1` by default. Set `HOST` to change that (`0.0.0.0` to publish inside a container; the Compose file does this). A process bound only to loopback is not reachable from other machines.

## Origin and Host

Every `/api` request (and `/openapi.json`) is checked:

- The `Host` header must name a trusted hostname: `localhost`, `127.0.0.1`, `::1`, the `HOST` bind address when it is a specific address, the Hugging Face `SPACE_HOST`, or a hostname listed in `TANPIN_CORS_ORIGINS`.
- If the browser sent `Origin`, it must be the same origin as `Host` *and* that hostname must be trusted, **or** it must appear exactly in `TANPIN_CORS_ORIGINS`.
- A missing `Origin` is treated as a non-browser client (curl, MCP, a POS). Those still need a key when they are not on loopback.

This is what stops a random website from driving the local API: its `Origin` is not trusted, so the request is `403 origin_forbidden` before any handler runs.

## CORS

Responses never send `Access-Control-Allow-Origin: *`. The allowlist is `TANPIN_CORS_ORIGINS` (comma-separated exact origins, for example `https://app.example`). Allowed origins are reflected; everyone else gets no CORS grant. Same-origin dashboard traffic does not need the allowlist.

## Authentication

Send `Authorization: Bearer <key>` or `X-API-Key: <key>`. Keys are stored hashed.

| Client | Reads | Writes |
| --- | --- | --- |
| Direct local, same-origin (dashboard on the server's machine) | open | open (no key) |
| Direct local, no `Origin` (curl / MCP on the server's machine) | open | open (no key) |
| Browser, different origin (allowlisted or not) | needs a key (non-allowlisted origins are refused outright) | needs a key |
| Through a reverse proxy / port mapping / another machine | needs a key | needs a key |
| `DEMO_MODE=1`, anyone | open | demo writes open, everything else refused (see below) |

**"Direct local"** means all three hold:

1. the TCP peer is loopback (`127.0.0.0/8`, `::1`),
2. the `Host` header is a loopback name (`localhost`, `127.x.x.x`, `[::1]`), and
3. there is no forwarding header: `Forwarded`, `X-Forwarded-For/-Host/-Proto/-Port/-Server`, `X-Real-IP`, `X-Client-IP`, `True-Client-IP`, `CF-Connecting-IP`, `Fastly-Client-IP`, `X-Cluster-Client-IP`, `Via`.

The peer address alone is not enough: nginx, Caddy or cloudflared on the same host always connect from `127.0.0.1`, which would make every internet client "local". Behind a proxy, create a key (or set `TANPIN_ADMIN_KEY`); the dashboard shows a key prompt whenever the API answers `401`, and keeps the key in `sessionStorage` (or `localStorage` if you tick "remember").

`TANPIN_REQUIRE_API_KEY=1` (or `REQUIRE_API_KEY=1`) turns off the local bypass entirely. `TANPIN_ADMIN_KEY` (or `INVENTORY_ADMIN_KEY`) is an always-valid master key.

**Browser requests from another origin always need the token** — reads as well as writes, and also for origins in `TANPIN_CORS_ORIGINS` — even when the TCP peer is loopback. That is the local-server hole: a visited page can send requests to `http://127.0.0.1` as the operator.

## Secrets are write-only

No read returns anything that can sign or forge a request:

- `settings.integrations.*` fields named like a secret (`webhookSecret`, `signatureKey`, `accessToken`, `apiKey`, `...Token`, `...Password`) read back as `hasWebhookSecret: true` etc. — in `/api/state`, `GET/PUT /api/settings`.
- Webhooks read back with `hasSecret: true` and credentials in the URL redacted. The signing secret is returned once, in the `POST /api/webhooks` response.
- `PUT /api/settings` with the masked view unchanged keeps the stored secrets; a secret field sent as `null` or `""` clears it.

## Dashboard hardening

Every response carries `Content-Security-Policy: default-src 'self'; script-src 'self'; script-src-attr 'none'; ...` (no inline script, no inline event handlers, no framing), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Values rendered by the dashboard are HTML-escaped; the CSP is the second line of defence if one is ever missed.

## Webhooks (SSRF)

`POST /api/webhooks` accepts only `http:` / `https:` URLs. A destination is refused (`400` at registration, a failed delivery at send time) when its host is, or resolves to, anything but ordinary public unicast:

- IPv4: `0/8`, `10/8`, `100.64/10` (CGNAT — Tailscale, some cloud metadata such as `100.100.100.200`), `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24` (IETF; OCI metadata `192.0.0.192`), `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` and above;
- IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001::/32` (Teredo), `2001:db8::/32`, `100::/64`, `64:ff9b:1::/48`, and the IPv4 embedded in IPv4-mapped/-compatible/-translated addresses, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`, which is judged by the IPv4 rules;
- names: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`.

**DNS rebinding:** there is no separate "check" lookup. The delivery uses `node:http(s)` with a `lookup` function that resolves the name once, refuses the connection if *any* returned address is private, and connects to an address from that same answer. A TTL-0 name cannot pass the check with a public IP and then connect to `127.0.0.1`.

Deliveries never follow redirects, and none are made in `DEMO_MODE`. All of this lives in `src/engine/webhooks.js` / `src/engine/netguard.js`, so it applies to the standalone daemon exactly as to `tanpin serve`.

Set `TANPIN_ALLOW_PRIVATE_WEBHOOKS=1` to register and fire hooks on a local receiver (tests, a sidecar on loopback).

## `DEMO_MODE=1`

Public demo / screenshot instance:

- Reads (`GET` / `HEAD`) are open, including without a key and from non-local clients (Docker, the Space's proxy). Secrets are masked as everywhere.
- Writes are limited to the demo catalog, and those writes need no key from anyone: sales, adjustments, purchase orders, hypotheses, product/supplier edits, settings (`autoSend` / `autoEmailAlerts` forced off; `integrations` and `notifyEmail` ignored; `SMTP_HOST` cleared), `POST /api/seed`, `POST /api/daemon/run`.
- Creating products or suppliers, API keys, webhooks, import/bulk, and `POST /api/reset` return `403 demo_mode`.
- Outbound webhooks are not delivered. SMTP is not used (`SMTP_HOST` is cleared on boot; auto-email flags are forced off).
- The demo catalog is seeded on boot and again every 30 minutes (`DEMO_RESEED_MS`).

## Optional integration routes

If `src/integrations/routes.js` exists, the server loads it at boot and calls:

```js
require('./integrations/routes').register(route);
```

`route(method, path, handler, opts?)` matches the plugin routing style in `src/plugin.js`:

- `method` — HTTP verb (`GET`, `POST`, …) or `*`
- `path` — exact string (`/api/foo`) or a `RegExp` (named groups become `ctx.params`)
- `handler(ctx)` — async function. `ctx` is the same object plugin routes receive: `req`, `res`, `url`, `path`, `method`, `params`, `store`, `auth`, `baseUrl`, `rawBody`, `body`, `json`, `error`, `text`, `limits`
- `opts.public` — skip API-key auth (Origin/Host checks still run)
- `opts.summary` — listed on `GET /api` when set

The handler may return an object (JSON 200), return `false` to pass through, or call `ctx.json` / `ctx.error` itself. Integration routes run after `TANPIN_PLUGIN` routes and before the core API, and they go through the same Origin/Host, CORS, demo-mode, and (unless `public`) auth gates.

## Optional backtest

`GET /api/backtest[?horizon=7&window=28]` runs `require('./engine/backtest').backtestInWorker(store, opts)` when that file exists — the replay happens on a worker thread so a large catalog does not block other requests. If the file does not exist, the endpoint responds `404 not_found`.

## Environment

| Variable | Role |
| --- | --- |
| `HOST` | Bind address (default `127.0.0.1`) |
| `PORT` | Bind port (default `4173`) |
| `TANPIN_CORS_ORIGINS` | Comma-separated exact origins allowed for CORS / Origin |
| `TANPIN_REQUIRE_API_KEY` | `1` to require a key even on loopback |
| `TANPIN_ADMIN_KEY` | Master key |
| `TANPIN_ALLOW_PRIVATE_WEBHOOKS` | `1` to allow loopback/private webhook URLs |
| `DEMO_MODE` | `1` for the public demo posture |
| `SPACE_HOST` | Set by Hugging Face Spaces; trusted as a `Host` |
| `TANPIN_PLUGIN` | Optional plugin module |
| `TANPIN_DB` | JSON data file |

## What this does not claim

Tanpin is not a multi-tenant SaaS. When you bind `0.0.0.0` (Docker, a LAN), set `TANPIN_ADMIN_KEY` or create keys first — every non-local request needs one. Put TLS in front if you expose it beyond your own network.
