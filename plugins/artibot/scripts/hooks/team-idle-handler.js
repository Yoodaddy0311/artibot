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
 */

import { atomicWriteSync, parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';

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

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

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
      // Reset idle count when tasks are available (immutable)
      if (state.idleCounts) {
        state = {
          ...state,
          idleCounts: { ...state.idleCounts, [agentId]: 0 },
        };
      }
    } else if (autoStopConfig.enabled && autoStopConfig.maxIdleCount > 0) {
      const tracked = trackIdleCount(agentId, state);
      state = tracked.state;
      count = tracked.count;
      if (count >= autoStopConfig.maxIdleCount) {
        stop = true;
      }
    }

    atomicWriteSync(statePath, state);
    return { pendingTasks: pending, shouldStop: stop, idleCount: count };
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

main().catch(createErrorHandler('team-idle-handler', { exit: true }));
