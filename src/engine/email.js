'use strict';
// Auto-emailing — purchase orders to suppliers and operational alerts.
// Transports, chosen automatically (or via EMAIL_TRANSPORT):
//
//   * SMTP    — SMTP_HOST. Port 465 = implicit TLS; 587 = STARTTLS.
//               AUTH LOGIN and AUTH PLAIN (SMTP_AUTH=login|plain, or advertised).
//   * Resend  — RESEND_API_KEY, POST https://api.resend.com/emails (override RESEND_API_URL).
//   * Postmark— POSTMARK_SERVER_TOKEN, POST https://api.postmarkapp.com/email
//               (override POSTMARK_API_URL).
//   * SES v2  — AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, SigV4 over HTTPS, no SDK.
//               Endpoint email.{AWS_REGION}.amazonaws.com (override AWS_SES_ENDPOINT).
//   * Outbox  — otherwise write <data dir>/outbox/*.eml.
//
// Purchase orders can carry a CSV attachment of their lines (pass `purchaseOrder`
// or `attachments` to sendEmail). Implemented with node:* built-ins only.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { toCsv } = require('./csv');

function smtpConfig() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 465);
  const secureEnv = process.env.SMTP_SECURE;
  const starttlsEnv = process.env.SMTP_STARTTLS;
  const secure = secureEnv === '1' || secureEnv === 'true' || (secureEnv == null && port === 465);
  const starttls = starttlsEnv === '1' || starttlsEnv === 'true' || (starttlsEnv == null && port === 587);
  return {
    host,
    port,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    auth: (process.env.SMTP_AUTH || '').toLowerCase(),
    secure,
    starttls,
    rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== '0',
  };
}

/**
 * The DATA payload for a message: CRLF line endings (RFC 5321 forbids bare LF)
 * and dot-stuffing, so a body line that starts with "." cannot end the
 * transmission early.
 */
function smtpData(message) {
  return message
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n') + '\r\n.';
}

function headerSafe(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}

function filenameSafe(v) {
  return headerSafe(v).replace(/["\\]/g, '_') || 'attachment.csv';
}

function purchaseOrderCsv(po) {
  const rows = (po && po.lines || []).map((l) => ({
    sku: l.sku || '',
    name: l.name || '',
    qty: l.qty || 0,
    unitCost: l.unitCost || 0,
    lineTotal: (Number(l.qty) || 0) * (Number(l.unitCost) || 0),
  }));
  return toCsv(rows, ['sku', 'name', 'qty', 'unitCost', 'lineTotal']);
}

function purchaseOrderAttachment(po) {
  const id = headerSafe(po && po.id != null ? po.id : 'draft').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return {
    filename: `PO-${id}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: purchaseOrderCsv(po),
  };
}

function normalizeAttachments(opts) {
  const out = [];
  if (Array.isArray(opts.attachments)) out.push(...opts.attachments);
  if (opts.purchaseOrder) out.push(purchaseOrderAttachment(opts.purchaseOrder));
  return out.filter((a) => a && a.filename);
}

function b64wrap(buf) {
  return Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

function buildMessage({ from, to, subject, text, attachments }) {
  const date = new Date().toUTCString();
  const files = Array.isArray(attachments) ? attachments.filter((a) => a && a.filename) : [];
  if (!files.length) {
    return [
      `From: ${headerSafe(from)}`,
      `To: ${headerSafe(to)}`,
      `Subject: ${headerSafe(subject)}`,
      `Date: ${date}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      text == null ? '' : String(text),
    ].join('\r\n');
  }
  const boundary = 'tanpin-' + crypto.randomBytes(12).toString('hex');
  const parts = [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(to)}`,
    `Subject: ${headerSafe(subject)}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    text == null ? '' : String(text),
  ];
  for (const a of files) {
    const body = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content == null ? '' : a.content), 'utf8');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${headerSafe(a.contentType || 'application/octet-stream')}`,
      `Content-Disposition: attachment; filename="${filenameSafe(a.filename)}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64wrap(body),
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

