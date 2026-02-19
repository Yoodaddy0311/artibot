#!/usr/bin/env node
/**
 * SubagentStart / SubagentStop hook.
 * Tracks teammate registration and deregistration.
 * Usage: node subagent-handler.js start|stop
 */

import { readStdin, writeStdout, parseJSON, atomicWriteSync } from '../utils/index.js';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

function getStatePath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.claude', 'artibot-state.json');
}

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

  const agentId = hookData?.agent_id || hookData?.subagent_id || hookData?.name || 'unknown';
  const agentRole = hookData?.role || hookData?.agent_type || 'teammate';

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

main().catch((err) => {
  process.stderr.write(`[artibot:subagent-handler] ${err.message}\n`);
  process.exit(0);
});
