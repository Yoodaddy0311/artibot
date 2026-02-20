#!/usr/bin/env node
/**
 * PostToolUse hook: Toolformer tool usage tracker.
 * Records tool usage with success scoring to enable self-learning
 * tool recommendations via lib/learning/tool-learner.js.
 *
 * Attached to PostToolUse for all tool types.
 * Reads hook data from stdin, scores the result, and records it.
 */

import path from 'node:path';
import { readStdin, parseJSON, toFileUrl } from '../utils/index.js';

// Dynamic import for tool-learner (ESM, relative to plugin root)
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
      '..',
      '..'
    );

/** Tools to skip tracking (too frequent / trivial) */
const SKIP_TOOLS = new Set([
  'TodoRead',
  'TodoWrite',
  'TaskList',
  'TaskGet',
  'TaskUpdate',
  'TaskCreate',
  'SendMessage',
  'TeamCreate',
  'TeamDelete',
]);

/** Minimum output length to consider a result substantive */
const MIN_SUBSTANTIVE_LENGTH = 10;

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  if (!hookData) return;

  const toolName = hookData?.tool_name || hookData?.tool;
  const toolInput = hookData?.tool_input || {};
  const toolResult = hookData?.tool_result || {};

  if (!toolName || SKIP_TOOLS.has(toolName)) return;

  // Build context key from tool usage pattern
  const context = buildContext(toolName, toolInput);
  if (!context) return;

  // Score the tool result
  const score = scoreResult(toolName, toolResult, toolInput);

  // Extract metadata
  const meta = extractMeta(toolInput);

  // Dynamically import tool-learner and record
  try {
    const learnerPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'tool-learner.js');
    const { recordUsage } = await import(toFileUrl(learnerPath));
    await recordUsage(toolName, context, score, meta);

    // Bridge: feed tool usage into the lifelong learning pipeline
    const lifelongPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'lifelong-learner.js');
    const { collectExperience } = await import(toFileUrl(lifelongPath));
    await collectExperience({
      type: 'tool',
      category: toolName,
      data: { context, score, ...meta },
    });
  } catch (err) {
    // Silently fail - tracker should never break the tool pipeline
    process.stderr.write(`[artibot:tool-tracker] ${err.message}\n`);
  }
}

/**
 * Build a context key from tool name and input.
 * Returns null for inputs we can't meaningfully classify.
 *
 * @param {string} toolName
 * @param {object} input
 * @returns {string|null}
 */
function buildContext(toolName, input) {
  switch (toolName) {
    case 'Read': {
      const ext = extractExt(input.file_path);
      return ext ? `read:${ext}:file` : 'read:unknown:file';
    }

    case 'Grep': {
      const type = input.type || extractExtFromGlob(input.glob) || 'any';
      const mode = input.output_mode || 'files_with_matches';
      return `search:${type}:${mode}`;
    }

    case 'Glob': {
      const pattern = input.pattern || '';
      const ext = extractExtFromGlob(pattern) || 'any';
      return `find:${ext}:glob`;
    }

    case 'Bash': {
      const cmd = input.command || '';
      const verb = classifyBashCommand(cmd);
      return verb ? `bash:${verb}:shell` : null;
    }

    case 'Edit': {
      const ext = extractExt(input.file_path);
      return ext ? `edit:${ext}:file` : 'edit:unknown:file';
    }

    case 'Write': {
      const ext = extractExt(input.file_path);
      return ext ? `create:${ext}:file` : 'create:unknown:file';
    }

    case 'WebSearch': {
      return 'search:web:external';
    }

    case 'WebFetch': {
      return 'fetch:web:external';
    }

    case 'Task': {
      const agentType = input.subagent_type || input.type || 'generic';
      return `delegate:${agentType}:subagent`;
    }

    case 'Skill': {
      const skill = input.skill || 'unknown';
      return `invoke:${skill}:skill`;
    }

    default: {
      return `use:${toolName.toLowerCase()}:tool`;
    }
  }
}

/**
 * Score a tool result from 0.0 to 1.0 based on success heuristics.
 *
 * @param {string} toolName
 * @param {object} result
 * @param {object} input
 * @returns {number}
 */
