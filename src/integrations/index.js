'use strict';
// Inbound sales sources — Stripe, Shopify, Square webhooks and CSV import.
// Each path decrements stock through the engine's recordSales (delta applied
// inside the write transaction + forecast recompute) and is idempotent on
// provider event ids so webhook retries are safe.
//
// An event id is only kept as "processed" when at least one sale from it was
// recorded. A valid event that maps to nothing (unknown SKUs, no line items,
// provider API not configured yet) is answered 2xx but NOT consumed, so it can
// be replayed from the provider dashboard once the SKU mapping is fixed.

const crypto = require('node:crypto');
const manager = require('../engine/manager');
const stripe = require('./stripe');
const shopify = require('./shopify');
const square = require('./square');
const csvSales = require('./csv-sales');

const EVENT_TTL_MS = 7 * 86400000;

/**
 * Decrement on-hand stock and append a `sale` movement. Same shape as the
 * REST POST /api/sales handler: address by SKU or product id, never go below 0.
 */
function recordSale(store, b) {
  return manager.recordSales(store, [b || {}])[0];
}

function inboundEvents(data) {
  if (!data.inboundEvents || typeof data.inboundEvents !== 'object' || Array.isArray(data.inboundEvents)) {
    data.inboundEvents = {};
  }
  return data.inboundEvents;
}

function pruneInbound(events) {
  const cut = Date.now() - EVENT_TTL_MS;
  for (const [k, at] of Object.entries(events)) {
    if (typeof at !== 'number' || at < cut) delete events[k];
  }
}

function withData(store, apply) {
  if (typeof store.mutate === 'function') return store.mutate(apply);
  const out = apply(store.data);
  store.save();
  return out;
}

/**
 * Claim an event id atomically (checked and set inside the write transaction,
 * so two processes cannot both claim it). Returns true if it was already
 * claimed (a duplicate).
 */
function claimEvent(store, source, eventId) {
  if (!eventId) return false;
  const key = `${source}:${eventId}`;
  let duplicate = false;
  withData(store, (data) => {
    const events = inboundEvents(data);
    if (events[key]) { duplicate = true; return; }
    events[key] = Date.now();
    pruneInbound(events);
  });
  return duplicate;
}

function unclaimEvent(store, source, eventId) {
  unclaimEvents(store, source, [eventId]);
}

/** Claim many ids in one transaction. Returns the set of ids already claimed. */
function claimEvents(store, source, ids) {
  const dupes = new Set();
  const wanted = [...new Set((ids || []).filter(Boolean))];
  if (!wanted.length) return dupes;
  withData(store, (data) => {
    const events = inboundEvents(data);
    const now = Date.now();
    for (const id of wanted) {
      const key = `${source}:${id}`;
      if (events[key]) dupes.add(id);
      else events[key] = now;
    }
    pruneInbound(events);
  });
  return dupes;
}

function unclaimEvents(store, source, ids) {
  const keys = (ids || []).filter(Boolean).map((id) => `${source}:${id}`);
  if (!keys.length) return;
  withData(store, (data) => {
    const events = inboundEvents(data);
    for (const k of keys) delete events[k];
  });
}

function setting(store, path) {
  let cur = store && store.data && store.data.settings && store.data.settings.integrations;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return '';
    cur = cur[p];
  }
  if (typeof cur !== 'string') return '';
  const v = cur.trim();
  return v || '';
}

