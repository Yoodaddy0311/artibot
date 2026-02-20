/**
 * Lightweight LSP client for VS Code diagnostics integration.
 * Collects TypeScript/ESLint diagnostics from a project and provides
 * structured data for the cognitive router.
 *
 * Zero runtime dependencies. ESM only.
 * @module lib/system/lsp-client
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Diagnostic severity levels aligned with LSP spec */
const SEVERITY = Object.freeze({
  ERROR: 1,
  WARNING: 2,
  INFORMATION: 3,
  HINT: 4,
});

/** Reverse mapping for display */
const SEVERITY_LABEL = Object.freeze({
  [SEVERITY.ERROR]: 'error',
  [SEVERITY.WARNING]: 'warning',
  [SEVERITY.INFORMATION]: 'information',
  [SEVERITY.HINT]: 'hint',
});

/** Maximum diagnostics collected per source to avoid memory issues */
const MAX_DIAGNOSTICS_PER_SOURCE = 500;

/** Default timeout for external tool execution (ms) */
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types (JSDoc only)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Diagnostic
 * @property {string} file - Relative file path from project root
 * @property {number} line - 1-based line number
 * @property {number} [column] - 1-based column number
 * @property {string} severity - 'error' | 'warning' | 'information' | 'hint'
 * @property {string} message - Human-readable diagnostic message
 * @property {string} [code] - Diagnostic code (e.g. 'TS2345', 'no-unused-vars')
 * @property {string} source - Tool that produced this diagnostic ('tsc' | 'eslint')
 */

/**
 * @typedef {object} DiagnosticSummary
 * @property {number} total - Total diagnostic count
 * @property {number} errors - Error count
 * @property {number} warnings - Warning count
 * @property {string[]} sources - Sources that produced diagnostics
 * @property {Diagnostic[]} diagnostics - Full diagnostic list
 * @property {number} collectedAt - Timestamp of collection
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {DiagnosticSummary|null} */
let lastDiagnostics = null;

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Collect TypeScript diagnostics by running tsc --noEmit.
 *
 * @param {string} projectRoot - Absolute path to project root containing tsconfig.json
 * @param {object} [options]
 * @param {number} [options.timeout=30000] - Execution timeout in ms
 * @param {string} [options.tscPath] - Custom path to tsc binary
 * @returns {Promise<Diagnostic[]>} Array of parsed diagnostics
 * @example
 * const diagnostics = await collectTscDiagnostics('/path/to/project');
 * // [{ file: 'src/index.ts', line: 10, severity: 'error', message: '...', code: 'TS2345', source: 'tsc' }]
 */
export async function collectTscDiagnostics(projectRoot, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const tscPath = options.tscPath ?? findTscBinary(projectRoot);

  if (!tscPath) {
    return [];
  }

  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return [];
  }

  const args = ['--noEmit', '--pretty', 'false', '--project', tsconfigPath];

  try {
    const output = await execCommand(tscPath, args, { cwd: projectRoot, timeout });
    return parseTscOutput(output, projectRoot);
  } catch {
    return [];
  }
}

/**
 * Collect ESLint diagnostics by running eslint with JSON formatter.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} [options]
 * @param {number} [options.timeout=30000] - Execution timeout in ms
 * @param {string} [options.eslintPath] - Custom path to eslint binary
 * @param {string[]} [options.targets=['.']] - Paths to lint relative to project root
 * @returns {Promise<Diagnostic[]>} Array of parsed diagnostics
 * @example
 * const diagnostics = await collectEslintDiagnostics('/path/to/project');
 * // [{ file: 'src/utils.js', line: 5, severity: 'warning', message: '...', code: 'no-unused-vars', source: 'eslint' }]
 */
export async function collectEslintDiagnostics(projectRoot, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const eslintPath = options.eslintPath ?? findEslintBinary(projectRoot);

  if (!eslintPath) {
    return [];
  }

  const targets = options.targets ?? ['.'];
  const args = ['--format', 'json', ...targets];

  try {
    const output = await execCommand(eslintPath, args, { cwd: projectRoot, timeout });
    return parseEslintOutput(output, projectRoot);
  } catch {
    return [];
  }
}

/**
 * Collect all available diagnostics from a project.
 * Runs tsc and eslint in parallel if both are available.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} [options]
 * @param {number} [options.timeout=30000] - Per-tool timeout in ms
 * @param {boolean} [options.tsc=true] - Include TypeScript diagnostics
 * @param {boolean} [options.eslint=true] - Include ESLint diagnostics
 * @returns {Promise<DiagnosticSummary>} Aggregated diagnostic summary
 * @example
 * const summary = await collectDiagnostics('/path/to/project');
 * // { total: 12, errors: 3, warnings: 9, sources: ['tsc', 'eslint'], diagnostics: [...], collectedAt: 1708000000 }
 */
