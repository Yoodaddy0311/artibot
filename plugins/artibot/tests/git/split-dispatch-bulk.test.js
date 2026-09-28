/**
 * 검사 목적: `/split dispatch` 전체 줄기 일괄 경로(split.md dispatch 3단계 스니펫)의
 * **소비 순서**를 그대로 재현해 판정·본문을 고정한다. 헬퍼 단독이 아니라 호출자 경로다.
 *
 * ── 재현하는 소비 순서 (새 순서) ──────────────────────────────────────────
 *   1. plan 행마다 `<worktreePath>` 아래 `.artibot` · `split` · `<limb>` · `prompt.md` 가
 *      실재할 때만 `promptPath` 를 붙인다(plan.json 행에는 promptPath 가 없다 —
 *      2026-09-28 라이브 부모 plan.json 8행 중 0행, forkPoint 는 8행 중 8행).
 *   2. 줄기별 `readLimbCompletion({ cwd, branch, base: forkPoint || plan.base }).complete`
 *      로 done 을 **먼저** 계산한다.
 *   3. 그 이름을 run.json lane-done ∪ 리더 명시 목록과 합쳐 `excludeLimbs` 로 넘긴다.
 *   4. `resolveDispatch(...)` 의 `messages` 를 그대로 쓴다(사후 필터 없음).
 *
 * 옛 순서(판정 먼저, done 은 messages 사후 필터)는 착지·정리된 줄기의 worktree 결손이
 * 판정을 `refused` 로 만든 뒤라 필터가 소용없다 — 아래 첫 케이스가 그 결함을 보인다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ─────────────────────────────────────
 *  1. split.md 스니펫 **문자열 자체**는 읽지 않는다. 이 파일은 순서의 의미를 재현할 뿐,
 *     문서가 그 순서로 적혔는지는 문서 쪽 게이트 몫이다.
 *  2. worktree·세션 관측은 합성 입력이다(`canonicalize` 는 항등). git 관측은
 *     `readLimbCompletion` 의 트레일러 판독에만 임시 리포로 쓴다.
 *  3. 픽스처 규모: 줄기 2개. 상한 8창·혼합 상태 분포는 안 본다.
 *  4. excludeLimbs 합집합 순서(lanes done → 트레일러 done → 리더 목록)는 헬퍼 안에서
 *     스니펫과 맞춰 두고 `excluded[]` 순서 케이스로 고정한다 — 단 스니펫 문자열이 그
 *     순서로 적혔는지는 1번과 같은 이유로 못 본다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLimbMessage, resolveDispatch } from '../../lib/git/split-dispatch.js';
import { readLimbCompletion, SPLIT_LIMB_DONE, SPLIT_LIMB_TRAILER } from '../../lib/git/limb-completion.js';
import { readLaneOpsState } from '../../lib/supervisor/lane-monitor.js';

const OK = Object.freeze({ listAgentsAvailable: true, socket: 'sock' });
const identity = (p) => p;
const BRANCH_A = 'worktree-split-bb-a';
const BRANCH_B = 'worktree-split-bb-b';
const SESSIONS = Object.freeze([{ name: 'artibot-1' }, { name: 'split-bb-b-3f' }]);

let repo = '';
let scratch = '';
let seedSha = '';
let planBase = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

// Trailer goes in the LAST `-m` — each `-m` is its own paragraph, and git only
// reads trailers from the final one.
function commitFile(cwd, name, messages) {
  fs.writeFileSync(path.join(cwd, name), `${name}\n`, 'utf-8');
  git(['add', name], cwd);
  git(['commit', '-q', ...messages.flatMap((m) => ['-m', m])], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

function promptFile(worktreePath, limb) {
  return path.join(worktreePath, '.artibot', 'split', limb, 'prompt.md');
}

/**
 * Fresh limb worktree layout for one test: A's worktree is absent (landed and
 * cleaned up), B's directory is real so prompt.md can exist or not.
 */
function layout(tag) {
  const root = path.join(scratch, tag);
  const wtA = path.join(root, 'split-bb-a');
  const wtB = path.join(root, 'split-bb-b');
  fs.mkdirSync(wtB, { recursive: true });
  return { wtA, wtB };
}

function planFor({ wtA, wtB }, { forkA = seedSha, forkB = seedSha } = {}) {
  return {
    runId: 'split-bulk-t1',
    base: planBase,
    limbs: [
      { limb: 'a', worktreePath: wtA, branch: BRANCH_A, taskIds: [1], forkPoint: forkA },
      { limb: 'b', worktreePath: wtB, branch: BRANCH_B, taskIds: [2], forkPoint: forkB },
    ],
  };
}

