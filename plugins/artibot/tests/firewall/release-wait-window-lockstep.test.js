/**
 * 검사 목적: release.yml 착지 스텝의 `wait_for_green` 대기 한도가 JS 포트
 * `lib/git/batch-landing.js` 의 상수와 **같은 값**인지 고정한다.
 *
 * ── 이 게이트가 존재하는 이유 (실사건) ────────────────────────────────────────
 * 같은 계약의 두 구현이 따로 움직였다. 2026-09-28 에 JS 포트만 80회(20분)로
 * 올랐고 release.yml 은 40회(10분)로 남았다. Windows CI 잡이 중앙값 11.28 / 최대
 * 13.63분(2026-10-05 실측, 첫 시도 push 런 45건)이라 v4.71.2·v4.71.3 릴리스가
 * 둘 다 `pending=1 failed=0` 으로 한도에 걸려 수동 착지됐다(이슈 #121, #122).
 * 설계: `.artibot/guides/RELEASE-WAIT-WINDOW-DESIGN.md` R1·R2.
 *
 * ── 고정하는 것 ───────────────────────────────────────────────────────────────
 *   1. 착지 스텝의 **실행 셸**(주석 제거 후 — release.yml 주석이 옛 숫자를 문자
 *      그대로 인용한다)에 `WAIT_ATTEMPTS=<정수>` 와 `WAIT_POLL_SECONDS=<정수>`
 *      대입문이 각각 정확히 1개 있다.
 *   2. `N === WAIT_FOR_GREEN_ATTEMPTS`, `S * 1000 === WAIT_FOR_GREEN_POLL_MS`.
 *   3. `wait_for_green` 본문이 그 변수를 **실제로 쓴다**: `seq 1 "${WAIT_ATTEMPTS}"`,
 *      `sleep "${WAIT_POLL_SECONDS}"` 가 있고 숫자 리터럴 `seq 1 40` / `sleep 15`
 *      가 남아 있지 않다(변수를 선언만 하고 루프가 옛 리터럴을 쓰면 값 비교가
 *      거짓 그린이 된다).
 *   3-1. 고정 형식 밖의 두 번째 대입을 막는다: 실행 셸 **전체**에서 `WAIT_ATTEMPTS=` 와
 *      `WAIT_POLL_SECONDS=` 의 출현 수(단어 경계, `+=` 포함)가 각각 정확히 1이다.
 *      `WAIT_ATTEMPTS=40;`, `export WAIT_ATTEMPTS=40`, `WAIT_ATTEMPTS=$((40))`, 호출부
 *      접두 `WAIT_ATTEMPTS=40 wait_for_green …` 은 고정 형식 정규식에 안 걸리면서
 *      실효값을 바꾼다(감사관 실측: 전부 GREEN 이었다).
 *   4. fail-closed: 파일·스텝·함수·대입문 중 하나라도 없으면 RED. 단언은 전부
 *      추출값 대 기대값 정확 비교이고, 0건 매치는 위반으로 센다.
 *   5. 스캐너 자기검증: 같은 추출기를 **변조한 문자열 사본**에 돌려 위반이
 *      보고되는지 확인한다. 변조가 실제로 적용됐는지(원문과 달라졌는지)를 먼저
 *      단언한다 — 적용 안 된 변조의 "통과"는 아무 것도 증명하지 않는다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ───────────────────
 *   - **`wait_for_green` 의 다른 분기가 JS 포트와 같은지는 보지 않는다.**
 *     zero-poll 조기 종료(JS 에는 없다), 실패 판정, 빈 payload 처리의 동치성은
 *     `landing-serialization.test.js` 의 포트 테스트와 `release-landing-push-identity`
 *     게이트 4 가 따로 맡는다. 여기는 **두 숫자**만 본다.
 *   - **워크플로를 실행하지 않는다.** 셸 문법이 맞는지, 루프가 실제로 100회 돌고
 *     25분에서 멈추는지, `gh api` 가 실제로 무엇을 돌려주는지는 정적 문자열
 *     스캔으로 알 수 없다. 라이브 검증은 배지 변경이 있는 다음 실제 릴리스에서만
 *     가능하다(배지 변경이 없으면 착지 스텝이 skipped 라 대기창이 돌지 않는다).
 *   - **상한이 충분한지는 증명하지 않는다.** 두 복사본이 같다는 것뿐이다. 100회가
 *     Windows 잡보다 긴지는 2026-10-05 측정(최대 13.63분의 약 1.8배)이 근거이고,
 *     그 추세가 이어지면 이 값도 소진된다.
 *   - **루프를 잘라내는 파이프는 못 본다.** `seq 1 "${WAIT_ATTEMPTS}" | head -40` 처럼
 *     변수는 그대로 쓰면서 실효 반복 횟수를 줄이는 변경은 정적 검사로 일반 해법이
 *     없다. 대입문 출현 수(아래 4번)는 "두 번째 대입"만 막는다. `declare`/`printf -v`
 *     같은 다른 대입 형태도 같은 이유로 보지 않는다.
 *   - **PR 모드의 정지 감지기**(다른 스텝의 `seq 1 6` / `sleep 20`)는 이 스텝
 *     밖이라 보지 않는다.
 *   - **YAML 파서가 아니라 스텝 절단기**를 쓴다(`badge-stall-yaml-tools.js`). 스텝
 *     이름이 바뀌면 `sliceStep` 이 null 을 돌려 RED 가 되고, 그 경우 이름을 같이
 *     고쳐야 한다.
 *
 * @module tests/firewall/release-wait-window-lockstep
 */

