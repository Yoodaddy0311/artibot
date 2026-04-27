#!/usr/bin/env node
/**
 * Stop / SubagentStop hook — Auto-Review Trigger.
 * After work concludes, scan `git diff --stat HEAD` and recommend reviewer
 * sub-agents (code-reviewer / spec-reviewer / security-reviewer) based on
 * which file types and keywords are present in the diff.
 *
 * Algorithm (PRD docs/PRD/autopilot-mode.md §5.3):
 *   1. git diff --stat HEAD -> changed files
 *   2. No changes -> skip
 *   3. Code files (.js/.ts/.py/.go/.java/.rs/.tsx/.jsx/.vue/.svelte)
 *      -> code-reviewer candidate
 *   4. PRD/spec impact (docs/PRD/, *.spec.md) -> spec-reviewer candidate
 *   5. Security keywords (auth, crypto, password, secret, token, jwt)
 *      -> security-reviewer candidate
 *
 * Loop guard: runtime/last-review-sha.txt holds the last suggested HEAD SHA.
 * If HEAD SHA + diff fingerprint match the saved one, skip (already advised).
 *
 * @module scripts/hooks/auto-review-trigger
 */

import path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  atomicWriteSync,
  getPluginRoot,
  parseJSON,
  readStdin,
  writeStdout,
} from '../utils/index.js';
import { createErrorHandler, hasExtension, logHookError } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'auto-review-trigger';
const STATE_FILE = 'last-review-sha.txt';

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.java', '.rs', '.rb', '.php',
  '.vue', '.svelte',
]);

const SPEC_PATH_PATTERNS = [
  /(^|\/)docs\/PRD\//i,
  /\.spec\.md$/i,
  /(^|\/)docs\/specs?\//i,
];

const SECURITY_KEYWORDS = /\b(auth|crypto|password|secret|token|jwt|oauth|hash|bcrypt|encrypt|decrypt)\b/i;

/**
 * Run a git command in the repo root, returning trimmed stdout.
 * Returns null on failure (silent).
 *
 * @param {string} cmd
 * @param {string} [cwd]
 * @returns {string|null}
 */
function git(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  } catch (err) {
    logHookError(HOOK_NAME, `git failed: ${cmd}`, err);
    return null;
  }
}

/** @returns {string|null} */
function getRepoRoot() {
  return git('git rev-parse --show-toplevel');
}

/** @returns {string|null} */
function getHeadSha(repoRoot) {
  return git('git rev-parse HEAD', repoRoot);
}

/**
 * Get changed files vs HEAD using --name-only (covers staged + working tree
 * + last commit). Falls back gracefully if any subcommand fails.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function getChangedFiles(repoRoot) {
  const merged = new Set();
  for (const cmd of [
    'git diff --name-only HEAD',
    'git diff --name-only --cached',
    'git diff --name-only HEAD~1 HEAD',
  ]) {
    const out = git(cmd, repoRoot);
    if (!out) continue;
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) merged.add(trimmed);
    }
  }
  return [...merged];
}

/**
 * Match a path against the SPEC patterns.
 * @param {string} filePath
 * @returns {boolean}
 */
function isSpecPath(filePath) {
  return SPEC_PATH_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Classify changed files into reviewer suggestions.
 *
 * @param {string[]} files
 * @param {string} repoRoot
 * @returns {{ agents: string[], reasons: string[] }}
 */
function classifyChanges(files, repoRoot) {
  const agents = new Set();
  const reasons = [];

  const codeFiles = files.filter((f) => hasExtension(f, CODE_EXTENSIONS));
  if (codeFiles.length > 0) {
    agents.add('code-reviewer');
    reasons.push(`code: ${codeFiles.length} file(s)`);
  }

  const specFiles = files.filter((f) => isSpecPath(f));
  if (specFiles.length > 0) {
    agents.add('spec-reviewer');
    reasons.push(`spec: ${specFiles.length} file(s)`);
  }

  // Security: any changed file path or content matches security keywords.
  let securityHits = 0;
  for (const file of files) {
    if (SECURITY_KEYWORDS.test(file)) {
      securityHits += 1;
      continue;
    }
    const abs = path.join(repoRoot, file);
    if (!existsSync(abs)) continue;
    try {
      const content = readFileSync(abs, 'utf-8');
      if (SECURITY_KEYWORDS.test(content)) securityHits += 1;
    } catch {
      // unreadable -> ignore
    }
  }
  if (securityHits > 0) {
    agents.add('security-reviewer');
    reasons.push(`security: ${securityHits} hit(s)`);
  }

  return { agents: [...agents], reasons };
}

/**
 * Build the cache fingerprint for loop-guard.
 * @param {string} sha
 * @param {string[]} files
 * @returns {string}
 */
function buildFingerprint(sha, files) {
  return `${sha}|${files.slice().sort().join(',')}`;
}

/**
 * Read the saved fingerprint if it exists. Returns empty string on miss.
 * @param {string} pluginRoot
 * @returns {string}
 */
function readLastFingerprint(pluginRoot) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', STATE_FILE);
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Persist the current fingerprint atomically.
 * @param {string} pluginRoot
 * @param {string} fingerprint
 */
function saveFingerprint(pluginRoot, fingerprint) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', STATE_FILE);
    atomicWriteSync(filePath, fingerprint + '\n');
  } catch (err) {
    logHookError(HOOK_NAME, 'failed to persist fingerprint', err);
  }
}

/**
 * Build the JSON payload for Stop/SubagentStop additionalContext.
 * @param {string[]} agents
 * @param {string[]} reasons
 * @param {number} fileCount
 * @param {string} eventName
 * @returns {object}
 */
function buildOutput(agents, reasons, fileCount, eventName) {
  const ctx =
    `[auto-review-required] agents: [${agents.join(', ')}]. ` +
    `Detected ${fileCount} changed file(s) — ${reasons.join('; ')}. ` +
    `Auto-spawn Task(subagent_type='${agents[0]}') to cross-check before reporting done.`;
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: ctx,
    },
  };
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};
  const eventName = hookData?.hook_event_name === 'SubagentStop' ? 'SubagentStop' : 'Stop';

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  const changedFiles = getChangedFiles(repoRoot);
  if (changedFiles.length === 0) return;

  const headSha = getHeadSha(repoRoot) || 'unknown';
  const pluginRoot = getPluginRoot();
  const fingerprint = buildFingerprint(headSha, changedFiles);
  if (readLastFingerprint(pluginRoot) === fingerprint) return; // already advised

  const { agents, reasons } = classifyChanges(changedFiles, repoRoot);
  if (agents.length === 0) return;

  saveFingerprint(pluginRoot, fingerprint);
  writeStdout(buildOutput(agents, reasons, changedFiles.length, eventName));
}

main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
