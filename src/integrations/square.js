'use strict';
// Square order webhooks.
// Signature: x-square-hmacsha256-signature = base64(HMAC-SHA256(key, notificationUrl + rawBody)).
//
// A real `order.created` notification carries only
//   data.object.order_created = { order_id, state, version, location_id }
// — no line items — and Square line items have no `sku` field anyway. When
// the payload has no usable line items the handler fetches the order
// (GET /v2/orders/{id}) and its variations (POST /v2/catalog/batch-retrieve)
// with a Square access token, and maps each line to a Tanpin SKU via:
//   line_items[].metadata.sku, else the catalog ItemVariation's `sku`.

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

function signedPayload(rawBody, notificationUrl) {
  return Buffer.concat([
    Buffer.from(String(notificationUrl || ''), 'utf8'),
    asBytes(rawBody),
  ]);
}

function verifySquareSignature(rawBody, header, secret, notificationUrl) {
  if (!header || !secret) return false;
  const expected = crypto.createHmac('sha256', String(secret).trim()).update(signedPayload(rawBody, notificationUrl)).digest('base64');
  return timingSafeEqualStr(String(header).trim(), expected);
}

function squareOrderId(event) {
  if (!event || typeof event !== 'object') return '';
  const data = event.data;
  if (!data || typeof data !== 'object') return '';
  const obj = data.object;
  if (obj && obj.order && obj.order.id) return String(obj.order.id);
  for (const k of ['order_created', 'order_updated']) {
    if (obj && obj[k] && obj[k].order_id) return String(obj[k].order_id);
  }
  if (obj && obj.id && (Array.isArray(obj.line_items) || obj.order)) return String(obj.id);
  if (data.id) return String(data.id);
  return '';
}

function eventId(event, headers = {}) {
  const orderId = squareOrderId(event);
  if (orderId) return `square-order-${orderId}`;
  if (headers['x-square-event-id']) return String(headers['x-square-event-id']);
  if (event && event.event_id) return String(event.event_id);
  if (event && event.event_id === 0) return '0';
  return '';
}

function isOrderCreated(event) {
  const t = String((event && (event.type || event.event_type)) || '').toLowerCase();
  if (!t) return true;
  return t === 'order.created' || t.endsWith('.order.created');
}

function walkLineItems(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) walkLineItems(x, out);
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node.line_items)) {
    for (const item of node.line_items) out.push(item);
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walkLineItems(v, out);
  }
}

function skuFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  return item.sku
    || (item.metadata && (item.metadata.sku || item.metadata.SKU))
    || (item.catalog_object && item.catalog_object.item_variation_data && item.catalog_object.item_variation_data.sku)
    || '';
}

function extractSquareSales(event) {
  const items = [];
  walkLineItems(event, items);
  const sales = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    const sku = skuFromItem(item);
    if (!sku) continue;
    const qty = Number(item.quantity != null ? item.quantity : item.qty) || 0;
    if (qty <= 0) continue;
    sales.push({ sku: String(sku), qty });
  }
  return sales;
}

const SQUARE_VERSION = '2024-10-17';

async function squareCall(base, token, method, pathName, body, fetchImpl) {
  const res = await fetchImpl(`${base.replace(/\/+$/, '')}${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'square-version': SQUARE_VERSION,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json && Array.isArray(json.errors) && json.errors[0];
    throw new Error(`Square ${pathName.split('?')[0]}: ${(e && (e.detail || e.code)) || `HTTP ${res.status}`}`);
  }
  return json;
}

/**
 * Fetch an order and resolve each line item's SKU through the Catalog API.
 * Returns [{ sku, qty }]. base: SQUARE_API_BASE, else production
 * (connect.squareup.com) or sandbox (connect.squareupsandbox.com).
 */
async function fetchOrderSales(orderId, token, { base = 'https://connect.squareup.com', fetchImpl = fetch } = {}) {
  const { order } = await squareCall(base, token, 'GET', `/v2/orders/${encodeURIComponent(orderId)}`, null, fetchImpl);
  const lines = (order && Array.isArray(order.line_items)) ? order.line_items : [];
  const ids = [...new Set(lines.map((l) => l && l.catalog_object_id).filter(Boolean))];
  const skuById = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const { objects } = await squareCall(base, token, 'POST', '/v2/catalog/batch-retrieve',
      { object_ids: ids.slice(i, i + 1000), include_related_objects: false }, fetchImpl);
    for (const o of objects || []) {
      const sku = o && o.item_variation_data && o.item_variation_data.sku;
      if (o && o.id && sku) skuById.set(o.id, String(sku));
    }
  }
  const sales = [];
  for (const line of lines) {
    const sku = (line.metadata && (line.metadata.sku || line.metadata.SKU)) || skuById.get(line.catalog_object_id) || '';
    const qty = Number(line.quantity) || 0;
    if (sku && qty > 0) sales.push({ sku: String(sku), qty });
  }
  return sales;
}

function signSquarePayload(rawBody, secret, notificationUrl) {
  return crypto.createHmac('sha256', String(secret).trim()).update(signedPayload(rawBody, notificationUrl)).digest('base64');
}

module.exports = {
  verifySquareSignature,
  extractSquareSales,
  eventId,
  isOrderCreated,
  signSquarePayload,
  orderId: squareOrderId,
  fetchOrderSales,
};