function firstEnv(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

function stripeSecret(store) {
  return setting(store, ['stripe', 'webhookSecret']) || firstEnv(['STRIPE_WEBHOOK_SECRET', 'STRIPE_WHSEC']);
}

function stripeApiKey(store) {
  return setting(store, ['stripe', 'apiKey']) || firstEnv(['STRIPE_API_KEY', 'STRIPE_SECRET_KEY']);
}

function stripeApiBase() {
  return firstEnv(['STRIPE_API_BASE']) || 'https://api.stripe.com';
}

function shopifySecret(store) {
  return setting(store, ['shopify', 'webhookSecret'])
    || firstEnv(['SHOPIFY_WEBHOOK_SECRET', 'SHOPIFY_SECRET', 'SHOPIFY_HMAC_SECRET']);
}

function squareSecret(store) {
  return setting(store, ['square', 'signatureKey'])
    || firstEnv(['SQUARE_SIGNATURE_KEY', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_SECRET']);
}

function squareAccessToken(store) {
  return setting(store, ['square', 'accessToken']) || firstEnv(['SQUARE_ACCESS_TOKEN']);
}

function squareApiBase(store) {
  const explicit = firstEnv(['SQUARE_API_BASE']);
  if (explicit) return explicit;
  const env = (setting(store, ['square', 'environment']) || firstEnv(['SQUARE_ENVIRONMENT'])).toLowerCase();
  return env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
}

function squareNotificationUrl(store, ctx) {
  return setting(store, ['square', 'notificationUrl'])
    || firstEnv(['SQUARE_NOTIFICATION_URL', 'SQUARE_WEBHOOK_URL'])
    || ((ctx.baseUrl || '') + (ctx.path || (ctx.url && ctx.url.pathname) || ''));
}

/** Record a batch of sales: ctx.recordSale when the host provides it, else the engine. */
function recordBatch(ctx, store, sales) {
  if (ctx && typeof ctx.recordSale === 'function') return sales.map((x) => ctx.recordSale(x));
  return manager.recordSales(store, sales);
}

function parseJson(raw) {
  try { return JSON.parse(asUtf8(raw) || '{}'); }
  catch { return null; }
}

function asUtf8(body) {
  if (body == null) return '';
  return Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
}

function sha256id(raw) {
  return crypto.createHash('sha256').update(asUtf8(raw)).digest('hex');
}

function summarize(results, extra) {
  return {
    recorded: results.filter((r) => r && r.ok).length,
    failed: results.filter((r) => !r || !r.ok).length,
    results,
    ...extra,
  };
}

/**
 * Record `sales` for a claimed event; release the claim when nothing was
 * recorded so a corrected replay is not rejected as a duplicate.
 */
function finish(ctx, store, source, id, sales, at, extra) {
  const results = sales.length ? recordBatch(ctx, store, sales.map((x) => ({ ...x, at, ref: id }))) : [];
  const summary = summarize(results, { ok: true, eventId: id, ...extra });
  if (!summary.recorded) {
    unclaimEvent(store, source, id);
    summary.consumed = false;
  }
  return ctx.json(200, summary);
}

async function handleStripe(ctx) {
  const store = ctx.store;
  const raw = await ctx.rawBody();
  const secret = stripeSecret(store);
  if (!secret) return ctx.error(503, 'not_configured', 'Stripe webhook secret is not set (STRIPE_WEBHOOK_SECRET)');
  const header = ctx.req.headers['stripe-signature'];
  if (!stripe.verifyStripeSignature(raw, header, secret)) {
    return ctx.error(400, 'invalid_signature', 'Stripe signature check failed');
  }
  const event = parseJson(raw);
  if (!event) return ctx.error(400, 'invalid_json', 'Request body is not valid JSON');
  if (!stripe.isCheckoutEvent(event)) {
    return ctx.json(200, { ok: true, ignored: true, reason: 'not checkout.session.completed' });
  }
  const id = stripe.eventId(event) || sha256id(raw);
  if (claimEvent(store, 'stripe', id)) {
    return ctx.json(200, { ok: true, duplicate: true, recorded: 0 });
  }
  let sales = stripe.extractStripeSales(event);
  let source = 'payload';
  const extra = {};
  if (!sales.length) {
    // Real checkout.session.completed events carry no line items: fetch them.
    const session = stripe.sessionId(event);
    const key = stripeApiKey(store);
    if (session && key) {
      try {
        sales = stripe.salesFromLineItems(await stripe.fetchLineItems(session, key, { base: stripeApiBase() }));
        source = 'stripe_api';
      } catch (e) {
        unclaimEvent(store, 'stripe', id);
        // 5xx so Stripe retries later; nothing was recorded.
        return ctx.error(502, 'provider_fetch_failed', String((e && e.message) || e));
      }
    } else if (session) {
      extra.hint = 'This event has no line items. Set STRIPE_API_KEY (read access to Checkout Sessions) so Tanpin can fetch them, then replay the event.';
    }
  }
  const at = event.created ? event.created * 1000 : Date.now();
  return finish(ctx, store, 'stripe', id, sales, at, { source, ...extra });
}

async function handleShopify(ctx) {
  const store = ctx.store;
  const raw = await ctx.rawBody();
  const secret = shopifySecret(store);
  if (!secret) return ctx.error(503, 'not_configured', 'Shopify webhook secret is not set (SHOPIFY_WEBHOOK_SECRET)');
  const header = ctx.req.headers['x-shopify-hmac-sha256'];
  if (!shopify.verifyShopifyHmac(raw, header, secret)) {
    return ctx.error(400, 'invalid_signature', 'Shopify HMAC check failed');
  }
  if (!shopify.isOrderTopic(ctx.req.headers)) {
    return ctx.json(200, { ok: true, ignored: true, reason: 'not orders/create' });
  }
  const order = parseJson(raw);
  if (!order) return ctx.error(400, 'invalid_json', 'Request body is not valid JSON');
  const id = shopify.eventId(order, ctx.req.headers) || sha256id(raw);
  if (claimEvent(store, 'shopify', id)) {
    return ctx.json(200, { ok: true, duplicate: true, recorded: 0 });
  }
  const sales = shopify.extractShopifySales(order);
  const at = order.created_at ? Date.parse(order.created_at) || Date.now() : Date.now();
  return finish(ctx, store, 'shopify', id, sales, at, { source: 'payload' });
}

async function handleSquare(ctx) {
  const store = ctx.store;
  const raw = await ctx.rawBody();
  const secret = squareSecret(store);
  if (!secret) return ctx.error(503, 'not_configured', 'Square signature key is not set (SQUARE_SIGNATURE_KEY)');
  const header = ctx.req.headers['x-square-hmacsha256-signature'] || ctx.req.headers['x-square-signature'];
  const notifyUrl = squareNotificationUrl(store, ctx);
  if (!square.verifySquareSignature(raw, header, secret, notifyUrl)) {
    return ctx.error(400, 'invalid_signature', 'Square signature check failed');
  }
  const event = parseJson(raw);
  if (!event) return ctx.error(400, 'invalid_json', 'Request body is not valid JSON');
  if (!square.isOrderCreated(event)) {
    return ctx.json(200, { ok: true, ignored: true, reason: 'not an order.created event' });
  }
  const id = square.eventId(event, ctx.req.headers) || sha256id(raw);
  if (claimEvent(store, 'square', id)) {
    return ctx.json(200, { ok: true, duplicate: true, recorded: 0 });
  }
  let sales = square.extractSquareSales(event);
  let source = 'payload';
  const extra = {};
  if (!sales.length) {
    // Real order.created notifications carry only the order id: fetch the
    // order and map variations to SKUs through the Catalog API.
    const orderId = square.orderId(event);
    const token = squareAccessToken(store);
    if (orderId && token) {
      try {
        sales = await square.fetchOrderSales(orderId, token, { base: squareApiBase(store) });
        source = 'square_api';
      } catch (e) {
        unclaimEvent(store, 'square', id);
        return ctx.error(502, 'provider_fetch_failed', String((e && e.message) || e));
      }
    } else if (orderId) {
      extra.hint = 'order.created carries no line items. Set SQUARE_ACCESS_TOKEN (ORDERS_READ + ITEMS_READ) so Tanpin can fetch the order, then replay the event.';
    }
  }
  const created = event.data && event.data.object && event.data.object.order_created
    && event.data.object.order_created.created_at;
  const at = Date.parse(created || event.created_at || '') || Date.now();
  return finish(ctx, store, 'square', id, sales, at, { source, ...extra });
}

async function handleCsvSales(ctx) {
  const store = ctx.store;
  const raw = await ctx.rawBody();
  if (!String(raw || '').trim()) {
    return ctx.error(400, 'invalid_request', 'Send CSV text with a header row (sku, qty, ...)');
  }
  const settings = (store.data && store.data.settings) || {};
  // Date-only / offset-less dates are store-local (settings.timezone).
  const parsed = csvSales.parseSalesCsv(raw, { timeZone: settings.timezone });
  const results = new Array(parsed.length);
  const pending = [];
  const valid = [];
  parsed.forEach((row, i) => {
    if (!row.sku) { results[i] = { ok: false, error: `row ${row.row}: missing sku`, sku: null }; return; }
    if (row.qty <= 0) { results[i] = { ok: false, error: `row ${row.row}: qty must be > 0`, sku: row.sku }; return; }
    valid.push(i);
  });
  // Claim every row id in one transaction; ids repeated inside this file
  // count once (the first row wins).
  const alreadyClaimed = claimEvents(store, 'csv', valid.map((i) => parsed[i].id));
  const seenIds = new Set();
  for (const i of valid) {
    const id = parsed[i].id;
    if (id && (alreadyClaimed.has(id) || seenIds.has(id))) {
      results[i] = { ok: true, duplicate: true, sku: parsed[i].sku, qty: 0 };
      continue;
    }
    if (id) seenIds.add(id);
    pending.push(i);
  }
  // One write transaction + one save for all recordable rows.
  const recorded = pending.length ? recordBatch(ctx, store, pending.map((i) => ({
    sku: parsed[i].sku, qty: parsed[i].qty, at: parsed[i].at, ref: parsed[i].id || 'csv',
  }))) : [];
  const release = [];
  pending.forEach((i, k) => {
    const r = recorded[k];
    if (!r.ok && parsed[i].id) release.push(parsed[i].id);
    results[i] = r;
  });
  unclaimEvents(store, 'csv', release);
  return ctx.json(201, summarize(results, { ok: true, rows: parsed.length }));
}

module.exports = {
  recordSale,
  claimEvent,
  handleStripe,
  handleShopify,
  handleSquare,
  handleCsvSales,
  stripe,
  shopify,
  square,
  csvSales,
  get register() { return require('./routes').register; },
};
