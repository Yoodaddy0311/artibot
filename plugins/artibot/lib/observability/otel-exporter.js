/**
 * OTLP HTTP Exporter (opt-in, loopback preferred).
 *
 * Zero-dependency OpenTelemetry Protocol (OTLP/HTTP JSON) exporter.
 * Emits spans and metrics derived from Artibot runtime middleware output
 * (token-usage, cache-roi) without pulling in `opentelemetry-js`.
 *
 * Design contract:
 * - Default **disabled**. Only activates when a concrete endpoint is configured.
 * - Network egress is the ONLY I/O beyond local disk. Loopback endpoints
 *   (127.0.0.1 / ::1 / localhost) are preferred; non-loopback endpoints
 *   emit a stderr warning so the operator sees the data-egress intent.
 * - Failed exports buffer to JSONL on disk and are retried on next flush.
 *   The buffer is capped to prevent unbounded growth.
 * - No external runtime deps. Uses only `node:http`, `node:https`, `node:fs`,
 *   `node:path`, `node:url`, `node:os`.
 * - All functions are pure or clearly side-effecting. Factory returns a
 *   closure instance so consumers can own lifecycle.
 *
 * DATA POLICY: local-only by default. Activation is explicit. Non-loopback
 * export is possible but warned about — it is the caller's responsibility to
 * ensure the target collector is trusted (e.g., user-owned Grafana/Jaeger).
 *
 * @module lib/observability/otel-exporter
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getPluginRoot } from '../core/platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVICE_NAME = 'artibot';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BUFFER_MAX_ENTRIES = 500;
const DEFAULT_RETRY_MAX = 3;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// OTLP JSON resource/instrumentation identity, frozen for cacheability.
const INSTRUMENTATION_SCOPE = Object.freeze({
  name: 'artibot.runtime',
  version: '1.0.0',
});

// ---------------------------------------------------------------------------
// Pure helpers — ID generation, time, attribute coercion
// ---------------------------------------------------------------------------

/**
 * Generate a 16-hex-char span ID. OTLP requires 8 bytes hex-encoded.
 * @param {() => number} [rng]
 * @returns {string}
 */
export function generateSpanId(rng = Math.random) {
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += Math.floor(rng() * 16).toString(16);
  }
  return id;
}

/**
 * Generate a 32-hex-char trace ID (16 bytes).
 * @param {() => number} [rng]
 * @returns {string}
 */
export function generateTraceId(rng = Math.random) {
  let id = '';
  for (let i = 0; i < 32; i += 1) {
    id += Math.floor(rng() * 16).toString(16);
  }
  return id;
}

/**
 * Convert a JS millisecond timestamp to OTLP nanosecond string.
 * OTLP JSON requires unixNano as a string (>2^53 safe).
 * @param {number} ms
 * @returns {string}
 */
export function msToNano(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0';
  // Use BigInt to avoid float precision loss.
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString();
}

/**
 * Coerce an arbitrary JS value into an OTLP AttributeValue.
 * Unsupported types collapse to stringValue.
 *
 * @param {unknown} value
 * @returns {{stringValue?:string,intValue?:string,doubleValue?:number,boolValue?:boolean}}
 */
export function toAttributeValue(value) {
  if (value === null || value === undefined) return { stringValue: '' };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { intValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'bigint') return { intValue: value.toString() };
  if (typeof value === 'string') return { stringValue: value };
  try {
    return { stringValue: JSON.stringify(value) };
  } catch {
    return { stringValue: String(value) };
  }
}

/**
 * Convert a plain object into OTLP `KeyValue[]`.
 * @param {Record<string, unknown>} attrs
 * @returns {Array<{key:string,value:object}>}
 */
export function toAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out.push({ key, value: toAttributeValue(value) });
  }
  return out;
}

/**
 * Check if the endpoint host is a loopback address.
 * @param {string} endpoint
 * @returns {boolean}
 */
