/**
 * Runtime memory middleware.
 * Pulls lightweight relevant context from memory-manager and injects summary.
 *
 * @module lib/runtime/middleware/memory
 */

import { getRelevantContext } from '../../learning/memory-manager.js';

function toSummaryLines(relevant) {
  const lines = [];

  const prefs = relevant.preferences || [];
  if (prefs.length > 0) {
    const first = prefs[0];
    lines.push(`Preference hint: ${JSON.stringify(first).slice(0, 140)}`);
  }

  const projectContext = relevant.projectContext || [];
  if (projectContext.length > 0) {
    const first = projectContext[0];
    lines.push(`Project context: ${JSON.stringify(first).slice(0, 140)}`);
  }

  const errors = relevant.errorPatterns || [];
  if (errors.length > 0) {
    const first = errors[0];
    lines.push(`Past error pattern: ${JSON.stringify(first).slice(0, 140)}`);
  }

  return lines.slice(0, 3);
}

function buildQueryContext(state) {
  const hookData = state.input?.hookData || {};
  return {
    cwd: hookData.cwd || hookData.working_directory || hookData.path || '',
    command: state.context.intent?.commands?.[0] || '',
    project: hookData.project || '',
    keywords: state.context.intent?.intents || [],
  };
}

function countRelevantHits(relevant) {
  return (
    (relevant.preferences?.length || 0) +
    (relevant.projectContext?.length || 0) +
    (relevant.recentCommands?.length || 0) +
    (relevant.errorPatterns?.length || 0)
  );
}

function attachMemoryContextToPrompt(state, relevant, hitCount) {
  if (hitCount <= 0 || state.context.routing?.system !== 'system2') {
    return;
  }

  const lines = toSummaryLines(relevant);
  if (lines.length > 0) {
    state.userPrompt += `\n\nRelevant memory context:\n- ${lines.join('\n- ')}`;
  }
}

function setMemorySuccessState(state, relevant, hitCount) {
  state.context.memory = {
    enabled: true,
    hitCount,
    relevant,
  };
  attachMemoryContextToPrompt(state, relevant, hitCount);
  state.messageParts.push(`memory=${hitCount}`);
}

function setMemoryErrorState(state, error) {
  state.context.memory = {
    enabled: true,
    hitCount: 0,
    error: error?.message || String(error),
  };
  state.messageParts.push('memory=0');
}

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]
 * @returns {(state: object) => Promise<object>}
 */
export function createMemoryMiddleware(options = {}) {
  const { enabled = true } = options;

  return async function memoryMiddleware(state) {
    if (!enabled) {
      state.context.memory = { enabled: false, hitCount: 0 };
      return state;
    }

    const queryContext = buildQueryContext(state);

    try {
      const relevant = await getRelevantContext(queryContext);
      const hitCount = countRelevantHits(relevant);
      setMemorySuccessState(state, relevant, hitCount);
    } catch (error) {
      setMemoryErrorState(state, error);
    }

    return state;
  };
}
