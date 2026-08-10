/**
 * Session signal extraction for learning records.
 *
 * The self-evaluator scored every session from `completed_tasks`, a SessionEnd
 * payload field that is never populated — so `success` was permanently false
 * and all four scoring dimensions collapsed to constants (318 consecutive rows
 * of the identical D grade). The transcript JSONL is the one place where what
 * actually happened during a session is recorded, so this module reads it and
 * produces the real signals: how many tools ran, how many failed, how many
 * files were written, and how long the session spanned.
 *
 * Deliberately separate from `model-identity.js` rather than folded into its
 * pass: that module carries the model-attribution test suite, and a second
 * streaming pass over the same file costs ~34ms for 3.4MB — 0.1% of the
 * SessionEnd budget. Buying isolation at that price is the easy trade.
 *
 * Never throws. An unreadable transcript yields `emptySignals()` with
 * `source: 'none'`, because "measured zero tools" and "failed to measure" are
 * different statements and conflating them is precisely the bug above.
 *
 * @module lib/learning/session-signals
 */

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

/**
 * Tools whose `input.file_path` represents a *modified* file. Read/Glob/Grep
 * also carry `file_path`, so without this set `filesTouched` would count
 * inspection as production.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Bucket for tool activity that cannot be attributed to a tool name — a
 * `tool_result` whose `tool_use_id` never appeared, or a `tool_use` with no
 * `name`. Kept visible rather than dropped so a schema change shows up as a
 * growing `<unknown>` count instead of silently shrinking totals.
 */
const UNKNOWN_TOOL = '<unknown>';

/**
 * The honest "not measured" record. `source: 'none'` is what distinguishes it
 * from a real session that happened to use no tools.
 *
 * @returns {object} A fresh empty signal record
 */
export function emptySignals() {
  return {
    source: 'none',
    toolCalls: 0,
    toolErrors: 0,
    filesTouched: 0,
    filesSeen: 0,
    wallClockMs: null,
    firstTs: null,
    lastTs: null,
    byTool: {},
    main: { toolCalls: 0, toolErrors: 0, filesTouched: 0, filesSeen: 0 },
    subagent: { toolCalls: 0, toolErrors: 0, filesTouched: 0, filesSeen: 0 },
    subagentFiles: 0,
  };
}

/**
 * Per-scope counters (one for the main thread, one for all subagents).
 * @returns {object}
 */
function newScope() {
  return { toolCalls: 0, toolErrors: 0, editFiles: new Set(), seenFiles: new Set() };
}

/**
 * Cross-file context: the id->tool-name map (a `tool_result` names only the id
 * of the call it answers), the combined per-tool tally, and the timestamp span.
 *
 * Mutated in place on purpose. The immutable fold used by `model-identity.js`
 * copies its accumulator per entry, which is fine for a handful of counters but
 * would be O(n^2) over a 1,400-entry id map. Mutation is confined to this
 * module — nothing here escapes to a caller until it is copied into the result.
 *
 * @returns {object}
 */
function newContext() {
  return { toolNames: new Map(), byTool: new Map(), minMs: null, maxMs: null, firstTs: null, lastTs: null };
}

/**
 * Add calls/errors to the combined per-tool tally.
 * @param {object} ctx
 * @param {string} name
 * @param {{calls?: number, errors?: number}} delta
 */
function tally(ctx, name, delta) {
  const prev = ctx.byTool.get(name) ?? { calls: 0, errors: 0 };
  ctx.byTool.set(name, {
    calls: prev.calls + (delta.calls ?? 0),
    errors: prev.errors + (delta.errors ?? 0),
  });
}

/**
 * Fold one `tool_use` block: count the call, remember its tool name for the
 * matching result, and record any file it targets.
 *
 * @param {object} block
 * @param {object} scope
 * @param {object} ctx
 */
function foldToolUse(block, scope, ctx) {
  scope.toolCalls += 1;
  const name = typeof block.name === 'string' && block.name.length > 0
    ? block.name
    : UNKNOWN_TOOL;
  if (typeof block.id === 'string' && block.id.length > 0) {
    ctx.toolNames.set(block.id, name);
  }
  tally(ctx, name, { calls: 1 });

  const filePath = block.input?.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return;
  scope.seenFiles.add(filePath);
  if (EDIT_TOOLS.has(name)) scope.editFiles.add(filePath);
}

/**
 * Fold one `tool_result` block. Only a literal `is_error === true` counts —
 * classifying *which* failures are the model's fault belongs to WP-C, so this
 * stays a raw count.
 *
 * @param {object} block
 * @param {object} scope
 * @param {object} ctx
 */
function foldToolResult(block, scope, ctx) {
  if (block.is_error !== true) return;
  scope.toolErrors += 1;
  tally(ctx, ctx.toolNames.get(block.tool_use_id) ?? UNKNOWN_TOOL, { errors: 1 });
}

/**
 * Track the earliest and latest parseable entry timestamp.
 * @param {object} entry
 * @param {object} ctx
 */
function foldTimestamp(entry, ctx) {
  const raw = entry?.timestamp;
  if (typeof raw !== 'string' || raw.length === 0) return;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return;
  if (ctx.minMs === null || ms < ctx.minMs) { ctx.minMs = ms; ctx.firstTs = raw; }
  if (ctx.maxMs === null || ms > ctx.maxMs) { ctx.maxMs = ms; ctx.lastTs = raw; }
}

