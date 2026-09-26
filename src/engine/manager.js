'use strict';
// Auto-management — the cycle the daemon runs on every tick. This is where the
// system behaves like a tanpin kanri store manager who never sleeps:
//
//   1. Recompute each SKU's forecast, safety stock and reorder point.
//   2. Reclassify A/B/C by revenue contribution.
//   3. Find SKUs at/below their reorder point and group needs by supplier.
//   4. Raise draft purchase orders with computed quantities + ETAs.
//   5. (optional) Email POs to suppliers and digests to the manager.
//   6. (optional) Auto-receive POs whose ETA has passed (lights-out demo mode).
//   7. Flag dead/slow stock to delist — deciding what to STOP stocking.
//
// Every step is logged so the Activity feed can explain what the robot did,
// and every state change emits a webhook so external systems (ERPs, agents,
// Slack bots) can react without polling.

const forecast = require('./forecast');
const reorder = require('./reorder');
const eta = require('./eta');
const { sendEmail } = require('./email');
const webhooks = require('./webhooks');
const { newId } = require('./store');

/** Sale/receipt/adjustment movements grouped by productId (one pass). */
function movementsByProduct(store) {
  const index = new Map();
  for (const m of store.list('movements')) {
    let arr = index.get(m.productId);
    if (!arr) { arr = []; index.set(m.productId, arr); }
    arr.push(m);
  }
  return index;
}

/**
 * Recompute derived planning fields for one product, mutating it in place.
 * `opts.movements` lets a caller that recomputes many products pass a
 * pre-grouped index (see recomputeAll) instead of scanning every movement.
 */
function recomputeProduct(store, product, opts = {}) {
  const s = store.data.settings;
  const movements = opts.movements
    ? (opts.movements.get(product.id) || [])
    : store.list('movements').filter((m) => m.productId === product.id);
  const supplier = store.find('suppliers', product.supplierId) || {};
  const leadTimeDays = product.leadTimeDays ?? supplier.leadTimeDays ?? 1;

  // settings.timezone decides which calendar day a sale belongs to and which
  // weekday a future day is — the same zone the ETA engine and backtest use.
  const f = forecast.forecastProduct(
    { ...product, leadTimeDays },
    movements,
    store.list('hypotheses'),
    { horizonDays: leadTimeDays, settings: s, now: opts.now },
  );

  const safety = reorder.safetyStock(s.serviceLevel, f.dailyStdDev, leadTimeDays);
  // Reorder point = demand forecast over the lead time + safety stock. Using
  // the forecast (not the baseline average) is what lets weekday peaks, trend
  // and manager hypotheses move the trigger, not only the order size.
  const rop = reorder.reorderPointFromForecast(f.horizonForecast, safety);

  const annualDemand = f.avgDailyDemand * 365;
  const holdingCost = (product.unitCost || 0) * (s.holdingCostRate || 0.25);
  const eoqQty = reorder.eoq(annualDemand, s.orderCost, holdingCost);

  product.avgDailyDemand = f.avgDailyDemand;
  product.dailyForecast = f.dailyForecast;
  product.dailyStdDev = f.dailyStdDev;
  product.safetyStock = round(safety);
  product.reorderPoint = round(rop);
  product.eoq = round(eoqQty);
  product.forecast = f;
  product.leadTimeDays = leadTimeDays;
  return product;
}

/** Recompute every product with one pass over the movement log. */
function recomputeAll(store, opts = {}) {
  const movements = movementsByProduct(store);
  const products = store.list('products');
  for (const p of products) recomputeProduct(store, p, { ...opts, movements });
  return products.length;
}

/** Units already inbound for a product across open purchase orders. */
function onOrderQty(store, productId) {
  let qty = 0;
  for (const po of store.list('purchaseOrders')) {
    if (po.status === 'received' || po.status === 'cancelled') continue;
    for (const line of po.lines || []) {
      if (line.productId === productId) qty += line.qty;
    }
  }
  return qty;
}

/** On-hand plus inbound — the number replenishment decisions are made on. */
function stockPosition(store, product) {
  return (product.currentStock || 0) + onOrderQty(store, product.id);
}

