/**
 * Plan-mode middleware — read-only guardrail for planning phase.
 * When plan mode is active, only read-only tools (Read, Grep, Glob)
 * and investigation tools (Agent) are permitted. Write, Edit, and Bash
 * are blocked.
 *
 * @module lib/runtime/middleware/plan-mode
 */

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/** Tools allowed in plan mode (read-only / investigation) */
const ALLOWED_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'Agent',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'SendMessage',
]);

/** Tools explicitly blocked in plan mode (write / execute) */
const BLOCKED_TOOLS = new Set([
  'Write', 'Edit', 'Bash',
  'NotebookEdit',
]);

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * Check if plan mode is active in the given context.
 *
 * @param {object} context - Pipeline state context.
 * @returns {boolean}
 */
export function isPlanMode(context) {
  return context?.planMode?.active === true;
}

/**
 * Enable plan mode on a context (immutable — returns new context).
 *
 * @param {object} context
 * @returns {object} New context with plan mode active.
 */
export function enablePlanMode(context) {
  return {
    ...context,
    planMode: { ...context?.planMode, active: true, enabledAt: new Date().toISOString() },
  };
}

/**
 * Disable plan mode on a context (immutable — returns new context).
 *
 * @param {object} context
 * @returns {object} New context with plan mode inactive.
 */
export function disablePlanMode(context) {
  return {
    ...context,
    planMode: { ...context?.planMode, active: false, disabledAt: new Date().toISOString() },
  };
}

// ---------------------------------------------------------------------------
// Tool evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a tool is permitted in plan mode.
 *
 * @param {string} toolName
 * @returns {{ decision: 'allow' | 'block', reason: string }}
 */
function evaluateTool(toolName) {
  if (ALLOWED_TOOLS.has(toolName)) {
    return { decision: 'allow', reason: `"${toolName}" is a read-only tool` };
  }
  if (BLOCKED_TOOLS.has(toolName)) {
    return { decision: 'block', reason: 'Plan mode active \u2014 read-only tools only' };
  }
  // Unknown tools default to block in plan mode (fail-closed)
  return { decision: 'block', reason: `Plan mode active \u2014 "${toolName}" is not in the allow list` };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a plan-mode middleware.
 *
 * @param {object} [options]
 * @param {boolean} [options.mode] - Set to 'plan' to force plan mode regardless of context.
 * @param {boolean} [options.enabled=true] - Disable middleware entirely.
 * @returns {(state: object) => Promise<object>}
 */
export function createPlanModeMiddleware(options = {}) {
  const { mode, enabled = true } = options;

  return async function planModeMiddleware(state) {
    const forcePlan = mode === 'plan';
    const contextPlan = isPlanMode(state.context);
    const active = enabled && (forcePlan || contextPlan);

    if (!active) {
      state.context.planMode = { ...state.context.planMode, active: false, evaluations: [] };
      return state;
    }

    // Enable in context if forced by option
    if (forcePlan && !contextPlan) {
      state.context = enablePlanMode(state.context);
    }

    const candidates = collectToolCandidates(state);
    const evaluations = [];
    const blocked = [];

    for (const toolName of candidates) {
      const result = evaluateTool(toolName);
      evaluations.push({ tool: toolName, ...result });
      if (result.decision === 'block') {
        blocked.push(toolName);
      }
    }

    state.context.planMode = {
      ...state.context.planMode,
      active: true,
      evaluated: evaluations.length,
      blocked,
      evaluations,
    };

    if (blocked.length > 0) {
      state.messageParts.push(`planMode=blocked:${blocked.join(',')}`);
      state.userPrompt += `\n\n\u26A0\uFE0F Plan mode: write/execute tools blocked \u2014 ${blocked.join(', ')}`;
    } else {
      state.messageParts.push('planMode=ok');
    }

    return state;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect tool names from state that may be invoked.
 *
 * @param {object} state
 * @returns {string[]}
 */
function collectToolCandidates(state) {
  const tools = new Set();

  const subagentTools = state.context.subagents?.contract?.tools;
  if (Array.isArray(subagentTools)) {
    for (const t of subagentTools) tools.add(t);
  }

  const taskMode = state.context.tasks?.mode;
  if (taskMode === 'agentTeam') {
    tools.add('TeamCreate');
    tools.add('SendMessage');
    tools.add('TaskCreate');
  }

  return [...tools];
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  ALLOWED_TOOLS as _ALLOWED_TOOLS,
  BLOCKED_TOOLS as _BLOCKED_TOOLS,
  evaluateTool as _evaluateTool,
  collectToolCandidates as _collectToolCandidates,
};
