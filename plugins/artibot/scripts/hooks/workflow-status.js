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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanupStaleStateTmpFiles, createErrorHandler, extractAgentId, extractAgentRole, getStatePath as getStateFilePath } from '../../lib/core/hook-utils.js';
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

/**
 * Derive aggregate team task progress from the shared `state.tasks` array.
 * Counts only tasks the team store actually knows about — when the array is
 * empty (no task store wired) this returns { completed: 0, total: 0 } and
 * callers treat it as "no progress data".
 *
 * @param {object} state - Loaded workflow state
 * @returns {{ completed: number, total: number }}
 */
function deriveTeamProgress(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const total = tasks.length;
  const completed = tasks.filter((t) => t && t.status === 'completed').length;
  return { completed, total };
}

/**
 * Infer the current workflow phase index from the completed/total task ratio.
 * Maps progress proportionally onto the playbook's phase list so the dashboard
 * shows a live "Phase X/N" line driven by real task completion — without any
 * caller having to emit an explicit `workflow-advance` event.
 *
 * Returns null when there is no task data (total === 0), so callers leave the
 * workflow phase untouched rather than fabricating phase 0.
 *
 * @param {number} completed - Completed task count
 * @param {number} total - Total task count
 * @param {string} playbook - Playbook key (feature|bugfix|refactor|security)
 * @returns {number|null} Zero-based phase index, or null when no data
 */
function derivePhaseFromProgress(completed, total, playbook) {
  if (!total || total <= 0) return null;
  const phases = PHASE_NAMES[playbook] || PHASE_NAMES.feature;
  const ratio = Math.min(1, Math.max(0, completed / total));
  // Last phase (Merge) is reserved for ratio === 1; in-flight work maps onto
  // the earlier phases. floor(ratio * (N-1)) keeps phase 0 until the first
  // completion and only reaches the final phase at 100%.
  return ratio >= 1 ? phases.length - 1 : Math.floor(ratio * (phases.length - 1));
}

/**
 * Build a new workflow object from derived task progress (immutable). Returns
 * the prior workflow unchanged when there is no task data to derive from, so
 * an explicitly-set phase (via the workflow-advance event) is never clobbered
 * by a no-data teammate-update.
 *
 * @param {object} state - Current state
 * @returns {object|null} New workflow object, or the existing one
 */