/**
 * Dry-run of the ordering logic: what WOULD the daemon order right now,
 * grouped by supplier? Powers GET /api/recommendations (agents love this) and
 * the live cycle below. Assumes recomputeProduct has already run this tick.
 */
function computeRecommendations(store) {
  const s = store.data.settings;
  const needsBySupplier = new Map();
  const notes = [];
  for (const p of store.list('products')) {
    const onOrder = onOrderQty(store, p.id);
    const position = (p.currentStock || 0) + onOrder;
    if (position > (p.reorderPoint || 0)) continue; // still healthy
    const qty = reorder.recommendedOrderQty({
      dailyForecast: p.dailyForecast || p.avgDailyDemand || 0,
      onHand: p.currentStock || 0,
      onOrder,
      targetDaysOfSupply: s.targetDaysOfSupply,
      maxDaysOfSupply: s.maxDaysOfSupply,
      eoqQty: p.eoq || 0,
      packSize: p.packSize || 1,
      minOrderQty: p.minOrderQty || 0,
    });
    if (qty <= 0) continue;
    if (!p.supplierId) {
      notes.push(`${p.sku} below reorder point but has no supplier`);
      continue;
    }
    if (!needsBySupplier.has(p.supplierId)) needsBySupplier.set(p.supplierId, []);
    needsBySupplier.get(p.supplierId).push({
      productId: p.id, sku: p.sku, name: p.name, qty, unitCost: p.unitCost || 0,
    });
  }

  const recommendations = [];
  for (const [supplierId, lines] of needsBySupplier) {
    const supplier = store.find('suppliers', supplierId);
    if (!supplier) continue;
    const total = lines.reduce((t, l) => t + l.qty * l.unitCost, 0);
    recommendations.push({
      supplierId,
      supplierName: supplier.name,
      lines,
      total: round(total),
      minOrderValue: supplier.minOrderValue || 0,
      heldBelowMinimum: !!(supplier.minOrderValue && total < supplier.minOrderValue),
    });
  }
  return { recommendations, notes };
}

/**
 * Run one full auto-management cycle. `opts.trigger` is 'daemon' | 'manual'.
 * Returns a summary object that is also appended to the daemon log.
 */
