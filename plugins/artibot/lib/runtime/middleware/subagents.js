/**
 * Runtime subagent middleware.
 * Normalizes delegation guidance into a single contract for hook/runtime consumers.
 *
 * @module lib/runtime/middleware/subagents
 */

const DEFAULT_POLICIES = Object.freeze({
  subAgent: {
    tools: ['Task'],
    communication: 'one-way (result return only)',
  },
  agentTeam: {
    tools: ['TeamCreate', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TeamDelete'],
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

    const contract = {
      mode,
      shouldParallelize: mode === 'agentTeam',
      requiresPlan: mode === 'agentTeam',
      targetAgent: bestAgent,
      targetCommand: bestCommand,
      tools: policy.tools || [],
      communication: policy.communication || 'unspecified',
    };

    state.context.subagents = {
      enabled: Boolean(state.config?.team?.enabled ?? true),
      contract,
    };

    state.messageParts.push(`delegate=${mode}`);

    if (mode === 'agentTeam') {
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
