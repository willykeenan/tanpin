// API integration tests — boots the real server on an ephemeral port and
// exercises the B2B surface end to end: auth, SKU addressing, idempotency,
// recommendations → purchase orders, webhooks (with HMAC verification),
// CSV import/export, and the discovery endpoints.
// Run with `npm test` (node --test). Zero dependencies.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate this run's data before the server module loads.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-test-'));
const dbFile = path.join(tmpDir, 'inventory.json');
process.env.TANPIN_DB = dbFile;
process.env.INVENTORY_DB = dbFile;
delete process.env.REQUIRE_API_KEY;
delete process.env.TANPIN_REQUIRE_API_KEY;
delete process.env.INVENTORY_ADMIN_KEY;
delete process.env.TANPIN_ADMIN_KEY;
delete process.env.DEMO_MODE;
delete process.env.TANPIN_CORS_ORIGINS;
delete process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS;

const { server } = require('../src/server');

let BASE = '';
const DAY = 86400000;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function req(method, p, { body, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, headers: res.headers };
}

// ---------------------------------------------------------------------------
test('discovery: health, api index, openapi, llms.txt are served', async () => {
  const health = await req('GET', '/api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.data.ok, true);
  assert.ok(health.data.version);

  const index = await req('GET', '/api');
  assert.strictEqual(index.status, 200);
  assert.ok(index.data.endpoints.length > 20);

  const oas = await req('GET', '/openapi.json');
  assert.strictEqual(oas.status, 200);
  assert.strictEqual(oas.data.openapi, '3.1.0');
  for (const p of ['/api/state', '/api/products', '/api/sales', '/api/recommendations', '/api/purchase-orders', '/api/webhooks', '/api/keys']) {
    assert.ok(oas.data.paths[p], `openapi should document ${p}`);
  }

  const llms = await fetch(BASE + '/llms.txt');
  assert.strictEqual(llms.status, 200);
  const llmsText = await llms.text();
  assert.ok(llmsText.length > 40);
  assert.match(llmsText, /Tanpin/);
});

test('suppliers + products: create, duplicate-sku rejection, SKU addressing', async () => {
  const sup = await req('POST', '/api/suppliers', {
    body: { name: 'Test Supplier', email: 'orders@test.example', leadTimeDays: 2, deliveryWindows: '9,15', minOrderValue: 0 },
  });
  assert.strictEqual(sup.status, 201);

  const prod = await req('POST', '/api/products', {
    body: { sku: 'WIDGET-1', name: 'Widget', supplierId: sup.data.id, unitCost: 1, price: 3, currentStock: 100, leadTimeDays: 2 },
  });
  assert.strictEqual(prod.status, 201);

  const dup = await req('POST', '/api/products', { body: { sku: 'WIDGET-1', name: 'Widget again' } });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.data.code, 'duplicate_sku');

  const bySku = await req('GET', '/api/products/WIDGET-1');
  assert.strictEqual(bySku.status, 200);
  assert.strictEqual(bySku.data.name, 'Widget');

  const missing = await req('GET', '/api/products/NOPE');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.data.code, 'product_not_found');
});

test('sales by SKU with history → recommendations → PO from recommendations → receive', async () => {
  // Two weeks of ~10/day sales history so the forecast engine has signal.
  const now = Date.now();
  const sales = [];
  for (let d = 14; d >= 1; d--) sales.push({ sku: 'WIDGET-1', qty: 10, at: now - d * DAY });
  const bulk = await req('POST', '/api/sales/bulk', { body: { sales } });
  assert.strictEqual(bulk.status, 201);
  assert.strictEqual(bulk.data.recorded, 14);
  assert.strictEqual(bulk.data.failed, 0);

  const p = await req('GET', '/api/products/WIDGET-1');
  assert.strictEqual(p.data.currentStock, 0, 'stock should be sold down to 0');
  assert.ok(p.data.avgDailyDemand > 5, `daily demand should be ~10, got ${p.data.avgDailyDemand}`);

  const recs = await req('GET', '/api/recommendations');
  assert.strictEqual(recs.status, 200);
  const rec = recs.data.recommendations.find((r) => r.supplierName === 'Test Supplier');
  assert.ok(rec, 'should recommend ordering from Test Supplier');
  assert.ok(rec.lines.some((l) => l.sku === 'WIDGET-1' && l.qty > 0));

  const po = await req('POST', '/api/purchase-orders', {
    body: { supplierId: 'Test Supplier', fromRecommendations: true },
  });
  assert.strictEqual(po.status, 201);
  assert.ok(po.data.eta > Date.now(), 'PO should carry a future ETA');
  const orderedQty = po.data.lines.find((l) => l.sku === 'WIDGET-1').qty;
  assert.ok(orderedQty > 0);

  const recv = await req('POST', `/api/purchase-orders/${po.data.id}/receive`);
  assert.strictEqual(recv.status, 200);
  const after1 = await req('GET', '/api/products/WIDGET-1');
  assert.strictEqual(after1.data.currentStock, orderedQty, 'received units should land in stock');

  const recvAgain = await req('POST', `/api/purchase-orders/${po.data.id}/receive`);
  assert.strictEqual(recvAgain.status, 409, 'double-receive must be rejected');
});

