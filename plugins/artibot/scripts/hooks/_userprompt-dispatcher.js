#!/usr/bin/env node
/**
 * UserPromptSubmit dispatcher.
 *
 * Replaces the previous configuration of 6 separate UserPromptSubmit hook
 * commands (each spawning its own `node` process and re-loading config) with
 * a single in-process orchestrator that:
 *
 *   0.5 GUARDS ON THE SENDER first: the host fires UserPromptSubmit for
 *      machine-injected turns too (task notifications, peer/channel messages,
 *      auto-continuation, scheduled wakeups), which arrive with a non-user
 *      `source`. Those are not the user asking for anything, so running the 6
 *      hooks on them writes decision rows and a mission ledger entry sourced
 *      from a notification body. `classifyPromptSource` decides; a non-user
 *      prompt returns before ANY hook runs and before git-autopilot-save is
 *      spawned, writing one stderr line and an EMPTY stdout.
 *   1. Runs `user-prompt-handler` first because it can rewrite the prompt
 *      (e.g. !rv re-verification, --no-team flag stripping). Order matters.
 *   2. Runs the remaining 5 in-process hooks in parallel via Promise.allSettled
 *      (auto-team-trigger, runtime-prompt, autopilot-nlu-trigger,
 *      auto-command-suggest, ambiguity-guard).
 *      They only contribute additionalContext, so order does not matter.
 *   3. Spawns git-autopilot-save as a child process (it has its own state-file
 *      side effects and was being worked on concurrently in IMPL-T1; keeping
 *      it out of process avoids a file conflict). It returns nothing useful
 *      to merge — its output is purely stderr-side observability.
 *   4. Merges the results into the HOST's stdout schema and nothing else:
 *      every contributor's additionalContext is concatenated with blank-line
 *      separators into `hookSpecificOutput.additionalContext`, and only
 *      allowlisted top-level keys are copied (HOST_STDOUT_KEYS below).
 *      `user_prompt` is a DISPATCHER-INTERNAL key — the rewriter still returns
 *      it and step 1 still writes it onto the payload so the parallel
 *      contributors classify the rewritten text, but it stops at this
 *      process's stdout boundary because the host does not read it.
 *
 * Rollback: set ARTIBOT_DISABLE_DISPATCHER=1. The dispatcher then writes a
 * stderr warning and exits without invoking any hook. Because hooks.json now
 * lists only this dispatcher, that effectively disables all 6 UserPromptSubmit
 * hooks — emergency-only.
 *
 * Process exits with code 0 on any failure path so a hook crash never blocks
 * the user's prompt from reaching Claude.
 *
 * `hook.fired` carrier appended after stdout, SH-29 O8=a1 — one ledger row per
 * dispatch naming the seven handlers above, written by the LIBRARY module
 * `_hook-fired-record.js` (not an 8th handler, so it costs nothing and never
 * names itself). A dispatch that ran ZERO hooks — the sender guard's early
 * return, and the env rollback — writes no row at all.
 *
 * @module scripts/hooks/_userprompt-dispatcher
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPluginRoot } from '../utils/index.js';
import { handleUserPromptSubmit as userPromptHandler } from './user-prompt-handler.js';
import { handleUserPromptSubmit as autoTeamTrigger } from './auto-team-trigger.js';
import { handleUserPromptSubmit as runtimePrompt } from './runtime-prompt.js';
import { handleUserPromptSubmit as autopilotNlu } from './autopilot-nlu-trigger.js';
import { handleUserPromptSubmit as autoCommandSuggest } from './auto-command-suggest.js';
import { handleUserPromptSubmit as ambiguityGuard } from './ambiguity-guard.js';
import { isMainEntry } from './_main-entry.js';
// readPayload is the shared one rather than a local copy: this file already
// imports createFatalHandler from that module, so reusing it adds nothing to
// the module graph — and the duplicate is exactly what let one stdin decode
// bug (UTF-8 corruption at the 64KB chunk boundary) exist in two places at
// once. The shared reader also wraps the `for await` in try/catch, which this
// copy did not; behavior on a stdin error stays fail-open ({} then exit 0).
import { createFatalHandler, isUnsafeMergeKey, readPayload } from './_dispatcher-utils.js';
import { recordHookFired } from './_hook-fired-record.js';

const HOOK_NAME = '_userprompt-dispatcher';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT_AUTOPILOT_SAVE = path.join(HERE, 'git-autopilot-save.js');
// 8s: fresh repos can hit init/index lock on the semantic strategy's two
// git invocations (stash + commit). Failure here is observable via stderr
// only — the user's prompt still proceeds.
const GIT_AUTOPILOT_TIMEOUT_MS = 8000;

/** The slot this dispatcher records in `hook.fired`. */
const EVENT_NAME = 'UserPromptSubmit';

