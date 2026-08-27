/**
 * Firewall — `/split` 산문이 텔레메트리 recorder 를 실제로 싣고 있는가 (`commands/split.md`).
 *
 * ── 왜 이 게이트가 필요한가 ─────────────────────────────────────────────────
 * probe 팀원 실증(2026-08-27): **`commands/split.md` 에서 `recordPhaseStart(...)` 등
 * recorder 호출을 전부 지워도 리포의 모든 게이트가 그린이다.** 기존
 * `split-telemetry-wallclock.test.js` 는 recorder **엔진**을 검증한다 — 함수를 직접
 * import 해 tmpdir `storeDir` 에 이벤트를 쓰고 요약을 확인한다(그 파일이 읽는 것은
 * `ENGINE_PATH`·`TELEMETRY_PATH`·`SPLIT_TELEMETRY_PATH` 이고 `commands/split.md` 는
 * 한 번도 읽지 않는다). 즉 **호출부 쪽이 통째로 비어 있다.**
 *
 * 그 파일 헤더가 스스로 적어둔 문장이 정확히 이 구멍이다:
 *   "A recorder nobody invokes writes nothing; existence is not operation."
 * 엔진 테스트는 그 명제를 **선언만** 했고 호출부를 잠그지는 않았다. 이 파일이 잠근다.
 * 따라서 중복이 아니라 반대편이다 — 엔진(그쪽) ↔ 호출부(이쪽).
 *
 * 두 번째 축은 **이름 드리프트**다. 산문이 실존하지 않는 recorder 이름을 부르면
 * 실런에서 조용히 죽고, 반대로 모듈에 새 recorder 를 추가하고 산문에 배선하지 않으면
 * 영영 호출되지 않는다. 양방향으로 대조한다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ──────────────────
 *
 *  1. **모델이 산문을 실제로 따르는지는 못 본다.** `/split` 은 코드가 아니라 지시문이다.
 *     문서에 적혀 있다 ≠ 실런에서 호출된다. 그것은 라이브 런의 `split-events` 파일
 *     (`getSplitEventsPath`) 을 읽어야만 안다 — 이 파일은 산문의 존재만 본다.
 *  2. **호출 순서·인자값의 의미는 안 본다.** 정규식 카운트다. `recordPhaseEnd` 를
 *     `recordPhaseStart` 보다 먼저 적어도 통과한다.
 *  3. **`RESUME` phase 는 쌍으로 잠기지 않는다.** `split.md` 가 그 절만
 *     "→ `recordPhaseEnd`" 라는 **약식**으로 적어 phase 인자가 없다(2026-08-27 실측:
 *     `recordPhaseStart(runId, 'RESUME'` 1건 / `recordPhaseEnd(runId, 'RESUME'` 0건).
 *     그래서 PAIRED_PHASES 는 4개뿐이다. 약식을 정식으로 바꾸려면 문서를 먼저 고치고
 *     여기 배열에 'RESUME' 을 추가하라 — 이 주석을 지우고 통과시키지 마라.
 *  4. **`wait-limbs`·`confirm-integrate` 세그먼트도 쌍이 아니라 존재만 본다.** 같은 이유로
 *     닫는 쪽이 약식이다. 미쌍 세그먼트는 엔진이 `null` 로 남기는 **정상 상태**이기도 해서
 *     (`split-telemetry-wallclock.test.js` 의 unpaired 케이스) 쌍을 강제하지 않는다.
 *  5. **카운트 래칫은 삭제만 잡는다.** 아래 FLOORS 는 2026-08-27 실측값이다. 호출을
 *     늘리면 통과하고 줄이면 red 다. 호출을 **다른 것으로 바꿔치기**하는 변경은 못 본다.
 *  6. **다른 커맨드 문서는 안 본다.** `autopilot.md` 등의 텔레메트리 배선은 범위 밖이다.
 *  7. **양방향 대조는 "split 전용 모듈" 전제 위에서만 옳다.** "모듈의 `record*` export 중
 *     산문에 배선되지 않은 것이 없다" 단언은 `lib/observability/split-telemetry.js` 가
 *     **`/split` 전용**이라는 전제에 의존한다. 그 모듈에 다른 소비자용 recorder 가
 *     추가되면 이 단언은 **거짓 red** 를 낸다 — 그때의 정답은 단언을 지우는 것이 아니라
 *     소비자별로 기대 집합을 나누는 것이다. 전제가 깨졌는지는 그 모듈의 import 元을
 *     세어 확인하라 — 2026-08-27 기준 **프로덕션 JS import 는 0건**이고(recorder 는
 *     오직 `commands/산문`에서만 호출된다 — 이 게이트가 필요한 이유 그 자체다),
 *     `lib/observability/run-events.js:13` 이 이 모듈을 "`/split` runs" 로 문서화한다.
 *     반대 방향(산문이 실존하지 않는 이름을 부른다)은 전제와 무관하게 항상 옳다.
 *
 * @module tests/firewall/split-telemetry-callsites
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// CRLF 정규화는 **읽기 지점에서 한 번만** 한다. Windows CI 러너는 autocrlf 로 CRLF
// 체크아웃을 만들므로, 원문에 `\n` 하드코딩 정규식을 대면 러너 OS 에 따라 결과가 갈린다
// (선례: 커밋 24970419 — split-window-contract 가 같은 이유로 red 였다).
// 케이스별로 정규화하면 새 케이스가 정규화를 빼먹는 함정이 남는다.
const read = (rel) => readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');

// 파일 부재·읽기 실패는 fail-closed — 조용한 스킵 가드를 두지 않는다.
const splitMd = read('commands/split.md');
const telemetrySrc = read('lib/observability/split-telemetry.js');

/** 산문이 실어야 하는 recorder 5종. */
const RECORDERS = [
  'recordFastProfilePlanned',
  'recordPhaseStart',
  'recordPhaseEnd',
  'recordWallClockStart',
  'recordWallClockEnd',
];

