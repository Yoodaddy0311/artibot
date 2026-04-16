/**
 * Setup/Teardown lifecycle middleware for agent task execution.
 * Wraps the middleware pipeline in a 3-phase lifecycle:
 *   1. Setup  — prepare context, record start timestamp, initialize logs
 *   2. Execute — run the next middleware (or the rest of the chain)
 *   3. Teardown — collect results, compute duration, cancel downstream on failure
 *
 * Compatible with the existing middleware signature used in create-artibot-agent.js:
 *   (state) => Promise<state>
 *
 * @module lib/runtime/middleware/lifecycle
 */

/**
 * @typedef {object} LifecycleOptions
 * @property {() => number} [now] - Clock injection for testability.
 * @property {object} [canceler] - Optional Canceler instance for downstream cancellation.
 * @property {object} [dag] - Optional DAG instance for dependency graph.
 * @property {(id: string) => string} [getStatus] - Status lookup for canceler.
 * @property {string} [taskId] - Current task identifier.
 * @property {(phase: string, data: object) => void} [onPhase] - Phase lifecycle callback.
 */

/**
 * Create a lifecycle middleware that wraps execution in setup/teardown phases.
 *
 * @param {LifecycleOptions} [options]
 * @returns {(state: object) => Promise<object>}
 */
export function createLifecycleMiddleware(options = {}) {
  const {
    now = Date.now,
    canceler = null,
    dag = null,
    getStatus,
    taskId = null,
    onPhase = null,
  } = options;

  return async function lifecycleMiddleware(state) {
    const setupResult = setup(state, { now, taskId, onPhase });

    let executeError = null;
    try {
      await execute(state, { onPhase });
    } catch (err) {
      executeError = err;
    }

    teardown(state, {
      now,
      setupResult,
      executeError,
      canceler,
      dag,
      getStatus,
      taskId,
      onPhase,
    });

    if (executeError) throw executeError;
    return state;
  };
}

/**
 * Setup phase: record start time, initialize lifecycle context.
 */
function setup(state, { now, taskId, onPhase }) {
  const startedAt = now();
  const lifecycleCtx = {
    phase: 'setup',
    startedAt,
    taskId: taskId || state.context?.tasks?.id || null,
    logs: [],
  };

  state.context = {
    ...state.context,
    lifecycle: lifecycleCtx,
  };

  state.messageParts.push('lifecycle=setup');

  if (onPhase) {
    onPhase('setup', { startedAt, taskId: lifecycleCtx.taskId });
  }

  return { startedAt };
}

/**
 * Execute phase: the pipeline body runs here.
 * In the middleware signature, `state` is mutated by the pipeline.
 */
async function execute(state, { onPhase }) {
  state.context.lifecycle = {
    ...state.context.lifecycle,
    phase: 'execute',
  };

  if (onPhase) {
    onPhase('execute', { taskId: state.context.lifecycle.taskId });
  }
}

/**
 * Teardown phase: compute duration, record result, cancel downstream on failure.
 */
function teardown(state, opts) {
  const {
    now, setupResult, executeError, canceler, dag, getStatus, taskId, onPhase,
  } = opts;
  const finishedAt = now();
  const durationMs = finishedAt - setupResult.startedAt;
  const success = !executeError;
  const resolvedTaskId = taskId || state.context?.lifecycle?.taskId;

  const teardownCtx = {
    ...state.context.lifecycle,
    phase: 'teardown',
    finishedAt,
    durationMs,
    success,
    error: executeError ? (executeError.message || String(executeError)) : null,
  };

  state.context = {
    ...state.context,
    lifecycle: teardownCtx,
  };

  state.messageParts.push(`lifecycle=teardown(${durationMs}ms)`);

  if (!success && canceler && dag && resolvedTaskId) {
    const cancelled = canceler.cancelDownstream(dag, resolvedTaskId, getStatus);
    teardownCtx.cancelledDownstream = cancelled;
    if (cancelled.length > 0) {
      state.messageParts.push(`cancelled=${cancelled.length}`);
    }
  }

  if (onPhase) {
    onPhase('teardown', {
      taskId: resolvedTaskId,
      durationMs,
      success,
      error: teardownCtx.error,
      cancelledDownstream: teardownCtx.cancelledDownstream || [],
    });
  }
}
