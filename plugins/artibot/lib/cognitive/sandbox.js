/**
 * Safe execution sandbox for System 2 reasoning.
 * Provides an isolated execution context with dangerous command blocking,
 * resource limits, and result validation.
 * @module lib/cognitive/sandbox
 */

// path and getPlatform reserved for future sandbox CWD/platform-specific logic

/**
 * Dangerous command patterns that are always blocked.
 * Extends the patterns from scripts/hooks/pre-bash.js for sandbox scope.
 * @type {Array<{ pattern: RegExp, label: string }>}
 */
const BLOCKED_PATTERNS = [
  // Filesystem destruction
  { pattern: /rm\s+(-\w*r\w*f|--recursive).*\//i, label: 'rm -rf with path' },
  { pattern: /rm\s+-\w*f\w*r.*\//i, label: 'rm -fr with path' },
  { pattern: /del\s+\/s\s+\/q/i, label: 'del /s /q (Windows recursive delete)' },
  { pattern: /rmdir\s+\/s\s+\/q/i, label: 'rmdir /s /q (Windows recursive delete)' },
  { pattern: /:\s*>\s*\//i, label: 'truncate file' },

  // Disk / filesystem
  { pattern: /mkfs\./i, label: 'format filesystem' },
  { pattern: /dd\s+if=/i, label: 'dd raw disk write' },
  { pattern: />\s*\/dev\/sd/i, label: 'write to disk device' },
  { pattern: /format\s+[a-z]:/i, label: 'format drive (Windows)' },
  { pattern: /diskpart/i, label: 'diskpart (Windows disk management)' },

  // Permission escalation
  { pattern: /chmod\s+-R\s+777/i, label: 'chmod 777 recursive' },
  { pattern: /chown\s+-R\s+root/i, label: 'chown to root recursive' },

  // Git destructive
  { pattern: /git\s+push\s+.*--force/i, label: 'git push --force' },
  { pattern: /git\s+push\s+-f\b/i, label: 'git push -f' },
  { pattern: /git\s+reset\s+--hard/i, label: 'git reset --hard' },
  { pattern: /git\s+clean\s+-\w*f/i, label: 'git clean -f' },

  // Database destruction
  { pattern: /drop\s+(database|table|schema)\b/i, label: 'DROP DATABASE/TABLE' },
  { pattern: /truncate\s+table\b/i, label: 'TRUNCATE TABLE' },
  { pattern: /delete\s+from\s+\w+\s*;?\s*$/i, label: 'DELETE FROM without WHERE' },

  // Package publishing
  { pattern: /npm\s+publish/i, label: 'npm publish' },

  // System shutdown / reboot
  { pattern: /shutdown\s/i, label: 'system shutdown' },
  { pattern: /reboot\b/i, label: 'system reboot' },
  { pattern: /init\s+0\b/i, label: 'init 0 (halt)' },

  // Network abuse
  { pattern: /:(){ :\|:& };:/i, label: 'fork bomb' },
  { pattern: /wget\s+.*\|\s*(sh|bash)/i, label: 'pipe download to shell' },
  { pattern: /curl\s+.*\|\s*(sh|bash)/i, label: 'pipe download to shell' },

  // Environment destruction
  { pattern: /unset\s+(PATH|HOME|USER)\b/i, label: 'unset critical env var' },
  { pattern: /export\s+PATH\s*=\s*$/i, label: 'empty PATH' },
];

/**
 * Default sandbox configuration.
 */
const DEFAULT_OPTIONS = {
  /** Maximum execution time per command in milliseconds */
  timeoutMs: 30_000,
  /** Maximum total sandbox lifetime in milliseconds */
  maxLifetimeMs: 300_000,
  /** Working directory for command execution */
  cwd: undefined,
  /** Environment variables overlay */
  env: {},
  /** Whether to allow network access (advisory, not enforced at OS level) */
  allowNetwork: true,
  /** Whether to allow file writes (advisory, validated post-execution) */
  allowWrites: true,
  /** Maximum stdout/stderr capture size in bytes */
  maxOutputBytes: 1_048_576, // 1 MB
  /** Additional blocked patterns beyond defaults */
  extraBlockedPatterns: [],
};

let sandboxIdCounter = 0;

/**
 * Create an isolated sandbox execution context.
 *
 * @param {object} [options] - Sandbox configuration
 * @param {number} [options.timeoutMs=30000] - Per-command timeout in ms
 * @param {number} [options.maxLifetimeMs=300000] - Total sandbox lifetime in ms
 * @param {string} [options.cwd] - Working directory
 * @param {object} [options.env] - Environment variable overlay
 * @param {boolean} [options.allowNetwork=true] - Allow network access
 * @param {boolean} [options.allowWrites=true] - Allow file writes
 * @param {number} [options.maxOutputBytes=1048576] - Max output capture size
 * @param {Array<{ pattern: RegExp, label: string }>} [options.extraBlockedPatterns] - Additional blocked patterns
 * @returns {{
 *   id: string,
 *   status: 'active' | 'expired' | 'cleaned',
 *   createdAt: string,
 *   expiresAt: string,
 *   options: object,
 *   executionLog: Array<object>,
 *   blockedPatterns: Array<{ pattern: RegExp, label: string }>
 * }}
 */
export function createSandbox(options = {}) {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const now = Date.now();
  sandboxIdCounter += 1;

  const blockedPatterns = [
    ...BLOCKED_PATTERNS,
    ...(resolved.extraBlockedPatterns || []),
  ];

  return {
    id: `sandbox-${now}-${sandboxIdCounter}`,
    status: 'active',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + resolved.maxLifetimeMs).toISOString(),
    options: resolved,
    executionLog: [],
    blockedPatterns,
  };
}

/**
 * Check whether a command is safe to execute within the sandbox.
 *
 * @param {string} command - The command string to validate
 * @param {object} sandbox - Sandbox context from createSandbox()
 * @returns {{ safe: boolean, blockedBy: string | null }}
 */
export function checkCommandSafety(command, sandbox) {
  if (!command || typeof command !== 'string') {
    return { safe: false, blockedBy: 'Empty or invalid command' };
  }

  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { safe: false, blockedBy: 'Empty command' };
  }

  const patterns = sandbox?.blockedPatterns || BLOCKED_PATTERNS;

  for (const { pattern, label } of patterns) {
    if (pattern.test(trimmed)) {
      return { safe: false, blockedBy: label };
    }
  }

  return { safe: true, blockedBy: null };
}

/**
 * Execute a command within the sandbox context.
 * This is a structured representation of execution - actual command execution
 * is delegated to the Claude Code Bash tool by the System 2 engine.
 *
 * @param {string} command - Command to execute
 * @param {object} sandbox - Sandbox context from createSandbox()
 * @returns {{
 *   executed: boolean,
 *   command: string,
 *   sandboxId: string,
 *   blocked: boolean,
 *   blockedBy: string | null,
 *   startedAt: string,
 *   timeoutMs: number,
 *   cwd: string | undefined,
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number | null,
 *   duration: number
 * }}
 */
export function execute(command, sandbox) {
  if (!sandbox || sandbox.status !== 'active') {
    const result = createBlockedResult(command, sandbox?.id || 'unknown', 'Sandbox is not active');
    return result;
  }

  // Check expiration
  if (Date.now() > new Date(sandbox.expiresAt).getTime()) {
    sandbox.status = 'expired';
    const result = createBlockedResult(command, sandbox.id, 'Sandbox has expired');
    sandbox.executionLog.push(result);
    return result;
  }

  // Safety check
  const safety = checkCommandSafety(command, sandbox);
  if (!safety.safe) {
    const result = createBlockedResult(command, sandbox.id, safety.blockedBy);
    sandbox.executionLog.push(result);
    return result;
  }

  // Create execution record (actual execution happens via Claude Code tools)
  const startedAt = new Date().toISOString();
  const result = {
    executed: false, // set to true when actual execution completes
    command,
    sandboxId: sandbox.id,
    blocked: false,
    blockedBy: null,
    startedAt,
    timeoutMs: sandbox.options.timeoutMs,
    cwd: sandbox.options.cwd,
    stdout: '',
    stderr: '',
    exitCode: null,
    duration: 0,
  };

  sandbox.executionLog.push(result);
  return result;
}

/**
 * Record the actual execution result into a sandbox execution record.
 * Called after the Claude Code Bash tool returns.
 *
 * @param {object} executionRecord - Record from execute()
 * @param {object} actualResult - Actual execution result
 * @param {string} [actualResult.stdout=''] - Standard output
 * @param {string} [actualResult.stderr=''] - Standard error
 * @param {number} [actualResult.exitCode=1] - Exit code
 * @param {number} [actualResult.duration=0] - Duration in ms
 * @returns {object} Updated execution record
 */
export function recordResult(executionRecord, actualResult) {
  const maxBytes = DEFAULT_OPTIONS.maxOutputBytes;

  return {
    ...executionRecord,
    executed: true,
    stdout: truncateOutput(actualResult.stdout || '', maxBytes),
    stderr: truncateOutput(actualResult.stderr || '', maxBytes),
    exitCode: actualResult.exitCode ?? 1,
    duration: actualResult.duration || 0,
  };
}

/**
 * Validate an execution result for safety and correctness.
 *
 * @param {object} result - Execution result from execute() or recordResult()
 * @returns {{
 *   safe: boolean,
 *   success: boolean,
 *   issues: string[],
 *   severity: 'none' | 'low' | 'medium' | 'high' | 'critical'
 * }}
 */
export function validate(result) {
  const issues = [];

  // Check if execution was blocked
  if (result.blocked) {
    return {
      safe: false,
      success: false,
      issues: [`Command blocked: ${result.blockedBy}`],
      severity: 'critical',
    };
  }

  // Check if execution actually happened
  if (!result.executed) {
    return {
      safe: true,
      success: false,
      issues: ['Command has not been executed yet'],
      severity: 'none',
    };
  }

  // Check exit code
  const exitOk = result.exitCode === 0;
  if (!exitOk) {
    issues.push(`Non-zero exit code: ${result.exitCode}`);
  }

  // Check stderr for error indicators
  if (result.stderr) {
    const stderrLower = result.stderr.toLowerCase();
    if (stderrLower.includes('error')) {
      issues.push('stderr contains error messages');
    }
    if (stderrLower.includes('fatal')) {
      issues.push('stderr contains fatal error');
    }
    if (stderrLower.includes('permission denied')) {
      issues.push('Permission denied encountered');
    }
    if (stderrLower.includes('segmentation fault') || stderrLower.includes('segfault')) {
      issues.push('Segmentation fault detected');
    }
  }

  // Check for timeout
  if (result.duration > 0 && result.duration >= result.timeoutMs) {
    issues.push(`Execution timed out (${result.duration}ms >= ${result.timeoutMs}ms)`);
  }

  // Determine severity
  let severity = 'none';
  if (issues.length > 0) {
    const hasFatal = issues.some((i) =>
      i.includes('fatal') || i.includes('Segmentation') || i.includes('Permission denied'),
    );
    const hasError = issues.some((i) => i.includes('error') || i.includes('exit code'));
    const hasTimeout = issues.some((i) => i.includes('timed out'));

    if (hasFatal) severity = 'critical';
    else if (hasError && hasTimeout) severity = 'high';
    else if (hasError) severity = 'medium';
    else severity = 'low';
  }

  return {
    safe: severity !== 'critical',
    success: exitOk && issues.length === 0,
    issues,
    severity,
  };
}

/**
 * Get sandbox execution statistics.
 *
 * @param {object} sandbox - Sandbox context
 * @returns {{
 *   totalExecutions: number,
 *   blocked: number,
 *   succeeded: number,
 *   failed: number,
 *   pending: number,
 *   totalDuration: number,
 *   status: string
 * }}
 */
export function getStats(sandbox) {
  if (!sandbox) {
    return {
      totalExecutions: 0,
      blocked: 0,
      succeeded: 0,
      failed: 0,
      pending: 0,
      totalDuration: 0,
      status: 'unknown',
    };
  }

  let blocked = 0;
  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  let totalDuration = 0;

  for (const entry of sandbox.executionLog) {
    if (entry.blocked) {
      blocked += 1;
    } else if (!entry.executed) {
      pending += 1;
    } else if (entry.exitCode === 0) {
      succeeded += 1;
      totalDuration += entry.duration || 0;
    } else {
      failed += 1;
      totalDuration += entry.duration || 0;
    }
  }

  return {
    totalExecutions: sandbox.executionLog.length,
    blocked,
    succeeded,
    failed,
    pending,
    totalDuration,
    status: sandbox.status,
  };
}

/**
 * Clean up sandbox resources and mark as cleaned.
 * Freezes the execution log and invalidates the sandbox for further use.
 *
 * @param {object} sandbox - Sandbox context to clean up
 * @returns {{
 *   sandboxId: string,
 *   status: 'cleaned',
 *   cleanedAt: string,
 *   stats: object
 * }}
 */
export function cleanup(sandbox) {
  if (!sandbox) {
    return {
      sandboxId: 'unknown',
      status: 'cleaned',
      cleanedAt: new Date().toISOString(),
      stats: getStats(null),
    };
  }

  const stats = getStats(sandbox);

  sandbox.status = 'cleaned';
  // Freeze log to prevent further mutations
  Object.freeze(sandbox.executionLog);

  return {
    sandboxId: sandbox.id,
    status: 'cleaned',
    cleanedAt: new Date().toISOString(),
    stats,
  };
}

// --- Internal helpers ---

/**
 * Create a blocked execution result record.
 * @param {string} command - Command that was blocked
 * @param {string} sandboxId - Sandbox identifier
 * @param {string} reason - Reason for blocking
 * @returns {object}
 */
function createBlockedResult(command, sandboxId, reason) {
  return {
    executed: false,
    command,
    sandboxId,
    blocked: true,
    blockedBy: reason,
    startedAt: new Date().toISOString(),
    timeoutMs: 0,
    cwd: undefined,
    stdout: '',
    stderr: `BLOCKED: ${reason}`,
    exitCode: null,
    duration: 0,
  };
}

/**
 * Truncate output string if it exceeds max bytes limit.
 * @param {string} output - Output string to truncate
 * @param {number} maxBytes - Maximum byte size
 * @returns {string}
 */
function truncateOutput(output, maxBytes) {
  if (typeof output !== 'string') return '';
  if (Buffer.byteLength(output, 'utf-8') <= maxBytes) return output;

  // Binary search for the right truncation point
  let lo = 0;
  let hi = output.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(output.slice(0, mid), 'utf-8') <= maxBytes - 50) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return output.slice(0, lo) + '\n... [truncated]';
}
