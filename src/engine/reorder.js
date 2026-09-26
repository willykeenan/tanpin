'use strict';
// Replenishment math — safety stock, reorder point, EOQ, ABC classification,
// and the recommended order quantity that the daemon turns into purchase orders.
//
// Reorder point  = forecast demand over the lead time + safety stock
//                  (the forecast carries weekday, trend and hypothesis factors;
//                  reorderPoint() is the flat-average special case)
// Safety stock   = z(service level) x demand std dev x sqrt(lead time)
// EOQ            = sqrt( 2 x annual demand x order cost / holding cost )
//
// ABC follows the Pareto principle the way tanpin kanri does: a small set of
// SKUs drives most revenue and gets the tightest control and freshest reorder
// cadence; the long C-tail gets simpler rules and is the first to be delisted.

/**
 * Inverse standard normal CDF (Acklam's algorithm). Lets a company pick *any*
 * service level (e.g. 0.985) instead of being limited to a lookup table.
 */
function zForServiceLevel(p) {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
          ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function safetyStock(serviceLevel, dailyStdDev, leadTimeDays) {
  const z = zForServiceLevel(serviceLevel);
  return Math.max(0, z * dailyStdDev * Math.sqrt(Math.max(leadTimeDays, 0)));
}

function reorderPoint(avgDailyDemand, leadTimeDays, safety) {
  return avgDailyDemand * Math.max(leadTimeDays, 0) + Math.max(safety, 0);
}

/** Reorder point from a lead-time demand forecast (sum over the lead time). */
function reorderPointFromForecast(leadTimeDemand, safety) {
  return Math.max(0, Number(leadTimeDemand) || 0) + Math.max(safety, 0);
}

function eoq(annualDemand, orderCost, holdingCostPerUnit) {
  if (annualDemand <= 0 || holdingCostPerUnit <= 0 || orderCost <= 0) return 0;
  return Math.sqrt((2 * annualDemand * orderCost) / holdingCostPerUnit);
}

/**
 * Recommended order quantity. Target a number of days of supply, never order
 * below EOQ (so we don't thrash suppliers with tiny POs), then round up to the
 * supplier's pack/case size and honor a minimum order quantity.
 */
function recommendedOrderQty({
  dailyForecast,
  onHand,
  onOrder = 0,
  targetDaysOfSupply = 7,
  maxDaysOfSupply = 21,
  eoqQty = 0,
  packSize = 1,
  minOrderQty = 0,
}) {
  const target = dailyForecast * targetDaysOfSupply;
  const position = onHand + onOrder;
  let need = Math.max(0, target - position);
  if (need <= 0) return 0;
  // EOQ and MOQ can raise the order, but JIT discipline (tanpin kanri) means we
  // never let a single order pile up more than `maxDaysOfSupply` of stock — an
  // unbounded EOQ on cheap, high-volume SKUs would otherwise order months of
  // inventory and defeat the whole point of frequent small replenishment.
  need = Math.max(need, eoqQty, minOrderQty);
  if (dailyForecast > 0 && maxDaysOfSupply) {
    const cap = Math.max(0, dailyForecast * maxDaysOfSupply - position);
    if (cap > 0) need = Math.min(need, cap);
  }
  if (packSize > 1) need = Math.ceil(need / packSize) * packSize;
  return Math.ceil(need);
}

/**
 * ABC classification by annual revenue contribution. Returns a Map of
 * productId -> { class, annualValue, cumulativePct }.
 * A: top 80% of value, B: next 15%, C: last 5% (the delisting candidates).
 */
function classifyABC(products, { aCut = 0.8, bCut = 0.95 } = {}) {
  const scored = products.map((p) => ({
    id: p.id,
    annualValue: (p.avgDailyDemand || 0) * 365 * (p.price || p.unitCost || 0),
  }));
  const total = scored.reduce((s, x) => s + x.annualValue, 0) || 1;
  scored.sort((a, b) => b.annualValue - a.annualValue);
  const out = new Map();
  let cum = 0;
  for (const x of scored) {
    // Classify by the cumulative share *before* this item, so the SKU that
    // pushes the running total past 80% is still counted as A (and a single
    // dominant SKU is never misfiled as C).
    const cumPctBefore = cum / total;
    cum += x.annualValue;
    const cls = cumPctBefore < aCut ? 'A' : cumPctBefore < bCut ? 'B' : 'C';
    out.set(x.id, { class: cls, annualValue: x.annualValue, cumulativePct: cum / total });
  }
  return out;
}

/**
 * Detect dead / slow stock: tanpin kanri's "decide what to STOP stocking".
 * A SKU is a delist candidate if it has on-hand units but effectively no
 * recent demand and would take a very long time to sell through.
 */
function delistRecommendation(product, { deadDays = 30, slowDaysOfSupply = 120 } = {}) {
  const daily = product.avgDailyDemand || 0;
  const onHand = product.currentStock || 0;
  if (onHand <= 0) return null;
  if (daily <= 0) {
    return { reason: 'dead', detail: `No sales in trailing window; ${onHand} units tying up cash.` };
  }
  const daysOfSupply = onHand / daily;
  if (daysOfSupply >= slowDaysOfSupply) {
    return { reason: 'slow', detail: `${Math.round(daysOfSupply)} days of supply on hand — overstocked.` };
  }
  return null;
}

module.exports = {
  zForServiceLevel,
  safetyStock,
  reorderPoint,
  reorderPointFromForecast,
  eoq,
  recommendedOrderQty,
  classifyABC,
  delistRecommendation,
};
