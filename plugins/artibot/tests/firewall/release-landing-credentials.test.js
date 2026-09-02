/**
 * 검사 목적: release.yml `sync-readmes` 잡의 **푸시 자격증명 귀속**을 고정한다.
 *
 * ── 이 게이트가 존재하는 이유 (실사건) ────────────────────────────────────────
 * v4.51.0 배지 싱크가 master 에 착지하지 못했다. 브랜치
 * `ci/sync-badges-v4.51.0` @ `c5c230f0` 는 origin 에 실재하는데, 그 SHA 에
 * **워크플로 런 0건 / 체크런 0건**이었다(실측 2026-08-29, REST 2종 교차:
 * `actions/runs?head_sha=` → `total_count: 0`, `commits/.../check-runs` →
 * `total: 0`). ff 경로는 10분을 기다린 뒤 이슈 #114 를 열고 포기했다.
 *
 * 원인은 PAT 이 만료된 것이 아니라 **PAT 이 애초에 쓰이지 않은 것**이다.
 *   1. checkout 이 `persist-credentials` 기본값 `true` 로 GITHUB_TOKEN 을
 *      `http.https://github.com/.extraheader` AUTHORIZATION 헤더에 영속화한다.
 *   2. ff 스텝은 `https://x-access-token:${LANDING_PAT}@github.com/...` 처럼
 *      URL 인라인 자격증명으로 푸시한다.
 *   3. **extraheader 가 URL 인라인 자격증명을 이긴다** (actions/checkout#181
 *      "Header Token overrides user token", #162). 즉 실제 인증 주체는
 *      GITHUB_TOKEN 이었다.
 *   4. GITHUB_TOKEN 이 일으킨 push 이벤트는 워크플로 런을 만들지 않는다
 *      (GitHub Actions 규약). → 체크가 영원히 안 생긴다 → 10분 소진.
 *
 * 그래서 고정해야 하는 것은 "PAT 문자열이 파일에 있다"가 아니라 **자격증명이
 * 명시적으로 지명되고, 영속 자격증명이 꺼져 있다**는 구조다.
 *
 * ── 게이트 4종 ────────────────────────────────────────────────────────────────
 *   1. `Checkout master` 의 `with:` 에 `persist-credentials: false` 가 **값으로**
 *      존재한다. 주석에 그 문자열이 있는 것으로는 통과하지 않는다.
 *   2. ff 스텝의 모든 `git push`/`git fetch` 원격이 정확히 `"${REMOTE}"` 이고,
 *      `REMOTE=` 대입이 `${LANDING_PAT}` 를 쓴다.
 *   3. pr 스텝의 모든 `git push` 원격이 정확히 `"${PR_REMOTE}"` 이고,
 *      `PR_REMOTE=` 대입이 `${GH_TOKEN}` 를 쓰며, 그 스텝 `env:` 에 `GH_TOKEN`
 *      이 실제로 정의돼 있다. (미정의면 빈 문자열 인증으로 조용히 실패한다 —
 *      `git push origin` 회귀보다 나쁘다.)
 *   4. `wait_for_green` 의 3값 계약: `ZERO_POLL_LIMIT=8`, `return 2` 존재,
 *      호출부가 `wait_rc` 를 `"2"` 로 분기, 빈 payload 가드가 total 검사보다
 *      **앞**에 온다(순서가 뒤집히면 API 장애를 인증 실패로 오진한다).
 *
 * 단언은 전부 **추출값 대 allowlist 정확 비교**다. `not.toContain('origin')`
 * 같은 부정 목록은 나열하지 않은 미래 값(`upstream`, `$OTHER`)에 fail-open
 * 이다(rules §8). 그리고 스캔 대상은 **주석을 걷어낸 실행 셸**이다 — 이 파일이
 * 고정하려는 문자열 대부분이 바로 위 워크플로 주석에도 등장하므로, 주석을 안
 * 걷으면 산문이 단언을 충족시키는 거짓 그린이 된다(같은 함정이 2026-08-24
 * badge-stall 게이트에서 실제로 발생했다).
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ───────────────────
 *   - **런타임에 어느 자격증명이 실제로 쓰였는지는 증명하지 못한다.** 여기는
 *     YAML/셸 정적 스캔이다. "문자열이 있다 ≠ 실행된다 ≠ 그 토큰으로 인증됐다".
 *     유일한 실측은 다음 릴리스 런에서 `wait_for_green` 첫 회차 로그가
 *     `total=N (N>0)` 을 찍는 것 — 즉 푸시가 런을 만들었다는 것 — 뿐이다.
 *     **2026-08-30 현재 이 수정의 라이브 발화는 0회다.**
 *   - **`ARTIBOT_LANDING_PAT` 의 토큰 종류를 모른다.** 시크릿이라 조회 불가.
 *     그 값이 GITHUB_TOKEN 계열이면 `persist-credentials: false` 를 넣어도
 *     여전히 런이 안 생긴다. 이 게이트는 그 경우를 green 으로 통과시킨다.
 *     (대신 게이트 4의 `return 2` 경로가 2분 만에 정확한 문구로 escalate 한다.)
 *   - **checkout v7.0.1 이 실제로 쓰는 config 키 형태를 확인하지 않았다.**
 *     actions/checkout#2321 은 v6+ 가 `includeIf` 지시자로 옮겼다고 보고한다.
 *     `persist-credentials: false` 는 그 형태와 무관하게 "저장하지 않는다"를
 *     뜻하므로 이 수정은 영향받지 않지만, extraheader 키 이름에 의존하는 수정
 *     (수동 `git config --unset-all`)이었다면 조용히 무효화됐을 것이다.
 *   - **GitHub 이 이 YAML 을 어떻게 파싱하는지는 모른다.** 이 플러그인은 zero
 *     runtime deps 이고 devDeps 에도 YAML 파서가 없어(badge-stall 게이트가
 *     2026-08-24 에 `require.resolve('js-yaml')` 실패로 실측) 아래 파서는
 *     들여쓰기 기반 최소 구현이다. 그래서 "스캐너 자기검증" 블록이 파싱 건수를
 *     단언으로 가둔다 — 0건 매치가 조용히 통과하는 것이 이런 게이트의 주된
 *     거짓 그린 경로다.
 *   - **`git push` 이외의 유출 경로는 보지 않는다.** 누가 `curl` 로 REST push
 *     를 하거나 새 스텝을 추가하면 여기 걸리지 않는다.
 *
 * @module tests/firewall/release-landing-credentials
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 리포 루트 — GitHub 가 실제로 실행하는 워크플로는 여기 아래에만 있다. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const RELEASE_YML = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

const CHECKOUT_STEP = 'Checkout master';
const FF_STEP = 'Land badge sync via ci/** side branch (PAT)';
const PR_STEP = 'Land badge sync via PR + auto-merge';

/**
 * 파일이 없으면 여기서 죽는다 = fail-closed. 경로가 바뀌었는데 게이트가
 * "검사할 게 없어서 통과"하는 것이 가장 위험한 실패다.
 */
