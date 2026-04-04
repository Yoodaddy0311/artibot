/**
 * Central guard registry for hook-based safety checks.
 * Consolidates patterns and logic from pre-bash, pre-write, and quality-gate hooks
 * into a single registry with chainable guard execution.
 * @module lib/core/guard-registry
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BLOCKED_PATTERNS } from './blocked-patterns.js';
import { extractFilePath, isSkippablePath, matchesPathPattern } from './hook-utils.js';

// -------------------------------------------------------------------------
// Registry State
// -------------------------------------------------------------------------

/** @type {Array<{name: string, phase: string, tools: string[], check: Function}>} */
let guards = [];

// -------------------------------------------------------------------------
// Registry API
// -------------------------------------------------------------------------

/**
 * Register a guard in the registry.
 * @param {object} guard
 * @param {string} guard.name - Unique guard identifier
 * @param {string} guard.phase - 'pre' or 'post'
 * @param {string[]} guard.tools - Tool names this guard applies to
 * @param {Function} guard.check - (ctx) => GuardResult | null
 * @throws {Error} If guard definition is invalid
 */
export function registerGuard(guard) {
  if (!guard || !guard.name) {
    throw new Error('Guard must have a name');
  }
  if (guard.phase !== 'pre' && guard.phase !== 'post') {
    throw new Error(`Guard "${guard.name}" has invalid phase: "${guard.phase}". Must be "pre" or "post".`);
  }
  if (!Array.isArray(guard.tools) || guard.tools.length === 0) {
    throw new Error(`Guard "${guard.name}" must have a non-empty tools array.`);
  }
  if (typeof guard.check !== 'function') {
    throw new Error(`Guard "${guard.name}" must have a check function.`);
  }
  guards = [...guards, { ...guard }];
}

/**
 * Execute the guard chain for a given phase and tool.
 * Runs matching guards sequentially. Stops on first block.
 * @param {string} phase - 'pre' or 'post'
 * @param {string} toolName - Tool name (e.g. 'Bash', 'Write', 'Edit')
 * @param {object} hookData - Raw hook data from stdin
 * @returns {{decision: string, reason?: string, warnings: string[]}}
 */
export function executeChain(phase, toolName, hookData) {
  const matching = guards.filter(
    (g) => g.phase === phase && g.tools.includes(toolName),
  );

  if (matching.length === 0) {
    return { decision: 'approve', warnings: [] };
  }

  const ctx = buildContext(phase, toolName, hookData);
  const warnings = [];

  for (const guard of matching) {
    const result = guard.check(ctx);
    if (!result) continue;

    if (result.decision === 'block') {
      return {
        decision: 'block',
        reason: result.reason || `Blocked by guard: ${guard.name}`,
        guardName: result.guardName || guard.name,
        warnings,
      };
    }

    if (result.decision === 'warn') {
      warnings.push(result.reason || `Warning from guard: ${guard.name}`);
    }
  }

  return { decision: 'approve', warnings };
}

/**
 * List guards registered for a given phase and tool.
 * @param {string} [phase] - Filter by phase
 * @param {string} [toolName] - Filter by tool
 * @returns {Array<{name: string, phase: string, tools: string[]}>}
 */
export function listGuards(phase, toolName) {
  return guards
    .filter((g) => {
      if (phase && g.phase !== phase) return false;
      if (toolName && !g.tools.includes(toolName)) return false;
      return true;
    })
    .map(({ name, phase: p, tools }) => ({ name, phase: p, tools }));
}

/**
 * Reset all registered guards (for testing).
 */
export function resetGuards() {
  guards = [];
}

// -------------------------------------------------------------------------
// Context Builder
// -------------------------------------------------------------------------

/**
 * Build a GuardContext from hook data.
 * For post phase, reads file content once for sharing across guards.
 * @param {string} phase
 * @param {string} toolName
 * @param {object} hookData
 * @returns {object} GuardContext
 */
function buildContext(phase, toolName, hookData) {
  const filePath = extractFilePath(hookData);
  const ctx = {
    phase,
    toolName,
    toolInput: hookData?.tool_input || {},
    toolResult: hookData?.tool_result || null,
    filePath,
    fileContent: null,
  };

  if (phase === 'post' && filePath && !isSkippablePath(filePath)) {
    ctx.fileContent = readFileSafe(filePath);
  }

  return ctx;
}

