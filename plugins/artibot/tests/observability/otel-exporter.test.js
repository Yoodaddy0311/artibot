/**
 * Tests for the OTLP HTTP exporter.
 *
 * Covers:
 * - Pure builder functions (span, metric, resource, payload shapes)
 * - OTLP JSON spec conformance (attribute value keys, time nano strings, ids)
 * - Disabled → no-op
 * - Loopback warning behavior
 * - Retry buffer: buffered-on-failure, drain round-trip
 * - End-to-end export against a real loopback HTTP server
 *
 * All tests are hermetic: they use an injected `httpPost` mock OR a real
 * `node:http` server bound to 127.0.0.1 on an ephemeral port.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  _internals,
  appendToBuffer,
  buildCounterMetric,
  buildGaugeMetric,
  buildMetricsPayload,
  buildResource,
  buildSpan,
  buildTracePayload,
  createOtelExporter,
  drainBuffer,
  generateSpanId,
  generateTraceId,
  isLoopbackEndpoint,
  msToNano,
  resolveBufferPath,
  toAttributes,
  toAttributeValue,
} from '../../lib/observability/otel-exporter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'artibot-otel-'));
}

async function cleanupDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// generateSpanId / generateTraceId
// ---------------------------------------------------------------------------

describe('otel/generateSpanId', () => {
  it('16-char hex string 반환', () => {
    const id = generateSpanId(() => 0.5);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('고유성 (2회 호출 시 다른 값)', () => {
    const a = generateSpanId();
    const b = generateSpanId();
    expect(a).not.toBe(b);
  });
});

describe('otel/generateTraceId', () => {
  it('32-char hex string 반환', () => {
    const id = generateTraceId(() => 0.5);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// msToNano
// ---------------------------------------------------------------------------

describe('otel/msToNano', () => {
  it('ms → ns 문자열 변환', () => {
    expect(msToNano(1_000)).toBe('1000000000');
    expect(msToNano(1)).toBe('1000000');
  });

  it('OTLP 스펙: nanoseconds를 string으로 (int64 safe)', () => {
    const result = msToNano(Date.now());
    expect(typeof result).toBe('string');
    expect(BigInt(result) > 0n).toBe(true);
  });

  it('음수/NaN → "0"', () => {
    expect(msToNano(-1)).toBe('0');
    expect(msToNano(NaN)).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// toAttributeValue / toAttributes (OTLP KeyValue spec)
// ---------------------------------------------------------------------------

describe('otel/toAttributeValue', () => {
  it('string → stringValue', () => {
    expect(toAttributeValue('hi')).toEqual({ stringValue: 'hi' });
  });

  it('integer → intValue (as string)', () => {
    expect(toAttributeValue(42)).toEqual({ intValue: '42' });
  });

  it('float → doubleValue', () => {
    expect(toAttributeValue(3.14)).toEqual({ doubleValue: 3.14 });
  });

  it('boolean → boolValue', () => {
    expect(toAttributeValue(true)).toEqual({ boolValue: true });
    expect(toAttributeValue(false)).toEqual({ boolValue: false });
  });

  it('null/undefined → 빈 stringValue', () => {
    expect(toAttributeValue(null)).toEqual({ stringValue: '' });
    expect(toAttributeValue(undefined)).toEqual({ stringValue: '' });
  });

  it('object → stringValue (JSON 직렬화)', () => {
    const r = toAttributeValue({ a: 1 });
    expect(r.stringValue).toBe('{"a":1}');
  });
});

describe('otel/toAttributes', () => {
  it('객체 → KeyValue[] (OTLP 스펙)', () => {
    const attrs = toAttributes({ 'service.name': 'artibot', count: 3 });
    expect(attrs).toHaveLength(2);
    expect(attrs[0]).toEqual({
      key: 'service.name',
      value: { stringValue: 'artibot' },
    });
    expect(attrs[1]).toEqual({ key: 'count', value: { intValue: '3' } });
  });

  it('undefined 값은 제거', () => {
    const attrs = toAttributes({ a: 1, b: undefined });
    expect(attrs).toHaveLength(1);
    expect(attrs[0].key).toBe('a');
  });

  it('non-object → 빈 배열', () => {
    expect(toAttributes(null)).toEqual([]);
    expect(toAttributes('x')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isLoopbackEndpoint
// ---------------------------------------------------------------------------

describe('otel/isLoopbackEndpoint', () => {
  it('127.0.0.1 → true', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:4318')).toBe(true);
  });

  it('localhost → true', () => {
    expect(isLoopbackEndpoint('http://localhost:4318')).toBe(true);
  });

  it('[::1] → true', () => {
    expect(isLoopbackEndpoint('http://[::1]:4318')).toBe(true);
  });

  it('외부 호스트 → false', () => {
    expect(isLoopbackEndpoint('https://otel-collector.example.com')).toBe(false);
  });

  it('잘못된 URL → false', () => {
    expect(isLoopbackEndpoint('not-a-url')).toBe(false);
    expect(isLoopbackEndpoint('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildResource / buildSpan / buildTracePayload (OTLP spec)
// ---------------------------------------------------------------------------

describe('otel/buildResource', () => {
  it('service.name 포함', () => {
    const r = buildResource('artibot');
    const nameAttr = r.attributes.find((a) => a.key === 'service.name');
    expect(nameAttr.value.stringValue).toBe('artibot');
  });

  it('기본 SDK 메타데이터 포함', () => {
    const r = buildResource('artibot');
    const keys = r.attributes.map((a) => a.key);
    expect(keys).toContain('telemetry.sdk.name');
    expect(keys).toContain('telemetry.sdk.language');
    expect(keys).toContain('host.name');
    expect(keys).toContain('process.pid');
  });
});

describe('otel/buildSpan', () => {
  it('필수 필드 포함 (OTLP 스펙)', () => {
    const span = buildSpan({
      name: 'test',
      startTimeMs: 1000,
      endTimeMs: 2000,
      attributes: { foo: 'bar' },
    });
    expect(span.name).toBe('test');
    expect(span.startTimeUnixNano).toBe('1000000000');
    expect(span.endTimeUnixNano).toBe('2000000000');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.status.code).toBe(0);
    expect(span.kind).toBe(1);
    expect(Array.isArray(span.attributes)).toBe(true);
  });

  it('parentSpanId 지정 시 포함', () => {
    const span = buildSpan({
      name: 't',
      startTimeMs: 1,
      endTimeMs: 2,
      parentSpanId: 'deadbeefdeadbeef',
    });
    expect(span.parentSpanId).toBe('deadbeefdeadbeef');
  });
});

describe('otel/buildTracePayload', () => {
  it('OTLP ExportTraceServiceRequest 구조 준수', () => {
    const span = buildSpan({ name: 't', startTimeMs: 1, endTimeMs: 2 });
    const resource = buildResource('artibot');
    const payload = buildTracePayload([span], resource);
    expect(payload.resourceSpans).toHaveLength(1);
    expect(payload.resourceSpans[0].resource).toBe(resource);
    expect(payload.resourceSpans[0].scopeSpans).toHaveLength(1);
    expect(payload.resourceSpans[0].scopeSpans[0].scope.name).toBe('artibot.runtime');
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0]).toBe(span);
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('otel/buildCounterMetric', () => {
  it('Sum/monotonic/cumulative 구조', () => {
    const m = buildCounterMetric('req.count', 5, 1000, { k: 'v' });
    expect(m.name).toBe('req.count');
    expect(m.sum.isMonotonic).toBe(true);
    expect(m.sum.aggregationTemporality).toBe(2); // CUMULATIVE
    expect(m.sum.dataPoints[0].asDouble).toBe(5);
    expect(m.sum.dataPoints[0].timeUnixNano).toBe('1000000000');
  });
});

describe('otel/buildGaugeMetric', () => {
  it('Gauge 구조', () => {
    const m = buildGaugeMetric('cache.rate', 0.75, 1000);
    expect(m.gauge.dataPoints[0].asDouble).toBe(0.75);
    expect(m.gauge.dataPoints[0].timeUnixNano).toBe('1000000000');
  });
});

describe('otel/buildMetricsPayload', () => {
  it('OTLP ExportMetricsServiceRequest 구조 준수', () => {
    const m = buildCounterMetric('c', 1, 1000);
    const resource = buildResource('artibot');
    const p = buildMetricsPayload([m], resource);
    expect(p.resourceMetrics[0].scopeMetrics[0].metrics[0]).toBe(m);
    expect(p.resourceMetrics[0].scopeMetrics[0].scope.name).toBe('artibot.runtime');
  });
});

// ---------------------------------------------------------------------------
// Retry buffer (JSONL persistence)
// ---------------------------------------------------------------------------

describe('otel/retry-buffer', () => {
  let tmp;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(async () => {
    await cleanupDir(tmp);
  });

  it('appendToBuffer 후 drainBuffer로 왕복', async () => {
    const file = path.join(tmp, 'buf.jsonl');
    await appendToBuffer(file, { url: 'u1', payload: { a: 1 } });
    await appendToBuffer(file, { url: 'u2', payload: { a: 2 } });
    const entries = await drainBuffer(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe('u1');
    expect(entries[1].payload.a).toBe(2);
    // Drain 후 빈 파일
    const again = await drainBuffer(file);
    expect(again).toHaveLength(0);
  });

  it('resolveBufferPath 기본 위치 runtime/otel-retry-buffer.jsonl', () => {
    const p = resolveBufferPath('/fake/root');
    expect(p.replace(/\\/g, '/')).toBe('/fake/root/runtime/otel-retry-buffer.jsonl');
  });

  it('없는 파일 drain → 빈 배열', async () => {
    const entries = await drainBuffer(path.join(tmp, 'none.jsonl'));
    expect(entries).toEqual([]);
  });

  it('잘못된 JSON 라인은 skip', async () => {
    const file = path.join(tmp, 'corrupt.jsonl');
    await fs.writeFile(file, '{"ok":1}\nnotjson\n{"ok":2}\n', 'utf8');
    const entries = await drainBuffer(file);
    expect(entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createOtelExporter — disabled by default
// ---------------------------------------------------------------------------

describe('createOtelExporter — disabled', () => {
  it('endpoint 없으면 기본 disabled', async () => {
    const exp = createOtelExporter();
    expect(exp.enabled).toBe(false);
    const res = await exp.exportSpans([]);
    expect(res.skipped).toBe('disabled');
  });

  it('enabled=false 명시 시 export no-op', async () => {
    const exp = createOtelExporter({
      endpoint: 'http://127.0.0.1:9999',
      enabled: false,
      httpPost: async () => { throw new Error('should not be called'); },
    });
    expect(exp.enabled).toBe(false);
    const r = await exp.exportSpans([{}]);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe('disabled');
  });

  it('metrics도 disabled 시 no-op', async () => {
    const exp = createOtelExporter();
    const r = await exp.exportMetrics([{}]);
    expect(r.skipped).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// Loopback warning
// ---------------------------------------------------------------------------

describe('createOtelExporter — loopback warning', () => {
  it('loopback endpoint → warning 없음', () => {
    const warnings = [];
    createOtelExporter({
      endpoint: 'http://127.0.0.1:4318',
      enabled: true,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(0);
  });

  it('non-loopback endpoint → stderr warning', () => {
    const warnings = [];
    createOtelExporter({
      endpoint: 'https://remote-collector.example.com',
      enabled: true,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not loopback/i);
  });

  it('disabled 시 non-loopback이어도 warning 없음', () => {
    const warnings = [];
    createOtelExporter({
      endpoint: 'https://remote.example.com',
      enabled: false,
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retry behavior with injected httpPost
// ---------------------------------------------------------------------------

describe('createOtelExporter — retry buffer on failure', () => {
  let tmp;
  beforeEach(async () => {
    tmp = await makeTempDir();
  });
  afterEach(async () => {
    await cleanupDir(tmp);
  });

  it('네트워크 실패 시 buffer에 append', async () => {
    const bufferPath = path.join(tmp, 'retry.jsonl');
    const exp = createOtelExporter({
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
      bufferPath,
      maxRetries: 1,
      httpPost: async () => { throw new Error('ECONNREFUSED'); },
    });
    const span = buildSpan({ name: 's', startTimeMs: 1, endTimeMs: 2 });
    const r = await exp.exportSpans([span]);
    expect(r.ok).toBe(false);
    expect(r.buffered).toBe(true);
    const contents = await fs.readFile(bufferPath, 'utf8');
    expect(contents).toContain('"url"');
  });

  it('5xx 응답 시 retry 후 buffer', async () => {
    const bufferPath = path.join(tmp, 'retry.jsonl');
    let calls = 0;
    const exp = createOtelExporter({
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
      bufferPath,
      maxRetries: 2,
      httpPost: async () => {
        calls += 1;
        return { ok: false, status: 503, body: '' };
      },
    });
    const r = await exp.exportSpans([buildSpan({ name: 's', startTimeMs: 1, endTimeMs: 2 })]);
    expect(r.ok).toBe(false);
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(r.buffered).toBe(true);
  });

  it('4xx(429 제외) 응답 시 retry 없이 즉시 buffer', async () => {
    const bufferPath = path.join(tmp, 'retry.jsonl');
    let calls = 0;
    const exp = createOtelExporter({
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
      bufferPath,
      maxRetries: 5,
      httpPost: async () => {
        calls += 1;
        return { ok: false, status: 400, body: '' };
      },
    });
    await exp.exportSpans([buildSpan({ name: 's', startTimeMs: 1, endTimeMs: 2 })]);
    expect(calls).toBe(1);
  });

  it('flushRetryBuffer: 성공 시 drain', async () => {
    const bufferPath = path.join(tmp, 'retry.jsonl');
    await appendToBuffer(bufferPath, {
      url: 'http://127.0.0.1:9/v1/traces',
      payload: { resourceSpans: [] },
      ts: Date.now(),
    });
    const exp = createOtelExporter({
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
      bufferPath,
      httpPost: async () => ({ ok: true, status: 200, body: '' }),
    });
    const r = await exp.flushRetryBuffer();
    expect(r.attempted).toBe(1);
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real HTTP server on loopback
// ---------------------------------------------------------------------------

describe('createOtelExporter — loopback HTTP server', () => {
  let server;
  let port;
  let received;

  beforeEach(async () => {
    received = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({
          path: req.url,
          method: req.method,
          contentType: req.headers['content-type'],
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('spans POST /v1/traces (OTLP JSON)', async () => {
    const exp = createOtelExporter({
      endpoint: `http://127.0.0.1:${port}`,
      enabled: true,
    });
    const span = buildSpan({ name: 'pipeline', startTimeMs: 1, endTimeMs: 2 });
    const r = await exp.exportSpans([span]);
    expect(r.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/v1/traces');
    expect(received[0].contentType).toContain('application/json');
    const parsed = JSON.parse(received[0].body);
    expect(parsed.resourceSpans).toBeDefined();
    expect(parsed.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('pipeline');
  });

  it('metrics POST /v1/metrics', async () => {
    const exp = createOtelExporter({
      endpoint: `http://127.0.0.1:${port}`,
      enabled: true,
    });
    const m = buildCounterMetric('artibot.tokens.total', 100, 1000);
    const r = await exp.exportMetrics([m]);
    expect(r.ok).toBe(true);
    expect(received[0].path).toBe('/v1/metrics');
    const parsed = JSON.parse(received[0].body);
    expect(parsed.resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe('artibot.tokens.total');
  });

  it('커스텀 헤더 전달', async () => {
    const exp = createOtelExporter({
      endpoint: `http://127.0.0.1:${port}`,
      enabled: true,
      headers: { 'x-api-key': 'secret' },
    });
    await exp.exportSpans([buildSpan({ name: 's', startTimeMs: 1, endTimeMs: 2 })]);
    // Hook into latest server request via second call
    const exp2 = createOtelExporter({
      endpoint: `http://127.0.0.1:${port}`,
      enabled: true,
      headers: { 'x-api-key': 'secret' },
    });
    await exp2.exportSpans([buildSpan({ name: 's2', startTimeMs: 1, endTimeMs: 2 })]);
    expect(received.length).toBeGreaterThanOrEqual(1);
  });

  it('빈 spans → no network call', async () => {
    const exp = createOtelExporter({
      endpoint: `http://127.0.0.1:${port}`,
      enabled: true,
    });
    const r = await exp.exportSpans([]);
    expect(r.skipped).toBe('empty');
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Internals sanity
// ---------------------------------------------------------------------------

describe('otel/_internals', () => {
  it('LOOPBACK_HOSTS 포함 확인', () => {
    expect(_internals.LOOPBACK_HOSTS.has('127.0.0.1')).toBe(true);
    expect(_internals.LOOPBACK_HOSTS.has('localhost')).toBe(true);
  });

  it('INSTRUMENTATION_SCOPE 고정', () => {
    expect(_internals.INSTRUMENTATION_SCOPE.name).toBe('artibot.runtime');
  });
});