/**
 * The seven handler names `hook.fired` records for this slot, IN THE ORDER
 * THEY RUN.
 *
 * NOT the order `hooks/dispatch-table.json` lists them. That file is
 * `"informational only"` for this slot (its own `note` says so — the handlers
 * are ESM imports, not spawns, and no loader consumes them), and it prints
 * `auto-team-trigger` before `runtime-prompt` while `main()` awaits
 * `runtime-prompt` FIRST — deliberately, because its directives must be the
 * first line the model reads. Recording the table's order would have put a
 * sequence in the ledger that never happened. The five other dispatchers have
 * no such split: their `HOOKS` array IS the spawn order.
 *
 * DRIFT GUARD: `tests/dispatcher/hook-fired-wiring.test.js` reads this file and
 * fails unless every name here appears as a `safeRun(..., '<name>')` literal
 * (or, for `git-autopilot-save`, as the spawned script's basename) and the
 * counts match. A name added to `main()` but not here is therefore red.
 */
const HOOK_FIRED_HANDLERS = Object.freeze([
  'user-prompt-handler',
  'runtime-prompt',
  'auto-team-trigger',
  'autopilot-nlu-trigger',
  'auto-command-suggest',
  'ambiguity-guard',
  'git-autopilot-save',
]);

/**
 * ALLOWLIST — the top-level keys the host accepts on a hook's stdout.
 *
 * Source: the host's own zod schema, read out of the installed bundle.
 * `~/.local/share/claude/versions/2.1.259` @187026302 (and unchanged at
 * 2.1.260): `c({continue, suppressOutput, stopReason, decision, systemMessage,
 * terminalSequence, reason, hookSpecificOutput})`. Everything else is STRIPPED
 * by the host's `Lwe` validator (@187394114), which writes
 * `Hook JSON output had unrecognized keys (ignored): …` to the debug file and
 * nowhere else. Full measurement:
 * `.artibot/guides/v5-design/PROBE-effort-directive-delivery.md` (B1-B6).
 *
 * This is a POSITIVE list on purpose. A deny list ("drop user_prompt and
 * message") is fail-OPEN: the next internal key someone invents ships straight
 * to a host that silently discards it, which is exactly the six-week outage
 * INCIDENT-2026-09-03-hook-payload-contract.md records. Keys not on this list
 * are NEVER COPIED — they are not deleted afterwards.
 *
 * When the host version changes, grow this constant; the drift gate
 * `tests/firewall/ups-host-schema-drift.test.js` reads the schema back out of
 * the installed binary and fails when the two disagree.
 */
export const HOST_STDOUT_KEYS = Object.freeze([
  'continue',
  'suppressOutput',
  'stopReason',
  'decision',
  'reason',
  'systemMessage',
  'terminalSequence',
  'hookSpecificOutput',
]);

/**
 * ALLOWLIST — the `hookSpecificOutput` keys the host accepts for
 * UserPromptSubmit. Same source, @187027146:
 * `c({hookEventName: literal("UserPromptSubmit"), additionalContext,
 * sessionTitle, suppressOriginalPrompt})`.
 *
 * Artibot emits `hookEventName` + `additionalContext`. `suppressOriginalPrompt`
 * only applies when `decision:"block"` is set, which no UserPromptSubmit hook
 * here does.
 */
export const HOST_UPS_KEYS = Object.freeze([
  'hookEventName',
  'additionalContext',
  'sessionTitle',
  'suppressOriginalPrompt',
]);

const HOST_STDOUT_KEY_SET = new Set(HOST_STDOUT_KEYS);

