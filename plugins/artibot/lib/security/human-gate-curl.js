/**
 * HG-07 curl loopback **증명** — `human-gate-enforce.js` 에서 분리(CA-04 L1, review2 B1~B3).
 *
 * 질문 하나에만 답한다: "이 Bash 명령은 loopback 만을 대상으로 하는 단일 curl 호출임이
 * **증명**되는가?" 참이면 HG-07 curl 행을 비보호로 둘 수 있고, 거짓이면 보호다. 인식하지
 * 못한 것이 하나라도 있으면 거짓이다(allowlist · fail-closed). 옛 구현은 스킴 URL·호스트 모양
 * 토큰만 뽑고 나머지를 무시했다 — 부정 목록이라 `--connect-to`·userinfo·점 없는 호스트·192자
 * 캡 너머가 전부 loopback 으로 통과했다(review2 재현 2026-09-28 19:40).
 *
 * ── 증명 규칙 ───────────────────────────────────────────────────────────────
 *  1. shellWords: 명령 전체를 셸 단어로 나눈다. 작은따옴표 안은 글자 그대로, 큰따옴표 안은
 *     `$`·백틱·역슬래시가 증명 불가. 따옴표 밖은 글자 allowlist(영숫자 + `_.:/@%=+~#^,-`)와
 *     공백·탭만 — 그 밖(체인·리다이렉트·개행·glob·brace·`$`·역슬래시)과 짝 없는 따옴표는 null.
 *  2. 첫 단어가 정확히 `curl`.
 *  3. 나머지 단어: CURL_VALUE_OPTIONS 면 다음 단어(값)를 건너뛰고, `--opt=값`·`-X값` 은 그 자체로
 *     값 붙은 옵션. CURL_FLAG_OPTIONS·CURL_SHORT_FLAGS(묶음 가능)는 무인자 플래그. 그 밖의
 *     옵션은 전부 증명 불가(--connect-to·--resolve·-x·--proxy·-K·--config·--next …).
 *  4. 옵션이 아닌 단어는 loopback 대상이어야 한다: http·https 스킴 또는 스킴 없음, authority 에
 *     `@`·역슬래시 없음, host ∈ 127.0.0.0/8 · localhost · [::1], 포트는 숫자 1~5자리.
 *  5. 대상이 1개 이상.
 *  길이 캡 없음 — 전부 선형 1패스 문자열 연산(정규식 0). 성능 증거는 ReDoS 카탈로그가 아니라
 *  tests/security/human-gate-enforce-redos.test.js 의 상태 전이 최대화 필러 스윕이다.
 *
 * ── 순수성 · 호출자 ─────────────────────────────────────────────────────────
 *  I/O·환경변수·시계·난수·node 내장 로딩 0, import 0. 호출자는 lib/security/human-gate-enforce.js
 *  (hg07InScope) 하나뿐이고, 그 모듈 자체가 L2 배선 전이라 프로덕션 호출자는 0 이다.
 *  tests/security/human-gate-enforce.test.js 의 순수성 스캔이 이 파일도 스캔한다.
 *
 * ── 이 증명이 못 보는 것 ────────────────────────────────────────────────────
 *  1. 명령 밖의 curl 설정: `~/.curlrc`·`CURL_HOME`(proxy·connect-to·resolve 를 넣을 수 있다),
 *     `http_proxy`·`HTTPS_PROXY`·`ALL_PROXY` 환경변수 — loopback URL 도 프록시로 나갈 수 있다.
 *  2. 이름 해석: `localhost` 가 hosts 파일로 다른 주소를 가리키는 경우.
 *  3. loopback 포트 뒤의 전달: SSH `-L` 터널·로컬 프록시·포트 포워딩으로 loopback 쓰기가
 *     외부에 닿는 경우 — 주소만 보고 도달 범위는 모른다.
 *  4. 목록의 정확성: CURL_FLAG_OPTIONS·CURL_SHORT_FLAGS(무인자)·CURL_VALUE_OPTIONS(인자 1개)는
 *     2026-09-28 로컬 curl 8.19.0(x86_64-w64-mingw32) `curl --help all` 과 대조했다 — 전부 일치.
 *     다른 curl 버전의 옵션 의미 차이는 미확인이다. 목록 밖은 보호 쪽이라 틀려도 fail-closed.
 *  5. 거짓 양성: 따옴표 없는 `?`·`&`·`*` 가 든 URL, 목록 밖 무해 옵션(`--max-time 5` 등)은 보호.
 *
 * @module lib/security/human-gate-curl
 */

/** 값이 전송 대상이 아닌 curl 옵션 — 다음 단어(또는 `--opt=값`·`-X값`)는 증명 대상에서 뺀다. */
export const CURL_VALUE_OPTIONS = Object.freeze([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary',
  '--data-urlencode', '--json', '-F', '--form', '-o', '--output', '-u', '--user',
  '-A', '--user-agent', '-w', '--write-out',
]);

/**
 * 인자를 받지 않는 curl 긴 옵션. 이 목록·CURL_VALUE_OPTIONS 밖의 옵션은 loopback 증명 불가.
 * `--location`(-L)은 뺐다 — 리다이렉트를 따라가므로 loopback 서버가 307/308 로 POST 본문을
 * 외부 호스트에 다시 보내게 할 수 있다. `--include` 는 curl 8.19.0 도움말에 없어(`--show-headers`
 * 로 개명) 뺐다.
 */
