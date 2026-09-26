#!/usr/bin/env node
// MCP server for Tanpin — exposes the inventory system as native tools for
// any Model Context Protocol client (Claude Code, Claude Desktop, Cursor, ...).
// Zero dependencies: newline-delimited JSON-RPC 2.0 over stdio, talking HTTP
// to a running Tanpin server.
//
//   claude mcp add tanpin -- node /path/to/tanpin/src/mcp.js
//
// Env:
//   INVENTORY_URL      base URL of the running server (default http://localhost:4173)
//   INVENTORY_API_KEY  API key if the server is remote or REQUIRE_API_KEY=1

const readline = require('readline');
const pkg = require('../package.json');

const BASE = (process.env.INVENTORY_URL || 'http://localhost:4173').replace(/\/$/, '');
const API_KEY = process.env.INVENTORY_API_KEY || '';
const PROTOCOL_FALLBACK = '2025-06-18';

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------
async function call(method, path, bodyObj) {
  const headers = { 'content-type': 'application/json' };
  if (API_KEY) headers['authorization'] = `Bearer ${API_KEY}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    const e = new Error(`${msg}${data?.code ? ` (${data.code})` : ''}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

function slimProduct(p) {
  return {
    sku: p.sku, name: p.name, category: p.category,
    currentStock: p.currentStock, onOrder: p.onOrder, belowReorder: p.belowReorder,
    dailyForecast: p.dailyForecast, reorderPoint: p.reorderPoint,
    daysOfSupply: p.daysOfSupply, abcClass: p.abcClass,
    price: p.price, unitCost: p.unitCost, delistFlagged: p.delistFlagged || null,
  };
}
function slimPO(po) {
  return {
    id: po.id, supplierName: po.supplierName, status: po.status,
    lines: (po.lines || []).map((l) => ({ sku: l.sku, qty: l.qty, unitCost: l.unitCost })),
    total: po.total, eta: po.eta ? new Date(po.eta).toISOString() : null, etaLabel: po.etaLabel || null,
  };
}

const TOOLS = [
  {
    name: 'get_overview',
    description: 'Snapshot of the whole inventory: KPIs, items at/below reorder point, dead stock, open purchase orders with ETAs, and the last auto-management cycle. Start here.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const s = await call('GET', '/api/state');
      return {
        kpis: s.kpis,
        lowStock: s.products.filter((p) => p.belowReorder).map(slimProduct),
        deadStock: s.products.filter((p) => p.delistFlagged).map((p) => ({ sku: p.sku, name: p.name, reason: p.delistFlagged, currentStock: p.currentStock })),
        openPurchaseOrders: s.purchaseOrders.map(slimPO),
        lastCycle: s.daemonLog[0] || null,
        settings: { autoManage: s.settings.autoManage, autoSend: s.settings.autoSend, serviceLevel: s.settings.serviceLevel, targetDaysOfSupply: s.settings.targetDaysOfSupply },
      };
    },
  },
  {
    name: 'list_products',
    description: 'List products with live forecast and reorder math. Filter with low_stock or category.',
    inputSchema: { type: 'object', properties: { low_stock: bool('Only items at/below their reorder point'), category: str('Filter by category') } },
    run: async (a) => {
      const q = new URLSearchParams();
      if (a.low_stock) q.set('low_stock', 'true');
      if (a.category) q.set('category', a.category);
      const rows = await call('GET', `/api/products${q.toString() ? '?' + q : ''}`);
      return rows.map(slimProduct);
    },
  },
  {
    name: 'get_product',
    description: 'Full detail for one product by SKU (or internal id): forecast breakdown, safety stock, reorder point, EOQ, days of supply.',
    inputSchema: { type: 'object', required: ['sku'], properties: { sku: str('SKU or product id') } },
    run: (a) => call('GET', `/api/products/${encodeURIComponent(a.sku)}`),
  },
  {
    name: 'create_product',
    description: 'Add a product to the catalog. supplier_name is matched or created automatically.',
    inputSchema: {
      type: 'object', required: ['sku', 'name'],
      properties: {
        sku: str('Unique SKU'), name: str('Display name'), category: str('Category, e.g. beverage'),
        supplier_name: str('Supplier name (created if new)'), unit_cost: num('Cost per unit'),
        price: num('Sell price per unit'), current_stock: num('Opening stock'),
        lead_time_days: num('Supplier lead time'), pack_size: num('Case/pack rounding'), min_order_qty: num('Minimum order quantity'),
      },
    },
    run: async (a) => {
      const r = await call('POST', '/api/products/bulk', [{
        sku: a.sku, name: a.name, category: a.category, supplierName: a.supplier_name,
        unitCost: a.unit_cost, price: a.price, currentStock: a.current_stock,
        leadTimeDays: a.lead_time_days, packSize: a.pack_size, minOrderQty: a.min_order_qty,
      }]);
      if (r.skipped) throw new Error(`Import skipped: ${r.errors.join('; ')}`);
      return call('GET', `/api/products/${encodeURIComponent(a.sku)}`);
    },
  },
  {
    name: 'record_sale',
    description: 'Record a sale — decrements stock, re-forecasts the item, and fires stock.low webhooks if it crosses its reorder point.',
    inputSchema: { type: 'object', required: ['sku'], properties: { sku: str('SKU or product id'), qty: num('Units sold (default 1)') } },
    run: async (a) => {
      const r = await call('POST', '/api/sales', { sku: a.sku, qty: a.qty || 1 });
      return slimProduct({ ...r.product, onOrder: r.product.onOrder ?? null });
    },
  },
  {
    name: 'adjust_stock',
    description: 'Manual stock adjustment (stocktake, shrinkage, damage). delta may be negative.',
    inputSchema: { type: 'object', required: ['sku', 'delta'], properties: { sku: str('SKU or product id'), delta: num('Units to add (negative to remove)'), reason: str('Why') } },
    run: async (a) => {
      const r = await call('POST', '/api/adjust', { sku: a.sku, delta: a.delta, reason: a.reason });
      return { sku: r.product.sku, currentStock: r.product.currentStock };
    },
  },
  {
    name: 'get_reorder_recommendations',
    description: 'What should be ordered RIGHT NOW — a dry run of the auto-ordering engine, grouped by supplier with quantities, costs, and minimum-order holds. Use before create_purchase_order.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('GET', '/api/recommendations'),
  },
  {
    name: 'create_purchase_order',
    description: 'Create a purchase order. Either pass explicit lines (by SKU), or set from_recommendations=true to order exactly what the engine recommends for that supplier. Returns the PO with its delivery ETA.',
    inputSchema: {
      type: 'object', required: ['supplier'],
      properties: {
        supplier: str('Supplier id or exact name'),
        lines: { type: 'array', description: 'Explicit lines [{sku, qty}]', items: { type: 'object', required: ['sku', 'qty'], properties: { sku: str('SKU'), qty: num('Units') } } },
        from_recommendations: bool('Build lines from the reorder recommendations'),
        auto_send: bool('Immediately mark sent and email the supplier'),
      },
    },
    run: async (a) => slimPO(await call('POST', '/api/purchase-orders', {
      supplierId: a.supplier, lines: a.lines, fromRecommendations: a.from_recommendations, autoSend: a.auto_send,
    })),
  },
  {
    name: 'list_purchase_orders',
    description: 'List purchase orders with statuses and delivery ETAs. status=open shows only in-flight orders.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'draft', 'sent', 'received', 'cancelled'], description: 'Filter' } } },
    run: async (a) => (await call('GET', `/api/purchase-orders${a.status ? `?status=${a.status}` : ''}`)).map(slimPO),
  },
  {
    name: 'send_purchase_order',
    description: 'Send a draft PO — marks it sent and emails it to the supplier (SMTP if configured, local outbox otherwise).',
    inputSchema: { type: 'object', required: ['po_id'], properties: { po_id: str('Purchase order id') } },
    run: async (a) => slimPO((await call('POST', `/api/purchase-orders/${encodeURIComponent(a.po_id)}/send`)).po),
  },
  {
    name: 'receive_purchase_order',
    description: 'Receive a PO into stock (the delivery arrived). Writes receipt movements and updates stock levels.',
    inputSchema: { type: 'object', required: ['po_id'], properties: { po_id: str('Purchase order id') } },
    run: async (a) => slimPO((await call('POST', `/api/purchase-orders/${encodeURIComponent(a.po_id)}/receive`)).po),
  },
  {
    name: 'list_suppliers',
    description: 'List suppliers with lead times, delivery windows, order cut-off hours, and minimum order values.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('GET', '/api/suppliers'),
  },
  {
    name: 'create_supplier',
    description: 'Add a supplier. delivery_windows are the hours (0-23) deliveries arrive, e.g. "8,13,19" = three deliveries a day.',
    inputSchema: {
      type: 'object', required: ['name'],
      properties: {
        name: str('Supplier name'), email: str('Order email address'),
        lead_time_days: num('Days from order to delivery'), delivery_windows: str('Comma-separated delivery hours, e.g. "8,13,19"'),
        cutoff_hour: num('Order cut-off hour — later orders start lead time tomorrow'), min_order_value: num('Minimum order value'),
      },
    },
    run: (a) => call('POST', '/api/suppliers', {
      name: a.name, email: a.email, leadTimeDays: a.lead_time_days,
      deliveryWindows: a.delivery_windows, cutoffHour: a.cutoff_hour, minOrderValue: a.min_order_value,
    }),
  },
  {
    name: 'add_demand_hypothesis',
    description: 'The forward-looking Tanpin Kanri move: tell the system about an upcoming event or weather change ("heatwave next week") and forecasts + automatic orders adjust immediately. multiplier 1.4 = +40% demand.',
    inputSchema: {
      type: 'object', required: ['note', 'multiplier'],
      properties: {
        note: str('What is happening, e.g. "Local festival this weekend"'),
        multiplier: num('Demand multiplier, e.g. 1.4 for +40%, 0.7 for -30%'),
        category: str('Apply to a whole category, e.g. beverage'),
        sku: str('Or apply to one product'),
        days: num('How many days it lasts (default 7)'),
      },
    },
    run: (a) => call('POST', '/api/hypotheses', {
      note: a.note, multiplier: a.multiplier, category: a.category || null, sku: a.sku || null,
      endsAt: Date.now() + (a.days || 7) * 86400000,
    }),
  },
  {
    name: 'run_management_cycle',
    description: 'Run one full auto-management cycle now: re-forecast every SKU, reclassify ABC, raise draft POs for anything below its reorder point, email them if auto-send is on, flag dead stock. Returns the cycle summary.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('POST', '/api/daemon/run'),
  },
  {
    name: 'get_movements',
    description: 'Stock movement audit trail (sales, receipts, adjustments), newest first.',
    inputSchema: { type: 'object', properties: { sku: str('Filter to one product (SKU or id)'), limit: num('Max rows (default 50)') } },
    run: async (a) => {
      const q = new URLSearchParams();
      if (a.sku) q.set('product', a.sku);
      q.set('limit', String(a.limit || 50));
      return call('GET', `/api/movements?${q}`);
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (newline-delimited)
// ---------------------------------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_FALLBACK,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tanpin', version: pkg.version },
          instructions: [
            'Tanpin — self-hosted item-by-item inventory with forecasting, automatic reordering, supplier emailing, and delivery ETAs, built on the tanpin kanri (単品管理) method popularized by Japanese convenience retail.',
            'Products are addressed by SKU. Call get_overview first to see the state of the store.',
            'Typical flows: get_overview → get_reorder_recommendations → create_purchase_order(from_recommendations=true).',
            'Expecting a demand spike? add_demand_hypothesis and the ordering math adjusts automatically.',
          ].join(' '),
        },
      });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return; // notification, no reply
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      return send({
        jsonrpc: '2.0', id,
        result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      });
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) {
        return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      }
      try {
        const result = await tool.run(params?.arguments || {});
        return send({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        });
      } catch (e) {
        return send({
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: `Error: ${(e && e.message) || e}${e && e.status ? '' : `\nIs the inventory server running at ${BASE}? Start it with: node bin/tanpin serve`}` }],
            isError: true,
          },
        });
      }
    }
    if (isRequest) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String((e && e.message) || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));