import { describe, expect, it } from 'vitest';
import { executableShell, sliceStep, source } from './badge-stall-yaml-tools.js';
import {
  WAIT_FOR_GREEN_ATTEMPTS,
  WAIT_FOR_GREEN_POLL_MS,
} from '../../lib/git/batch-landing.js';

const FF_STEP = 'Land badge sync via ci/** side branch (PAT)';

/**
 * 워크플로 텍스트에서 대기창 설정을 뽑고, JS 상수와의 불일치·구조 위반을 모은다.
 *
 * @param {string | null} yaml 워크플로 전체 텍스트
 * @param {number} jsAttempts `WAIT_FOR_GREEN_ATTEMPTS`
 * @param {number} jsPollMs `WAIT_FOR_GREEN_POLL_MS`
 * @returns {{ violations: string[], attempts: number | null, pollSeconds: number | null }}
 */
function checkWaitWindow(yaml, jsAttempts, jsPollMs) {
  /** @type {string[]} */
  const violations = [];
  if (typeof yaml !== 'string' || yaml.length === 0) {
    return { violations: ['워크플로 텍스트가 비어 있다'], attempts: null, pollSeconds: null };
  }
  const body = sliceStep(yaml, FF_STEP);
  if (body === null) {
    return { violations: [`"${FF_STEP}" 스텝을 찾지 못했다`], attempts: null, pollSeconds: null };
  }
  const shell = executableShell(body);

  const attemptHits = [...shell.matchAll(/^\s*WAIT_ATTEMPTS=(\d+)\s*$/gm)].map((m) => Number(m[1]));
  const pollHits = [...shell.matchAll(/^\s*WAIT_POLL_SECONDS=(\d+)\s*$/gm)].map((m) => Number(m[1]));
  if (attemptHits.length !== 1) violations.push(`WAIT_ATTEMPTS 대입문이 ${attemptHits.length}개다 (정확히 1개여야 한다)`);
  if (pollHits.length !== 1) violations.push(`WAIT_POLL_SECONDS 대입문이 ${pollHits.length}개다 (정확히 1개여야 한다)`);
  // 고정 형식(한 줄 전체가 대입) 밖의 대입까지 센다: 출현 수가 1이 아니면 위반.
  for (const name of ['WAIT_ATTEMPTS', 'WAIT_POLL_SECONDS']) {
    const n = (shell.match(new RegExp(`\\b${name}\\+?=`, 'g')) ?? []).length;
    if (n !== 1) violations.push(`${name}= 출현이 실행 셸 전체에서 ${n}회다 (정확히 1회여야 한다)`);
  }
  const attempts = attemptHits.length === 1 ? attemptHits[0] : null;
  const pollSeconds = pollHits.length === 1 ? pollHits[0] : null;

  if (attempts !== null && attempts !== jsAttempts) {
    violations.push(`WAIT_ATTEMPTS=${attempts} 가 WAIT_FOR_GREEN_ATTEMPTS=${jsAttempts} 와 다르다`);
  }
  if (pollSeconds !== null && pollSeconds * 1000 !== jsPollMs) {
    violations.push(`WAIT_POLL_SECONDS=${pollSeconds} (${pollSeconds * 1000}ms) 가 WAIT_FOR_GREEN_POLL_MS=${jsPollMs} 와 다르다`);
  }

  const fnMatch = /^\s*wait_for_green\(\) \{\n([\s\S]*?)\n\s*\}$/m.exec(shell);
  if (!fnMatch) {
    violations.push('wait_for_green 함수 본문을 찾지 못했다');
  } else {
    const fn = fnMatch[1];
    if (!fn.includes('seq 1 "${WAIT_ATTEMPTS}"')) violations.push('루프가 seq 1 "${WAIT_ATTEMPTS}" 를 쓰지 않는다');
    if (!fn.includes('sleep "${WAIT_POLL_SECONDS}"')) violations.push('루프가 sleep "${WAIT_POLL_SECONDS}" 를 쓰지 않는다');
    for (const lit of fn.matchAll(/\bseq 1 \d+/g)) violations.push(`함수 안에 숫자 리터럴 "${lit[0]}" 이 남아 있다`);
    for (const lit of fn.matchAll(/\bsleep \d+/g)) violations.push(`함수 안에 숫자 리터럴 "${lit[0]}" 이 남아 있다`);
  }

  return { violations, attempts, pollSeconds };
}