/**
 * 삭제 방지 래칫 — 2026-08-27 `commands/split.md` 실측 호출 수.
 * 늘리는 변경은 통과, 줄이는 변경은 red. 의식적으로 줄이려면 이 값을 함께 낮춰라.
 */
const FLOORS = Object.freeze({
  recordFastProfilePlanned: 1,
  recordPhaseStart: 5,
  recordPhaseEnd: 6,
  recordWallClockStart: 4,
  recordWallClockEnd: 5,
});

/** phase 인자까지 명시적으로 쌍을 이루는 phase (RESUME 은 약식 — 헤더 3항). */
const PAIRED_PHASES = ['PLAN', 'OPEN', 'DISPATCH', 'INTEGRATE'];

/** 산문에 반드시 등장해야 하는 wall-clock 세그먼트 표기. */
const SEGMENTS = ['RUN_SEGMENT', "'open-windows'", "'wait-limbs'", "'confirm-integrate'"];

/** 겹치지 않는 부분문자열 출현 횟수 (정규식 이스케이프 회피 — split 기반). */
export function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** 문서 하나에 대한 recorder 카운트 맵. */
export function countRecorders(md) {
  return Object.fromEntries(RECORDERS.map((n) => [n, countOccurrences(md, n)]));
}

describe('firewall / split.md 가 recorder 5종을 싣고 있다', () => {
  it.each(RECORDERS)('%s 호출이 산문에 존재한다', (name) => {
    expect(countOccurrences(splitMd, name)).toBeGreaterThan(0);
  });

  it('호출 수가 2026-08-27 래칫 이상이다 (삭제 방지)', () => {
    for (const [name, floor] of Object.entries(FLOORS)) {
      expect(countOccurrences(splitMd, name), `${name} 호출 수가 래칫 ${floor} 아래로 떨어졌다`)
        .toBeGreaterThanOrEqual(floor);
    }
  });
});

describe('firewall / recorder 이름이 모듈 export 와 양방향 일치한다', () => {
  it.each(RECORDERS)('%s 는 split-telemetry.js 의 실제 export 다', (name) => {
    expect(telemetrySrc).toContain(`export function ${name}(`);
  });

  it('모듈의 record* export 중 산문에 배선되지 않은 것이 없다', () => {
    const exported = [...telemetrySrc.matchAll(/^export function (record[A-Za-z]*)\(/gm)]
      .map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(0); // 스캐너가 0건이면 자체가 무의미
    const unwired = exported.filter((n) => countOccurrences(splitMd, n) === 0);
    expect(unwired, `모듈에 있으나 split.md 가 부르지 않는 recorder: ${unwired.join(', ')}`)
      .toEqual([]);
  });
});

describe('firewall / phase 와 세그먼트 표기', () => {
  it.each(PAIRED_PHASES)("%s 는 start/end 가 phase 인자까지 짝을 이룬다", (phase) => {
    expect(countOccurrences(splitMd, `recordPhaseStart(runId, '${phase}'`)).toBeGreaterThan(0);
    expect(countOccurrences(splitMd, `recordPhaseEnd(runId, '${phase}'`)).toBeGreaterThan(0);
  });

  it.each(SEGMENTS)('세그먼트 %s 표기가 산문에 있다', (seg) => {
    expect(countOccurrences(splitMd, seg)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 스캐너 자기검증 (rules §10 — 게이트가 거짓 그린이 되지 않게)
// ---------------------------------------------------------------------------

describe('firewall / 스캐너 자기검증', () => {
  it('recorder 를 지운 사본에서는 카운트가 0 이 된다 (게이트가 실제로 결합돼 있다)', () => {
    // probe 가 실증한 삭제 공격을 메모리에서 재현한다 — 디스크는 건드리지 않는다.
    let mutated = splitMd;
    for (const name of RECORDERS) mutated = mutated.split(name).join('recordNOOP');

    expect(countRecorders(mutated)).toEqual({
      recordFastProfilePlanned: 0,
      recordPhaseStart: 0,
      recordPhaseEnd: 0,
      recordWallClockStart: 0,
      recordWallClockEnd: 0,
    });
    // 그리고 래칫 단언이 이 사본에서 실패해야 한다.
    for (const [name, floor] of Object.entries(FLOORS)) {
      expect(countOccurrences(mutated, name)).toBeLessThan(floor);
    }
  });

  it('countOccurrences 가 겹치지 않는 출현을 정확히 센다', () => {
    expect(countOccurrences('aXbXc', 'X')).toBe(2);
    expect(countOccurrences('none here', 'X')).toBe(0);
    expect(countOccurrences('aaa', 'aa')).toBe(1); // 겹침은 세지 않는다
  });

  it('읽기 지점 정규화가 걸려 있어 원문에 CR 이 남지 않는다', () => {
    // `\n` 하드코딩 단언이 Windows 러너에서만 red 가 되는 사고(24970419)의 재발 방지.
    expect(splitMd).not.toContain('\r');
    expect(telemetrySrc).not.toContain('\r');
  });
});
