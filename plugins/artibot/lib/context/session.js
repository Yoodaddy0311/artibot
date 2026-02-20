/**
 * Session state management.
 * Tracks active agents, in-progress tasks, and history within a session.
 * @module lib/context/session
 */

import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../core/file.js';
import { getHomeDir } from '../core/platform.js';

const STATE_FILENAME = 'artibot-state.json';

/**
 * Get the state file path (~/.claude/artibot-state.json).
 */
function getStatePath() {
  return path.join(getHomeDir(), '.claude', STATE_FILENAME);
}

/**
 * Default session state.
 */
function defaultState() {
  return {
    sessionId: null,
    startedAt: null,
    agents: {},
    tasks: [],
    history: [],
    metadata: {},
  };
}

/**
 * Load persisted session state from disk.
 * @returns {Promise<object>}
 */
export async function loadSessionState() {
  const data = await readJsonFile(getStatePath());
  return data ? { ...defaultState(), ...data } : defaultState();
}

/**
 * Save session state to disk.
 * @param {object} state
 */
export async function saveSessionState(state) {
  await writeJsonFile(getStatePath(), state);
}

/**
 * Register an active agent in the session.
 * @param {object} state
 * @param {string} agentId
 * @param {object} [info] - Additional agent info
 * @returns {object} Updated state (immutable)
 */
export function registerAgent(state, agentId, info = {}) {
  return {
    ...state,
    agents: {
      ...state.agents,
      [agentId]: { ...info, registeredAt: new Date().toISOString(), active: true },
    },
  };
}

/**
 * Unregister (deactivate) an agent.
 * @param {object} state
 * @param {string} agentId
 * @returns {object} Updated state (immutable)
 */
export function unregisterAgent(state, agentId) {
  const existing = state.agents[agentId];
  if (!existing) return state;
  return {
    ...state,
    agents: {
      ...state.agents,
      [agentId]: { ...existing, active: false, stoppedAt: new Date().toISOString() },
    },
  };
}

/**
 * Add a task to the session.
 * @param {object} state
 * @param {{ id: string, description: string, status?: string }} task
 * @returns {object} Updated state (immutable)
 */
export function addTask(state, task) {
  return {
    ...state,
    tasks: [...state.tasks, { status: 'pending', createdAt: new Date().toISOString(), ...task }],
  };
}

/**
 * Update a task's status.
 * @param {object} state
 * @param {string} taskId
 * @param {string} status
 * @returns {object} Updated state (immutable)
 */
export function updateTaskStatus(state, taskId, status) {
  return {
    ...state,
    tasks: state.tasks.map((t) =>
      t.id === taskId ? { ...t, status, updatedAt: new Date().toISOString() } : t,
    ),
  };
}

/**
 * Add an entry to session history.
 * @param {object} state
 * @param {string} event
 * @param {object} [data]
 * @returns {object} Updated state (immutable)
 */
export function addHistory(state, event, data = {}) {
  return {
    ...state,
    history: [...state.history, { event, ...data, timestamp: new Date().toISOString() }],
  };
}

/**
 * Get all active agents.
 * @param {object} state
 * @returns {string[]}
 */
export function getActiveAgents(state) {
  return Object.entries(state.agents)
    .filter(([, v]) => v.active)
    .map(([k]) => k);
}

/**
 * Get in-progress tasks.
 * @param {object} state
 * @returns {object[]}
 */
export function getInProgressTasks(state) {
  return state.tasks.filter((t) => t.status === 'in_progress');
}
