#!/usr/bin/env node
/**
 * GRPO-RLVR Reward Backfill (Phase A4).
 *
 * Scans the active episodic store and, for every record that pre-dates the
 * v3.4 reward hook (i.e. missing a numeric `reward` field), computes a
 * best-effort verifiable reward from whatever signals the legacy record
 * carries. Idempotent: records with an existing numeric `reward` are left
 * untouched so the script can be re-run safely.
 *
 * Safety protocol:
 *   - `.corrupted.json` backup is dropped beside any episodes.json whose
 *     content fails to parse; the backfill then skips that file rather than
 *     mutating it.
 *   - `--dry-run` (default) never writes to disk; `--apply` is required to
 *     persist changes.
 *   - Writes use the shared atomic-rename primitive so partial failures
 *     cannot corrupt the store.
 *
 * CLI:
 *   node backfill.js --dry-run
 *   node backfill.js --apply
 *   node backfill.js --apply --path /custom/episodes.json
 *
 * Zero external deps. ESM.
 *
 * @module lib/learning/grpo/backfill
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, exists, readJsonFile } from '../../core/file.js';
import { ARTIBOT_DIR } from '../../core/config.js';
import { computeReward } from './reward-capture.js';

const DEFAULT_EPISODES_PATH = path.join(ARTIBOT_DIR, 'episodic', 'episodes.json');
const CORRUPT_SUFFIX = '.corrupted.json';

/**
 * @typedef {Object} BackfillReport
 * @property {string} path - episodes.json absolute path
 * @property {boolean} dryRun
 * @property {number} total - total records scanned
 * @property {number} skipped - already had a reward (idempotent skip)
 * @property {number} updated - records that received a backfilled reward
 * @property {number} errors - records that could not be scored
 * @property {boolean} corrupted - true when the source file was unparseable
 * @property {string} [backupPath] - set when corrupted
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function hasExistingReward(record) {
  return record !== null
    && record !== undefined
    && typeof record === 'object'
    && typeof record.reward === 'number'
    && Number.isFinite(record.reward);
}

/**
 * Re-score a single legacy record. Separated from `backfillFile` so unit
 * tests can exercise the reward inference without touching disk.
 *
 * @param {object} record
 * @returns {{reward: number, rewardComponents: object}|null}
 */
export function backfillRecord(record) {
  if (!record || typeof record !== 'object') return null;
  try {
    const result = computeReward(record);
    if (!result || !Number.isFinite(result.reward)) return null;
    return {
      reward: result.reward,
      rewardComponents: result.rewardComponents || {},
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Corruption handling
// ---------------------------------------------------------------------------

async function detectCorruption(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

async function dropCorruptBackup(filePath) {
  const backup = `${filePath}${CORRUPT_SUFFIX}`;
  try {
    await fs.copyFile(filePath, backup);
  } catch {
    // best-effort; caller decides next move
  }
  return backup;
}

// ---------------------------------------------------------------------------
// Core workflow
// ---------------------------------------------------------------------------

/**
 * Run backfill against a specific episodes.json path.
 *
 * @param {object} [options]
 * @param {string} [options.filePath] - Default ARTIBOT_DIR/episodic/episodes.json
 * @param {boolean} [options.apply=false] - Persist changes when true
 * @returns {Promise<BackfillReport>}
 */
export async function backfillFile({ filePath = DEFAULT_EPISODES_PATH, apply = false } = {}) {
  const report = {
    path: filePath,
    dryRun: !apply,
    total: 0,
    skipped: 0,
    updated: 0,
    errors: 0,
    corrupted: false,
  };

  if (!(await exists(filePath))) return report;

  if (await detectCorruption(filePath)) {
    report.corrupted = true;
    report.backupPath = await dropCorruptBackup(filePath);
    return report;
  }

  const raw = await readJsonFile(filePath);
  const list = Array.isArray(raw?.episodes) ? raw.episodes : [];
  report.total = list.length;
  if (list.length === 0) return report;

  const next = list.map((record) => {
    if (hasExistingReward(record)) {
      report.skipped += 1;
      return record;
    }
    const scored = backfillRecord(record);
    if (!scored) {
      report.errors += 1;
      return record;
    }
    report.updated += 1;
    return { ...record, reward: scored.reward, rewardComponents: scored.rewardComponents };
  });

  if (apply && report.updated > 0) {
    await atomicWriteJson(filePath, {
      ...raw,
      episodes: next,
      backfilledAt: new Date().toISOString(),
    });
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { apply: false, filePath: DEFAULT_EPISODES_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a === '--path' && argv[i + 1]) {
      opts.filePath = argv[i + 1];
      i += 1;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await backfillFile(opts);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.corrupted) process.exit(2);
}

// Only run when invoked directly (not when imported from tests).
const isDirectInvocation = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    process.stderr.write(`backfill failed: ${err.message}\n`);
    process.exit(1);
  });
}
