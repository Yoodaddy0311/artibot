/**
 * Decision events — why the runtime routed a prompt the way it did.
 *
 * The third consumer of `lib/observability/run-events.js`, alongside
 * `lib/autopilot/telemetry.js` (`runtime/autopilot/`) and
 * `lib/observability/split-telemetry.js` (`runtime/split/`). It writes the same
 * line shape into `runtime/decisions/`, so `replay.js` and every other reader of
 * that shape work here unchanged.
 *
 * WHY A SECOND STORE INSTEAD OF `lib/core/decision-trail.js`: measured
 * 2026-08-28, the trail records one entry per *slash-command* prompt — 95 of 782
 * user turns over 18 active days (12.1%). The decisions this module records
 * happen on every prompt, so routing them into the trail would multiply its
 * volume ~8x. That matters because the trail is a single-file read-modify-write:
 * its vulnerable window scales with file size (measured 4.80ms at 971 entries,
 * 22.62ms at the 5,000-entry cap). Appending instead of rewriting removes the
 * window entirely, so volume here costs nothing.
 *
 * SCOPE OF THAT WINDOW — do not overstate it. The *in-process* lost update was
 * closed by afe799a9 (the suspension moved above the read, making the
 * read-modify-write synchronous). What remains, and what append-only avoids
 * here, is the CROSS-PROCESS case: separate Node processes (the per-prompt hook,
 * the cron runners) share no execution, so a synchronous section does not
 * serialize them — measured 21 of 60 writes lost across 3 processes.
 *
 * OBSERVE-ONLY. Nothing here blocks, vetoes, or changes a routing decision, and
 * no failure propagates to the caller. Unlike the trail, though, failures are
 * COUNTED (`getDecisionRecorderStats`) — a swallowed error that nobody can even
 * count is how the trail stayed empty in production without anyone noticing.
 *
 * PRIVACY: prompt text is never written. Only the classifier's own outputs
 * (scores, thresholds, chosen system, agent names) go to disk. Two mechanisms,
 * because the payload has two shapes:
 *   - Fixed shapes (`ROUTING_FIELDS`, the plan's scalars) are copied by NAME, so
 *     an added upstream field cannot leak by default.
 *   - Open containers — `factors` (keyed by signal name) and `trigger.reasons`
 *     (a generated list) — legitimately grow, so a name allowlist would drop
 *     real data. They are filtered by VALUE TYPE instead: numbers only for
 *     `factors`, short strings only for `reasons`. Both keep the container open
 *     while making it impossible for a string carrying prompt-derived text to
 *     ride along.
 * Neither mechanism spreads an upstream object verbatim.
 *
 * RETENTION: file-granular, one file per run id, like the two sibling stores.
 * Nothing prunes it yet — deliberately noted rather than silently inherited:
 * `runtime/autopilot/` has accumulated 10,476 event files (measured 2026-08-28)
 * because no cleanup was ever specified. A pruner for all three stores is a
 * separate decision.
 *
 * Public surface:
 *   - ROUTING_CLASSIFIED / WORKFLOW_PLANNED   (the two `type` values written)
 *   - getDecisionStoreDir({ storeDir })
 *   - getDecisionEventsPath(runId, { storeDir })
 *   - readDecisionEvents(runId, { storeDir, tail, level })
 *   - resolveDecisionRunId(source)
 *   - recordRoutingDecision(runId, classification, { storeDir, ts, phase })
 *   - recordWorkflowPlanDecision(runId, plan, { storeDir, ts, phase })
 *   - getDecisionRecorderStats() / resetDecisionRecorderStats()
 *
 * DATA POLICY: 100% local file; no external transmission.
 *
 * @module lib/observability/decision-events
 */

import path from 'node:path';
import { getPluginRoot } from '../core/platform.js';
import { appendRunEvent, readRunEvents, resolveRunEventsPath } from './run-events.js';

const DECISIONS_DIR = 'decisions';

export const ROUTING_CLASSIFIED = 'routing-classified';
export const WORKFLOW_PLANNED = 'workflow-planned';

/**
 * Write outcomes for this process. Counted rather than merely swallowed: the
 * decision trail proved that an error nobody can count is indistinguishable
 * from "there was nothing to record", and that ambiguity hid an outage.
 *
 * `skipped` counts calls that carried no session id. It is separate from
 * `failed` on purpose: a write that could not happen and a write that broke are
 * different diagnoses, and collapsing them would hide whichever is rarer.
 *
 * @type {{ recorded: number, failed: number, skipped: number, lastError: string|null }}
 */
