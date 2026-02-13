#!/usr/bin/env node
/**
 * TeammateIdle hook.
 * Notifies when a teammate becomes idle and can accept new tasks.
 */

import { readStdin, writeStdout, parseJSON } from '../utils/index.js';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const agentId = hookData?.agent_id || hookData?.teammate_id || hookData?.name || 'unknown';
  const agentRole = hookData?.role || '';

  // Check if there are pending tasks in state
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const statePath = path.join(home, '.claude', 'artibot-state.json');
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

main().catch((err) => {
  process.stderr.write(`[artibot:team-idle-handler] ${err.message}\n`);
});
