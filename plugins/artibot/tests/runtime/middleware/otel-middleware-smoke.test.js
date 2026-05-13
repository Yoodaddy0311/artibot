import { describe, expect, it } from 'vitest';
import {
  buildMetricsFromState,
  buildPipelineSpan,
  createOtelMiddleware,
  resolveOtelConfig,
} from '../../../lib/runtime/middleware/otel-middleware.js';

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