function scoreResult(toolName, result, _input) {
  // Check for explicit error
  if (result.error || result.is_error) return 0.0;

  const output = getResultContent(result);

  switch (toolName) {
    case 'Read': {
      if (!output || output.length < MIN_SUBSTANTIVE_LENGTH) return 0.2;
      return 1.0;
    }

    case 'Grep': {
      if (!output || output.trim() === '') return 0.1;
      const lineCount = output.split('\n').filter(Boolean).length;
      if (lineCount > 100) return 0.7; // Too many results = imprecise
      if (lineCount > 0) return 1.0;
      return 0.1;
    }

    case 'Glob': {
      if (!output || output.trim() === '') return 0.1;
      const matchCount = output.split('\n').filter(Boolean).length;
      if (matchCount > 200) return 0.6; // Too broad
      if (matchCount > 0) return 1.0;
      return 0.1;
    }

    case 'Bash': {
      const exitCode = result.exit_code ?? result.exitCode;
      const stderr = result.stderr || '';
      if (exitCode !== 0 && exitCode !== undefined) return 0.1;
      if (stderr && stderr.length > 50) return 0.6;
      return 1.0;
    }

    case 'Edit': {
      if (output && output.includes('updated successfully')) return 1.0;
      if (output && output.includes('not unique')) return 0.2;
      return output ? 0.8 : 0.3;
    }

    case 'Write': {
      if (output && output.includes('created successfully')) return 1.0;
      return output ? 0.8 : 0.3;
    }

    case 'WebSearch':
    case 'WebFetch': {
      if (!output || output.length < MIN_SUBSTANTIVE_LENGTH) return 0.2;
      return 0.9;
    }

    case 'Task': {
      // Sub-agent results are harder to score; use presence of output as proxy
      if (!output || output.length < MIN_SUBSTANTIVE_LENGTH) return 0.3;
      return 0.85;
    }

    default: {
      return output ? 0.7 : 0.3;
    }
  }
}

/**
 * Extract metadata from tool input for recording.
 * @param {object} input
 * @returns {object}
 */
function extractMeta(input) {
  const meta = {};

  // Try to detect originating command from description or context
  if (input.description) {
    const cmdMatch = input.description.match(/^\/(\w+)/);
    if (cmdMatch) meta.command = `/${cmdMatch[1]}`;
  }

  return meta;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Extract file extension from a path.
 * @param {string} [filePath]
 * @returns {string|null}
 */
function extractExt(filePath) {
  if (!filePath) return null;
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return ext || null;
}

/**
 * Extract extension hint from a glob pattern (e.g. "*.ts", "**\/*.md").
 * @param {string} [pattern]
 * @returns {string|null}
 */
function extractExtFromGlob(pattern) {
  if (!pattern) return null;
  const match = pattern.match(/\*\.(\w+)/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Classify a bash command into a category verb.
 * @param {string} cmd
 * @returns {string|null}
 */
function classifyBashCommand(cmd) {
  const trimmed = cmd.trim().toLowerCase();

  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?test/.test(trimmed)) return 'test';
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?build/.test(trimmed)) return 'build';
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?lint/.test(trimmed)) return 'lint';
  if (/^(npm|pnpm|yarn|bun)\s+install/.test(trimmed)) return 'install';
  if (/^git\s/.test(trimmed)) return 'git';
  if (/^(tsc|npx\s+tsc)/.test(trimmed)) return 'typecheck';
  if (/^(node|npx|tsx)\s/.test(trimmed)) return 'execute';
  if (/^(docker|docker-compose)/.test(trimmed)) return 'container';
  if (/^(curl|wget|fetch)/.test(trimmed)) return 'http';
  if (/^(ls|dir|pwd)/.test(trimmed)) return 'list';
  if (/^(mkdir|rm|cp|mv)/.test(trimmed)) return 'filesystem';

  return null;
}

/**
 * Get the main content string from a tool result.
 * @param {object} result
 * @returns {string}
 */
function getResultContent(result) {
  if (typeof result === 'string') return result;
  return (
    result.content ||
    result.output ||
    result.stdout ||
    result.text ||
    result.message ||
    ''
  );
}

main().catch((err) => {
  process.stderr.write(`[artibot:tool-tracker] ${err.message}\n`);
});
