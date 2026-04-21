/**
 * Skill Lifecycle Autopilot — AGO Self-Control Module 6.
 *
 * Analyzes skill usage statistics to identify deprecation and promotion
 * candidates. Applies decisions only when three gates are open:
 *   1. `ago.selfControl.masterEnabled === true`
 *   2. `ago.selfControl.autoLifecycle.enabled === true`
 *   3. `ARTIBOT_SELF_CONTROL=1` environment variable
 *
 * Deprecation is two-phase: mark frontmatter with `deprecated: true` +
 * `deprecatedAt`, then actual deletion only after `graceDays` (14) elapse.
 * Promotion adds `priority: high` to frontmatter — no code changes.
 *
 * Protected core skills are never deprecated. All decisions are written to
 * the Decision Trail for explainability.
 *
 * Zero runtime deps. ESM only.
 * @module lib/learning/skill-lifecycle-autopilot
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { ensureDir, readJsonFile } from '../core/file.js';
import { getPluginRoot } from '../core/platform.js';
import { recordDecision } from '../core/decision-trail.js';

// ---------------------------------------------------------------------------
// Constants (immutable — do not relax without security review)
// ---------------------------------------------------------------------------

/** Minimum grace period before actual deletion. Never reduce. */
export const MIN_GRACE_DAYS = 14;

/** Core skills that MUST NEVER be deprecated, regardless of usage stats. */
export const PROTECTED_SKILLS = Object.freeze([
  'principles',
  'dev-protocol',
  'yes-md',
  'artibot-core',
  'coding-standards',
]);

const MS_PER_DAY = 86_400_000;
const DEFAULT_DEPRECATE_THRESHOLD = 0;
const DEFAULT_PROMOTE_THRESHOLD = 5;
const PROMOTE_WINDOW_DAYS = 7;
const DEPRECATE_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// Gate resolution
// ---------------------------------------------------------------------------

/**
 * Check that all three safety gates are open.
 *
 * @param {object} [config]
 * @param {object} [env]
 * @returns {{open: boolean, reason?: string}}
 */
export function checkGates(config, env = process.env) {
  const sc = config?.ago?.selfControl;
  if (!sc || sc.masterEnabled !== true) {
    return { open: false, reason: 'masterEnabled=false' };
  }
  if (!sc.autoLifecycle || sc.autoLifecycle.enabled !== true) {
    return { open: false, reason: 'autoLifecycle.enabled=false' };
  }
  if (env.ARTIBOT_SELF_CONTROL !== '1') {
    return { open: false, reason: 'env ARTIBOT_SELF_CONTROL!=1' };
  }
  return { open: true };
}

// ---------------------------------------------------------------------------
// Usage-data aggregation
// ---------------------------------------------------------------------------

/**
 * Load raw skill usage counts from agent/tool pattern stores plus the
 * decision trail. Returns a map of skill name -> {total, recent7, recent14}.
 *
 * @param {object} options
 * @param {string} options.claudeDir - `~/.claude/artibot`
 * @param {string} options.pluginRoot
 * @param {Date} options.now
 * @returns {Promise<Map<string, {total: number, recent7: number, recent14: number}>>}
 */
export async function loadUsageStats({ claudeDir, pluginRoot, now }) {
  const stats = new Map();
  const agentPath = path.join(claudeDir, 'patterns', 'agent-patterns.json');
  const toolPath = path.join(claudeDir, 'patterns', 'tool-patterns.json');
  const trailPath = path.join(pluginRoot, 'runtime', 'decision-trail.json');

  await mergeSkillCountsFromPatterns(stats, agentPath, now);
  await mergeSkillCountsFromPatterns(stats, toolPath, now);
  await mergeSkillCountsFromTrail(stats, trailPath, now);

  return stats;
}

/**
 * @param {Map<string, {total: number, recent7: number, recent14: number}>} stats
 * @param {string} filePath
 * @param {Date} now
 * @returns {Promise<void>}
 */
async function mergeSkillCountsFromPatterns(stats, filePath, now) {
  const data = await readJsonFile(filePath);
  if (!data || typeof data !== 'object') return;
  const entries = Array.isArray(data.entries) ? data.entries : [];
  for (const entry of entries) {
    const skill = typeof entry?.skill === 'string' ? entry.skill : null;
    if (!skill) continue;
    const count = Number.isFinite(entry.count) ? entry.count : 1;
    const lastSeen = entry.lastSeen ? new Date(entry.lastSeen) : null;
    bumpStats(stats, skill, count, lastSeen, now);
  }
}

