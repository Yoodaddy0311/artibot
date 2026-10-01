#!/usr/bin/env node
/**
 * PostToolUse hook for Edit / Write / MultiEdit.
 *
 * Writes `last-main-agent-edit.timestamp` ONLY when the edit was made by the main
 * orchestrator agent — not by a Task-spawned teammate / subagent — and only for
 * the session and project that made it. The dev-verify-gate Stop hook compares
 * this marker's mtime against its own fingerprint cache to decide whether to
 * surface the DEV verify checklist.
 *
 * Where the marker lives (O2): `<store>/gates/sessions/<session>/`, with `<store>`
 * from `lib/project-state/store-location.js` — see
 * `lib/project-state/gate-markers.js` for the layout and the reasons. It used to
 * be ONE file in `<pluginRoot>/runtime/`, shared by every project and lost on
 * every plugin update, so an edit anywhere fired the Stop gate of any Artibot
 * checkout.
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
 * When it writes NOTHING (each is a case no Stop gate could ever read):
 *   - the tool is not an edit tool, or the call came from a subagent;
 *   - `cwd` (the payload's, else the process's — the Stop gates root on the same
 *     one) is not inside a git work tree. Both Stop gates need git
 *     (`getRepoRoot()`), so a marker outside one is unreachable. The walk up is
 *     pure filesystem — this hook runs on every edit and must not start a
 *     process (see `_main-entry.js#nearestWorkTreeRoot`);
 *   - the work tree is not an Artibot repo. The gates bail outside one
 *     (`isArtibotRepo`), so the marker would be state no reader exists for, left
 *     in every unrelated project the plugin is installed into.
 *
 * Side-effect contract: writes one timestamp file, and — only for the process
 * that just created a new session directory — prunes idle ones. No stdout.
 * Errors are logged via the shared error handler with `exit: false` — a marker
 * write failure must never break tool execution.
 *
 * @module scripts/hooks/mark-main-agent-edit
 */

import path from 'node:path';
import {
  atomicWriteSync,
  parseJSON,
  readStdin,
} from '../utils/index.js';
import { createErrorHandler, extractToolName, isArtibotRepo } from '../../lib/core/hook-utils.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import {
  claimGateDir,
  GATE_FILES,
  gatesDir,
  payloadCwdOf,
  pruneStaleGateState,
  sessionGateDir,
  sessionIdOf,
  sessionSlot,
} from '../../lib/project-state/gate-markers.js';
import { isMainEntry, nearestWorkTreeRoot } from './_main-entry.js';

const HOOK_NAME = 'mark-main-agent-edit';
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
 * Absolute path of the main-agent-edit marker for one session of one project.
 *
 * The same `sessionGateDir` the Stop gate reads, so the two cannot disagree
 * about the location.
 *
 * @param {string} projectRoot work-tree root
 * @param {unknown} [sessionId] hook payload `session_id`
 * @returns {string}
 */
export function getMarkerPath(projectRoot, sessionId) {
  return path.join(sessionGateDir(projectRoot, sessionId), GATE_FILES.mainAgentEdit);
}

/**
 * Decide where this payload's marker goes, or that it goes nowhere.
 *
 * The project is resolved from the payload's `cwd`, falling back to the process
 * cwd only when the payload names none — the SAME source the Stop gates use
 * (`gate-markers.js#payloadCwdOf`), so writer and readers cannot root in two
 * different directories.
 *
 * @param {object} hookData parsed PostToolUse payload
 * @returns {{ projectRoot: string, dir: string, file: string, gates: string, slot: string }|null}
 *   null when no Stop gate could read a marker written for this payload
 */
export function resolveMarkerTarget(hookData) {
  const cwd = payloadCwdOf(hookData) ?? process.cwd();
  const projectRoot = nearestWorkTreeRoot(cwd, resolveGitCommonDir);
  if (projectRoot === null) return null;
  if (!isArtibotRepo(projectRoot)) return null;

  const sessionId = sessionIdOf(hookData);
  const dir = sessionGateDir(projectRoot, sessionId);
  return {
    projectRoot,
    dir,
    file: path.join(dir, GATE_FILES.mainAgentEdit),
    gates: gatesDir(projectRoot),
    slot: sessionSlot(sessionId),
  };
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

  const target = resolveMarkerTarget(hookData);
  if (target === null) return;

  // The creator of a session directory owes the prune of idle ones; a process
  // that finds it already there does not pay for a directory listing.
  const created = claimGateDir(target.dir);
  atomicWriteSync(target.file, new Date().toISOString() + '\n');
  if (created) pruneStaleGateState(target.gates, { keep: [target.slot] });
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// Production is unaffected — the dispatcher spawns this file as argv[1].
//
// Was `argv[1].endsWith('mark-main-agent-edit.js')`: a suffix test that any path
// ending in that name satisfied, comparing a possibly-relative argv[1]
// unresolved. Identity on the resolved path is the repo-wide check now.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
}

export { main };
