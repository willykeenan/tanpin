// Tanpin — item-by-item inventory dashboard (vanilla JS, no build step).
'use strict';

const TIMEZONES = [
  'UTC',
  'Pacific/Honolulu',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

// --- auth ------------------------------------------------------------------
// The dashboard needs no key on this machine (loopback). Anywhere else — a
// Docker container, behind a reverse proxy, TANPIN_REQUIRE_API_KEY=1 — the API
// answers 401 and the dashboard asks for an API key (or TANPIN_ADMIN_KEY),
// kept in sessionStorage (or localStorage when "remember" is ticked) and sent
// as X-API-Key. A plugin may instead provide window.TanpinAuth sessions.
const KEY_STORAGE = 'tanpin.apiKey';

function session() {
  const a = window.TanpinAuth;
  if (!a || typeof a.session !== 'function') return null;
  try { return a.session(); } catch { return null; }
}
function clearSession() {
  const a = window.TanpinAuth;
  if (a && typeof a.clearSession === 'function') a.clearSession();
}
async function refreshSession() {
  const a = window.TanpinAuth;
  if (!a || typeof a.refreshSession !== 'function') return false;
  try { return await a.refreshSession(); } catch { return false; }
}
function pluginLogin() {
  const a = window.TanpinAuth;
  clearSession();
  if (a && typeof a.login === 'function') return a.login();
  if (a && a.loginUrl) window.location.href = a.loginUrl;
  return null;
}

function storedKey() {
  try { return window.sessionStorage.getItem(KEY_STORAGE) || window.localStorage.getItem(KEY_STORAGE) || ''; }
  catch { return ''; }
}
function saveKey(key, remember) {
  try {
    window.sessionStorage.setItem(KEY_STORAGE, key);
    if (remember) window.localStorage.setItem(KEY_STORAGE, key);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch { /* storage unavailable: key lives only in memory */ }
  MEMORY_KEY = key;
}
function forgetKey() {
  MEMORY_KEY = '';
  try { window.sessionStorage.removeItem(KEY_STORAGE); window.localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
}
let MEMORY_KEY = '';
function currentKey() { return MEMORY_KEY || storedKey(); }

let KEY_PROMPT = null;
/** Ask for an API key once, even if several requests hit 401 together. */
function promptForKey(reason) {
  if (KEY_PROMPT) return KEY_PROMPT;
  KEY_PROMPT = new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'key-overlay';
    overlay.id = 'key-prompt';
    const box = document.createElement('form');
    box.className = 'card key-box';
    const title = document.createElement('h3');
    title.className = 'font-semibold mb-2';
    title.textContent = 'API key required';
    const msg = document.createElement('p');
    msg.className = 'text-sm text-slate-500 mb-3';
    msg.textContent = (reason ? reason + ' ' : '')
      + 'This connection needs an API key: the server is behind a proxy or in a container, or it runs with TANPIN_REQUIRE_API_KEY=1. '
      + 'Use the TANPIN_ADMIN_KEY the server was started with, or a key created on the server host (API tab, or POST /api/keys from localhost).';
    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'password';
    input.id = 'key-input';
    input.autocomplete = 'off';
    input.placeholder = 'ti_… or admin key';
    const remember = document.createElement('label');
    remember.className = 'text-xs text-slate-500 flex items-center gap-2 mt-2';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.id = 'key-remember';
    remember.append(check, document.createTextNode('Remember on this device'));
    const save = document.createElement('button');
    save.className = 'btn btn-primary mt-3';
    save.type = 'submit';
    save.id = 'key-save';
    save.textContent = 'Use key';
    box.append(title, msg, input, remember, save);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.onsubmit = (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      const key = String(input.value || '').trim();
      if (!key) return;
      saveKey(key, !!check.checked);
      overlay.remove();
      KEY_PROMPT = null;
      resolve(key);
    };
    if (input.focus) input.focus();
  });
  return KEY_PROMPT;
}

const api = {
  headers(extra = {}) {
    const s = session();
    if (s && s.access_token) return { ...extra, 'Authorization': `Bearer ${s.access_token}` };
    const key = currentKey();
    return key ? { ...extra, 'X-API-Key': key } : extra;
  },
  async request(path, opts, retried = false) {
    const r = await fetch(path, { ...opts, headers: this.headers(opts.headers || {}) });
    if (r.status === 401) {
      if (session()) {
        if (!retried && await refreshSession()) return this.request(path, opts, true);
        pluginLogin();
        throw new Error('Session expired');
      }
      const data = await r.json().catch(() => ({}));
      if (data.code === 'missing_api_key' || data.code === 'invalid_api_key' || data.code === 'session_expired') {
        if (data.code === 'invalid_api_key') forgetKey();
        await promptForKey(data.code === 'invalid_api_key' ? 'That key was not accepted.' : '');
        return this.request(path, opts, true);
      }
      throw new Error(data.error || 'Unauthorized');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
  get(path) { return this.request(path, {}); },
  send(path, method, body) {
    return this.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  },
  post(p, b) { return this.send(p, 'POST', b); },
  put(p, b) { return this.send(p, 'PUT', b); },
  del(p) { return this.send(p, 'DELETE'); },
};

let STATE = null;
let CURRENCY = 'USD';

function money(n) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY, maximumFractionDigits: 2 }).format(n || 0); }
  catch { return (n || 0).toFixed(2); }
}
function num(n, dp = 1) { return (Number(n) || 0).toFixed(dp); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function el(id) { return document.getElementById(id); }
function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return true;
  } catch {
    return false;
  }
}
function storeTimeZone() {
  const tz = STATE && STATE.settings && STATE.settings.timezone;
  const name = typeof tz === 'string' ? tz.trim() : '';
  return validTimeZone(name) ? name : '';
}
function dateOpts() {
  const tz = storeTimeZone();
  return tz ? { timeZone: tz } : undefined;
}
function fmtDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(undefined, dateOpts()); }
  catch { return new Date(ts).toLocaleString(); }
}
function fmtClock(d = new Date()) {
  const base = { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  try { return d.toLocaleString(undefined, { ...base, ...dateOpts() }); }
  catch { return d.toLocaleString(undefined, base); }
}

function toast(msg, kind = '') {
  const box = el('toast');
  const node = document.createElement('div');
  node.className = 'toast-item';
  if (kind === 'err') node.style.background = '#9b2b18';
  node.textContent = msg;
  box.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function updateClock() {
  const node = el('store-clock');
  if (!node) return;
  const tz = storeTimeZone();
  node.textContent = fmtClock();
  node.title = tz ? `Store time (${tz})` : 'Store time (browser local)';
}

// --- data load -------------------------------------------------------------
async function refresh() {
  try {
    STATE = await api.get('/api/state');
    CURRENCY = STATE.settings.currency || 'USD';
    el('company-name').textContent = STATE.settings.companyName || '';
    updateClock();
    renderKpis();
    renderActiveTab();
  } catch (e) { toast('Load failed: ' + e.message, 'err'); }
}

function renderKpis() {
  const k = STATE.kpis;
  const cards = [
    { label: 'Active SKUs', value: k.skuCount, sub: 'tracked items' },
    { label: 'Stock value', value: money(k.stockValue), sub: 'at cost' },
    { label: 'Below reorder', value: k.lowStock, sub: 'need ordering', warn: k.lowStock > 0 },
    { label: 'Dead stock', value: k.deadStock, sub: 'no demand', warn: k.deadStock > 0 },
    { label: 'Open POs', value: k.openPOs, sub: 'in flight' },
    { label: 'Incoming units', value: k.incomingUnits, sub: 'on order' },
  ];
  el('kpis').innerHTML = cards.map((c) => `
    <div class="card p-3 kpi-card">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value ${c.warn ? 'is-warn' : ''}">${esc(c.value)}</div>
      <div class="kpi-sub">${c.sub}</div>
    </div>`).join('');
}

// --- tabs ------------------------------------------------------------------
let ACTIVE = 'dashboard';
function renderActiveTab() {
  ({ dashboard: renderDashboard, products: renderProducts, orders: renderOrders,
     suppliers: renderSuppliers, forecast: renderForecast, activity: renderActivity,
     api: renderApi, settings: renderSettings }[ACTIVE] || renderDashboard)();
}
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    ACTIVE = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('tab-active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    el('tab-' + ACTIVE).classList.remove('hidden');
    renderActiveTab();
  });
});

