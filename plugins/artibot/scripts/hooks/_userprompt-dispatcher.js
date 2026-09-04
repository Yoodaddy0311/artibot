#!/usr/bin/env node
/**
 * UserPromptSubmit dispatcher.
 *
 * Replaces the previous configuration of 6 separate UserPromptSubmit hook
 * commands (each spawning its own `node` process and re-loading config) with
 * a single in-process orchestrator that:
 *
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

const HOOK_NAME = '_userprompt-dispatcher';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT_AUTOPILOT_SAVE = path.join(HERE, 'git-autopilot-save.js');
// 8s: fresh repos can hit init/index lock on the semantic strategy's two
// git invocations (stash + commit). Failure here is observable via stderr
// only — the user's prompt still proceeds.
const GIT_AUTOPILOT_TIMEOUT_MS = 8000;

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
 * @param {Function} fn
 * @param {object} payload
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function safeRun(fn, payload, name) {
  try {
    return await fn(payload);
  } catch (err) {
    process.stderr.write(`[artibot:${HOOK_NAME}] ${name} failed: ${err.message}\n`);
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

async function main() {
  if (process.env.ARTIBOT_DISABLE_DISPATCHER === '1') {
    process.stderr.write(`[artibot:${HOOK_NAME}] disabled via ARTIBOT_DISABLE_DISPATCHER=1\n`);
    return;
  }

  const payload = await readPayload();

  // Step 1: rewriter (sync ordering — its output mutates the payload that the
  // parallel contributors classify on, so they see the rewritten prompt).
  // Contract: rewriter is all-or-nothing. If it throws, safeRun returns null
  // and any partial additionalContext it would have emitted is lost on purpose
  // — the parallel contributors still run unaffected. If rewriter ever needs
  // to deliver partial results, change safeRun to capture intermediate state
  // and merge here before the parallel fan-out.
  const rewriterResult = await safeRun(userPromptHandler, payload, 'user-prompt-handler');
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
      safeRun(runtimePrompt, payload, 'runtime-prompt'),
      safeRun(autoTeamTrigger, payload, 'auto-team-trigger'),
      safeRun(autopilotNlu, payload, 'autopilot-nlu-trigger'),
      safeRun(autoCommandSuggest, payload, 'auto-command-suggest'),
      safeRun(ambiguityGuard, payload, 'ambiguity-guard'),
    ]),
    runGitAutopilotSave(payload),
  ]);

  const merged = mergeHookResults(rewriterResult, parallelResults, {
    legacyStdout: isLegacyStdoutEnabled(),
  });
  if (merged) {
    try { process.stdout.write(JSON.stringify(merged)); } catch { /* ignore */ }
  }
}

if (isMainEntry(import.meta.url)) {
  main().catch(createFatalHandler(HOOK_NAME));
}
