#!/usr/bin/env node
/**
 * Artibot CLI - standalone entry point.
 *
 * Usage:
 *   artibot <command> [options]
 *   artibot run <prompt>       - Process a prompt through the runtime pipeline
 *   artibot team <prompt>      - Process a prompt in team mode
 *   artibot eval               - Run the runtime eval suite
 *   artibot learn              - Run the learning pipeline
 *   artibot version            - Show version
 *   artibot help               - Show this help message
 *
 * Zero external dependencies - uses only Node.js built-in APIs.
 *
 * @module bin/artibot
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

// Ensure CLAUDE_PLUGIN_ROOT is set for all lib modules
process.env.CLAUDE_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT;

const HELP_TEXT = `
Artibot CLI - Cognitive orchestration framework

Usage:
  artibot <command> [options]

Commands:
  run <prompt>       Process a prompt through the runtime pipeline
  team <prompt>      Process a prompt in team delegation mode
  eval               Run the runtime eval suite
  learn              Run the nightly learning pipeline
  version, -v        Show version information
  help, -h, --help   Show this help message

Options:
  --json             Output results as JSON (for run/team/eval commands)
  --sequential       Run eval scenarios sequentially (default: parallel)

Examples:
  artibot run "fix the typo in README"
  artibot eval --json
  artibot version
`.trim();

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set();
  const positional = [];
  let command = null;

  for (const arg of args) {
    if (arg.startsWith('--')) {
      flags.add(arg.slice(2));
    } else if (arg.startsWith('-')) {
      flags.add(arg.slice(1));
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  // Treat bare --help / -h / -v as commands
  if (!command && (flags.has('help') || flags.has('h'))) command = 'help';
  if (!command && flags.has('v')) command = 'version';
  if (!command) command = 'help';

  return { command, flags, positional, prompt: positional.join(' ') };
}

async function loadVersion() {
  const { readFile } = await import('node:fs/promises');
  const pkgPath = path.join(PLUGIN_ROOT, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  return pkg.version || '0.0.0';
}

async function cmdVersion() {
  const version = await loadVersion();
  const nodeVersion = process.version;
  const platform = process.platform;
  const arch = process.arch;
  process.stdout.write(`artibot v${version}\n`);
  process.stdout.write(`Node ${nodeVersion} | ${platform}/${arch}\n`);
}

async function cmdRun(prompt, flags) {
  if (!prompt) {
    process.stderr.write('Error: prompt is required.\nUsage: artibot run <prompt>\n');
    process.exitCode = 1;
    return;
  }

  const { createCliAdapter } = await import('../lib/adapters/cli-adapter.js');
  const adapter = createCliAdapter({ pluginRoot: PLUGIN_ROOT });
  const result = await adapter.runPrompt(prompt);

  if (flags.has('json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(result.message + '\n');
    if (result.context?.routing) {
      process.stdout.write(`Route: ${result.context.routing.system}\n`);
    }
    if (result.context?.intent?.best) {
      process.stdout.write(`Intent: ${result.context.intent.best}\n`);
    }
  }
}

async function cmdTeam(prompt, flags) {
  if (!prompt) {
    process.stderr.write('Error: prompt is required.\nUsage: artibot team <prompt>\n');
    process.exitCode = 1;
    return;
  }

  const { createCliAdapter } = await import('../lib/adapters/cli-adapter.js');
  const adapter = createCliAdapter({ pluginRoot: PLUGIN_ROOT, teamMode: true });
  const result = await adapter.runPrompt(prompt);

  if (flags.has('json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(result.message + '\n');
    if (result.context?.routing) {
      process.stdout.write(`Route: ${result.context.routing.system}\n`);
    }
    if (result.context?.subagents?.contract?.mode) {
      process.stdout.write(`Mode: ${result.context.subagents.contract.mode}\n`);
    }
  }
}

async function cmdEval(flags) {
  const { evaluateRuntimeSuite, formatRuntimeSuiteReport } = await import(
    '../lib/runtime/evaluator.js'
  );

  const parallel = !flags.has('sequential');
  const report = await evaluateRuntimeSuite(undefined, { parallel });

  if (flags.has('json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatRuntimeSuiteReport(report) + '\n');
  }

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

async function cmdLearn() {
  const { toFileUrl } = await import('../scripts/utils/index.js');
  const learningPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'index.js');

  try {
    const { shutdownLearning } = await import(toFileUrl(learningPath));
    const sessionData = {
      sessionId: `cli-${Date.now()}`,
      toolUsage: {},
      errors: [],
      completedTasks: [],
      teamConfig: null,
    };

    const result = await shutdownLearning(sessionData);

    const parts = ['Learning pipeline complete'];
    if (result.summarized) parts.push('session summarized');
    if (result.learned) {
      parts.push(`groups: ${result.learned.groupsProcessed ?? 0}`);
      parts.push(`patterns: ${result.learned.patternsExtracted ?? 0}`);
    }
    if (result.hotSwapped) {
      parts.push(`promoted: ${result.hotSwapped.promoted?.length ?? 0}`);
      parts.push(`demoted: ${result.hotSwapped.demoted?.length ?? 0}`);
    }

    process.stdout.write(parts.join(' | ') + '\n');
  } catch (err) {
    process.stderr.write(`Learning pipeline failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

async function main() {
  const { command, flags, prompt } = parseArgs(process.argv);

  if (flags.has('h') || flags.has('help') || command === 'help') {
    process.stdout.write(HELP_TEXT + '\n');
    return;
  }

  if (flags.has('v') || command === 'version') {
    await cmdVersion();
    return;
  }

  switch (command) {
    case 'run':
      await cmdRun(prompt, flags);
      break;
    case 'team':
      await cmdTeam(prompt, flags);
      break;
    case 'eval':
      await cmdEval(flags);
      break;
    case 'learn':
      await cmdLearn();
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      process.stdout.write(HELP_TEXT + '\n');
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[artibot] Fatal: ${err.message}\n`);
  process.exitCode = 1;
});