/**
 * 문자열 사본을 변조한다. 대상이 정확히 1곳이 아니면 던진다 — 변조가 적용되지
 * 않은 채 "RED 가 났다/안 났다"를 읽는 것이 음성 대조의 fail-open 경로다.
 *
 * @param {string} yaml
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function mutate(yaml, from, to) {
  const hits = yaml.split(from).length - 1;
  if (hits !== 1) throw new Error(`변조 대상이 ${hits}곳이다 (정확히 1곳이어야 한다): ${from}`);
  const out = yaml.replace(from, () => to);
  if (out === yaml) throw new Error(`변조가 적용되지 않았다: ${from}`);
  return out;
}

describe('release.yml 대기창 ↔ batch-landing.js 락스텝', () => {
  it('release.yml 이 실재하고 착지 스텝이 정확히 1회 등장한다 (fail-closed)', () => {
    expect(typeof source).toBe('string');
    expect(source.length).toBeGreaterThan(1000);
    const hits = source.split(/\r?\n/).filter((l) => l.trim() === `- name: ${FF_STEP}`).length;
    expect(hits).toBe(1);
  });

  it('WAIT_ATTEMPTS / WAIT_POLL_SECONDS 가 JS 상수와 같다', () => {
    const { violations, attempts, pollSeconds } = checkWaitWindow(
      source, WAIT_FOR_GREEN_ATTEMPTS, WAIT_FOR_GREEN_POLL_MS,
    );
    expect(violations).toEqual([]);
    expect(attempts).toBe(WAIT_FOR_GREEN_ATTEMPTS);
    expect(pollSeconds * 1000).toBe(WAIT_FOR_GREEN_POLL_MS);
  });

  it('JS 상수가 정수 양수다 (NaN/0 이면 비교가 공허하다)', () => {
    expect(Number.isInteger(WAIT_FOR_GREEN_ATTEMPTS) && WAIT_FOR_GREEN_ATTEMPTS > 0).toBe(true);
    expect(Number.isInteger(WAIT_FOR_GREEN_POLL_MS) && WAIT_FOR_GREEN_POLL_MS > 0).toBe(true);
  });

  // ── 스캐너 자기검증 ─────────────────────────────────────────────────────────
  // 변조를 적용(mutate 가 적용 여부를 단언)한 사본에서 추출기가 위반을 보고해야
  // 한다. 무변조 대조군은 위반 0 이어야 한다 — 아니면 아래 RED 는 의미가 없다.
  describe('스캐너 자기검증', () => {
    const run = (yaml) => checkWaitWindow(yaml, WAIT_FOR_GREEN_ATTEMPTS, WAIT_FOR_GREEN_POLL_MS);
    const ASSIGN_ATTEMPTS = `WAIT_ATTEMPTS=${WAIT_FOR_GREEN_ATTEMPTS}`;
    const ASSIGN_POLL = `WAIT_POLL_SECONDS=${WAIT_FOR_GREEN_POLL_MS / 1000}`;

    it('무변조 대조군은 위반이 없다', () => {
      expect(run(source).violations).toEqual([]);
    });

    it('주석 제거기가 일한다: 원문에는 WAIT_ATTEMPTS 가 더 많이 나온다 (산문 포함)', () => {
      const body = sliceStep(source, FF_STEP);
      const raw = body.split('WAIT_ATTEMPTS').length - 1;
      const exec = executableShell(body).split('WAIT_ATTEMPTS').length - 1;
      expect(raw).toBeGreaterThan(exec);
    });

    it('WAIT_ATTEMPTS 를 40 으로 바꾸면 RED', () => {
      const bad = run(mutate(source, ASSIGN_ATTEMPTS, 'WAIT_ATTEMPTS=40'));
      expect(bad.violations.some((v) => v.includes('WAIT_ATTEMPTS=40'))).toBe(true);
    });

    it('WAIT_POLL_SECONDS 를 20 으로 바꾸면 RED', () => {
      const bad = run(mutate(source, ASSIGN_POLL, 'WAIT_POLL_SECONDS=20'));
      expect(bad.violations.some((v) => v.includes('WAIT_POLL_SECONDS=20'))).toBe(true);
    });

    it('대입문을 주석 처리하면 RED (주석은 대입이 아니다)', () => {
      const bad = run(mutate(source, `          ${ASSIGN_ATTEMPTS}`, `          # ${ASSIGN_ATTEMPTS}`));
      expect(bad.violations.some((v) => v.includes('WAIT_ATTEMPTS 대입문이 0개'))).toBe(true);
    });

    it('대입문이 둘이면 RED (어느 쪽이 쓰이는지 모호하다)', () => {
      const bad = run(mutate(source, `          ${ASSIGN_POLL}`, `          ${ASSIGN_POLL}\n          ${ASSIGN_POLL}`));
      expect(bad.violations.some((v) => v.includes('WAIT_POLL_SECONDS 대입문이 2개'))).toBe(true);
    });

    // 고정 형식 정규식(`^s*WAIT_ATTEMPTS=d+s*$`)에 안 걸리는 두 번째 대입 4종 + 호출부 접두.
    it.each([
      ['세미콜론이 붙은 두 번째 대입', ASSIGN_ATTEMPTS, `${ASSIGN_ATTEMPTS}
          WAIT_ATTEMPTS=40;`, 'WAIT_ATTEMPTS= 출현이 실행 셸 전체에서 2회'],
      ['export 한 두 번째 대입', ASSIGN_ATTEMPTS, `${ASSIGN_ATTEMPTS}
          export WAIT_ATTEMPTS=40`, 'WAIT_ATTEMPTS= 출현이 실행 셸 전체에서 2회'],
      ['산술식 두 번째 대입', ASSIGN_ATTEMPTS, `${ASSIGN_ATTEMPTS}
          WAIT_ATTEMPTS=$((40))`, 'WAIT_ATTEMPTS= 출현이 실행 셸 전체에서 2회'],
      ['호출부 접두 대입 (WAIT_ATTEMPTS)', 'wait_for_green "${SHA}" ||', 'WAIT_ATTEMPTS=40 wait_for_green "${SHA}" ||', 'WAIT_ATTEMPTS= 출현이 실행 셸 전체에서 2회'],
      ['호출부 접두 대입 (WAIT_POLL_SECONDS)', 'wait_for_green "${SHA}" ||', 'WAIT_POLL_SECONDS=1 wait_for_green "${SHA}" ||', 'WAIT_POLL_SECONDS= 출현이 실행 셸 전체에서 2회'],
    ])('고정 형식 밖의 %s 도 RED', (_name, from, to, expected) => {
      const bad = run(mutate(source, from, to));
      expect(bad.violations.some((v) => v.includes(expected))).toBe(true);
    });

    it('루프에 seq 1 40 리터럴이 되살아나면 RED (변수는 선언만 되고 안 쓰인다)', () => {
      const bad = run(mutate(source, 'seq 1 "${WAIT_ATTEMPTS}"', 'seq 1 40'));
      expect(bad.violations.some((v) => v.includes('seq 1 40'))).toBe(true);
    });

    it('루프에 sleep 15 리터럴이 되살아나면 RED', () => {
      const bad = run(mutate(source, 'sleep "${WAIT_POLL_SECONDS}"', 'sleep 15'));
      expect(bad.violations.some((v) => v.includes('sleep 15'))).toBe(true);
    });

    it('착지 스텝 이름이 바뀌면 RED (fail-closed)', () => {
      const bad = run(mutate(source, `- name: ${FF_STEP}`, '- name: Renamed landing step'));
      expect(bad.violations.some((v) => v.includes('스텝을 찾지 못했다'))).toBe(true);
    });

    it('빈 입력은 RED', () => {
      expect(run('').violations.length).toBeGreaterThan(0);
      expect(run(null).violations.length).toBeGreaterThan(0);
    });

    it('JS 쪽 상수가 어긋난 경우도 RED (80 / 30000ms)', () => {
      const a = checkWaitWindow(source, 80, WAIT_FOR_GREEN_POLL_MS);
      expect(a.violations.some((v) => v.includes('WAIT_FOR_GREEN_ATTEMPTS=80'))).toBe(true);
      const p = checkWaitWindow(source, WAIT_FOR_GREEN_ATTEMPTS, 30_000);
      expect(p.violations.some((v) => v.includes('WAIT_FOR_GREEN_POLL_MS=30000'))).toBe(true);
    });
  });
});
