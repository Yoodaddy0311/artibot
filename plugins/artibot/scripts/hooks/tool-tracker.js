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
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { atomicWriteSync, parseJSON, readStdin, toFileUrl } from '../utils/index.js';
import { createErrorHandler, extractAgentId, extractAgentRole, getArtibotDataDir, logHookError } from '../../lib/core/hook-utils.js';
import { createLoopDetector } from '../../lib/cognitive/loop-detector.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { isMainEntry } from './_main-entry.js';

/** Path to the persisted loop detector state file. */
const LOOP_STATE_FILE = path.join(getArtibotDataDir(), 'loop-state.json');

/** Inactivity timeout (ms) after which persisted state is discarded. */
const STATE_EXPIRY_MS = 30 * 60 * 1000;

/**
 * Loop-state flush cadence (v4.7.3 perf — perf-auditor A1.2). Previously the
 * detector state was written every PostToolUse fire; now we flush once per N
 * calls or immediately when a loop is detected. Recovery semantics unchanged
 * — detector history persists across crashes within the expiry window, with
 * worst-case loss of N-1 entries at process kill.
 */
const LOOP_STATE_FLUSH_INTERVAL = 10;
let loopCallCounter = 0;

/**
 * Load persisted loop detector history from disk.
 * Returns null if the file is missing, expired, or corrupt.
 * @returns {Array<{ tool: string, fingerprint: string }> | null}
 */
function loadLoopState() {
  try {
    if (!existsSync(LOOP_STATE_FILE)) return null;
    const data = JSON.parse(readFileSync(LOOP_STATE_FILE, 'utf-8'));
    if (Date.now() - (data.lastUpdated || 0) > STATE_EXPIRY_MS) return null;
    return Array.isArray(data.history) ? data.history : null;
  } catch {
    return null;
  }
}

/**
 * Save loop detector history to disk for cross-process persistence.
 * @param {object} detector - Loop detector instance
 */
function saveLoopState(detector) {
  try {
    mkdirSync(path.dirname(LOOP_STATE_FILE), { recursive: true });
    atomicWriteSync(LOOP_STATE_FILE, JSON.stringify({
      history: detector.getLoopHistory(),
      lastUpdated: Date.now(),
    }, null, 2));
  } catch {
    // Non-fatal: persistence failure does not block tool pipeline
  }
}

/** Loop detector instance restored from persisted state when available. */
const restoredHistory = loadLoopState();
const loopDetector = createLoopDetector(
  restoredHistory ? { initialHistory: restoredHistory } : {},
);

// Dynamic import for tool-learner (ESM, relative to plugin root)
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..'
    );

/**
 * Dynamic-import module cache (v4.7.3 perf — perf-auditor A1.2).
 * tool-learner.js and lifelong-learner.js were re-imported on every
 * PostToolUse fire. ESM module cache makes repeat imports cheap, but the
 * promise round-trip itself is non-trivial in a hot hook — memoize the
 * resolved module promise so the second call onwards is a no-op.
 *
 * @type {Promise<{ recordUsage: Function }>|null}
 */
let toolLearnerModulePromise = null;
/** @type {Promise<{ collectExperience: Function }>|null} */
let lifelongLearnerModulePromise = null;

function loadToolLearner() {
  if (!toolLearnerModulePromise) {
    const learnerPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'tool-learner.js');
    toolLearnerModulePromise = import(toFileUrl(learnerPath));
  }
  return toolLearnerModulePromise;
}

function loadLifelongLearner() {
  if (!lifelongLearnerModulePromise) {
    const lifelongPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'lifelong-learner.js');
    lifelongLearnerModulePromise = import(toFileUrl(lifelongPath));
  }
  return lifelongLearnerModulePromise;
}

/** Tools to skip tracking (too frequent / trivial / orchestration-only).
 *
 * v4.6.4: AskUserQuestion, ExitPlanMode, and Skill are CLI orchestration
 * primitives whose result shape is not a tool measurement — they previously
 * fell through to the default scoring branch and were locked at 0.3, which
 * polluted GRPO weights with apparent "20% success" signals.
 */
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
  'AskUserQuestion',
  'ExitPlanMode',
  'Skill',
]);

/** Minimum output length to consider a result substantive */
const MIN_SUBSTANTIVE_LENGTH = 10;

