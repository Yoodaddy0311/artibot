/**
 * Phase 1 runtime factory for hook-time prompt preparation.
 *
 * API contract:
 * - export function createArtibotAgent(options = {})
 * - returned object has async preparePrompt({ prompt, hookData })
 * - preparePrompt returns { userPrompt, message, context }
 *
 * @module lib/runtime/create-artibot-agent
 */

import { loadConfig } from '../core/config.js';
import { createCompositeBackend } from './backend/composite-backend.js';
import { createRouterMiddleware } from './middleware/router.js';
import { createMemoryMiddleware } from './middleware/memory.js';
import { createSkillsMiddleware } from './middleware/skills.js';
import { createTasksMiddleware } from './middleware/tasks.js';
import { createSubagentsMiddleware } from './middleware/subagents.js';
import { createSummarizationMiddleware } from './middleware/summarization.js';
import { createCheckpointMiddleware } from './middleware/checkpoint.js';

const FALLBACK_CONFIG = Object.freeze({
  automation: { supportedLanguages: ['en', 'ko', 'ja'], ambiguityThreshold: 50 },
  team: { enabled: true },
  cognitive: { router: { threshold: 0.4 } },
});

function summarizeMessage(parts) {
  const core = parts.filter(Boolean).slice(0, 6).join(' | ');
  return core ? `[runtime] ${core}` : '[runtime] prepared';
}

function normalizePrompt(prompt, hookData) {
  const fromHook = hookData?.user_prompt || hookData?.content || '';
  const value = typeof prompt === 'string' && prompt.length > 0 ? prompt : fromHook;
  return String(value || '').trim();
}

/**
 * Create an Artibot runtime agent instance for hook integration.
 *
 * @param {object} [options]
 * @param {object} [options.config] - Optional preloaded config override.
 * @param {Map<string, object>} [options.checkpointStore] - Shared checkpoint store.
 * @param {object} [options.backend] - Optional backend instance.
 * @param {Function[]} [options.middleware] - Optional custom middleware chain.
 * @param {() => number} [options.now] - Clock injection for deterministic tests.
 * @returns {{
 *   preparePrompt: ({ prompt, hookData }: { prompt: string, hookData?: object }) => Promise<{
 *     userPrompt: string,
 *     message: string,
 *     context: object
 *   }>
 * }}
 */
export function createArtibotAgent(options = {}) {
  const now = options.now || Date.now;
  const checkpointStore = options.checkpointStore || new Map();
  const middlewareOptions = options.middlewareOptions || {};

  const backend = options.backend || createCompositeBackend(options.backendOptions);
  const middleware = options.middleware || [
    createRouterMiddleware(middlewareOptions.router),
    createMemoryMiddleware(middlewareOptions.memory),
    createSkillsMiddleware(middlewareOptions.skills),
    createTasksMiddleware({ now, ...(middlewareOptions.tasks || {}) }),
    createSubagentsMiddleware(middlewareOptions.subagents),
    createSummarizationMiddleware(middlewareOptions.summarization),
    createCheckpointMiddleware({
      store: checkpointStore,
      now,
      ...(middlewareOptions.checkpoint || {}),
      ...(options.checkpointOptions || {}),
    }),
  ];

  const configPromise = options.config
    ? Promise.resolve(options.config)
    : loadConfig().catch(() => FALLBACK_CONFIG);

  return {
    async preparePrompt({ prompt, hookData } = {}) {
      const normalizedPrompt = normalizePrompt(prompt, hookData);
      const config = await configPromise;

      const state = {
        input: {
          prompt: normalizedPrompt,
          hookData: hookData || {},
        },
        userPrompt: normalizedPrompt,
        messageParts: [],
        config,
        context: {
          runtime: {
            name: 'artibot-runtime-phase1',
            preparedAt: new Date(now()).toISOString(),
            middleware: middleware.map((fn) => fn.name || 'anonymous'),
          },
          hook: {
            event: hookData?.event || 'UserPromptSubmit',
          },
          config: {
            threshold: config?.cognitive?.router?.threshold ?? 0.4,
            teamEnabled: Boolean(config?.team?.enabled),
            ambiguityThreshold: config?.automation?.ambiguityThreshold ?? 50,
          },
        },
      };

      if (!normalizedPrompt) {
        return {
          userPrompt: '',
          message: '[runtime] empty prompt',
          context: state.context,
        };
      }

      for (const apply of middleware) {
        await apply(state);
      }

      const selectedBackend = backend.selectBackend(state.context);
      state.context.backend = {
        selected: selectedBackend?.id || 'local',
        available: Object.keys(backend.backends || {}),
      };

      return {
        userPrompt: state.userPrompt,
        message: summarizeMessage(state.messageParts),
        context: state.context,
      };
    },
  };
}
