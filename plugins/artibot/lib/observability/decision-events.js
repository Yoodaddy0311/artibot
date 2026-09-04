/**
 * Decision events — why the runtime routed a prompt the way it did.
 *
 * The third consumer of `lib/observability/run-events.js`, alongside
 * `lib/autopilot/telemetry.js` (`runtime/autopilot/`) and
 * `lib/observability/split-telemetry.js` (`runtime/split/`). It writes the same
 * line shape into `<projectRoot>/.artibot/runtime/decisions/`, so `replay.js` and
 * every other reader of that shape work here unchanged.
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
 * WHY THE T-37 PAIR LIVES HERE AND NOT IN THE LEDGER: the run ledger's
 * allowlist restricts `topology.selected` to `sources:["scheduler","supervisor"]`
 * and `context.compiled` to `sources:["worker"]`, while the emitter is a
 * UserPromptSubmit hook whose honest `source` is `hook`. Measured 2026-09-02
 * against `lib/runtime/event-writer.js#writeEvent`, both are refused with
 * `source-not-allowed:hook` AND a `ledger.rejected` line is written in their
 * place — so wiring them there would add one rejection per prompt to the ledger
 * /doctor Check 8 reads. `context.compiled` additionally delegates its whole
 * `data` to `context-receipt.schema.json`, which is `additionalProperties:false`
 * and whose required `cache.*` numbers have a single declared writer
 * (`lib/economics/usage-receipt.js`). THIS module decides the destination
 * (`getDecisionStoreDir`); `topology-router.js#routeTopology`'s OBSERVE STAGE
 * note independently expects the same one, so the two agree rather than one
 * deriving from the other. Tripwire on that decision:
 * `tests/hooks/runtime-prompt-memory-instrumentation.test.js`.
 *
 * Public surface:
 *   - ROUTING_CLASSIFIED / WORKFLOW_PLANNED   (the two `type` values written)
 *   - TOPOLOGY_RECOMMENDED / MEMORY_INJECTION_MEASURED  (the T-37 pair)
 *   - getDecisionStoreDir({ storeDir, projectRoot, cwd })
 *   - getDecisionEventsPath(runId, { storeDir, projectRoot, cwd })
 *   - readDecisionEvents(runId, { storeDir, projectRoot, cwd, tail, level })
 *   - resolveDecisionRunId(source)
 *   - recordRoutingDecision(runId, classification, { storeDir, projectRoot, cwd, ts, phase })
 *   - recordWorkflowPlanDecision(runId, plan, { storeDir, projectRoot, cwd, ts, phase })
 *   - recordTopologyRecommended(runId, observation, { storeDir, projectRoot, cwd, ts, phase })
 *   - measureMemoryInjection(prepared)  (pure parser for the above)
 *   - recordMemoryInjection(runId, measurement, { storeDir, projectRoot, cwd, ts, phase })
 *   - recordSelfControlDecision(runId, decision, { storeDir, projectRoot, cwd, ts, phase })  (D9)
 *   - recordSkillLevelChanged(runId, change, { storeDir, projectRoot, cwd, ts, phase })         (D9)
 *   - cronRunId(feature, { env, now })  (run id for the scheduler writers above)
 *   - DECISION_EVENT_TYPES / SELF_CONTROL_SUBSYSTEMS / SELF_CONTROL_ACTIONS / SKILL_LEVELS
 *     (the fail-closed vocabularies `record` and the two D9 recorders admit)
 *   - isAllowedDecisionType(type)  (the predicate `record` refuses on)
 *   - getDecisionRecorderStats() / resetDecisionRecorderStats()
 *
 * DATA POLICY: 100% local file; no external transmission.
 *
 * @module lib/observability/decision-events
 */

import path from 'node:path';
import { redactString } from '../core/redaction.js';
import { resolveProjectRoot } from '../git/project-root.js';
import { appendRunEvent, readRunEvents, resolveRunEventsPath } from './run-events.js';

/** Store path relative to <projectRoot>. See {@link getDecisionStoreDir}. */
const DECISIONS_REL = Object.freeze(['.artibot', 'runtime', 'decisions']);

