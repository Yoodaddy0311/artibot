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
import { extractUserPromptText } from '../core/hook-utils.js';
import { createExtensionRegistry } from '../core/extension.js';
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
import { createCacheRoiMiddleware } from './middleware/cache-roi.js';
import { createSmartPipeline } from './smart-pipeline.js';

const FALLBACK_CONFIG = Object.freeze({
  automation: { supportedLanguages: ['en', 'ko', 'ja'], ambiguityThreshold: 50 },
  team: { enabled: true },
  cognitive: { router: { threshold: 0.4 } },
});

function summarizeMessage(parts) {
  const core = parts.filter(Boolean).slice(0, 9).join(' | ');
  return core ? `[runtime] ${core}` : '[runtime] prepared';
}

// The explicit `prompt` argument wins; `hookData` is only the fallback for
// callers that pass a payload and no text. That fallback read the same two
// wrong keys (`user_prompt` / `content`) as the five broken hook call sites,
// so it goes through the same measured extractor — see
// `lib/core/hook-utils.js#extractUserPromptText`.
function normalizePrompt(prompt, hookData) {
  const fromHook = extractUserPromptText(hookData);
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
 * Compute the smart-pipeline skip list after the router has populated
 * state.context.routing. Returns the array of middleware names to skip
 * (router/lifecycle excluded — they already executed). Pure helper so the
 * preparePrompt pipeline stays within complexity limits.
 *
 * @param {object} smartPipeline - createSmartPipeline() instance
 * @param {string[]} defaultPipeline - ordered default middleware names
 * @param {object} state - Pipeline state (reads state.context.routing/planMode/mode)
 * @returns {string[]} middleware names to skip
 */
function computeSmartSkips(smartPipeline, defaultPipeline, state) {
  const selected = new Set(smartPipeline.selectMiddlewares({
    intent: state.context.routing?.intent || '',
    system: state.context.routing?.system || 'system1',
    mode: state.context.planMode?.active ? 'plan' : (state.context.mode || 'dev'),
    complexity: state.context.routing?.score ?? 0,
  }).map((m) => m.name));
  return defaultPipeline.filter((n) => n !== 'router' && n !== 'lifecycle' && !selected.has(n));
}

/**
 * Apply the smart-pipeline skip list onto state (no-op when disabled or when a
 * custom middleware chain is in use). Kept as a helper so preparePrompt stays
 * within complexity limits.
 */
function applySmartPipeline(state, { smartEnabled, customMiddleware, smartPipeline, defaultPipeline }) {
  if (!smartEnabled || customMiddleware) return;
  state.context.smartPipeline = {
    skipped: computeSmartSkips(smartPipeline, defaultPipeline, state),
  };
}

/**
 * Build [name, fn] entries for a parallel phase, filtered by the enabled set.
 * specs are [enabledKey, entryName, fn] tuples; enabledKey gates inclusion and
 * entryName labels the middleware for runParallel/runMiddleware.
 */
function buildParallelEntries(isEnabled, specs) {
  return specs
    .filter(([enabledKey]) => isEnabled(enabledKey))
    .map(([, entryName, fn]) => [entryName, fn]);
}

/**
 * Execute extension hooks registered for a given event.
 * Each handler receives the pipeline state and runs with an error boundary.
 * Failures are logged but do not break the pipeline (graceful degradation).
 *
 * @param {object} registry - Extension registry instance
 * @param {string} event - Hook event name (e.g. 'pre-command', 'post-execute')
 * @param {object} state - Pipeline state
 * @returns {Promise<void>}
 */
async function runExtensionHooks(registry, event, state) {
  if (!registry) return;
  const handlers = registry.getHooksForEvent(event);
  if (handlers.length === 0) return;

  for (const handler of handlers) {
    try {
      await handler(state);
    } catch (err) {
      process.stderr.write(`[artibot:extension-hook:${event}] ${err?.message || err}\n`);
      state.messageParts.push(`ext-hook:${event}=error`);
    }
  }
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
 * @param {object} [options.extensionRegistry] - Pre-created extension registry. If omitted, a new one is created.
 * @returns {{
 *   preparePrompt: ({ prompt, hookData }: { prompt: string, hookData?: object }) => Promise<{
 *     userPrompt: string,
 *     message: string,
 *     context: object
 *   }>,
 *   extensions: object
 * }}
 */
export function createArtibotAgent(options = {}) {
  const now = options.now || Date.now;
  const checkpointStore = options.checkpointStore || new Map();
  const middlewareOptions = options.middlewareOptions || {};
  const extensions = options.extensionRegistry || createExtensionRegistry();

  const backend = options.backend || createCompositeBackend(options.backendOptions);
  const customMiddleware = options.middleware || null;

  const mwRouter = createRouterMiddleware(middlewareOptions.router);
  const mwMemory = createMemoryMiddleware(middlewareOptions.memory);
  const mwSkills = createSkillsMiddleware({
    ...middlewareOptions.skills,
    extensionRegistry: extensions,
  });
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
  const mwCacheRoi = createCacheRoiMiddleware({ now, ...(middlewareOptions.cacheRoi || {}) });

  // Middleware registry — maps config names to instances for config-driven filtering.
  const middlewareRegistry = Object.freeze({
    'lifecycle': mwLifecycle,
    'router': mwRouter,
    'memory': mwMemory,
    'skills': mwSkills,
    'tasks': mwTasks,
    'subagents': mwSubagents,
    'guardrail': mwGuardrail,
    'summarization': mwSummarization,
    'token-usage': mwTokenUsage,
    'checkpoint': mwCheckpoint,
    'cache-roi': mwCacheRoi,
  });

  // Default pipeline names (determines execution order). Order is intentional:
  //   1. lifecycle  — telemetry / session housekeeping (no state mutation).
  //   2. router     — classifies System 1/2 and intent. Writes state.context.routing
  //                   and state.context.intent that downstream stages depend on.
  //   3. memory     — loads relevant memory before skills/tasks build context.
  //   4. skills     — uses routing.intent to select skill bundles.
  //   5. tasks      — derives workflowPlan from routing + intent.recommendations
  //                   (so it MUST come after router; see workflow-plan.js).
  //   6. subagents  — chooses teammate fan-out from the workflowPlan.
  //   7. guardrail  — clips/sanitizes the (possibly very long) composed prompt
  //                   BEFORE summarization to bound token spend.
  //   8. summarization — compacts the guarded prompt for the final assistant call.
  //   9. token-usage — records the post-summarization token estimate.
  //  10. checkpoint  — persists durable state once the prompt is finalized.
  //  11. cache-roi   — emits cache-hit telemetry (read-only, last to run).
  const defaultPipeline = [
    'lifecycle',
    'router', 'memory', 'skills', 'tasks',
    'subagents', 'guardrail', 'summarization',
    'token-usage', 'checkpoint', 'cache-roi',
  ];

  // Smart pipeline (Zero-Waste): opt-in condition-based middleware selection.
  // Default OFF — behavior unchanged unless options.smart or config.runtime.smartPipeline is true.
  const smartConditions = options.config?.runtime?.middlewareConditions || {};
  const smartPipeline = createSmartPipeline(
    defaultPipeline.map((name) => ({ name, fn: middlewareRegistry[name], conditions: smartConditions[name] })),
  );
  const smartEnabled = options.smart === true || options.config?.runtime?.smartPipeline === true;

  // Resolve enabled middleware set from config.
  // When config.runtime.middleware is a non-empty array, only listed middleware runs.
  // When absent or empty, all default middleware runs (backward compatible).
  const configList = options.config?.runtime?.middleware;
  const enabledMiddleware = (Array.isArray(configList) && configList.length > 0)
    ? new Set(configList.filter((name) => name in middlewareRegistry))
    : new Set(defaultPipeline);

  const allMiddleware = customMiddleware ||
    defaultPipeline
      .filter((name) => enabledMiddleware.has(name))
      .map((name) => middlewareRegistry[name]);

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
          pluginRoot: options.pluginRoot,
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
        const isEnabled = (name) => enabledMiddleware.has(name);

        // Phase 0: lifecycle setup (outermost — runs first, teardown context recorded)
        if (isEnabled('lifecycle')) await runMiddleware('lifecycle', mwLifecycle, state);
        // Phase 1: router (all others depend on routing/intent)
        if (isEnabled('router')) await runMiddleware('router', mwRouter, state);
        // Phase 1.5: smart-pipeline PRODUCER — after router populates state.context.routing,
        // compute the skip list the runMiddleware() guard consumes (default OFF).
        applySmartPipeline(state, { smartEnabled, customMiddleware, smartPipeline, defaultPipeline });
        // Phase 2: memory, skills, tasks (independent, only read router output)
        const phase2 = [
          ['memory', mwMemory],
          ['skills', mwSkills],
          ['tasks', mwTasks],
        ].filter(([name]) => isEnabled(name));
        if (phase2.length > 0) await runParallel(phase2, state);
        // Phase 3: subagents (depends on tasks)
        if (isEnabled('subagents')) await runMiddleware('subagents', mwSubagents, state);
        // Phase 3.5: extension hooks (run registered pre-command hooks)
        await runExtensionHooks(extensions, 'pre-command', state);
        // Phase 4: guardrail (reads subagents/tasks tool lists + ACI constraints)
        if (isEnabled('guardrail')) await runMiddleware('guardrail', mwGuardrail, state);
        // Phase 5: summarization (reads final userPrompt)
        if (isEnabled('summarization')) await runMiddleware('summarization', mwSummarization, state);
        // Phase 6: token-usage + checkpoint + cache-roi (independent, read all context)
        const phase6 = buildParallelEntries(isEnabled, [
          ['token-usage', 'tokenUsage', mwTokenUsage],
          ['checkpoint', 'checkpoint', mwCheckpoint],
          ['cache-roi', 'cacheRoi', mwCacheRoi],
        ]);
        if (phase6.length > 0) await runParallel(phase6, state);
      }

      const selectedBackend = backend.selectBackend(state.context);
      state.context.backend = {
        selected: selectedBackend?.id || 'local',
        available: Object.keys(backend.backends || {}),
      };

      // Post-pipeline extension hooks
      await runExtensionHooks(extensions, 'post-execute', state);

      return {
        userPrompt: state.userPrompt,
        message: summarizeMessage(state.messageParts),
        context: state.context,
      };
    },

    /** Extension registry — register/unregister skills and hooks at runtime. */
    extensions,
  };
}
