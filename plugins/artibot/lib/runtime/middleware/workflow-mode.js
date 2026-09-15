/**
 * Execution-topology resolver for the tasks middleware (runtime layer, L5).
 *
 * ONE function, deliberately extracted from `tasks.js`: the mode decision now
 * has three inputs instead of one (routing system, team enable state, prompt
 * opt-out) and F04(b) adds a fourth (`team.followWorkflowPlan` plus the plan
 * itself). Keeping it inline would have pushed `tasks.js` past the 800-line
 * file ceiling, and — more to the point — the decision is worth testing as a
 * truth table rather than through a middleware with a filesystem in front of
 * it.
 *
 * WHY THE OPT-OUT OUTRANKS ROUTING. `routing.system === 'system2'` means "this
 * prompt is complex". It does not mean "spawn a team". Before this module the
 * two were the same statement, so a user who set `team.enabled: false` or typed
 * `--no-team` still got `mode: 'agentTeam'`, an "Execution contract" telling the
 * model to plan in phases, and a "Delegation contract" naming teammates. Owner
 * decision OD2 (2026-09-15): OFF drops to `subAgent` even on system2, so the
 * contract text disappears with the spawn directive rather than surviving it.
 * Complexity still reaches the model — the `[artibot:route system2]` directive
 * is emitted by a different owner (`runtime-prompt.js`) and is untouched here.
 *
 * Options object, not positional arguments: F04(b) adds `followWorkflowPlan`
 * and `plan` to this call, and a fifth positional boolean is how call sites
 * start passing arguments in the wrong order.
 *
 * WHY `planWorkflow` AND `recordWorkflow` LIVE HERE, not just the resolver.
 * Two reasons, and the second is the load-bearing one:
 *   1. Size. `tasks.js` was 799 lines with the OFF gate inline — at the 800-line
 *      file ceiling (plugin `CLAUDE.md` Quality Gates) with nothing left to
 *      spend. Measured 2026-09-15: 844 lines with the helpers still in it, 785
 *      after this move. The only other way to fit was to delete the rationale
 *      paragraphs below, which is the wrong thing to lose.
 *   2. Cohesion. Plan, mode and record are ONE decision taken in one order.
 *      Splitting them across two files is how the old order — mode decided
 *      first, plan built afterwards as a passive observer of a decision it is
 *      supposed to inform — survived as long as it did. Reading them in
 *      sequence here makes an inversion visible at the call site.
 *
 * `tasks.js` keeps the composition: it reads the config, calls these three in
 * order, and owns everything downstream of the mode (phases, attachment, the
 * "Execution contract" append).
 *
 * @module lib/runtime/middleware/workflow-mode
 */

import { buildWorkflowPlan } from '../../cognitive/workflow-plan.js';
import { getTaskBudgetForEffort } from '../task-budget.js';
import { recordWorkflowPlanDecision, resolveDecisionRunId } from '../../observability/decision-events.js';

/**
 * Resolve the execution topology for one prompt.
 *
 * `reasons` is the AUDIT trail, not a decision input: it records why the mode
 * is what it is so `workflow-planned` records can tell an OFF session apart
 * from a session that simply routed system1. Both OFF reasons are collected
 * when both apply — the user disabled the team AND typed the flag is a
 * different fact from either one alone.
 *
 * @param {object} params
 * @param {string} [params.routingSystem] - `state.context.routing.system`
 *   (`'system1'` | `'system2'`). Anything that is not `'system2'` is treated as
 *   system1, matching the `|| 'system1'` default the caller already applied.
 * @param {boolean} [params.teamEnabled] - `isTeamEnabled(config.team)`. Pass the
 *   resolved boolean, not the config: the enable MEANING has one owner
 *   (`lib/cognitive/workflow-plan.js#isTeamEnabled`) and this module is not it.
 *   Anything falsy — including a caller that forgot to pass it — reads as OFF.
 *   That direction is chosen on purpose: the failure mode of guessing wrong is
 *   "no team was spawned", not "a team was spawned against the user's wishes".
 * @param {boolean} [params.optOut] - `--no-team` on the prompt's flag surface.
 *   Only the literal `true` counts, so an unparsed payload cannot disable a
 *   team by accident.
 * @returns {{ mode: 'agentTeam'|'subAgent', reasons: string[] }}
 */
export function resolveWorkflowMode({ routingSystem, teamEnabled, optOut } = {}) {
  const reasons = [];
  if (!teamEnabled) reasons.push('team-disabled');
  if (optOut === true) reasons.push('no-team-flag');

  if (reasons.length > 0) return { mode: 'subAgent', reasons };

  return {
    mode: routingSystem === 'system2' ? 'agentTeam' : 'subAgent',
    reasons: [],
  };
}

/**
 * Build the workflow plan for this prompt and record it — on EVERY routing path.
 *
 * P2: one unified plan (team trigger + per-teammate effort/budget) derived from
 * the single complexity classification. `workflow-plan.js` is pure L4
 * (router-only); the L5 `budgetResolver` port is injected here.
 *
 * RUNS FOR BOTH MODES since F04(a). It used to run only for `agentTeam`, which
 * left system1 — the majority of prompts — with no `workflow-planned` line, and
 * made one of the two mismatch directions unrepresentable: the only writer was
 * the branch where the mode is `agentTeam` by construction. Whether the plan is
 * ATTACHED to `task.meta` is a separate decision, still `agentTeam`-only, and
 * stays with the caller.
 *
 * Explainability (D7) — observe-only. Records whether a parallel team fired and
 * the trigger reasons; agent names only, no sub-objective text. The session id
 * comes from `state.input`, where the hook payload lives — the same place
 * `pluginRoot` is read from.
 *
 * `cwd` is passed RAW, not through the `resolveProjectRoot(state)` helper in
 * `tasks.js` (which stayed there when this moved out on 2026-09-15 — the
 * sentence used to say "this file's", and that pronoun would now name the
 * wrong file): the recorder runs the payload through
 * `lib/git/project-root.js#resolveProjectRoot` itself, and every call site
 * handing it the same raw `cwd` is what guarantees all four recorders agree on
 * one store directory. Pre-resolving here would introduce a second answer,
 * which is the split store this store is being moved to avoid.
 *
 * ORDER (2026-09-15): plan BEFORE mode, record AFTER it. This used to take
 * `mode` as an argument — see `workflow-mode.js` for why that order was wrong.
 *
 * @param {object} state middleware state
 * @param {object} cfg the already-read `artibot.config.json` object
 * @param {object} intent `state.context.intent`, already defaulted by the caller
 * @param {boolean} optOut `--no-team` was on the prompt's flag surface
 * @returns {object} the `buildWorkflowPlan` result
 */
export function planWorkflow(state, cfg, intent, optOut) {
  const classification = {
    score: state.context.routing?.score ?? 0,
    factors: state.context.routing?.classification?.factors,
  };
  return buildWorkflowPlan(classification, intent, cfg, {
    budgetResolver: (e) => getTaskBudgetForEffort(e, cfg) || 0,
    optOut,
  });
}

/**
 * Record the plan with the mode the prompt ACTUALLY ran under (`data.mode`).
 * Split from {@link planWorkflow} only so the mode resolves between the two.
 * `cwd` stays RAW — see the note above.
 *
 * @param {object} state @param {object} plan @param {'agentTeam'|'subAgent'} mode
 * @returns {void}
 */
export function recordWorkflow(state, plan, mode) {
  recordWorkflowPlanDecision(resolveDecisionRunId(state.input), plan, {
    cwd: state.input?.hookData?.cwd,
    mode,
  });
}
