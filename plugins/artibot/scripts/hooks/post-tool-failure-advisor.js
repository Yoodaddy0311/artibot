#!/usr/bin/env node
/**
 * PostToolUseFailure hook: corrective context injection for recognised
 * tool-failure patterns.
 *
 * The tool has already run by the time this fires, so the failure cannot be
 * retried or re-argued from here. What IS possible is `additionalContext` —
 * telling the model what actually went wrong and what the next call should
 * look like. That is the entire job of this file.
 *
 * WHY A SEPARATE SCRIPT (not folded into tool-tracker.js):
 *   `hooks.json` invokes `tool-tracker.js failure`, but tool-tracker contains
 *   no `process.argv` read at all, so it cannot tell PostToolUse from
 *   PostToolUseFailure. Advice added there would attach to SUCCESSFUL calls
 *   too. Verified: `grep -c 'process\.argv' scripts/hooks/tool-tracker.js` → 0.
 *
 * RELATED, NOT DUPLICATED:
 *   | script                      | event              | scope | output            |
 *   |-----------------------------|--------------------|-------|-------------------|
 *   | tool-tracker.js             | PostToolUse(+Fail) | *     | none (GRPO score) |
 *   | post-bash-failure.js        | PostToolUse        | Bash  | agent suggestion  |
 *   | post-tool-failure-advisor.js| PostToolUseFailure | *     | additionalContext |
 *   post-bash-failure proposes an AGENT (build-error-resolver) for build/test
 *   failures; this file gives the MODEL a corrected next call. Different layers.
 *   Its `extractExitCode` is deliberately re-implemented here rather than
 *   imported: post-bash-failure.js calls `main()` at import time, so importing
 *   it would fire a second stdin read.
 *
 * ALLOWLIST, NEVER DENYLIST:
 *   Advice is emitted only for rules in {@link ADVICE_RULES}. Every other
 *   failure — including failure modes that do not exist yet — produces no
 *   output. A denylist would fail open on each new error string.
 *
 * PAYLOAD SHAPE (measured 2026-08-10, 8 captured PostToolUseFailure payloads):
 *   The error text arrives as a plain string at TOP-LEVEL `error`. There is no
 *   `tool_response` key, no `tool_result` key, and no top-level `exit_code` —
 *   the exit status appears only inside the `error` string ("Exit code 1\n…").
 *   `cwd`, `tool_input`, `tool_name` and `hook_event_name` are all present.
 *   Extraction still probes the sibling-hook shapes first so a future envelope
 *   change degrades to silence rather than a crash.
 *
 *   The same measurement explains a separate live defect: `tool-tracker.js`
 *   reads only `tool_response|tool_result|tool_output|output`, all absent here,
 *   so a failed Bash call scores 1.0 — a perfect success. Not this hook's job
 *   to fix, but do not "reuse" that extractor here.
 *
 * WHAT THIS HOOK CANNOT DEMONSTRATE (read before claiming it helped):
 *   Reachable population is small and was over-estimated twice — 56% of
 *   failures, then 25%, and finally 3 of 38 measured failures (7.9%). Only
 *   Bash execution failures reach this hook at all.
 *
 *   Baseline, 2026-08-10T00:47Z ±2min (26 transcripts, 1,528 tool_use, 38
 *   is_error). Quote the timestamp with any of these — the corpus grows, so a
 *   bare number cannot be told apart from natural growth:
 *     - abandonment rate 25/38 = 65.8%  → PRIMARY metric, expect it to FALL
 *     - repeat identical failure 1/1,528 → allowed to RISE, never judge alone
 *     - raw error rate 2.50%             → allowed to RISE, never judge alone
 *     - F2 family 9                      → expect fall (small sample)
 *     - recovery cost median 2 calls     → supporting only
 *
 *   Repeat-failure sits at 1 because 65.8% of failures are abandoned without a
 *   retry, not because things go well. Giving the model a usable next call
 *   should convert abandonment into retries, which pushes repeat-failure and
 *   raw error rate UP. "Repeat failures increased, therefore this regressed"
 *   is an invalid reading.
 *
 *   With n=1 repeat failures and n=9 F2 events, no statistically meaningful
 *   error-rate improvement can be claimed from this change. Effect can only be
 *   judged after dozens of sessions accumulate. Never cite the unit tests
 *   below as evidence of a real-world error-rate reduction: their fixtures are
 *   hand-built and prove correctness on defined patterns, nothing more.
 *
 * Output is strictly advisory — never `decision: block`. Any internal error is
 * swallowed: an instrumentation hook must not break the tool pipeline.
 *
 * @module scripts/hooks/post-tool-failure-advisor
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';
// The Grep/Glob tool guard owns both the identifier predicate and the shared
// firing counter; this file is its Bash-channel twin and reuses them rather
// than keeping a second copy that can drift. Importing it is safe — it carries
// a direct-run guard, so nothing executes on import.
import { isIdentifierLike, recordFire } from './zero-result-guard.js';
import { isMainEntry } from './_main-entry.js';

/** Prefix for every emitted advice line. */
const ADVICE_PREFIX = '[artibot:tool-advice]';

