#!/usr/bin/env node
/**
 * Workflow status hook.
 * Renders team dashboard updates on teammate state changes, task completions,
 * and error events. Integrates with the TUI module for visual output.
 *
 * Usage: node workflow-status.js <event-type>
 * Events: teammate-update | task-complete | task-error | workflow-advance
 */

import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { createErrorHandler, extractAgentId, extractAgentRole, getStatePath as getStateFilePath } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';

const PHASE_NAMES = {
  feature: ['Plan', 'Design', 'Implement', 'Review', 'Test', 'Merge'],
  bugfix: ['Triage', 'Reproduce', 'Fix', 'Test', 'Review', 'Merge'],
  refactor: ['Analyze', 'Plan', 'Refactor', 'Test', 'Review', 'Merge'],
  security: ['Scan', 'Assess', 'Fix', 'Verify', 'Audit', 'Merge'],
};

function loadState() {
  const statePath = getStateFilePath();
  if (!existsSync(statePath)) {
    return { agents: {}, tasks: [], events: [], workflow: null };
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { agents: {}, tasks: [], events: [], workflow: null };
  }
}

function saveState(state) {
  atomicWriteSync(getStateFilePath(), state);
}

/**
 * Return a new state with the event appended (immutable).
 * Keeps at most the last 50 events.
 */
function addEvent(state, type, agent, message) {
  const events = [...(state.events || []), {
    timestamp: new Date().toISOString(),
    type,
    agent,
    message,
  }];
  return {
    ...state,
    events: events.length > 50 ? events.slice(-50) : events,
  };
}

function mapAgentStatus(agent) {
  if (!agent.active) return 'idle';
  if (agent.blocked) return 'blocked';
  if (agent.error) return 'error';
  if (agent.currentTask) return 'in_progress';
  return 'ready';
}

function buildTeammateList(agents) {
  return Object.entries(agents || {}).map(([name, info]) => ({
    name,
    role: info.role || 'teammate',
    status: mapAgentStatus(info),
    currentTask: info.currentTask || '',
    progress: info.progress,
    tasksCompleted: info.tasksCompleted,
    tasksTotal: info.tasksTotal,
  }));
}

async function main() {
  const eventType = process.argv[2] || 'teammate-update';
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const agentId = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData, '');

  // All state mutations happen inside the file lock (read-modify-write)
  const finalState = withFileLock(getStateFilePath(), () => {
    const loaded = loadState();
    let state = {
      ...loaded,
      agents: { ...(loaded.agents || {}) },
      events: [...(loaded.events || [])],
      tasks: [...(loaded.tasks || [])],
    };

    switch (eventType) {
      case 'teammate-update': {
        const existing = state.agents[agentId] || {};
        state = {
          ...state,
          agents: {
            ...state.agents,
            [agentId]: {
              ...existing,
              role: agentRole || existing.role || 'teammate',
              active: hookData?.active !== false,
              currentTask: hookData?.current_task || hookData?.currentTask || existing.currentTask || '',
              progress: hookData?.progress ?? existing.progress,
              blocked: hookData?.blocked || false,
              error: hookData?.error || null,
              updatedAt: new Date().toISOString(),
            },
          },
        };

        const statusVerb = hookData?.active === false ? 'went idle' : 'updated';
        state = addEvent(state, 'info', agentId, `Agent ${statusVerb}`);
        break;
      }

      case 'task-complete': {
        const taskId = hookData?.task_id || hookData?.taskId || '';
        const taskSubject = hookData?.subject || hookData?.task_subject || '';

        // Update task in state (immutable)
        const updatedTasks = state.tasks.map((t) =>
          String(t.id) === String(taskId)
            ? { ...t, status: 'completed', completedAt: new Date().toISOString() }
            : t
        );

        // Update agent completed count (immutable)
        const agentEntry = state.agents[agentId];
        const updatedAgents = agentEntry
          ? {
              ...state.agents,
              [agentId]: {
                ...agentEntry,
                tasksCompleted: (agentEntry.tasksCompleted || 0) + 1,
                currentTask: '',
              },
            }
          : state.agents;

        state = { ...state, tasks: updatedTasks, agents: updatedAgents };
        state = addEvent(state, 'success', agentId, `Completed: ${taskSubject || `task #${taskId}`}`);
        break;
      }

      case 'task-error': {
        const errorMsg = hookData?.error || hookData?.message || 'Unknown error';
        const taskId = hookData?.task_id || hookData?.taskId || '';

        // Mark agent as errored (immutable)
        const agentEntry = state.agents[agentId];
        if (agentEntry) {
          state = {
            ...state,
            agents: {
              ...state.agents,
              [agentId]: { ...agentEntry, error: errorMsg },
            },
          };
        }

        state = addEvent(state, 'error', agentId, `Error on task #${taskId}: ${errorMsg}`);
        break;
      }

      case 'workflow-advance': {
        const phase = hookData?.phase ?? hookData?.step ?? 0;
        const playbook = hookData?.playbook || state.workflow?.playbook || 'feature';

        state = {
          ...state,
          workflow: {
            playbook,
            currentPhase: phase,
            updatedAt: new Date().toISOString(),
          },
        };

        const phases = PHASE_NAMES[playbook] || PHASE_NAMES.feature;
        const phaseName = phases[phase] || `Phase ${phase}`;

        state = addEvent(state, 'action', agentId || 'orchestrator', `Workflow advanced to: ${phaseName}`);
        break;
      }

      default:
        state = addEvent(state, 'info', agentId, `Event: ${eventType}`);
        break;
    }

    saveState(state);
    return state;
  });

  // Build dashboard message
  const teammates = buildTeammateList(finalState.agents);
  // Construct a summary message
  const activeCnt = teammates.filter((t) => t.status === 'in_progress').length;
  const blockedCnt = teammates.filter((t) => t.status === 'blocked').length;
  const errorCnt = teammates.filter((t) => t.status === 'error').length;

  const parts = [`[workflow] ${eventType}`];
  parts.push(`Team: ${teammates.length} members (${activeCnt} active)`);

  if (blockedCnt > 0) parts.push(`BLOCKED: ${blockedCnt}`);
  if (errorCnt > 0) parts.push(`ERRORS: ${errorCnt}`);

  if (finalState.workflow) {
    const phases = PHASE_NAMES[finalState.workflow.playbook] || PHASE_NAMES.feature;
    const currentName = phases[finalState.workflow.currentPhase] || '?';
    parts.push(`Phase: ${currentName} (${finalState.workflow.currentPhase + 1}/${phases.length})`);
  }

  writeStdout({ message: parts.join(' | ') });
}

main().catch(createErrorHandler('workflow-status', { exit: true }));