async function runCycle(store, opts = {}) {
  const now = opts.now || Date.now();
  const s = store.data.settings;
  const summary = {
    at: now,
    trigger: opts.trigger || 'manual',
    recomputed: 0,
    ordersCreated: 0,
    orderLines: 0,
    emailsSent: 0,
    received: 0,
    delistFlags: [],
    notes: [],
  };

  // Snapshot which SKUs were already below reorder, so we only emit
  // `stock.low` on the healthy → low transition (not every tick).
  const products = store.list('products');
  const wasBelow = new Set();
  for (const p of products) {
    if (stockPosition(store, p) <= (p.reorderPoint || 0)) wasBelow.add(p.id);
  }

  // 1 + 2: recompute every SKU, then classify ABC.
  summary.recomputed = recomputeAll(store);
  const abc = reorder.classifyABC(products);
  for (const p of products) {
    const cls = abc.get(p.id);
    if (cls) { p.abcClass = cls.class; p.annualValue = round(cls.annualValue); }
  }
  for (const p of products) {
    if (!wasBelow.has(p.id) && stockPosition(store, p) <= (p.reorderPoint || 0)) {
      webhooks.emit(store, 'stock.low', { product: productSummary(store, p) });
    }
  }

  // 6: auto-receive POs whose ETA has passed (optional).
  if (s.autoReceive) {
    // Iterate a copy: receiving may merge another process's rows into the list.
    for (const po of [...store.list('purchaseOrders')]) {
      if ((po.status === 'sent' || po.status === 'in_transit') && po.eta && po.eta <= now) {
        // receiveOrder re-checks the status inside the write transaction, so a
        // PO the web tier received meanwhile is not received twice.
        if (receiveOrder(store, po, now)) summary.received += 1;
      }
    }
  }

  // 3 + 4: find needs and raise draft POs grouped by supplier.
  if (s.autoManage) {
    const { recommendations, notes } = computeRecommendations(store);
    summary.notes.push(...notes);
    for (const rec of recommendations) {
      const supplier = store.find('suppliers', rec.supplierId);
      if (!supplier) continue;
      if (rec.heldBelowMinimum) {
        summary.notes.push(`Held order for ${supplier.name}: $${rec.total.toFixed(2)} under $${supplier.minOrderValue} minimum`);
        continue;
      }
      const { eta: etaTs, leadTimeDays } = eta.etaForOrder({ orderedAt: now, supplier, settings: s });
      const po = store.insert('purchaseOrders', {
        supplierId: rec.supplierId,
        supplierName: supplier.name,
        status: 'draft',
        lines: rec.lines,
        total: rec.total,
        auto: true,
        orderedAt: now,
        eta: etaTs,
        leadTimeDays,
      });
      summary.ordersCreated += 1;
      summary.orderLines += rec.lines.length;
      webhooks.emit(store, 'po.created', { purchaseOrder: po });

      // 5: email the PO to the supplier (optional auto-send).
      if (s.autoSend && supplier.email) {
        const emailRec = await emailPurchaseOrder(store, po, supplier);
        if (emailRec.ok) summary.emailsSent += 1;
        if (transitionOrder(store, po, ['draft', 'sent'], { status: 'sent', sentAt: now }).ok) {
          webhooks.emit(store, 'po.sent', { purchaseOrder: store.find('purchaseOrders', po.id) });
        }
      }
    }
  }

  // 7: dead / slow stock — what to STOP stocking. Emit only on transition.
  for (const p of products) {
    const rec = reorder.delistRecommendation(p);
    const wasFlagged = !!p.delistFlagged;
    if (rec) {
      summary.delistFlags.push({ productId: p.id, sku: p.sku, name: p.name, ...rec });
      p.delistFlagged = rec.reason;
      if (!wasFlagged) {
        webhooks.emit(store, 'product.delist_flagged', { product: productSummary(store, p), reason: rec });
      }
    } else {
      p.delistFlagged = null;
    }
  }

  // Operational digest email to the manager (optional).
  if (s.autoEmailAlerts && s.notifyEmail && (summary.ordersCreated || summary.delistFlags.length)) {
    const rec = await emailManagerDigest(store, summary);
    if (rec.ok) summary.emailsSent += 1;
  }

  store.save();
  store.data.daemonLog.unshift(summary);
  store.data.daemonLog = store.data.daemonLog.slice(0, 200); // keep last 200 ticks
  store.save();
  webhooks.emit(store, 'cycle.completed', { summary });
  return summary;
}

/**
 * Record sales: decrement on-hand and append `sale` movements. The stock
 * change is applied as a delta inside the store's write transaction against
 * the freshest row (store.mutate), so a concurrent writer in another process
 * (the standalone daemon receiving a PO, a second server) is never overwritten
 * by a stale in-memory absolute value. One transaction and one save for the
 * whole batch; each touched product is recomputed once.
 *
 * items: [{ productId | sku, qty, at?, ref? }]
 * returns per item { ok, product, qty, sku, stockAfter } | { ok: false, error, sku }
 */
