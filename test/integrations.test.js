'use strict';
// Sales sources + supplier email. Local fake servers only; no network providers.
// Run: node --test --test-concurrency=1 test/integrations.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const { Store } = require('../src/engine/store');
const email = require('../src/engine/email');
const {
  recordSale, handleStripe, handleShopify, handleSquare, handleCsvSales,
} = require('../src/integrations');
const { register } = require('../src/integrations/routes');
const stripe = require('../src/integrations/stripe');
const shopify = require('../src/integrations/shopify');
const square = require('../src/integrations/square');

const EMAIL_ENV = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_AUTH',
  'SMTP_SECURE', 'SMTP_STARTTLS', 'SMTP_TLS_REJECT_UNAUTHORIZED',
  'RESEND_API_KEY', 'RESEND_API_URL',
  'POSTMARK_SERVER_TOKEN', 'POSTMARK_API_TOKEN', 'POSTMARK_API_URL',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_KEY',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_SES_ENDPOINT', 'SES_ENDPOINT',
  'AWS_SESSION_TOKEN', 'EMAIL_TRANSPORT',
  'STRIPE_WEBHOOK_SECRET', 'STRIPE_WHSEC',
  'SHOPIFY_WEBHOOK_SECRET', 'SHOPIFY_SECRET', 'SHOPIFY_HMAC_SECRET',
  'SQUARE_SIGNATURE_KEY', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_SECRET',
  'SQUARE_NOTIFICATION_URL', 'SQUARE_WEBHOOK_URL',
  'STRIPE_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_API_BASE',
  'SQUARE_ACCESS_TOKEN', 'SQUARE_API_BASE', 'SQUARE_ENVIRONMENT',
];