/**
 * Safely read file content. Returns null on failure.
 * @param {string} filePath
 * @returns {string|null}
 */
function readFileSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------
// Built-in Guard Patterns
// -------------------------------------------------------------------------

/** @see {BLOCKED_PATTERNS} imported from ./blocked-patterns.js */

/**
 * Normalize a command string to defeat common evasion techniques.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeCommand(raw) {
  let cmd = raw;
  // eslint-disable-next-line no-control-regex
  cmd = cmd.replace(/\u001b\[[0-9;]*m/g, '');
  cmd = cmd.replace(/`([^`]*)`/g, '$1');
  cmd = cmd.replace(/\$\(([^)]*)\)/g, '$1');
  cmd = cmd.replace(/\$?'([^']*)'/g, '$1');
  cmd = cmd.replace(/"([^"]*)"/g, '$1');
  cmd = cmd.replace(/\\(.)/g, '$1');
  cmd = cmd.replace(/\$\{[^}]*\}/g, ' ');
  cmd = cmd.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, ' ');
  cmd = cmd.replace(/\s+/g, ' ').trim();
  return cmd;
}

/** Sensitive file path patterns for Write/Edit guard. */
const SENSITIVE_PATTERNS = [
  /\.env($|\.)/i, /credentials/i, /\.pem$/i, /\.key$/i,
  /\.p12$/i, /\.pfx$/i, /secrets?\./i, /\.secret$/i,
  /id_rsa/i, /id_ed25519/i, /token\.json$/i,
  /service.account\.json$/i, /\.npmrc$/i, /\.netrc$/i,
  /_netrc$/i, /\.htpasswd$/i, /\.jks$/i, /kubeconfig/i,
  /\.docker\/config\.json$/i, /wp-config\.php$/i, /database\.yml$/i,
];

/** Exact sensitive filenames. */
const SENSITIVE_FILENAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development',
  'credentials.json', 'secrets.json', 'serviceAccountKey.json',
  '.npmrc', '.netrc', '_netrc', '.htpasswd', 'kubeconfig',
]);

/** Secret content patterns (pre phase). */
const SECRET_CONTENT_PATTERNS = [
  /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|password|passwd)\s*[=:]\s*["'][^"']{8,}["']/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bsk-ant-[A-Za-z0-9-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
];

/** Hardcoded secret patterns (post phase, broader). */
const POST_SECRET_PATTERNS = [
  /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|password|passwd|credentials?)\s*[=:]\s*["'][^"']{8,}["']/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(?:["'])[A-Za-z0-9+/]{32,}={0,2}["']/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bsk-ant-[A-Za-z0-9-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
];

/** Comment line pattern for skipping in secret detection. */
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*)/;