export const ROUTING_CLASSIFIED = 'routing-classified';
export const WORKFLOW_PLANNED = 'workflow-planned';

/**
 * T-37 topology sighting. The name is not invented here: it is the one
 * `topology-router.js#routeTopology`'s OBSERVE STAGE note already uses for this
 * record. Deliberately `recommended`, not `selected` — the router selects
 * nothing.
 */
export const TOPOLOGY_RECOMMENDED = 'topology-recommended';

/** T-37 memory-injection measurement. */
export const MEMORY_INJECTION_MEASURED = 'memory-injection-measured';

/** End-of-process dump of this module's own `stats`. See `flushRecorderStats`. */
export const RECORDER_STATS = 'recorder-stats';

/**
 * D9 — the two vocabularies that took over from `lib/core/decision-trail.js`
 * when the trail was frozen (2026-09-05, `DESIGN-TRAIL-migration-projectRoot.md`
 * §2 C, owner rulings TR-1..3). The trail had five unique writers left:
 * `lib/core/user-profile.js` (skill-level promotion) and the four
 * `scripts/cron/` self-control runners. Two event types, not five, because the
 * four runners record ONE kind of fact — "the scheduler decided X about Y" — and
 * differ only in `subsystem`, which is a field of that fact, not a type of its
 * own. The subsystem list is the closed set below; a fifth runner is red until
 * it is registered here (verification-discipline §8: allowlist, never denylist).
 *
 * WHY THESE ARE ALLOWLISTS AND NOT SHAPES. `ARTIBOT-5.0-DESIGN.md` `:645` fixes
 * the rule for this store: "두 번째 writer 가 생기면 fail-closed allowlist". The
 * trail accepted any `subsystem`/`action` string, which is how a test fixture
 * named `probe-b` once landed in the live file. Here an unknown type,
 * subsystem, action or level is REFUSED and counted as `failed` with a
 * `*-not-allowed:<value>` `lastError`, so the refusal is visible in
 * `flushRecorderStats` rather than silently absorbed.
 */
export const SELF_CONTROL_DECIDED = 'self-control-decided';
export const SKILL_LEVEL_CHANGED = 'skill-level-changed';

/**
 * Every `type` this store admits, and the ONLY ones. `record` refuses the rest.
 * `tests/observability/decision-events.test.js` scans this module's source and
 * asserts that every `type:` literal written here is a member, so a recorder
 * added without registering its type goes red before it can write.
 */
export const DECISION_EVENT_TYPES = Object.freeze([
  ROUTING_CLASSIFIED,
  WORKFLOW_PLANNED,
  TOPOLOGY_RECOMMENDED,
  MEMORY_INJECTION_MEASURED,
  RECORDER_STATS,
  SELF_CONTROL_DECIDED,
  SKILL_LEVEL_CHANGED,
]);

/**
 * Is `type` one this store admits? The single predicate `record` consults, so a
 * test can prove the gate is live without reaching the private `record`.
 * @param {unknown} type
 * @returns {boolean}
 */
export function isAllowedDecisionType(type) {
  return typeof type === 'string' && DECISION_EVENT_TYPES.includes(type);
}

/**
 * `data.subsystem` values `recordSelfControlDecision` admits — one per
 * `scripts/cron/` runner, spelled exactly as each runner names itself.
 * Measured 2026-09-05 (`grep -n "subsystem:" scripts/cron/*.js`): four
 * spellings, four files.
 */
export const SELF_CONTROL_SUBSYSTEMS = Object.freeze([
  'auto-cleanup',
  'auto-commit',
  'auto-macro-register',
  'auto-pr-creator',
]);

/**
 * `data.action` values `recordSelfControlDecision` admits. The union of every
 * `action:` literal the four runners write, measured the same way and the same
 * day; sorted so a diff of this list is a diff of the vocabulary.
 */
export const SELF_CONTROL_ACTIONS = Object.freeze([
  'applied',
  'committed',
  'created',
  'dry-run',
  'failed',
  'refused',
  'registered',
  'rejected',
  'rolled-back',
  'swept',
  'would-cleanup',
  'would-commit',
  'would-create',
]);

