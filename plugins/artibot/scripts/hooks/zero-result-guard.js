#!/usr/bin/env node
/**
 * PostToolUse guard for Grep/Glob: a zero-result identifier lookup must not be
 * read as proof of absence.
 *
 * WHAT IT IS FOR (the failure this exists to catch):
 *   "query an identifier -> 0 hits -> declare it does not exist" is the single
 *   most repeated verification failure in this repo's session history (leader
 *   committed it 3+ times in the 2026-08-10 session alone). In every measured
 *   case the query SYNTAX was fine and the SCOPE was wrong — the identifier
 *   lived in `infra/`, in a comment, in a bash string, or under a different
 *   field name. `~/.claude/rules/artibot/verification-discipline.md` §1 exists
 *   because of it.
 *
 *   So the injected reminder is deliberately about scope, never about regex
 *   syntax. The tests pin that (see 'directs the model at SCOPE').
 *
 * WHEN IT FIRES: the tool response carries one of {@link ZERO_RESULT_MARKERS}
 * AND the queried pattern is identifier-shaped ({@link isIdentifierLike}).
 * A regex or a glob is left alone — those are searches whose author already
 * knows they are pattern-matching, not name lookups.
 *
 * MEASURED RESPONSE SHAPE (2026-08-10, re-captured from live hook stdin):
 *   `tool_response` is an OBJECT for every Grep and Glob call. It is never a
 *   string, and it carries NO 'No matches found' / 'No files found' marker —
 *   those phrasings are what the MODEL is shown, not what the hook receives.
 *
 *     Grep 'content'            zero -> { mode:'content', numFiles:0, filenames:[],
 *                                         content:'', numLines:0, totalLines:0 }
 *     Grep 'files_with_matches' zero -> { mode:'files_with_matches', filenames:[],
 *                                         numFiles:0, totalFiles:0 }
 *     Grep 'count'              zero -> { mode:'count', numFiles:0, filenames:[],
 *                                         content:'', numMatches:0 }
 *     Glob                      zero -> { filenames:[], numFiles:0, totalMatches:0,
 *                                         truncated:false, countIsComplete:true }
 *
 *   THE TRAP: in 'content' mode `numFiles` is 0 even when the query MATCHED
 *   (measured: a 2-line hit returns numFiles:0, numLines:2). A `numFiles === 0`
 *   test would therefore fire on successful searches. Content mode must be
 *   judged on `numLines`, never on `numFiles` — see {@link isStructuralZeroResult}
 *   and the captured fixture at tests/fixtures/zero-result-guard-hook-payloads.jsonl.
 *
 *   The earlier version of this comment asserted the opposite (plain STRING,
 *   marker-bearing) and the guard was built on it, so it fired on nothing in
 *   production. Corrected here from a raw-stdin capture; do not "restore" the
 *   string claim without a fresh capture that shows it.
 *
 * WHAT THIS GUARD CANNOT SEE (do not read a non-firing as "scope was fine"):
 *   1. `grep ... || echo none` and friends — the shell masks the zero result,
 *      so no zero-result marker ever reaches any hook. Bash-channel blind spot
 *      shared with post-tool-failure-advisor.js.
 *   2. `node -e` / script-driven lookups that return "0 rows" semantically but
 *      emit no marker string. Semantically-empty results are invisible here.
 *   3. The Read channel: a stale `file:line` citation whose line has MOVED
 *      reads as a successful Read. Nothing in this guard covers it.
 *   4. Output is advisory `additionalContext`. Whether the model actually
 *      re-queries is not observable from here — the counter measures FIRING,
 *      never compliance. Do not quote `fired` as evidence of behaviour change.
 *   5. `fired` is a LOWER BOUND, not an exact count. recordFire() is a
 *      read-modify-write with no cross-process lock, so two hooks firing
 *      concurrently can lose one increment. Undercounting is the fail-safe
 *      direction (it never inflates the guard's apparent usefulness), but do
 *      not present the number as exact.
 *
 * Never `decision: block`. Silence is the default on every unrecognised shape.
 *
 * @module scripts/hooks/zero-result-guard
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';
import { getHomeDir } from '../../lib/core/platform.js';

const HOOK_NAME = 'zero-result-guard';
const EVENT_NAME = 'PostToolUse';
const PREFIX = '[artibot:zero-result-guard]';

/**
 * Response substrings that mean "this query matched nothing". Allowlist, never
 * a denylist: an unrecognised phrasing produces silence rather than a guess.
 * Exported so a platform wording change is a one-line diff with a failing test.
 *
 * NOT the live path. The 2026-08-10 capture shows Grep/Glob deliver a structured
 * object with no marker string, so {@link isStructuralZeroResult} is what fires
 * in production. These markers are retained for string-valued responses (other
 * tools, older payload versions, hand-written tests) and cost one cheap
 * `startsWith` when the response is not a string-bearing shape.
 *
 * @type {string[]}
 */
