#!/usr/bin/env node
// Minimal webhook receiver with signature verification. Register it with:
//
//   curl -X POST http://localhost:4173/api/webhooks \
//     -d '{"url": "http://localhost:9999/hook", "secret": "my-secret", "events": ["*"]}'
//
// Then watch events arrive as the store operates. Zero dependencies.

const http = require('http');
const crypto = require('crypto');

const SECRET = process.env.WEBHOOK_SECRET || 'my-secret';
const PORT = Number(process.env.PORT || 9999);

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const given = req.headers['x-inventory-signature'] || '';
    const valid = given.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!valid) {
      console.warn('✗ rejected: bad signature');
      res.writeHead(401); return res.end();
    }
    const { event, data } = JSON.parse(body);
    console.log(`✓ ${event}`, JSON.stringify(data).slice(0, 140));
    res.writeHead(200); res.end('ok');
  });
}).listen(PORT, () => console.log(`Webhook receiver listening on :${PORT} (secret: ${SECRET})`));
