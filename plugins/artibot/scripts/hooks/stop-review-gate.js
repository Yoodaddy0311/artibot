#!/usr/bin/env node
/**
 * Stop hook — Review Gate.
 * Analyzes recent changes for quality issues before session ends.
 * Checks: bracket mismatch, pattern violations, sensitive files, missing tests.
 * @module scripts/hooks/stop-review-gate
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicWriteSync, getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, hasExtension, isSkippablePath } from '../../lib/core/hook-utils.js';
import { getHeadSha, getRepoRoot } from '../../lib/git/repo-root-cache.js';

const HOOK_NAME = 'stop-review-gate';
const STATE_FILE = 'last-review-gate-sha.txt';
const log = (msg) => process.stderr.write(`[artibot:${HOOK_NAME}] ${msg}\n`);

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.java', '.cs', '.php', '.rs',
]);

const TEST_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.jsx', '.tsx']);

const SENSITIVE_PATTERNS = [
  /\.env($|\.)/i, /credentials/i, /\.pem$/i, /\.key$/i,
  /\.p12$/i, /\.pfx$/i, /secrets?\./i, /\.secret$/i,
  /id_rsa/i, /id_ed25519/i, /token\.json$/i,
  /service.account\.json$/i, /\.npmrc$/i, /\.netrc$/i,
];

const SENSITIVE_FILENAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development',
  'credentials.json', 'secrets.json', 'serviceAccountKey.json',
]);

// -------------------------------------------------------------------------
// Git Helpers
// -------------------------------------------------------------------------
// getRepoRoot / getHeadSha imported from lib/git/repo-root-cache.js
// (process-scoped memoize — see v4.7.3 perf-auditor A1).

/** @returns {string[]} Changed file paths relative to repo root */
function getChangedFiles(cwd) {
  // Use --diff-filter=ACMR to exclude deleted (D) and only include
  // Added/Copied/Modified/Renamed entries — deletions cause existsSync
  // gates downstream to noisy-skip and previously created review-gate
  // loops on autopilot squash/cleanup commits.
  // --name-status emits "<STATUS>\t<path>" (renames emit a third column),
  // so we strip the leading status column when parsing.
  const parse = (output) =>
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const cols = line.split('\t');
        // For A/C/M: ["M", "path"]; for R/C: ["R100", "old", "new"] — take last col.
        return cols.length > 1 ? cols[cols.length - 1] : cols[0];
      })
      .filter(Boolean);
  // Try HEAD~1..HEAD first (post-commit diff). Fall back to working-tree
  // diff vs HEAD when no parent commit exists (initial commit, shallow
  // clone). execFileSync (no shell) avoids POSIX-only `2>/dev/null || ...`
  // chaining that silently failed on Windows cmd.exe and emitted no diff
  // for any changed file — see issue-scanner W4 P1-1.
  const opts = {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    windowsHide: true,
  };
  for (const args of [
    ['diff', '--name-status', '--diff-filter=ACMR', 'HEAD~1', 'HEAD'],
    ['diff', '--name-status', '--diff-filter=ACMR', 'HEAD'],
  ]) {
    try {
      return parse(execFileSync('git', args, opts));
    } catch {
      // try next variant
    }
  }
  return [];
}

// -------------------------------------------------------------------------
// Fingerprint Cache (loop-guard)
// -------------------------------------------------------------------------
// Mirrors dev-verify-gate.js pattern (scripts/hooks/dev-verify-gate.js:120-186)
// to prevent self-loops where the same persistent issue triggers `decision:
// "block"` on every Stop event. The `stop_hook_active` guard only catches
// immediate Claude Code retries, not a sequence of separate Stop events with
// identical working-tree state.

/**
 * Build the cache fingerprint: repoHash + HEAD + sorted(changed_files).
 * @param {string} repoRoot
 * @param {string} sha
 * @param {string[]} files
 * @returns {string}
 */
function buildFingerprint(repoRoot, sha, files) {
  const repoHash = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);
  return `${repoHash}|${sha}|${files.slice().sort().join(',')}`;
}

/** @returns {string} */
function readLastFingerprint(pluginRoot) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', STATE_FILE);
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

function saveFingerprint(pluginRoot, fingerprint) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', STATE_FILE);
    atomicWriteSync(filePath, fingerprint + '\n');
  } catch {
    // best-effort persistence
  }
}