const worktreesFor = ({ wtB }) => [{ path: wtB, branch: BRANCH_B }];

function laneDoneOf(plan, runJson) {
  return plan.limbs.map((l) => l.limb).filter((l) => readLaneOpsState(runJson, l) === 'done');
}

/** Old consumer order: decide first, drop done limbs from `messages` afterwards. */
function dispatchOldOrder({ plan, worktrees, runJson = {} }) {
  const decision = resolveDispatch({
    plan, worktrees, sessions: SESSIONS, messaging: OK, canonicalize: identity,
    excludeLimbs: laneDoneOf(plan, runJson),
  });
  const done = new Set(plan.limbs
    .filter((l) => readLimbCompletion({ cwd: repo, branch: l.branch, base: l.forkPoint || plan.base }).complete)
    .map((l) => l.limb));
  return { ...decision, messages: decision.messages.filter((m) => !done.has(m.limb)) };
}

/** New consumer order (the snippet under test): done first → excludeLimbs → resolve. */
function dispatchNewOrder({ plan, worktrees, runJson = {}, leaderList = [], baseOf }) {
  const rows = plan.limbs.map((l) => {
    const p = promptFile(l.worktreePath, l.limb);
    return fs.existsSync(p) ? { ...l, promptPath: p } : l;
  });
  const pickBase = baseOf || ((l) => l.forkPoint || plan.base);
  const done = rows
    .filter((l) => readLimbCompletion({ cwd: repo, branch: l.branch, base: pickBase(l) }).complete)
    .map((l) => l.limb);
  // Same union order as the split.md snippet: lanes done, trailer done, leader list.
  const excludeLimbs = laneDoneOf(plan, runJson).concat(done, leaderList);
  return resolveDispatch({
    plan: { ...plan, limbs: rows }, worktrees, sessions: SESSIONS, messaging: OK,
    canonicalize: identity, excludeLimbs,
  });
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-bulk-'));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-bulk-wt-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  seedSha = commitFile(repo, 'seed.txt', ['init']);

  // Limb A: finished — its last first-parent trailer is `done`.
  git(['checkout', '-q', '-b', BRANCH_A, 'main'], repo);
  commitFile(repo, 'a.txt', ['feat: a part', `${SPLIT_LIMB_TRAILER}: ${SPLIT_LIMB_DONE}`]);
  // Limb B: still going — last trailer `wip`.
  git(['checkout', '-q', '-b', BRANCH_B, 'main'], repo);
  commitFile(repo, 'b.txt', ['feat: b part', `${SPLIT_LIMB_TRAILER}: wip`]);

  // A lands on main; plan.base is the post-landing tip, i.e. it already
  // contains A's done commit. forkPoint (the seed) is where both limbs forked.
  git(['checkout', '-q', 'main'], repo);
  git(['merge', '-q', '--no-ff', '-m', 'merge a', BRANCH_A], repo);
  planBase = git(['rev-parse', 'HEAD'], repo);
});