export function isLoopbackEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return false;
  try {
    const u = new URL(endpoint);
    const host = u.hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OTLP JSON builders (pure)
// ---------------------------------------------------------------------------

/**
 * Build a Resource object (shared across all spans/metrics in a batch).
 * @param {string} serviceName
 * @param {Record<string, unknown>} [extra]
 */
export function buildResource(serviceName, extra = {}) {
  return Object.freeze({
    attributes: toAttributes({
      'service.name': serviceName || DEFAULT_SERVICE_NAME,
      'service.namespace': 'artibot',
      'telemetry.sdk.name': 'artibot-otel',
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.version': '1.0.0',
      'host.name': os.hostname(),
      'process.pid': process.pid,
      ...extra,
    }),
  });
}

/**
 * Build a span object from a minimal descriptor.
 *
 * @param {object} desc
 * @param {string} desc.name
 * @param {number} desc.startTimeMs
 * @param {number} desc.endTimeMs
 * @param {string} [desc.traceId]
 * @param {string} [desc.spanId]
 * @param {string} [desc.parentSpanId]
 * @param {Record<string,unknown>} [desc.attributes]
 * @param {number} [desc.kind=1] — SPAN_KIND_INTERNAL=1, SERVER=2, CLIENT=3
 * @param {{code:number,message?:string}} [desc.status]
 */
export function buildSpan(desc) {
  const traceId = desc.traceId || generateTraceId();
  const spanId = desc.spanId || generateSpanId();
  const span = {
    traceId,
    spanId,
    name: desc.name,
    kind: typeof desc.kind === 'number' ? desc.kind : 1,
    startTimeUnixNano: msToNano(desc.startTimeMs),
    endTimeUnixNano: msToNano(desc.endTimeMs),
    attributes: toAttributes(desc.attributes || {}),
    status: desc.status || { code: 0 },
  };
  if (desc.parentSpanId) span.parentSpanId = desc.parentSpanId;
  return span;
}

/**
 * Build an OTLP ExportTraceServiceRequest payload.
 * @param {Array<object>} spans
 * @param {object} resource
 */
export function buildTracePayload(spans, resource) {
  return {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope: { ...INSTRUMENTATION_SCOPE },
            spans,
          },
        ],
      },
    ],
  };
}

/**
 * Build a Sum (counter) metric point.
 * @param {string} name
 * @param {number} value
 * @param {number} timeMs
 * @param {Record<string,unknown>} [attributes]
 */
export function buildCounterMetric(name, value, timeMs, attributes = {}) {
  return {
    name,
    sum: {
      dataPoints: [
        {
          attributes: toAttributes(attributes),
          startTimeUnixNano: msToNano(timeMs),
          timeUnixNano: msToNano(timeMs),
          asDouble: typeof value === 'number' ? value : 0,
        },
      ],
      aggregationTemporality: 2, // CUMULATIVE
      isMonotonic: true,
    },
  };
}

/**
 * Build a Gauge metric point.
 * @param {string} name
 * @param {number} value
 * @param {number} timeMs
 * @param {Record<string,unknown>} [attributes]
 */
export function buildGaugeMetric(name, value, timeMs, attributes = {}) {
  return {
    name,
    gauge: {
      dataPoints: [
        {
          attributes: toAttributes(attributes),
          timeUnixNano: msToNano(timeMs),
          asDouble: typeof value === 'number' ? value : 0,
        },
      ],
    },
  };
}

/**
 * Build an OTLP ExportMetricsServiceRequest payload.
 * @param {Array<object>} metrics
 * @param {object} resource
 */