/** The two skill levels `lib/core/user-profile.js#classify` can return. */
export const SKILL_LEVELS = Object.freeze(['novice', 'pro']);

/**
 * Run-id prefix for scheduler runs (`cronRunId`). `/doctor` Check 7 counts
 * files under this prefix SEPARATELY from session files: a cron file proves the
 * scheduler ran, not that the per-prompt hook path is alive, and folding the two
 * together would let a nightly job silence the S5 "never recorded" row.
 */
export const CRON_RUN_ID_PREFIX = 'cron-';

/**
 * Historical run id for stats that could not be attributed to a session.
 *
 * NO LONGER WRITTEN. Until 2026-09-04 `flushRecorderStats` filed its
 * end-of-process line under this id whenever there was no session, so every
 * session-less prompt appended to a `_unattributed.events.ndjson` in the live
 * store (measured in the parent repo's `.artibot/runtime/decisions/`,
 * 2026-09-04: 1 of the 3 files there). A file whose entire content is "there
 * was no session" reads, to anything counting files in that directory, as
 * "recording is alive" — the false-health failure this module's header argues
 * against for swallowed errors. 후속 12 안 B replaced the write with a single
 * stderr line; see {@link flushRecorderStats}.
 *
 * The name stays exported so a reader of the store can recognise files left by
 * builds from before 2026-09-04. As of 2026-09-04 no consumer in `lib/`,
 * `scripts/` or `commands/` references it (grep: tests only) — `/doctor`
 * Check 7 does not mention the file; whether it should is a separate decision.
 * Nothing in `lib/` writes it any more.
 */
export const UNATTRIBUTED_RUN_ID = '_unattributed';

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
 * Resolve the directory decision events live in.
 *
 * `<projectRoot>/.artibot/runtime/decisions/`, matching the ledger's rule
 * (design §3.3/§3.6: per-project local artifacts hang off the PROJECT root, and
 * `.artibot/` is load-bearing because pluginRoot also has a `runtime/`).
 *
 * WHY NOT `<pluginRoot>/runtime/decisions/`, which this was until 2026-09-03:
 * the plugin root is the marketplace mirror, and `claude plugin update`
 * REPLACES that directory. Every KPI this store feeds — /doctor Check 7's
 * "has anything ever been recorded", the Observe coverage denominator — is a
 * count over its history, so an update would silently reset the denominator to
 * zero and the reset would read as "recording is fine, this root is just new".
 * A store whose disappearance is indistinguishable from health is the failure
 * this module's header already argues against for swallowed errors.
 *
 * Resolution order: an explicit `storeDir` (tests, which point at `os.tmpdir()`
 * and never touch a real store) -> an injected `projectRoot` -> the root
 * resolved from `cwd`. The last step goes through
 * `lib/git/project-root.js#resolveProjectRoot` rather than using `cwd`
 * directly: a hook payload's `cwd` follows the shell, so anchoring on it splits
 * one project's store across every directory the session `cd`s into. That
 * helper always returns a path and never throws, which keeps this function
 * total — an observe-only recorder must not acquire a failure mode.
 *
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string }} [opts]
 * @returns {string}
 */
export function getDecisionStoreDir(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (typeof o.storeDir === 'string' && o.storeDir) return o.storeDir;
  const root = typeof o.projectRoot === 'string' && o.projectRoot
    ? o.projectRoot
    : resolveProjectRoot(typeof o.cwd === 'string' && o.cwd ? o.cwd : undefined);
  return path.join(root, ...DECISIONS_REL);
}

/**
 * @param {string} runId
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string }} [opts]
 * @returns {string}
 */
export function getDecisionEventsPath(runId, opts = {}) {
  return resolveRunEventsPath(getDecisionStoreDir(opts), runId);
}

/**
 * @param {string} runId
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string, tail?: number, level?: 'info'|'warn'|'error' }} [opts]
 * @returns {object[]}
 */
export function readDecisionEvents(runId, opts = {}) {
  return readRunEvents(getDecisionStoreDir(opts), runId, opts);
}