function deriveWorkflow(state) {
  const { completed, total } = deriveTeamProgress(state);
  const playbook = state.workflow?.playbook || 'feature';
  const phase = derivePhaseFromProgress(completed, total, playbook);
  if (phase === null) return state.workflow || null;
  return {
    playbook,
    currentPhase: phase,
    completed,
    total,
    derived: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Reconcile the shared `state.tasks` array with task data carried on the hook
 * payload. Claude Code surfaces team task signals under a few keys depending on
 * the slot:
 *   - `tasks`           — full task list ({ id, status } objects)
 *   - `completed_tasks` — ids/objects of tasks finished this turn
 *   - `tasks_total`     — explicit total when only a count is available
 *
 * The reconciliation is additive and idempotent: known task ids keep their
 * status (upgraded to 'completed' when they appear in completed_tasks), and a
 * bare `tasks_total` synthesizes placeholder entries so the progress ratio has
 * a denominator. Returns the prior task array unchanged when the payload
 * carries nothing, so an empty payload never wipes accumulated state.
 *
 * @param {object[]} current - Existing state.tasks
 * @param {object} hookData - Parsed hook payload
 * @returns {object[]} New task array (immutable)
 */
function reconcileTasks(current, hookData) {
  const prior = Array.isArray(current) ? current : [];
  const byId = new Map(prior.map((t) => [String(t.id), t]));

  const payloadTasks = Array.isArray(hookData?.tasks) ? hookData.tasks : [];
  for (const t of payloadTasks) {
    if (!t || t.id === undefined || t.id === null) continue;
    const id = String(t.id);
    byId.set(id, { ...(byId.get(id) || {}), id, status: t.status || byId.get(id)?.status || 'pending' });
  }

  const completed = Array.isArray(hookData?.completed_tasks) ? hookData.completed_tasks : [];
  for (const c of completed) {
    const id = String(c?.id ?? c);
    if (id === 'undefined' || id === 'null') continue;
    byId.set(id, { ...(byId.get(id) || { id }), id, status: 'completed' });
  }

  // Synthesize placeholder rows from an explicit total when no richer list exists.
  const explicitTotal = Number(hookData?.tasks_total);
  if (Number.isFinite(explicitTotal) && explicitTotal > byId.size) {
    for (let i = byId.size; i < explicitTotal; i++) {
      const id = `synth-${i}`;
      if (!byId.has(id)) byId.set(id, { id, status: 'pending', synthetic: true });
    }
  }

  return byId.size === prior.length && payloadTasks.length === 0 && completed.length === 0
    ? prior
    : [...byId.values()];
}

/**
 * Resolve the Agent Teams task-list directory for the current team.
 *
 * The real progress data lives in `~/.claude/tasks/<team>/<N>.json` (written by
 * TaskCreate/TaskUpdate), NOT in the subagent-lifecycle hook payload — which is
 * why phase/percent never rendered before this wiring. Team identity MUST come
 * from the payload/env (`team_name`/`teamName`/`CLAUDE_TEAM_NAME`); we never
 * guess by "most recent dir" because that would read a DIFFERENT team's progress
 * (wrong-team data is worse than no data) and would also make unit tests read the
 * real filesystem. No explicit team → return null (degrade to payload counts).
 *
 * @param {object} hookData
 * @returns {string|null} absolute task dir, or null if no explicit team resolves
 */
function resolveTeamTaskDir(hookData) {
  const named = hookData?.team_name || hookData?.teamName || process.env.CLAUDE_TEAM_NAME;
  if (!named) return null;
  const dir = join(homedir(), '.claude', 'tasks', named);
  try {
    if (existsSync(dir) && readdirSync(dir).some((f) => /^\d+\.json$/.test(f))) return dir;
  } catch { return null; }
  return null;
}

/**
 * Read team tasks from the on-disk Agent Teams task list. Returns `[]` on any
 * error so the caller degrades to whatever the payload carried (never throws).
 * @param {object} hookData
 * @returns {{ id: string, status: string }[]}
 */
function readTeamTasksFromDisk(hookData) {
  try {
    const dir = resolveTeamTaskDir(hookData);
    if (!dir) return [];
    const out = [];
    for (const f of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const t = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (!t || t.status === 'deleted') continue;
        out.push({ id: String(t.id ?? f.replace('.json', '')), status: t.status || 'pending' });
      } catch { /* skip unreadable task file */ }
    }
    return out;
  } catch {
    return [];
  }
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
  const hookData = parseJSON(raw) || {};

  // WIRE: Claude Code's subagent-lifecycle payload carries no team task counts,
  // so phase/percent stayed empty. When the payload has no task data, hydrate it
  // from the real source — the on-disk Agent Teams task list — so reconcileTasks
  // → deriveTeamProgress → deriveWorkflow see actual totals. Best-effort: an empty
  // read leaves the payload untouched (no fabrication when there is no team).
  if (!Array.isArray(hookData.tasks) || hookData.tasks.length === 0) {
    const diskTasks = readTeamTasksFromDisk(hookData);
    if (diskTasks.length > 0) hookData.tasks = diskTasks;
  }

  const agentId = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData, '');

  // Best-effort: sweep orphan `.tmp.<pid>` files (>1min old) before write.
  cleanupStaleStateTmpFiles(getStateFilePath());

  // All state mutations happen inside the file lock (read-modify-write)
  const finalState = withFileLock(getStateFilePath(), () => {
    const loaded = loadState();
    let state = {
      ...loaded,
      agents: { ...(loaded.agents || {}) },
      events: [...(loaded.events || [])],
      tasks: [...(loaded.tasks || [])],
    };

    // Reconcile any team task data carried on the payload before dispatching,
    // so both the derived phase (Opt-A) and the aggregate counts (Opt-B) see
    // up-to-date totals regardless of which event fired.
    state = { ...state, tasks: reconcileTasks(state.tasks, hookData) };

    switch (eventType) {
      case 'teammate-update': {
        const existing = state.agents[agentId] || {};
        // Opt-B: surface aggregate team task counts on the teammate record so
        // the dashboard's tasksTotal/tasksCompleted fields are populated even
        // though Claude Code's SubagentStart/Stop payload carries no per-agent
        // progress. tasksCompleted still honors any per-agent +1 count from the
        // task-complete event; only the team-wide total is injected here.
        const { completed, total } = deriveTeamProgress(state);
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
              tasksCompleted: existing.tasksCompleted ?? (total > 0 ? completed : undefined),
              tasksTotal: total > 0 ? total : existing.tasksTotal,
              blocked: hookData?.blocked || false,
              error: hookData?.error || null,
              updatedAt: new Date().toISOString(),
            },
          },
        };

        // Opt-A: refresh the derived workflow phase from current task progress.
        state = { ...state, workflow: deriveWorkflow(state) };

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
        // Opt-A: a completed task is the canonical moment to advance the
        // derived workflow phase.
        state = { ...state, workflow: deriveWorkflow(state) };
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

  // Skip dashboard output when there are no teammates (solo mode)
  if (teammates.length === 0) {
    writeStdout({});
    return;
  }

  const parts = [`[workflow] ${eventType}`];
  parts.push(`Team: ${teammates.length} members (${activeCnt} active)`);

  if (blockedCnt > 0) parts.push(`BLOCKED: ${blockedCnt}`);
  if (errorCnt > 0) parts.push(`ERRORS: ${errorCnt}`);

  // Aggregate task progress (Opt-B): only shown when the team task store has
  // entries, so an unwired session shows team/phase info without a misleading
  // "0/0" progress bar.
  const { completed, total } = deriveTeamProgress(finalState);
  if (total > 0) {
    const pct = Math.round((completed / total) * 100);
    parts.push(`Progress: ${completed}/${total} tasks (${pct}%)`);
  }

  if (finalState.workflow) {
    const phases = PHASE_NAMES[finalState.workflow.playbook] || PHASE_NAMES.feature;
    const currentName = phases[finalState.workflow.currentPhase] || '?';
    parts.push(`Phase: ${currentName} (${finalState.workflow.currentPhase + 1}/${phases.length})`);
  }

  writeStdout({ message: parts.join(' | ') });
}

main().catch(createErrorHandler('workflow-status', { exit: true }));
