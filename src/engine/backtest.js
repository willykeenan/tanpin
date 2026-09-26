'use strict';
// Rolling-origin forecast evaluation. Tanpin kanri closes the loop: a
// hypothesis is only as good as the sales that followed it. This module walks
// each SKU's history, stands at successive origins, forecasts the next
// `horizon` days from data known at that origin, and scores the result with
// MAPE, sMAPE and bias.
//
// Pure: reads the store, writes nothing.

const forecast = require('./forecast');

function coll(store, name) {
  if (store && typeof store.list === 'function') return store.list(name) || [];
  return (store && store.data && store.data[name]) || [];
}

function settingsOf(store) {
  return (store && store.data && store.data.settings) || {};
}

/** MAPE over pairs with non-zero actual. Returns null when nothing is usable. */
function mape(pairs) {
  const usable = pairs.filter((p) => p.actual !== 0);
  if (!usable.length) return null;
  const s = usable.reduce((acc, p) => acc + Math.abs(p.predicted - p.actual) / Math.abs(p.actual), 0);
  return s / usable.length;
}

/** Symmetric MAPE. Zero/zero pairs count as 0 error. */
function smape(pairs) {
  if (!pairs.length) return null;
  const s = pairs.reduce((acc, p) => {
    const den = Math.abs(p.actual) + Math.abs(p.predicted);
    return acc + (den ? 2 * Math.abs(p.predicted - p.actual) / den : 0);
  }, 0);
  return s / pairs.length;
}

/** Mean (forecast − actual). Positive = over-forecast. */
function bias(pairs) {
  if (!pairs.length) return null;
  return pairs.reduce((acc, p) => acc + (p.predicted - p.actual), 0) / pairs.length;
}

function roundMetric(x) {
  if (x == null || Number.isNaN(x)) return null;
  return Math.round(x * 1e6) / 1e6;
}

const MIN_HISTORY_DAYS = 7;

function backtestSku(product, movements, hypotheses, opts) {
  const { horizon, now, timeZone, window } = opts;
  const lookback = opts.lookback || Math.max(window + horizon + 14, 56);
  // Score only COMPLETED local days: the window ends yesterday, so the last
  // origin's actuals never include today's unfinished sales.
  const yesterday = forecast.addCalendarDays(now, -1, timeZone).ts;
  const days = forecast.calendarWindow(yesterday, lookback, timeZone);
  // Bucket this SKU's sales once; every origin reuses the same day totals.
  const dayTotals = forecast.saleTotalsByDay(movements, timeZone);
  const historyStart = forecast.historyStartOf(product, movements);
  if (historyStart == null) return summarizeSku(product, []);
  const startKey = forecast.calendarDayKey(historyStart, timeZone);
  let firstIdx = days.findIndex((d) => d.key >= startKey);
  if (firstIdx < 0) firstIdx = days.length; // history starts after the window

  const pairs = [];
  // Origin i is a completed local day with at least MIN_HISTORY_DAYS of the
  // SKU's own history behind it (days before its first sale / createdAt are
  // not zero-demand days). Forecast the next `horizon` days, compare to actuals.
  const minHistory = Math.max(1, Number(opts.minHistory) || MIN_HISTORY_DAYS);
  const firstOrigin = Math.max(window - 1, firstIdx + minHistory - 1, 0);
  const lastOrigin = days.length - 1 - horizon;
  for (let i = firstOrigin; i <= lastOrigin; i++) {
    const origin = days[i];
    const originNow = forecast.zonedLocalToUtc(origin.y, origin.m, origin.d, 23, 59, 59, timeZone);
    const actual = days.slice(i + 1, i + 1 + horizon)
      .reduce((s, d) => s + (dayTotals.get(d.key) || 0), 0);
    const f = forecast.forecastProduct(product, movements, hypotheses, {
      now: originNow,
      includeToday: true, // the origin day is complete at 23:59:59
      horizonDays: horizon,
      window,
      timeZone,
      dayTotals,
      historyStart,
    });
    pairs.push({ actual, predicted: f.horizonForecast });
  }
  return summarizeSku(product, pairs);
}