// ---------------------------------------------------------------------------
// SMTP (implicit TLS on 465, STARTTLS on 587, AUTH LOGIN / PLAIN)
// ---------------------------------------------------------------------------
class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this._bind(socket);
  }

  _bind(socket) {
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this._flush();
    });
    socket.on('error', (e) => this._rejectAll(e));
    socket.on('close', () => this._rejectAll(new Error('SMTP connection closed')));
  }

  _rejectAll(e) {
    while (this.waiters.length) this.waiters.shift().reject(e);
  }

  _flush() {
    while (this.waiters.length) {
      const parsed = consumeSmtpReply(this.buffer);
      if (!parsed.reply) return;
      this.buffer = parsed.rest;
      this.waiters.shift().resolve(parsed.reply);
    }
  }

  readReply() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this._flush();
    });
  }

  async command(line) {
    this.socket.write(line + '\r\n');
    const r = await this.readReply();
    if (r.code >= 400) throw new Error(`SMTP ${r.code}`);
    return r;
  }

  async data(payload) {
    this.socket.write(payload + '\r\n');
    const r = await this.readReply();
    if (r.code >= 400) throw new Error(`SMTP ${r.code}`);
    return r;
  }

  upgradeTls(opts) {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('close');
      const tlsSock = tls.connect({ ...opts, socket: plain }, () => {
        this.socket = tlsSock;
        this.buffer = '';
        this._bind(tlsSock);
        resolve();
      });
      tlsSock.on('error', reject);
    });
  }
}

function consumeSmtpReply(buffer) {
  // One SMTP reply: optional "xyz-…" continuations, terminated by "xyz …" or "xyz".
  const m = buffer.match(/^(?:[0-9]{3}-.*(?:\r\n|\n))*(?:[0-9]{3}[ ].*(?:\r\n|\n)|[0-9]{3}(?:\r\n|\n))/);
  if (!m) return { reply: null, rest: buffer };
  const block = m[0];
  const lines = block.split(/\r?\n/).filter((l) => l !== '');
  const last = lines[lines.length - 1] || '';
  const code = parseInt(last.slice(0, 3), 10);
  return { reply: { code, lines, text: lines.join('\n') }, rest: buffer.slice(block.length) };
}

function waitConnect(socket) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = () => { if (done) return; done = true; resolve(); };
    const fail = (e) => { if (done) return; done = true; reject(e); };
    socket.once('error', fail);
    if (socket instanceof tls.TLSSocket) {
      socket.once('secureConnect', ok);
    } else {
      socket.once('connect', ok);
      if (socket.readable && socket.writable) ok();
    }
  });
}

async function authenticateSmtp(session, cfg, ehloText) {
  const requested = (cfg.auth || '').toLowerCase();
  const hasPlain = /AUTH[^\r\n]*\bPLAIN\b/i.test(ehloText);
  const method = requested === 'login' || requested === 'plain'
    ? requested
    : (hasPlain ? 'plain' : 'login');
  if (method === 'plain') {
    const token = Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64');
    session.socket.write(`AUTH PLAIN ${token}\r\n`);
    let r = await session.readReply();
    if (r.code === 334) {
      session.socket.write(token + '\r\n');
      r = await session.readReply();
    }
    if (r.code >= 400) throw new Error(`SMTP ${r.code}`);
    return;
  }
  await session.command('AUTH LOGIN');
  await session.command(Buffer.from(cfg.user).toString('base64'));
  await session.command(Buffer.from(cfg.pass).toString('base64'));
}

