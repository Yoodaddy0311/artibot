/**
 * Runtime router middleware.
 * Classifies prompt complexity and intent, then rewrites prompt for System 1/2.
 *
 * @module lib/runtime/middleware/router
 */

import { emit } from '../../core/event-bus.js';
import { classifyComplexity } from '../../cognitive/router.js';
import { detectIntent } from '../../intent/index.js';
import { detectMode, applyMode, MODES } from '../../cognitive/context-modes.js';

/**
 * @param {object} [options]
 * @returns {(state: object) => Promise<object>}
 */
export function createRouterMiddleware(options = {}) {
  const {
    system1Prefix = 'System 1 mode: answer directly and keep it concise.',
    system2Prefix = 'System 2 mode: use plan-execute-reflect and reason step-by-step.',
  } = options;

  return async function routerMiddleware(state) {
    const input = state.userPrompt;
    const automation = state.config?.automation || {};

    const intent = detectIntent(input, {
      languages: automation.supportedLanguages,
      ambiguityThreshold: automation.ambiguityThreshold,
    });
    const classification = classifyComplexity(input, {
      sessionDepth: state.context?.runtime?.sessionDepth || 0,
    });
    const system = classification.system === 2 ? 'system2' : 'system1';

    state.context.routing = {
      ...classification,
      system,
    };

    state.context.intent = {
      intents: intent.intents,
      best: intent.best?.intent || null,
      commands: intent.best?.commands || [],
      agents: intent.best?.agents || [],
      ambiguous: Boolean(intent.ambiguity?.ambiguous),
      ambiguityScore: intent.ambiguity?.score ?? 0,
    };

    const rewritten = [
      system === 'system2' ? system2Prefix : system1Prefix,
      'Original request:',
      input,
    ].join('\n');
    state.userPrompt = rewritten;

    state.messageParts.push(`route=${system.toUpperCase()}`);
    if (state.context.intent.best) {
      state.messageParts.push(`intent=${state.context.intent.best}`);
    }

    emit('feature:cognitive-route', { detail: `${system} (score ${classification.score ?? 0})` });

    return state;
  };
}

