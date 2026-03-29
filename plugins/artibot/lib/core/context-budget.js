/**
 * Predictive Context Budget — EWMA-based token budget allocation and tracking.
 * Allocates context window capacity across concurrent tasks using
 * exponentially weighted moving average cost prediction.
 * @module lib/core/context-budget
 */

// ---------------------------------------------------------------------------
// Default cost estimates (tokens) per task type
// ---------------------------------------------------------------------------

const DEFAULT_COST_ESTIMATES = Object.freeze({
  code: 8000,
  search: 3000,
  edit: 5000,
  test: 6000,
  review: 7000,
  plan: 4000,
  chat: 2000,
  default: 5000,
});

// ---------------------------------------------------------------------------
// EWMA — Exponentially Weighted Moving Average
// ---------------------------------------------------------------------------

/**
 * Tracks a smoothed average that adapts to recent observations.
 * New values are blended with the running average via alpha coefficient.
 */
export class EWMA {
  /**
   * @param {number} alpha - Smoothing factor (0 < alpha <= 1). Higher = more reactive.
   * @param {number} [initial=0] - Initial value.
   */
  constructor(alpha, initial = 0) {
    this._alpha = Math.max(0.01, Math.min(1, alpha));
    this._value = initial;
    this._count = initial > 0 ? 1 : 0;
  }

  /**
   * Record a new observation and update the average.
   * @param {number} observation
   * @returns {number} Updated average.
   */
  update(observation) {
    if (this._count === 0) {
      this._value = observation;
    } else {
      this._value = this._alpha * observation + (1 - this._alpha) * this._value;
    }
    this._count += 1;
    return this._value;
  }

  /** @returns {number} Current smoothed value. */
  get value() { return this._value; }

  /** @returns {number} Number of observations recorded. */
  get count() { return this._count; }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Predict cost for a task type using EWMA history or default estimates.
 * @param {string} taskType
 * @param {Map<string, EWMA>} history
 * @returns {number}
 */
export function predictTaskCost(taskType, history) {
  const ewma = history.get(taskType);
  if (ewma && ewma.count > 0) return ewma.value;
  return DEFAULT_COST_ESTIMATES[taskType] ?? DEFAULT_COST_ESTIMATES.default;
}

/**
 * Distribute a budget across tasks proportional to their estimated costs.
 * @param {number} remaining - Total tokens to distribute.
 * @param {Array<{ id: string, estimate: number }>} estimates
 * @returns {Map<string, number>} taskId -> allocated budget
 */
export function distributeWeighted(remaining, estimates) {
  const total = estimates.reduce((sum, e) => sum + e.estimate, 0);
  const result = new Map();
  if (total === 0 || remaining <= 0) {
    for (const e of estimates) result.set(e.id, 0);
    return result;
  }
  for (const e of estimates) {
    result.set(e.id, Math.round((e.estimate / total) * remaining));
  }
  return result;
}

// ---------------------------------------------------------------------------
// ContextBudget
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TaskBudgetInfo
 * @property {number} budget - Allocated budget tokens.
 * @property {number} used - Tokens consumed.
 * @property {number} remaining - Tokens left.
 * @property {number} pctUsed - Usage percentage (0-100).
 */

/**
 * @typedef {object} CompressAdvice
 * @property {boolean} compress - Whether compression is recommended.
 * @property {'low'|'high'} severity
 * @property {string} recommendation
 */

/**
 * @typedef {object} BudgetSummary
 * @property {number} total - Max tokens for the context window.
 * @property {number} allocated - Tokens allocated to tasks.
 * @property {number} unallocated - Free tokens (not allocated, not reserved).
 * @property {number} safetyReserve - Tokens held in reserve.
 */

/**
 * Predictive context budget manager.
 * Immutable-style: public methods return new data, internal state is encapsulated.
 */
class ContextBudget {
  /**
   * @param {number} maxTokens
   * @param {{ safetyReserve?: number, alpha?: number }} options
   */
  constructor(maxTokens, options = {}) {
    this._maxTokens = maxTokens;
    this._safetyPct = options.safetyReserve ?? 0.1;
    this._alpha = options.alpha ?? 0.3;
    /** @type {Map<string, EWMA>} */
    this._history = new Map();
    /** @type {Map<string, number>} allocated budget per task */
    this._allocations = new Map();
    /** @type {Map<string, number>} actual usage per task */
    this._usage = new Map();
  }

