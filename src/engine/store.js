'use strict';
// Persistence. Default is SQLite (src/engine/store-sqlite.js) when node:sqlite
// is available: WAL, one transaction per mutation, incremental row writes,
// safe for two processes. JSON remains the fallback (TANPIN_STORE=json, or
// builds without node:sqlite) and is single-process only.
// Callers only use the small API: load, save, mutate(fn), refresh, reset,
// list, find, insert, update, remove.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DATA = () => ({
  meta: { version: 1, createdAt: Date.now() },
  settings: {
    currency: 'USD',
    serviceLevel: 0.95,        // 95% in-stock probability
    targetDaysOfSupply: 7,
    maxDaysOfSupply: 21,       // JIT cap: never order more than this much supply
    orderCost: 25,             // fixed admin cost per PO, for EOQ
    holdingCostRate: 0.25,     // annual holding cost as fraction of unit cost
    autoManage: true,          // daemon recomputes + raises draft POs
    autoSend: false,           // daemon emails POs to suppliers automatically
    autoReceive: false,        // daemon auto-receives POs once ETA passes (demo/lights-out)
    autoEmailAlerts: true,     // low-stock / dead-stock digests
    daemonIntervalMinutes: 15,
    notifyEmail: '',           // where operational alerts go
    fromEmail: 'inventory@example.com',
    companyName: 'Your Company',
    movementRetentionDays: 365, // 0 = keep forever; prune movements older than this
  },
  products: [],
  suppliers: [],
  purchaseOrders: [],
  movements: [],     // sales / receipts / adjustments
  hypotheses: [],    // forward-looking demand bumps (events/weather)
  daemonLog: [],     // one entry per auto-management tick
  outbox: [],        // record of every email the system sent
  apiKeys: [],       // API keys: {id,name,prefix,hash,createdAt,lastUsedAt,revoked}
  webhooks: [],      // outbound integrations: {id,url,events,secret,active}
  webhookLog: [],    // recent webhook delivery attempts
  idempotency: {},   // Idempotency-Key -> {status, body, at} (24h replay cache)
});

function applyDefaults(data) {
  const defaults = DEFAULT_DATA();
  if (!data || typeof data !== 'object') return defaults;
  data.settings = { ...defaults.settings, ...(data.settings || {}) };
  for (const key of Object.keys(defaults)) {
    if (data[key] === undefined) data[key] = defaults[key];
  }
  return data;
}

function pruneMovements(data) {
  if (!data || !Array.isArray(data.movements)) return data;
  const days = Number(data.settings && data.settings.movementRetentionDays);
  if (!Number.isFinite(days) || days <= 0) return data;
  const cut = Date.now() - days * 86400000;
  const kept = data.movements.filter((m) => (m.at ?? m.createdAt ?? 0) >= cut);
  if (kept.length === data.movements.length) return data;
  data.movements.length = 0;
  for (const m of kept) data.movements.push(m);
  return data;
}

function envWantsJson() {
  const v = String(process.env.TANPIN_STORE || '').toLowerCase();
  return v === 'json' || v === 'file';
}

function defaultDbFile() {
  return path.join(path.resolve(process.env.TANPIN_DATA_DIR || 'data'), 'inventory.json');
}

// Tests and older scripts set INVENTORY_DB; config.js still passes the default
// data/inventory.json path. Remap only that default path so explicit Store(file)
// arguments (including store tests) stay untouched.
function resolveFile(file) {
  const tanpin = process.env.TANPIN_DB;
  const inventory = process.env.INVENTORY_DB;
  const envFile = inventory || tanpin;
  if (!file) file = envFile || defaultDbFile();
  // config.js still passes data/inventory.json and does not read INVENTORY_DB.
  // Remap that default path so tests/older scripts isolating via INVENTORY_DB win.
  if (path.resolve(file) === defaultDbFile() && envFile) return envFile;
  return file;
}

class JsonStore {
  constructor(file) {
    this.file = resolveFile(file);
    this.data = null;
    this.backend = 'json';
  }

  load() {
    try {
      this._mtime = mtimeOf(this.file);
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = JSON.parse(raw);
      applyDefaults(this.data);
    } catch {
      this.data = DEFAULT_DATA();
      this.save();
      return this.data;
    }
    const before = (this.data.movements || []).length;
    pruneMovements(this.data);
    if ((this.data.movements || []).length !== before) this.save();
    return this.data;
  }

  save() {
    pruneMovements(this.data);
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file); // atomic on POSIX
    this._mtime = mtimeOf(this.file);
  }

  /** Apply fn(data) and save. (Single-process backend: data is always current.) */
  mutate(fn) {
    if (!this.data) this.load();
    const out = fn(this.data);
    this.save();
    return out;
  }

  /** Reload if another process rewrote the file since our last read/write. */
  refresh() {
    if (!this.data) { this.load(); return true; }
    const m = mtimeOf(this.file);
    if (m == null || m === this._mtime) return false;
    const fresh = new JsonStore(this.file);
    fresh.load();
    for (const k of Object.keys(this.data)) if (!(k in fresh.data)) delete this.data[k];
    Object.assign(this.data, fresh.data);
    this._mtime = fresh._mtime;
    return true;
  }

  reset() {
    this.data = DEFAULT_DATA();
    this.save();
    return this.data;
  }

  close() {}

  list(coll) { return this.data[coll] || []; }
  find(coll, id) { return (this.data[coll] || []).find((x) => x.id === id) || null; }

  insert(coll, doc) {
    if (!doc.id) doc.id = newId(coll);
    if (!doc.createdAt) doc.createdAt = Date.now();
    this.data[coll].push(doc);
    this.save();
    return doc;
  }

  update(coll, id, patch) {
    const row = this.find(coll, id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: Date.now() });
    this.save();
    return row;
  }

  remove(coll, id) {
    const before = this.data[coll].length;
    this.data[coll] = this.data[coll].filter((x) => x.id !== id);
    const removed = this.data[coll].length !== before;
    if (removed) this.save();
    return removed;
  }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

let counter = 0;
function newId(prefix = 'id') {
  counter += 1;
  const t = Date.now().toString(36);
  const c = counter.toString(36);
  const r = Math.floor(Math.random() * 1e6).toString(36);
  return `${prefix.slice(0, 3)}_${t}${c}${r}`;
}

// Export before loading the sqlite module so a circular require sees these.
module.exports = {
  Store: JsonStore,
  JsonStore,
  newId,
  DEFAULT_DATA,
  applyDefaults,
  pruneMovements,
  resolveFile,
};

function sqliteUnavailable(err) {
  const code = err && err.code;
  if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' || code === 'MODULE_NOT_FOUND') return true;
  const msg = String(err && err.message || err);
  return /cannot find module|not supported/i.test(msg);
}

let sqliteAvailable = false;
if (!envWantsJson()) {
  try {
    const { SqliteStore } = require('./store-sqlite');
    module.exports.Store = SqliteStore;
    sqliteAvailable = true;
  } catch (err) {
    if (!sqliteUnavailable(err)) throw err;
    sqliteAvailable = false;
  }
}
module.exports.sqliteAvailable = sqliteAvailable;
