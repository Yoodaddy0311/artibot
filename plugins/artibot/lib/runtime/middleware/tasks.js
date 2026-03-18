/**
 * Runtime task middleware.
 * Builds a task envelope for downstream hook/team integrations.
 *
 * @module lib/runtime/middleware/tasks
 */

function makeTaskId(nowFn) {
  const now = nowFn();
  return `rt-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

    state.context.tasks = task;
    state.messageParts.push(`task=${mode}`);

    if (mode === 'agentTeam') {
      state.userPrompt += '\n\nExecution contract:\n- Create a plan first.\n- Execute in clear phases.\n- Validate before final answer.';
    }

    return state;
  };
}
