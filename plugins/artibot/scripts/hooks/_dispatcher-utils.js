/**
 * Shared dispatcher utilities.
 *
 * Each Artibot dispatcher (UserPromptSubmit/SessionStart/PostToolUse/Stop/
 * SessionEnd) consolidates N hooks-per-slot into a single registered command.
 *
 * Design contract:
 *
 *   1. Every hook is invoked as a child Node process. This isolates crashes —
 *      one hook's SyntaxError or unhandled rejection never propagates into the
 *      dispatcher process and never blocks the slot.
 *   2. Each child has its own timeout. The dispatcher SIGTERMs and resolves
 *      with `{ status: 'timeout', name }` so a slow hook never holds up the
 *      slot.
 *   3. stdout JSON from each child is parsed best-effort. Garbage stdout
 *      simply contributes nothing to the merge.
 *   4. stderr from each child is forwarded to the parent process's stderr
 *      so existing observability (banners, advisories, [artibot:*] markers)
 *      survives consolidation.
 *   5. NEVER throw and NEVER exit non-zero. Hook crashes must not block the
 *      slot.
 *
 * @module scripts/hooks/_dispatcher-utils
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractToolName } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// isMainEntry is owned by ./_main-entry.js — a zero-dependency leaf module, so
// the ~50 hooks that need only the direct-run guard do not pull this file's
// child_process + hook-utils graph onto the spawn hot path. Re-exported here so
// the dispatchers (and tests) that already import it from this module are
// unaffected.
export { isMainEntry };

// v4.8.0 H-2: extractToolName is owned by lib/core/hook-utils.js; we re-export
// it so the dispatcher hot path keeps a single import line and downstream
// callers (_posttooluse-dispatcher.js, tests) see one canonical implementation.
export { extractToolName };

/**
 * Read the entire stdin payload and JSON-parse it. Returns {} on empty/invalid.
 *
 * Chunks are collected and decoded ONCE at the end, never accumulated with
 * `buf += chunk`. A Buffer chunk stringifies itself in isolation, so a UTF-8
 * character straddling the 64KB stdin chunk boundary loses its tail and comes
 * back as U+FFFD. Measured on a real pipe 2026-08-14: a 64,571-byte payload
 * round-tripped intact, a 66,071-byte one came back with 3 replacement chars.
 * That matters more here than in a single hook — spawnHook re-serializes this
 * payload to every child, so one bad decode reaches every hook in the slot
 * even though each of them reads its own stdin correctly.
 * `lib/core/io.js#readStdin` closes the same gap from the other side, with
 * `setEncoding`; this module cannot import it (leaf module — see header).
 *
 * @returns {Promise<object>}
 */
export async function readPayload() {
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    return {};
  }
  // String chunks are tolerated: an upstream setEncoding would already have
  // decoded them correctly, but Buffer.concat throws on a string array.
  const buf = Buffer.concat(
    chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf-8') : c)),
  ).toString('utf-8');
  if (!buf) return {};
  try {
    return JSON.parse(buf);
  } catch {
    return {};
  }
}

/**
 * Resolve a hook script path relative to scripts/hooks/.
 * @param {string} name e.g. "session-start.js"
 * @returns {string}
 */
export function hookPath(name) {
  return path.join(HERE, name);
}

/**
 * Spawn a hook child process with the given payload on stdin.
 *
 * Resolution is guaranteed:
 *   - on natural exit (whatever the exit code),
 *   - on hard timeout (SIGTERM then resolve),
 *   - on spawn error (resolve with status=error),
 *   - never rejects.
 *
 * @param {string} scriptPath absolute path to the hook script
 * @param {object} payload JSON-serializable input
 * @param {object} opts
 * @param {number} opts.timeoutMs hard timeout per hook (default 5000)
 * @param {string} opts.name human-readable hook name for logs
 * @param {string[]} [opts.args] extra CLI arguments to pass after the script
 * @param {string} [opts.dispatcherName] dispatcher tag for stderr lines
 * @param {boolean} [opts.allowTimeoutScale] opt in to the TEST-ONLY budget
 *   multiplier (see resolveTimeoutScale). Only the literal `true` opts in, and
 *   only together with a usable `slotTimeoutMs`; the default runs `timeoutMs` as
 *   declared whatever the environment holds. The PostToolUse dispatcher is the
 *   one caller that passes it.
 * @param {number} [opts.slotTimeoutMs] the host timeout of the slot this
 *   dispatcher is registered in, in ms (hooks/hooks.json `timeout`, which is in
 *   seconds, x 1000). It bounds a SCALED budget at `slotTimeoutMs` minus
 *   DISPATCHER_HEADROOM_MS (see scaledBudgetCeilingMs). Read only when
 *   `allowTimeoutScale` is true; without a finite slot above the headroom the
 *   scale is not applied at all.
 * @returns {Promise<{ status: 'ok'|'timeout'|'error', name: string, stdout: string }>}
 */
