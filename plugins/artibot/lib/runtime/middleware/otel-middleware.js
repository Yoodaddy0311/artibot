/**
 * Runtime OTEL middleware.
 *
 * Converts the output of the existing `token-usage` and `cache-roi`
 * middlewares into OTLP spans and metrics, then hands them to the
 * {@link createOtelExporter} exporter for delivery to a local/remote
 * OTLP collector.
 *
 * Design contract:
 * - Default **disabled**. Only activates when `config.observability.otel.enabled`
 *   is `true` AND `config.observability.otel.endpoint` is set.
 * - No network or disk side-effects when disabled.
 * - Never throws; failures are logged via stderr (via exporter's warn hook)
 *   and queued to the retry buffer.
 * - Reads state produced by earlier middlewares (`state.context.tokenUsage`,
 *   `state.context.cacheRoi`) — it does NOT duplicate the underlying
 *   accounting.
 *
 * @module lib/runtime/middleware/otel-middleware
 */

import { createOtelExporter } from '../../observability/otel-exporter.js';

// ---------------------------------------------------------------------------
// Pure helpers — state → OTEL conversion
// ---------------------------------------------------------------------------

/**
 * Resolve the active model name from pipeline state, mirroring token-usage.
 * @param {object} state
 * @returns {string}
 */
function resolveModel(state) {
  return (
    state?.context?.backend?.selected
    || state?.config?.modelPolicy?.default
    || state?.context?.tokenUsage?.current?.model
    || 'unknown'
  );
}

/**
 * Resolve the active agent name from pipeline state.
 * @param {object} state
 * @returns {string}
 */
function resolveAgent(state) {
  return (
    state?.context?.subagents?.contract?.targetAgent
    || state?.context?.tasks?.recommendedAgent
    || state?.context?.tokenUsage?.current?.agent
    || 'orchestrator'
  );
}

/**
 * Resolve the operation/intent label for attributes.
 * @param {object} state
 * @returns {string}
 */
function resolveOperation(state) {
  return state?.context?.intent?.best || 'unknown';
}

/**
 * Build a pipeline-scope span capturing the full middleware pass.
 *
 * @param {object} state
 * @param {object} timing — {startMs, endMs}
 * @param {object} exporter — from createOtelExporter
 * @param {() => number} [rngFn]
 * @returns {object} OTLP span
 */
export function buildPipelineSpan(state, timing, exporter, rngFn) {
  const tokenUsage = state?.context?.tokenUsage;
  const cacheRoi = state?.context?.cacheRoi;
  const attrs = {
    'artibot.model': resolveModel(state),
    'artibot.agent': resolveAgent(state),
    'artibot.operation': resolveOperation(state),
  };
  if (tokenUsage?.enabled && tokenUsage.current) {
    attrs['artibot.tokens.input'] = tokenUsage.current.inputTokens;
  }
  if (tokenUsage?.enabled && tokenUsage.session) {
    attrs['artibot.session.total_tokens'] = tokenUsage.session.totalTokens;
    attrs['artibot.session.request_count'] = tokenUsage.session.requestCount;
  }
  if (cacheRoi?.enabled && cacheRoi.current) {
    attrs['artibot.cache.hit_rate'] = Number(cacheRoi.current.hitRate?.toFixed?.(4) ?? cacheRoi.current.hitRate);
    attrs['artibot.cache.saved_usd'] = cacheRoi.current.savedCostUsd;
    attrs['artibot.cache.spent_usd'] = cacheRoi.current.spentCostUsd;
  }
  return exporter.buildSpan({
    name: 'artibot.pipeline',
    startTimeMs: timing.startMs,
    endTimeMs: timing.endMs,
    attributes: attrs,
    kind: 1,
    status: { code: 0 },
    traceId: undefined,
    spanId: undefined,
  }, rngFn);
}

/**
 * Build metrics points from current middleware state.
 *
 * @param {object} state
 * @param {number} timeMs
 * @param {object} exporter
 * @returns {Array<object>}
 */
