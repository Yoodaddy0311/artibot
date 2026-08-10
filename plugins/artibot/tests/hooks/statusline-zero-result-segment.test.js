import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// statusline 의 zero-result-guard 세그먼트 — 값 검증 계약
//
// 이 세그먼트가 지키는 두 가지:
//   1. 오염된 `fired` 는 절대 확신에 찬 숫자로 렌더되지 않는다. 특히 `"abc"` 가
//      `0` 으로 보이면 안 된다 — 파일 부재(숨김)와 구분 불가능해지고, 그게 이
//      세그먼트가 존재하는 이유 자체를 무너뜨린다.
//   2. plain(jq 분기)과 themed(node 전용)가 **같은 입력에 같은 답**을 낸다.
//      백엔드가 갈리면 사용자가 어느 렌더러를 쓰느냐에 따라 다른 사실을 본다.
//
// 표현식을 테스트에 복사하지 않고 **배포되는 sh 파일에서 추출**해 실행한다.
// 복사본을 테스트하면 코드가 바뀌어도 테스트는 옛 표현식을 계속 통과시킨다.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PLAIN_SH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh');
const THEMED_SH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline-themed.sh');

const plainSrc = readFileSync(PLAIN_SH, 'utf-8');
const themedSrc = readFileSync(THEMED_SH, 'utf-8');

/** `jq -r '<expr>'` 의 expr 를 소스에서 추출 */
function extractJqExpr(src) {
  const m = src.match(/jq -r '(if \(\.fired[\s\S]*?)' "\$file"/);
  return m ? m[1] : null;
}

/** `node -e "<expr>"` 중 fired 검증 표현식을 소스에서 추출 */
function extractNodeExpr(src) {
  const m = src.match(/node -e "(try\{const v=JSON\.parse[\s\S]*?)"/);
  return m ? m[1] : null;
}

const jqExpr = extractJqExpr(plainSrc);
const plainNodeExpr = extractNodeExpr(plainSrc);
const themedNodeExpr = extractNodeExpr(themedSrc);

const jqProbe = spawnSync('jq', ['--version'], { encoding: 'utf8' });
const hasJq = jqProbe.status === 0;

const runNode = (expr, json) => {
  const r = spawnSync(process.execPath, ['-e', expr], {
    encoding: 'utf8',
    env: { ...process.env, ARTIBOT_ZG_JSON: json },
  });
  return r.stdout ?? '';
};

const runJq = (expr, json) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-zg-jq-'));
  try {
    const f = path.join(dir, 'counter.json');
    writeFileSync(f, json);
    const r = spawnSync('jq', ['-r', expr, f], { encoding: 'utf8' });
    // 파싱 실패 시 jq 는 비정상 종료한다 — sh 쪽 `|| true` 와 같은 취급(빈 출력).
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// 입력 → 기대 라벨. 빈 문자열 = 세그먼트 숨김.
const CASES = [
  ['{"fired":7}', '7', '정상 카운트'],
  ['{"fired":0}', '0', 'fired 0 은 유효 상태 — 반드시 렌더된다'],
  ['{"fired":1}', '1', '경계: 1'],
  ['{"fired":2.7}', '2', '비정수는 floor'],
  ['{"fired":"abc"}', '', '문자열 오염 — 0 으로 렌더되면 안 된다'],
  ['{"fired":"7"}', '', '숫자형 문자열도 거부(쓰기 측은 항상 number)'],
  ['{"fired":-5}', '', '음수 카운트는 불가능한 상태'],
  ['{"fired":null}', '', 'null'],
  ['{"fired":{}}', '', '객체'],
  ['{"fired":[]}', '', '배열'],
  ['{}', '', 'fired 키 없음'],
  ['{"fired":1e999}', '', 'Infinity/거대값'],
  ['{"fired":9007199254740993}', '', 'safe integer 초과'],
  ['not-json{{{', '', '손상 JSON'],
  ['', '', '빈 파일'],
];

describe('statusline zero-result 세그먼트/표현식 추출', () => {
  it('배포 소스에서 jq·node 표현식을 실제로 추출할 수 있다', () => {
    expect(jqExpr, 'statusline.sh 의 jq 표현식').not.toBeNull();
    expect(plainNodeExpr, 'statusline.sh 의 node 표현식').not.toBeNull();
    expect(themedNodeExpr, 'statusline-themed.sh 의 node 표현식').not.toBeNull();
  });

  it('plain 과 themed 의 node 표현식이 문자 단위로 동일하다 (파리티)', () => {
    expect(themedNodeExpr).toBe(plainNodeExpr);
  });

  it('themed 에는 jq 분기가 없다 (파일 전체가 node 전용 관례)', () => {
    expect(themedSrc).not.toMatch(/\bjq -r\b/);
  });
});

describe('statusline zero-result 세그먼트/node 백엔드 값 검증', () => {
  it.each(CASES)('%s → %s (%s)', (json, expected) => {
    expect(runNode(plainNodeExpr, json)).toBe(expected);
  });

  it('오염값이 "0" 으로 렌더되지 않는다 (회귀 방지 — 양성 단언)', () => {
    for (const bad of ['{"fired":"abc"}', '{"fired":{}}', '{"fired":null}', '{}']) {
      const out = runNode(plainNodeExpr, bad);
      expect(out, `${bad} 가 숨겨져야 한다`).toBe('');
      expect(out).not.toBe('0');
    }
    // 대조군: 진짜 0 은 반드시 렌더된다 — 위 단언이 "전부 숨김"으로 통과하지 않게.
    expect(runNode(plainNodeExpr, '{"fired":0}')).toBe('0');
  });
});

describe.skipIf(!hasJq)('statusline zero-result 세그먼트/jq 백엔드 값 검증', () => {
  it.each(CASES)('%s → %s (%s)', (json, expected) => {
    expect(runJq(jqExpr, json)).toBe(expected);
  });
});

describe.skipIf(!hasJq)('statusline zero-result 세그먼트/백엔드 간 동답', () => {
  it.each(CASES)('%s 에서 jq 와 node 가 같은 답을 낸다', (json) => {
    expect(runJq(jqExpr, json)).toBe(runNode(plainNodeExpr, json));
  });
});