export function spawnHook(scriptPath, payload, opts) {
  const {
    timeoutMs = 5000,
    name = path.basename(scriptPath, '.js'),
    args = [],
    dispatcherName = '_dispatcher',
    allowTimeoutScale = false,
    slotTimeoutMs,
  } = opts || {};
  // The declared budget, byte for byte, unless the caller opted in with a literal
  // `true`, named the slot it runs in, AND the test-only scale is set (see
  // resolveTimeoutScale). An allowlist: a dispatcher added later starts on the
  // shipped budget. No slot, no stretch: nothing can be kept inside a slot the
  // caller did not name, so an opt-in without one is refused, not left unbounded.
  const ceilingMs = scaledBudgetCeilingMs(slotTimeoutMs);
  const scale = allowTimeoutScale === true && ceilingMs !== null ? resolveTimeoutScale() : 1;
  const budgetMs = scaleTimeoutMs(timeoutMs, scale, ceilingMs ?? undefined);
  // What an operator reading a stretched timeout needs: the declared budget, the
  // factor and, only when the ceiling shortened the product, that it did.
  let stretchNote = '';
  if (budgetMs !== timeoutMs) {
    stretchNote = budgetMs < scaleTimeoutMs(timeoutMs, scale)
      ? ` (declared ${timeoutMs}ms x ${scale}, capped by the ${slotTimeoutMs}ms slot)`
      : ` (declared ${timeoutMs}ms x ${scale})`;
  }

  return new Promise((resolve) => {
    let settled = false;
    const chunks = [];

    function finish(status) {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(chunks).toString('utf-8');
      resolve({ status, name, stdout });
    }

    let child;
    try {
      child = spawn(process.execPath, [scriptPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env },
      });
    } catch (err) {
      process.stderr.write(`[artibot:${dispatcherName}] ${name} spawn failed: ${err.message}\n`);
      finish('error');
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      process.stderr.write(`[artibot:${dispatcherName}] ${name} timed out after ${budgetMs}ms${stretchNote}\n`);
      finish('timeout');
    }, budgetMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`[artibot:${dispatcherName}] ${name} error: ${err.message}\n`);
      finish('error');
    });
    child.on('exit', () => {
      clearTimeout(timer);
      finish('ok');
    });

    if (child.stdout) {
      child.stdout.on('data', (c) => chunks.push(c));
    }
    // Forward child stderr lines to parent stderr so banners / advisories
    // remain visible after consolidation.
    if (child.stderr) {
      child.stderr.on('data', (c) => {
        try { process.stderr.write(c); } catch { /* ignore */ }
      });
    }

    try {
      child.stdin.end(JSON.stringify(payload || {}));
    } catch (err) {
      process.stderr.write(`[artibot:${dispatcherName}] ${name} stdin write failed: ${err.message}\n`);
      // Let exit/timeout handlers complete the promise.
    }
  });
}

/** The only environment variable that stretches hook budgets. TEST-ONLY. */
const TIMEOUT_SCALE_ENV = 'ARTIBOT_DISPATCH_TIMEOUT_SCALE';

/** Largest multiplier `resolveTimeoutScale` will return, however big the value. */
const TIMEOUT_SCALE_MAX = 10;

/** The one accepted syntax: a plain non-negative decimal, ASCII digits only. */
const TIMEOUT_SCALE_SYNTAX = /^\d+(?:\.\d+)?$/;

/** setTimeout keeps its delay in a signed 32-bit int; a longer one fires after 1 ms. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * What a dispatcher keeps for ITS OWN work inside the host slot: node cold start,
 * dispatch-table load, child fan-out and the merge that writes the one stdout. A
 * conservative budget figure, NOT a measurement.
 *
 * PAIRED CONSTANT. tests/firewall/hook-timeout-budget.test.js reserves the same
 * 3 s as its private `HEADROOM_MS` when it checks the DECLARED budgets against the
 * slot. The two are equal by convention and nothing links them: change one, change
 * the other in the same commit. That test belongs to another lane and is left as it
 * is; it can import this export to drop the duplicate.
 */
