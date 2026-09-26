// Engine unit tests — run with `npm test` (node --test). No dependencies.
const { test } = require('node:test');
const assert = require('node:assert');

const forecast = require('../src/engine/forecast');
const reorder = require('../src/engine/reorder');
const eta = require('../src/engine/eta');

const DAY = 86400000;

test('weightedMovingAverage biases toward recent values', () => {
  const flat = forecast.weightedMovingAverage([10, 10, 10, 10]);
  assert.ok(Math.abs(flat - 10) < 1e-9);
  const rising = forecast.weightedMovingAverage([0, 0, 0, 100], 1);
  assert.ok(rising > 50, `expected recency bias, got ${rising}`);
});

test('forecastProduct produces a positive forecast from steady sales', () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const movements = [];
  for (let d = 1; d <= 28; d++) movements.push({ type: 'sale', qty: 10, at: now - d * DAY });
  const f = forecast.forecastProduct({ id: 'p1', leadTimeDays: 2 }, movements, [], { now, timeZone: 'UTC' });
  assert.ok(f.avgDailyDemand > 8 && f.avgDailyDemand < 12, `avg ~10, got ${f.avgDailyDemand}`);
  assert.ok(f.horizonForecast > 0);
});

test('hypothesis multiplier lifts the forecast for matching category', () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const movements = [];
  for (let d = 1; d <= 28; d++) movements.push({ type: 'sale', qty: 10, at: now - d * DAY });
  const product = { id: 'p1', category: 'beverage', leadTimeDays: 2 };
  const base = forecast.forecastProduct(product, movements, [], { now, timeZone: 'UTC' });
  const bumped = forecast.forecastProduct(product, movements, [
    { multiplier: 1.5, scope: { category: 'beverage' }, startsAt: now - DAY, endsAt: now + 10 * DAY },
  ], { now, timeZone: 'UTC' });
  assert.ok(bumped.dailyForecast > base.dailyForecast * 1.3, 'hypothesis should raise forecast');
});

test('safety stock and reorder point follow the standard formulas', () => {
  const z = reorder.zForServiceLevel(0.95);
  assert.ok(Math.abs(z - 1.645) < 0.02, `z(95%) ~1.645, got ${z}`);
  const ss = reorder.safetyStock(0.95, 5, 4); // z*sigma*sqrt(L) = 1.645*5*2
  assert.ok(Math.abs(ss - 16.45) < 0.3, `safety ~16.45, got ${ss}`);
  const rop = reorder.reorderPoint(10, 4, ss); // 10*4 + ss
  assert.ok(Math.abs(rop - (40 + ss)) < 1e-6);
});

test('EOQ matches the closed-form optimum', () => {
  // sqrt(2*1000*25 / 2) = sqrt(25000) ~ 158.11
  const q = reorder.eoq(1000, 25, 2);
  assert.ok(Math.abs(q - 158.11) < 0.5, `EOQ ~158.11, got ${q}`);
});

test('recommendedOrderQty respects pack size and stock position', () => {
  const q = reorder.recommendedOrderQty({
    dailyForecast: 10, onHand: 5, onOrder: 0, targetDaysOfSupply: 7, eoqQty: 0, packSize: 12,
  });
  // need = 70 - 5 = 65 → round up to pack of 12 → 72
  assert.strictEqual(q, 72);
  const none = reorder.recommendedOrderQty({ dailyForecast: 10, onHand: 200, onOrder: 0, targetDaysOfSupply: 7 });
  assert.strictEqual(none, 0);
});

test('ABC classification puts the revenue leaders in class A', () => {
  const products = [
    { id: 'big', avgDailyDemand: 100, price: 5 },
    { id: 'mid', avgDailyDemand: 10, price: 2 },
    { id: 'tail', avgDailyDemand: 0.1, price: 1 },
  ];
  const abc = reorder.classifyABC(products);
  assert.strictEqual(abc.get('big').class, 'A');
  assert.strictEqual(abc.get('tail').class, 'C');
});

test('delistRecommendation flags dead stock with no demand', () => {
  const dead = reorder.delistRecommendation({ currentStock: 20, avgDailyDemand: 0 });
  assert.strictEqual(dead.reason, 'dead');
  const healthy = reorder.delistRecommendation({ currentStock: 20, avgDailyDemand: 10 });
  assert.strictEqual(healthy, null);
});

test('ETA lands on the next delivery window after lead time', () => {
  const orderedAt = Date.UTC(2026, 0, 12, 9); // Monday 09:00 UTC
  const supplier = { leadTimeDays: 1, deliveryWindows: [8, 13, 19] };
  const { eta: etaTs } = eta.etaForOrder({ orderedAt, supplier, timeZone: 'UTC' });
  assert.ok(etaTs > orderedAt + DAY - 3600000, 'ETA should be ~a day out, snapped to a window');
  const hour = new Date(etaTs).getUTCHours();
  assert.ok([8, 13, 19].includes(hour), `delivery hour should be a window, got ${hour}`);
});

test('cut-off time pushes the lead-time clock to the next day', () => {
  const supplier = { leadTimeDays: 1, deliveryWindows: [9], cutoffHour: 11 };
  const before = eta.etaForOrder({ orderedAt: Date.UTC(2026, 0, 12, 10), supplier, timeZone: 'UTC' }).eta;
  const after = eta.etaForOrder({ orderedAt: Date.UTC(2026, 0, 12, 12), supplier, timeZone: 'UTC' }).eta;
  assert.ok(after > before, 'ordering after cut-off should arrive later');
});
