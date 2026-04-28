/**
 * Integration tests for lib/autopilot/report-generator.js generateReport()
 * Covers style selection: default (dev + deriveAll), 'all', 'exec', deriveAll=false.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { generateReport } from '../../lib/autopilot/report-generator.js';
import { saveSession, deleteSession } from '../../lib/autopilot/session-store.js';
import { getPluginRoot } from '../../lib/core/platform.js';

/**
 * Resolve reports/AUTOPILOT under the project root (one level above plugin).
 * @returns {string}
 */
function reportsDir() {
  return path.resolve(getPluginRoot(), '..', '..', 'reports', 'AUTOPILOT');
}

/** Build a minimally complete dummy session state for rendering. */
function dummyState(sessionId) {
  return {
    sessionId,
    mode: 'default',
    createdAt: '2026-04-27T10:00:00.000Z',
    completedAt: '2026-04-27T11:00:00.000Z',
    phase: 'COMPLETED',
    task: '리포트 스타일 통합 테스트 더미 세션',
    summary: '한글 요약 테스트',
    phases: [{ name: 'PLAN', status: 'pass', durationMs: 1000, changedFiles: 1, checks: 'ok' }],
    verifyResult: { lint: 'pass', typecheck: 'pass', test: 'pass', build: 'pass' },
    crossCheck: { verdict: 'approve', notes: 'ok' },
    improvements: ['개선 1'],
    futurePlans: ['미래 1'],
    risks: [{ severity: 'low', message: '경미한 리스크' }],
    nextAction: '추가 작업 없음.',
  };
}

const trackedFiles = new Set();
let trackedSession = null;

function trackReport(filePath) {
  if (filePath) trackedFiles.add(filePath);
}

function cleanup() {
  for (const f of trackedFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }
  trackedFiles.clear();
  if (trackedSession) {
    try { deleteSession(trackedSession); } catch { /* ignore */ }
    trackedSession = null;
  }
}

describe('generateReport — style selection', () => {
  beforeEach(() => {
    trackedSession = `ap-test-style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    saveSession(dummyState(trackedSession));
  });

  afterEach(cleanup);

  it('default (no opts) renders dev .md + derives all 4 styles', () => {
    const out = generateReport(trackedSession);
    const dir = reportsDir();
    const expectedDev = path.join(dir, `${trackedSession}.md`);
    expect(out.filePath).toBe(expectedDev);
    expect(existsSync(expectedDev)).toBe(true);
    expect(out.results.dev.filePath).toBe(expectedDev);
    trackReport(expectedDev);
    // deriveAll defaults to true → pm/exec/casual also rendered
    for (const s of ['pm', 'exec', 'casual']) {
      const p = path.join(dir, `${trackedSession}.${s}.md`);
      expect(existsSync(p), `${s} should exist`).toBe(true);
      trackReport(p);
    }
  });

  it("style 'all' produces 4 files (dev/pm/exec/casual)", () => {
    const out = generateReport(trackedSession, { style: 'all' });
    const dir = reportsDir();
    expect(existsSync(path.join(dir, `${trackedSession}.md`))).toBe(true);
    trackReport(path.join(dir, `${trackedSession}.md`));
    for (const s of ['pm', 'exec', 'casual']) {
      const p = path.join(dir, `${trackedSession}.${s}.md`);
      expect(existsSync(p), `${s} present`).toBe(true);
      expect(out.results[s].filePath).toBe(p);
      trackReport(p);
    }
    expect(out.results.dev.filePath).toBe(path.join(dir, `${trackedSession}.md`));
  });

  it("style 'exec' generates only exec.md (no dev/pm/casual)", () => {
    const out = generateReport(trackedSession, { style: 'exec' });
    const dir = reportsDir();
    const execPath = path.join(dir, `${trackedSession}.exec.md`);
    expect(existsSync(execPath)).toBe(true);
    expect(out.results.exec.filePath).toBe(execPath);
    trackReport(execPath);
    // others should NOT have been written by this call
    expect(out.results.dev).toBeUndefined();
    expect(out.results.pm).toBeUndefined();
    expect(out.results.casual).toBeUndefined();
  });

  it('deriveAll:false renders only the dev style', () => {
    const out = generateReport(trackedSession, { deriveAll: false });
    const dir = reportsDir();
    const devPath = path.join(dir, `${trackedSession}.md`);
    expect(existsSync(devPath)).toBe(true);
    expect(out.results.dev.filePath).toBe(devPath);
    expect(out.results.pm).toBeUndefined();
    expect(out.results.exec).toBeUndefined();
    expect(out.results.casual).toBeUndefined();
    trackReport(devPath);
  });
});
