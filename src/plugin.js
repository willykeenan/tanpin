'use strict';
// Optional plugin hook — lets a separate module add HTTP routes and usage
// limits without forking the server (for example, a hosted edition with its
// own accounts and plans). Point TANPIN_PLUGIN at a CommonJS module:
//
//   module.exports = {
//     name: 'my-plugin',
//     routes: [{ method: 'GET', path: '/api/plan', handler: (ctx) => ({ plan: 'free' }) }],
//     limits: { maxProducts: 20, maxApiKeys: 1, autoSend: false },   // or (store) => ({ ... })
//   };
//
// The full contract (route matching, the ctx object, pass-through, how limits
// are enforced) is documented in docs/plugins.md.

const path = require('node:path');

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', '*']);

/** Resolve and load the module named by TANPIN_PLUGIN (a path or a package name). */
function loadPlugin(spec, { cwd = process.cwd() } = {}) {
  if (!spec) return null;
  let file;
  try {
    file = path.isAbsolute(spec) || spec.startsWith('.')
      ? require.resolve(path.resolve(cwd, spec))
      : require.resolve(spec, { paths: [cwd] });
  } catch {
    throw new Error(`TANPIN_PLUGIN: cannot resolve "${spec}" (relative paths resolve from ${cwd})`);
  }
  return normalizePlugin(require(file), file);
}

/** Validate a plugin's exports up front so mistakes fail at boot, not mid-request. */
function normalizePlugin(mod, source = '<inline>') {
  const where = `TANPIN_PLUGIN (${source})`;
  if (!mod || typeof mod !== 'object') throw new Error(`${where} must export an object like { routes, limits }`);
  if (mod.routes !== undefined && !Array.isArray(mod.routes)) throw new Error(`${where}: routes must be an array`);

  const routes = (mod.routes || []).map((r, i) => {
    if (!r || typeof r.handler !== 'function') throw new Error(`${where}: routes[${i}].handler must be a function`);
    const method = String(r.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) throw new Error(`${where}: routes[${i}].method "${r.method}" is not supported`);
    if (typeof r.path !== 'string' && !(r.path instanceof RegExp)) {
      throw new Error(`${where}: routes[${i}].path must be a string or a RegExp`);
    }
    if (typeof r.path === 'string' && !r.path.startsWith('/')) {
      throw new Error(`${where}: routes[${i}].path must start with "/"`);
    }
    return { method, path: r.path, handler: r.handler, public: r.public === true, summary: r.summary || null };
  });

  const limits = mod.limits === undefined ? null : mod.limits;
  if (limits !== null && typeof limits !== 'object' && typeof limits !== 'function') {
    throw new Error(`${where}: limits must be an object or a function returning one`);
  }
  return { name: String(mod.name || path.basename(source, '.js')), source, routes, limits };
}

/** Match a request against a route. Returns null, or { params } on a hit. */
function matchRoute(route, method, pathname) {
  if (route.method !== '*' && route.method !== method) return null;
  if (typeof route.path === 'string') return route.path === pathname ? { params: {} } : null;
  route.path.lastIndex = 0; // a /g or /y RegExp keeps state between calls
  const m = route.path.exec(pathname);
  if (!m) return null;
  const params = {};
  for (const [k, v] of Object.entries(m.groups || {})) params[k] = v === undefined ? v : safeDecode(v);
  return { params, match: m };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * The limits currently in force (possibly per-request, if `limits` is a
 * function of the request-scoped store). Missing / non-finite values mean
 * "unlimited"; `autoSend: false` means auto-emailing POs may not be enabled.
 */
async function resolveLimits(plugin, store) {
  if (!plugin || !plugin.limits) return {};
  const l = typeof plugin.limits === 'function' ? await plugin.limits(store) : plugin.limits;
  return l && typeof l === 'object' ? l : {};
}

function isCap(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

module.exports = { loadPlugin, normalizePlugin, matchRoute, resolveLimits, isCap };