/**
 * Reduce an id to characters that cannot leave the store directory. A session
 * id reaches us from the hook payload — outside input — and it becomes a file
 * name, so `../` in it would write outside the decisions store.
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
 * suites wrote 10 fixture lines into the real decisions store, mixing test
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
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string }} opts
 * @returns {object|null} the persisted event, or null when nothing was written
 */
function record(runId, event, opts) {
  // Fail-closed on the vocabulary BEFORE touching the filesystem: a type this
  // module never registered must not reach disk, and the refusal is counted so
  // it shows up in `flushRecorderStats` instead of vanishing.
  const type = event && typeof event === 'object' ? event.type : undefined;
  if (!isAllowedDecisionType(type)) {
    stats.failed += 1;
    stats.lastError = `type-not-allowed:${String(type)}`;
    return null;
  }
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
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string, ts?: string, phase?: string }} [opts]
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
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string, ts?: string, phase?: string }} [opts]
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

/**
 * Longest string accepted into a topology reason list. Larger than
 * MAX_REASON_LENGTH because the provenance differs: topology reasons are fixed
 * pattern ids plus JSON.stringify'd CONFIG values
 * (`policy:split.maxWindows=4(observe-only)`), never text generated from a
 * prompt. A size bound, not a privacy bound — the privacy property is that
 * `topology-router.js` puts no prompt text in `reason[]` at all, returning
 * pattern IDS from fixed tables (`topology-router.js#FAST_PATTERNS` and
 * `#SPLIT_PATTERNS`, matched by `#firstMatch`, which returns `pattern.id` and
 * never the matched text). Cited by SYMBOL, not line range: the range this
 * comment first carried went stale within a day as that file grew.
 */
const MAX_TOPOLOGY_REASON_LENGTH = 120;

/**
 * Keep only short strings, by the same rule as `reasonLiteralsOnly` but at the
 * topology bound.
 * @param {unknown[]} arr
 * @returns {string[]}
 */
function topologyLiteralsOnly(arr) {
  return arr.filter(
    (r) => typeof r === 'string' && r.length > 0 && r.length <= MAX_TOPOLOGY_REASON_LENGTH,
  );
}

/**
 * Keep only finite numbers and booleans. `parallelGain` is a score breakdown
 * whose key set grows as terms are added, so a name allowlist would silently
 * drop new terms; filtering by value type keeps the container open while making
 * a string impossible — the same trade `numericValuesOnly` makes for `factors`.
 * @param {object} src
 * @returns {object}
 */
function scalarValuesOnly(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

/**
 * T-37 — record the topology sighting. OBSERVE ONLY: `routeTopology` selects
 * nothing (its own header states BEHAVIOR CHANGE = 0) and no execution path
 * reads `mode`. The live caller is `scripts/hooks/runtime-prompt.js`, after the
 * hook's output object is already final.
 *
 * `humanGateHits` is stored under `advisory:true`. The hook-layer gate verdict
 * belongs to `lib/security/human-gates.js#classify`; the router's hits are a
 * text match and must never be read as a decision.
 *
 * @param {string} runId
 * @param {object} observation - a `routeTopology` result
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string, ts?: string, phase?: string }} [opts]
 * @returns {object|null}
 */
export function recordTopologyRecommended(runId, observation, opts = {}) {
  if (!runId || typeof runId !== 'string') {
    stats.skipped += 1;
    return null;
  }
  const o = observation && typeof observation === 'object' ? observation : {};
  const gain = o.parallelGain && typeof o.parallelGain === 'object' ? o.parallelGain : {};

  const data = {
    observe_only: true,
    mode: typeof o.mode === 'string' ? o.mode : null,
    exception: typeof o.exception === 'string' ? o.exception : null,
    confidence: typeof o.confidence === 'number' ? o.confidence : null,
    reason: Array.isArray(o.reason) ? topologyLiteralsOnly(o.reason) : [],
    parallelGain: scalarValuesOnly(gain),
    parallelGainMeasured: scalarValuesOnly(gain.measured),
    humanGateHits: {
      advisory: true,
      hits: Array.isArray(o.humanGateHits) ? topologyLiteralsOnly(o.humanGateHits) : [],
    },
  };

  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : 'ROUTE',
    type: TOPOLOGY_RECOMMENDED,
    level: 'info',
    message: `topology ${data.mode} (observe-only, routed nothing)`,
    data,
  }, opts);
}

