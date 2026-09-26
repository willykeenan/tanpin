'use strict';
// Stripe Checkout webhooks. Signature: Stripe-Signature header
//   t=<unix>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}` keyed by the webhook secret>
//
// A real `checkout.session.completed` event does NOT carry line items. When
// the payload has none, the handler fetches them with
//   GET /v1/checkout/sessions/{id}/line_items?expand[]=data.price.product
// using a Stripe API key (a restricted key with read access to Checkout
// Sessions is enough). SKU per line: line metadata.sku, else the Price
// lookup_key, else price.metadata.sku, else the Product's metadata.sku.
// Without an API key only session-level metadata.sku (+ optional qty) works.

const crypto = require('node:crypto');

function asBytes(body) {
  if (body == null) return Buffer.alloc(0);
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!header || !secret) return false;
  const items = String(header).split(',').map((s) => s.trim()).filter(Boolean);
  let timestamp = '';
  const v1 = [];
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq < 0) continue;
    const k = item.slice(0, eq);
    const v = item.slice(eq + 1);
    if (k === 't') timestamp = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!timestamp || !v1.length) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), asBytes(rawBody)]);
  const expected = crypto.createHmac('sha256', String(secret).trim()).update(payload).digest('hex');
  return v1.some((sig) => timingSafeEqualStr(String(sig).toLowerCase(), expected));
}

function eventId(event) {
  return (event && (event.id || event.event_id)) || '';
}

/** Only checkout.session.completed decrements stock (other Stripe events share metadata). */
function isCheckoutEvent(event) {
  const t = String((event && event.type) || '');
  if (!t) return true;
  return t === 'checkout.session.completed';
}

function skuFromLine(item) {
  if (!item || typeof item !== 'object') return '';
  const price = item.price || {};
  const product = price.product && typeof price.product === 'object' ? price.product : null;
  return item.sku
    || (item.metadata && item.metadata.sku)
    || price.lookup_key
    || (price.metadata && price.metadata.sku)
    || (item.plan && item.plan.lookup_key)
    || (product && product.metadata && product.metadata.sku)
    || '';
}

function qtyOf(item, fallback = 1) {
  if (!item || (item.quantity == null && item.qty == null)) return fallback;
  const n = Number(item.quantity != null ? item.quantity : item.qty);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function lineItemsOf(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj.line_items)) return obj.line_items;
  if (obj.line_items && Array.isArray(obj.line_items.data)) return obj.line_items.data;
  if (Array.isArray(obj.display_items)) return obj.display_items;
  if (Array.isArray(obj.items)) return obj.items;
  if (obj.lines && Array.isArray(obj.lines.data)) return obj.lines.data;
  return [];
}

function extractStripeSales(event) {
  const obj = (event && event.data && event.data.object) || event || {};
  const items = lineItemsOf(obj);
  const fromItems = [];
  for (const item of items) {
    const sku = skuFromLine(item);
    const qty = qtyOf(item, 1);
    if (sku && qty > 0) fromItems.push({ sku: String(sku), qty });
  }
  if (fromItems.length) return fromItems;
  const meta = obj.metadata || {};
  const qty = qtyOf(meta, 1);
  if (meta.sku && qty > 0) return [{ sku: String(meta.sku), qty }];
  return [];
}

/** The Checkout Session id of a checkout.session.* event, or ''. */
function sessionId(event) {
  const obj = event && event.data && event.data.object;
  if (obj && typeof obj.id === 'string' && (obj.object === 'checkout.session' || obj.id.startsWith('cs_'))) return obj.id;
  return '';
}

/** Sales from a list of Stripe line-item objects. */
function salesFromLineItems(items) {
  const out = [];
  for (const item of items || []) {
    const sku = skuFromLine(item);
    const qty = qtyOf(item, 1);
    if (sku && qty > 0) out.push({ sku: String(sku), qty });
  }
  return out;
}

/**
 * Fetch every line item of a Checkout Session from the Stripe API.
 * base: STRIPE_API_BASE (tests point it at a local fake), default api.stripe.com.
 */
async function fetchLineItems(id, apiKey, { base = 'https://api.stripe.com', fetchImpl = fetch } = {}) {
  const items = [];
  let after = '';
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: '100' });
    q.append('expand[]', 'data.price.product');
    if (after) q.set('starting_after', after);
    const url = `${base.replace(/\/+$/, '')}/v1/checkout/sessions/${encodeURIComponent(id)}/line_items?${q}`;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}`, 'stripe-version': '2024-06-20' },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body && body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
      throw new Error(`Stripe line_items: ${msg}`);
    }
    const data = Array.isArray(body.data) ? body.data : [];
    items.push(...data);
    if (!body.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return items;
}

function signStripePayload(rawBody, secret, timestamp) {
  const t = timestamp == null ? Math.floor(Date.now() / 1000) : Number(timestamp);
  const payload = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), asBytes(rawBody)]);
  const v1 = crypto.createHmac('sha256', String(secret).trim()).update(payload).digest('hex');
  return `t=${t},v1=${v1}`;
}

module.exports = {
  verifyStripeSignature,
  extractStripeSales,
  eventId,
  isCheckoutEvent,
  signStripePayload,
  sessionId,
  salesFromLineItems,
  fetchLineItems,
};