test('idempotency: same key replays the response without re-applying the write', async () => {
  const before1 = (await req('GET', '/api/products/WIDGET-1')).data.currentStock;
  const h = { 'Idempotency-Key': 'idem-test-1' };
  const first = await req('POST', '/api/sales', { body: { sku: 'WIDGET-1', qty: 5 }, headers: h });
  assert.strictEqual(first.status, 201);
  const second = await req('POST', '/api/sales', { body: { sku: 'WIDGET-1', qty: 5 }, headers: h });
  assert.strictEqual(second.headers.get('idempotency-replayed'), 'true');
  const after1 = (await req('GET', '/api/products/WIDGET-1')).data.currentStock;
  assert.strictEqual(after1, before1 - 5, 'the sale must be applied exactly once');
});

test('adjust + movements audit trail', async () => {
  const adj = await req('POST', '/api/adjust', { body: { sku: 'WIDGET-1', delta: 7, reason: 'stocktake' } });
  assert.strictEqual(adj.status, 201);
  const mv = await req('GET', '/api/movements?product=WIDGET-1&limit=5');
  assert.strictEqual(mv.status, 200);
  assert.strictEqual(mv.data[0].type, 'adjustment');
  assert.strictEqual(mv.data[0].qty, 7);
  assert.strictEqual(mv.data[0].sku, 'WIDGET-1');
});

