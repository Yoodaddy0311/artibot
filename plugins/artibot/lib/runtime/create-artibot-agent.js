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
import { createGuardrailMiddleware } from './middleware/guardrail.js';
import { createTokenUsageMiddleware } from './middleware/token-usage.js';
import { createCheckpointMiddleware } from './middleware/checkpoint.js';
import { createLifecycleMiddleware } from './middleware/lifecycle.js';
import { createSmartPipelineMiddleware } from './smart-pipeline.js';
import { createRateSentinel } from '../orchestration/rate-sentinel.js';

const FALLBACK_CONFIG = Object.freeze({
  automation: { supportedLanguages: ['en', 'ko', 'ja'], ambiguityThreshold: 50 },
  team: { enabled: true },
  cognitive: { router: { threshold: 0.4 } },
});

function summarizeMessage(parts) {
  const core = parts.filter(Boolean).slice(0, 9).join(' | ');
  return core ? `[runtime] ${core}` : '[runtime] prepared';
}

function normalizePrompt(prompt, hookData) {
  const fromHook = hookData?.user_prompt || hookData?.content || '';
  const value = typeof prompt === 'string' && prompt.length > 0 ? prompt : fromHook;
  return String(value || '').trim();
}

/**
 * Run a single middleware with error boundary.
 * On failure, logs to stderr and returns state unchanged (graceful degradation).
 *
 * @param {string} name - Middleware name for error reporting
 * @param {Function} fn - Middleware function
 * @param {object} state - Pipeline state
 * @returns {Promise<object>} state (possibly unchanged on error)
 */
async function runMiddleware(name, fn, state) {
  const skipped = state.context.smartPipeline?.skipped;
  if (Array.isArray(skipped) && skipped.includes(name)) {
    state.messageParts.push(`${name}=skipped`);
    return state;
  }
  try {
    await fn(state);
  } catch (err) {
    process.stderr.write(`[artibot:middleware:${name}] ${err?.message || err}\n`);
    state.messageParts.push(`${name}=error`);
  }
  return state;
}

/**
 * Run multiple independent middlewares in parallel on a shared state.
 * Each middleware writes to distinct context keys, so parallel execution is safe.
 * userPrompt appends and messageParts pushes are collected per-middleware
 * and merged sequentially afterward to preserve deterministic ordering.
 *
 * @param {Array<[string, Function]>} entries - [name, fn] pairs
 * @param {object} state - Pipeline state
 * @returns {Promise<void>}
 */
async function runParallel(entries, state) {
  const basePrompt = state.userPrompt;

  const results = await Promise.all(entries.map(async ([name, fn]) => {
    const localState = {
      ...state,
      userPrompt: basePrompt,
      messageParts: [],
      context: { ...state.context },
      config: state.config,
      input: state.input,
    };
    await runMiddleware(name, fn, localState);
    return {
      promptSuffix: localState.userPrompt.slice(basePrompt.length),
      messageParts: localState.messageParts,
      context: localState.context,
    };
  }));

  let prompt = basePrompt;
  for (const r of results) {
    prompt += r.promptSuffix;
    state.messageParts.push(...r.messageParts);
    Object.assign(state.context, r.context);
  }
  state.userPrompt = prompt;
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
  const customMiddleware = options.middleware || null;

  const mwRouter = createRouterMiddleware(middlewareOptions.router);
  const mwMemory = createMemoryMiddleware(middlewareOptions.memory);
  const mwSkills = createSkillsMiddleware(middlewareOptions.skills);
  const mwTasks = createTasksMiddleware({ now, ...(middlewareOptions.tasks || {}) });
  const mwSubagents = createSubagentsMiddleware(middlewareOptions.subagents);
  const mwSummarization = createSummarizationMiddleware(middlewareOptions.summarization);
  const mwGuardrail = createGuardrailMiddleware(middlewareOptions.guardrail);
  const mwTokenUsage = createTokenUsageMiddleware({ now, ...(middlewareOptions.tokenUsage || {}) });
  const mwCheckpoint = createCheckpointMiddleware({
    store: checkpointStore,
    now,
    ...(middlewareOptions.checkpoint || {}),
    ...(options.checkpointOptions || {}),
  });
  const mwLifecycle = createLifecycleMiddleware({ now, ...(middlewareOptions.lifecycle || {}) });
  const mwSmartPipeline = createSmartPipelineMiddleware(middlewareOptions.smartPipeline);

  // TODO: bridge config.runtime.middleware — the config defines a middleware
  // list intended to make this pipeline configurable. Implementing dynamic
  // middleware loading requires a registry + ordering/dependency resolution.
  // For now the pipeline is hardcoded below.
  const allMiddleware = customMiddleware || [
    mwLifecycle,
    mwSmartPipeline,
    mwRouter, mwMemory, mwSkills, mwTasks,
    mwSubagents, mwGuardrail, mwSummarization,
    mwTokenUsage, mwCheckpoint,
  ];

  const configPromise = options.config
    ? Promise.resolve(options.config)
    : loadConfig().catch(() => FALLBACK_CONFIG);

  return {
    // eslint-disable-next-line complexity
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
            middleware: allMiddleware.map((fn) => fn.name || 'anonymous'),
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

      if (customMiddleware) {
        for (const apply of customMiddleware) {
          await runMiddleware(apply.name || 'anonymous', apply, state);
        }
      } else {
        // Phase 0: lifecycle setup (outermost — runs first, teardown context recorded)
        await runMiddleware('lifecycle', mwLifecycle, state);
        // Phase 0.5: smart pipeline (may mark middlewares to skip)
        await runMiddleware('smartPipeline', mwSmartPipeline, state);
        // Phase 1: router (all others depend on routing/intent)
        await runMiddleware('router', mwRouter, state);
        // Phase 2: memory, skills, tasks (independent, only read router output)
        await runParallel([
          ['memory', mwMemory],
          ['skills', mwSkills],
          ['tasks', mwTasks],
        ], state);
        // Phase 3: subagents (depends on tasks)
        await runMiddleware('subagents', mwSubagents, state);
        // Phase 3.5: (reserved for future middleware)
        // Phase 4: guardrail (reads subagents/tasks tool lists + ACI constraints)
        await runMiddleware('guardrail', mwGuardrail, state);
        // Phase 5: summarization (reads final userPrompt)
        await runMiddleware('summarization', mwSummarization, state);
        // Phase 6: token-usage + checkpoint (independent, read all context)
        await runParallel([
          ['tokenUsage', mwTokenUsage],
          ['checkpoint', mwCheckpoint],
        ], state);
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