export function buildMetricsFromState(state, timeMs, exporter) {
  const out = [];
  const model = resolveModel(state);
  const agent = resolveAgent(state);
  const attrs = { 'artibot.model': model, 'artibot.agent': agent };

  const tokenUsage = state?.context?.tokenUsage;
  if (tokenUsage?.enabled && tokenUsage.session) {
    out.push(
      exporter.buildCounterMetric(
        'artibot.tokens.input.total',
        tokenUsage.session.totalInput,
        timeMs,
        attrs,
      ),
    );
    out.push(
      exporter.buildCounterMetric(
        'artibot.tokens.output.total',
        tokenUsage.session.totalOutput,
        timeMs,
        attrs,
      ),
    );
    out.push(
      exporter.buildCounterMetric(
        'artibot.requests.total',
        tokenUsage.session.requestCount,
        timeMs,
        attrs,
      ),
    );
  }

  const cacheRoi = state?.context?.cacheRoi;
  if (cacheRoi?.enabled && cacheRoi.session) {
    out.push(
      exporter.buildGaugeMetric(
        'artibot.cache.hit_rate',
        cacheRoi.session.hitRate,
        timeMs,
        attrs,
      ),
    );
    out.push(
      exporter.buildCounterMetric(
        'artibot.cache.saved_usd.total',
        cacheRoi.session.cumulativeSavedUsd,
        timeMs,
        attrs,
      ),
    );
    out.push(
      exporter.buildCounterMetric(
        'artibot.cache.spent_usd.total',
        cacheRoi.session.cumulativeSpentUsd,
        timeMs,
        attrs,
      ),
    );
    out.push(
      exporter.buildCounterMetric(
        'artibot.cache.read_tokens.total',
        cacheRoi.session.totalCacheReadTokens,
        timeMs,
        attrs,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Extract OTEL config from artibot.config.json-shaped object.
 * Supports env-var override `ARTIBOT_OTEL_ENDPOINT` (also enables).
 *
 * @param {object} [config]
 * @returns {{enabled:boolean,endpoint:string,serviceName:string,headers:Record<string,string>}}
 */
export function resolveOtelConfig(config) {
  const otelCfg = config?.observability?.otel || {};
  const envEndpoint = process.env.ARTIBOT_OTEL_ENDPOINT || '';
  const envEnabled = process.env.ARTIBOT_OTEL === '1';
  const endpoint = envEndpoint || otelCfg.endpoint || '';
  const enabled = envEnabled
    || Boolean(otelCfg.enabled && endpoint)
    || Boolean(envEndpoint);
  return {
    enabled,
    endpoint,
    serviceName: otelCfg.serviceName || 'artibot',
    headers: otelCfg.headers || {},
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the OTEL middleware.
 *
 * @param {object} [options]
 * @param {object} [options.exporter] — Injected exporter (overrides config-derived one).
 * @param {object} [options.config] — Full artibot config; `observability.otel.*` is read.
 * @param {() => number} [options.now]
 * @param {boolean} [options.flushBufferOnEachCall=false] — If true, drains retry buffer each call.
 * @returns {(state:object, next?:Function) => Promise<object>}
 */
export function createOtelMiddleware(options = {}) {
  const now = options.now || Date.now;
  const flushBufferOnEachCall = Boolean(options.flushBufferOnEachCall);

  // Build exporter from either direct injection or config.
  let exporter = options.exporter;
  if (!exporter) {
    const cfg = resolveOtelConfig(options.config);
    exporter = createOtelExporter({
      enabled: cfg.enabled,
      endpoint: cfg.endpoint,
      serviceName: cfg.serviceName,
      headers: cfg.headers,
    });
  }

  return async function otelMiddleware(state, next) {
    const startMs = now();
    if (typeof next === 'function') await next();
    const endMs = now();

    if (!exporter.enabled) {
      if (state?.context) {
        state.context.otel = { enabled: false };
      }
      return state;
    }

    // Build span + metrics from already-populated context.
    const span = buildPipelineSpan(state, { startMs, endMs }, exporter);
    const metrics = buildMetricsFromState(state, endMs, exporter);

    // Fire-and-forget: never block the pipeline.
    const spanResult = await exporter.exportSpans([span]).catch((err) => ({
      ok: false,
      error: err?.message || 'span export failed',
    }));
    const metricsResult = metrics.length > 0
      ? await exporter.exportMetrics(metrics).catch((err) => ({
        ok: false,
        error: err?.message || 'metrics export failed',
      }))
      : { ok: true, skipped: 'empty' };

    let flushResult = null;
    if (flushBufferOnEachCall) {
      flushResult = await exporter.flushRetryBuffer().catch((err) => ({
        ok: false,
        error: err?.message || 'flush failed',
      }));
    }

    if (state?.context) {
      state.context.otel = {
        enabled: true,
        endpoint: exporter.endpoint,
        spans: { exported: spanResult.ok, ...spanResult },
        metrics: { exported: metricsResult.ok, count: metrics.length, ...metricsResult },
        ...(flushResult ? { flush: flushResult } : {}),
      };
    }
    if (state && Array.isArray(state.messageParts)) {
      state.messageParts.push(`otel=${spanResult.ok ? 'ok' : 'buf'}`);
    }
    return state;
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  resolveModel as _resolveModel,
  resolveAgent as _resolveAgent,
  resolveOperation as _resolveOperation,
};
