/**
 * Persistence + snapshot management for the agent-selection GRPO policy.
 *
 * Split out of `agent-policy.js` to keep each file under 800 lines. Handles
 * path resolution, atomic-ish write, snapshot rotation (N retention),
 * loading, listing, and prune. No math, no policy semantics — pure storage.
 *
 * Storage root: `~/.claude/artibot/policies/agent-policy-v1.json` + sibling
 * `agent-snapshots/` directory for N-rotation.
 *
 * @module lib/learning/grpo/agent-policy-store
 */

import path from 'node:path';
import { ensureDir, readJsonFile, writeJsonFile } from '../../core/file.js';
import { getHomeDir } from '../../core/platform.js';

export const POLICY_VERSION = 1;
export const MODEL_TYPE = 'softmax-weights';

/**
 * Resolve the canonical agent-policy paths. Absolute `policyPath` overrides
 * are honored; otherwise defaults to `~/.claude/artibot/policies/agent-policy-v1.json`.
 *
 * @param {string} [policyPath]
 * @returns {{ policyFile: string, snapshotDir: string }}
 */
export function resolvePolicyPaths(policyPath) {
  const file = policyPath && path.isAbsolute(policyPath)
    ? policyPath
    : path.join(getHomeDir(), '.claude', 'artibot', 'policies', 'agent-policy-v1.json');
  const dir = path.dirname(file);
  return { policyFile: file, snapshotDir: path.join(dir, 'agent-snapshots') };
}

/**
 * Build a snapshot id. Deterministic under NODE_ENV=test (pid-suffixed) so
 * parallel vitest workers do not collide on the same string.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function makeSnapshotId(now = new Date()) {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const suffix = process.env.NODE_ENV === 'test'
    ? `${process.pid}`
    : Math.random().toString(36).slice(2, 8);
  return `agent-v${POLICY_VERSION}-${iso}-${suffix}`;
}

function round6(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1e6) / 1e6;
}

function cloneWeights(weights) {
  if (!weights || typeof weights !== 'object') return {};
  const out = {};
  for (const fam of Object.keys(weights)) {
    const inner = weights[fam];
    if (inner && typeof inner === 'object') out[fam] = { ...inner };
  }
  return out;
}

/**
 * Load the current agent policy from disk. Returns `null` on missing or
 * malformed file. Never throws.
 *
 * @param {string} [policyPath]
 * @returns {Promise<object|null>}
 */
export async function loadPolicy(policyPath) {
  const { policyFile } = resolvePolicyPaths(policyPath);
  const data = await readJsonFile(policyFile);
  if (!data || typeof data !== 'object') return null;
  if (!data.weights || typeof data.weights !== 'object') return null;
  return data;
}

/**
 * Atomic-ish write of policy record + rotating snapshot.
 * Keeps the newest `snapshotCount` snapshots, prunes the rest.
 *
 * @param {Record<string, Record<string, number>>} weights
 * @param {object} metrics
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @param {number} [options.trainedOnEpisodes]
 * @param {string|null} [options.previousSnapshotId]
 * @param {number} [options.snapshotCount=3]
 * @returns {Promise<{ policy: object, snapshotId: string, policyFile: string }>}
 */
export async function savePolicy(weights, metrics, options = {}) {
  const { policyFile, snapshotDir } = resolvePolicyPaths(options.policyPath);
  const snapshotCount = options.snapshotCount ?? 3;
  await ensureDir(path.dirname(policyFile));
  await ensureDir(snapshotDir);

  const snapshotId = makeSnapshotId();
  const policy = {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    weights: cloneWeights(weights),
    trainedAt: new Date().toISOString(),
    trainedOnEpisodes: options.trainedOnEpisodes ?? 0,
    metrics: {
      logLoss: round6(metrics?.logLoss ?? 0),
      accuracyVsBaseline: round6(metrics?.accuracyVsBaseline ?? 0),
      klFromPrev: round6(metrics?.klFromPrev ?? 0),
    },
    previousSnapshotId: options.previousSnapshotId ?? null,
    snapshotId,
  };

  await writeJsonFile(policyFile, policy);
  await writeJsonFile(path.join(snapshotDir, `${snapshotId}.json`), policy);
  await pruneSnapshots(snapshotDir, snapshotCount);
  return { policy, snapshotId, policyFile };
}

/**
 * Write a standalone snapshot. Useful for rollback fixtures and tests.
 *
 * @param {Record<string, Record<string, number>>} weights
 * @param {string} id
 * @param {string} [policyPath]
 * @returns {Promise<string>} absolute snapshot file path
 */
export async function snapshot(weights, id, policyPath) {
  const { snapshotDir } = resolvePolicyPaths(policyPath);
  await ensureDir(snapshotDir);
  const file = path.join(snapshotDir, `${id}.json`);
  await writeJsonFile(file, {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    weights: cloneWeights(weights),
    trainedAt: new Date().toISOString(),
    snapshotId: id,
  });
  return file;
}

/**
 * List snapshots newest-first (by `trainedAt`). Malformed files are skipped.
 *
 * @param {string} [policyPath]
 * @returns {Promise<Array<{ id:string, file:string, trainedAt:string, weights:object }>>}
 */
export async function listSnapshots(policyPath) {
  const { snapshotDir } = resolvePolicyPaths(policyPath);
  const fs = await import('node:fs/promises');
  let entries;
  try {
    entries = await fs.readdir(snapshotDir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(snapshotDir, name);
    const data = await readJsonFile(file);
    if (!data || !data.weights || typeof data.weights !== 'object') continue;
    records.push({
      id: data.snapshotId ?? name.replace(/\.json$/, ''),
      file,
      trainedAt: data.trainedAt ?? '',
      weights: data.weights,
    });
  }
  records.sort((a, b) => (b.trainedAt || '').localeCompare(a.trainedAt || ''));
  return records;
}

/**
 * Overwrite the policy file with a snapshot's weights (for `rollback`).
 *
 * @param {string|undefined} policyPath
 * @param {{ id:string, weights:object }} target
 * @param {string|null} rolledBackFromId
 * @returns {Promise<void>}
 */
export async function writeRolledBackPolicy(policyPath, target, rolledBackFromId) {
  const { policyFile } = resolvePolicyPaths(policyPath);
  await writeJsonFile(policyFile, {
    version: POLICY_VERSION,
    modelType: MODEL_TYPE,
    weights: cloneWeights(target.weights),
    trainedAt: new Date().toISOString(),
    rolledBackFrom: rolledBackFromId,
    rolledBackTo: target.id,
    snapshotId: target.id,
  });
}

async function pruneSnapshots(snapshotDir, retain) {
  const fs = await import('node:fs/promises');
  let entries;
  try {
    entries = await fs.readdir(snapshotDir);
  } catch {
    return;
  }
  const files = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(snapshotDir, name);
    try {
      const stat = await fs.stat(full);
      files.push({ full, mtime: stat.mtimeMs });
    } catch {
      // skip
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const toDelete = files.slice(Math.max(0, retain));
  for (const f of toDelete) {
    try {
      await fs.unlink(f.full);
    } catch {
      // best-effort
    }
  }
}