/**
 * Rule id whose firings are counted on the shared `b2` channel. Named here so
 * the counter attribution in main() cannot drift from {@link ADVICE_RULES}.
 */
const ZERO_RESULT_RULE_ID = 'bash-grep-zero-result';

// ---------------------------------------------------------------------------
// Payload extraction (defensive — see module doc)
// ---------------------------------------------------------------------------

/**
 * Flatten a value that may be a string, an anthropic content-block array, or
 * an object carrying the text under one of several known keys.
 * @param {*} value
 * @returns {string}
 */
function flattenText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  for (const key of ['content', 'output', 'stdout', 'stderr', 'error', 'message', 'text']) {
    const flat = flattenText(value[key]);
    if (flat) return flat;
  }
  return '';
}

/**
 * Extract the failure text from a PostToolUseFailure payload.
 * @param {object} hookData
 * @returns {string} error text, or '' when nothing recognisable is present
 */
export function extractErrorText(hookData) {
  if (!hookData || typeof hookData !== 'object') return '';
  for (const candidate of [
    hookData.tool_response,
    hookData.tool_result,
    hookData.tool_error,
    hookData.error,
    hookData.tool_output,
    hookData.output,
  ]) {
    const flat = flattenText(candidate);
    if (flat) return flat;
  }
  return '';
}

/**
 * Extract the process exit code, checking every shape sibling hooks accept.
 * @param {object} hookData
 * @returns {number|null}
 */
export function extractExitCode(hookData) {
  for (const value of [
    hookData?.tool_response?.exit_code,
    hookData?.tool_response?.exitCode,
    hookData?.tool_response?.returncode,
    hookData?.tool_result?.exit_code,
    hookData?.tool_result?.exitCode,
    hookData?.exit_code,
  ]) {
    if (typeof value === 'number') return value;
  }
  return null;
}

/**
 * Extract the path argument the model supplied. Read/Edit/Write use
 * `file_path`; Grep/Glob use `path`.
 * @param {object} hookData
 * @returns {string}
 */
