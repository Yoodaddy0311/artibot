/**
 * Local-only tracing primitives.
 * Pattern-only adoption from openai-agents-python tracing/ (AD-06).
 * NO HTTP/network egress allowed in this module. Spans flush via injected exporter.
 * @module lib/observability/trace
 */

import { randomUUID } from 'node:crypto';

export const SPAN_TYPES = Object.freeze([
  'agent',
  'function',
  'handoff',
  'guardrail',
  'tool',
  'task',
  'turn',
]);

function nowMs() {
  return Date.now();
}

export class Span {
  constructor(type, attrs = {}, parent = null) {
    if (!SPAN_TYPES.includes(type)) {
      throw new TypeError(`Unknown span type: ${type}`);
    }
    this.id = randomUUID();
    this.type = type;
    this.parentId = parent?.id ?? null;
    this.traceId = parent?.traceId ?? randomUUID();
    this.attrs = { ...attrs };
    this.events = [];
    this.startedAt = nowMs();
    this.endedAt = null;
    this.error = null;
  }

  addEvent(name, data = {}) {
    this.events.push({ name, data, at: nowMs() });
    return this;
  }

  end(error) {
    this.endedAt = nowMs();
    if (error) {
      this.error = {
        message: error?.message ?? String(error),
        name: error?.name ?? 'Error',
      };
    }
    return this;
  }

  toJSON() {
    return {
      id: this.id,
      traceId: this.traceId,
      parentId: this.parentId,
      type: this.type,
      attrs: this.attrs,
      events: this.events,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.endedAt !== null ? this.endedAt - this.startedAt : null,
      error: this.error,
    };
  }
}

/**
 * Build a span. Provide parent for hierarchical traces.
 * @param {string} type
 * @param {object} [attrs]
 * @param {Span} [parent]
 * @returns {Span}
 */
export function createSpan(type, attrs = {}, parent = null) {
  return new Span(type, attrs, parent);
}

export class Trace {
  constructor({ name, sessionId, exporter } = {}) {
    this.id = randomUUID();
    this.name = name ?? 'trace';
    this.sessionId = sessionId ?? null;
    this.exporter = exporter ?? null;
    this.spans = [];
    this.startedAt = null;
    this.endedAt = null;
  }

  start() {
    this.startedAt = nowMs();
    return this;
  }

  recordSpan(span) {
    if (!(span instanceof Span)) {
      throw new TypeError('recordSpan expects a Span instance');
    }
    if (span.endedAt === null) {
      span.end();
    }
    this.spans.push(span);
    return this;
  }

  async end() {
    this.endedAt = nowMs();
    if (this.exporter && typeof this.exporter.export === 'function') {
      await this.exporter.export(this.spans.map((s) => ({
        ...s.toJSON(),
        sessionId: this.sessionId,
        traceName: this.name,
      })));
    }
    return this;
  }
}