async function sendViaSmtp(cfg, mail) {
  const implicitTls = cfg.secure === true;
  const servername = net.isIP(cfg.host) ? undefined : cfg.host;
  const socket = implicitTls
    ? tls.connect({
      host: cfg.host, port: cfg.port, servername,
      rejectUnauthorized: cfg.rejectUnauthorized !== false,
    })
    : net.connect({ host: cfg.host, port: cfg.port });

  const session = new SmtpSession(socket);
  const failTimer = setTimeout(() => {
    try { socket.destroy(); } catch {}
  }, 15000);
  socket.setTimeout(15000, () => { try { socket.destroy(); } catch {} });

  try {
    await waitConnect(socket);
    const greet = await session.readReply();
    if (greet.code >= 400) throw new Error(`SMTP ${greet.code}`);
    let ehlo = await session.command('EHLO inventory.local');
    const wantStartTls = !implicitTls && (cfg.starttls === true || /STARTTLS/i.test(ehlo.text));
    if (wantStartTls) {
      await session.command('STARTTLS');
      await session.upgradeTls({
        servername,
        rejectUnauthorized: cfg.rejectUnauthorized !== false,
      });
      ehlo = await session.command('EHLO inventory.local');
    }
    if (cfg.user) await authenticateSmtp(session, cfg, ehlo.text);
    await session.command(`MAIL FROM:<${headerSafe(mail.from)}>`);
    await session.command(`RCPT TO:<${headerSafe(mail.to)}>`);
    await session.command('DATA');
    await session.data(smtpData(buildMessage(mail)));
    try { await session.command('QUIT'); } catch { /* server already closed */ }
    return true;
  } finally {
    clearTimeout(failTimer);
    try { session.socket.destroy(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// AWS SigV4 (SES v2). No SDK.
// ---------------------------------------------------------------------------
function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacRaw(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function awsEncode(value, isPath) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, isPath ? '/' : '%2F');
}

function canonicalQuery(url) {
  const params = [];
  url.searchParams.forEach((v, k) => params.push([k, v]));
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 0));
  return params.map(([k, v]) => `${awsEncode(k)}=${awsEncode(v)}`).join('&');
}

function iso8601Basic(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function signAwsV4({ method, url, body, headers = {}, accessKey, secretKey, region, service, amzDate, sessionToken, includeContentSha256 = true }) {
  const u = typeof url === 'string' ? new URL(url) : url;
  const datetime = amzDate || iso8601Basic(new Date());
  const date = datetime.slice(0, 8);
  const payloadHash = sha256hex(body || '');
  const hdrs = {};
  for (const [k, v] of Object.entries(headers)) hdrs[k.toLowerCase()] = String(v).trim();
  hdrs.host = u.host;
  hdrs['x-amz-date'] = datetime;
  if (includeContentSha256 || hdrs['x-amz-content-sha256']) {
    hdrs['x-amz-content-sha256'] = hdrs['x-amz-content-sha256'] || payloadHash;
  }
  if (sessionToken) hdrs['x-amz-security-token'] = sessionToken;

  const signedNames = Object.keys(hdrs).sort();
  const canonicalHeaders = signedNames.map((n) => n + ':' + hdrs[n] + '\n').join('');
  const signedHeaders = signedNames.join(';');
  const canonicalUri = u.pathname.split('/').map((p) => awsEncode(p, true)).join('/') || '/';
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery(u),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacRaw('AWS4' + secretKey, date);
  const kRegion = hmacRaw(kDate, region);
  const kService = hmacRaw(kRegion, service);
  const kSigning = hmacRaw(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  hdrs.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: hdrs, datetime, signature, canonicalRequest, stringToSign };
}

// ---------------------------------------------------------------------------
// HTTPS senders
// ---------------------------------------------------------------------------
async function httpPostJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return true;
}

function attachmentParts(files) {
  return files.map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content)
      ? a.content.toString('base64')
      : Buffer.from(String(a.content == null ? '' : a.content), 'utf8').toString('base64'),
    contentType: a.contentType || 'application/octet-stream',
  }));
}

async function sendViaResend(mail) {
  const url = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
  const files = mail.attachments || [];
  const payload = {
    from: mail.from,
    to: [mail.to],
    subject: mail.subject,
    text: mail.text,
  };
  if (files.length) {
    payload.attachments = attachmentParts(files).map((a) => ({
      filename: a.filename,
      content: a.content,
    }));
  }
  await httpPostJson(url, {
    authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    'content-type': 'application/json',
  }, JSON.stringify(payload));
  return true;
}