/**
 * Rollback switch: `runtime.hooks.userPromptSubmit.legacyStdout` (default
 * false). When true, `mergeHookResults` copies every top-level key again, as it
 * did before the allowlist landed.
 *
 * READ THIS BEFORE FLIPPING IT: the legacy state is the state that was BROKEN.
 * A top-level `user_prompt` is discarded by the host either way (PROBE B1-B6),
 * so turning this on does not restore a working path — it only restores the
 * old stdout SHAPE, which is useful for bisecting a regression in the parallel
 * contributors and for nothing else.
 *
 * @returns {boolean}
 */
function isLegacyStdoutEnabled() {
  try {
    const configPath = path.join(getPluginRoot(), 'artibot.config.json');
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return parsed?.runtime?.hooks?.userPromptSubmit?.legacyStdout === true;
  } catch {
    // Fail CLOSED: an unreadable config keeps the host-schema allowlist on.
    return false;
  }
}

/**
 * Run a hook's named export with try/catch. Logs the failure to stderr but
 * never throws — a hook failure must not block the prompt.
 *
 * THE RETURN VALUE CANNOT TELL YOU WHETHER IT FAILED. `null` is what a throw
 * produces AND what a handler that legitimately contributed nothing produces —
 * five of the six in-process handlers return null on most prompts. That
 * ambiguity is load-bearing for the merge (both cases contribute nothing) but
 * useless to the `hook.fired` carrier, which has to name the handlers that
 * FAILED. `onError` is the seam: an OPTIONAL callback, invoked only on the
 * throw path, so the three-argument contract every existing caller and
 * `tests/hooks/userprompt-dispatcher-resilience.test.js` rely on is unchanged.
 *
 * @param {Function} fn
 * @param {object} payload
 * @param {string} name
 * @param {(name: string) => void} [onError] called with `name` when `fn` threw
 * @returns {Promise<object|null>}
 */
async function safeRun(fn, payload, name, onError) {
  try {
    return await fn(payload);
  } catch (err) {
    process.stderr.write(`[artibot:${HOOK_NAME}] ${name} failed: ${err.message}\n`);
    if (typeof onError === 'function') {
      try { onError(name); } catch { /* a bookkeeping fault must not block the prompt */ }
    }
    return null;
  }
}

/**
 * Spawn git-autopilot-save as a child process, forwarding the JSON payload
 * via stdin. Resolves on exit (or after a timeout) — never rejects. Any
 * stdout the child emits is intentionally discarded because the dispatcher
 * already owns this process's stdout for the merged response.
 *
 * @param {object} payload
 * @returns {Promise<void>}
 */
function runGitAutopilotSave(payload) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    let child;
    try {
      child = spawn(process.execPath, [GIT_AUTOPILOT_SAVE], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
    } catch (err) {
      process.stderr.write(`[artibot:${HOOK_NAME}] git-autopilot-save spawn failed: ${err.message}\n`);
      finish();
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      process.stderr.write(`[artibot:${HOOK_NAME}] git-autopilot-save timed out after ${GIT_AUTOPILOT_TIMEOUT_MS}ms\n`);
      finish();
    }, GIT_AUTOPILOT_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`[artibot:${HOOK_NAME}] git-autopilot-save error: ${err.message}\n`);
      finish();
    });
    child.on('exit', () => {
      clearTimeout(timer);
      finish();
    });

    // Drain child stdout so the OS pipe buffer never fills up.
    if (child.stdout) child.stdout.on('data', () => {});

    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (err) {
      // If the child already exited, the exit handler will have resolved.
      // Suppress noisy 'spawn already exited' style errors and short-circuit.
      if (!/already (closed|exited|ended)|EPIPE/i.test(err.message)) {
        process.stderr.write(`[artibot:${HOOK_NAME}] git-autopilot-save stdin write failed: ${err.message}\n`);
      }
      clearTimeout(timer);
      finish();
    }
  });
}

