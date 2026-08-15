/**
 * 검사 목적: `artibot-cowork` 릴리스 스크립트가 **락을 누수하지 않는 구조**를
 * 유지하는가, 그리고 락 경로를 **cwd 가 아닌 git 공용 디렉터리**에서 얻는가.
 *
 * 두 결함 모두 2026-08-15 에 격리 샌드박스 실행으로 관측된 실물이다.
 *
 *  - **D1** `release-lock.js` 가 `path.join(process.cwd(), '.git', …)` 로 경로를
 *    잡았다. `release.js` 는 락을 **플러그인 디렉터리를 cwd 로** 스폰하는데 거기엔
 *    `.git` 이 없다. 연결된 worktree 에서는 `.git` 이 디렉터리가 아니라 파일이라
 *    또 실패했다. 결과: 릴리스가 `acquireLock` 에서 exit 3 으로 죽어 **꼬리가 한
 *    번도 완주할 수 없었다**(cowork 릴리스 태그 0개의 기전).
 *
 *  - **D2** `gitOrFail` 이 실패 시 `fail()` → `process.exit()` 를 불렀다.
 *    `process.exit()` 는 스택을 풀지 않으므로 `main()` 의 `try/catch` 가 **도달
 *    불가**였고, 락을 푸는 유일한 경로가 그 catch 였다. 결과: 중간 실패 시
 *    `.git/autopilot.lock.json` 잔존 + `autopilot.json` 이 `enabled:false` 로 방치
 *    → 다음 릴리스가 "Lock already exists" 로 **영구 차단**되고 그 사실은 어디에도
 *    출력되지 않았다.
 *
 * ── 왜 소스 불변식 검사인가 (동작 검사가 아니라) ──────────────────────────────
 * 두 수정의 **동작**은 이 세션에 격리 샌드박스(`git init` 독립 리포)에서 실행으로
 * 확인했다: 플러그인 디렉터리 실행이 EXIT 0 완주, pre-commit 훅 강제 실패 주입 시
 * 락 해제 + `enabled=true` 복원 + EXIT 2 유지. 그 실행을 테스트로 옮기지 않은
 * 이유는 실패 주입에 **`sh` 기반 git 훅**이 필요한데, 이 리포에서 그 방식이 이미
 * Windows 에서 false-red 를 낸 전력이 있기 때문이다(하네스 sh-ENOENT). 훅 없이
 * `git commit` 을 실패시키는 이식성 있는 방법을 찾지 못했다(`--stage` 로 리포 밖
 * 경로를 넘기는 우회는 `stageFiles` 의 존재-필터에 걸려 무효였다).
 *
 * 대신 **한 토큰 되돌리기로 재발하는** 지점만 고정한다. D2 는 `throw` 를 `fail(` 로
 * 바꾸는 순간 조용히 부활하고, 그 피해는 로그에 남지 않는다. 구조가 약한 게이트인
 * 것을 알고 넣는다 — 아래 한계를 함께 읽어라.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ────────────────────────────────────────
 *  1. **실행하지 않는다.** 락이 실제로 해제되는지, 릴리스가 완주하는지 검증하지
 *     않는다. 소스에 그렇게 **쓰여 있는지**만 본다.
 *  2. `releaseLock()` 자체가 실패하는 경우는 보지 않는다. 그 경로는 경고만 내고
 *     종료하며, 경고 문구의 정확성도 검사하지 않는다.
 *  3. `maybePush` 경로는 이 세션에 **한 번도 실행되지 않았다**(`--push` 금지).
 *     같은 `gitOrFail` 을 쓰므로 같은 논리로 안전할 것으로 보이나 미실측이다.
 *  4. `git rev-parse --git-common-dir` 이 미래 git 버전에서 다른 값을 주면 같이
 *     낡는다. 문자열 존재만 보고 해석 결과는 보지 않는다.
 *  5. **`process.exit` 리터럴 부재 검사는 `fail()` 경유 간접 종료를 못 본다.**
 *     원 D2 결함이 정확히 그 형태였다 — 종료는 `gitOrFail` 안의 `fail()` 에서
 *     일어났고 `stageFiles`·`commitRelease`·`maybePush` 본문에는 `process.exit(`
 *     리터럴이 없었다. 즉 아래 "직접 종료하지 않는다" 검사는 **그 버그를 통과
 *     시켰을 것이다**(격리 미러 실측: pre-fix 소스에서 GREEN).
 *     **이 게이트에서 D2 를 실제로 판별하는 것은 `gitOrFail 은 throw 한다` 단언
 *     하나뿐이다.** 같은 파일의 `main() 의 catch` 단언도 pre-fix 에서 GREEN 이다
 *     (그 try/catch 는 원래 있었고 수정이 손대지 않았다) — 회귀 가드로는 유효하나
 *     이 수정을 판별하지는 못한다.
 *
 *     **강화하지 않기로 판정했다.** 호출 그래프를 따라가야 잡히는데, 소스 문자열
 *     게이트로는 정당한 형태와 위험한 형태를 가를 수 없다: `commitRelease` 는
 *     `run('git', ['diff','--cached','--name-only'])` 를 **직접** 부르지만 status
 *     를 보지 않는 읽기 전용 탐침이라 안전하다. "직접 git 호출 금지"로 조이면
 *     **현행 정상 코드가 RED 가 된다**(실측 확인). 한계로 적고 남긴다.
 *
 * @module tests/firewall/cowork-release-lock-safety
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COWORK_SCRIPTS = join(__dirname, '..', '..', '..', 'artibot-cowork', 'scripts');

const read = (f) => readFileSync(join(COWORK_SCRIPTS, f), 'utf-8');

/**
 * 이름이 붙은 함수의 본문을 중괄호 균형으로 잘라낸다. 정규식 한 방으로 본문을
 * 잡으려 하면 중첩 블록에서 조용히 짧게 잘리고, 그러면 검사가 헛돈다.
 *
 * @param {string} src
 * @param {string} name
 * @returns {string|null} 본문(중괄호 안). 함수를 못 찾으면 null.
 */
