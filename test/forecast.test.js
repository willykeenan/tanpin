'use strict';
// Forecast + backtest: daily unit volume (zeros included), store timezone,
// weekday factor, trend, damped promo spikes. Must be stable under TZ=UTC,
// Asia/Tokyo and America/Los_Angeles — all civil times go through Date.UTC
// or the engine's Intl helpers, never host-local getters.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const forecast = require('../src/engine/forecast');
const { backtest } = require('../src/engine/backtest');

const DAY = 86400000;

function salesEveryDay(now, days, qty) {
  const movements = [];
  for (let d = 1; d <= days; d++) {
    movements.push({ type: 'sale', qty, at: now - d * DAY });
  }
  return movements;
}

function memStore({ products, movements, hypotheses = [], settings = {} }) {
  const data = { products, movements, hypotheses, settings };
  return {
    data,
    list: (name) => data[name] || [],
    find: (name, id) => (data[name] || []).find((x) => x.id === id) || null,
  };
}

test('dailySalesSeries sums units on a calendar day, not ticket count', () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const movements = [
    { type: 'sale', qty: 3, at: now - DAY + 3600000 },
    { type: 'sale', qty: 7, at: now - DAY + 7200000 },
    { type: 'sale', qty: 10, at: now - 2 * DAY },
  ];
  const series = forecast.dailySalesSeries(movements, { now, days: 4, timeZone: 'UTC' });
  assert.equal(series.length, 4);
  // oldest..newest: day-3 empty, day-2 = 10, day-1 = 3+7, today empty
  assert.deepEqual(series, [0, 10, 10, 0]);
});

test('dailySalesSeries keeps zero-sale days in the window', () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const movements = [
    { type: 'sale', qty: 8, at: now - DAY },
    { type: 'sale', qty: 8, at: now - 4 * DAY },
  ];
  const series = forecast.dailySalesSeries(movements, { now, days: 5, timeZone: 'UTC' });
  assert.deepEqual(series, [8, 0, 0, 8, 0]);
  const wma = forecast.weightedMovingAverage(series, 7);
  // Including zeros must pull the average below 8 (the non-zero daily volume).
  assert.ok(wma < 8, `zeros should lower the daily average, got ${wma}`);
  assert.ok(wma > 0);
});

test('weekdayFactors use daily volume including zeros, not transactions', () => {
  const now = Date.UTC(2026, 5, 10, 12); // Wednesday
  const movements = [];
  // 8 weeks: every Saturday sells 20 as a single ticket; every Monday sells
  // 20 as four tickets of 5. Other days are quiet (zero). Ticket-counting
  // would treat Monday as a 5-unit day; daily volume treats both as 20.
  for (let w = 0; w < 8; w++) {
    const saturday = now - ((4 + w * 7) * DAY); // Wed-4 = Sat
    const monday = now - ((2 + w * 7) * DAY);   // Wed-2 = Mon
    movements.push({ type: 'sale', qty: 20, at: saturday });
    for (let t = 0; t < 4; t++) {
      movements.push({ type: 'sale', qty: 5, at: monday + t * 60000 });
    }
  }
  const factors = forecast.weekdayFactors(movements, { now, days: 56, timeZone: 'UTC' });
  assert.equal(factors.length, 7);
  // Saturday (6) and Monday (1) should both sit well above the quiet weekdays.
  assert.ok(factors[6] > 1.3, `Saturday factor should be high, got ${factors[6]}`);
  assert.ok(factors[1] > 1.3, `Monday factor should match Saturday on daily volume, got ${factors[1]}`);
  assert.ok(Math.abs(factors[1] - factors[6]) < 0.15, 'same daily volume → similar weekday factor');
  // A quiet weekday (e.g. Thursday=4) includes zeros, so its factor is below 1.
  assert.ok(factors[4] < 1, `quiet Thursday should be below 1, got ${factors[4]}`);
});

