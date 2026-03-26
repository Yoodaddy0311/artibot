/**
 * Runtime task evaluation helpers.
 * Provides scenario-driven scoring for the rebuilt Artibot runtime path.
 *
 * @module lib/runtime/evaluator
 */

import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createArtibotAgent } from './create-artibot-agent.js';
import { createRouterMiddleware } from './middleware/router.js';
import { createMemoryMiddleware } from './middleware/memory.js';
import { createSkillsMiddleware } from './middleware/skills.js';
import { createTasksMiddleware } from './middleware/tasks.js';
import { createSubagentsMiddleware } from './middleware/subagents.js';
import { createSummarizationMiddleware } from './middleware/summarization.js';
import { createCheckpointMiddleware } from './middleware/checkpoint.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';
import { ARTIBOT_DIR } from '../core/config.js';
import { getPluginRoot } from '../core/platform.js';

const execFile = promisify(execFileCb);

const TEST_CONFIG = Object.freeze({
  automation: {
    supportedLanguages: ['en', 'ko', 'ja'],
    ambiguityThreshold: 50,
  },
  team: {
    enabled: true,
    delegationModeSelection: {
      subAgent: {
        tools: ['Task'],
        communication: 'one-way (result return only)',
      },
      agentTeam: {
        tools: ['TeamCreate', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TeamDelete'],
        communication: 'P2P bidirectional + shared task list',
      },
    },
  },
  cognitive: {
    router: {
      threshold: 0.4,
    },
  },
});

function makeAssertion(name, passed, detail, options = {}) {
  return {
    name,
    passed: Boolean(passed),
    detail,
    critical: options.critical ?? true,
  };
}

function scoreAssertions(assertions) {
  if (!assertions.length) return 0;
  const passed = assertions.filter((item) => item.passed).length;
  return Math.round((passed / assertions.length) * 100) / 100;
}

function getDefaultReportPath() {
  return path.join(ARTIBOT_DIR, 'runtime', 'evals', 'runtime-task-suite.json');
}

export function getDefaultRepoRuntimeReportPath() {
  return path.join(getPluginRoot(), '_reports', 'runtime-task-suite.json');
}

export function getDefaultRuntimeComparisonJsonPath() {
  return path.join(getPluginRoot(), '_reports', 'runtime-eval-comparison.json');
}

export function getDefaultRuntimeComparisonMarkdownPath() {
  return path.resolve(getPluginRoot(), '..', '..', '_benchmarks', 'runtime-eval-comparison.md');
}

function createRuntime(options = {}) {
  const now = options.now || Date.now;
  const checkpointStore = options.checkpointStore || new Map();
  const middleware = [
    createRouterMiddleware(),
    createMemoryMiddleware({ enabled: false }),
    createSkillsMiddleware(),
    createTasksMiddleware({ now }),
    createSubagentsMiddleware(),
    createSummarizationMiddleware(),
    createCheckpointMiddleware({
      store: checkpointStore,
      now,
      persistToDisk: false,
      ...(options.checkpointOptions || {}),
    }),
  ];

  return createArtibotAgent({
    config: TEST_CONFIG,
    now,
    checkpointStore,
    middleware,
    ...options,
  });
}

async function runRuntimePrompt(prompt, options = {}) {
  const runtime = createRuntime(options);
  return runtime.preparePrompt({
    prompt,
    hookData: {
      event: 'UserPromptSubmit',
      ...(options.hookData || {}),
    },
  });
}

async function runHook(scriptName, payload, options = {}) {
  const pluginRoot = options.pluginRoot || getPluginRoot();
  const scriptPath = path.join(pluginRoot, 'scripts', 'hooks', scriptName);
  const timeout = options.timeout ?? 30_000;
  const { stdout } = await execFile(process.execPath, [scriptPath], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
      ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
    },
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout,
  });

  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

