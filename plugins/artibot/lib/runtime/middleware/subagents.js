/**
 * Runtime subagent middleware.
 * Normalizes delegation guidance into a single contract for hook/runtime consumers.
 *
 * @module lib/runtime/middleware/subagents
 */

import { isTeamEnabled } from '../../cognitive/workflow-plan.js';

// Fallback for when config omits team.delegationModeSelection. Must stay in
// lockstep with artibot.config.json#/team/delegationModeSelection — a drifted
// fallback names tools the harness no longer provides, and the contract flows
// into the prompt and into guardrail's candidate list.
const DEFAULT_POLICIES = Object.freeze({
  subAgent: {
    tools: ['Agent'],
    communication: 'one-way (result return only)',
  },
  agentTeam: {
    tools: ['Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'],
    communication: 'P2P bidirectional + shared task list',
  },
});

function getPolicy(config, mode) {
  const configured = config?.team?.delegationModeSelection?.[mode];
  return configured || DEFAULT_POLICIES[mode] || { tools: [], communication: 'unspecified' };
}

/**
 * @param {object} [options]
 * @returns {(state: object) => Promise<object>}
 */
export function createSubagentsMiddleware(options = {}) {
  const { enabled = true } = options;

  return async function subagentsMiddleware(state) {
    if (!enabled) {
      state.context.subagents = {
        enabled: false,
        contract: null,
      };
      return state;
    }

    const task = state.context.tasks || {};
    const mode = task.mode === 'agentTeam' ? 'agentTeam' : 'subAgent';
    const policy = getPolicy(state.config, mode);
    const bestAgent = state.context.intent?.agents?.[0] || task.recommendedAgent || null;
    const bestCommand = state.context.intent?.commands?.[0] || task.recommendedCommand || null;

    // WIRE-03: surface the per-teammate plan from buildWorkflowPlan
    // (lib/cognitive/workflow-plan.js) on the structured contract so object
    // consumers — not just the prompt-string directive (runtime-prompt.js
    // buildTeamDirective:127) — get planned effort/budget. The team branch of
    // buildWorkflowPlan (workflow-plan.js:254-261) emits runner/effort/
    // perAgentBudget/teammates[{agent,command,effort,budget}]; inline returns
    // teammates:[] (workflow-plan.js:232).
    const plan = task.meta?.workflowPlan;
    const planTeammates = (plan?.runner === 'team' && Array.isArray(plan.teammates))
      ? plan.teammates
      : [];

    const contract = {
      mode,
      shouldParallelize: mode === 'agentTeam',
      requiresPlan: mode === 'agentTeam',
      targetAgent: bestAgent,
      targetCommand: bestCommand,
      tools: policy.tools || [],
      communication: policy.communication || 'unspecified',
      parentEffort: plan?.effort ?? null,
      perAgentBudget: typeof plan?.perAgentBudget === 'number' ? plan.perAgentBudget : 0,
      teammates: planTeammates.map((t) => ({
        agent: t.agent,
        command: t.command,
        effort: t.effort,
        budget: t.budget,
      })),
    };

    // Read BEFORE the append below, which is the whole point: this flag was
    // computed and then ignored. `mode` alone used to decide whether the model
    // was told to delegate, so `team.enabled:false` still produced a
    // "Delegation contract" naming teammates. The mode gate upstream
    // (`workflow-mode.js`) already resolves OFF to `subAgent`, so in practice
    // this is the second fence rather than the first — kept because a future
    // caller that sets `task.mode` itself would otherwise reopen the hole.
    //
    // `isTeamEnabled`, not a local `team.enabled ?? true`: the local version
    // ignored `autoApply`, so the two documented spellings of the same opt-out
    // disagreed here (owner decision OD3 — either one false means off). Every
    // consumer of `context.subagents` outside this file reads `.contract.*`,
    // never `.enabled` (measured 2026-09-15 13:27 KST, `grep -rn
    // "subagents\.enabled|context\.subagents" lib scripts`), so widening the
    // flag's meaning reaches the prompt gate and nothing else.
    const teamEnabled = isTeamEnabled(state.config?.team);

    state.context.subagents = {
      enabled: teamEnabled,
      contract,
    };

    state.messageParts.push(`delegate=${mode}`);

    if (mode === 'agentTeam' && teamEnabled) {
      state.userPrompt += [
        '',
        'Delegation contract:',
        `- Preferred mode: ${mode}`,
        `- Preferred agent: ${bestAgent || 'orchestrator'}`,
        `- Preferred command: ${bestCommand || 'none'}`,
        '- Parallelize independent work when it reduces time-to-result.',
      ].join('\n');
    }

    return state;
  };
}
