/**
 * Team-state helpers for subagent-handler.js: `~/.claude/artibot-state.json`
 * read, write, locked update, and the top-level team context.
 *
 * Not a hook — nothing here runs on import, and there is no direct-run entry.
 * Extracted from subagent-handler.js (which had reached the 800-line cap) with
 * the bodies unchanged; the one new piece is updateTeamState(). pruneAgents() was
 * added later and is also used by workflow-status.js, the file's other writer of
 * the `agents` map.
 *
 * @module scripts/hooks/_team-state
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteSync } from '../utils/index.js';
import { getStatePath, logHookError } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// RETENTION OF THE `agents` MAP. It is keyed by a per-spawn agent id and no writer ever
// removed a row, so every hook that loads and rewrites the file paid for all of them
// (measured 2026-10-06 on the live file: 1,666 rows / 453 KB five days after the last
// wipe, hundreds of new rows a day). Rows are dropped on the write path instead.

/**
 * How long a FINISHED agent's row stays: `active === false`, or a `stoppedAt` stamp.
 * `stoppedAt` counts on its own because rows already on disk can carry both: until
 * workflow-status recorded SubagentStop as inactive, its teammate-update — run beside the
 * stop handler by the SubagentStop dispatcher — wrote `active: true` back over the handler's
 * `active: false` (126 of the live file's 142 stopped rows read that way on 2026-10-06).
 * 7 days: nothing reads a stopped row after its stop record — the stop handler reads the
 * row it is stopping, and the statusline roster lists only rows touched within 10 minutes —
 * so the window only has to outlast a person looking back at a finished run.
 */
export const AGENT_RETENTION_MS = 7 * DAY_MS;

/**
 * Backstop for a burst inside the windows: past this many rows the oldest FINISHED rows go
 * first. An active row never does, so the map can stay over the cap while more than this many
 * agents are live, or have been silent for less than the ghost window.
 * Known (U4 review F2): the row a stop is writing in this very call is finished too, and over
 * the cap it can be among the first dropped. Left as is: nothing reads a finished row back
 * (handleStop took `tracked` before it saved; the roster lists only non-idle rows), and when
 * the stop saves first, the same stop's workflow-status upsert re-creates the row as an
 * inactive one (if the upsert saves first, the dropped row stays gone).
 */
export const AGENT_MAX_ENTRIES = 500;

// THE GHOST RULE is kept apart from the rules above so it can be dropped on its own: the
// constant below, isGhost(), and its one call in pruneAgents().

/**
 * How long an ACTIVE row with neither `stoppedAt` nor `startedAt` may go untouched before it
 * is a ghost. Measured on the live file, 2026-10-06: 1,666 rows, 1,524 of them active with no
 * stoppedAt, 701 of those untouched for 72h+. A rule that spared every active row ages out none
 * of them, and the cap then drops only the 142 finished rows.
 * Only rows no SubagentStart registered qualify. `startedAt` is written by handleStart alone
 * and nothing refreshes it while the subagent runs, so a registered row is quiet for as long as
 * the agent works. U4 review F1 measured it: a normal subagent living past 24h was deleted by
 * the first version of this rule, handleStop does not upsert, and its stop row lost
 * canonicalModel, actionClass and durationMs. Registered rows get the retention window, see
 * isGhost.
 * An unregistered row exists because workflow-status saw a lifecycle event for the id, and
 * its next event re-creates it (teammate-update upserts on SubagentStart, SubagentStop and
 * TeammateIdle). A day without a refresh means the stop was never recorded (cause not measured:
 * SubagentStop never fired, or its state update lost the lock) or the agent is still running
 * with no event in between; dropping the row loses nothing a stop reads either way.
 * 24 hours: the longest start-to-stop span among the file's 134 stopped rows was 10.2h
 * (p99 2.2h).
 */
export const AGENT_STALE_ACTIVE_MS = DAY_MS;

const isSet = (stamp) => stamp !== undefined && stamp !== null && stamp !== '';

// An ISO-8601 date-time with a time and a zone — the shape every writer here emits
// (toISOString()). Date.parse alone takes far more ('1' is the year 2001), so a foreign or
// hand-edited stamp could read as ancient; anything outside this shape is not trusted to age a row.
const ISO_8601_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether a row is a ghost: active, no stop recorded, silent past AGENT_STALE_ACTIVE_MS.
 * A row REGISTERED at SubagentStart (it has `startedAt`, which only subagent-handler writes)
 * gets the retention window instead: handleStop reads startedAt, agentType, canonicalModel and
 * the routing columns back from it, and a named reviewer's stop counts as a review only when
 * `tracked.startedAt` is there (_review-stop-record.js#isReviewerStop). A row only
 * workflow-status wrote holds none of that, so dropping it loses nothing a stop reads.
 * @param {{finished: boolean, registered: boolean, at: number|null}} row
 * @param {number} nowMs
 * @returns {boolean}
 */
function isGhost({ finished, registered, at }, nowMs) {
  if (finished || at === null) return false;
  return nowMs - at > (registered ? AGENT_RETENTION_MS : AGENT_STALE_ACTIVE_MS);
}

/**
 * Newest of `updatedAt` / `stoppedAt` / `startedAt` on a row, in ms. Null when the age cannot
 * be told — no stamp at all, or any stamp that is not an ISO-8601 date-time that parses.
 * Unknown is not old. A stamp in the future is kept until it arrives and a non-string (numeric)
 * stamp for good (U4 review F4): both fail toward keeping the row.
 * @param {object} agent
 * @returns {number|null}
 */
function lastActivityMs(agent) {
  let newest = null;
  for (const field of ['updatedAt', 'stoppedAt', 'startedAt']) {
    const stamp = agent[field];
    if (!isSet(stamp)) continue;
    const ms = typeof stamp === 'string' && ISO_8601_DATE_TIME.test(stamp) ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(ms)) return null;
    newest = newest === null ? ms : Math.max(newest, ms);
  }
  return newest;
}

