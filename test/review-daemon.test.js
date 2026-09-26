'use strict';
// Regression tests for the independent review — webhook guard in the engine
// (so the standalone daemon has it), DNS-rebinding-safe delivery, and the
// `tanpin daemon` / `tanpin seed` entry points. The HTTP server is NOT loaded
// in this file on purpose: nothing here may depend on server.js patching.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const webhooks = require('../src/engine/webhooks');
const netguard = require('../src/engine/netguard');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tanpin');

function receiver() {
  const hits = [];
  const srv = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => { hits.push({ url: rq.url, body, host: rq.headers.host }); rs.writeHead(200); rs.end('ok'); });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port })));
}

function memStore(hooks) {
  return {
    data: { webhookLog: [] },
    saves: 0,
    save() { this.saves++; },
    list(c) { return c === 'webhooks' ? hooks : []; },
  };
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  });
}

/** Stub dns.lookup for one hostname; returns a restore function and a call log. */
function stubLookup(hostname, answer) {
  const orig = dns.lookup;
  const calls = [];
  dns.lookup = function (host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (host !== hostname) return orig.call(dns, host, opts, cb);
    calls.push(host);
    const list = (typeof answer === 'function' ? answer(calls.length) : answer).map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));
    process.nextTick(() => (opts && opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family)));
  };
  return { calls, restore: () => { dns.lookup = orig; } };
}

// ---------------------------------------------------------------------------
test('engine webhooks refuse private destinations without the HTTP server loaded', async () => {
  assert.equal(require.cache[require.resolve('../src/server')], undefined, 'server.js must not be loaded here');
  const rx = await receiver();
  try {
    await withEnv({ DEMO_MODE: undefined, TANPIN_ALLOW_PRIVATE_WEBHOOKS: undefined }, async () => {
      const store = memStore([{ id: 'w1', url: `http://127.0.0.1:${rx.port}/internal-admin`, events: ['*'], active: true, secret: 's' }]);
      await webhooks.emit(store, 'cycle.completed', { summary: {} });
      assert.equal(rx.hits.length, 0, 'private receiver must not be hit');
      assert.equal(store.data.webhookLog.length, 1);
      assert.match(store.data.webhookLog[0].error, /private|loopback/);
    });
  } finally {
    rx.srv.close();
  }
});

test('DEMO_MODE suppresses engine webhook deliveries', async () => {
  const rx = await receiver();
  try {
    await withEnv({ DEMO_MODE: '1', TANPIN_ALLOW_PRIVATE_WEBHOOKS: '1' }, async () => {
      const hook = { id: 'w1', url: `http://127.0.0.1:${rx.port}/hook`, events: ['*'], active: true, secret: 's' };
      const store = memStore([hook]);
      assert.deepEqual(await webhooks.emit(store, 'po.created', {}), []);
      const entry = await webhooks.deliver(store, hook, 'webhook.test', {});
      assert.equal(entry.error, 'demo_mode');
      assert.equal(rx.hits.length, 0);
    });
  } finally {
    rx.srv.close();
  }
});

test('engine webhooks never follow redirects', async () => {
  const rx = await receiver();
  const redir = http.createServer((_q, s) => { s.writeHead(302, { location: `http://127.0.0.1:${rx.port}/secret` }); s.end(); });
  await new Promise((r) => redir.listen(0, '127.0.0.1', r));
  try {
    await withEnv({ DEMO_MODE: undefined, TANPIN_ALLOW_PRIVATE_WEBHOOKS: '1' }, async () => {
      const store = memStore([]);
      const entry = await webhooks.deliver(store, { id: 'w', url: `http://127.0.0.1:${redir.address().port}/h`, secret: 's' }, 'webhook.test', {});
      assert.equal(entry.status, 302);
      assert.equal(entry.ok, false);
      assert.equal(rx.hits.length, 0);
    });
  } finally {
    rx.srv.close();
    redir.close();
  }
});

test('a hostname that resolves to a private address is refused at connect time (no check-then-fetch)', async () => {
  const rx = await receiver();
  const dnsStub = stubLookup('rebind.tanpin.test', ['127.0.0.1']);
  try {
    await withEnv({ DEMO_MODE: undefined, TANPIN_ALLOW_PRIVATE_WEBHOOKS: undefined }, async () => {
      const store = memStore([]);
      const entry = await webhooks.deliver(store, { id: 'w', url: `http://rebind.tanpin.test:${rx.port}/x`, secret: 's' }, 'webhook.test', {});
      assert.equal(entry.ok, false);
      assert.match(entry.error, /resolves to a private/);
      assert.equal(rx.hits.length, 0);
      assert.equal(dnsStub.calls.length, 1, 'exactly one resolution per delivery: the one the socket uses');
    });
  } finally {
    dnsStub.restore();
    rx.srv.close();
  }
});

