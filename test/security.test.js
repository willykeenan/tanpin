// Security tests — CSRF/CORS on the local server, webhook SSRF, DEMO_MODE.
// Run with `npm test` (node --test --test-concurrency=1). Zero dependencies.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-sec-'));
const dbFile = path.join(tmpDir, 'inventory.json');
process.env.TANPIN_DB = process.env.TANPIN_DB || dbFile;
process.env.INVENTORY_DB = process.env.INVENTORY_DB || dbFile;
delete process.env.REQUIRE_API_KEY;
delete process.env.TANPIN_REQUIRE_API_KEY;
delete process.env.DEMO_MODE;
delete process.env.TANPIN_CORS_ORIGINS;
delete process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS;

const {
  server,
  DEFAULT_HOST,
  DEMO_RESEED_MS,
  webhookUrlBlocked,
} = require('../src/server');

let BASE = '';

before(async () => {
  if (!server.listening) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (server.listening) server.close();
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

function rawReq(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('default bind is loopback', () => {
  assert.strictEqual(DEFAULT_HOST, '127.0.0.1');
});

test('demo reseed interval is 30 minutes', () => {
  assert.strictEqual(DEMO_RESEED_MS, 30 * 60 * 1000);
});

test('cross-origin request from another site cannot create keys or change data', async () => {
  const beforeKeys = await req('GET', '/api/keys');
  assert.strictEqual(beforeKeys.status, 200);
  const n = beforeKeys.data.length;

  const create = await req('POST', '/api/keys', {
    body: { name: 'csrf-key' },
    headers: { Origin: 'https://evil.example' },
  });
  assert.strictEqual(create.status, 403);
  assert.strictEqual(create.data.code, 'origin_forbidden');
  assert.equal(create.headers.get('access-control-allow-origin'), null);

  const reset = await req('POST', '/api/reset', {
    headers: { Origin: 'https://evil.example' },
  });
  assert.strictEqual(reset.status, 403);
  assert.strictEqual(reset.data.code, 'origin_forbidden');

  const afterKeys = await req('GET', '/api/keys');
  assert.strictEqual(afterKeys.data.length, n, 'no key created by the foreign origin');
});

test('CORS is an allowlist, never *', async () => {
  const health = await req('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(health.status, 403);
  assert.notStrictEqual(health.headers.get('access-control-allow-origin'), '*');

  process.env.TANPIN_CORS_ORIGINS = 'https://app.example';
  try {
    const allowed = await req('GET', '/api/health', { headers: { Origin: 'https://app.example' } });
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.notStrictEqual(allowed.headers.get('access-control-allow-origin'), '*');

    const other = await req('GET', '/api/health', { headers: { Origin: 'https://other.example' } });
    assert.strictEqual(other.status, 403);

    const write = await req('POST', '/api/keys', {
      body: { name: 'from-allowlist' },
      headers: { Origin: 'https://app.example' },
    });
    assert.strictEqual(write.status, 401, 'allowlisted origin still needs a token to write');
    assert.strictEqual(write.data.code, 'missing_api_key');
  } finally {
    delete process.env.TANPIN_CORS_ORIGINS;
  }
});

test('same-origin dashboard writes still work without a key', async () => {
  const res = await req('POST', '/api/hypotheses', {
    body: { note: 'dashboard write', multiplier: 1.1, category: 'beverage' },
    headers: { Origin: BASE },
  });
  assert.strictEqual(res.status, 201);
});

test('spoofed Host header is rejected', async () => {
  const res = await rawReq('GET', '/api/state', { headers: { Host: 'evil.example' } });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.data.code, 'host_forbidden');
});

test('SSRF guard blocks private, loopback and link-local webhook URLs', () => {
  delete process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS;
  const blocked = [
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/hook',
    'http://localhost/hook',
    'http://localhost./hook',
    'http://10.0.0.1/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://169.254.169.254/latest',
    'http://127.1/',
    'http://2130706433/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fd12:3456::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::127.0.0.1]/',
  ];
  for (const url of blocked) {
    const reason = webhookUrlBlocked(url);
    assert.ok(reason, `expected block for ${url}`);
    assert.match(reason, /private|loopback|link-local|http\(s\)/);
  }
  assert.strictEqual(webhookUrlBlocked('https://example.com/hook'), null);
  assert.ok(webhookUrlBlocked('file:///etc/passwd'));
});

test('SSRF guard rejects private webhook registration over HTTP', async () => {
  delete process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS;
  for (const url of [
    'http://127.0.0.1:9/hook',
    'http://10.1.2.3/h',
    'http://169.254.1.1/h',
    'http://localhost/h',
    'http://localhost./h',
    'http://[::ffff:127.0.0.1]/h',
  ]) {
    const res = await req('POST', '/api/webhooks', { body: { url, events: ['webhook.test'] } });
    assert.strictEqual(res.status, 400, url);
    assert.strictEqual(res.data.code, 'invalid_request');
  }
  const publicUrl = await req('POST', '/api/webhooks', { body: { url: 'https://example.com/hook' } });
  assert.strictEqual(publicUrl.status, 201);
});

test('TANPIN_ALLOW_PRIVATE_WEBHOOKS=1 permits loopback receivers', async () => {
  process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS = '1';
  try {
    const res = await req('POST', '/api/webhooks', { body: { url: 'http://127.0.0.1:9/hook' } });
    assert.strictEqual(res.status, 201);
  } finally {
    delete process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS;
  }
});

test('webhook deliveries do not follow redirects', async () => {
  process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS = '1';
  const hits = [];
  const target = http.createServer((_rq, rs) => { hits.push('target'); rs.writeHead(200); rs.end('ok'); });
  const redir = http.createServer((_rq, rs) => {
    hits.push('redir');
    rs.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/secret` });
    rs.end();
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => redir.listen(0, '127.0.0.1', resolve));
  try {
    const hookUrl = `http://127.0.0.1:${redir.address().port}/hook`;
    const hook = await req('POST', '/api/webhooks', { body: { url: hookUrl, events: ['webhook.test'] } });
    assert.strictEqual(hook.status, 201);
    const fire = await req('POST', `/api/webhooks/${hook.data.id}/test`);
    assert.strictEqual(fire.status, 200);
    assert.strictEqual(fire.data.delivery.ok, false);
    assert.ok(hits.includes('redir'));
    assert.ok(!hits.includes('target'), 'delivery must not follow the redirect');
  } finally {
    target.close();
    redir.close();
    delete process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS;
  }
});

test('DEMO_MODE: reads open, writes limited, webhooks off', async () => {
  process.env.DEMO_MODE = '1';
  try {
    const seeded = await req('POST', '/api/seed');
    assert.strictEqual(seeded.status, 200);
    assert.strictEqual(seeded.data.demo, true);

    process.env.TANPIN_REQUIRE_API_KEY = '1';
    const products = await req('GET', '/api/products');
    assert.strictEqual(products.status, 200, 'reads stay open in demo mode');
    assert.ok(products.data.length > 0);
    const state = await req('GET', '/api/state');
    assert.strictEqual(state.status, 200);
    delete process.env.TANPIN_REQUIRE_API_KEY;

    const create = await req('POST', '/api/products', { body: { sku: 'EVIL-SKU', name: 'Should fail' } });
    assert.strictEqual(create.status, 403);
    assert.strictEqual(create.data.code, 'demo_mode');

    const reset = await req('POST', '/api/reset');
    assert.strictEqual(reset.status, 403);
    assert.strictEqual(reset.data.code, 'demo_mode');

    const hook = await req('POST', '/api/webhooks', { body: { url: 'https://example.com/h' } });
    assert.strictEqual(hook.status, 403);
    assert.strictEqual(hook.data.code, 'demo_mode');

    const key = await req('POST', '/api/keys', { body: { name: 'demo-key' } });
    assert.strictEqual(key.status, 403);

    const sale = await req('POST', '/api/sales', { body: { sku: 'COFFEE-HOT', qty: 1 } });
    assert.strictEqual(sale.status, 201, 'writes against demo SKUs stay allowed');

    const still = await req('GET', '/api/products/COFFEE-HOT');
    assert.strictEqual(still.status, 200);
    assert.ok(!still.data.sku || still.data.sku === 'COFFEE-HOT');

    process.env.SMTP_HOST = 'smtp.example';
    const settings = await req('PUT', '/api/settings', {
      body: { autoSend: true, autoEmailAlerts: true, notifyEmail: 'ops@example.com', targetDaysOfSupply: 8 },
    });
    assert.strictEqual(settings.status, 200);
    assert.strictEqual(settings.data.autoSend, false);
    assert.strictEqual(settings.data.autoEmailAlerts, false);
    assert.strictEqual(settings.data.targetDaysOfSupply, 8);
    assert.notStrictEqual(process.env.SMTP_HOST, 'smtp.example');
  } finally {
    delete process.env.DEMO_MODE;
    delete process.env.TANPIN_REQUIRE_API_KEY;
    delete process.env.SMTP_HOST;
    await req('POST', '/api/seed');
  }
});

test('GET /api/backtest is mounted and 404s when the engine is absent', async () => {
  const res = await req('GET', '/api/backtest');
  assert.ok(res.status === 200 || res.status === 404);
  if (res.status === 404) assert.strictEqual(res.data.code, 'not_found');
});
