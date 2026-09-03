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
// Mission compile (T-25) — OBSERVE ONLY
//
// `compileMission()` runs for EVERY prompt. It deliberately does NOT inherit
// the `mode === 'agentTeam'` condition that gates `buildWorkflowPlan` below:
// that condition excludes every system1 prompt, and a compiler that skips
// system1 has no Observe denominator (design §3.5; compiler.js module header).
// system1 receives the REDUCED contract instead.
//
// Nothing here changes behavior. The compiled contract is recorded on the task
// envelope, one line is appended to the central ledger, and every failure is
// swallowed into a status field. No file under `.artibot/**` is created by
// this block other than the ledger's own append (intent.md is T-40's).
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
    const goal = typeof result.contract?.goal === 'string' && result.contract.goal.length > 0
      ? result.contract.goal
      : prompt;
    return {
      title: String(goal).slice(0, MISSION_TITLE_MAX),
      // No revision source exists in Phase 0 — `intent_revision` is the
      // caller's, copied through by `compiler.js#assignOptionalFields`, and
      // this caller has none, so a first compile is revision 1. Revisions
      // are T-24's.
      intent_revision: Number.isInteger(result.contract?.intent_revision)
        ? result.contract.intent_revision
        : 1,
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
 * Compile the prompt into a Mission Contract and record it.
 *
 * @param {object} state
 * @param {() => number} now
 * @returns {object} the value for `task.mission`
 */
function recordMissionCompile(state, now) {
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
      ok: true,
    };
  } catch (err) {
    // A compile failure is recorded, not raised. Observe-only means the
    // prompt must survive its own bookkeeping.
    return { ok: false, error: err?.message ?? 'compile-failed', ledger: 'skipped:compile-failed' };
  }
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - Clock injection for deterministic tests.
 * @returns {(state: object) => Promise<object>}
 */
export function createTasksMiddleware(options = {}) {
  const now = options.now || Date.now;

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
      recordWorkflowPlanDecision(resolveDecisionRunId(state.input), plan);
    }

    // T-25: compile a Mission Contract for EVERY prompt and record it. Placed
    // outside the `agentTeam` branch above on purpose (§3.5). Recorded on
    // `task.mission`, a sibling of `task.meta` — see the deviation note in the
    // module header for why not `task.meta.missionContract`.
    task.mission = recordMissionCompile(state, now);

    state.context.tasks = task;
    state.messageParts.push(`task=${mode}`);

    if (mode === 'agentTeam') {
      state.userPrompt += '\n\nExecution contract:\n- Create a plan first.\n- Execute in clear phases.\n- Validate before final answer.';
    }

    return state;
  };
}
