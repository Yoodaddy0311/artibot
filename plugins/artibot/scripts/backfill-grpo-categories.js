#!/usr/bin/env node
/**
 * Stage C #1 — Retroactive GRPO category backfill.
 *
 * Reads historical experience records from `~/.claude/artibot/daily-experiences.json`,
 * filters the failure-shaped ones (low score, error type, or error payloads),
 * routes each through `lib/learning/failure-categorizer.categorizeAll()` to obtain
 * per-category confidence scores, then writes a category-keyed weight bucket
 * (`categoryWeights`) into `~/.claude/artibot/grpo-history.json` while leaving
 * the existing `rounds` / `weights` / `teamWeights` keys untouched.
 *
 * Usage:
 *   node scripts/backfill-grpo-categories.js                    # dry-run (default)
 *   node scripts/backfill-grpo-categories.js --apply            # write w/ backup
 *   node scripts/backfill-grpo-categories.js --limit 50         # cap records
 *   node scripts/backfill-grpo-categories.js --input <path>     # override input
 *   node scripts/backfill-grpo-categories.js --output <path>    # override output
 *
 * Exit codes: 0 success, 1 missing input or fatal error.
 *
 * Zero runtime deps. ESM. Public functions are exported for the test harness.
 *
 * @module scripts/backfill-grpo-categories
 */
import fsDefault from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { categorizeAll } from '../lib/learning/failure-categorizer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Records whose `data.score` is below this are treated as failure-shaped. */
const FAILURE_SCORE_THRESHOLD = 0.5;

/** Records over which categorizeAll returns no match are bucketed here. */
const UNMATCHED_KEY = '__unmatched__';