/**
 * Extract the tool result object from a Claude Code PostToolUse /
 * PostToolUseFailure payload.
 *
 * Field-name resolution (newest → oldest):
 *   0. top-level `error` / `tool_error` — the PostToolUseFailure shape.
 *   1. `tool_response` — canonical PostToolUse field (object OR string).
 *   2. `tool_result`   — legacy alias kept for older payloads / tests.
 *   3. `tool_output` / `output` — defensive fallbacks seen in sibling hooks.
 *
 * Claude Code sends `tool_response` as a plain string for some tools (e.g.
 * Bash stdout). scoreResult() inspects object fields (error, exit_code,
 * stderr), so a bare string is normalised into `{ output: <string> }` — that
 * keeps getResultContent() working while leaving the structured branches
 * (exit_code/stderr/is_error) safely undefined.
 *
 * ── Why the failure branch must map to `error`, never `output` ──
 * Measured 2026-08-10 by dumping raw hook stdin: a PostToolUseFailure payload
 * carries its text at TOP-LEVEL `error` as a plain string and has NO
 * `tool_response`, NO `tool_result` and NO top-level `exit_code` (the status
 * lives only inside the string, e.g. "Exit code 125\n…"). Before this branch
 * existed every failing Bash call resolved to `{}` and fell through to the
 * Bash arm of scoreResult, which found no exit_code and no stderr and returned
 * **1.0 — a perfect success**. Failures were indistinguishable from successes
 * in the learning store, so scoreResult's `return 0.0` was dead code.
 *
 * Routing the string through the normal `{ output: … }` normalisation would
 * NOT fix it: scoreResult's 0.0 branch tests `result.error`, so an
 * `output`-wrapped failure still scores 1.0. The key name is the whole fix.
 *
 * ── What this fix does NOT reach ──
 * Only failures of commands that {@link classifyBashCommand} recognises get
 * scored at all. That helper matches on the command's LEADING TOKEN, so
 * `cd x && …`, `VAR=… ; …` and other compound forms return null, buildContext
 * returns null, and main() returns before scoring — no row is written, with or
 * without this branch. Those failures remain invisible to tool learning, and
 * since `cd x && …` is the dominant command shape in this repo the blind spot
 * is large. Tracked separately; do not infer from "0.0 rows now exist" that
 * every failure is being captured.
 *
 * @param {object} hookData
 * @returns {object}
 */
function extractToolResult(hookData) {
  const failure = hookData?.error ?? hookData?.tool_error;
  if (typeof failure === 'string' && failure) return { error: failure };
  if (failure && typeof failure === 'object') {
    // `||` not `??`: scoreResult tests `result.error` for TRUTHINESS, so a
    // falsy message ('' / 0 / false / NaN) parked on `error` would sail past
    // the 0.0 branch and score the failure 1.0 again — the same leak this
    // whole function exists to close. `??` only substitutes null/undefined.
    // A present error OBJECT is itself the failure signal, so an empty message
    // degrades to `true` rather than to "no error".
    return { ...failure, error: failure.message || true };
  }

  const raw = hookData?.tool_response
    ?? hookData?.tool_result
    ?? hookData?.tool_output
    ?? hookData?.output
    ?? {};
  if (typeof raw === 'string') return { output: raw };
  if (raw && typeof raw === 'object') return raw;
  return {};
}