// --- dashboard -------------------------------------------------------------
function renderDashboard() {
  if (!STATE.products.length) {
    el('tab-dashboard').innerHTML = `
      <div class="card empty-hero">
        <div class="empty-mark">単</div>
        <h3 class="font-semibold text-lg mb-2">Your stockroom is empty</h3>
        <p class="text-sm text-slate-500 mb-5">Load a sample catalog to explore forecasting and auto-reorder, or add your first product and start from scratch.</p>
        <div class="flex gap-2 justify-center flex-wrap">
          <button class="btn btn-primary" id="empty-seed">Load demo data</button>
          <button class="btn btn-ghost" id="empty-add">Add first product</button>
        </div>
      </div>`;
    el('empty-seed').onclick = async () => {
      try { await api.post('/api/seed'); toast('Demo data loaded'); refresh(); }
      catch (e) { toast(e.message, 'err'); }
    };
    el('empty-add').onclick = () => {
      ACTIVE = 'products';
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('tab-active', b.dataset.tab === 'products'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      el('tab-products').classList.remove('hidden');
      renderProducts();
      showProductForm();
    };
    return;
  }

  const low = STATE.products.filter((p) => p.belowReorder).sort((a, b) => (a.daysOfSupply || 0) - (b.daysOfSupply || 0));
  const incoming = STATE.purchaseOrders;
  const lastTick = STATE.daemonLog[0];
  el('tab-dashboard').innerHTML = `
    <div class="grid lg:grid-cols-3 gap-4">
      <div class="card p-4 lg:col-span-2">
        <h3 class="font-semibold mb-2">Needs attention <span class="text-xs text-slate-400">(at or below reorder point)</span></h3>
        ${low.length ? `<table class="grid"><thead><tr>
          <th>SKU</th><th>Item</th><th>On hand</th><th>On order</th><th>Reorder pt</th><th>Days left</th><th>ABC</th></tr></thead><tbody>
          ${low.map((p) => `<tr>
            <td class="font-mono text-xs">${esc(p.sku)}</td>
            <td>${esc(p.name)}</td>
            <td>${esc(p.currentStock)}</td>
            <td>${esc(p.onOrder)}</td>
            <td>${num(p.reorderPoint)}</td>
            <td>${p.daysOfSupply == null ? '∞' : num(p.daysOfSupply)}</td>
            <td><span class="badge badge-${esc(p.abcClass || 'C')}">${esc(p.abcClass || '—')}</span></td>
          </tr>`).join('')}
        </tbody></table>` : `<p class="text-sm text-slate-500">Everything is above its reorder point.</p>`}
      </div>
      <div class="card p-4">
        <h3 class="font-semibold mb-2">Last auto-management cycle</h3>
        ${lastTick ? `<ul class="text-sm space-y-1 text-slate-600">
          <li>⏱️ ${fmtDate(lastTick.at)} <span class="text-xs">(${esc(lastTick.trigger)})</span></li>
          <li>🔄 Recomputed <b>${lastTick.recomputed}</b> SKUs</li>
          <li>🧾 Raised <b>${lastTick.ordersCreated}</b> draft POs (${lastTick.orderLines} lines)</li>
          <li>📧 Sent <b>${lastTick.emailsSent}</b> emails</li>
          <li>📦 Auto-received <b>${lastTick.received}</b> POs</li>
          <li>🗑️ <b>${lastTick.delistFlags.length}</b> delist candidates</li>
        </ul>` : `<p class="text-sm text-slate-500">No cycles run yet. Click “Run cycle now”.</p>`}
      </div>
    </div>
    <div class="card p-4 mt-4">
      <h3 class="font-semibold mb-2">Incoming deliveries <span class="text-xs text-slate-400">(with ETAs)</span></h3>
      ${incoming.length ? `<table class="grid"><thead><tr>
        <th>PO</th><th>Supplier</th><th>Status</th><th>Units</th><th>Value</th><th>ETA</th><th></th></tr></thead><tbody>
        ${incoming.map((po) => poRow(po)).join('')}
      </tbody></table>` : `<p class="text-sm text-slate-500">No open purchase orders.</p>`}
    </div>`;
  bindPoActions(el('tab-dashboard'));
}

function poRow(po) {
  const units = (po.lines || []).reduce((t, l) => t + l.qty, 0);
  return `<tr>
    <td class="font-mono text-xs">${esc(po.id)}</td>
    <td>${esc(po.supplierName || '')}</td>
    <td><span class="badge badge-${esc(po.status)}">${esc(po.status)}</span>${po.auto ? ' <span class="text-[10px] text-slate-400">auto</span>' : ''}</td>
    <td>${esc(units)}</td>
    <td>${money(po.total)}</td>
    <td>${po.eta ? `${fmtDate(po.eta)}<div class="text-[11px] text-slate-400">${esc(po.etaLabel || '')}</div>` : '—'}</td>
    <td class="text-right whitespace-nowrap">
      ${po.status === 'draft' ? `<button class="btn btn-primary" data-po-send="${esc(po.id)}">Send</button>` : ''}
      ${po.status !== 'received' && po.status !== 'cancelled' ? `<button class="btn btn-ghost" data-po-receive="${esc(po.id)}">Receive</button>` : ''}
      ${po.status !== 'received' && po.status !== 'cancelled' ? `<button class="btn btn-danger" data-po-cancel="${esc(po.id)}">Cancel</button>` : ''}
    </td>
  </tr>`;
}
function bindPoActions(root) {
  root.querySelectorAll('[data-po-send]').forEach((b) => b.onclick = async () => { await api.post(`/api/purchase-orders/${b.dataset.poSend}/send`); toast('PO sent + emailed'); refresh(); });
  root.querySelectorAll('[data-po-receive]').forEach((b) => b.onclick = async () => { await api.post(`/api/purchase-orders/${b.dataset.poReceive}/receive`); toast('PO received into stock'); refresh(); });
  root.querySelectorAll('[data-po-cancel]').forEach((b) => b.onclick = async () => { await api.post(`/api/purchase-orders/${b.dataset.poCancel}/cancel`); toast('PO cancelled'); refresh(); });
}

// --- products --------------------------------------------------------------
function renderProducts() {
  const rows = STATE.products.map((p) => `<tr>
    <td class="font-mono text-xs">${esc(p.sku)}</td>
    <td>${esc(p.name)}<div class="text-[11px] text-slate-400">${esc(p.category)}</div></td>
    <td>${esc(supplierName(p.supplierId))}</td>
    <td class="text-right">${esc(p.currentStock)}${p.belowReorder ? ' <span class="badge badge-low">low</span>' : ''}</td>
    <td class="text-right">${num(p.dailyForecast || p.avgDailyDemand)}/d</td>
    <td class="text-right">${num(p.reorderPoint)}</td>
    <td class="text-right">${num(p.safetyStock)}</td>
    <td class="text-right">${p.daysOfSupply == null ? '∞' : num(p.daysOfSupply)}</td>
    <td><span class="badge badge-${esc(p.abcClass || 'C')}">${esc(p.abcClass || '—')}</span></td>
    <td class="text-right whitespace-nowrap">
      <button class="btn btn-ghost" data-sell="${esc(p.id)}">Sell 1</button>
      <button class="btn btn-ghost" data-edit-prod="${esc(p.id)}">Edit</button>
      <button class="btn btn-danger" data-del-prod="${esc(p.id)}">✕</button>
    </td>
  </tr>`).join('');

  el('tab-products').innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-semibold">Products <span class="text-xs text-slate-400">(${STATE.products.length})</span></h3>
      <button class="btn btn-primary" id="add-prod">+ Add product</button>
    </div>
    <div class="card overflow-x-auto">
      <table class="grid"><thead><tr>
        <th>SKU</th><th>Item</th><th>Supplier</th><th class="text-right">On hand</th>
        <th class="text-right">Forecast</th><th class="text-right">Reorder pt</th><th class="text-right">Safety</th>
        <th class="text-right">Days left</th><th>ABC</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="10" class="text-center text-slate-400 py-6">No products yet — add one or load demo data.</td></tr>`}</tbody>
      </table>
    </div>
    <div id="prod-form-slot" class="mt-4"></div>`;

  el('add-prod').onclick = () => showProductForm();
  el('tab-products').querySelectorAll('[data-sell]').forEach((b) => b.onclick = async () => { await api.post('/api/sales', { productId: b.dataset.sell, qty: 1 }); toast('Sale recorded'); refresh(); });
  el('tab-products').querySelectorAll('[data-edit-prod]').forEach((b) => b.onclick = () => showProductForm(STATE.products.find((p) => p.id === b.dataset.editProd)));
  el('tab-products').querySelectorAll('[data-del-prod]').forEach((b) => b.onclick = async () => { if (confirm('Delete this product?')) { await api.del('/api/products/' + b.dataset.delProd); toast('Deleted'); refresh(); } });
}

function supplierName(id) { const s = (STATE.suppliers || []).find((x) => x.id === id); return s ? s.name : '—'; }

function showProductForm(p = null) {
  const slot = el('prod-form-slot');
  const supOpts = STATE.suppliers.map((s) => `<option value="${esc(s.id)}" ${p && p.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  slot.innerHTML = `<div class="card p-4">
    <h4 class="font-semibold mb-3">${p ? 'Edit' : 'New'} product</h4>
    <div class="grid sm:grid-cols-3 gap-3">
      ${field('SKU', 'sku', p?.sku)}
      ${field('Name', 'name', p?.name)}
      ${field('Category', 'category', p?.category || 'general')}
      <div><label class="label">Supplier</label><select class="input" id="f-supplierId"><option value="">—</option>${supOpts}</select></div>
      ${field('Unit cost', 'unitCost', p?.unitCost ?? 0, 'number')}
      ${field('Sell price', 'price', p?.price ?? 0, 'number')}
      ${field('On-hand stock', 'currentStock', p?.currentStock ?? 0, 'number')}
      ${field('Lead time (days)', 'leadTimeDays', p?.leadTimeDays ?? 2, 'number')}
      ${field('Pack / case size', 'packSize', p?.packSize ?? 1, 'number')}
      ${field('Min order qty', 'minOrderQty', p?.minOrderQty ?? 0, 'number')}
    </div>
    <div class="mt-3 flex gap-2">
      <button class="btn btn-primary" id="save-prod">${p ? 'Save' : 'Create'}</button>
      <button class="btn btn-ghost" id="cancel-prod">Cancel</button>
    </div>
  </div>`;
  el('cancel-prod').onclick = () => { slot.innerHTML = ''; };
  el('save-prod').onclick = async () => {
    const body = collect(['sku', 'name', 'category', 'supplierId', 'unitCost', 'price', 'currentStock', 'leadTimeDays', 'packSize', 'minOrderQty']);
    if (!body.sku || !body.name) return toast('SKU and name required', 'err');
    try {
      if (p) await api.put('/api/products/' + p.id, body); else await api.post('/api/products', body);
      slot.innerHTML = ''; toast('Saved'); refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
}

function field(label, id, val, type = 'text') {
  return `<div><label class="label">${label}</label><input class="input" id="f-${id}" type="${type}" value="${val == null ? '' : esc(val)}" ${type === 'number' ? 'step="any"' : ''}/></div>`;
}
function collect(ids) { const o = {}; ids.forEach((id) => { const n = el('f-' + id); if (n) o[id] = n.value; }); return o; }

// --- orders ----------------------------------------------------------------
function renderOrders() {
  const all = STATE.allPurchaseOrders;
  el('tab-orders').innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-semibold">Purchase orders</h3>
      <button class="btn btn-primary" id="new-po">+ Manual PO</button>
    </div>
    <div id="po-form-slot" class="mb-4"></div>
    <div class="card overflow-x-auto">
      <table class="grid"><thead><tr><th>PO</th><th>Supplier</th><th>Status</th><th>Lines</th><th>Units</th><th>Value</th><th>Ordered</th><th>ETA</th><th></th></tr></thead>
      <tbody>${all.length ? all.map((po) => `<tr>
        <td class="font-mono text-xs">${esc(po.id)}</td>
        <td>${esc(po.supplierName || '')}</td>
        <td><span class="badge badge-${esc(po.status)}">${esc(po.status)}</span>${po.auto ? ' <span class="text-[10px] text-slate-400">auto</span>' : ''}</td>
        <td>${(po.lines || []).length}</td>
        <td>${(po.lines || []).reduce((t, l) => t + l.qty, 0)}</td>
        <td>${money(po.total)}</td>
        <td class="text-xs">${fmtDate(po.orderedAt)}</td>
        <td class="text-xs">${po.eta ? fmtDate(po.eta) : '—'}</td>
        <td class="text-right whitespace-nowrap">
          ${po.status === 'draft' ? `<button class="btn btn-primary" data-po-send="${esc(po.id)}">Send</button>` : ''}
          ${po.status !== 'received' && po.status !== 'cancelled' ? `<button class="btn btn-ghost" data-po-receive="${esc(po.id)}">Receive</button>` : ''}
          ${po.status !== 'received' && po.status !== 'cancelled' ? `<button class="btn btn-danger" data-po-cancel="${esc(po.id)}">Cancel</button>` : ''}
        </td></tr>`).join('') : `<tr><td colspan="9" class="text-center text-slate-400 py-6">No purchase orders yet.</td></tr>`}
      </tbody></table>
    </div>`;
  bindPoActions(el('tab-orders'));
  el('new-po').onclick = showPoForm;
}

function showPoForm() {
  const slot = el('po-form-slot');
  const supOpts = STATE.suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  slot.innerHTML = `<div class="card p-4">
    <h4 class="font-semibold mb-3">Manual purchase order</h4>
    <div class="grid sm:grid-cols-2 gap-3 mb-3">
      <div><label class="label">Supplier</label><select class="input" id="po-supplier">${supOpts}</select></div>
    </div>
    <div id="po-lines"></div>
    <button class="btn btn-ghost mt-2" id="po-add-line">+ Add line</button>
    <div class="mt-3 flex gap-2">
      <button class="btn btn-primary" id="po-save">Create draft</button>
      <button class="btn btn-ghost" id="po-cancel">Cancel</button>
    </div>
  </div>`;
  const addLine = () => {
    const div = document.createElement('div');
    div.className = 'flex gap-2 mb-2 po-line';
    const opts = STATE.products.map((p) => `<option value="${esc(p.id)}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('');
    div.innerHTML = `<select class="input po-prod" style="flex:3">${opts}</select>
      <input class="input po-qty" style="flex:1" type="number" min="1" value="1"/>
      <button class="btn btn-danger po-rm">✕</button>`;
    el('po-lines').appendChild(div);
    div.querySelector('.po-rm').onclick = () => div.remove();
  };
  addLine();
  el('po-add-line').onclick = addLine;
  el('po-cancel').onclick = () => slot.innerHTML = '';
  el('po-save').onclick = async () => {
    const lines = [...document.querySelectorAll('.po-line')].map((d) => ({ productId: d.querySelector('.po-prod').value, qty: Number(d.querySelector('.po-qty').value) }));
    try { await api.post('/api/purchase-orders', { supplierId: el('po-supplier').value, lines }); slot.innerHTML = ''; toast('Draft PO created'); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

// --- suppliers -------------------------------------------------------------
function renderSuppliers() {
  const rows = STATE.suppliers.map((s) => `<tr>
    <td>${esc(s.name)}</td>
    <td class="text-xs">${esc(s.email || '—')}</td>
    <td>${esc(s.leadTimeDays)}d</td>
    <td>${esc((s.deliveryWindows || []).map((h) => h + ':00').join(', ') || '—')}</td>
    <td>${s.cutoffHour != null ? esc(s.cutoffHour + ':00') : '—'}</td>
    <td>${money(s.minOrderValue || 0)}</td>
    <td class="text-right whitespace-nowrap">
      <button class="btn btn-ghost" data-edit-sup="${esc(s.id)}">Edit</button>
      <button class="btn btn-danger" data-del-sup="${esc(s.id)}">✕</button></td>
  </tr>`).join('');
  el('tab-suppliers').innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-semibold">Suppliers</h3>
      <button class="btn btn-primary" id="add-sup">+ Add supplier</button>
    </div>
    <div class="card overflow-x-auto"><table class="grid"><thead><tr>
      <th>Name</th><th>Email</th><th>Lead time</th><th>Delivery windows</th><th>Cut-off</th><th>Min order</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="text-center text-slate-400 py-6">No suppliers yet.</td></tr>`}</tbody></table></div>
    <div id="sup-form-slot" class="mt-4"></div>`;
  el('add-sup').onclick = () => showSupplierForm();
  el('tab-suppliers').querySelectorAll('[data-edit-sup]').forEach((b) => b.onclick = () => showSupplierForm(STATE.suppliers.find((s) => s.id === b.dataset.editSup)));
  el('tab-suppliers').querySelectorAll('[data-del-sup]').forEach((b) => b.onclick = async () => { if (confirm('Delete supplier?')) { await api.del('/api/suppliers/' + b.dataset.delSup); toast('Deleted'); refresh(); } });
}

function showSupplierForm(s = null) {
  const slot = el('sup-form-slot');
  slot.innerHTML = `<div class="card p-4"><h4 class="font-semibold mb-3">${s ? 'Edit' : 'New'} supplier</h4>
    <div class="grid sm:grid-cols-3 gap-3">
      ${field('Name', 'name', s?.name)}
      ${field('Order email', 'email', s?.email)}
      ${field('Lead time (days)', 'leadTimeDays', s?.leadTimeDays ?? 2, 'number')}
      ${field('Delivery windows (hours, e.g. 8,13,19)', 'deliveryWindows', (s?.deliveryWindows || [9, 15]).join(','))}
      ${field('Order cut-off hour (optional)', 'cutoffHour', s?.cutoffHour ?? '', 'number')}
      ${field('Min order value', 'minOrderValue', s?.minOrderValue ?? 0, 'number')}
    </div>
    <div class="mt-3 flex gap-2"><button class="btn btn-primary" id="save-sup">${s ? 'Save' : 'Create'}</button>
    <button class="btn btn-ghost" id="cancel-sup">Cancel</button></div></div>`;
  el('cancel-sup').onclick = () => slot.innerHTML = '';
  el('save-sup').onclick = async () => {
    const body = collect(['name', 'email', 'leadTimeDays', 'deliveryWindows', 'cutoffHour', 'minOrderValue']);
    if (!body.name) return toast('Name required', 'err');
    try { if (s) await api.put('/api/suppliers/' + s.id, body); else await api.post('/api/suppliers', body); slot.innerHTML = ''; toast('Saved'); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

// --- forecast & hypotheses -------------------------------------------------
function renderForecast() {
  const prodOpts = STATE.products.map((p) => `<option value="${esc(p.id)}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('');
  const hyp = STATE.hypotheses;
  el('tab-forecast').innerHTML = `
    <div class="grid lg:grid-cols-2 gap-4">
      <div class="card p-4">
        <h3 class="font-semibold mb-2">Per-SKU forecast</h3>
        <select class="input mb-3" id="fc-prod">${prodOpts}</select>
        <div id="fc-detail" class="text-sm"></div>
      </div>
      <div class="card p-4">
        <h3 class="font-semibold mb-1">Demand hypotheses</h3>
        <p class="text-xs text-slate-400 mb-3">The forward-looking half of the tanpin kanri (単品管理) method popularized by Japanese convenience retail: tell the system about a weather change or local event and it bumps the forecast (and therefore orders) automatically.</p>
        <div class="grid grid-cols-2 gap-2 mb-2">
          <div class="col-span-2"><label class="label">Note</label><input class="input" id="hy-note" placeholder="Heatwave next week"/></div>
          <div><label class="label">Multiplier</label><input class="input" id="hy-mult" type="number" step="0.05" value="1.3"/></div>
          <div><label class="label">Category (optional)</label><input class="input" id="hy-cat" placeholder="beverage"/></div>
          <div class="col-span-2"><label class="label">Or specific product (optional)</label><select class="input" id="hy-prod"><option value="">— whole category —</option>${prodOpts}</select></div>
        </div>
        <button class="btn btn-primary" id="hy-add">Add hypothesis</button>
        <div class="mt-3 space-y-2">
          ${hyp.length ? hyp.map((h) => `<div class="flex items-center justify-between border border-slate-200 rounded p-2 text-xs">
            <div><b>×${esc(h.multiplier)}</b> ${esc(h.note || '')}<div class="text-slate-400">${h.scope && h.scope.productId ? 'product' : esc((h.scope && h.scope.category) || 'all')} · ${fmtDate(h.startsAt)} → ${fmtDate(h.endsAt)}</div></div>
            <button class="btn btn-danger" data-del-hy="${esc(h.id)}">✕</button></div>`).join('') : '<p class="text-xs text-slate-400">No active hypotheses.</p>'}
        </div>
      </div>
    </div>`;
  const drawDetail = () => {
    const p = STATE.products.find((x) => x.id === el('fc-prod').value);
    if (!p || !p.forecast) { el('fc-detail').innerHTML = '<p class="text-slate-400">No forecast data.</p>'; return; }
    const f = p.forecast;
    const series = (f.series || []).map((v) => Number(v) || 0);
    const max = Math.max(1, ...series);
    const spark = `<div class="spark">${series.map((v) => `<span style="height:${Math.max(2, (v / max) * 22)}px"></span>`).join('')}</div>`;
    el('fc-detail').innerHTML = `
      <div class="mb-3">${spark}<div class="text-[11px] text-slate-400">daily sales, last ${series.length} completed day${series.length === 1 ? '' : 's'}</div></div>
      <table class="grid"><tbody>
        <tr><td>Base demand (weighted avg)</td><td class="text-right font-medium">${num(f.avgDailyDemand)}/day</td></tr>
        <tr><td>Day-of-week factor</td><td class="text-right">×${num(f.weekdayFactor, 2)}</td></tr>
        <tr><td>Trend factor</td><td class="text-right">×${num(f.trendFactor, 2)}</td></tr>
        <tr><td>Hypothesis (event/weather)</td><td class="text-right">×${num(f.hypothesisMultiplier, 2)}</td></tr>
        <tr><td class="font-semibold">→ Forecast demand</td><td class="text-right font-semibold">${num(f.dailyForecast)}/day</td></tr>
        <tr><td>Demand std dev</td><td class="text-right">${num(f.dailyStdDev)}</td></tr>
        <tr><td>Safety stock</td><td class="text-right">${num(p.safetyStock)}</td></tr>
        <tr><td>Reorder point</td><td class="text-right">${num(p.reorderPoint)}</td></tr>
        <tr><td>EOQ</td><td class="text-right">${num(p.eoq)}</td></tr>
      </tbody></table>`;
  };
  el('fc-prod').onchange = drawDetail; drawDetail();
  el('hy-add').onclick = async () => {
    try {
      await api.post('/api/hypotheses', { note: el('hy-note').value, multiplier: Number(el('hy-mult').value), category: el('hy-cat').value || null, productId: el('hy-prod').value || null });
      toast('Hypothesis added — forecasts updated'); refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
  el('tab-forecast').querySelectorAll('[data-del-hy]').forEach((b) => b.onclick = async () => { await api.del('/api/hypotheses/' + b.dataset.delHy); toast('Removed'); refresh(); });
}

// --- activity --------------------------------------------------------------
function renderActivity() {
  el('tab-activity').innerHTML = `
    <div class="grid lg:grid-cols-2 gap-4">
      <div class="card p-4">
        <h3 class="font-semibold mb-2">Daemon activity log</h3>
        <div class="space-y-2 text-xs">${STATE.daemonLog.length ? STATE.daemonLog.map((t) => `
          <div class="border border-slate-200 rounded p-2">
            <div class="flex justify-between"><b>${fmtDate(t.at)}</b><span class="badge badge-${t.trigger === 'daemon' ? 'sent' : 'draft'}">${esc(t.trigger)}</span></div>
            <div class="text-slate-500 mt-1">${t.ordersCreated} orders · ${t.orderLines} lines · ${t.emailsSent} emails · ${t.received} received · ${t.delistFlags.length} delist</div>
            ${t.notes && t.notes.length ? `<div class="text-slate-400 mt-1">${t.notes.map(esc).join('<br>')}</div>` : ''}
          </div>`).join('') : '<p class="text-slate-400">No cycles yet.</p>'}</div>
      </div>
      <div class="card p-4">
        <h3 class="font-semibold mb-2">Outbox <span class="text-xs text-slate-400">(auto-sent email)</span></h3>
        <div class="space-y-2 text-xs">${STATE.outbox.length ? STATE.outbox.map((m) => `
          <div class="border border-slate-200 rounded p-2">
            <div class="flex justify-between"><b>${esc(m.subject || '')}</b><span class="badge badge-${m.transport === 'smtp' ? 'received' : 'draft'}">${esc(m.transport)}</span></div>
            <div class="text-slate-500">→ ${esc(m.to || '')} · ${fmtDate(m.at)}</div>
          </div>`).join('') : '<p class="text-slate-400">No emails sent yet. Enable auto-send or click Send on a PO.</p>'}</div>
      </div>
    </div>`;
}

// --- API & integrations ------------------------------------------------------
function renderApi() {
  const origin = window.location.origin;
  const keys = STATE.apiKeys || [];
  const hooks = STATE.webhooks || [];
  const log = STATE.webhookLog || [];
  el('tab-api').innerHTML = `
    <div class="grid lg:grid-cols-2 gap-4">
      <div class="card p-4">
        <h3 class="font-semibold mb-1">API keys</h3>
        <p class="text-xs text-slate-400 mb-3">For POS systems, ERPs, scripts, and AI agents. Send as <code>Authorization: Bearer &lt;key&gt;</code> or <code>X-API-Key</code>. Keys are stored hashed and shown only once. Requests made on this machine directly to localhost need no key; anything through a proxy, container port or another origin does.${currentKey() ? ' <a href="#" id="key-forget">Forget the key this browser uses</a>.' : ''}</p>
        <div class="flex gap-2 mb-3">
          <input class="input" id="key-name" placeholder="Key name, e.g. acme-pos" style="max-width:260px"/>
          <button class="btn btn-primary" id="key-create">Create key</button>
        </div>
        <div id="key-reveal"></div>
        ${keys.length ? `<table class="grid"><thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
          ${keys.map((k) => `<tr class="${k.revoked ? 'opacity-50' : ''}">
            <td>${esc(k.name)}</td><td class="font-mono text-xs">${esc(k.prefix)}…</td>
            <td class="text-xs">${fmtDate(k.createdAt)}</td><td class="text-xs">${k.lastUsedAt ? fmtDate(k.lastUsedAt) : '—'}</td>
            <td class="text-right">${k.revoked ? '<span class="badge badge-cancelled">revoked</span>' : `<button class="btn btn-danger" data-revoke-key="${esc(k.id)}">Revoke</button>`}</td>
          </tr>`).join('')}</tbody></table>` : '<p class="text-xs text-slate-400">No keys yet.</p>'}
      </div>

      <div class="card p-4">
        <h3 class="font-semibold mb-1">Webhooks</h3>
        <p class="text-xs text-slate-400 mb-3">Push events to your systems instead of polling. Deliveries are JSON POSTs signed with <code>X-Inventory-Signature</code> (HMAC-SHA256 of the raw body).</p>
        <div class="grid grid-cols-1 gap-2 mb-2">
          <input class="input" id="hook-url" placeholder="https://your-system.example/hook"/>
          <div class="flex gap-2 items-center">
            <input class="input" id="hook-events" placeholder="Events (comma-sep) or * for all" value="*"/>
            <button class="btn btn-primary whitespace-nowrap" id="hook-create">Add webhook</button>
          </div>
          <div class="text-[11px] text-slate-400">Events: ${(STATE.webhookEvents || []).map((e) => `<code>${esc(e)}</code>`).join(' ')}</div>
        </div>
        ${hooks.length ? `<table class="grid"><thead><tr><th>URL</th><th>Events</th><th></th></tr></thead><tbody>
          ${hooks.map((h) => `<tr>
            <td class="text-xs font-mono">${esc(h.url)}</td>
            <td class="text-xs">${esc((h.events || ['*']).join(', '))}</td>
            <td class="text-right whitespace-nowrap">
              <button class="btn btn-ghost" data-test-hook="${esc(h.id)}">Test</button>
              <button class="btn btn-danger" data-del-hook="${esc(h.id)}">✕</button>
            </td></tr>`).join('')}</tbody></table>` : '<p class="text-xs text-slate-400">No webhooks yet.</p>'}
        ${log.length ? `<h4 class="font-semibold text-xs mt-3 mb-1">Recent deliveries</h4>
          <div class="space-y-1 text-[11px]">${log.slice(0, 8).map((d) => `
            <div class="flex justify-between border border-slate-100 rounded px-2 py-1">
              <span><code>${esc(d.event)}</code> → ${esc(d.url)}</span>
              <span class="${d.ok ? 'text-slate-400' : 'text-red-600'}">${esc(d.ok ? (d.status || 'ok') : (d.error || d.status || 'failed'))}</span>
            </div>`).join('')}</div>` : ''}
      </div>

      <div class="card p-4">
        <h3 class="font-semibold mb-1">Machine-readable docs</h3>
        <p class="text-xs text-slate-400 mb-3">Everything an integration (human or AI) needs to discover this API on its own.</p>
        <ul class="text-sm space-y-2">
          <li>📄 <a href="${origin}/openapi.json" target="_blank"><code>/openapi.json</code></a> — OpenAPI 3.1 spec (import into Postman, codegen, agents)</li>
          <li>🤖 <a href="${origin}/llms.txt" target="_blank"><code>/llms.txt</code></a> — concise guide for AI agents</li>
          <li>🤖 <a href="${origin}/llms-full.txt" target="_blank"><code>/llms-full.txt</code></a> — full endpoint reference for LLM context</li>
          <li>🗂️ <a href="${origin}/api" target="_blank"><code>GET /api</code></a> — self-describing endpoint index</li>
          <li>⬇️ <a href="${origin}/api/export/products.csv"><code>/api/export/products.csv</code></a> — catalog export</li>
        </ul>
      </div>

      <div class="card p-4">
        <h3 class="font-semibold mb-1">Quickstarts</h3>
        <p class="text-xs text-slate-400 mb-2">Record a sale from anything that can speak HTTP:</p>
        <pre class="text-[11px] bg-slate-900 text-slate-100 rounded p-3 overflow-x-auto">curl -X POST ${origin}/api/sales \\
  -H "Authorization: Bearer &lt;key&gt;" \\
  -d '{"sku": "COFFEE-HOT", "qty": 2}'</pre>
        <p class="text-xs text-slate-400 mt-3 mb-2">Give Claude (or any MCP client) native inventory tools:</p>
        <pre class="text-[11px] bg-slate-900 text-slate-100 rounded p-3 overflow-x-auto">claude mcp add tanpin -- node /path/to/tanpin/src/mcp.js</pre>
        <p class="text-xs text-slate-400 mt-2">Then ask: <em>"check stock levels and order whatever we need"</em>.</p>
      </div>
    </div>`;

  const forget = el('key-forget');
  if (forget) forget.onclick = (ev) => { ev.preventDefault(); forgetKey(); toast('Key forgotten for this browser'); refresh(); };
  el('key-create').onclick = async () => {
    const name = el('key-name').value.trim() || 'API key';
    try {
      const r = await api.post('/api/keys', { name });
      el('key-reveal').innerHTML = `<div class="border border-emerald-300 bg-emerald-50 rounded p-3 mb-3 text-xs">
        <b>Key created — copy it now, it won't be shown again:</b>
        <div class="font-mono mt-1 select-all">${esc(r.key)}</div></div>`;
      toast('API key created');
      STATE = await api.get('/api/state');
      CURRENCY = STATE.settings.currency || 'USD';
    } catch (e) { toast(e.message, 'err'); }
  };
  el('hook-create').onclick = async () => {
    const url = el('hook-url').value.trim();
    const events = el('hook-events').value.split(',').map((s) => s.trim()).filter(Boolean);
    try { await api.post('/api/webhooks', { url, events }); toast('Webhook added'); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  };
  el('tab-api').querySelectorAll('[data-revoke-key]').forEach((b) => b.onclick = async () => {
    if (confirm('Revoke this key? Integrations using it will stop working.')) {
      await api.del('/api/keys/' + b.dataset.revokeKey); toast('Key revoked'); refresh();
    }
  });
  el('tab-api').querySelectorAll('[data-test-hook]').forEach((b) => b.onclick = async () => {
    try {
      const r = await api.post(`/api/webhooks/${b.dataset.testHook}/test`);
      toast(r.delivery.ok ? `Test delivered (${r.delivery.status})` : `Delivery failed: ${r.delivery.error || r.delivery.status}`, r.delivery.ok ? '' : 'err');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  });
  el('tab-api').querySelectorAll('[data-del-hook]').forEach((b) => b.onclick = async () => {
    await api.del('/api/webhooks/' + b.dataset.delHook); toast('Webhook removed'); refresh();
  });
}

// --- settings --------------------------------------------------------------
function timezoneField(current) {
  const val = current || '';
  const extras = val && !TIMEZONES.includes(val) ? `<option value="${esc(val)}" selected>${esc(val)}</option>` : '';
  const opts = TIMEZONES.map((z) => `<option value="${z}" ${val === z ? 'selected' : ''}>${z}</option>`).join('');
  return `<div class="col-span-2">
    <label class="label">Store timezone</label>
    <input class="input" id="s-timezone" list="tz-list" value="${esc(val)}" placeholder="e.g. Asia/Tokyo" autocomplete="off"/>
    <datalist id="tz-list">${extras}${opts}</datalist>
    <p class="text-xs text-slate-400 mt-1">IANA name stored as <code>settings.timezone</code>. The dashboard formats dates and ETAs in this zone. Leave blank for the browser’s local zone.</p>
  </div>`;
}

function renderSettings() {
  const s = STATE.settings;
  const toggle = (id, label, desc) => `<label class="flex items-start gap-2 py-2 border-b border-slate-100">
    <input type="checkbox" id="s-${id}" ${s[id] ? 'checked' : ''} class="mt-1"/>
    <span><span class="font-medium text-sm">${label}</span><br><span class="text-xs text-slate-400">${desc}</span></span></label>`;
  el('tab-settings').innerHTML = `
    <div class="grid lg:grid-cols-2 gap-4">
      <div class="card p-4">
        <h3 class="font-semibold mb-2">Automation</h3>
        ${toggle('autoManage', 'Auto-manage stock', 'Daemon recomputes forecasts and raises draft POs when stock hits the reorder point.')}
        ${toggle('autoSend', 'Auto-email POs to suppliers', 'Draft POs are emailed to suppliers automatically (otherwise they wait for your Send click).')}
        ${toggle('autoReceive', 'Auto-receive on ETA', 'Lights-out mode: mark POs received and add to stock once their ETA passes.')}
        ${toggle('autoEmailAlerts', 'Email digests to manager', 'Send an operational digest when orders are raised or delist candidates appear.')}
      </div>
      <div class="card p-4">
        <h3 class="font-semibold mb-2">Planning parameters</h3>
        <div class="grid grid-cols-2 gap-3">
          ${sfield('Service level (0–1)', 'serviceLevel', s.serviceLevel)}
          ${sfield('Target days of supply', 'targetDaysOfSupply', s.targetDaysOfSupply)}
          ${sfield('Max days of supply (JIT cap)', 'maxDaysOfSupply', s.maxDaysOfSupply)}
          ${sfield('Order cost (per PO)', 'orderCost', s.orderCost)}
          ${sfield('Holding cost rate (annual)', 'holdingCostRate', s.holdingCostRate)}
          ${sfield('Daemon interval (minutes)', 'daemonIntervalMinutes', s.daemonIntervalMinutes)}
        </div>
      </div>
      <div class="card p-4">
        <h3 class="font-semibold mb-2">Identity &amp; email</h3>
        <div class="grid grid-cols-2 gap-3">
          ${sfield('Company name', 'companyName', s.companyName, 'text')}
          ${sfield('Currency', 'currency', s.currency, 'text')}
          ${sfield('From email', 'fromEmail', s.fromEmail, 'text')}
          ${sfield('Manager notify email', 'notifyEmail', s.notifyEmail, 'text')}
          ${timezoneField(s.timezone)}
        </div>
        <p class="text-xs text-slate-400 mt-2">Set <code>SMTP_HOST</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> env vars to send real email; otherwise messages are written to the <code>outbox/</code> folder.</p>
      </div>
      <div class="card p-4 flex flex-col justify-between">
        <div>
          <h3 class="font-semibold mb-2">Danger zone</h3>
          <p class="text-xs text-slate-400">Reset wipes all data. Load demo data repopulates a sample store.</p>
        </div>
        <div class="flex gap-2 mt-3">
          <button class="btn btn-ghost" id="s-reload-demo">Load demo data</button>
          <button class="btn btn-danger" id="s-reset">Reset all data</button>
        </div>
      </div>
    </div>
    <div class="mt-4"><button class="btn btn-primary" id="s-save">Save settings</button></div>`;
  el('s-save').onclick = async () => {
    const body = {
      autoManage: el('s-autoManage').checked, autoSend: el('s-autoSend').checked,
      autoReceive: el('s-autoReceive').checked, autoEmailAlerts: el('s-autoEmailAlerts').checked,
      serviceLevel: Number(el('s-serviceLevel').value), targetDaysOfSupply: Number(el('s-targetDaysOfSupply').value),
      maxDaysOfSupply: Number(el('s-maxDaysOfSupply').value), orderCost: Number(el('s-orderCost').value),
      holdingCostRate: Number(el('s-holdingCostRate').value), daemonIntervalMinutes: Number(el('s-daemonIntervalMinutes').value),
      companyName: el('s-companyName').value, currency: el('s-currency').value,
      fromEmail: el('s-fromEmail').value, notifyEmail: el('s-notifyEmail').value,
      timezone: el('s-timezone').value.trim(),
    };
    try {
      await api.put('/api/settings', body);
      if (body.timezone && !validTimeZone(body.timezone)) {
        toast('Saved, but that timezone is not a valid IANA name — dates stay in the browser’s local zone');
      } else {
        toast('Settings saved');
      }
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
  el('s-reset').onclick = async () => { if (confirm('Wipe ALL data?')) { await api.post('/api/reset'); toast('Reset'); refresh(); } };
  el('s-reload-demo').onclick = async () => { await api.post('/api/seed'); toast('Demo data loaded'); refresh(); };
}

function sfield(label, id, val, type = 'number') {
  return `<div><label class="label">${label}</label><input class="input" id="s-${id}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${val == null ? '' : esc(val)}"/></div>`;
}

// --- top bar actions -------------------------------------------------------
el('btn-run').onclick = async () => { el('btn-run').textContent = 'Running…'; try { const s = await api.post('/api/daemon/run'); toast(`Cycle done: ${s.ordersCreated} orders, ${s.emailsSent} emails`); } catch (e) { toast(e.message, 'err'); } el('btn-run').textContent = 'Run cycle now'; refresh(); };
el('btn-seed').onclick = async () => { if (confirm('Replace current data with demo data?')) { await api.post('/api/seed'); toast('Demo data loaded'); refresh(); } };

refresh();
updateClock();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 30000);
setInterval(updateClock, 1000);
