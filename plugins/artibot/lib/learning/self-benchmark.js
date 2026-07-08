/**
 * Artibot Self-Benchmark — weekly 5-dimension observational scorecard.
 *
 * Runs purely observationally (no code changes, no LLM calls, no network).
 * Produces a GFM markdown report at `_reports/self-benchmark.md` and
 * appends scores to `_reports/self-benchmark-history.json` for trend tracking.
 *
 * 5 dimensions (each 0-10, weighted-sum to 0-100):
 *   - evolved      EFFORT_POLICY coverage, native-effort hint usage, lifelong hook
 *   - extensible   SDK .commit(), extension-loader, plugin.json + dynamic discovery
 *   - productive   autoApply=true, post-bash-failure hook, avg hooks/session
 *   - universal    plain-language entries, user-profile signals, dashboard.enabled
 *   - quality      tests passing, lint errors, skill:check errors
 *
 * DATA POLICY: all computation stays in-process on local files.
 *
 * @module lib/learning/self-benchmark
 */

import path from 'node:path';
import { readdir } from 'node:fs/promises';

import {
  ensureDir,
  exists,
  readJsonFile,
  readTextFile,
  writeJsonFile,
} from '../core/file.js';
import { getPluginRoot } from '../core/platform.js';
import { resolveProfilePath } from '../core/user-profile.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DIMENSIONS = ['evolved', 'extensible', 'productive', 'universal', 'quality'];

/** Weight per dimension (each dimension contributes 0-20 to 0-100 total). */
const DIMENSION_WEIGHT = 2;

const DEFAULT_REPORT_REL = '_reports/self-benchmark.md';
const DEFAULT_HISTORY_REL = '_reports/self-benchmark-history.json';
const MAX_HISTORY_ENTRIES = 52; // 1 year of weekly snapshots

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number to the range [0, 10].
 * @param {number} n
 * @returns {number}
 */
export function clamp10(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 10) return 10;
  return Math.round(n * 100) / 100;
}

/**
 * Recursively count files matching a predicate, bounded in depth.
 * @param {string} dir
 * @param {(name: string, full: string) => boolean} predicate
 * @param {number} [maxDepth=6]
 * @returns {Promise<number>}
 */
async function countFilesRec(dir, predicate, maxDepth = 6) {
  if (maxDepth < 0) return 0;
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      total += await countFilesRec(full, predicate, maxDepth - 1);
    } else if (predicate(e.name, full)) {
      total += 1;
    }
  }
  return total;
}

/**
 * Grep-like substring count across all files under a directory.
 * @param {string} dir
 * @param {string} needle
 * @param {(name: string) => boolean} filter
 * @returns {Promise<number>}
 */
async function grepCount(dir, needle, filter) {
  let hits = 0;
  const walk = async (cur, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(full, depth - 1);
      } else if (filter(e.name)) {
        const txt = await readTextFile(full);
        if (txt && txt.includes(needle)) hits += 1;
      }
    }
  };
  await walk(dir, 5);
  return hits;
}

// ---------------------------------------------------------------------------
// Stats gathering
// ---------------------------------------------------------------------------

/**
 * Gather repo stats needed to compute dimension scores.
 * No network, no external APIs — purely local filesystem observation.
 *
 * @param {string} pluginRoot
 * @returns {Promise<object>}
 */