/** Sample record IDs kept per category in the report. */
const SAMPLE_LIMIT = 3;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    mode: 'dry-run',
    input: null,
    output: null,
    limit: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--dry-run') {
      args.mode = 'dry-run';
    } else if (tok === '--apply') {
      args.mode = 'apply';
    } else if (tok === '--input') {
      args.input = argv[++i];
    } else if (tok === '--output') {
      args.output = argv[++i];
    } else if (tok === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--limit expects a non-negative number, got: ${argv[i]}`);
      }
      args.limit = Math.floor(n);
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    } else if (tok.startsWith('--')) {
      throw new Error(`unknown flag: ${tok}`);
    }
  }
  return args;
}

export function defaultInputPath() {
  return path.join(os.homedir(), '.claude', 'artibot', 'daily-experiences.json');
}

export function defaultOutputPath() {
  return path.join(os.homedir(), '.claude', 'artibot', 'grpo-history.json');
}

/** Repo root used to locate `.artibot/failure-patterns.json` for the categorizer. */
export function defaultPatternsCwd() {
  // This file lives at <repo>/plugins/artibot/scripts/backfill-grpo-categories.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

// ---------------------------------------------------------------------------
// Failure-shape filter
// ---------------------------------------------------------------------------

/**
 * Identify records that should be retroactively categorized.
 * A record qualifies when any of:
 *   - `type === 'tool'` AND `data.score < FAILURE_SCORE_THRESHOLD`
 *   - `type === 'error'`
 *   - `data.errorMessage` or `data.stderr` is a non-empty string
 *
 * @param {*} record
 * @returns {boolean}
 */
export function isFailureRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const data = record.data && typeof record.data === 'object' ? record.data : null;
  if (record.type === 'tool' && data && typeof data.score === 'number' && data.score < FAILURE_SCORE_THRESHOLD) {
    return true;
  }
  if (record.type === 'error') return true;
  if (data) {
    if (typeof data.errorMessage === 'string' && data.errorMessage.length > 0) return true;
    if (typeof data.stderr === 'string' && data.stderr.length > 0) return true;
  }
  return false;
}

/**
 * Map a record's `data` shape into the `failureContext` shape expected by
 * `categorizeAll`. Returns `null` if the record's data block is unusable.
 */
export function toFailureContext(record) {
  const data = record && typeof record === 'object' && record.data && typeof record.data === 'object'
    ? record.data
    : null;
  if (!data) return null;
  return {
    stderr: typeof data.stderr === 'string'
      ? data.stderr
      : (typeof data.errorMessage === 'string' ? data.errorMessage : ''),
    stdout: typeof data.stdout === 'string' ? data.stdout : '',
    diff: typeof data.diff === 'string' ? data.diff : '',
    files: Array.isArray(data.files) ? data.files : [],
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate categorization results across a record stream into per-category
 * buckets. Each failure record contributes its top-scoring category (and
 * unmatched ones land in `__unmatched__`).
 *
 * @param {Array<{ record: object, categories: Array<object> }>} entries
 * @returns {Record<string, { count: number, confidenceSum: number, avgConfidence: number, sampleRecordIds: string[] }>}
 */
export function aggregateCategories(entries) {
  const buckets = {};
  for (const entry of entries) {
    const top = Array.isArray(entry.categories) && entry.categories.length > 0
      ? entry.categories[0]
      : null;
    const key = top ? top.categoryId : UNMATCHED_KEY;
    if (!buckets[key]) {
      buckets[key] = { count: 0, confidenceSum: 0, avgConfidence: 0, sampleRecordIds: [] };
    }
    const bucket = buckets[key];
    bucket.count += 1;
    bucket.confidenceSum += top ? top.confidence : 0;
    bucket.avgConfidence = Math.round((bucket.confidenceSum / bucket.count) * 1000) / 1000;
    if (bucket.sampleRecordIds.length < SAMPLE_LIMIT && entry.record?.id) {
      bucket.sampleRecordIds.push(entry.record.id);
    }
  }
  return buckets;
}

/**
 * Project the per-category buckets into a weight map suitable for merging into
 * grpo-history.json under `categoryWeights`. Weight is the bucket's
 * `avgConfidence` scaled by `count` (capped to avoid runaway values), so
 * categories that fire often with high confidence dominate.
 *
 * Unmatched bucket is dropped — it carries no actionable signal.
 *
 * @param {ReturnType<typeof aggregateCategories>} buckets
 * @returns {Record<string, number>}
 */
export function bucketsToWeights(buckets) {
  const weights = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    if (key === UNMATCHED_KEY) continue;
    const raw = bucket.avgConfidence * Math.min(bucket.count, 100);
    weights[key] = Math.round(raw * 1000) / 1000;
  }
  return weights;
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

async function readJsonOrThrow(fs, filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const e = new Error(`backfill: input not found: ${filePath}`, { cause: err });
      e.code = 'ENOENT';
      throw e;
    }
    throw new Error(`backfill: cannot read ${filePath} — ${err.message}`, { cause: err });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`backfill: malformed JSON in ${filePath} — ${err.message}`, { cause: err });
  }
}

async function readJsonOrDefault(fs, filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) return fallback;
    throw err;
  }
}

function backupSuffix(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatReport(summary, { mode, output, backup }) {
  const lines = [];
  lines.push('Stage C Backfill Report');
  lines.push('=======================');
  lines.push(`mode: ${mode}`);
  lines.push(`records scanned: ${summary.scanned}`);
  lines.push(`failed (failure-shaped): ${summary.failed}`);
  lines.push(`categorized: ${summary.categorized}`);
  lines.push(`unmatched: ${summary.unmatched}`);
  lines.push(`parse errors: ${summary.reportError}`);
  lines.push('');
  lines.push('Per-category bucket:');
  const rows = Object.entries(summary.buckets)
    .map(([id, b]) => ({ id, count: b.count, avgConfidence: b.avgConfidence, samples: b.sampleRecordIds }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  for (const row of rows) {
    const samples = row.samples.length > 0 ? ` samples=[${row.samples.join(', ')}]` : '';
    lines.push(`  ${row.id.padEnd(28)} count=${String(row.count).padStart(4)} avgConf=${row.avgConfidence.toFixed(3)}${samples}`);
  }
  lines.push('');
  if (mode === 'dry-run') {
    lines.push('[DRY RUN] no files written');
  } else if (mode === 'apply') {
    lines.push(`Wrote ${output} (backup: ${backup})`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Core runner — injectable for tests
// ---------------------------------------------------------------------------

/**
 * Run the backfill end-to-end. All side-effects (fs, clock, categorizer cwd)
 * are injectable so tests can drive the runner without touching disk.
 *
 * @param {object} [opts]
 * @param {string} [opts.mode] - 'dry-run' (default) or 'apply'.
 * @param {string} [opts.input] - input path.
 * @param {string} [opts.output] - output path.
 * @param {number|null} [opts.limit] - cap on records processed.
 * @param {object} [opts.fs] - fs/promises-like; defaults to node:fs/promises.
 * @param {string} [opts.patternsCwd] - cwd for failure-patterns.json lookup.
 * @param {object} [opts.patternsFs] - fs/promises-like used by categorizer.
 * @param {() => number} [opts.now] - clock for backup suffix.
 * @returns {Promise<{ summary: object, output: string, backup: string|null, report: string }>}
 */
export async function runBackfill(opts = {}) {
  const fs = opts.fs || fsDefault;
  const mode = opts.mode === 'apply' ? 'apply' : 'dry-run';
  const inputPath = opts.input || defaultInputPath();
  const outputPath = opts.output || defaultOutputPath();
  const limit = typeof opts.limit === 'number' && opts.limit >= 0 ? opts.limit : null;
  const patternsCwd = opts.patternsCwd || defaultPatternsCwd();
  const categorizerOpts = { cwd: patternsCwd };
  if (opts.patternsFs) categorizerOpts.fs = opts.patternsFs;

  const records = await readJsonOrThrow(fs, inputPath);
  if (!Array.isArray(records)) {
    throw new Error(`backfill: input is not an array: ${inputPath}`);
  }

  const summary = {
    scanned: 0,
    failed: 0,
    categorized: 0,
    unmatched: 0,
    reportError: 0,
    buckets: {},
  };

  const failureEntries = [];
  for (const record of records) {
    if (limit !== null && summary.scanned >= limit) break;
    summary.scanned += 1;
    let isFailure;
    try {
      isFailure = isFailureRecord(record);
    } catch {
      summary.reportError += 1;
      continue;
    }
    if (!isFailure) continue;
    summary.failed += 1;

    const ctx = toFailureContext(record);
    if (!ctx) {
      summary.reportError += 1;
      continue;
    }
    let categories;
    try {
      categories = await categorizeAll(ctx, categorizerOpts);
    } catch (err) {
      summary.reportError += 1;
      // Keep going — a single record's failure shouldn't abort the run.
      if (process.env.ARTIBOT_BACKFILL_DEBUG === '1') {
        process.stderr.write(`[backfill] categorizeAll threw for ${record.id}: ${err.message}\n`);
      }
      continue;
    }
    failureEntries.push({ record, categories });
    if (categories.length > 0) summary.categorized += 1;
    else summary.unmatched += 1;
  }

  summary.buckets = aggregateCategories(failureEntries);

  let backupPath = null;
  if (mode === 'apply') {
    const existing = await readJsonOrDefault(fs, outputPath, { rounds: [], weights: {}, teamWeights: {} });
    const merged = mergeCategoryWeights(existing, bucketsToWeights(summary.buckets));
    backupPath = `${outputPath}.bak-${backupSuffix((opts.now || Date.now)())}`;
    // Backup is best-effort: if the output file doesn't exist there's nothing to back up.
    try {
      const raw = await fs.readFile(outputPath, 'utf-8');
      await fs.writeFile(backupPath, raw, 'utf-8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        throw new Error(`backfill: backup failed for ${outputPath} — ${err.message}`, { cause: err });
      }
      backupPath = null;
    }
    await fs.writeFile(outputPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  }

  const report = formatReport(summary, { mode, output: outputPath, backup: backupPath });
  return { summary, output: outputPath, backup: backupPath, report };
}

/**
 * Merge a per-category weight map into the grpo-history object WITHOUT
 * touching any existing top-level keys other than `categoryWeights`.
 *
 * Per-category merge rule: existing weight is averaged with new weight when
 * both are present; otherwise the new or existing value is kept. This makes
 * repeated backfills idempotent enough that running twice in a row converges
 * rather than ballooning.
 */
export function mergeCategoryWeights(existing, newWeights) {
  const merged = { ...(existing || {}) };
  const prior = (existing && typeof existing.categoryWeights === 'object' && existing.categoryWeights !== null)
    ? existing.categoryWeights
    : {};
  const next = { ...prior };
  for (const [k, v] of Object.entries(newWeights)) {
    if (typeof next[k] === 'number') {
      next[k] = Math.round(((next[k] + v) / 2) * 1000) / 1000;
    } else {
      next[k] = v;
    }
  }
  merged.categoryWeights = next;
  return merged;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const HELP = `Stage C Backfill — retroactively categorize past failures into GRPO buckets.

Usage:
  node scripts/backfill-grpo-categories.js [--dry-run|--apply]
       [--input <path>] [--output <path>] [--limit <N>]

Flags:
  --dry-run        Analyze only; print report. (default)
  --apply          Write categoryWeights into grpo-history.json (backup auto-created).
  --input <path>   Override input file (default ~/.claude/artibot/daily-experiences.json).
  --output <path>  Override output file (default ~/.claude/artibot/grpo-history.json).
  --limit <N>      Stop after N input records (testing only).
  -h, --help       Show this banner.
`;

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${HELP}`);
    process.exit(1);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    const result = await runBackfill({
      mode: args.mode,
      input: args.input,
      output: args.output,
      limit: args.limit,
    });
    process.stdout.write(result.report + '\n');
  } catch (err) {
    process.stderr.write(`backfill: ${err.message}\n`);
    process.exit(1);
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main();
}
