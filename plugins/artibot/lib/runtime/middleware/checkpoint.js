/**
 * Runtime checkpoint middleware.
 * Persists lightweight checkpoint snapshots to memory and disk for resume/inspection.
 *
 * @module lib/runtime/middleware/checkpoint
 */

import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolveArtibotDir } from '../../core/config.js';

function buildCheckpointId(nowFn) {
  const ts = nowFn();
  return `ckpt-${ts.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Resolved per call, not from the `ARTIBOT_DIR` constant. Same path in
// production; the difference is that a test can redirect it, which it could not
// before — this middleware is in the DEFAULT pipeline, so every `preparePrompt`
// test was persisting a checkpoint into the developer's own state file.
function getDefaultCheckpointPath() {
  return path.join(resolveArtibotDir(), 'runtime', 'checkpoints.json');
}

/**
 * Read the checkpoint log.
 *
 * The store is ndjson — one checkpoint per line — so the cap is a READ-side
 * view rather than something the writer enforces. That is what makes the write
 * path safe: see `persistCheckpoint`.
 *
 * Malformed lines are skipped rather than thrown on. A line can be malformed
 * only if a write was torn, which `appendFileSync` makes vanishingly unlikely
 * at these sizes; dropping one is still better than failing every read.
 *
 * Files written before the ndjson switch are a single `{ entries: [...] }`
 * object. Those are still readable — without this branch a legacy store would
 * parse as zero lines and look like silent data loss.
 *
 * @param {string} filePath
 * @param {{ tail?: number }} [opts] - `tail` returns only the newest N.
 * @returns {object[]} checkpoints, oldest first
 */
export function readCheckpoints(filePath, opts = {}) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');

  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch { /* torn or legacy line — skip */ }
  }

  // Legacy single-object store: no line parsed, but the whole file might.
  if (entries.length === 0 && raw.trim()) {
    try {
      const legacy = JSON.parse(raw);
      if (Array.isArray(legacy?.entries)) entries.push(...legacy.entries);
    } catch { /* not legacy either — leave empty */ }
  }

  const { tail } = opts;
  if (Number.isInteger(tail) && tail > 0) return entries.slice(-tail);
  return entries;
}

function buildCheckpoint(state, id, nowFn) {
  return {
    id,
    createdAt: new Date(nowFn()).toISOString(),
    routing: state.context.routing?.system || null,
    routingScore: state.context.routing?.score ?? null,
    intent: state.context.intent?.best || null,
    taskMode: state.context.tasks?.mode || null,
    taskId: state.context.tasks?.id || null,
    delegationMode: state.context.subagents?.contract?.mode || null,
  };
}

function trimStore(store, maxEntries) {
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

/**
 * Append one checkpoint as a JSON line.
 *
 * APPEND-ONLY, DELIBERATELY. This used to read the whole store, push one entry,
 * and write the whole store back. Two processes that interleave those three
 * steps both start from the same snapshot and the later write erases the
 * earlier one's entry. This middleware is in the DEFAULT pipeline, so that
 * collision happened on ordinary use, not under stress: measured 2026-08-30
 * with 6 processes x 10 writes, only 17/18/19 of 60 entries survived across
 * three runs.
 *
 * A single `appendFileSync` is one write(2) with O_APPEND, so the kernel
 * serialises concurrent appends and no reader-writer window exists to lose.
 * `lib/observability/run-events.js#appendRunEvent` and `decision-events.js`
 * already store this way.
 *
 * Cost of the change: the writer no longer enforces `maxEntries`, so the file
 * grows with use and the cap moved to `readCheckpoints`. Unlike run-events and
 * decision-events — which key their files by runId and are therefore bounded by
 * one session — this is a single global store, so nothing bounds it over time.
 * Keying it per session would fix that and is NOT done here; this change is
 * scoped to the concurrency defect.
 *
 * @param {string} filePath
 * @param {object} checkpoint
 * @returns {void}
 */
function persistCheckpoint(filePath, checkpoint) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(checkpoint)}\n`, 'utf-8');
}

/**
 * @param {object} [options]
 * @param {Map<string, object>} [options.store] - Optional external checkpoint store.
 * @param {number} [options.maxEntries=100]
 * @param {() => number} [options.now]
 * @param {boolean} [options.persistToDisk=true]
 * @param {string} [options.filePath]
 * @returns {(state: object) => Promise<object>}
 */
export function createCheckpointMiddleware(options = {}) {
  const store = options.store || new Map();
  const maxEntries = options.maxEntries ?? 100;
  const now = options.now || Date.now;
  const persistToDisk = options.persistToDisk ?? true;
  const filePath = options.filePath || getDefaultCheckpointPath();

  return async function checkpointMiddleware(state) {
    const id = buildCheckpointId(now);
    const checkpoint = buildCheckpoint(state, id, now);

    store.set(id, checkpoint);
    trimStore(store, maxEntries);

    let persisted = true;
    let error = null;

    if (persistToDisk) {
      try {
        persistCheckpoint(filePath, checkpoint);
      } catch (cause) {
        persisted = false;
        error = cause?.message || String(cause);
      }
    }

    // In-memory store size, not a count of what is on disk. Counting the disk
    // store would mean reading a file that now grows with use, on every prompt.
    // Nothing consumes this field (measured: zero references outside this
    // module); `readCheckpoints()` is the supported way to see the disk view.
    const persistedEntries = store.size;

    state.context.checkpoint = {
      id,
      persisted,
      filePath: persistToDisk ? filePath : null,
      storeSize: store.size,
      persistedEntries,
      error,
    };
    state.messageParts.push(`ckpt=${id.slice(-5)}`);

    return state;
  };
}