/** Exact string `lib/runtime/middleware/memory.js:116` prepends. Extraction anchor. */
export const MEMORY_BLOCK_HEAD = '\n\nRelevant memory context:\n- ';

/**
 * Measure the memory block the runtime pipeline injected into a prompt.
 *
 * MEASURE ONLY. Nothing here changes whether memory is injected, how much is
 * injected, or the `enabled` default at `runtime-prompt.js`
 * #getMiddlewareOptionsFromEnv — design §8.6's default-value question (G2) is
 * deliberately untouched.
 *
 * Measured from the PRODUCED prompt rather than recomputed from
 * `context.memory.relevant`: the injected text is the middleware's own
 * `toSummaryLines` output (JSON.stringify sliced to 140 chars), so rebuilding it
 * here would fork that transform and could report a size the model never saw.
 *
 * The block is bounded by the next blank line, not by end-of-string, because
 * `guardrail.js`, `subagents.js` and `tasks.js` each append their own block
 * after `memory.js` in the same pipeline — taking the tail would silently
 * attribute their bytes to memory.
 *
 * Pure string work, no I/O, so it lives beside the recorder that persists it
 * rather than in the hook that calls both.
 *
 * @param {object|null|undefined} prepared - a `preparePrompt` envelope.
 * @returns {{injected: boolean, items: number, bytes: number,
 *   approx_tokens_chars_div4: number, hit_count: number|null,
 *   working_hits: number|null, enabled: boolean|null, measured_by: string}}
 */
export function measureMemoryInjection(prepared) {
  const mem = prepared?.context?.memory;
  const base = {
    injected: false,
    items: 0,
    bytes: 0,
    // chars/4 is an APPROXIMATION, not a tokenizer count. The divisor is named
    // in the key so a reader cannot mistake this for a measured token total.
    approx_tokens_chars_div4: 0,
    hit_count: typeof mem?.hitCount === 'number' ? mem.hitCount : null,
    working_hits: typeof mem?.workingHits === 'number' ? mem.workingHits : null,
    enabled: typeof mem?.enabled === 'boolean' ? mem.enabled : null,
    measured_by: 'prompt-marker-extraction',
  };

  const text = prepared?.userPrompt;
  if (typeof text !== 'string' || text.length === 0) return base;
  const start = text.lastIndexOf(MEMORY_BLOCK_HEAD);
  if (start < 0) return base;

  const rest = text.slice(start + MEMORY_BLOCK_HEAD.length);
  const end = rest.indexOf('\n\n');
  const body = end === -1 ? rest : rest.slice(0, end);
  const block = MEMORY_BLOCK_HEAD + body;

  return {
    ...base,
    injected: true,
    items: body.split('\n- ').length,
    bytes: Buffer.byteLength(block, 'utf-8'),
    approx_tokens_chars_div4: Math.ceil(block.length / 4),
  };
}

/**
 * T-37 — record how much memory the runtime injected into the prompt.
 * INSTRUMENTATION ONLY: the injection itself is unchanged.
 *
 * Takes a `measureMemoryInjection` result rather than measuring internally, so
 * the parser stays unit-testable on synthetic envelopes. Named fields are
 * copied, never spread — the measurement is derived from prompt text, so an
 * upstream field added later must not ride along by default.
 *
 * @param {string} runId
 * @param {object} measurement - a `measureMemoryInjection` result
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string, ts?: string, phase?: string }} [opts]
 * @returns {object|null}
 */
export function recordMemoryInjection(runId, measurement, opts = {}) {
  if (!runId || typeof runId !== 'string') {
    stats.skipped += 1;
    return null;
  }
  const m = measurement && typeof measurement === 'object' ? measurement : {};
  const data = {
    ...pick(m, [
      'injected', 'items', 'bytes',
      // chars/4 is an APPROXIMATION, not a tokenizer count. The divisor stays in
      // the key name so no reader mistakes it for a measured token total.
      'approx_tokens_chars_div4',
      'hit_count', 'working_hits', 'enabled', 'measured_by',
    ]),
  };

  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : 'CONTEXT',
    type: MEMORY_INJECTION_MEASURED,
    level: 'info',
    message: data.injected
      ? `memory injected — ${data.items} item(s), ${data.bytes}B, `
        + `~${data.approx_tokens_chars_div4} tok (chars/4)`
      : 'memory not injected',
    data,
  }, opts);
}

