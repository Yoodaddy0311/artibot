#!/usr/bin/env node
/**
 * SubagentStart / SubagentStop hook.
 * Tracks teammate registration and deregistration.
 * Usage: node subagent-handler.js start|stop
 */

import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';

function loadState() {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return { agents: {} };
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { agents: {} };
  }
}

function saveState(state) {
  const statePath = getStatePath();
  atomicWriteSync(statePath, state);
}

async function main() {
  const action = process.argv[2]; // 'start' or 'stop'
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const agentId = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData);
  const agentType = hookData?.agent_type || agentRole;

  const statePath = getStatePath();

  if (action === 'start') {
    withFileLock(statePath, () => {
      const loaded = loadState();
      const updatedState = {
        ...loaded,
        agents: {
          ...(loaded.agents || {}),
          [agentId]: {
            role: agentRole,
            agentType,
            active: true,
            startedAt: new Date().toISOString(),
          },
        },
      };
      saveState(updatedState);
    });
    writeStdout({
      message: `[team] Agent registered: ${agentId} (${agentRole})`,
    });
  } else if (action === 'stop') {
    withFileLock(statePath, () => {
      const loaded = loadState();
      const existing = (loaded.agents || {})[agentId];
      const updatedState = existing
        ? {
            ...loaded,
            agents: {
              ...(loaded.agents || {}),
              [agentId]: {
                ...existing,
                active: false,
                stoppedAt: new Date().toISOString(),
              },
            },
          }
        : loaded;
      saveState(updatedState);
    });
    writeStdout({
      message: `[team] Agent deregistered: ${agentId}`,
    });
  }
}

main().catch(createErrorHandler('subagent-handler', { exit: true }));
