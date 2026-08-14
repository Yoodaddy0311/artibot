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
 *   4. Merges the results: `user_prompt` from the rewriter takes precedence;
 *      every contributor's additionalContext is concatenated with blank-line
 *      separators.
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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import { createFatalHandler, readPayload } from './_dispatcher-utils.js';

const HOOK_NAME = '_userprompt-dispatcher';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT_AUTOPILOT_SAVE = path.join(HERE, 'git-autopilot-save.js');
// 8s: fresh repos can hit init/index lock on the semantic strategy's two
// git invocations (stash + commit). Failure here is observable via stderr
// only — the user's prompt still proceeds.
const GIT_AUTOPILOT_TIMEOUT_MS = 8000;

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
 * Merge the rewriter's result with the parallel contributors' results.
 *
 *   - `user_prompt` from the rewriter wins (it can rewrite or null-out).
 *   - `additionalContext` from every contributor is concatenated with
 *     blank-line separators. The rewriter's own additionalContext (if any)
 *     comes first, followed by the parallel contributors in fulfillment order.
 *   - All other top-level fields (e.g. `continue`, `message`) are spread from
 *     the rewriter's result, then defensively shallow-merged with each
 *     contributor's non-context fields (last write wins; uncommon in practice).
 *
 * @param {object|null} rewriterResult
 * @param {Array<PromiseSettledResult<object|null>>} parallelResults
 * @returns {object|null} The merged response object, or null when nothing to send.
 */
export function mergeHookResults(rewriterResult, parallelResults) {
  const out = {};
  const additions = [];

  function ingest(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return;
    const ctx = value?.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) additions.push(ctx);
    for (const [key, val] of Object.entries(value)) {
      if (key === 'hookSpecificOutput') continue; // composed below
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

  // Step 2: 4 in-process contributors in parallel + 1 child-process side-effect.
  const [parallelResults] = await Promise.all([
    Promise.allSettled([
      safeRun(autoTeamTrigger, payload, 'auto-team-trigger'),
      safeRun(runtimePrompt, payload, 'runtime-prompt'),
      safeRun(autopilotNlu, payload, 'autopilot-nlu-trigger'),
      safeRun(autoCommandSuggest, payload, 'auto-command-suggest'),
      safeRun(ambiguityGuard, payload, 'ambiguity-guard'),
    ]),
    runGitAutopilotSave(payload),
  ]);

  const merged = mergeHookResults(rewriterResult, parallelResults);
  if (merged) {
    try { process.stdout.write(JSON.stringify(merged)); } catch { /* ignore */ }
  }
}

if (isMainEntry(import.meta.url)) {
  main().catch(createFatalHandler(HOOK_NAME));
}
