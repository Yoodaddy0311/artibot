/**
 * Team-state helpers for subagent-handler.js: `~/.claude/artibot-state.json`
 * read, write, locked update, and the top-level team context.
 *
 * Not a hook — nothing here runs on import, and there is no direct-run entry.
 * Extracted from subagent-handler.js (which had reached the 800-line cap) with
 * the bodies unchanged; the one new piece is updateTeamState().
 *
 * @module scripts/hooks/_team-state
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteSync } from '../utils/index.js';
import { getStatePath, logHookError } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';

export function loadState() {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return { agents: {} };
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { agents: {} };
  }
}

export function saveState(state) {
  const statePath = getStatePath();
  atomicWriteSync(statePath, state);
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