/**
 * Fold one parsed transcript entry. Entry `type` is intentionally not filtered:
 * Claude Code puts `tool_use` on assistant entries and `tool_result` on user
 * entries, and pinning that layout here would turn a harness change into a
 * silent zero.
 *
 * @param {object} entry
 * @param {object} scope
 * @param {object} ctx
 */
function foldEntry(entry, scope, ctx) {
  foldTimestamp(entry, ctx);
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'tool_use') foldToolUse(block, scope, ctx);
    else if (block?.type === 'tool_result') foldToolResult(block, scope, ctx);
  }
}

/**
 * Stream one JSONL file into a scope. Malformed lines are skipped and a
 * truncated or locked file keeps whatever was already folded — partial signals
 * beat none.
 *
 * @param {string} filePath
 * @param {object} scope
 * @param {object} ctx
 * @returns {Promise<void>}
 */
async function foldFile(filePath, scope, ctx) {
  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      foldEntry(entry, scope, ctx);
    }
  } catch {
    // Unreadable file: keep what was folded, report it as measured-so-far.
  }
}

/**
 * List the subagent transcripts belonging to a session.
 *
 * Claude Code stores them as siblings of the main file, not inline:
 *   `<project>/<session-id>.jsonl`             <- main thread
 *   `<project>/<session-id>/subagents/*.jsonl` <- one file per subagent
 *
 * Scanning only the main file would drop delegated work entirely, which in a
 * leader-delegates setup is most of the work.
 *
 * @param {string} transcriptPath - Path to the main session .jsonl
 * @returns {string[]} Absolute subagent transcript paths (empty if none)
 */
function listSubagentTranscripts(transcriptPath) {
  const subagentsDir = path.join(transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
  try {
    return readdirSync(subagentsDir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => path.join(subagentsDir, name));
  } catch {
    return [];
  }
}

/**
 * Reduce a scope to its reportable counts.
 * @param {object} scope
 * @returns {{toolCalls: number, toolErrors: number, filesTouched: number, filesSeen: number}}
 */
function summarize(scope) {
  return {
    toolCalls: scope.toolCalls,
    toolErrors: scope.toolErrors,
    filesTouched: scope.editFiles.size,
    filesSeen: scope.seenFiles.size,
  };
}

/**
 * Assemble the public record from the two scopes and the shared context.
 * Top-level counts are main+subagent combined; file counts are set *unions*, so
 * a file both the leader and a subagent edited counts once.
 *
 * @param {object} main
 * @param {object} sub
 * @param {object} ctx
 * @param {number} subagentFiles
 * @returns {object}
 */
function buildRecord(main, sub, ctx, subagentFiles) {
  const mainSum = summarize(main);
  const subSum = summarize(sub);
  return {
    source: 'transcript',
    toolCalls: mainSum.toolCalls + subSum.toolCalls,
    toolErrors: mainSum.toolErrors + subSum.toolErrors,
    filesTouched: new Set([...main.editFiles, ...sub.editFiles]).size,
    filesSeen: new Set([...main.seenFiles, ...sub.seenFiles]).size,
    wallClockMs: ctx.minMs === null ? null : ctx.maxMs - ctx.minMs,
    firstTs: ctx.firstTs,
    lastTs: ctx.lastTs,
    byTool: Object.fromEntries(ctx.byTool),
    main: mainSum,
    subagent: subSum,
    subagentFiles,
  };
}

/**
 * Read a Claude Code session transcript and extract what actually happened.
 *
 * Covers the main thread AND every subagent transcript of the same session.
 * The two are summed at the top level — Artibot's leader delegates and
 * teammates execute, so scoring the leader's thread alone would score the wrong
 * work — while `main` and `subagent` stay separate so the split can be
 * re-derived later without re-parsing.
 *
 * @param {string} transcriptPath - Absolute path to the session .jsonl
 * @returns {Promise<{
 *   source: 'transcript' | 'none',
 *   toolCalls: number,
 *   toolErrors: number,
 *   filesTouched: number,
 *   filesSeen: number,
 *   wallClockMs: number | null,
 *   firstTs: string | null,
 *   lastTs: string | null,
 *   byTool: Record<string, {calls: number, errors: number}>,
 *   main: {toolCalls: number, toolErrors: number, filesTouched: number, filesSeen: number},
 *   subagent: {toolCalls: number, toolErrors: number, filesTouched: number, filesSeen: number},
 *   subagentFiles: number
 * }>}
 */
export async function resolveSessionSignals(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return emptySignals();
  }

  const ctx = newContext();
  const main = newScope();
  const sub = newScope();

  await foldFile(transcriptPath, main, ctx);
  const subagentPaths = listSubagentTranscripts(transcriptPath);
  for (const file of subagentPaths) {
    await foldFile(file, sub, ctx);
  }

  // Nothing at all was read: report 'none' rather than a zero that looks like
  // a measurement. A session with timestamps but no tools IS a measurement.
  if (main.toolCalls + sub.toolCalls === 0 && ctx.minMs === null) {
    return emptySignals();
  }

  return buildRecord(main, sub, ctx, subagentPaths.length);
}
