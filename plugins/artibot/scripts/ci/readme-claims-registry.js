/**
 * readme-claims-registry.js — Single source of truth for README count claims.
 *
 * Both the validator (validate-readme-claims.js, which FAILS on drift) and the
 * auto-fixer (sync-readme-claims.js, which REWRITES drift) need the same two
 * things: the actual file-system counts, and the regexes that locate count
 * claims in README prose/badges. Keeping them in one place guarantees the gate
 * and the self-heal can never disagree about what a "claim" is or what it should
 * equal — the failure mode that would let drift slip past one but not the other.
 *
 * Exports:
 *   REPO_ROOT, PLUGIN_ROOT — resolved repo paths (callers pass nothing).
 *   collectActuals(opts)   — file-system counts; opts.full adds coverage.
 *   CLAIM_PATTERNS         — [{ key, regex, label }] matching prose/badges.
 *
 * Regex contract: each pattern has capture group 1 = numeric claim, group 2 =
 * the trailing phrase (e.g. " slash commands"). The validator reads group 1 to
 * compare; the sync reads group 2 to rebuild the replacement verbatim. The `gi`
 * flag is intentional (case-insensitive, all occurrences).
 *
 * Zero dependencies. Node 20+ built-ins only.
 *
 * @module scripts/ci/readme-claims-registry
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(scriptDir, '..', '..');
export const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

function countDirsWith(dir, marker) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() && existsSync(path.join(full, marker));
  }).length;
}

function countFiles(dir, ext, exclude = []) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(
    (f) => f.endsWith(ext) && !exclude.includes(f)
  ).length;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Collect actual counts from the file system.
 * @param {{ full?: boolean }} [opts] - When `full`, also reads coverage summary.
 * @returns {Record<string, number>} category -> count
 */
export function collectActuals(opts = {}) {
  const actuals = {
    skills: countDirsWith(path.join(PLUGIN_ROOT, 'skills'), 'SKILL.md'),
    commands: countFiles(path.join(PLUGIN_ROOT, 'commands'), '.md'),
    agents: countFiles(path.join(PLUGIN_ROOT, 'agents'), '.md', ['INDEX.md', 'README.md']),
    hookScripts: countFiles(path.join(PLUGIN_ROOT, 'scripts', 'hooks'), '.js'),
  };

  // hooks.json registration count (sum of array lengths across event types).
  const hooksJson = readJsonSafe(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'));
  if (hooksJson?.hooks) {
    actuals.hookRegistrations = Object.values(hooksJson.hooks).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
  }

  if (opts.full) {
    const summary = readJsonSafe(
      path.join(PLUGIN_ROOT, 'coverage', 'coverage-summary.json')
    );
    if (summary?.total) {
      actuals.statementCoverage = Math.round(summary.total.statements.pct);
    }
  }

  return actuals;
}

// Claim patterns. Group 1 = numeric claim, group 2 = trailing phrase (preserved
// verbatim by the sync rewriter). `label` is for validator/sync human output.
//
// Coverage (statementCoverage) is intentionally NOT pattern-matched here: it is
// a "≈"/threshold claim, not a file-system fact, so the auto-fixer must never
// silently rewrite it — that stays validator-only territory.
export const CLAIM_PATTERNS = [
  { key: 'skills', regex: /(\d{2,3})(\s+(?:domain\s+)?skills?\b)/gi, label: 'skills' },
  { key: 'skills', regex: /(\d{2,3})(\s+skill\s+director(?:y|ies))/gi, label: 'skill dirs' },
  { key: 'commands', regex: /(\d{2,3})(\s+(?:slash\s+)?commands?\b)/gi, label: 'commands' },
  { key: 'agents', regex: /(\d{2,3})(\s+(?:specialist\s+)?agents?\b)/gi, label: 'agents' },
  { key: 'agents', regex: /(\d{2,3})(\s+agent\s+definitions?)/gi, label: 'agent defs' },
  { key: 'hookRegistrations', regex: /(\d{2,3})(\s+hook\s+registrations?)/gi, label: 'hook regs' },
  { key: 'hookScripts', regex: /(\d{2,3})(\s+hook\s+scripts?)/gi, label: 'hook scripts' },
];