/**
 * @param {Map<string, {total: number, recent7: number, recent14: number}>} stats
 * @param {string} trailPath
 * @param {Date} now
 * @returns {Promise<void>}
 */
async function mergeSkillCountsFromTrail(stats, trailPath, now) {
  const data = await readJsonFile(trailPath);
  if (!data || !Array.isArray(data.entries)) return;
  for (const entry of data.entries) {
    const skill = entry?.outputs?.skill || entry?.inputs?.skill;
    if (typeof skill !== 'string' || !skill) continue;
    const ts = entry.timestamp ? new Date(entry.timestamp) : null;
    bumpStats(stats, skill, 1, ts, now);
  }
}

/**
 * @param {Map<string, {total: number, recent7: number, recent14: number}>} stats
 * @param {string} skill
 * @param {number} count
 * @param {Date|null} lastSeen
 * @param {Date} now
 * @returns {void}
 */
function bumpStats(stats, skill, count, lastSeen, now) {
  const prev = stats.get(skill) || { total: 0, recent7: 0, recent14: 0 };
  const next = { ...prev, total: prev.total + count };
  if (lastSeen instanceof Date && !Number.isNaN(lastSeen.getTime())) {
    const diffDays = (now.getTime() - lastSeen.getTime()) / MS_PER_DAY;
    if (diffDays <= PROMOTE_WINDOW_DAYS) next.recent7 += count;
    if (diffDays <= DEPRECATE_WINDOW_DAYS) next.recent14 += count;
  }
  stats.set(skill, next);
}

// ---------------------------------------------------------------------------
// Skill discovery & frontmatter utilities
// ---------------------------------------------------------------------------

/**
 * List all skill directory names under `<pluginRoot>/skills/`.
 *
 * @param {string} pluginRoot
 * @returns {Promise<string[]>}
 */