test('a midnight-crossing sale buckets by store timezone, not host TZ', () => {
  const ts = Date.UTC(2026, 0, 15, 2, 0, 0); // 02:00 UTC 15 Jan
  assert.equal(forecast.weekdayAt(ts, 'UTC'), 4); // Thursday
  assert.equal(forecast.weekdayAt(ts, 'America/Los_Angeles'), 3); // Wednesday evening
  assert.equal(forecast.weekdayAt(ts, 'Asia/Tokyo'), 4); // Thursday midday

  const now = Date.UTC(2026, 0, 16, 12);
  const movements = [{ type: 'sale', qty: 9, at: ts }];
  const utc = forecast.dailySalesSeries(movements, { now, days: 4, timeZone: 'UTC' });
  const la = forecast.dailySalesSeries(movements, { now, days: 4, timeZone: 'America/Los_Angeles' });
  // now = 16 Jan noon in both zones. UTC: sale on 15th (yesterday). LA: sale on 14th.
  assert.deepEqual(utc, [0, 0, 9, 0]);
  assert.deepEqual(la, [0, 9, 0, 0]);
});

test('dampPromoSpikes pulls a one-off peak toward typical volume', () => {
  const series = [10, 10, 10, 10, 10, 10, 10, 100];
  const damped = forecast.dampPromoSpikes(series);
  assert.equal(damped[0], 10);
  assert.ok(damped[7] < 50, `spike should be damped, got ${damped[7]}`);
  assert.ok(damped[7] > 10, 'damped spike should keep some of the excess');
});

test('forecastProduct damps a promo spike instead of treating it as the new base', () => {
  const now = Date.UTC(2026, 0, 28, 12);
  const clean = salesEveryDay(now, 28, 10);
  const spiked = salesEveryDay(now, 28, 10);
  spiked[0] = { type: 'sale', qty: 200, at: now - DAY }; // yesterday exploded
  const product = { id: 'p1', leadTimeDays: 3 };
  const base = forecast.forecastProduct(product, clean, [], { now, timeZone: 'UTC' });
  const promo = forecast.forecastProduct(product, spiked, [], { now, timeZone: 'UTC' });
  assert.ok(base.avgDailyDemand > 8 && base.avgDailyDemand < 12);
  // Without damping, a 200-unit yesterday would drag the EWMA far above 10.
  assert.ok(promo.dailyForecast < base.dailyForecast + 15, `promo should be damped, got ${promo.dailyForecast} vs base ${base.dailyForecast}`);
  assert.ok(promo.dailyForecast > base.dailyForecast, 'a real spike should still lift the forecast a little');
});

test('rising series produces a trend factor above 1', () => {
  const now = Date.UTC(2026, 2, 1, 12);
  const movements = [];
  for (let d = 28; d >= 1; d--) {
    const qty = d > 14 ? 5 : 12;
    movements.push({ type: 'sale', qty, at: now - d * DAY });
  }
  const f = forecast.forecastProduct({ id: 'p1', leadTimeDays: 2 }, movements, [], { now, timeZone: 'UTC' });
  assert.ok(f.trendFactor > 1.05, `expected rising trend, got ${f.trendFactor}`);
  assert.ok(f.trendFactor <= 1.4);
});

test('forecastProduct is stable when the host TZ changes (explicit store TZ)', () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const movements = salesEveryDay(now, 28, 10);
  const f = forecast.forecastProduct({ id: 'p1', leadTimeDays: 2 }, movements, [], {
    now, timeZone: 'Asia/Tokyo',
  });
  assert.equal(f.timeZone, 'Asia/Tokyo');
  assert.ok(f.avgDailyDemand > 8 && f.avgDailyDemand < 12);
  assert.ok(f.horizonForecast > 0);
  assert.equal(f.series.length, 28);
});

test('resolveTimeZone defaults to the host and rejects junk', () => {
  const host = forecast.hostTimeZone();
  assert.equal(forecast.resolveTimeZone(), host);
  assert.equal(forecast.resolveTimeZone(''), host);
  assert.equal(forecast.resolveTimeZone('Not/A_Zone'), host);
  assert.equal(forecast.resolveTimeZone('UTC'), 'UTC');
});

