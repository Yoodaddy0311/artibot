/**
 * Unit tests for lib/autopilot/telemetry.js
 * Covers appendEvent, readEvents, getEventsPath, tail option, level filter,
 * Korean message preservation, and concurrent appends.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  appendEvent,
  getEventsPath,
  readEvents,
} from '../../lib/autopilot/telemetry.js';
import { getStoreDir } from '../../lib/autopilot/session-store.js';

const createdSessions = [];

function uniqueSessionId(label) {
  const id = `ap-test-telemetry-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdSessions.push(id);
  return id;
}

afterEach(() => {
  while (createdSessions.length) {
    const id = createdSessions.pop();
    try {
      const filePath = getEventsPath(id);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch { /* ignore */ }
  }
});

describe('getEventsPath', () => {
  it('returns absolute path under store dir with .events.ndjson suffix', () => {
    const sessionId = 'ap-test-path-only';
    const filePath = getEventsPath(sessionId);
    expect(path.isAbsolute(filePath)).toBe(true);
    expect(filePath.endsWith(`${sessionId}.events.ndjson`)).toBe(true);
    expect(filePath.startsWith(getStoreDir())).toBe(true);
  });

  it('throws TypeError on empty sessionId', () => {
    expect(() => getEventsPath('')).toThrow(TypeError);
    expect(() => getEventsPath(null)).toThrow(TypeError);
  });
});

describe('appendEvent + readEvents roundtrip', () => {
  it('persists a single event and reads it back', () => {
    const sessionId = uniqueSessionId('roundtrip');
    appendEvent(sessionId, {
      phase: 'INTAKE',
      type: 'phase-start',
      level: 'info',
      message: 'starting',
    });
    const events = readEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('INTAKE');
    expect(events[0].type).toBe('phase-start');
    expect(events[0].level).toBe('info');
    expect(events[0].message).toBe('starting');
    expect(events[0].sessionId).toBe(sessionId);
    expect(typeof events[0].ts).toBe('string');
  });

  it('preserves Korean characters in message and data fields', () => {
    const sessionId = uniqueSessionId('korean');
    const koreanMsg = 'Phase 0 시작 — 한글 메시지 보존 확인';
    appendEvent(sessionId, {
      phase: 'INTAKE',
      type: 'phase-start',
      level: 'info',
      message: koreanMsg,
      data: { 작업: '자율 모드 테스트' },
    });
    const events = readEvents(sessionId);
    expect(events[0].message).toBe(koreanMsg);
    expect(events[0].data).toEqual({ 작업: '자율 모드 테스트' });
  });
});

describe('readEvents tail option', () => {
  it('returns only the last N events when tail is specified', () => {
    const sessionId = uniqueSessionId('tail');
    for (let i = 0; i < 10; i += 1) {
      appendEvent(sessionId, {
        phase: 'EXECUTE',
        type: 'progress',
        level: 'info',
        message: `tick-${i}`,
      });
    }
    const last3 = readEvents(sessionId, { tail: 3 });
    expect(last3).toHaveLength(3);
    expect(last3.map((e) => e.message)).toEqual(['tick-7', 'tick-8', 'tick-9']);
  });

  it('returns all events when tail exceeds total count', () => {
    const sessionId = uniqueSessionId('tail-overflow');
    appendEvent(sessionId, { type: 'a', level: 'info', message: 'one' });
    appendEvent(sessionId, { type: 'b', level: 'info', message: 'two' });
    const all = readEvents(sessionId, { tail: 100 });
    expect(all).toHaveLength(2);
  });
});

describe('readEvents on missing session', () => {
  it('returns empty array when session has no events file', () => {
    const sessionId = `ap-test-nonexistent-${Date.now()}`;
    const events = readEvents(sessionId);
    expect(events).toEqual([]);
  });

  it('returns empty array with tail option on missing file', () => {
    const sessionId = `ap-test-nonexistent-tail-${Date.now()}`;
    const events = readEvents(sessionId, { tail: 5 });
    expect(events).toEqual([]);
  });
});

describe('appendEvent concurrency', () => {
  it('persists multiple sequential appends without loss or corruption', () => {
    const sessionId = uniqueSessionId('concurrent');
    const N = 25;
    for (let i = 0; i < N; i += 1) {
      appendEvent(sessionId, {
        phase: 'EXECUTE',
        type: 'tool-call',
        level: 'info',
        message: `event-${i}`,
        data: { idx: i },
      });
    }
    const events = readEvents(sessionId);
    expect(events).toHaveLength(N);
    // Order preserved
    for (let i = 0; i < N; i += 1) {
      expect(events[i].message).toBe(`event-${i}`);
      expect(events[i].data).toEqual({ idx: i });
    }
  });
});

describe('readEvents level filter', () => {
  it('filters events by level when level option is provided', () => {
    const sessionId = uniqueSessionId('level-filter');
    appendEvent(sessionId, { type: 'phase-start', level: 'info', message: 'i1' });
    appendEvent(sessionId, { type: 'pause', level: 'warn', message: 'w1' });
    appendEvent(sessionId, { type: 'phase-end', level: 'info', message: 'i2' });
    appendEvent(sessionId, { type: 'abort', level: 'error', message: 'e1' });

    const warns = readEvents(sessionId, { level: 'warn' });
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toBe('w1');

    const infos = readEvents(sessionId, { level: 'info' });
    expect(infos.map((e) => e.message)).toEqual(['i1', 'i2']);

    const errors = readEvents(sessionId, { level: 'error' });
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('abort');
  });

  it('combines level filter with tail option', () => {
    const sessionId = uniqueSessionId('level-tail');
    for (let i = 0; i < 5; i += 1) {
      appendEvent(sessionId, { level: 'info', type: 'log', message: `info-${i}` });
      appendEvent(sessionId, { level: 'warn', type: 'log', message: `warn-${i}` });
    }
    const lastTwoWarns = readEvents(sessionId, { level: 'warn', tail: 2 });
    expect(lastTwoWarns).toHaveLength(2);
    expect(lastTwoWarns.map((e) => e.message)).toEqual(['warn-3', 'warn-4']);
  });
});

describe('appendEvent default normalization', () => {
  it('coerces unknown level to info and missing type to log', () => {
    const sessionId = uniqueSessionId('normalize');
    appendEvent(sessionId, { message: 'no level no type' });
    const events = readEvents(sessionId);
    expect(events[0].level).toBe('info');
    expect(events[0].type).toBe('log');
    expect(events[0].sessionId).toBe(sessionId);
  });

  it('throws TypeError on missing sessionId', () => {
    expect(() => appendEvent('', { message: 'x' })).toThrow(TypeError);
    expect(() => appendEvent(null, { message: 'x' })).toThrow(TypeError);
  });
});
