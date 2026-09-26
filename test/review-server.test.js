'use strict';
// Regression tests for the independent security/correctness review — server
// level: reverse-proxy auth, secret masking, SSRF ranges, demo/Space hosts,
// CSP, cross-process stock updates, store timezone, hypotheses and write cost.
// Boots the real server in-process on an ephemeral port. Zero dependencies.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-review-'));
const dbFile = path.join(tmpDir, 'inventory.json');
process.env.TANPIN_DB = dbFile;
process.env.INVENTORY_DB = dbFile;
for (const k of ['REQUIRE_API_KEY', 'TANPIN_REQUIRE_API_KEY', 'INVENTORY_ADMIN_KEY', 'TANPIN_ADMIN_KEY',
  'DEMO_MODE', 'TANPIN_CORS_ORIGINS', 'TANPIN_ALLOW_PRIVATE_WEBHOOKS', 'SPACE_HOST', 'TANPIN_STORE']) {
  delete process.env[k];
}

const { server, store, webhookUrlBlocked } = require('../src/server');
const forecast = require('../src/engine/forecast');

const DAY = 86400000;
let PORT = 0;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  PORT = server.address().port;
});
after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Raw HTTP so tests control Host and forwarding headers exactly. */
function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        host: `127.0.0.1:${PORT}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        resolve({ status: res.statusCode, data: parsed, headers: res.headers, text: data });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

async function seedStore() {
  const r = await req('POST', '/api/seed');
  assert.equal(r.status, 200);
  return r.data;
}

// ---------------------------------------------------------------------------
// Reverse proxy on the same host
// ---------------------------------------------------------------------------
test('reverse-proxied requests need an API key even though the TCP peer is 127.0.0.1', async () => {
  process.env.TANPIN_CORS_ORIGINS = 'https://inv.example.com';
  try {
    const proxied = await req('POST', '/api/keys', {
      body: { name: 'via-proxy' },
      headers: { host: 'inv.example.com', 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(proxied.status, 401, 'public Host + X-Forwarded-For must not count as loopback');
    assert.equal(proxied.data.code, 'missing_api_key');
    assert.equal(proxied.data.key, undefined);

    // A public Host alone (proxy that strips forwarding headers) is not local either.
    const publicHost = await req('GET', '/api/state', { headers: { host: 'inv.example.com' } });
    assert.equal(publicHost.status, 401);

    // Loopback Host but a forwarding header (proxy that rewrites Host) is not local.
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'via']) {
      const r = await req('POST', '/api/keys', { body: { name: 'x' }, headers: { [h]: '198.51.100.9' } });
      assert.equal(r.status, 401, `${h} must disable the loopback bypass`);
    }
  } finally {
    delete process.env.TANPIN_CORS_ORIGINS;
  }
});

test('direct loopback requests (the local dashboard, curl, MCP) still need no key', async () => {
  const state = await req('GET', '/api/state');
  assert.equal(state.status, 200);
  const hyp = await req('POST', '/api/hypotheses', {
    body: { note: 'local', multiplier: 1.1, category: 'x' },
    headers: { origin: `http://127.0.0.1:${PORT}` },
  });
  assert.equal(hyp.status, 201);
  const localhost = await req('GET', '/api/state', { headers: { host: `localhost:${PORT}` } });
  assert.equal(localhost.status, 200);
});

test('a key still works through the proxy', async () => {
  process.env.TANPIN_ADMIN_KEY = 'review-admin-key';
  process.env.TANPIN_CORS_ORIGINS = 'https://inv.example.com';
  try {
    const r = await req('GET', '/api/state', {
      headers: { host: 'inv.example.com', 'x-forwarded-for': '203.0.113.7', 'x-api-key': 'review-admin-key' },
    });
    assert.equal(r.status, 200);
  } finally {
    delete process.env.TANPIN_ADMIN_KEY;
    delete process.env.TANPIN_CORS_ORIGINS;
  }
});

// ---------------------------------------------------------------------------
// Secrets in read responses
// ---------------------------------------------------------------------------
test('cross-origin reads need a key, even from an allowlisted origin', async () => {
  process.env.TANPIN_CORS_ORIGINS = 'https://app.example';
  try {
    const r = await req('GET', '/api/state', { headers: { origin: 'https://app.example' } });
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'missing_api_key');
    assert.ok(!r.text.includes('settings'), 'no state body without a key');
    const settings = await req('GET', '/api/settings', { headers: { origin: 'https://app.example' } });
    assert.equal(settings.status, 401);
  } finally {
    delete process.env.TANPIN_CORS_ORIGINS;
  }
});