const source = existsSync(RELEASE_YML) ? readFileSync(RELEASE_YML, 'utf-8') : null;

/**
 * `- name: <step>` 부터 다음 `- name:` 직전까지를 잘라낸다.
 *
 * YAML 파서가 아니라 스텝 경계만 나누는 최소 절단기다(badge-stall 게이트와
 * 같은 관용구). 스텝 본문 안의 셸 주석에 `- name:` 이 나오면 잘못 자르는데,
 * 아래 자기검증이 그 전제를 단언으로 고정한다.
 *
 * @param {string} yaml 워크플로 전체 텍스트
 * @param {string} stepName 찾을 스텝 이름
 * @returns {string | null} 스텝 본문. 없으면 null
 */
function sliceStep(yaml, stepName) {
  const lines = yaml.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (startIdx === -1) return null;
  const rest = lines.slice(startIdx + 1);
  const endOffset = rest.findIndex((l) => /^\s*- name: /.test(l));
  return (endOffset === -1 ? rest : rest.slice(0, endOffset)).join('\n');
}

/**
 * 스텝 본문에서 **실행되는 셸만** 남긴다: `#` 주석 줄을 버리고 `\` 줄 연속을 잇는다.
 *
 * @param {string} stepBody sliceStep 결과
 * @returns {string} 주석 제거 + 줄 연속 결합된 텍스트
 */
