'use strict';
// Dashboard (public/app.js) regression tests without a browser: the script is
// run in a vm context with a minimal fake DOM. Covers the stored-XSS sinks
// found in review and the API-key prompt that replaced the /login.html
// redirect. Zero dependencies.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const XSS = '<img src=x onerror=alert(1)>';

function fakeElement(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', checked: false, title: '', className: '', type: '',
    dataset: {}, style: {}, children: [], onclick: null, onchange: null, onsubmit: null,
    classList: { add() {}, remove() {}, toggle() {} },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    append(...cs) { for (const c of cs) this.appendChild(c); },
    remove() {
    const mark = (n) => { n.removed = true; (n.children || []).forEach(mark); };
    mark(this);
  },
    focus() {},
  };
  return el;
}

function makeDom() {
  const byId = new Map();
  const created = [];
  const document = {
    visibilityState: 'visible',
    body: fakeElement('body'),
    getElementById(id) {
      for (const c of created) if (c.id === id && !c.removed) return c;
      if (!byId.has(id)) byId.set(id, fakeElement(id));
      return byId.get(id);
    },
    querySelectorAll() { return []; },
    createElement(tag) { const e = fakeElement(''); e.tag = tag; created.push(e); return e; },
    createTextNode(t) { return { textContent: t }; },
  };
  return { document, byId, created };
}

function state(overrides = {}) {
  return {
    settings: { currency: 'USD', companyName: 'Test Co' },
    kpis: { skuCount: 0, stockValue: 0, lowStock: 0, deadStock: 0, openPOs: 0, incomingUnits: 0 },
    products: [], suppliers: [], purchaseOrders: [], allPurchaseOrders: [], hypotheses: [],
    daemonLog: [], outbox: [], apiKeys: [], webhooks: [], webhookLog: [], webhookEvents: [],
    ...overrides,
  };
}

/** Load app.js into a sandbox. `respond(url, opts)` returns { status, body }. */
async function loadApp(respond) {
  const dom = makeDom();
  const requests = [];
  const storage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const location = { origin: 'http://127.0.0.1:4173', href: 'http://127.0.0.1:4173/' };
  const sandbox = {
    console, Intl, Date, Math, JSON, Promise, Number, String, Array, Object, Error, Map, Set,
    setTimeout: (fn) => { fn(); return 0; },
    setInterval: () => 0,
    confirm: () => true,
    document: dom.document,
    fetch: async (url, opts = {}) => {
      requests.push({ url, opts });
      const r = await respond(url, opts);
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
    },
  };
  sandbox.window = { location, sessionStorage: storage(), localStorage: storage() };
  vm.createContext(sandbox);
  vm.runInContext(APP, sandbox, { filename: 'app.js' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { sandbox, dom, requests, location };
}

test('hypothesis category and webhook delivery errors are HTML-escaped (stored XSS)', async () => {
  const s = state({
    hypotheses: [{ id: 'hyp_1', multiplier: 2, note: 'n', scope: { productId: null, category: XSS }, startsAt: 0, endsAt: 0 }],
    webhooks: [{ id: 'web_1', url: 'https://example.com/h', events: ['*'] }],
    webhookLog: [{ at: 0, event: 'webhook.test', url: 'https://example.com/h', ok: false, error: `fetch failed ${XSS}` }],
    outbox: [{ subject: 's', to: 't', at: 0, transport: XSS }],
    daemonLog: [{ at: 0, trigger: XSS, recomputed: 0, ordersCreated: 0, orderLines: 0, emailsSent: 0, received: 0, delistFlags: [], notes: [] }],
  });
  const app = await loadApp(async () => ({ status: 200, body: s }));
  const run = (code) => vm.runInContext(code, app.sandbox);
  run('STATE = ' + JSON.stringify(s) + ';');
  for (const [tab, fn] of [['tab-forecast', 'renderForecast'], ['tab-api', 'renderApi'], ['tab-activity', 'renderActivity'], ['tab-dashboard', 'renderDashboard']]) {
    run(`${fn}()`);
    const html = app.dom.document.getElementById(tab).innerHTML;
    assert.ok(!html.includes('<img'), `${fn} rendered raw markup: ${html.slice(html.indexOf('<img') - 40, html.indexOf('<img') + 40)}`);
  }
  assert.ok(app.dom.document.getElementById('tab-forecast').innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(app.dom.document.getElementById('tab-api').innerHTML.includes('fetch failed &lt;img'));
});

test('a 401 shows an API-key prompt and retries with X-API-Key instead of redirecting to /login.html', async () => {
  let authed = false;
  const app = await loadApp(async (url, opts) => {
    const key = opts.headers && opts.headers['X-API-Key'];
    if (key === 'ti_good') { authed = true; return { status: 200, body: state() }; }
    if (key) return { status: 401, body: { code: 'invalid_api_key', error: 'API key not recognized or revoked' } };
    return { status: 401, body: { code: 'missing_api_key', error: 'Provide an API key' } };
  });
  assert.notEqual(app.location.href, '/login.html', 'must not navigate to a page that does not exist');
  const prompt = app.dom.document.getElementById('key-prompt');
  assert.ok(prompt && prompt.className === 'key-overlay' && !prompt.removed, 'key prompt is shown');
  const form = prompt.children[0];
  const input = app.dom.document.getElementById('key-input');

  input.value = 'ti_wrong';
  form.onsubmit({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const again = app.dom.document.getElementById('key-prompt');
  assert.ok(again && !again.removed, 'a rejected key re-prompts');

  app.dom.document.getElementById('key-input').value = 'ti_good';
  again.children[0].onsubmit({ preventDefault() {} });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(authed, true);
  const last = app.requests[app.requests.length - 1];
  assert.equal(last.opts.headers['X-API-Key'], 'ti_good');
  assert.equal(app.sandbox.window.sessionStorage.getItem('tanpin.apiKey'), 'ti_good');
  assert.equal(app.dom.document.getElementById('company-name').textContent, 'Test Co', 'dashboard loaded after the key');
});
