/**
 * Task Budget helper — maps effort levels to max_tokens budgets per
 * `artibot.config.json#/runtime/effort/budgetMap` and produces the
 * directive string injected into the user prompt.
 *
 * Used by `scripts/hooks/runtime-prompt.js` to auto-wire budgets for
 * slash commands and by `/team` orchestrator for per-teammate prompts.
 *
 * @module lib/runtime/task-budget
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const DEFAULT_BUDGET_MAP = Object.freeze({
  max: 200000,
  xhigh: 128000,
  high: 64000,
  medium: 32000,
  low: 16000,
});

const DEFAULT_BETA_HEADER = 'context-1m-2025-08-01';

/**
 * Resolve max_tokens budget for a given effort level.
 *
 * @param {'max'|'xhigh'|'high'|'medium'|'low'|string|null|undefined} effortLevel
 * @param {object} [config] - artibot.config.json object (optional).
 * @returns {number|null} Budget in tokens, or null if level is unknown.
 */
export function getTaskBudgetForEffort(effortLevel, config = {}) {
  if (!effortLevel) return null;
  const level = String(effortLevel).toLowerCase();
  const map = config?.runtime?.effort?.budgetMap || DEFAULT_BUDGET_MAP;
  const value = map[level];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

/**
 * Build the task budget directive string for prompt injection.
 *
 * Output format (single line):
 *   [artibot:task-budget max_tokens=N]
 *   [artibot:task-budget max_tokens=N anthropic-beta=context-1m-2025-08-01]
 *
 * The beta header is appended only when long-context is enabled in config.
 *
 * @param {'max'|'xhigh'|'high'|'medium'|'low'|string|null|undefined} effortLevel
 * @param {number|null} budget
 * @param {object} [config] - artibot.config.json object (optional).
 * @returns {string} Directive string (empty when inputs are invalid).
 */
export function buildTaskBudgetDirective(effortLevel, budget, config = {}) {
  if (!effortLevel || typeof budget !== 'number' || budget <= 0) return '';

  const longContext = config?.runtime?.longContext || {};
  const betaEnabled = longContext.enabled === true;
  const betaHeader = longContext.betaHeader || DEFAULT_BETA_HEADER;

  const segments = [`max_tokens=${budget}`];
  if (betaEnabled) {
    segments.push(`anthropic-beta=${betaHeader}`);
  }
  return `[artibot:task-budget ${segments.join(' ')}]`;
}

/**
 * Persist the current task budget context for downstream consumers
 * (statusline, team orchestrator, observability).
 *
 * @param {{ command?: string|null, effort?: string|null, budget?: number|null }} meta
 * @param {string} pluginRoot
 * @returns {string|null} Absolute path to the written file, or null on failure.
 */
export function persistTaskBudget(meta, pluginRoot) {
  if (!meta || typeof pluginRoot !== 'string' || !pluginRoot) return null;
  const { command = null, effort = null, budget = null } = meta;
  if (!effort || typeof budget !== 'number' || budget <= 0) return null;

  try {
    const runtimeDir = path.join(pluginRoot, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const filePath = path.join(runtimeDir, 'current-task-budget.json');
    const payload = {
      command,
      effort,
      budget,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(filePath, JSON.stringify(payload) + '\n');
    return filePath;
  } catch {
    return null;
  }
}
