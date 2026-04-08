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
import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
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
    execSync(`node --check "${absPath}"`, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
    });
    return null;
  } catch (err) {
    const stderr = String(err.stderr || err.message || '').trim();
    // Extract the first error line for a terse message.
    const firstLine = stderr.split('\n').find((l) => /SyntaxError|error/i.test(l));
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
    (f) => hasExtension(f, TEST_EXTENSIONS)
      && !f.includes('.test.')
      && !f.includes('.spec.')
      && !f.includes('__tests__')
      // CLI entry scripts and one-shot utilities don't need tests:
      && !/\/scripts\/hooks\//.test(f)
      && !/\/scripts\/(validate-|migrate-|audit-|generate-|phase\d+-audit|inject-)/.test(f),
  );

  const missing = [];
  for (const file of codeFiles) {
    const ext = path.extname(file);
    const base = file.slice(0, -ext.length);
    const baseName = path.basename(base);

    // Sibling-path variants: foo.js -> foo.test.js
    const siblingVariants = [`${base}.test${ext}`, `${base}.spec${ext}`];

    // Mirror-path variants: lib/core/foo.js -> tests/core/foo.test.js
    //                       lib/runtime/foo.js -> tests/runtime/foo.test.js
    //                       scripts/foo.js -> tests/scripts/foo.test.js
    const mirrorVariants = [];
    const libMatch = file.match(/(.*?\/)(?:lib|scripts)\/(.+?)\/([^/]+)\.(js|mjs|cjs|ts|tsx|jsx)$/);
    if (libMatch) {
      const [, pluginPath, subdir, name, e] = libMatch;
      mirrorVariants.push(
        `${pluginPath}tests/${subdir}/${name}.test.${e}`,
        `${pluginPath}tests/${subdir}/${name}.spec.${e}`,
      );
    }
    // Generic tests/** search: any file under tests/ whose basename matches.
    const testsRoot = path.join(repoRoot, 'plugins', 'artibot', 'tests');
    const genericCandidates = [
      path.join(testsRoot, 'core', `${baseName}.test${ext}`),
      path.join(testsRoot, 'hooks', `${baseName}.test${ext}`),
      path.join(testsRoot, 'runtime', `${baseName}.test${ext}`),
      path.join(testsRoot, 'scripts', `${baseName}.test${ext}`),
    ];

    const allVariants = [
      ...siblingVariants.map((t) => path.join(repoRoot, t)),
      ...mirrorVariants.map((t) => path.join(repoRoot, t)),
      ...genericCandidates,
    ];
    const hasTest = allVariants.some((t) => existsSync(t));
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
      patternWarnings.push(...checkPatternViolations(content, basename));
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
 * @param {string[]} issues
 * @param {string[]} changedFiles
 * @param {string|null} codexMode
 */
function buildResult(issues, changedFiles, codexMode) {
  // Reserved: codexMode can trigger cross-check in future releases.
  // Currently the flag is informational only.
  void codexMode;

  if (issues.length > 0) {
    const reason = `Review gate found ${issues.length} issue(s):\n${issues.map((i) => `  - ${i}`).join('\n')}`;
    log(reason);
    writeStdout({ decision: 'block', reason });
  } else {
    const reason = `All ${changedFiles.length} changed file(s) passed review gate`;
    log(reason);
    writeStdout({ decision: 'approve', reason });
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
    writeStdout({ decision: 'approve', reason: 'No changes to review' });
    return;
  }

  const analysis = analyzeChangedFiles(changedFiles, repoRoot);
  const missingTests = checkMissingTests(changedFiles, repoRoot);
  const issues = aggregateIssues(analysis, missingTests);

  buildResult(issues, changedFiles, loadCodexMode());
  void hookData;
}

main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
