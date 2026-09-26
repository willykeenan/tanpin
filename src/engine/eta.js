'use strict';
// ETA engine — when will a purchase order actually land on the shelf?
//
// Tanpin kanri replenishment runs on fixed delivery windows with order cut-off
// times (convenience-store distribution often delivers several times a day).
// We model each supplier with a lead time plus a set of daily delivery windows
// (hours). A PO placed now arrives at the first delivery window that falls
// at/after (now + lead time).
//
// Window hours and cut-offs are civil times in the store timezone
// (settings.timezone, else the host timezone) via the Intl API.

const { DAY_MS, resolveTimeZone, zonedParts, zonedLocalToUtc, hourAt, addZonedDays } = require('./forecast');

/**
 * Next delivery moment at/after `fromTs` given delivery window hours.
 * windowHours: array of integers 0..23 (e.g. [8, 13, 19] for 3x/day).
 * Hours are interpreted in `timeZone` (store timezone, defaulting to host).
 */
function nextDeliveryWindow(fromTs, windowHours = [9], timeZone) {
  const tz = resolveTimeZone(timeZone);
  const hours = (windowHours && windowHours.length ? windowHours : [9])
    .slice()
    .sort((a, b) => a - b);
  const p = zonedParts(fromTs, tz);
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const cursor = Date.UTC(y, m - 1, d + dayOffset, 12, 0, 0);
    const dt = new Date(cursor);
    const yy = dt.getUTCFullYear();
    const mm = dt.getUTCMonth() + 1;
    const dd = dt.getUTCDate();
    for (const h of hours) {
      const candidate = zonedLocalToUtc(yy, mm, dd, Number(h) || 0, 0, 0, tz);
      if (candidate >= fromTs) return candidate;
    }
  }
  return fromTs + DAY_MS;
}

/**
 * ETA for a purchase order.
 * @returns { eta, leadTimeDays, deliveryWindowHour, timeZone }
 */
function etaForOrder({ orderedAt = Date.now(), supplier = {}, timeZone, settings } = {}) {
  const tz = resolveTimeZone(timeZone || (settings && settings.timezone));
  const leadTimeDays = Number(supplier.leadTimeDays ?? 1);
  const cutoffHour = supplier.cutoffHour;
  let start = orderedAt;

  // If we missed today's local cut-off, the lead-time clock starts tomorrow
  // (next store-local calendar day, not a raw 24-hour add — DST-safe).
  if (typeof cutoffHour === 'number') {
    if (hourAt(orderedAt, tz) >= cutoffHour) {
      start = addZonedDays(orderedAt, 1, tz);
    }
  }
  const earliest = addZonedDays(start, leadTimeDays, tz);
  const eta = nextDeliveryWindow(earliest, supplier.deliveryWindows, tz);
  return {
    eta,
    leadTimeDays,
    deliveryWindowHour: hourAt(eta, tz),
    timeZone: tz,
  };
}

/** Human-friendly relative ETA, e.g. "in 2 days" / "overdue by 3h". */
function describeEta(etaTs, now = Date.now()) {
  const diff = etaTs - now;
  const abs = Math.abs(diff);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / DAY_MS);
  const unit = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${hours}h`;
  return diff >= 0 ? `in ${unit}` : `overdue by ${unit}`;
}

module.exports = { nextDeliveryWindow, etaForOrder, describeEta };