test('signing secrets are masked in /api/state, /api/settings and /api/webhooks', async () => {
  const put = await req('PUT', '/api/settings', {
    body: { integrations: {
      stripe: { webhookSecret: 'whsec_REVIEW_SECRET', apiKey: 'rk_test_REVIEW' },
      shopify: { webhookSecret: 'shpss_REVIEW_SECRET' },
      square: { signatureKey: 'sq_REVIEW_SECRET', accessToken: 'sq_tok_REVIEW', notificationUrl: 'https://x.example/sq' },
    } },
  });
  assert.equal(put.status, 200);
  assert.ok(!put.text.includes('REVIEW'), 'PUT response masks secrets');
  const hook = await req('POST', '/api/webhooks', { body: { url: 'https://example.com/review-hook', secret: 'HOOK_REVIEW_SECRET' } });
  assert.equal(hook.status, 201);
  assert.equal(hook.data.secret, 'HOOK_REVIEW_SECRET', 'secret is shown once, at creation');

  for (const p of ['/api/state', '/api/settings', '/api/webhooks']) {
    const r = await req('GET', p);
    assert.equal(r.status, 200, p);
    assert.ok(!r.text.includes('REVIEW_SECRET') && !r.text.includes('rk_test_REVIEW') && !r.text.includes('sq_tok_REVIEW'), `${p} leaks a secret`);
  }
  const settings = (await req('GET', '/api/settings')).data;
  assert.equal(settings.integrations.stripe.hasWebhookSecret, true);
  assert.equal(settings.integrations.square.hasAccessToken, true);
  assert.equal(settings.integrations.square.notificationUrl, 'https://x.example/sq');
  const hooks = (await req('GET', '/api/webhooks')).data.webhooks;
  assert.ok(hooks.every((h) => h.secret === undefined && h.hasSecret === true));

  // Reading the masked view and PUTting it back must not wipe the secrets.
  const back = await req('PUT', '/api/settings', { body: { integrations: settings.integrations, companyName: 'Masked Co' } });
  assert.equal(back.status, 200);
  assert.equal(store.data.settings.integrations.stripe.webhookSecret, 'whsec_REVIEW_SECRET');
  assert.equal(store.data.settings.integrations.square.accessToken, 'sq_tok_REVIEW');
  assert.equal(store.data.settings.hasIntegrations, undefined);
  // Explicit null clears one secret.
  await req('PUT', '/api/settings', { body: { integrations: { stripe: { apiKey: null } } } });
  assert.equal(store.data.settings.integrations.stripe.apiKey, undefined);
  assert.equal(store.data.settings.integrations.stripe.webhookSecret, 'whsec_REVIEW_SECRET');
  await req('DELETE', `/api/webhooks/${hook.data.id}`);
});

test('DEMO_MODE hides secrets and refuses integration secrets in settings', async () => {
  process.env.DEMO_MODE = '1';
  try {
    const r = await req('GET', '/api/state', { headers: { 'x-forwarded-for': '203.0.113.50' } });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('REVIEW_SECRET'));
    await req('PUT', '/api/settings', { body: { integrations: { stripe: { webhookSecret: 'whsec_DEMO_ATTACK' } } } });
    assert.notEqual(store.data.settings.integrations.stripe.webhookSecret, 'whsec_DEMO_ATTACK');
  } finally {
    delete process.env.DEMO_MODE;
  }
});

// ---------------------------------------------------------------------------
// SSRF ranges
// ---------------------------------------------------------------------------
test('SSRF guard blocks CGNAT, IETF, benchmark, documentation, NAT64, 6to4 and Teredo destinations', async () => {
  const blocked = [
    'http://100.64.0.1/', 'http://100.100.100.200/latest/meta-data', 'http://100.127.255.254/',
    'http://192.0.0.192/opc/v2/instance/', 'http://192.0.2.10/', 'http://198.18.0.1/', 'http://198.19.255.1/',
    'http://198.51.100.1/', 'http://203.0.113.9/', 'http://240.0.0.1/', 'http://255.255.255.255/',
    'http://[64:ff9b::a9fe:a9fe]/', 'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b::10.0.0.1]/',
    'http://[2002:a9fe:a9fe::]/', 'http://[2002:7f00:1::1]/', 'http://[2001:db8::1]/', 'http://[2001:0:4136:e378::1]/',
    'http://[::ffff:0:a9fe:a9fe]/', 'http://[fec0::1]/', 'http://[64:ff9b:1::1]/',
  ];
  for (const url of blocked) {
    assert.ok(webhookUrlBlocked(url), `expected block for ${url}`);
    const r = await req('POST', '/api/webhooks', { body: { url } });
    assert.equal(r.status, 400, `registration must be refused: ${url}`);
  }
  for (const url of ['https://example.com/h', 'http://93.184.215.14/h', 'http://[64:ff9b::5db8:d70e]/h', 'http://[2002:5db8:d70e::1]/h', 'http://100.128.0.1/']) {
    assert.equal(webhookUrlBlocked(url), null, `public destination should pass: ${url}`);
  }
});