/**
 * True if any changed file's mtime is newer than the cache file (real new
 * edits since last gate fire). False means HEAD/working-tree drift but no
 * actual edits — same break-the-loop pattern as dev-verify-gate.js:167-186.
 *
 * @param {string} pluginRoot
 * @param {string} repoRoot
 * @param {string[]} changedFiles
 * @returns {boolean}
 */
function hasNewerEdits(pluginRoot, repoRoot, changedFiles) {
  const cachePath = path.join(pluginRoot, 'runtime', STATE_FILE);
  if (!existsSync(cachePath)) return true;
  let cacheMtime;
  try {
    cacheMtime = statSync(cachePath).mtimeMs;
  } catch {
    return true;
  }
  for (const file of changedFiles) {
    const abs = path.join(repoRoot, file);
    if (!existsSync(abs)) continue;
    try {
      if (statSync(abs).mtimeMs > cacheMtime) return true;
    } catch {
      // skip unreadable
    }
  }
  return false;
}

// -------------------------------------------------------------------------
// Quality Checks
// -------------------------------------------------------------------------

/**
 * Check for syntax errors (including bracket mismatch) in a JS/MJS/CJS file.
 * Delegates to Node's own parser via `node --check` for accurate results —
 * this avoids hand-rolled parser false positives on template literals,
 * regex literals, and nested `${...}` interpolation.
 *
 * Returns a short message on failure, or null on success.
 *
 * @param {string} absPath - Absolute path to the file to check.
 * @param {string} ext - File extension (only .js/.mjs/.cjs are checked).
 * @returns {string|null}
 */
function checkBracketMismatch(absPath, ext) {
  if (!['.js', '.mjs', '.cjs'].includes(ext)) return null;
  try {
    // Argv-array form avoids shell quoting issues on Windows + paths with
    // non-ASCII (e.g., Korean) or whitespace components.
    execFileSync(process.execPath, ['--check', absPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
    });
    return null;
  } catch (err) {
    const stderr = String(err.stderr || err.message || '').trim();
    // Extract the first error line for a terse message.
    const firstLine = stderr.split('\n').find((l) => /SyntaxError\b/.test(l));
    return firstLine ? firstLine.slice(0, 120) : 'syntax error';
  }
}


/**
 * Check for pattern violations (console.log, TODO/FIXME).
 * @param {string} content
 * @param {string} filename
 * @returns {string[]}
 */
function checkPatternViolations(content, filename) {
  const warnings = [];
  const lines = content.split('\n');

  const consolePattern = /\bconsole\.(log|debug|info)\s*\(/;
  const todoPattern = /\b(TODO|FIXME|HACK|XXX)\b/;
  const jsdocLine = /^\s*\*(?!\/)/; // matches JSDoc continuation lines
  const singleLineComment = /^\s*\/\//;

  const consoleHits = [];
  const todoHits = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track block comment state (simple line-level heuristic)
    if (inBlockComment) {
      if (/\*\//.test(line)) inBlockComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(line) && !/\*\//.test(line)) {
      inBlockComment = true;
      continue;
    }
    // Skip JSDoc continuation lines and single-line comments
    if (jsdocLine.test(line) || singleLineComment.test(line)) continue;
    if (consolePattern.test(line)) consoleHits.push(i + 1);
    if (todoPattern.test(line)) todoHits.push(i + 1);
  }

  if (consoleHits.length > 0) {
    warnings.push(`${filename}: console.log at line(s) ${consoleHits.slice(0, 5).join(', ')}`);
  }
  if (todoHits.length > 0) {
    warnings.push(`${filename}: TODO/FIXME at line(s) ${todoHits.slice(0, 5).join(', ')}`);
  }
  return warnings;
}

/**
 * Check if a file path is sensitive.
 * @param {string} filePath
 * @returns {boolean}
 */
function isSensitiveFile(filePath) {
  const basename = path.basename(filePath);
  if (SENSITIVE_FILENAMES.has(basename)) return true;
  return SENSITIVE_PATTERNS.some((p) => p.test(basename));
}

/**
 * Check if code files have corresponding test files.
 * @param {string[]} files - Changed file paths
 * @param {string} repoRoot
 * @returns {string[]} Files without tests
 */
/**
 * Recursively walk a directory and collect all `*.test.*` and `*.spec.*` basenames.
 * Used to match arbitrary lib paths against any mirror test regardless of depth.
 *
 * @param {string} rootDir
 * @returns {Set<string>} Set of basename stems (e.g. "router", "dag").
 */
function collectTestBasenames(rootDir) {
  const stems = new Set();
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const match = entry.name.match(/^(.+?)\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|jsx)$/);
        if (match) stems.add(match[1]);
      }
    }
  }
  return stems;
}