export async function collectDiagnostics(projectRoot, options = {}) {
  const collectors = [];

  if (options.tsc !== false) {
    collectors.push(collectTscDiagnostics(projectRoot, options));
  }
  if (options.eslint !== false) {
    collectors.push(collectEslintDiagnostics(projectRoot, options));
  }

  const results = await Promise.all(collectors);
  const diagnostics = results.flat();

  const summary = buildSummary(diagnostics);
  lastDiagnostics = summary;

  return summary;
}

/**
 * Add diagnostic context to the cognitive router input.
 * Creates a structured context object from diagnostics that can be
 * merged into the router's context parameter.
 *
 * @param {DiagnosticSummary|Diagnostic[]} diagnostics - Diagnostics or summary
 * @returns {{ diagnosticContext: { errorCount: number, warningCount: number, affectedFiles: string[], topIssues: string[], hasCriticalErrors: boolean } }}
 * @example
 * const ctx = addDiagnosticContext(diagnostics);
 * // { diagnosticContext: { errorCount: 3, warningCount: 9, affectedFiles: ['src/index.ts'], topIssues: [...], hasCriticalErrors: true } }
 */
export function addDiagnosticContext(diagnostics) {
  const items = Array.isArray(diagnostics) ? diagnostics : (diagnostics?.diagnostics ?? []);

  const errors = items.filter((d) => d.severity === 'error');
  const warnings = items.filter((d) => d.severity === 'warning');

  const affectedFiles = [...new Set(items.map((d) => d.file))];

  // Top issues: deduplicated by message, sorted by frequency
  const messageCounts = new Map();
  for (const d of items) {
    const key = d.code ? `${d.code}: ${d.message}` : d.message;
    messageCounts.set(key, (messageCounts.get(key) ?? 0) + 1);
  }

  const topIssues = [...messageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([msg, count]) => `${msg} (x${count})`);

  return {
    diagnosticContext: {
      errorCount: errors.length,
      warningCount: warnings.length,
      affectedFiles,
      topIssues,
      hasCriticalErrors: errors.length > 0,
    },
  };
}

/**
 * Get the most recently collected diagnostics.
 *
 * @returns {DiagnosticSummary|null}
 * @example
 * const last = getLastDiagnostics();
 * if (last) console.log(`${last.total} diagnostics from last run`);
 */
export function getLastDiagnostics() {
  return lastDiagnostics;
}

/**
 * Parse a raw diagnostic entry from external data (e.g., VS Code extension).
 * Normalizes various formats into the standard Diagnostic shape.
 *
 * @param {object} raw - Raw diagnostic data
 * @param {string} raw.file - File path
 * @param {number} raw.line - Line number (0 or 1-based)
 * @param {number} [raw.column] - Column number
 * @param {number|string} raw.severity - Severity (LSP numeric or string label)
 * @param {string} raw.message - Diagnostic message
 * @param {string} [raw.code] - Diagnostic code
 * @param {string} [raw.source='external'] - Source identifier
 * @returns {Diagnostic} Normalized diagnostic
 * @example
 * const d = parseDiagnostic({ file: 'foo.ts', line: 0, severity: 1, message: 'error' });
 * // { file: 'foo.ts', line: 1, severity: 'error', message: 'error', source: 'external' }
 */
export function parseDiagnostic(raw) {
  const severity = typeof raw.severity === 'number'
    ? (SEVERITY_LABEL[raw.severity] ?? 'information')
    : String(raw.severity || 'information').toLowerCase();

  return {
    file: String(raw.file || ''),
    line: Math.max(1, Number(raw.line) || 1),
    ...(raw.column !== undefined && raw.column !== null ? { column: Math.max(1, Number(raw.column) || 1) } : {}),
    severity,
    message: String(raw.message || ''),
    ...(raw.code !== undefined && raw.code !== null ? { code: String(raw.code) } : {}),
    source: String(raw.source || 'external'),
  };
}

/**
 * Reset stored diagnostic state.
 * Intended for testing or session boundaries.
 *
 * @returns {void}
 */
export function resetDiagnostics() {
  lastDiagnostics = null;
}

// ---------------------------------------------------------------------------
// Exported constants for consumers
// ---------------------------------------------------------------------------

export { SEVERITY, SEVERITY_LABEL, MAX_DIAGNOSTICS_PER_SOURCE };

// ---------------------------------------------------------------------------
// Internal: Parsers
// ---------------------------------------------------------------------------

