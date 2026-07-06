/**
 * Autopilot safety guard.
 * Classifies tool calls by risk and decides when the engine should pause.
 *
 * Reference: PRD docs/PRD/autopilot-mode.md sections 5.5 and 13.3.
 *
 * @module lib/autopilot/safety
 */

/**
 * Pattern catalogue used by classifyRisk. Each entry has:
 *  - id: unique identifier
 *  - level: 'caution' | 'danger'
 *  - test: RegExp to match against the command/text payload
 *  - reason: human readable reason
 */
export const DANGEROUS_PATTERNS = Object.freeze([
  { id: 'git-force-push', level: 'danger', test: /\bgit\s+push\b[^\n]*--force(-with-lease)?\b/i, reason: 'Destructive git push --force' },
  { id: 'git-force-push-short', level: 'danger', test: /\bgit\s+push\b[^\n]*\s-f(\s|$)/i, reason: 'Destructive git push -f' },
  { id: 'git-branch-delete', level: 'danger', test: /\bgit\s+branch\s+-D\b/i, reason: 'Force-delete git branch (-D)' },
  { id: 'git-reset-hard', level: 'danger', test: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard discards work' },
  { id: 'git-clean-force', level: 'danger', test: /\bgit\s+clean\s+-[a-z]*f/i, reason: 'git clean -f deletes untracked files' },
  { id: 'rm-rf-root', level: 'danger', test: /\brm\s+-rf?\s+(?:\/(?:\s|$|\*|\w)|~(?:\s|$|\/)|\$HOME(?:\s|$|\/))/i, reason: 'rm -rf on root or home' },
  { id: 'rm-rf-broad', level: 'danger', test: /\brm\s+-rf?\s+\*/i, reason: 'rm -rf with broad glob' },
  { id: 'sql-drop-table', level: 'danger', test: /\bDROP\s+TABLE\b/i, reason: 'SQL DROP TABLE' },
  { id: 'sql-drop-database', level: 'danger', test: /\bDROP\s+DATABASE\b/i, reason: 'SQL DROP DATABASE' },
  { id: 'sql-truncate', level: 'danger', test: /\bTRUNCATE\b/i, reason: 'SQL TRUNCATE' },
  { id: 'sql-delete-no-where', level: 'danger', test: /\bDELETE\s+FROM\s+[\w."` ]+(?!.*\bWHERE\b)/is, reason: 'DELETE FROM without WHERE' },
  { id: 'secret-openai', level: 'danger', test: /\bsk-[A-Za-z0-9]{16,}\b/, reason: 'Possible OpenAI secret key' },
  { id: 'secret-stripe-pub', level: 'caution', test: /\bpk_(live|test)_[A-Za-z0-9]{16,}\b/, reason: 'Possible Stripe key literal' },
  { id: 'secret-private-key', level: 'danger', test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'PEM private key block' },
  { id: 'secret-aws', level: 'danger', test: /\baws_secret_access_key\b/i, reason: 'AWS secret access key reference' },
  { id: 'curl-external', level: 'caution', test: /\bcurl\b[^\n]*\shttps?:\/\//i, reason: 'curl to external host' },
  { id: 'wget-external', level: 'caution', test: /\bwget\b[^\n]*\shttps?:\/\//i, reason: 'wget from external host' },
  { id: 'npm-publish', level: 'danger', test: /\bnpm\s+publish\b/i, reason: 'npm publish (release-grade action)' },
  { id: 'docker-prune', level: 'caution', test: /\bdocker\s+system\s+prune\b/i, reason: 'docker prune deletes resources' },
]);

/**
 * Extract a probe string from a tool call payload.
 * Accepts strings, or objects with command/code/content/input.
 * @param {*} toolCall
 * @returns {string}
 */
function probeText(toolCall) {
  if (toolCall === null || toolCall === undefined) return '';
  if (typeof toolCall === 'string') return toolCall;
  if (typeof toolCall !== 'object') return String(toolCall);
  const candidates = [
    toolCall.command,
    toolCall.cmd,
    toolCall.code,
    toolCall.content,
    toolCall.text,
    toolCall.input,
    toolCall.body,
    toolCall.url,
  ];
  return candidates.filter((v) => typeof v === 'string').join('\n');
}

/**
 * Classify the risk level of a tool call.
 * @param {*} toolCall - String command, or object with command/code/content fields
 * @returns {{ level: 'safe'|'caution'|'danger', reason: string, matchedId?: string }}
 */
export function classifyRisk(toolCall) {
  const text = probeText(toolCall);
  if (!text) return { level: 'safe', reason: 'empty payload' };

  let cautionHit = null;
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.test.test(text)) {
      if (rule.level === 'danger') {
        return { level: 'danger', reason: rule.reason, matchedId: rule.id };
      }
      if (!cautionHit) cautionHit = rule;
    }
  }
  if (cautionHit) {
    return { level: 'caution', reason: cautionHit.reason, matchedId: cautionHit.id };
  }
  return { level: 'safe', reason: 'no dangerous pattern matched' };
}

const DEFAULT_THRESHOLDS = Object.freeze({
  buildFailures: 3,
  testFailures: 5,
  contextRatio: 0.85,
});

/**
 * Parse a duration string like "4h", "30m", "8h", "120s" into milliseconds.
 * @param {string|number|undefined} input
 * @returns {number|null} milliseconds, or null if unparseable
 */
export function parseDuration(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const m = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/i.exec(String(input));
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'ms' ? 1
    : unit === 's' ? 1000
    : unit === 'm' ? 60_000
    : unit === 'h' ? 3_600_000
    : 86_400_000;
  return value * mult;
}

/**
 * Decide whether the autopilot session should be paused.
 * Triggers per PRD section 5.5:
 *  - build failures >= 3
 *  - test failures >= 5
 *  - context usage > 85%
 *  - duration exceeded options.maxDuration
 *
 * @param {object} state - Session state
 * @returns {boolean}
 */
export function shouldPause(state) {
  if (!state || typeof state !== 'object') return false;

  const counters = state.counters || {};
  const buildFailures = Number(counters.buildFailures || 0);
  const testFailures = Number(counters.testFailures || 0);
  if (buildFailures >= DEFAULT_THRESHOLDS.buildFailures) return true;
  if (testFailures >= DEFAULT_THRESHOLDS.testFailures) return true;

  const ratio = Number(state.contextUsage ?? counters.contextRatio ?? 0);
  if (Number.isFinite(ratio) && ratio > DEFAULT_THRESHOLDS.contextRatio) return true;

  const maxDur = parseDuration(state.options?.maxDuration);
  if (maxDur && state.createdAt) {
    const started = Date.parse(state.createdAt);
    if (Number.isFinite(started) && Date.now() - started > maxDur) return true;
  }

  // Runtime feeder: severity-tagged errors are written by engine-state.js
  // #recordRiskEvent, which the Bash PreToolUse risk guard
  // (scripts/hooks/bash-risk-guard.js) calls when classifyRisk returns
  // 'danger' during an active autopilot session. Before that wiring this
  // branch was unreachable (no code path recorded `severity`).
  if (Array.isArray(state.errors) && state.errors.some((e) => e?.severity === 'danger')) {
    return true;
  }
  return false;
}

/**
 * Produce a human-readable pause reason. Returns null if no trigger is hit.
 * @param {object} state
 * @returns {string|null}
 */
export function pauseReason(state) {
  if (!shouldPause(state)) return null;
  const counters = state?.counters || {};
  if (Number(counters.buildFailures || 0) >= DEFAULT_THRESHOLDS.buildFailures) return 'build-failures-threshold';
  if (Number(counters.testFailures || 0) >= DEFAULT_THRESHOLDS.testFailures) return 'test-failures-threshold';
  const ratio = Number(state.contextUsage ?? counters.contextRatio ?? 0);
  if (Number.isFinite(ratio) && ratio > DEFAULT_THRESHOLDS.contextRatio) return 'context-window-exceeded';
  const maxDur = parseDuration(state.options?.maxDuration);
  if (maxDur && state.createdAt) {
    const started = Date.parse(state.createdAt);
    if (Number.isFinite(started) && Date.now() - started > maxDur) return 'max-duration-exceeded';
  }
  if (Array.isArray(state.errors) && state.errors.some((e) => e?.severity === 'danger')) return 'danger-error-recorded';
  return 'unknown';
}