/**
 * Return the state without the `agents` rows that have outlived the windows above. Immutable:
 * the input is untouched, and the very same object comes back when nothing is dropped.
 *
 * Order: (1) age — a finished row older than AGENT_RETENTION_MS, and the ghosts (isGhost);
 * (2) cap — the oldest finished rows until the map fits AGENT_MAX_ENTRIES, never an active
 * one. A row whose age is unknown is never dropped.
 *
 * Never throws: retention is housekeeping and a state write must not depend on it, so any
 * failure hands the state back as it came.
 *
 * @param {object} state - Team state about to be written
 * @param {number} [nowMs=Date.now()]
 * @returns {object}
 */
export function pruneAgents(state, nowMs = Date.now()) {
  try {
    const agents = state?.agents;
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return state;

    const entries = Object.entries(agents);
    const rows = entries.map(([id, agent]) => {
      const isRow = agent !== null && typeof agent === 'object';
      return {
        id,
        finished: isRow && (agent.active === false || isSet(agent.stoppedAt)),
        registered: isRow && isSet(agent.startedAt),
        at: isRow ? lastActivityMs(agent) : null,
      };
    });

    const drop = new Set(
      rows
        .filter(({ finished, at }) => finished && at !== null && nowMs - at > AGENT_RETENTION_MS)
        .map(({ id }) => id),
    );
    for (const row of rows) if (isGhost(row, nowMs)) drop.add(row.id);

    const excess = rows.length - drop.size - AGENT_MAX_ENTRIES;
    if (excess > 0) {
      const oldestFirst = rows
        .filter(({ id, finished, at }) => finished && at !== null && !drop.has(id))
        .sort((a, b) => a.at - b.at);
      for (const { id } of oldestFirst.slice(0, excess)) drop.add(id);
    }

    if (drop.size === 0) return state;
    return { ...state, agents: Object.fromEntries(entries.filter(([id]) => !drop.has(id))) };
  } catch {
    return state;
  }
}

export function loadState() {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return { agents: {} };
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { agents: {} };
  }
}

/** Write the state under ~/.claude, with the `agents` map pruned first (see pruneAgents). */
export function saveState(state) {
  const statePath = getStatePath();
  atomicWriteSync(statePath, pruneAgents(state));
}

/**
 * Run `mutate` (a loadState → saveState read-modify-write) under the state
 * file's lock.
 *
 * The update is best-effort, like the atomicWriteSync under it. When the lock
 * is not taken — `mutate` never ran: ELOCKTIMEOUT, ELOCKREENTRANT, or a create
 * error lib/core/file-lock.js rethrew — only this update is skipped, with a
 * note on stderr; the caller's ledger writes need no lock and still run. The
 * test is "did `mutate` run", not a list of codes: before withFileLock went
 * fail-closed, a lock it could not create still ran `mutate`, so ledger lines
 * were never lost to a lock. An error thrown BY `mutate` propagates.
 *
 * Cost of that rule: a defect inside withFileLock itself that throws before
 * `mutate` runs (a TypeError, say) is indistinguishable from a lock not taken.
 * It surfaces only as the stderr note and a state file that stops changing,
 * never as a hook failure.
 *
 * @param {string} statePath - Path of the state file (the lock is `<statePath>.lock`)
 * @param {() => void} mutate - Synchronous read-modify-write
 * @returns {boolean} Whether `mutate` ran
 */
export function updateTeamState(statePath, mutate) {
  let ran = false;
  try {
    withFileLock(statePath, () => { ran = true; mutate(); });
  } catch (err) {
    if (ran) throw err;
    logHookError('subagent-handler', 'team state not updated', err);
  }
  return ran;
}

/**
 * Derive a deterministic teamId from session context. Stable for the
 * duration of one Claude Code session so team-weight rounds aggregate
 * under a single id.
 */
function deriveTeamId(hookData) {
  const sessionId = hookData?.session_id || hookData?.sessionId || null;
  return sessionId ? `team-${sessionId}` : `team-${Date.now()}`;
}

/**
 * Pick a coarse domain bucket from hook payload. Falls back to the
 * teammate role; finally to `general` so downstream GRPO bucketing has
 * a non-undefined key.
 */
function deriveDomain(hookData, agentRole) {
  return hookData?.domain || hookData?.agent_type || agentRole || 'general';
}

/**
 * Idempotent team-context initializer. Only writes top-level fields
 * (`teamId`, `domain`, `startedAt`) when missing or carrying stale
 * non-numeric `startedAt` left over from a previous session-end snapshot.
 * `startedAt` is stored as numeric ms — team-idle-handler computes
 * `Date.now() - teamState.startedAt`.
 */
export function initTeamContext(loaded, hookData, agentRole) {
  const teamId = loaded.teamId ?? deriveTeamId(hookData);
  const domain = loaded.domain ?? deriveDomain(hookData, agentRole);
  const startedAt = typeof loaded.startedAt === 'number'
    ? loaded.startedAt
    : Date.now();
  return { teamId, domain, startedAt };
}