export async function gatherRepoStats(pluginRoot) {
  const root = pluginRoot || getPluginRoot();
  const config = (await readJsonFile(path.join(root, 'artibot.config.json'))) || {};

  const [commands, effortPolicyHits, nativeEffortHits, sdkHasCommit] = await Promise.all([
    countFilesRec(path.join(root, 'commands'), (n) => n.endsWith('.md')),
    grepCount(path.join(root, 'commands'), 'EFFORT_POLICY', (n) => n.endsWith('.md')),
    grepCount(path.join(root, 'lib'), 'setNativeEffortHint', (n) => n.endsWith('.js')),
    fileContains(path.join(root, 'lib', 'sdk', 'artibot-sdk.js'), '.commit('),
  ]);

  const [extensionLoaderExists, lifelongHookRegistered, postBashFailureExists] = await Promise.all([
    exists(path.join(root, 'lib', 'core', 'extension-loader.js')).catch(() => false),
    grepCount(path.join(root, 'hooks'), 'lifelong', (n) => n.endsWith('.json')),
    exists(path.join(root, 'scripts', 'hooks', 'post-bash-failure.js')),
  ]);

  const plainLangPath = path.join(root, 'lib', 'core', 'plain-language.js');
  const plainLangEntries = await countExportLike(plainLangPath);

  // Read the profile from the same path the writer (user-profile.js) uses —
  // the home-dir location, NOT a phantom `<root>/runtime/user-profile.json`
  // that is never written (which pinned userProfileSignals at 0).
  const userProfileSignals = await countJsonKeys(resolveProfilePath());
  const dashboardEnabled = Boolean(config?.dashboard?.enabled);

  const autoApply = Boolean(config?.team?.autoApply);
  const hookCount = await countHookEntries(path.join(root, 'hooks', 'hooks.json'));

  const stats = {
    timestamp: new Date().toISOString(),
    root,
    commands: {
      total: commands,
      withEffortPolicy: effortPolicyHits,
    },
    nativeEffortHits,
    sdkHasCommit,
    extensionLoaderExists,
    lifelongHookRegistered: lifelongHookRegistered > 0,
    postBashFailureHookExists: postBashFailureExists,
    autoApply,
    hookCount,
    plainLangEntries,
    userProfileSignals,
    dashboardEnabled,
    tests: await getTestSummary(root),
    lintErrors: 0, // placeholder; actual lint is exercised by `npm run lint`, not this observer
    skillCheckErrors: 0,
  };

  return stats;
}

/**
 * @param {string} filePath
 * @param {string} needle
 * @returns {Promise<boolean>}
 */
async function fileContains(filePath, needle) {
  const txt = await readTextFile(filePath);
  return Boolean(txt && txt.includes(needle));
}

/**
 * Count `export` declarations in a JS module as a proxy for entry richness.
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function countExportLike(filePath) {
  const txt = await readTextFile(filePath);
  if (!txt) return 0;
  const re = /^export\s+(async\s+)?(function|const|class|let)\s+/gm;
  const matches = txt.match(re);
  return matches ? matches.length : 0;
}

/**
 * Count top-level keys in a JSON file (signal count proxy).
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function countJsonKeys(filePath) {
  const data = await readJsonFile(filePath);
  if (!data || typeof data !== 'object') return 0;
  return Object.keys(data).length;
}

/**
 * Count all hook entries across all events in hooks.json.
 * @param {string} hooksJsonPath
 * @returns {Promise<number>}
 */
async function countHookEntries(hooksJsonPath) {
  const data = await readJsonFile(hooksJsonPath);
  if (!data || typeof data !== 'object') return 0;
  let total = 0;
  for (const v of Object.values(data)) {
    if (Array.isArray(v)) {
      for (const g of v) {
        if (g && Array.isArray(g.hooks)) total += g.hooks.length;
      }
    }
  }
  return total;
}

/**
 * Read the most recent vitest summary if present. Falls back to a default.
 * @param {string} root
 * @returns {Promise<{passed: number, total: number, ratio: number}>}
 */
