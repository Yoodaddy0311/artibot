/**
 * Firewall — CRLF 플랜의 태스크 파싱 + `syncTodo` 의 0건 fail-closed.
 *
 * ── 왜 이 게이트가 필요한가 ─────────────────────────────────────────────────
 * 실사고 1건: CRLF 로 저장된 PRD 를 `/plan --done` · `/ultraplan` 이 넘기면
 * `PlanTracker#parsePlan` 이 **태스크 0건**을 반환하고, `syncTodo` 가 그 0건을
 * `ok:true` 로 `.plan-state.json` 에 써서 기존 완료 상태를 파괴했다(fail-open).
 *
 * 근본 원인은 정규식이다. `CHECKBOX_UNCHECKED = /^(\s*)-\s\[\s\]\s+(.+)$/` 에서
 * JS 의 `.` 는 **줄 종결자를 매치하지 않으며 `\r` 도 줄 종결자다**. 따라서
 * `split('\n')` 이 남긴 `- [ ] task\r` 는 `(.+)` 가 `task` 까지만 먹고 `$`(비-multiline,
 * 입력 끝에서만 매치)가 `\r` 앞에서 실패한다 → 매치 0. `\r` 이 `\s` 라서 통과할
 * 거라는 직관은 **틀렸다**(2026-08-27 실측으로 반증됨).
 *
 * 수정 방향은 커밋 `24970419`(split-window-contract) 와 같은 **읽기 지점 정규화**다.
 * 단 한 가지가 다르다: 그 파일은 읽고 버리는 게이트라 `\r\n`→`\n` 통짜 치환으로
 * 충분했지만, 여기서는 `markCompleted` 가 **원문을 되돌려 쓴다**. 통짜 정규화하면
 * `/plan --done` 한 번에 PRD 전체가 CRLF→LF 로 뒤집혀 거대한 가짜 diff 가 된다.
 * 그래서 줄 종결자를 **보존한 채** 분해하고, 매칭만 종결자 없는 본문으로 한다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ──────────────────
 *
 *  1. **파일이 실제로 어떤 인코딩으로 디스크에 있는지는 안 본다.** 픽스처는 모두
 *     메모리 문자열이다. `core.autocrlf` 로 체크아웃이 CRLF 가 되는지 여부와 무관하게
 *     초록/빨강이 갈리지 않는 것이 의도다 — 러너 OS 의존성을 만들지 않는다.
 *  2. **`/plan` · `/ultraplan` 이 실제로 `syncTodo` 를 호출하는지는 안 본다.** 호출부는
 *     커맨드 마크다운의 지시문이고 프로덕션 JS 호출자는 0건이다(2026-08-27 실측:
 *     `grep -rn "syncTodo(" lib/ scripts/` → 정의 1건뿐). 모델이 지시를 따르는지는
 *     이 게이트 밖이다.
 *  3. **마크다운의 BOM 은 안 본다 — 그리고 볼 필요도 없다.** 최초 작성 시 "BOM 이
 *     붙으면 첫 줄이 어긋난다"고 적었는데 **틀렸다**(2026-08-27 실측 교정). JS 의 `\s`
 *     는 U+FEFF 를 포함하므로 체크박스 패턴의 선행 `(\s*)` 가 BOM 을 그대로 흡수한다
 *     — `/\s/.test('U+FEFF') === true`, `'U+FEFF- [ ] x'` 도 정상 매치된다.
 *     즉 마크다운 BOM 은 파싱 위험이 아니다. **진짜 BOM 위험은 `.plan-state.json`
 *     쪽**이고(`JSON.parse('U+FEFF{}')` 는 throw), 그것은 이 게이트가 아니라
 *     `readState` 의 fail-closed 경로가 받는다(아래 corrupt-JSON 케이스).
 *  4. **`.plan-state.json` 의 원자적 쓰기 자체는 안 본다.** `atomicWriteJson` 의 몫이다.
 *     이 파일은 "쓰지 않는다"만 검증하지 "어떻게 쓰는지"는 검증하지 않는다.
 *  5. **유니코드 줄 종결자(U+2028 / U+2029)는 안 본다.** `.` 는 이들도 매치하지
 *     않지만 마크다운 에디터가 만들지 않는 형태다.
 *  6. **부분 파싱 손실은 못 본다 — 0건만 본다.** 태스크가 3건 → 1건으로 **줄어드는**
 *     경우(예: 일부 줄만 문법이 어긋남) `zeroTaskRejection` 은 통과시키고, 사라진
 *     2건의 완료 플래그는 조용히 소실된다. 이는 결함이 아니라 설계상 의도다 —
 *     `artifacts.js#mergeCompletion` 의 "마크다운이 어떤 태스크가 존재하는지를
 *     결정한다"는 분업 계약이 그것이고, 태스크 삭제와 파싱 실패를 텍스트만으로는
 *     구별할 수 없다. 부분 손실을 잡으려면 stable ID 가 먼저 필요하다.
 *
 * @module tests/firewall/plan-crlf-fail-closed
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PlanTracker } from '../../lib/core/plan-tracker.js';
import { syncTodo } from '../../lib/planning/artifacts.js';

/** 세 개의 태스크(1 완료 / 2 미완료)를 가진 LF 기준 플랜. */
const PLAN_LF = [
  '# Plan',
  '',
  '- [ ] alpha task',
  '- [x] beta task',
  '  - [ ] nested gamma',
  '',
].join('\n');

