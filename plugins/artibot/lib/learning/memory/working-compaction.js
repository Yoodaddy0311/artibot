/**
 * Working-memory compaction hooks.
 *
 * Design reference: _design/hierarchical-memory-2026-04-24.md Section 5.3 C3
 * and Section 9 R3. Ensures Working state is not silently dropped when the
 * runtime triggers compaction or the host process exits.
 *
 * Exposed helpers:
 *   - onCompactionStart(ctx) — called BEFORE summarization middleware starts
 *     compacting prompt history. Forces a Working flush so important signals
 *     survive into the Episodic layer.
 *   - onBeforeExit(ctx)     — flushes Working before the Node.js process
 *     exits (beforeExit/SIGINT/SIGTERM).
 *   - registerProcessHandlers(store, opts) — opt-in installer that wires
 *     beforeExit/signal handlers to a flush. Returns an `unregister` fn.
 *
 * Every accepted flush appends one line to `runtime/compaction-survival.log`
 * for observability. Log path is injectable for tests.
 *
 * Zero runtime deps. No dynamic imports at module load — optional plugin-root
 * resolution is lazy and wrapped in try/catch so isolated test runs work.
 *
 * @module lib/learning/memory/working-compaction
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir } from '../../core/file.js';
import { getPluginRoot } from '../../core/platform.js';

// ---------------------------------------------------------------------------
// Log-path resolution
// ---------------------------------------------------------------------------

function defaultLogPath() {
  try {
    const root = typeof getPluginRoot === 'function' ? getPluginRoot() : process.cwd();
    return path.join(root, 'runtime', 'compaction-survival.log');
  } catch {
    return path.join(process.cwd(), 'runtime', 'compaction-survival.log');
  }
}

async function appendSurvivalLog(logPath, line) {
  if (!logPath) return;
  try {
    await ensureDir(path.dirname(logPath));
    await fs.appendFile(logPath, `${JSON.stringify(line)}\n`, 'utf-8');
  } catch {
    /* best-effort logging — never block flush on log IO */
  }
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

/**
 * Called before compaction. Flushes Working to Episodic.
 *
 * @param {object} ctx
 * @param {import('./working.js').createWorkingStore} ctx.workingStore
 * @param {object} [ctx.episodicStore] - Optional; if missing, working.flush
 *   still clears and scores but cannot promote.
 * @param {{info?: Function, warn?: Function}} [ctx.logger]
 * @param {string} [ctx.logPath]
 * @returns {Promise<{flushedCount: number, kept: number, importanceScore: number, promoted: boolean}>}
 */
export async function onCompactionStart(ctx = {}) {
  const { workingStore, logger, logPath } = ctx;
  if (!workingStore || typeof workingStore.flush !== 'function') {
    return Object.freeze({
      flushedCount: 0,
      kept: 0,
      importanceScore: 0,
      promoted: false,
      skipReason: 'no-store',
    });
  }
  const pre = typeof workingStore.snapshot === 'function'
    ? workingStore.snapshot()
    : { entries: [] };
  const before = pre.entries?.length ?? 0;
  const result = await workingStore.flush({ reason: 'compaction' });
  const resolvedLog = logPath || defaultLogPath();
  await appendSurvivalLog(resolvedLog, {
    ts: new Date().toISOString(),
    reason: 'compaction',
    flushedCount: before,
    kept: 0,
    importanceScore: result?.importanceScore ?? 0,
    promoted: !!result?.promoted,
  });
  logger?.info?.(`[working-compaction] flushed=${before} promoted=${!!result?.promoted}`);
  return Object.freeze({
    flushedCount: before,
    kept: 0,
    importanceScore: result?.importanceScore ?? 0,
    promoted: !!result?.promoted,
    skipReason: result?.skipReason ?? null,
  });
}

/**
 * Final flush before process exit.
 *
 * @param {object} ctx
 * @param {import('./working.js').createWorkingStore} ctx.workingStore
 * @param {{info?: Function, warn?: Function}} [ctx.logger]
 * @param {string} [ctx.logPath]
 * @returns {Promise<{flushedCount: number, promoted: boolean}>}
 */
export async function onBeforeExit(ctx = {}) {
  const { workingStore, logger, logPath } = ctx;
  if (!workingStore || typeof workingStore.flush !== 'function') {
    return Object.freeze({ flushedCount: 0, promoted: false });
  }
  const pre = typeof workingStore.snapshot === 'function'
    ? workingStore.snapshot()
    : { entries: [] };
  const before = pre.entries?.length ?? 0;
  if (before === 0) {
    return Object.freeze({ flushedCount: 0, promoted: false });
  }
  const result = await workingStore.flush({ reason: 'beforeExit' });
  const resolvedLog = logPath || defaultLogPath();
  await appendSurvivalLog(resolvedLog, {
    ts: new Date().toISOString(),
    reason: 'beforeExit',
    flushedCount: before,
    kept: 0,
    importanceScore: result?.importanceScore ?? 0,
    promoted: !!result?.promoted,
  });
  logger?.info?.(`[working-compaction] beforeExit flushed=${before}`);
  return Object.freeze({
    flushedCount: before,
    promoted: !!result?.promoted,
  });
}

// ---------------------------------------------------------------------------
// Process-level opt-in handler registration
// ---------------------------------------------------------------------------

/**
 * Install process beforeExit / SIGINT / SIGTERM handlers that flush the
 * Working store. Returns a disposer that removes the handlers (for tests).
 *
 * @param {object} options
 * @param {import('./working.js').createWorkingStore} options.workingStore
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @param {string} [options.logPath]
 * @param {NodeJS.Process} [options.proc] - injectable for tests
 * @returns {() => void} unregister
 */
export function registerProcessHandlers(options = {}) {
  const proc = options.proc || process;
  const { workingStore, logger, logPath } = options;
  if (!workingStore) return () => {};

  let fired = false;
  const wrapped = () => {
    if (fired) return undefined;
    fired = true;
    return onBeforeExit({ workingStore, logger, logPath }).catch(() => {});
  };

  proc.on('beforeExit', wrapped);
  proc.on('SIGINT', wrapped);
  proc.on('SIGTERM', wrapped);

  return () => {
    try { proc.removeListener('beforeExit', wrapped); } catch { /* */ }
    try { proc.removeListener('SIGINT', wrapped); } catch { /* */ }
    try { proc.removeListener('SIGTERM', wrapped); } catch { /* */ }
  };
}