function summarizeSku(product, pairs) {
  return {
    productId: product.id,
    sku: product.sku || product.id,
    n: pairs.length,
    mape: roundMetric(mape(pairs)),
    smape: roundMetric(smape(pairs)),
    bias: roundMetric(bias(pairs)),
  };
}

/**
 * Rolling-origin per-SKU MAPE / sMAPE / bias.
 * @param {object} store  engine store (uses list() + data.settings)
 * @param {{horizon?: number, now?: number, window?: number, timeZone?: string}} [opts]
 */
function backtest(store, opts = {}) {
  const settings = settingsOf(store);
  const timeZone = forecast.resolveTimeZone(opts.timeZone || settings.timezone);
  const horizon = Math.max(1, Number(opts.horizon) || 7);
  const now = opts.now || Date.now();
  const window = Math.max(7, Number(opts.window) || 28);
  const hypotheses = coll(store, 'hypotheses');
  const movements = coll(store, 'movements');
  const products = coll(store, 'products');

  const byProduct = new Map();
  for (const m of movements) {
    let arr = byProduct.get(m.productId);
    if (!arr) { arr = []; byProduct.set(m.productId, arr); }
    arr.push(m);
  }
  const skus = products.map((product) => backtestSku(product, byProduct.get(product.id) || [], hypotheses, {
    horizon, now, timeZone, window, lookback: opts.lookback, minHistory: opts.minHistory,
  }));

  const overallN = skus.reduce((s, r) => s + r.n, 0);
  // Recompute overall from per-SKU sample sizes: weighted mean of metrics
  // that are themselves means. Equivalent to pooling when every origin is
  // scored, and defined even if we only kept per-SKU summaries.
  const weighted = (key) => {
    let num = 0;
    let den = 0;
    for (const r of skus) {
      if (r[key] == null || !r.n) continue;
      num += r[key] * r.n;
      den += r.n;
    }
    return den ? roundMetric(num / den) : null;
  };

  return {
    horizon,
    timeZone,
    window,
    skus,
    overall: {
      n: overallN,
      mape: weighted('mape'),
      smape: weighted('smape'),
      bias: weighted('bias'),
    },
  };
}

/**
 * Same result as backtest(), computed on a worker thread so the HTTP server's
 * event loop stays free while a large catalog is replayed. Falls back to the
 * inline computation if a worker cannot be started.
 */
function backtestInWorker(store, opts = {}) {
  const input = {
    data: {
      products: coll(store, 'products'),
      movements: coll(store, 'movements'),
      hypotheses: coll(store, 'hypotheses'),
      settings: settingsOf(store),
    },
    opts: { ...opts, now: opts.now || Date.now() },
  };
  let Worker;
  try { ({ Worker } = require('node:worker_threads')); } catch { return Promise.resolve(backtest(store, opts)); }
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    try {
      worker = new Worker(__filename, { workerData: input });
    } catch {
      resolve(backtest(store, opts));
      return;
    }
    worker.once('message', (msg) => {
      settled = true;
      if (msg && msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    });
    worker.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    worker.once('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`backtest worker exited with code ${code}`)); }
    });
  });
}

function memStore(data) {
  return { data, list: (name) => data[name] || [] };
}

module.exports = { backtest, backtestInWorker, mape, smape, bias };

// Worker entry point (see backtestInWorker).
{
  let wt = null;
  try { wt = require('node:worker_threads'); } catch { wt = null; }
  if (wt && !wt.isMainThread && wt.workerData && wt.workerData.data && wt.parentPort) {
    try {
      const { data, opts } = wt.workerData;
      wt.parentPort.postMessage({ result: backtest(memStore(data), opts) });
    } catch (e) {
      wt.parentPort.postMessage({ error: String((e && e.message) || e) });
    }
  }
}
