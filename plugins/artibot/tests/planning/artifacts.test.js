/**
 * Tests for the planning artifacts layer (PRD / ADR / TODO state).
 * @module tests/planning/artifacts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archiveStale,
  ensureADR,
  indexArtifacts,
  listArtifacts,
  supersede,
  syncTodo,
  writePRD,
} from '../../lib/planning/artifacts.js';

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

  // linkedAdrs 정규화 — 호출자가 `.md` 프롬프트(모델 생성 JS)라 타입 검사가 닿지 않는다.
  // `ensureADR()` 반환값을 그대로 넘기는 것이 자연스러운 사용 흐름이므로 객체도 받는다.
  // 실제 사고: commands/ultraplan.md 가 `[{ number, adrPath }]` 를 넘겨 헤더에
  // `[object Object]` 가 박힐 뻔했다. 문자열만 테스트하던 자리가 정확히 이 사각지대였다.
  it('linkedAdrs: ensureADR 반환 객체를 canonical ADR-NNN 으로 정규화한다', async () => {
    const res = await writePRD({
      projectRoot: root,
      slug: 'obj-link',
      title: 'Obj',
      sections: {},
      linkedAdrs: [{ number: 7, adrPath: '/repo/docs/adr/ADR-007-caching.md' }],
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    const body = readFileSync(res.prdPath, 'utf-8');
    expect(body).not.toContain('[object Object]');
    expect(body).toContain('linked_adrs: ADR-007');
    expect(body).toContain('`ADR-007`');
  });

  it('linkedAdrs: number 가 없으면 adrPath 파일명으로 폴백한다', async () => {
    const res = await writePRD({
      projectRoot: root,
      slug: 'path-link',
      title: 'Path',
      sections: {},
      linkedAdrs: [{ adrPath: '/repo/docs/adr/ADR-012-retry-policy.md' }],
      now: fixedNow,
    });
    const body = readFileSync(res.prdPath, 'utf-8');
    expect(body).not.toContain('[object Object]');
    expect(body).toContain('`ADR-012-retry-policy`');
  });

  it('linkedAdrs: 문자열은 그대로 보존하고 섞인 배열도 처리한다', async () => {
    const res = await writePRD({
      projectRoot: root,
      slug: 'mixed-link',
      title: 'Mixed',
      sections: {},
      linkedAdrs: ['ADR-001', { number: 2, adrPath: '/x/ADR-002-b.md' }, '  ', null],
      now: fixedNow,
    });
    const body = readFileSync(res.prdPath, 'utf-8');
    expect(body).toContain('linked_adrs: ADR-001, ADR-002');
    expect(body).not.toContain('[object Object]');
  });

  it('linkedAdrs: 알 수 없는 형태는 조용히 렌더하지 않고 droppedAdrLinks 로 신고한다', async () => {
    const res = await writePRD({
      projectRoot: root,
      slug: 'bad-link',
      title: 'Bad',
      sections: {},
      linkedAdrs: [{ foo: 'bar' }, 42, 'ADR-009'],
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(res.droppedAdrLinks).toBe(2);
    const body = readFileSync(res.prdPath, 'utf-8');
    expect(body).not.toContain('[object Object]');
    expect(body).toContain('linked_adrs: ADR-009');
  });

  // 경계 — `Number.isFinite` 만으로는 음수·소수가 통과해 `ADR-0-1` / `ADR-1.5` 같은
  // 깨진 라벨이 렌더된다. JSDoc 이 "해석 불가는 렌더하지 않고 신고한다"고 약속하므로
  // 이 자리는 계약 위반이다. ADR 번호는 정의상 0 이상의 정수다(`ensureADR` 이 그렇게 만든다).
  it.each([
    ['음수', -1],
    ['소수', 1.5],
    ['NaN 아닌 무한대', Number.MAX_VALUE + Number.MAX_VALUE],
  ])('linkedAdrs: number 가 %s 면 깨진 라벨을 렌더하지 않고 신고한다', async (_label, bad) => {
    const res = await writePRD({
      projectRoot: root, slug: `bad-num-${String(bad)}`, title: 'BadNum', sections: {},
      linkedAdrs: [{ number: bad }], now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(res.droppedAdrLinks).toBe(1);
    const body = readFileSync(res.prdPath, 'utf-8');
    expect(body).not.toContain('linked_adrs:');
    expect(body).not.toContain('ADR-0-1');
    expect(body).not.toContain('ADR-1.5');
  });

  it('linkedAdrs: number 0 은 유효한 ADR-000 이다 (falsy 경계)', async () => {
    const res = await writePRD({
      projectRoot: root, slug: 'zero-num', title: 'Zero', sections: {},
      linkedAdrs: [{ number: 0 }], now: fixedNow,
    });
    expect(res.droppedAdrLinks).toBeUndefined();
    expect(readFileSync(res.prdPath, 'utf-8')).toContain('linked_adrs: ADR-000');
  });

  it('linkedAdrs: 배열이 아닌 단일 값도 받아 링크 1건으로 처리한다', async () => {
    const res = await writePRD({
      projectRoot: root, slug: 'not-array', title: 'NotArray', sections: {},
      linkedAdrs: 'ADR-001', now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(res.droppedAdrLinks).toBeUndefined();
    expect(readFileSync(res.prdPath, 'utf-8')).toContain('linked_adrs: ADR-001');
  });

  it('linkedAdrs: 배열 아닌 해석 불가 값은 조용히 삼키지 않고 신고한다', async () => {
    const res = await writePRD({
      projectRoot: root, slug: 'not-array-bad', title: 'NotArrayBad', sections: {},
      linkedAdrs: 42, now: fixedNow,
    });
    expect(res.droppedAdrLinks).toBe(1);
    expect(readFileSync(res.prdPath, 'utf-8')).not.toContain('linked_adrs:');
  });

  it('linkedAdrs: 전부 정상이면 droppedAdrLinks 를 붙이지 않는다', async () => {
    const res = await writePRD({
      projectRoot: root, slug: 'clean-link', title: 'Clean', sections: {},
      linkedAdrs: ['ADR-001'], now: fixedNow,
    });
    expect(res.droppedAdrLinks).toBeUndefined();
  });

  it('writes status:active + created frontmatter', async () => {
    const res = await writePRD({
      projectRoot: root, slug: 'fm', title: 'FM', sections: {}, now: fixedNow,
    });
    const body = readFileSync(res.prdPath, 'utf-8');
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain('status: active');
    expect(body).toContain('created: 2026-06-09');
    expect(body).toContain('slug: fm');
  });

  it('dedup guard: same active slug returns deduped:true, no new file', async () => {
    const a = await writePRD({ projectRoot: root, slug: 'dup', title: 'Dup', sections: {}, now: fixedNow });
    const b = await writePRD({ projectRoot: root, slug: 'dup', title: 'Dup', sections: {}, now: fixedNow });
    expect(a.deduped).toBeUndefined();
    expect(b.ok).toBe(true);
    expect(b.deduped).toBe(true);
    expect(b.prdPath).toBe(a.prdPath);
    const files = readdirSync(path.join(root, 'docs', 'PRD')).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
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
// W1-3 (U2a) — unregistered PRD sections.
//
// renderPrdSections walked PRD_SECTION_ORDER only, so any key outside the
// canonical nine was silently discarded — including `기능요구사항`, which
// `commands/go.md` passes on every /go run.
// ---------------------------------------------------------------------------

describe('artifacts / writePRD — unregistered sections', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const REGISTERED = [
    '배경', '목표', '비목표', '시나리오', '설계',
    '산출물', '실행계획', '위험', '수락기준',
  ];

  async function write(sections, slug = 'extra') {
    const res = await writePRD({
      projectRoot: root, slug, title: 'T', sections, now: fixedNow,
    });
    expect(res.ok).toBe(true);
    return readFileSync(res.prdPath, 'utf-8');
  }

  it('round-trips unregistered keys instead of dropping them', async () => {
    const body = await write({ 배경: 'b', 근거: '왜 이 결정인가', 기능요구사항: 'F-1 로그인' });
    expect(body).toContain('## 근거\n\n왜 이 결정인가\n');
    expect(body).toContain('## 기능요구사항\n\nF-1 로그인\n');
  });

  it('preserves the 기능요구사항 key that /go passes', async () => {
    const goSections = {
      배경: 'ctx', 목표: 'g', 비목표: 'ng',
      기능요구사항: 'P0 기능마다 F-ID sub-section',
      시나리오: 's', 설계: 'd', 산출물: 'o', 실행계획: 'p', 위험: 'r', 수락기준: 'a',
    };
    const body = await write(goSections, 'go-prd');
    expect(body).toContain('P0 기능마다 F-ID sub-section');
  });

  it('appends extras after all nine registered sections, in sorted order', async () => {
    const body = await write({ 배경: 'b', 힣: 'z', 근거: 'r', abc: 'a' });
    const order = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(order.slice(0, 9)).toEqual(REGISTERED);
    // Exact, not "is sorted" — comparing a list to its own sort is a tautology.
    expect(order.slice(9)).toEqual(['abc', '근거', '힣']);
  });

  it('still renders empty sections — registered and appended alike', async () => {
    const body = await write({ 근거: '' });
    expect(body).toContain('## 수락기준'); // existing contract, unchanged
    expect(body).toContain('## 근거');
  });

  it('is byte-identical to the previous output when no extra key is present', async () => {
    // Negative control for the "registered render is unchanged" requirement.
    const sections = Object.fromEntries(REGISTERED.map((k) => [k, `v-${k}`]));
    const body = await write(sections, 'no-extra');
    const expected = REGISTERED
      .map((name) => `## ${name}\n\nv-${name}\n`)
      .join('\n');
    expect(body.endsWith(expected)).toBe(true);
  });

  it('skips blank keys rather than emitting a bare "## " heading', async () => {
    const body = await write({ 배경: 'b', '': 'x', '   ': 'y' });
    expect(body).not.toMatch(/^##\s*$/m);
    expect(body).not.toContain('## \n');
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

  // -------------------------------------------------------------------------
  // W1-1 — destructive-write repair.
  //
  // The prior fixture must carry REAL completions (3 of them). With an empty
  // or absent prior state the bug is unobservable: overwriting nothing with
  // nothing looks identical to correct behavior.
  // -------------------------------------------------------------------------

  /** Plan whose three tasks are all unchecked in markdown. */
  const PLAN_OPEN = [
    '# Plan',
    '- [ ] alpha task',
    '- [ ] beta task',
    '- [ ] gamma task',
  ].join('\n');

  /** Same three tasks, all checked — used to seed a prior state with 3 done. */
  const PLAN_ALL_DONE = [
    '# Plan',
    '- [x] alpha task',
    '- [x] beta task',
    '- [x] gamma task',
  ].join('\n');

  /** Seed `.plan-state.json` with 3 completed tasks and return its path. */
  async function seedThreeDone() {
    const res = await syncTodo({
      projectRoot: root, planMarkdown: PLAN_ALL_DONE, sessionId: 'seed', now: fixedNow,
    });
    expect(res.progress).toEqual({ total: 3, completed: 3, percentage: 100 });
    return res.stateFile;
  }

  it('rejects a non-string planMarkdown and leaves the state file untouched', async () => {
    const stateFile = await seedThreeDone();
    const before = readFileSync(stateFile, 'utf-8');

    for (const bad of [undefined, null, 42, {}, ['- [x] a'], true]) {
      const res = await syncTodo({ projectRoot: root, planMarkdown: bad, now: fixedNow });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/planMarkdown/);
      expect(res.progress).toBeUndefined();
      // Byte-identical: the destroyed-state bug reported ok:true here.
      expect(readFileSync(stateFile, 'utf-8')).toBe(before);
    }

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(state.tasks.filter((t) => t.completed)).toHaveLength(3);
  });

  it('does not create a state file at all when planMarkdown is not a string', async () => {
    const res = await syncTodo({ projectRoot: root, planMarkdown: null, now: fixedNow });
    expect(res.ok).toBe(false);
    expect(existsSync(path.join(root, '.plan-state.json'))).toBe(false);
  });

  it('keeps completion across re-syncs of a valid plan (flags are not reset)', async () => {
    const stateFile = await seedThreeDone();

    // Re-sync twice with markdown whose checkboxes are all OPEN. parsePlan
    // replaces the task list wholesale, so without the merge the completion
    // count would drop to 0 on the first call.
    const first = await syncTodo({
      projectRoot: root, planMarkdown: PLAN_OPEN, sessionId: 's2', now: fixedNow,
    });
    const second = await syncTodo({
      projectRoot: root, planMarkdown: PLAN_OPEN, sessionId: 's3', now: fixedNow,
    });

    expect(first.progress).toEqual({ total: 3, completed: 3, percentage: 100 });
    expect(second.progress).toEqual({ total: 3, completed: 3, percentage: 100 });

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(state.tasks.filter((t) => t.completed)).toHaveLength(3);
    expect(state.sessions.map((s) => s.id)).toEqual(['seed', 's2', 's3']);
  });

  it('merges completion by normalized text, tolerating whitespace drift', async () => {
    await seedThreeDone();
    const rewrapped = [
      '# Plan',
      '- [ ]   alpha    task  ', // re-wrapped spacing, same task
      '- [ ] beta task',
      '- [ ] delta task', // genuinely new — must stay open
    ].join('\n');

    const res = await syncTodo({ projectRoot: root, planMarkdown: rewrapped, now: fixedNow });
    expect(res.ok).toBe(true);
    const state = JSON.parse(readFileSync(res.stateFile, 'utf-8'));
    // Markdown is the source of truth for WHICH tasks exist: gamma is gone,
    // delta is new and open; alpha/beta keep their completion.
    expect(state.tasks.map((t) => [t.text, t.completed])).toEqual([
      ['alpha    task', true],
      ['beta task', true],
      ['delta task', false],
    ]);
    expect(res.progress).toEqual({ total: 3, completed: 2, percentage: 67 });
  });

  it('drops completion when a task is renamed (text is the only join key)', async () => {
    // stable ID 가 없으므로 rename = 제거 + 추가다. 이 손실은 의도된 동작이며,
    // 퍼지 매칭을 도입하려면 이 단언을 의식적으로 깨야 한다. 공백 차이만은
    // taskKey 가 흡수한다 (바로 위 whitespace-drift 테스트가 그 경계다).
    await seedThreeDone();
    const renamed = [
      '# Plan',
      '- [ ] alpha task RENAMED',
      '- [ ] beta task',
      '- [ ] gamma task',
    ].join('\n');

    const res = await syncTodo({ projectRoot: root, planMarkdown: renamed, now: fixedNow });
    expect(res.ok).toBe(true);
    const { tasks } = JSON.parse(readFileSync(res.stateFile, 'utf-8'));
    expect(tasks.find((t) => t.text === 'alpha task RENAMED').completed).toBe(false);
    expect(tasks.find((t) => t.text === 'beta task').completed).toBe(true);
    expect(tasks.find((t) => t.text === 'gamma task').completed).toBe(true);
    // 이름이 바뀐 태스크는 사라진 것으로 취급된다 — 옛 텍스트는 state 에 남지 않는다.
    expect(tasks.some((t) => t.text === 'alpha task')).toBe(false);
    expect(res.progress).toEqual({ total: 3, completed: 2, percentage: 67 });
  });

  it('never un-completes: markdown [x] wins even when prior state says open', async () => {
    await syncTodo({ projectRoot: root, planMarkdown: PLAN_OPEN, now: fixedNow });
    const res = await syncTodo({ projectRoot: root, planMarkdown: PLAN_ALL_DONE, now: fixedNow });
    expect(res.progress).toEqual({ total: 3, completed: 3, percentage: 100 });
  });
});

