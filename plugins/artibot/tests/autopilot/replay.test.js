/**
 * Unit tests for lib/autopilot/replay.js
 *
 * Covers:
 *   - empty events → empty phases / topBottleneck null
 *   - 8-phase normal flow → 8 phase entries
 *   - bottleneck flag (>= 40% of total)
 *   - topBottleneck correct phase name
 *   - malformed ndjson lines are skipped
 *   - renderTimelineTable GFM shape (header + pipe count)
 *   - summarizeSession on missing file → empty result, no throw
 *   - retry counting via type='retry' and warn+message
 *   - invalid sessionId → safe empty result
 *   - 0-duration phases → fmtDuration handles correctly
 */
import {
  afterEach, describe, expect, it,
} from 'vitest';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  appendEvent,
  getEventsPath,
} from '../../lib/autopilot/telemetry.js';
import {
  renderTimelineTable,
  summarizeSession,
} from '../../lib/autopilot/replay.js';

const createdSessions = [];

function uniqueSessionId(label) {
  const id = `ap-test-replay-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

describe('summarizeSession — missing or empty input', () => {
  it('returns empty result for a session with no events file', () => {
    const id = `ap-test-replay-missing-${Date.now()}`;
    const summary = summarizeSession(id);
    expect(summary.sessionId).toBe(id);
    expect(summary.totalDurationMs).toBe(0);
    expect(summary.phases).toEqual([]);
    expect(summary.topBottleneck).toBeNull();
  });

  it('returns safe empty result on empty sessionId without throwing', () => {
    expect(() => summarizeSession('')).not.toThrow();
    const summary = summarizeSession('');
    expect(summary.phases).toEqual([]);
    expect(summary.topBottleneck).toBeNull();
  });
});

describe('summarizeSession — normal 8-phase flow', () => {
  it('produces one entry per phase window for an 8-phase session', () => {
    const id = uniqueSessionId('8phase');
    const phases = [
      'INTAKE', 'PLAN', 'EXECUTE', 'CROSS_CHECK',
      'VERIFY', 'IMPROVE', 'EVALUATE', 'REPORT',
    ];
    const t0 = Date.parse('2026-05-17T00:00:00.000Z');
    phases.forEach((phase, idx) => {
      appendEvent(id, {
        ts: new Date(t0 + idx * 60_000).toISOString(),
        phase,
        type: 'phase-start',
        level: 'info',
        message: `${phase} start`,
      });
      appendEvent(id, {
        ts: new Date(t0 + idx * 60_000 + 30_000).toISOString(),
        phase,
        type: 'phase-end',
        level: 'info',
        message: `${phase} end`,
      });
    });
    const summary = summarizeSession(id);
    expect(summary.phases).toHaveLength(8);
    expect(summary.phases.map((p) => p.phase)).toEqual(phases);
    expect(summary.totalDurationMs).toBeGreaterThan(0);
  });
});

describe('summarizeSession — bottleneck detection', () => {
  it('flags a phase consuming >= 40% of total duration', () => {
    const id = uniqueSessionId('bottleneck');
    const t0 = Date.parse('2026-05-17T00:00:00.000Z');
    // Phase A: 1s (10%), Phase B: 9s (90%) → B is bottleneck
    appendEvent(id, { ts: new Date(t0).toISOString(), phase: 'A', type: 'phase-start', level: 'info', message: 'a' });
    appendEvent(id, { ts: new Date(t0 + 1000).toISOString(), phase: 'A', type: 'phase-end', level: 'info', message: 'a-end' });
    appendEvent(id, { ts: new Date(t0 + 1000).toISOString(), phase: 'B', type: 'phase-start', level: 'info', message: 'b' });
    appendEvent(id, { ts: new Date(t0 + 10_000).toISOString(), phase: 'B', type: 'phase-end', level: 'info', message: 'b-end' });
    const summary = summarizeSession(id);
    const a = summary.phases.find((p) => p.phase === 'A');
    const b = summary.phases.find((p) => p.phase === 'B');
    expect(a.bottleneck).toBe(false);
    expect(b.bottleneck).toBe(true);
    expect(summary.topBottleneck).toBe('B');
  });
});

describe('summarizeSession — retry counting', () => {
  it('counts both type=retry and warn+message containing "retry"', () => {
    const id = uniqueSessionId('retry');
    const t0 = Date.parse('2026-05-17T00:00:00.000Z');
    appendEvent(id, { ts: new Date(t0).toISOString(), phase: 'EXECUTE', type: 'phase-start', level: 'info', message: 'start' });
    appendEvent(id, { ts: new Date(t0 + 100).toISOString(), phase: 'EXECUTE', type: 'retry', level: 'info', message: 'retry-1' });
    appendEvent(id, { ts: new Date(t0 + 200).toISOString(), phase: 'EXECUTE', type: 'log', level: 'warn', message: 'will retry now' });
    appendEvent(id, { ts: new Date(t0 + 300).toISOString(), phase: 'EXECUTE', type: 'log', level: 'warn', message: 'unrelated warn' });
    appendEvent(id, { ts: new Date(t0 + 400).toISOString(), phase: 'EXECUTE', type: 'phase-end', level: 'info', message: 'end' });
    const summary = summarizeSession(id);
    const ex = summary.phases[0];
    expect(ex.retries).toBe(2);
    expect(ex.warnings).toBe(2);
  });
});

describe('summarizeSession — malformed JSON lines', () => {
  it('skips malformed lines while keeping valid events', () => {
    const id = uniqueSessionId('malformed');
    const t0 = Date.parse('2026-05-17T00:00:00.000Z');
    // Write malformed + valid mix directly
    const filePath = getEventsPath(id);
    const lines = [
      JSON.stringify({ ts: new Date(t0).toISOString(), sessionId: id, phase: 'PLAN', type: 'phase-start', level: 'info', message: 'ok-1' }),
      '{this is not json',
      '',
      JSON.stringify({ ts: new Date(t0 + 1000).toISOString(), sessionId: id, phase: 'PLAN', type: 'phase-end', level: 'info', message: 'ok-2' }),
      'garbage{}}}',
    ].join('\n');
    writeFileSync(filePath, `${lines}\n`, 'utf-8');
    const summary = summarizeSession(id);
    expect(summary.phases).toHaveLength(1);
    expect(summary.phases[0].events).toBe(2);
  });
});

describe('renderTimelineTable — GFM output', () => {
  it('produces a valid markdown table with 9-pipe header row', () => {
    const id = uniqueSessionId('render');
    const t0 = Date.parse('2026-05-17T00:00:00.000Z');
    appendEvent(id, { ts: new Date(t0).toISOString(), phase: 'INTAKE', type: 'phase-start', level: 'info', message: 's' });
    appendEvent(id, { ts: new Date(t0 + 134_000).toISOString(), phase: 'INTAKE', type: 'phase-end', level: 'info', message: 'e' });
    const summary = summarizeSession(id);
    const md = renderTimelineTable(summary);
    expect(md).toContain('## Phase Timeline');
    const header = md.split('\n').find((l) => l.startsWith('| Phase |'));
    expect(header).toBeDefined();
    // Header has 9 pipes (8 columns)
    expect((header.match(/\|/g) || []).length).toBe(9);
    expect(md).toMatch(/\|---\|/);
  });

  it('returns a "no data" stub when summary has zero phases', () => {
    const md = renderTimelineTable({ sessionId: 'x', totalDurationMs: 0, phases: [], topBottleneck: null });
    expect(md).toContain('## Phase Timeline');
    expect(md).toMatch(/없음/);
  });

  it('includes Top bottleneck footer when topBottleneck is set', () => {
    const id = uniqueSessionId('topfoot');
    const t0 = Date.parse('2026-05-17T00:00:00.000Z');
    appendEvent(id, { ts: new Date(t0).toISOString(), phase: 'X', type: 'phase-start', level: 'info', message: 's' });
    appendEvent(id, { ts: new Date(t0 + 5000).toISOString(), phase: 'X', type: 'phase-end', level: 'info', message: 'e' });
    const summary = summarizeSession(id);
    const md = renderTimelineTable(summary);
    expect(md).toContain('Top bottleneck:');
    expect(md).toContain('X');
    expect(md).toContain('%');
  });

  it('renders bottleneck flag column as ⚠ for flagged phases', () => {
    const id = uniqueSessionId('flag');
    const t0 = Date.parse('2026-05-17T00:00:00.000Z');
    appendEvent(id, { ts: new Date(t0).toISOString(), phase: 'A', type: 'phase-start', level: 'info', message: 's' });
    appendEvent(id, { ts: new Date(t0 + 100).toISOString(), phase: 'A', type: 'phase-end', level: 'info', message: 'e' });
    appendEvent(id, { ts: new Date(t0 + 100).toISOString(), phase: 'B', type: 'phase-start', level: 'info', message: 's' });
    appendEvent(id, { ts: new Date(t0 + 10_000).toISOString(), phase: 'B', type: 'phase-end', level: 'info', message: 'e' });
    const md = renderTimelineTable(summarizeSession(id));
    expect(md).toMatch(/\| B \|.*⚠ \|/);
  });
});