export function buildMetricsPayload(metrics, resource) {
  return {
    resourceMetrics: [
      {
        resource,
        scopeMetrics: [
          {
            scope: { ...INSTRUMENTATION_SCOPE },
            metrics,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTTP transport (zero-dep)
// ---------------------------------------------------------------------------

/**
 * Post a JSON payload to an OTLP endpoint over HTTP/HTTPS.
 * Resolves with {ok, status, body} on response (any status).
 * Rejects only on network/transport errors.
 *
 * @param {string} url
 * @param {object} payload
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean,status:number,body:string}>}
 */
export function postJson(url, payload, opts = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`invalid endpoint: ${url}`));
      return;
    }
    const body = JSON.stringify(payload);
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      accept: 'application/json',
      ...(opts.headers || {}),
    };
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, body: data });
        });
      },
    );
    req.setTimeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error('otel export timeout'));
    });
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Persistence: retry buffer (JSONL)
// ---------------------------------------------------------------------------

/**
 * Default retry buffer location under plugin runtime/ dir.
 * @param {string} [pluginRoot]
 */
export function resolveBufferPath(pluginRoot) {
  const root = pluginRoot || getPluginRoot();
  return path.join(root, 'runtime', 'otel-retry-buffer.jsonl');
}

/**
 * Append a failed payload to the JSONL retry buffer.
 * Best-effort; never throws. Caps entries by truncating oldest.
 *
 * @param {string} bufferPath
 * @param {object} entry
 * @param {number} [maxEntries]
 */