/**
 * Test seam for the vocabulary gate — NOT a public contract. Every public
 * recorder hard-codes an allowlisted `type`, so nothing outside this module
 * can hand `record` a bad one; without this seam the gate was provable only
 * by reading source text, and a mutation test (2026-09-05, M2) showed that
 * `if (false && …)` left every test green. Same `_` convention as
 * `decision-trail.js#_resetDecisionTrailCache`.
 *
 * @param {string} runId
 * @param {object} event
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string }} [opts]
 * @returns {object|null}
 */
export function _recordForTest(runId, event, opts = {}) {
  return record(runId, event, opts);
}

/** Longest free-text `reason` a D9 recorder keeps. Bound, then redacted. */
const MAX_DECISION_REASON_LENGTH = 200;

/** Longest string kept inside a D9 `inputs` / `outputs` bag. */
const MAX_DECISION_VALUE_LENGTH = 200;

/** Most array items kept inside a D9 `inputs` / `outputs` bag. */
const MAX_DECISION_LIST_ITEMS = 50;

/**
 * Keep only bounded scalars, one level deep. The trail accepted arbitrary
 * `inputs` / `outputs` objects and redacted them recursively; here the container
 * is kept OPEN (the runners legitimately add keys) but its VALUES are typed:
 * finite numbers, booleans, null, redacted strings up to
 * `MAX_DECISION_VALUE_LENGTH`, and arrays of those up to
 * `MAX_DECISION_LIST_ITEMS`. Nested objects and functions are dropped — the same
 * trade `numericValuesOnly` makes for `factors`, widened to the scalar set the
 * cron runners actually write (file paths, a branch name, a PR url, a sha).
 *
 * @param {unknown} src
 * @returns {object|null} a fresh object, or null when `src` is not an object
 */
