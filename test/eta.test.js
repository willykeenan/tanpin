'use strict';
// Delivery ETAs in the store timezone. Civil hours (windows, cut-offs) go
// through Intl, so these tests must pass under TZ=UTC, Asia/Tokyo and
// America/Los_Angeles. Assertions use UTC getters or explicit IANA zones.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const eta = require('../src/engine/eta');
const forecast = require('../src/engine/forecast');

const DAY = 86400000;

test('nextDeliveryWindow snaps to the next civil hour in UTC', () => {
  const from = Date.UTC(2026, 0, 12, 10, 0, 0); // 10:00 UTC, windows 8/13/19
  const ts = eta.nextDeliveryWindow(from, [8, 13, 19], 'UTC');
  assert.equal(new Date(ts).getUTCHours(), 13);
  assert.equal(new Date(ts).getUTCDate(), 12);
});

test('nextDeliveryWindow uses America/Los_Angeles civil hours in January (PST)', () => {
  // 16:00 UTC = 08:00 PST on 13 Jan 2026. Window 8 is already that instant.
  const atEight = Date.UTC(2026, 0, 13, 16, 0, 0);
  const hit = eta.nextDeliveryWindow(atEight, [8, 13, 19], 'America/Los_Angeles');
  assert.equal(hit, atEight);
  assert.equal(forecast.hourAt(hit, 'America/Los_Angeles'), 8);

  const justAfter = atEight + 60 * 1000;
  const next = eta.nextDeliveryWindow(justAfter, [8, 13, 19], 'America/Los_Angeles');
  assert.equal(forecast.hourAt(next, 'America/Los_Angeles'), 13);
  // 13:00 PST = 21:00 UTC
  assert.equal(new Date(next).getUTCHours(), 21);
});

test('nextDeliveryWindow uses Asia/Tokyo civil hours', () => {
  // 01:00 UTC 13 Jan = 10:00 JST. Next window 13:00 JST = 04:00 UTC.
  const from = Date.UTC(2026, 0, 13, 1, 0, 0);
  const ts = eta.nextDeliveryWindow(from, [8, 13, 19], 'Asia/Tokyo');
  assert.equal(forecast.hourAt(ts, 'Asia/Tokyo'), 13);
  assert.equal(new Date(ts).getUTCHours(), 4);
  assert.equal(new Date(ts).getUTCDate(), 13);
});

test('etaForOrder adds lead time then snaps to a window in the store timezone', () => {
  const orderedAt = Date.UTC(2026, 0, 12, 9, 0, 0);
  const supplier = { leadTimeDays: 1, deliveryWindows: [8, 13, 19] };
  const { eta: ts, deliveryWindowHour, timeZone } = eta.etaForOrder({
    orderedAt, supplier, timeZone: 'UTC',
  });
  assert.equal(timeZone, 'UTC');
  assert.ok(ts >= orderedAt + DAY);
  assert.ok([8, 13, 19].includes(deliveryWindowHour));
  assert.equal(new Date(ts).getUTCHours(), deliveryWindowHour);
});

test('cut-off is the store-local hour, not the host hour', () => {
  const supplier = { leadTimeDays: 1, deliveryWindows: [9], cutoffHour: 11 };
  // 10:00 and 12:00 UTC, evaluated in UTC.
  const before = eta.etaForOrder({
    orderedAt: Date.UTC(2026, 0, 12, 10), supplier, timeZone: 'UTC',
  });
  const after = eta.etaForOrder({
    orderedAt: Date.UTC(2026, 0, 12, 12), supplier, timeZone: 'UTC',
  });
  assert.ok(after.eta > before.eta);

  // Same UTC instants in Tokyo (19:00 / 21:00 JST) both miss an 11:00 JST cut-off,
  // so they share a delivery window — unlike the UTC interpretation above.
  const tokyoBefore = eta.etaForOrder({
    orderedAt: Date.UTC(2026, 0, 12, 10), supplier, timeZone: 'Asia/Tokyo',
  });
  const tokyoAfter = eta.etaForOrder({
    orderedAt: Date.UTC(2026, 0, 12, 12), supplier, timeZone: 'Asia/Tokyo',
  });
  assert.equal(tokyoBefore.eta, tokyoAfter.eta);
  assert.equal(forecast.hourAt(tokyoBefore.eta, 'Asia/Tokyo'), 9);
});

test('settings.timezone is honored when timeZone is omitted', () => {
  const orderedAt = Date.UTC(2026, 0, 13, 16, 0, 0); // 08:00 PST
  const supplier = { leadTimeDays: 0, deliveryWindows: [8] };
  const r = eta.etaForOrder({
    orderedAt, supplier, settings: { timezone: 'America/Los_Angeles' },
  });
  assert.equal(r.timeZone, 'America/Los_Angeles');
  assert.equal(r.deliveryWindowHour, 8);
  assert.equal(r.eta, orderedAt);
});

test('describeEta is a relative label from millisecond difference', () => {
  const now = Date.UTC(2026, 0, 12, 12);
  assert.equal(eta.describeEta(now + 2 * DAY, now), 'in 2 days');
  assert.equal(eta.describeEta(now + DAY, now), 'in 1 day');
  assert.equal(eta.describeEta(now + 3 * 3600000, now), 'in 3h');
  assert.equal(eta.describeEta(now - 3 * 3600000, now), 'overdue by 3h');
});

test('default timezone matches the host so host TZ does not crash the engine', () => {
  const host = forecast.hostTimeZone();
  const orderedAt = Date.UTC(2026, 5, 1, 12);
  const r = eta.etaForOrder({
    orderedAt,
    supplier: { leadTimeDays: 1, deliveryWindows: [9] },
  });
  assert.equal(r.timeZone, host);
  assert.equal(r.deliveryWindowHour, 9);
  assert.ok(r.eta > orderedAt);
});

test('lead time is store-local calendar days so DST does not skip a window', () => {
  const tz = 'America/Los_Angeles';
  // Saturday 7 Mar 2026 07:30 PST. Spring-forward is 02:00 Sunday.
  // +24h would land at 08:30 PDT Sunday and miss the 08:00 window.
  const orderedAt = forecast.zonedLocalToUtc(2026, 3, 7, 7, 30, 0, tz);
  const r = eta.etaForOrder({
    orderedAt,
    supplier: { leadTimeDays: 1, deliveryWindows: [8] },
    timeZone: tz,
  });
  assert.equal(forecast.hourAt(r.eta, tz), 8);
  const p = forecast.zonedParts(r.eta, tz);
  assert.equal(p.month, '03');
  assert.equal(p.day, '08');
});
