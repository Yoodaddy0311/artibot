/**
 * Context Reset Middleware.
 * Triggers agent replacement with structured handoff when token usage
 * exceeds a configurable threshold. Uses full reset instead of compaction
 * to eliminate "context anxiety".
 *
 * @module lib/runtime/middleware/context-reset
 */

import { emit } from '../../core/event-bus.js';

// ---------------------------------------------------------------------------
// Serialization (pure)
// ---------------------------------------------------------------------------

/**
 * Serialize current pipeline state into a structured handoff document.
 *
 * @param {object} state
 * @returns {object} Frozen handoff payload
 */
function serializeHandoff(state) {
  const ctx = state.context || {};
  return Object.freeze({
    currentTask: ctx.currentTask || null,
    completedTasks: ctx.completedTasks || [],
    pendingTasks: ctx.pendingTasks || [],
    decisions: ctx.decisions || [],
    constraints: ctx.constraints || [],
    modifiedFiles: ctx.modifiedFiles || [],
    contract: ctx.contract || null,
    sessionId: ctx.sessionId || null,
    agentType: state.agent?.type || null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Convert a handoff document into initial context for a replacement agent.
 *
 * @param {object} handoff - Previously serialized handoff
 * @returns {object} New agent's initial context
 */
function deserializeHandoff(handoff) {
  if (!handoff || typeof handoff !== 'object') {
    return { previousSession: null, resumedFrom: null, originalAgent: null };
  }
  return {
    previousSession: {
      tasks: {
        completed: handoff.completedTasks || [],
        pending: handoff.pendingTasks || [],
        current: handoff.currentTask || null,
      },
      decisions: handoff.decisions || [],
      constraints: handoff.constraints || [],
      modifiedFiles: handoff.modifiedFiles || [],
      contract: handoff.contract || null,
    },
    resumedFrom: handoff.timestamp || null,
    originalAgent: handoff.agentType || null,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a context-reset middleware.
 *
 * @param {object} [config]
 * @param {number} [config.tokenThreshold=0.80]  - Ratio (0-1) at which to trigger reset.
 * @param {number} [config.preserveRatio=0.95]    - Target state-preservation ratio.
 * @returns {(state: object, next: Function) => Promise<object>}
 */
function createContextResetMiddleware(config = {}) {
  const threshold = config.tokenThreshold ?? 0.80;
  const preserveRatio = config.preserveRatio ?? 0.95;

  return async function contextResetMiddleware(state, next) {
    const usage = state.context?.tokenUsage?.ratio ?? 0;

    if (usage < threshold) {
      return next(state);
    }

    // Build handoff
    const handoff = serializeHandoff(state);

    const resetInfo = Object.freeze({
      triggered: true,
      reason: `Token usage ${(usage * 100).toFixed(1)}% exceeded threshold ${(threshold * 100)}%`,
      handoff,
      preserveRatio,
      timestamp: new Date().toISOString(),
    });

    const newState = {
      ...state,
      context: {
        ...state.context,
        contextReset: resetInfo,
      },
    };

    // Notify listeners
    emit('context:reset', {
      reason: resetInfo.reason,
      sessionId: handoff.sessionId,
      agentType: handoff.agentType,
      timestamp: resetInfo.timestamp,
    });

    return next(newState);
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  createContextResetMiddleware,
  serializeHandoff,
  deserializeHandoff,
};