  /**
   * Allocate budget across tasks based on predicted costs.
   * @param {Array<{ id: string, type?: string }>} taskDescriptions
   * @param {number} currentUsage - Tokens already consumed in the session.
   * @returns {Map<string, number>} taskId -> allocated tokens
   */
  allocate(taskDescriptions, currentUsage) {
    const reserve = Math.round(this._maxTokens * this._safetyPct);
    const remaining = Math.max(0, this._maxTokens - currentUsage - reserve);

    const estimates = taskDescriptions.map((t) => ({
      id: t.id,
      estimate: predictTaskCost(t.type ?? 'default', this._history),
    }));

    const allocation = distributeWeighted(remaining, estimates);

    for (const [id, budget] of allocation) {
      this._allocations.set(id, budget);
      if (!this._usage.has(id)) this._usage.set(id, 0);
    }

    return new Map(allocation);
  }

  /**
   * Record actual token usage for a task and update EWMA predictions.
   * @param {string} taskId
   * @param {number} tokensUsed
   */
  record(taskId, tokensUsed) {
    const prev = this._usage.get(taskId) ?? 0;
    this._usage.set(taskId, prev + tokensUsed);

    // Update EWMA for this task's type pattern
    if (!this._history.has(taskId)) {
      this._history.set(taskId, new EWMA(this._alpha));
    }
    this._history.get(taskId).update(prev + tokensUsed);
  }

  /**
   * Get remaining budget summary.
   * @returns {BudgetSummary}
   */
  getRemainingBudget() {
    const reserve = Math.round(this._maxTokens * this._safetyPct);
    let allocated = 0;
    for (const v of this._allocations.values()) allocated += v;
    const unallocated = Math.max(0, this._maxTokens - allocated - reserve);
    return { total: this._maxTokens, allocated, unallocated, safetyReserve: reserve };
  }

  /**
   * Check if a task should trigger context compression.
   * @param {string} taskId
   * @returns {CompressAdvice}
   */
  shouldCompress(taskId) {
    const budget = this._allocations.get(taskId) ?? 0;
    const used = this._usage.get(taskId) ?? 0;

    if (budget === 0) {
      return { compress: false, severity: 'low', recommendation: 'No budget allocated.' };
    }

    const pct = used / budget;

    if (pct >= 0.9) {
      return {
        compress: true,
        severity: 'high',
        recommendation: `Task "${taskId}" at ${Math.round(pct * 100)}% — compress urgently or isolate to subagent.`,
      };
    }

    if (pct >= 0.7) {
      return {
        compress: true,
        severity: 'low',
        recommendation: `Task "${taskId}" at ${Math.round(pct * 100)}% — consider /compact to free budget.`,
      };
    }

    return { compress: false, severity: 'low', recommendation: 'Within budget.' };
  }

  /**
   * Get budget details for a specific task.
   * @param {string} taskId
   * @returns {TaskBudgetInfo}
   */
  getTaskBudget(taskId) {
    const budget = this._allocations.get(taskId) ?? 0;
    const used = this._usage.get(taskId) ?? 0;
    const remaining = Math.max(0, budget - used);
    const pctUsed = budget > 0 ? Math.round((used / budget) * 100) : 0;
    return { budget, used, remaining, pctUsed };
  }

  /**
   * Suggest whether a task should be isolated to a subagent.
   * Returns true when remaining budget is less than 1.5x the allocation,
   * meaning we predict the task will exceed its budget.
   * @param {string} taskId
   * @returns {boolean}
   */
  suggestIsolation(taskId) {
    const budget = this._allocations.get(taskId) ?? 0;
    const used = this._usage.get(taskId) ?? 0;
    const remaining = budget - used;
    return remaining < budget * 0.5;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new ContextBudget instance.
 * @param {number} maxTokens - Maximum context window tokens.
 * @param {{ safetyReserve?: number, alpha?: number }} [options]
 * @returns {ContextBudget}
 */
export function createContextBudget(maxTokens, options = {}) {
  return new ContextBudget(maxTokens, options);
}
