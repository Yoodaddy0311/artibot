#!/usr/bin/env node
/**
 * SubagentStart / SubagentStop hook.
 * Tracks teammate registration and deregistration.
 * Usage: node subagent-handler.js start|stop
 */

import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { cleanupStaleStateTmpFiles, createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';
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
function initTeamContext(loaded, hookData, agentRole) {
  const teamId = loaded.teamId ?? deriveTeamId(hookData);
  const domain = loaded.domain ?? deriveDomain(hookData, agentRole);
  const startedAt = typeof loaded.startedAt === 'number'
    ? loaded.startedAt
    : Date.now();
  return { teamId, domain, startedAt };
}

async function main() {
  const action = process.argv[2]; // 'start' or 'stop'
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const agentId = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData);
  const agentType = hookData?.agent_type || agentRole;

  const statePath = getStatePath();
  // Best-effort: sweep orphan `.tmp.<pid>` files (>1min old) that prior
  // crashes or EPERM failures may have left in ~/.claude/.
  cleanupStaleStateTmpFiles(statePath);

  if (action === 'start') {
    withFileLock(statePath, () => {
      const loaded = loadState();
      const teamCtx = initTeamContext(loaded, hookData, agentRole);
      const updatedState = {
        ...loaded,
        ...teamCtx,
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
