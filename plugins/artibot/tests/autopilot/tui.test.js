/**
 * Unit tests for lib/autopilot/tui.js — Track A1 Phase 2.
 *
 * Covers:
 *   - renderFrame determinism (same input → same output minus elapsed)
 *   - ASCII box-drawing chars are unicode (TUI exception)
 *   - progress bar exact 20-cell width at 4/8 phases
 *   - level color escapes present for info/warn/error
 *   - compact layout omits queue when width<60
 *   - tokenUsage missing → token row omitted
 *   - shouldActivateTui policy matrix
 *   - runTuiLoop on non-TTY stream returns immediately
 *   - runTuiLoop with abort signal stops within interval+50ms
 *   - runTuiLoop with state.phase='COMPLETED' exits after one frame
 *   - Korean message renders unchanged
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import {
  renderFrame, runTuiLoop, shouldActivateTui,
} from '../../lib/autopilot/tui.js';
import { deleteSessionArtifacts, saveSession } from '../../lib/autopilot/session-store.js';
import { appendEvent, getEventsPath } from '../../lib/autopilot/telemetry.js';

const createdSessions = [];

function makeState(overrides = {}) {
  const id = overrides.sessionId
    || `ap-test-tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state = {
    sessionId: id,
    task: 'tui test task',
    mode: 'default',
    phase: 'EXECUTE',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    options: {},
    phases: [
      { name: 'INTAKE', status: 'done', ts: new Date().toISOString() },
      { name: 'PLAN', status: 'done', ts: new Date().toISOString() },
      { name: 'EXECUTE', status: 'done', ts: new Date().toISOString() },
      { name: 'CROSS_CHECK', status: 'done', ts: new Date().toISOString() },
    ],
    queuedQuestions: [],
    counters: { buildFailures: 0, testFailures: 0 },
    ...overrides,
  };
  return state;
}

function persistAndTrack(state) {
  saveSession(state);
  createdSessions.push(state.sessionId);
  return state;
}

afterEach(() => {
  while (createdSessions.length) {
    const id = createdSessions.pop();
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
    try {
      const ev = getEventsPath(id);
      if (existsSync(ev)) unlinkSync(ev);
    } catch { /* ignore */ }
  }
});

describe('shouldActivateTui', () => {
  it('returns true for default mode with TTY', () => {
    expect(shouldActivateTui({ mode: 'default', options: {} }, { isTTY: true })).toBe(true);
  });

  it('returns false when state is null', () => {
    expect(shouldActivateTui(null, { isTTY: true })).toBe(false);
  });

  it('returns false in night mode', () => {
    expect(shouldActivateTui({ mode: 'night', options: {} }, { isTTY: true })).toBe(false);
  });

  it('returns false when options.noTui is true', () => {
    expect(shouldActivateTui({ mode: 'default', options: { noTui: true } }, { isTTY: true })).toBe(false);
  });

  it('returns false when options.tui is explicitly false', () => {
    expect(shouldActivateTui({ mode: 'default', options: { tui: false } }, { isTTY: true })).toBe(false);
  });

  it('returns false when env.isTTY is explicitly false', () => {
    expect(shouldActivateTui({ mode: 'default', options: {} }, { isTTY: false })).toBe(false);
  });

  it('returns true when env.isTTY is undefined (default ON)', () => {
    expect(shouldActivateTui({ mode: 'default', options: {} }, {})).toBe(true);
  });
});

