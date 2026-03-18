/**
 * Runtime task evaluation helpers.
 * Provides scenario-driven scoring for the rebuilt Artibot runtime path.
 *
 * @module lib/runtime/evaluator
 */

import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

function runHook(scriptName, payload, options = {}) {
  const pluginRoot = options.pluginRoot || getPluginRoot();
  const scriptPath = path.join(pluginRoot, 'scripts', 'hooks', scriptName);
  const stdout = execFileSync(process.execPath, [scriptPath], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
      ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
    },
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  }).trim();

  return stdout ? JSON.parse(stdout) : null;
}

async function runHookChain(prompt, options = {}) {
  const basePayload = { user_prompt: prompt, event: 'UserPromptSubmit' };
  const firstOutput = runHook('user-prompt-handler.js', basePayload, options);
  const runtimePayload = {
    ...basePayload,
    user_prompt: firstOutput?.user_prompt || prompt,
  };
  const runtimeOutput = runHook('runtime-prompt.js', runtimePayload, options);
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
];

export async function evaluateRuntimeScenario(scenario) {
  const startedAt = new Date().toISOString();
  const output = await scenario.run();
  const assertions = scenario.evaluate(output);
  const score = scoreAssertions(assertions);
  const criticalFailures = assertions.filter((item) => item.critical && !item.passed).length;

  return {
    id: scenario.id,
    name: scenario.name,
    startedAt,
    score,
    passed: criticalFailures === 0 && score >= 0.75,
    assertions,
  };
}

export async function evaluateRuntimeSuite(scenarios = DEFAULT_RUNTIME_EVAL_SCENARIOS) {
  const results = [];
  for (const scenario of scenarios) {
    results.push(await evaluateRuntimeScenario(scenario));
  }

  const averageScore = results.length > 0
    ? Math.round((results.reduce((sum, item) => sum + item.score, 0) / results.length) * 100) / 100
    : 0;

  return {
    generatedAt: new Date().toISOString(),
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
    '',
  ];

  for (const result of report.results) {
    lines.push(`${result.passed ? 'PASS' : 'FAIL'} ${result.id} (${result.score})`);
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
