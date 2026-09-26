'use strict';
// Demand forecasting in the tanpin kanri (単品管理) style: forward-looking and
// single-item (per SKU).
//
// The method is not just reacting to history: the person ordering forms a
// *hypothesis* about tomorrow (weather, local events, day of week), orders
// against it, then *verifies* against actual sales. This module produces a
// per-SKU daily-demand forecast that blends:
//
//   1. Daily unit totals over COMPLETED store-local days, including days with
//      zero sales — but only from the SKU's first sale (or createdAt, if
//      earlier) onward. Days before a product existed are not demand of zero,
//      and today's partial day would read as a slump every morning.
//   2. Weighted moving average of those daily totals (recency-biased)
//   3. Day-of-week factor on daily volume (Fri/Sat lunch spikes, etc.)
//   4. Short-term trend (rising/falling momentum)
//   5. Damped promo spikes (one-off peaks do not become "normal")
//   6. Active manager hypotheses (events/weather) (the forward-looking bump)
//
// Calendar days and weekdays are computed in the store timezone
// (settings.timezone, else the host timezone) via the Intl API.
//
// Everything here is pure: it takes sales movements + hypotheses and returns
// numbers. No I/O, so it is trivially testable.

const DAY_MS = 86400000;

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const dtfCache = new Map();

function hostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** IANA timezone from settings or opts; invalid values fall back to the host. */
function resolveTimeZone(timeZone) {
  const host = hostTimeZone();
  const candidate = (timeZone && String(timeZone).trim()) || host;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return host;
  }
}

function getDtf(timeZone) {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

function zonedParts(ts, timeZone) {
  const map = {};
  for (const p of getDtf(timeZone).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  if (map.hour === '24') map.hour = '00';
  return map;
}

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function calendarDayKey(ts, timeZone) {
  const p = zonedParts(ts, timeZone);
  return ymd(Number(p.year), Number(p.month), Number(p.day));
}

function weekdayAt(ts, timeZone) {
  const p = zonedParts(ts, timeZone);
  return WEEKDAY_INDEX[p.weekday] ?? 0;
}

function hourAt(ts, timeZone) {
  return Number(zonedParts(ts, timeZone).hour) % 24;
}

/**
 * UTC millis for a civil wall-clock time in `timeZone`.
 * Iteratively corrects the timezone offset (including DST).
 */
function zonedLocalToUtc(year, month, day, hour, minute, second, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 8; i++) {
    const p = zonedParts(utc, timeZone);
    const got = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second),
    );
    const want = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = want - got;
    if (delta === 0) return utc;
    utc += delta;
  }
  return utc;
}

function addCalendarDays(ts, delta, timeZone) {
  const p = zonedParts(ts, timeZone);
  const cursor = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + delta, 12);
  const dt = new Date(cursor);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const noon = zonedLocalToUtc(y, m, d, 12, 0, 0, timeZone);
  return { y, m, d, weekday: weekdayAt(noon, timeZone), ts: noon, key: ymd(y, m, d) };
}

/**
 * Advance `ts` by `days` store-local calendar days, keeping wall-clock time.
 * Used for lead time and cut-off so DST does not skip a delivery window.
 */
function addZonedDays(ts, days, timeZone) {
  const n = Number(days) || 0;
  if (!n) return ts;
  const p = zonedParts(ts, timeZone);
  const cursor = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + n, 12);
  const dt = new Date(cursor);
  const utc = zonedLocalToUtc(
    dt.getUTCFullYear(),
    dt.getUTCMonth() + 1,
    dt.getUTCDate(),
    Number(p.hour) % 24,
    Number(p.minute) || 0,
    Number(p.second) || 0,
    timeZone,
  );
  return utc + (Number(ts) % 1000);
}

const windowCache = new Map();
const WINDOW_CACHE_MAX = 512;

/**
 * Last `days` store-local calendar days ending on the local date of `now`.
 * Oldest first. Memoized per (zone, end date, length) — callers must treat the
 * returned array as read-only.
 */
function calendarWindow(now, days, timeZone) {
  const p = zonedParts(now, timeZone);
  const cacheKey = `${timeZone}|${p.year}-${p.month}-${p.day}|${days}`;
  const hit = windowCache.get(cacheKey);
  if (hit) return hit;
  const start = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(start - i * DAY_MS);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const noon = zonedLocalToUtc(y, m, d, 12, 0, 0, timeZone);
    out.push({ key: ymd(y, m, d), weekday: weekdayAt(noon, timeZone), y, m, d, noon });
  }
  if (windowCache.size >= WINDOW_CACHE_MAX) windowCache.delete(windowCache.keys().next().value);
  windowCache.set(cacheKey, out);
  return out;
}

function isSale(m) {
  return !m.type || m.type === 'sale';
}

/**
 * Per-day sale unit totals keyed by store-local date ('YYYY-MM-DD'). Build it
 * once per SKU and pass it as `dayTotals` to avoid re-bucketing movements.
 */
