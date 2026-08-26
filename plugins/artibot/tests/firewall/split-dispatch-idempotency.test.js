/**
 * 검사 목적: `/split dispatch` 의 판정기 `lib/git/split-dispatch.js` 가
 * **멱등·fail-closed** 인가.
 *
 * ── 계약 (PRD §설계 dispatch) ──────────────────────────────────────────────
 *   - 진실원은 git/파일시스템(`git worktree list --porcelain`), 메시지는 최적화.
 *   - 계획 worktree 가 하나라도 없으면 **거부** + 어느 줄기가 비는지 보고.
 *   - `ListAgents` 도구 부재 또는 env `CLAUDE_CODE_MESSAGING_SOCKET` 부재 → `unavailable`.
 *   - 같은 계획을 두 번 dispatch 하면 결과가 같고 부작용이 0 이다(재발행).
 *
 * ── 실측 전제 (2026-08-26 21:30~35, 리더 artibot-16 + probe1-08, n=4) ───────
 *   `ListAgents` 출력에 **cwd 가 없다** (`name [ref] · kind · state · started`).
 *   세션 이름은 `{worktree 디렉터리명}-{hex2}`. 따라서 "창이 열렸는가"는 세션
 *   이름 **접두 휴리스틱**이다. 이 파일은 그 휴리스틱의 정의(정확히 1개 매칭 =
 *   열림, 0 = 미개설, ≥2 = 중복 → 둘 다 거부)를 고정한다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ─────────────────
 *  1. **SendMessage 를 실제로 보내지 않는다.** `messages[]` 를 계산할 뿐이다.
 *     전송·도달·수신 세션의 해석은 라이브에서만 관측된다.
 *  2. **세션 이름 규칙은 관측이지 계약이 아니다.** Claude Code 가 이름 형식을
 *     바꾸면 모든 창이 "미개설"로 보인다 — 이때 판정은 거부(fail-closed)이지
 *     오배달이 아니다. 그 red 는 이 파일이 아니라 라이브 `/split status` 가 낸다.
 *  3. **cwd 검증 없음.** 이름이 맞는 세션이 다른 디렉터리에서 돌고 있어도 모른다.
 *  4. **픽스처 규모**: 줄기 2개·세션 3행. 실용 상한 4창은 안 본다.
 *  5. **`listWorktrees` 외 I/O 없음** — 파일시스템 부작용 0 은 임시 리포의
 *     `readdirSync` 전후 비교로만 본다(리포 밖 쓰기는 관측 범위 밖).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildLimbMessage,
  canonicalPath,
  limbsFromPlan,
  listWorktrees,
  matchingSessions,
  MESSAGING_SOCKET_ENV,
  messagingFromEnv,
  normalizePath,
  parseListAgents,
  parseWorktreePorcelain,
  resolveDispatch,
} from '../../lib/git/split-dispatch.js';
import { limbNames } from '../../lib/git/limb-completion.js';

// ── 순수 픽스처 ───────────────────────────────────────────────────────────

const ROOT = process.platform === 'win32' ? 'C:/proj/.claude/worktrees' : '/proj/.claude/worktrees';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const PLAN = deepFreeze({
  runId: 'split-abc123', // = split-{sid}; 판정기는 이 값을 파싱하지 않고 메시지 헤더에 그대로 싣는다
  base: 'master',
  limbs: [
    { limb: 'auth', worktreePath: `${ROOT}/split-rr-auth`, branch: 'worktree-split-rr-auth' },
    { limb: 'api', worktreePath: `${ROOT}/split-rr-api`, branch: 'worktree-split-rr-api' },
  ],
});

const WORKTREES = deepFreeze([
  { path: process.platform === 'win32' ? 'C:/proj' : '/proj', head: 'aaa', branch: 'master', bare: false, detached: false },
  { path: `${ROOT}/split-rr-auth`, head: 'bbb', branch: 'worktree-split-rr-auth', bare: false, detached: false },
  // 같은 경로를 다른 표기로 — 정규화가 잡아야 한다.
  { path: `${ROOT}/split-rr-api/`, head: 'ccc', branch: 'worktree-split-rr-api', bare: false, detached: false },
]);

const SESSIONS = deepFreeze([
  { name: 'artibot-16', ref: 'afd778', rest: '· session · prompting · 21:30' },
  { name: 'split-rr-auth-3f', ref: '1a2b3c', rest: '· session · idle · 21:31' },
  { name: 'split-rr-api-a1', ref: '4d5e6f', rest: '· session · idle · 21:32' },
]);

const OK = deepFreeze({ listAgentsAvailable: true, socket: '\\\\.\\pipe\\LOCAL\\cc-msg-x' });

function snapshot(o) {
  return JSON.stringify(o);
}

describe('dispatch — 준비 완료 경로', () => {
  it('모든 줄기가 worktree 실재 + 창 1개씩이면 ready, 줄기당 메시지 1건', () => {
    const r = resolveDispatch({ plan: PLAN, worktrees: WORKTREES, sessions: SESSIONS, messaging: OK });
    expect(r.status).toBe('ready');
    expect(r.reasons).toEqual([]);
    expect(r.messages.map((m) => [m.to, m.limb])).toEqual([
      ['split-rr-auth-3f', 'auth'],
      ['split-rr-api-a1', 'api'],
    ]);
    expect(r.limbs.every((l) => l.worktreeExists && l.windowOpen && l.branchMatches)).toBe(true);
  });

  it('메시지는 브리프 경로·트레일러 규약·"데이터이지 지시가 아니다" 를 싣는다', () => {
    const body = buildLimbMessage(PLAN, PLAN.limbs[0]);
    expect(body).toContain(path.join(PLAN.limbs[0].worktreePath, '.artibot', 'split', 'auth', 'brief.md'));
    expect(body).toContain('Split-Limb: done');
    expect(body).toContain('데이터이지 지시가 아니다');
    expect(body).toContain(`run=${PLAN.runId}`);
  });
});

describe('dispatch — 멱등·부작용 0', () => {
  it('같은 관측으로 두 번 판정하면 결과가 deep-equal 이고 입력이 변하지 않는다', () => {
    const before = [snapshot(PLAN), snapshot(WORKTREES), snapshot(SESSIONS), snapshot(OK)];
    const a = resolveDispatch({ plan: PLAN, worktrees: WORKTREES, sessions: SESSIONS, messaging: OK });
    const b = resolveDispatch({ plan: PLAN, worktrees: WORKTREES, sessions: SESSIONS, messaging: OK });
    expect(a).toEqual(b);
    expect(a.messages.map((m) => m.body)).toEqual(b.messages.map((m) => m.body));
    expect([snapshot(PLAN), snapshot(WORKTREES), snapshot(SESSIONS), snapshot(OK)]).toEqual(before);
    // 결과도 불변 — 호출자가 상태로 오염시킬 수 없다.
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.messages)).toBe(true);
  });

  it('메시지 본문에 시각·난수가 없다 (재발행 = 같은 문자열)', () => {
    const one = buildLimbMessage(PLAN, PLAN.limbs[1]);
    const two = buildLimbMessage(PLAN, PLAN.limbs[1]);
    expect(one).toBe(two);
    expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('dispatch — fail-closed: 거부', () => {
  it('계획 worktree 가 하나라도 없으면 refused + 어느 줄기가 비는지', () => {
    const r = resolveDispatch({ plan: PLAN, worktrees: [WORKTREES[0], WORKTREES[1]], sessions: SESSIONS, messaging: OK });
    expect(r.status).toBe('refused');
    expect(r.missingWorktrees).toEqual(['api']);
    expect(r.messages).toEqual([]);
    expect(r.reasons.join('\n')).toContain('worktree 미개설: api');
  });

  it('창이 안 열린 줄기가 있으면 refused + 어느 창이 비는지', () => {
    const r = resolveDispatch({ plan: PLAN, worktrees: WORKTREES, sessions: [SESSIONS[0], SESSIONS[1]], messaging: OK });
    expect(r.status).toBe('refused');
    expect(r.unopenedWindows).toEqual(['api']);
    expect(r.messages).toEqual([]);
    expect(r.reasons.join('\n')).toContain('창 미개설: api');
  });

  it('같은 worktree 이름의 세션이 2개면 추측하지 않고 refused (중복)', () => {
    const dup = [...SESSIONS, { name: 'split-rr-api-b2', ref: '777777', rest: '' }];
    const r = resolveDispatch({ plan: PLAN, worktrees: WORKTREES, sessions: dup, messaging: OK });
    expect(r.status).toBe('refused');
    expect(r.ambiguousWindows).toEqual(['api']);
    expect(r.limbs[1].sessions).toEqual(['split-rr-api-a1', 'split-rr-api-b2']);
    expect(r.messages).toEqual([]);
  });

  it('줄기가 0개인 계획은 refused', () => {
    const r = resolveDispatch({ plan: { ...PLAN, limbs: [] }, worktrees: WORKTREES, sessions: SESSIONS, messaging: OK });
    expect(r.status).toBe('refused');
    expect(r.messages).toEqual([]);
  });

  it('세션 목록이 비면 전 줄기 미개설 → refused (0건 = 열린 창 없음, 오류 아님)', () => {
    const r = resolveDispatch({ plan: PLAN, worktrees: WORKTREES, sessions: [], messaging: OK });
    expect(r.status).toBe('refused');
    expect(r.unopenedWindows).toEqual(['auth', 'api']);
  });
});

describe('dispatch — fail-closed: unavailable (도구/env 부재)', () => {
  it('ListAgents 부재 → unavailable, 메시지 0', () => {
    const r = resolveDispatch({
      plan: PLAN, worktrees: WORKTREES, sessions: SESSIONS,
      messaging: { listAgentsAvailable: false, socket: OK.socket },
    });
    expect(r.status).toBe('unavailable');
    expect(r.reasons.join('\n')).toContain('ListAgents');
    expect(r.messages).toEqual([]);
  });

  it('sessions=null (도구를 못 불렀다) 도 unavailable 이다 — 빈 배열과 다르다', () => {
    const r = resolveDispatch({ plan: PLAN, worktrees: WORKTREES, sessions: null, messaging: OK });
    expect(r.status).toBe('unavailable');
  });

  it(`env ${MESSAGING_SOCKET_ENV} 부재 → unavailable`, () => {
    const r = resolveDispatch({
      plan: PLAN, worktrees: WORKTREES, sessions: SESSIONS,
      messaging: { listAgentsAvailable: true, socket: null },
    });
    expect(r.status).toBe('unavailable');
    expect(r.reasons.join('\n')).toContain(MESSAGING_SOCKET_ENV);
  });

  it('unavailable 은 거부 사유보다 앞선다 — 관측 불가 상태에서 "창이 비었다"고 말하지 않는다', () => {
    const r = resolveDispatch({ plan: PLAN, worktrees: [], sessions: null, messaging: { listAgentsAvailable: false, socket: null } });
    expect(r.status).toBe('unavailable');
    expect(r.reasons.some((s) => s.includes('미개설'))).toBe(false);
    // 관측치 자체는 보고를 위해 남긴다.
    expect(r.missingWorktrees).toEqual(['auth', 'api']);
  });

  it('messagingFromEnv 는 넘겨준 env 만 읽는다 (process.env 우회 없음)', () => {
    expect(messagingFromEnv({ listAgentsAvailable: true, env: {} }).socket).toBeNull();
    expect(messagingFromEnv({ listAgentsAvailable: true, env: { [MESSAGING_SOCKET_ENV]: '  ' } }).socket).toBeNull();
    const m = messagingFromEnv({ listAgentsAvailable: true, env: { [MESSAGING_SOCKET_ENV]: 'sock' } });
    expect(m).toEqual({ listAgentsAvailable: true, socket: 'sock' });
    expect(messagingFromEnv({ listAgentsAvailable: 'yes', env: { [MESSAGING_SOCKET_ENV]: 'sock' } }).listAgentsAvailable).toBe(false);
  });
});

describe('파서 — 관측 텍스트 → 구조', () => {
  it('git worktree list --porcelain 스탠자를 읽는다', () => {
    const text = [
      'worktree C:/proj', 'HEAD aaa', 'branch refs/heads/master', '',
      'worktree C:/proj/.claude/worktrees/probe1', 'HEAD bbb', 'branch refs/heads/worktree-probe1', '',
      'worktree C:/proj/.claude/worktrees/det', 'HEAD ccc', 'detached', '',
    ].join('\n');
    const w = parseWorktreePorcelain(text);
    expect(w.map((x) => [x.path, x.branch, x.detached])).toEqual([
      ['C:/proj', 'master', false],
      ['C:/proj/.claude/worktrees/probe1', 'worktree-probe1', false],
      ['C:/proj/.claude/worktrees/det', null, true],
    ]);
    expect(parseWorktreePorcelain('')).toEqual([]);
  });

  it('ListAgents 행(2026-08-26 실측 형식)에서 이름과 [ref] 를 뽑는다', () => {
    const text = [
      'artibot-16 [afd778] · session · prompting · 21:30',
      'probe1-08 [1a2b3c] · session · idle · 21:31',
      '- team-x-afd778-worker [zz] · agent · running · 21:32',
      '',
    ].join('\n');
    const rows = parseListAgents(text);
    expect(rows.map((r) => [r.name, r.ref])).toEqual([
      ['artibot-16', 'afd778'],
      ['probe1-08', '1a2b3c'],
      ['team-x-afd778-worker', 'zz'],
    ]);
  });

  it('창 매칭은 worktree 디렉터리명 + "-" + 세그먼트 1개다', () => {
    expect(matchingSessions(`${ROOT}/probe1`, [{ name: 'probe1-08' }, { name: 'probe10-aa' }, { name: 'x' }]))
      .toEqual(['probe1-08']);
    expect(matchingSessions('', [{ name: '-x' }])).toEqual([]);
  });

  it('줄기 창 안의 팀원(split-{limb}-{sid}-{role})은 창으로 세지 않는다 — 접두만 보면 중복 거부가 난다', () => {
    const rows = [
      { name: 'split-auth-3f' },             // 창
      { name: 'split-auth-3f-worker' },      // 그 창이 스폰한 팀원 (split.md open 7)
      { name: 'split-auth-3f-reviewer' },
      { name: 'split-auth-v2-08' },          // 다른 limb(auth-v2)의 창
    ];
    expect(matchingSessions(`${ROOT}/split-auth`, rows)).toEqual(['split-auth-3f']);
    expect(matchingSessions(`${ROOT}/split-auth-v2`, rows)).toEqual(['split-auth-v2-08']);
    const r = resolveDispatch({
      plan: { ...PLAN, limbs: [{ limb: 'auth', worktreePath: `${ROOT}/split-auth`, branch: 'worktree-split-auth' }] },
      worktrees: [{ path: `${ROOT}/split-auth`, branch: 'worktree-split-auth' }],
      sessions: rows, messaging: OK,
    });
    expect(r.status).toBe('ready');
    expect(r.messages.map((m) => m.to)).toEqual(['split-auth-3f']);
  });

  it('정본 이름(split-<repo>-<limb>-<hex2>) 기준 재확인 — 하이픈 든 repoShort 여도 창 1개만 매칭된다', () => {
    // 리더 요청(2026-08-26 22:0x): "접두+세그먼트 1개" 규칙을 정본 이름 형태로 재확인.
    const n = limbNames({ repoShort: 'my-repo', limb: 'auth' });
    expect(n.worktreeName).toBe('split-my-repo-auth');
    const rows = [
      'my-repo-3f',                       // 부모 리포 세션 (worktree 이름 아님)
      'split-my-repo-auth-3f',            // 이 줄기의 창 ← 유일한 매칭
      'split-my-repo-auth-3f-worker',     // 그 창이 스폰한 팀원
      'split-my-repo-auth-v2-08',         // 다른 limb(auth-v2)
      'split-my-repo-auth',               // hex 없는 맨 worktree 이름
      'split-other-auth-3f',              // 다른 리포의 같은 limb — repoShort 가 가른다
      'artibot-16',
    ].map((name) => ({ name }));
    expect(matchingSessions(`${ROOT}/${n.worktreeName}`, rows)).toEqual(['split-my-repo-auth-3f']);
  });

  it('limbsFromPlan 은 split.md 의 plan.json 형태를 정본 규약(split-<repo>-<limb> / worktree-split-<repo>-<limb>)으로 펼친다', () => {
    const rows = limbsFromPlan(
      { limbs: [{ limb: 'auth', taskIds: [1] }, { limb: 'api', taskIds: [2] }] },
      '/repo',
      { repoShort: 'artibot' },
    );
    expect(rows).toEqual([
      { limb: 'auth', worktreePath: path.join('/repo', '.claude', 'worktrees', 'split-artibot-auth'), branch: 'worktree-split-artibot-auth' },
      { limb: 'api', worktreePath: path.join('/repo', '.claude', 'worktrees', 'split-artibot-api'), branch: 'worktree-split-artibot-api' },
    ]);
    // repoShort 는 필수 — 기계 전역 ListAgents 에서 두 리포의 같은 limb 을 가른다.
    expect(() => limbsFromPlan({ limbs: [{ limb: 'auth' }] }, '/repo')).toThrow(TypeError);
    expect(() => limbsFromPlan({ limbs: [{ limb: 'Bad/Slug' }] }, '/repo', { repoShort: 'artibot' })).toThrow(TypeError);
    expect(limbsFromPlan({}, '/repo', { repoShort: 'artibot' })).toEqual([]);
  });

  it('bodies 를 주면 그 줄기의 본문을 SplitWindow 프롬프트로 대체한다 (없는 줄기는 포인터 본문)', () => {
    const r = resolveDispatch({
      plan: PLAN, worktrees: WORKTREES, sessions: SESSIONS, messaging: OK,
      bodies: { auth: '[split limb] limb=auth · full window prompt' },
    });
    expect(r.messages[0].body).toBe('[split limb] limb=auth · full window prompt');
    expect(r.messages[1].body).toBe(buildLimbMessage(PLAN, PLAN.limbs[1]));
  });

  it('경로 정규화: 구분자·끝 슬래시·(win32) 대소문자', () => {
    expect(normalizePath('C:\\a\\b\\', 'win32')).toBe(normalizePath('c:/A/B', 'win32'));
    expect(normalizePath('/a/b/', 'linux')).toBe(normalizePath('/a/b', 'linux'));
    expect(normalizePath('/a/B', 'linux')).not.toBe(normalizePath('/a/b', 'linux'));
    expect(normalizePath('')).toBe('');
  });
});

// ── 임시 리포: listWorktrees 실측 + 2회 dispatch 후 파일시스템 불변 ────────────

let repo = '';
let wtAuth = '';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
}

beforeAll(() => {
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-dispatch-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  fsSync.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf-8');
  git(['add', 'seed.txt'], repo);
  git(['commit', '-qm', 'init'], repo);
  wtAuth = path.join(repo, '.claude', 'worktrees', 'split-rr-auth');
  git(['worktree', 'add', '-q', wtAuth, '-b', 'worktree-split-rr-auth'], repo);
});

afterAll(() => {
  try {
    fsSync.rmSync(repo, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('임시 리포 — git 관측과 부작용 0', () => {
  it('listWorktrees 는 porcelain 을 파싱해 실재 worktree 를 돌려주고, 비리포는 null', () => {
    const w = listWorktrees(repo);
    expect(w).not.toBeNull();
    expect(w.map((x) => canonicalPath(x.path))).toContain(canonicalPath(wtAuth));
    const notRepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-notrepo-'));
    try {
      expect(listWorktrees(notRepo)).toBeNull();
    } finally {
      fsSync.rmSync(notRepo, { recursive: true, force: true });
    }
    expect(listWorktrees('')).toBeNull();
  });

  it('실재 worktree 계획을 두 번 dispatch 해도 worktree 목록·파일 목록이 그대로다', () => {
    const plan = {
      runId: 'r1', base: 'main',
      limbs: [{ limb: 'auth', worktreePath: wtAuth, branch: 'worktree-split-rr-auth' }],
    };
    const sessions = [{ name: 'split-rr-auth-3f' }];
    const filesBefore = fsSync.readdirSync(repo).sort();
    const wtBefore = snapshot(listWorktrees(repo));

    const a = resolveDispatch({ plan, worktrees: listWorktrees(repo), sessions, messaging: OK });
    const b = resolveDispatch({ plan, worktrees: listWorktrees(repo), sessions, messaging: OK });

    expect(a.status).toBe('ready');
    expect(a).toEqual(b);
    expect(fsSync.readdirSync(repo).sort()).toEqual(filesBefore);
    expect(snapshot(listWorktrees(repo))).toBe(wtBefore);
    expect(fsSync.existsSync(path.join(wtAuth, '.artibot'))).toBe(false); // 브리프는 open 이 쓴다, dispatch 가 아니다
  });

  it('짧은 경로(8.3)·긴 경로가 섞여도 같은 worktree 로 본다 — 실측 함정 (git 은 긴 경로를 찍는다)', () => {
    // 2026-08-26 이 테스트가 처음 red 였던 이유: os.tmpdir() 이 `HEECHA~1` 단축 경로를
    // 돌려주고 git porcelain 은 `HeechangLee` 긴 경로를 찍어 path.resolve 만으로는
    // 불일치했다. canonicalPath(realpath) 가 그것을 흡수한다. 단축 경로가 없는
    // 플랫폼(POSIX)에서는 둘이 애초에 같아 자명하게 통과한다 — 이 케이스의 실효
    // 해상도는 Windows 에서만 있다.
    const fromGit = listWorktrees(repo).find((w) => canonicalPath(w.path) === canonicalPath(wtAuth));
    expect(fromGit).toBeDefined();
    expect(canonicalPath(fromGit.path)).toBe(canonicalPath(wtAuth));
    // 존재하지 않는 경로는 문자열 정규화로 폴백한다(= 실재하는 것과 절대 같아질 수 없다).
    const ghost = path.join(repo, '.claude', 'worktrees', 'ghost');
    expect(canonicalPath(ghost)).toBe(normalizePath(ghost));
  });

  it('계획에 있으나 실재하지 않는 worktree 는 실제 git 관측으로도 refused', () => {
    const plan = {
      runId: 'r1', base: 'main',
      limbs: [
        { limb: 'auth', worktreePath: wtAuth, branch: 'worktree-split-rr-auth' },
        { limb: 'api', worktreePath: path.join(repo, '.claude', 'worktrees', 'split-rr-api'), branch: 'worktree-split-rr-api' },
      ],
    };
    const r = resolveDispatch({
      plan, worktrees: listWorktrees(repo),
      sessions: [{ name: 'split-rr-auth-3f' }, { name: 'split-rr-api-a1' }], messaging: OK,
    });
    expect(r.status).toBe('refused');
    expect(r.missingWorktrees).toEqual(['api']);
  });
});
