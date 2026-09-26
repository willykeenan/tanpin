'use strict';
// Store tests — JSON fallback, SQLite default, one-time migration, movement
// retention, and two-process concurrent writers (no lost updates).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  Store, JsonStore, newId, DEFAULT_DATA, sqliteAvailable, pruneMovements,
} = require('../src/engine/store');
const { SqliteStore, sqlitePath } = require('../src/engine/store-sqlite');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-store-'));
}

function tmpFile(dir, name = 'inventory.json') {
  return path.join(dir || tmpDir(), name);
}

function cleanup(store, dir) {
  try { store && store.close(); } catch { /* ignore */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

function waitChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', (c) => { stdout += c; });
    if (child.stderr) child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`child exited ${code || signal}\n${stderr}\n${stdout}`));
    });
  });
}

test('default Store uses sqlite when node:sqlite is available', () => {
  assert.equal(sqliteAvailable, true);
  const dir = tmpDir();
  const store = new Store(tmpFile(dir));
  try {
    assert.equal(store.backend, 'sqlite');
    store.load();
    assert.equal(store.data.settings.currency, 'USD');
    assert.equal(store.data.settings.movementRetentionDays, 365);
    const mode = store.db.prepare('PRAGMA journal_mode').get();
    assert.equal(String(mode.journal_mode).toLowerCase(), 'wal');
  } finally {
    cleanup(store, dir);
  }
});

test('INVENTORY_DB relocates the default data/inventory.json path', () => {
  const dir = tmpDir();
  const relocated = tmpFile(dir);
  const prevInv = process.env.INVENTORY_DB;
  const prevTan = process.env.TANPIN_DB;
  delete process.env.TANPIN_DB;
  process.env.INVENTORY_DB = relocated;
  const store = new Store(path.join('data', 'inventory.json'));
  try {
    assert.equal(store.file, relocated);
    store.load();
    store.insert('products', { sku: 'ISO-1', name: 'Isolated' });
    assert.ok(fs.existsSync(sqlitePath(relocated)));
    assert.equal(store.list('products')[0].sku, 'ISO-1');
  } finally {
    if (prevInv === undefined) delete process.env.INVENTORY_DB;
    else process.env.INVENTORY_DB = prevInv;
    if (prevTan === undefined) delete process.env.TANPIN_DB;
    else process.env.TANPIN_DB = prevTan;
    cleanup(store, dir);
  }
});

test('newId is unique and prefixed', () => {
  const a = newId('products');
  const b = newId('products');
  assert.notEqual(a, b);
  assert.match(a, /^pro_/);
});

test('insert, find, update, remove, reset round-trip', () => {
  const dir = tmpDir();
  const store = new Store(tmpFile(dir));
  try {
    store.load();
    const p = store.insert('products', { sku: 'SKU-1', name: 'Widget' });
    assert.ok(p.id);
    assert.ok(p.createdAt);
    assert.equal(store.find('products', p.id).sku, 'SKU-1');
    assert.equal(store.find('products', p.id), p, 'live object identity is preserved');

    p.currentStock = 9;
    store.save();
    assert.equal(store.find('products', p.id).currentStock, 9);

    const updated = store.update('products', p.id, { name: 'Widget 2' });
    assert.equal(updated.name, 'Widget 2');
    assert.ok(updated.updatedAt);

    assert.equal(store.remove('products', p.id), true);
    assert.equal(store.find('products', p.id), null);
    assert.equal(store.remove('products', p.id), false);

    store.insert('products', { sku: 'GONE', name: 'x' });
    store.reset();
    assert.equal(store.list('products').length, 0);
    assert.equal(store.data.settings.currency, 'USD');
  } finally {
    cleanup(store, dir);
  }
});