function saleTotalsByDay(movements, timeZone, { from = -Infinity, to = Infinity } = {}) {
  const tz = resolveTimeZone(timeZone);
  const totals = new Map();
  for (const m of movements || []) {
    if (!isSale(m)) continue;
    const at = Number(m.at);
    if (!(at >= from && at <= to)) continue;
    const key = calendarDayKey(at, tz);
    totals.set(key, (totals.get(key) || 0) + Math.abs(Number(m.qty) || 0));
  }
  return totals;
}

/** Window days + unit totals, oldest..newest, zeros included. */
function dailySeriesWindow(movements, { days = 28, now = Date.now(), timeZone, dayTotals } = {}) {
  const tz = resolveTimeZone(timeZone);
  const n = Math.max(0, days | 0);
  const window = calendarWindow(now, n, tz);
  if (!n) return { window, values: [] };
  // Only movements that can fall in the window are bucketed (a day is at most
  // ~26h from its local noon), so long histories cost O(window) Intl calls.
  const totals = dayTotals || saleTotalsByDay(movements, tz, {
    from: window[0].noon - 1.5 * DAY_MS,
    to: window[n - 1].noon + 1.5 * DAY_MS,
  });
  return { window, values: window.map((d) => totals.get(d.key) || 0) };
}

/** Bucket sale movements into per-day unit totals, oldest..newest, zeros included. */
function dailySalesSeries(movements, opts = {}) {
  return dailySeriesWindow(movements, opts).values;
}

/** Earliest sale timestamp, or null. */
function firstSaleAt(movements) {
  let first = null;
  for (const m of movements || []) {
    if (!isSale(m)) continue;
    const at = Number(m.at);
    if (Number.isFinite(at) && (first === null || at < first)) first = at;
  }
  return first;
}

/**
 * Start of a SKU's demand history: its first sale or its createdAt, whichever
 * is earlier (imported history can predate createdAt; a product that sat
 * unsold after creation has real zero-demand days). null = no history.
 */
function historyStartOf(product, movements) {
  const first = firstSaleAt(movements);
  const created = Number(product && product.createdAt);
  if (first == null) return Number.isFinite(created) && created > 0 ? created : null;
  return Number.isFinite(created) && created > 0 ? Math.min(first, created) : first;
}

/** Drop the leading days of a window that precede `startKey`. */
function trimBefore(window, values, startKey) {
  if (!startKey) return { window, values };
  let i = 0;
  while (i < window.length && window[i].key < startKey) i++;
  return i ? { window: window.slice(i), values: values.slice(i) } : { window, values };
}

/** Exponentially weighted mean — recent days count more (half-life in days). */
function weightedMovingAverage(series, halfLife = 7) {
  const n = series.length;
  if (!n) return 0;
  let wsum = 0, vsum = 0;
  for (let i = 0; i < n; i++) {
    const ageFromNewest = n - 1 - i;
    const w = Math.pow(0.5, ageFromNewest / halfLife);
    wsum += w;
    vsum += w * series[i];
  }
  return wsum ? vsum / wsum : 0;
}

