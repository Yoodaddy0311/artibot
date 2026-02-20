#!/usr/bin/env node
/**
 * TeammateIdle hook.
 * Notifies when a teammate becomes idle and can accept new tasks.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const agentId = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData, '');

  // Check if there are pending tasks in state
  const statePath = getStatePath();
  let pendingTasks = [];

  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      pendingTasks = (state.tasks || []).filter((t) => t.status === 'pending');
    } catch {
      // Ignore
    }
  }

  const parts = [`[team] Teammate idle: ${agentId}`];
  if (agentRole) parts[0] += ` (${agentRole})`;

  if (pendingTasks.length > 0) {
    parts.push(`${pendingTasks.length} pending task(s) available for assignment.`);
  } else {
    parts.push('No pending tasks. Ready for new work.');
  }

  writeStdout({ message: parts.join(' | ') });
}

main().catch(createErrorHandler('team-idle-handler', { exit: true }));