export async function listSkills(pluginRoot) {
  const skillsDir = path.join(pluginRoot, 'skills');
  try {
    const dirents = await fs.readdir(skillsDir, { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/**
 * Read a skill's SKILL.md content or return null.
 *
 * @param {string} pluginRoot
 * @param {string} skillName
 * @returns {Promise<string|null>}
 */
async function readSkillFile(pluginRoot, skillName) {
  const filePath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract YAML frontmatter block and body from a markdown string.
 *
 * @param {string} source
 * @returns {{frontmatter: string, body: string} | null}
 */
export function splitFrontmatter(source) {
  if (typeof source !== 'string' || !source.startsWith('---')) return null;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return null;
  const frontmatter = source.slice(3, end).replace(/^\n/, '');
  const body = source.slice(end + 4).replace(/^\n/, '');
  return { frontmatter, body };
}

/**
 * Upsert a scalar key in a YAML frontmatter block. Returns new frontmatter.
 *
 * @param {string} frontmatter
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function upsertFrontmatterKey(frontmatter, key, value) {
  const lines = frontmatter.split('\n');
  const keyRe = new RegExp(`^${escapeRe(key)}\\s*:`);
  const idx = lines.findIndex((line) => keyRe.test(line));
  if (idx >= 0) {
    const next = [...lines];
    next[idx] = `${key}: ${value}`;
    return next.join('\n');
  }
  return `${frontmatter}\n${key}: ${value}`;
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LifecyclePlan
 * @property {Array<{name: string, reason: string}>} toDeprecate
 * @property {Array<{name: string, reason: string}>} toPromote
 * @property {Array<{name: string, deprecatedAt: string}>} grace
 */

/**
 * Analyze skill usage statistics and classify candidates.
 * Pure function: returns a plan but does NOT mutate the filesystem.
 *
 * @param {object} options
 * @param {string} [options.pluginRoot]
 * @param {object} [options.config]
 * @param {string} [options.claudeDir]
 * @param {() => Date} [options.now]
 * @returns {Promise<LifecyclePlan>}
 */
export async function analyzeLifecycle(options = {}) {
  const pluginRoot = options.pluginRoot || getPluginRoot();
  const now = typeof options.now === 'function' ? options.now() : new Date();
  const claudeDir = options.claudeDir || defaultClaudeDir();
  const cfg = options.config?.ago?.selfControl?.autoLifecycle || {};
  const deprecateThreshold = Number.isFinite(cfg.deprecateThreshold)
    ? cfg.deprecateThreshold
    : DEFAULT_DEPRECATE_THRESHOLD;
  const promoteThreshold = Number.isFinite(cfg.promoteThreshold)
    ? cfg.promoteThreshold
    : DEFAULT_PROMOTE_THRESHOLD;

  const [skillNames, usage] = await Promise.all([
    listSkills(pluginRoot),
    loadUsageStats({ claudeDir, pluginRoot, now }),
  ]);

  const toDeprecate = [];
  const toPromote = [];
  const grace = [];

  for (const name of skillNames) {
    const stats = usage.get(name) || { total: 0, recent7: 0, recent14: 0 };
    const source = await readSkillFile(pluginRoot, name);
    if (source === null) continue;
    const fm = splitFrontmatter(source);
    if (!fm) continue;

    const deprecatedAt = matchFrontmatterValue(fm.frontmatter, 'deprecatedAt');
    if (deprecatedAt) {
      grace.push({ name, deprecatedAt });
      continue;
    }

    if (PROTECTED_SKILLS.includes(name)) continue;

    if (stats.recent14 <= deprecateThreshold) {
      toDeprecate.push({
        name,
        reason: `recent14=${stats.recent14} <= threshold=${deprecateThreshold}`,
      });
      continue;
    }

    if (stats.recent7 >= promoteThreshold) {
      const already = matchFrontmatterValue(fm.frontmatter, 'priority') === 'high';
      if (!already) {
        toPromote.push({
          name,
          reason: `recent7=${stats.recent7} >= threshold=${promoteThreshold}`,
        });
      }
    }
  }

  return { toDeprecate, toPromote, grace };
}

/**
 * @param {string} frontmatter
 * @param {string} key
 * @returns {string|null}
 */
function matchFrontmatterValue(frontmatter, key) {
  const re = new RegExp(`^${escapeRe(key)}\\s*:\\s*(.+)$`, 'm');
  const m = re.exec(frontmatter);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function defaultClaudeDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.claude', 'artibot');
}

// ---------------------------------------------------------------------------
// Mutations — require 3-gate pass
// ---------------------------------------------------------------------------

/**
 * Mark a skill as deprecated (frontmatter only; no deletion).
 * Returns `{applied, reason}`. Requires 3-gate pass.
 *
 * @param {string} skillName
 * @param {object} [options]
 * @param {string} [options.pluginRoot]
 * @param {object} [options.config]
 * @param {() => Date} [options.now]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<{applied: boolean, reason: string, path?: string}>}
 */
export async function deprecateSkill(skillName, options = {}) {
  const gate = checkGates(options.config, options.env);
  if (!gate.open) return { applied: false, reason: `gate-closed: ${gate.reason}` };
  if (PROTECTED_SKILLS.includes(skillName)) {
    return { applied: false, reason: 'protected-skill' };
  }

  const pluginRoot = options.pluginRoot || getPluginRoot();
  const now = typeof options.now === 'function' ? options.now() : new Date();
  const filePath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
  const source = await readSkillFile(pluginRoot, skillName);
  if (!source) return { applied: false, reason: 'skill-not-found' };
  const fm = splitFrontmatter(source);
  if (!fm) return { applied: false, reason: 'no-frontmatter' };

  const deprecatedAt = now.toISOString().slice(0, 10);
  let nextFm = upsertFrontmatterKey(fm.frontmatter, 'deprecated', 'true');
  nextFm = upsertFrontmatterKey(nextFm, 'deprecatedAt', `"${deprecatedAt}"`);
  const next = `---\n${nextFm}\n---\n${fm.body}`;
  await fs.writeFile(filePath, next, 'utf-8');

  await recordDecision({
    subsystem: 'skill-lifecycle-autopilot',
    action: 'deprecated',
    reason: `no usage in ${DEPRECATE_WINDOW_DAYS}d`,
    inputs: { skill: skillName },
    outputs: { deprecatedAt, graceDays: MIN_GRACE_DAYS },
  });

  return { applied: true, reason: 'ok', path: filePath };
}

/**
 * Promote a skill by adding `priority: high` to frontmatter.
 * No code changes. Requires 3-gate pass.
 *
 * @param {string} skillName
 * @param {object} [options]
 * @returns {Promise<{applied: boolean, reason: string, path?: string}>}
 */
export async function promoteSkill(skillName, options = {}) {
  const gate = checkGates(options.config, options.env);
  if (!gate.open) return { applied: false, reason: `gate-closed: ${gate.reason}` };

  const pluginRoot = options.pluginRoot || getPluginRoot();
  const filePath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
  const source = await readSkillFile(pluginRoot, skillName);
  if (!source) return { applied: false, reason: 'skill-not-found' };
  const fm = splitFrontmatter(source);
  if (!fm) return { applied: false, reason: 'no-frontmatter' };

  const nextFm = upsertFrontmatterKey(fm.frontmatter, 'priority', 'high');
  const next = `---\n${nextFm}\n---\n${fm.body}`;
  await fs.writeFile(filePath, next, 'utf-8');

  await recordDecision({
    subsystem: 'skill-lifecycle-autopilot',
    action: 'promoted',
    inputs: { skill: skillName },
    outputs: { priority: 'high' },
  });

  return { applied: true, reason: 'ok', path: filePath };
}

/**
 * Finalize a deprecated skill by deleting its directory ONLY after
 * `graceDays` have elapsed since `deprecatedAt`. Never shortens grace.
 *
 * @param {string} skillName
 * @param {string} deprecatedAt - ISO YYYY-MM-DD
 * @param {object} [options]
 * @returns {Promise<{applied: boolean, reason: string}>}
 */
export async function finalizeDeprecation(skillName, deprecatedAt, options = {}) {
  const gate = checkGates(options.config, options.env);
  if (!gate.open) return { applied: false, reason: `gate-closed: ${gate.reason}` };
  if (PROTECTED_SKILLS.includes(skillName)) {
    return { applied: false, reason: 'protected-skill' };
  }

  const now = typeof options.now === 'function' ? options.now() : new Date();
  const deprDate = new Date(`${deprecatedAt}T00:00:00Z`);
  if (Number.isNaN(deprDate.getTime())) {
    return { applied: false, reason: 'bad-deprecatedAt' };
  }
  const diffDays = Math.floor((now.getTime() - deprDate.getTime()) / MS_PER_DAY);
  if (diffDays < MIN_GRACE_DAYS) {
    return { applied: false, reason: `grace-period: ${diffDays}/${MIN_GRACE_DAYS}d` };
  }

  const pluginRoot = options.pluginRoot || getPluginRoot();
  const skillDir = path.join(pluginRoot, 'skills', skillName);
  try {
    await fs.rm(skillDir, { recursive: true, force: true });
  } catch (err) {
    return { applied: false, reason: `rm-failed: ${err.message}` };
  }

  await recordDecision({
    subsystem: 'skill-lifecycle-autopilot',
    action: 'finalized',
    inputs: { skill: skillName, deprecatedAt },
    outputs: { elapsedDays: diffDays },
  });

  return { applied: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Cron-style sweep
// ---------------------------------------------------------------------------

/**
 * Analyze + apply (deprecate/promote/finalize) in one pass. Obeys all gates.
 *
 * @param {object} [options]
 * @returns {Promise<{deprecated: string[], promoted: string[], finalized: string[], skipped: Array<{name: string, reason: string}>}>}
 */
export async function sweepLifecycle(options = {}) {
  const gate = checkGates(options.config, options.env);
  if (!gate.open) {
    return { deprecated: [], promoted: [], finalized: [], skipped: [{ name: '*', reason: gate.reason }] };
  }
  const plan = await analyzeLifecycle(options);
  const deprecated = [];
  const promoted = [];
  const finalized = [];
  const skipped = [];

  for (const entry of plan.toDeprecate) {
    const res = await deprecateSkill(entry.name, options);
    if (res.applied) deprecated.push(entry.name);
    else skipped.push({ name: entry.name, reason: res.reason });
  }
  for (const entry of plan.toPromote) {
    const res = await promoteSkill(entry.name, options);
    if (res.applied) promoted.push(entry.name);
    else skipped.push({ name: entry.name, reason: res.reason });
  }
  for (const entry of plan.grace) {
    const res = await finalizeDeprecation(entry.name, entry.deprecatedAt, options);
    if (res.applied) finalized.push(entry.name);
    else skipped.push({ name: entry.name, reason: res.reason });
  }

  await ensureDir(path.join(options.pluginRoot || getPluginRoot(), 'runtime'));
  return { deprecated, promoted, finalized, skipped };
}

// ---------------------------------------------------------------------------
// Internal exports for tests
// ---------------------------------------------------------------------------

export const _internals = Object.freeze({
  bumpStats,
  matchFrontmatterValue,
  escapeRe,
  defaultClaudeDir,
});
