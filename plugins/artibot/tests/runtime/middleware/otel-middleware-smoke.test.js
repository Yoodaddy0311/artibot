import { describe, expect, it } from 'vitest';
import {
  buildMetricsFromState,
  buildPipelineSpan,
  createOtelMiddleware,
  resolveOtelConfig,
} from '../../../lib/runtime/middleware/otel-middleware.js';
import { createCacheRoiMiddleware } from '../../../lib/runtime/middleware/cache-roi.js';
import { createOtelExporter } from '../../../lib/observability/otel-exporter.js';

describe('otel-middleware (smoke)', () => {
  it('resolveOtelConfig returns object with enabled flag', () => {
    const cfg = resolveOtelConfig({});
    expect(typeof cfg).toBe('object');
    expect('enabled' in cfg).toBe(true);
  });

  it('resolveOtelConfig defaults to disabled', () => {
    const cfg = resolveOtelConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it('resolveOtelConfig honours explicit enable', () => {
    const cfg = resolveOtelConfig({ observability: { otel: { enabled: true, endpoint: 'http://127.0.0.1:4318' } } });
    expect(cfg.enabled).toBe(true);
  });

  it('createOtelMiddleware returns a function', () => {
    const mw = createOtelMiddleware({});
    expect(typeof mw).toBe('function');
  });

  it('buildPipelineSpan calls exporter.buildSpan with span fields', () => {
    const calls = [];
    const fakeExporter = {
      buildSpan: (args) => { calls.push(args); return { traceId: 't1', spanId: 's1' }; },
    };
    const state = { startTime: 0, endTime: 100 };
    const timing = { startMs: 0, endMs: 100 };
    const span = buildPipelineSpan(state, timing, fakeExporter, () => 0.5);
    expect(typeof span).toBe('object');
    expect(calls.length).toBe(1);
    expect(typeof calls[0]).toBe('object');
  });

  it('buildMetricsFromState accepts stub exporter', () => {
    const fakeExporter = {
      buildMetric: () => ({ name: 'stub', value: 0 }),
    };
    const state = { tokens: { input: 100, output: 50 } };
    const result = buildMetricsFromState(state, 1_700_000_000_000, fakeExporter);
    expect(result).toBeDefined();
  });

  // v4.7.0 A3: agent_id / parent_agent_id span attribution
  it('buildPipelineSpan emits artibot.agent_id when subagent contract carries it', () => {
    let captured = null;
    const fakeExporter = {
      buildSpan: (args) => { captured = args; return { traceId: 't', spanId: 's' }; },
    };
    const state = {
      context: {
        subagents: {
          contract: {
            agentId: 'frontend-developer',
            parentAgentId: 'orchestrator',
            targetAgent: 'frontend-developer',
          },
        },
      },
    };
    buildPipelineSpan(state, { startMs: 0, endMs: 1 }, fakeExporter, () => 0.5);
    expect(captured.attributes['artibot.agent_id']).toBe('frontend-developer');
    expect(captured.attributes['artibot.parent_agent_id']).toBe('orchestrator');
  });

  it('buildPipelineSpan omits agent_id attrs when contract is absent (backward compat)', () => {
    let captured = null;
    const fakeExporter = {
      buildSpan: (args) => { captured = args; return { traceId: 't', spanId: 's' }; },
    };
    buildPipelineSpan({}, { startMs: 0, endMs: 1 }, fakeExporter, () => 0.5);
    expect(captured.attributes).not.toHaveProperty('artibot.agent_id');
    expect(captured.attributes).not.toHaveProperty('artibot.parent_agent_id');
    // existing artibot.agent fallback still present
    expect(captured.attributes['artibot.agent']).toBe('orchestrator');
  });

  it('buildMetricsFromState propagates agent_id into metric attrs when present', () => {
    const built = [];
    const fakeExporter = {
      buildCounterMetric: (_n, _v, _t, attrs) => { built.push(attrs); return {}; },
      buildGaugeMetric: (_n, _v, _t, attrs) => { built.push(attrs); return {}; },
    };
    const state = {
      context: {
        subagents: { contract: { agentId: 'backend-developer', parentAgentId: 'orchestrator' } },
        tokenUsage: { enabled: true, session: { totalInput: 1, totalOutput: 1, requestCount: 1 } },
      },
    };
    buildMetricsFromState(state, 1_700_000_000_000, fakeExporter);
    expect(built.length).toBeGreaterThan(0);
    expect(built[0]['artibot.agent_id']).toBe('backend-developer');
    expect(built[0]['artibot.parent_agent_id']).toBe('orchestrator');
  });
});

// Real path: cache-roi middleware → otel middleware → exporter payload.
// Only the HTTP transport is stubbed; the span is read from the posted body.
async function exportPipelineSpan(model) {
  const posts = [];
  const exporter = createOtelExporter({
    enabled: true,
    endpoint: 'http://127.0.0.1:4318',
    httpPost: async (url, payload) => {
      posts.push({ url, payload });
      return { ok: true, status: 200, body: '' };
    },
    warn: () => {},
  });
  const cacheRoi = createCacheRoiMiddleware({ enabled: true, persist: async () => {} });
  const otel = createOtelMiddleware({ exporter, now: () => 1_700_000_000_000 });
  const state = {
    context: { backend: { selected: model } },
    response: {
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
    },
  };
  await cacheRoi(state);
  await otel(state);
  const trace = posts.find((p) => p.url.endsWith('/v1/traces'));
  return { span: trace.payload.resourceSpans[0].scopeSpans[0].spans[0], cacheRoi: state.context.cacheRoi };
}

function attrValue(span, key) {
  return span.attributes.find((kv) => kv.key === key)?.value;
}

describe('otel-middleware — unpriced cache attributes', () => {
  it('omits null dollar attributes from the exported span instead of sending empty strings', async () => {
    const { span, cacheRoi } = await exportPipelineSpan('claude-opus-x');
    expect(cacheRoi.current.savedCostUsd).toBeNull();
    expect(cacheRoi.current.spentCostUsd).toBeNull();
    const keys = span.attributes.map((kv) => kv.key);
    expect(keys).not.toContain('artibot.cache.saved_usd');
    expect(keys).not.toContain('artibot.cache.spent_usd');
    expect(span.attributes.filter((kv) => kv.value.stringValue === '')).toEqual([]);
  });

  it('exports the session unpriced request count as an int attribute', async () => {
    const { span } = await exportPipelineSpan('claude-opus-x');
    expect(attrValue(span, 'artibot.cache.unpriced_request_count')).toEqual({ intValue: '1' });
  });

  it('keeps the priced cache attributes and values as before', async () => {
    const { span, cacheRoi } = await exportPipelineSpan('claude-opus-5-5');
    expect(attrValue(span, 'artibot.cache.hit_rate')).toEqual({ doubleValue: 0.75 });
    expect(attrValue(span, 'artibot.cache.saved_usd')).toEqual({ doubleValue: cacheRoi.current.savedCostUsd });
    expect(attrValue(span, 'artibot.cache.spent_usd')).toEqual({ doubleValue: cacheRoi.current.spentCostUsd });
    expect(cacheRoi.current.savedCostUsd).toBeGreaterThan(0);
  });

  it('reports a zero unpriced count for a priced session', async () => {
    const { span } = await exportPipelineSpan('claude-opus-5-5');
    expect(attrValue(span, 'artibot.cache.unpriced_request_count')).toEqual({ intValue: '0' });
  });

  it('does not set null cache values on the attribute object handed to buildSpan', () => {
    let captured = null;
    const fakeExporter = {
      buildSpan: (args) => { captured = args; return {}; },
    };
    const state = {
      context: {
        cacheRoi: {
          enabled: true,
          current: { hitRate: null, savedCostUsd: null, spentCostUsd: null },
          session: {},
        },
      },
    };
    buildPipelineSpan(state, { startMs: 0, endMs: 1 }, fakeExporter, () => 0.5);
    expect(captured.attributes).not.toHaveProperty('artibot.cache.hit_rate');
    expect(captured.attributes).not.toHaveProperty('artibot.cache.saved_usd');
    expect(captured.attributes).not.toHaveProperty('artibot.cache.spent_usd');
    // A session persisted before the counter existed has no count — absent, not 0.
    expect(captured.attributes).not.toHaveProperty('artibot.cache.unpriced_request_count');
  });
});