/**
 * Merge the rewriter's result with the parallel contributors' results into the
 * HOST's stdout schema.
 *
 *   - `additionalContext` from every contributor is concatenated with
 *     blank-line separators, in INPUT ORDER. `Promise.allSettled` resolves to
 *     the input array's order, not completion order, so this is deterministic:
 *     whatever `main()` lists first lands first, which is how the effort /
 *     task-budget directives stay on the first line.
 *   - Other top-level fields are copied ONLY when the key is in
 *     HOST_STDOUT_KEYS. `user_prompt` and `message` are dispatcher-internal and
 *     stop here; they are not copied, so there is nothing to delete later.
 *   - `continue: true` is elided: it is the host's default, so emitting it
 *     carries zero information (`ambiguity-guard.js#buildOutput` returns it on
 *     every prompt). `continue: false` and every other allowlisted key pass
 *     through untouched.
 *
 * @param {object|null} rewriterResult
 * @param {Array<PromiseSettledResult<object|null>>} parallelResults
 * @param {{ legacyStdout?: boolean }} [options] - `legacyStdout: true` restores
 *   the pre-allowlist "copy every key" behaviour (config rollback, see
 *   `isLegacyStdoutEnabled`).
 * @returns {object|null} The merged response object, or null when nothing to send.
 */
