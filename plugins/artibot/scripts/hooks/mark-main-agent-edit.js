#!/usr/bin/env node
/**
 * PostToolUse hook for Edit / Write / MultiEdit.
 *
 * Writes `runtime/last-main-agent-edit.timestamp` ONLY when the edit was made
 * by the main orchestrator agent — not by a Task-spawned teammate / subagent.
 * The dev-verify-gate Stop hook compares this marker's mtime against its own
 * fingerprint cache to decide whether to surface the DEV verify checklist.
 *
 * Why this matters (v4.5.6 in-flight regression that v4.5.8 closes):
 *   The previous gate fired on every Stop with uncommitted changes in the
 *   working tree. In `/team` delegate workflows, those changes are produced
 *   by teammates (fix-applier, code-reviewer, etc.) — NOT by the orchestrator
 *   turn whose Stop is being gated. Result: every orchestrator Stop while
 *   teammates were mid-edit got blocked with "Pending verification" feedback,
 *   paralysing all delegate flows. v4.5.6 patched this by hard-disabling the
 *   gate; v4.5.8 restores the gate AND distinguishes orchestrator edits from
 *   teammate edits via this marker.
 *
 * Schema: PostToolUse fires from the agent that executed the tool. When the
 * orchestrator calls Edit/Write/MultiEdit directly, hookData has no subagent
 * markers and we write the marker. When a Task-spawned teammate executes the
 * same tool inside its own subagent context, hookData carries `subagent_id` /
 * `subagent_type` / `parent_session_id` / `role: 'teammate'`, and we bail
 * without touching the marker.
 *
 * Side-effect contract: writes one timestamp file. No stdout. Errors are
 * logged via the shared error handler with `exit: false` — a marker write
 * failure must never break tool execution.
 *
 * @module scripts/hooks/mark-main-agent-edit
 */

import path from 'node:path';
import {
  atomicWriteSync,
  getPluginRoot,
  parseJSON,
  readStdin,
} from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'mark-main-agent-edit';
const MARKER_FILE = 'last-main-agent-edit.timestamp';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * Detect whether the hook is executing inside a Task-spawned subagent.
 *
 * @param {object} hookData
 * @returns {boolean}
 */
export function isSubagentContext(hookData) {
  if (!hookData || typeof hookData !== 'object') return false;
  if (hookData.subagent_id) return true;
  if (hookData.subagent_type) return true;
  if (hookData.parent_session_id) return true;
  if (hookData.role === 'teammate') return true;
  return false;
}

/**
 * Resolve the absolute path of the main-agent-edit marker file.
 *
 * @param {string} [pluginRoot]
 * @returns {string}
 */
export function getMarkerPath(pluginRoot) {
  const root = pluginRoot ?? getPluginRoot();
  return path.join(root, 'runtime', MARKER_FILE);
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  // Tool gate — only fire on edit tools. Defensive: hooks.json already
  // matches Edit/Write/MultiEdit, but if the matcher is widened or another
  // tool slips through (e.g. NotebookEdit) we don't want to mistakenly
  // mark non-edit turns.
  const toolName = extractToolName(hookData);
  if (!toolName || !EDIT_TOOLS.has(toolName)) return;

  // Subagent gate — teammate edits must NOT update the marker, otherwise
  // the orchestrator's dev-verify-gate would treat teammate edits as if
  // the orchestrator made them.
  if (isSubagentContext(hookData)) return;

  const markerPath = getMarkerPath();
  atomicWriteSync(markerPath, new Date().toISOString() + '\n');
}

// CLI entry — only runs when invoked directly, not on import (test imports).
const isCliEntry = process.argv[1] && process.argv[1].endsWith('mark-main-agent-edit.js');
if (isCliEntry) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
}

export { main };