function executableShell(stepBody) {
  return stepBody
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\r?\n\s*/g, ' ');
}

/**
 * 스텝의 `with:` 또는 `env:` 매핑을 읽는다. 주석 줄은 버린다.
 *
 * @param {string} stepBody sliceStep 결과
 * @param {'with'|'env'} key 읽을 블록
 * @returns {Record<string, string>} 이름 → 값(문자열 그대로)
 */
function parseBlock(stepBody, key) {
  const lines = stepBody.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const start = lines.findIndex((l) => l.trim() === `${key}:`);
  if (start === -1) return {};
  const baseIndent = lines[start].match(/^ */)[0].length;
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (line.match(/^ */)[0].length <= baseIndent) break;
    const m = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * 실행 셸에서 `git <verb>` 호출의 **원격 인자**를 등장 순서대로 뽑는다.
 *
 * `--force-with-lease` 같은 선행 플래그를 건너뛰고 첫 비-플래그 토큰을 원격으로
 * 본다. 추출한 배열을 allowlist 와 정확 비교하려고 만들었다 — 하나라도
 * `origin` 이나 다른 값으로 새면 배열이 달라져 RED 가 된다.
 *
 * @param {string} stepBody sliceStep 결과
 * @param {'push'|'fetch'} verb git 하위 명령
 * @returns {string[]} 호출별 원격 인자
 */
function gitRemotes(stepBody, verb) {
  const shell = executableShell(stepBody);
  const remotes = [];
  for (const match of shell.matchAll(new RegExp(`git ${verb}\\b([^\\n;]*)`, 'g'))) {
    const tokens = match[1].trim().split(/\s+/).filter(Boolean);
    const first = tokens.find((t) => !t.startsWith('-'));
    remotes.push(first ?? null);
  }
  return remotes;
}

describe('release.yml 배지 착지 자격증명 계약', () => {
  it('release.yml 이 실재한다 (부재 시 fail-closed)', () => {
    expect(source, `${RELEASE_YML} 를 읽지 못했다`).not.toBeNull();
    expect(source.length).toBeGreaterThan(1000);
  });

  // ── 게이트 1: 영속 자격증명 차단 ────────────────────────────────────────────
  it('Checkout master 가 persist-credentials: false 를 값으로 선언한다', () => {
    const body = sliceStep(source, CHECKOUT_STEP);
    expect(body, `"${CHECKOUT_STEP}" 스텝을 찾지 못했다`).not.toBeNull();
    const withBlock = parseBlock(body, 'with');
    // 정확 비교. 주석에 같은 문자열이 있어도 값이 아니면 통과하지 못한다.
    expect(withBlock['persist-credentials']).toBe('false');
  });

  // ── 게이트 2: ff 경로가 PAT 을 지명한다 ─────────────────────────────────────
  it('ff 스텝의 모든 git push/fetch 가 명시 REMOTE 를 쓴다', () => {
    const body = sliceStep(source, FF_STEP);
    expect(body, `"${FF_STEP}" 스텝을 찾지 못했다`).not.toBeNull();

    const pushes = gitRemotes(body, 'push');
    const fetches = gitRemotes(body, 'fetch');
    expect(pushes.length).toBeGreaterThan(0);
    expect(fetches.length).toBeGreaterThan(0);
    // allowlist 정확 비교: 전부 "${REMOTE}" 여야 한다.
    expect([...new Set(pushes)]).toEqual(['"${REMOTE}"']);
    expect([...new Set(fetches)]).toEqual(['"${REMOTE}"']);

    const shell = executableShell(body);
    expect(shell).toMatch(/REMOTE="https:\/\/x-access-token:\$\{LANDING_PAT\}@github\.com\//);
    expect(parseBlock(body, 'env')).toHaveProperty('LANDING_PAT');
  });

  // ── 게이트 3: pr 경로도 자격증명을 지명한다 ─────────────────────────────────
  it('pr 스텝의 모든 git push 가 명시 PR_REMOTE 를 쓰고 GH_TOKEN 이 정의돼 있다', () => {
    const body = sliceStep(source, PR_STEP);
    expect(body, `"${PR_STEP}" 스텝을 찾지 못했다`).not.toBeNull();

    const pushes = gitRemotes(body, 'push');
    expect(pushes.length).toBeGreaterThan(0);
    expect([...new Set(pushes)]).toEqual(['"${PR_REMOTE}"']);

    const shell = executableShell(body);
    expect(shell).toMatch(/PR_REMOTE="https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com\//);
    // 변수명 오타/미정의는 빈 문자열 인증으로 조용히 실패한다 — env 에서 실측.
    expect(parseBlock(body, 'env')).toHaveProperty('GH_TOKEN');
  });

  // ── 게이트 4: wait_for_green 3값 계약 ───────────────────────────────────────
  it('wait_for_green 이 "런 0건" 을 별도 코드 2 로 조기 판정한다', () => {
    const body = sliceStep(source, FF_STEP);
    const shell = executableShell(body);

    expect(shell).toMatch(/^\s*ZERO_POLL_LIMIT=8$/m);
    expect(shell).toMatch(/return 2/);
    // 호출부가 실제로 2 를 분기해야 의미가 있다. 함수만 고치고 호출부를
    // 안 고치면 escalation 문구가 그대로라 오진이 재발한다.
    expect(shell).toMatch(/wait_for_green "\$\{SHA\}" \|\| wait_rc=\$\?/);
    expect(shell).toMatch(/\[ "\$\{wait_rc\}" = "2" \]/);

    // 순서 계약: 빈 payload 가드가 total 검사보다 앞이어야 한다. 뒤집히면
    // API 장애 2분이 "인증 실패" 로 보고된다.
    const emptyGuard = shell.indexOf('if [ -z "${payload}" ]; then continue; fi');
    const totalCheck = shell.indexOf('if [ "${total}" = "0" ]; then');
    expect(emptyGuard).toBeGreaterThan(-1);
    expect(totalCheck).toBeGreaterThan(-1);
    expect(emptyGuard).toBeLessThan(totalCheck);
  });

  // ── 스캐너 자기검증 ─────────────────────────────────────────────────────────
  // 0건 매치가 조용히 통과하는 것이 이런 정적 게이트의 주된 거짓 그린 경로다.
  // 절단기·주석제거기·추출기가 실제로 일했는지를 단언으로 가둔다.
  describe('스캐너 자기검증', () => {
    it('세 스텝 이름이 파일에 정확히 1회씩만 등장한다 (절단기 전제)', () => {
      for (const name of [CHECKOUT_STEP, FF_STEP, PR_STEP]) {
        const hits = source
          .split(/\r?\n/)
          .filter((l) => l.trim() === `- name: ${name}`).length;
        expect(hits, `"${name}" 이 ${hits} 회 등장한다`).toBe(1);
      }
    });

    it('주석 제거기가 실제로 줄을 걷어낸다', () => {
      const body = sliceStep(source, FF_STEP);
      const before = body.split(/\r?\n/).length;
      const after = executableShell(body).split(/\r?\n/).length;
      // ff 스텝은 주석이 본문의 상당 부분이다. 0줄 제거면 필터가 죽은 것이다.
      expect(before - after).toBeGreaterThan(10);
    });

    it('주석만으로는 자격증명 단언이 충족되지 않는다 (거짓 그린 차단)', () => {
      const body = sliceStep(source, PR_STEP);
      const commentsOnly = body
        .split(/\r?\n/)
        .filter((l) => /^\s*#/.test(l))
        .join('\n');
      // 주석에 'git push origin' 서술이 남아 있어도 추출기는 그것을 세지 않는다.
      expect(gitRemotes(commentsOnly, 'push')).toEqual([]);
    });

    it('with/env 파서가 빈 결과를 내지 않는다', () => {
      expect(Object.keys(parseBlock(sliceStep(source, CHECKOUT_STEP), 'with')).length)
        .toBeGreaterThanOrEqual(4);
      expect(Object.keys(parseBlock(sliceStep(source, PR_STEP), 'env')).length)
        .toBeGreaterThanOrEqual(2);
    });
  });
});
