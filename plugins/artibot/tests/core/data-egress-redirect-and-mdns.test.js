/**
 * 검사 목적: DATA POLICY egress 게이트의 **두 우회 경로** 폐쇄 고정.
 *
 * ── G-1: 리다이렉트 재검증 부재 (SSRF류) ─────────────────────────────────────
 * `safeFetch` 는 최초 URL 만 `assertEgressAllowed` 로 검사한 뒤 `fetch(url, init)`
 * 를 그대로 불렀다. Node fetch 의 기본값은 `redirect: 'follow'` 이고 이 리포
 * 프로덕션 코드에는 `redirect:` 를 지정하는 곳이 **0건**이다(실측 2026-08-30).
 * 따라서 allowlist 호스트가 302 를 내면 헤더·토큰을 실은 요청이 allowlist 밖으로
 * 나간다 — 모듈 헤더가 막았다고 주장하는 바로 그 "SSRF-style policy bypass" 다.
 * 토큰 실사용처: `scripts/hooks/http-notify.js` 사용자 헤더,
 * `lib/swarm/swarm-client.js` 의 `Authorization: Bearer`.
 *
 * ── G-2: `.local`(mDNS) 이 localhost 로 분류됨 ────────────────────────────────
 * `isLocalhost` 가 `*.local` 을 참으로 판정했고 JSDoc 이 이를 "local machine" 이라
 * **명시적으로 잘못** 서술했다. mDNS `.local` 은 정의상 LAN 의 **다른 기계**다.
 * 결과: `http://exfil.local/collect` 는 통과하는데 `http://192.168.1.50/collect`
 * 는 차단되는 비일관 — 같은 기계를 이름으로 부르면 정책이 사라졌다.
 * `fe80::/10`(link-local) 도 같은 성질이었고, URL 대괄호 때문에 **우연히** 막히던
 * 상태였다(`isLocalhost('fe80::1')`=true 인데 `assertEgressAllowed('http://[fe80::1]/')`
 * 는 blocked). 우연을 설계로 바꾼다.
 *
 * ── 이 테스트가 못 보는 것 (rules §9) ────────────────────────────────────────
 *  - **정책 단언 대부분은 `fetch` 스텁으로 잰다.** Node 의 실제 리다이렉트 구현이
 *    아니라 우리 루프의 판단만 검증한다. 실제 소켓 거동은 아래 로컬 서버 케이스
 *    하나뿐이고, 그것도 localhost→localhost 다.
 *  - **크로스-오리진 헤더 유출은 막지 않는다.** allowlist 안의 A→B 홉이면
 *    `Authorization` 이 B 로 따라간다. 모든 홉이 allowlist 라는 것과 홉마다
 *    자격증명을 줘도 된다는 것은 다른 진술이다. 현재는 전자만 보장한다.
 *  - **DNS 재바인딩은 여기서 새로 검증하지 않는다.** 기존 스위트가 덮는다 —
 *    다만 회귀 방지 단언 몇 개를 아래 남겨둔다.
 *  - **`0.0.0.0` 은 의도적으로 localhost 로 남긴다.** 의미상 unspecified 이지만
 *    connect 대상으로는 주요 OS 에서 루프백에 닿으므로 기계 밖으로 나가지
 *    못한다 — 이 게이트의 목적(유출 차단) 기준으로는 무해하다. 프로덕션 사용처
 *    실측 0건이라 제거해도 무해하지만, 근거 없이 좁히지 않는다.
 *
 * @module tests/core/data-egress-redirect-and-mdns
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertEgressAllowed,
  EgressBlockedError,
  isLocalhost,
  safeFetch,
} from '../../lib/core/data-egress-guard.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOW = ['api.github.com', 'raw.githubusercontent.com'];

let realFetch;
/** @type {Array<{url: string, init: object}>} */
let calls;

/** Install a fetch stub that replays a scripted list of responses. */
function stubFetch(responses) {
  calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
}

/** Build a minimal Response-like object the guard can read. */
function redirectTo(location, status = 302) {
  return { status, headers: { get: (k) => (k.toLowerCase() === 'location' ? location : null) } };
}
function ok(status = 200) {
  return { status, headers: { get: () => null } };
}

beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('G-2 — mDNS `.local` 은 로컬 기계가 아니다', () => {
  it('`.local` 은 localhost 가 아니다', () => {
    expect(isLocalhost('mybox.local')).toBe(false);
    expect(isLocalhost('printer.local')).toBe(false);
    expect(isLocalhost('exfil.local')).toBe(false);
  });

  it('`.local` 로의 egress 는 allowlist 없이는 차단된다', () => {
    expect(() => assertEgressAllowed('http://exfil.local/collect', { allowlist: ALLOW }))
      .toThrow(EgressBlockedError);
  });

  it('통제 비일관 해소 — 이름과 IP 가 같은 판정을 받는다', () => {
    // 결함의 핵심은 "같은 LAN 기계를 이름으로 부르면 통과"였다.
    const byName = () => assertEgressAllowed('http://box.local/x', { allowlist: ALLOW });
    const byIp = () => assertEgressAllowed('http://192.168.1.50/x', { allowlist: ALLOW });
    expect(byName).toThrow(EgressBlockedError);
    expect(byIp).toThrow(EgressBlockedError);
  });

  it('명시 등재하면 통과한다 (opt-in 경로는 살아 있다)', () => {
    expect(assertEgressAllowed('http://printer.local/status', {
      allowlist: [...ALLOW, 'printer.local'],
    })).toBe(true);
  });

  it('link-local fe80::/10 도 localhost 가 아니다 (우연 → 설계)', () => {
    expect(isLocalhost('fe80::1')).toBe(false);
    expect(isLocalhost('fe80::abcd:1234')).toBe(false);
    expect(() => assertEgressAllowed('http://[fe80::1]/', { allowlist: ALLOW }))
      .toThrow(EgressBlockedError);
  });

  it('과잉교정 방지 — 정당한 루프백은 전부 유지된다', () => {
    for (const h of ['localhost', '127.0.0.1', '127.0.0.53', '::1', '[::1]', '0.0.0.0']) {
      expect(isLocalhost(h), `${h} 는 루프백이어야 한다`).toBe(true);
    }
    expect(assertEgressAllowed('http://127.0.0.1:41300/dashboard', { allowlist: [] })).toBe(true);
    expect(assertEgressAllowed('http://localhost:41300/', { allowlist: [] })).toBe(true);
    expect(assertEgressAllowed('http://[::1]:41300/', { allowlist: [] })).toBe(true);
  });

  it('DNS 재바인딩 사칭 회귀 방지', () => {
    for (const h of ['127.evil.com', 'localhost.evil.com', 'foo.local.evil.com',
      'fe80.evil.com', 'not-fe80::1', '.local', 'foo..local']) {
      expect(isLocalhost(h), `${h} 는 거부돼야 한다`).toBe(false);
    }
  });
});