test('load picks up writes from another Store on the same file', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const a = new Store(file);
  const b = new Store(file);
  try {
    a.load();
    a.insert('suppliers', { id: 'sup_a', name: 'Alpha' });
    b.load();
    assert.equal(b.find('suppliers', 'sup_a').name, 'Alpha');
    b.insert('suppliers', { id: 'sup_b', name: 'Beta' });
    a.load();
    assert.equal(a.list('suppliers').length, 2);
  } finally {
    a.close();
    cleanup(b, dir);
  }
});

test('one-time migration from an existing JSON data file', () => {
  const dir = tmpDir();
  const jsonFile = tmpFile(dir);
  const payload = DEFAULT_DATA();
  payload.settings.companyName = 'Migrated Co';
  payload.products.push({ id: 'prd_1', sku: 'X', name: 'Widget' });
  payload.movements.push({ id: 'mv_1', type: 'sale', qty: 3, at: Date.now() });
  fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2));

  const store = new Store(jsonFile);
  try {
    store.load();
    assert.equal(store.backend, 'sqlite');
    assert.equal(store.data.settings.companyName, 'Migrated Co');
    assert.equal(store.find('products', 'prd_1').sku, 'X');
    assert.equal(store.list('movements').length, 1);
    assert.ok(fs.existsSync(sqlitePath(jsonFile)));
    assert.ok(fs.existsSync(jsonFile), 'JSON file is left in place');

    store.insert('products', { id: 'prd_2', sku: 'Y', name: 'Y' });
    // A later open must not re-import the JSON (which still has only prd_1).
    const again = new Store(jsonFile);
    try {
      again.load();
      assert.equal(again.list('products').length, 2);
      assert.ok(again.find('products', 'prd_2'));
    } finally {
      again.close();
    }
  } finally {
    cleanup(store, dir);
  }
});

test('movementRetentionDays prunes old movements on save', () => {
  const dir = tmpDir();
  const store = new Store(tmpFile(dir));
  try {
    store.load();
    store.data.settings.movementRetentionDays = 7;
    const now = Date.now();
    store.data.movements.push({ id: 'old', type: 'sale', qty: 1, at: now - 30 * 86400000 });
    store.data.movements.push({ id: 'new', type: 'sale', qty: 2, at: now - 1 * 86400000 });
    store.save();
    store.load();
    assert.equal(store.list('movements').length, 1);
    assert.equal(store.list('movements')[0].id, 'new');

    store.data.settings.movementRetentionDays = 0;
    store.data.movements.push({ id: 'ancient', type: 'sale', qty: 1, at: 1 });
    store.save();
    assert.ok(store.list('movements').some((m) => m.id === 'ancient'));
  } finally {
    cleanup(store, dir);
  }
});

test('pruneMovements helper keeps recent rows and honors 0 = forever', () => {
  const data = DEFAULT_DATA();
  const now = Date.now();
  data.settings.movementRetentionDays = 10;
  data.movements = [
    { id: 'a', at: now - 40 * 86400000 },
    { id: 'b', at: now - 2 * 86400000 },
  ];
  pruneMovements(data);
  assert.deepEqual(data.movements.map((m) => m.id), ['b']);
  data.settings.movementRetentionDays = 0;
  data.movements.push({ id: 'c', at: 1 });
  pruneMovements(data);
  assert.deepEqual(data.movements.map((m) => m.id), ['b', 'c']);
});

test('JsonStore fallback writes JSON and fsyncs via the same public API', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const store = new JsonStore(file);
  try {
    assert.equal(store.backend, 'json');
    store.load();
    store.insert('products', { sku: 'JSON-1', name: 'From JSON' });
    assert.ok(fs.existsSync(file));
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.products[0].sku, 'JSON-1');
    assert.equal(disk.settings.movementRetentionDays, 365);
  } finally {
    cleanup(store, dir);
  }
});

