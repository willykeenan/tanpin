#!/usr/bin/env node
'use strict';
// The daemon — the "never-sleeping store manager". On a fixed interval it runs
// a full auto-management cycle (forecast → reorder → order → email → receive).
//
// Two ways to run it:
//   * In-process: server.js calls startDaemon() so one command boots everything.
//   * Standalone: `tanpin daemon` (or `node src/daemon.js`) runs only the
//     daemon against the same data file — resolved exactly like `tanpin serve`
//     (TANPIN_DATA_DIR / TANPIN_DB / TANPIN_OUTBOX, see src/config.js) — e.g.
//     under systemd / pm2 / a container, separate from the web tier.
//
// Webhook deliveries from the daemon go through engine/webhooks.js, which
// applies DEMO_MODE and the SSRF guard itself.

const path = require('node:path');

function startDaemon(store, { onTick, intervalMs } = {}) {
  const manager = require('./engine/manager');
  let running = false;
  const tick = async () => {
    if (running) return;            // never overlap cycles
    running = true;
    try {
      // Pick up changes written by the web tier (merged in place; with the
      // in-process daemon this is a no-op because the store is shared).
      if (typeof store.refresh === 'function') store.refresh();
      else store.load();
      store.outboxDir = store.outboxDir || path.join(process.cwd(), 'outbox');
      const summary = await manager.runCycle(store, { trigger: 'daemon' });
      if (onTick) onTick(summary);
    } catch (e) {
      console.error('[daemon] cycle error:', e && e.message || e);
    } finally {
      running = false;
    }
  };

  const minutes = store.data.settings.daemonIntervalMinutes || 15;
  const ms = intervalMs || Math.max(60000, minutes * 60000);
  const timer = setInterval(tick, ms);
  if (timer.unref) timer.unref(); // don't keep a standalone process alive by itself
  const first = tick(); // run one immediately on boot
  return { stop: () => clearInterval(timer), tick, first };
}

/**
 * Standalone entry point (`tanpin daemon`). Returns the daemon handle; the
 * process stays alive until SIGINT/SIGTERM.
 */
function main({ env = process.env, log = console.log } = {}) {
  const { resolveConfig } = require('./config');
  const { Store } = require('./engine/store');
  const config = resolveConfig(env);
  const store = new Store(config.dbFile);
  store.load();
  store.outboxDir = config.outboxDir;
  log(`[daemon] standalone, db=${store.sqliteFile || store.file}, outbox=${config.outboxDir}, interval=${store.data.settings.daemonIntervalMinutes}min${env.DEMO_MODE === '1' ? ', demo mode (no webhooks/SMTP)' : ''}`);
  if (env.DEMO_MODE === '1') delete env.SMTP_HOST;
  const handle = startDaemon(store, {
    onTick: (s) => log(`[daemon] ${new Date(s.at).toISOString()} — ${s.ordersCreated} orders, ${s.emailsSent} emails, ${s.received} received, ${s.delistFlags.length} delist flags`),
  });
  // Keep the standalone process alive (the interval is unref'd above).
  const keepAlive = setInterval(() => {}, 1 << 30);
  const stop = () => { handle.stop(); clearInterval(keepAlive); try { store.close(); } catch { /* ignore */ } process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { ...handle, store, config };
}

if (require.main === module) main();

module.exports = { startDaemon, main };