/**
 * Parse tsc --pretty false output into Diagnostic[].
 * Format: file(line,col): severity TScode: message
 * @param {string} output - Raw tsc stdout+stderr
 * @param {string} projectRoot - Project root for relative paths
 * @returns {Diagnostic[]}
 */
export function parseTscOutput(output, projectRoot) {
  if (!output || typeof output !== 'string') return [];

  const diagnostics = [];
  const lines = output.split('\n');
  // Match: path(line,col): error TS1234: message
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;

    const [, filePath, lineNum, colNum, severity, code, message] = match;
    const relFile = path.isAbsolute(filePath)
      ? path.relative(projectRoot, filePath)
      : filePath;

    diagnostics.push({
      file: relFile.replace(/\\/g, '/'),
      line: Number(lineNum),
      column: Number(colNum),
      severity,
      message: message.trim(),
      code,
      source: 'tsc',
    });

    if (diagnostics.length >= MAX_DIAGNOSTICS_PER_SOURCE) break;
  }

  return diagnostics;
}

/**
 * Parse ESLint JSON output into Diagnostic[].
 * @param {string} output - Raw eslint JSON stdout
 * @param {string} projectRoot - Project root for relative paths
 * @returns {Diagnostic[]}
 */
export function parseEslintOutput(output, projectRoot) {
  if (!output || typeof output !== 'string') return [];

  let results;
  try {
    results = JSON.parse(output);
  } catch {
    return [];
  }

  if (!Array.isArray(results)) return [];

  const diagnostics = [];

  for (const fileResult of results) {
    if (!fileResult.messages || !Array.isArray(fileResult.messages)) continue;

    const relFile = fileResult.filePath
      ? (path.isAbsolute(fileResult.filePath)
        ? path.relative(projectRoot, fileResult.filePath)
        : fileResult.filePath)
      : '';

    for (const msg of fileResult.messages) {
      diagnostics.push({
        file: relFile.replace(/\\/g, '/'),
        line: msg.line ?? 1,
        ...(msg.column !== undefined && msg.column !== null ? { column: msg.column } : {}),
        severity: msg.severity === 2 ? 'error' : 'warning',
        message: msg.message ?? '',
        ...(msg.ruleId ? { code: msg.ruleId } : {}),
        source: 'eslint',
      });

      if (diagnostics.length >= MAX_DIAGNOSTICS_PER_SOURCE) break;
    }

    if (diagnostics.length >= MAX_DIAGNOSTICS_PER_SOURCE) break;
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Internal: Helpers
// ---------------------------------------------------------------------------

/**
 * Build a DiagnosticSummary from a list of diagnostics.
 * @param {Diagnostic[]} diagnostics
 * @returns {DiagnosticSummary}
 */
function buildSummary(diagnostics) {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const sources = [...new Set(diagnostics.map((d) => d.source))];

  return {
    total: diagnostics.length,
    errors,
    warnings,
    sources,
    diagnostics,
    collectedAt: Date.now(),
  };
}

/**
 * Find tsc binary in node_modules/.bin or global PATH.
 * @param {string} projectRoot
 * @returns {string|null}
 */
function findTscBinary(projectRoot) {
  const localBin = path.join(projectRoot, 'node_modules', '.bin', 'tsc');
  if (existsSync(localBin)) return localBin;

  const localCmd = localBin + '.cmd';
  if (existsSync(localCmd)) return localCmd;

  // Fallback: assume tsc is in PATH
  return 'tsc';
}

/**
 * Find eslint binary in node_modules/.bin or global PATH.
 * @param {string} projectRoot
 * @returns {string|null}
 */
function findEslintBinary(projectRoot) {
  const localBin = path.join(projectRoot, 'node_modules', '.bin', 'eslint');
  if (existsSync(localBin)) return localBin;

  const localCmd = localBin + '.cmd';
  if (existsSync(localCmd)) return localCmd;

  return 'eslint';
}

/**
 * Execute an external command and return stdout + stderr combined.
 * @param {string} command - Binary path
 * @param {string[]} args - Command arguments
 * @param {object} options - Execution options
 * @param {string} options.cwd - Working directory
 * @param {number} options.timeout - Timeout in ms
 * @returns {Promise<string>}
 */
function execCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      windowsHide: true,
    }, (error, stdout, stderr) => {
      // tsc and eslint exit with non-zero when they find issues,
      // so we treat stdout+stderr as valid output even on error
      const output = (stdout || '') + (stderr || '');
      if (output.length > 0) {
        resolve(output);
      } else if (error) {
        reject(error);
      } else {
        resolve('');
      }
    });
  });
}
