/**
 * Cognitive system module re-exports.
 * Integrates four cognitive subsystems (dual-process architecture):
 *   - router: Complexity-based routing between System 1 and System 2
 *   - system1: Fast, intuitive pattern-matching for simple tasks
 *   - system2: Deliberate Plan-Execute-Reflect loop for complex tasks
 *   - sandbox: Safe execution environment with dangerous command blocking
 *
 * Processing flow: input -> router (classify) -> system1 OR system2 -> output
 * @module lib/cognitive
 */

// Router (dual-process dispatcher)
export {
  classifyComplexity,
  route,
  adaptThreshold,
  getRoutingStats,
  resetRouter,
  getThreshold,
} from './router.js';

// System 1 (fast / intuitive)
export {
  patternMatch,
  fastResponse,
  escalateToSystem2,
  warmCache,
  savePattern,
  recordPatternOutcome,
  getDiagnostics,
  clearAllCaches,
} from './system1.js';

// System 2 (slow / deliberate)
export {
  plan,
  execute as executeSystem2,
  reflect,
  solve,
  assessComplexity,
} from './system2.js';

// Sandbox (safe execution)
export {
  createSandbox,
  execute as executeSandbox,
  checkCommandSafety,
  recordResult,
  validate as validateSandboxResult,
  getStats as getSandboxStats,
  cleanup as cleanupSandbox,
} from './sandbox.js';

/**
 * Process an input through the full cognitive pipeline.
 * Routes to System 1 or System 2 based on complexity assessment.
 *
 * @param {string} input - User input or task description
 * @param {object} [context] - Additional context
 * @returns {Promise<{
 *   system: 'system1' | 'system2',
 *   result: object,
 *   complexity: object
 * }>}
 */
export async function process(input, context = {}) {
  const { route: routeInput } = await import('./router.js');
  const routing = routeInput(input, context);

  if (routing.system === 'system1') {
    const { fastResponse } = await import('./system1.js');
    const result = await fastResponse(input, context);
    return { system: 'system1', result, complexity: routing };
  }

  // System 2: build a task and solve it
  const { solve: solveTask } = await import('./system2.js');
  const task = {
    id: `task-${Date.now()}`,
    description: input,
    type: context.type || 'general',
    domain: context.domain || 'general',
    context,
  };
  const result = await solveTask(task);
  return { system: 'system2', result, complexity: routing };
}