test('backtest(store, {horizon}) reports rolling-origin MAPE/sMAPE/bias per SKU', () => {
  const now = Date.UTC(2026, 3, 1, 12);
  const product = { id: 'sku_milk', sku: 'MILK-1', leadTimeDays: 3 };
  const movements = salesEveryDay(now, 56, 10).map((m) => ({ ...m, productId: product.id }));
  const store = memStore({
    products: [product],
    movements,
    settings: { timezone: 'UTC' },
  });
  const result = backtest(store, { horizon: 7, now, window: 28 });
  assert.equal(result.horizon, 7);
  assert.equal(result.timeZone, 'UTC');
  assert.equal(result.skus.length, 1);
  const sku = result.skus[0];
  assert.equal(sku.productId, 'sku_milk');
  assert.ok(sku.n > 5, `expected several origins, got n=${sku.n}`);
  assert.ok(sku.mape != null && sku.mape < 0.25, `steady 10/day should have low MAPE, got ${sku.mape}`);
  assert.ok(sku.smape != null && sku.smape < 0.25, `low sMAPE expected, got ${sku.smape}`);
  assert.ok(Math.abs(sku.bias) < 15, `bias near 0 on a 7-day horizon of ~70 units, got ${sku.bias}`);
  assert.equal(result.overall.n, sku.n);
  assert.ok(result.overall.mape != null);
});

test('backtest includes end-of-day sales after 23:00 local', () => {
  const tz = 'UTC';
  const now = Date.UTC(2026, 3, 1, 12);
  const product = { id: 'late', sku: 'LATE', leadTimeDays: 2 };
  const movements = [];
  for (let d = 1; d <= 50; d++) {
    const day = forecast.addCalendarDays(now, -d, tz);
    const at = forecast.zonedLocalToUtc(day.y, day.m, day.d, 23, 30, 0, tz);
    movements.push({ type: 'sale', qty: 10, at, productId: product.id });
  }
  const store = memStore({
    products: [product],
    movements,
    settings: { timezone: tz },
  });
  const result = backtest(store, { horizon: 3, now, window: 21 });
  const sku = result.skus[0];
  assert.ok(sku.n > 5, `expected several origins, got n=${sku.n}`);
  assert.ok(sku.mape != null && sku.mape < 0.3, `23:30 sales must train the model, mape=${sku.mape}`);
});

test('forecastProduct reads settings.timezone for calendar buckets', () => {
  const ts = Date.UTC(2026, 0, 15, 2, 0, 0); // 18:00 PST on the 14th
  const now = Date.UTC(2026, 0, 16, 12);
  const movements = [{ type: 'sale', qty: 9, at: ts }];
  const f = forecast.forecastProduct({ id: 'p1', leadTimeDays: 1 }, movements, [], {
    now, window: 4, settings: { timezone: 'America/Los_Angeles' },
  });
  assert.equal(f.timeZone, 'America/Los_Angeles');
  // Window = the last 4 COMPLETED LA days (today, the 16th, is excluded),
  // starting at the SKU's first sale: 14th (sale, LA date) and 15th (zero).
  // Bucketing in UTC would put the sale on the 15th instead.
  assert.deepEqual(f.series, [9, 0]);
});

test('backtest reads settings.timezone and scores more than one SKU', () => {
  const now = Date.UTC(2026, 3, 1, 20);
  const a = { id: 'a', sku: 'A', leadTimeDays: 2 };
  const b = { id: 'b', sku: 'B', leadTimeDays: 2 };
  const movements = [
    ...salesEveryDay(now, 50, 6).map((m) => ({ ...m, productId: 'a' })),
    ...salesEveryDay(now, 50, 4).map((m) => ({ ...m, productId: 'b' })),
  ];
  const store = memStore({
    products: [a, b],
    movements,
    settings: { timezone: 'Asia/Tokyo' },
  });
  const result = backtest(store, { horizon: 3, now, window: 21 });
  assert.equal(result.timeZone, 'Asia/Tokyo');
  assert.equal(result.skus.length, 2);
  assert.ok(result.overall.n >= result.skus[0].n);
});

