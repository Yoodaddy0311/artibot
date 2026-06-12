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

import { getTokenizerCoeff } from '../core/model-catalog.js';

const DEFAULT_BUDGET_MAP = Object.freeze({
  max: 200000,
  xhigh: 128000,
  high: 64000,
  medium: 32000,
  low: 16000,
});

const DEFAULT_BETA_HEADER = 'context-1m-2025-08-01';

/**
 * Minimum max_tokens budget the Task Budgets beta accepts for the `fable`
 * (Claude Fable 5) tier — mirrors the catalog constraint `task-budget-min-20k`.
 * Without this, `low` (16k) falls under the beta floor.
 */
const FABLE_MIN_BUDGET = 20000;

/**
 * Resolve the model tokenizer coefficient from `opts`. Precedence:
 *   1. explicit numeric `opts.tokenizerCoeff` (finite, > 0),
 *   2. else `opts.modelTier` via the catalog (lazy/guarded, never-throw),
 *   3. else 1.0.
 *
 * @param {{ tokenizerCoeff?: number, modelTier?: string }|null|undefined} opts
 * @returns {number} Coefficient (> 0); 1.0 on any invalid/missing input.
 */
function resolveTokenizerCoeff(opts) {
  const explicit = opts?.tokenizerCoeff;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const tier = opts?.modelTier;
  if (typeof tier === 'string' && tier) {
    try {
      const coeff = getTokenizerCoeff(tier);
      if (typeof coeff === 'number' && Number.isFinite(coeff) && coeff > 0) {
        return coeff;
      }
    } catch {
      return 1.0;
    }
  }
  return 1.0;
}

/**
 * Resolve max_tokens budget for a given effort level.
 *
 * The optional `overlay` is the L4 learned effort-policy overlay (P3). When it
 * carries a valid budget multiplier for `level` (a finite number in [0.5, 1.5]),
 * the base budget is multiplied by it and re-clamped to the map ceiling
 * (`budgetMap.max`) so a learned boost can never exceed the hard cap. Any
 * missing / zero / NaN / out-of-range multiplier is ignored, leaving the base
 * budget unchanged — overlay-absent behaviour is byte-identical to before.
 *
 * On top of the overlay, an optional `opts` applies the MODEL tokenizer
 * coefficient (`opts.tokenizerCoeff`, or `opts.modelTier` resolved via the
 * catalog) to the effort→budget output, reusing the same round-then-clamp
 * mechanism as the overlay multiplier so a coefficient can never exceed the
 * map ceiling. When `opts.modelTier === 'fable'`, the result is additionally
 * clamped UP to the Task Budgets beta floor (20k) so `low` is never rejected.
 * With `opts` absent the output is byte-identical to the overlay-only path.
 *
 * @param {'max'|'xhigh'|'high'|'medium'|'low'|string|null|undefined} effortLevel
 * @param {object} [config] - artibot.config.json object (optional).
 * @param {{ budgetMultipliers?: Record<string, number> }|null} [overlay] - learned overlay (optional).
 * @param {{ tokenizerCoeff?: number, modelTier?: string }|null} [opts] - model coefficient injection (optional).
 * @returns {number|null} Budget in tokens, or null if level is unknown.
 */
export function getTaskBudgetForEffort(effortLevel, config = {}, overlay = null, opts = null) {
  if (!effortLevel) return null;
  const level = String(effortLevel).toLowerCase();
  const map = config?.runtime?.effort?.budgetMap || DEFAULT_BUDGET_MAP;
  const value = map[level];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const ceiling = typeof map.max === 'number' && Number.isFinite(map.max) && map.max > 0
    ? map.max
    : DEFAULT_BUDGET_MAP.max;

  let budget = value;
  const mult = overlay?.budgetMultipliers?.[level];
  if (typeof mult === 'number' && Number.isFinite(mult) && mult >= 0.5 && mult <= 1.5) {
    budget = Math.min(Math.round(budget * mult), ceiling);
  }

  // Apply the model tokenizer coefficient through the same round+ceiling clamp.
  const coeff = resolveTokenizerCoeff(opts);
  if (coeff !== 1.0) {
    budget = Math.min(Math.round(budget * coeff), ceiling);
  }

  // fable: Task Budgets beta floor — clamp UP so low (16k) is never rejected.
  if (opts?.modelTier === 'fable' && budget < FABLE_MIN_BUDGET) {
    budget = Math.min(FABLE_MIN_BUDGET, ceiling);
  }

  return budget;
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
