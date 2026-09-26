'use strict';
// Tanpin server — pure Node HTTP. Serves the dashboard and the JSON API, and
// (unless disabled) runs the auto-management daemon in-process so a single
// `tanpin serve` boots the whole system. Zero npm dependencies.
//
// API surface (also served machine-readably at /openapi.json and /llms.txt):
//   * Versioned paths — /api/... and /api/v1/... are equivalent.
//   * Auth — Authorization: Bearer <key> or X-API-Key. Only DIRECT local
//     requests need no key by default: loopback TCP peer + loopback Host + no
//     forwarding header (a reverse proxy on the same host is not "local").
//     Cross-origin browser requests (reads too) always need a key. Set
//     TANPIN_REQUIRE_API_KEY=1 to force keys everywhere, and TANPIN_ADMIN_KEY
//     for an always-valid master key. Secrets are never returned by reads.
//   * Binds 127.0.0.1 by default (HOST overrides). CORS is an allowlist
//     (TANPIN_CORS_ORIGINS); Origin/Host are checked on every API request.
//     Every response carries a CSP without inline script.
//   * Outbound webhooks refuse private/loopback/link-local/CGNAT/reserved
//     destinations (engine/webhooks.js) unless TANPIN_ALLOW_PRIVATE_WEBHOOKS=1.
//   * DEMO_MODE=1: reads and demo-catalog writes open to anyone, everything
//     else refused, webhooks and SMTP off, reseeds every 30 minutes.
//   * Products are addressable by internal id OR by SKU everywhere.
//   * Idempotency-Key header on POST /sales and /purchase-orders gives safe
//     retries (24h replay window).
//   * TANPIN_PLUGIN loads an optional module that adds routes and usage limits
//     (see src/plugin.js and docs/plugins.md).
//   * Optional src/integrations/routes.js is mounted via register(route).
//   * GET /api/backtest is mounted when src/engine/backtest.js exists.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Store, newId } = require('./engine/store');
const manager = require('./engine/manager');
const eta = require('./engine/eta');
const webhooks = require('./engine/webhooks');
const netguard = require('./engine/netguard');
// Outbound webhook SSRF guard, demo-mode suppression and redirect refusal live
// in engine/webhooks.js + engine/netguard.js so the standalone daemon gets them
// too. The server only uses the synchronous URL check at registration time.
const { webhookUrlBlocked, normalizeHostname, ipv6Hextets } = netguard;
const csv = require('./engine/csv');
const { buildOpenApi } = require('./openapi');
const { startDaemon } = require('./daemon');
const { seed } = require('./seed');
const { resolveConfig } = require('./config');
const { loadPlugin, matchRoute, resolveLimits, isCap } = require('./plugin');
const pkg = require('../package.json');

const config = resolveConfig();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const plugin = loadPlugin(process.env.TANPIN_PLUGIN);
const DEFAULT_HOST = '127.0.0.1';
const DEMO_RESEED_MS = 30 * 60 * 1000;

// Every handler below references `store`, which resolves through
// AsyncLocalStorage: an embedding wrapper can run the request handler inside
// `storeContext.run(otherStore, ...)` to scope a request to a different store
// (e.g. one per tenant) without touching any handler. With no context set it
// is the plain file store.
const storeContext = new AsyncLocalStorage();
const baseStore = new Store(config.dbFile);
baseStore.load();
baseStore.outboxDir = config.outboxDir;
const store = new Proxy(baseStore, {
  get(target, prop) {
    const s = storeContext.getStore() || target;
    const v = s[prop];
    return typeof v === 'function' ? v.bind(s) : v;
  },
  set(target, prop, value) {
    (storeContext.getStore() || target)[prop] = value;
    return true;
  },
});

function isDemo() { return process.env.DEMO_MODE === '1'; }
function envFlag(...names) { return names.some((n) => process.env[n] === '1'); }
function adminKey() { return process.env.TANPIN_ADMIN_KEY || process.env.INVENTORY_ADMIN_KEY || ''; }
function requireApiKey() { return envFlag('TANPIN_REQUIRE_API_KEY', 'REQUIRE_API_KEY'); }

function corsOrigins() {
  return String(process.env.TANPIN_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseHostname(host) {
  const s = String(host || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end >= 0 ? s.slice(1, end) : s;
  }
  // Strip :port, but keep IPv6 without brackets as-is when no extra colon-port.
  const colon = s.lastIndexOf(':');
  if (colon > -1 && s.indexOf(':') === colon) return s.slice(0, colon);
  return s;
}

function isLoopbackHostname(hostname) {
  const h = normalizeHostname(hostname);
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (net.isIP(h) === 4) return h.split('.')[0] === '127';
  if (net.isIP(h) === 6) {
    const hx = ipv6Hextets(h);
    if (!hx) return false;
    if (hx.every((x, i) => x === (i === 7 ? 1 : 0))) return true; // ::1
    // IPv4-mapped / IPv4-compatible loopback (127.0.0.0/8)
    if (hx[0] === 0 && hx[1] === 0 && hx[2] === 0 && hx[3] === 0 && hx[4] === 0
        && (hx[5] === 0 || hx[5] === 0xffff) && (hx[6] >> 8) === 127) return true;
  }
  return false;
}

function isTrustedHostname(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  if (isLoopbackHostname(h)) return true;
  const bind = process.env.HOST || config.host || DEFAULT_HOST;
  if (bind && bind !== '0.0.0.0' && bind !== '::' && h === normalizeHostname(bind)) return true;
  // Hugging Face Spaces publish the public hostname as SPACE_HOST.
  if (process.env.SPACE_HOST && h === normalizeHostname(parseHostname(process.env.SPACE_HOST))) return true;
  for (const origin of corsOrigins()) {
    try {
      if (normalizeHostname(new URL(origin).hostname) === h) return true;
    } catch { /* ignore malformed allowlist entries */ }
  }
  return false;
}

function originIsSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === (req.headers.host || ''); }
  catch { return false; }
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, MCP, POS)
  try {
    const u = new URL(origin);
    if (corsOrigins().includes(origin)) return true;
    if (u.host !== (req.headers.host || '')) return false;
    return isTrustedHostname(u.hostname);
  } catch {
    return false;
  }
}

function hostForbidden(req) {
  const raw = req.headers.host;
  if (!raw) return 'Missing Host header';
  if (!isTrustedHostname(parseHostname(raw))) {
    return 'Host header is not an allowed name for this server';
  }
  return null;
}