const PLAN_CRLF = PLAN_LF.replace(/\n/g, '\r\n');
const PLAN_CR = PLAN_LF.replace(/\n/g, '\r');

/** 체크박스가 하나도 없는, 그러나 비어있지 않은 플랜 — fail-closed 대상. */
const PLAN_NO_CHECKBOXES = '# Plan\r\n\r\n본문만 있고 체크박스가 없다.\r\n';

const EXPECTED_TASKS = [
  { text: 'alpha task', completed: false },
  { text: 'beta task', completed: true },
  { text: 'nested gamma', completed: false },
];

/** 픽스처는 tmpdir 에서만 만든다 — 리포의 `docs/PRD/.plan-state.json` 을 절대 건드리지 않는다. */
let root;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'artibot-plan-crlf-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const fixedNow = () => new Date('2026-08-27T00:00:00.000Z');

describe('firewall / plan-tracker CRLF 파싱', () => {
  it.each([
    ['LF', PLAN_LF],
    ['CRLF', PLAN_CRLF],
    ['CR-only', PLAN_CR],
  ])('%s 플랜에서 태스크 3건을 동일하게 파싱한다', (_label, src) => {
    const tracker = new PlanTracker();
    const tasks = tracker.parsePlan(src);

    expect(tasks).toEqual(EXPECTED_TASKS);
    expect(tracker.getProgress()).toEqual({ total: 3, completed: 1, percentage: 33 });
  });

  it('CRLF 에서도 들여쓰기(indent)를 종결자와 섞지 않는다', () => {
    const tracker = new PlanTracker();
    tracker.parsePlan(PLAN_CRLF);
    // nested gamma 는 두 칸 들여쓰기다. 종결자가 indent 캡처로 새면 마킹 시
    // 줄이 어긋난다 — markCompleted 왕복으로 간접 확인한다.
    const out = tracker.markCompleted(2);
    expect(out).toContain('  - [x] nested gamma\r\n');
  });
});

describe('firewall / markCompleted 는 원본 줄 종결자를 보존한다', () => {
  it('CRLF 플랜을 마킹해도 CRLF 로 되돌려준다 (가짜 diff 금지)', () => {
    const tracker = new PlanTracker();
    tracker.parsePlan(PLAN_CRLF);

    const out = tracker.markCompleted(0);

    expect(out).toContain('- [x] alpha task');
    expect(out).toBe(PLAN_CRLF.replace('- [ ] alpha task', '- [x] alpha task'));
    // 통짜 정규화의 증상: LF 가 하나라도 섞이면 전체 파일 diff 가 된다.
    expect(out.match(/(?<!\r)\n/g)).toBeNull();
  });

  it('LF 플랜은 LF 그대로 유지한다', () => {
    const tracker = new PlanTracker();
    tracker.parsePlan(PLAN_LF);

    const out = tracker.markCompleted(0);

    expect(out).toBe(PLAN_LF.replace('- [ ] alpha task', '- [x] alpha task'));
    expect(out).not.toContain('\r');
  });
});

describe('firewall / syncTodo 0건 파싱은 fail-closed', () => {
  /** 완료 3건이 든 `.plan-state.json` 을 심고 경로를 돌려준다. */
  async function seedThreeDone() {
    const res = await syncTodo({
      projectRoot: root,
      planMarkdown: ['# Plan', '- [x] alpha task', '- [x] beta task', '- [x] gamma task'].join('\n'),
      sessionId: 'seed',
      now: fixedNow,
    });
    expect(res.progress).toEqual({ total: 3, completed: 3, percentage: 100 });
    return res.stateFile;
  }

  it('CRLF 플랜을 정상 동기화한다 (0건으로 파괴하지 않는다)', async () => {
    const res = await syncTodo({
      projectRoot: root, planMarkdown: PLAN_CRLF, sessionId: 's1', now: fixedNow,
    });

    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ total: 3, completed: 1, percentage: 33 });

    const state = JSON.parse(readFileSync(res.stateFile, 'utf-8'));
    expect(state.tasks.map((t) => t.text)).toEqual(
      ['alpha task', 'beta task', 'nested gamma'],
    );
  });

  it('비어있지 않은 플랜이 0건으로 파싱되면 state 를 바이트 단위로 보존한다', async () => {
    const stateFile = await seedThreeDone();
    const before = readFileSync(stateFile, 'utf-8');

    const res = await syncTodo({
      projectRoot: root, planMarkdown: PLAN_NO_CHECKBOXES, now: fixedNow,
    });

    expect(res.ok).toBe(false);
    // 마지막 대안이 `task` 였을 때는 사실상 모든 오류 문구가 통과해 "거부 경로에
    // 탑승했다"를 고정하지 못했다(projectRoot 누락 같은 다른 거부도 통과). 거부
    // 문구 자체를 고정한다.
    expect(res.error).toMatch(/refusing to overwrite/);
    expect(res.error).toMatch(/parsed 0 tasks/);
    expect(res.progress).toBeUndefined();
    // 파괴적 쓰기의 증상은 ok:true 였다. 파일이 그대로여야 한다.
    expect(readFileSync(stateFile, 'utf-8')).toBe(before);
  });

  it('선행 state 가 없어도 0건 플랜으로는 state 파일을 만들지 않는다', async () => {
    const res = await syncTodo({
      projectRoot: root, planMarkdown: PLAN_NO_CHECKBOXES, now: fixedNow,
    });

    expect(res.ok).toBe(false);
    expect(existsSync(path.join(root, '.plan-state.json'))).toBe(false);
  });

  it('선행 완료가 있는데 빈 플랜이 오면 역시 보존한다', async () => {
    const stateFile = await seedThreeDone();
    const before = readFileSync(stateFile, 'utf-8');

    const res = await syncTodo({ projectRoot: root, planMarkdown: '   \r\n', now: fixedNow });

    expect(res.ok).toBe(false);
    expect(readFileSync(stateFile, 'utf-8')).toBe(before);
  });

  it('선행 태스크가 없는 빈 플랜은 초기화로 허용한다 (파괴할 것이 없다)', async () => {
    const res = await syncTodo({ projectRoot: root, planMarkdown: '', now: fixedNow });

    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ total: 0, completed: 0, percentage: 0 });
  });
});

