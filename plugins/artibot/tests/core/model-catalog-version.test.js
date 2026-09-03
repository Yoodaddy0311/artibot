/**
 * `lib/core/model-catalog.js#CATALOG_VERSION` — 카탈로그 데이터의 버전 도장.
 *
 * 왜 별도 파일인가: `tests/core/model-catalog.test.js` 는 스펙 값(ID·가격·한도)을
 * 핀하는 기존 파일이고 이 작업의 소유 경로가 아니다. 버전 상수만 여기서 소유한다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ───────────────────────────────────────
 *  1. **소비.** 2026-09-02 기준 `CATALOG_VERSION` 을 읽는 코드는 **0개**다
 *     (소비처는 후속 작업 T-16/T-32). 이 파일이 그린이라는 것은 상수가 export
 *     된다는 뜻이지, 어떤 기록에 카탈로그 버전이 실제로 찍힌다는 뜻이 아니다.
 *  2. **신선도.** 아래 "MODELS 가 바뀌면 같이 올려라" 는 **규약**이고, 그것을
 *     기계로 강제하지는 않는다. 값 해시와 버전을 묶는 검사는 지금 없다 —
 *     즉 가격을 고치고 버전을 안 올린 커밋은 **이 테스트를 통과한다**. 그
 *     구멍을 메우려면 카탈로그 값 스냅샷 대조가 필요하고, 그건 기존
 *     `model-catalog.test.js` 의 값 핀과 겹치는 별도 결정이다.
 *  3. **날짜의 진위.** 형식이 `YYYY-MM-DD` 이고 실재 달력 날짜인지만 본다.
 *     그 날짜에 정말로 값을 검증했는지는 기계가 알 수 없다.
 *
 * @module tests/core/model-catalog-version
 */

import { describe, expect, it } from 'vitest';

import { CATALOG_VERSION, MODELS } from '../../lib/core/model-catalog.js';

describe('CATALOG_VERSION', () => {
  it('문자열로 export 된다', () => {
    expect(typeof CATALOG_VERSION).toBe('string');
    expect(CATALOG_VERSION).not.toBe('');
  });

  it('YYYY-MM-DD 형식이다 (semver 아님 — "언제 검증했나" 를 답하는 도장)', () => {
    expect(CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('실재하는 달력 날짜다 (2026-13-45 같은 값을 막는다)', () => {
    const parsed = new Date(`${CATALOG_VERSION}T00:00:00Z`);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // toISOString 왕복이 같아야 롤오버(02-30 → 03-02)를 잡는다.
    expect(parsed.toISOString().slice(0, 10)).toBe(CATALOG_VERSION);
  });

  it('카탈로그가 비어 있지 않다 (버전이 도장 찍을 대상이 실재하는 분모)', () => {
    // 버전만 있고 MODELS 가 비면 도장은 아무것도 증명하지 않는다.
    expect(Object.keys(MODELS).length).toBeGreaterThanOrEqual(4);
  });

  it('상수는 재할당되지 않는다 (모듈 export 는 읽기 전용 바인딩)', () => {
    const mod = { CATALOG_VERSION };
    expect(mod.CATALOG_VERSION).toBe(CATALOG_VERSION);
  });
});