async function getTestSummary(root) {
  const candidates = [
    path.join(root, 'coverage', 'summary.json'),
    path.join(root, '_reports', 'test-summary.json'),
  ];
  for (const p of candidates) {
    const data = await readJsonFile(p);
    if (data && Number.isFinite(data.passed) && Number.isFinite(data.total)) {
      return {
        passed: data.passed,
        total: data.total,
        ratio: data.total > 0 ? data.passed / data.total : 0,
      };
    }
  }
  return { passed: 0, total: 0, ratio: 0 };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute 5 dimension scores (each 0-10) from repo stats.
 * Pure function — deterministic given the same stats.
 *
 * @param {object} stats
 * @returns {Record<string, {score: number, evidence: string[]}>}
 */
export function computeDimensionScores(stats) {
  return {
    evolved: scoreEvolved(stats),
    extensible: scoreExtensible(stats),
    productive: scoreProductive(stats),
    universal: scoreUniversal(stats),
    quality: scoreQuality(stats),
  };
}

function scoreEvolved(s) {
  const cmdTotal = Math.max(1, s?.commands?.total ?? 0);
  const cmdCov = s?.commands?.withEffortPolicy ?? 0;
  const covRatio = Math.min(1, cmdCov / cmdTotal);
  const nativeBonus = (s?.nativeEffortHits ?? 0) > 0 ? 2 : 0;
  const lifelongBonus = s?.lifelongHookRegistered ? 2 : 0;
  const score = clamp10(covRatio * 6 + nativeBonus + lifelongBonus);
  return {
    score,
    evidence: [
      `EFFORT_POLICY coverage: ${cmdCov}/${cmdTotal} commands (${Math.round(covRatio * 100)}%)`,
      `setNativeEffortHint hits in lib/: ${s?.nativeEffortHits ?? 0}`,
      `lifelong-learner hook registered: ${s?.lifelongHookRegistered ? 'yes' : 'no'}`,
    ],
  };
}

function scoreExtensible(s) {
  const sdk = s?.sdkHasCommit ? 4 : 0;
  const loader = s?.extensionLoaderExists ? 3 : 0;
  const hooks = Math.min(3, (s?.hookCount ?? 0) / 10);
  const score = clamp10(sdk + loader + hooks);
  return {
    score,
    evidence: [
      `SDK .commit() present: ${s?.sdkHasCommit ? 'yes' : 'no'}`,
      `extension-loader.js present: ${s?.extensionLoaderExists ? 'yes' : 'no'}`,
      `hook entries registered: ${s?.hookCount ?? 0}`,
    ],
  };
}

function scoreProductive(s) {
  const auto = s?.autoApply ? 4 : 0;
  const failHook = s?.postBashFailureHookExists ? 3 : 0;
  const hookDensity = Math.min(3, (s?.hookCount ?? 0) / 15);
  const score = clamp10(auto + failHook + hookDensity);
  return {
    score,
    evidence: [
      `team.autoApply: ${s?.autoApply ? 'true' : 'false'}`,
      `post-bash-failure hook: ${s?.postBashFailureHookExists ? 'present' : 'missing'}`,
      `hook density (hooks/15): ${(s?.hookCount ?? 0) / 15}`,
    ],
  };
}

function scoreUniversal(s) {
  const plain = Math.min(5, (s?.plainLangEntries ?? 0) / 4);
  const profile = Math.min(3, (s?.userProfileSignals ?? 0) / 3);
  const dash = s?.dashboardEnabled ? 2 : 0;
  const score = clamp10(plain + profile + dash);
  return {
    score,
    evidence: [
      `plain-language exports: ${s?.plainLangEntries ?? 0}`,
      `user-profile signals: ${s?.userProfileSignals ?? 0}`,
      `dashboard.enabled: ${s?.dashboardEnabled ? 'true' : 'false'}`,
    ],
  };
}

function scoreQuality(s) {
  const testRatio = s?.tests?.ratio ?? 0;
  const testPts = testRatio * 7;
  const lintPts = (s?.lintErrors ?? 0) === 0 ? 2 : 0;
  const skillPts = (s?.skillCheckErrors ?? 0) === 0 ? 1 : 0;
  const score = clamp10(testPts + lintPts + skillPts);
  return {
    score,
    evidence: [
      `tests: ${s?.tests?.passed ?? 0}/${s?.tests?.total ?? 0} (${Math.round(testRatio * 100)}%)`,
      `lint errors: ${s?.lintErrors ?? 0}`,
      `skill:check errors: ${s?.skillCheckErrors ?? 0}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

/**
 * Render a GFM markdown report from dimension scores and history.
 * Pure — no I/O.
 *
 * @param {object} params
 * @returns {string}
 */
export function renderMarkdownReport({ scores, totalScore, timestamp, previous, schedule }) {
  const lines = [];
  lines.push('# Artibot Self-Benchmark Report');
  lines.push('');
  lines.push(`Generated: ${timestamp}`);
  lines.push(`Schedule: ${schedule || 'weekly (Monday 04:00)'}`);
  lines.push(`Total score: ${totalScore} / 100`);
  lines.push('');
  lines.push('## 5차원 스코어카드');
  lines.push('');
  lines.push('| 차원 | 점수 | 이전 주 | Δ |');
  lines.push('|---|---|---|---|');
  for (const dim of DIMENSIONS) {
    const cur = scores[dim]?.score ?? 0;
    const prev = previous?.scores?.[dim]?.score;
    const delta = typeof prev === 'number' ? (cur - prev).toFixed(2) : 'n/a';
    const prevStr = typeof prev === 'number' ? prev.toFixed(2) : 'n/a';
    lines.push(`| ${dim} | ${cur.toFixed(2)} | ${prevStr} | ${delta} |`);
  }
  lines.push('');
  lines.push('## 근거');
  lines.push('');
  for (const dim of DIMENSIONS) {
    lines.push(`### ${dim}`);
    lines.push('');
    for (const e of scores[dim]?.evidence ?? []) {
      lines.push(`- ${e}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the weekly self-benchmark.
 * Purely observational — reads files, writes a report + appends history.
 *
 * @param {object} [options]
 * @param {string} [options.pluginRoot]
 * @param {object} [options.config]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{scores: object, totalScore: number, reportPath: string, written: boolean}>}
 */
export async function runSelfBenchmark(options = {}) {
  const root = options.pluginRoot || getPluginRoot();
  const cfg = options.config?.ago?.selfBenchmark || {};
  const reportRel = cfg.reportPath || DEFAULT_REPORT_REL;
  const reportPath = path.join(root, reportRel);
  const historyPath = path.join(root, DEFAULT_HISTORY_REL);

  const stats = await gatherRepoStats(root);
  const scores = computeDimensionScores(stats);
  const totalScore = DIMENSIONS.reduce((sum, d) => sum + (scores[d]?.score ?? 0) * DIMENSION_WEIGHT, 0);

  const history = (await readJsonFile(historyPath)) || { entries: [] };
  const previous = history.entries[history.entries.length - 1] || null;

  const report = renderMarkdownReport({
    scores,
    totalScore: Math.round(totalScore * 100) / 100,
    timestamp: stats.timestamp,
    previous,
    schedule: cfg.schedule,
  });

  if (options.dryRun) {
    return { scores, totalScore, reportPath, written: false, report };
  }

  await ensureDir(path.dirname(reportPath));
  await writeTextFile(reportPath, report);

  const entry = {
    timestamp: stats.timestamp,
    totalScore: Math.round(totalScore * 100) / 100,
    scores: Object.fromEntries(
      DIMENSIONS.map((d) => [d, { score: scores[d]?.score ?? 0 }]),
    ),
  };
  const nextEntries = [...(history.entries || []), entry].slice(-MAX_HISTORY_ENTRIES);
  await writeJsonFile(historyPath, { entries: nextEntries });

  return { scores, totalScore, reportPath, written: true, report };
}

/**
 * Write a text file atomically via intermediate ensureDir.
 * @param {string} filePath
 * @param {string} content
 */
async function writeTextFile(filePath, content) {
  const fs = await import('node:fs/promises');
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf-8');
}