function checkMissingTests(files, repoRoot) {
  const codeFiles = files.filter(
    (f) => hasExtension(f, TEST_EXTENSIONS)
      && !f.includes('.test.')
      && !f.includes('.spec.')
      && !f.includes('__tests__')
      // CLI entry scripts and one-shot utilities don't need tests:
      && !/\/scripts\/hooks\//.test(f)
      && !/\/scripts\/(validate-|migrate-|audit-|generate-|phase\d+-audit|inject-)/.test(f)
      // Config files (eslint.config.js, vitest.config.js, prettier.config.js, etc.):
      && !/\.config\.(js|mjs|cjs|ts)$/.test(f)
      // Smoke / scratch tools (anywhere under */smoke/* or with leading underscore):
      && !/\/smoke\//.test(f)
      && !path.basename(f).startsWith('_'),
  );

  // Pre-collect all test basename stems under plugins/artibot/tests/ once.
  const testsRoot = path.join(repoRoot, 'plugins', 'artibot', 'tests');
  const testStems = existsSync(testsRoot) ? collectTestBasenames(testsRoot) : new Set();

  const missing = [];
  for (const file of codeFiles) {
    // Skip deleted files: `git diff HEAD~1 HEAD` includes deletions, but a
    // deleted source file with no sibling test would be falsely flagged as
    // "code without tests" — causing review-gate loops after autopilot
    // squash/cleanup commits.
    if (!existsSync(path.join(repoRoot, file))) continue;

    const ext = path.extname(file);
    const base = file.slice(0, -ext.length);
    const baseName = path.basename(base);

    // Fast path: any test file anywhere under tests/** with matching basename.
    if (testStems.has(baseName)) continue;

    // Sibling-path variants: foo.js -> foo.test.js
    const siblingVariants = [`${base}.test${ext}`, `${base}.spec${ext}`];
    const hasSibling = siblingVariants.some((t) => existsSync(path.join(repoRoot, t)));
    if (!hasSibling) missing.push(file);
  }
  return missing;
}

/**
 * Load codex.mode from artibot.config.json.
 * @returns {string|null}
 */
