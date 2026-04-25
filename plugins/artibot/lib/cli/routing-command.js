/**
 * `artibot routing {status|rollback|enable|disable}` command.
 *
 * Thin, local-only admin surface for the GRPO-RLVR routing feature. Never
 * touches the network. `rollback` moves the policy file to its prior snapshot;
 * `status` prints the current configuration + policy metadata; `enable` /
 * `disable` patch the `learning.grpoRouting.enabled` flag in
 * `artibot.config.json`. All failures are reported as typed errors, never
 * thrown into the CLI shell.
 *
 * @module lib/cli/routing-command
 */

import path from 'node:path';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { getHomeDir, getPluginRoot } from '../core/platform.js';
import {
  getGrpoRoutingConfig,
  resetGrpoRoutingConfigCache,
} from '../cognitive/grpo-routing-config.js';
import { resetRoutingBiasCache } from '../cognitive/grpo-bridge.js';

const SUBCOMMANDS = Object.freeze(['status', 'rollback', 'enable', 'disable']);

/** Policies directory used by the Phase B updater. */
function policiesDir() {
  return path.join(getHomeDir(), '.claude', 'artibot', 'policies');
}

/** Snapshot directory holding N prior `theta` files. */
function snapshotsDir() {
  return path.join(policiesDir(), 'snapshots');
}

/** Path to the live routing policy file. */
function policyFilePath(configPolicyPath) {
  if (typeof configPolicyPath === 'string' && configPolicyPath.length > 0) {
    return configPolicyPath.replace(/^~(?=\/|\\|$)/, getHomeDir());
  }
  return path.join(policiesDir(), 'routing-policy-v1.json');
}

/** Read JSON with safe fallback. */
async function readJson(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Return the parsed `status` payload — used by both the CLI and tests.
 * @returns {Promise<{ enabled: boolean, policyPath: string, policy: object|null, snapshots: string[], config: object }>}
 */
export async function collectRoutingStatus() {
  const config = await getGrpoRoutingConfig({ force: true });
  const policyPath = policyFilePath(config.policyPath);
  const policy = await readJson(policyPath);
  let snapshots;
  try {
    const entries = await readdir(snapshotsDir());
    snapshots = entries.filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    snapshots = [];
  }
  return { enabled: config.enabled, policyPath, policy, snapshots, config };
}

/**
 * Promote a snapshot back to live. `n=0` is the most recent snapshot.
 * @param {number} n
 * @returns {Promise<{ ok: boolean, from?: string, to?: string, reason?: string }>}
 */
export async function rollbackPolicy(n = 0) {
  const config = await getGrpoRoutingConfig({ force: true });
  const target = policyFilePath(config.policyPath);
  let entries;
  try {
    entries = (await readdir(snapshotsDir())).filter((f) => f.endsWith('.json'));
  } catch {
    return { ok: false, reason: 'no-snapshots' };
  }
  if (entries.length === 0) return { ok: false, reason: 'no-snapshots' };
  entries.sort();
  entries.reverse(); // newest first
  const idx = Math.max(0, Math.min(entries.length - 1, Math.floor(n)));
  const source = path.join(snapshotsDir(), entries[idx]);
  try {
    await copyFile(source, target);
    resetRoutingBiasCache();
    return { ok: true, from: source, to: target };
  } catch (err) {
    return { ok: false, reason: `copy-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Flip `learning.grpoRouting.enabled` in `artibot.config.json` in place.
 * Atomic-ish: reads, patches, writes. If the config lacks the block entirely,
 * creates a minimal stub. Never touches unrelated fields.
 * @param {boolean} enabled
 * @returns {Promise<{ ok: boolean, previous: boolean, current: boolean, reason?: string }>}
 */
export async function setEnabled(enabled) {
  const configPath = path.join(getPluginRoot(), 'artibot.config.json');
  const raw = await readJson(configPath);
  if (!raw || typeof raw !== 'object') {
    return { ok: false, previous: false, current: false, reason: 'config-missing' };
  }
  const learning = (raw.learning && typeof raw.learning === 'object') ? raw.learning : {};
  const block = (learning.grpoRouting && typeof learning.grpoRouting === 'object')
    ? learning.grpoRouting : {};
  const previous = block.enabled === true;
  const next = {
    ...raw,
    learning: { ...learning, grpoRouting: { ...block, enabled: Boolean(enabled) } },
  };
  try {
    await writeFile(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    resetGrpoRoutingConfigCache();
    return { ok: true, previous, current: Boolean(enabled) };
  } catch (err) {
    return {
      ok: false, previous, current: previous,
      reason: `write-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Entrypoint — parses argv and dispatches. Returns a plain result object so
 * callers can print it however they want. Never calls `process.exit`.
 *
 * @param {string[]} argv - Positional args, e.g. `['status']` or `['rollback', '1']`.
 * @returns {Promise<{ subcommand: string, ok: boolean, result?: object, error?: string }>}
 */
export async function runRoutingCommand(argv = []) {
  const sub = (argv[0] || 'status').toLowerCase();
  if (!SUBCOMMANDS.includes(sub)) {
    return {
      subcommand: sub, ok: false,
      error: `unknown subcommand: ${sub} (expected one of ${SUBCOMMANDS.join(', ')})`,
    };
  }
  if (sub === 'status') {
    return { subcommand: sub, ok: true, result: await collectRoutingStatus() };
  }
  if (sub === 'rollback') {
    const n = Number.parseInt(argv[1] ?? '0', 10);
    const r = await rollbackPolicy(Number.isFinite(n) ? n : 0);
    return { subcommand: sub, ok: r.ok, result: r };
  }
  if (sub === 'enable' || sub === 'disable') {
    const r = await setEnabled(sub === 'enable');
    return { subcommand: sub, ok: r.ok, result: r };
  }
  return { subcommand: sub, ok: false, error: 'unreachable' };
}

/** Exported for test introspection. */
export { SUBCOMMANDS };
