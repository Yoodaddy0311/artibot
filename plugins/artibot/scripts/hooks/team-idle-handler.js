#!/usr/bin/env node
/**
 * TeammateIdle hook.
 * Notifies when a teammate becomes idle and can accept new tasks.
 * Supports returning { stop: true } (v2.1.69+) to gracefully stop
 * idle teammates when no work remains and auto-stop is configured.
 *
 * Hook attachment (hooks.json): TeammateIdle
 * Stdin: Claude Code hook data JSON
 * Stdout: JSON { message, stop? }
 *
 * HOST SEMANTICS — read before "fixing" the output shape. The hooks reference
 * (code.claude.com/docs/en/hooks.md, "TeammateIdle decision control", read
 * 2026-10-02) says, verbatim: "Exit code 2 or `{"continue": false,
 * "stopReason": "..."}` blocks the teammate from going idle, so it continues
 * working." and "To allow the teammate to go idle normally, exit 0 without
 * JSON or return any other exit code." Both controls mean the opposite of
 * stopping. So:
 *   - `stop: true` below is not a documented field. The auto-stop option
 *     (team.autoStopIdle, off by default and absent from the shipped config)
 *     therefore has no host effect beyond the message; it is not a way to end
 *     a teammate. Ending one is the leader's TaskStop / shutdown_request.
 *   - Do NOT rename `stop: true` to `continue: false`: that would turn
 *     "auto-stop" into "never let this teammate idle".
 *
 * PAYLOAD SHAPE is 미확인. The same reference documents `agent_id`,
 * `agent_type`, `idle_reason`; this repo's own fixture
 * (tests/hooks/hook-fired-direct.test.js, TeammateIdle case) carries
 * `teammate_name`/`team_name` and no `agent_id`; the shared state file held
 * an `agents.unknown` row (2026-10-02), so at least some real firings had no
 * key extractAgentId then read. Whenever a firing has no `agent_id`, its
 * top-level KEY NAMES (never values) go to `state.idlePayloadWithoutAgentId`
 * so the shape the host really sends can be measured. Consequence to know: a
 * firing keyed by `teammate_name` lands on a different `agents` row than the
 * SubagentStart row keyed by `agent_id`, if teammates fire SubagentStart.
 */

import { atomicWriteSync, parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';
import { isMainEntry, tapDirectFiring } from './_main-entry.js';

/** Maximum consecutive idle events before auto-stop (0 = disabled). */
const DEFAULT_MAX_IDLE_COUNT = 0;

/**
 * Load the auto-stop configuration from artibot.config.json.
 * @returns {{ enabled: boolean, maxIdleCount: number }}
 */
function loadAutoStopConfig() {
  try {
    const configPath = resolveConfigPath('artibot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const teamConfig = config.team || {};
    return {
      enabled: teamConfig.autoStopIdle === true,
      maxIdleCount: teamConfig.maxIdleCount ?? DEFAULT_MAX_IDLE_COUNT,
    };
  } catch {
    return { enabled: false, maxIdleCount: DEFAULT_MAX_IDLE_COUNT };
  }
}

/**
 * Return a new state with the idle count for the given agent incremented (immutable).
 * @param {string} agentId
 * @param {object} state
 * @returns {{ state: object, count: number }}
 */
function trackIdleCount(agentId, state) {
  const idleCounts = { ...(state.idleCounts || {}) };
  const prev = idleCounts[agentId] || 0;
  const count = prev + 1;
  return {
    state: { ...state, idleCounts: { ...idleCounts, [agentId]: count } },
    count,
  };
}

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
  const autoStopConfig = loadAutoStopConfig();

  // Read-modify-write under file lock
  const { pendingTasks, shouldStop, idleCount } = withFileLock(statePath, () => {
    let state = {};
    let pending = [];

    if (existsSync(statePath)) {
      try {
        state = JSON.parse(readFileSync(statePath, 'utf-8'));
        pending = (state.tasks || []).filter((t) => t.status === 'pending');
      } catch {
        // Ignore
      }
    }

    let stop = false;
    let count = 0;

    if (pending.length > 0) {
      // Reset idle count when new work appears.
      const newIdleCounts = state.idleCounts
        ? { ...state.idleCounts, [agentId]: 0 }
        : state.idleCounts;
      state = {
        ...state,
        ...(newIdleCounts ? { idleCounts: newIdleCounts } : {}),
      };
    } else if (autoStopConfig.enabled && autoStopConfig.maxIdleCount > 0) {
      const tracked = trackIdleCount(agentId, state);
      state = tracked.state;
      count = tracked.count;
      if (count >= autoStopConfig.maxIdleCount) {
        stop = true;
      }
    }

    state = withIdlePayloadRecord(state, hookData);

    atomicWriteSync(statePath, state);
    return {
      pendingTasks: pending,
      shouldStop: stop,
      idleCount: count,
      teamState: state,
    };
  });

  // Build output message (no state mutation needed)
  const parts = [`[team] Teammate idle: ${agentId}`];
  if (agentRole) parts[0] += ` (${agentRole})`;

  if (pendingTasks.length > 0) {
    parts.push(`${pendingTasks.length} pending task(s) available for assignment.`);
  } else {
    parts.push('No pending tasks.');
    if (autoStopConfig.enabled && autoStopConfig.maxIdleCount > 0) {
      if (shouldStop) {
        parts.push(`Auto-stopping after ${idleCount} idle events.`);
      } else {
        parts.push(`Idle count: ${idleCount}/${autoStopConfig.maxIdleCount}.`);
      }
    } else {
      parts.push('Ready for new work.');
    }
  }

  const result = shouldStop
    ? { message: parts.join(' | '), stop: true }
    : { message: parts.join(' | ') };

  writeStdout(result);
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('team-idle-handler', { exit: true }));
}