// ---------------------------------------------------------------------------
// Document lifecycle: list / index / archive / supersede
// ---------------------------------------------------------------------------

/** Write a PRD fixture with optional frontmatter + age (mtime back-dated). */
function seedPrd(root, name, { status, created, body = 'x', ageDays } = {}) {
  const dir = path.join(root, 'docs', 'PRD');
  mkdirSync(dir, { recursive: true });
  const fm = status
    ? `---\nstatus: ${status}\n${created ? `created: ${created}\n` : ''}---\n\n`
    : '';
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, `${fm}# ${name}\n\n${body}\n`, 'utf-8');
  if (typeof ageDays === 'number') {
    const t = new Date(FIXED.getTime() - ageDays * 86400000);
    utimesSync(file, t, t);
  }
  return file;
}

describe('artifacts / listArtifacts', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('classifies active / done / legacy and computes ageDays', async () => {
    seedPrd(root, 'a-active', { status: 'active', created: '2026-06-08' });
    seedPrd(root, 'b-done', { status: 'done', created: '2026-01-01' });
    seedPrd(root, 'c-legacy', { ageDays: 5 }); // no frontmatter → legacy

    const res = await listArtifacts({ projectRoot: root, filter: 'all', now: fixedNow });
    expect(res.ok).toBe(true);
    const bySlug = Object.fromEntries(res.items.map((i) => [i.slug, i]));
    expect(bySlug['a-active'].status).toBe('active');
    expect(bySlug['b-done'].status).toBe('done');
    expect(bySlug['c-legacy'].status).toBe('legacy');
    expect(bySlug['a-active'].ageDays).toBe(1);
    expect(bySlug['c-legacy'].ageDays).toBe(5);
  });

  it('filter=active includes legacy; filter=done excludes active', async () => {
    seedPrd(root, 'a-active', { status: 'active', created: '2026-06-09' });
    seedPrd(root, 'b-done', { status: 'done', created: '2026-06-09' });
    seedPrd(root, 'c-legacy', { ageDays: 1 });

    const act = await listArtifacts({ projectRoot: root, filter: 'active', now: fixedNow });
    expect(act.items.map((i) => i.slug).sort()).toEqual(['a-active', 'c-legacy']);

    const done = await listArtifacts({ projectRoot: root, filter: 'done', now: fixedNow });
    expect(done.items.map((i) => i.slug)).toEqual(['b-done']);
  });

  it('filter=stale = active/legacy older than 90 days', async () => {
    seedPrd(root, 'fresh', { status: 'active', created: '2026-06-01' });
    seedPrd(root, 'old-active', { status: 'active', created: '2026-01-01' }); // >90d
    seedPrd(root, 'old-legacy', { ageDays: 200 });
    seedPrd(root, 'old-done', { status: 'done', created: '2026-01-01' }); // done ≠ stale

    const res = await listArtifacts({ projectRoot: root, filter: 'stale', now: fixedNow });
    expect(res.items.map((i) => i.slug).sort()).toEqual(['old-active', 'old-legacy']);
  });
});