test('the socket connects to the address the validating lookup returned (DNS pinning)', async () => {
  // With private destinations allowed, the same code path must connect via our
  // lookup: a name that exists nowhere but in the stub can only be reached if
  // the connection uses the validated answer rather than a second resolution.
  const rx = await receiver();
  const dnsStub = stubLookup('pinned.tanpin.test', ['127.0.0.1']);
  try {
    await withEnv({ DEMO_MODE: undefined, TANPIN_ALLOW_PRIVATE_WEBHOOKS: '1' }, async () => {
      const store = memStore([]);
      const entry = await webhooks.deliver(store, { id: 'w', url: `http://pinned.tanpin.test:${rx.port}/pinned`, secret: 's' }, 'webhook.test', {});
      assert.equal(entry.ok, true, JSON.stringify(entry));
      assert.equal(rx.hits.length, 1);
      assert.equal(rx.hits[0].url, '/pinned');
      assert.equal(dnsStub.calls.length, 1);
    });
  } finally {
    dnsStub.restore();
    rx.srv.close();
  }
});

test('safeLookup fails when ANY resolved address is private (mixed public/private answers)', async () => {
  const dnsStub = stubLookup('mixed.tanpin.test', ['93.184.215.14', '127.0.0.1']);
  try {
    await withEnv({ TANPIN_ALLOW_PRIVATE_WEBHOOKS: undefined }, async () => {
      const err = await new Promise((resolve) => netguard.safeLookup('mixed.tanpin.test', { all: true }, (e) => resolve(e)));
      assert.ok(err, 'expected an error');
      assert.equal(err.code, 'EBLOCKED_DESTINATION');
      const ok = await new Promise((resolve) => netguard.safeLookup('mixed.tanpin.test', {}, (e, a) => resolve({ e, a })));
      assert.ok(ok.e);
    });
  } finally {
    dnsStub.restore();
  }
});

test('webhook log entries redact URL credentials', async () => {
  await withEnv({ DEMO_MODE: '1' }, async () => {
    const store = memStore([]);
    const entry = await webhooks.deliver(store, { id: 'w', url: 'https://user:pass@example.com/<img src=x onerror=alert(1)>', secret: 's' }, 'webhook.test', {});
    assert.ok(!entry.url.includes('pass'), entry.url);
    assert.ok(!entry.url.includes('<img'), 'URL is normalized/encoded');
  });
});

// ---------------------------------------------------------------------------
// CLI entry points
// ---------------------------------------------------------------------------
function runUntil(args, env, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: os.tmpdir(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err); else resolve(out);
    };
    const onData = (c) => {
      out += c;
      if (pattern.test(out)) finish();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!done) finish(pattern.test(out) ? null : new Error(`exited ${code} before ${pattern}: ${out}`)); });
    const timer = setTimeout(() => finish(new Error(`timeout waiting for ${pattern}: ${out}`)), timeoutMs);
  });
}

function cleanEnv(dir) {
  return {
    TANPIN_DATA_DIR: dir, TANPIN_DB: '', INVENTORY_DB: '', TANPIN_OUTBOX: '', TANPIN_STORE: '',
    DEMO_MODE: '', TANPIN_ALLOW_PRIVATE_WEBHOOKS: '',
  };
}

test('`tanpin seed` and `tanpin daemon` use TANPIN_DATA_DIR and actually run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-cli-'));
  try {
    const seeded = await runUntil([BIN, 'seed'], cleanEnv(dir), /Seeded demo store/);
    assert.match(seeded, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(fs.existsSync(path.join(dir, 'inventory.sqlite')), 'seed wrote into TANPIN_DATA_DIR');

    const out = await runUntil([BIN, 'daemon'], cleanEnv(dir), /\[daemon\] \d{4}-\d\d-\d\dT.* orders/);
    assert.match(out, /\[daemon\] standalone, db=.*inventory\.sqlite/);
    assert.ok(out.includes(dir), 'daemon uses the configured data dir');
    assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'data')), 'nothing written inside the package');

    const { Store } = require('../src/engine/store');
    const st = new Store(path.join(dir, 'inventory.sqlite'));
    st.load();
    assert.ok(st.list('daemonLog').some((t) => t.trigger === 'daemon'), 'the cycle was persisted');
    st.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the standalone daemon applies the SSRF guard and DEMO_MODE to webhooks', async () => {
  const rx = await receiver();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-cli-'));
  try {
    const { Store } = require('../src/engine/store');
    const file = path.join(dir, 'inventory.sqlite');
    const st = new Store(file);
    st.load();
    st.insert('webhooks', { url: `http://127.0.0.1:${rx.port}/internal-admin`, events: ['*'], secret: 's', active: true });
    st.close();

    await runUntil([path.join(ROOT, 'src', 'daemon.js')], cleanEnv(dir), /\[daemon\] \d{4}-.* orders/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rx.hits.length, 0, 'private receiver must not be hit by the standalone daemon');

    await runUntil([BIN, 'daemon'], { ...cleanEnv(dir), DEMO_MODE: '1', TANPIN_ALLOW_PRIVATE_WEBHOOKS: '1' }, /\[daemon\] \d{4}-.* orders/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rx.hits.length, 0, 'DEMO_MODE daemon must not deliver webhooks');

    const check = new Store(file);
    check.load();
    const log = check.list('webhookLog');
    assert.ok(log.some((e) => /private|loopback/.test(e.error || '')), 'blocked delivery is logged');
    check.close();
  } finally {
    rx.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