export const ZERO_RESULT_MARKERS = [
  'No matches found',
  'No files found',
  'Found 0 total occurrences',
];

/** Filename WP-4 reads. Kept as a named export so consumers never hardcode it. */
export const COUNTER_FILENAME = 'zero-result-guard-counter.json';

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

/**
 * Flatten a value that may be a string, an anthropic content-block array, or an
 * object carrying the text under a known key.
 * @param {*} value
 * @returns {string}
 */
function flattenText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  for (const key of ['content', 'output', 'stdout', 'text', 'result']) {
    const flat = flattenText(value[key]);
    if (flat) return flat;
  }
  return '';
}

/**
 * Extract the tool's response text from a PostToolUse payload.
 * @param {object} hookData
 * @returns {string}
 */
export function extractResponseText(hookData) {
  if (!hookData || typeof hookData !== 'object') return '';
  for (const candidate of [
    hookData.tool_response,
    hookData.tool_result,
    hookData.tool_output,
    hookData.output,
  ]) {
    const flat = flattenText(candidate);
    if (flat) return flat;
  }
  return '';
}

/**
 * Extract the queried pattern. Both Grep and Glob carry it as `tool_input.pattern`.
 * @param {object} hookData
 * @returns {string}
 */
export function extractQueryPattern(hookData) {
  const p = hookData?.tool_input?.pattern;
  return typeof p === 'string' ? p : '';
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Did this response report zero results?
 *
 * Anchored at the START of the response, never `includes`. A substring test
 * misfires on real hits whose CONTENT happens to quote a marker: searching
 * this repo for `grepContent` returns hit lines containing the literal
 * `'No matches found'`, and an `includes` check then injected "returned zero
 * results" on top of a 3-hit result the model had just read. Advice that
 * contradicts what the model can see destroys the guard's credibility, which
 * is the only thing it has.
 *
 * Anchoring is structurally safe: every zero-result form begins with its
 * marker, while every hit begins with a file path.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isZeroResult(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const head = text.trimStart();
  return ZERO_RESULT_MARKERS.some((m) => head.startsWith(m));
}

/**
 * Did this structured Grep/Glob response report zero results?
 *
 * The live payload carries no marker string (see the MEASURED block at the top
 * of this file), so absence has to be read off the counters. Every branch is an
 * ALLOWLIST keyed on the response's own `mode`: an unrecognised mode, a missing
 * counter, or a non-object response all return false, so a payload shape change
 * degrades this guard to silence rather than to guessing.
 *
 * Per-mode fields are deliberate, not interchangeable:
 *   - 'content'            `numLines`, because `numFiles` is 0 even on hits.
 *   - 'files_with_matches' `numFiles`, the only counter the mode reports.
 *   - 'count'              `numMatches`, the total the mode exists to return.
 *   - Glob                 `numFiles` + `totalMatches`, both present and honest.
 * Strict `=== 0` (never `!count`) keeps `undefined` from reading as zero.
 *
 * @param {object} hookData - Parsed PostToolUse payload.
 * @returns {boolean}
 */
export function isStructuralZeroResult(hookData) {
  const res = hookData?.tool_response;
  if (!res || typeof res !== 'object' || Array.isArray(res)) return false;

  const tool = extractToolName(hookData);
  if (tool === 'Glob') return res.numFiles === 0 && res.totalMatches === 0;
  if (tool !== 'Grep') return false;

  switch (res.mode) {
    case 'content': return res.numLines === 0 && res.content === '';
    case 'files_with_matches': return res.numFiles === 0;
    case 'count': return res.numMatches === 0;
    default: return false;
  }
}

/**
 * Characters an identifier may contain. An ALLOWLIST, so every regex
 * metacharacter, path separator, quote and space is excluded by construction —
 * a denylist would fail open on the next metacharacter someone uses.
 */
const IDENTIFIER_CHARSET = /^[A-Za-z0-9_-]+$/;

/** A camelCase boundary: the cheapest signal that a token is a symbol name. */
const CAMEL_HUMP = /[a-z][A-Z]/;

/** Below this length a token is too weak a signal to nudge on (`id`, `db`). */
const MIN_IDENTIFIER_LENGTH = 3;

/**
 * Is this query a name lookup rather than a pattern match?
 *
 * Deliberately narrow. Kebab-case (`zero-result-guard`) and plain lowercase
 * words (`resolve`) are EXCLUDED even though they are often identifiers: both
 * shapes are also ordinary prose, and a guard that fires on prose searches
 * becomes noise the model learns to skim past. Missing a real case costs one
 * un-nudged lookup; firing on every word costs the guard its credibility.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
export function isIdentifierLike(pattern) {
  if (typeof pattern !== 'string') return false;
  const p = pattern.trim();
  if (p.length < MIN_IDENTIFIER_LENGTH) return false;
  if (!IDENTIFIER_CHARSET.test(p)) return false;
  return p.includes('_') || CAMEL_HUMP.test(p);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Scope-narrowing inputs worth echoing back to the model. */
const SCOPE_FILTER_KEYS = ['path', 'glob', 'type'];

/**
 * Decide whether the guard speaks, and gather what the message needs.
 * Pure — no I/O, no counter write.
 *
 * @param {object} hookData - Parsed PostToolUse payload.
 * @returns {{ fired: boolean, tool: string, pattern: string, filters: Record<string,string> }}
 */
export function evaluateZeroResult(hookData) {
  const idle = { fired: false, tool: '', pattern: '', filters: {} };
  if (!hookData || typeof hookData !== 'object') return idle;

  // Structural first: it is the shape production actually delivers. The string
  // test stays as a fallback for string-valued responses.
  const zero = isStructuralZeroResult(hookData)
    || isZeroResult(extractResponseText(hookData));
  if (!zero) return idle;

  const pattern = extractQueryPattern(hookData).trim();
  if (!isIdentifierLike(pattern)) return idle;

  const filters = {};
  for (const key of SCOPE_FILTER_KEYS) {
    const val = hookData?.tool_input?.[key];
    if (typeof val === 'string' && val.length > 0) filters[key] = val;
  }

  return {
    fired: true,
    tool: extractToolName(hookData) || 'The search',
    pattern,
    filters,
  };
}

/**
 * Build the injected reminder.
 *
 * The wording targets SCOPE on purpose. Every failure in the corpus behind this
 * guard had correct syntax and a wrong search boundary, so advice about regex
 * spelling would have helped none of them.
 *
 * @param {ReturnType<typeof evaluateZeroResult>} ev
 * @returns {string}
 */
export function formatScopeReminder(ev) {
  const applied = Object.entries(ev.filters).map(([k, v]) => `${k}=${v}`).join(', ');
  const scopeLine = applied
    ? `The scope you applied was: ${applied}.`
    : 'No path/glob/type filter was applied, but the tool still has defaults you did not choose.';

  return [
    `${PREFIX} ${ev.tool} for "${ev.pattern}" returned zero results. ${scopeLine}`,
    'Zero results is a fact about THIS query\'s scope, not about the repository.',
    'Verify the SCOPE, not the query syntax — the repeated failures this guard exists for'
      + ' all had correct patterns and a wrong search boundary.',
    'Before re-querying, do not write "does not exist" / "없음" / "0건":',
    '  1. Re-run repo-wide with path/glob/type dropped. Identifiers hide in infra/,'
      + ' scripts/, docs/, .github/ and root files — and inside comments, markdown and'
      + ' shell strings, which type-filtered scans never reach.',
    '  2. Re-run on the other spelling axis: snake_case vs camelCase, a distinctive'
      + ' substring, or the value instead of the key name.',
    'If you do not re-run, report "미확인" (unverified) rather than absent, and state the'
      + ' narrowing explicitly: "0 hits under <scope> — other locations unchecked".',
  ].join('\n');
}

/**
 * Wrap the evaluation in the PostToolUse envelope, or null to stay silent.
 * Silence is `null`, not `{ continue: true }`: the dispatcher's mergeResults()
 * drops nulls, so an empty stdout is the cheapest correct non-firing output.
 *
 * @param {ReturnType<typeof evaluateZeroResult>} ev
 * @returns {object|null}
 */
export function buildOutput(ev) {
  if (!ev || !ev.fired) return null;
  return {
    hookSpecificOutput: {
      hookEventName: EVENT_NAME,
      additionalContext: formatScopeReminder(ev),
    },
  };
}

/**
 * Pure handler: payload in, envelope or null out. No disk access.
 * @param {object} hookData
 * @returns {object|null}
 */
export function handlePostToolUse(hookData) {
  return buildOutput(evaluateZeroResult(hookData));
}

// ---------------------------------------------------------------------------
// Firing counter (shared with the Bash channel in post-tool-failure-advisor.js)
// ---------------------------------------------------------------------------

/**
 * Absolute path of the counter file. Resolved per call rather than cached so a
 * test that redirects HOME/USERPROFILE gets the sandbox path.
 * @returns {string}
 */
export function counterPath() {
  return path.join(getHomeDir(), '.claude', 'artibot', COUNTER_FILENAME);
}

/** Shape written to disk when nothing has fired yet. */
function emptyCounter() {
  return { fired: 0, lastFiredAt: null, byChannel: { b1: 0, b2: 0 } };
}

/**
 * Read the counter, treating a missing or corrupt file as "never fired".
 * A parse failure must not stall the guard, so it degrades to zeros rather
 * than throwing — the counter is instrumentation, not state anything depends on.
 * @returns {{ fired: number, lastFiredAt: string|null, byChannel: { b1: number, b2: number } }}
 */
export function readCounter() {
  try {
    const parsed = JSON.parse(readFileSync(counterPath(), 'utf-8'));
    const base = emptyCounter();
    return {
      fired: Number.isFinite(parsed?.fired) ? parsed.fired : base.fired,
      lastFiredAt: typeof parsed?.lastFiredAt === 'string' ? parsed.lastFiredAt : null,
      byChannel: {
        b1: Number.isFinite(parsed?.byChannel?.b1) ? parsed.byChannel.b1 : 0,
        b2: Number.isFinite(parsed?.byChannel?.b2) ? parsed.byChannel.b2 : 0,
      },
    };
  } catch {
    return emptyCounter();
  }
}

/**
 * Record one firing. Best-effort by contract: a counter failure must never stop
 * the guard from delivering its advice, so every error is swallowed.
 *
 * @param {'b1'|'b2'} channel - b1 = Grep/Glob tool channel, b2 = Bash channel.
 * @returns {void}
 */
export function recordFire(channel) {
  if (channel !== 'b1' && channel !== 'b2') return;
  try {
    const cur = readCounter();
    atomicWriteSync(counterPath(), {
      fired: cur.fired + 1,
      lastFiredAt: new Date().toISOString(),
      byChannel: { ...cur.byChannel, [channel]: cur.byChannel[channel] + 1 },
    });
  } catch {
    // Instrumentation only — never let it break the guard.
  }
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  if (!hookData) return;

  let output;
  try {
    output = handlePostToolUse(hookData);
  } catch {
    return; // A guard bug must never surface as a failed hook.
  }
  if (!output) return;

  // Emit first, count second: `fired` should mean "advice was delivered", not
  // "advice was computed". recordFire swallows its own errors, so ordering it
  // last cannot cost us the output.
  writeStdout(output);
  recordFire('b1');
}

// Direct-run guard: importing this module (tests, or the advisor reusing
// recordFire) must not execute main() — it blocks on stdin and hangs the
// importer until the suite times out. Regression fixed in 67adb5e.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
}
