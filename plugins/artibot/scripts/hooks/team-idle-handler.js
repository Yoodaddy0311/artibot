#!/usr/bin/env node
/**
 * TeammateIdle hook.
 * Notifies when a teammate becomes idle and can accept new tasks.
 *
 * Hook attachment (hooks.json): TeammateIdle
 * Stdin: Claude Code hook data JSON
 * Stdout: JSON { message }
 *
 * No `stop` output: not a documented TeammateIdle field (team.autoStopIdle
 * was removed for that reason). Do not reintroduce it.
 *
 * PAYLOAD SHAPE is 미확인. The hooks reference (read 2026-10-02) documents `agent_id`,
 * `agent_type`, `idle_reason`; this repo's own fixture
 * (tests/hooks/hook-fired-direct.test.js, TeammateIdle case) carries
 * `teammate_name`/`team_name` and no `agent_id`; the shared state file held
 * an `agents.unknown` row (2026-10-02), so at least some real firings had no
 * key extractAgentId then read. Whenever a firing has no `agent_id`, its
 * top-level KEY NAMES (never values) go to `state.idlePayloadWithoutAgentId`
 * so the shape the host really sends can be measured. Consequence to know: a
 * firing keyed by `teammate_name` lands on a different `agents` row than the
 * SubagentStart row keyed by `agent_id`, if teammates fire SubagentStart.
 * Not recorded when the state file could not be read (nothing is written
 * then, see the read in main()): an absent record is not proof of a payload
 * that carried `agent_id`.
 */

import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';
import { readStateForUpdate } from '../../lib/runtime/subagent-state-guard.js';
import { isMainEntry, tapDirectFiring } from './_main-entry.js';

/**
 * Key names (sorted, values dropped) of a payload.
 * @param {object|null} hookData
 * @returns {{ keys: string[], at: string }}
 */
export function payloadKeyRecord(hookData) {
  const keys = hookData && typeof hookData === 'object' ? Object.keys(hookData).sort() : [];
  return { keys, at: new Date().toISOString() };
}

/**
 * Return the state with the payload's key names recorded when the firing has
 * no `agent_id` (immutable; unchanged state otherwise).
 * @param {object} state
 * @param {object|null} hookData
 * @returns {object}
 */
export function withIdlePayloadRecord(state, hookData) {
  if (hookData?.agent_id) return state;
  return { ...state, idlePayloadWithoutAgentId: payloadKeyRecord(hookData) };
}

export async function main() {
  const raw = await readStdin();
  const hookData = tapDirectFiring(import.meta.url, parseJSON(raw));

  const agentId = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData, '');

  const statePath = getStatePath();

  // Read-modify-write under file lock
  const pendingTasks = withFileLock(statePath, () => {
    // The shared state file is read the way SubagentStart/Stop read it (readStateForUpdate,
    // lib/runtime/subagent-state-guard.js): only a read's own ENOENT is a missing file. `null` is
    // a file that is there but was not read as a state object (unreadable, not JSON, not an
    // object, an `agents` that is not an object): this firing then works out its message over an
    // empty state, as it did when that failure was ignored, and writes nothing. Written back,
    // that empty state (plus the key record) would replace every row the file holds, on every
    // TeammateIdle and TaskCompleted firing.
    const loaded = readStateForUpdate(statePath, { hook: 'team-idle-handler' });
    const state = loaded ?? {};
    let pending = [];

    try {
      pending = (state.tasks || []).filter((t) => t.status === 'pending');
    } catch {
      // A `tasks` that is not a list of rows: no pending tasks to report. The state is written
      // back as it was read.
    }

    if (loaded !== null) atomicWriteSync(statePath, withIdlePayloadRecord(state, hookData));
    return pending;
  });

  // Build output message (no state mutation needed)
  const parts = [`[team] Teammate idle: ${agentId}`];
  if (agentRole) parts[0] += ` (${agentRole})`;

  if (pendingTasks.length > 0) {
    parts.push(`${pendingTasks.length} pending task(s) available for assignment.`);
  } else {
    parts.push('No pending tasks.', 'Ready for new work.');
  }

  writeStdout({ message: parts.join(' | ') });
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('team-idle-handler', { exit: true }));
}