export const CURL_FLAG_OPTIONS = Object.freeze([
  '--silent', '--show-error', '--verbose', '--insecure', '--show-headers', '--fail', '--fail-with-body',
  '--globoff', '--compressed', '--no-buffer', '--http1.1', '--http2', '--ipv4', '--ipv6',
]);

/** 인자를 받지 않는 curl 짧은 옵션 글자(`-sSk` 처럼 묶어 써도 된다). `L` 은 위 이유로 없다. */
export const CURL_SHORT_FLAGS = 'sSvkifgN46';

/** @param {string} ch @returns {boolean} */
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

/** 따옴표 밖에서 그대로 두어도 셸이 확장·분리하지 않는 글자(allowlist). */
function isPlainUnquotedChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || isDigit(ch) || '_.:/@%=+~#^,-'.includes(ch);
}

/**
 * 따옴표를 벗긴 셸 단어. 증명 불가(확장·치환·체인·개행·glob·역슬래시·짝 없는 따옴표)면 null.
 * 선형 1패스 — 단어는 지역 배열에 push, 글자는 문자열 이어 붙이기.
 * @param {string} command
 * @returns {string[]|null}
 */
export function shellWords(command) {
  const words = [];
  let current = null;
  let quote = null;
  for (const ch of command) {
    if (quote !== null && ch === quote) {
      quote = null;
    } else if (quote !== null) {
      if (quote === '"' && (ch === '$' || ch === '`' || ch === '\\')) return null;
      current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current = current ?? '';
    } else if (ch === ' ' || ch === '\t') {
      if (current !== null) words.push(current);
      current = null;
    } else if (isPlainUnquotedChar(ch)) {
      current = (current ?? '') + ch;
    } else {
      return null;
    }
  }
  if (quote !== null) return null;
  if (current !== null) words.push(current);
  return words;
}

/** @param {string} word @returns {'value'|'value-attached'|'flag'|'target'|'unknown'} */
function curlWordKind(word) {
  if (!word.startsWith('-') || word === '-') return 'target';
  if (CURL_VALUE_OPTIONS.includes(word)) return 'value';
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    if (eq !== -1) return CURL_VALUE_OPTIONS.includes(word.slice(0, eq)) ? 'value-attached' : 'unknown';
    return CURL_FLAG_OPTIONS.includes(word) ? 'flag' : 'unknown';
  }
  if (CURL_VALUE_OPTIONS.includes(word.slice(0, 2))) return 'value-attached';
  return [...word.slice(1)].every((ch) => CURL_SHORT_FLAGS.includes(ch)) ? 'flag' : 'unknown';
}

/** 127.0.0.0/8 — 점 4조각, 각 1~3자리 숫자 ≤255, 첫 조각 127. */
function isIpv4Loopback(host) {
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127'
    && octets.every((o) => o.length >= 1 && o.length <= 3 && [...o].every(isDigit) && Number(o) <= 255);
}

/** @param {string} host @returns {boolean} */
function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || isIpv4Loopback(host);
}

/** `host[:port]` 이 loopback 으로 증명되는가. userinfo(`@`)·역슬래시·비숫자 포트는 증명 불가. */
function isLoopbackAuthority(authority) {
  if (authority.includes('@') || authority.includes('\\')) return false;
  const bracketed = authority.startsWith('[');
  const close = bracketed ? authority.indexOf(']') : -1;
  if (bracketed && close === -1) return false;
  const colon = authority.indexOf(':');
  const hostEnd = bracketed ? close + 1 : (colon === -1 ? authority.length : colon);
  const host = bracketed ? authority.slice(1, close) : authority.slice(0, hostEnd);
  const port = authority.slice(hostEnd);
  const portOk = port === '' || (port.length >= 2 && port.length <= 6 && port[0] === ':'
    && [...port.slice(1)].every(isDigit));
  return portOk && isLoopbackHost(host);
}

/** curl 대상 단어(스킴 URL 또는 맨 호스트)가 loopback 으로 증명되는가. 스킴은 http·https 만. */
function isLoopbackTarget(word) {
  const lower = word.toLowerCase();
  const schemeEnd = lower.indexOf('://');
  if (schemeEnd !== -1 && !['http', 'https'].includes(lower.slice(0, schemeEnd))) return false;
  const rest = schemeEnd === -1 ? lower : lower.slice(schemeEnd + 3);
  const cut = [...rest].findIndex((ch) => ch === '/' || ch === '?' || ch === '#');
  return isLoopbackAuthority(cut === -1 ? rest : rest.slice(0, cut));
}

/**
 * HG-07 loopback 증명. 참일 때만 호출자가 curl 행을 비보호로 둔다. 그 밖은 전부 거짓(보호).
 * @param {string} command
 * @returns {boolean}
 */
export function curlProvenLoopbackOnly(command) {
  if (typeof command !== 'string') return false;
  const words = shellWords(command.trim());
  if (words === null || words[0] !== 'curl') return false;
  let targets = 0;
  for (let i = 1; i < words.length; i += 1) {
    const kind = curlWordKind(words[i]);
    if (kind === 'value') i += 1;
    else if (kind === 'unknown' || (kind === 'target' && !isLoopbackTarget(words[i]))) return false;
    else if (kind === 'target') targets += 1;
  }
  return targets > 0;
}