/** Population standard deviation of a numeric series. */
function stddev(series) {
  const n = series.length;
  if (n < 2) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Pull one-off promo / event peaks toward typical daily volume so they do not
 * rewrite the baseline. Days at or below `spikeMultiple` × median are kept;
 * the excess of a spike is kept at `keep` (default 30%).
 */
function dampPromoSpikes(series, { spikeMultiple = 2, keep = 0.3 } = {}) {
  const n = series.length;
  if (n < 5) return series.slice();
  let typical = median(series);
  if (typical <= 0) {
    const pos = series.filter((v) => v > 0);
    if (!pos.length) return series.slice();
    typical = pos.reduce((a, b) => a + b, 0) / pos.length;
  }
  const threshold = typical * spikeMultiple;
  return series.map((v) => (v > threshold ? typical + keep * (v - typical) : v));
}

/**
 * Day-of-week multipliers (index 0=Sun..6=Sat). Each is that weekday's mean
 * *daily unit volume* (zeros included) divided by the overall daily mean,
 * smoothed toward 1.0 when that weekday has been seen only a few times.
 */
function weekdayFactors(movements, { now = Date.now(), days = 56, timeZone, dayTotals, historyStartKey } = {}) {
  const tz = resolveTimeZone(timeZone);
  const w = dailySeriesWindow(movements, { now, days, timeZone: tz, dayTotals });
  const raw = trimBefore(w.window, w.values, historyStartKey);
  const series = dampPromoSpikes(raw.values);
  const window = raw.window;
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (let i = 0; i < series.length; i++) {
    const dow = window[i].weekday;
    sums[dow] += series[i];
    counts[dow] += 1;
  }
  const overallDays = series.length;
  const overall = overallDays ? series.reduce((a, b) => a + b, 0) / overallDays : 0;
  return sums.map((s, i) => {
    if (!overall || counts[i] === 0) return 1;
    const raw = (s / counts[i]) / overall;
    const confidence = Math.min(1, counts[i] / 4);
    return 1 + (raw - 1) * confidence;
  });
}

/** Trend multiplier: recent half mean vs older half mean, clamped to ±40%. */
function trendFactor(series) {
  const n = series.length;
  if (n < 6) return 1;
  const half = Math.floor(n / 2);
  const older = series.slice(0, half);
  const recent = series.slice(n - half);
  const om = older.reduce((a, b) => a + b, 0) / older.length || 0;
  const rm = recent.reduce((a, b) => a + b, 0) / recent.length || 0;
  if (om <= 0) return rm > 0 ? 1.2 : 1;
  const ratio = rm / om;
  return Math.max(0.6, Math.min(1.4, ratio));
}

/**
 * Combined multiplier from active hypotheses (manager-entered event/weather
 * bumps) that apply to this product on the target date. Multipliers compound.
 */
function hypothesisMultiplier(product, hypotheses, targetTs = Date.now()) {
  let mult = 1;
  for (const h of hypotheses || []) {
    if (h.startsAt && targetTs < h.startsAt) continue;
    if (h.endsAt && targetTs > h.endsAt) continue;
    const scope = h.scope || {};
    if (scope.productId && scope.productId !== product.id) continue;
    if (scope.category && scope.category !== product.category) continue;
    mult *= Number(h.multiplier) || 1;
  }
  return mult;
}

/**
 * Forecast demand for the next `horizonDays`. Returns the engine's full
 * reasoning so the UI can explain *why* (tanpin kanri: "show your work").
 */
/**
 * opts: now, horizonDays, timeZone | settings.timezone, window (28),
 *   weekdayDays (56), halfLife (7),
 *   includeToday — count the local day of `now` as complete (backtest origins
 *     at 23:59:59); by default today's partial day is excluded,
 *   historyStart — override the series start (default: historyStartOf),
 *   dayTotals — precomputed saleTotalsByDay(movements) (speed only).
 */
function forecastProduct(product, movements, hypotheses = [], opts = {}) {
  const now = opts.now || Date.now();
  const horizonDays = opts.horizonDays || product.leadTimeDays || 3;
  const timeZone = resolveTimeZone(opts.timeZone || (opts.settings && opts.settings.timezone));
  const windowDays = opts.window || 28;

  // The series ends on the last COMPLETED local day.
  const seriesEnd = opts.includeToday ? now : addCalendarDays(now, -1, timeZone).ts;
  const start = opts.historyStart !== undefined ? opts.historyStart : historyStartOf(product, movements);
  const startKey = start == null ? '9999-99-99' : calendarDayKey(start, timeZone);
  const dayTotals = opts.dayTotals;

  const w = dailySeriesWindow(movements, { now: seriesEnd, days: windowDays, timeZone, dayTotals });
  const trimmed = trimBefore(w.window, w.values, startKey);
  const seriesRaw = trimmed.values;
  const series = dampPromoSpikes(seriesRaw);
  const base = weightedMovingAverage(series, opts.halfLife || 7);
  const sd = stddev(series);
  const factors = weekdayFactors(movements, {
    now: seriesEnd, timeZone, days: opts.weekdayDays || 56, dayTotals, historyStartKey: startKey,
  });
  const trend = trendFactor(series);

  let horizonSum = 0;
  let wkSum = 0;
  let hypoSum = 0;
  for (let d = 1; d <= horizonDays; d++) {
    const future = addCalendarDays(now, d, timeZone);
    const wk = factors[future.weekday];
    const hypo = hypothesisMultiplier(product, hypotheses, future.ts);
    wkSum += wk;
    hypoSum += hypo;
    horizonSum += Math.max(0, base * wk * trend * hypo);
  }
  const wkAvg = horizonDays ? wkSum / horizonDays : 1;
  const hypoAvg = horizonDays ? hypoSum / horizonDays : 1;
  const dailyForecast = horizonDays ? horizonSum / horizonDays : 0;

  return {
    avgDailyDemand: round(base),
    dailyStdDev: round(sd),
    weekdayFactor: round(wkAvg),
    trendFactor: round(trend),
    hypothesisMultiplier: round(hypoAvg),
    dailyForecast: round(dailyForecast),
    horizonDays,
    horizonForecast: round(horizonSum),
    series: seriesRaw,
    historyDays: seriesRaw.length,
    timeZone,
  };
}

function round(x, dp = 3) {
  const f = 10 ** dp;
  return Math.round((Number(x) || 0) * f) / f;
}

module.exports = {
  DAY_MS,
  hostTimeZone,
  resolveTimeZone,
  zonedParts,
  zonedLocalToUtc,
  calendarDayKey,
  weekdayAt,
  hourAt,
  addCalendarDays,
  addZonedDays,
  calendarWindow,
  saleTotalsByDay,
  dailySeriesWindow,
  dailySalesSeries,
  firstSaleAt,
  historyStartOf,
  weightedMovingAverage,
  stddev,
  median,
  dampPromoSpikes,
  weekdayFactors,
  trendFactor,
  hypothesisMultiplier,
  forecastProduct,
};