export function extractInputPath(hookData) {
  return hookData?.tool_input?.file_path || hookData?.tool_input?.path || '';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Is this path relative (i.e. resolved against the caller's cwd)?
 *
 * Absolute forms recognised: Windows drive (`C:\`, `C:/`), UNC (`\\host`),
 * POSIX root (`/`), and home-anchored (`~`). Empty input returns false —
 * there is nothing to advise about a path that was never supplied.
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isRelativePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  if (/^\\\\/.test(p)) return false;
  if (/^[/~]/.test(p)) return false;
  return true;
}

/**
 * Split a path into non-empty segments, treating both separators alike.
 * @param {string} p
 * @returns {string[]}
 */
function segmentsOf(p) {
  return String(p).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
}

/**
 * Case-insensitive segment-list equality. Case folding is intentional: the
 * primary platform here is Windows, where paths are case-insensitive, and this
 * is an advisory heuristic rather than a filesystem operation.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function segmentsEqual(a, b) {
  return a.length === b.length && a.every((s, i) => s.toLowerCase() === b[i].toLowerCase());
}

// ---------------------------------------------------------------------------
// Permission-denial classifier (PRD §5.4 C-3)
// ---------------------------------------------------------------------------

/**
 * Keywords borrowed from the Codex denial taxonomy.
 * @type {string[]}
 */
const PERMISSION_KEYWORDS = [
  'operation not permitted',
  'permission denied',
  'read-only file system',
  'seccomp',
  'sandbox',
  'landlock',
  'failed to write file',
];

/**
 * Exit codes that are never a permission problem, checked BEFORE keyword
 * matching: 127 = command not found, 126 = found but not executable,
 * 2 = shell misuse. A shell can print "permission denied" while exiting 127
 * (searching $PATH), and treating that as a sandbox denial would silence
 * advice on an ordinary typo.
 * @type {number[]}
 */
const QUICK_REJECT_EXIT_CODES = [2, 126, 127];

/**
 * Decide whether a failure is a permission / sandbox denial — i.e. something
 * the model cannot fix by calling differently, and therefore must not be
 * advised about.
 *
 * WHAT THIS CLASSIFIER CANNOT SEE (do not treat a `denied: false` as proof
 * that no permission problem occurred):
 *   - non-English locale stderr (the keywords are English literals);
 *   - MCP and tool-harness errors that carry no exit code and no stderr;
 *   - genuine permission failures that happen to exit 2, swallowed by the
 *     quick-reject above — 2 is the broadest of the three rejected codes;
 *   - denials reported only in a structured field this hook never reads.
 *
 * IN THE OTHER DIRECTION, `sandbox` is a broad word: a failure whose output
 * merely mentions it (a test file named sandbox.test.js, say) classifies as
 * denied. The only consequence is that this hook stays quiet on that failure,
 * which is already its default, so the over-match costs a missed hint rather
 * than a wrong one.
 *
 * OBSERVED FIRING RATE IN THIS REPO: zero. All 38 real tool failures in the
 * local transcript corpus classify as not-denied, because this is a Windows
 * host where seccomp / landlock / sandbox denials do not arise. Non-firing
 * here is correct behaviour, not a defect; the classifier exists for
 * cross-platform coverage.
 *
 * @param {object} [input]
 * @param {string} [input.stderr] - Failure text to scan.
 * @param {number|null} [input.exitCode] - Process exit code, when known.
 * @returns {{ denied: boolean, reason: string|null, keyword: string|null }}
 *   Always an object — never use the return value as a bare boolean.
 */
export function classifyPermissionDenial({ stderr, exitCode } = {}) {
  if (typeof exitCode === 'number' && QUICK_REJECT_EXIT_CODES.includes(exitCode)) {
    return { denied: false, reason: 'quick-reject-exit-code', keyword: null };
  }
  const text = typeof stderr === 'string' ? stderr.toLowerCase() : '';
  if (!text) return { denied: false, reason: 'no-text', keyword: null };
  const keyword = PERMISSION_KEYWORDS.find((k) => text.includes(k));
  if (keyword) return { denied: true, reason: 'keyword-match', keyword };
  return { denied: false, reason: null, keyword: null };
}

// ---------------------------------------------------------------------------
// Rule 1 — relative `cd` target that does not exist
// ---------------------------------------------------------------------------

/** e.g. `/usr/bin/bash: line 1: cd: plugins/artibot: No such file or directory` */
const CD_FAILURE_RE = /\bcd: ([^\r\n]+?): No such file or directory/;

/**
 * Match a failed `cd` to a RELATIVE directory.
 *
 * Why this earns advice: the raw message names the missing directory but never
 * states the cause. In agent threads the working directory is reset between
 * Bash calls, so a `cd` performed in an earlier call does not carry over and
 * the relative target is resolved from somewhere the model did not expect.
 *
 * An absolute `cd` target is left alone — "that directory does not exist" is
 * already the whole story there.
 *
 * @param {{ errorText: string, cwd: string }} input
 * @returns {{ target: string, absolute: string|null }|null}
 *   `absolute` is populated only when the directory is confirmed to exist
 *   under `cwd`; an unverified path is reported as null rather than guessed.
 */
export function matchRelativeCd({ errorText, cwd }) {
  const m = CD_FAILURE_RE.exec(errorText || '');
  if (!m) return null;
  const target = m[1].trim();
  if (!isRelativePath(target)) return null;

  let absolute = null;
  if (cwd) {
    const candidate = path.resolve(cwd, target);
    if (existsSync(candidate)) absolute = candidate;
  }
  return { target, absolute };
}

// ---------------------------------------------------------------------------
// Rule 2 — relative path whose leading segments duplicate the cwd tail
//
// NOT IN {@link ADVICE_RULES}: UNREACHABLE ON THIS PLATFORM.
//
// Measured 2026-08-10 by dumping raw hook stdin for every event: failures that
// surface as `<tool_use_error>` — Grep/Read `Path does not exist`, Edit
// `String to replace not found`, and PreToolUse blocks — emit NO hook event at
// all. Deliberately triggering them produced zero PostToolUse and zero
// PostToolUseFailure payloads. All 8 captured PostToolUseFailure payloads were
// Bash execution failures.
//
// So this matcher can never be reached from the hook, and wiring it into the
// allowlist would ship a rule that looks live but cannot fire. It is kept —
// with its tests — because it is correct code against a payload the platform
// may one day deliver, and because the tests will be the first thing to notice
// if that changes. Re-add to ADVICE_RULES only after re-running the dump probe
// and observing a non-Bash PostToolUseFailure payload.
// ---------------------------------------------------------------------------

/** Covers both `File does not exist.` (Read/Edit) and `Path does not exist: x` (Grep/Glob). */
const PATH_MISSING_RE = /\b(?:File|Path) does not exist/i;

/**
 * Match a path-not-found failure caused by prefixing a path with directories
 * the cwd already contains — e.g. asking for `plugins/artibot/docs/x.md` while
 * standing in `.../plugins/artibot`, which resolves to
 * `.../plugins/artibot/plugins/artibot/docs/x.md`.
 *
 * DELIBERATELY NARROWER THAN "steer the model to absolute paths". In the local
 * corpus, 4 of the 6 path-not-found failures already supplied an absolute path
 * that was simply wrong; absolute-path advice would have helped none of them
 * and would have been noise. The 2 remaining failures were both this
 * duplicated-prefix shape.
 *
 * Fires only when the de-duplicated candidate is confirmed to exist, so the
 * advice names a real file rather than a plausible-looking guess.
 *
 * @param {{ errorText: string, inputPath: string, cwd: string }} input
 * @returns {{ inputPath: string, resolved: string, corrected: string, correctedAbsolute: string }|null}
 */
export function matchDuplicatedPathPrefix({ errorText, inputPath, cwd }) {
  if (!PATH_MISSING_RE.test(errorText || '')) return null;
  if (!cwd || !isRelativePath(inputPath)) return null;

  const inSegs = segmentsOf(inputPath);
  const cwdSegs = segmentsOf(cwd);
  if (inSegs.length < 2) return null;

  // Longest overlap between the cwd tail and the input head, leaving at least
  // one segment so the corrected path is never empty.
  const maxK = Math.min(inSegs.length - 1, cwdSegs.length);
  let overlap = 0;
  for (let k = maxK; k >= 1; k--) {
    if (segmentsEqual(cwdSegs.slice(cwdSegs.length - k), inSegs.slice(0, k))) {
      overlap = k;
      break;
    }
  }
  if (overlap === 0) return null;

  const corrected = inSegs.slice(overlap).join('/');
  const correctedAbsolute = path.resolve(cwd, corrected);
  if (!existsSync(correctedAbsolute)) return null;

  return {
    inputPath,
    resolved: path.resolve(cwd, inputPath),
    corrected,
    correctedAbsolute,
  };
}

// ---------------------------------------------------------------------------
// Rule 3 — `grep`/`rg` exited 1 with no output: a zero-result identifier lookup
//
// The Bash-channel twin of scripts/hooks/zero-result-guard.js. Same failure
// ("0 hits therefore absent"), different door: there the model used the Grep
// TOOL, here it shelled out.
//
// LIMITS OF THIS CHANNEL (do not read a non-firing as "the search was sound"):
//   - `grep ... || true` / `|| echo none` exits 0, so it never reaches this
//     hook at all. Masked zero-results are invisible on both channels.
//   - Only Bash EXECUTION failures arrive here — 3 of 38 measured failures
//     (7.9%), baseline 2026-08-10T00:47Z.
//   - A pipeline or `&&` chain is rejected outright: the reported exit code
//     belongs to the last stage, so `grep foo x | head` exiting 0 says nothing
//     about whether grep matched.
// ---------------------------------------------------------------------------

/** grep/rg exit 1 = "no lines selected". 2 = a real error; 0 = matched. */
const GREP_NO_MATCH_EXIT_CODE = 1;

/** Only these leading binaries. `git grep` and pipelines are deliberately out. */
const GREP_BINARIES = new Set(['grep', 'rg']);

/** Any of these means the exit code no longer belongs to the leading command. */
const SHELL_COMPOSITION_RE = /[;|&]/;

/** Leading `Exit code N` line the Bash tool prepends to every failure text. */
const EXIT_CODE_LINE_RE = /^Exit code (\d+)[^\n]*\n?/;

/**
 * Flags that consume the FOLLOWING token as their value. Without this the
 * value would be mistaken for the search pattern (`grep -A 3 foo` → "3").
 * Allowlist: an unknown flag is assumed valueless, which at worst makes the
 * rule read the wrong token and then stay silent because it is not
 * identifier-shaped.
 */
const VALUE_CONSUMING_FLAGS = new Set([
  '-e', '-f', '-m', '-A', '-B', '-C', '-d', '-g', '-t', '-T',
  '--regexp', '--file', '--max-count', '--context', '--after-context',
  '--before-context', '--include', '--exclude', '--exclude-dir',
  '--glob', '--type', '--type-not',
]);

/**
 * Strip the `Exit code N` header and return whatever the command actually
 * printed. An empty result is the signature of a clean grep no-match: grep
 * prints nothing when it matches nothing, so any residual text means the
 * exit 1 came from something else.
 *
 * @param {string} text
 * @returns {string}
 */
export function residualAfterExitLine(text) {
  if (typeof text !== 'string') return '';
  return text.replace(EXIT_CODE_LINE_RE, '').trim();
}

/**
 * Read the exit code out of the failure text. The live PostToolUseFailure
 * envelope carries no structured exit code — it exists only inside the error
 * string (module doc, 8 captured payloads).
 * @param {string} text
 * @returns {number|null}
 */
function exitCodeFromText(text) {
  const m = typeof text === 'string' ? EXIT_CODE_LINE_RE.exec(text) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Split a command line into tokens, honouring simple single/double quoting.
 * Not a shell parser: `-e"foo"` and escaped quotes are not handled, and both
 * degrade to a token that fails the identifier test, i.e. to silence.
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeCommand(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * Identify a leading `grep`/`rg` invocation and the pattern it searched for.
 *
 * @param {string} command - Raw `tool_input.command`.
 * @returns {{ tool: string, pattern: string }} `tool` is '' when this is not a
 *   bare leading grep/rg — the caller must treat that as "do not advise".
 */
export function parseGrepInvocation(command) {
  const none = { tool: '', pattern: '' };
  if (typeof command !== 'string' || command.trim().length === 0) return none;
  if (SHELL_COMPOSITION_RE.test(command)) return none;

  const tokens = tokenizeCommand(command);
  const tool = tokens[0];
  if (!GREP_BINARIES.has(tool)) return none;

  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') { i += 1; break; }
    if (!t.startsWith('-')) break;
    // `-e PATTERN` names the pattern explicitly — take it and stop.
    if (t === '-e' || t === '--regexp') return { tool, pattern: tokens[i + 1] ?? '' };
    if (t.startsWith('--') && t.includes('=')) { i += 1; continue; }
    if (VALUE_CONSUMING_FLAGS.has(t)) { i += 2; continue; }
    i += 1;
  }

  const pattern = tokens[i];
  return pattern ? { tool, pattern } : none;
}

/**
 * Match a grep/rg that searched for an identifier and found nothing.
 *
 * Requires ALL of: exit 1, no printed output, a bare leading grep/rg, and an
 * identifier-shaped pattern. A regex query is left alone on purpose — the
 * advice is about search SCOPE, and someone writing a regex already knows they
 * are pattern-matching rather than looking up a name.
 *
 * @param {{ errorText: string, command: string, exitCode: number|null }} input
 * @returns {{ tool: string, pattern: string }|null}
 */
export function matchZeroResultScope({ errorText, command, exitCode }) {
  if (exitCode !== GREP_NO_MATCH_EXIT_CODE) return null;
  if (residualAfterExitLine(errorText) !== '') return null;

  const { tool, pattern } = parseGrepInvocation(command);
  if (!tool || !isIdentifierLike(pattern)) return null;
  return { tool, pattern: pattern.trim() };
}

// ---------------------------------------------------------------------------
// Message builders — received value → cause → concrete next call
// ---------------------------------------------------------------------------

/**
 * @param {{ target: string, absolute: string|null }} hit
 * @param {string} toolName
 * @returns {string}
 */
function buildCdMessage(hit, toolName) {
  const next = hit.absolute
    ? `Retry as a single command anchored on the verified absolute path: `
      + `cd "${hit.absolute}" && <rest of the command>.`
    : `Retry with an absolute path for the directory, or pass absolute paths to the command `
      + `directly instead of relying on a prior cd.`;
  return `${ADVICE_PREFIX} ${toolName} failed on \`cd ${hit.target}\`, a relative directory. `
    + `The working directory is reset between Bash calls in agent threads, so a cd from an `
    + `earlier call does not carry over and "${hit.target}" was resolved from an unexpected `
    + `location. ${next}`;
}

/**
 * Message builder for the unreachable Rule 2. Exported rather than wired into
 * {@link ADVICE_RULES}: nothing calls it today, and keeping it importable is
 * what lets its tests keep proving it correct until the platform emits a
 * payload it can act on.
 * @param {{ inputPath: string, resolved: string, correctedAbsolute: string }} hit
 * @param {string} toolName
 * @returns {string}
 */
export function buildDuplicatedPrefixMessage(hit, toolName) {
  return `${ADVICE_PREFIX} ${toolName} received the relative path "${hit.inputPath}", which `
    + `resolved to "${hit.resolved}" — its leading segments are already part of the current `
    + `working directory, so they were applied twice. The file does exist at `
    + `"${hit.correctedAbsolute}". Retry with that absolute path.`;
}

/**
 * Advice for a zero-result identifier search.
 *
 * Aimed at SCOPE, never at pattern syntax. Every failure in the corpus behind
 * this rule spelled the identifier correctly and searched the wrong place, so
 * regex coaching would have helped none of them.
 *
 * @param {{ tool: string, pattern: string }} hit
 * @param {string} toolName
 * @returns {string}
 */
function buildZeroResultScopeMessage(hit, toolName) {
  return `${ADVICE_PREFIX} ${toolName} ran \`${hit.tool}\` for "${hit.pattern}" and it exited 1 — `
    + 'zero matches. That is a fact about THIS command\'s scope, not about the repository. '
    + 'Verify the SCOPE, not the pattern: the repeated failures behind this rule all had a correct '
    + 'pattern and a wrong search boundary. Before writing "does not exist" / "없음" / "0건", re-run '
    + 'repo-wide with the path arguments and --include/-t filters dropped — identifiers hide in '
    + 'infra/, scripts/, docs/, .github/ and root files, and inside comments, markdown and shell '
    + 'strings that filtered scans never reach. Then try the other spelling axis: snake_case vs '
    + 'camelCase, a distinctive substring, or the value instead of the key name. If you do not '
    + 're-run, report "미확인" (unverified) rather than absent, and state the narrowing explicitly: '
    + '"0 hits under <scope> — other locations unchecked".';
}

// ---------------------------------------------------------------------------
// Allowlist dispatcher
// ---------------------------------------------------------------------------

/**
 * The complete set of failures this hook speaks about. Adding an entry is the
 * only way to make it speak; anything absent stays silent by construction.
 * First match wins.
 *
 * Only Bash execution failures reach this hook (see the Rule 2 banner above),
 * so every rule here is Bash-shaped. `matchDuplicatedPathPrefix` is
 * intentionally absent: it targets `<tool_use_error>` failures, which emit no
 * hook event on this platform.
 * @type {Array<{ id: string, match: (ctx: object) => object|null, build: (hit: object, tool: string) => string }>}
 */
const ADVICE_RULES = [
  { id: 'bash-cd-relative', match: matchRelativeCd, build: buildCdMessage },
  { id: ZERO_RESULT_RULE_ID, match: matchZeroResultScope, build: buildZeroResultScopeMessage },
];

/** Rule identifiers in dispatch order (exported so tests can pin the allowlist). */
export const ADVICE_RULE_IDS = ADVICE_RULES.map((r) => r.id);

/**
 * Produce corrective advice AND the id of the rule that produced it, or null
 * to stay silent. The id is what lets main() attribute a firing to the right
 * counter channel without re-inspecting the message text.
 *
 * @param {object} hookData - Parsed PostToolUseFailure payload
 * @returns {{ id: string, advice: string }|null}
 */
export function selectAdvice(hookData) {
  const errorText = extractErrorText(hookData);
  if (!errorText) return null;

  // The live envelope carries no structured exit code — fall back to the
  // `Exit code N` header inside the error text (module doc).
  const exitCode = extractExitCode(hookData) ?? exitCodeFromText(errorText);

  // Permission and sandbox denials are not something the model can call its
  // way out of — advising there would be noise.
  if (classifyPermissionDenial({ stderr: errorText, exitCode }).denied) return null;

  const toolName = extractToolName(hookData) || 'The tool';
  const ctx = {
    errorText,
    cwd: hookData?.cwd || '',
    inputPath: extractInputPath(hookData),
    command: hookData?.tool_input?.command || '',
    exitCode,
  };

  for (const rule of ADVICE_RULES) {
    const hit = rule.match(ctx);
    if (hit) return { id: rule.id, advice: rule.build(hit, toolName) };
  }
  return null;
}

/**
 * Produce corrective advice for a tool failure, or null to stay silent.
 * Thin wrapper over {@link selectAdvice} — kept string-or-null so existing
 * callers and tests are unaffected by the id being added.
 * @param {object} hookData - Parsed PostToolUseFailure payload
 * @returns {string|null}
 */
export function buildAdvice(hookData) {
  return selectAdvice(hookData)?.advice ?? null;
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  if (!hookData) return;

  let selected;
  try {
    selected = selectAdvice(hookData);
  } catch {
    // A classifier bug must never surface as a failed hook. Silence instead.
    return;
  }
  if (!selected) return;

  writeStdout({
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: selected.advice,
    },
  });

  // Emit first, count second, so `fired` means "advice was delivered". The
  // counter is instrumentation only: it records FIRING, never whether the
  // model acted on the advice, and it is a lower bound (see the limits list
  // in zero-result-guard.js). recordFire swallows its own errors.
  if (selected.id === ZERO_RESULT_RULE_ID) recordFire('b2');
}

// Direct-run guard: importing this module (tests) must not execute main() —
// it blocks on stdin, which hangs the importer until the suite times out.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('post-tool-failure-advisor', { exit: true }));
}
