// Demo seed — a small convenience-store catalog with suppliers and ~35 days of
// sales history (with day-of-week seasonality baked in) so the forecasting and
// reorder engines have real signal the moment you open the app.

const { newId } = require('./engine/store');

const DAY_MS = 86400000;

const SUPPLIERS = [
  { name: 'FreshFoods Distribution', email: 'orders@freshfoods.example', leadTimeDays: 1, deliveryWindows: [8, 13, 19], cutoffHour: 11, minOrderValue: 50 },
  { name: 'Beverage Wholesale Co', email: 'sales@bevwholesale.example', leadTimeDays: 2, deliveryWindows: [10, 16], cutoffHour: 14, minOrderValue: 100 },
  { name: 'SnackPack Supply', email: 'po@snackpack.example', leadTimeDays: 3, deliveryWindows: [9], minOrderValue: 0 },
];

// baseDemand = avg units/day; weekdayBias scales weekend (Fri-Sun) demand.
const PRODUCTS = [
  { sku: 'ONIGIRI-TUNA', name: 'Tuna Mayo Onigiri', category: 'fresh-food', unitCost: 0.85, price: 1.60, baseDemand: 42, weekendBias: 1.3, supplier: 0, leadTimeDays: 1, packSize: 12 },
  { sku: 'BENTO-CHK', name: 'Chicken Katsu Bento', category: 'fresh-food', unitCost: 2.40, price: 4.99, baseDemand: 18, weekendBias: 1.1, supplier: 0, leadTimeDays: 1, packSize: 6 },
  { sku: 'SANDWICH-EGG', name: 'Egg Salad Sandwich', category: 'fresh-food', unitCost: 1.10, price: 2.49, baseDemand: 25, weekendBias: 0.9, supplier: 0, leadTimeDays: 1, packSize: 8 },
  { sku: 'COFFEE-HOT', name: 'Hot Brewed Coffee Cup', category: 'beverage', unitCost: 0.30, price: 1.20, baseDemand: 60, weekendBias: 0.8, supplier: 1, leadTimeDays: 2, packSize: 50 },
  { sku: 'WATER-500', name: 'Mineral Water 500ml', category: 'beverage', unitCost: 0.25, price: 0.99, baseDemand: 35, weekendBias: 1.2, supplier: 1, leadTimeDays: 2, packSize: 24 },
  { sku: 'COLA-350', name: 'Cola Can 350ml', category: 'beverage', unitCost: 0.40, price: 1.30, baseDemand: 28, weekendBias: 1.4, supplier: 1, leadTimeDays: 2, packSize: 24 },
  { sku: 'CHIPS-SALT', name: 'Salted Potato Chips', category: 'snack', unitCost: 0.55, price: 1.50, baseDemand: 22, weekendBias: 1.5, supplier: 2, leadTimeDays: 3, packSize: 12 },
  { sku: 'CHOCO-BAR', name: 'Milk Chocolate Bar', category: 'snack', unitCost: 0.45, price: 1.20, baseDemand: 30, weekendBias: 1.3, supplier: 2, leadTimeDays: 3, packSize: 24 },
  { sku: 'GUM-MINT', name: 'Mint Chewing Gum', category: 'snack', unitCost: 0.35, price: 1.00, baseDemand: 8, weekendBias: 1.0, supplier: 2, leadTimeDays: 3, packSize: 20 },
  { sku: 'UMBRELLA', name: 'Folding Umbrella', category: 'general', unitCost: 3.50, price: 8.99, baseDemand: 0.4, weekendBias: 1.0, supplier: 2, leadTimeDays: 3, packSize: 6 },
];

function seed(store) {
  store.reset();
  store.data.settings.companyName = 'Demo Convenience Store';
  store.data.settings.notifyEmail = 'manager@demostore.example';
  store.data.settings.fromEmail = 'inventory@demostore.example';

  const supplierIds = SUPPLIERS.map((s) => store.insert('suppliers', { ...s }).id);

  const now = Date.now();
  for (const pdef of PRODUCTS) {
    const product = store.insert('products', {
      sku: pdef.sku, name: pdef.name, category: pdef.category,
      supplierId: supplierIds[pdef.supplier],
      unitCost: pdef.unitCost, price: pdef.price,
      leadTimeDays: pdef.leadTimeDays, packSize: pdef.packSize, minOrderQty: 0,
      currentStock: 0,
    });

    // Generate ~35 days of sales with weekday seasonality + noise.
    for (let d = 35; d >= 1; d--) {
      const ts = now - d * DAY_MS + 12 * 3600000; // midday
      const dow = new Date(ts).getDay();
      const weekend = dow === 0 || dow === 5 || dow === 6;
      const bias = weekend ? pdef.weekendBias : 1;
      const noise = 0.8 + pseudoRandom(pdef.sku + d) * 0.4; // 0.8..1.2
      let qty = Math.round(pdef.baseDemand * bias * noise);
      if (pdef.baseDemand < 1) qty = pseudoRandom(pdef.sku + d) < pdef.baseDemand ? 1 : 0;
      if (qty <= 0) continue;
      store.data.movements.push({ id: newId('mv'), productId: product.id, type: 'sale', qty, at: ts });
    }

    // Seed current stock to a few days of supply so some items need reordering.
    const startStock = Math.round(pdef.baseDemand * (1 + pseudoRandom(pdef.sku) * 3));
    product.currentStock = startStock;
  }

  // A forward-looking hypothesis: heatwave next week → cold drinks +40%.
  store.insert('hypotheses', {
    note: 'Heatwave forecast next week — cold beverages spike',
    multiplier: 1.4,
    scope: { productId: null, category: 'beverage' },
    startsAt: now, endsAt: now + 7 * DAY_MS,
  });

  store.save();
  return store.data;
}

// Deterministic pseudo-random in [0,1) from a string seed (so seeds are stable).
function pseudoRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** `tanpin seed`: replace the configured data file with the demo store. */
function main({ env = process.env, log = console.log } = {}) {
  const { resolveConfig } = require('./config');
  const { Store } = require('./engine/store');
  const manager = require('./engine/manager');
  const config = resolveConfig(env);
  const store = new Store(config.dbFile);
  store.load();
  seed(store);
  manager.recomputeAll(store);
  store.save();
  log(`Seeded demo store: ${store.list('products').length} products, ${store.list('movements').length} sales → ${store.sqliteFile || store.file}`);
  store.close();
  return store;
}

if (require.main === module) main();

module.exports = { seed, main };
