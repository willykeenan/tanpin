# Security Policy

Tanpin is a local-first inventory server. The default bind address is `127.0.0.1`, CORS is an origin allowlist, and state-changing requests from another website need an API key.

## Reporting a vulnerability

Open a private GitHub security advisory on this repository. Do not file a public issue for a vulnerability that is still unpatched.

## What is in scope

- Cross-origin use of the local API (creating keys, wiping data, reading stock)
- SSRF through registered webhook URLs
- Auth bypass around `TANPIN_REQUIRE_API_KEY`, loopback, or `DEMO_MODE`
- Host-header / DNS-rebinding tricks against a loopback bind

## What this release already closes

A page the operator visits cannot create API keys or change data on a default install: the server refuses a foreign `Origin`, does not send `Access-Control-Allow-Origin: *`, requires a key for any cross-origin request, and serves the dashboard under a CSP without inline script. A reverse proxy on the same host does not make remote clients "local": forwarded requests need a key. Secrets are never returned by reads. Outbound webhooks (server and standalone daemon) refuse private, loopback, link-local, CGNAT and reserved destinations — validated on the address actually connected to — unless `TANPIN_ALLOW_PRIVATE_WEBHOOKS=1`.

See [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) for the full model, environment variables, and the optional integrations contract.
