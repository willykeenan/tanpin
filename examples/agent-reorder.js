#!/usr/bin/env node
// The "agent morning routine" as a plain script — exactly what an AI agent
// does through MCP, runnable from cron: look at the store, get the engine's
// reorder recommendations, and place (and email) the orders that clear each
// supplier's minimum. Zero dependencies, Node 18+.

const BASE = (process.env.INVENTORY_URL || 'http://localhost:4173').replace(/\/$/, '');
const KEY = process.env.INVENTORY_API_KEY || '';

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error}`);
  return data;
}

(async () => {
  const { kpis } = await call('GET', '/api/state');
  console.log(`Store: ${kpis.skuCount} SKUs, ${kpis.lowStock} below reorder, ${kpis.openPOs} POs in flight`);

  const { recommendations, notes } = await call('GET', '/api/recommendations');
  notes.forEach((n) => console.log(`note: ${n}`));
  if (!recommendations.length) return console.log('Nothing to order. ✅');

  for (const rec of recommendations) {
    if (rec.heldBelowMinimum) {
      console.log(`HOLD  ${rec.supplierName}: $${rec.total} is under the $${rec.minOrderValue} minimum`);
      continue;
    }
    const po = await call('POST', '/api/purchase-orders', {
      supplierId: rec.supplierId,
      fromRecommendations: true,
      autoSend: true, // marks sent + emails the supplier
    });
    console.log(`ORDER ${po.supplierName}: ${po.lines.length} lines, $${po.total}, ETA ${new Date(po.eta).toLocaleString()}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