export function mergeHookResults(rewriterResult, parallelResults, options = {}) {
  const out = {};
  const additions = [];
  const dropped = new Set();
  const legacyStdout = options.legacyStdout === true;

  function ingest(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return;
    const ctx = value?.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) additions.push(ctx);
    for (const [key, val] of Object.entries(value)) {
      // `__proto__`/`constructor`/`prototype` would hijack the envelope's
      // prototype or shadow a built-in rather than merge a field.
      if (isUnsafeMergeKey(key)) continue;
      if (key === 'hookSpecificOutput') continue; // composed below
      if (!legacyStdout && !HOST_STDOUT_KEY_SET.has(key)) {
        dropped.add(key);
        continue;
      }
      // `continue: true` is the host default — never copied, so a later
      // contributor's default can never overwrite an earlier `continue: false`.
      if (!legacyStdout && key === 'continue' && val === true) continue;
      out[key] = val;
    }
  }

  ingest(rewriterResult);
  for (const r of parallelResults) {
    if (r.status === 'fulfilled') ingest(r.value);
  }

  if (additions.length > 0) {
    out.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: additions.join('\n\n'),
    };
  }

  if (dropped.size > 0) {
    // One line per process (HOOK-VISIBILITY §2.2). exit-0 stderr only reaches
    // the debug file (INCIDENT F13), but it leaves a drift trail for anyone who
    // adds a key expecting the host to read it.
    process.stderr.write(
      `[artibot:${HOOK_NAME}] dropped non-host keys: ${[...dropped].join(',')}\n`,
    );
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The host's full `source` enum for UserPromptSubmit.
 *
 * MEASURED, not assumed: extracted from the installed Claude Code
 * `2.1.260` bundle's own zod schema for the UserPromptSubmit hook input
 * (`source: X(["user","sdk","system","loop_wakeup","schedule_wakeup",
 * "poll_event"]).optional()`). Reproduce with:
 *
 *   grep -ao 'hook_event_name:[A-Za-z$_]*("UserPromptSubmit").\{0,400\}' \
 *     "$APPDATA/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
 *
 * (that npm-global path is the 2.1.260 install; `~/.local/share/claude/
 * versions/*` on this machine holds only 2.1.108 / 2.1.31, which predate the
 * `source` field entirely — 0 hits for `loop_wakeup`.) Read out on
 * 2026-09-04T23:23Z and independently re-run at 2026-09-04T23:31Z with
 * identical output. The host's own describe() text documents them as: `user` =
 * interactive composer, `sdk` = non-interactive entrypoint (`-p` / Agent SDK),
 * `loop_wakeup` = dynamic /loop wakeup, `schedule_wakeup` = scheduled-task
 * fire, `system` = other machine-injected turns (peer/channel messages, task
 * notifications, auto-continuation), `poll_event` = poll-event channel
 * enqueue-time pass. The field is `.optional()` — "Payloads may omit it while
 * the field rolls out."
 *
 * This constant exists so the drift gate can compare it against the installed
 * binary. Grow it when the host adds a value; do NOT use it as the pass list.
 */
export const HOST_PROMPT_SOURCES = Object.freeze([
  'user',
  'sdk',
  'system',
  'loop_wakeup',
  'schedule_wakeup',
  'poll_event',
]);

/**
 * ALLOWLIST — the only `source` values that mean "a human asked for this".
 *
 * POSITIVE list on purpose, same reasoning as HOST_STDOUT_KEYS: a deny list
 * ("skip system and loop_wakeup") is fail-OPEN — the next injection channel the
 * host invents runs all 6 hooks on machine text before anyone notices. An
 * unknown value is treated as NON-user, so a new host source degrades to
 * "hooks did not run" (visible in stderr) instead of "hooks ran on a
 * notification" (invisible until the ledger is polluted).
 *
 * `sdk` is on the list: `-p` / Agent SDK turns still originate from a person
 * driving the CLI, and the pre-existing behaviour for them was to run.
 */
export const USER_PROMPT_SOURCES = Object.freeze(['user', 'sdk']);

/**
 * Fallback body sniff, used ONLY when `source` is absent.
 *
 * NOT a fallback in practice — on the installed host it is the ONLY defense.
 *
 * MEASURED. A 7-row capture of real hook input on 2.1.267 at
 * 2026-09-10T01:06–01:12Z (`-p` first prompt, in-process teammate arrival,
 * cross-session arrival) carried these keys and no others:
 *
 *   7 of 7   session_id, transcript_path, cwd, prompt_id, permission_mode,
 *            hook_event_name, prompt
 *   2 of 7   scratchpad_dir, session_title  (interactive / background sessions)
 *   0 of 7   source
 *
 * So `USER_PROMPT_SOURCES` above never runs on this host and the body sniff
 * carries the whole load. (Reading the minified builders suggests the same
 * conclusion — `{...Ra(…), hook_event_name:"UserPromptSubmit", prompt:r,
 * ...!1, session_title:…}`, where `...!1` is a conditional spread resolved to
 * `false` — but that is INFERENCE. The capture above is the measurement, and
 * the two disagree about which other keys `Ra` contributes, so trust the
 * capture.)
 *
 * Why this table grew (2026-09-10): with only the first two entries, a peer
 * SendMessage turn was classified as a human prompt and ran all 6 hooks. Live
 * measurement in the main session of this window — 2026-09-10T00:59:20Z and
 * 01:00:49Z, 2 peer turns, 2 `routing-classified` decision rows, 0 human
 * prompts that day.
 *
 * WHAT THE HOOK ACTUALLY RECEIVES — same capture. `prompt` carries the QUEUE's
 * raw envelope with no framing at all:
 *
 *   `<agent-message from="a3ebe9b629a8f39c7">\n…\n</agent-message>` (102B)
 *   `<cross-session-message from="uds:\\.\pipe\LOCAL\cc-msg-c0f9…"
 *    from-name="probe-cwd-b-0f" from-mode="bypass">\n…\n
 *    </cross-session-message>` (205B, nothing before or after)
 *
 * That is why the host's RENDER-time framing — `KK = "Another Claude session
 * sent a message"` with its `${KK}:` / `${KK} while you were working:`
 * variants, and `gt = "A peer session sent a message while you were
 * working:"` — is NOT in this table. Those strings are what the model is
 * shown; they never reach the hook. Listing them would only misclassify a
 * human who opens a question by quoting one, which the control group in
 * `tests/hooks/userprompt-dispatcher-resilience.test.js` pins as `user:true`.
 *
 * Marker provenance, split by evidence grade:
 *
 *   `<task-notification>`        harness task notifications (2026-09-04).
 *   `[SYSTEM NOTIFICATION`       other machine turns; no closing bracket on
 *                                purpose, so the `…]` variants match too.
 *   `<cross-session-message `    LIVE CAPTURE (above) + host `q3`.
 *   `<agent-message `            LIVE CAPTURE (above) + host `qee`. This is
 *                                what an in-process subagent's
 *                                `SendMessage(to="main")` arrives as.
 *   `<teammate-message `         host binary literal `RP` only — NOT observed
 *                                on hook input. Kept because the host's own
 *                                check is ``startsWith(`<${RP} `)`` and its
 *                                parser requires `teammate_id="…"`.
 *   `[Cross-session idle notice]` host binary literal only — NOT observed on
 *                                hook input.
 *
 * The three envelope markers carry a TRAILING SPACE, matching the host's own
 * `<${RP} ` check: every captured envelope puts an attribute (` from=`,
 * ` teammate_id=`) directly after the tag name, and including the space keeps
 * a `<agent-messages>` look-alike out of the table without reaching for a
 * regex. A bare `<agent-message>` with no attribute is therefore ADMITTED — a
 * documented narrowing, pinned in the tests.
 *
 * That narrowing is an ACCEPTED RISK, not a proof of impossibility. The host's
 * own strip regex is `/^<agent-message[^>]*>\n/`, which tolerates a bare tag,
 * so a bare envelope is not structurally ruled out. What is measured is only
 * that every captured envelope carried ` from=`; a bare tag was never observed
 * (inference, not measurement). If one is ever captured, widen the marker.
 *
 * Deliberately NARROW, and matched with `startsWith` after `trimStart()` only.
 * No regex, no substring search: without `source` there is no reliable signal,
 * so anything that does not START with a known machine marker is treated as a
 * user prompt. An over-broad sniff would silently disable all 6 hooks for real
 * prompts — a worse failure than the one being fixed.
 */
const NON_USER_BODY_MARKERS = Object.freeze([
  ['<task-notification>', 'body:task-notification'],
  ['[SYSTEM NOTIFICATION', 'body:system-notification'],
  // Live capture 2026-09-10T01:06–01:12Z. Host `q3` / `qee`.
  ['<cross-session-message ', 'body:cross-session-message'],
  ['<agent-message ', 'body:agent-message'],
  // Host binary literals; not observed on hook input (see note above).
  ['<teammate-message ', 'body:teammate-message'], // host `RP`
  ['[Cross-session idle notice]', 'body:idle-notice'],
]);

// Derived from the same table the classifier iterates, so the exported list
// and the actual sniff cannot drift apart (judge review W1, 2026-09-04).
export const NON_USER_BODY_PREFIXES = Object.freeze(
  NON_USER_BODY_MARKERS.map(([prefix]) => prefix),
);

const USER_PROMPT_SOURCE_SET = new Set(USER_PROMPT_SOURCES);

/**
 * Clamp an untrusted source string to one short single-line fragment so it is
 * safe to interpolate into a stderr line.
 * @param {string} value
 * @returns {string}
 */
function sanitizeReasonValue(value) {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 64);
}

