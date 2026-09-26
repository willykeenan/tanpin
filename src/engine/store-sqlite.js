'use strict';
// SQLite backend (node:sqlite). WAL + one IMMEDIATE transaction per write so
// the HTTP server and a standalone daemon can share one file safely.
//
// Layout: every array collection is stored one row per document in `docs`
// (coll, id, pos, doc); every other top-level value (settings, meta, the
// idempotency cache, ...) is one row in `kv`. Public methods match JsonStore.
//
// Writes are incremental: save() compares the in-memory state with what it
// knows the database holds (this._known, one JSON string per row) and only
// upserts/deletes the rows that changed. Append-only logs (movements and the
// newest-first activity logs) are never re-serialized — a new id is an insert,
// a vanished id a delete — so a sale on a store with 100k movements writes a
// handful of rows instead of rewriting the whole database.
//
// Other processes: `PRAGMA data_version` changes when another connection
// commits. Inside the write transaction (lock held) we check it; if someone
// else wrote since our last read, we re-read and three-way merge (snapshot =
// what we last read, mem = our edits, db = theirs) before writing. For values
// that must combine rather than merge — stock on hand — callers use
// mutate(fn), which runs `fn` against the freshest state inside the lock, so
// a delta (stock - qty) is applied to the current row, never to a stale copy.

const fs = require('node:fs');
const path = require('node:path');

const { DatabaseSync } = loadDatabaseSync();

function helpers() {
  return require('./store');
}

const BUSY_TIMEOUT_MS = 15000;
const TX_RETRIES = 8;

// Rows in these collections are never modified after insert (only appended,
// pruned or truncated). Change detection is by id; no per-save stringify.
const APPEND_ONLY = new Set(['movements', 'daemonLog', 'outbox', 'webhookLog']);
// These are unshift()-ed (newest first) and read with slice(0, N): after a
// merge, rows another process added must sort to the front, not the end.
const NEWEST_FIRST = new Set(['daemonLog', 'outbox', 'webhookLog']);

function sqlitePath(file) {
  if (/\.sqlite$/i.test(file) || /\.db$/i.test(file)) return file;
  if (/\.json$/i.test(file)) return file.replace(/\.json$/i, '.sqlite');
  return `${file}.sqlite`;
}