function boundedScalars(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const scalar = (v) => {
    if (v === null) return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string') return redactString(v).slice(0, MAX_DECISION_VALUE_LENGTH);
    return undefined;
  };
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (Array.isArray(v)) {
      out[k] = v.slice(0, MAX_DECISION_LIST_ITEMS).map(scalar).filter((x) => x !== undefined);
      continue;
    }
    const s = scalar(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/**
 * Refuse one D9 record on vocabulary grounds, counting it like a failed write.
 * @param {string} what - `subsystem` | `action` | `skill-level`
 * @param {unknown} value
 * @returns {null}
 */
function refuse(what, value) {
  stats.failed += 1;
  stats.lastError = `${what}-not-allowed:${String(value)}`;
  return null;
}

/**
 * D9 — record one self-control decision from a `scripts/cron/` runner.
 *
 * Replaces the trail call `({ subsystem, action, reason, inputs, outputs })` for
 * the four runners, with the same call shape minus the trail's open vocabulary:
 * `subsystem` must be in {@link SELF_CONTROL_SUBSYSTEMS} and `action` in
 * {@link SELF_CONTROL_ACTIONS}, or the record is refused and counted.
 *
 * NO SESSION, NO FILE — same rule as every recorder here. A runner has no hook
 * session; it passes the run id `cronRunId` mints for it, and a runner that
 * passes none is counted as `skipped`, never bucketed. This is design §2 C's
 * stated side-effect (1), accepted because 후속 12 안 B already made a
 * session-less flush go to stderr instead of disk.
 *
 * WHERE THE FILE LANDS. `opts.cwd` is the runner's `pluginRoot`, and
 * `getDecisionStoreDir` resolves it through `resolveProjectRoot`: under a git
 * checkout that is the repo root (`<repo>/.artibot/runtime/decisions/`); under
 * a root with no `.git` ancestor — the marketplace cache — the weak-marker
 * walk stops at the plugin tree itself, i.e. INSIDE the directory `plugin
 * update` replaces. Measured 2026-09-05 (cross-review): `getDecisionStoreDir({
 * cwd: ~/.claude/plugins/cache/artibot/artibot/4.54.0 })` → `…/4.54.0/
 * .artibot/runtime/decisions`. Reach is nil today (the runners use
 * `pluginRoot` as their git working directory, so a cache root was never a
 * supported host; the only caller is `.github/workflows/self-control.yml`),
 * but it is the same loss class D9 exists to close and is stated here rather
 * than left to be rediscovered.
 *
 * @param {string|null} runId - `cronRunId(...)` from the runner's CLI entry
 * @param {{subsystem: string, action: string, reason?: string, inputs?: object,
 *   outputs?: object}} decision
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string, ts?: string, phase?: string }} [opts]
 * @returns {object|null}
 */
export function recordSelfControlDecision(runId, decision, opts = {}) {
  if (!runId || typeof runId !== 'string') {
    stats.skipped += 1;
    return null;
  }
  const d = decision && typeof decision === 'object' ? decision : {};
  if (!SELF_CONTROL_SUBSYSTEMS.includes(d.subsystem)) return refuse('subsystem', d.subsystem);
  if (!SELF_CONTROL_ACTIONS.includes(d.action)) return refuse('action', d.action);

  const data = {
    subsystem: d.subsystem,
    action: d.action,
    reason: typeof d.reason === 'string' && d.reason.length > 0
      ? redactString(d.reason).slice(0, MAX_DECISION_REASON_LENGTH)
      : null,
    inputs: boundedScalars(d.inputs),
    outputs: boundedScalars(d.outputs),
  };

  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : 'SELF_CONTROL',
    type: SELF_CONTROL_DECIDED,
    level: d.action === 'failed' ? 'warn' : 'info',
    message: `${d.subsystem} ${d.action}${data.reason ? ` — ${data.reason}` : ''}`,
    data,
  }, opts);
}

/**
 * D9 — record a skill-level transition detected by `lib/core/user-profile.js`.
 *
 * `user-profile.js` is L1 and may not import this module (eslint L1 block), so
 * it never calls this directly: `recordSignal` accepts a `recordChange` PORT and
 * the hook (`scripts/hooks/runtime-prompt.js#recordPromptSignals`) binds this
 * function to the session's run id and store. `evidence` is `classify`'s own
 * generated metric strings (`slash-ratio=0.80`), never a prompt; it is still
 * filtered to short strings so a future change to `classify` cannot leak text.
 *
 * @param {string|null} runId
 * @param {{from: string, to: string, signals?: number, evidence?: string[]}} change
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string, ts?: string, phase?: string }} [opts]
 * @returns {object|null}
 */
export function recordSkillLevelChanged(runId, change, opts = {}) {
  if (!runId || typeof runId !== 'string') {
    stats.skipped += 1;
    return null;
  }
  const c = change && typeof change === 'object' ? change : {};
  if (!SKILL_LEVELS.includes(c.from) || !SKILL_LEVELS.includes(c.to)) {
    return refuse('skill-level', `${String(c.from)}->${String(c.to)}`);
  }
  const data = {
    from: c.from,
    to: c.to,
    signals: Number.isInteger(c.signals) && c.signals >= 0 ? c.signals : null,
    evidence: Array.isArray(c.evidence) ? reasonLiteralsOnly(c.evidence) : [],
  };
  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : 'PROFILE',
    type: SKILL_LEVEL_CHANGED,
    level: 'info',
    message: `skill level ${data.from} -> ${data.to}`
      + (data.signals === null ? '' : ` (${data.signals} signals)`),
    data,
  }, opts);
}