// ---------------------------------------------------------------------------
// Docker / Space / demo
// ---------------------------------------------------------------------------
test('DEMO_MODE lets a non-loopback client make the demo writes without a key', async () => {
  process.env.DEMO_MODE = '1';
  const remote = { 'x-forwarded-for': '203.0.113.77' }; // looks like Docker / HF front end
  try {
    assert.equal((await req('POST', '/api/seed', { headers: remote })).status, 200);
    assert.equal((await req('POST', '/api/sales', { body: { sku: 'COFFEE-HOT', qty: 1 }, headers: remote })).status, 201);
    assert.equal((await req('POST', '/api/daemon/run', { headers: remote })).status, 200);
    const key = await req('POST', '/api/keys', { body: { name: 'nope' }, headers: remote });
    assert.ok(key.status === 401 || key.status === 403, `demo must still refuse key creation, got ${key.status}`);
    const reset = await req('POST', '/api/reset', { headers: remote });
    assert.ok(reset.status === 401 || reset.status === 403);
  } finally {
    delete process.env.DEMO_MODE;
  }
});

test('the Hugging Face SPACE_HOST is a trusted Host header', async () => {
  const before = await req('GET', '/api/health', { headers: { host: 'owner-tanpin.hf.space' } });
  assert.equal(before.status, 403);
  process.env.SPACE_HOST = 'owner-tanpin.hf.space';
  process.env.DEMO_MODE = '1';
  try {
    const r = await req('GET', '/api/state', { headers: { host: 'owner-tanpin.hf.space', 'x-forwarded-for': '203.0.113.5' } });
    assert.equal(r.status, 200);
  } finally {
    delete process.env.SPACE_HOST;
    delete process.env.DEMO_MODE;
  }
});

