#!/usr/bin/env node
/**
 * Workflow status hook.
 * Renders team dashboard updates on teammate state changes, task completions,
 * and error events. Integrates with the TUI module for visual output.
 *
 * Usage: node workflow-status.js <event-type>
 * Events: teammate-update | task-complete | task-error | workflow-advance
 */

import { readStdin, writeStdout, parseJSON, getPluginRoot } from '../utils/index.js';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

// Dynamic import of TUI module (ESM)
const tuiPath = path.join(getPluginRoot(), 'lib', 'core', 'tui.js');

function getStatePath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.claude', 'artibot-state.json');
}

function loadState() {
  const statePath = getStatePath();
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
  const statePath = getStatePath();
  const dir = path.dirname(statePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

function addEvent(state, type, agent, message) {
  if (!state.events) state.events = [];
  state.events.push({
    timestamp: new Date().toISOString(),
    type,
    agent,
    message,
  });
  // Keep last 50 events
  if (state.events.length > 50) {
    state.events = state.events.slice(-50);
  }
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

  const state = loadState();
  if (!state.agents) state.agents = {};
  if (!state.events) state.events = [];

  const agentId = hookData?.agent_id || hookData?.teammate_id || hookData?.name || 'unknown';
  const agentRole = hookData?.role || hookData?.agent_type || '';

  switch (eventType) {
    case 'teammate-update': {
      // Update agent state
      const existing = state.agents[agentId] || {};
      state.agents[agentId] = {
        ...existing,
        role: agentRole || existing.role || 'teammate',
        active: hookData?.active !== false,
        currentTask: hookData?.current_task || hookData?.currentTask || existing.currentTask || '',
        progress: hookData?.progress ?? existing.progress,
        blocked: hookData?.blocked || false,
        error: hookData?.error || null,
        updatedAt: new Date().toISOString(),
      };

      const statusVerb = hookData?.active === false ? 'went idle' : 'updated';
      addEvent(state, 'info', agentId, `Agent ${statusVerb}`);
      break;
    }

    case 'task-complete': {
      const taskId = hookData?.task_id || hookData?.taskId || '';
      const taskSubject = hookData?.subject || hookData?.task_subject || '';

      // Update task in state
      if (state.tasks) {
        const task = state.tasks.find((t) => String(t.id) === String(taskId));
        if (task) {
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
        }
      }

      // Update agent completed count
      if (state.agents[agentId]) {
        const agent = state.agents[agentId];
        agent.tasksCompleted = (agent.tasksCompleted || 0) + 1;
        agent.currentTask = '';
      }

      addEvent(state, 'success', agentId, `Completed: ${taskSubject || `task #${taskId}`}`);
      break;
    }

    case 'task-error': {
      const errorMsg = hookData?.error || hookData?.message || 'Unknown error';
      const taskId = hookData?.task_id || hookData?.taskId || '';

      // Mark agent as errored
      if (state.agents[agentId]) {
        state.agents[agentId].error = errorMsg;
      }

      addEvent(state, 'error', agentId, `Error on task #${taskId}: ${errorMsg}`);
      break;
    }

    case 'workflow-advance': {
      const phase = hookData?.phase ?? hookData?.step ?? 0;
      const playbook = hookData?.playbook || state.workflow?.playbook || 'feature';

      state.workflow = {
        playbook,
        currentPhase: phase,
        updatedAt: new Date().toISOString(),
      };

      const phaseNames = {
        feature: ['Plan', 'Design', 'Implement', 'Review', 'Test', 'Merge'],
        bugfix: ['Triage', 'Reproduce', 'Fix', 'Test', 'Review', 'Merge'],
        refactor: ['Analyze', 'Plan', 'Refactor', 'Test', 'Review', 'Merge'],
        security: ['Scan', 'Assess', 'Fix', 'Verify', 'Audit', 'Merge'],
      };
      const phases = phaseNames[playbook] || phaseNames.feature;
      const phaseName = phases[phase] || `Phase ${phase}`;

      addEvent(state, 'action', agentId || 'orchestrator', `Workflow advanced to: ${phaseName}`);
      break;
    }

    default:
      addEvent(state, 'info', agentId, `Event: ${eventType}`);
      break;
  }

  saveState(state);

  // Build dashboard message
  const teammates = buildTeammateList(state.agents);
  const tasks = (state.tasks || []).map((t) => ({
    id: t.id,
    subject: t.subject || t.name || '',
    status: t.status || 'pending',
    owner: t.owner || '',
  }));

  // Construct a summary message
  const activeCnt = teammates.filter((t) => t.status === 'in_progress').length;
  const blockedCnt = teammates.filter((t) => t.status === 'blocked').length;
  const errorCnt = teammates.filter((t) => t.status === 'error').length;

  const parts = [`[workflow] ${eventType}`];
  parts.push(`Team: ${teammates.length} members (${activeCnt} active)`);

  if (blockedCnt > 0) parts.push(`BLOCKED: ${blockedCnt}`);
  if (errorCnt > 0) parts.push(`ERRORS: ${errorCnt}`);

  if (state.workflow) {
    const phaseNames = {
      feature: ['Plan', 'Design', 'Implement', 'Review', 'Test', 'Merge'],
      bugfix: ['Triage', 'Reproduce', 'Fix', 'Test', 'Review', 'Merge'],
      refactor: ['Analyze', 'Plan', 'Refactor', 'Test', 'Review', 'Merge'],
      security: ['Scan', 'Assess', 'Fix', 'Verify', 'Audit', 'Merge'],
    };
    const phases = phaseNames[state.workflow.playbook] || phaseNames.feature;
    const currentName = phases[state.workflow.currentPhase] || '?';
    parts.push(`Phase: ${currentName} (${state.workflow.currentPhase + 1}/${phases.length})`);
  }

  writeStdout({ message: parts.join(' | ') });
}

main().catch((err) => {
  process.stderr.write(`[artibot:workflow-status] ${err.message}\n`);
});
