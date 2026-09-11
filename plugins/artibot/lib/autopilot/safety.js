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
 *
 * lib/core/blocked-patterns.js (L1, PreToolUse) is the canonical block list;
 * this catalogue only grades severity on top of it and never widens what runs.
 */
export const DANGEROUS_PATTERNS = Object.freeze([
  // Owner decision 2026-09-11 ①: the lease/if-includes forms are a CHECKED
  // force push — L1 (blocked-patterns.js safeOverrides on the two `git push`
  // rules) lets them through on purpose. Grading them 'danger' here made the
  // two layers say opposite things about the same command, so the checked form
  // drops to 'caution' while a blind `--force` / `-f` stays 'danger'.
  // The negative lookahead is what splits them: `--force` followed by
  // `-with-lease` or `-if-includes` is not a blind force.
  { id: 'git-force-push', level: 'danger', test: /\bgit\s+push\b[^\n]*--force(?!-with-lease|-if-includes)\b/i, reason: 'Destructive git push --force' },
  { id: 'git-force-push-lease', level: 'caution', test: /\bgit\s+push\b[^\n]*--force-(?:with-lease|if-includes)\b/i, reason: 'Checked force push (--force-with-lease/--force-if-includes) — allowed at PreToolUse, still rewrites remote history' },
  { id: 'git-force-push-short', level: 'danger', test: /\bgit\s+push\b[^\n]*\s-f(\s|$)/i, reason: 'Destructive git push -f' },
  // Owner decision 2026-09-11 ④: CASE HANDLING IS DELIBERATE AND UNEVEN.
  // `git` is matched case-insensitively ([gG][iI][tT]) because a shell resolves
  // `GIT branch` fine; `branch` stays lowercase because git itself rejects
  // `git BRANCH` ("is not a git command", measured 2026-09-11); `-D` stays
  // case-sensitive because that single letter is the whole point — `-D`
  // force-deletes an unmerged branch and `-d` refuses to. The /i flag this rule
  // used to carry collapsed the last distinction and made the safe everyday
  // `git branch -d topic` register as danger.
  // Three shapes count as a force delete:
  //   1. a short-flag bundle containing uppercase D  (-D, -qD, -Dv, -Df)
  //   2. a delete flag AND a force flag anywhere     (-fd, -df, -f -d)
  //   3. --delete together with --force
  // "anywhere" is literal: the option run also steps over non-option arguments,
  // so a flag AFTER the branch name counts (`git branch -d topic -f`, which git
  // really does honour). The run ends at a shell separator (; & |) and at a
  // NEWLINE, but a BACKSLASH line continuation (`\` + LF, or `\` + CRLF) is
  // whitespace inside one command, so it keeps the run open.
  // Without the newline bound a `-f` on a later line of a multi-line script
  // satisfied the force lookahead and `git branch -d old\nrm -rf build` was
  // graded danger (measured 2026-09-11, 2 false positives). NOTE THE ASYMMETRY:
  // this bound only holds at L2. L1 (guard-registry#checkDangerousCommand) also
  // tests a normalizeCommand variant that collapses every \s+ run to a single
  // space, so at L1 the newline is erased before the pattern ever sees it and
  // the same two commands are still blocked. Fixing that means changing
  // normalizeCommand for all 38 rules — out of scope here, pinned as an
  // owner-decision row in tests/core/guard-registry-safe-override-scope.test.js.
  // Run tokens stay unambiguous: the option branch demands a dash then \w, the
  // argument branch forbids a leading dash, and the continuation branch starts
  // with a backslash (never whitespace), so no token or separator can parse two
  // ways and the scan is linear (120KB adversarial input < 5ms, measured).
  {
    id: 'git-branch-delete',
    level: 'danger',
    test: /\b[gG][iI][tT](?:[^\S\n]|\\\r?\n)+branch\b(?:(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+-[a-zA-Z]*D[a-zA-Z]*(?![\w-]))|(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+(?:--delete|-[a-z]*d[a-z]*)(?![\w-]))(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+(?:--force|-[a-z]*f[a-z]*)(?![\w-])))/,
    reason: 'Force-delete git branch (-D / --delete --force)',
  },
  { id: 'git-reset-hard', level: 'danger', test: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard discards work' },
  { id: 'git-clean-force', level: 'danger', test: /\bgit\s+clean\s+-[a-z]*f/i, reason: 'git clean -f deletes untracked files' },
  { id: 'git-checkout-discard', level: 'danger', test: /\bgit\s+checkout\s+(?:--\s+)?\.(?=\s|$)/i, reason: 'git checkout . discards all uncommitted changes' },
  { id: 'git-restore-discard', level: 'danger', test: /\bgit\s+restore\s+(?:--\s+)?\.(?=\s|$)/i, reason: 'git restore . discards all uncommitted changes' },
  { id: 'git-stash-drop', level: 'danger', test: /\bgit\s+stash\s+(?:drop|clear)\b/i, reason: 'git stash drop/clear deletes stash entries' },
  // A recursive flag anywhere in the option run is enough here (force stays
  // optional, preserving the older `rm -r /` verdict); the target decides.
  // The option token must stay `--?\w[\w-]*` — a shape that lets `--opt` split
  // two ways (e.g. `-{1,2}[\w-]+`) backtracks 2^n on a non-matching tail, and
  // the 5s PreToolUse hook would drop the verdict instead of failing loudly.
  {
    id: 'rm-rf-root',
    level: 'danger',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+(?:\/(?:\s|$|\*|\w)|~(?:\s|$|\/)|\$HOME(?:\s|$|\/))/i,
    reason: 'rm -rf on root or home',
  },
  {
    id: 'rm-rf-broad',
    level: 'danger',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+\*/i,
    reason: 'rm -rf with broad glob',
  },
  // Keep after rm-rf-root/rm-rf-broad: those two own the root/home/glob targets.
  // Two lookaheads demand a recursive flag AND a force flag anywhere in the
  // option run, so combined (-rfv), split (-r -f) and long (--recursive) forms
  // all land here; the final guard skips root/home/glob targets.
  {
    id: 'rm-rf-path',
    level: 'caution',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?=(?:\s+--?\w[\w-]*)*\s+(?:--force|-[a-z]*[f][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+(?![-/~*]|\$HOME\b)\S+/i,
    reason: 'recursive delete of a scoped path (blocked at PreToolUse by blocked-patterns)',
  },
  // Owner decision 2026-09-11 ③: L1 (blocked-patterns.js `dd\s+if=`, category
  // 'disk') blocks every dd invocation, so an L2 verdict of 'safe' broke the
  // "L1 block => L2 at least caution" direction rule. Only the raw-device
  // target is graded here — a file-to-file `dd if=a.img of=b.img` is still L1
  // block / L2 safe, which is a known open divergence, not a decided one.
  { id: 'dd-device-write', level: 'danger', test: /\bdd\b[^\n]*\sof=\/dev\//i, reason: 'dd writing to a raw block device' },
  { id: 'sql-drop-table', level: 'danger', test: /\bDROP\s+TABLE\b/i, reason: 'SQL DROP TABLE' },
  { id: 'sql-drop-database', level: 'danger', test: /\bDROP\s+DATABASE\b/i, reason: 'SQL DROP DATABASE' },
  // Owner decision 2026-09-11 ②: `/\bTRUNCATE\b/i` fired on any mention of the
  // word, so `grep -n -i "truncate\|force-with-lease" file` was blocked at
  // PreToolUse (measured 2026-09-11). The word alone proves nothing; a SQL
  // statement does. Two accepted shapes:
  //   1. TRUNCATE {TABLE|ONLY|DATABASE} <identifier>
  //   2. TRUNCATE <identifier list> followed by a statement terminator or a
  //      TRUNCATE-only keyword (; CASCADE RESTRICT RESTART/CONTINUE IDENTITY)
  // Both alternatives need whitespace then an identifier CHARACTER, which is
  // what rejects `truncate -s 0 file.log` (coreutils), `"truncate\|force"`
  // (grep argument), `--grep=truncate` and `fs.truncateSync(p)`.
  // WHAT THIS RULE STILL MISSES (do not read a green suite as coverage):
  // a bare `psql -c "TRUNCATE users"` — no keyword, no terminator — is NOT
  // matched. Adding the closing quote as a terminator would re-admit prose
  // like `echo "truncate cache"`, so the miss is deliberate.
  // WHAT THIS RULE GETS WRONG: prose that happens to be one word plus a
  // semicolon — `echo "truncate cache;"` — is graded danger. Rare, and the
  // failure is toward blocking rather than allowing, so it is accepted.
  // Linear by construction: the identifier class, \s and ',' are disjoint and
  // the repeat group needs a literal comma per iteration.
  { id: 'sql-truncate', level: 'danger', test: /\bTRUNCATE\s+(?:(?:TABLE|ONLY|DATABASE)\s+[\w."`]+|[\w."`]+(?:\s*,\s*[\w."`]+)*\s*(?:;|\bCASCADE\b|\bRESTRICT\b|\b(?:RESTART|CONTINUE)\s+IDENTITY\b))/i, reason: 'SQL TRUNCATE' },
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