describe('G-1 — 리다이렉트는 홉마다 재검증된다', () => {
  it('정책을 호출자 재량에 맡기지 않는다: redirect 는 항상 manual', async () => {
    stubFetch([ok()]);
    await safeFetch('https://api.github.com/x', { redirect: 'follow' }, { allowlist: ALLOW });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect, '호출자의 redirect 를 덮어써야 한다').toBe('manual');
  });

  it('allowlist 밖으로 나가는 302 를 차단한다 (핵심 결함)', async () => {
    stubFetch([redirectTo('https://evil.example.com/collect'), ok()]);
    await expect(safeFetch('https://api.github.com/x', {}, { allowlist: ALLOW }))
      .rejects.toThrow(EgressBlockedError);
    // 두 번째 fetch 가 아예 일어나지 않아야 한다 — 요청이 나간 뒤 막는 것은 무의미하다.
    expect(calls, 'allowlist 밖 홉으로 요청이 나갔다').toHaveLength(1);
  });

  it('allowlist 안의 홉은 따라간다', async () => {
    stubFetch([redirectTo('https://raw.githubusercontent.com/f'), ok()]);
    const res = await safeFetch('https://api.github.com/x', {}, { allowlist: ALLOW });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/x',
      'https://raw.githubusercontent.com/f',
    ]);
  });

  it('상대 Location 을 현재 URL 기준으로 해석한다', async () => {
    stubFetch([redirectTo('/other/path'), ok()]);
    await safeFetch('https://api.github.com/a/b', {}, { allowlist: ALLOW });
    expect(calls[1].url).toBe('https://api.github.com/other/path');
  });

  it('상대 Location 으로 호스트를 바꿔치기해도 차단된다', async () => {
    stubFetch([redirectTo('//evil.example.com/x'), ok()]);
    await expect(safeFetch('https://api.github.com/a', {}, { allowlist: ALLOW }))
      .rejects.toThrow(EgressBlockedError);
    expect(calls).toHaveLength(1);
  });

  it('홉 상한을 넘기면 fail-closed 로 throw 한다', async () => {
    // 같은 allowlist 호스트로 무한 리다이렉트.
    stubFetch([redirectTo('https://api.github.com/loop')]);
    await expect(safeFetch('https://api.github.com/loop', {}, { allowlist: ALLOW }))
      .rejects.toThrow(EgressBlockedError);
    expect(calls.length).toBeLessThanOrEqual(6); // 최초 + 홉 상한 5
  });

  it('30x 가 아니면 그대로 돌려준다', async () => {
    stubFetch([ok(204)]);
    const res = await safeFetch('https://api.github.com/x', {}, { allowlist: ALLOW });
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(1);
  });

  it('Location 없는 30x 는 따라가지 않고 응답을 그대로 준다', async () => {
    stubFetch([{ status: 302, headers: { get: () => null } }]);
    const res = await safeFetch('https://api.github.com/x', {}, { allowlist: ALLOW });
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it('303 은 GET 으로 바꾸고 본문을 버린다 (fetch 사양)', async () => {
    stubFetch([redirectTo('https://api.github.com/after', 303), ok()]);
    await safeFetch('https://api.github.com/x',
      { method: 'POST', body: 'payload' }, { allowlist: ALLOW });
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].init.body).toBeUndefined();
  });

  it('307/308 은 메서드와 본문을 보존한다', async () => {
    stubFetch([redirectTo('https://api.github.com/after', 307), ok()]);
    await safeFetch('https://api.github.com/x',
      { method: 'POST', body: 'payload' }, { allowlist: ALLOW });
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].init.body).toBe('payload');
  });

  it('최초 URL 차단은 네트워크 I/O 이전에 일어난다 (기존 계약 회귀 방지)', async () => {
    stubFetch([ok()]);
    await expect(safeFetch('https://evil.example.com/', {}, { allowlist: ALLOW }))
      .rejects.toThrow(EgressBlockedError);
    expect(calls).toHaveLength(0);
  });
});