test('TANPIN_STORE=json selects the JSON backend', () => {
  const storeModule = require.resolve('../src/engine/store');
  const r = spawnSync(process.execPath, ['-e', `
    const { Store } = require(${JSON.stringify(storeModule)});
    const s = new Store();
    process.stdout.write(s.backend);
  `], {
    encoding: 'utf8',
    env: { ...process.env, TANPIN_STORE: 'json' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'json');
});

test('JsonStore load persists movement pruning', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const payload = DEFAULT_DATA();
  payload.settings.movementRetentionDays = 7;
  const now = Date.now();
  payload.movements = [
    { id: 'old', type: 'sale', qty: 1, at: now - 30 * 86400000 },
    { id: 'new', type: 'sale', qty: 2, at: now - 1 * 86400000 },
  ];
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  const store = new JsonStore(file);
  try {
    store.load();
    assert.deepEqual(store.list('movements').map((m) => m.id), ['new']);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(disk.movements.map((m) => m.id), ['new']);
  } finally {
    cleanup(store, dir);
  }
});

test('node:sqlite ExperimentalWarning is suppressed on require', () => {
  const storeModule = require.resolve('../src/engine/store');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(storeModule)})`], {
    encoding: 'utf8',
    env: { ...process.env, TANPIN_STORE: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr || '', /SQLite is an experimental feature/);
  assert.doesNotMatch(r.stdout || '', /SQLite is an experimental feature/);
});

test('two processes writing concurrently do not lose updates', async () => {
  const dir = tmpDir();
  const file = tmpFile(dir);

  const storeModule = require.resolve('../src/engine/store');
  const sqliteModule = require.resolve('../src/engine/store-sqlite');
  const n = 30;
  const writer = `
    'use strict';
    const { SqliteStore } = require(${JSON.stringify(sqliteModule)});
    require(${JSON.stringify(storeModule)});
    const file = process.argv[2];
    const tag = process.argv[3];
    const n = Number(process.argv[4]);
    const store = new SqliteStore(file);
    store.load();
    for (let i = 0; i < n; i++) {
      store.insert('products', { sku: tag + '-' + String(i).padStart(4, '0'), name: tag, seq: i });
      store.data.movements.push({
        id: tag + '-m-' + i,
        type: 'sale',
        qty: 1,
        at: Date.now(),
        sku: tag,
      });
      store.save();
    }
    store.close();
  `;
  const script = path.join(dir, 'writer.js');
  fs.writeFileSync(script, writer);

  const spawnWriter = (tag) => spawn(process.execPath, [script, file, tag, String(n)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const a = spawnWriter('A');
  const b = spawnWriter('B');
  await Promise.all([waitChild(a), waitChild(b)]);

  const check = new SqliteStore(file);
  try {
    check.load();
    const products = check.list('products');
    const movements = check.list('movements');
    assert.equal(products.length, n * 2, `expected ${n * 2} products, got ${products.length}`);
    assert.equal(movements.length, n * 2, `expected ${n * 2} movements, got ${movements.length}`);
    const skus = new Set(products.map((p) => p.sku));
    assert.equal(skus.size, n * 2);
    assert.ok(products.some((p) => p.sku.startsWith('A-')));
    assert.ok(products.some((p) => p.sku.startsWith('B-')));
  } finally {
    cleanup(check, dir);
  }
});

test('two processes updating disjoint settings do not lose either write', async () => {
  const dir = tmpDir();
  const file = tmpFile(dir);

  const sqliteModule = require.resolve('../src/engine/store-sqlite');
  const script = path.join(dir, 'settings-writer.js');
  fs.writeFileSync(script, `
    'use strict';
    const { SqliteStore } = require(${JSON.stringify(sqliteModule)});
    const store = new SqliteStore(process.argv[2]);
    store.load();
    const key = process.argv[3];
    const val = process.argv[4];
    store.data.settings[key] = val;
    store.save();
    store.close();
  `);

  const a = spawn(process.execPath, [script, file, 'currency', 'EUR'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const b = spawn(process.execPath, [script, file, 'companyName', 'B Co'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await Promise.all([waitChild(a), waitChild(b)]);

  const check = new SqliteStore(file);
  try {
    check.load();
    assert.equal(check.data.settings.currency, 'EUR');
    assert.equal(check.data.settings.companyName, 'B Co');
  } finally {
    cleanup(check, dir);
  }
});

test('disjoint field updates on the same product are both kept', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const setup = new SqliteStore(file);
  setup.load();
  setup.insert('products', {
    id: 'prd_1', sku: 'X', name: 'Widget', currentStock: 100, avgDailyDemand: 10,
  });
  setup.close();

  function run(firstField, firstVal, secondField, secondVal) {
    const a = new SqliteStore(file);
    const b = new SqliteStore(file);
    a.load();
    b.load();
    a.find('products', 'prd_1')[firstField] = firstVal;
    b.find('products', 'prd_1')[secondField] = secondVal;
    a.save();
    b.save();
    a.close();
    b.close();
    const check = new SqliteStore(file);
    check.load();
    const p = check.find('products', 'prd_1');
    check.close();
    return p;
  }

  try {
    let p = run('currentStock', 42, 'name', 'Renamed');
    assert.equal(p.currentStock, 42);
    assert.equal(p.name, 'Renamed');

    const reset = new SqliteStore(file);
    reset.load();
    Object.assign(reset.find('products', 'prd_1'), { name: 'Widget', currentStock: 100 });
    reset.save();
    reset.close();

    p = run('name', 'Renamed', 'currentStock', 42);
    assert.equal(p.currentStock, 42);
    assert.equal(p.name, 'Renamed');
  } finally {
    cleanup(null, dir);
  }
});

test('untouched save does not resurrect a row deleted by the other connection', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const setup = new SqliteStore(file);
  setup.load();
  setup.insert('products', { id: 'prd_keep', sku: 'K', name: 'Keep' });
  setup.insert('products', { id: 'prd_gone', sku: 'G', name: 'Gone' });
  setup.close();

  const a = new SqliteStore(file);
  const b = new SqliteStore(file);
  try {
    a.load();
    b.load();
    assert.equal(a.remove('products', 'prd_gone'), true);
    b.save();
    const check = new SqliteStore(file);
    try {
      check.load();
      assert.equal(check.find('products', 'prd_gone'), null);
      assert.ok(check.find('products', 'prd_keep'));
    } finally {
      check.close();
    }
  } finally {
    a.close();
    cleanup(b, dir);
  }
});

// ---------------------------------------------------------------------------
// Review regressions: stale in-memory copies across processes, log ordering,
// incremental writes.
// ---------------------------------------------------------------------------
test('mutate applies a stock delta to the freshest row when another connection changed it', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const setup = new SqliteStore(file);
  setup.load();
  setup.insert('products', { id: 'prd_c', sku: 'COFFEE-HOT', name: 'Coffee', currentStock: 99 });
  setup.close();

  const server = new SqliteStore(file); // loaded once, then stale
  const daemon = new SqliteStore(file);
  try {
    server.load();
    daemon.load();
    // The daemon receives 1350 units.
    daemon.mutate((d) => { d.products.find((p) => p.id === 'prd_c').currentStock += 1350; });
    assert.equal(server.find('products', 'prd_c').currentStock, 99, 'server copy is stale');
    // The stale server sells 2: applied to the fresh row, not to its copy.
    const live = server.find('products', 'prd_c');
    server.mutate((d) => { const p = d.products.find((x) => x.id === 'prd_c'); p.currentStock -= 2; });
    assert.equal(live.currentStock, 1447, 'in-memory object is updated in place');
    assert.equal(server.lastWrite.merged, true);
    const check = new SqliteStore(file);
    check.load();
    assert.equal(check.find('products', 'prd_c').currentStock, 1447);
    check.close();
  } finally {
    server.close();
    cleanup(daemon, dir);
  }
});

test('refresh() pulls another process\'s commits in place and is a no-op otherwise', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const a = new SqliteStore(file);
  const b = new SqliteStore(file);
  try {
    a.load();
    a.insert('products', { id: 'p1', sku: 'A', name: 'A', currentStock: 5 });
    b.load();
    const live = a.find('products', 'p1');
    assert.equal(a.refresh(), false, 'nothing changed');
    b.find('products', 'p1').currentStock = 9;
    b.insert('suppliers', { id: 's1', name: 'S' });
    assert.equal(a.refresh(), true);
    assert.equal(live.currentStock, 9, 'same object, fresh value');
    assert.ok(a.find('suppliers', 's1'));
  } finally {
    a.close();
    cleanup(b, dir);
  }
});

test('rows another process adds to newest-first logs sort to the front, not the end', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const a = new SqliteStore(file);
  const b = new SqliteStore(file);
  try {
    a.load();
    for (let i = 0; i < 5; i++) a.data.daemonLog.unshift({ id: `old${i}`, at: 1000 + i });
    a.save();
    b.load();
    b.data.daemonLog.unshift({ id: 'fromB', at: 3000 });
    b.save();
    a.data.daemonLog.unshift({ id: 'fromA', at: 2000 });
    a.save(); // merges B's row
    assert.deepEqual(a.list('daemonLog').slice(0, 3).map((x) => x.id), ['fromB', 'fromA', 'old4']);
    const check = new SqliteStore(file);
    check.load();
    assert.equal(check.list('daemonLog')[0].id, 'fromB');
    assert.equal(check.list('daemonLog').slice(0, 200).length, 7);
    check.close();
  } finally {
    a.close();
    cleanup(b, dir);
  }
});

test('save writes only changed rows instead of rewriting the database', () => {
  const dir = tmpDir();
  const store = new SqliteStore(tmpFile(dir));
  try {
    store.load();
    store.data.products.push({ id: 'p1', sku: 'A', name: 'A', currentStock: 10 });
    const now = Date.now();
    for (let i = 0; i < 5000; i++) store.data.movements.push({ id: `m${i}`, productId: 'p1', type: 'sale', qty: 1, at: now - i * 1000 });
    store.save();
    assert.ok(store.lastWrite.upserts >= 5001);

    store.find('products', 'p1').currentStock = 9;
    store.data.movements.push({ id: 'mNew', productId: 'p1', type: 'sale', qty: 1, at: now });
    store.save();
    assert.deepEqual({ upserts: store.lastWrite.upserts, deletes: store.lastWrite.deletes }, { upserts: 2, deletes: 0 });

    store.save(); // nothing changed
    assert.deepEqual({ upserts: store.lastWrite.upserts, deletes: store.lastWrite.deletes, kv: store.lastWrite.kv }, { upserts: 0, deletes: 0, kv: 0 });

    assert.equal(store.remove('products', 'p1'), true);
    assert.equal(store.lastWrite.deletes, 1);

    const check = new SqliteStore(store.sqliteFile);
    check.load();
    assert.equal(check.list('movements').length, 5001);
    assert.equal(check.list('products').length, 0);
    assert.equal(check.list('movements')[5000].id, 'mNew', 'insertion order is kept');
    check.close();
  } finally {
    cleanup(store, dir);
  }
});

test('JsonStore offers the same mutate/refresh API', () => {
  const dir = tmpDir();
  const file = tmpFile(dir);
  const a = new JsonStore(file);
  const b = new JsonStore(file);
  try {
    a.load();
    a.insert('products', { id: 'p', sku: 'P', name: 'P', currentStock: 3 });
    assert.equal(a.mutate((d) => { d.products[0].currentStock += 2; return 'r'; }), 'r');
    b.load();
    assert.equal(b.find('products', 'p').currentStock, 5);
    assert.equal(b.refresh(), false);
  } finally {
    cleanup(null, dir);
  }
});