// ---------------------------------------------------------------------------
// readState — 부재(ENOENT) 와 읽기 실패를 구분한다
//
// 이전 구현은 모든 예외를 `null` 로 삼켰다. 그래서 "선행 태스크 0건" 판단이
// fail-open 이었다: 파손된 state + 빈 플랜이면 zeroTaskRejection 이 통과시키고
// 멀쩡한 파일을 덮어쓰며 ok:true 를 냈다. 권한/잠금 실패(EACCES·EBUSY — 윈도우
// 동시접근·AV)면 정상 플랜에서도 완료 플래그가 조용히 소실됐다.
// ---------------------------------------------------------------------------

describe('firewall / readState 는 부재와 실패를 구분한다', () => {
  const PLAN_THREE = ['# Plan', '- [x] alpha task', '- [x] beta task', '- [x] gamma task'].join('\n');

  it('파손된 JSON + 빈 플랜이면 덮어쓰지 않는다 (재현된 fail-open)', async () => {
    const stateFile = path.join(root, '.plan-state.json');
    const corrupt = '{ this is not json';
    writeFileSync(stateFile, corrupt, 'utf-8');

    const res = await syncTodo({ projectRoot: root, planMarkdown: '', now: fixedNow });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refusing to overwrite/);
    expect(res.error).toMatch(/not valid JSON/);
    // 파손 파일이라도 사람이 복구할 수 있게 그대로 남긴다.
    expect(readFileSync(stateFile, 'utf-8')).toBe(corrupt);
  });

  it('파손된 JSON 은 정상 플랜에서도 덮어쓰지 않는다 (완료 플래그 소실 방지)', async () => {
    const stateFile = path.join(root, '.plan-state.json');
    const corrupt = '{"tasks": [{"text": "alpha task", "completed": true}';
    writeFileSync(stateFile, corrupt, 'utf-8');

    const res = await syncTodo({ projectRoot: root, planMarkdown: PLAN_THREE, now: fixedNow });

    expect(res.ok).toBe(false);
    expect(readFileSync(stateFile, 'utf-8')).toBe(corrupt);
  });

  it('BOM 이 붙은 state 파일도 파손으로 잡는다 (JSON.parse 가 거부한다)', async () => {
    const stateFile = path.join(root, '.plan-state.json');
    writeFileSync(stateFile, '\uFEFF{"tasks":[]}', 'utf-8');

    const res = await syncTodo({ projectRoot: root, planMarkdown: PLAN_THREE, now: fixedNow });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not valid JSON/);
  });

  it('읽기 실패(비-ENOENT)를 부재로 오인하지 않는다', async () => {
    // 모킹 대신 실제 EISDIR 을 만든다 — state 경로를 디렉터리로 점유한다.
    // fs 를 모킹하면 "무엇이 실패로 분류되는가"가 아니라 모킹 자체를 검증하게 된다.
    mkdirSync(path.join(root, '.plan-state.json'));

    const res = await syncTodo({ projectRoot: root, planMarkdown: PLAN_THREE, now: fixedNow });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refusing to overwrite/);
    expect(res.error).toMatch(/cannot read/);
    expect(res.progress).toBeUndefined();
  });

  it('부재(ENOENT)는 정상 초기화로 통과시킨다 (fail-closed 가 과잉이 아님)', async () => {
    const res = await syncTodo({ projectRoot: root, planMarkdown: PLAN_THREE, now: fixedNow });

    expect(res.ok).toBe(true);
    expect(res.progress).toEqual({ total: 3, completed: 3, percentage: 100 });
  });
});
