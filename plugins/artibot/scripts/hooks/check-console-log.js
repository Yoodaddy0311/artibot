#!/usr/bin/env node
/**
 * Legacy compatibility stub.
 * Original check-console-log.js was consolidated into the Stop dispatcher
 * in v4.7.2 (dev-verify-gate.js handles console.log detection now).
 * This stub exists only to satisfy in-memory Stop hook registrations
 * from sessions that loaded the v3.0.0 hooks.json before upgrade.
 * Safe to remove after all open sessions are restarted.
 */
process.exit(0);
