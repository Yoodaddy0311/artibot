/**
 * Runtime task middleware.
 * Builds a task envelope for downstream hook/team integrations.
 *
 * FIELD PLACEMENT (T-25 deviation, reported deliberately): the task brief names
 * `task.meta.missionContract`. That location is not implementable while the
 * existing suite stays unmodified — in `tests/runtime/middleware/tasks.test.js`,
 * the case "propagates shift + reason from current-effort.json into task.meta"
 * asserts `toEqual` on the WHOLE of `task.meta` (an exact five-key object) and
 * "omits task.meta entirely when no effort file exists" asserts it is
 * `undefined`. Adding
 * any key to `task.meta`, or creating `task.meta` to hold one, fails one of
 * those two. The brief also requires the pre-existing return shape to be
 * byte-identical before and after this wiring, which the same two assertions
 * are the mechanical statement of. The mission record therefore lands on
 * `task.mission`, a purely additive sibling: `task.meta` is untouched, both
 * assertions stay green, and no existing field changes meaning.
 *
 * @module lib/runtime/middleware/tasks
 */

import path from 'node:path';
import { readJsonFileSync } from '../../core/file.js';
import { isTeamEnabled } from '../../cognitive/workflow-plan.js';
import { compileMission } from '../../mission/compiler.js';
import { composeControllerMutator } from '../../mission/controller.js';
import { readEffortRecord } from '../task-budget.js';
import { appendLedgerEvent } from '../ledger.js';
import { createStateStore } from '../../project-state/state-manager.js';
import { resolveGitCommonDir } from '../../project-state/git-common-dir.js';
import { extractUserPromptFlagSurface, NO_TEAM_FLAG } from '../../core/hook-utils.js';
import { planWorkflow, readFollowWorkflowPlan, recordWorkflow, resolveWorkflowMode } from './workflow-mode.js';
import {
  appendMissionEvent, missionIntentRevision, missionTitle, resolveMissionIdentity,
} from './mission-ledger.js';
import { appendQuestionGateEvent, buildQuestionGateData } from '../question-gate-record.js';