/**
 * Decide whether a UserPromptSubmit payload represents an actual user prompt.
 *
 * @param {object|null|undefined} payload - The raw hook payload.
 * @returns {{ user: boolean, reason: string }} `user:false` means no hook
 *   should run. `reason` is a short stable tag for the stderr line.
 */
export function classifyPromptSource(payload) {
  // Not an object at all (empty stdin -> readPayload returns {}, which IS an
  // object). Keep the pre-existing "empty payload still runs" path untouched:
  // the existing test "emits nothing for an empty stdin payload" pins it.
  if (!payload || typeof payload !== 'object') {
    return { user: true, reason: 'payload:empty' };
  }

  if (typeof payload.source === 'string') {
    if (USER_PROMPT_SOURCE_SET.has(payload.source)) {
      return { user: true, reason: `source:${payload.source}` };
    }
    return { user: false, reason: `source:${sanitizeReasonValue(payload.source)}` };
  }

  const body = typeof payload.prompt === 'string'
    ? payload.prompt
    : (typeof payload.user_prompt === 'string' ? payload.user_prompt : '');
  const head = body.trimStart();
  for (const [prefix, reason] of NON_USER_BODY_MARKERS) {
    if (head.startsWith(prefix)) return { user: false, reason };
  }

  return { user: true, reason: 'source:absent' };
}