async function runHookChain(prompt, options = {}) {
  const basePayload = { user_prompt: prompt, event: 'UserPromptSubmit' };
  const firstOutput = await runHook('user-prompt-handler.js', basePayload, options);
  const runtimePayload = {
    ...basePayload,
    user_prompt: firstOutput?.user_prompt || prompt,
  };
  const runtimeOutput = await runHook('runtime-prompt.js', runtimePayload, options);
  return { firstOutput, runtimeOutput };
}

async function runCheckpointScenario() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artibot-runtime-eval-'));
  const filePath = path.join(dir, 'checkpoints.json');

  try {
    const result = await runRuntimePrompt(
      'analyze security vulnerabilities, then refactor auth flow, then deploy to production',
      {
        checkpointOptions: {
          persistToDisk: true,
          filePath,
        },
      },
    );
    const persisted = JSON.parse(await readFile(filePath, 'utf-8'));
    return { result, persisted, filePath };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runMiddlewarePipelineScenario() {
  const results = await Promise.all([
    runRuntimePrompt('fix typo in readme'),
    runRuntimePrompt('analyze security vulnerabilities, then refactor auth flow, then deploy to production'),
    runRuntimePrompt('implement a new REST API endpoint for user authentication'),
  ]);
  return results;
}

async function runErrorRecoveryScenario() {
  const failingMiddleware = async (_state) => {
    throw new Error('simulated middleware failure');
  };
  Object.defineProperty(failingMiddleware, 'name', { value: 'failingMiddleware' });

  const runtime = createArtibotAgent({
    config: TEST_CONFIG,
    now: Date.now,
    checkpointStore: new Map(),
    middleware: [
      createRouterMiddleware(),
      failingMiddleware,
      createSkillsMiddleware(),
      createTasksMiddleware({ now: Date.now }),
      createSubagentsMiddleware(),
      createSummarizationMiddleware(),
      createCheckpointMiddleware({ store: new Map(), now: Date.now, persistToDisk: false }),
    ],
  });

  return runtime.preparePrompt({
    prompt: 'build a dashboard with charts and authentication',
    hookData: { event: 'UserPromptSubmit' },
  });
}

async function runSchedulingConfigScenario() {
  const result = await runRuntimePrompt('schedule nightly learning at 2 AM');
  return result;
}

export const DEFAULT_RUNTIME_EVAL_SCENARIOS = [
  {
    id: 'simple-system1',
    name: 'Simple prompt routes through System 1',
    run: () => runRuntimePrompt('fix typo in readme'),
    evaluate: (result) => [
      makeAssertion('route=system1', result.context.routing.system === 'system1', result.context.routing.system),
      makeAssertion('prompt-rewritten', result.userPrompt.includes('System 1 mode'), result.userPrompt),
      makeAssertion('message-summary', result.message.includes('route=SYSTEM1'), result.message),
      makeAssertion('subagent-mode', result.context.subagents.contract.mode === 'subAgent', result.context.subagents.contract.mode),
    ],
  },
  {
    id: 'complex-system2',
    name: 'Complex prompt routes through System 2 with delegation contract',
    run: () => runRuntimePrompt('analyze security vulnerabilities, then refactor auth flow, then deploy to production'),
    evaluate: (result) => [
      makeAssertion('route=system2', result.context.routing.system === 'system2', result.context.routing.system),
      makeAssertion('execution-contract', result.userPrompt.includes('Execution contract:'), result.userPrompt),
      makeAssertion('delegation-contract', result.userPrompt.includes('Delegation contract:'), result.userPrompt),
      makeAssertion('agent-team-mode', result.context.subagents.contract.mode === 'agentTeam', result.context.subagents.contract.mode),
      makeAssertion('requires-plan', result.context.subagents.contract.requiresPlan === true, String(result.context.subagents.contract.requiresPlan)),
    ],
  },
  {
    id: 'command-skill-handoff',
    name: 'Implementation intent maps to command and skill suggestions',
    run: () => runRuntimePrompt('implement a new REST API endpoint for user authentication'),
    evaluate: (result) => [
      makeAssertion('intent=implement', result.context.intent.best === 'action:implement', result.context.intent.best),
      makeAssertion('intent-command', Array.isArray(result.context.intent.commands) && result.context.intent.commands.includes('/implement'), JSON.stringify(result.context.intent.commands)),
      makeAssertion('task-command', result.context.tasks.recommendedCommand === '/implement', String(result.context.tasks.recommendedCommand)),
      makeAssertion('skill-suggested', Array.isArray(result.context.skills.suggested) && result.context.skills.suggested.includes('cmd-implement'), JSON.stringify(result.context.skills.suggested)),
    ],
  },
  {
    id: 'reverify-hook-chain',
    name: 'Re-verification trigger survives the full hook chain',
    run: () => runHookChain('!rv check auth module'),
    evaluate: ({ firstOutput, runtimeOutput }) => [
      makeAssertion('trigger-rewrite', Boolean(firstOutput?.user_prompt?.includes('CRITICAL RE-VERIFICATION MODE')), firstOutput?.user_prompt || 'missing'),
      makeAssertion('runtime-preserves-rewrite', Boolean(runtimeOutput?.user_prompt?.includes('CRITICAL RE-VERIFICATION MODE')), runtimeOutput?.user_prompt || 'missing'),
      makeAssertion('runtime-message', Boolean(runtimeOutput?.message?.includes('[runtime]')), runtimeOutput?.message || 'missing'),
      makeAssertion('runtime-still-runs', Boolean(runtimeOutput), runtimeOutput ? 'present' : 'missing'),
    ],
  },
  {
    id: 'checkpoint-contract',
    name: 'Complex runtime task produces checkpoint and delegation artifacts',
    run: () => runCheckpointScenario(),
    evaluate: ({ result, persisted }) => [
      makeAssertion('checkpoint-id', /^ckpt-/.test(result.context.checkpoint.id), result.context.checkpoint.id),
      makeAssertion('checkpoint-persisted', result.context.checkpoint.persisted === true, String(result.context.checkpoint.persisted)),
      makeAssertion('checkpoint-file-entry', Array.isArray(persisted.entries) && persisted.entries.length === 1, JSON.stringify(persisted)),
      makeAssertion('delegation-tools', Array.isArray(result.context.subagents.contract.tools) && result.context.subagents.contract.tools.length > 0, JSON.stringify(result.context.subagents.contract.tools)),
    ],
  },
  {
    id: 'middleware-pipeline-parallel',
    name: 'Middleware pipeline processes multiple prompts in parallel correctly',
    run: () => runMiddlewarePipelineScenario(),
    evaluate: (results) => [
      makeAssertion('parallel-count', results.length === 3, String(results.length)),
      makeAssertion('system1-route', results[0].context.routing.system === 'system1', results[0].context.routing.system),
      makeAssertion('system2-route', results[1].context.routing.system === 'system2', results[1].context.routing.system),
      makeAssertion('intent-detected', results[2].context.intent.best === 'action:implement', results[2].context.intent.best),
      makeAssertion('all-have-runtime', results.every((r) => r.context.runtime.name === 'artibot-runtime-phase1'), 'all runtime contexts present'),
    ],
  },
  {
    id: 'error-recovery',
    name: 'Middleware failure triggers graceful degradation without crashing',
    run: () => runErrorRecoveryScenario(),
    evaluate: (result) => [
      makeAssertion('did-not-crash', Boolean(result), 'pipeline completed'),
      makeAssertion('has-routing', Boolean(result.context.routing), String(Boolean(result.context.routing))),
      makeAssertion('error-in-message', result.message.includes('error'), result.message),
      makeAssertion('prompt-preserved', result.userPrompt.length > 0, result.userPrompt.slice(0, 80)),
      makeAssertion('skills-still-ran', Boolean(result.context.skills), String(Boolean(result.context.skills))),
    ],
  },
  {
    id: 'scheduling-config',
    name: 'Scheduling-related prompt routes and produces valid runtime context',
    run: () => runSchedulingConfigScenario(),
    evaluate: (result) => [
      makeAssertion('has-routing', Boolean(result.context.routing), String(Boolean(result.context.routing))),
      makeAssertion('has-intent', Boolean(result.context.intent), String(Boolean(result.context.intent))),
      makeAssertion('prompt-processed', result.userPrompt.length > 0, result.userPrompt.slice(0, 80)),
      makeAssertion('runtime-name', result.context.runtime.name === 'artibot-runtime-phase1', result.context.runtime.name),
    ],
  },
];

export async function evaluateRuntimeScenario(scenario) {
  const startedAt = new Date().toISOString();
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  const output = await scenario.run();

  const durationMs = Math.round((performance.now() - t0) * 100) / 100;
  const memAfter = process.memoryUsage().heapUsed;
  const memDeltaBytes = memAfter - memBefore;

  const assertions = scenario.evaluate(output);
  const score = scoreAssertions(assertions);
  const criticalFailures = assertions.filter((item) => item.critical && !item.passed).length;

  return {
    id: scenario.id,
    name: scenario.name,
    startedAt,
    durationMs,
    memDeltaBytes,
    score,
    passed: criticalFailures === 0 && score >= 0.75,
    assertions,
  };
}

const SUITE_TIMEOUT_MS = 120_000;

export async function evaluateRuntimeSuite(scenarios = DEFAULT_RUNTIME_EVAL_SCENARIOS, options = {}) {
  const parallel = options.parallel ?? true;
  const suiteTimeout = options.timeout ?? SUITE_TIMEOUT_MS;
  const suiteT0 = performance.now();

  let results;
  if (parallel) {
    const tasks = scenarios.map((scenario) => evaluateRuntimeScenario(scenario));
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Suite timeout after ${suiteTimeout}ms`)), suiteTimeout),
    );
    results = await Promise.race([Promise.all(tasks), timeoutPromise]);
  } else {
    results = [];
    for (const scenario of scenarios) {
      if (performance.now() - suiteT0 > suiteTimeout) {
        break;
      }
      results.push(await evaluateRuntimeScenario(scenario));
    }
  }

  const suiteDurationMs = Math.round((performance.now() - suiteT0) * 100) / 100;
  const averageScore = results.length > 0
    ? Math.round((results.reduce((sum, item) => sum + item.score, 0) / results.length) * 100) / 100
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    suiteDurationMs,
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    averageScore,
    results,
  };
}

export function formatRuntimeSuiteReport(report) {
  const lines = [
    'RUNTIME TASK EVAL SUITE',
    '=======================',
    `Generated: ${report.generatedAt}`,
    `Scenarios: ${report.total}`,
    `Passed:    ${report.passed}`,
    `Failed:    ${report.failed}`,
    `Avg Score: ${report.averageScore}`,
  ];

  if (report.suiteDurationMs !== null && report.suiteDurationMs !== undefined) {
    lines.push(`Duration:  ${report.suiteDurationMs}ms`);
  }
  lines.push('');

  for (const result of report.results) {
    const timing = result.durationMs !== null && result.durationMs !== undefined ? ` ${result.durationMs}ms` : '';
    const mem = result.memDeltaBytes !== null && result.memDeltaBytes !== undefined ? ` mem=${Math.round(result.memDeltaBytes / 1024)}KB` : '';
    lines.push(`${result.passed ? 'PASS' : 'FAIL'} ${result.id} (${result.score}${timing}${mem})`);
    for (const assertion of result.assertions) {
      lines.push(`  - ${assertion.passed ? 'ok' : 'xx'} ${assertion.name}: ${assertion.detail}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export async function writeRuntimeSuiteReport(report, filePath = getDefaultReportPath()) {
  await writeJsonFile(filePath, report);
  return filePath;
}

function summarizeReport(report) {
  if (!report) return null;
  return {
    generatedAt: report.generatedAt,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    averageScore: report.averageScore,
  };
}

export function buildRuntimeEvalComparison(previousReport, currentReport) {
  const previous = summarizeReport(previousReport);
  const current = summarizeReport(currentReport);

  const previousResults = new Map((previousReport?.results || []).map((item) => [item.id, item]));
  const scenarioDiffs = (currentReport?.results || []).map((item) => {
    const previousItem = previousResults.get(item.id) || null;
    return {
      id: item.id,
      name: item.name,
      currentScore: item.score,
      previousScore: previousItem?.score ?? null,
      deltaScore: previousItem ? Math.round((item.score - previousItem.score) * 100) / 100 : null,
      currentPassed: item.passed,
      previousPassed: previousItem?.passed ?? null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    current,
    previous,
    delta: {
      averageScore: previous ? Math.round((current.averageScore - previous.averageScore) * 100) / 100 : null,
      passed: previous ? current.passed - previous.passed : null,
      failed: previous ? current.failed - previous.failed : null,
    },
    scenarios: scenarioDiffs,
  };
}

export function formatRuntimeEvalComparisonMarkdown(comparison) {
  const lines = [
    '# Runtime Eval Comparison',
    '',
    `\uC0DD\uC131 \uC2DC\uAC01: ${comparison.generatedAt}`,
    '',
  ];

  if (!comparison.previous) {
    lines.push('\uC774\uC804 \uAE30\uC900 \uBCF4\uACE0\uC11C\uAC00 \uC5C6\uC5B4 \uC774\uBC88 \uACB0\uACFC\uB97C baseline\uC73C\uB85C \uAE30\uB85D\uD588\uC2B5\uB2C8\uB2E4.');
    lines.push('');
  }

  lines.push('## \uC694\uC57D');
  lines.push('');
  lines.push('| \uD56D\uBAA9 | \uC774\uC804 | \uD604\uC7AC | \uBCC0\uD654 |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| \uD3C9\uADE0 \uC810\uC218 | ${comparison.previous?.averageScore ?? '-'} | ${comparison.current.averageScore} | ${comparison.delta.averageScore ?? '-'} |`);
  lines.push(`| \uD1B5\uACFC \uC2DC\uB098\uB9AC\uC624 | ${comparison.previous?.passed ?? '-'} | ${comparison.current.passed} | ${comparison.delta.passed ?? '-'} |`);
  lines.push(`| \uC2E4\uD328 \uC2DC\uB098\uB9AC\uC624 | ${comparison.previous?.failed ?? '-'} | ${comparison.current.failed} | ${comparison.delta.failed ?? '-'} |`);
  lines.push('');
  lines.push('## \uC2DC\uB098\uB9AC\uC624\uBCC4 \uBE44\uAD50');
  lines.push('');
  lines.push('| \uC2DC\uB098\uB9AC\uC624 | \uC774\uC804 \uC810\uC218 | \uD604\uC7AC \uC810\uC218 | \uBCC0\uD654 | \uD604\uC7AC \uD1B5\uACFC |');
  lines.push('|---|---:|---:|---:|---|');
  for (const item of comparison.scenarios) {
    lines.push(`| ${item.id} | ${item.previousScore ?? '-'} | ${item.currentScore} | ${item.deltaScore ?? '-'} | ${item.currentPassed ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');

  return lines.join('\n');
}

export async function loadRuntimeSuiteReport(filePath = getDefaultRepoRuntimeReportPath()) {
  return readJsonFile(filePath);
}

export async function writeRuntimeEvalComparisonArtifacts(
  comparison,
  options = {},
) {
  const jsonPath = options.jsonPath || getDefaultRuntimeComparisonJsonPath();
  const markdownPath = options.markdownPath || getDefaultRuntimeComparisonMarkdownPath();
  const markdown = formatRuntimeEvalComparisonMarkdown(comparison);

  await writeJsonFile(jsonPath, comparison);
  await ensureDir(path.dirname(markdownPath));
  await writeFile(markdownPath, markdown + '\n', 'utf-8');
  return { jsonPath, markdownPath, markdown };
}