function withEnv(vars, fn) {
  const prev = {};
  for (const k of EMAIL_ENV) { prev[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of EMAIL_ENV) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-int-'));
  const store = new Store(path.join(dir, 'inventory.json'));
  store.load();
  store.outboxDir = path.join(dir, 'outbox');
  store.insert('products', {
    sku: 'WIDGET-1', name: 'Widget', category: 'general',
    unitCost: 1, price: 3, currentStock: 100, leadTimeDays: 2, packSize: 1, minOrderQty: 0,
  });
  store.insert('products', {
    sku: 'GADGET-2', name: 'Gadget', category: 'general',
    unitCost: 2, price: 5, currentStock: 50, leadTimeDays: 2, packSize: 1, minOrderQty: 0,
  });
  return { store, dir };
}

function stock(store, sku) {
  return store.list('products').find((p) => p.sku === sku).currentStock;
}

function saleMovements(store) {
  return store.list('movements').filter((m) => m.type === 'sale');
}

function fakeCtx({ store, headers = {}, raw = '', path = '/api/integrations/stripe', baseUrl = 'http://127.0.0.1' }) {
  const result = { status: null, body: null };
  return {
    req: { headers },
    res: {},
    store,
    path,
    url: new URL(path, baseUrl),
    baseUrl,
    rawBody: async () => raw,
    json(status, obj) { result.status = status; result.body = obj; return obj; },
    error(status, code, message) {
      result.status = status;
      result.body = { error: message, code };
      return result.body;
    },
    result,
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const SAMPLE_PO = {
  id: 'po_test1',
  lines: [
    { sku: 'WIDGET-1', name: 'Widget', qty: 12, unitCost: 1.5 },
    { sku: 'GADGET-2', name: 'Gadget', qty: 4, unitCost: 2 },
  ],
};

// ---------------------------------------------------------------------------
// Routing contract
// ---------------------------------------------------------------------------
test('register() mounts public webhook routes and an authenticated CSV import', () => {
  const routes = [];
  register((r) => routes.push(r));
  const byPath = Object.fromEntries(routes.map((r) => [r.path, r]));
  assert.strictEqual(byPath['/api/integrations/stripe'].public, true);
  assert.strictEqual(byPath['/api/integrations/stripe'].method, 'POST');
  assert.strictEqual(byPath['/api/integrations/stripe-sales'].public, true);
  assert.strictEqual(byPath['/api/integrations/shopify'].public, true);
  assert.strictEqual(byPath['/api/integrations/square'].public, true);
  assert.strictEqual(byPath['/api/integrations/csv-sales'].public, false);
  for (const r of routes) assert.strictEqual(typeof r.handler, 'function');
});

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
test('Stripe checkout webhook decrements stock from metadata.sku', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    id: 'evt_meta_1',
    type: 'checkout.session.completed',
    data: { object: { metadata: { sku: 'WIDGET-1', qty: '3' } } },
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test' }, async () => {
    const sig = stripe.signStripePayload(payload, 'whsec_test');
    const ctx = fakeCtx({ store, raw: payload, headers: { 'stripe-signature': sig } });
    await handleStripe(ctx);
    assert.strictEqual(ctx.result.status, 200);
    assert.strictEqual(ctx.result.body.recorded, 1);
    assert.strictEqual(stock(store, 'WIDGET-1'), 97);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Stripe checkout webhook uses price lookup_key when metadata.sku is absent', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    id: 'evt_lookup_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        line_items: {
          data: [
            { quantity: 2, price: { lookup_key: 'GADGET-2' } },
            { quantity: 1, price: { lookup_key: 'WIDGET-1' } },
          ],
        },
      },
    },
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test' }, async () => {
    const sig = stripe.signStripePayload(payload, 'whsec_test');
    const ctx = fakeCtx({ store, raw: payload, headers: { 'stripe-signature': sig } });
    await handleStripe(ctx);
    assert.strictEqual(ctx.result.status, 200);
    assert.strictEqual(stock(store, 'GADGET-2'), 48);
    assert.strictEqual(stock(store, 'WIDGET-1'), 99);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Stripe forged signature is rejected and does not decrement', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    id: 'evt_forged',
    type: 'checkout.session.completed',
    data: { object: { metadata: { sku: 'WIDGET-1', qty: '9' } } },
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test' }, async () => {
    const ctx = fakeCtx({
      store, raw: payload,
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    });
    await handleStripe(ctx);
    assert.strictEqual(ctx.result.status, 400);
    assert.strictEqual(ctx.result.body.code, 'invalid_signature');
    assert.strictEqual(stock(store, 'WIDGET-1'), 100);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Stripe non-checkout events are ignored and do not decrement', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    id: 'evt_pi_1',
    type: 'payment_intent.succeeded',
    data: { object: { metadata: { sku: 'WIDGET-1', qty: '9' } } },
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test' }, async () => {
    const sig = stripe.signStripePayload(payload, 'whsec_test');
    const ctx = fakeCtx({ store, raw: payload, headers: { 'stripe-signature': sig } });
    await handleStripe(ctx);
    assert.strictEqual(ctx.result.status, 200);
    assert.strictEqual(ctx.result.body.ignored, true);
    assert.strictEqual(stock(store, 'WIDGET-1'), 100);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Stripe valid signature of a tampered body is rejected', async () => {
  const { store, dir } = makeStore();
  const original = JSON.stringify({
    id: 'evt_tamper',
    type: 'checkout.session.completed',
    data: { object: { metadata: { sku: 'WIDGET-1', qty: '2' } } },
  });
  const tampered = JSON.stringify({
    id: 'evt_tamper',
    type: 'checkout.session.completed',
    data: { object: { metadata: { sku: 'WIDGET-1', qty: '9' } } },
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test' }, async () => {
    const sig = stripe.signStripePayload(original, 'whsec_test');
    const ctx = fakeCtx({ store, raw: tampered, headers: { 'stripe-signature': sig } });
    await handleStripe(ctx);
    assert.strictEqual(ctx.result.status, 400);
    assert.strictEqual(ctx.result.body.code, 'invalid_signature');
    assert.strictEqual(stock(store, 'WIDGET-1'), 100);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Stripe webhook retries with the same event id do not double-decrement', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    id: 'evt_retry_1',
    type: 'checkout.session.completed',
    data: { object: { metadata: { sku: 'WIDGET-1', qty: '4' } } },
  });
  await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test' }, async () => {
    const sig = stripe.signStripePayload(payload, 'whsec_test');
    const first = fakeCtx({ store, raw: payload, headers: { 'stripe-signature': sig } });
    await handleStripe(first);
    const second = fakeCtx({ store, raw: payload, headers: { 'stripe-signature': sig } });
    await handleStripe(second);
    assert.strictEqual(second.result.status, 200);
    assert.strictEqual(second.result.body.duplicate, true);
    assert.strictEqual(stock(store, 'WIDGET-1'), 96);
    assert.strictEqual(saleMovements(store).length, 1);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------
test('Shopify orders/create HMAC webhook decrements stock', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    id: 9001,
    line_items: [{ sku: 'WIDGET-1', quantity: 5 }],
  });
  await withEnv({ SHOPIFY_WEBHOOK_SECRET: 'shop_secret' }, async () => {
    const hmac = shopify.signShopifyPayload(payload, 'shop_secret');
    const ctx = fakeCtx({
      store, raw: payload, path: '/api/integrations/shopify',
      headers: {
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'wh_9001',
      },
    });
    await handleShopify(ctx);
    assert.strictEqual(ctx.result.status, 200);
    assert.strictEqual(stock(store, 'WIDGET-1'), 95);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Shopify forged HMAC is rejected', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({ id: 1, line_items: [{ sku: 'WIDGET-1', quantity: 2 }] });
  await withEnv({ SHOPIFY_WEBHOOK_SECRET: 'shop_secret' }, async () => {
    const ctx = fakeCtx({
      store, raw: payload, path: '/api/integrations/shopify',
      headers: { 'x-shopify-hmac-sha256': 'not-a-real-hmac===========', 'x-shopify-topic': 'orders/create' },
    });
    await handleShopify(ctx);
    assert.strictEqual(ctx.result.status, 400);
    assert.strictEqual(ctx.result.body.code, 'invalid_signature');
    assert.strictEqual(stock(store, 'WIDGET-1'), 100);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Shopify orders/updated is ignored and does not decrement', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    id: 77,
    line_items: [{ sku: 'WIDGET-1', quantity: 8 }],
  });
  await withEnv({ SHOPIFY_WEBHOOK_SECRET: 'shop_secret' }, async () => {
    const hmac = shopify.signShopifyPayload(payload, 'shop_secret');
    const ctx = fakeCtx({
      store, raw: payload, path: '/api/integrations/shopify',
      headers: {
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-topic': 'orders/updated',
        'x-shopify-webhook-id': 'wh_updated_77',
      },
    });
    await handleShopify(ctx);
    assert.strictEqual(ctx.result.status, 200);
    assert.strictEqual(ctx.result.body.ignored, true);
    assert.strictEqual(stock(store, 'WIDGET-1'), 100);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Shopify retries with the same webhook id do not double-decrement', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    id: 42,
    line_items: [{ sku: 'GADGET-2', quantity: 3 }],
  });
  await withEnv({ SHOPIFY_WEBHOOK_SECRET: 'shop_secret' }, async () => {
    const hmac = shopify.signShopifyPayload(payload, 'shop_secret');
    const headers = {
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': 'wh_dup',
    };
    await handleShopify(fakeCtx({ store, raw: payload, path: '/api/integrations/shopify', headers }));
    const again = fakeCtx({ store, raw: payload, path: '/api/integrations/shopify', headers });
    await handleShopify(again);
    assert.strictEqual(again.result.body.duplicate, true);
    assert.strictEqual(stock(store, 'GADGET-2'), 47);
    assert.strictEqual(saleMovements(store).length, 1);

    const redeliver = fakeCtx({
      store, raw: payload, path: '/api/integrations/shopify',
      headers: {
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'wh_dup_redeliver',
      },
    });
    await handleShopify(redeliver);
    assert.strictEqual(redeliver.result.body.duplicate, true);
    assert.strictEqual(stock(store, 'GADGET-2'), 47);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Square
// ---------------------------------------------------------------------------
test('Square order webhook decrements stock when signature matches URL+body', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    event_id: 'sq_1',
    type: 'order.created',
    data: { object: { order: { line_items: [{ sku: 'WIDGET-1', quantity: '6' }] } } },
  });
  const notify = 'http://127.0.0.1/api/integrations/square';
  await withEnv({ SQUARE_SIGNATURE_KEY: 'sq_key', SQUARE_NOTIFICATION_URL: notify }, async () => {
    const sig = square.signSquarePayload(payload, 'sq_key', notify);
    const ctx = fakeCtx({
      store, raw: payload, path: '/api/integrations/square', baseUrl: 'http://127.0.0.1',
      headers: { 'x-square-hmacsha256-signature': sig },
    });
    await handleSquare(ctx);
    assert.strictEqual(ctx.result.status, 200);
    assert.strictEqual(stock(store, 'WIDGET-1'), 94);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Square forged signature is rejected', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    event_id: 'sq_bad',
    data: { object: { order: { line_items: [{ sku: 'WIDGET-1', quantity: '1' }] } } },
  });
  await withEnv({ SQUARE_SIGNATURE_KEY: 'sq_key', SQUARE_NOTIFICATION_URL: 'http://127.0.0.1/api/integrations/square' }, async () => {
    const ctx = fakeCtx({
      store, raw: payload, path: '/api/integrations/square',
      headers: { 'x-square-hmacsha256-signature': 'AAAA' },
    });
    await handleSquare(ctx);
    assert.strictEqual(ctx.result.status, 400);
    assert.strictEqual(ctx.result.body.code, 'invalid_signature');
    assert.strictEqual(stock(store, 'WIDGET-1'), 100);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Square payment.created is ignored and does not decrement', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    event_id: 'sq_pay',
    type: 'payment.created',
    data: { object: { order: { line_items: [{ sku: 'WIDGET-1', quantity: '4' }] } } },
  });
  const notify = 'http://127.0.0.1/api/integrations/square';
  await withEnv({ SQUARE_SIGNATURE_KEY: 'sq_key', SQUARE_NOTIFICATION_URL: notify }, async () => {
    const sig = square.signSquarePayload(payload, 'sq_key', notify);
    const ctx = fakeCtx({
      store, raw: payload, path: '/api/integrations/square',
      headers: { 'x-square-hmacsha256-signature': sig },
    });
    await handleSquare(ctx);
    assert.strictEqual(ctx.result.status, 200);
    assert.strictEqual(ctx.result.body.ignored, true);
    assert.strictEqual(stock(store, 'WIDGET-1'), 100);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Square retries with the same event_id do not double-decrement', async () => {
  const { store, dir } = makeStore();
  const payload = JSON.stringify({
    event_id: 'sq_retry',
    data: { object: { order: { line_items: [{ metadata: { sku: 'GADGET-2' }, quantity: '2' }] } } },
  });
  const notify = 'http://tanpin.example/api/integrations/square';
  await withEnv({ SQUARE_SIGNATURE_KEY: 'sq_key', SQUARE_NOTIFICATION_URL: notify }, async () => {
    const sig = square.signSquarePayload(payload, 'sq_key', notify);
    const headers = { 'x-square-hmacsha256-signature': sig };
    await handleSquare(fakeCtx({ store, raw: payload, path: '/api/integrations/square', headers }));
    const again = fakeCtx({ store, raw: payload, path: '/api/integrations/square', headers });
    await handleSquare(again);
    assert.strictEqual(again.result.body.duplicate, true);
    assert.strictEqual(stock(store, 'GADGET-2'), 48);
    assert.strictEqual(saleMovements(store).length, 1);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
test('CSV sales import decrements stock and is idempotent on the id column', async () => {
  const { store, dir } = makeStore();
  const csv = 'sku,qty,id\nWIDGET-1,7,csv-a\nGADGET-2,1,csv-b\n';
  const ctx = fakeCtx({ store, raw: csv, path: '/api/integrations/csv-sales' });
  await handleCsvSales(ctx);
  assert.strictEqual(ctx.result.status, 201);
  assert.strictEqual(stock(store, 'WIDGET-1'), 93);
  assert.strictEqual(stock(store, 'GADGET-2'), 49);
  const again = fakeCtx({ store, raw: csv, path: '/api/integrations/csv-sales' });
  await handleCsvSales(again);
  assert.strictEqual(stock(store, 'WIDGET-1'), 93);
  assert.strictEqual(saleMovements(store).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CSV UTF-8 BOM is stripped from the header row', async () => {
  const { store, dir } = makeStore();
  const csv = '\uFEFFsku,qty,id\nWIDGET-1,2,csv-bom\n';
  const ctx = fakeCtx({ store, raw: csv, path: '/api/integrations/csv-sales' });
  await handleCsvSales(ctx);
  assert.strictEqual(ctx.result.status, 201);
  assert.strictEqual(stock(store, 'WIDGET-1'), 98);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CSV unknown SKU with an id can be re-imported after the product exists', async () => {
  const { store, dir } = makeStore();
  const csv = 'sku,qty,id\nNEW-SKU,3,csv-later\n';
  const first = fakeCtx({ store, raw: csv, path: '/api/integrations/csv-sales' });
  await handleCsvSales(first);
  assert.strictEqual(first.result.body.failed, 1);
  assert.strictEqual(saleMovements(store).length, 0);
  store.insert('products', {
    sku: 'NEW-SKU', name: 'New', category: 'general',
    unitCost: 1, price: 2, currentStock: 10, leadTimeDays: 2, packSize: 1, minOrderQty: 0,
  });
  const again = fakeCtx({ store, raw: csv, path: '/api/integrations/csv-sales' });
  await handleCsvSales(again);
  assert.strictEqual(stock(store, 'NEW-SKU'), 7);
  assert.strictEqual(saleMovements(store).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordSale writes a sale movement and never drops stock below zero', () => {
  const { store, dir } = makeStore();
  const r = recordSale(store, { sku: 'WIDGET-1', qty: 1000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(stock(store, 'WIDGET-1'), 0);
  const miss = recordSale(store, { sku: 'NO-SUCH', qty: 1 });
  assert.strictEqual(miss.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// register() + HTTP
// ---------------------------------------------------------------------------
test('mounted webhook routes verify signatures over HTTP', async () => {
  const { store, dir } = makeStore();
  const routes = [];
  register((r) => routes.push(r));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const ctx = {
      req, res, url, path: url.pathname, store,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      rawBody: async () => raw,
      json(status, obj) {
        const s = JSON.stringify(obj);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(s);
      },
      error(status, code, message) { this.json(status, { error: message, code }); },
    };
    await route.handler(ctx);
  });
  const { origin } = await listen(server);
  try {
    await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_http' }, async () => {
      const payload = JSON.stringify({
        id: 'evt_http',
        type: 'checkout.session.completed',
        data: { object: { metadata: { sku: 'WIDGET-1', qty: '2' } } },
      });
      const sig = stripe.signStripePayload(payload, 'whsec_http');
      const ok = await fetch(origin + '/api/integrations/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': sig },
        body: payload,
      });
      assert.strictEqual(ok.status, 200);
      const forged = await fetch(origin + '/api/integrations/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=nope' },
        body: payload,
      });
      assert.strictEqual(forged.status, 400);
      assert.strictEqual(stock(store, 'WIDGET-1'), 98);
    });
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Email: MIME + PO CSV
// ---------------------------------------------------------------------------
test('buildMessage still strips CR/LF header injection', () => {
  const msg = email.buildMessage({
    from: 'a@example.com', to: 'b@example.com',
    subject: 'PO 1 — Evil\r\nBcc: victim@example.com',
    text: 'body',
  });
  const headerLines = msg.split('\r\n\r\n')[0].split('\r\n');
  assert.ok(!headerLines.some((l) => l.startsWith('Bcc:')));
  assert.ok(headerLines.find((l) => l.startsWith('Subject:')).includes('Evil Bcc:'));
});

test('purchase order email includes a CSV attachment of the lines', () => {
  const csv = email.purchaseOrderCsv(SAMPLE_PO);
  assert.match(csv, /WIDGET-1/);
  assert.match(csv, /12/);
  const msg = email.buildMessage({
    from: 'inventory@example.com',
    to: 'supplier@example.com',
    subject: 'Purchase Order po_test1',
    text: 'Please supply',
    attachments: [email.purchaseOrderAttachment(SAMPLE_PO)],
  });
  assert.match(msg, /multipart\/mixed/);
  assert.match(msg, /filename="PO-po_test1.csv"/);
  const b64 = Buffer.from(csv, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
  assert.ok(msg.includes(b64) || msg.includes(Buffer.from(csv, 'utf8').toString('base64')));
});

// ---------------------------------------------------------------------------
// Fake SMTP
// ---------------------------------------------------------------------------
function loadTlsPair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-tls-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-keyout', keyFile, '-out', certFile, '-days', '1', '-nodes', '-subj', '/CN=localhost',
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    return {
      dir,
      key: EMBEDDED_KEY,
      cert: EMBEDDED_CERT,
    };
  }
  return { dir, key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
}

const EMBEDDED_CERT = `-----BEGIN CERTIFICATE-----
MIICDDCCAbICCQDIPujFxB4zqzAKBggqhkjOPQQDAjAUMRIwEAYDVQQDDAlsb2Nh
bGhvc3QwHhcNMjYwOTI2MDM0MTE4WhcNMzYwOTIzMDM0MTE4WjAUMRIwEAYDVQQD
DAlsb2NhbGhvc3QwggFLMIIBAwYHKoZIzj0CATCB9wIBATAsBgcqhkjOPQEBAiEA
/////wAAAAEAAAAAAAAAAAAAAAD///////////////8wWwQg/////wAAAAEAAAAA
AAAAAAAAAAD///////////////wEIFrGNdiqOpPns+u9VXaYhrxlHQawzFOw9jvO
PD4n0mBLAxUAxJ02CIbnBJNqZnjhE50mt4GffpAEQQRrF9Hy4SxCR/i85uVjpEDy
dwN9gS3rM6D0oTlF2JjClk/jQuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1
AiEA/////wAAAAD//////////7zm+q2nF56E87nKwvxjJVECAQEDQgAEKZRPXv1a
fNDn8nPAHEj9PMDSQMVkKAoP2r1w4I9ySCKWnvdEfz0jpk9mt8/8oreeY6lOejEG
bdFv6yZw8/al5TAKBggqhkjOPQQDAgNIADBFAiEArghMnhuUMGKnXP1asthlthjs
38+KC2XfdsI3j+cveq4CIDkJdQPWzzed87IQiguy1QaIgLWQOk7hhUcoISqdtYMi
-----END CERTIFICATE-----
`;
// TEST-ONLY: throwaway self-signed key for the localhost STARTTLS test server (CN=localhost).
// It protects nothing and is not a secret.
const EMBEDDED_KEY = `-----BEGIN PRIVATE KEY-----
MIIBeQIBADCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAAB
AAAAAAAAAAAAAAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA
///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMV
AMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg
9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8A
AAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBBG0wawIBAQQgpMfbU5hG8rvs
iS1yE+ydI1phZ9VdbLGwG4MVP6dRJdqhRANCAAQplE9e/Vp80Ofyc8AcSP08wNJA
xWQoCg/avXDgj3JIIpae90R/PSOmT2a3z/yit55jqU56MQZt0W/rJnDz9qXl
-----END PRIVATE KEY-----
`;

function attachSmtp(initial, { tlsKey, tlsCert, collected }) {
  let conn = initial;
  let buf = '';
  let dataMode = false;
  let dataAcc = '';
  let loginStep = 0;

  function send(s) { conn.write(s); }

  function onChunk(chunk) {
    if (dataMode) {
      dataAcc += chunk.toString();
      if (/\r?\n\.\r?\n/.test(dataAcc)) {
        collected.data = dataAcc.replace(/\r?\n\.\r?\n[\s\S]*$/, '');
        dataMode = false;
        send('250 OK\r\n');
      }
      return;
    }
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      onLine(line);
    }
  }

  function onLine(line) {
    const u = line.toUpperCase();
    if (u.startsWith('EHLO') || u.startsWith('HELO')) {
      send('250-localhost\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
    } else if (u === 'STARTTLS') {
      send('220 Ready to start TLS\r\n');
      conn.removeAllListeners('data');
      const tlsSock = new tls.TLSSocket(conn, {
        isServer: true,
        key: tlsKey,
        cert: tlsCert,
      });
      conn = tlsSock;
      collected.starttls = true;
      conn.on('data', onChunk);
    } else if (u.startsWith('AUTH PLAIN')) {
      collected.auth.push(line);
      send('235 2.7.0 Authentication successful\r\n');
    } else if (u === 'AUTH LOGIN') {
      loginStep = 1;
      collected.auth.push(line);
      send('334 VXNlcm5hbWU6\r\n');
    } else if (loginStep === 1) {
      collected.auth.push(line);
      loginStep = 2;
      send('334 UGFzc3dvcmQ6\r\n');
    } else if (loginStep === 2) {
      collected.auth.push(line);
      loginStep = 0;
      send('235 2.7.0 Authentication successful\r\n');
    } else if (u.startsWith('MAIL FROM:')) {
      collected.from = line;
      send('250 OK\r\n');
    } else if (u.startsWith('RCPT TO:')) {
      collected.to = line;
      send('250 OK\r\n');
    } else if (u === 'DATA') {
      dataMode = true;
      dataAcc = '';
      send('354 End data with <CR><LF>.<CR><LF>\r\n');
    } else if (u === 'QUIT') {
      send('221 Bye\r\n');
      try { conn.end(); } catch {}
    } else {
      send('250 OK\r\n');
    }
  }

  send('220 localhost ESMTP tanpin-test\r\n');
  conn.on('data', onChunk);
}

test('SMTP STARTTLS on port 587 delivers a PO with CSV against a local fake server', async () => {
  const pair = loadTlsPair();
  const collected = { auth: [], data: '', starttls: false };
  const server = net.createServer((socket) => attachSmtp(socket, { tlsKey: pair.key, tlsCert: pair.cert, collected }));
  const { port } = await listen(server);
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-out-'));
  try {
    const rec = await withEnv({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_USER: 'mailer',
      SMTP_PASS: 'secret',
      SMTP_AUTH: 'plain',
      SMTP_SECURE: '0',
      SMTP_STARTTLS: '1',
      SMTP_TLS_REJECT_UNAUTHORIZED: '0',
    }, () => email.sendEmail({
      from: 'inventory@example.com',
      to: 'supplier@example.com',
      subject: 'Purchase Order po_test1',
      text: 'Please supply the attached lines.',
      purchaseOrder: SAMPLE_PO,
      outboxDir: outbox,
    }));
    assert.strictEqual(rec.transport, 'smtp', rec.smtpError || 'expected smtp transport');
    assert.strictEqual(collected.starttls, true);
    assert.ok(collected.auth.some((a) => a.toUpperCase().startsWith('AUTH PLAIN')));
    assert.match(collected.data, /multipart\/mixed/);
    assert.match(collected.data, /PO-po_test1.csv/);
    assert.match(collected.from, /inventory@example.com/);
    assert.match(collected.to, /supplier@example.com/);
  } finally {
    await close(server);
    fs.rmSync(pair.dir, { recursive: true, force: true });
    fs.rmSync(outbox, { recursive: true, force: true });
  }
});

test('SMTP implicit TLS on 465 with AUTH LOGIN against a local fake server', async () => {
  const pair = loadTlsPair();
  const collected = { auth: [], data: '', starttls: false };
  const server = tls.createServer({ key: pair.key, cert: pair.cert }, (socket) => {
    attachSmtp(socket, { tlsKey: pair.key, tlsCert: pair.cert, collected });
  });
  const { port } = await listen(server);
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-out-'));
  try {
    const rec = await withEnv({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_USER: 'mailer',
      SMTP_PASS: 'secret',
      SMTP_AUTH: 'login',
      SMTP_SECURE: '1',
      SMTP_TLS_REJECT_UNAUTHORIZED: '0',
    }, () => email.sendEmail({
      from: 'inventory@example.com',
      to: 'supplier@example.com',
      subject: 'hello',
      text: 'plain body',
      outboxDir: outbox,
    }));
    assert.strictEqual(rec.transport, 'smtp', rec.smtpError || 'expected smtp transport');
    assert.ok(collected.auth.includes('AUTH LOGIN'));
    assert.match(collected.data, /plain body/);
  } finally {
    await close(server);
    fs.rmSync(pair.dir, { recursive: true, force: true });
    fs.rmSync(outbox, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTPS senders
// ---------------------------------------------------------------------------
function jsonServer(onHit) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (onHit) onHit(req, body, res, hits);
      else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'ok' }));
      }
    });
  });
  return { server, hits };
}

test('Resend HTTPS sender posts JSON to a local fake server with CSV attachment', async () => {
  const { server, hits } = jsonServer();
  const { origin } = await listen(server);
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-out-'));
  try {
    const rec = await withEnv({
      RESEND_API_KEY: 're_test',
      RESEND_API_URL: origin + '/emails',
    }, () => email.sendEmail({
      from: 'inventory@example.com',
      to: 'supplier@example.com',
      subject: 'PO',
      text: 'lines',
      purchaseOrder: SAMPLE_PO,
      outboxDir: outbox,
    }));
    assert.strictEqual(rec.transport, 'resend', rec.smtpError || '');
    assert.strictEqual(hits.length, 1);
    assert.ok(hits[0].headers.authorization.startsWith('Bearer re_test'));
    const body = JSON.parse(hits[0].body);
    assert.strictEqual(body.subject, 'PO');
    assert.ok(Array.isArray(body.attachments) && body.attachments.length === 1);
    assert.match(body.attachments[0].filename, /PO-po_test1.csv/);
  } finally {
    await close(server);
    fs.rmSync(outbox, { recursive: true, force: true });
  }
});

test('Postmark HTTPS sender posts to a local fake server', async () => {
  const { server, hits } = jsonServer();
  const { origin } = await listen(server);
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-out-'));
  try {
    const rec = await withEnv({
      POSTMARK_SERVER_TOKEN: 'pm_test',
      POSTMARK_API_URL: origin + '/email',
    }, () => email.sendEmail({
      from: 'inventory@example.com',
      to: 'supplier@example.com',
      subject: 'digest',
      text: 'hello',
      outboxDir: outbox,
    }));
    assert.strictEqual(rec.transport, 'postmark', rec.smtpError || '');
    assert.strictEqual(hits[0].headers['x-postmark-server-token'], 'pm_test');
    const body = JSON.parse(hits[0].body);
    assert.strictEqual(body.To, 'supplier@example.com');
    assert.strictEqual(body.TextBody, 'hello');
  } finally {
    await close(server);
    fs.rmSync(outbox, { recursive: true, force: true });
  }
});

test('SES v2 HTTPS sender signs with SigV4 against a local fake server', async () => {
  const { server, hits } = jsonServer();
  const { origin } = await listen(server);
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-out-'));
  try {
    const rec = await withEnv({
      AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      AWS_REGION: 'us-east-1',
      AWS_SES_ENDPOINT: origin + '/v2/email/outbound-emails',
    }, () => email.sendEmail({
      from: 'inventory@example.com',
      to: 'supplier@example.com',
      subject: 'ses',
      text: 'via ses',
      outboxDir: outbox,
    }));
    assert.strictEqual(rec.transport, 'ses', rec.smtpError || '');
    const h = hits[0].headers;
    assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    assert.match(h.authorization, /Signature=[0-9a-f]{64}/);
    assert.ok(h['x-amz-date']);
    const body = JSON.parse(hits[0].body);
    assert.deepStrictEqual(body.Destination.ToAddresses, ['supplier@example.com']);

    // Independent check: recomputing the signature with the same inputs matches.
    const signed = email.signAwsV4({
      method: 'POST',
      url: origin + '/v2/email/outbound-emails',
      body: hits[0].body,
      headers: { 'content-type': 'application/json' },
      accessKey: 'AKIDEXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'ses',
      amzDate: h['x-amz-date'],
    });
    assert.ok(h.authorization.includes(signed.signature));
  } finally {
    await close(server);
    fs.rmSync(outbox, { recursive: true, force: true });
  }
});

test('SigV4 empty-payload hash and date-key match the published AWS values', () => {
  const empty = crypto.createHash('sha256').update('').digest('hex');
  assert.strictEqual(empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const signed = email.signAwsV4({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    body: '',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'iam',
    amzDate: '20150830T123600Z',
    includeContentSha256: false,
  });
  assert.strictEqual(signed.datetime, '20150830T123600Z');
  assert.match(signed.headers.authorization, /SignedHeaders=content-type;host;x-amz-date/);
  // Published GET IAM example from the AWS SigV4 signing walkthrough.
  assert.strictEqual(signed.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

// ---------------------------------------------------------------------------
// Review regressions: real provider payload shapes, unconsumed event ids,
// store-local CSV dates. Providers are local fake servers.
// ---------------------------------------------------------------------------
function fakeProvider(routes) {
  const calls = [];
  const srv = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      calls.push({ method: rq.method, url: rq.url, auth: rq.headers.authorization, body });
      const key = `${rq.method} ${rq.url.split('?')[0]}`;
      const handler = routes[key];
      if (!handler) { rs.writeHead(404, { 'content-type': 'application/json' }); rs.end('{"errors":[{"code":"NOT_FOUND"}]}'); return; }
      const [status, obj] = handler(rq, body);
      rs.writeHead(status, { 'content-type': 'application/json' });
      rs.end(JSON.stringify(obj));
    });
  });
  return listen(srv).then(({ origin }) => ({ srv, calls, origin }));
}

// A real checkout.session.completed: no line_items on the session object.
function realStripeEvent(id, sessionId) {
  return JSON.stringify({
    id, object: 'event', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment', payment_status: 'paid', metadata: {} } },
  });
}

// A real order.created: only the order id, state and version.
function realSquareEvent(orderId) {
  return JSON.stringify({
    merchant_id: 'MLX', type: 'order.created', event_id: `evt-${orderId}`, created_at: '2026-01-15T10:00:00Z',
    data: { type: 'order_created', id: orderId, object: { order_created: { order_id: orderId, state: 'OPEN', version: 1, location_id: 'L1', created_at: '2026-01-15T10:00:00Z' } } },
  });
}

test('real Stripe checkout.session.completed (no line items) fetches line items from the API and decrements', async () => {
  const { store, dir } = makeStore();
  const provider = await fakeProvider({
    'GET /v1/checkout/sessions/cs_test_real/line_items': () => [200, {
      object: 'list', has_more: false,
      data: [
        { id: 'li_1', quantity: 2, price: { id: 'price_1', lookup_key: 'WIDGET-1', product: { id: 'prod_1', metadata: {} } } },
        { id: 'li_2', quantity: 1, price: { id: 'price_2', lookup_key: null, product: { id: 'prod_2', metadata: { sku: 'GADGET-2' } } } },
      ],
    }],
  });
  try {
    await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_KEY: 'rk_test_fake', STRIPE_API_BASE: provider.origin }, async () => {
      const raw = realStripeEvent('evt_real_1', 'cs_test_real');
      const ctx = fakeCtx({ store, raw, headers: { 'stripe-signature': stripe.signStripePayload(raw, 'whsec_test') } });
      await handleStripe(ctx);
      assert.strictEqual(ctx.result.status, 200);
      assert.strictEqual(ctx.result.body.recorded, 2);
      assert.strictEqual(ctx.result.body.source, 'stripe_api');
      assert.strictEqual(stock(store, 'WIDGET-1'), 98);
      assert.strictEqual(stock(store, 'GADGET-2'), 49);
      assert.strictEqual(provider.calls[0].auth, 'Bearer rk_test_fake');
      assert.match(provider.calls[0].url, /expand%5B%5D=data.price.product|expand\[\]=data.price.product/);

      const again = fakeCtx({ store, raw, headers: { 'stripe-signature': stripe.signStripePayload(raw, 'whsec_test') } });
      await handleStripe(again);
      assert.strictEqual(again.result.body.duplicate, true);
      assert.strictEqual(stock(store, 'WIDGET-1'), 98, 'a retry does not decrement twice');
    });
  } finally {
    await close(provider.srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Stripe event that records nothing is not consumed: replay after configuring the API key works', async () => {
  const { store, dir } = makeStore();
  const provider = await fakeProvider({
    'GET /v1/checkout/sessions/cs_test_late/line_items': () => [200, { has_more: false, data: [{ id: 'li', quantity: 3, price: { lookup_key: 'WIDGET-1' } }] }],
  });
  try {
    const raw = realStripeEvent('evt_late_1', 'cs_test_late');
    await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test' }, async () => {
      const first = fakeCtx({ store, raw, headers: { 'stripe-signature': stripe.signStripePayload(raw, 'whsec_test') } });
      await handleStripe(first);
      assert.strictEqual(first.result.status, 200, 'still 2xx so Stripe does not hammer us');
      assert.strictEqual(first.result.body.recorded, 0);
      assert.strictEqual(first.result.body.consumed, false);
      assert.match(first.result.body.hint, /STRIPE_API_KEY/);
    });
    await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_KEY: 'rk_test_fake', STRIPE_API_BASE: provider.origin }, async () => {
      const replay = fakeCtx({ store, raw, headers: { 'stripe-signature': stripe.signStripePayload(raw, 'whsec_test') } });
      await handleStripe(replay);
      assert.strictEqual(replay.result.body.duplicate, undefined, 'the id was not burned by the empty first delivery');
      assert.strictEqual(replay.result.body.recorded, 1);
      assert.strictEqual(stock(store, 'WIDGET-1'), 97);
    });
  } finally {
    await close(provider.srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Stripe API outage returns 5xx (so Stripe retries) and does not consume the event', async () => {
  const { store, dir } = makeStore();
  const provider = await fakeProvider({
    'GET /v1/checkout/sessions/cs_test_down/line_items': () => [500, { error: { message: 'boom' } }],
  });
  try {
    await withEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_KEY: 'rk_test_fake', STRIPE_API_BASE: provider.origin }, async () => {
      const raw = realStripeEvent('evt_down_1', 'cs_test_down');
      const ctx = fakeCtx({ store, raw, headers: { 'stripe-signature': stripe.signStripePayload(raw, 'whsec_test') } });
      await handleStripe(ctx);
      assert.strictEqual(ctx.result.status, 502);
      assert.strictEqual(ctx.result.body.code, 'provider_fetch_failed');
      assert.ok(!store.data.inboundEvents['stripe:evt_down_1'], 'event id released for the retry');
      assert.strictEqual(stock(store, 'WIDGET-1'), 100);
    });
  } finally {
    await close(provider.srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real Square order.created fetches the order and maps variations to SKUs via the Catalog API', async () => {
  const { store, dir } = makeStore();
  const provider = await fakeProvider({
    'GET /v2/orders/ORD-REAL-1': () => [200, { order: { id: 'ORD-REAL-1', state: 'COMPLETED', line_items: [
      { uid: 'a', catalog_object_id: 'VAR-W', quantity: '4', name: 'Widget' },
      { uid: 'b', catalog_object_id: 'VAR-G', quantity: '1', name: 'Gadget' },
      { uid: 'c', quantity: '2', name: 'Custom', metadata: { sku: 'GADGET-2' } },
    ] } }],
    'POST /v2/catalog/batch-retrieve': (_rq, body) => {
      const ids = JSON.parse(body).object_ids;
      const known = { 'VAR-W': 'WIDGET-1', 'VAR-G': 'GADGET-2' };
      return [200, { objects: ids.filter((id) => known[id]).map((id) => ({ id, type: 'ITEM_VARIATION', item_variation_data: { sku: known[id] } })) }];
    },
  });
  try {
    const url = 'https://tanpin.example/api/integrations/square';
    await withEnv({ SQUARE_SIGNATURE_KEY: 'sqsig', SQUARE_NOTIFICATION_URL: url, SQUARE_ACCESS_TOKEN: 'EAAA-fake', SQUARE_API_BASE: provider.origin }, async () => {
      const raw = realSquareEvent('ORD-REAL-1');
      const ctx = fakeCtx({ store, raw, path: '/api/integrations/square', headers: { 'x-square-hmacsha256-signature': square.signSquarePayload(raw, 'sqsig', url) } });
      await handleSquare(ctx);
      assert.strictEqual(ctx.result.status, 200);
      assert.strictEqual(ctx.result.body.source, 'square_api');
      assert.strictEqual(ctx.result.body.recorded, 3);
      assert.strictEqual(stock(store, 'WIDGET-1'), 96);
      assert.strictEqual(stock(store, 'GADGET-2'), 47);
      assert.ok(provider.calls.every((c) => c.auth === 'Bearer EAAA-fake'));
    });
  } finally {
    await close(provider.srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Square order.created without an access token is answered 2xx but not consumed', async () => {
  const { store, dir } = makeStore();
  try {
    const url = 'https://tanpin.example/api/integrations/square';
    await withEnv({ SQUARE_SIGNATURE_KEY: 'sqsig', SQUARE_NOTIFICATION_URL: url }, async () => {
      const raw = realSquareEvent('ORD-NOTOKEN');
      for (let i = 0; i < 2; i++) {
        const ctx = fakeCtx({ store, raw, path: '/api/integrations/square', headers: { 'x-square-hmacsha256-signature': square.signSquarePayload(raw, 'sqsig', url) } });
        await handleSquare(ctx);
        assert.strictEqual(ctx.result.status, 200);
        assert.strictEqual(ctx.result.body.recorded, 0);
        assert.strictEqual(ctx.result.body.duplicate, undefined, 'second delivery is not reported as a duplicate');
        assert.match(ctx.result.body.hint, /SQUARE_ACCESS_TOKEN/);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CSV date-only and offset-less dates are store-local days (settings.timezone)', async () => {
  const forecast = require('../src/engine/forecast');
  const { store, dir } = makeStore();
  try {
    store.data.settings.timezone = 'Pacific/Honolulu'; // UTC-10: UTC midnight would be the previous day
    store.save();
    const raw = 'sku,qty,date\nWIDGET-1,1,2026-01-15\nWIDGET-1,1,2026-01-15 23:30\nWIDGET-1,1,2026-01-15T00:15:00Z\n';
    const ctx = fakeCtx({ store, raw, path: '/api/integrations/csv-sales' });
    await handleCsvSales(ctx);
    assert.strictEqual(ctx.result.body.recorded, 3);
    const days = saleMovements(store).map((m) => forecast.calendarDayKey(m.at, 'Pacific/Honolulu'));
    assert.deepStrictEqual(days, ['2026-01-15', '2026-01-15', '2026-01-14'], 'explicit Z stays an exact instant');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