async function main() {
  if (process.env.ARTIBOT_DISABLE_DISPATCHER === '1') {
    process.stderr.write(`[artibot:${HOOK_NAME}] disabled via ARTIBOT_DISABLE_DISPATCHER=1\n`);
    return;
  }

  const payload = await readPayload();

  // Step 0.5: sender guard. Runs BEFORE the rewriter and before the
  // git-autopilot-save spawn, so a machine-injected turn costs one stderr line
  // and nothing else — no decision rows, no mission ledger entry, no child
  // process.
  //
  // Why EMPTY stdout rather than `{continue:true}`: `continue` defaults to true
  // in the host, and `mergeHookResults` already elides it for that reason (see
  // its JSDoc). The existing test "emits nothing for an empty stdin payload"
  // pins empty stdout as a live, host-accepted response.
  const promptSource = classifyPromptSource(payload);
  if (!promptSource.user) {
    process.stderr.write(
      `[artibot:${HOOK_NAME}] skipped non-user prompt (${promptSource.reason}) — 0 hooks run\n`,
    );
    return;
  }

  // Step 1: rewriter (sync ordering — its output mutates the payload that the
  // parallel contributors classify on, so they see the rewritten prompt).
  // Contract: rewriter is all-or-nothing. If it throws, safeRun returns null
  // and any partial additionalContext it would have emitted is lost on purpose
  // — the parallel contributors still run unaffected. If rewriter ever needs
  // to deliver partial results, change safeRun to capture intermediate state
  // and merge here before the parallel fan-out.
  // SH-29: every name `safeRun` reports a THROW for, for `hook.fired.failed`.
  // A handler that merely returned null is NOT in here — see the limitation
  // note at the carrier call.
  const threw = new Set();
  const noteThrow = (name) => threw.add(name);

  const rewriterResult = await safeRun(
    userPromptHandler, payload, 'user-prompt-handler', noteThrow,
  );
  // Use typeof string check so empty string "" (a legitimate rewriter output)
  // is preserved instead of being treated as missing by a truthy check.
  if (typeof rewriterResult?.user_prompt === 'string') {
    payload.user_prompt = rewriterResult.user_prompt;
  }

  // Step 2: 5 in-process contributors in parallel + 1 child-process side-effect.
  //
  // ORDER IS LOAD-BEARING even though these run concurrently: `allSettled`
  // returns results in INPUT order, and `mergeHookResults` joins their
  // additionalContext in that same order. `runtime-prompt` goes first so the
  // `[artibot:effort …][artibot:task-budget …]` directives are the first line
  // the model reads, ahead of the advisory `[auto-team-suggested]` blocks.
  const [parallelResults] = await Promise.all([
    Promise.allSettled([
      safeRun(runtimePrompt, payload, 'runtime-prompt', noteThrow),
      safeRun(autoTeamTrigger, payload, 'auto-team-trigger', noteThrow),
      safeRun(autopilotNlu, payload, 'autopilot-nlu-trigger', noteThrow),
      safeRun(autoCommandSuggest, payload, 'auto-command-suggest', noteThrow),
      safeRun(ambiguityGuard, payload, 'ambiguity-guard', noteThrow),
    ]),
    runGitAutopilotSave(payload),
  ]);

  const merged = mergeHookResults(rewriterResult, parallelResults, {
    legacyStdout: isLegacyStdoutEnabled(),
  });
  if (merged) {
    try { process.stdout.write(JSON.stringify(merged)); } catch { /* ignore */ }
  }

  // SH-29 hook carrier (O8=a1): one hook.fired row per dispatch, after stdout.
  //
  // WHAT `failed` DOES NOT SEE HERE (rules §9 — write it next to the gate).
  // Six of the seven handlers run IN-PROCESS, and `safeRun` swallows their
  // throws. `noteThrow` recovers exactly that case, so a handler that THREW is
  // named in `failed`. Everything else is invisible:
  //   - A handler that returned null, undefined or a malformed result is
  //     recorded as `ok`. Nothing distinguishes "nothing to contribute" — the
  //     normal answer for five of the six — from "gave up quietly".
  //   - `git-autopilot-save` is ALWAYS `ok`. `runGitAutopilotSave` resolves the
  //     same way on a clean exit, a non-zero exit, a spawn failure and the 8s
  //     timeout; all four are stderr-only today, so the row would be lying if
  //     it claimed to know which one happened.
  // In short, `failed` is a subset of real failures for this slot, never a
  // superset. `[artibot:_userprompt-dispatcher] <name> failed:` on stderr
  // remains the only complete record.
  try {
    recordHookFired({
      slot: EVENT_NAME, payload,
      results: HOOK_FIRED_HANDLERS.map((name) => ({
        name, status: threw.has(name) ? 'error' : 'ok',
      })),
    });
  } catch { /* never let the carrier touch the slot */ }
}

if (isMainEntry(import.meta.url)) {
  main().catch(createFatalHandler(HOOK_NAME));
}