function jsonCompanionPath(file) {
  if (/\.json$/i.test(file)) return file;
  if (/\.sqlite$/i.test(file)) return file.replace(/\.sqlite$/i, '.json');
  if (/\.db$/i.test(file)) return file.replace(/\.db$/i, '.json');
  return `${file}.json`;
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sampleShape() {
  return helpers().DEFAULT_DATA();
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function byId(arr) {
  const map = new Map();
  for (const item of arr || []) {
    if (item && item.id != null) map.set(item.id, item);
  }
  return map;
}

function emptyKnown() {
  return { kv: new Map(), docs: new Map(), maxPos: new Map() };
}

function sortNewestFirst(arr) {
  // Stable: equal timestamps keep their relative order.
  return arr
    .map((item, i) => ({ item, i }))
    .sort((a, b) => ((b.item && b.item.at) || 0) - ((a.item && a.item.at) || 0) || a.i - b.i)
    .map((x) => x.item);
}

function mergeArray(snap, mem, db) {
  const snapMap = byId(snap);
  const memMap = byId(mem);
  const dbMap = byId(db);
  const out = [];
  const seen = new Set();

  for (const item of mem || []) {
    if (!item || item.id == null) {
      out.push(item);
      continue;
    }
    seen.add(item.id);
    const s = snapMap.get(item.id);
    const d = dbMap.get(item.id);
    // Untouched locally and deleted in db → honor the remote delete.
    if (s !== undefined && d === undefined && eq(item, s)) continue;
    if (d !== undefined && typeof item === 'object' && typeof d === 'object') {
      const base = s && typeof s === 'object' ? s : {};
      out.push(mergeObject(base, item, d));
    } else {
      out.push(item);
    }
  }

  for (const item of db || []) {
    if (!item || item.id == null) continue;
    if (seen.has(item.id)) continue;
    if (snapMap.has(item.id) && !memMap.has(item.id)) continue; // local delete
    out.push(item);
    seen.add(item.id);
  }
  return out;
}

/** Union by id for append-only collections; honors deletes on either side. */
function mergeAppendOnly(knownIds, mem, db) {
  const dbIds = new Set();
  for (const item of db || []) if (item && item.id != null) dbIds.add(item.id);
  const out = [];
  const seen = new Set();
  for (const item of mem || []) {
    if (!item || item.id == null) { out.push(item); continue; }
    if (knownIds.has(item.id) && !dbIds.has(item.id)) continue; // pruned/removed remotely
    seen.add(item.id);
    out.push(item);
  }
  for (const item of db || []) {
    if (!item || item.id == null || seen.has(item.id)) continue;
    if (knownIds.has(item.id)) continue; // we removed it locally (prune/truncate)
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function mergeObject(snap, mem, db) {
  const s = snap && typeof snap === 'object' ? snap : {};
  const m = mem && typeof mem === 'object' ? mem : {};
  const d = db && typeof db === 'object' ? db : {};
  const out = { ...d };
  const keys = new Set([...Object.keys(s), ...Object.keys(m), ...Object.keys(d)]);
  for (const k of keys) {
    const inS = Object.prototype.hasOwnProperty.call(s, k);
    const inM = Object.prototype.hasOwnProperty.call(m, k);
    if (inS && !inM) {
      delete out[k];
    } else if (!inS && inM) {
      out[k] = m[k];
    } else if (inM && inS && !eq(m[k], s[k])) {
      out[k] = m[k];
    } else if (Object.prototype.hasOwnProperty.call(d, k)) {
      out[k] = d[k];
    } else {
      delete out[k];
    }
  }
  return out;
}

function parseOr(json, fallback) {
  if (json === undefined) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

/**
 * Three-way merge of the whole state. `known` is what we last read/wrote (the
 * common ancestor), `mem` our in-memory edits, `db` what is in the file now.
 */
function mergeState(known, mem, db) {
  const merged = {};
  const keys = new Set([
    ...Object.keys(sampleShape()),
    ...Object.keys(mem || {}),
    ...Object.keys(db || {}),
    ...known.kv.keys(),
    ...known.docs.keys(),
  ]);
  for (const key of keys) {
    const m = mem ? mem[key] : undefined;
    const d = db ? db[key] : undefined;
    const knownRows = known.docs.get(key);
    if (Array.isArray(m) || Array.isArray(d) || knownRows) {
      let arr;
      if (APPEND_ONLY.has(key)) {
        arr = mergeAppendOnly(new Set(knownRows ? knownRows.keys() : []), m || [], d || []);
      } else {
        const snap = knownRows ? [...knownRows.values()].map((j) => parseOr(j, null)).filter(Boolean) : [];
        arr = mergeArray(snap, m || [], d || []);
      }
      merged[key] = NEWEST_FIRST.has(key) ? sortNewestFirst(arr) : arr;
    } else {
      const s = parseOr(known.kv.get(key), undefined);
      if (isPlainObject(s) || isPlainObject(m) || isPlainObject(d)) {
        merged[key] = mergeObject(s || {}, m || {}, d || {});
      } else {
        const localChanged = m !== undefined && (s === undefined || !eq(m, s));
        merged[key] = localChanged ? m : (d !== undefined ? d : m);
      }
    }
  }
  return merged;
}

function adoptInto(live, merged) {
  for (const key of Object.keys(merged)) {
    if (!Array.isArray(merged[key])) continue;
    if (!Array.isArray(live[key])) live[key] = [];
    const liveMap = byId(live[key]);
    const next = [];
    for (const item of merged[key] || []) {
      if (item && item.id != null && liveMap.has(item.id)) {
        const existing = liveMap.get(item.id);
        if (existing !== item && existing && typeof existing === 'object') {
          for (const k of Object.keys(existing)) {
            if (!Object.prototype.hasOwnProperty.call(item, k)) delete existing[k];
          }
          Object.assign(existing, item);
        }
        next.push(existing);
      } else {
        next.push(item);
      }
    }
    live[key].length = 0;
    for (const item of next) live[key].push(item);
  }
  for (const key of Object.keys(merged)) {
    if (Array.isArray(merged[key])) continue;
    if (isPlainObject(merged[key])) {
      if (!isPlainObject(live[key])) live[key] = {};
      const src = merged[key];
      const dst = live[key];
      for (const k of Object.keys(dst)) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) delete dst[k];
      }
      Object.assign(dst, src);
    } else {
      live[key] = merged[key];
    }
  }
}

function sleep(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function isBusyError(err) {
  return /busy|locked/i.test(String(err && err.message || err));
}

class SqliteStore {
  constructor(file) {
    this.file = helpers().resolveFile(file);
    this.sqliteFile = sqlitePath(this.file);
    this.data = null;
    this.backend = 'sqlite';
    this.db = null;
    this._known = emptyKnown();
    this._dv = null;
    this._stmts = null;
    this.lastWrite = { upserts: 0, deletes: 0, kv: 0, merged: false };
  }

  /** Read the whole database into memory (replaces this.data). */
  load() {
    this._open();
    let data;
    let known;
    let dv;
    this._tx(() => {
      const { DEFAULT_DATA, applyDefaults, pruneMovements } = helpers();
      if (this._isEmpty()) {
        data = this._tryMigrate() || DEFAULT_DATA();
        applyDefaults(data);
        pruneMovements(data);
        known = this._writeDiff(data, emptyKnown());
      } else {
        const r = this._readUnlocked();
        data = r.data;
        known = r.known;
        const before = (data.movements || []).length;
        pruneMovements(data);
        if ((data.movements || []).length !== before) known = this._writeDiff(data, known);
      }
      dv = this._dataVersion();
    });
    this.data = data;
    this._known = known;
    this._dv = dv;
    return this.data;
  }

  /** Persist in-memory changes (only the rows that changed). */
  save() {
    if (!this.data) this.load();
    this._commit(null);
  }

  /**
   * Run `fn(data)` against the freshest state inside the write lock and
   * persist the result atomically. Use it for read-modify-write changes that
   * must not be based on a stale copy (stock deltas, PO status transitions).
   * `fn` must be synchronous; its return value is returned.
   */
  mutate(fn) {
    if (!this.data) this.load();
    return this._commit(fn);
  }

  /**
   * Pull in rows other processes committed since our last read/write, merging
   * them into this.data in place (object identity is kept). Returns true when
   * something was re-read. Costs one PRAGMA when nothing changed.
   */
  refresh() {
    if (!this.data) { this.load(); return true; }
    this._open();
    if (this._dataVersion() === this._dv) return false;
    let merged = null;
    let known;
    let dv;
    this._tx(() => {
      const r = this._readUnlocked();
      merged = mergeState(this._known, this.data, r.data);
      known = r.known;
      dv = this._dataVersion();
    });
    adoptInto(this.data, merged);
    this._known = known;
    this._dv = dv;
    return true;
  }

  reset() {
    this._open();
    const data = helpers().DEFAULT_DATA();
    let known;
    let dv;
    this._tx(() => {
      this._stmt('clearKv').run();
      this._stmt('clearDocs').run();
      known = this._writeDiff(data, emptyKnown());
      dv = this._dataVersion();
    });
    this.data = data;
    this._known = known;
    this._dv = dv;
    return this.data;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch { /* already closed */ }
      this.db = null;
      this._stmts = null;
    }
  }

  list(coll) { return this.data[coll] || []; }
  find(coll, id) { return (this.data[coll] || []).find((x) => x.id === id) || null; }

  insert(coll, doc) {
    if (!doc.id) doc.id = helpers().newId(coll);
    if (!doc.createdAt) doc.createdAt = Date.now();
    if (!Array.isArray(this.data[coll])) this.data[coll] = [];
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

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  _commit(fn) {
    this._open();
    const { pruneMovements } = helpers();
    let out;
    let merged = null;
    let known;
    let dv;
    this._tx(() => {
      let base = this._known;
      let target = this.data;
      dv = this._dataVersion();
      if (dv !== this._dv) {
        // Another connection committed since our last read/write: re-read
        // and three-way merge before applying fn / writing.
        const r = this._readUnlocked();
        merged = mergeState(this._known, this.data, r.data);
        base = r.known;
        target = merged;
      }
      if (fn) out = fn(target);
      pruneMovements(target);
      known = this._writeDiff(target, base);
      this.lastWrite.merged = !!merged;
    });
    if (merged) adoptInto(this.data, merged);
    this._known = known;
    this._dv = dv;
    return out;
  }

  _dataVersion() {
    const row = this._stmt('dataVersion').get();
    return row ? Number(row.data_version) : null;
  }

  _stmt(name) {
    if (!this._stmts) this._stmts = {};
    if (!this._stmts[name]) {
      const sql = {
        dataVersion: 'PRAGMA data_version',
        clearKv: 'DELETE FROM kv',
        clearDocs: 'DELETE FROM docs',
        upsertKv: 'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
        deleteKv: 'DELETE FROM kv WHERE k = ?',
        insertDoc: 'INSERT INTO docs (coll, id, pos, doc) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET doc = excluded.doc',
        updateDoc: 'UPDATE docs SET doc = ? WHERE coll = ? AND id = ?',
        deleteDoc: 'DELETE FROM docs WHERE coll = ? AND id = ?',
        deleteColl: 'DELETE FROM docs WHERE coll = ?',
        readKv: 'SELECT k, v FROM kv',
        readDocs: 'SELECT coll, id, pos, doc FROM docs ORDER BY coll ASC, pos ASC, id ASC',
      }[name];
      this._stmts[name] = this.db.prepare(sql);
    }
    return this._stmts[name];
  }

  _open() {
    if (this.db) return this.db;
    const dir = path.dirname(this.sqliteFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let lastErr;
    for (let attempt = 1; attempt <= TX_RETRIES; attempt++) {
      let db;
      try {
        db = new DatabaseSync(this.sqliteFile, { timeout: BUSY_TIMEOUT_MS });
        // busy_timeout first so a racing creator/writer queues instead of failing.
        db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = FULL');
        db.exec(`
          CREATE TABLE IF NOT EXISTS kv (
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS docs (
            coll TEXT NOT NULL,
            id TEXT NOT NULL,
            pos INTEGER NOT NULL,
            doc TEXT NOT NULL,
            PRIMARY KEY (coll, id)
          );
          CREATE INDEX IF NOT EXISTS docs_coll_pos ON docs (coll, pos);
        `);
        this.db = db;
        this._stmts = null;
        return this.db;
      } catch (err) {
        if (db) {
          try { db.close(); } catch { /* ignore */ }
        }
        lastErr = err;
        if (attempt >= TX_RETRIES || !isBusyError(err)) throw err;
        sleep(25 * attempt);
      }
    }
    throw lastErr;
  }

  _isEmpty() {
    const row = this.db.prepare('SELECT (SELECT COUNT(*) FROM kv) + (SELECT COUNT(*) FROM docs) AS n').get();
    return !row || Number(row.n) === 0;
  }

  _tryMigrate() {
    const candidates = [jsonCompanionPath(this.file), this.file];
    const seen = new Set();
    for (const p of candidates) {
      if (!p || seen.has(p) || p === this.sqliteFile) continue;
      seen.add(p);
      if (!fs.existsSync(p)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        helpers().applyDefaults(data);
        return data;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Full read. Returns { data, known } (known = raw JSON per row + max pos). */
  _readUnlocked() {
    const { DEFAULT_DATA, applyDefaults } = helpers();
    const data = DEFAULT_DATA();
    const known = emptyKnown();
    for (const row of this._stmt('readKv').all()) {
      try { data[row.k] = JSON.parse(row.v); } catch { continue; }
      known.kv.set(row.k, row.v);
    }
    const grouped = Object.create(null);
    for (const row of this._stmt('readDocs').all()) {
      if (!grouped[row.coll]) {
        grouped[row.coll] = [];
        known.docs.set(row.coll, new Map());
      }
      let doc;
      try { doc = JSON.parse(row.doc); } catch { continue; }
      if (doc && typeof doc === 'object' && doc.id == null) doc.id = row.id;
      grouped[row.coll].push(doc);
      known.docs.get(row.coll).set(String(row.id), row.doc);
      const pos = Number(row.pos);
      if (!(known.maxPos.get(row.coll) >= pos)) known.maxPos.set(row.coll, pos);
    }
    for (const [coll, arr] of Object.entries(grouped)) {
      data[coll] = NEWEST_FIRST.has(coll) ? sortNewestFirst(arr) : arr;
    }
    applyDefaults(data);
    return { data, known };
  }

  /**
   * Write `data` given that the database currently holds `base`. Only changed
   * rows are touched. Returns the new known-state.
   */
  _writeDiff(data, base) {
    const next = emptyKnown();
    const stats = { upserts: 0, deletes: 0, kv: 0 };
    const sample = sampleShape();
    const keys = new Set([...Object.keys(sample), ...Object.keys(data || {})]);
    const arrayKeys = new Set();

    for (const key of keys) {
      const value = data[key] !== undefined ? data[key] : sample[key];
      if (Array.isArray(value)) { arrayKeys.add(key); continue; }
      const json = JSON.stringify(value ?? null);
      next.kv.set(key, json);
      if (base.kv.get(key) !== json) {
        this._stmt('upsertKv').run(key, json);
        stats.kv++;
      }
    }
    for (const key of base.kv.keys()) {
      if (!next.kv.has(key) && !arrayKeys.has(key)) { this._stmt('deleteKv').run(key); stats.kv++; }
    }

    for (const coll of arrayKeys) {
      const arr = data[coll] !== undefined ? data[coll] : sample[coll];
      const prev = base.docs.get(coll) || new Map();
      let maxPos = base.maxPos.has(coll) ? base.maxPos.get(coll) : -1;
      if (APPEND_ONLY.has(coll)) {
        // Rows never change after insert: new id → insert, missing id → delete.
        // Copy-on-write so `base` stays intact if the transaction fails.
        let hits = 0;
        const inserts = [];
        const fresh = new Set();
        for (let i = 0; i < arr.length; i++) {
          let doc = arr[i];
          if (!doc || typeof doc !== 'object') { doc = { value: doc }; arr[i] = doc; }
          if (doc.id == null) doc.id = helpers().newId(coll);
          const id = String(doc.id);
          if (prev.has(id)) { hits++; continue; }
          if (fresh.has(id)) continue;
          fresh.add(id);
          inserts.push([id, JSON.stringify(doc)]);
        }
        let rows = prev;
        if (inserts.length || hits !== prev.size) {
          rows = new Map(prev);
          for (const [id, json] of inserts) {
            maxPos += 1;
            this._stmt('insertDoc').run(coll, id, maxPos, json);
            rows.set(id, json);
            stats.upserts++;
          }
          if (hits !== prev.size) {
            const ids = new Set();
            for (const doc of arr) ids.add(String(doc.id));
            for (const id of prev.keys()) {
              if (!ids.has(id)) { this._stmt('deleteDoc').run(coll, id); rows.delete(id); stats.deletes++; }
            }
          }
        }
        next.docs.set(coll, rows);
        next.maxPos.set(coll, maxPos);
        continue;
      }
      const rows = new Map();
      for (let i = 0; i < arr.length; i++) {
        let doc = arr[i];
        if (!doc || typeof doc !== 'object') { doc = { value: doc }; arr[i] = doc; }
        if (doc.id == null) doc.id = helpers().newId(coll);
        const id = String(doc.id);
        if (rows.has(id)) continue; // duplicate id: first one wins, as on read
        const old = prev.get(id);
        const json = JSON.stringify(doc);
        rows.set(id, json);
        if (old === undefined) {
          maxPos += 1;
          this._stmt('insertDoc').run(coll, id, maxPos, json);
          stats.upserts++;
        } else if (old !== json) {
          this._stmt('updateDoc').run(json, coll, id);
          stats.upserts++;
        }
      }
      for (const id of prev.keys()) {
        if (!rows.has(id)) { this._stmt('deleteDoc').run(coll, id); stats.deletes++; }
      }
      next.docs.set(coll, rows);
      next.maxPos.set(coll, maxPos);
    }
    for (const coll of base.docs.keys()) {
      if (!arrayKeys.has(coll)) { this._stmt('deleteColl').run(coll); stats.deletes += base.docs.get(coll).size; }
    }
    this.lastWrite = { ...stats, merged: false };
    return next;
  }

  _tx(fn) {
    const db = this._open();
    // Only acquiring the write lock is retried. Once BEGIN IMMEDIATE succeeds
    // the body runs exactly once — it may apply deltas, so it must not repeat.
    for (let attempt = 1; ; attempt++) {
      try {
        db.exec('BEGIN IMMEDIATE');
        break;
      } catch (err) {
        if (attempt >= TX_RETRIES || !isBusyError(err)) throw err;
        sleep(25 * attempt);
      }
    }
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      // Our view of the file may no longer match it; force a full re-read and
      // merge on the next write instead of trusting the known-state.
      this._dv = null;
      throw err;
    }
  }
}

function isSqliteExperimentalWarning(warning, type) {
  const msg = typeof warning === 'string' ? warning : (warning && warning.message);
  let name = type;
  if (typeof warning !== 'string') name = (warning && warning.name) || name;
  if (name && typeof name === 'object') name = name.type || name.name;
  return String(name) === 'ExperimentalWarning' && /sqlite/i.test(String(msg));
}

function loadDatabaseSync() {
  const orig = process.emitWarning;
  if (!orig.__tanpinSqliteFiltered) {
    process.emitWarning = function (warning, type, ...rest) {
      if (isSqliteExperimentalWarning(warning, type)) return;
      return orig.call(process, warning, type, ...rest);
    };
    process.emitWarning.__tanpinSqliteFiltered = true;
  }
  return require('node:sqlite');
}

module.exports = { SqliteStore, sqlitePath, jsonCompanionPath, APPEND_ONLY, NEWEST_FIRST, mergeState };
