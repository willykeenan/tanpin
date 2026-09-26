'use strict';
// Outbound webhooks — how other systems (ERPs, POS, Slack bots, AI agents)
// react to inventory events without polling. Each registered webhook gets a
// JSON POST per matching event, signed with HMAC-SHA256 so receivers can
// verify authenticity:
//
//   X-Inventory-Event:     po.created
//   X-Inventory-Signature: sha256=<hmac of raw body with the webhook secret>
//
// Deliveries are fire-and-forget with a 10s timeout and never throw — a dead
// receiver must not break a sale or a daemon cycle. Every attempt is recorded
// in store.data.webhookLog for the Activity/API tabs.
//
// The guards live here (not in the HTTP server) so they apply to every caller,
// including the standalone daemon:
//   * DEMO_MODE=1: nothing is delivered.
//   * SSRF: private/loopback/link-local/CGNAT/... destinations are refused
//     (TANPIN_ALLOW_PRIVATE_WEBHOOKS=1 opts out), and the socket connects to
//     the exact address that was validated (see netguard.safeLookup).
//   * Redirects are never followed.

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const netguard = require('./netguard');
const { newId } = require('./store');
const { version } = require('../../package.json');

/** Event names emitted by the system (also listed in /openapi.json). */
const EVENTS = [
  'sale.recorded',
  'stock.adjusted',
  'stock.low',
  'po.created',
  'po.sent',
  'po.received',
  'po.cancelled',
  'product.delist_flagged',
  'cycle.completed',
];

const TIMEOUT_MS = 10000;

function isDemo() { return process.env.DEMO_MODE === '1'; }

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret || '')).update(body).digest('hex');
}

function logDelivery(store, entry) {
  store.data.webhookLog.unshift(entry);
  store.data.webhookLog = store.data.webhookLog.slice(0, 200);
  store.save();
  return entry;
}

/** POST `payload` to `url` via node:http(s), resolving through safeLookup. */
function post(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
      lookup: netguard.safeLookup,
      agent: false, // no pooled sockets: every delivery resolves + validates afresh
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, (res) => {
      res.resume(); // discard the body; only the status matters
      res.on('end', () => resolve(res.statusCode));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** URL with any user:password@ credentials replaced, for logs and API responses. */
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    if (!u.username && !u.password) return String(raw);
    u.username = u.username ? '***' : '';
    u.password = u.password ? '***' : '';
    return u.toString();
  } catch {
    return String(raw == null ? '' : raw);
  }
}

async function deliver(store, hook, event, data) {
  const url = hook && hook.url;
  const entry = { at: Date.now(), event, url: redactUrl(url), webhookId: hook && hook.id, ok: false };
  if (isDemo()) {
    entry.error = 'demo_mode';
    return logDelivery(store, entry);
  }
  const blocked = netguard.webhookUrlBlocked(url);
  if (blocked) {
    entry.error = blocked;
    return logDelivery(store, entry);
  }
  const payload = JSON.stringify({ id: newId('evt'), event, at: Date.now(), data });
  try {
    const status = await post(url, {
      'content-type': 'application/json',
      'user-agent': `tanpin-webhook/${version}`,
      'x-inventory-event': event,
      'x-inventory-signature': sign(hook.secret, payload),
    }, payload);
    entry.status = status;
    entry.ok = status >= 200 && status < 300;
  } catch (e) {
    entry.error = e && e.code === 'EBLOCKED_DESTINATION'
      ? netguard.RESOLVES_PRIVATE_MSG
      : String((e && e.message) || e).slice(0, 200);
  }
  return logDelivery(store, entry);
}

/**
 * Emit an event to every active webhook subscribed to it (or to '*').
 * Returns a promise that settles when all deliveries finish, but callers are
 * free to fire-and-forget — nothing here ever rejects.
 */
function emit(store, event, data) {
  if (isDemo()) return Promise.resolve([]);
  const hooks = store.list('webhooks').filter((h) =>
    h.active !== false &&
    (!h.events || !h.events.length || h.events.includes('*') || h.events.includes(event)));
  if (!hooks.length) return Promise.resolve([]);
  return Promise.allSettled(hooks.map((h) => module.exports.deliver(store, h, event, data)));
}

module.exports = { EVENTS, emit, deliver, sign, redactUrl };