afterAll(() => {
  for (const d of [repo, scratch]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

describe('bulk dispatch — done 판정은 resolveDispatch 보다 먼저 (소비 순서)', () => {
  it('옛 순서는 착지·정리된 줄기 A 의 worktree 결손으로 refused — 사후 필터로는 못 살린다', () => {
    const lay = layout('old-order');
    const r = dispatchOldOrder({ plan: planFor(lay), worktrees: worktreesFor(lay) });
    expect(r.status).toBe('refused');
    expect(r.missingWorktrees).toEqual(['a']);
    expect(r.unopenedWindows).toEqual(['a']);
    expect(r.messages).toEqual([]);
  });

  it('새 순서는 ready — B 에게만 메시지 1건, A 는 excluded[] 에 보인다', () => {
    const lay = layout('new-order');
    const r = dispatchNewOrder({ plan: planFor(lay), worktrees: worktreesFor(lay) });
    expect(r.status).toBe('ready');
    expect(r.reasons).toEqual([]);
    expect(r.messages.map((m) => [m.to, m.limb])).toEqual([['split-bb-b-3f', 'b']]);
    expect(r.excluded).toEqual([{ limb: 'a', reason: 'excluded-by-input' }]);
    expect(r.limbs.map((l) => [l.limb, l.excluded, l.worktreeExists])).toEqual([
      ['a', true, false],
      ['b', false, true],
    ]);
  });

  it('run.json lane-done 과 트레일러 done 이 겹쳐도 한 번만 제외된다', () => {
    const lay = layout('union');
    const runJson = { lanes: { a: { state: 'done' } } };
    const r = dispatchNewOrder({ plan: planFor(lay), worktrees: worktreesFor(lay), runJson });
    expect(r.status).toBe('ready');
    expect(r.excluded).toEqual([{ limb: 'a', reason: 'excluded-by-input' }]);
  });

  it('excluded[] 순서는 스니펫 합집합 순서(트레일러 done → 리더 목록)를 따른다', () => {
    const lay = layout('order');
    const r = dispatchNewOrder({ plan: planFor(lay), worktrees: worktreesFor(lay), leaderList: ['zz'] });
    expect(r.status).toBe('ready');
    expect(r.excluded).toEqual([
      { limb: 'a', reason: 'excluded-by-input' },
      { limb: 'zz', reason: 'unknown-limb' },
    ]);
  });
});

describe('bulk dispatch — done 은 줄기별 forkPoint || plan.base 로 판정한다', () => {
  it('전제: plan.base 는 A 의 done 을 이미 포함해 no-commits, forkPoint 로는 done', () => {
    expect(readLimbCompletion({ cwd: repo, branch: BRANCH_A, base: planBase }).reason).toBe('no-commits');
    expect(readLimbCompletion({ cwd: repo, branch: BRANCH_A, base: seedSha }).complete).toBe(true);
  });

  it('forkPoint 를 쓰면 A 가 done 으로 제외돼 ready 다', () => {
    const lay = layout('fork-used');
    const seen = [];
    const r = dispatchNewOrder({
      plan: planFor(lay),
      worktrees: worktreesFor(lay),
      baseOf: (l) => {
        const b = l.forkPoint || planBase;
        seen.push([l.limb, b]);
        return b;
      },
    });
    expect(seen).toEqual([['a', seedSha], ['b', seedSha]]);
    expect(r.status).toBe('ready');
    expect(r.excluded.map((e) => e.limb)).toEqual(['a']);
  });

  it('forkPoint 가 빈 문자열(미기록)이면 plan.base 로 폴백 — A 가 done 이 아니라서 refused', () => {
    const lay = layout('fork-empty');
    const r = dispatchNewOrder({ plan: planFor(lay, { forkA: '' }), worktrees: worktreesFor(lay) });
    expect(r.status).toBe('refused');
    expect(r.missingWorktrees).toEqual(['a']);
    expect(r.excluded).toEqual([]);
  });
});

describe('bulk dispatch — promptPath·forkPoint 가 messages[].body 까지 간다 (SP-01)', () => {
  it('prompt.md 가 있으면 본문에 프롬프트 줄, 브랜치 줄 base 는 forkPoint', () => {
    const lay = layout('prompt-present');
    const promptB = promptFile(lay.wtB, 'b');
    fs.mkdirSync(path.dirname(promptB), { recursive: true });
    fs.writeFileSync(promptB, 'PROMPT', 'utf-8');

    const r = dispatchNewOrder({ plan: planFor(lay), worktrees: worktreesFor(lay) });
    expect(r.status).toBe('ready');
    const lines = r.messages[0].body.split('\n');
    expect(lines[2]).toBe(`프롬프트: ${promptB} (브리프 다음에 읽어라 — 보고 계약·효과 레벨·팀원 이름 규약이 거기 있다; 같은 폴더에 leader-addendum.md 가 있으면 그 다음에 읽어라)`);
    expect(lines[3]).toBe(`브랜치: ${BRANCH_B} (base: ${seedSha})`);
    expect(r.messages[0].body).not.toContain(`(base: ${planBase})`);
    expect(r.messages[0].body).toBe(buildLimbMessage({ runId: 'split-bulk-t1', base: planBase }, {
      limb: 'b', worktreePath: lay.wtB, branch: BRANCH_B, promptPath: promptB, forkPoint: seedSha,
    }));
  });

  it('prompt.md 가 없으면 프롬프트 줄이 없다 — forkPoint 는 여전히 base 줄에 쓰인다', () => {
    const lay = layout('prompt-absent');
    const r = dispatchNewOrder({ plan: planFor(lay), worktrees: worktreesFor(lay) });
    expect(r.status).toBe('ready');
    const body = r.messages[0].body;
    expect(body).not.toContain('프롬프트:');
    expect(body.split('\n')).toHaveLength(5);
    expect(body).toContain(`브랜치: ${BRANCH_B} (base: ${seedSha})`);
    expect(r.limbs[1]).not.toHaveProperty('promptPath');
  });

  it('forkPoint 가 plan.base 와 다르면 본문 base 는 forkPoint 다 (land 우선순위와 같다)', () => {
    const lay = layout('fork-diff');
    const r = dispatchNewOrder({ plan: planFor(lay), worktrees: worktreesFor(lay) });
    expect(seedSha).not.toBe(planBase);
    expect(r.messages[0].body).toContain(`(base: ${seedSha})`);
  });
});
