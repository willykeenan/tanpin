---
title: Tanpin
emoji: 📦
sdk: docker
app_port: 7860
license: mit
short_description: Item-by-item inventory that reorders itself
---

# Tanpin

Zero-dependency Node inventory: per-SKU demand forecasts, automatic purchase orders, supplier email, and delivery ETAs. REST API, MCP server, daemon, and dashboard.

This Space runs the open-source dashboard and API in Docker:

```
DEMO_MODE=1 PORT=7860 HOST=0.0.0.0 node bin/tanpin serve
```

Open the app, then click **Load demo data** for a convenience-store catalog and about 35 days of sales so the forecast and reorder engines have signal. The image sets `DEMO_MODE=1`: open reads, demo writes without a key, webhooks and SMTP off, reseed every 30 minutes. The Space's public hostname (`SPACE_HOST`) is trusted automatically.

- Health: `/api/health`
- Full state: `/api/state`
- OpenAPI: `/openapi.json`
- Agent guide: `/llms.txt`

Build from the Tanpin repository root (so `bin/`, `src/`, and `public/` are in the Docker context):

```bash
docker build -f space/Dockerfile -t tanpin .
docker run --rm -p 7860:7860 tanpin
```

Self-host, MCP configs, and the security model: see the project README. MIT license.