const stats = { recorded: 0, failed: 0, skipped: 0, lastError: null };

/**
 * @returns {{ recorded: number, failed: number, skipped: number, lastError: string|null }} a copy
 */
export function getDecisionRecorderStats() {
  return { ...stats };
}

/**
 * Reset the counters. Test helper, not a public contract.
 * @returns {void}
 */
export function resetDecisionRecorderStats() {
  stats.recorded = 0;
  stats.failed = 0;
  stats.skipped = 0;
  stats.lastError = null;
}

/**
 * Resolve the directory decision events live in. Defaults to
 * `<pluginRoot>/runtime/decisions/`; tests pass an explicit `storeDir` under
 * `os.tmpdir()` and never touch the real one.
 *
 * @param {{ storeDir?: string }} [opts]
 * @returns {string}
 */
export function getDecisionStoreDir(opts = {}) {
  const override = opts && typeof opts.storeDir === 'string' && opts.storeDir ? opts.storeDir : null;
  return override || path.join(getPluginRoot(), 'runtime', DECISIONS_DIR);
}

/**
 * @param {string} runId
 * @param {{ storeDir?: string }} [opts]
 * @returns {string}
 */
export function getDecisionEventsPath(runId, opts = {}) {
  return resolveRunEventsPath(getDecisionStoreDir(opts), runId);
}

/**
 * @param {string} runId
 * @param {{ storeDir?: string, tail?: number, level?: 'info'|'warn'|'error' }} [opts]
 * @returns {object[]}
 */
export function readDecisionEvents(runId, opts = {}) {
  return readRunEvents(getDecisionStoreDir(opts), runId, opts);
}

/**
 * Reduce an id to characters that cannot leave the store directory. A session
 * id reaches us from the hook payload — outside input — and it becomes a file
 * name, so `../` in it would write outside `runtime/decisions/`.
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeRunId(raw) {
  return raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    // Collapse dot runs AFTER the charset pass, not before. `../../x` is already
    // `..-..-x` by this point, so stripping only a leading `..` would leave the
    // inner ones intact; collapsing every run is what removes the traversal.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
}

/**
 * Pick the file these events belong to, or null when there is no session.
 *
 * The middleware runs inside a short-lived per-prompt hook process, so there is
 * no ambient run id the way autopilot has one. Priority:
 *   1. the hook payload's `session_id` — the real Claude Code session, which
 *      `scripts/hooks/pre-write-checkpoint.js:17-23` and five sibling hooks
 *      already rely on
 *   2. `sessionId`, for callers that already resolved one
 *
 * The runtime callers pass `state.input` — the object holding the hook payload.
 * The parameter is deliberately NOT named `context`: it was, and both call sites
 * were written against `state.context`, which carries neither field. That reads
 * as working code and fails silently (every call counted `skipped`), so the name
 * is load-bearing.
 *
 * NO FALLBACK BUCKET, deliberately. An earlier draft fell back to a UTC date so
 * an event was "never dropped" — measured consequence: running the middleware
 * suites wrote 10 fixture lines into the real `runtime/decisions/`, mixing test
 * noise into the very store `/doctor` reads to decide whether recording is
 * alive. A fixture that makes the health check look healthy is worse than a
 * missing record. Callers without a session are counted as `skipped` instead,
 * so the absence is visible rather than silently bucketed.
 *
 * @param {{ hookData?: object, sessionId?: string }} [source]
 * @returns {string|null}
 */
export function resolveDecisionRunId(source) {
  const src = source && typeof source === 'object' ? source : {};
  const candidates = [src.hookData?.session_id, src.sessionId];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const clean = sanitizeRunId(c.trim());
      if (clean) return clean;
    }
  }
  return null;
}

/**
 * Append one event, swallowing every failure but counting it.
 *
 * @param {string} runId
 * @param {object} event
 * @param {{ storeDir?: string }} opts
 * @returns {object|null} the persisted event, or null when nothing was written
 */
function record(runId, event, opts) {
  try {
    const persisted = appendRunEvent(getDecisionStoreDir(opts), runId, event);
    stats.recorded += 1;
    return persisted;
  } catch (err) {
    stats.failed += 1;
    stats.lastError = err && err.message ? String(err.message) : 'unknown error';
    return null;
  }
}

/**
 * Copy named numeric/string fields, substituting null for anything absent.
 * Named-field copying (rather than spreading the source) is what keeps a future
 * upstream field — including one holding prompt text — from leaking to disk.
 *
 * @param {object} src
 * @param {string[]} keys
 * @returns {object}
 */
