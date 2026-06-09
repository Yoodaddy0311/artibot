/**
 * Tests for the planning artifacts layer (PRD / ADR / TODO state).
 * @module tests/planning/artifacts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureADR, syncTodo, writePRD } from '../../lib/planning/artifacts.js';

const FIXED = new Date(2026, 5, 9, 14, 30); // 2026-06-09 14:30 local
const fixedNow = () => FIXED;

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
}

// ---------------------------------------------------------------------------
// writePRD
// ---------------------------------------------------------------------------

describe('artifacts / writePRD', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates docs/PRD/<slug>-<YYYYMMDD>.md', async () => {
    const res = await writePRD({
      projectRoot: root,
      slug: 'login-flow',
      title: '로그인 플로우',
      sections: { 배경: 'b', 목표: 'g' },
      linkedAdrs: ['ADR-001'],
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(res.prdPath).toBe(path.join(root, 'docs', 'PRD', 'login-flow-20260609.md'));
    expect(existsSync(res.prdPath)).toBe(true);

    const body = readFileSync(res.prdPath, 'utf-8');
    expect(body).toContain('# PRD: 로그인 플로우');
    expect(body).toContain('`ADR-001`');
    expect(body).toContain('## 배경');
    expect(body).toContain('## 수락기준'); // empty section still rendered
  });

  it('is non-destructive: re-call adds -NN suffix', async () => {
    const a = await writePRD({ projectRoot: root, slug: 'x', title: 'X', sections: {}, now: fixedNow });
    const b = await writePRD({ projectRoot: root, slug: 'x', title: 'X', sections: {}, now: fixedNow });
    expect(a.prdPath).not.toBe(b.prdPath);
    expect(b.prdPath).toBe(path.join(root, 'docs', 'PRD', 'x-20260609-2.md'));
    expect(existsSync(a.prdPath)).toBe(true);
    expect(existsSync(b.prdPath)).toBe(true);
  });

  it('returns {ok:false} when projectRoot missing', async () => {
    const res = await writePRD({ slug: 'x', title: 'X', sections: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/projectRoot/);
  });
});

// ---------------------------------------------------------------------------
// ensureADR
// ---------------------------------------------------------------------------

describe('artifacts / ensureADR', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates ADR-001 when docs/adr is empty', async () => {
    const res = await ensureADR({
      projectRoot: root,
      title: 'Primary Database',
      options: ['PostgreSQL', 'MongoDB'],
      decision: 'PostgreSQL',
      rationale: '관계형 무결성',
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(res.number).toBe(1);
    expect(res.adrPath).toBe(path.join(root, 'docs', 'adr', 'ADR-001-primary-database.md'));

    const body = readFileSync(res.adrPath, 'utf-8');
    expect(body).toContain('# ADR-001: Primary Database');
    expect(body).toContain('PostgreSQL');
    expect(body).toContain('MongoDB');
    expect(body).toContain('## 7. 2년 뒤 기술 부채');
  });

  it('auto-increments to 002 when ADR-001 exists', async () => {
    await ensureADR({
      projectRoot: root, title: 'First', options: ['A', 'B'], decision: 'A', now: fixedNow,
    });
    const res = await ensureADR({
      projectRoot: root, title: 'Second Decision', options: ['C', 'D'], decision: 'C', now: fixedNow,
    });
    expect(res.number).toBe(2);
    expect(res.adrPath).toBe(path.join(root, 'docs', 'adr', 'ADR-002-second-decision.md'));
  });

  it('rejects fewer than 2 options', async () => {
    const res = await ensureADR({
      projectRoot: root, title: 'X', options: ['only-one'], decision: 'only-one', now: fixedNow,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/2/);
  });
});

// ---------------------------------------------------------------------------
// syncTodo
// ---------------------------------------------------------------------------

describe('artifacts / syncTodo', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const PLAN = [
    '# Plan',
    '- [x] done one',
    '- [ ] todo two',
    '- [ ] todo three',
  ].join('\n');

  it('parses checkboxes into accurate progress and writes .plan-state.json', async () => {
    const res = await syncTodo({
      projectRoot: root,
      planMarkdown: PLAN,
      planFile: 'PLAN.md',
      sessionId: 's1',
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ total: 3, completed: 1, percentage: 33 });
    expect(res.stateFile).toBe(path.join(root, '.plan-state.json'));
    expect(existsSync(res.stateFile)).toBe(true);

    const state = JSON.parse(readFileSync(res.stateFile, 'utf-8'));
    expect(state.tasks).toHaveLength(3);
    expect(state.sessions.map((s) => s.id)).toContain('s1');
  });

  it('merges sessions across re-calls', async () => {
    await syncTodo({ projectRoot: root, planMarkdown: PLAN, sessionId: 's1', now: fixedNow });
    const res = await syncTodo({ projectRoot: root, planMarkdown: PLAN, sessionId: 's2', now: fixedNow });
    expect(res.ok).toBe(true);

    const state = JSON.parse(readFileSync(res.stateFile, 'utf-8'));
    const ids = state.sessions.map((s) => s.id);
    expect(ids).toContain('s1');
    expect(ids).toContain('s2');
  });

  it('returns {ok:false} when projectRoot missing', async () => {
    const res = await syncTodo({ planMarkdown: PLAN });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/projectRoot/);
  });
});