export const DISPATCHER_HEADROOM_MS = 3000;

/**
 * The most a SCALED child budget may be inside a host slot of `slotTimeoutMs`: the
 * slot minus {@link DISPATCHER_HEADROOM_MS}. `null` when a ceiling cannot be
 * derived - the slot is not a finite number, or leaves no room above the headroom
 * - and `spawnHook` then applies no scale at all (fail closed).
 *
 * @param {unknown} slotTimeoutMs host timeout of the slot in ms
 * @returns {number|null}
 */
export function scaledBudgetCeilingMs(slotTimeoutMs) {
  if (!Number.isFinite(slotTimeoutMs)) return null;
  const ceiling = slotTimeoutMs - DISPATCHER_HEADROOM_MS;
  return ceiling > 0 ? ceiling : null;
}

/**
 * TEST-ONLY budget multiplier. Returns the factor `spawnHook` applies to every
 * declared `timeoutMs` of a caller that opted in (`allowTimeoutScale: true`, with
 * the host slot named in `slotTimeoutMs`):
 * exactly 1 (the shipped budgets, byte for byte) unless
 * `ARTIBOT_DISPATCH_TIMEOUT_SCALE` holds a plain decimal, which is then clamped
 * to [1, 10].
 *
 * WHY. A handler's timer starts at spawn(), so its budget also has to cover
 * process creation and node cold start. On a loaded machine the tightest budget
 * (post-write-tdd, hooks/dispatch-table.json) loses that race, the handler is
 * recorded as `timeout`, and a test asserting `hook.fired` `data.failed` is `[]`
 * fails with no defect in the code under test. Scaling the budget keeps that
 * assertion strict instead of loosening it.
 *
 * WHY ONLY POSTTOOLUSE. A dispatcher waits for every child (Promise.allSettled)
 * and writes ONE merged stdout after the last one settles, and hooks/hooks.json
 * gives each dispatcher a host timeout. One that outlives it is cancelled (how
 * the host enforces that is not verified in this repo) and writes nothing, so
 * what its children already produced is lost. A stretched child budget can turn
 * "a slow hook gave up" into "the slot's whole output vanished":
 *   - Stop: 30 s slot, stop-review-gate declared 15 s, so from 2x it reaches the
 *     host limit. dev-verify-gate's decision:'block' (stop-review-gate can emit
 *     one too) exists only as that stdout, so it is lost with the dispatcher and
 *     the gate does not block.
 *   - SubagentStop: 15 s slot, agent-evaluator declared 8 s, so from 1.875x. No
 *     handler on this slot emits a decision today; the loss is the merged
 *     `message` and the `hook.fired` row.
 *   - SessionStart, SessionEnd: 30 s slot, swarm-download / swarm-sync declared
 *     15 s, so from 2x.
 * Those four never opt in, so they keep the declared budgets whatever the
 * environment holds. The Stop and SubagentStop suites pin that with a timer spy,
 * and tests/dispatcher/dispatcher-utils-timeout.test.js pins who may opt in,
 * which is what covers SessionStart and SessionEnd.
 *
 * WHAT IT COSTS POSTTOOLUSE. Its handlers are advisory except quality-gate,
 * whose hardcoded-secret post guard
 * (lib/core/guard-registry.js#checkHardcodedSecret) can emit decision:'block'.
 * PostToolUse fires after the tool ran, so a lost block is lost feedback on a
 * write that already happened, not a gate on it. The slot is 30 s and
 * post-edit-format is declared 10 s, so an UNBOUNDED scale ran the 3 s
 * dispatcher headroom that tests/firewall/hook-timeout-budget.test.js reserves
 * out above 2.7x, and at the 10x cap post-edit-format alone was 100 s: a child
 * that really hung got the dispatcher cancelled before its own timer fired, and
 * the merged output went with it.
 *
 * THE CEILING. `spawnHook` therefore clamps each SCALED budget to the slot minus
 * DISPATCHER_HEADROOM_MS (27 s for PostToolUse), and applies the scale at all
 * only to a caller that names its slot (`slotTimeoutMs`). Why per budget and not a
 * lower cap on the multiplier: a cap derived from the slot and the largest
 * declared budget is 2.7x (27 s over post-edit-format's 10 s), and that would cut
 * post-write-tdd - the tightest budget, the one this knob exists for - from 30 s
 * to 8.1 s. tests/dispatcher/posttooluse-dispatcher.test.js records 9-11 s for a
 * whole dispatch under the 16-parallel harness, the load the knob was added for;
 * the child's own share of that was not measured, so 8.1 s is a reason for
 * caution, not a proven failure. Clamping each child's timer keeps the stretch
 * where it is needed and stops it only where it would outlast the slot. It also
 * needs no update when a handler with a bigger budget joins the table. A declared
 * budget already above the ceiling is left as declared, never shortened: that is
 * the firewall gate's finding, not something a test knob may repair.
 *
 * ENVELOPE (each line is pinned by tests/dispatcher/dispatcher-utils-timeout.test.js):
 *   - It can only LENGTHEN. A value below 1 is floored to 1, so it can never turn
 *     every hook into a `timeout` and silently disable them.
 *   - It is capped at 10, and `scaleTimeoutMs` keeps the product inside what
 *     setTimeout can hold.
 *   - A scaled budget never exceeds `slotTimeoutMs` - DISPATCHER_HEADROOM_MS, and
 *     a caller that names no usable slot gets no stretch at all.
 *   - It is read from `^\d+(\.\d+)?$` and nothing else. Anything else is 1, so a
 *     typo fails closed to the shipped budgets.
 *   - It is read only for a caller passing the literal `allowTimeoutScale: true`,
 *     and the PostToolUse dispatcher is the only production module that does.
 *   - This module is its only reader.
 *
 * WHAT IT CANNOT SEE. tests/firewall/hook-timeout-budget.test.js checks the
 * DECLARED budgets against the host's slot timeout (hooks/hooks.json), so a
 * runtime multiplier is invisible to it; the ceiling above is what covers that
 * gap for the one dispatcher that scales. What the ceiling does not cover:
 *   - The headroom is that gate's conservative 3 s budget, not a measurement. A
 *     dispatcher whose own cold start, table load and merge take longer under
 *     load can still lose a slot whose slowest child ran to the ceiling.
 *   - The slot is a figure the PostToolUse dispatcher names itself. Its equality
 *     with the hooks/hooks.json `timeout` is pinned by
 *     tests/dispatcher/posttooluse-dispatcher.test.js, which reads that file; a
 *     dispatcher added later that opts in must name its own slot and is on its own
 *     until it has a pin of that kind.
 *   - How the host enforces that timeout is not verified in this repo.
 * Nothing stops an operator exporting the variable in a real session either: it
 * then reaches the PostToolUse dispatcher and no other, where a real hang can
 * now cost up to 27 s of the 30 s slot before the child is cut, but no longer the
 * slot's merged output. ARTIBOT_DISABLE_DISPATCHER=1 stays the explicit off
 * switch.
 *
 * @param {Record<string, unknown>|null} [env] defaults to process.env
 * @returns {number} a finite number in [1, 10]
 */
