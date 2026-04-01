#!/usr/bin/env node
/**
 * Stop hook — Review Gate.
 * Analyzes recent changes for quality issues before session ends.
 * Checks: bracket mismatch, pattern violations, sensitive files, missing tests.
 * @module scripts/hooks/stop-review-gate
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJSON, readStdin, writeStdout, getPluginRoot } from '../utils/index.js';
import { createErrorHandler, hasExtension, isSkippablePath } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'stop-review-gate';
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

/** @returns {string|null} */
function getRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** @returns {string[]} Changed file paths relative to repo root */
function getChangedFiles(cwd) {
  try {
    const output = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------------
// Quality Checks
// -------------------------------------------------------------------------

/**
 * Check for bracket/brace mismatch in a file.
 * @param {string} content
 * @returns {string|null} Warning message or null
 */
function checkBracketMismatch(content) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const openers = new Set(Object.keys(pairs));
  const closerToOpener = Object.fromEntries(
    Object.entries(pairs).map(([k, v]) => [v, k]),
  );
  const stack = [];
  let inString = false;
  let stringChar = '';
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (ch === stringChar) inString = false;
      continue;
    }

    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue; }

    if (openers.has(ch)) {
      stack.push(ch);
    } else if (closerToOpener[ch]) {
      const expected = closerToOpener[ch];
      if (stack.length === 0 || stack[stack.length - 1] !== expected) {
        return `unmatched '${ch}' detected`;
      }
      stack.pop();
    }
  }

  if (stack.length > 0) {
    const unclosed = stack.map((c) => `'${c}'`).join(', ');
    return `unclosed brackets: ${unclosed}`;
  }
  return null;
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

  const consolePattern = /\bconsole\.(log|debug|info)\s*\(/g;
  const todoPattern = /\b(TODO|FIXME|HACK|XXX)\b/g;

  const consoleHits = [];
  const todoHits = [];

  for (let i = 0; i < lines.length; i++) {
    consolePattern.lastIndex = 0;
    todoPattern.lastIndex = 0;
    if (consolePattern.test(lines[i])) consoleHits.push(i + 1);
    if (todoPattern.test(lines[i])) todoHits.push(i + 1);
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
function checkMissingTests(files, repoRoot) {
  const codeFiles = files.filter(
    (f) => hasExtension(f, TEST_EXTENSIONS) && !f.includes('.test.') && !f.includes('.spec.') && !f.includes('__tests__'),
  );

  const missing = [];
  for (const file of codeFiles) {
    const ext = path.extname(file);
    const base = file.slice(0, -ext.length);
    const testVariants = [
      `${base}.test${ext}`,
      `${base}.spec${ext}`,
    ];
    const hasTest = testVariants.some((t) => existsSync(path.join(repoRoot, t)));
    if (!hasTest) missing.push(file);
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
// Main
// -------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    log('Not in a git repository, skipping review gate');
    return;
  }

  const changedFiles = getChangedFiles(repoRoot);
  if (changedFiles.length === 0) {
    log('No changed files detected');
    writeStdout({ decision: 'ALLOW', reason: 'No changes to review' });
    return;
  }

  const issues = [];
  const sensitiveFiles = [];
  const bracketWarnings = [];
  const patternWarnings = [];

  for (const file of changedFiles) {
    if (isSkippablePath(file)) continue;

    // Sensitive file check
    if (isSensitiveFile(file)) {
      sensitiveFiles.push(file);
    }

    // Content-based checks for code files only
    if (!hasExtension(file, CODE_EXTENSIONS)) continue;

    const absPath = path.join(repoRoot, file);
    if (!existsSync(absPath)) continue;

    try {
      const content = readFileSync(absPath, 'utf-8');
      const basename = path.basename(file);

      // Bracket mismatch
      const bracketIssue = checkBracketMismatch(content);
      if (bracketIssue) bracketWarnings.push(`${basename}: ${bracketIssue}`);

      // Pattern violations
      const violations = checkPatternViolations(content, basename);
      patternWarnings.push(...violations);
    } catch {
      // Skip unreadable files
    }
  }

  // Missing tests check
  const missingTests = checkMissingTests(changedFiles, repoRoot);

  // Aggregate issues
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

  // Build result
  const codexMode = loadCodexMode();
  const needsCodexReview = codexMode === 'review' || codexMode === 'dev';

  if (issues.length > 0) {
    const reason = `Review gate found ${issues.length} issue(s):\n${issues.map((i) => `  - ${i}`).join('\n')}`;
    log(reason);
    writeStdout({
      decision: 'BLOCK',
      reason,
      issues,
      changedFiles,
      ...(needsCodexReview ? { codexCrossCheck: true } : {}),
    });
  } else {
    const reason = `All ${changedFiles.length} changed file(s) passed review gate`;
    log(reason);
    writeStdout({
      decision: 'ALLOW',
      reason,
      changedFiles,
      ...(needsCodexReview ? { codexCrossCheck: true } : {}),
    });
  }

  void hookData;
}

main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
