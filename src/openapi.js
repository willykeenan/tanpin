// OpenAPI 3.1 spec for the Tanpin API, served at /openapi.json.
// Kept in code (not a static file) so the server can inject its own base URL,
// and so the spec lives next to the routes it documents.

function buildOpenApi({ baseUrl = 'http://localhost:4173', version = '1.1.0' } = {}) {
  const err = (description) => ({
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  });
  const jsonBody = (schema, required = true) => ({
    required,
    content: { 'application/json': { schema } },
  });
  const jsonRes = (description, schema) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
  const idOrSku = {
    name: 'idOrSku', in: 'path', required: true,
    description: 'Product internal id (pro_...) or SKU (e.g. COFFEE-HOT)',
    schema: { type: 'string' },
  };
  const idemHeader = {
    name: 'Idempotency-Key', in: 'header', required: false,
    description: 'Any unique string. Retrying with the same key within 24h replays the original response instead of duplicating the write.',
    schema: { type: 'string' },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Tanpin API',
      version,
      summary: 'Self-hosted item-by-item inventory with demand forecasting, automatic reordering, supplier auto-emailing, and delivery ETAs.',
      description: [
        'Tanpin — inventory management built on the tanpin kanri (単品管理) method popularized by Japanese convenience retail.',
        '',
        '**For AI agents:** every product is addressable by SKU (no need to look up internal ids), ',
        '`GET /api/state` returns the whole world in one call, `GET /api/recommendations` tells you exactly what to order, ',
        'and `POST /api/purchase-orders` with `{"supplierId": "...", "fromRecommendations": true}` turns a recommendation into a real order. ',
        'A bundled MCP server (mcp.js) exposes all of this as native tools.',
        '',
        '**Auth:** `Authorization: Bearer <key>` or `X-API-Key: <key>`. Direct local requests (loopback peer, loopback Host, no forwarding headers) need no key by default; proxied, containerized or cross-origin requests do. Secrets are never returned by reads.',
        '',
        '**Errors:** non-2xx responses are `{"error": "<human message>", "code": "<machine_code>"}`.',
        '',
        '**Webhooks:** register URLs via `POST /api/webhooks`; deliveries are JSON POSTs signed with `X-Inventory-Signature: sha256=HMAC-SHA256(secret, raw_body)`.',
      ].join('\n'),
      license: { name: 'MIT' },
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    tags: [
      { name: 'discovery', description: 'Health, docs, and the full system state' },
      { name: 'products', description: 'SKU catalog with live forecasts and reorder math' },
      { name: 'stock', description: 'Sales, adjustments, and the movement audit trail' },
      { name: 'ordering', description: 'Recommendations and purchase orders with ETAs' },
      { name: 'suppliers', description: 'Suppliers: lead times, delivery windows, cut-offs' },
      { name: 'forecasting', description: 'Demand hypotheses (events, weather)' },
      { name: 'automation', description: 'The auto-management daemon' },
      { name: 'integration', description: 'API keys, webhooks, CSV import/export' },
    ],
    paths: {
      '/api/health': {
        get: {
          tags: ['discovery'], summary: 'Liveness, version, SKU count', security: [],
          responses: { 200: jsonRes('Server is up', { type: 'object', properties: { ok: { type: 'boolean' }, name: { type: 'string' }, version: { type: 'string' }, time: { type: 'integer' }, skus: { type: 'integer' }, daemonLastRun: { type: ['integer', 'null'] } } }) },
        },
      },
      '/api/state': {
        get: {
          tags: ['discovery'], summary: 'Everything in one call: KPIs, products (enriched), open POs with ETAs, suppliers, hypotheses, daemon log, outbox',
          responses: { 200: jsonRes('Full system state', ref('State')), 401: err('Missing or invalid API key') },
        },
      },
      '/api/products': {
        get: {
          tags: ['products'], summary: 'List products with live forecast + reorder fields',
          parameters: [
            { name: 'low_stock', in: 'query', schema: { type: 'string', enum: ['true'] }, description: 'Only items at/below reorder point' },
            { name: 'category', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: jsonRes('Products', { type: 'array', items: ref('Product') }), 401: err('Unauthorized') },
        },
        post: {
          tags: ['products'], summary: 'Create a product',
          requestBody: jsonBody(ref('ProductInput')),
          responses: { 201: jsonRes('Created', ref('Product')), 400: err('sku and name required'), 409: err('Duplicate SKU'), 401: err('Unauthorized') },
        },
      },
      '/api/products/bulk': {
        post: {
          tags: ['products'], summary: 'Bulk upsert products by SKU (creates unknown suppliers by name)',
          requestBody: jsonBody({ oneOf: [{ type: 'array', items: ref('ProductInput') }, { type: 'object', properties: { products: { type: 'array', items: ref('ProductInput') } } }] }),
          responses: { 201: jsonRes('Import summary', ref('ImportResult')), 401: err('Unauthorized') },
        },
      },
      '/api/products/{idOrSku}': {
        get: { tags: ['products'], summary: 'Get one product (by id or SKU)', parameters: [idOrSku], responses: { 200: jsonRes('Product', ref('Product')), 404: err('Not found') } },
        put: { tags: ['products'], summary: 'Update a product', parameters: [idOrSku], requestBody: jsonBody(ref('ProductInput')), responses: { 200: jsonRes('Updated', ref('Product')), 404: err('Not found') } },
        delete: { tags: ['products'], summary: 'Delete a product', parameters: [idOrSku], responses: { 200: jsonRes('Removed', { type: 'object', properties: { removed: { type: 'boolean' } } }), 404: err('Not found') } },
      },
      '/api/sales': {
        post: {
          tags: ['stock'], summary: 'Record a sale (decrements stock, re-forecasts, may emit stock.low)',
          parameters: [idemHeader],
          requestBody: jsonBody(ref('SaleInput')),
          responses: { 201: jsonRes('Sale recorded', { type: 'object', properties: { product: ref('Product') } }), 404: err('Product not found') },
        },
      },
      '/api/sales/bulk': {
        post: {
          tags: ['stock'], summary: 'Record many sales in one call (e.g. end-of-day POS sync)',
          parameters: [idemHeader],
          requestBody: jsonBody({ oneOf: [{ type: 'array', items: ref('SaleInput') }, { type: 'object', properties: { sales: { type: 'array', items: ref('SaleInput') } } }] }),
          responses: { 201: jsonRes('Per-line results', { type: 'object', properties: { recorded: { type: 'integer' }, failed: { type: 'integer' }, results: { type: 'array', items: { type: 'object' } } } }) },
        },
      },
      '/api/adjust': {
        post: {
          tags: ['stock'], summary: 'Manual stock adjustment (delta can be negative; e.g. shrinkage, stocktake)',
          requestBody: jsonBody({ type: 'object', required: ['delta'], properties: { productId: { type: 'string' }, sku: { type: 'string' }, delta: { type: 'number' }, reason: { type: 'string' } } }),
          responses: { 201: jsonRes('Adjusted', { type: 'object', properties: { product: ref('Product') } }), 404: err('Product not found') },
        },
      },
      '/api/movements': {
        get: {
          tags: ['stock'], summary: 'Stock movement audit trail (sales, receipts, adjustments), newest first',
          parameters: [
            { name: 'product', in: 'query', schema: { type: 'string' }, description: 'Filter to one product (id or SKU)' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 1000 } },
          ],
          responses: { 200: jsonRes('Movements', { type: 'array', items: ref('Movement') }) },
        },
      },
      '/api/recommendations': {
        get: {
          tags: ['ordering'], summary: 'What should be ordered right now — a dry run of the daemon\'s ordering pass, grouped by supplier',
          responses: { 200: jsonRes('Recommendations', { type: 'object', properties: { recommendations: { type: 'array', items: ref('Recommendation') }, notes: { type: 'array', items: { type: 'string' } }, generatedAt: { type: 'integer' } } }) },
        },
      },
      '/api/purchase-orders': {
        get: {
          tags: ['ordering'], summary: 'List purchase orders with ETAs',
          parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'draft', 'sent', 'received', 'cancelled'] }, description: '"open" = not received and not cancelled' }],
          responses: { 200: jsonRes('Purchase orders', { type: 'array', items: ref('PurchaseOrder') }) },
        },
        post: {
          tags: ['ordering'], summary: 'Create a PO — pass explicit lines (by sku), or fromRecommendations to order exactly what the engine recommends',
          parameters: [idemHeader],
          requestBody: jsonBody({
            type: 'object', required: ['supplierId'],
            properties: {
              supplierId: { type: 'string', description: 'Supplier id or exact name' },
              lines: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, productId: { type: 'string' }, qty: { type: 'number' } } } },
              fromRecommendations: { type: 'boolean', description: 'Build lines from GET /api/recommendations for this supplier' },
              autoSend: { type: 'boolean', description: 'Immediately mark sent + email the supplier' },
            },
          }),
          responses: { 201: jsonRes('Created', ref('PurchaseOrder')), 400: err('Bad supplier or empty lines'), 422: err('fromRecommendations found nothing to order') },
        },
      },
      '/api/purchase-orders/{id}': {
        get: { tags: ['ordering'], summary: 'Get one purchase order', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Purchase order', ref('PurchaseOrder')), 404: err('Not found') } },
      },
      '/api/purchase-orders/{id}/send': {
        post: { tags: ['ordering'], summary: 'Mark sent and email it to the supplier (SMTP or outbox)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Sent', { type: 'object' }), 404: err('Not found') } },
      },
      '/api/purchase-orders/{id}/receive': {
        post: { tags: ['ordering'], summary: 'Receive the PO into stock (writes receipt movements)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Received', { type: 'object' }), 409: err('Already received / cancelled'), 404: err('Not found') } },
      },
      '/api/purchase-orders/{id}/cancel': {
        post: { tags: ['ordering'], summary: 'Cancel the PO', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Cancelled', { type: 'object' }), 409: err('Already received'), 404: err('Not found') } },
      },
      '/api/suppliers': {
        get: { tags: ['suppliers'], summary: 'List suppliers', responses: { 200: jsonRes('Suppliers', { type: 'array', items: ref('Supplier') }) } },
        post: { tags: ['suppliers'], summary: 'Create supplier', requestBody: jsonBody(ref('SupplierInput')), responses: { 201: jsonRes('Created', ref('Supplier')), 400: err('name required') } },
      },
      '/api/suppliers/{id}': {
        put: { tags: ['suppliers'], summary: 'Update supplier', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody(ref('SupplierInput')), responses: { 200: jsonRes('Updated', ref('Supplier')), 404: err('Not found') } },
        delete: { tags: ['suppliers'], summary: 'Delete supplier', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Removed', { type: 'object' }) } },
      },
      '/api/hypotheses': {
        get: { tags: ['forecasting'], summary: 'List demand hypotheses', responses: { 200: jsonRes('Hypotheses', { type: 'array', items: ref('Hypothesis') }) } },
        post: {
          tags: ['forecasting'], summary: 'Add a hypothesis — "heatwave next week, beverages ×1.4" — forecasts and orders adjust automatically',
          requestBody: jsonBody({ type: 'object', required: ['multiplier'], properties: { note: { type: 'string' }, multiplier: { type: 'number', example: 1.4 }, category: { type: ['string', 'null'] }, sku: { type: ['string', 'null'] }, productId: { type: ['string', 'null'] }, startsAt: { type: 'integer' }, endsAt: { type: 'integer' } } }),
          responses: { 201: jsonRes('Created', ref('Hypothesis')) },
        },
      },
      '/api/hypotheses/{id}': {
        delete: { tags: ['forecasting'], summary: 'Remove hypothesis', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Removed', { type: 'object' }) } },
      },
      '/api/daemon/run': {
        post: { tags: ['automation'], summary: 'Run one full auto-management cycle now (forecast → reorder → order → email → receive → delist)', responses: { 200: jsonRes('Cycle summary', ref('CycleSummary')) } },
      },
      '/api/daemon/log': {
        get: { tags: ['automation'], summary: 'Recent cycle summaries, newest first', responses: { 200: jsonRes('Log', { type: 'array', items: ref('CycleSummary') }) } },
      },
      '/api/settings': {
        get: { tags: ['automation'], summary: 'Read settings', responses: { 200: jsonRes('Settings', ref('Settings')) } },
        put: { tags: ['automation'], summary: 'Update settings (partial)', requestBody: jsonBody(ref('Settings')), responses: { 200: jsonRes('Updated', ref('Settings')) } },
      },
      '/api/keys': {
        get: { tags: ['integration'], summary: 'List API keys (masked — full keys are never stored)', responses: { 200: jsonRes('Keys', { type: 'array', items: ref('ApiKey') }) } },
        post: { tags: ['integration'], summary: 'Create an API key — the full key appears once in this response', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' } } }, false), responses: { 201: jsonRes('Created (includes `key` once)', ref('ApiKey')) } },
      },
      '/api/keys/{id}': {
        delete: { tags: ['integration'], summary: 'Revoke an API key', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Revoked', ref('ApiKey')), 404: err('Not found') } },
      },
      '/api/webhooks': {
        get: { tags: ['integration'], summary: 'List webhooks, valid event names, and recent deliveries', responses: { 200: jsonRes('Webhooks', { type: 'object', properties: { webhooks: { type: 'array', items: ref('Webhook') }, events: { type: 'array', items: { type: 'string' } }, recentDeliveries: { type: 'array', items: { type: 'object' } } } }) } },
        post: {
          tags: ['integration'], summary: 'Register a webhook. Deliveries are HMAC-signed JSON POSTs.',
          requestBody: jsonBody({ type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' }, description: 'Event names or ["*"] (default)' }, secret: { type: 'string', description: 'Auto-generated if omitted' } } }),
          responses: { 201: jsonRes('Created (includes secret)', ref('Webhook')), 400: err('Bad URL or unknown event') },
        },
      },
      '/api/webhooks/{id}': {
        delete: { tags: ['integration'], summary: 'Delete webhook', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Removed', { type: 'object' }) } },
      },
      '/api/webhooks/{id}/test': {
        post: { tags: ['integration'], summary: 'Fire a webhook.test event at this webhook now', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: jsonRes('Delivery attempt result', { type: 'object' }), 404: err('Not found') } },
      },
      '/api/export/products.csv': {
        get: { tags: ['integration'], summary: 'Export the catalog as CSV', responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } } } },
      },
      '/api/export/movements.csv': {
        get: { tags: ['integration'], summary: 'Export the movement audit trail as CSV', responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } } } },
      },
      '/api/import/products': {
        post: {
          tags: ['integration'], summary: 'Import products from a JSON array or CSV text (upserts by SKU; creates suppliers by name)',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'array', items: ref('ProductInput') } }, 'text/csv': { schema: { type: 'string' } } } },
          responses: { 201: jsonRes('Import summary', ref('ImportResult')), 400: err('Unparseable body') },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key as bearer token. Direct local requests (loopback peer, loopback Host, no forwarding headers) need no key by default.' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string', description: 'Human-readable message' }, code: { type: 'string', description: 'Machine-readable code, e.g. product_not_found' } },
        },
        Product: {
          type: 'object',
          description: 'A SKU with live planning fields (recomputed every cycle and on every sale).',
          properties: {
            id: { type: 'string' }, sku: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' },
            supplierId: { type: ['string', 'null'] }, unitCost: { type: 'number' }, price: { type: 'number' },
            currentStock: { type: 'number' }, onOrder: { type: 'number', description: 'Inbound on open POs' },
            stockPosition: { type: 'number', description: 'currentStock + onOrder' },
            belowReorder: { type: 'boolean' }, daysOfSupply: { type: ['number', 'null'] },
            leadTimeDays: { type: 'number' }, packSize: { type: 'number' }, minOrderQty: { type: 'number' },
            avgDailyDemand: { type: 'number' }, dailyForecast: { type: 'number' }, dailyStdDev: { type: 'number' },
            safetyStock: { type: 'number' }, reorderPoint: { type: 'number' }, eoq: { type: 'number' },
            abcClass: { type: 'string', enum: ['A', 'B', 'C'] }, delistFlagged: { type: ['string', 'null'], enum: ['dead', 'slow', null] },
          },
        },
        ProductInput: {
          type: 'object', required: ['sku', 'name'],
          properties: {
            sku: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' },
            supplierId: { type: 'string' }, supplierName: { type: 'string', description: 'Bulk/CSV only: resolved or created by name' },
            unitCost: { type: 'number' }, price: { type: 'number' }, currentStock: { type: 'number' },
            leadTimeDays: { type: 'number' }, packSize: { type: 'number' }, minOrderQty: { type: 'number' },
          },
        },
        SaleInput: {
          type: 'object',
          properties: { sku: { type: 'string' }, productId: { type: 'string' }, qty: { type: 'number', default: 1 }, at: { type: 'integer', description: 'Unix ms; defaults to now' } },
        },
        Movement: {
          type: 'object',
          properties: { id: { type: 'string' }, productId: { type: 'string' }, sku: { type: ['string', 'null'] }, type: { type: 'string', enum: ['sale', 'receipt', 'adjustment'] }, qty: { type: 'number' }, at: { type: 'integer' }, ref: { type: 'string' } },
        },
        Recommendation: {
          type: 'object',
          properties: {
            supplierId: { type: 'string' }, supplierName: { type: 'string' },
            lines: { type: 'array', items: { type: 'object', properties: { productId: { type: 'string' }, sku: { type: 'string' }, name: { type: 'string' }, qty: { type: 'number' }, unitCost: { type: 'number' } } } },
            total: { type: 'number' }, minOrderValue: { type: 'number' },
            heldBelowMinimum: { type: 'boolean', description: 'True when total is under the supplier minimum — daemon will hold it' },
          },
        },
        PurchaseOrder: {
          type: 'object',
          properties: {
            id: { type: 'string' }, supplierId: { type: 'string' }, supplierName: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'sent', 'in_transit', 'received', 'cancelled'] },
            lines: { type: 'array', items: { type: 'object' } }, total: { type: 'number' },
            auto: { type: 'boolean', description: 'Raised by the daemon (vs manually)' },
            orderedAt: { type: 'integer' }, eta: { type: 'integer' }, etaLabel: { type: ['string', 'null'], example: 'in 2 days' },
            leadTimeDays: { type: 'number' }, sentAt: { type: 'integer' }, receivedAt: { type: 'integer' },
          },
        },
        Supplier: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' },
            leadTimeDays: { type: 'number' },
            deliveryWindows: { type: 'array', items: { type: 'integer' }, description: 'Delivery hours (0-23), e.g. [8,13,19] = 3 deliveries/day' },
            cutoffHour: { type: ['integer', 'null'], description: 'Orders after this hour start lead time tomorrow' },
            minOrderValue: { type: 'number' },
          },
        },
        SupplierInput: {
          type: 'object', required: ['name'],
          properties: {
            name: { type: 'string' }, email: { type: 'string' }, leadTimeDays: { type: 'number' },
            deliveryWindows: { oneOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'string', example: '8,13,19' }] },
            cutoffHour: { type: 'integer' }, minOrderValue: { type: 'number' },
          },
        },
        Hypothesis: {
          type: 'object',
          properties: {
            id: { type: 'string' }, note: { type: 'string' }, multiplier: { type: 'number' },
            scope: { type: 'object', properties: { productId: { type: ['string', 'null'] }, category: { type: ['string', 'null'] } } },
            startsAt: { type: 'integer' }, endsAt: { type: 'integer' },
          },
        },
        CycleSummary: {
          type: 'object',
          properties: {
            at: { type: 'integer' }, trigger: { type: 'string', enum: ['daemon', 'manual'] },
            recomputed: { type: 'integer' }, ordersCreated: { type: 'integer' }, orderLines: { type: 'integer' },
            emailsSent: { type: 'integer' }, received: { type: 'integer' },
            delistFlags: { type: 'array', items: { type: 'object' } }, notes: { type: 'array', items: { type: 'string' } },
          },
        },
        Settings: {
          type: 'object',
          properties: {
            currency: { type: 'string' }, serviceLevel: { type: 'number', description: '0-1, in-stock probability target' },
            targetDaysOfSupply: { type: 'number' }, maxDaysOfSupply: { type: 'number', description: 'JIT cap on any single order' },
            orderCost: { type: 'number' }, holdingCostRate: { type: 'number' },
            autoManage: { type: 'boolean' }, autoSend: { type: 'boolean' }, autoReceive: { type: 'boolean' }, autoEmailAlerts: { type: 'boolean' },
            daemonIntervalMinutes: { type: 'number' }, notifyEmail: { type: 'string' }, fromEmail: { type: 'string' }, companyName: { type: 'string' },
            timezone: { type: 'string', description: 'IANA store timezone, e.g. Asia/Tokyo. The dashboard formats dates and ETAs in this zone.' },
          },
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, prefix: { type: 'string', example: 'ti_a1b2c3d4' },
            key: { type: 'string', description: 'Full key — present ONLY in the POST /api/keys response' },
            createdAt: { type: 'integer' }, lastUsedAt: { type: ['integer', 'null'] }, revoked: { type: 'boolean' },
          },
        },
        Webhook: {
          type: 'object',
          properties: {
            id: { type: 'string' }, url: { type: 'string' },
            events: { type: 'array', items: { type: 'string' } },
            secret: { type: 'string', description: 'HMAC-SHA256 secret for X-Inventory-Signature verification' },
            active: { type: 'boolean' },
          },
        },
        ImportResult: {
          type: 'object',
          properties: { created: { type: 'integer' }, updated: { type: 'integer' }, suppliersCreated: { type: 'integer' }, skipped: { type: 'integer' }, errors: { type: 'array', items: { type: 'string' } } },
        },
        State: {
          type: 'object',
          properties: {
            version: { type: 'string' }, settings: ref('Settings'),
            kpis: { type: 'object', properties: { skuCount: { type: 'integer' }, stockValue: { type: 'number' }, retailValue: { type: 'number' }, lowStock: { type: 'integer' }, deadStock: { type: 'integer' }, openPOs: { type: 'integer' }, incomingUnits: { type: 'number' } } },
            products: { type: 'array', items: ref('Product') },
            suppliers: { type: 'array', items: ref('Supplier') },
            purchaseOrders: { type: 'array', items: ref('PurchaseOrder') },
            hypotheses: { type: 'array', items: ref('Hypothesis') },
            daemonLog: { type: 'array', items: ref('CycleSummary') },
            serverTime: { type: 'integer' },
          },
        },
      },
    },
  };
}

module.exports = { buildOpenApi };
