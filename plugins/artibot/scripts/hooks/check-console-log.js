#!/usr/bin/env node
/**
 * Legacy compatibility stub.
 * Original check-console-log.js was consolidated into the Stop dispatcher
 * in v4.7.2 (dev-verify-gate.js handles console.log detection now).
 * This stub exists only to satisfy in-memory Stop hook registrations
 * from sessions that loaded the v3.0.0 hooks.json before upgrade.
 * Safe to remove after all open sessions are restarted.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Direct-run guard: this stub's whole body is a process.exit(0), so an
// unguarded import terminates the importing process — the sharpest form of the
// hazard this repo's guards exist for. Guarded, importing it is inert while a
// stale in-memory hook registration still exits 0 as before.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  process.exit(0);
}
