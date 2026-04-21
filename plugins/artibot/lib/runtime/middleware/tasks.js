/**
 * Runtime task middleware.
 * Builds a task envelope for downstream hook/team integrations.
 *
 * @module lib/runtime/middleware/tasks
 */

import path from 'node:path';
import { readJsonFileSync } from '../../core/file.js';

function makeTaskId(nowFn) {
  const now = nowFn();
  return `rt-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Load the most recent effort + task-budget meta written by runtime-prompt.js.
 * Returns null when the effort file is missing or unreadable — downstream code
 * must treat effort/budget as optional.
 *
 * @param {string|undefined} pluginRoot
 * @returns {{ effort: string|null, taskBudget: number|null, command: string|null }|null}
 */
function readEffortMeta(pluginRoot) {
  if (!pluginRoot) return null;
  const runtimeDir = path.join(pluginRoot, 'runtime');
  const effortRaw = readJsonFileSync(path.join(runtimeDir, 'current-effort.json'));
  if (!effortRaw) return null;

  const meta = {
    effort: effortRaw.effort || null,
    command: effortRaw.command || null,
    taskBudget: null,
  };

  const budgetRaw = readJsonFileSync(path.join(runtimeDir, 'current-task-budget.json'));
  if (budgetRaw && typeof budgetRaw.budget === 'number' && budgetRaw.budget > 0) {
    meta.taskBudget = budgetRaw.budget;
  }

  return meta;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] - Clock injection for deterministic tests.
 * @returns {(state: object) => Promise<object>}
 */
export function createTasksMiddleware(options = {}) {
  const now = options.now || Date.now;

  return async function tasksMiddleware(state) {
    const routingSystem = state.context.routing?.system || 'system1';
    const mode = routingSystem === 'system2' ? 'agentTeam' : 'subAgent';
    const intent = state.context.intent || {};
    const phases = mode === 'agentTeam'
      ? ['plan', 'execute', 'verify']
      : ['execute', 'verify'];

    const task = {
      id: makeTaskId(now),
      mode,
      objective: state.input.prompt,
      recommendedAgent: intent.agents?.[0] || null,
      recommendedCommand: intent.commands?.[0] || null,
      complexity: state.context.routing?.score ?? null,
      ambiguity: intent.ambiguous || false,
      phases,
      createdAt: new Date(now()).toISOString(),
    };

    // P3-10: automatically attach effort/taskBudget meta when the prior
    // UserPromptSubmit hook (runtime-prompt.js) persisted them. This lets
    // /team orchestrator propagate `[artibot:effort=X][artibot:task-budget=Y]`
    // to each teammate without an explicit re-derive step.
    const pluginRoot = state.input?.pluginRoot
      || state.context?.pluginRoot
      || state.pluginRoot;
    const effortMeta = readEffortMeta(pluginRoot);
    if (effortMeta && effortMeta.effort) {
      task.meta = {
        effort: effortMeta.effort,
        command: effortMeta.command,
        taskBudget: effortMeta.taskBudget,
      };
    }

    state.context.tasks = task;
    state.messageParts.push(`task=${mode}`);

    if (mode === 'agentTeam') {
      state.userPrompt += '\n\nExecution contract:\n- Create a plan first.\n- Execute in clear phases.\n- Validate before final answer.';
    }

    return state;
  };
}
