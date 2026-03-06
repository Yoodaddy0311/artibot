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

import { parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';

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
 * Get the idle count for an agent from state, and increment it.
 * @param {string} agentId
 * @param {object} state
 * @returns {number} Current idle count (after increment)
 */
function trackIdleCount(agentId, state) {
  if (!state.idleCounts) state.idleCounts = {};
  const prev = state.idleCounts[agentId] || 0;
  state.idleCounts[agentId] = prev + 1;
  return prev + 1;
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const agentId = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData, '');
  const agentType = hookData?.agent_type || agentRole;

  // Check if there are pending tasks in state
  const statePath = getStatePath();
  let pendingTasks = [];
  let state = {};

  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf-8'));
      pendingTasks = (state.tasks || []).filter((t) => t.status === 'pending');
    } catch {
      // Ignore
    }
  }

  const parts = [`[team] Teammate idle: ${agentId}`];
  if (agentRole) parts[0] += ` (${agentRole})`;

  // Determine if we should stop this idle teammate
  let shouldStop = false;
  const autoStopConfig = loadAutoStopConfig();

  if (pendingTasks.length > 0) {
    parts.push(`${pendingTasks.length} pending task(s) available for assignment.`);
    // Reset idle count when tasks are available
    if (state.idleCounts) state.idleCounts[agentId] = 0;
  } else {
    parts.push('No pending tasks.');

    if (autoStopConfig.enabled && autoStopConfig.maxIdleCount > 0) {
      const idleCount = trackIdleCount(agentId, state);
      if (idleCount >= autoStopConfig.maxIdleCount) {
        shouldStop = true;
        parts.push(`Auto-stopping after ${idleCount} idle events.`);
      } else {
        parts.push(`Idle count: ${idleCount}/${autoStopConfig.maxIdleCount}.`);
      }
    } else {
      parts.push('Ready for new work.');
    }
  }

  const result = { message: parts.join(' | ') };
  if (shouldStop) {
    result.stop = true;
  }

  writeStdout(result);
}

main().catch(createErrorHandler('team-idle-handler', { exit: true }));
