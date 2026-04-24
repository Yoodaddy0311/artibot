/**
 * First-run migration runner for v3.5 default-on flip.
 *
 * Responsibilities:
 *   1. Detect whether the hierarchical-memory migration has already run for
 *      the current plugin version.
 *   2. If not, invoke the Phase A migration helper (`memory/migrate.js`)
 *      programmatically — no external process, no network, no runtime deps.
 *   3. Persist success/failure markers to
 *        `<userScope>/migration-state.json`
 *      (default: `~/.claude/artibot/migration-state.json`).
 *   4. On failure, produce a *runtime-only* override that disables
 *      `learning.hierarchicalMemory.enabled`. The on-disk config file is NEVER
 *      mutated from here — rollback is a pure in-memory decision so users can
 *      re-enable after diagnosing.
 *
 * Idempotent: calling `checkAndMigrate` twice for the same (version, memoryDir)
 * pair is a fast no-op that returns `{status: 'already-migrated'}`.
 *
 * Zero external deps. Atomic writes only. ESM.
 *
 * @module lib/learning/migration-runner
 */

import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteJson,
  ensureDir,
  readJsonFile,
} from '../core/file.js';
import { runMigration as defaultRunMigration } from './memory/migrate.js';

const DEFAULT_STATE_FILENAME = 'migration-state.json';
const SCHEMA_VERSION = 'migration-state-v1';

/**
 * Status values reported by `checkAndMigrate`.
 * @typedef {'migrated'|'already-migrated'|'failed'|'skipped'} MigrationStatus
 */

/**
 * Result returned by `checkAndMigrate`.
 * @typedef {object} MigrationCheckResult
 * @property {MigrationStatus} status
 * @property {string} fromVersion
 * @property {string} toVersion
 * @property {boolean} rollback - true if caller should disable hierarchical memory at runtime
 * @property {string} [error]
 * @property {number} [tagged]
 * @property {string} statePath
 */

/**
 * Expand `~` / `~/` prefixes to the user home directory. Leaves absolute and
 * relative paths untouched.
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve the absolute path to the migration-state.json.
 * @param {string} userScope
 * @param {string} [filename]
 * @returns {string}
 */
function resolveStatePath(userScope, filename = DEFAULT_STATE_FILENAME) {
  return path.join(expandHome(userScope), filename);
}

/**
 * Resolve the memory directory. Phase A migration expects the four legacy JSON
 * files to live directly under the user memory scope.
 * @param {string} userScope
 * @returns {string}
 */
function resolveMemoryDir(userScope) {
  return expandHome(userScope);
}

/**
 * Load existing migration-state.json, returning `null` when missing or
 * structurally unusable. Any I/O error is treated as "no state recorded yet"
 * so a broken state file cannot block a retry.
 * @param {string} statePath
 * @returns {Promise<object|null>}
 */
async function loadState(statePath) {
  try {
    const raw = await readJsonFile(statePath);
    if (!raw || typeof raw !== 'object') return null;
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Persist a new migration-state record atomically.
 * @param {string} statePath
 * @param {object} record
 * @returns {Promise<void>}
 */
async function saveState(statePath, record) {
  await ensureDir(path.dirname(statePath));
  await atomicWriteJson(statePath, {
    schemaVersion: SCHEMA_VERSION,
    ...record,
  });
}

/**
 * Decide whether a previously-recorded state matches the target version.
 * @param {object|null} state
 * @param {string} targetVersion
 * @returns {boolean}
 */
function isUpToDate(state, targetVersion) {
  if (!state) return false;
  if (state.outcome !== 'success') return false;
  return state.version === targetVersion;
}

/**
 * Core entry point — runs on plugin start-up via the upgrade-check middleware.
 *
 * @param {object} options
 * @param {string} options.targetVersion - semver from artibot.config.json
 * @param {string} options.userScope      - learning.memoryScopes.user (e.g. `~/.claude/artibot/`)
 * @param {boolean} [options.hierarchicalEnabled] - config value at entry; used only to short-circuit
 *                                                   when the user has explicitly opted out.
 * @param {(msg: string) => void} [options.logger] - user-friendly progress logger
 * @param {(msg: string) => void} [options.errorLogger] - stderr-style error logger
 * @param {typeof defaultRunMigration} [options.runMigration] - injection seam
 * @param {() => number} [options.now]
 * @returns {Promise<MigrationCheckResult>}
 */
export async function checkAndMigrate(options = {}) {
  const {
    targetVersion,
    userScope,
    hierarchicalEnabled = true,
    logger = () => {},
    errorLogger = () => {},
    runMigration = defaultRunMigration,
    now = () => Date.now(),
  } = options;

  if (!targetVersion || typeof targetVersion !== 'string') {
    throw new Error('checkAndMigrate: targetVersion required');
  }
  if (!userScope || typeof userScope !== 'string') {
    throw new Error('checkAndMigrate: userScope required');
  }

  const statePath = resolveStatePath(userScope);
  const memoryDir = resolveMemoryDir(userScope);
  const iso = new Date(now()).toISOString();

  const existing = await loadState(statePath);
  const fromVersion = existing?.version || 'none';

  // User explicitly opted out — do not migrate, do not touch state.
  if (hierarchicalEnabled === false) {
    return {
      status: 'skipped',
      fromVersion,
      toVersion: targetVersion,
      rollback: false,
      statePath,
    };
  }

  if (isUpToDate(existing, targetVersion)) {
    return {
      status: 'already-migrated',
      fromVersion,
      toVersion: targetVersion,
      rollback: false,
      statePath,
    };
  }

  logger('Upgrading memory to 3-layer architecture...');

  try {
    const { reports, totalTagged } = await runMigration({ memoryDir, now });
    await saveState(statePath, {
      version: targetVersion,
      previousVersion: fromVersion,
      migratedAt: iso,
      outcome: 'success',
      totalTagged,
      reports: reports.map((r) => ({
        file: path.basename(r.file ?? ''),
        status: r.status,
        tagged: r.tagged,
        total: r.total,
      })),
    });
    logger(`Memory upgrade complete (${totalTagged} entries tagged).`);
    return {
      status: 'migrated',
      fromVersion,
      toVersion: targetVersion,
      rollback: false,
      tagged: totalTagged,
      statePath,
    };
  } catch (err) {
    const message = err?.message ?? String(err);
    errorLogger(`Memory upgrade failed: ${message}. Falling back to flat memory.`);
    await saveState(statePath, {
      version: targetVersion,
      previousVersion: fromVersion,
      migratedAt: iso,
      outcome: 'failed',
      error: message,
    }).catch(() => {
      /* ignore — state write failure must not mask the original error */
    });
    return {
      status: 'failed',
      fromVersion,
      toVersion: targetVersion,
      rollback: true,
      error: message,
      statePath,
    };
  }
}

/**
 * Convenience factory so callers can capture dependencies once (logger, runner)
 * and reuse the resulting function across sessions.
 *
 * @param {object} deps
 * @returns {(opts: Omit<Parameters<typeof checkAndMigrate>[0], keyof deps>) => Promise<MigrationCheckResult>}
 */
export function createMigrationRunner(deps = {}) {
  return async function runner(opts = {}) {
    return checkAndMigrate({ ...deps, ...opts });
  };
}

export const __internals = Object.freeze({
  expandHome,
  resolveStatePath,
  resolveMemoryDir,
  loadState,
  saveState,
  isUpToDate,
  SCHEMA_VERSION,
  DEFAULT_STATE_FILENAME,
});