export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  if (!hookData) return;

  const toolName = hookData?.tool_name || hookData?.tool;
  const toolInput = hookData?.tool_input || {};
  // Claude Code's PostToolUse payload exposes the tool output under
  // `tool_response` (see scripts/hooks/event-emitter.mjs:84 and the sibling
  // hooks post-bash.js / post-edit-recovery.js). The legacy `tool_result`
  // field is never populated by Claude Code, which silently starved
  // scoreResult of output/exit_code and collapsed every score to a per-tool
  // constant (Read→0.2, Bash→1.0, …). Accept all known aliases, newest first.
  const toolResult = extractToolResult(hookData);

  if (!toolName || SKIP_TOOLS.has(toolName)) return;

  // Build context key from tool usage pattern
  const context = buildContext(toolName, toolInput);
  if (!context) return;

  // Score the tool result
  const score = scoreResult(toolName, toolResult, toolInput);

  // Extract metadata
  const meta = extractMeta(toolInput);

  // Extract agent context for per-agent tracking
  const agentId = extractAgentId(hookData);
  const agentType = extractAgentRole(hookData, 'main');

  // Extract session ID and project context from hook data
  const sessionId = hookData?.session_id ?? null;
  // basename of the resolved project root, not of the raw cwd: the shell's
  // directory moves mid-session, which split one project across several names.
  const project = path.basename(resolveProjectRoot(hookData?.cwd)) || null;

  // Loop detection: check for repetitive tool call patterns
  const loopResult = loopDetector.detectLoop({ tool: toolName, args: toolInput });

  // v4.7.3 perf: flush detector state every Nth call OR immediately on loop
  // detection. Loop alerts must surface in real-time; benign tool calls can
  // tolerate worst-case N-1 entries of lost history on crash.
  loopCallCounter += 1;
  if (loopResult.detected || loopCallCounter % LOOP_STATE_FLUSH_INTERVAL === 0) {
    saveLoopState(loopDetector);
  }

  if (loopResult.detected) {
    const label = loopResult.severity === 'block' ? 'LOOP BLOCKED' : 'LOOP WARNING';
    // Claude Code parses PostToolUse stdout as JSON — alert text goes to
    // stderr (matcher * triggers on every tool, prior stdout polluted JSON).
    process.stderr.write(
      `[artibot:${label}] Tool "${toolName}" called ${loopResult.count}x with same args (severity: ${loopResult.severity})\n`
    );
  }

  // Dynamically import tool-learner and record (modules memoized in
  // toolLearnerModulePromise / lifelongLearnerModulePromise — first call
  // pays the import cost, subsequent calls hit the cached promise).
  try {
    const { recordUsage, flushToDisk } = await loadToolLearner();
    await recordUsage(toolName, context, score, { ...meta, agentId, agentType });

    // Persist NOW rather than letting the learner's debounce decide.
    //
    // recordUsage only marks the history dirty and arms a FLUSH_INTERVAL_MS
    // (5000ms) timer — a sensible batching policy for a long-lived library
    // host, and the wrong one for a hook. This process is spawned per tool call
    // by _posttooluse-dispatcher.js and SIGTERM'd at the `tool-tracker` timeout
    // in hooks/dispatch-table.json, which is 3000ms. The timer therefore never
    // reached its deadline and every row was lost.
    //
    // Measured 2026-08-10 (isolated HOME, real script, one Grep payload):
    //   SIGTERM @3000ms -> exits 3037ms, signal SIGTERM, tool-history.json ABSENT
    //   no kill         -> exits 5114ms, code 0,         tool-history.json present
    // `beforeExit` does not rescue it: the armed timer keeps the loop non-empty
    // until 5s, and it does not run on SIGTERM at all.
    //
    // Flushing here also clears the timer, so the process exits as soon as its
    // work is done instead of idling for the rest of the debounce window.
    await flushToDisk();

    // Bridge: feed tool usage into the lifelong learning pipeline
    const { collectExperience } = await loadLifelongLearner();
    await collectExperience({
      type: 'tool',
      category: toolName,
      data: { context, score, project, agentId, agentType, ...meta },
      sessionId,
    });
  } catch (err) {
    // Silently fail - tracker should never break the tool pipeline
    logHookError('tool-tracker', 'recording failed', err);
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

    case 'Agent':
    case 'Task': {
      // 'Agent' is the current host tool name; 'Task' is what it was called
      // before the rename, kept because an older host still sends it and
      // dropping it would silently demote those payloads to the default
      // 'use:task:tool' bucket. Design follow-up 4 asked for Agent; adding it
      // as an allowlist entry rather than a replacement is the fail-closed
      // direction (verification-discipline §8).
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

  // v4.6.4: MCP tools (mcp__server__method) previously fell through to the
  // default `output ? 0.7 : 0.3` branch, locking many at 0.3 and polluting
  // GRPO weights. MCP tools surface success via stderr / structured response,
  // not via output length, so we score them like Bash (exit-code + stderr).
  if (toolName.startsWith('mcp__')) {
    const exitCode = result.exit_code ?? result.exitCode;
    const stderr = result.stderr || '';
    if (exitCode !== 0 && exitCode !== undefined) return 0.1;
    if (!output || output.length < MIN_SUBSTANTIVE_LENGTH) {
      return stderr ? 0.4 : 0.7; // empty result without error is plausible (e.g. side-effect calls)
    }
    if (stderr && stderr.length > 50) return 0.7;
    return 0.95;
  }

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

    case 'Agent':
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

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('tool-tracker'));
}