export function resolveTimeoutScale(env = process.env) {
  const raw = env?.[TIMEOUT_SCALE_ENV];
  if (typeof raw !== 'string' || !TIMEOUT_SCALE_SYNTAX.test(raw)) return 1;
  return Math.min(Math.max(Number(raw), 1), TIMEOUT_SCALE_MAX);
}

/**
 * Apply `scale` to a declared budget. The identity at scale 1; otherwise the
 * product rounded up and clamped to what setTimeout can hold and to `ceilingMs`.
 * Never shorter than the declared budget, whatever `scale` is (0, negative, NaN,
 * Infinity) and whatever `ceilingMs` is (below the budget, NaN, null, 0): that
 * guard is the second line of defence behind `resolveTimeoutScale`'s floor, and
 * it makes an unusable ceiling leave the declared budget rather than unbound the
 * product. Omitting `ceilingMs` (undefined) means no ceiling beyond the timer's.
 *
 * @param {number} timeoutMs declared budget
 * @param {number} scale factor from resolveTimeoutScale
 * @param {number} [ceilingMs] the most the scaled budget may be, from
 *   scaledBudgetCeilingMs
 * @returns {number}
 */
export function scaleTimeoutMs(timeoutMs, scale, ceilingMs = TIMER_MAX_MS) {
  if (scale === 1) return timeoutMs;
  const scaled = Math.min(Math.ceil(timeoutMs * scale), TIMER_MAX_MS, ceilingMs);
  return scaled > timeoutMs ? scaled : timeoutMs;
}