/** console.* usage pattern. */
const CONSOLE_LOG_PATTERN = /\bconsole\.(log|debug|info|warn|error|trace)\s*\(/g;

/** File extensions to inspect in post phase. */
const INSPECTABLE_EXTS = new Set([
  'js', 'ts', 'mjs', 'cjs', 'jsx', 'tsx',
  'py', 'rb', 'go', 'java', 'cs', 'php', 'rs',
  'sh', 'bash', 'zsh',
]);

const MAX_FILE_LINES = 800;

// -------------------------------------------------------------------------
// Built-in Guard Implementations
// -------------------------------------------------------------------------

/** Safe command patterns that override block patterns (e.g. --force-with-lease). */
const SAFE_OVERRIDES = [
  /--force-with-lease/i,
  /--force-if-includes/i,
];

/** Check dangerous Bash commands. */
function checkDangerousCommand(ctx) {
  const command = ctx.toolInput?.command || '';
  if (!command) return null;

  const normalized = normalizeCommand(command);
  const variants = [command, normalized];

  for (const { pattern, label } of BLOCKED_PATTERNS) {
    for (const variant of variants) {
      if (pattern.test(variant)) {
        // Allow safe variants (e.g. --force-with-lease is a safe force push)
        if (SAFE_OVERRIDES.some((safe) => safe.test(command))) {
          continue;
        }
        return {
          decision: 'block',
          reason: `DANGEROUS COMMAND DETECTED: "${label}". Command: "${command}". This operation is blocked for safety.`,
          guardName: 'dangerous-command',
        };
      }
    }
  }
  return null;
}

/** Check sensitive file paths. */
function checkSensitiveFile(ctx) {
  if (!ctx.filePath) return null;

  const basename = path.basename(ctx.filePath);
  const isSensitive =
    SENSITIVE_FILENAMES.has(basename) ||
    matchesPathPattern(basename, SENSITIVE_PATTERNS);

  if (isSensitive) {
    return {
      decision: 'block',
      reason: `SECURITY WARNING: "${basename}" appears to be a sensitive file. Writing to credential or secret files is blocked by default.`,
      guardName: 'sensitive-file',
    };
  }
  return null;
}

/** Check content for hardcoded secrets (pre phase). */
function checkContentSecret(ctx) {
  const content = ctx.toolInput?.content || ctx.toolInput?.new_string || '';
  if (!content) return null;

  const nonCommentLines = content
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');

  for (const secretPattern of SECRET_CONTENT_PATTERNS) {
    secretPattern.lastIndex = 0;
    if (secretPattern.test(nonCommentLines)) {
      return {
        decision: 'block',
        reason: 'SECURITY WARNING: The content being written appears to contain a hardcoded secret or credential.',
        guardName: 'content-secret',
      };
    }
  }
  return null;
}

/** Check for console.log usage (post phase). */
function checkConsoleLog(ctx) {
  if (!ctx.fileContent) return null;
  if (!isInspectableFile(ctx.filePath)) return null;

  const matches = ctx.fileContent.match(CONSOLE_LOG_PATTERN);
  if (matches && matches.length > 0) {
    const count = matches.length;
    return {
      decision: 'warn',
      reason: `console.log/debug found (${count} occurrence${count > 1 ? 's' : ''}) in ${path.basename(ctx.filePath)}`,
      guardName: 'console-log',
    };
  }
  return null;
}

/** Check for hardcoded secrets in written file (post phase). */
function checkHardcodedSecret(ctx) {
  if (!ctx.fileContent) return null;
  if (!isInspectableFile(ctx.filePath)) return null;

  const lines = ctx.fileContent.split('\n');
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;

    for (const pattern of POST_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.push({ line: i + 1, snippet: line.trim().slice(0, 80) });
        break;
      }
    }
  }

  if (findings.length > 0) {
    const details = findings.slice(0, 3)
      .map((f) => `line ${f.line}: ${f.snippet}`)
      .join('; ');
    const extra = findings.length > 3 ? ` ...and ${findings.length - 3} more` : '';
    return {
      decision: 'block',
      reason: `Potential hardcoded secret at ${details}${extra}. Remove hardcoded secrets before proceeding.`,
      guardName: 'hardcoded-secret',
    };
  }
  return null;
}

/** Check file size exceeds maximum (post phase). */
function checkFileSize(ctx) {
  if (!ctx.fileContent) return null;
  if (!isInspectableFile(ctx.filePath)) return null;

  const lineCount = ctx.fileContent.split('\n').length;
  if (lineCount > MAX_FILE_LINES) {
    return {
      decision: 'warn',
      reason: `File exceeds ${MAX_FILE_LINES} lines (${lineCount} lines). Consider splitting into smaller modules.`,
      guardName: 'file-size',
    };
  }
  return null;
}

/**
 * Check if a file has an inspectable source code extension.
 * @param {string} filePath
 * @returns {boolean}
 */
function isInspectableFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return INSPECTABLE_EXTS.has(ext);
}

// -------------------------------------------------------------------------
// Built-in Registration
// -------------------------------------------------------------------------

/**
 * Register all 6 built-in guards.
 */
export function registerBuiltinGuards() {
  registerGuard({
    name: 'dangerous-command',
    phase: 'pre',
    tools: ['Bash'],
    check: checkDangerousCommand,
  });

  registerGuard({
    name: 'sensitive-file',
    phase: 'pre',
    tools: ['Write', 'Edit'],
    check: checkSensitiveFile,
  });

  registerGuard({
    name: 'content-secret',
    phase: 'pre',
    tools: ['Write', 'Edit'],
    check: checkContentSecret,
  });

  registerGuard({
    name: 'console-log',
    phase: 'post',
    tools: ['Edit', 'Write'],
    check: checkConsoleLog,
  });

  registerGuard({
    name: 'hardcoded-secret',
    phase: 'post',
    tools: ['Edit', 'Write'],
    check: checkHardcodedSecret,
  });

  registerGuard({
    name: 'file-size',
    phase: 'post',
    tools: ['Edit', 'Write'],
    check: checkFileSize,
  });
}
