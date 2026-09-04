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
import { buildWorkflowPlan } from '../../cognitive/workflow-plan.js';
import { compileMission } from '../../mission/compiler.js';
import { getTaskBudgetForEffort } from '../task-budget.js';
import { appendLedgerEvent } from '../ledger.js';
import { sessionFallbackMissionId } from '../event-writer.js';
import { createStateStore } from '../../project-state/state-manager.js';
import { resolveGitCommonDir } from '../../project-state/git-common-dir.js';
import { recordWorkflowPlanDecision, resolveDecisionRunId } from '../../observability/decision-events.js';

function makeTaskId(nowFn) {
  const now = nowFn();
  return `rt-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Load the most recent effort + task-budget meta written by runtime-prompt.js.
 * Returns null when the effort file is missing or unreadable — downstream code
 * must treat effort/budget as optional.
 *
 * @param {string|undefined} pluginRoot
 * @returns {{ effort: string|null, taskBudget: number|null, command: string|null }|null}
 */
function readEffortMeta(pluginRoot) {
  if (!pluginRoot) return null;
  const runtimeDir = path.join(pluginRoot, 'runtime');
  const effortRaw = readJsonFileSync(path.join(runtimeDir, 'current-effort.json'));
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
 * Ledger event names this middleware may append, keyed by the spelling
 * `compileMission()` returns in `meta.ledgerEvent`.
 *
 * An ALLOWLIST map, not a normalizer. A rule that rewrote hyphens into dots
 * and underscores would fail OPEN for every event name the compiler invents
 * later (verification-discipline §8); a name absent from this table is skipped
 * and recorded instead.
 *
 * The hyphenated key is a real observed value, not defensive padding:
 * `lib/mission/compiler.js#compileMission` returns `'mission-candidate-deferred'`
 * in its `meta.ledgerEvent` — design §3.1's spelling — while the ledger
 * vocabulary registers `mission.candidate_deferred`
 * (`schemas/ledger-events.allowlist.json#/events/mission.candidate_deferred`,
 * whose `spec` field records that normalization). The allowlist is the
 * canonical vocabulary, so the append uses its name.
 */
const LEDGER_EVENT_BY_COMPILER_NAME = Object.freeze({
  'mission.created': 'mission.created',
  'mission-candidate-deferred': 'mission.candidate_deferred',
  'mission.candidate_deferred': 'mission.candidate_deferred',
});

/**
 * Cap on the ledger `title`. `mission.created` REQUIRES it, so the writer's
 * oversize fold cannot drop it — an unbounded goal string would push the whole
 * line past the 4 KB cap and get it rejected outright.
 */
const MISSION_TITLE_MAX = 120;

/** Cap on recorded signals, so a long signal list cannot crowd the same line. */
const MISSION_SIGNALS_MAX = 20;

/**
 * The project root the ledger is written under.
 *
 * INJECTED, never derived: `pluginRoot` also has a `runtime/` directory, so a
 * writer that guessed would land in the wrong tree (event-writer.js module
 * header). The hook-payload keys mirror `middleware/memory.js#buildQueryContext`,
 * which is where this pipeline already reads the working directory from.
 *
 * @param {object} state
 * @returns {string|null} null when no root is knowable — append is then skipped
 */
function resolveProjectRoot(state) {
  const hookData = state.input?.hookData || {};
  const candidates = [
    state.input?.projectRoot,
    state.context?.projectRoot,
    hookData.cwd,
    hookData.working_directory,
    hookData.path,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c.length > 0);
  return found || null;
}

/**
 * The raw session id for the ledger envelope.
 *
 * Read raw rather than through `resolveDecisionRunId`, which sanitizes for use
 * as a filename; the envelope wants the session's own id, and the writer
 * derives the `M-YYYYMMDD-S<sid8>` fallback mission id from it.
 *
 * @param {object} state
 * @returns {string|null}
 */
function resolveSessionId(state) {
  const candidates = [state.input?.hookData?.session_id, state.input?.sessionId];
  const found = candidates.find((c) => typeof c === 'string' && c.trim().length > 0);
  return found ? found.trim() : null;
}

/**
 * The mission title, capped.
 *
 * EXTRACTED so the ledger line and the store row cannot drift apart. They have
 * to agree by construction, not because two call sites happen to spell the same
 * expression today: `/doctor` Check 8 pairs a `mission.created` event with the
 * store entry it created, and a title that matched when it was written and
 * diverged three edits later is a mismatch nobody would think to look for.
 *
 * @param {object} result `compileMission()` output
 * @param {string} prompt raw prompt, the fallback when the contract has no goal
 * @returns {string} the goal (or prompt) truncated to MISSION_TITLE_MAX
 */
function missionTitle(result, prompt) {
  const goal = typeof result.contract?.goal === 'string' && result.contract.goal.length > 0
    ? result.contract.goal
    : prompt;
  return String(goal).slice(0, MISSION_TITLE_MAX);
}

/**
 * The intent revision for this compile.
 *
 * No revision source exists in Phase 0 — `intent_revision` is the caller's,
 * copied through by `compiler.js#assignOptionalFields`, and this caller has
 * none, so a first compile is revision 1. Revisions are T-24's.
 *
 * EXTRACTED for the same reason as {@link missionTitle}: the ledger's
 * `intent_revision` and the store's `mission.intent.revision` are ONE fact, and
 * the pairing stays checkable only while they stay one expression.
 *
 * @param {object} result `compileMission()` output
 * @returns {number} an integer >= 1
 */
function missionIntentRevision(result) {
  return Number.isInteger(result.contract?.intent_revision)
    ? result.contract.intent_revision
    : 1;
}

/**
 * The `data` object for one mission ledger line — the minimum each event's
 * allowlist entry requires, and nothing else.
 *
 * The contract itself is NOT written to the ledger. It carries verbatim spans
 * of the user's prompt, and the ledger line is capped at 4 KB; the contract
 * stays in memory on the task envelope, where the cap does not apply.
 *
 * @param {string} eventName resolved allowlist event name
 * @param {object} result `compileMission()` output
 * @param {string} prompt raw prompt, the title fallback
 * @returns {object}
 */
function buildMissionLedgerData(eventName, result, prompt) {
  if (eventName === 'mission.created') {
    return {
      title: missionTitle(result, prompt),
      intent_revision: missionIntentRevision(result),
    };
  }
  return {
    reason: result.deferred ? 'substantive-gate:deferred' : 'substantive-gate:not-substantive',
    signals: Array.isArray(result.signals) ? result.signals.slice(0, MISSION_SIGNALS_MAX) : [],
  };
}

/**
 * Append the one mission event for this prompt.
 *
 * Never throws and never affects the middleware result: every refusal becomes
 * a short status string. `appendLedgerEvent` already returns rather than
 * throws, but it is wrapped anyway — a bookkeeping call must not be able to
 * take its caller down.
 *
 * @param {object} state
 * @param {object} result `compileMission()` output
 * @param {() => number} now
 * @returns {{ok: boolean, status: string, event?: string}}
 */
function appendMissionEvent(state, result, now) {
  const compilerName = result.meta?.ledgerEvent;
  const eventName = Object.prototype.hasOwnProperty.call(
    LEDGER_EVENT_BY_COMPILER_NAME, compilerName,
  ) ? LEDGER_EVENT_BY_COMPILER_NAME[compilerName] : null;
  if (!eventName) return { ok: false, status: `skipped:unknown-event:${compilerName}` };

  const projectRoot = resolveProjectRoot(state);
  if (!projectRoot) return { ok: false, status: 'skipped:no-project-root' };

  const sessionId = resolveSessionId(state);
  if (!sessionId) return { ok: false, status: 'skipped:no-session-id' };

  try {
    const written = appendLedgerEvent(projectRoot, {
      event: eventName,
      session_id: sessionId,
      // Both events are registered `sources: ["hook"]`. This middleware runs
      // inside the UserPromptSubmit hook pipeline, so 'hook' is accurate as
      // well as the only permitted value.
      source: 'hook',
      data: buildMissionLedgerData(eventName, result, String(state.input?.prompt ?? '')),
    }, { now: () => new Date(now()) });
    return written?.ok
      ? { ok: true, status: 'appended', event: eventName }
      : { ok: false, status: `rejected:${written?.reason ?? 'unknown'}`, event: eventName };
  } catch (err) {
    return { ok: false, status: `error:${err?.message ?? 'append-threw'}`, event: eventName };
  }
}

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
 * @param {object} commit `updateMission()` result
 * @param {string} missionId the mission the write was for
 * @param {string} location `store.location.source`
 * @returns {object} the `task.mission.store` value
 */
function summarizeMissionCommit(commit, missionId, location) {
  const warnings = Array.isArray(commit?.warnings) ? commit.warnings : [];
  if (commit?.ok) {
    return {
      status: 'written',
      detail: null,
      state_version: Number.isInteger(commit.state_version) ? commit.state_version : null,
      mission_id: missionId,
      location,
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
 * @param {string} missionId mission the row belongs to
 * @param {string} title from {@link missionTitle}
 * @param {number} revision from {@link missionIntentRevision}
 * @returns {(current: object|null) => object} mutator for `updateMission`
 */
function missionMutator(missionId, title, revision) {
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
 * Record the mission in the StateStore, 1:1 with the `mission.created` append.
 *
 * Called ONLY after that append succeeded. A store row whose mission has no
 * `mission.created` event is an orphan by the design's own definition
 * (`/doctor` Check 8-③), so a failed or skipped append must not be followed by
 * a store write that invents one.
 *
 * FAIL-OPEN, in full. Every failure — a bad project root, a store constructor
 * TypeError, a refused ledger port inside the commit — becomes a status string.
 * Nothing here may throw, and nothing here may alter any other field of the
 * middleware's return value: this is bookkeeping attached to a user prompt.
 *
 * @param {object} state middleware state
 * @param {object} result `compileMission()` output
 * @param {() => number} now epoch-ms clock (converted to the store's `() => Date`)
 * @param {{resolveGitCommonDir: (root: string) => string|null}} deps injected ports
 * @returns {object} the `task.mission.store` value
 */
function recordMissionState(state, result, now, deps) {
  try {
    const projectRoot = resolveProjectRoot(state);
    const sessionId = resolveSessionId(state);
    // Both are guaranteed by the append that gated this call; re-read rather
    // than passed so this function has no hidden precondition on its caller.
    if (!projectRoot || !sessionId) return skippedMissionStore('no-project-root-or-session-id');

    // THE SAME FUNCTION AND THE SAME INSTANT the writer used for the append.
    // `event-writer.js#buildEnvelope` derives the fallback id this way when a
    // caller supplies no `mission_id`; deriving it any other way here (there is
    // a same-named function in `lib/mission/mission-id.js` with a different
    // signature) would pair the two events under two different missions.
    const missionId = sessionFallbackMissionId(sessionId, new Date(now()));
    if (!missionId) return skippedMissionStore('no-mission-id');

    const store = createStateStore({
      projectRoot,
      sessionId,
      // `state.updated` registers no `sources` restriction, and this middleware
      // runs inside the UserPromptSubmit hook pipeline, so 'hook' is the honest
      // value — not the store's 'supervisor' default, which names a process
      // that is not running.
      source: 'hook',
      now: () => new Date(now()),
      appendEvent: (envelope) => appendLedgerEvent(projectRoot, envelope),
      resolveGitCommonDir: () => deps.resolveGitCommonDir(projectRoot),
    });

    const mutator = missionMutator(
      missionId, missionTitle(result, String(state.input?.prompt ?? '')), missionIntentRevision(result),
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
    return summarizeMissionCommit(commit, missionId, store.location.source);
  } catch (err) {
    return {
      status: 'error',
      detail: err?.message ?? 'store-threw',
      // Null because nothing committed. Reporting the id here would suggest a
      // row exists under it, which is the one thing this branch knows is false.
      state_version: null,
      mission_id: null,
      location: null,
      warnings: [],
    };
  }
}

/**
 * Compile the prompt into a Mission Contract and record it.
 *
 * @param {object} state
 * @param {() => number} now
 * @param {{resolveGitCommonDir: (root: string) => string|null}} deps injected ports
 * @returns {object} the value for `task.mission`
 */
function recordMissionCompile(state, now, deps) {
  try {
    const result = compileMission({
      prompt: String(state.input?.prompt ?? ''),
      intent: state.context?.intent,
      classification: state.context?.routing?.classification,
      nowMs: now(),
      // system1 → reduced contract. Not the `agentTeam` flag: that one is a
      // topology decision, this one selects the contract shape (§3.5).
      system: state.context?.routing?.system === 'system2' ? 'system2' : 'system1',
    });
    const ledger = appendMissionEvent(state, result, now);
    return {
      contract: result.contract,
      mode: result.mode,
      signals: result.signals,
      substantive: result.substantive,
      deferred: result.deferred,
      ledger: ledger.status,
      // Gated on the APPEND, not on the compile. `mission.candidate_deferred`
      // is a successful append of a non-mission, and a store row for it would
      // be a mission the ledger never opened.
      store: ledger.ok && ledger.event === 'mission.created'
        ? recordMissionState(state, result, now, deps)
        : skippedMissionStore('no-mission-created'),
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
    };
  }
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
    const mode = routingSystem === 'system2' ? 'agentTeam' : 'subAgent';
    const intent = state.context.intent || {};
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
    const pluginRoot = state.input?.pluginRoot
      || state.context?.pluginRoot
      || state.pluginRoot;
    const effortMeta = readEffortMeta(pluginRoot);
    if (effortMeta && effortMeta.effort) {
      task.meta = {
        effort: effortMeta.effort,
        command: effortMeta.command,
        taskBudget: effortMeta.taskBudget,
        shift: effortMeta.shift,
        reason: effortMeta.reason,
      };
    }

    // P2: derive a unified workflow plan (team trigger + per-teammate
    // effort/budget) from the single complexity classification. Attached only
    // for agentTeam mode so the orchestrator can prefix each teammate with
    // `[artibot:effort][artibot:task-budget]` from the SAME source as the
    // trigger decision. workflow-plan.js is pure L4 (router-only); the L5
    // budgetResolver port is injected here.
    if (mode === 'agentTeam') {
      const cfg = readJsonFileSync(path.join(pluginRoot || '', 'artibot.config.json')) || {};
      const classification = {
        score: state.context.routing?.score ?? 0,
        factors: state.context.routing?.classification?.factors,
      };
      const plan = buildWorkflowPlan(classification, intent, cfg, {
        budgetResolver: (e) => getTaskBudgetForEffort(e, cfg) || 0,
      });
      task.meta = { ...(task.meta || {}), workflowPlan: plan };

      // Explainability (D7) — observe-only. Records whether a parallel team
      // fired and the trigger reasons, including the inline case; agent names
      // only, no sub-objective text. Session id comes from `state.input` (where
      // the hook payload lives), the same place `pluginRoot` is read from above.
      //
      // `cwd` is passed RAW, not through this file's `resolveProjectRoot(state)`
      // helper: the recorder runs the payload through
      // `lib/git/project-root.js#resolveProjectRoot` itself, and every call site
      // handing it the same raw `cwd` is what guarantees all four recorders
      // agree on one store directory. Pre-resolving here would introduce a
      // second answer, which is the split store this store is being moved to
      // avoid.
      recordWorkflowPlanDecision(resolveDecisionRunId(state.input), plan, {
        cwd: state.input?.hookData?.cwd,
      });
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
