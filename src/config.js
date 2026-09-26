'use strict';
// Runtime configuration, resolved from environment variables. The CLI
// (bin/tanpin) maps its flags onto these variables before loading anything,
// so every entry point (server, daemon, seed) agrees on where data lives.
//
//   TANPIN_DATA_DIR  directory for runtime state        (default ./data)
//   TANPIN_DB        the JSON data file                 (default $TANPIN_DATA_DIR/inventory.json)
//   TANPIN_OUTBOX    where unsent mail is written       (default <dir of TANPIN_DB>/outbox)
//   PORT             HTTP port for `tanpin serve`       (default 4173)
//   HOST             bind address                       (default: all interfaces)

const path = require('node:path');

const DEFAULT_PORT = 4173;

function resolveConfig(env = process.env) {
  const dataDir = path.resolve(env.TANPIN_DATA_DIR || 'data');
  const dbFile = env.TANPIN_DB ? path.resolve(env.TANPIN_DB) : path.join(dataDir, 'inventory.json');
  const outboxDir = env.TANPIN_OUTBOX ? path.resolve(env.TANPIN_OUTBOX) : path.join(path.dirname(dbFile), 'outbox');
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT "${env.PORT}" — expected an integer 0-65535`);
  }
  return { dataDir, dbFile, outboxDir, port, host: env.HOST || undefined };
}

module.exports = { resolveConfig, DEFAULT_PORT };
