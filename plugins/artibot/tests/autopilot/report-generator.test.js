/**
 * Integration tests for lib/autopilot/report-generator.js generateReport()
 * Covers style selection: default (dev only), 'all', 'exec', deriveAll=true opt-in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildRecoveryJournalFields,
  generateReport,
  renderReport,
} from '../../lib/autopilot/report-generator.js';
import { deleteSessionArtifacts, saveSession } from '../../lib/autopilot/session-store.js';

let projectRoot = null;

/**
 * Resolve reports/AUTOPILOT under the test-scoped project root (tmpdir).
 * @returns {string}
 */
function reportsDir() {
  return path.join(projectRoot, 'reports', 'AUTOPILOT');
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
    try { deleteSessionArtifacts(trackedSession); } catch { /* ignore */ }
    trackedSession = null;
  }
  if (projectRoot) {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    projectRoot = null;
  }
}

describe('generateReport — style selection', () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-report-gen-'));
    trackedSession = `ap-test-style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    saveSession(dummyState(trackedSession));
  });

  afterEach(cleanup);

  it('default (no opts beyond projectRoot) renders only dev .md (pm/exec/casual are opt-in)', () => {
    const out = generateReport(trackedSession, { projectRoot });
    const dir = reportsDir();
    const expectedDev = path.join(dir, `${trackedSession}.md`);
    expect(out.filePath).toBe(expectedDev);
    expect(existsSync(expectedDev)).toBe(true);
    expect(out.results.dev.filePath).toBe(expectedDev);
    trackReport(expectedDev);
    // deriveAll defaults to false → pm/exec/casual NOT rendered
    for (const s of ['pm', 'exec', 'casual']) {
      const p = path.join(dir, `${trackedSession}.${s}.md`);
      expect(existsSync(p), `${s} should NOT exist by default`).toBe(false);
      expect(out.results[s], `${s} should be undefined`).toBeUndefined();
    }
  });

  it("style 'all' produces 4 files (dev/pm/exec/casual)", () => {
    const out = generateReport(trackedSession, { style: 'all', projectRoot });
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
    const out = generateReport(trackedSession, { style: 'exec', projectRoot });
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

  it('deriveAll:true renders all 4 profiles (opt-in)', () => {
    const out = generateReport(trackedSession, { deriveAll: true, projectRoot });
    const dir = reportsDir();
    const devPath = path.join(dir, `${trackedSession}.md`);
    expect(existsSync(devPath)).toBe(true);
    expect(out.results.dev.filePath).toBe(devPath);
    trackReport(devPath);
    for (const s of ['pm', 'exec', 'casual']) {
      const p = path.join(dir, `${trackedSession}.${s}.md`);
      expect(existsSync(p), `${s} should exist when deriveAll:true`).toBe(true);
      expect(out.results[s].filePath).toBe(p);
      trackReport(p);
    }
  });

  it('deriveAll:false (legacy explicit) still renders only dev (matches new default)', () => {
    const out = generateReport(trackedSession, { deriveAll: false, projectRoot });
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

// ---------------------------------------------------------------------------
// Recovery journal printer (SH-06 follow-up: recovery-record.js writes
// state.recoveryJournal[]; the report generator is what finally prints it).
// ---------------------------------------------------------------------------

/** A normal judgement row, shaped like recovery-record.js#recordRecoveryDecision. */
function journalRow(overrides = {}) {
  return {
    at: '2026-09-17T00:00:00.000Z',
    phase: 'VERIFY',
    status: 'failed',
    verdictRaw: 'FAIL',
    verdict: 'fail',
    verificationStatus: 'FAIL',
    class: 'implementation',
    classReason: 'lint 오류 — 열에 인쇄하지 않는다',
    action: 'repair',
    target: 'EXECUTE',
    reason: 'lint 실패로 EXECUTE 재시도',
    repairAttempts: 1,
    sameClassAttempts: 1,
    retryLimit: 3,
    fixedNext: 'IMPROVE',
    divergent: true,
    recordedBy: 'recovery-record',
    ...overrides,
  };
}

/** Slice the `## Recovery Journal` section out of a rendered dev report. */
function journalSection(text) {
  const start = text.indexOf('## Recovery Journal');
  if (start === -1) return '';
  const rest = text.slice(start);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

/** Count markdown table body rows (`| <n> | ...`) inside a section. */
function bodyRowCount(section) {
  return section.split('\n').filter((l) => /^\|\s\d+\s\|/.test(l)).length;
}

describe('generateReport — recovery journal section (dev profile)', () => {
  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-report-rj-'));
    trackedSession = `ap-test-rj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(cleanup);

  /** Persist the dummy state plus an arbitrary recoveryJournal value. */
  function saveWithJournal(journal) {
    const state = dummyState(trackedSession);
    if (journal !== undefined) state.recoveryJournal = journal;
    saveSession(state);
  }

  it('prints a normal row and a record-failed row with the total count in the heading', () => {
    saveWithJournal([
      journalRow({ reason: '고유이유-정상행' }),
      { at: '2026-09-17T00:01:00.000Z', phase: 'VERIFY', recordFailed: true, error: '기록기 자체가 던짐' },
    ]);
    const out = generateReport(trackedSession, { projectRoot });
    trackReport(out.filePath);
    const onDisk = readFileSync(out.filePath, 'utf-8');
    expect(onDisk).toContain('## Recovery Journal (2)');
    const section = journalSection(onDisk);
    expect(section).toContain('implementation');
    expect(section).toContain('repair → EXECUTE');
    expect(section).toContain('r1/s1/L3');
    expect(section).toContain('고유이유-정상행');
    expect(section).toContain('record-failed');
    expect(section).toContain('기록기 자체가 던짐');
    // classReason / divergent are deliberately not printed.
    expect(section).not.toContain('열에 인쇄하지 않는다');
    expect(onDisk).not.toContain('{{');
  });

  it('renders (0) + N/A when the state has no recoveryJournal key', () => {
    saveWithJournal(undefined);
    const out = generateReport(trackedSession, { projectRoot });
    trackReport(out.filePath);
    const onDisk = readFileSync(out.filePath, 'utf-8');
    expect(onDisk).toContain('## Recovery Journal (0)');
    expect(journalSection(onDisk)).toContain('N/A');
  });

  it('does not throw and renders (0) + N/A when recoveryJournal is not an array', () => {
    saveWithJournal('corrupt');
    let out = null;
    expect(() => { out = generateReport(trackedSession, { projectRoot }); }).not.toThrow();
    trackReport(out.filePath);
    const onDisk = readFileSync(out.filePath, 'utf-8');
    expect(onDisk).toContain('## Recovery Journal (0)');
    expect(journalSection(onDisk)).toContain('N/A');
  });

  it('caps the table at the LAST 20 rows and notes the remainder', () => {
    const rows = Array.from({ length: 25 }, (_, i) => journalRow({ reason: `유니크사유-${i}` }));
    saveWithJournal(rows);
    const out = generateReport(trackedSession, { projectRoot });
    trackReport(out.filePath);
    const onDisk = readFileSync(out.filePath, 'utf-8');
    expect(onDisk).toContain('## Recovery Journal (25)');
    const section = journalSection(onDisk);
    expect(bodyRowCount(section)).toBe(20);
    expect(section).toContain('+5 more');
    // tail slice: rows 5..24 printed, rows 0..4 dropped
    expect(section).toContain('유니크사유-5');
    expect(section).toContain('유니크사유-24');
    expect(section).not.toContain('유니크사유-0');
    expect(section).not.toContain('유니크사유-4 ');
  });

  it("style 'all' renders 4 profiles without error and only dev carries the journal", () => {
    saveWithJournal([journalRow()]);
    const out = generateReport(trackedSession, { style: 'all', projectRoot });
    for (const s of ['dev', 'pm', 'exec', 'casual']) {
      expect(out.results[s].error, `${s} must render without error`).toBeUndefined();
      trackReport(out.results[s].filePath);
    }
    expect(readFileSync(out.results.dev.filePath, 'utf-8')).toContain('## Recovery Journal (1)');
    for (const s of ['pm', 'exec', 'casual']) {
      expect(readFileSync(out.results[s].filePath, 'utf-8'), s).not.toContain('Recovery Journal');
    }
  });

  // MEASUREMENT (2026-09-17): 20-row journal + dummyState → dev render is 92
  // lines, well under the dev maxLines=400 cap, so capLines does not eat the
  // trailing Next Action section.
  it('keeps a 20-row journal render under the dev 400-line cap (measured 92 lines)', () => {
    saveWithJournal(Array.from({ length: 20 }, (_, i) => journalRow({ reason: `측정-${i}` })));
    const out = generateReport(trackedSession, { projectRoot });
    trackReport(out.filePath);
    const onDisk = readFileSync(out.filePath, 'utf-8');
    const lineCount = onDisk.split('\n').length;
    expect(bodyRowCount(journalSection(onDisk))).toBe(20);
    expect(lineCount).toBeLessThan(400);
    expect(onDisk.trimEnd().endsWith('추가 작업 없음.')).toBe(true);
  });
});

describe('renderReport (legacy) — conditional 6b section', () => {
  it('emits ## 6b. 복구 판정 저널 when the journal has rows', () => {
    const md = renderReport({ phase: 'COMPLETED', recoveryJournal: [journalRow()] });
    expect(md).toContain('## 6b. 복구 판정 저널');
    expect(md).toContain('repair → EXECUTE');
    expect(md.indexOf('## 6b.')).toBeGreaterThan(md.indexOf('## 6. 검증 결과'));
    expect(md.indexOf('## 6b.')).toBeLessThan(md.indexOf('## 7. 개선 제안'));
  });

  it('omits the 6b heading when the journal is empty, missing or corrupt', () => {
    for (const journal of [[], undefined, 'corrupt', { a: 1 }]) {
      const md = renderReport({ phase: 'COMPLETED', recoveryJournal: journal });
      expect(md).not.toContain('6b. 복구 판정 저널');
    }
  });
});

describe('buildRecoveryJournalFields (pure)', () => {
  it('returns count 0 and N/A for non-array / empty input without throwing', () => {
    for (const bad of [undefined, null, 'corrupt', { a: 1 }, 42, []]) {
      const f = buildRecoveryJournalFields(bad);
      expect(f.recoveryJournalCount).toBe(0);
      expect(f.recoveryJournalTable).toBe('N/A');
    }
  });

  it('truncates reason to 120 chars with an ellipsis marker', () => {
    const long = 'x'.repeat(200);
    const { recoveryJournalTable } = buildRecoveryJournalFields([journalRow({ reason: long })]);
    expect(recoveryJournalTable).toContain(`${'x'.repeat(120)}…`);
    expect(recoveryJournalTable).not.toContain('x'.repeat(121));
  });

  it('renders - for every missing field and never throws on null / array rows', () => {
    const { recoveryJournalTable, recoveryJournalCount } = buildRecoveryJournalFields([{}, null, 'oops', [1, 2, 3]]);
    expect(recoveryJournalCount).toBe(4);
    const lines = recoveryJournalTable.split('\n').filter((l) => /^\|\s\d+\s\|/.test(l));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toMatch(/^\|\s\d+\s\|(\s-\s\|){10}$/);
    }
    expect(recoveryJournalTable).not.toContain('native code');
  });

  it('escapes pipes and folds newlines inside cells so the table stays intact', () => {
    const { recoveryJournalTable } = buildRecoveryJournalFields([journalRow({ reason: 'a|b\nc' })]);
    expect(recoveryJournalTable).toContain('a\\|b c');
    const lines = recoveryJournalTable.split('\n').filter((l) => /^\|\s\d+\s\|/.test(l));
    expect(lines).toHaveLength(1);
  });

  it('prints verdict(verdictRaw) only when the raw token differs', () => {
    const same = buildRecoveryJournalFields([journalRow({ verdict: 'fail', verdictRaw: 'fail' })]);
    expect(same.recoveryJournalTable).not.toContain('fail(fail)');
    const diff = buildRecoveryJournalFields([journalRow({ verdict: 'fail', verdictRaw: 'FAIL' })]);
    expect(diff.recoveryJournalTable).toContain('fail(FAIL)');
  });
});
