'use strict';
/**
 * Inbound sales-source HTTP endpoints.
 *
 * The HTTP server (security target) mounts this module by calling:
 *
 *   const { register } = require('./integrations/routes');
 *   register(route);
 *
 * `route` is the same registrar used for plugin routes in src/server.js:
 *
 *   route({
 *     method: 'POST',
 *     path: '/api/integrations/stripe',
 *     public: true,   // skip API-key auth; the provider HMAC is the credential
 *     summary: '…',   // forwarded to GET /api when the server lists routes
 *     handler: async (ctx) => { … }
 *   })
 *
 * `ctx` matches the plugin ctx in src/server.js:
 *   req, res, url, path, method, params, store, auth, baseUrl,
 *   rawBody() → Promise<string|Buffer>,
 *   body() → Promise<object>,
 *   json(status, obj, headers),
 *   error(status, code, message),
 *   text(status, string, contentType)
 *
 * Optional: ctx.recordSale({ sku, qty, at, ref }) — when present, handlers
 * use it; otherwise they decrement through src/integrations.recordSale
 * (engine sale movement + forecast recompute).
 *
 * Contract:
 *   POST /api/integrations/stripe        public, Stripe-Signature
 *   POST /api/integrations/stripe-sales  public, alias of stripe
 *   POST /api/integrations/shopify       public, X-Shopify-Hmac-Sha256 (orders/create)
 *   POST /api/integrations/square        public, x-square-hmacsha256-signature
 *   POST /api/integrations/csv-sales     authenticated, CSV body
 *
 * Webhook handlers return 2xx after a valid signature (including unknown SKUs
 * and duplicate event ids) so providers do not retry and double-decrement.
 * Forged signatures return 400 { code: 'invalid_signature' }.
 * Missing secrets return 503 { code: 'not_configured' }.
 */

function api() {
  return require('./index');
}

function register(route) {
  if (typeof route !== 'function') throw new Error('integrations.register(route): route must be a function');

  route({
    method: 'POST',
    path: '/api/integrations/stripe',
    public: true,
    summary: 'Stripe Checkout webhook — signature-verified, idempotent on event id',
    handler: (ctx) => api().handleStripe(ctx),
  });
  route({
    method: 'POST',
    path: '/api/integrations/stripe-sales',
    public: true,
    summary: 'Stripe Checkout webhook (alias of /api/integrations/stripe)',
    handler: (ctx) => api().handleStripe(ctx),
  });
  route({
    method: 'POST',
    path: '/api/integrations/shopify',
    public: true,
    summary: 'Shopify orders/create webhook — HMAC-verified, idempotent on order id',
    handler: (ctx) => api().handleShopify(ctx),
  });
  route({
    method: 'POST',
    path: '/api/integrations/square',
    public: true,
    summary: 'Square order webhook — signature-verified, idempotent on event id',
    handler: (ctx) => api().handleSquare(ctx),
  });
  route({
    method: 'POST',
    path: '/api/integrations/csv-sales',
    public: false,
    summary: 'Import sales from CSV (sku, qty, optional at / id). Idempotent on id column',
    handler: (ctx) => api().handleCsvSales(ctx),
  });
}

module.exports = { register };