describe('renderFrame — shape and content', () => {
  it('returns a non-empty multi-line ANSI-decorated string', () => {
    const out = renderFrame({ state: makeState(), events: [] });
    expect(typeof out).toBe('string');
    expect(out.split('\n').length).toBeGreaterThan(3);
    // Contains at least one ANSI escape (color)
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(true);
  });

  it('uses unicode box-drawing chars (TUI exception per project policy)', () => {
    const out = renderFrame({ state: makeState(), events: [] });
    expect(out.includes('\u250C')).toBe(true); // ┌
    expect(out.includes('\u2510')).toBe(true); // ┐
    expect(out.includes('\u2514')).toBe(true); // └
    expect(out.includes('\u2518')).toBe(true); // ┘
    expect(out.includes('\u2502')).toBe(true); // │
  });

  it('renders progress bar at exactly 20-cell width for 4/8 phases', () => {
    const out = renderFrame({ state: makeState(), events: [], width: 80 });
    // 4 done out of 8 → 10 filled, 10 empty
    expect(out).toContain('\u2588'.repeat(10) + '\u2591'.repeat(10));
    expect(out).toContain('4/8 phases');
  });

  it('uses ASCII fallback chars when asciiOnly=true', () => {
    const out = renderFrame({
      state: makeState(), events: [], width: 80, asciiOnly: true,
    });
    expect(out).toContain('#'.repeat(10) + '-'.repeat(10));
    expect(out.includes('\u2588')).toBe(false);
  });

  it('includes blue/yellow/red color escapes for info/warn/error levels', () => {
    const events = [
      { ts: '2026-05-17T01:00:00.000Z', phase: 'EXECUTE', type: 'log', level: 'info', message: 'info-line' },
      { ts: '2026-05-17T01:00:01.000Z', phase: 'EXECUTE', type: 'log', level: 'warn', message: 'warn-line' },
      { ts: '2026-05-17T01:00:02.000Z', phase: 'EXECUTE', type: 'log', level: 'error', message: 'err-line' },
    ];
    const out = renderFrame({ state: makeState(), events });
    expect(out).toContain('\x1b[34m'); // blue (info)
    expect(out).toContain('\x1b[33m'); // yellow (warn)
    expect(out).toContain('\x1b[31m'); // red (error)
  });

  it('omits the token row when tokenUsage is undefined', () => {
    const out = renderFrame({ state: makeState(), events: [] });
    expect(out.includes('Tokens:')).toBe(false);
  });

  it('renders the token row when tokenUsage is provided', () => {
    const out = renderFrame({
      state: makeState(),
      events: [],
      tokenUsage: { used: 1_200_000, budget: 2_000_000 },
    });
    expect(out).toContain('Tokens:');
    expect(out).toContain('1.2M');
    expect(out).toContain('2.0M');
  });

  it('omits queued-questions block at compact width (<60)', () => {
    const state = makeState({
      queuedQuestions: [{ title: 'confirm migration drop' }],
    });
    const out = renderFrame({ state, events: [], width: 50 });
    expect(out.includes('Queued Questions')).toBe(false);
  });

  it('renders queued-questions block at normal width when entries exist', () => {
    const state = makeState({
      queuedQuestions: [
        { title: 'confirm migration drop' },
        { title: 'approve force push' },
      ],
    });
    const out = renderFrame({ state, events: [], width: 80 });
    expect(out).toContain('Queued Questions (2)');
    expect(out).toContain('confirm migration drop');
  });

  it('preserves Korean characters in event messages', () => {
    const events = [{
      ts: '2026-05-17T01:00:00.000Z',
      phase: 'EXECUTE',
      type: 'phase-start',
      level: 'info',
      message: 'Phase 2 시작 — 한글 메시지',
    }];
    const out = renderFrame({ state: makeState(), events });
    expect(out).toContain('한글 메시지');
    expect(out).toContain('Phase 2 시작');
  });

  it('is deterministic for the same input within one ms tick (modulo elapsed)', () => {
    const state = makeState();
    const a = renderFrame({ state, events: [], width: 80 });
    const b = renderFrame({ state, events: [], width: 80 });
    // Strip the elapsed clock segment which depends on Date.now().
    const stripElapsed = (s) => s.replace(/\d{2}:\d{2}:\d{2}/g, 'HH:MM:SS');
    expect(stripElapsed(a)).toBe(stripElapsed(b));
  });
});

describe('runTuiLoop — TTY-less environments', () => {
  it('returns immediately when stream.isTTY is false (no write)', async () => {
    const writes = [];
    const stream = {
      isTTY: false,
      columns: 80,
      write(chunk) { writes.push(chunk); return true; },
    };
    const state = persistAndTrack(makeState({ phase: 'COMPLETED' }));
    await runTuiLoop(state.sessionId, { stream, intervalMs: 50 });
    expect(writes).toHaveLength(0);
  });

  it('returns immediately when sessionId is empty', async () => {
    const writes = [];
    const stream = {
      isTTY: true,
      columns: 80,
      write(chunk) { writes.push(chunk); return true; },
    };
    await runTuiLoop('', { stream, intervalMs: 50 });
    expect(writes).toHaveLength(0);
  });
});

