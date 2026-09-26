'use strict';
// Minimal, correct CSV — RFC 4180 quoting for both directions. Used by the
// import/export endpoints so companies can onboard from a spreadsheet and get
// their data back out without vendor lock-in.

function escapeField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: array of objects; columns: ordered list of keys to emit. */
function toCsv(rows, columns) {
  const header = columns.map(escapeField).join(',');
  const lines = rows.map((r) => columns.map((c) => escapeField(r[c])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}

/**
 * Parse CSV text into objects keyed by the header row. Handles quoted fields,
 * embedded commas/newlines, and doubled quotes. Blank lines are skipped.
 */
function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => {
    pushField();
    if (record.length > 1 || record[0].trim() !== '') records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRecord();
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || record.length) pushRecord();
  if (!records.length) return [];
  const header = records[0].map((h) => h.trim());
  return records.slice(1).map((rec) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = rec[i] ?? ''; });
    return obj;
  });
}

module.exports = { toCsv, parseCsv };
