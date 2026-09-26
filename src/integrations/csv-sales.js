'use strict';
// CSV sales import — same decrement path as the webhooks. Header row required.
// Columns: sku (required), qty|quantity (default 1), at|date|timestamp (optional),
// id|event_id|ref (optional; used as the idempotency key when present).
//
// Dates: a value with an explicit offset or Z (2026-01-15T09:00:00Z,
// ...+09:00) is an exact instant. A date-only value (2026-01-15) or a local
// date-time without an offset (2026-01-15 14:30) is wall-clock time in the
// STORE timezone (settings.timezone), not UTC and not the host zone — so an
// end-of-day export lands on the day it names. Date-only rows are placed at
// 12:00 store time. Numbers are epoch milliseconds.

const { parseCsv } = require('../engine/csv');
const { resolveTimeZone, zonedLocalToUtc } = require('../engine/forecast');

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

function first(row, names) {
  for (const n of names) {
    if (row[n] != null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

function parseAt(v, timeZone) {
  if (v == null || v === '') return Date.now();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const local = s.match(LOCAL_DATE);
  if (local) {
    const [, y, mo, d, h, mi, sec] = local;
    const dateOnly = h === undefined;
    const month = Number(mo);
    const day = Number(d);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return zonedLocalToUtc(
        Number(y), month, day,
        dateOnly ? 12 : Number(h), dateOnly ? 0 : Number(mi), dateOnly ? 0 : Number(sec || 0),
        resolveTimeZone(timeZone),
      );
    }
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : Date.now();
}

function parseSalesCsv(text, { timeZone } = {}) {
  const rows = parseCsv(String(text || '').replace(/^\uFEFF/, ''));
  const sales = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sku = String(first(row, ['sku', 'SKU', 'Sku', 'product_sku', 'productSku'])).trim();
    const qtyRaw = first(row, ['qty', 'quantity', 'Qty', 'Quantity', 'qty_sold']);
    const qty = qtyRaw === '' ? 1 : Number(qtyRaw);
    const at = parseAt(first(row, ['at', 'date', 'timestamp', 'sold_at', 'soldAt']), timeZone);
    const id = String(first(row, ['id', 'event_id', 'eventId', 'ref'])).trim();
    sales.push({
      sku,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      at,
      id: id || '',
      row: i + 2,
    });
  }
  return sales;
}

function importCsvSales(store, text, recordSale) {
  const settings = (store && store.data && store.data.settings) || {};
  const rows = parseSalesCsv(text, { timeZone: settings.timezone });
  const results = [];
  for (const row of rows) {
    if (!row.sku) {
      results.push({ ok: false, error: `row ${row.row}: missing sku`, sku: null });
      continue;
    }
    if (row.qty <= 0) {
      results.push({ ok: false, error: `row ${row.row}: qty must be > 0`, sku: row.sku });
      continue;
    }
    results.push(recordSale(store, { sku: row.sku, qty: row.qty, at: row.at, ref: row.id || 'csv' }));
  }
  return { rows: rows.length, results };
}

module.exports = { parseSalesCsv, importCsvSales, parseAt };