test('webhooks: registered hook receives HMAC-signed deliveries', async () => {
  process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS = '1';
  const received = [];
  const receiver = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => body += c);
    rq.on('end', () => {
      received.push({ body, event: rq.headers['x-inventory-event'], sig: rq.headers['x-inventory-signature'] });
      rs.writeHead(200); rs.end('ok');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  try {
    const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

    const hook = await req('POST', '/api/webhooks', { body: { url: hookUrl, events: ['sale.recorded', 'webhook.test'] } });
    assert.strictEqual(hook.status, 201);
    assert.ok(hook.data.secret, 'secret should be auto-generated');

    const testFire = await req('POST', `/api/webhooks/${hook.data.id}/test`);
    assert.strictEqual(testFire.status, 200);
    assert.strictEqual(testFire.data.delivery.ok, true);

    await req('POST', '/api/sales', { body: { sku: 'WIDGET-1', qty: 1 } });
    // Deliveries are async fire-and-forget — poll briefly.
    const deadline = Date.now() + 3000;
    while (received.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(received.length >= 2, `expected test + sale deliveries, got ${received.length}`);

    const sale = received.find((r) => r.event === 'sale.recorded');
    assert.ok(sale, 'sale.recorded should be delivered');
    const expected = 'sha256=' + crypto.createHmac('sha256', hook.data.secret).update(sale.body).digest('hex');
    assert.strictEqual(sale.sig, expected, 'signature must verify with the returned secret');
    const payload = JSON.parse(sale.body);
    assert.strictEqual(payload.data.product.sku, 'WIDGET-1');

    const rejected = await req('POST', '/api/webhooks', { body: { url: hookUrl, events: ['nonsense.event'] } });
    assert.strictEqual(rejected.status, 400);
  } finally {
    receiver.close();
    delete process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS;
  }
});

test('API keys + auth: loopback open, cross-origin writes blocked, TANPIN_REQUIRE_API_KEY', async () => {
  const created = await req('POST', '/api/keys', { body: { name: 'test-key' } });
  assert.strictEqual(created.status, 201);
  assert.match(created.data.key, /^ti_[0-9a-f]{48}$/);

  const listed = await req('GET', '/api/keys');
  assert.ok(!JSON.stringify(listed.data).includes(created.data.key), 'full key must never be listed');

  // Same-origin dashboard still works without a key.
  const sameOrigin = await req('POST', '/api/keys', {
    body: { name: 'from-dashboard' },
    headers: { Origin: BASE },
  });
  assert.strictEqual(sameOrigin.status, 201);

  // A visited website cannot create keys or wipe data.
  const stolen = await req('POST', '/api/keys', {
    body: { name: 'stolen' },
    headers: { Origin: 'https://evil.example' },
  });
  assert.strictEqual(stolen.status, 403);
  assert.strictEqual(stolen.data.code, 'origin_forbidden');
  assert.notStrictEqual(stolen.headers.get('access-control-allow-origin'), '*');

  const wipe = await req('POST', '/api/reset', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(wipe.status, 403);
  assert.strictEqual(wipe.data.code, 'origin_forbidden');

  const health = await req('GET', '/api/health');
  assert.strictEqual(health.status, 200, 'health stays public');
  assert.notStrictEqual(health.headers.get('access-control-allow-origin'), '*');

  process.env.TANPIN_REQUIRE_API_KEY = '1';
  try {
    const denied = await req('GET', '/api/state');
    assert.strictEqual(denied.status, 401);
    assert.strictEqual(denied.data.code, 'missing_api_key');

    const bearer = await req('GET', '/api/state', { headers: { Authorization: `Bearer ${created.data.key}` } });
    assert.strictEqual(bearer.status, 200);
    const xkey = await req('GET', '/api/state', { headers: { 'X-API-Key': created.data.key } });
    assert.strictEqual(xkey.status, 200);

    const bad = await req('GET', '/api/state', { headers: { 'X-API-Key': 'ti_wrong' } });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(bad.data.code, 'invalid_api_key');

    process.env.TANPIN_ADMIN_KEY = 'master-secret';
    const admin = await req('GET', '/api/state', { headers: { Authorization: 'Bearer master-secret' } });
    assert.strictEqual(admin.status, 200);

    const healthLocked = await req('GET', '/api/health');
    assert.strictEqual(healthLocked.status, 200, 'health stays public');

    // Revoked keys stop working.
    const revoked = await req('DELETE', `/api/keys/${created.data.id}`, { headers: { Authorization: 'Bearer master-secret' } });
    assert.strictEqual(revoked.status, 200);
    const deadKey = await req('GET', '/api/state', { headers: { Authorization: `Bearer ${created.data.key}` } });
    assert.strictEqual(deadKey.status, 401);
  } finally {
    delete process.env.TANPIN_REQUIRE_API_KEY;
    delete process.env.REQUIRE_API_KEY;
    delete process.env.TANPIN_ADMIN_KEY;
    delete process.env.INVENTORY_ADMIN_KEY;
  }
});

test('CSV import creates products + suppliers; export round-trips', async () => {
  const csvText = [
    'sku,name,category,supplierName,unitCost,price,currentStock,leadTimeDays,packSize',
    'CSV-1,"Imported, Thing A",imported,CSV Supplier,1.5,4,50,3,6',
    'CSV-2,Imported Thing B,imported,CSV Supplier,2,5,20,3,1',
  ].join('\n');
  const imp = await req('POST', '/api/import/products', { body: csvText });
  assert.strictEqual(imp.status, 201);
  assert.strictEqual(imp.data.created, 2);
  assert.strictEqual(imp.data.suppliersCreated, 1);

  const p1 = await req('GET', '/api/products/CSV-1');
  assert.strictEqual(p1.data.name, 'Imported, Thing A', 'quoted commas must parse');
  assert.strictEqual(p1.data.currentStock, 50);

  const reImp = await req('POST', '/api/import/products', { body: [{ sku: 'CSV-1', currentStock: 75 }] });
  assert.strictEqual(reImp.data.updated, 1, 'bulk import upserts by SKU');
  assert.strictEqual((await req('GET', '/api/products/CSV-1')).data.currentStock, 75);

  const exp = await fetch(BASE + '/api/export/products.csv');
  assert.strictEqual(exp.status, 200);
  assert.match(exp.headers.get('content-type'), /text\/csv/);
  const text = await exp.text();
  assert.match(text, /CSV-1/);
  assert.match(text, /"Imported, Thing A"/);
});

test('versioned paths: /api/v1/... behaves like /api/...', async () => {
  const v1 = await req('GET', '/api/v1/products/WIDGET-1');
  assert.strictEqual(v1.status, 200);
  assert.strictEqual(v1.data.sku, 'WIDGET-1');
});

test('JSON bodies cannot reach prototypes via __proto__ keys', async () => {
  const res = await req('PUT', '/api/settings', {
    body: '{"targetDaysOfSupply": 9, "__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.targetDaysOfSupply, 9);
  assert.strictEqual({}.polluted, undefined, 'Object.prototype must stay clean');
  const settings = (await req('GET', '/api/settings')).data;
  assert.strictEqual(settings.polluted, undefined, 'settings prototype must stay clean');
});

test('email headers strip CR/LF injection from user-entered fields', () => {
  const { buildMessage } = require('../src/engine/email');
  const msg = buildMessage({
    from: 'a@x.com', to: 'b@y.com',
    subject: 'PO 1 — Evil\r\nBcc: victim@example.com',
    text: 'body',
  });
  const headerLines = msg.split('\r\n\r\n')[0].split('\r\n');
  assert.ok(!headerLines.some((l) => l.startsWith('Bcc:')), 'injected header line must not appear');
  assert.ok(headerLines.find((l) => l.startsWith('Subject:')).includes('Evil Bcc:'), 'payload stays inside the subject value');
});

test('daemon cycle runs and reports via the API', async () => {
  const run = await req('POST', '/api/daemon/run');
  assert.strictEqual(run.status, 200);
  assert.ok(run.data.recomputed >= 3);
  const log = await req('GET', '/api/daemon/log');
  assert.ok(log.data.length >= 1);
});
