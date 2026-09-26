'use strict';
// Outbound-request guard (SSRF). Used by engine/webhooks.js for every webhook
// delivery — whether it runs inside `tanpin serve` or the standalone daemon —
// and by the server when a webhook is registered.
//
// A destination is refused when its host is, or resolves to, anything that is
// not ordinary public unicast: loopback, RFC1918, CGNAT (100.64/10, which also
// covers some cloud metadata services), link-local, IETF/benchmark/doc ranges,
// multicast/reserved, and the IPv6 equivalents including IPv4 embedded via
// IPv4-mapped/-compatible, NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
//
// DNS rebinding: the resolver used for the actual TCP connection is
// `safeLookup`, which validates every address it returns. There is no separate
// "check" resolution that a TTL-0 name could answer differently.

const net = require('node:net');
const dns = require('node:dns');

const PRIVATE_MSG = 'webhook URL points at a private, loopback, or link-local address';
const RESOLVES_PRIVATE_MSG = 'webhook URL resolves to a private, loopback, or link-local address';

function allowPrivate() { return process.env.TANPIN_ALLOW_PRIVATE_WEBHOOKS === '1'; }

function normalizeHostname(host) {
  return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function parseV4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return p;
}

function ipv4Blocked(ip) {
  const p = parseV4(ip);
  if (!p) return true;
  const [a, b, c] = p;
  if (a === 0) return true;                                   // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                  // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64.0.0/10 CGNAT (Tailscale, Alibaba metadata)
  if (a === 127) return true;                                 // loopback
  if (a === 169 && b === 254) return true;                    // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;           // RFC1918
  if (a === 192 && b === 0 && c === 0) return true;           // 192.0.0.0/24 IETF protocol assignments (OCI metadata)
  if (a === 192 && b === 0 && c === 2) return true;           // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true;         // 6to4 relay anycast
  if (a === 192 && b === 168) return true;                    // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true;        // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;         // TEST-NET-3
  if (a >= 224) return true;                                  // multicast, reserved, broadcast
  return false;
}

function parseHextet(x) {
  if (!x || !/^[0-9a-f]{1,4}$/i.test(x)) return null;
  return parseInt(x, 16);
}

/** Expand an IPv6 literal to 8 hextets, including dotted IPv4 tails. */
function ipv6Hextets(ip) {
  const raw = normalizeHostname(ip).replace(/%.*$/, ''); // drop zone id
  if (!raw) return null;
  let v4tail = null;
  let core = raw;
  const v4m = raw.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4m) {
    const p = parseV4(v4m[1]);
    if (!p) return null;
    v4tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    core = raw.slice(0, raw.length - v4m[1].length) || ':';
    if (core.endsWith(':') && !core.endsWith('::')) core = core.slice(0, -1);
  }
  const extra = v4tail ? 2 : 0;
  let groups;
  if (core.includes('::')) {
    const parts = core.split('::');
    if (parts.length !== 2) return null;
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const fill = 8 - left.length - right.length - extra;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    groups = core ? core.split(':') : [];
    if (groups.length + extra !== 8) return null;
  }
  const nums = groups.map(parseHextet);
  if (nums.some((n) => n == null)) return null;
  if (v4tail) nums.push(...v4tail);
  return nums.length === 8 ? nums : null;
}

function v4FromHextets(hi, lo) {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function ipv6Blocked(ip) {
  const hx = ipv6Hextets(ip);
  if (!hx) return true;
  const [a, b, c, d, e, f, g, h] = hx;
  if (hx.every((x) => x === 0)) return true;                              // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-translated (::ffff:0:a.b.c.d) and
  // deprecated IPv4-compatible (::a.b.c.d): judge the embedded IPv4.
  if (a === 0 && b === 0 && c === 0 && d === 0 && ((e === 0 && (f === 0xffff || f === 0)) || (e === 0xffff && f === 0))) {
    return ipv4Blocked(v4FromHextets(g, h));
  }
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return ipv4Blocked(v4FromHextets(g, h));                              // NAT64 64:ff9b::/96
  }
  if (a === 0x64 && b === 0xff9b && c === 1) return true;                 // local-use NAT64 64:ff9b:1::/48
  if (a === 0x2002) return ipv4Blocked(v4FromHextets(b, c));              // 6to4 2002::/16
  if (a === 0x2001 && b === 0) return true;                               // Teredo 2001::/32 (obfuscated IPv4)
  if (a === 0x2001 && b === 0x0db8) return true;                          // documentation 2001:db8::/32
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true;         // discard-only 100::/64
  if ((a & 0xfe00) === 0xfc00) return true;                               // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true;                               // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true;                               // site-local fec0::/10 (deprecated)
  if ((a & 0xff00) === 0xff00) return true;                               // multicast
  return false;
}

function ipIsBlocked(ip) {
  const h = normalizeHostname(ip);
  const version = net.isIP(h.replace(/%.*$/, ''));
  if (version === 4) return ipv4Blocked(h);
  if (version === 6) return ipv6Blocked(h);
  return true;
}

function hostnameLooksPrivate(host) {
  const h = normalizeHostname(host);
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (net.isIP(h)) return ipIsBlocked(h);
  return false;
}

/** Synchronous URL check (scheme + literal/obviously-private host). null = OK. */
function webhookUrlBlocked(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'url must be an http(s) URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must be an http(s) URL';
  if (allowPrivate()) return null;
  if (hostnameLooksPrivate(u.hostname)) return PRIVATE_MSG;
  return null;
}

/**
 * dns.lookup-compatible resolver for http.request({ lookup }). Resolves all
 * addresses and fails the connection if ANY of them is private, so the address
 * the socket connects to is always one that was checked.
 */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  options = options || {};
  const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : (options.family || 0);
  dns.lookup(hostname, { all: true, family, hints: options.hints, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length) {
      const e = new Error(`webhook URL did not resolve: ${hostname}`);
      e.code = 'ENOTFOUND';
      return callback(e);
    }
    if (!allowPrivate()) {
      for (const a of list) {
        if (ipIsBlocked(a.address)) {
          const e = new Error(RESOLVES_PRIVATE_MSG);
          e.code = 'EBLOCKED_DESTINATION';
          return callback(e);
        }
      }
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

module.exports = {
  PRIVATE_MSG,
  RESOLVES_PRIVATE_MSG,
  allowPrivate,
  normalizeHostname,
  ipv4Blocked,
  ipv6Blocked,
  ipv6Hextets,
  ipIsBlocked,
  hostnameLooksPrivate,
  webhookUrlBlocked,
  safeLookup,
};