export async function appendToBuffer(bufferPath, entry, maxEntries = DEFAULT_BUFFER_MAX_ENTRIES) {
  try {
    await fs.mkdir(path.dirname(bufferPath), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    await fs.appendFile(bufferPath, line, 'utf8');
    // Cap: if file exceeds roughly N lines, truncate oldest.
    const stat = await fs.stat(bufferPath);
    if (stat.size > maxEntries * 8192) {
      const raw = await fs.readFile(bufferPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const trimmed = lines.slice(-maxEntries).join('\n') + '\n';
      await fs.writeFile(bufferPath, trimmed, 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Drain the retry buffer: read all entries, return them, truncate file.
 * @param {string} bufferPath
 * @returns {Promise<Array<object>>}
 */
export async function drainBuffer(bufferPath) {
  try {
    const raw = await fs.readFile(bufferPath, 'utf8');
    const entries = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    // Truncate after successful read.
    await fs.writeFile(bufferPath, '', 'utf8');
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exporter factory
// ---------------------------------------------------------------------------

/**
 * Create an OTLP exporter instance.
 *
 * Endpoints expected:
 *   traces:  `${endpoint}/v1/traces`
 *   metrics: `${endpoint}/v1/metrics`
 * (Collector convention; `endpoint` should be the base URL without path.)
 *
 * @param {object} [options]
 * @param {string} [options.endpoint] — base URL, e.g. 'http://127.0.0.1:4318'
 * @param {string} [options.tracesPath='/v1/traces']
 * @param {string} [options.metricsPath='/v1/metrics']
 * @param {string} [options.serviceName='artibot']
 * @param {boolean} [options.enabled=false]
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRetries]
 * @param {string} [options.bufferPath]
 * @param {string} [options.pluginRoot]
 * @param {(url:string,payload:object,opts:object)=>Promise<{ok:boolean,status:number,body:string}>} [options.httpPost]
 *   Injection point for tests / alternate transports.
 * @param {(msg:string)=>void} [options.warn] — stderr warn function (injectable).
 */
export function createOtelExporter(options = {}) {
  const endpoint = options.endpoint || '';
  const tracesPath = options.tracesPath || '/v1/traces';
  const metricsPath = options.metricsPath || '/v1/metrics';
  const serviceName = options.serviceName || DEFAULT_SERVICE_NAME;
  // If endpoint is explicitly provided, default to enabled; still overridable.
  const enabled = options.enabled !== undefined ? options.enabled : Boolean(endpoint);
  const headers = options.headers || {};
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY_MAX;
  const bufferPath = options.bufferPath || resolveBufferPath(options.pluginRoot);
  const httpPost = options.httpPost || postJson;
  const warn = options.warn || ((msg) => process.stderr.write(`[artibot-otel] ${msg}\n`));

  // Loopback warning at construction time (not per call) to avoid noise.
  if (enabled && endpoint && !isLoopbackEndpoint(endpoint)) {
    warn(
      `WARNING: OTEL endpoint '${endpoint}' is not loopback. Telemetry will leave this machine. `
        + 'Prefer 127.0.0.1/localhost collectors unless the target is trusted.',
    );
  }

  const resource = buildResource(serviceName);

  function buildUrl(subPath) {
    if (!endpoint) return '';
    const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
    return `${base}${subPath}`;
  }

  async function exportPayload(url, payload) {
    let attempt = 0;
    let lastErr = null;
    while (attempt <= maxRetries) {
      try {
        const res = await httpPost(url, payload, { headers, timeoutMs });
        if (res.ok) return { ok: true, status: res.status, attempts: attempt + 1 };
        // 4xx: don't retry non-transient client errors except 429.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          lastErr = new Error(`otel export rejected: ${res.status}`);
          break;
        }
        lastErr = new Error(`otel export non-2xx: ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      attempt += 1;
    }
    // Failed: buffer for later retry.
    await appendToBuffer(bufferPath, { url, payload, ts: Date.now() });
    return {
      ok: false,
      error: lastErr ? lastErr.message : 'unknown',
      attempts: attempt,
      buffered: true,
    };
  }

  return {
    get enabled() {
      return enabled;
    },
    get endpoint() {
      return endpoint;
    },
    get bufferPath() {
      return bufferPath;
    },
    get serviceName() {
      return serviceName;
    },

    /**
     * Export spans. No-op when disabled.
     * @param {Array<object>} spans — built via `buildSpan()`.
     */
    async exportSpans(spans) {
      if (!enabled || !endpoint) return { ok: true, skipped: 'disabled' };
      if (!Array.isArray(spans) || spans.length === 0) {
        return { ok: true, skipped: 'empty' };
      }
      const payload = buildTracePayload(spans, resource);
      return exportPayload(buildUrl(tracesPath), payload);
    },

    /**
     * Export metrics. No-op when disabled.
     * @param {Array<object>} metrics — built via `buildCounterMetric()`/`buildGaugeMetric()`.
     */
    async exportMetrics(metrics) {
      if (!enabled || !endpoint) return { ok: true, skipped: 'disabled' };
      if (!Array.isArray(metrics) || metrics.length === 0) {
        return { ok: true, skipped: 'empty' };
      }
      const payload = buildMetricsPayload(metrics, resource);
      return exportPayload(buildUrl(metricsPath), payload);
    },

    /**
     * Drain retry buffer and re-attempt queued exports.
     * Returns counts of attempted/succeeded/failed entries.
     */
    async flushRetryBuffer() {
      if (!enabled) return { ok: true, skipped: 'disabled' };
      const entries = await drainBuffer(bufferPath);
      if (entries.length === 0) return { ok: true, attempted: 0, succeeded: 0, failed: 0 };
      let succeeded = 0;
      let failed = 0;
      for (const entry of entries) {
        try {
          const res = await httpPost(entry.url, entry.payload, { headers, timeoutMs });
          if (res.ok) {
            succeeded += 1;
          } else {
            failed += 1;
            await appendToBuffer(bufferPath, entry);
          }
        } catch {
          failed += 1;
          await appendToBuffer(bufferPath, entry);
        }
      }
      return { ok: true, attempted: entries.length, succeeded, failed };
    },

    // Low-level builders exposed for middleware convenience.
    buildSpan,
    buildCounterMetric,
    buildGaugeMetric,
    buildResource: () => resource,
  };
}

// ---------------------------------------------------------------------------
// Test exports (internal helpers)
// ---------------------------------------------------------------------------

export const _internals = Object.freeze({
  LOOPBACK_HOSTS,
  DEFAULT_SERVICE_NAME,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BUFFER_MAX_ENTRIES,
  INSTRUMENTATION_SCOPE,
});
