/**
 * Harness Ablation Test.
 * Disables middlewares one-at-a-time and compares eval scores to baseline,
 * identifying components whose removal has negligible impact.
 *
 * @module scripts/evals/harness-ablation
 */

import { createArtibotAgent } from '../../lib/runtime/create-artibot-agent.js';
import { createRouterMiddleware } from '../../lib/runtime/middleware/router.js';
import { createMemoryMiddleware } from '../../lib/runtime/middleware/memory.js';
import { createSkillsMiddleware } from '../../lib/runtime/middleware/skills.js';
import { createTasksMiddleware } from '../../lib/runtime/middleware/tasks.js';
import { createSubagentsMiddleware } from '../../lib/runtime/middleware/subagents.js';
import { createSummarizationMiddleware } from '../../lib/runtime/middleware/summarization.js';
import { createGuardrailMiddleware } from '../../lib/runtime/middleware/guardrail.js';
import { createTokenUsageMiddleware } from '../../lib/runtime/middleware/token-usage.js';
import { createCheckpointMiddleware } from '../../lib/runtime/middleware/checkpoint.js';

// ---------------------------------------------------------------------------
// Default middleware registry
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MiddlewareEntry
 * @property {string} name - Middleware identifier
 * @property {Function} factory - Factory function returning middleware
 */

/** @type {MiddlewareEntry[]} */
const DEFAULT_MIDDLEWARES = [
  { name: 'router', factory: () => createRouterMiddleware() },
  { name: 'memory', factory: () => createMemoryMiddleware({ enabled: false }) },
  { name: 'skills', factory: () => createSkillsMiddleware() },
  { name: 'tasks', factory: (opts) => createTasksMiddleware({ now: opts.now }) },
  { name: 'subagents', factory: () => createSubagentsMiddleware() },
  { name: 'guardrail', factory: () => createGuardrailMiddleware() },
  { name: 'summarization', factory: () => createSummarizationMiddleware() },
  { name: 'tokenUsage', factory: (opts) => createTokenUsageMiddleware({ now: opts.now }) },
  { name: 'checkpoint', factory: (opts) => createCheckpointMiddleware({ store: opts.checkpointStore, now: opts.now, persistToDisk: false }) },
];

// ---------------------------------------------------------------------------
// Default eval scenarios (lightweight subset for ablation)
// ---------------------------------------------------------------------------

const DEFAULT_SCENARIOS = [
  { id: 'simple', prompt: 'fix typo in readme' },
  { id: 'complex', prompt: 'analyze security vulnerabilities, then refactor auth flow, then deploy to production' },
  { id: 'implement', prompt: 'implement a new REST API endpoint for user authentication' },
];

