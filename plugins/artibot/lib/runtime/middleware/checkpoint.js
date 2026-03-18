/**
 * Runtime checkpoint middleware.
 * Persists lightweight checkpoint snapshots to memory and disk for resume/inspection.
 *
 * @module lib/runtime/middleware/checkpoint
 */

import path from 'node:path';
import { ARTIBOT_DIR } from '../../core/config.js';
import { readJsonFile, writeJsonFile } from '../../core/file.js';

function buildCheckpointId(nowFn) {
  const ts = nowFn();
  return `ckpt-${ts.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getDefaultCheckpointPath() {
  return path.join(ARTIBOT_DIR, 'runtime', 'checkpoints.json');
}

function trimEntries(entries, maxEntries) {
  if (entries.length <= maxEntries) return entries;
  return entries.slice(-maxEntries);
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

async function persistCheckpoint(filePath, checkpoint, maxEntries) {
  const existing = await readJsonFile(filePath);
  const existingEntries = Array.isArray(existing?.entries) ? existing.entries : [];
  const entries = trimEntries([...existingEntries, checkpoint], maxEntries);

  await writeJsonFile(filePath, {
    entries,
    metadata: {
      updatedAt: checkpoint.createdAt,
    },
  });

  return entries.length;
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
    let persistedEntries = store.size;
    let error = null;

    if (persistToDisk) {
      try {
        persistedEntries = await persistCheckpoint(filePath, checkpoint, maxEntries);
      } catch (cause) {
        persisted = false;
        error = cause?.message || String(cause);
      }
    }

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