/**
 * Parse a hook's stdout best-effort. Returns null when empty / unparseable
 * (we never throw on bad stdout — a hook is allowed to print nothing).
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseHookStdout(stdout) {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Keys that must never be copied out of a hook's parsed stdout.
 *
 * `out[key] = val` is a [[Set]], so a key of `__proto__` runs the inherited
 * accessor on Object.prototype and swaps the ENVELOPE's prototype instead of
 * adding a property to it. Nothing reaches Object.prototype globally, and
 * JSON.stringify emits own properties only — so the serialized response stays
 * clean today. It is the field READS that are exposed: any caller holding the
 * merged object sees attacker-supplied values resolve through the chain.
 * `constructor` and `prototype` are different — they land as ordinary own
 * enumerable properties and do reach stdout as-is.
 *
 * Measured against mergeResults 2026-08-15, before this guard:
 *   [{"__proto__":{"decision":"block"}}] -> merged.decision === 'block'
 *                                           while JSON.stringify(merged) is '{}'
 *   [{"constructor":{"evil":1}}]         -> '{"constructor":{"evil":1}}'
 *
 * A deny-list is normally fail-open against future additions. These three are
 * the exception: the set is fixed by the language spec, so it cannot grow.
 */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * True when `key` must not be shallow-merged into a response envelope.
 *
 * Exported rather than inlined so the UserPromptSubmit dispatcher's separate
 * merge (`_userprompt-dispatcher.js#mergeHookResults`) cannot drift from this
 * one — a duplicated merge is precisely what let a single stdin decode bug
 * exist in two places at once (see readPayload above).
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isUnsafeMergeKey(key) {
  return UNSAFE_MERGE_KEYS.has(key);
}

/**
 * Merge an array of hook results into a single response envelope.
 *
 *   - `additionalContext` from every hookSpecificOutput is concatenated with
 *     blank-line separators (in array order).
 *   - `decision === 'block'` from any hook wins (we surface the first blocker
 *     with its reason); we still concat any additionalContext from later
 *     hooks for visibility.
 *   - `message` strings are joined with newline separators.
 *   - Other top-level fields are shallow-merged (last write wins), except the
 *     keys `isUnsafeMergeKey` rejects — those are dropped, never copied.
 *
 * @param {Array<object|null>} results
 * @param {string} hookEventName for the merged hookSpecificOutput envelope
 * @returns {object|null}
 */
export function mergeResults(results, hookEventName) {
  const out = {};
  const additions = [];
  const messages = [];
  let blocker = null;

  for (const r of results || []) {
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r)) continue;

    const ctx = r?.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) additions.push(ctx);

    if (typeof r.message === 'string' && r.message.length > 0) {
      messages.push(r.message);
    }

    if (r.decision === 'block' && !blocker) {
      blocker = { decision: 'block', reason: r.reason || 'blocked by hook' };
    }

    for (const [key, val] of Object.entries(r)) {
      if (isUnsafeMergeKey(key)) continue;
      if (key === 'hookSpecificOutput') continue;
      if (key === 'message') continue;
      if (key === 'decision' || key === 'reason') continue;
      out[key] = val;
    }
  }

  if (blocker) {
    out.decision = blocker.decision;
    out.reason = blocker.reason;
  }

  if (messages.length > 0) {
    out.message = messages.join('\n');
  }

  if (additions.length > 0) {
    out.hookSpecificOutput = {
      hookEventName,
      additionalContext: additions.join('\n\n'),
    };
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build the fatal handler every dispatcher attaches to `main().catch(...)`.
 *
 * Contract (design note 5 in the module header): a dispatcher must NEVER throw
 * and NEVER exit non-zero — that would block the whole slot. So the handler
 * reports on stderr, where the parent already forwards `[artibot:*]` markers,
 * and then exits 0.
 *
 * Deliberately NOT `hook-utils.createErrorHandler(name, { exit: true })`: that
 * one logs `[artibot:<name>] <message>` while dispatchers log
 * `[artibot:<name>] fatal: <message>`. The `fatal:` marker distinguishes a dead
 * dispatcher (every hook in the slot lost) from a single hook reporting an
 * error, so it is load-bearing in logs rather than cosmetic.
 *
 * @param {string} hookName Dispatcher name, e.g. "posttooluse-dispatcher"
 * @returns {(err: Error) => void}
 */
export function createFatalHandler(hookName) {
  return (err) => {
    process.stderr.write(`[artibot:${hookName}] fatal: ${err.message}\n`);
    process.exit(0);
  };
}