export function functionBody(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

describe('cowork 릴리스 — 락 누수 방지 (D2)', () => {
  it('gitOrFail 은 throw 한다 — process.exit 로 끝내면 catch 가 도달 불가다', () => {
    const body = functionBody(read('release.js'), 'gitOrFail');
    expect(body, 'release.js 에서 gitOrFail 을 찾지 못했다').not.toBeNull();
    expect(body).toMatch(/\bthrow\s+new\s+Error\b/);
    // fail() 은 process.exit 을 부른다. 여기서 쓰면 D2 가 그대로 재발한다.
    expect(body).not.toMatch(/\bfail\s*\(/);
    expect(body).not.toMatch(/process\.exit\s*\(/);
  });

  it('main() 의 catch 가 releaseLock 을 부른다 — 락을 푸는 유일한 경로다', () => {
    const src = read('release.js');
    const body = functionBody(src, 'main');
    expect(body, 'release.js 에서 main 을 찾지 못했다').not.toBeNull();
    const cat = body.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/);
    expect(cat, 'main() 에서 catch 블록을 찾지 못했다').not.toBeNull();
    expect(cat[1]).toMatch(/releaseLock\s*\(/);
  });

  // 이름을 정확히 적는다. 이 검사는 "전부 gitOrFail 을 거친다"를 **보증하지
  // 않는다** — `commitRelease` 는 status 를 보지 않는 읽기 전용 `run('git', …)`
  // 탐침을 직접 부르며 그것은 정당하다. 여기서 보는 것은 세 함수 본문에 `process.exit(`
  // 리터럴이 없다는 것뿐이고, 그것은 D2 를 판별하지 못한다(헤더 한계 5).
  // 앞으로 누가 이 함수들 안에 **새로** 직접 종료를 심는 경우만 잡는다.
  it('세 함수 본문에 직접 종료(process.exit) 리터럴이 없다 — D2 판별용 아님', () => {
    const src = read('release.js');
    for (const fn of ['stageFiles', 'commitRelease', 'maybePush']) {
      const body = functionBody(src, fn);
      expect(body, `${fn} 을 찾지 못했다`).not.toBeNull();
      expect(body, `${fn} 이 락 해제를 건너뛰고 종료한다`).not.toMatch(/process\.exit\s*\(/);
    }
  });
});

describe('cowork 릴리스 — 락 경로 해석 (D1)', () => {
  it('release-lock.js 는 git 공용 디렉터리에서 경로를 얻는다', () => {
    const src = read('release-lock.js');
    expect(src).toMatch(/--git-common-dir/);
  });

  it('락 경로를 cwd 에서 조립하지 않는다', () => {
    const src = read('release-lock.js');
    // 결함 원본은 `const REPO_ROOT = process.cwd()` 를 거쳐 join 했다. 즉
    // `path.join(process.cwd(), '.git')` 리터럴을 찾는 검사는 **공허하다** —
    // 변수를 한 단계 거치면 통과한다(실제로 pre-fix 소스에 대해 통과했다).
    // cwd 호출 자체를 금지해야 그 형태까지 잡힌다.
    expect(src).not.toMatch(/process\.cwd\s*\(/);
  });
});

describe('스캐너 자기검증 — 게이트가 헛돌지 않는다', () => {
  it('두 스크립트를 실제로 읽는다 (분모 0 방지)', () => {
    expect(read('release.js').length).toBeGreaterThan(1000);
    expect(read('release-lock.js').length).toBeGreaterThan(1000);
  });

  it('functionBody 가 중첩 중괄호에서 짧게 자르지 않는다', () => {
    const src = 'function outer() {\n  if (x) { y(); }\n  return 1;\n}\n';
    expect(functionBody(src, 'outer')).toContain('return 1;');
  });

  it('functionBody 는 없는 함수에 null 을 준다 (이름이 바뀌면 위 검사가 실패한다)', () => {
    expect(functionBody('function a() {}', 'nope')).toBeNull();
  });

  it('뮤테이션: fail() 을 쓰는 gitOrFail 은 위반으로 잡힌다', () => {
    // 이 검사가 없으면 "throw 가 있다"만 보고 fail() 병기를 놓칠 수 있다.
    const mutant = 'function gitOrFail(a, b) {\n  if (r) { fail(2, b); }\n  throw new Error(b);\n}';
    const body = functionBody(mutant, 'gitOrFail');
    expect(body).toMatch(/\bthrow\s+new\s+Error\b/);
    expect(body).toMatch(/\bfail\s*\(/); // 뮤턴트는 fail 을 쓴다 → 본 검사에서 RED
  });
});
