// MCP server tests — boots the inventory HTTP server, spawns mcp.js as a real
// subprocess, and speaks the Model Context Protocol to it over stdio exactly
// like Claude Code / Claude Desktop would.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanpin-mcp-test-'));
const dbFile = path.join(tmpDir, 'inventory.json');
process.env.TANPIN_DB = dbFile;
process.env.TANPIN_DATA_DIR = tmpDir;
process.env.TANPIN_OUTBOX = path.join(tmpDir, 'outbox');
process.env.TANPIN_NO_DAEMON = '1';
process.env.INVENTORY_DB = dbFile;
delete process.env.REQUIRE_API_KEY;
delete process.env.TANPIN_REQUIRE_API_KEY;
delete process.env.TANPIN_ADMIN_KEY;
delete process.env.INVENTORY_ADMIN_KEY;

const { server } = require('../src/server');

let BASE = '';
let mcp;            // child process
let buffered = '';  // stdout accumulator
const responses = new Map(); // id -> parsed message

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  await fetch(BASE + '/api/seed', { method: 'POST' }); // demo data for tools to chew on

  mcp = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp.js')], {
    env: { ...process.env, INVENTORY_URL: BASE },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  mcp.stdout.on('data', (chunk) => {
    buffered += chunk.toString();
    let nl;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null) responses.set(msg.id, msg);
      } catch { /* ignore non-JSON noise */ }
    }
  });
});
after(() => {
  if (mcp) mcp.kill();
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function send(msg) { mcp.stdin.write(JSON.stringify(msg) + '\n'); }

async function rpc(method, params, id) {
  send({ jsonrpc: '2.0', id, method, params });
  const deadline = Date.now() + 8000;
  while (!responses.has(id) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const msg = responses.get(id);
  assert.ok(msg, `no response to ${method} (id ${id}) within 8s`);
  return msg;
}

function toolResultJson(msg) {
  assert.ok(msg.result, `expected result, got ${JSON.stringify(msg.error)}`);
  assert.notStrictEqual(msg.result.isError, true, `tool errored: ${msg.result.content?.[0]?.text}`);
  return JSON.parse(msg.result.content[0].text);
}

// ---------------------------------------------------------------------------
test('initialize handshake follows MCP semantics', async () => {
  const res = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  }, 1);
  assert.strictEqual(res.result.protocolVersion, '2025-06-18');
  assert.strictEqual(res.result.serverInfo.name, 'tanpin');
  assert.ok(res.result.capabilities.tools);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // must not crash
});

test('tools/list exposes the inventory toolset with schemas', async () => {
  const res = await rpc('tools/list', {}, 2);
  const tools = res.result.tools;
  assert.ok(tools.length >= 15, `expected 15+ tools, got ${tools.length}`);
  const names = tools.map((t) => t.name);
  for (const required of ['get_overview', 'get_reorder_recommendations', 'create_purchase_order', 'record_sale', 'add_demand_hypothesis', 'run_management_cycle']) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  for (const t of tools) {
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.strictEqual(t.inputSchema.type, 'object');
  }
});

test('tools/call get_overview returns KPIs from the live server', async () => {
  const res = await rpc('tools/call', { name: 'get_overview', arguments: {} }, 3);
  const overview = toolResultJson(res);
  assert.ok(overview.kpis.skuCount >= 10, 'seeded store should have 10+ SKUs');
  assert.ok(Array.isArray(overview.openPurchaseOrders));
});

test('tools/call record_sale mutates real stock', async () => {
  const beforeRes = await rpc('tools/call', { name: 'get_product', arguments: { sku: 'CHOCO-BAR' } }, 4);
  const before1 = toolResultJson(beforeRes).currentStock;
  const saleRes = await rpc('tools/call', { name: 'record_sale', arguments: { sku: 'CHOCO-BAR', qty: 3 } }, 5);
  const after1 = toolResultJson(saleRes).currentStock;
  assert.strictEqual(after1, Math.max(0, before1 - 3));
});

test('tools/call with unknown tool and unknown method fail cleanly', async () => {
  const bad = await rpc('tools/call', { name: 'not_a_tool', arguments: {} }, 6);
  assert.ok(bad.error, 'unknown tool should be a JSON-RPC error');
  const nope = await rpc('bogus/method', {}, 7);
  assert.strictEqual(nope.error.code, -32601);
});

test('full agent flow: hypothesis → cycle → recommendations shape', async () => {
  const hyp = await rpc('tools/call', {
    name: 'add_demand_hypothesis',
    arguments: { note: 'test spike', multiplier: 1.5, category: 'snack', days: 3 },
  }, 8);
  assert.strictEqual(toolResultJson(hyp).multiplier, 1.5);

  const cycle = await rpc('tools/call', { name: 'run_management_cycle', arguments: {} }, 9);
  const summary = toolResultJson(cycle);
  assert.ok(summary.recomputed >= 10);

  const recs = await rpc('tools/call', { name: 'get_reorder_recommendations', arguments: {} }, 10);
  const body = toolResultJson(recs);
  assert.ok(Array.isArray(body.recommendations));
});
