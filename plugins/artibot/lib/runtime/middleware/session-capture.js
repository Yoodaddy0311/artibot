/**
 * Session capture middleware.
 *
 * Observes pipeline state to accumulate per-session metrics, and flushes a
 * normalized session record to the session-aggregator on SessionEnd. Works
 * orthogonally to token-usage and cache-roi middlewares: it reads what they
 * already populated on `state.context` and aggregates at session granularity.
 *
 * Config: `observability.sessionCapture.enabled` (default true) on
 * `state.config` or passed into the factory. ENV override:
 * `ARTIBOT_SESSION_CAPTURE=0` disables.
 *
 * @module lib/runtime/middleware/session-capture
 */

import { emit } from '../../core/event-bus.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({ enabled: true });

/**
 * Resolve the merged config from options + state.
 *
 * @param {object} optsCfg
 * @param {object} stateCfg
 * @returns {{ enabled: boolean }}
 */
function resolveConfig(optsCfg, stateCfg) {
  const envOff = process.env.ARTIBOT_SESSION_CAPTURE === '0';
  if (envOff) return { enabled: false };
  const fromState = stateCfg?.observability?.sessionCapture;
  const merged = { ...DEFAULT_CONFIG, ...(fromState || {}), ...(optsCfg || {}) };
  return { enabled: Boolean(merged.enabled) };
}

/**
 * Create an empty session accumulator for a session id.
 *
 * @param {string} sessionId
 * @param {string} startTime
 * @returns {object}
 */
export function createAccumulator(sessionId, startTime) {
  return {
    sessionId,
    startTime,
    endTime: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requestCount: 0,
    toolCallCount: 0,
    errorCount: 0,
    costUsd: 0,
    meta: {},
  };
}

/**
 * Extract per-request deltas from a completed pipeline state. Reads
 * `state.context.tokenUsage` and `state.context.cacheRoi` if present.
 *
 * @param {object} state
 * @returns {{
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheCreationTokens: number,
 *   costUsd: number,
 *   toolCallCount: number,
 *   errorCount: number,
 * }}
 */
export function extractDelta(state) {
  const tu = state?.context?.tokenUsage || {};
  const roi = state?.context?.cacheRoi?.current || {};
  const curInput = Number(tu.current?.inputTokens) || 0;
  const curOutput = Number(tu.current?.outputTokens) || 0;
  return {
    inputTokens: curInput + (Number(roi.inputTokens) || 0),
    outputTokens: curOutput + (Number(roi.outputTokens) || 0),
    cacheReadTokens: Number(roi.cacheReadTokens) || 0,
    cacheCreationTokens: Number(roi.cacheCreationTokens) || 0,
    costUsd: Number(roi.spentCostUsd) || 0,
    toolCallCount: Array.isArray(state?.context?.tools?.calls)
      ? state.context.tools.calls.length
      : 0,
    errorCount: Array.isArray(state?.context?.errors) ? state.context.errors.length : 0,
  };
}

/**
 * Apply a per-request delta to an accumulator. Returns a new accumulator so
 * callers can preserve immutability if desired; default usage mutates in
 * place for performance. Here we return a new object for safety — this is
 * a hot path but still handful of fields.
 *
 * @param {object} acc
 * @param {object} delta
 * @returns {object}
 */
export function foldDelta(acc, delta) {
  return {
    ...acc,
    inputTokens: acc.inputTokens + (delta.inputTokens || 0),
    outputTokens: acc.outputTokens + (delta.outputTokens || 0),
    cacheReadTokens: acc.cacheReadTokens + (delta.cacheReadTokens || 0),
    cacheCreationTokens: acc.cacheCreationTokens + (delta.cacheCreationTokens || 0),
    costUsd: acc.costUsd + (delta.costUsd || 0),
    toolCallCount: acc.toolCallCount + (delta.toolCallCount || 0),
    errorCount: acc.errorCount + (delta.errorCount || 0),
    requestCount: acc.requestCount + 1,
  };
}

/**
 * Resolve a session id from state, falling back to a time-based one.
 *
 * @param {object} state
 * @param {() => number} now
 * @returns {string}
 */
function resolveSessionId(state, now) {
  return (
    state?.context?.session?.id
    || state?.session?.id
    || state?.sessionId
    || `session-${now()}`
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the session-capture middleware.
 *
 * @param {{
 *   aggregator: { recordSession: (input: object) => Promise<object> },
 *   enabled?: boolean,
 *   now?: () => number,
 *   logger?: { warn?: Function },
 * }} options
 * @returns {(state: object, next?: Function) => Promise<object>} Middleware.
 */
export function createSessionCaptureMiddleware(options) {
  if (!options || !options.aggregator || typeof options.aggregator.recordSession !== 'function') {
    throw new TypeError('createSessionCaptureMiddleware: aggregator.recordSession is required');
  }
  const aggregator = options.aggregator;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const logger = options.logger || { warn: () => {} };

  const accumulators = new Map();

  const middleware = async function sessionCaptureMiddleware(state, next) {
    if (typeof next === 'function') await next();

    const cfg = resolveConfig(
      { enabled: options.enabled },
      state?.config,
    );

    if (!cfg.enabled) {
      if (state?.context) state.context.sessionCapture = { enabled: false };
      return state;
    }

    const sessionId = resolveSessionId(state, now);
    const event = state?.context?.session?.event;

    // On SessionStart, seed the accumulator.
    if (event === 'start' || event === 'SessionStart') {
      const startTime = new Date(now()).toISOString();
      accumulators.set(sessionId, createAccumulator(sessionId, startTime));
      if (state?.context) {
        state.context.sessionCapture = { enabled: true, sessionId, event: 'start' };
      }
      return state;
    }

    // On SessionEnd, flush to aggregator.
    if (event === 'end' || event === 'SessionEnd') {
      const acc = accumulators.get(sessionId)
        || createAccumulator(sessionId, new Date(now()).toISOString());
      const endTime = new Date(now()).toISOString();
      const final = { ...acc, endTime };
      accumulators.delete(sessionId);
      try {
        await aggregator.recordSession({
          sessionId: final.sessionId,
          startTime: final.startTime,
          endTime: final.endTime,
          metrics: {
            inputTokens: final.inputTokens,
            outputTokens: final.outputTokens,
            cacheReadTokens: final.cacheReadTokens,
            cacheCreationTokens: final.cacheCreationTokens,
            requestCount: final.requestCount,
            toolCallCount: final.toolCallCount,
            errorCount: final.errorCount,
            costUsd: final.costUsd,
          },
          meta: final.meta,
        });
        emit('feature:session-capture', {
          detail: `flushed ${sessionId} req=${final.requestCount}`,
        });
      } catch (err) {
        logger.warn?.(`session-capture flush failed: ${err?.message ?? err}`);
      }
      if (state?.context) {
        state.context.sessionCapture = { enabled: true, sessionId, event: 'end', flushed: true };
      }
      return state;
    }

    // Default: accumulate per-request delta.
    let acc = accumulators.get(sessionId);
    if (!acc) {
      acc = createAccumulator(sessionId, new Date(now()).toISOString());
    }
    const delta = extractDelta(state);
    acc = foldDelta(acc, delta);
    accumulators.set(sessionId, acc);

    if (state?.context) {
      state.context.sessionCapture = {
        enabled: true,
        sessionId,
        requestCount: acc.requestCount,
      };
    }
    return state;
  };

  middleware._accumulators = accumulators;
  return middleware;
}

// ---------------------------------------------------------------------------
// Testing exports
// ---------------------------------------------------------------------------

export const _internals = { resolveConfig, resolveSessionId };
