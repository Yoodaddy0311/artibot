/**
 * Runtime router middleware.
 * Classifies prompt complexity and intent, then rewrites prompt for System 1/2.
 *
 * @module lib/runtime/middleware/router
 */

import { emit } from '../../core/event-bus.js';
import { classifyComplexity } from '../../cognitive/router.js';
import { detectIntent } from '../../intent/index.js';
import { recordRoutingDecision, resolveDecisionRunId } from '../../observability/decision-events.js';

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

    // Explainability (D5) — observe-only, swallows its own failures, records no
    // prompt text. This is the classification that actually runs on every
    // prompt; `router.js#route()` wraps the same call with a trail write but
    // nothing in production calls it (measured 2026-08-28).
    //
    // The session id is read from `state.input`, not `state.context`: the hook
    // payload is stored there (`create-artibot-agent.js#preparePrompt`), and
    // `state.context` never carries it. Passing the wrong one is silent — the
    // recorder counts a `skipped` and returns null — which is how this recorded
    // 0 of 2 decisions until 2026-08-29.
    recordRoutingDecision(resolveDecisionRunId(state.input), classification);

    state.context.intent = {
      intents: intent.intents,
      best: intent.best?.intent || null,
      commands: intent.best?.commands || [],
      agents: intent.best?.agents || [],
      // Preserve the full per-recommendation list so the downstream tasks
      // middleware can derive parallel teammates via
      // workflow-plan.js#extractSubObjectives. Without this the workflow plan
      // always saw zero sub-objectives → empty teammates → no team directive
      // ("parallel-not-spawned"). `best` stays a string and commands/agents
      // stay top-level so existing string consumers (bin/artibot.js, eval
      // suite) are unaffected.
      recommendations: Array.isArray(intent.recommendations) ? intent.recommendations : [],
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

