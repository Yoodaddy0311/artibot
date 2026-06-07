/**
 * Central guard registry for hook-based safety checks.
 * Consolidates patterns and logic from pre-bash, pre-write, and quality-gate hooks
 * into a single registry with chainable guard execution.
 * @module lib/core/guard-registry
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BLOCKED_PATTERNS } from './blocked-patterns.js';
import { extractFilePath, isArtibotRepo, isSkippablePath, matchesPathPattern } from './hook-utils.js';

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
 * @param {string} [guard.category='artibot-policy'] - 'security-critical' or
 *   'artibot-policy'. Security-critical guards run everywhere; artibot-policy
 *   guards are skipped when the cwd is not the Artibot plugin repo (see
 *   {@link executeChain}).
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
  const category = guard.category || 'artibot-policy';
  if (category !== 'security-critical' && category !== 'artibot-policy') {
    throw new Error(`Guard "${guard.name}" has invalid category: "${category}". Must be "security-critical" or "artibot-policy".`);
  }
  guards = [...guards, { ...guard, category }];
}

/**
 * Execute the guard chain for a given phase and tool.
 * Runs matching guards sequentially. Stops on first block.
 *
 * Scope policy (added v4.7.4): when the caller's cwd is not the Artibot plugin
 * repo, only `security-critical` guards run. `artibot-policy` guards
 * (console-log, sensitive-file, content-secret, hardcoded-secret, file-size)
 * are skipped silently to avoid false positives in unrelated user projects
 * where Artibot is installed globally via `~/.claude/`.
 *
 * @param {string} phase - 'pre' or 'post'
 * @param {string} toolName - Tool name (e.g. 'Bash', 'Write', 'Edit')
 * @param {object} hookData - Raw hook data from stdin
 * @param {object} [opts]
 * @param {string} [opts.cwd] - Working directory used for the Artibot-repo
 *   scope check. Defaults to `process.cwd()` when omitted.
 * @returns {{decision: string, reason?: string, warnings: string[]}}
 */
export function executeChain(phase, toolName, hookData, opts = {}) {
  let matching = guards.filter(
    (g) => g.phase === phase && g.tools.includes(toolName),
  );

  if (matching.length === 0) {
    return { decision: 'approve', warnings: [] };
  }

  const cwd = opts.cwd || process.cwd();
  if (!isArtibotRepo(cwd)) {
    matching = matching.filter((g) => g.category === 'security-critical');
    if (matching.length === 0) {
      return { decision: 'approve', warnings: [] };
    }
  }

  const ctx = buildContext(phase, toolName, hookData);
  const warnings = [];

  for (const guard of matching) {
    let result;
    try {
      result = guard.check(ctx);
    } catch (err) {
      // Fail-closed: a broken guard must never silently pass
      return {
        decision: 'block',
        reason: `Guard '${guard.name}' threw: ${err.message}`,
        guardName: guard.name,
        warnings,
      };
    }
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
    .map(({ name, phase: p, tools, category }) => ({ name, phase: p, tools, category }));
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

/** Sensitive environment variable names that must not leak in tool output. */
const ENV_VAR_BLOCKLIST = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GITHUB_PAT',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AZURE_CLIENT_SECRET',
  'GCP_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'STRIPE_SECRET_KEY', 'TWILIO_AUTH_TOKEN', 'SENDGRID_API_KEY',
  'DATABASE_URL', 'REDIS_URL', 'MONGODB_URI',
  'JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY',
  'SLACK_TOKEN', 'DISCORD_TOKEN', 'TELEGRAM_BOT_TOKEN',
  'SSH_PRIVATE_KEY', 'GPG_PASSPHRASE',
  'FIREBASE_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'VERCEL_TOKEN', 'NETLIFY_AUTH_TOKEN',
  'NPM_TOKEN', 'PYPI_TOKEN', 'DOCKER_PASSWORD',
]);

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

const IS_WINDOWS = process.platform === 'win32';

