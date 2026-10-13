/**
 * The shared team-state file (`~/.claude/artibot-state.json`) as a hook's read-modify-write sees
 * it, and the rule that keeps that write from replacing what it could not read. Three hooks read
 * through it: subagent-handler.js (SubagentStart/Stop), workflow-status.js and
 * team-idle-handler.js. Each passes its own name as the `hook` option, so a refusal on stderr is
 * attributed to the hook that made it.
 *
 * WHY THIS EXISTS. The file is shared by every live session on the machine (agents,
 * events, idle records, tasks). The `loadState()` that `_team-state.js` used to export
 * (retired 2026-10-13) answered `{ agents: {} }` for a file it could not read AND for one
 * that was not JSON, and the START or STOP that followed wrote that empty state back: one
 * failed read (EBUSY or EPERM from a scanner, say, on Windows) replaced every other agent's
 * row with a single one. SessionEnd already refuses the unreadable case
 * (`_team-state.js#readStateForMerge`); this is the same refusal for the hook's own writes
 * to the `agents` map.
 *
 * NO `existsSync` PRE-CHECK, ON PURPOSE. `existsSync` answers false for ANY failure to
 * stat the path, a file that is there and cannot be reached included, so "does not exist"
 * would be taken for "empty" and the file replaced. Only the read's own ENOENT means there
 * is no file.
 *
 * ONE DIFFERENCE FROM SESSION END, ON PURPOSE. SessionEnd replaces a file that is not a
 * JSON object, because its snapshot is a whole document. A START or STOP row is not one:
 * laid over a corrupt file it would replace content nobody has looked at. So a corrupt
 * file is left byte for byte as it was and said once on stderr; the next SessionEnd merge
 * (`_team-state.js#mergeSessionSnapshot`) is what replaces it. Until then no hook that reads
 * through this guard updates the state file. For subagent-handler.js the spawn record and the
 * stdout message do not depend on it, and a STOP just finds no START entry to read back (its
 * row then carries null policy columns and no `durationMs`); workflow-status.js and
 * team-idle-handler.js likewise write nothing on a refusal (their own suites).
 *
 * THE SAME READ ALSO ANSWERS "IS THIS START A RESUME?" ({@link readAgentEntry}). That answer
 * decides whether the bind runs, so a file that cannot be read whole answers "not known",
 * and the bind runs as it did before the question existed: the ledger window decides. The
 * bind of a new spawn is the common case and the one worth keeping when the file is in
 * trouble; the cost is the resume-outside-the-window double bind this question was added to
 * stop, but only while the file is unreadable.
 *
 * WHAT THIS DOES NOT SEE.
 *   - A writer that does not read through it. The three hooks above do; SessionEnd keeps its
 *     own, `_team-state.js#readStateForMerge`, which replaces a corrupt file on purpose (see
 *     above); pre-compact.js and session-start.js only read the file. That is the list
 *     `grep -rn "artibot-state\|getStatePath()\|getStateFilePath()" scripts lib` gave on
 *     2026-10-13: a hook added after it has to adopt this read, or it reopens the hole.
 *   - Content that parses but is stale or wrong: only "readable, a JSON object, `agents`
 *     absent or an object" is checked. Rows are not validated here (`pruneAgents` and the
 *     readers tolerate odd rows).
 *   - A read that succeeds on a half-written file. `atomicWriteSync` renames a complete
 *     temp file into place, so our own writers cannot produce one; an outside writer that
 *     truncates a file to still-valid JSON would pass.
 *   - A retry. A read that fails skips this event's state update; the next event writes it.
 *
 * @module lib/runtime/subagent-state-guard
 */

import { readFileSync } from 'node:fs';
import { logHookError } from '../core/hook-utils.js';

/** The label a refusal carries when the caller names none: the first hook to use this guard. */
const DEFAULT_HOOK = 'subagent-handler';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The state a hook's read-modify-write may write over, or `null` when it may not write at all.
 *
 * - the read fails with ENOENT: `{ agents: {} }`, the fresh state a missing file has always
 *   meant, so a first registration still creates the file
 * - a file that reads as a JSON object whose `agents` is absent, null or an object: that
 *   object, as parsed
 * - anything else (a read that fails for any other reason or with no errno at all, text that
 *   is not JSON, a JSON value that is not an object, an `agents` that is not an object):
 *   `null`, with one line on stderr saying which. The file is not touched.
 *
 * Never throws. The text of an unparsable file is not echoed to stderr.
 *
 * @param {string} statePath - Path of the state file
 * @param {{quiet?: boolean, hook?: string}} [opts]
 *   `quiet`: say nothing on stderr. For a read that only informs a decision and is followed by
 *   the read-modify-write, which says why it refused.
 *   `hook`: the name the stderr line carries, `[artibot:<hook>]`: the calling hook script's own,
 *   so a refusal is attributed to the hook that made it. Default `subagent-handler`; an empty
 *   or non-string value falls back to the default rather than printing a label nobody can read.
 * @returns {object|null}
 */
export function readStateForUpdate(statePath, opts) {
  const { quiet = false, hook } = opts ?? {};
  const label = typeof hook === 'string' && hook !== '' ? hook : DEFAULT_HOOK;
  const refuse = (message, cause) => {
    if (!quiet) logHookError(label, message, cause);
    return null;
  };
  let text;
  try {
    text = readFileSync(statePath, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { agents: {} };
    return refuse('team state left untouched (unreadable)', err);
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return refuse('team state left untouched (not valid JSON)');
  }
  const shapeOk = isPlainObject(state)
    && (state.agents === undefined || state.agents === null || isPlainObject(state.agents));
  return shapeOk ? state : refuse('team state left untouched (not a state object)');
}

/**
 * The row the state file holds for `agentId`, or `undefined`: there is none, or the file
 * cannot be read whole (what {@link readStateForUpdate} refuses).
 *
 * An UNLOCKED read, for a decision that comes before the locked write, which reads again.
 * It is whole all the same: `atomicWriteSync` replaces the file by rename. Quiet, because
 * the locked read is the one that says why it refused. The row is looked up by own key, so
 * an id such as `__proto__` finds nothing.
 *
 * @param {string} statePath - Path of the state file
 * @param {string} agentId
 * @returns {object|undefined}
 */
export function readAgentEntry(statePath, agentId) {
  const agents = readStateForUpdate(statePath, { quiet: true })?.agents;
  if (!isPlainObject(agents) || !Object.hasOwn(agents, agentId)) return undefined;
  return isPlainObject(agents[agentId]) ? agents[agentId] : undefined;
}