function recordSales(store, items, { now = Date.now() } = {}) {
  const products = store.list('products');
  const byId = new Map(products.map((p) => [p.id, p]));
  const bySku = new Map();
  for (const p of products) if (p.sku != null && !bySku.has(p.sku)) bySku.set(p.sku, p);
  const plan = (items || []).map((b) => {
    const ref = (b && (b.productId || b.sku)) || '';
    const prod = byId.get(ref) || bySku.get(ref);
    if (!prod) return { ok: false, error: `No product with id/SKU "${ref}"`, sku: (b && (b.sku || b.productId)) || null };
    const x = { ok: true, prod, qty: Math.max(1, Number(b.qty) || 1), at: toTimestamp(b.at, now), sku: prod.sku };
    if (b.ref !== undefined) x.ref = b.ref;
    return x;
  });
  const valid = plan.filter((x) => x.ok);
  if (!valid.length) return plan.map(publicSaleResult);

  const wasBelow = new Map();
  for (const x of valid) {
    if (!wasBelow.has(x.prod.id)) wasBelow.set(x.prod.id, stockPosition(store, x.prod) <= (x.prod.reorderPoint || 0));
  }
  store.mutate((d) => {
    const rows = new Map(d.products.map((p) => [p.id, p]));
    for (const x of valid) {
      const row = rows.get(x.prod.id);
      if (!row) { x.ok = false; x.error = `Product ${x.sku} no longer exists`; continue; }
      row.currentStock = Math.max(0, (Number(row.currentStock) || 0) - x.qty);
      x.stockAfter = row.currentStock;
      const mv = { id: newId('mv'), productId: row.id, type: 'sale', qty: x.qty, at: x.at };
      if (x.ref !== undefined) mv.ref = x.ref;
      d.movements.push(mv);
    }
  });

  const recorded = valid.filter((x) => x.ok);
  const touched = [...new Set(recorded.map((x) => x.prod))];
  for (const p of touched) recomputeProduct(store, p);
  if (touched.length) store.save();
  for (const x of recorded) {
    webhooks.emit(store, 'sale.recorded', {
      product: { id: x.prod.id, sku: x.prod.sku, name: x.prod.name, currentStock: x.stockAfter }, qty: x.qty,
    });
  }
  for (const p of touched) {
    if (!wasBelow.get(p.id) && stockPosition(store, p) <= (p.reorderPoint || 0)) {
      webhooks.emit(store, 'stock.low', { product: productSummary(store, p) });
    }
  }
  return plan.map(publicSaleResult);
}

/** Unix ms from a number, a numeric string or an ISO date string; else `fallback`. */
function toTimestamp(v, fallback = Date.now()) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function publicSaleResult(x) {
  if (!x.ok) return { ok: false, error: x.error, sku: x.sku == null ? null : x.sku };
  return { ok: true, product: x.prod, qty: x.qty, sku: x.sku, stockAfter: x.stockAfter };
}

/** Manual +/- stock adjustment, applied as a delta in the write transaction. */
function adjustStock(store, product, delta, reason = null, now = Date.now()) {
  const qty = Number(delta) || 0;
  let found = false;
  store.mutate((d) => {
    const row = d.products.find((p) => p.id === product.id);
    if (!row) return;
    found = true;
    row.currentStock = Math.max(0, (Number(row.currentStock) || 0) + qty);
    d.movements.push({ id: newId('mv'), productId: row.id, type: 'adjustment', qty, at: now, reason: reason || null });
  });
  if (!found) return null;
  recomputeProduct(store, product);
  store.save();
  webhooks.emit(store, 'stock.adjusted', { product: productSummary(store, product), delta: qty, reason: reason || null });
  return product;
}

/**
 * Move a PO to a new status only if its CURRENT status (re-read inside the
 * write transaction) is one of `from`. Returns { ok, status } where status is
 * the status found; ok=false means someone else got there first.
 */
function transitionOrder(store, po, from, patch) {
  let result = { ok: false, status: null };
  store.mutate((d) => {
    const row = d.purchaseOrders.find((x) => x.id === po.id);
    if (!row) { result = { ok: false, status: 'missing' }; return; }
    if (!from.includes(row.status)) { result = { ok: false, status: row.status }; return; }
    Object.assign(row, patch, { updatedAt: Date.now() });
    result = { ok: true, status: row.status };
  });
  return result;
}

/**
 * Apply a received PO to stock and write receipt movements — atomically, and
 * only if the PO is still open in the database (not received or cancelled by
 * another process meanwhile). Returns the received PO, or null when it was not
 * open (then `receiveOrder.lastStatus` says what it was).
 */
