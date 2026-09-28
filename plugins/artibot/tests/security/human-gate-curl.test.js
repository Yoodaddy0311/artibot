/**
 * `lib/security/human-gate-curl.js` 단위 테스트 — HG-07 curl loopback 증명(allowlist, fail-closed).
 *
 * 2026-09-28 human-gate-enforce.test.js 에서 이관(Stop 게이트 stem 규칙: 이 모듈의 커버는
 * `human-gate-curl.test.js` 여야 인정된다). 이관분은 describe·it 제목을 그대로 두어 두 파일의
 * 전체 이름 집합으로 중복·누락 0 을 대조할 수 있게 했다.
 *
 * 여기서 보는 것: curlProvenLoopbackOnly 의 증명됨/증명 실패 표, shellWords 의 따옴표·증명 불가
 * 글자 처리, 이 모듈의 순수성(금지 토큰 0 · import 0)과 그 스캐너의 자기검증.
 * decideHumanGate 를 거친 HG-07 판정 표는 human-gate-enforce.test.js 가, 상태기계 성장비 스윕은
 * human-gate-enforce-redos.test.js 가 소유한다.
 *
 * 이 파일이 못 보는 것: 모듈 헤더 "이 증명이 못 보는 것" 1~5(.curlrc·프록시 환경변수·이름
 * 해석·터널, curl 8.19.0 외 버전의 옵션 의미, 실트래픽 거짓 양성률).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { curlProvenLoopbackOnly, shellWords } from '../../lib/security/human-gate-curl.js';

describe('human-gate-curl — loopback 증명 (allowlist, fail-closed)', () => {
  it.each([
    ['기본', 'curl -X POST http://127.0.0.1'],
    ['https + 포트 + 경로', 'curl -X POST https://localhost:8443/a/b'],
    ['[::1] 따옴표', "curl -X POST 'http://[::1]:8080/x'"],
    ['맨 호스트:포트', 'curl -X POST 127.0.0.1:3000/hook'],
    ['값 옵션 값 건너뛰기(따옴표 속 @·공백)', `curl -X POST -H 'Authorization: Bearer a@b' -d "x y" http://127.0.0.1/`],
    ['플래그 묶음 + 긴 플래그', 'curl -sSk --fail --show-headers -X POST http://127.0.0.1/'],
  ])('증명됨: %s', (_label, command) => {
    expect(curlProvenLoopbackOnly(command)).toBe(true);
  });

  it.each([
    ['대상 없음', 'curl -X POST'],
    ['curl 아님', 'wget http://127.0.0.1'],
    ['앞에 환경변수', 'FOO=1 curl -X POST http://127.0.0.1'],
    ['인식 못 한 비옵션 단어', 'curl http://127.0.0.1 foo'],
    ['미지 옵션', 'curl --connect-to a:1:b:2 http://127.0.0.1'],
    ['userinfo', 'curl http://u@127.0.0.1'],
    ['스킴 ftp', 'curl ftp://127.0.0.1'],
    ['포트 비숫자', 'curl http://127.0.0.1:8o/'],
    ['옥텟 256', 'curl http://127.0.0.256/'],
    ['0.0.0.0', 'curl http://0.0.0.0/'],
    ['localhost.', 'curl http://localhost./'],
    ['큰따옴표 속 $', 'curl "http://127.0.0.1/$X"'],
    ['짝 없는 따옴표', "curl 'http://127.0.0.1"],
    ['따옴표 밖 &', 'curl http://127.0.0.1/?a=1&b=2'],
    ['비문자열', 42],
    ['-L 리다이렉트 추종 (307/308 이 POST 를 외부로 재전송 가능)', 'curl -L -X POST http://127.0.0.1/'],
    ['--location 긴 형', 'curl --location -X POST http://127.0.0.1/'],
    ['--include (curl 8.19 도움말에 없음)', 'curl --include -X POST http://127.0.0.1/'],
  ])('증명 실패: %s', (_label, command) => {
    expect(curlProvenLoopbackOnly(command)).toBe(false);
  });

  it('shellWords — 따옴표 결합·작은따옴표 속 특수문자는 글자, 증명 불가 글자는 null', () => {
    expect(shellWords(`a"b c"'d$e' f`)).toEqual(['ab cd$e', 'f']);
    expect(shellWords("''")).toEqual(['']);
    expect(shellWords('a\\b')).toBeNull();
    expect(shellWords('a;b')).toBeNull();
    expect(shellWords('a\nb')).toBeNull();
    expect(shellWords('a*')).toBeNull();
  });
});

// ── 순수성 핀 ──────────────────────────────────────────────────────────────
// 스캐너는 human-gate-enforce.test.js 와 형식만 같은 자급형 복사본이다(테스트 파일끼리 import
// 하지 않는다). 복사본이므로 이 파일 안에서 따로 자기검증한다.

const FORBIDDEN_IN_PURE_SOURCE = [
  ['process.', /\bprocess\s*\./],
  ['require(', /\brequire\s*\(/],
  ['dynamic import(', /\bimport\s*\(/],
  ["from 'node:*'", /\bfrom\s*['"]node:/],
  ["from 'fs'|'path'|'os'|'child_process'", /\bfrom\s*['"](?:fs|path|os|child_process)(?:\/[a-z]+)?['"]/],
  ['Date', /\bDate\b/],
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['globalThis', /\bglobalThis\b/],
];

/** 블록·줄 주석을 지운다. `://` 뒤의 `//` 는 주석으로 보지 않는다. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

const scanPurity = (source) => {
  const code = stripComments(source);
  return FORBIDDEN_IN_PURE_SOURCE.filter(([, re]) => re.test(code)).map(([label]) => label);
};

describe('순수성 핀 — I/O·env·시계·난수·node 내장 로딩 0', () => {
  it.each([
    ['human-gate-curl.js'],
  ])('%s 소스(주석 제거 후)에 금지 토큰이 없다', (file) => {
    const source = readFileSync(new URL(`../../lib/security/${file}`, import.meta.url), 'utf8');
    expect(source.length).toBeGreaterThan(1000);
    expect(scanPurity(source)).toEqual([]);
  });

  it('human-gate-curl.js 는 아무것도 import 하지 않는다', () => {
    const source = readFileSync(new URL('../../lib/security/human-gate-curl.js', import.meta.url), 'utf8');
    expect(stripComments(source)).not.toMatch(/^\s*import\b/m);
  });

  it('스캐너 복사본 자기검증 — 금지 토큰마다 잡고, 주석 속 언급은 잡지 않으며, import 핀도 잡는다', () => {
    const broken = [
      ['process.', 'const a = process.env.CLAUDE_PLUGIN_ROOT;'],
      ['require(', "const fs = require('fs');"],
      ['dynamic import(', "const m = await import('./x.js');"],
      ["from 'node:*'", "import { readFileSync } from 'node:fs';"],
      ["from 'fs'|'path'|'os'|'child_process'", "import path from 'path';"],
      ['Date', 'const now = new Date();'],
      ['Math.random', 'const r = Math.random();'],
      ['globalThis', 'const g = globalThis.x;'],
    ];
    for (const [label, source] of broken) expect(scanPurity(source)).toEqual([label]);
    expect(scanPurity('/* process.env */ const x = 1;\n// new Date()\nconst y = 2;')).toEqual([]);
    expect(stripComments("/* import x */\nimport { a } from './a.js';")).toMatch(/^\s*import\b/m);
    expect(stripComments('/* import x */\nconst a = 1;')).not.toMatch(/^\s*import\b/m);
  });
});
