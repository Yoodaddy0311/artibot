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
});