// Sent on every response. The CSP forbids inline script and inline event
// handlers, so even an escaping bug in the dashboard cannot run injected
// markup such as <img onerror=...>.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function corsHeaders(res) {
  const headers = {
    ...SECURITY_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Idempotency-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const req = res && res.req;
  const origin = req && req.headers.origin;
  if (origin && originAllowed(req)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function isMutating(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function isMissingModule(err, spec) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') return false;
  const msg = String(err.message || '');
  const id = String(spec || '').replace(/^\.\//, '');
  return msg.includes(spec) || (id && msg.includes(id));
}

// Optional integrations — see docs/SECURITY-MODEL.md for the register(route) contract.
const extraRoutes = [];
function route(method, pathSpec, handler, opts) {
  // Accept both route(method, path, handler, opts) and route({ method, path, handler, public, summary }).
  if (method && typeof method === 'object') {
    ({ method, path: pathSpec, handler } = method);
    opts = { public: arguments[0].public, summary: arguments[0].summary };
  }
  if (typeof handler !== 'function') throw new Error('integrations route handler must be a function');
  extraRoutes.push({
    method: String(method || 'GET').toUpperCase(),
    path: pathSpec,
    handler,
    public: !!(opts && opts.public),
    summary: (opts && opts.summary) || null,
  });
}
try {
  const integ = require('./integrations/routes');
  if (integ && typeof integ.register === 'function') integ.register(route);
} catch (e) {
  if (!isMissingModule(e, './integrations/routes')) throw e;
}

function enforceDemoSettings() {
  if (!isDemo()) return;
  delete process.env.SMTP_HOST;
  const s = store.data.settings;
  if (s.autoSend || s.autoEmailAlerts) {
    s.autoSend = false;
    s.autoEmailAlerts = false;
    store.save();
  }
}

function demoWriteBlocked(method, p) {
  if (!isDemo()) return null;
  if (!isMutating(method)) return null;
  if (p === '/api/seed') return null;
  const allowed = [
    [/^\/api\/sales(\/bulk)?$/, ['POST']],
    [/^\/api\/adjust$/, ['POST']],
    [/^\/api\/purchase-orders(\/|$)/, ['POST']],
    [/^\/api\/hypotheses(\/|$)/, ['POST', 'DELETE']],
    [/^\/api\/daemon\/run$/, ['POST']],
    [/^\/api\/products\/[^/]+$/, ['PUT']],
    [/^\/api\/suppliers\/[^/]+$/, ['PUT']],
    [/^\/api\/settings$/, ['PUT']],
  ];
  for (const [re, methods] of allowed) {
    if (re.test(p) && methods.includes(method)) return null;
  }
  return 'DEMO_MODE only allows writes against the demo catalog (sales, adjustments, purchase orders, hypotheses). Creating products/suppliers, API keys, webhooks, reset, and SMTP are disabled.';
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// Compare via hashes so lengths never leak through timingSafeEqual's throw.
function timingSafeEq(a, b) {
  return crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

// Headers a reverse proxy (nginx, Caddy, cloudflared, a load balancer, the
// Hugging Face / Docker front ends) adds when it relays someone else's request.
const FORWARDING_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-forwarded-server', 'x-real-ip', 'x-client-ip', 'true-client-ip', 'cf-connecting-ip',
  'fastly-client-ip', 'x-cluster-client-ip', 'via',
];

function peerIsLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return isLoopbackHostname(a);
}

/**
 * The key-free "this machine" path. The TCP peer being 127.0.0.1 is NOT
 * enough: a reverse proxy on the same host always connects from loopback, so
 * every internet client would count as local. Require all three:
 *   * the TCP peer is loopback,
 *   * the Host header names a loopback host (localhost / 127.x / ::1), and
 *   * no forwarding header (Forwarded, X-Forwarded-*, X-Real-IP, Via, ...).
 */
function isLoopback(req) {
  if (!peerIsLoopback(req)) return false;
  const host = req.headers.host;
  if (!host || !isLoopbackHostname(parseHostname(host))) return false;
  for (const h of FORWARDING_HEADERS) {
    if (req.headers[h] !== undefined) return false;
  }
  return true;
}

function extractApiKey(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const x = req.headers['x-api-key'];
  return typeof x === 'string' && x.trim() ? x.trim() : null;
}

function authenticate(req, p) {
  const key = extractApiKey(req);
  if (key) {
    const admin = adminKey();
    if (admin && timingSafeEq(key, admin)) return { ok: true, via: 'admin' };
    const hash = sha256(key);
    const row = store.list('apiKeys').find((k) => !k.revoked && k.hash === hash);
    if (row) {
      // Throttle lastUsedAt persistence to one write per minute per key.
      if (!row.lastUsedAt || Date.now() - row.lastUsedAt > 60000) {
        row.lastUsedAt = Date.now();
        store.save();
      } else {
        row.lastUsedAt = Date.now();
      }
      return { ok: true, via: 'key', keyId: row.id, keyName: row.name };
    }
    return { ok: false, code: 'invalid_api_key', message: 'API key not recognized or revoked' };
  }
  if (isDemo()) {
    // Public demo: reads are open, and so are the writes the demo allows
    // (sales, adjustments, POs, hypotheses, seed, ...) — whoever the peer is.
    // Everything else still needs a key and is then refused by demoWriteBlocked.
    if (req.method === 'GET' || req.method === 'HEAD') return { ok: true, via: 'demo' };
    if (p && !demoWriteBlocked(req.method, p)) return { ok: true, via: 'demo' };
  }
  // Any browser request from another origin (read or write) needs a key —
  // including allowlisted TANPIN_CORS_ORIGINS. Loopback is not a bypass for
  // a page the user merely visited.
  if (req.headers.origin && !originIsSameOrigin(req)) {
    return {
      ok: false,
      code: 'missing_api_key',
      message: 'Browser requests from another origin require an API key.',
    };
  }
  if (isLoopback(req) && !requireApiKey()) {
    return { ok: true, via: 'loopback' };
  }
  return {
    ok: false,
    code: 'missing_api_key',
    message: 'Provide an API key via "Authorization: Bearer <key>" or "X-API-Key: <key>". Create keys in the dashboard (API tab) or POST /api/keys from localhost, or use TANPIN_ADMIN_KEY.',
  };
}

// ---------------------------------------------------------------------------
// Idempotency (24h replay cache for POSTs)
// ---------------------------------------------------------------------------
function idemLookup(req) {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') return null;
  const cut = Date.now() - 86400000;
  let pruned = false;
  for (const [k, v] of Object.entries(store.data.idempotency)) {
    if (!v || v.at < cut) { delete store.data.idempotency[k]; pruned = true; }
  }
  if (pruned) store.save();
  return { key, hit: store.data.idempotency[key] || null };
}

function idemStore(key, status, body) {
  store.data.idempotency[key] = { status, body, at: Date.now() };
  store.save();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;
  if (p === '/api/v1') p = '/api';
  else if (p.startsWith('/api/v1/')) p = '/api/' + p.slice('/api/v1/'.length);
  try {
    const isApi = p.startsWith('/api') || p === '/openapi.json';
    if (isApi) {
      const badHost = hostForbidden(req);
      if (badHost) return jsonErr(res, 403, 'host_forbidden', badHost);
      if (!originAllowed(req)) {
        return jsonErr(res, 403, 'origin_forbidden', 'Cross-origin request blocked');
      }
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(res));
      return res.end();
    }
    // Pick up rows another process (the standalone daemon, a second server)
    // committed since our last read, so reads are current and writes merge
    // against fresh data. Cheap: one PRAGMA data_version when nothing changed.
    if (isApi && typeof store.refresh === 'function') store.refresh();
    if (isDemo()) enforceDemoSettings();
    if (plugin && await runPluginRoutes(req, res, url, p)) return;
    if (await runExtraRoutes(req, res, url, p)) return;
    if (p === '/openapi.json') {
      return json(res, 200, buildOpenApi({ baseUrl: baseUrlOf(req), version: pkg.version }));
    }
    if (p === '/api') return json(res, 200, apiIndex());
    if (p.startsWith('/api/')) return await api(req, res, url, p);
    return serveStatic(req, res, p);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err && err.expose) return jsonErr(res, err.status, err.code, err.message);
    console.error('request error', err);
    jsonErr(res, 500, 'internal_error', String((err && err.message) || err));
  }
}

const server = http.createServer(handler);

/**
 * Plugin routes run before the core routes, so a plugin can add endpoints and
 * also wrap or replace core ones. Returns true when a plugin route handled the
 * request. A handler that returns `false` without writing a response passes
 * the request on to the next matching route (and finally to the core API).
 */
async function runPluginRoutes(req, res, url, p) {
  const raw = () => rawBody(req);
  for (const route of plugin.routes) {
    const hit = matchRoute(route, req.method, p);
    if (!hit) continue;
    let auth = null;
    if (!route.public) {
      auth = authenticate(req, p);
      if (!auth.ok) { jsonErr(res, 401, auth.code, auth.message); return true; }
    }
    const demoErr = route.public ? null : demoWriteBlocked(req.method, p);
    if (demoErr) { jsonErr(res, 403, 'demo_mode', demoErr); return true; }
    const ctx = {
      req, res, url, path: p, method: req.method,
      params: hit.params, match: hit.match || null,
      store, auth, baseUrl: baseUrlOf(req),
      rawBody: raw,
      body: async () => parseJsonBody(await raw()),
      json: (status, obj, headers) => json(res, status, obj, headers),
      error: (status, code, message) => jsonErr(res, status, code, message),
      text: (status, s, contentType) => text(res, status, s, contentType),
      limits: () => resolveLimits(plugin, store),
    };
    const out = await route.handler(ctx);
    if (res.headersSent || res.writableEnded) return true;
    if (out === false) continue;
    if (out !== undefined) { json(res, 200, out); return true; }
    jsonErr(res, 500, 'plugin_no_response', `Plugin route ${req.method} ${p} returned without responding`);
    return true;
  }
  return false;
}

async function runExtraRoutes(req, res, url, p) {
  if (!extraRoutes.length) return false;
  const raw = () => rawBody(req);
  for (const extra of extraRoutes) {
    const hit = matchRoute(extra, req.method, p);
    if (!hit) continue;
    let auth = null;
    if (!extra.public) {
      auth = authenticate(req, p);
      if (!auth.ok) { jsonErr(res, 401, auth.code, auth.message); return true; }
    }
    const demoErr = extra.public ? null : demoWriteBlocked(req.method, p);
    if (demoErr) { jsonErr(res, 403, 'demo_mode', demoErr); return true; }
    const ctx = {
      req, res, url, path: p, method: req.method,
      params: hit.params, match: hit.match || null,
      store, auth, baseUrl: baseUrlOf(req),
      rawBody: raw,
      body: async () => parseJsonBody(await raw()),
      json: (status, obj, headers) => json(res, status, obj, headers),
      error: (status, code, message) => jsonErr(res, status, code, message),
      text: (status, s, contentType) => text(res, status, s, contentType),
      limits: () => resolveLimits(plugin, store),
    };
    const out = await extra.handler(ctx);
    if (res.headersSent || res.writableEnded) return true;
    if (out === false) continue;
    if (out !== undefined) { json(res, 200, out); return true; }
    jsonErr(res, 500, 'integration_no_response', `Integration route ${req.method} ${p} returned without responding`);
    return true;
  }
  return false;
}

async function api(req, res, url, p) {
  const method = req.method;
  const seg = p.split('/').filter(Boolean); // ['api', ...]

  // --- public, unauthenticated ---
  if (p === '/api/health' && method === 'GET') {
    return json(res, 200, {
      ok: true,
      name: 'tanpin',
      version: pkg.version,
      time: Date.now(),
      skus: store.list('products').length,
      daemonLastRun: store.list('daemonLog')[0]?.at || null,
      demo: isDemo(),
    });
  }

  const auth = authenticate(req, p);
  if (!auth.ok) return jsonErr(res, 401, auth.code, auth.message);

  const demoErr = demoWriteBlocked(method, p);
  if (demoErr) return jsonErr(res, 403, 'demo_mode', demoErr);

  if (p === '/api/backtest' && method === 'GET') {
    let mod;
    try {
      mod = require('./engine/backtest');
    } catch (e) {
      if (isMissingModule(e, './engine/backtest')) {
        return jsonErr(res, 404, 'not_found', 'Backtest engine is not available on this build');
      }
      throw e;
    }
    if (!mod || typeof mod.backtest !== 'function') {
      return jsonErr(res, 404, 'not_found', 'Backtest engine is not available on this build');
    }
    const opts = {};
    if (url.searchParams.get('horizon')) opts.horizon = Number(url.searchParams.get('horizon'));
    if (url.searchParams.get('window')) opts.window = Number(url.searchParams.get('window'));
    // Scoring replays every SKU's history; run it on a worker thread so a large
    // catalog does not block sales, webhooks and the dashboard meanwhile.
    const result = typeof mod.backtestInWorker === 'function'
      ? await mod.backtestInWorker(store, opts)
      : await mod.backtest(store, opts);
    return json(res, 200, result);
  }

  // --- dashboard state ---
  if (p === '/api/state' && method === 'GET') {
    return json(res, 200, buildState());
  }
  if (p === '/api/seed' && method === 'POST') {
    seed(store);
    if (isDemo()) {
      store.data.settings.autoSend = false;
      store.data.settings.autoEmailAlerts = false;
      store.save();
    }
    await manager.runCycle(store, { trigger: 'manual' });
    return json(res, 200, buildState());
  }
  if (p === '/api/reset' && method === 'POST') {
    store.reset();
    return json(res, 200, buildState());
  }

  // --- products ---
  if (p === '/api/products' && method === 'GET') {
    let out = store.list('products').map((x) => enrichProduct(x));
    if (url.searchParams.get('low_stock') === 'true') out = out.filter((x) => x.belowReorder);
    if (url.searchParams.get('category')) out = out.filter((x) => x.category === url.searchParams.get('category'));
    return json(res, 200, out);
  }
  if (p === '/api/products/bulk' && method === 'POST') {
    const b = await body(req);
    const items = Array.isArray(b) ? b : b.products;
    if (!Array.isArray(items)) return jsonErr(res, 400, 'invalid_request', 'Send an array of products (or {products: [...]})');
    return json(res, 201, await importProducts(items));
  }
  if (p === '/api/products' && method === 'POST') {
    const b = await body(req);
    if (!b.sku || !b.name) return jsonErr(res, 400, 'invalid_request', 'sku and name are required');
    if (store.list('products').some((x) => x.sku === b.sku)) {
      return jsonErr(res, 409, 'duplicate_sku', `A product with SKU ${b.sku} already exists`);
    }
    const lim = await resolveLimits(plugin, store);
    if (isCap(lim.maxProducts) && store.list('products').length + 1 > lim.maxProducts) {
      return jsonErr(res, 402, 'limit_reached', limitMessage(`This instance allows at most ${lim.maxProducts} products.`, lim));
    }
    const doc = store.insert('products', normalizeProduct(b));
    manager.recomputeProduct(store, doc); store.save();
    return json(res, 201, doc);
  }
  if (seg[1] === 'products' && seg[2] && seg[2] !== 'bulk') {
    const prod = resolveProduct(safeDecode(seg[2]));
    if (!prod) return jsonErr(res, 404, 'product_not_found', 'No product with that id or SKU');
    if (method === 'GET') return json(res, 200, enrichProduct(prod));
    if (method === 'PUT') {
      const b = await body(req);
      Object.assign(prod, normalizeProduct(b, true), { updatedAt: Date.now() });
      manager.recomputeProduct(store, prod); store.save();
      return json(res, 200, prod);
    }
    if (method === 'DELETE') {
      return json(res, 200, { removed: store.remove('products', prod.id) });
    }
  }

  // --- sales ---
  if (p === '/api/sales/bulk' && method === 'POST') {
    const idem = idemLookup(req);
    if (idem?.hit) return json(res, idem.hit.status, idem.hit.body, { 'Idempotency-Replayed': 'true' });
    const b = await body(req);
    const items = Array.isArray(b) ? b : b.sales;
    if (!Array.isArray(items)) return jsonErr(res, 400, 'invalid_request', 'Send an array of sales (or {sales: [...]})');
    // One write transaction and one save for the whole batch.
    const results = recordSales(items);
    const resp = {
      recorded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
    if (idem) idemStore(idem.key, 201, resp);
    return json(res, 201, resp);
  }
  if (p === '/api/sales' && method === 'POST') {
    const idem = idemLookup(req);
    if (idem?.hit) return json(res, idem.hit.status, idem.hit.body, { 'Idempotency-Replayed': 'true' });
    const b = await body(req);
    const r = recordSale(b);
    if (!r.ok) return jsonErr(res, 404, 'product_not_found', r.error);
    const resp = { product: r.product };
    if (idem) idemStore(idem.key, 201, resp);
    return json(res, 201, resp);
  }

  // --- manual stock adjustment ---
  if (p === '/api/adjust' && method === 'POST') {
    const b = await body(req);
    const prod = resolveProduct(b.productId || b.sku);
    if (!prod) return jsonErr(res, 404, 'product_not_found', 'No product with that id or SKU');
    // Applied as a delta against the freshest row inside the write transaction.
    const updated = manager.adjustStock(store, prod, Number(b.delta) || 0, b.reason || null);
    if (!updated) return jsonErr(res, 404, 'product_not_found', 'No product with that id or SKU');
    return json(res, 201, { product: updated });
  }

  // --- movements (audit trail) ---
  if (p === '/api/movements' && method === 'GET') {
    let rows = store.list('movements');
    const ref = url.searchParams.get('product');
    if (ref) {
      const prod = resolveProduct(ref);
      if (!prod) return jsonErr(res, 404, 'product_not_found', 'No product with that id or SKU');
      rows = rows.filter((m) => m.productId === prod.id);
    }
    const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 100);
    const bySku = new Map(store.list('products').map((x) => [x.id, x.sku]));
    return json(res, 200, rows.slice(-limit).reverse().map((m) => ({ ...m, sku: bySku.get(m.productId) || null })));
  }

  // --- suppliers ---
  if (p === '/api/suppliers' && method === 'GET') return json(res, 200, store.list('suppliers'));
  if (p === '/api/suppliers' && method === 'POST') {
    const b = await body(req);
    if (!b.name) return jsonErr(res, 400, 'invalid_request', 'name is required');
    return json(res, 201, store.insert('suppliers', normalizeSupplier(b)));
  }
  if (seg[1] === 'suppliers' && seg[2] && method === 'PUT') {
    const b = await body(req);
    const doc = store.update('suppliers', seg[2], normalizeSupplier(b, true));
    return doc ? json(res, 200, doc) : jsonErr(res, 404, 'not_found', 'Supplier not found');
  }
  if (seg[1] === 'suppliers' && seg[2] && method === 'DELETE') {
    return json(res, 200, { removed: store.remove('suppliers', seg[2]) });
  }

  // --- reorder recommendations (dry run of the daemon's ordering pass) ---
  if (p === '/api/recommendations' && method === 'GET') {
    manager.recomputeAll(store);
    store.save();
    const { recommendations, notes } = manager.computeRecommendations(store);
    return json(res, 200, { recommendations, notes, generatedAt: Date.now() });
  }

  // --- purchase orders ---
  if (p === '/api/purchase-orders' && method === 'GET') {
    let rows = store.list('purchaseOrders');
    const status = url.searchParams.get('status');
    if (status === 'open') rows = rows.filter((po) => po.status !== 'received' && po.status !== 'cancelled');
    else if (status) rows = rows.filter((po) => po.status === status);
    const now = Date.now();
    return json(res, 200, rows.map((po) => ({ ...po, etaLabel: po.eta ? eta.describeEta(po.eta, now) : null })));
  }
  if (p === '/api/purchase-orders' && method === 'POST') {
    const idem = idemLookup(req);
    if (idem?.hit) return json(res, idem.hit.status, idem.hit.body, { 'Idempotency-Replayed': 'true' });
    const b = await body(req);
    const supplier = store.find('suppliers', b.supplierId) ||
      store.list('suppliers').find((s) => s.name === b.supplierId);
    if (!supplier) return jsonErr(res, 400, 'invalid_request', 'supplierId (id or exact name) is required');

    let lines;
    if (b.fromRecommendations) {
      manager.recomputeAll(store);
      const { recommendations } = manager.computeRecommendations(store);
      const rec = recommendations.find((r) => r.supplierId === supplier.id);
      if (!rec) return jsonErr(res, 422, 'nothing_to_order', 'No recommended lines for this supplier right now');
      lines = rec.lines;
    } else {
      lines = (b.lines || []).map((l) => {
        const prod = resolveProduct(l.productId || l.sku);
        if (!prod) return null;
        return { productId: prod.id, sku: prod.sku, name: prod.name, qty: Number(l.qty) || 0, unitCost: prod.unitCost || 0 };
      }).filter((l) => l && l.qty > 0);
    }
    if (!lines.length) return jsonErr(res, 400, 'invalid_request', 'At least one line with a known product and qty > 0 is required');

    const total = lines.reduce((t, l) => t + l.qty * l.unitCost, 0);
    const { eta: etaTs, leadTimeDays } = eta.etaForOrder({ orderedAt: Date.now(), supplier, settings: store.data.settings });
    const po = store.insert('purchaseOrders', {
      supplierId: supplier.id, supplierName: supplier.name, status: 'draft',
      lines, total: round(total), auto: false, orderedAt: Date.now(), eta: etaTs, leadTimeDays,
    });
    webhooks.emit(store, 'po.created', { purchaseOrder: po });
    if (b.autoSend && !isDemo()) {
      if (supplier.email) await manager.emailPurchaseOrder(store, po, supplier);
      if (manager.transitionOrder(store, po, ['draft'], { status: 'sent', sentAt: Date.now() }).ok) {
        webhooks.emit(store, 'po.sent', { purchaseOrder: store.find('purchaseOrders', po.id) });
      }
    }
    const resp = store.find('purchaseOrders', po.id);
    if (idem) idemStore(idem.key, 201, resp);
    return json(res, 201, resp);
  }
  if (seg[1] === 'purchase-orders' && seg[2] && !seg[3] && method === 'GET') {
    const po = store.find('purchaseOrders', seg[2]);
    if (!po) return jsonErr(res, 404, 'not_found', 'Purchase order not found');
    return json(res, 200, { ...po, etaLabel: po.eta ? eta.describeEta(po.eta) : null });
  }
  if (seg[1] === 'purchase-orders' && seg[2] && seg[3] && method === 'POST') {
    const po = store.find('purchaseOrders', seg[2]);
    if (!po) return jsonErr(res, 404, 'not_found', 'Purchase order not found');
    // Status changes re-check the PO's current status inside the write
    // transaction, so a daemon (or second server) acting on the same PO in
    // another process cannot make us receive it twice or cancel a receipt.
    const conflict = (status) => (status === 'received'
      ? jsonErr(res, 409, 'already_received', 'This PO was already received')
      : status === 'cancelled'
        ? jsonErr(res, 409, 'cancelled', 'This PO was cancelled')
        : jsonErr(res, 404, 'not_found', 'Purchase order not found'));
    if (seg[3] === 'send') {
      if (po.status === 'received' || po.status === 'cancelled') return conflict(po.status);
      const supplier = store.find('suppliers', po.supplierId);
      let emailed = null;
      if (!isDemo() && supplier && supplier.email) emailed = await manager.emailPurchaseOrder(store, po, supplier);
      const t = manager.transitionOrder(store, po, ['draft', 'sent', 'in_transit'], { status: 'sent', sentAt: Date.now() });
      if (!t.ok) return conflict(t.status);
      const updated = store.find('purchaseOrders', po.id);
      webhooks.emit(store, 'po.sent', { purchaseOrder: updated });
      return json(res, 200, { po: updated, emailed });
    }
    if (seg[3] === 'receive') {
      const received = manager.receiveOrder(store, po);
      if (!received) return conflict(manager.receiveOrder.lastStatus);
      return json(res, 200, { po: received });
    }
    if (seg[3] === 'cancel') {
      const t = manager.transitionOrder(store, po, ['draft', 'sent', 'in_transit'], { status: 'cancelled' });
      if (!t.ok) {
        if (t.status === 'received') return jsonErr(res, 409, 'already_received', 'Received POs cannot be cancelled');
        return conflict(t.status);
      }
      webhooks.emit(store, 'po.cancelled', { purchaseOrder: store.find('purchaseOrders', po.id) });
      return json(res, 200, { po: store.find('purchaseOrders', po.id) });
    }
  }

  // --- hypotheses (forward-looking demand bumps) ---
  if (p === '/api/hypotheses' && method === 'GET') return json(res, 200, store.list('hypotheses'));
  if (p === '/api/hypotheses' && method === 'POST') {
    const b = await body(req);
    const prod = b.productId || b.sku ? resolveProduct(b.productId || b.sku) : null;
    const doc = store.insert('hypotheses', {
      note: typeof b.note === 'string' ? b.note : '', multiplier: Number(b.multiplier) || 1,
      scope: {
        productId: prod ? prod.id : null,
        category: typeof b.category === 'string' && b.category ? b.category : null,
      },
      startsAt: manager.toTimestamp(b.startsAt, Date.now()),
      endsAt: manager.toTimestamp(b.endsAt, Date.now() + 7 * 86400000),
    });
    // Forecasts and reorder points move immediately, not at the next cycle.
    manager.recomputeAll(store);
    store.save();
    return json(res, 201, doc);
  }
  if (seg[1] === 'hypotheses' && seg[2] && method === 'DELETE') {
    const removed = store.remove('hypotheses', seg[2]);
    if (removed) { manager.recomputeAll(store); store.save(); }
    return json(res, 200, { removed });
  }

  // --- settings ---
  if (p === '/api/settings' && method === 'GET') return json(res, 200, publicSettings(store.data.settings));
  if (p === '/api/settings' && method === 'PUT') {
    const b = await body(req);
    if (isDemo()) {
      delete b.autoSend;
      delete b.autoEmailAlerts;
      delete b.notifyEmail;
      delete b.integrations; // no provider secrets on a public demo
    }
    if (b.autoSend === true) {
      const lim = await resolveLimits(plugin, store);
      if (lim.autoSend === false) {
        return jsonErr(res, 402, 'limit_reached', limitMessage('Auto-emailing purchase orders to suppliers is not enabled on this instance.', lim));
      }
    }
    const tzChanged = b.timezone !== undefined && b.timezone !== store.data.settings.timezone;
    applySettingsPatch(store.data.settings, b);
    if (isDemo()) {
      store.data.settings.autoSend = false;
      store.data.settings.autoEmailAlerts = false;
    }
    // The store timezone decides calendar-day buckets: recompute forecasts.
    if (tzChanged) manager.recomputeAll(store);
    store.save();
    return json(res, 200, publicSettings(store.data.settings));
  }

  // --- daemon ---
  if (p === '/api/daemon/run' && method === 'POST') {
    const summary = await manager.runCycle(store, { trigger: 'manual' });
    return json(res, 200, summary);
  }
  if (p === '/api/daemon/log' && method === 'GET') return json(res, 200, store.list('daemonLog'));
  if (p === '/api/outbox' && method === 'GET') return json(res, 200, store.list('outbox'));

  // --- API keys ---
  if (p === '/api/keys' && method === 'GET') {
    return json(res, 200, store.list('apiKeys').map(maskKey));
  }
  if (p === '/api/keys' && method === 'POST') {
    const b = await body(req);
    const lim = await resolveLimits(plugin, store);
    if (isCap(lim.maxApiKeys)) {
      const active = store.list('apiKeys').filter((k) => !k.revoked).length;
      if (active >= lim.maxApiKeys) {
        return jsonErr(res, 402, 'limit_reached', limitMessage(`This instance allows at most ${lim.maxApiKeys} active API key${lim.maxApiKeys === 1 ? '' : 's'}.`, lim));
      }
    }
    const raw = 'ti_' + crypto.randomBytes(24).toString('hex');
    const doc = store.insert('apiKeys', {
      name: b.name || 'API key',
      prefix: raw.slice(0, 11),
      hash: sha256(raw),
      revoked: false,
    });
    return json(res, 201, {
      ...maskKey(doc),
      key: raw,
      notice: 'Store this key now — it is shown only once and is stored hashed.',
    });
  }
  if (seg[1] === 'keys' && seg[2] && method === 'DELETE') {
    const doc = store.update('apiKeys', seg[2], { revoked: true });
    return doc ? json(res, 200, maskKey(doc)) : jsonErr(res, 404, 'not_found', 'Key not found');
  }

  // --- webhooks ---
  if (p === '/api/webhooks' && method === 'GET') {
    return json(res, 200, {
      webhooks: store.list('webhooks').map(publicWebhook),
      events: webhooks.EVENTS,
      recentDeliveries: store.list('webhookLog').slice(0, 20),
    });
  }
  if (p === '/api/webhooks' && method === 'POST') {
    const b = await body(req);
    if (!/^https?:\/\//.test(b.url || '')) return jsonErr(res, 400, 'invalid_request', 'url must be an http(s) URL');
    const blocked = webhookUrlBlocked(b.url);
    if (blocked) return jsonErr(res, 400, 'invalid_request', blocked);
    const events = Array.isArray(b.events) && b.events.length ? b.events : ['*'];
    const bad = events.filter((e) => e !== '*' && !webhooks.EVENTS.includes(e) && e !== 'webhook.test');
    if (bad.length) return jsonErr(res, 400, 'invalid_request', `Unknown events: ${bad.join(', ')}. Valid: * ${webhooks.EVENTS.join(' ')}`);
    const doc = store.insert('webhooks', {
      url: b.url,
      events,
      secret: b.secret || crypto.randomBytes(16).toString('hex'),
      active: true,
    });
    // The signing secret is returned once, here, like an API key.
    return json(res, 201, {
      ...publicWebhook(doc),
      secret: doc.secret,
      notice: 'Store this signing secret now — later reads only report hasSecret.',
    });
  }
  if (seg[1] === 'webhooks' && seg[2] && seg[3] === 'test' && method === 'POST') {
    const hook = store.find('webhooks', seg[2]);
    if (!hook) return jsonErr(res, 404, 'not_found', 'Webhook not found');
    const entry = await webhooks.deliver(store, hook, 'webhook.test', { message: 'Test delivery from Tanpin', at: Date.now() });
    return json(res, 200, { delivery: entry });
  }
  if (seg[1] === 'webhooks' && seg[2] && method === 'DELETE') {
    return json(res, 200, { removed: store.remove('webhooks', seg[2]) });
  }

  // --- CSV import / export ---
  if (p === '/api/export/products.csv' && method === 'GET') {
    const supName = new Map(store.list('suppliers').map((s) => [s.id, s.name]));
    const rows = store.list('products').map((x) => ({ ...x, supplierName: supName.get(x.supplierId) || '' }));
    const cols = ['sku', 'name', 'category', 'supplierName', 'unitCost', 'price', 'currentStock', 'leadTimeDays', 'packSize', 'minOrderQty', 'avgDailyDemand', 'reorderPoint', 'safetyStock', 'abcClass'];
    return text(res, 200, csv.toCsv(rows, cols), 'text/csv; charset=utf-8');
  }
  if (p === '/api/export/movements.csv' && method === 'GET') {
    const bySku = new Map(store.list('products').map((x) => [x.id, x.sku]));
    const rows = store.list('movements').map((m) => ({
      ...m, sku: bySku.get(m.productId) || '', atIso: new Date(m.at).toISOString(),
    }));
    return text(res, 200, csv.toCsv(rows, ['id', 'sku', 'productId', 'type', 'qty', 'at', 'atIso', 'ref']), 'text/csv; charset=utf-8');
  }
  if (p === '/api/import/products' && method === 'POST') {
    const raw = await rawBody(req);
    let items;
    try {
      const parsed = sanitizeJson(JSON.parse(raw));
      items = Array.isArray(parsed) ? parsed : parsed.products;
    } catch {
      items = csv.parseCsv(raw);
    }
    if (!Array.isArray(items) || !items.length) {
      return jsonErr(res, 400, 'invalid_request', 'Send a JSON array of products or CSV text with a header row (sku,name,... columns)');
    }
    return json(res, 201, await importProducts(items));
  }

  return jsonErr(res, 404, 'unknown_endpoint', `No route for ${method} ${p}. See /openapi.json or GET /api for the endpoint list.`);
}

// ---------------------------------------------------------------------------
// Shared operations
// ---------------------------------------------------------------------------
function resolveProduct(ref) {
  if (!ref) return null;
  return store.find('products', ref) || store.list('products').find((x) => x.sku === ref) || null;
}

/** Record sales through the engine (delta-in-transaction, one save per batch). */
function recordSales(items) {
  return manager.recordSales(store, items).map((r) => (r.ok
    ? { ok: true, product: enrichProduct(r.product) }
    : { ok: false, error: r.error, sku: r.sku }));
}

function recordSale(b) {
  return recordSales([b || {}])[0];
}

/** Error text for a plugin limit, plus the plugin's own hint (e.g. how to upgrade). */
function limitMessage(base, lim) {
  return lim && typeof lim.message === 'string' && lim.message ? `${base} ${lim.message}` : base;
}

function newProductId() { return newId('products'); }

/** Upsert products by SKU (used by bulk endpoint + CSV import). One save at the end. */
async function importProducts(items) {
  let created = 0, updated = 0, suppliersCreated = 0, skipped = 0;
  const errors = [];
  const lim = await resolveLimits(plugin, store);
  const maxProducts = isCap(lim.maxProducts) ? lim.maxProducts : Infinity;
  const movementIndex = manager.movementsByProduct(store);
  for (const item of items) {
    if (!item || !item.sku) { skipped++; errors.push('Row missing sku'); continue; }
    let supplierId = item.supplierId || null;
    if (!supplierId && item.supplierName) {
      let sup = store.list('suppliers').find((s) => s.name === item.supplierName);
      if (!sup) { sup = store.insert('suppliers', normalizeSupplier({ name: item.supplierName })); suppliersCreated++; }
      supplierId = sup.id;
    }
    const patch = normalizeProduct({ ...item, supplierId }, true);
    const existing = store.list('products').find((x) => x.sku === item.sku);
    if (existing) {
      Object.assign(existing, patch, { updatedAt: Date.now() });
      manager.recomputeProduct(store, existing, { movements: movementIndex });
      updated++;
    } else {
      if (!item.name) { skipped++; errors.push(`${item.sku}: new product needs a name`); continue; }
      if (store.list('products').length >= maxProducts) {
        skipped++; errors.push(limitMessage(`${item.sku}: product limit (${maxProducts}) reached.`, lim)); continue;
      }
      const doc = store.data.products[store.data.products.push({
        ...normalizeProduct({}), ...patch, sku: item.sku, name: item.name, id: newProductId(), createdAt: Date.now(),
      }) - 1];
      manager.recomputeProduct(store, doc, { movements: movementIndex });
      created++;
    }
  }
  store.save();
  return { created, updated, suppliersCreated, skipped, errors: errors.slice(0, 20) };
}

// ---------------------------------------------------------------------------
// Dashboard aggregation
// ---------------------------------------------------------------------------
function enrichProduct(x) {
  const onOrder = manager.onOrderQty(store, x.id);
  const position = (x.currentStock || 0) + onOrder;
  const below = position <= (x.reorderPoint || 0);
  const daysOfSupply = x.avgDailyDemand > 0 ? (x.currentStock || 0) / x.avgDailyDemand : null;
  return {
    ...x, onOrder, stockPosition: position, belowReorder: below,
    daysOfSupply: daysOfSupply == null ? null : round(daysOfSupply, 1),
  };
}

function maskKey(k) {
  return { id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null, revoked: !!k.revoked };
}

// ---------------------------------------------------------------------------
// Secret masking. Nothing that can sign or forge a request (webhook signing
// secrets, provider webhook secrets, API tokens) is ever returned by a read.
// A secret field `x` is replaced by `hasX: true`.
// ---------------------------------------------------------------------------
const SECRET_FIELD = /(secret|signaturekey|token|password|passwd|apikey|api_key|accesskey|privatekey)$/i;

function hasFlag(k) { return 'has' + k.charAt(0).toUpperCase() + k.slice(1); }

function maskSecrets(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((x) => maskSecrets(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELD.test(k) && v != null && typeof v !== 'object') {
      out[hasFlag(k)] = v !== '';
    } else {
      out[k] = maskSecrets(v, depth + 1);
    }
  }
  return out;
}

function publicSettings(settings) {
  return maskSecrets(settings || {});
}

function publicWebhook(h) {
  const { secret, ...rest } = h || {};
  return { ...rest, url: webhooks.redactUrl(rest.url), hasSecret: !!secret };
}

/**
 * Shallow settings merge, except `integrations`, which merges per provider so a
 * client that read the masked view (hasWebhookSecret: true) and PUTs it back
 * does not wipe the stored secrets. Send a secret field as null or '' to clear it.
 */
function applySettingsPatch(settings, b) {
  const { integrations, ...rest } = b || {};
  for (const [k, v] of Object.entries(rest)) {
    if (/^has[A-Z]/.test(k) && typeof v === 'boolean') continue; // masked read-back marker
    settings[k] = v;
  }
  if (integrations && typeof integrations === 'object' && !Array.isArray(integrations)) {
    const cur = settings.integrations && typeof settings.integrations === 'object' ? settings.integrations : {};
    const next = { ...cur };
    for (const [provider, patch] of Object.entries(integrations)) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
      const merged = { ...(cur[provider] && typeof cur[provider] === 'object' ? cur[provider] : {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (/^has[A-Z]/.test(k) && typeof v === 'boolean') continue; // masked read-back marker
        if ((v === null || v === '') && SECRET_FIELD.test(k)) { delete merged[k]; continue; }
        merged[k] = v;
      }
      next[provider] = merged;
    }
    settings.integrations = next;
  }
  return settings;
}

function buildState() {
  const products = store.list('products');
  const now = Date.now();
  let stockValue = 0, retailValue = 0, lowStock = 0, deadStock = 0;
  const enriched = products.map((x) => {
    const e = enrichProduct(x);
    stockValue += (x.currentStock || 0) * (x.unitCost || 0);
    retailValue += (x.currentStock || 0) * (x.price || 0);
    if (e.belowReorder) lowStock += 1;
    if ((x.currentStock || 0) > 0 && (x.avgDailyDemand || 0) <= 0) deadStock += 1;
    return e;
  });
  const openPOs = store.list('purchaseOrders').filter((po) => po.status !== 'received' && po.status !== 'cancelled');
  const incoming = openPOs.map((po) => ({ ...po, etaLabel: po.eta ? eta.describeEta(po.eta, now) : null }));

  return {
    version: pkg.version,
    settings: publicSettings(store.data.settings),
    kpis: {
      skuCount: products.length,
      stockValue: round(stockValue),
      retailValue: round(retailValue),
      lowStock,
      deadStock,
      openPOs: openPOs.length,
      incomingUnits: openPOs.reduce((t, po) => t + (po.lines || []).reduce((s, l) => s + l.qty, 0), 0),
    },
    products: enriched,
    suppliers: store.list('suppliers'),
    purchaseOrders: incoming,
    allPurchaseOrders: store.list('purchaseOrders').slice(-50).reverse(),
    hypotheses: store.list('hypotheses'),
    daemonLog: store.list('daemonLog').slice(0, 20),
    outbox: store.list('outbox').slice(0, 30),
    apiKeys: store.list('apiKeys').map(maskKey),
    webhooks: store.list('webhooks').map(publicWebhook),
    webhookLog: store.list('webhookLog').slice(0, 20),
    webhookEvents: webhooks.EVENTS,
    serverTime: now,
    demo: isDemo(),
  };
}

// The endpoint index served at GET /api. test/contract.test.js checks that it
// and openapi.js document exactly the same set of routes.
const ENDPOINTS = [
  ['GET', '/api/health', 'Liveness + version (no auth)'],
  ['GET', '/api/backtest', 'Replay the reorder engine against recorded sales (when built)'],
  ['GET', '/api/state', 'Everything: KPIs, products, POs, suppliers, logs'],
  ['POST', '/api/seed', 'Replace all data with the demo store (destructive)'],
  ['POST', '/api/reset', 'Wipe all data (destructive)'],
  ['GET', '/api/products?low_stock=true&category=', 'List products (filterable)'],
  ['POST', '/api/products', 'Create product'],
  ['GET', '/api/products/{idOrSku}', 'Get one product'],
  ['PUT', '/api/products/{idOrSku}', 'Update product'],
  ['DELETE', '/api/products/{idOrSku}', 'Delete product'],
  ['POST', '/api/products/bulk', 'Bulk upsert products by SKU'],
  ['POST', '/api/sales', 'Record a sale (decrements stock; accepts sku)'],
  ['POST', '/api/sales/bulk', 'Record many sales at once'],
  ['POST', '/api/adjust', 'Manual stock adjustment (+/- delta)'],
  ['GET', '/api/movements?product=&limit=', 'Stock movement audit trail'],
  ['GET', '/api/recommendations', 'What should be ordered right now (dry run)'],
  ['GET', '/api/purchase-orders?status=open', 'List purchase orders with ETAs'],
  ['POST', '/api/purchase-orders', 'Create PO (lines by sku, or fromRecommendations)'],
  ['GET', '/api/purchase-orders/{id}', 'Get one purchase order'],
  ['POST', '/api/purchase-orders/{id}/send', 'Send + email PO to supplier'],
  ['POST', '/api/purchase-orders/{id}/receive', 'Receive PO into stock'],
  ['POST', '/api/purchase-orders/{id}/cancel', 'Cancel PO'],
  ['GET', '/api/suppliers', 'List suppliers'],
  ['POST', '/api/suppliers', 'Create supplier (lead time, delivery windows, cut-off)'],
  ['PUT', '/api/suppliers/{id}', 'Update supplier'],
  ['DELETE', '/api/suppliers/{id}', 'Delete supplier'],
  ['GET', '/api/hypotheses', 'List demand hypotheses'],
  ['POST', '/api/hypotheses', 'Add demand hypothesis (event/weather multiplier)'],
  ['DELETE', '/api/hypotheses/{id}', 'Remove demand hypothesis'],
  ['POST', '/api/daemon/run', 'Run a full auto-management cycle now'],
  ['GET', '/api/daemon/log', 'Recent cycle summaries'],
  ['GET', '/api/outbox', 'Emails the system has sent'],
  ['GET', '/api/settings', 'Read settings'],
  ['PUT', '/api/settings', 'Update settings (service level, automation toggles...)'],
  ['GET', '/api/keys', 'List API keys (masked)'],
  ['POST', '/api/keys', 'Create API key (returned once)'],
  ['DELETE', '/api/keys/{id}', 'Revoke API key'],
  ['GET', '/api/webhooks', 'List webhooks + recent deliveries + event names'],
  ['POST', '/api/webhooks', 'Register webhook (HMAC-signed deliveries)'],
  ['POST', '/api/webhooks/{id}/test', 'Fire a test delivery'],
  ['DELETE', '/api/webhooks/{id}', 'Delete webhook'],
  ['GET', '/api/export/products.csv', 'Export products as CSV'],
  ['GET', '/api/export/movements.csv', 'Export the movement audit trail as CSV'],
  ['POST', '/api/import/products', 'Import products (JSON array or CSV)'],
].map(([method, p, summary]) => ({ method, path: p, summary }));

function apiIndex() {
  const pluginEndpoints = plugin
    ? plugin.routes.filter((r) => r.summary && typeof r.path === 'string' && r.method !== '*')
      .map((r) => ({ method: r.method, path: r.path, summary: r.summary, plugin: plugin.name }))
    : [];
  const integrationEndpoints = extraRoutes
    .filter((r) => r.summary && typeof r.path === 'string' && r.method !== '*')
    .map((r) => ({ method: r.method, path: r.path, summary: r.summary, integration: true }));
  return {
    name: 'Tanpin API',
    version: pkg.version,
    description: 'Self-hosted inventory management: per-SKU demand forecasting, automatic reordering, supplier auto-emailing, delivery ETAs, ABC analysis, dead-stock detection.',
    docs: {
      openapi: '/openapi.json',
      llms: '/llms.txt',
      llmsFull: '/llms-full.txt',
      dashboard: '/',
    },
    auth: {
      scheme: 'Authorization: Bearer <key> or X-API-Key: <key>',
      note: 'Same-origin loopback (the dashboard) and non-browser loopback clients need no key by default. Cross-origin browser writes require a key. Create keys via the dashboard API tab or POST /api/keys from localhost.',
    },
    mcp: {
      note: 'A bundled MCP server exposes this API as tools: run `tanpin mcp` with TANPIN_URL (+ TANPIN_API_KEY if the server is remote).',
    },
    endpoints: [...ENDPOINTS, ...pluginEndpoints, ...integrationEndpoints],
    demo: isDemo(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeProduct(b, partial = false) {
  const out = {};
  const num = (v) => (v === '' || v == null ? undefined : Number(v));
  const fields = {
    sku: b.sku, name: b.name, category: b.category, supplierId: b.supplierId,
    unitCost: num(b.unitCost), price: num(b.price), currentStock: num(b.currentStock),
    leadTimeDays: num(b.leadTimeDays), packSize: num(b.packSize), minOrderQty: num(b.minOrderQty),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) out[k] = v;
    else if (!partial) out[k] = defaultProductField(k);
  }
  return out;
}
function defaultProductField(k) {
  const d = { sku: '', name: '', category: 'general', supplierId: null, unitCost: 0, price: 0, currentStock: 0, leadTimeDays: 2, packSize: 1, minOrderQty: 0 };
  return d[k];
}
function normalizeSupplier(b, partial = false) {
  const out = {};
  const set = (k, v, dflt) => { if (v !== undefined && v !== '') out[k] = v; else if (!partial) out[k] = dflt; };
  set('name', b.name, 'Supplier');
  set('email', b.email, '');
  set('leadTimeDays', b.leadTimeDays != null ? Number(b.leadTimeDays) : undefined, 2);
  set('minOrderValue', b.minOrderValue != null ? Number(b.minOrderValue) : undefined, 0);
  set('cutoffHour', b.cutoffHour != null && b.cutoffHour !== '' ? Number(b.cutoffHour) : undefined, undefined);
  if (Array.isArray(b.deliveryWindows)) out.deliveryWindows = b.deliveryWindows.map(Number);
  else if (typeof b.deliveryWindows === 'string' && b.deliveryWindows.trim())
    out.deliveryWindows = b.deliveryWindows.split(',').map((x) => Number(x.trim())).filter((x) => !isNaN(x));
  else if (!partial) out.deliveryWindows = [9, 15];
  return out;
}

const MAX_BODY = 10e6;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

// Memoized per request: a plugin route may read the body and then pass the
// request through to a core route, which must see the same bytes.
const rawBodies = new WeakMap();
function rawBody(req) {
  if (!rawBodies.has(req)) {
    rawBodies.set(req, new Promise((resolve, reject) => {
      let data = '';
      let tooLarge = false;
      req.setEncoding('utf8');
      req.on('data', (c) => {
        if (tooLarge) return; // drain without buffering
        data += c;
        if (data.length > MAX_BODY) { tooLarge = true; data = ''; reject(httpError(413, 'payload_too_large', `Request body exceeds ${MAX_BODY} bytes`)); }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    }));
  }
  return rawBodies.get(req);
}

// Strip keys that would let a JSON body reach into prototypes when merged
// with Object.assign (settings, product patches).
function sanitizeJson(x) {
  if (Array.isArray(x)) { x.forEach(sanitizeJson); return x; }
  if (x && typeof x === 'object') {
    for (const k of Object.keys(x)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') delete x[k];
      else sanitizeJson(x[k]);
    }
  }
  return x;
}

async function body(req) {
  return parseJsonBody(await rawBody(req));
}

function parseJsonBody(data) {
  try { return data ? sanitizeJson(JSON.parse(data)) : {}; }
  catch { throw httpError(400, 'invalid_json', 'Request body is not valid JSON'); }
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8',
};
function serveStatic(req, res, p) {
  const rel = p === '/' ? '/index.html' : p;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return jsonErr(res, 403, 'forbidden', 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return jsonErr(res, 404, 'not_found', 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...corsHeaders(res) });
    res.end(buf);
  });
}

function json(res, status, obj, extraHeaders = {}) {
  const s = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
    ...corsHeaders(res),
    ...extraHeaders,
  });
  res.end(s);
}
function jsonErr(res, status, code, message) {
  return json(res, status, { error: message, code });
}
function text(res, status, s, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(s), ...corsHeaders(res) });
  res.end(s);
}
function round(x, dp = 2) { const f = 10 ** dp; return Math.round((Number(x) || 0) * f) / f; }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
/**
 * Listen and (unless TANPIN_NO_DAEMON=1) start the in-process daemon.
 * Resolves with { server, port, daemon } once the port is bound.
 */
function start({ port = config.port, host = config.host || process.env.HOST || DEFAULT_HOST, log = console.log } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actual = server.address().port;
      const origin = `http://127.0.0.1:${actual}`;
      log(`\n  Tanpin v${pkg.version} →  ${origin}  (bound ${host}:${actual})`);
      log(`  Data file:  ${config.dbFile}`);
      log(`  Outbox:     ${config.outboxDir}`);
      log(`  API docs:   ${origin}/openapi.json · /llms.txt · GET /api`);
      log(`  MCP server: TANPIN_URL=${origin} tanpin mcp`);
      if (plugin) log(`  Plugin:     ${plugin.name} (${plugin.source})`);
      if (isDemo()) log(`  Demo mode:  reads open, writes limited to demo data, webhooks/SMTP off, reseed every ${DEMO_RESEED_MS / 60000} min`);
      if (!isDemo() && !isLoopbackHostname(host) && !adminKey() && !store.list('apiKeys').some((k) => !k.revoked)) {
        log('  Access:     bound beyond loopback — every non-local request needs an API key. Set TANPIN_ADMIN_KEY (the dashboard will ask for it).');
      }
      let daemon = null;
      if (process.env.TANPIN_NO_DAEMON !== '1') {
        daemon = startDaemon(store, { onTick: (s) => log(`  [daemon] tick: ${s.ordersCreated} orders, ${s.emailsSent} emails, ${s.delistFlags.length} delist flags`) });
        log(`  Daemon:     every ${store.data.settings.daemonIntervalMinutes} min (--no-daemon or TANPIN_NO_DAEMON=1 to disable)\n`);
      } else {
        log('  Daemon:     off (run `tanpin daemon` separately against the same data file)\n');
      }
      let reseedTimer = null;
      if (isDemo()) {
        delete process.env.SMTP_HOST;
        const reseed = () => {
          seed(store);
          store.data.settings.autoSend = false;
          store.data.settings.autoEmailAlerts = false;
          store.save();
        };
        reseed();
        reseedTimer = setInterval(reseed, DEMO_RESEED_MS);
        if (reseedTimer.unref) reseedTimer.unref();
      }
      resolve({ server, port: actual, daemon, host, reseedTimer });
    });
  });
}

if (require.main === module) {
  start().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = {
  server, handler, start, store, storeContext, buildState, recordSale, plugin, config,
  DEFAULT_HOST, DEMO_RESEED_MS, webhookUrlBlocked, originAllowed, isDemo, route,
};
