/**
 * Unit tests for lib/autopilot/engine.js
 * Covers startAutopilot, resumeAutopilot, getStatus, abortAutopilot, PHASES,
 * and the public Phase runner functions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  startAutopilot,
  resumeAutopilot,
  getStatus,
  abortAutopilot,
  PHASES,
  runPhase0Intake,
  runPhase1Plan,
  runPhase6Report,
} from '../../lib/autopilot/index.js';
import { deleteSession } from '../../lib/autopilot/session-store.js';

const cleanupIds = new Set();
function track(id) {
  if (id) cleanupIds.add(id);
  return id;
}

afterEach(() => {
  for (const id of cleanupIds) {
    try { deleteSession(id); } catch { /* ignore */ }
  }
  cleanupIds.clear();
});

describe('PHASES constant', () => {
  it('exposes 7 phases in order INTAKE→REPORT', () => {
    expect(Array.isArray(PHASES)).toBe(true);
    expect(PHASES).toEqual([
      'INTAKE', 'PLAN', 'EXECUTE', 'CROSS_CHECK', 'VERIFY', 'IMPROVE', 'REPORT',
    ]);
  });
});

describe('startAutopilot', () => {
  it('throws TypeError when task is missing', async () => {
    await expect(startAutopilot({})).rejects.toThrow(TypeError);
  });

  it('throws TypeError when task is non-string', async () => {
    await expect(startAutopilot({ task: 42 })).rejects.toThrow(TypeError);
  });

  it('returns object with sessionId, prdPath, phase, instruction (P0-1 fix)', async () => {
    const r = await startAutopilot({ task: 'engine test 표준 진입', mode: 'plan' });
    track(r.sessionId);
    expect(r.sessionId).toMatch(/^ap-\d{8}-\d{6}/);
    expect(typeof r.prdPath).toBe('string');
    expect(r.prdPath.length).toBeGreaterThan(0);
    expect(typeof r.phase).toBe('string');
    expect(r.instruction).toBeTruthy();
    expect(typeof r.instruction).toBe('object');
  });

  it('plan mode stops at INTAKE phase', async () => {
    const r = await startAutopilot({ task: 'plan-mode 정지 검증', mode: 'plan' });
    track(r.sessionId);
    expect(r.phase).toBe('INTAKE');
  });

  it('default mode also initializes at INTAKE (Phase 0 first)', async () => {
    const r = await startAutopilot({ task: 'default 모드 초기화', mode: 'default' });
    track(r.sessionId);
    expect(r.phase).toBe('INTAKE');
    expect(r.instruction.type).toBeTruthy();
  });

  it('persists session retrievable via getStatus', async () => {
    const r = await startAutopilot({ task: '세션 영속화 검증', mode: 'plan' });
    track(r.sessionId);
    const status = await getStatus(r.sessionId);
    expect(status).toBeTruthy();
    expect(status.sessionId).toBe(r.sessionId);
    expect(status.task).toContain('세션 영속화');
    expect(status.mode).toBe('plan');
  });
});

describe('getStatus', () => {
  it('returns null for unknown sessionId', async () => {
    const result = await getStatus('ap-19990101-000000-doesnotexist');
    expect(result).toBeNull();
  });

  it('returns the most recent session when sessionId is omitted', async () => {
    const r = await startAutopilot({ task: 'most-recent 픽업', mode: 'plan' });
    track(r.sessionId);
    const recent = await getStatus();
    expect(recent).toBeTruthy();
    expect(typeof recent.sessionId).toBe('string');
  });
});

describe('abortAutopilot', () => {
  it('marks session ABORTED and emits reportPath when graceful', async () => {
    const r = await startAutopilot({ task: 'abort graceful', mode: 'plan' });
    track(r.sessionId);
    const a = await abortAutopilot(r.sessionId, { graceful: true });
    expect(a.sessionId).toBe(r.sessionId);
    expect(a.status).toBe('ABORTED');
    expect(typeof a.reportPath).toBe('string');
    expect(a.reportPath.length).toBeGreaterThan(0);
  });

  it('throws when sessionId missing', async () => {
    await expect(abortAutopilot()).rejects.toThrow();
  });
});

describe('resumeAutopilot', () => {
  it('throws when sessionId missing', async () => {
    await expect(resumeAutopilot()).rejects.toThrow(TypeError);
  });

  it('throws when session not found', async () => {
    await expect(
      resumeAutopilot('ap-19990101-000000-missing'),
    ).rejects.toThrow(/session not found/);
  });

  it('returns noop for COMPLETED sessions', async () => {
    const r = await startAutopilot({ task: 'completed noop', mode: 'plan' });
    track(r.sessionId);
    await abortAutopilot(r.sessionId, { graceful: true });
    // After abort, session is ABORTED — resume should return noop status.
    const out = await resumeAutopilot(r.sessionId);
    expect(out.status).toBe('noop');
  });
});

describe('Phase runner functions return instruction objects', () => {
  it('runPhase0Intake returns object with type field', async () => {
    const r = await startAutopilot({ task: 'phase0 inst 검증', mode: 'plan' });
    track(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase0Intake(state);
    expect(inst).toBeTruthy();
    expect(typeof inst.type).toBe('string');
  });

  it('runPhase1Plan returns object with type field', async () => {
    const r = await startAutopilot({ task: 'phase1 inst 검증', mode: 'default' });
    track(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase1Plan(state);
    expect(inst).toBeTruthy();
    expect(typeof inst.type).toBe('string');
  });

  it('runPhase6Report returns object with type=phase-result and reportPath', async () => {
    const r = await startAutopilot({ task: 'phase6 report 산출', mode: 'default' });
    track(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase6Report(state);
    expect(inst).toBeTruthy();
    expect(inst.type).toBe('phase-result');
    expect(typeof inst.reportPath).toBe('string');
  });
});