/**
 * Mint the run id a scheduler run records under.
 *
 * `cron-<feature>-<stamp>`, where the stamp is `gha<GITHUB_RUN_ID>` under
 * GitHub Actions (stable across a re-run of the same job) and a compact UTC
 * timestamp `YYYYMMDD-HHMMSS` elsewhere. One file per run, which is what this
 * store already means by a run id (`run-events.js`: "file-granular, one file
 * per run id"). The prefix is {@link CRON_RUN_ID_PREFIX} so a reader can tell a
 * scheduler file from a session file without opening it.
 *
 * `feature` is reduced to `[A-Za-z0-9_-]` because it becomes part of a file
 * name — the same reason `sanitizeRunId` exists for session ids.
 *
 * @param {string} feature - runner name, e.g. `auto-commit`
 * @param {{ env?: NodeJS.ProcessEnv, now?: Date }} [opts] - injectable for tests
 * @returns {string}
 */
export function cronRunId(feature, opts = {}) {
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const now = opts.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
  const name = String(feature ?? 'cron').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'cron';
  const gha = typeof env.GITHUB_RUN_ID === 'string' && /^\d{1,20}$/.test(env.GITHUB_RUN_ID)
    ? `gha${env.GITHUB_RUN_ID}`
    : now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  return `${CRON_RUN_ID_PREFIX}${name}-${gha}`;
}

/**
 * Write this module's own `stats` into the store, so a drop is READABLE rather
 * than merely counted.
 *
 * WHY THIS EXISTS. `stats` lives in a module object inside a process that dies
 * at the end of every prompt, and outside tests nothing ever read it — so
 * `skipped` and `failed` were counted and then thrown away. That is the exact
 * failure this module's header (see "OBSERVE-ONLY") claims to have fixed: an
 * error nobody can count is indistinguishable from "there was nothing to
 * record". Counting it in memory that no one reads is the same thing one step
 * removed. The counters only become evidence once they reach the store the
 * reader already looks at.
 *
 * Writes NOTHING when both counters are zero, so a healthy prompt adds no line
 * and the store stays quiet enough that a line means something.
 *
 * `level` separates the two diagnoses the counters deliberately keep apart:
 * `failed` (a write broke) is a `warn`; `skipped` alone (nothing to attribute
 * it to) is routine `info` — a prompt with no session id is normal, not a
 * fault.
 *
 * The snapshot is taken BEFORE the write, so the line reports the state that
 * preceded it and never counts itself.
 *
 * NO SESSION MEANS NO FILE, since 2026-09-04 (후속 12 안 B). Filing the line
 * under {@link UNATTRIBUTED_RUN_ID} made the ABSENCE of a session look like
 * activity to every reader that counts files in the store. The counters are
 * still reported when there is no session, as ONE stderr line carrying nothing
 * but the two counts — visible where a session-less prompt actually runs (a
 * terminal), invisible to anything that measures the store.
 *
 * @param {string|null|undefined} runId session to attribute the stats to. When
 *   it is not a non-empty string nothing is persisted: the counts go to stderr
 *   instead and the return is null.
 * @param {{ storeDir?: string, projectRoot?: string, cwd?: string, ts?: string, phase?: string }} [opts]
 * @returns {object|null} the persisted event, or null when there was nothing to
 *   report, when there was no session, or when the write failed (which is itself
 *   counted, see the caveat).
 */
export function flushRecorderStats(runId, opts = {}) {
  const snapshot = { ...stats };
  if (snapshot.skipped === 0 && snapshot.failed === 0) return null;

  const attributed = typeof runId === 'string' && runId.length > 0 ? runId : null;
  if (!attributed) {
    // 안 B (2026-09-04): no session → nothing on disk. One diagnostic line; no
    // values, prompt text, or paths — counts only.
    try {
      process.stderr.write(
        '[artibot:decision-events] recorder stats unattributed — '
        + `${snapshot.skipped} skipped, ${snapshot.failed} failed `
        + '(no session id; not persisted)\n',
      );
    } catch { /* observe-only: a failed diagnostic must not become a failure mode */ }
    return null;
  }

  const data = {
    skipped: snapshot.skipped,
    failed: snapshot.failed,
    lastError: snapshot.lastError,
  };
  data.runId = attributed;

  return record(attributed, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : 'END',
    type: RECORDER_STATS,
    level: snapshot.failed > 0 ? 'warn' : 'info',
    message: `recorder stats — ${snapshot.skipped} skipped, ${snapshot.failed} failed`,
    data,
  }, opts);
}
