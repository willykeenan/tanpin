'use strict';
// Shopify orders/create webhooks.
// Signature: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(secret, rawBody)).

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

function verifyShopifyHmac(rawBody, header, secret) {
  if (!header || !secret) return false;
  const expected = crypto.createHmac('sha256', String(secret).trim()).update(asBytes(rawBody)).digest('base64');
  return timingSafeEqualStr(String(header).trim(), expected);
}

function eventId(event, headers = {}) {
  // Order id is stable across Shopify redeliveries (webhook ids are not).
  if (event && event.admin_graphql_api_id) return String(event.admin_graphql_api_id);
  if (event && event.id != null && event.id !== '') return `shopify-order-${event.id}`;
  const h = headers['x-shopify-webhook-id'] || headers['x-shopify-event-id'];
  if (h) return String(h);
  return '';
}

function isOrderTopic(headers = {}) {
  const topic = String(headers['x-shopify-topic'] || '').toLowerCase();
  if (!topic) return true;
  return topic === 'orders/create';
}

function skuFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.sku) return String(item.sku);
  const props = item.properties;
  if (props && typeof props === 'object' && !Array.isArray(props) && props.sku) return String(props.sku);
  if (Array.isArray(props)) {
    const hit = props.find((p) => p && String(p.name || p.key || '').toLowerCase() === 'sku');
    if (hit && hit.value != null && String(hit.value).trim() !== '') return String(hit.value);
  }
  return '';
}

function extractShopifySales(order) {
  if (!order || typeof order !== 'object') return [];
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  const sales = [];
  for (const item of items) {
    const sku = skuFromItem(item);
    if (!sku) continue;
    const qty = Number(item.quantity != null ? item.quantity : item.current_quantity) || 0;
    if (qty <= 0) continue;
    sales.push({ sku: String(sku), qty });
  }
  return sales;
}

function signShopifyPayload(rawBody, secret) {
  return crypto.createHmac('sha256', String(secret).trim()).update(asBytes(rawBody)).digest('base64');
}

module.exports = {
  verifyShopifyHmac,
  extractShopifySales,
  eventId,
  isOrderTopic,
  signShopifyPayload,
};