function pick(src, keys) {
  const from = src && typeof src === 'object' ? src : {};
  const out = {};
  for (const k of keys) out[k] = from[k] === undefined ? null : from[k];
  return out;
}

const ROUTING_FIELDS = ['system', 'score', 'threshold', 'confidence', 'nativeEffort'];

/**
 * Longest string accepted as a trigger reason. Real ones are generated tokens
 * (`subObjectives>=2`); anything materially longer is off-contract and is the
 * shape prompt-derived text would arrive in.
 */
const MAX_REASON_LENGTH = 64;

/**
 * Keep only finite numbers. `factors` is a score breakdown keyed by signal name
 * and the key set grows as the classifier gains signals, so a name allowlist
 * would silently drop new scores. Filtering by value type keeps the map open and
 * still makes a string — a matched keyword, a prompt fragment — impossible.
 *
 * @param {object} src
 * @returns {object}
 */
function numericValuesOnly(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Keep only short strings, for the same reason `numericValuesOnly` exists: the
 * list is generated and open-ended, so its contents are constrained by type and
 * length rather than by an enumeration that would go stale.
 *
 * @param {unknown[]} arr
 * @returns {string[]}
 */
function reasonLiteralsOnly(arr) {
  return arr.filter((r) => typeof r === 'string' && r.length > 0 && r.length <= MAX_REASON_LENGTH);
}

/**
 * D5 — record the System 1/2 classification. The classifier is
 * `lib/cognitive/router.js#classifyComplexity`; the live caller is
 * `lib/runtime/middleware/router.js`, immediately after it assigns
 * `state.context.routing`, on every prompt.
 *
 * @param {string} runId
 * @param {object} classification - a `classifyComplexity` result
 * @param {{ storeDir?: string, ts?: string, phase?: string }} [opts]
 * @returns {object|null}
 */
export function recordRoutingDecision(runId, classification, opts = {}) {
  if (!runId || typeof runId !== 'string') {
    stats.skipped += 1;
    return null;
  }
  const cls = classification && typeof classification === 'object' ? classification : {};
  const data = pick(cls, ROUTING_FIELDS);
  // `factors` is the classifier's own score breakdown. Filtered by value type,
  // not spread: see the PRIVACY note in the module header.
  data.factors = cls.factors && typeof cls.factors === 'object'
    ? numericValuesOnly(cls.factors)
    : null;

  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : 'ROUTE',
    type: ROUTING_CLASSIFIED,
    level: 'info',
    message: `routed to system ${data.system} — score ${data.score} vs threshold ${data.threshold}`,
    data,
  }, opts);
}

/**
 * D7 — record the workflow plan: whether a parallel team fired, and why. The
 * planner is `lib/cognitive/workflow-plan.js#buildWorkflowPlan`; the live caller
 * is `lib/runtime/middleware/tasks.js`, in the `agentTeam` branch right after it
 * attaches the plan to `task.meta`.
 *
 * The inline case is recorded too. "No team" is a decision an operator asks
 * about as often as "why a team?", and a record that only exists on one branch
 * cannot answer the other.
 *
 * @param {string} runId
 * @param {object} plan - a `buildWorkflowPlan` result
 * @param {{ storeDir?: string, ts?: string, phase?: string }} [opts]
 * @returns {object|null}
 */
export function recordWorkflowPlanDecision(runId, plan, opts = {}) {
  if (!runId || typeof runId !== 'string') {
    stats.skipped += 1;
    return null;
  }
  const p = plan && typeof plan === 'object' ? plan : {};
  const teammates = Array.isArray(p.teammates) ? p.teammates : [];
  const trigger = p.trigger && typeof p.trigger === 'object' ? p.trigger : {};

  const data = {
    ...pick(p, ['runner', 'effort', 'perAgentBudget', 'recommendation', 'autoFire']),
    teammateCount: teammates.length,
    // Agent names only — the sub-objective text they were derived from stays out.
    teammates: teammates.map((t) => (t && typeof t.agent === 'string' ? t.agent : null)),
    trigger: {
      fired: trigger.fired === true,
      reasons: Array.isArray(trigger.reasons) ? reasonLiteralsOnly(trigger.reasons) : [],
      bypassed: trigger.bypassed === true,
    },
  };

  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : 'PLAN',
    type: WORKFLOW_PLANNED,
    level: 'info',
    message: `runner ${data.runner} — ${data.teammateCount} teammate(s), `
      + `trigger ${data.trigger.fired ? 'fired' : 'did not fire'}`,
    data,
  }, opts);
}