test('every response carries a CSP that forbids inline script and event handlers', async () => {
  for (const p of ['/', '/app.js', '/api/health']) {
    const r = await req('GET', p);
    const csp = r.headers['content-security-policy'] || '';
    assert.match(csp, /script-src 'self'(;|$)/, `${p}: ${csp}`);
    assert.match(csp, /script-src-attr 'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  const html = await req('GET', '/');
  assert.doesNotMatch(html.text, /<script>(?!<)/, 'no inline <script> blocks in index.html');
  assert.doesNotMatch(html.text, /\son[a-z]+=/i, 'no inline event handlers in index.html');
});

// ---------------------------------------------------------------------------
// Cross-process stock updates
// ---------------------------------------------------------------------------
test('a PO received by another process is not overwritten by a stale server sale', async () => {
  await seedStore();
  const p0 = (await req('GET', '/api/products/COFFEE-HOT')).data;
  const po = (await req('POST', '/api/purchase-orders', {
    body: { supplierId: p0.supplierId, lines: [{ sku: 'COFFEE-HOT', qty: 1350 }] },
  })).data;
  assert.equal(po.status, 'draft');

  // A second process (standalone daemon, second server) receives the PO.
  const code = `
    const { Store } = require(${JSON.stringify(require.resolve('../src/engine/store'))});
    const manager = require(${JSON.stringify(require.resolve('../src/engine/manager'))});
    const st = new Store(process.argv[1]); st.load();
    const po = st.find('purchaseOrders', process.argv[2]);
    if (!manager.receiveOrder(st, po)) process.exit(3);
    process.stdout.write(String(st.list('products').find((p) => p.sku === 'COFFEE-HOT').currentStock));`;
  const child = spawnSync(process.execPath, ['-e', code, store.sqliteFile, po.id], { encoding: 'utf8', env: { ...process.env, TANPIN_DB: '', INVENTORY_DB: '' } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(Number(child.stdout), p0.currentStock + 1350);

  // The server still holds the pre-receipt copy in memory; a sale must apply
  // as a delta on the fresh row, not write back its stale absolute value.
  const sale = await req('POST', '/api/sales', { body: { sku: 'COFFEE-HOT', qty: 2 } });
  assert.equal(sale.status, 201);
  assert.equal(sale.data.product.currentStock, p0.currentStock + 1350 - 2);

  const check = spawnSync(process.execPath, ['-e', `
    const { Store } = require(${JSON.stringify(require.resolve('../src/engine/store'))});
    const st = new Store(process.argv[1]); st.load();
    const p = st.list('products').find((x) => x.sku === 'COFFEE-HOT');
    process.stdout.write(JSON.stringify({ stock: p.currentStock, status: st.find('purchaseOrders', process.argv[2]).status,
      receipts: st.list('movements').filter((m) => m.type === 'receipt' && m.ref === process.argv[2]).length }));`,
  store.sqliteFile, po.id], { encoding: 'utf8', env: { ...process.env, TANPIN_DB: '', INVENTORY_DB: '' } });
  const onDisk = JSON.parse(check.stdout);
  assert.deepEqual(onDisk, { stock: p0.currentStock + 1350 - 2, status: 'received', receipts: 1 });

  // And the server knows the PO is received: no double receipt, no cancel.
  const again = await req('POST', `/api/purchase-orders/${po.id}/receive`);
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'already_received');
  const cancel = await req('POST', `/api/purchase-orders/${po.id}/cancel`);
  assert.equal(cancel.status, 409);
  const after = (await req('GET', '/api/products/COFFEE-HOT')).data;
  assert.equal(after.currentStock, p0.currentStock + 1350 - 2);
});

// ---------------------------------------------------------------------------
// Store timezone
// ---------------------------------------------------------------------------
test('settings.timezone drives PO ETAs, cycle ETAs and product forecasts (not the host zone)', async () => {
  await seedStore();
  const tz = 'Asia/Kolkata'; // +05:30: differs from every host zone the suite runs under
  const put = await req('PUT', '/api/settings', { body: { timezone: tz } });
  assert.equal(put.status, 200);
  const suppliers = (await req('GET', '/api/suppliers')).data;
  const snack = suppliers.find((s) => s.name === 'SnackPack Supply'); // delivery window 09:00
  const po = (await req('POST', '/api/purchase-orders', {
    body: { supplierId: snack.id, lines: [{ sku: 'GUM-MINT', qty: 20 }] },
  })).data;
  assert.equal(forecast.hourAt(po.eta, tz), 9, `ETA should be 09:00 ${tz}, got ${new Date(po.eta).toISOString()}`);

  // Cancel what the seed's own cycle raised (before the timezone was set),
  // then let a fresh cycle raise auto POs under the store timezone.
  for (const open of (await req('GET', '/api/purchase-orders?status=open')).data) {
    await req('POST', `/api/purchase-orders/${open.id}/cancel`);
  }
  const t0 = Date.now();
  const cycle = await req('POST', '/api/daemon/run');
  assert.equal(cycle.status, 200);
  const all = (await req('GET', '/api/purchase-orders')).data.filter((x) => x.auto && x.orderedAt >= t0);
  assert.ok(all.length > 0, 'the cycle should raise auto POs on the seeded store');
  for (const x of all) {
    const sup = suppliers.find((s) => s.id === x.supplierId);
    assert.ok(sup.deliveryWindows.includes(forecast.hourAt(x.eta, tz)), `auto PO ETA hour must be a ${tz} window`);
  }
  const prod = (await req('GET', '/api/products/COFFEE-HOT')).data;
  assert.equal(prod.forecast.timeZone, tz);
  await req('PUT', '/api/settings', { body: { timezone: '' } });
});

// ---------------------------------------------------------------------------
// Hypotheses move the reorder trigger
// ---------------------------------------------------------------------------
test('a demand hypothesis raises the reorder point and triggers a recommendation', async () => {
  await req('POST', '/api/reset');
  const sup = (await req('POST', '/api/suppliers', { body: { name: 'Hyp Supply', leadTimeDays: 3, deliveryWindows: [9] } })).data;
  const prod = (await req('POST', '/api/products', {
    body: { sku: 'HYP-1', name: 'Hypothesis item', supplierId: sup.id, currentStock: 35, leadTimeDays: 3, unitCost: 1, price: 2 },
  })).data;
  const now = Date.now();
  const sales = [];
  for (let d = 1; d <= 40; d++) sales.push({ sku: 'HYP-1', qty: 5 + (d % 5), at: now - d * DAY });
  assert.equal((await req('POST', '/api/sales/bulk', { body: sales })).status, 201);
  await req('POST', '/api/adjust', { body: { sku: 'HYP-1', delta: 35 - (await req('GET', '/api/products/HYP-1')).data.currentStock } });
  assert.equal((await req('GET', '/api/products/HYP-1')).data.currentStock, 35);

  const baseline = (await req('GET', '/api/recommendations')).data;
  assert.equal(baseline.recommendations.length, 0, 'healthy without the hypothesis');
  const ropBefore = (await req('GET', '/api/products/HYP-1')).data.reorderPoint;

  const hyp = await req('POST', '/api/hypotheses', { body: { productId: prod.id, multiplier: 3, note: 'festival' } });
  assert.equal(hyp.status, 201);
  const p = (await req('GET', '/api/products/HYP-1')).data;
  assert.ok(p.reorderPoint > ropBefore * 2, `ROP should move with the hypothesis immediately (${ropBefore} → ${p.reorderPoint})`);
  assert.ok(p.reorderPoint >= p.forecast.horizonForecast, 'ROP covers lead-time forecast demand');
  const recs = (await req('GET', '/api/recommendations')).data.recommendations;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].lines[0].sku, 'HYP-1');
});

// ---------------------------------------------------------------------------
// Write cost
// ---------------------------------------------------------------------------
test('a sale writes only the rows it changed, and a bulk sync is one transaction', async () => {
  await seedStore();
  // Grow the movement log so a full rewrite would be obvious.
  const now = Date.now();
  const products = store.list('products');
  for (let i = 0; i < 20000; i++) {
    store.data.movements.push({ id: `bulkmv_${i}`, productId: products[i % products.length].id, type: 'sale', qty: 1, at: now - (1 + (i % 300)) * DAY / 10 });
  }
  store.save();

  const proto = Object.getPrototypeOf(store);
  const realCommit = proto._commit;
  const realDiff = proto._writeDiff;
  let commits = 0;
  let rows = 0;
  proto._commit = function (fn) { commits++; return realCommit.call(this, fn); };
  proto._writeDiff = function (data, base) {
    const out = realDiff.call(this, data, base);
    rows += this.lastWrite.upserts + this.lastWrite.deletes;
    return out;
  };
  try {
    const one = await req('POST', '/api/sales', { body: { sku: 'COLA-350', qty: 1 } });
    assert.equal(one.status, 201);
    assert.ok(store.list('movements').length > 20000);
    assert.ok(commits >= 1 && rows >= 2, `instrumentation must observe the sale's writes (commits=${commits}, rows=${rows})`);
    assert.ok(rows <= 6, `a single sale should write a few rows (product + movement), wrote ${rows}`);

    commits = 0;
    const lines = products.map((p) => ({ sku: p.sku, qty: 1 }));
    const bulk = await req('POST', '/api/sales/bulk', { body: lines });
    assert.equal(bulk.status, 201);
    assert.equal(bulk.data.recorded, products.length);
    assert.ok(commits >= 1);
    assert.ok(commits <= 3, `bulk of ${lines.length} lines should be ~2 commits (stock delta + recompute), got ${commits}`);
  } finally {
    proto._commit = realCommit;
    proto._writeDiff = realDiff;
  }
});

test('GET /api/backtest runs off the event loop', async () => {
  const bt = require('../src/engine/backtest');
  const real = bt.backtestInWorker;
  let workerCalls = 0;
  bt.backtestInWorker = (...args) => { workerCalls++; return real(...args); };
  after(() => { bt.backtestInWorker = real; });
  const pending = req('GET', '/api/backtest');
  const t0 = Date.now();
  const health = await req('GET', '/api/health');
  const healthMs = Date.now() - t0;
  assert.equal(health.status, 200);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(workerCalls, 1, 'the server must use the worker-thread backtest');
  assert.ok(Array.isArray(res.data.skus) && res.data.skus.length > 0);
  assert.ok(res.data.skus.every((s) => s.n >= 0));
  assert.ok(healthMs < 1000, `health check waited ${healthMs}ms behind the backtest`);
});
