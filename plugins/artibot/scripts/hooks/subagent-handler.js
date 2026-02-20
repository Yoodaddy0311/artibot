#!/usr/bin/env node
/**
 * SubagentStart / SubagentStop hook.
 * Tracks teammate registration and deregistration.
 * Usage: node subagent-handler.js start|stop
 */

import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';

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

  const state = loadState();
  if (!state.agents) state.agents = {};

  if (action === 'start') {
    state.agents[agentId] = {
      role: agentRole,
      active: true,
      startedAt: new Date().toISOString(),
    };
    saveState(state);
    writeStdout({
      message: `[team] Agent registered: ${agentId} (${agentRole})`,
    });
  } else if (action === 'stop') {
    if (state.agents[agentId]) {
      state.agents[agentId] = {
        ...state.agents[agentId],
        active: false,
        stoppedAt: new Date().toISOString(),
      };
    }
    saveState(state);
    writeStdout({
      message: `[team] Agent deregistered: ${agentId}`,
    });
  }
}

main().catch(createErrorHandler('subagent-handler', { exit: true }));