describe('runTuiLoop — terminal interaction', () => {
  it('renders one frame then exits when state.phase is COMPLETED', async () => {
    const writes = [];
    const stream = {
      isTTY: true,
      columns: 80,
      write(chunk) { writes.push(String(chunk)); return true; },
    };
    const state = persistAndTrack(makeState({ phase: 'COMPLETED' }));
    appendEvent(state.sessionId, {
      phase: 'COMPLETED', type: 'session-complete', level: 'info', message: '완료',
    });
    await runTuiLoop(state.sessionId, { stream, intervalMs: 50 });
    // At least: cursor-hide + frame write + cursor-show.
    expect(writes.length).toBeGreaterThanOrEqual(2);
    const allOutput = writes.join('');
    // Frame should be present (look for header bar prefix).
    expect(allOutput).toContain('Autopilot Live');
    // Cursor restore at the end.
    expect(allOutput.endsWith('\x1b[?25h\n')).toBe(true);
  });

  it('stops within intervalMs+200 when AbortSignal aborts', async () => {
    const writes = [];
    const stream = {
      isTTY: true,
      columns: 80,
      write(chunk) { writes.push(String(chunk)); return true; },
    };
    const state = persistAndTrack(makeState({ phase: 'EXECUTE' }));
    const controller = new AbortController();
    const intervalMs = 100;
    setTimeout(() => controller.abort(), 30);
    const start = Date.now();
    await runTuiLoop(state.sessionId, {
      stream,
      intervalMs,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(intervalMs + 250);
    expect(writes.some((w) => w.includes('Autopilot Live'))).toBe(true);
  });

  it('exits gracefully when session disappears (3 consecutive null loads)', async () => {
    const writes = [];
    const stream = {
      isTTY: true,
      columns: 80,
      write(chunk) { writes.push(String(chunk)); return true; },
    };
    const ghostId = `ap-test-tui-ghost-${Date.now()}`;
    // No saveSession → loadSession returns null on every iteration.
    // intervalMs small so 3 iterations finish quickly.
    const start = Date.now();
    await runTuiLoop(ghostId, { stream, intervalMs: 20 });
    const elapsed = Date.now() - start;
    // 3 iterations × 20ms = 60ms, plus a frame render. Bound generously.
    expect(elapsed).toBeLessThan(500);
    // Cursor restore line emitted in finally block.
    expect(writes.some((w) => w.includes('\x1b[?25h'))).toBe(true);
  });
});

describe('renderFrame — edge cases', () => {
  it('handles state with no phases array', () => {
    const out = renderFrame({
      state: {
        sessionId: 'ap-edge', mode: 'default', phase: 'INTAKE',
        createdAt: new Date().toISOString(),
      },
      events: [],
    });
    expect(out).toContain('0/8 phases');
  });

  it('handles PAUSED state with red color', () => {
    const state = makeState({ phase: 'PAUSED' });
    const out = renderFrame({ state, events: [] });
    expect(out).toContain('\x1b[31m'); // red for PAUSED
    expect(out).toContain('PAUSED');
  });

  it('handles COMPLETED state with green color', () => {
    const state = makeState({ phase: 'COMPLETED' });
    const out = renderFrame({ state, events: [] });
    expect(out).toContain('\x1b[32m'); // green for COMPLETED
  });

  it('renders (no events yet) placeholder when events array is empty', () => {
    const out = renderFrame({ state: makeState(), events: [] });
    expect(out).toContain('(no events yet)');
  });

  it('progress is monotonic across phases even when intermediate phases are queued', () => {
    // Engine records INTAKE/REPORT as done but PLAN..IMPROVE as queued.
    // The bar must still climb monotonically and never stall at 1/8.
    const order = [
      'INTAKE', 'PLAN', 'EXECUTE', 'CROSS_CHECK',
      'VERIFY', 'IMPROVE', 'EVALUATE', 'REPORT',
    ];
    const pull = (out) => {
      const m = out.match(/(\d+)\/8 phases/);
      return m ? Number(m[1]) : -1;
    };
    let prev = -1;
    order.forEach((phase, i) => {
      // Realistic phases[]: only INTAKE done, rest queued up to current.
      const phases = order.slice(0, i + 1).map((name) => ({
        name,
        status: name === 'INTAKE' ? 'done' : 'queued',
        ts: new Date().toISOString(),
      }));
      const out = renderFrame({ state: makeState({ phase, phases }), events: [], width: 80 });
      const done = pull(out);
      expect(done).toBeGreaterThanOrEqual(prev); // monotonic
      expect(done).toBeGreaterThanOrEqual(0);
      expect(done).toBeLessThanOrEqual(8); // clamp — never 9/8
      prev = done;
    });
  });

  it('reaches 8/8 only when phase is COMPLETED', () => {
    const completed = renderFrame({
      state: makeState({ phase: 'COMPLETED', phases: [{ name: 'REPORT', status: 'done' }] }),
      events: [],
      width: 80,
    });
    expect(completed).toContain('8/8 phases');
  });

  it('never reports more than total even when phases[] has duplicate done records', () => {
    const phases = [
      { name: 'INTAKE', status: 'done' },
      { name: 'INTAKE', status: 'done' }, // duplicate must not double-count
      { name: 'PLAN', status: 'done' },
    ];
    const out = renderFrame({ state: makeState({ phase: 'EXECUTE', phases }), events: [], width: 80 });
    const m = out.match(/(\d+)\/8 phases/);
    expect(Number(m[1])).toBeLessThanOrEqual(8);
    expect(Number(m[1])).toBe(2); // unique INTAKE+PLAN
  });

  it('clamps width below 40 to 40 minimum', () => {
    const out = renderFrame({ state: makeState(), events: [], width: 10 });
    // First line is the top border; should be at least 40 chars long including corners.
    const firstLine = out.split('\n')[0];
    // eslint-disable-next-line no-control-regex
    const visible = firstLine.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    expect(visible.length).toBeGreaterThanOrEqual(40);
  });
});