describe('G-3 배선 — 보호가 실제 호출부에 걸린다', () => {
  // 이번 결함의 교훈이 "함수만 고치고 배선을 안 했다"였다. safeFetch 를 단단히
  // 만든 것과 프로덕션 경로가 그걸 통과하는 것은 다른 진술이므로, 실제 호출부
  // 하나를 끝까지 몰아본다. 가드는 진짜를 쓴다(모킹하지 않는다).
  it('http-notify: 웹훅 호스트가 allowlist 밖으로 302 하면 페이로드가 나가지 않는다', async () => {
    const { sendWebhook } = await import('../../scripts/hooks/http-notify.js');

    stubFetch([redirectTo('https://evil.example.com/collect'), ok()]);
    const errs = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (s) => { errs.push(String(s)); return true; };
    let result;
    try {
      result = await sendWebhook(
        { url: 'https://api.github.com/webhook', timeoutMs: 1000 },
        { event: 'session-complete', secret: 'session payload' },
      );
    } finally {
      process.stderr.write = origWrite;
    }

    expect(result, '차단 시 false 를 돌려주는 계약이 유지돼야 한다').toBe(false);
    // 리다이렉트 대상으로는 단 한 번도 요청이 나가지 않아야 한다.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/webhook');
    expect(calls.some((c) => c.url.includes('evil.example.com'))).toBe(false);
    // 정책 결정으로 보고돼야 한다 — 일반 네트워크 실패로 뭉뚱그리지 않는다.
    expect(errs.join('')).toMatch(/blocked by DATA POLICY/);
  });

  it('http-notify: 차단된 리다이렉트 후 무참조 타이머가 남지 않는다', async () => {
    // 훅은 이벤트마다 뜨는 단명 프로세스이고 http-notify 에는 process.exit 가
    // 없다. 타이머가 armed 인 채로 남으면 함수가 끝난 뒤에도 이벤트 루프가
    // timeoutMs 만큼 살아 있어 사용자 눈에 보이는 지연이 된다. codeE 실측:
    // 함수는 43ms 에 반환하는데 프로세스는 5,027ms 에 종료됐다.
    //
    // 이 경로의 도달 빈도를 올린 것이 G-3 자신이다. 이전에 타이머 생성 이후로
    // 던지는 것은 DNS 실패·연결 거부뿐이었고(차단 URL 은 사전 검사가 타이머보다
    // 앞이라 타이머가 생기기 전에 return 했다), 이제 "allowlist 안 호스트가 밖으로
    // 302"라는 정상 운영 경로(URL 단축기·Slack/Discord 리다이렉트)가 추가됐다.
    const { sendWebhook } = await import('../../scripts/hooks/http-notify.js');

    const countTimers = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    stubFetch([redirectTo('https://evil.example.com/collect'), ok()]);
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    const before = countTimers();
    let result;
    try {
      result = await sendWebhook(
        { url: 'https://api.github.com/webhook', timeoutMs: 30_000 },
        { event: 'session-complete' },
      );
    } finally {
      process.stderr.write = origWrite;
    }

    expect(result).toBe(false);
    // 델타로 잰다 — vitest 자신의 타이머가 배경에 있으므로 절대값은 의미가 없다.
    expect(countTimers() - before, '차단 경로가 타이머를 정리하지 않았다').toBe(0);
  });

  it('http-notify: allowlist 안이면 정상 전송된다 (과잉교정 방지)', async () => {
    const { sendWebhook } = await import('../../scripts/hooks/http-notify.js');
    stubFetch([{ ...ok(), ok: true }]);
    const result = await sendWebhook(
      { url: 'https://api.github.com/webhook', timeoutMs: 1000 },
      { event: 'session-complete' },
    );
    expect(result).toBe(true);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('manual');
  });
});

describe('G-3 배선 게이트 — 가드 대상 모듈에 raw fetch 가 남지 않는다', () => {
  // 위 통합 단언은 http-notify 와 version-checker 만 덮는다. update.js 는 CLI 라
  // 행동 테스트가 어색해서 정적으로 고정한다. 뮤테이션 실측 2026-08-30: 이 게이트가
  // 없을 때 update.js 를 raw fetch 로 되돌려도 전 스위트가 GREEN 이었다.
  //
  // 못 보는 것: 문자열 스캔이다. 런타임에 그 경로가 실행되는지도, 새로 생긴
  // 네 번째 모듈이 raw fetch 를 쓰는지도 보지 못한다(목록이 여기 하드코딩이다).
  const GUARDED = [
    'scripts/hooks/http-notify.js',
    'lib/core/version-checker.js',
    'scripts/update.js',
  ];

  it.each(GUARDED)('%s 는 safeFetch 만 쓴다', (rel) => {
    const src = readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');
    const exec = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    // `safeFetch(` 는 대문자 F 라 이 패턴에 걸리지 않는다.
    const raw = exec.match(/(?<![A-Za-z])fetch\s*\(/g) || [];
    expect(raw, `${rel}: raw fetch( 잔존 ${raw.length}건`).toHaveLength(0);
    expect(exec, `${rel}: safeFetch 미사용`).toMatch(/safeFetch\s*\(/);
  });
});

describe('G-1 — 실제 소켓 1케이스 (스텁이 못 보는 것 일부 보완)', () => {
  let server;
  let base;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: `${base}/final` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('final');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await new Promise((r) => server.close(r));
  });

  it('실제 302 를 수동으로 따라가 최종 본문을 돌려준다', async () => {
    globalThis.fetch = realFetch;
    const res = await safeFetch(`${base}/redirect`, {}, { allowlist: [] });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('final');
  });
});