describe('artifacts / indexArtifacts', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes INDEX.md with only active docs', async () => {
    seedPrd(root, 'keep', { status: 'active', created: '2026-06-09' });
    seedPrd(root, 'drop', { status: 'done', created: '2026-06-09' });

    const res = await indexArtifacts({ projectRoot: root, now: fixedNow });
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    const idx = readFileSync(res.indexPath, 'utf-8');
    expect(idx).toContain('| slug | status | date | ageDays | link |');
    expect(idx).toContain('keep');
    expect(idx).not.toContain('| drop |');
  });

  it('does not include INDEX.md itself as an item', async () => {
    seedPrd(root, 'one', { status: 'active', created: '2026-06-09' });
    await indexArtifacts({ projectRoot: root, now: fixedNow });
    const res2 = await listArtifacts({ projectRoot: root, filter: 'all', now: fixedNow });
    expect(res2.items.map((i) => i.slug)).not.toContain('INDEX');
  });
});

describe('artifacts / archiveStale', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('dryRun=true reports moves without touching disk', async () => {
    seedPrd(root, 'done-doc', { status: 'done', created: '2026-06-09' });
    const before = readdirSync(path.join(root, 'docs', 'PRD'));

    const res = await archiveStale({ projectRoot: root, dryRun: true, now: fixedNow });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.moved).toHaveLength(1);
    expect(res.moved[0].reason).toMatch(/done/);
    expect(existsSync(path.join(root, 'docs', 'PRD', '_archive'))).toBe(false);
    expect(readdirSync(path.join(root, 'docs', 'PRD'))).toEqual(before);
  });

  it('dryRun=false moves to _archive without deleting (rename only)', async () => {
    const src = seedPrd(root, 'done-doc', { status: 'done', created: '2026-06-09' });
    seedPrd(root, 'active-doc', { status: 'active', created: '2026-06-09' });

    const res = await archiveStale({ projectRoot: root, dryRun: false, now: fixedNow });
    expect(res.dryRun).toBe(false);
    expect(res.moved).toHaveLength(1);
    expect(existsSync(src)).toBe(false); // moved away
    const dest = path.join(root, 'docs', 'PRD', '_archive', 'done-doc.md');
    expect(existsSync(dest)).toBe(true); // present in archive (not deleted)
    // active doc untouched
    expect(existsSync(path.join(root, 'docs', 'PRD', 'active-doc.md'))).toBe(true);
  });

  it('archives legacy/active only when older than threshold', async () => {
    seedPrd(root, 'old-legacy', { ageDays: 200 });
    seedPrd(root, 'fresh-legacy', { ageDays: 3 });

    const res = await archiveStale({ projectRoot: root, dryRun: true, now: fixedNow });
    expect(res.moved.map((m) => path.basename(m.from))).toEqual(['old-legacy.md']);
  });
});

