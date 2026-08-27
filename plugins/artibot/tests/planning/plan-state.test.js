/**
 * Direct-import tests for the plan-state synchronisation module.
 *
 * The deep behavioral suite (fail-closed matrix, completion stickiness, rename
 * semantics) lives in `tests/planning/artifacts.test.js` and exercises this
 * module through the `artifacts.js` wrapper — the public path every consumer
 * uses. This file pins what that suite cannot: `lib/planning/plan-state.js`
 * works when imported directly, and the wrapper is a pure delegate (same
 * result, same on-disk state) rather than a second implementation.
 *
 * @module tests/planning/plan-state
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { syncTodo } from '../../lib/planning/plan-state.js';
import { syncTodo as syncTodoViaArtifacts } from '../../lib/planning/artifacts.js';

const FIXED = new Date(2026, 5, 9, 14, 30); // 2026-06-09 14:30 local
const fixedNow = () => FIXED;

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'plan-state-'));
}

const PLAN = [
  '# Plan',
  '- [x] done one',
  '- [ ] todo two',
  '- [ ] todo three',
].join('\n');

describe('plan-state / syncTodo (direct import)', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('parses checkboxes into accurate progress and writes .plan-state.json', async () => {
    const res = await syncTodo({
      projectRoot: root, planMarkdown: PLAN, planFile: 'PLAN.md', sessionId: 's1', now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ total: 3, completed: 1, percentage: 33 });
    expect(res.stateFile).toBe(path.join(root, '.plan-state.json'));
    expect(existsSync(res.stateFile)).toBe(true);

    const state = JSON.parse(readFileSync(res.stateFile, 'utf-8'));
    expect(state.tasks).toHaveLength(3);
    expect(state.sessions.map((s) => s.id)).toContain('s1');
  });

  it('returns {ok:false} when projectRoot missing', async () => {
    const res = await syncTodo({ planMarkdown: PLAN });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/projectRoot/);
  });

  it('rejects a non-string planMarkdown before touching disk (fail-closed)', async () => {
    const res = await syncTodo({ projectRoot: root, planMarkdown: null, now: fixedNow });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/planMarkdown/);
    expect(existsSync(path.join(root, '.plan-state.json'))).toBe(false);
  });

  it('rejects a non-blank plan that parses to zero tasks (CRLF-shaped failure)', async () => {
    const res = await syncTodo({
      projectRoot: root, planMarkdown: '# prose only, no checkboxes', now: fixedNow,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/0 tasks/);
    expect(existsSync(path.join(root, '.plan-state.json'))).toBe(false);
  });

  it('rejects a blank plan that would drop tracked tasks', async () => {
    const seeded = await syncTodo({ projectRoot: root, planMarkdown: PLAN, now: fixedNow });
    expect(seeded.ok).toBe(true);
    const before = readFileSync(seeded.stateFile, 'utf-8');

    const res = await syncTodo({ projectRoot: root, planMarkdown: '', now: fixedNow });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/drop 3 tracked tasks/);
    expect(readFileSync(seeded.stateFile, 'utf-8')).toBe(before);
  });

  it('refuses to overwrite an unreadable (corrupt JSON) state file', async () => {
    const stateFile = path.join(root, '.plan-state.json');
    writeFileSync(stateFile, '{ not json', 'utf-8');

    const res = await syncTodo({ projectRoot: root, planMarkdown: PLAN, now: fixedNow });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refusing to overwrite state/);
    expect(readFileSync(stateFile, 'utf-8')).toBe('{ not json');
  });

  it('carries completion flags across re-syncs by normalized task text', async () => {
    const allDone = PLAN.replaceAll('- [ ]', '- [x]');
    await syncTodo({ projectRoot: root, planMarkdown: allDone, now: fixedNow });

    const res = await syncTodo({
      projectRoot: root,
      planMarkdown: PLAN.replaceAll('- [x]', '- [ ]'),
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ total: 3, completed: 3, percentage: 100 });
  });
});

describe('plan-state / artifacts.js wrapper parity', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** Parse a state file with wall-clock fields removed — `PlanTracker` stamps
   *  `lastUpdated` / `sessions[].startedAt` from the real clock (not the
   *  injectable `now`), so byte comparison across two writes would flake. */
  function stateSansClock(file) {
    const { lastUpdated: _lu, sessions, ...rest } = JSON.parse(readFileSync(file, 'utf-8'));
    return { ...rest, sessions: sessions.map(({ startedAt: _sa, ...s }) => s) };
  }

  it('wrapper produces the same result and on-disk state as the direct import', async () => {
    const direct = await syncTodo({
      projectRoot: root, planMarkdown: PLAN, sessionId: 's1', now: fixedNow,
    });
    const directState = stateSansClock(direct.stateFile);
    rmSync(direct.stateFile);

    const wrapped = await syncTodoViaArtifacts({
      projectRoot: root, planMarkdown: PLAN, sessionId: 's1', now: fixedNow,
    });
    expect(wrapped).toEqual(direct);
    expect(stateSansClock(wrapped.stateFile)).toEqual(directState);
  });

  it('wrapper propagates fail-closed rejections unchanged', async () => {
    const direct = await syncTodo({ projectRoot: root, planMarkdown: null, now: fixedNow });
    const wrapped = await syncTodoViaArtifacts({ projectRoot: root, planMarkdown: null, now: fixedNow });
    expect(wrapped).toEqual(direct);
    expect(wrapped.ok).toBe(false);
  });
});