function makeTaskId(nowFn) {
  const now = nowFn();
  return `rt-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Load the most recent effort + task-budget meta written by runtime-prompt.js.
 * Returns null when the effort file is missing or unreadable — downstream code
 * must treat effort/budget as optional.
 *
 * F05: the file read is delegated to `task-budget.js#readEffortRecord`, which
 * applies the identity + expiry gate — a record left by ANOTHER session or by an
 * OLDER prompt is refused rather than propagated into this task. Records written
 * before F05 carry no identity and are honoured unchanged. The five-key mapping
 * below is deliberately not extended (see this module's header).
 *
 * `nowMs` is the MIDDLEWARE's clock, not `Date.now()`: this middleware already
 * takes an injected `now` for the task id and `createdAt`, and an expiry judged
 * on wall-clock while everything else runs on a fixed clock is untestable — a
 * fixture record would be expired or fresh depending on when the suite ran.
 *
 * @param {string|undefined} pluginRoot
 * @param {{ sessionId?: string|null, promptId?: string|null }} [identity]
 * @param {number} [nowMs] - epoch ms; omitted means the reader uses `Date.now()`.
 * @returns {{ effort: string|null, taskBudget: number|null, command: string|null }|null}
 */
function readEffortMeta(pluginRoot, identity = {}, nowMs = undefined) {
  if (!pluginRoot) return null;
  const runtimeDir = path.join(pluginRoot, 'runtime');
  const effortRaw = readEffortRecord(pluginRoot, {
    sessionId: identity.sessionId ?? null,
    promptId: identity.promptId ?? null,
    now: nowMs,
  });
  if (!effortRaw) return null;

  const meta = {
    effort: effortRaw.effort || null,
    command: effortRaw.command || null,
    taskBudget: null,
    shift: typeof effortRaw.shift === 'number' ? effortRaw.shift : null,
    reason: effortRaw.reason || null,
  };

  const budgetRaw = readJsonFileSync(path.join(runtimeDir, 'current-task-budget.json'));
  if (budgetRaw && typeof budgetRaw.budget === 'number' && budgetRaw.budget > 0) {
    meta.taskBudget = budgetRaw.budget;
  }

  return meta;
}

// ---------------------------------------------------------------------------
// Mission compile (T-25) + the paired StateStore write
//
// `compileMission()` runs for EVERY prompt. It deliberately does NOT inherit
// the `mode === 'agentTeam'` condition that gates `buildWorkflowPlan` below:
// that condition excludes every system1 prompt, and a compiler that skips
// system1 has no Observe denominator (design §3.5; compiler.js module header).
// system1 receives the REDUCED contract instead.
//
// WHAT THIS BLOCK WRITES — the old claim is RETIRED, not softened. This header
// used to read "No file under `.artibot/**` is created by this block other than
// the ledger's own append". That sentence is now false, so it is replaced
// rather than qualified: a stale exemption is worse than no exemption, because
// the next reader takes it as permission. A substantive prompt now touches
// three paths, not one:
//
//   <projectRoot>/.artibot/runtime/ledger.jsonl          the append (history)
//   <git-common-dir>/artibot/project-state.{json,jsonl}  the store  (now)
//   <projectRoot>/.artibot/state.yaml                    the projection (view)
//
// The append itself lives in `mission-ledger.js` (split out 2026-09-23 for the
// 800-line file ceiling); this block composes it with the store write.
//
// The store sits under the GIT COMMON DIR, never under a worktree's own
// `.artibot/` — decision F3, restated at length in
// `lib/project-state/state-manager.js`'s module header: every linked worktree
// shares one common dir, and a per-worktree store is the measured failure the
// design rejects, where each `/split` window keeps its own divergent copy.
//
// `state.yaml` is a PROJECTION, and the leader's ruling is that it sits OUTSIDE
// the zero-artifact rule (ADDENDUM-HARDENING §1.1). It is regenerated from the
// store after every commit and is never read back as truth, so deleting it
// loses nothing — which is precisely what makes it not an artifact. The store
// and the ledger are the two records; this file is a view of one of them.
//
// Behavior is still unchanged for the caller. A compile failure, a refused
// append and a refused store write are all swallowed into status fields: the
// prompt has to survive its own bookkeeping (intent.md is still T-40's).
// ---------------------------------------------------------------------------

/**
 * `reason` recorded on the `state.updated` event this write emits.
 *
 * Deliberately the NAME OF THE PAIRED EVENT rather than a prose description:
 * `/doctor` Check 8 matches store writes to `mission.created` appends, and a
 * reader who has only the `state.updated` line needs to know which event it was
 * paired with, not how the author felt about it.
 */
const MISSION_STORE_REASON = 'mission.created';

/**
 * The `task.mission.store` value for a prompt that wrote nothing.
 *
 * A FACTORY, not a frozen constant: the shape carries a mutable `warnings`
 * array, and a shared literal would let one caller's push be observed by every
 * later prompt in the process.
 *
 * The field is ALWAYS present, on every branch, including compile failure. An
 * absent key and a key reading `skipped` are different claims — the first says
 * "this middleware does not do stores", which stopped being true — and a census
 * over the envelope cannot count what is not there.
 *
 * `controller_observation` is `null` here for the same reason: no mutator ran,
 * so no judgement was made. That is not the same claim as a judgement that
 * found nothing, and a census over the envelope must be able to tell them apart.
 *
 * @param {string} detail why nothing was written
 * @returns {object} the skipped store record
 */
function skippedMissionStore(detail) {
  return {
    status: 'skipped',
    detail,
    state_version: null,
    mission_id: null,
    location: null,
    controller_observation: null,
    warnings: [],
  };
}

/**
 * Reduce a `updateMission` commit result to the reported store record.
 *
 * `conflict` is kept DISTINCT from `rejected` even though both are `ok:false`.
 * A conflict means someone else won a race and this write can simply be retried;
 * a rejection means the draft was invalid and retrying it forever would not
 * help. Folding them together would make a permanent defect look like noise.
 *
 * `observation` is REPORTED, never acted on (OB-10 follow-up a). It is the one
 * thing the controller composition knows that the row alone does not say: that
 * the recorded controller is somebody ELSE's live claim rather than this
 * session's. Carrying it costs no write — it is read off the mutator that the
 * commit already ran.
 *
 * @param {object} commit `updateMission()` result
 * @param {string} missionId the mission the write was for
 * @param {string} location `store.location.source`
 * @param {string|null} observation the composed mutator's last judgement, one of
 *   `lib/mission/controller.js#CONTROLLER_OBSERVATIONS`
 * @returns {object} the `task.mission.store` value
 */
function summarizeMissionCommit(commit, missionId, location, observation) {
  const warnings = Array.isArray(commit?.warnings) ? commit.warnings : [];
  if (commit?.ok) {
    return {
      status: 'written',
      detail: null,
      state_version: Number.isInteger(commit.state_version) ? commit.state_version : null,
      mission_id: missionId,
      location,
      controller_observation: observation ?? null,
      warnings,
    };
  }
  return {
    status: commit?.conflict === true ? 'conflict' : 'rejected',
    detail: Array.isArray(commit?.errors) && commit.errors.length > 0
      ? commit.errors.join('; ')
      : null,
    state_version: null,
    mission_id: missionId,
    location,
    controller_observation: observation ?? null,
    warnings,
  };
}

/**
 * The mutation applied to the mission row.
 *
 * PRESERVING, not replacing. The same session's second substantive prompt
 * arrives under the SAME fallback mission id — `sessionFallbackMissionId` is a
 * pure function of the session id and the UTC date — so this runs against a
 * mission that may already be `executing` with a controller and a plan. Only
 * `title` and `intent` are authored here; resetting `status` to `queued` would
 * walk a running mission backwards, and the store would faithfully record the
 * lie.
 *
 * EXPORTED, not private, because `scripts/hooks/intent-observe-pre.js` writes
 * the SAME row from stage ② (design §3.1) and a second copy of this mutator
 * would be a second definition of what a mission row is. The preserving
 * behaviour above is exactly what stage ② needs and is the part that a
 * duplicate would most easily get wrong.
 *
 * @param {string} missionId mission the row belongs to
 * @param {string} title from {@link missionTitle}
 * @param {number} revision from {@link missionIntentRevision}
 * @returns {(current: object|null) => object} mutator for `updateMission`
 */
export function missionMutator(missionId, title, revision) {
  return (current) => ({
    ...(current ?? {}),
    title,
    status: current?.status ?? 'queued',
    // Reference form only. `validateMission` checks `{path, revision}` and
    // deliberately does NOT check that the file exists — writing intent.md is
    // T-40's, and a store that refused a reference to a not-yet-authored file
    // could never hold a mission at all.
    intent: { path: `missions/${missionId}/intent.md`, revision },
    plan: current?.plan ?? { path: `missions/${missionId}/plan.md`, revision: 1 },
  });
}

/**
 * Raise a mission row's `plan.revision`. PRESERVING, not replacing — same
 * rationale as {@link missionMutator}: `title`, `status`, `intent`, `controller`
 * and `blocked_by` survive, because a plan write says nothing about them.
 * THE ONLY CODE THAT RAISES `plan.revision`. Before this, nothing did — measured
 * 2026-09-14: the two production `updateMission` callers ({@link
 * recordMissionState}, `intent-observe-pre.js#promote`) both pass {@link
 * missionMutator}, which only ever SEEDS `plan` at revision 1. EXPORTED for
 * `scripts/hooks/_plan-observe-record.js` rather than duplicated there: a copy
 * would be a second definition of what a mission row is.
 *
 * @param {string} missionId mission the row belongs to
 * @param {number} revision the NEW revision (`validateMission`: integer >= 1)
 * @returns {(current: object|null) => object} mutator for `updateMission`
 */
export function planRevisionMutator(missionId, revision) {
  return (current) => ({
    ...(current ?? {}),
    plan: { path: `missions/${missionId}/plan.md`, revision },
  });
}

/**
 * Open the StateStore for this prompt, with every port bound.
 *
 * EXTRACTED from {@link recordMissionState} to keep that function inside the
 * 50-line rule, and because the four ports are the part a reader most often
 * comes here to check. It opens a store and nothing else: no write, no clock
 * read, no decision.
 *
 * The clock port is `() => new Date(nowMs)` — a CONSTANT for the whole prompt,
 * not a live reading. `state-manager.js` calls it for the record `ts`, and
 * pinning it to the same instant the ledger append used is what makes the two
 * lines timestamp-comparable rather than merely close together.
 *
 * EXPORTED alongside {@link missionMutator} so stage ②
 * (`scripts/hooks/intent-observe-pre.js`) binds the SAME four ports. The
 * `source: 'hook'` and the ledger port in particular are the pairing that makes
 * a stage-② store write indistinguishable from a stage-① one in the ledger.
 *
 * @param {string} projectRoot absolute project root
 * @param {string} sessionId raw session id for the ledger envelope
 * @param {number} nowMs the single epoch-ms reading for this prompt
 * @param {{resolveGitCommonDir: (root: string) => string|null}} deps injected ports
 * @returns {object} the StateStore
 */
export function openMissionStore(projectRoot, sessionId, nowMs, deps) {
  return createStateStore({
    projectRoot,
    sessionId,
    // `state.updated` registers no `sources` restriction, and this middleware
    // runs inside the UserPromptSubmit hook pipeline, so 'hook' is the honest
    // value — not the store's 'supervisor' default, which names a process
    // that is not running.
    source: 'hook',
    now: () => new Date(nowMs),
    appendEvent: (envelope) => appendLedgerEvent(projectRoot, envelope),
    resolveGitCommonDir: () => deps.resolveGitCommonDir(projectRoot),
  });
}

/**
 * Record the mission in the StateStore, 1:1 with the `mission.created` append.
 *
 * Called ONLY after that append succeeded. A store row whose mission has no
 * `mission.created` event is an orphan by the design's own definition
 * (`/doctor` Check 8-③), so a failed or skipped append must not be followed by
 * a store write that invents one.
 *
 * The mission id is RECEIVED, never recomputed. It is the same value the append
 * put on the wire, from the same instant — recomputing it here is the midnight
 * split `resolveMissionIdentity` exists to prevent.
 *
 * FAIL-OPEN, in full. Every failure — a bad project root, a store constructor
 * TypeError, a refused ledger port inside the commit — becomes a status string.
 * Nothing here may throw, and nothing here may alter any other field of the
 * middleware's return value: this is bookkeeping attached to a user prompt.
 *
 * THE MISSION CONTROLLER IS RECORDED HERE by composition, not by a second
 * write ({@link module:lib/mission/controller}). It is an OBSERVATION: a row
 * another live session controls is left exactly as found, so this function
 * still never arbitrates who may write a mission (transitions are CA-14).
 *
 * @param {object} state middleware state
 * @param {object} result `compileMission()` output
 * @param {number} nowMs the single epoch-ms reading for this prompt
 * @param {{projectRoot: string|null, sessionId: string|null, missionId: string|null}} identity
 *   from {@link resolveMissionIdentity} — shared with the append
 * @param {{resolveGitCommonDir: (root: string) => string|null}} deps injected ports
 * @returns {object} the `task.mission.store` value
 */
function recordMissionState(state, result, nowMs, identity, deps) {
  try {
    const { projectRoot, sessionId, missionId } = identity;
    // Guaranteed by the append that gated this call. Re-checked rather than
    // assumed, so this function carries no unstated precondition.
    if (!projectRoot || !sessionId) return skippedMissionStore('no-project-root-or-session-id');
    if (!missionId) return skippedMissionStore('no-mission-id');

    const store = openMissionStore(projectRoot, sessionId, nowMs, deps);
    // The controller rides the SAME mutator (no extra commit, `state.updated` or
    // journal record). `nowMs` is threaded, not re-read: lease instant and ledger
    // `ts` must be ONE instant. The CAS retry re-runs this mutator as a whole.
    const title = missionTitle(result, String(state.input?.prompt ?? ''));
    const mutator = composeControllerMutator(
      missionMutator(missionId, title, missionIntentRevision(result)), { sessionId, now: nowMs },
    );
    const opts = { reason: MISSION_STORE_REASON };
    let commit = store.updateMission(missionId, mutator, {
      ...opts, expectedVersion: store.getState().state_version,
    });
    // ONE retry, not a loop. A second conflict means sustained contention, and
    // a hook that spins on a lock delays the user's prompt to fix bookkeeping.
    if (commit.conflict === true) {
      commit = store.updateMission(missionId, mutator, {
        ...opts, expectedVersion: store.getState().state_version,
      });
    }
    // AFTER the retry, deliberately: the mutator reports its LAST run, which
    // is the one that committed.
    return summarizeMissionCommit(
      commit, missionId, store.location.source, mutator.observation,
    );
  } catch (err) {
    return {
      status: 'error',
      detail: err?.message ?? 'store-threw',
      // Null because nothing committed. Reporting the id here would suggest a
      // row exists under it, which is the one thing this branch knows is false.
      state_version: null,
      mission_id: null,
      location: null,
      controller_observation: null,
      warnings: [],
    };
  }
}

/**
 * Record the question gate's four conditions for this prompt (SH-18), as the
 * ONE `adr.question_gate_evaluated` line `lib/runtime/question-gate-record.js`
 * appends. Observe only: nothing reads the verdict back, and the returned
 * status is surfaced on `task.mission.question_gate` for a census, not for a
 * branch.
 *
 * WRAPPED LOCALLY even though both recorder functions promise not to throw.
 * This runs inside `recordMissionCompile`'s try, whose catch rewrites the whole
 * mission record as a compile failure — so a recorder that broke its promise
 * would take the contract, the ledger status and the store result down with
 * it. The recorder is the newest and least-exercised code on this path; it is
 * the one that must not be able to reach its neighbours.
 *
 * Takes the SAME `identity` and `nowMs` as the mission append, so the two lines
 * name one mission and one instant (see `resolveMissionIdentity`).
 *
 * ORDER. Called AFTER the store write, so the mission event and its paired
 * `state.updated` stay adjacent and the gate line is always the last one this
 * prompt appends. NOT gated on the mission append: the gate is its own
 * observation, and it skips on exactly the identity the append skips on.
 *
 * @param {object} state middleware state
 * @param {number} nowMs the single epoch-ms reading for this prompt
 * @param {{projectRoot: string|null, sessionId: string|null, missionId: string|null}} identity
 * @returns {string} the recorder's status, or `error:<message>` if it threw
 */
function recordQuestionGate(state, nowMs, identity) {
  try {
    const data = buildQuestionGateData({
      prompt: String(state.input?.prompt ?? ''),
      intent: state.context?.intent,
      classification: state.context?.routing?.classification,
    });
    return appendQuestionGateEvent(identity, data, nowMs);
  } catch (err) {
    return `error:${err?.message ?? 'question-gate-threw'}`;
  }
}

/**
 * Compile the prompt into a Mission Contract and record it.
 *
 * The question-gate line is NOT recorded when the compile throws. Its
 * denominator is kept equal to the mission events': every
 * `adr.question_gate_evaluated` line then has a mission line beside it under
 * the same `mission_id`, and a compile failure — which writes no mission line —
 * writes no gate line either, instead of a gate line that pairs with nothing.
 *
 * @param {object} state
 * @param {() => number} now
 * @param {{resolveGitCommonDir: (root: string) => string|null}} deps injected ports
 * @returns {object} the value for `task.mission`
 */
function recordMissionCompile(state, now, deps) {
  try {
    // ONE reading of the clock for the whole mission record, threaded through
    // the compile, the append and the store write. `now` is a PORT: nothing
    // guarantees two calls return the same value, and a test that advances it
    // between calls is a supported use, not an abuse. Every downstream instant
    // is derived from this constant.
    const nowMs = now();
    const result = compileMission({
      prompt: String(state.input?.prompt ?? ''),
      intent: state.context?.intent,
      classification: state.context?.routing?.classification,
      nowMs,
      // system1 → reduced contract. Not the `agentTeam` flag: that one is a
      // topology decision, this one selects the contract shape (§3.5).
      system: state.context?.routing?.system === 'system2' ? 'system2' : 'system1',
    });
    const identity = resolveMissionIdentity(state, nowMs);
    const ledger = appendMissionEvent(state, result, nowMs, identity);
    // Gated on the APPEND, not on the compile. `mission.candidate_deferred`
    // is a successful append of a non-mission, and a store row for it would
    // be a mission the ledger never opened.
    const store = ledger.ok && ledger.event === 'mission.created'
      ? recordMissionState(state, result, nowMs, identity, deps)
      : skippedMissionStore('no-mission-created');
    return {
      contract: result.contract,
      mode: result.mode,
      signals: result.signals,
      substantive: result.substantive,
      deferred: result.deferred,
      ledger: ledger.status,
      store,
      // Evaluated last, after the store write — see recordQuestionGate.
      question_gate: recordQuestionGate(state, nowMs, identity),
      ok: true,
    };
  } catch (err) {
    // A compile failure is recorded, not raised. The prompt must survive its
    // own bookkeeping.
    return {
      ok: false,
      error: err?.message ?? 'compile-failed',
      ledger: 'skipped:compile-failed',
      store: skippedMissionStore('no-mission-created'),
      question_gate: 'skipped:compile-failed',
    };
  }
}

// F04(b)'s config key moved to `workflow-mode.js`, next to the resolver that
// acts on it. Re-exported — not relocated silently — because this module's
// export surface is depended on by path and must not change shape.
export { FOLLOW_WORKFLOW_PLAN_CONFIG_KEY } from './workflow-mode.js';

/**
 * Resolve everything the team gate needs from one config read.
 *
 * The config is read ONCE per prompt: the plan, the mode gate and the F04(b)
 * key are three consumers, and two reads of one file in one prompt can
 * disagree. `pluginRoot` comes back with it because the effort-meta read
 * downstream needs the same root — resolving it twice is how the two could
 * point at different plugins.
 *
 * `--no-team` is tested on the FLAG SURFACE, never on the prompt text:
 * `user-prompt-handler` strips the flag and the stripped copy is what reaches
 * `state.input.prompt`, so testing that would read a string the flag has
 * already been removed from (`hook-utils.js#extractUserPromptFlagSurface`).
 *
 * `followWorkflowPlan` is resolved by `workflow-mode.js#readFollowWorkflowPlan`
 * rather than read inline, so the key's name, its default and the gate that
 * uses it stay in one module.
 *
 * @param {object} state middleware state
 * @returns {{ pluginRoot: string|undefined, cfg: object, optOut: boolean,
 *   teamEnabled: boolean, followWorkflowPlan: boolean }}
 */
function readTeamGateInputs(state) {
  const pluginRoot = state.input?.pluginRoot
    || state.context?.pluginRoot
    || state.pluginRoot;
  const cfg = readJsonFileSync(path.join(pluginRoot || '', 'artibot.config.json')) || {};
  return {
    pluginRoot,
    cfg,
    optOut: NO_TEAM_FLAG.test(extractUserPromptFlagSurface(state.input?.hookData)),
    teamEnabled: isTeamEnabled(cfg.team),
    followWorkflowPlan: readFollowWorkflowPlan(cfg),
  };
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - Clock injection for deterministic tests.
 * @param {(projectRoot: string) => string|null} [options.resolveGitCommonDir] - Git
 *   port for the StateStore's location rule (decision F3). Injected the same way
 *   as `now`, and for the same reason: the default reads the filesystem, so a
 *   test that could not replace it would be asserting against whatever
 *   repository the suite happens to run inside. Contract: returns the absolute
 *   common dir or `null`, and NEVER throws — a `null` selects the reported
 *   `project-root-fallback` location rather than failing the write.
 * @returns {(state: object) => Promise<object>}
 */
export function createTasksMiddleware(options = {}) {
  const now = options.now || Date.now;
  const missionDeps = {
    resolveGitCommonDir: options.resolveGitCommonDir || resolveGitCommonDir,
  };

  return async function tasksMiddleware(state) {
    const routingSystem = state.context.routing?.system || 'system1';
    const intent = state.context.intent || {};

    const {
      pluginRoot, cfg, optOut, teamEnabled, followWorkflowPlan,
    } = readTeamGateInputs(state);

    // PLAN -> MODE -> RECORD. F04(b) derives the mode FROM the plan when the
    // key is on, so the plan has to be built first; the record then needs the
    // mode that was actually run, which is why it comes last.
    const plan = planWorkflow(state, cfg, intent, optOut);
    const { mode } = resolveWorkflowMode({
      routingSystem, teamEnabled, optOut, followWorkflowPlan, plan,
    });
    recordWorkflow(state, plan, mode);

    const phases = mode === 'agentTeam'
      ? ['plan', 'execute', 'verify']
      : ['execute', 'verify'];

    const task = {
      id: makeTaskId(now),
      mode,
      objective: state.input.prompt,
      recommendedAgent: intent.agents?.[0] || null,
      recommendedCommand: intent.commands?.[0] || null,
      complexity: state.context.routing?.score ?? null,
      ambiguity: intent.ambiguous || false,
      phases,
      createdAt: new Date(now()).toISOString(),
    };

    // P3-10: automatically attach effort/taskBudget meta when the prior
    // UserPromptSubmit hook (runtime-prompt.js) persisted them. This lets
    // /team orchestrator propagate `[artibot:effort=X][artibot:task-budget=Y]`
    // to each teammate without an explicit re-derive step.
    const effortMeta = readEffortMeta(pluginRoot, {
      sessionId: state.input?.hookData?.session_id ?? state.input?.sessionId ?? null,
      promptId: state.input?.hookData?.prompt_id ?? null,
    }, now());
    if (effortMeta && effortMeta.effort) {
      task.meta = {
        effort: effortMeta.effort,
        command: effortMeta.command,
        taskBudget: effortMeta.taskBudget,
        shift: effortMeta.shift,
        reason: effortMeta.reason,
      };
    }

    // P2 / F04(a): plan on EVERY path, record on every path — but ATTACH only
    // for agentTeam. The attachment is what the orchestrator reads to prefix
    // each teammate with `[artibot:effort][artibot:task-budget]` from the SAME
    // source as the trigger decision, and three live readers
    // (`middleware/subagents.js`, `runtime-prompt.js#buildTeamDirective` and
    // `#recordObserveOnlyDecisions`) require `undefined` here when no team runs.
    // Both gates reach this through `mode` alone: an OFF setting and — since
    // F04(b) — a `runner: 'inline'` plan under `team.followWorkflowPlan` each
    // resolve to `subAgent`, so the plan stays unattached and
    // `buildTeamDirective` emits ''.
    if (mode === 'agentTeam') {
      task.meta = { ...(task.meta || {}), workflowPlan: plan };
    }

    // T-25: compile a Mission Contract for EVERY prompt and record it. Placed
    // outside the `agentTeam` branch above on purpose (§3.5). Recorded on
    // `task.mission`, a sibling of `task.meta` — see the deviation note in the
    // module header for why not `task.meta.missionContract`.
    task.mission = recordMissionCompile(state, now, missionDeps);

    state.context.tasks = task;
    state.messageParts.push(`task=${mode}`);

    if (mode === 'agentTeam') {
      state.userPrompt += '\n\nExecution contract:\n- Create a plan first.\n- Execute in clear phases.\n- Validate before final answer.';
    }

    return state;
  };
}