describe('artifacts / supersede', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('sets status superseded + adds link (frontmatter doc)', async () => {
    seedPrd(root, 'old', { status: 'active', created: '2026-06-09' });
    const res = await supersede({
      projectRoot: root, oldSlug: 'old', newPath: 'docs/PRD/new.md', now: fixedNow,
    });
    expect(res.ok).toBe(true);
    const body = readFileSync(res.oldPath, 'utf-8');
    expect(body).toContain('status: superseded');
    expect(body).toContain('Superseded by: docs/PRD/new.md');
    expect(body).not.toContain('status: active');
  });

  it('adds frontmatter block to a legacy doc', async () => {
    seedPrd(root, 'legacy', { ageDays: 1 });
    const res = await supersede({
      projectRoot: root, oldSlug: 'legacy', newPath: 'new.md', now: fixedNow,
    });
    expect(res.ok).toBe(true);
    const body = readFileSync(res.oldPath, 'utf-8');
    expect(body.startsWith('---\nstatus: superseded')).toBe(true);
    expect(body).toContain('Superseded by: new.md');
  });

  it('returns {ok:false} when oldSlug not found', async () => {
    const res = await supersede({
      projectRoot: root, oldSlug: 'nope', newPath: 'new.md', now: fixedNow,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// kind resolution (U6/D1)
//
// `kindDir()` used to fall back to the PRD directory for any unrecognised
// kind while `renderIndex()` fell back to the raw kind string. The two
// fallbacks pointed in different directions, so `indexArtifacts({kind:'ADR'})`
// silently OVERWROTE docs/PRD/INDEX.md with a `# ADR Index` heading listing
// PRD records. Writing the wrong directory quietly is worse than failing, so
// the kind is now case-normalised and then validated against an allowlist.
// ---------------------------------------------------------------------------

describe('artifacts / kind resolution', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('indexArtifacts({kind:"ADR"}) does not clobber the PRD index', async () => {
    seedPrd(root, 'p-one', { status: 'active', created: '2026-06-09' });
    await indexArtifacts({ projectRoot: root, kind: 'prd', now: fixedNow });
    const prdIndex = path.join(root, 'docs', 'PRD', 'INDEX.md');
    const before = readFileSync(prdIndex, 'utf-8');

    await ensureADR({
      projectRoot: root, title: 'Kind Case', options: ['A', 'B'], decision: 'A', now: fixedNow,
    });
    const res = await indexArtifacts({ projectRoot: root, kind: 'ADR', now: fixedNow });

    expect(res.ok).toBe(true);
    // Uppercase is normalised to the adr directory — never the PRD one.
    expect(res.indexPath).toBe(path.join(root, 'docs', 'adr', 'INDEX.md'));
    expect(readFileSync(prdIndex, 'utf-8')).toBe(before);
  });

  it('rejects an unknown kind instead of silently writing docs/PRD', async () => {
    seedPrd(root, 'p-one', { status: 'active', created: '2026-06-09' });
    await indexArtifacts({ projectRoot: root, kind: 'prd', now: fixedNow });
    const prdIndex = path.join(root, 'docs', 'PRD', 'INDEX.md');
    const before = readFileSync(prdIndex, 'utf-8');

    const res = await indexArtifacts({ projectRoot: root, kind: 'bogus', now: fixedNow });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/kind/i);
    expect(readFileSync(prdIndex, 'utf-8')).toBe(before);
  });

  it('listArtifacts and archiveStale reject an unknown kind too', async () => {
    const list = await listArtifacts({ projectRoot: root, kind: 'bogus', now: fixedNow });
    expect(list.ok).toBe(false);
    expect(list.error).toMatch(/kind/i);

    const arch = await archiveStale({ projectRoot: root, kind: 'bogus', dryRun: true, now: fixedNow });
    expect(arch.ok).toBe(false);
    expect(arch.error).toMatch(/kind/i);
  });

  it('index heading uses the canonical uppercase label for both kinds', async () => {
    seedPrd(root, 'p-one', { status: 'active', created: '2026-06-09' });
    const prd = await indexArtifacts({ projectRoot: root, kind: 'prd', now: fixedNow });
    expect(readFileSync(prd.indexPath, 'utf-8').startsWith('# PRD Index')).toBe(true);

    await ensureADR({
      projectRoot: root, title: 'Heading Case', options: ['A', 'B'], decision: 'A', now: fixedNow,
    });
    const adr = await indexArtifacts({ projectRoot: root, kind: 'adr', now: fixedNow });
    expect(readFileSync(adr.indexPath, 'utf-8').startsWith('# ADR Index')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADR lifecycle metadata (U6/D2, U6/D3)
// ---------------------------------------------------------------------------

describe('artifacts / ADR lifecycle metadata', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // D3: renderAdr emitted no frontmatter, so readArtifact classified a
  // brand-new "Accepted" ADR as `legacy` — the index status column contradicted
  // the document body.
  it('a freshly created ADR carries active frontmatter, not legacy', async () => {
    const made = await ensureADR({
      projectRoot: root, title: 'Fresh Decision', options: ['A', 'B'], decision: 'A', now: fixedNow,
    });
    const body = readFileSync(made.adrPath, 'utf-8');
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain('status: active');
    // The rendered skeleton must survive the frontmatter addition.
    expect(body).toContain('# ADR-001: Fresh Decision');

    const listed = await listArtifacts({ projectRoot: root, kind: 'adr', filter: 'all', now: fixedNow });
    expect(listed.ok).toBe(true);
    expect(listed.items.map((i) => i.status)).toEqual(['active']);

    const idx = await indexArtifacts({ projectRoot: root, kind: 'adr', now: fixedNow });
    expect(readFileSync(idx.indexPath, 'utf-8')).not.toContain('| legacy |');
  });

  // D2: ensureADR is deliberately NOT idempotent — an ADR number is the
  // decision's identity, and two calls mean two decisions. This test locks the
  // contract so the "(멱등)" claim cannot silently return to the docs.
  it('is NOT idempotent by design: identical args create a second numbered ADR', async () => {
    const args = {
      projectRoot: root, title: 'Same Title', options: ['A', 'B'], decision: 'A', now: fixedNow,
    };
    const first = await ensureADR(args);
    const second = await ensureADR(args);

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(second.adrPath).not.toBe(first.adrPath);
    expect(existsSync(first.adrPath)).toBe(true);
    expect(existsSync(second.adrPath)).toBe(true);
  });
});
