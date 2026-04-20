/**
 * Zero-Waste Smart Pipeline — condition-based middleware selection
 * with execution statistics. Only runs middlewares whose conditions
 * match the current routing context.
 *
 * Compatible with create-artibot-agent.js middleware chain.
 *
 * @module lib/runtime/smart-pipeline
 */

// ---------------------------------------------------------------------------
// Intent Matching
// ---------------------------------------------------------------------------

/**
 * Match an intent string against a pattern.
 * Supports: '*' (always), 'prefix:*' (prefix glob), exact match.
 *
 * @param {string} intent - Actual intent (e.g. 'action:implement')
 * @param {string} pattern - Pattern to match against
 * @returns {boolean}
 */
function matchIntent(intent, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    return intent.startsWith(pattern.slice(0, -1));
  }
  return intent === pattern;
}

// ---------------------------------------------------------------------------
// Condition Matching
// ---------------------------------------------------------------------------

/**
 * Check if a middleware's conditions are satisfied by the routing context.
 * All specified conditions must match (AND logic).
 * Empty or missing conditions = always execute.
 *
 * @param {object} middleware - { name, fn, conditions }
 * @param {object} context - { intent, system, mode, complexity }
 * @returns {boolean}
 */
function matchConditions(middleware, context) {
  const cond = middleware.conditions;
  if (!cond || Object.keys(cond).length === 0) return true;

  // Intent matching
  if (cond.intents !== undefined) {
    if (cond.intents === '*') {
      // always match
    } else if (Array.isArray(cond.intents)) {
      const intent = context.intent || '';
      const anyMatch = cond.intents.some((p) => matchIntent(intent, p));
      if (!anyMatch) return false;
    }
  }

  // System matching
  if (Array.isArray(cond.systems) && cond.systems.length > 0) {
    if (!cond.systems.includes(context.system)) return false;
  }

  // Mode matching
  if (Array.isArray(cond.modes) && cond.modes.length > 0) {
    if (!cond.modes.includes(context.mode)) return false;
  }

  // Complexity threshold
  if (typeof cond.minComplexity === 'number') {
    const complexity = context.complexity ?? 0;
    if (complexity < cond.minComplexity) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Stats Management
// ---------------------------------------------------------------------------

/**
 * Create a fresh stats entry.
 *
 * @returns {{ runs: number, skips: number, totalMs: number, avgMs: number }}
 */
function createStatsEntry() {
  return { runs: 0, skips: 0, totalMs: 0, avgMs: 0 };
}

/**
 * Update stats for a middleware (immutable map update).
 *
 * @param {Map} statsMap
 * @param {string} name
 * @param {number} durationMs
 * @param {boolean} skipped
 */
function updateStats(statsMap, name, durationMs, skipped) {
  const prev = statsMap.get(name) || createStatsEntry();
  const next = { ...prev };

  if (skipped) {
    next.skips = prev.skips + 1;
  } else {
    next.runs = prev.runs + 1;
    next.totalMs = prev.totalMs + durationMs;
    next.avgMs = next.runs > 0 ? Math.round((next.totalMs / next.runs) * 100) / 100 : 0;
  }

  statsMap.set(name, next);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a smart pipeline with condition-based middleware selection.
 *
 * @param {Array<{ name: string, fn: Function, conditions?: object }>} middlewares
 * @param {object} [options]
 * @param {() => number} [options.now] - Timestamp function for DI
 * @returns {{ selectMiddlewares, run, getStats, getEfficiency }}
 */
export function createSmartPipeline(middlewares, options = {}) {
  const entries = Object.freeze(middlewares.map((m) => Object.freeze({ ...m })));
  const now = options.now || (() => Date.now());
  const statsMap = new Map();

  // Initialize stats for all middlewares
  for (const mw of entries) {
    statsMap.set(mw.name, createStatsEntry());
  }

  /**
   * Select middlewares matching the routing context.
   *
   * @param {object} routingContext
   * @returns {Array<{ name: string, fn: Function, conditions?: object }>}
   */
  function selectMiddlewares(routingContext) {
    return entries.filter((mw) => matchConditions(mw, routingContext));
  }

  /**
   * Run the pipeline: select matching middlewares, execute sequentially.
   *
   * @param {object} state - Pipeline state with context for routing
   * @returns {Promise<object>} Final state
   */
  // eslint-disable-next-line complexity -- orchestrates 11 middleware stages with per-stage guards
  async function run(state) {
    const routingContext = {
      intent: state.context?.routing?.intent || state.context?.intent?.best || '',
      system: state.context?.routing?.system || 'system1',
      mode: state.context?.planMode?.active ? 'plan' : (state.context?.mode || 'dev'),
      complexity: state.context?.routing?.score ?? 0,
    };

    const selected = selectMiddlewares(routingContext);
    const selectedNames = new Set(selected.map((m) => m.name));

    // Record skips
    for (const mw of entries) {
      if (!selectedNames.has(mw.name)) {
        updateStats(statsMap, mw.name, 0, true);
      }
    }

    // Execute selected middlewares sequentially
    for (const mw of selected) {
      const start = now();
      try {
        await mw.fn(state);
      } catch (err) {
        if (typeof process !== 'undefined' && process.stderr) {
          process.stderr.write(`[smart-pipeline:${mw.name}] ${err?.message || err}\n`);
        }
        state.messageParts = state.messageParts || [];
        state.messageParts.push(`${mw.name}=error`);
      }
      const elapsed = now() - start;
      updateStats(statsMap, mw.name, elapsed, false);
    }

    return state;
  }

  /**
   * Get per-middleware execution statistics (defensive copy).
   *
   * @returns {Map<string, { runs: number, skips: number, totalMs: number, avgMs: number }>}
   */
  function getStats() {
    const copy = new Map();
    for (const [name, stats] of statsMap) {
      copy.set(name, { ...stats });
    }
    return copy;
  }

  /**
   * Get overall pipeline efficiency report.
   *
   * @returns {{ totalRuns: number, totalSkips: number, savedMs: number, skipRate: number }}
   */
  function getEfficiency() {
    let totalRuns = 0;
    let totalSkips = 0;
    let totalMs = 0;

    for (const stats of statsMap.values()) {
      totalRuns += stats.runs;
      totalSkips += stats.skips;
      totalMs += stats.totalMs;
    }

    const total = totalRuns + totalSkips;
    const skipRate = total > 0 ? Math.round((totalSkips / total) * 100) / 100 : 0;

    // Estimate saved time: avgMs of run middlewares * number of skips
    const avgRunMs = totalRuns > 0 ? totalMs / totalRuns : 0;
    const savedMs = Math.round(avgRunMs * totalSkips * 100) / 100;

    return { totalRuns, totalSkips, savedMs, skipRate };
  }

  return { selectMiddlewares, run, getStats, getEfficiency };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  matchConditions as _matchConditions,
  matchIntent as _matchIntent,
  updateStats as _updateStats,
};