const GITBASH_PATH = /(?:^|[\s'"=(])\/[a-z]\/Users\//i;
const TMP_ABS_PATH = /(?:^|[\s'"=(])\/tmp\//;
const INTERPRETER_INLINE = /\b(?:python|python3|py|node|deno|bun|ruby|perl|php)(?:\.exe)?\s+(?:-c|-e)\b/i;

/** Detect path forms that fail when handed off to non-bash interpreters on Windows. */
function checkPathPortability(ctx) {
  if (!IS_WINDOWS) return null;
  const command = ctx.toolInput?.command || '';
  if (!command) return null;

  const hits = [];
  if (INTERPRETER_INLINE.test(command) && GITBASH_PATH.test(command)) {
    hits.push('git-bash path (/c/Users/...) inside interpreter inline code — non-bash runtimes cannot resolve it. Use Windows-style absolute paths (C:\\Users\\...) instead.');
  }
  if (TMP_ABS_PATH.test(command)) {
    hits.push('Absolute /tmp/ path on Windows — directory does not exist. Use $TMPDIR/$TEMP or a project-local temp dir.');
  }
  if (hits.length === 0) return null;
  return {
    decision: 'warn',
    reason: `path portability: ${hits.join(' | ')}`,
    guardName: 'path-portability',
  };
}

/** Detect unmatched bash quotes / heredocs that produce "unexpected EOF" failures. */
function checkBashQuoteBalance(ctx) {
  const command = ctx.toolInput?.command || '';
  if (!command || command.length > 8000) return null;

  let stripped = command.replace(/\\./g, '');
  stripped = stripped.replace(/<<-?\s*'([A-Z_][A-Z0-9_]*)'[\s\S]*?\n\1\s*$/gm, '');
  stripped = stripped.replace(/<<-?\s*"?([A-Z_][A-Z0-9_]*)"?[\s\S]*?\n\1\s*$/gm, '');

  const single = (stripped.match(/'/g) || []).length;
  const double = (stripped.match(/"/g) || []).length;
  const issues = [];
  if (single % 2 === 1) issues.push("unmatched single-quote (')");
  if (double % 2 === 1) issues.push('unmatched double-quote (")');

  const heredocOpens = (command.match(/<<-?\s*'?"?[A-Z_][A-Z0-9_]*'?"?/g) || []).length;
  const heredocCloses = (command.match(/^[A-Z_][A-Z0-9_]*\s*$/gm) || []).length;
  if (heredocOpens > heredocCloses) issues.push('unterminated heredoc');

  if (issues.length === 0) return null;
  return {
    decision: 'warn',
    reason: `bash lint: ${issues.join(', ')} — likely to fail with "unexpected EOF". Use 'EOF' heredoc or escape inner quotes.`,
    guardName: 'bash-lint',
  };
}

/** Check tool output for sensitive env var name exposure (post phase). */
function checkEnvVarExposure(ctx) {
  const output = typeof ctx.toolResult === 'string'
    ? ctx.toolResult
    : JSON.stringify(ctx.toolResult ?? '');
  if (!output) return null;

  const found = [];
  for (const name of ENV_VAR_BLOCKLIST) {
    const pattern = new RegExp(
      `(?:^|\\s|["'\`])(?:export\\s+)?` +
      name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      `(?:\\s*=|\\b)` +
      `|\\$\\{?` +
      name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      `\\}?`,
    );
    if (pattern.test(output)) {
      found.push(name);
    }
  }

  if (found.length > 0) {
    return {
      decision: 'warn',
      reason: `Sensitive env var name detected in output: ${found.join(', ')}. Avoid exposing secret variable names.`,
      guardName: 'env-var-exposure',
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
 * Register all built-in guards.
 *
 * Each guard is tagged with a category that determines whether it runs
 * outside the Artibot plugin repo (see {@link executeChain}):
 *
 *   - `security-critical`: runs everywhere (dangerous shell commands,
 *     bash-lint hygiene, Windows path-portability) — these are not Artibot
 *     opinions, they protect any project the user happens to be in.
 *   - `artibot-policy`: skipped in non-Artibot repos to prevent
 *     false-positive noise (e.g. flagging `.env` writes in a Next.js
 *     project that legitimately writes its own secrets).
 */
export function registerBuiltinGuards() {
  registerGuard({
    name: 'dangerous-command',
    phase: 'pre',
    tools: ['Bash'],
    category: 'security-critical',
    check: checkDangerousCommand,
  });

  registerGuard({
    name: 'path-portability',
    phase: 'pre',
    tools: ['Bash'],
    category: 'security-critical',
    check: checkPathPortability,
  });

  registerGuard({
    name: 'bash-lint',
    phase: 'pre',
    tools: ['Bash'],
    category: 'security-critical',
    check: checkBashQuoteBalance,
  });

  registerGuard({
    name: 'sensitive-file',
    phase: 'pre',
    tools: ['Write', 'Edit'],
    category: 'artibot-policy',
    check: checkSensitiveFile,
  });

  registerGuard({
    name: 'content-secret',
    phase: 'pre',
    tools: ['Write', 'Edit'],
    category: 'artibot-policy',
    check: checkContentSecret,
  });

  registerGuard({
    name: 'console-log',
    phase: 'post',
    tools: ['Edit', 'Write'],
    category: 'artibot-policy',
    check: checkConsoleLog,
  });

  registerGuard({
    name: 'hardcoded-secret',
    phase: 'post',
    tools: ['Edit', 'Write'],
    category: 'artibot-policy',
    check: checkHardcodedSecret,
  });

  registerGuard({
    name: 'file-size',
    phase: 'post',
    tools: ['Edit', 'Write'],
    category: 'artibot-policy',
    check: checkFileSize,
  });

  registerGuard({
    name: 'env-var-exposure',
    phase: 'post',
    tools: ['Bash'],
    category: 'security-critical',
    check: checkEnvVarExposure,
  });
}