// ---------------------------------------------------------------------------
// Review regressions: pre-history zeros and today's partial day.
// ---------------------------------------------------------------------------
function flatDaily(tz, endTs, days, qty, hour = 12) {
  const out = [];
  for (let d = 1; d <= days; d++) {
    const day = forecast.addCalendarDays(endTs, -d, tz);
    out.push({ type: 'sale', qty, at: forecast.zonedLocalToUtc(day.y, day.m, day.d, hour, 0, 0, tz), productId: 'flat' });
  }
  return out;
}

test('a constant 10/day SKU with only 35 days of history backtests to ~0 error and bias', () => {
  const tz = 'UTC';
  const now = Date.UTC(2026, 3, 1, 12);
  const product = { id: 'flat', sku: 'FLAT', leadTimeDays: 2, createdAt: now - 35 * DAY };
  const store = memStore({ products: [product], movements: flatDaily(tz, now, 35, 10), settings: { timezone: tz } });
  const r = backtest(store, { horizon: 7, now });
  const sku = r.skus[0];
  assert.ok(sku.n > 5, `expected several origins, got ${sku.n}`);
  assert.ok(sku.mape < 0.01, `MAPE should be ~0, got ${sku.mape}`);
  assert.ok(Math.abs(sku.bias) < 0.1, `bias should be ~0, got ${sku.bias}`);
});

test("the backtest's last origin never scores today's unfinished day", () => {
  const tz = 'UTC';
  const now = Date.UTC(2026, 3, 1, 1); // 01:00 — today has barely started
  const movements = flatDaily(tz, now, 60, 10);
  movements.push({ type: 'sale', qty: 1, at: now - 30 * 60000, productId: 'flat' }); // today so far
  const store = memStore({ products: [{ id: 'flat', sku: 'FLAT', leadTimeDays: 2 }], movements, settings: { timezone: tz } });
  const r = backtest(store, { horizon: 3, now, window: 21 });
  assert.ok(r.skus[0].mape < 0.01, `today's 1 unit must not be scored as a 3-day actual, mape=${r.skus[0].mape}`);
  assert.ok(Math.abs(r.skus[0].bias) < 0.1);
});

test('a 20-day-old SKU selling exactly 10/day forecasts 10/day with no trend or noise', () => {
  const tz = 'America/Los_Angeles';
  const now = forecast.zonedLocalToUtc(2026, 5, 10, 15, 0, 0, tz);
  const product = { id: 'flat', leadTimeDays: 3, createdAt: now - 20 * DAY };
  const f = forecast.forecastProduct(product, flatDaily(tz, now, 20, 10), [], { now, timeZone: tz });
  assert.equal(f.avgDailyDemand, 10);
  assert.equal(f.dailyForecast, 10);
  assert.equal(f.trendFactor, 1);
  assert.equal(f.dailyStdDev, 0);
  assert.equal(f.historyDays, 20);
});

test("today's partial day does not drag the forecast down (00:30 local)", () => {
  const tz = 'Asia/Tokyo';
  const now = forecast.zonedLocalToUtc(2026, 5, 10, 0, 30, 0, tz);
  const product = { id: 'flat', leadTimeDays: 2, createdAt: now - 90 * DAY };
  const f = forecast.forecastProduct(product, flatDaily(tz, now, 60, 10, 11), [], { now, timeZone: tz });
  assert.equal(f.avgDailyDemand, 10);
  assert.equal(f.dailyStdDev, 0, 'no phantom variability → no phantom safety stock');
});

test('zero-sale days after a product was created still count as demand zeros', () => {
  const tz = 'UTC';
  const now = Date.UTC(2026, 3, 1, 12);
  // Created 28 days ago, sold 10/day only for the last 14 days.
  const product = { id: 'flat', leadTimeDays: 2, createdAt: now - 28 * DAY };
  const f = forecast.forecastProduct(product, flatDaily(tz, now, 14, 10), [], { now, timeZone: tz });
  assert.equal(f.historyDays, 28);
  assert.ok(f.series.slice(0, 13).every((v) => v === 0));
});