function loadCodexMode() {
  try {
    const configPath = path.join(getPluginRoot(), 'artibot.config.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config?.codex?.mode ?? null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------
// Analysis Pipeline
// -------------------------------------------------------------------------

/**
 * Analyze changed files for quality issues.
 * @param {string[]} changedFiles
 * @param {string} repoRoot
 * @returns {{ sensitiveFiles: string[], bracketWarnings: string[], patternWarnings: string[] }}
 */
function analyzeChangedFiles(changedFiles, repoRoot) {
  const sensitiveFiles = [];
  const bracketWarnings = [];
  const patternWarnings = [];

  for (const file of changedFiles) {
    if (isSkippablePath(file)) continue;

    if (isSensitiveFile(file)) sensitiveFiles.push(file);
    if (!hasExtension(file, CODE_EXTENSIONS)) continue;

    const absPath = path.join(repoRoot, file);
    if (!existsSync(absPath)) continue;

    try {
      const content = readFileSync(absPath, 'utf-8');
      const basename = path.basename(file);
      const ext = path.extname(file);
      const bracketIssue = checkBracketMismatch(absPath, ext);
      if (bracketIssue) bracketWarnings.push(`${basename}: ${bracketIssue}`);
      // Pattern checks are advisory only; skip for files where console output
      // and TODO/FIXME references are legitimate: CLI scripts under scripts/**,
      // test files, the review-gate itself (isSelfFile), and CJS one-shots.
      const isCliScript = /\/scripts\//.test(file);
      const isTestFile = /\/tests\//.test(file) || /\.test\.|\.spec\./.test(file);
      const isSelfFile = file.endsWith('stop-review-gate.js');
      const isCjs = file.endsWith('.cjs');
      if (!isCliScript && !isTestFile && !isSelfFile && !isCjs) {
        patternWarnings.push(...checkPatternViolations(content, basename));
      }
    } catch {
      // Skip unreadable files
    }
  }

  return { sensitiveFiles, bracketWarnings, patternWarnings };
}

/**
 * Aggregate analysis results into a flat issues array.
 * @param {{ sensitiveFiles: string[], bracketWarnings: string[], patternWarnings: string[] }} analysis
 * @param {string[]} missingTests
 * @returns {string[]}
 */
function aggregateIssues(analysis, missingTests) {
  const issues = [];
  const { sensitiveFiles, bracketWarnings, patternWarnings } = analysis;

  if (sensitiveFiles.length > 0) {
    issues.push(`Sensitive files changed: ${sensitiveFiles.join(', ')}`);
  }
  if (bracketWarnings.length > 0) {
    issues.push(`Bracket mismatch: ${bracketWarnings.join('; ')}`);
  }
  if (patternWarnings.length > 0) {
    issues.push(`Pattern violations: ${patternWarnings.join('; ')}`);
  }
  if (missingTests.length > 0) {
    issues.push(`Code without tests: ${missingTests.slice(0, 5).join(', ')}`);
  }
  return issues;
}

/**
 * Build the final review gate result and write to stdout.
 *
 * Loop-guard: when issues exist but the fingerprint matches the prior gate
 * fire (same HEAD + same changed files), downgrade `block` to advisory log.
 * Without this the gate would block every Stop event for persistent issues
 * — same UX lock-up that motivated dev-verify-gate.js's fingerprint cache.
 *
 * @param {string[]} issues
 * @param {string[]} changedFiles
 * @param {string|null} codexMode
 * @param {{ duplicate: boolean, fingerprint: string|null, pluginRoot: string }} cacheCtx
 */
function buildResult(issues, changedFiles, codexMode, cacheCtx) {
  void codexMode; // reserved for future cross-check

  if (issues.length === 0) {
    const reason = `All ${changedFiles.length} changed file(s) passed review gate`;
    log(reason);
    writeStdout({ decision: 'approve', reason });
    return;
  }

  const reason = `Review gate found ${issues.length} issue(s):\n${issues.map((i) => `  - ${i}`).join('\n')}`;

  if (cacheCtx.duplicate) {
    // Same fingerprint as last gate fire — downgrade to silent advisory to
    // avoid blocking the user repeatedly for issues they've already seen.
    log(`(advisory, duplicate fingerprint) ${reason}`);
    return;
  }

  log(reason);
  if (cacheCtx.fingerprint) saveFingerprint(cacheCtx.pluginRoot, cacheCtx.fingerprint);
  writeStdout({ decision: 'block', reason });
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  // Stop-hook recursion guard: if Claude is replaying a Stop event that this
  // hook itself triggered, skip the gate to avoid infinite loops.
  if (hookData.stop_hook_active === true) {
    return;
  }

  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    log('Not in a git repository, skipping review gate');
    return;
  }

  const changedFiles = getChangedFiles(repoRoot);
  if (changedFiles.length === 0) {
    log('No changed files detected');
    writeStdout({ decision: 'approve', reason: 'No changes to review' });
    return;
  }

  const analysis = analyzeChangedFiles(changedFiles, repoRoot);
  const missingTests = checkMissingTests(changedFiles, repoRoot);
  const issues = aggregateIssues(analysis, missingTests);

  // Fingerprint cache + mtime guard (mirrors dev-verify-gate.js loop fix).
  // Only relevant when issues exist — clean runs always emit `approve`.
  const pluginRoot = getPluginRoot();
  let cacheCtx = { duplicate: false, fingerprint: null, pluginRoot };
  if (issues.length > 0) {
    const headSha = getHeadSha(repoRoot) || 'unknown';
    const fingerprint = buildFingerprint(repoRoot, headSha, changedFiles);
    const sameFingerprint = readLastFingerprint(pluginRoot) === fingerprint;
    const noNewerEdits = !hasNewerEdits(pluginRoot, repoRoot, changedFiles);
    cacheCtx = {
      duplicate: sameFingerprint && noNewerEdits,
      fingerprint,
      pluginRoot,
    };
  }

  buildResult(issues, changedFiles, loadCodexMode(), cacheCtx);
  void hookData;
}

main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