function receiveOrder(store, po, now = Date.now()) {
  let status = null;
  let done = false;
  store.mutate((d) => {
    const row = d.purchaseOrders.find((x) => x.id === po.id);
    if (!row) { status = 'missing'; return; }
    status = row.status;
    if (row.status === 'received' || row.status === 'cancelled') return;
    const rows = new Map(d.products.map((p) => [p.id, p]));
    for (const line of row.lines || []) {
      const p = rows.get(line.productId);
      if (!p) continue;
      p.currentStock = (Number(p.currentStock) || 0) + (Number(line.qty) || 0);
      d.movements.push({
        id: newId('mv'),
        productId: line.productId, type: 'receipt', qty: line.qty,
        at: now, ref: row.id,
      });
    }
    row.status = 'received';
    row.receivedAt = now;
    done = true;
  });
  receiveOrder.lastStatus = status;
  if (!done) return null;
  const received = store.find('purchaseOrders', po.id) || po;
  webhooks.emit(store, 'po.received', { purchaseOrder: received });
  return received;
}

/** Compact product payload for webhooks — enough to act on, no forecast blob. */
function productSummary(store, p) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category,
    currentStock: p.currentStock || 0,
    onOrder: onOrderQty(store, p.id),
    reorderPoint: p.reorderPoint || 0,
    avgDailyDemand: p.avgDailyDemand || 0,
    supplierId: p.supplierId || null,
  };
}

async function emailPurchaseOrder(store, po, supplier) {
  const s = store.data.settings;
  const lines = po.lines.map((l) => `  ${l.qty} x ${l.name} (${l.sku}) @ ${money(l.unitCost, s)}`).join('\n');
  const text = [
    `Hello ${supplier.name},`,
    ``,
    `Please supply the following against PO ${po.id}:`,
    ``,
    lines,
    ``,
    `Order total: ${money(po.total, s)}`,
    `Requested delivery (our ETA): ${formatStoreTime(po.eta, s)}`,
    ``,
    `Thank you,`,
    `${s.companyName}`,
  ].join('\n');
  const rec = await sendEmail({
    from: s.fromEmail, to: supplier.email,
    subject: `Purchase Order ${po.id} — ${s.companyName}`,
    text, outboxDir: store.outboxDir,
  });
  store.data.outbox.unshift({ ...rec, kind: 'purchase_order', poId: po.id });
  store.save();
  return rec;
}

async function emailManagerDigest(store, summary) {
  const s = store.data.settings;
  const delist = summary.delistFlags.map((d) => `  - ${d.sku} ${d.name}: ${d.detail}`).join('\n') || '  (none)';
  const text = [
    `Auto-management cycle complete.`,
    ``,
    `Draft purchase orders raised: ${summary.ordersCreated} (${summary.orderLines} lines)`,
    `POs auto-emailed to suppliers: ${summary.emailsSent}`,
    `POs auto-received: ${summary.received}`,
    ``,
    `Delist / dead-stock candidates:`,
    delist,
    ``,
    summary.notes.length ? `Notes:\n${summary.notes.map((n) => '  - ' + n).join('\n')}` : '',
  ].join('\n');
  const rec = await sendEmail({
    from: s.fromEmail, to: s.notifyEmail,
    subject: `Inventory digest — ${summary.ordersCreated} orders, ${summary.delistFlags.length} delist flags`,
    text, outboxDir: store.outboxDir,
  });
  store.data.outbox.unshift({ ...rec, kind: 'digest' });
  store.save();
  return rec;
}

/** A timestamp as wall-clock time in the store timezone, with the zone named. */
function formatStoreTime(ts, s) {
  const tz = forecast.resolveTimeZone(s && s.timezone);
  try {
    return new Date(ts).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }) + ` (${tz})`;
  } catch {
    return new Date(ts).toISOString();
  }
}

function money(n, s) {
  const cur = (s && s.currency) || 'USD';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n || 0); }
  catch { return `${(n || 0).toFixed(2)} ${cur}`; }
}

function round(x, dp = 2) {
  const f = 10 ** dp;
  return Math.round((Number(x) || 0) * f) / f;
}

module.exports = {
  recomputeProduct,
  recomputeAll,
  movementsByProduct,
  recordSales,
  adjustStock,
  transitionOrder,
  formatStoreTime,
  toTimestamp,
  onOrderQty,
  stockPosition,
  computeRecommendations,
  runCycle,
  receiveOrder,
  productSummary,
  emailPurchaseOrder,
  emailManagerDigest,
};