const DEFAULT_CONFIG = Object.freeze({
  automation: { supportedLanguages: ['en', 'ko', 'ja'], ambiguityThreshold: 50 },
  team: {
    enabled: true,
    delegationModeSelection: {
      subAgent: { tools: ['Task'], communication: 'one-way (result return only)' },
      agentTeam: {
        tools: ['TeamCreate', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TeamDelete'],
        communication: 'P2P bidirectional + shared task list',
      },
    },
  },
  cognitive: { router: { threshold: 0.4 } },
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single runtime result on heuristic quality signals.
 * Returns a value in [0, 1].
 *
 * @param {object} result - preparePrompt output
 * @returns {number}
 */
function scoreResult(result) {
  let score = 0;
  let checks = 0;

  // Has routing info
  checks += 1;
  if (result.context?.routing?.system) score += 1;

  // Has intent
  checks += 1;
  if (result.context?.intent) score += 1;

  // Has skills suggestion
  checks += 1;
  if (result.context?.skills?.suggested?.length > 0) score += 1;

  // Prompt was rewritten (longer than original)
  checks += 1;
  if (result.userPrompt && result.userPrompt.length > 20) score += 1;

  // Has message summary
  checks += 1;
  if (result.message && result.message.includes('[runtime]')) score += 1;

  // Has subagent contract
  checks += 1;
  if (result.context?.subagents?.contract) score += 1;

  return checks > 0 ? Math.round((score / checks) * 100) / 100 : 0;
}

/**
 * Run scenarios against a given middleware stack and return average score.
 *
 * @param {Function[]} middleware - Middleware array
 * @param {object[]} scenarios - Scenarios to run
 * @param {object} runtimeConfig - Config for createArtibotAgent
 * @returns {Promise<object>} Object with scores map and average number.
 */
async function evalWithMiddleware(middleware, scenarios, runtimeConfig) {
  const now = runtimeConfig.now || Date.now;
  const runtime = createArtibotAgent({
    config: runtimeConfig.config || DEFAULT_CONFIG,
    now,
    checkpointStore: new Map(),
    middleware,
  });

  const scores = {};
  for (const scenario of scenarios) {
    const result = await runtime.preparePrompt({
      prompt: scenario.prompt,
      hookData: { event: 'UserPromptSubmit' },
    });
    scores[scenario.id] = scoreResult(result);
  }

  const values = Object.values(scores);
  const average = values.length > 0
    ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100
    : 0;

  return { scores, average };
}

// ---------------------------------------------------------------------------
// Ablation runner
// ---------------------------------------------------------------------------

/**
 * Build the full middleware stack from entries.
 *
 * @param {MiddlewareEntry[]} entries
 * @param {object} factoryOpts
 * @returns {Function[]}
 */
function buildStack(entries, factoryOpts) {
  return entries.map((e) => e.factory(factoryOpts));
}

/**
 * Run ablation test: baseline with all middlewares, then remove one at a time.
 *
 * @param {object} [config]
 * @param {MiddlewareEntry[]} [config.middlewares] - Middleware entries to test
 * @param {object[]} [config.scenarios] - Eval scenarios
 * @param {number} [config.threshold=0.05] - Delta threshold for removal candidate
 * @param {object} [config.runtimeConfig] - Runtime config overrides
 * @param {Function} [config.now] - Clock injection
 * @returns {Promise<object>} Ablation result with baseline, per-middleware results, and removeCandidates list.
 */
export async function runAblationTest(config = {}) {
  const entries = config.middlewares || DEFAULT_MIDDLEWARES;
  const scenarios = config.scenarios || DEFAULT_SCENARIOS;
  const threshold = config.threshold ?? 0.05;
  const now = config.now || Date.now;
  const checkpointStore = new Map();
  const factoryOpts = { now, checkpointStore };
  const runtimeConfig = { config: config.runtimeConfig || DEFAULT_CONFIG, now };

  // Baseline: all middlewares active
  const fullStack = buildStack(entries, factoryOpts);
  const baseline = await evalWithMiddleware(fullStack, scenarios, runtimeConfig);

  // Ablation: remove one middleware at a time
  const results = [];
  for (const entry of entries) {
    const reduced = entries.filter((e) => e.name !== entry.name);
    const stack = buildStack(reduced, { now, checkpointStore: new Map() });
    const ablated = await evalWithMiddleware(stack, scenarios, runtimeConfig);
    const delta = Math.round((baseline.average - ablated.average) * 100) / 100;

    results.push({
      name: entry.name,
      scores: ablated.scores,
      average: ablated.average,
      delta,
    });
  }

  // Identify removal candidates (delta below threshold)
  const removeCandidates = results
    .filter((r) => Math.abs(r.delta) < threshold)
    .map((r) => r.name);

  return { baseline, results, removeCandidates };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/**
 * Format ablation results as a human-readable table.
 *
 * @param {object} ablation - Result from runAblationTest
 * @returns {string}
 */
export function formatAblationReport(ablation) {
  const lines = [
    'HARNESS ABLATION REPORT',
    '=======================',
    `Baseline avg score: ${ablation.baseline.average}`,
    '',
    'Middleware              | Baseline | Ablated | Delta',
    '-----------------------|----------|---------|------',
  ];

  for (const r of ablation.results) {
    const name = r.name.padEnd(23);
    const bl = String(ablation.baseline.average).padStart(8);
    const ab = String(r.average).padStart(7);
    const dt = (r.delta >= 0 ? `+${r.delta}` : String(r.delta)).padStart(6);
    lines.push(`${name}| ${bl} | ${ab} | ${dt}`);
  }

  if (ablation.removeCandidates.length > 0) {
    lines.push('');
    lines.push(`Remove candidates (|delta| < threshold): ${ablation.removeCandidates.join(', ')}`);
  } else {
    lines.push('');
    lines.push('No removal candidates — all middlewares contribute significantly.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  DEFAULT_MIDDLEWARES,
  DEFAULT_SCENARIOS,
  DEFAULT_CONFIG,
  scoreResult as _scoreResult,
  evalWithMiddleware as _evalWithMiddleware,
  buildStack as _buildStack,
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const result = await runAblationTest();
  const report = formatAblationReport(result);
  process.stdout.write(report + '\n');

  if (result.removeCandidates.length > 0) {
    process.stdout.write(`\n${result.removeCandidates.length} middleware(s) may be removable.\n`);
  }
}

// Only run when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[ablation] ${err.message || err}\n`);
    process.exit(1);
  });
}
