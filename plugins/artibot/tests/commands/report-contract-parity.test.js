import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 팀원 보고 계약 — 스폰 경로 전체 커버리지 + 문구 드리프트 방지
//
// 계약이 /team 에만 있으면, autopilot·ultraplan·sc 로 뜬 에이전트는 더 약한
// 계약으로 일한다. 그러면 "표준"이 후퇴 기준선이 된다 — 실제로 이 세션의
// 즉석 스폰 프롬프트가 표준 계약보다 강했던 것이 그 증상이었다.
//
// 각 커맨드 파일은 자기 완결적으로 계약 블록을 들고 있다(참조 방식이 아니다):
// /autopilot 만 실행한 세션의 리더는 team.md 를 읽지 않기 때문이다. 자기 완결의
// 대가는 중복이고, 중복의 위험은 드리프트다 — 그 드리프트를 이 테스트가 잡는다.
// ---------------------------------------------------------------------------

const COMMANDS_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'commands');

/** team.md 가 정본, 나머지는 문자 단위로 같아야 한다 */
const CANONICAL = 'team.md';
const CARRIERS = ['team.md', 'autopilot.md', 'ultraplan.md', 'sc.md'];

const read = (f) => readFileSync(path.join(COMMANDS_DIR, f), 'utf-8');

/** ```-펜스 안의 `[보고 계약]` 블록을 추출 */
function extractContract(src) {
  const m = src.match(/```\r?\n(\[보고 계약\][\s\S]*?)\r?\n```/);
  return m ? m[1].replace(/\r\n/g, '\n').trim() : null;
}

/**
 * `prompt="..."` 문자열 전체를 추출 (여러 줄에 걸친 것 포함).
 * 종결자가 `")` 인 것과 `",` 인 것이 둘 다 존재한다.
 */
function extractPrompts(src) {
  const out = [];
  const re = /prompt="([\s\S]*?)"\s*[,)]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

const contracts = Object.fromEntries(CARRIERS.map((f) => [f, extractContract(read(f))]));

describe('보고 계약/블록 존재', () => {
  it.each(CARRIERS)('%s 에 [보고 계약] 블록이 있다', (f) => {
    expect(contracts[f], `${f} 에서 계약 블록 추출 실패`).not.toBeNull();
  });
});

describe('보고 계약/문구 파리티', () => {
  it.each(CARRIERS.filter((f) => f !== CANONICAL))(
    '%s 의 계약이 team.md 와 문자 단위로 동일하다',
    (f) => {
      expect(contracts[f]).toBe(contracts[CANONICAL]);
    },
  );
});

describe('보고 계약/필수 조항', () => {
  // 조항이 조용히 빠지는 것을 막는다. 각 항목은 계약이 존재하는 이유 하나씩에 대응한다.
  const REQUIRED = [
    ['보고 채널', /SendMessage\(to="\{리더 이름\}"\)/],
    ['분모+측정시각', /분모와 측정 시각/],
    ['발생률≠도달률', /발생률과 도달률을 구분/],
    ['file:line 유지', /file:line 으로 인용한다\(DEV Protocol\)/],
    ['동시편집 시 심볼명 병기', /심볼명과 측정 시각을 함께/],
    ['지시가 틀리면 보고', /틀렸으면 그대로 따르지 말고/],
    ['없는 것 고치지 마라', /없는 것을 고치지 마라/],
    ['미확인 줄', /`미확인:` 줄을 반드시 포함/],
  ];

  it.each(REQUIRED)('정본 계약에 "%s" 조항이 있다', (_label, re) => {
    expect(contracts[CANONICAL]).toMatch(re);
  });

  it('예시 타임스탬프는 실측처럼 보이는 값이 아니라 플레이스홀더다', () => {
    // 실제 ISO 값이 박혀 있으면 팀원이 그 시각을 그대로 복사해 보고한다.
    expect(contracts[CANONICAL]).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(contracts[CANONICAL]).toMatch(/\{측정시각\}/);
  });
});

describe('보고 계약/스폰 프롬프트 커버리지', () => {
  it.each(CARRIERS)('%s 의 모든 스폰 프롬프트가 계약을 실어 나른다', (f) => {
    const prompts = extractPrompts(read(f));
    expect(prompts.length, `${f} 에서 prompt= 를 하나도 못 찾았다`).toBeGreaterThan(0);
    const uncovered = prompts.filter((p) => !p.includes('{보고 계약}'));
    expect(uncovered, `계약 없는 스폰 프롬프트: ${JSON.stringify(uncovered)}`).toEqual([]);
  });

  it('4개 파일 합계 스폰 프롬프트 수가 기대치와 같다 (신규 경로 누락 감지)', () => {
    const total = CARRIERS.reduce((n, f) => n + extractPrompts(read(f)).length, 0);
    // team 4 + autopilot 3 + ultraplan 4 + sc 2 = 13.
    // 늘었는데 이 수가 안 맞으면 새 스폰 경로가 생겼다는 뜻 — 계약을 붙였는지 확인하라.
    expect(total).toBe(13);
  });
});