async function sendViaPostmark(mail) {
  const url = process.env.POSTMARK_API_URL || 'https://api.postmarkapp.com/email';
  const token = process.env.POSTMARK_SERVER_TOKEN || process.env.POSTMARK_API_TOKEN;
  const files = mail.attachments || [];
  const payload = {
    From: mail.from,
    To: mail.to,
    Subject: mail.subject,
    TextBody: mail.text,
    MessageStream: 'outbound',
  };
  if (files.length) {
    payload.Attachments = attachmentParts(files).map((a) => ({
      Name: a.filename,
      Content: a.content,
      ContentType: a.contentType,
    }));
  }
  await httpPostJson(url, {
    'x-postmark-server-token': token,
    accept: 'application/json',
    'content-type': 'application/json',
  }, JSON.stringify(payload));
  return true;
}

async function sendViaSes(mail) {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const url = process.env.AWS_SES_ENDPOINT || process.env.SES_ENDPOINT
    || `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY;
  const files = mail.attachments || [];
  let payload;
  if (files.length) {
    payload = {
      FromEmailAddress: mail.from,
      Destination: { ToAddresses: [mail.to] },
      Content: { Raw: { Data: Buffer.from(buildMessage(mail)).toString('base64') } },
    };
  } else {
    payload = {
      FromEmailAddress: mail.from,
      Destination: { ToAddresses: [mail.to] },
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: mail.text, Charset: 'UTF-8' } },
        },
      },
    };
  }
  const body = JSON.stringify(payload);
  const signed = signAwsV4({
    method: 'POST',
    url,
    body,
    headers: { 'content-type': 'application/json' },
    accessKey,
    secretKey,
    region,
    service: 'ses',
    sessionToken: process.env.AWS_SESSION_TOKEN,
  });
  const headers = {};
  for (const [k, v] of Object.entries(signed.headers)) headers[k] = v;
  await httpPostJson(url, headers, body);
  return true;
}

function detectTransport() {
  const forced = (process.env.EMAIL_TRANSPORT || '').toLowerCase();
  if (forced) return forced;
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.POSTMARK_SERVER_TOKEN || process.env.POSTMARK_API_TOKEN) return 'postmark';
  if (process.env.AWS_ACCESS_KEY_ID && (process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY)) return 'ses';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'outbox';
}

function writeOutboxFile(outboxDir, msg) {
  if (!outboxDir) throw new Error('no outbox directory configured');
  if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });
  const safe = headerSafe(msg.subject).replace(/[^a-z0-9]+/gi, '_').slice(0, 50);
  const file = path.join(outboxDir, `${Date.now()}_${safe}.eml`);
  fs.writeFileSync(file, buildMessage(msg));
  return file;
}

/**
 * Send an email. Always resolves with a record describing what happened; never
 * throws (a failed supplier email must not crash the daemon).
 */
async function sendEmail(opts) {
  const attachments = normalizeAttachments(opts || {});
  const mail = {
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    attachments,
    purchaseOrder: opts.purchaseOrder,
  };
  const record = {
    to: mail.to, from: mail.from, subject: mail.subject, text: mail.text,
    at: Date.now(), transport: 'outbox', ok: true,
  };
  const transport = detectTransport();
  if (mail.to && transport !== 'outbox') {
    try {
      if (transport === 'smtp') {
        const cfg = smtpConfig();
        if (!cfg) throw new Error('SMTP_HOST is not set');
        await sendViaSmtp(cfg, mail);
        record.transport = 'smtp';
        return record;
      }
      if (transport === 'resend') {
        await sendViaResend(mail);
        record.transport = 'resend';
        return record;
      }
      if (transport === 'postmark') {
        await sendViaPostmark(mail);
        record.transport = 'postmark';
        return record;
      }
      if (transport === 'ses') {
        await sendViaSes(mail);
        record.transport = 'ses';
        return record;
      }
      throw new Error(`unknown EMAIL_TRANSPORT "${transport}"`);
    } catch (e) {
      record.transport = 'outbox';
      record.smtpError = String((e && e.message) || e);
    }
  }
  try {
    record.file = writeOutboxFile(opts.outboxDir, mail);
  } catch (e) {
    record.ok = false;
    record.error = String((e && e.message) || e);
  }
  return record;
}

module.exports = {
  sendEmail,
  buildMessage,
  smtpConfig,
  smtpData,
  purchaseOrderCsv,
  purchaseOrderAttachment,
  signAwsV4,
  detectTransport,
  headerSafe,
};
