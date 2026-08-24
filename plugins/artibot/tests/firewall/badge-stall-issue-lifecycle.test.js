/**
 * 검사 목적: release.yml 배지 정체(stall) 이슈의 **여닫이 계약** 고정.
 *
 * 감지기(`Detect silent badge-sync stall`)는 배지 PR 이 머지될 수 없을 때 이슈를
 * 연다. 그런데 **닫는 쪽이 없었다** — #107(v4.48.0)·#109(v4.49.0)는 각각의 PR
 * #106·#108 이 2026-08-22 / 08-23 에 머지된 뒤에도 2026-08-24 까지 OPEN 이었다.
 * `Close resolved badge-sync stall issues` 스텝이 그 나머지 절반이고, 이 파일이
 * 그 스텝과 감지기가 **같은 제목 문자열을 공유한다는 것**을 red 로 만든다.
 *
 * 게이트는 3중이다.
 *   1. 이슈 제목이 워크플로 최상위 `env:` 의 prefix/suffix 쌍으로만 존재한다.
 *      리터럴 재등장을 금지하는 게 핵심이다 — 두 스텝이 각자 문자열을 들고 있으면
 *      한쪽만 리워딩되는 순간 닫기 로직이 **조용히** 매칭에 실패한다. 감지기가
 *      제거하려던 바로 그 종류의 무관측 실패다.
 *   2. 여는 스텝과 닫는 스텝이 **둘 다 존재하고**, 둘 다 그 env 를 참조한다.
 *      닫기 경로를 통째로 지우는 회귀를 막는다.
 *   3. 닫기 스텝의 `gh pr list` **명령줄에서 뽑은** `--state` 값이 `['merged']` 와
 *      정확히 일치한다. `closed` 로 넓히면 "머지 안 된 채 닫힌 PR"(누가 배지 싱크를
 *      폐기한 경우)까지 해소로 오판해 사람이 알아야 할 이슈를 조용히 닫는다.
 *
 *      이 단언은 처음에 `toContain('--state merged')` +
 *      `not.toContain('--state all')` 이었고 **거짓 그린이었다**: 명령을
 *      `--state closed` 로 바꿔도 바로 위 주석이 positive 를 채워 11/11 이
 *      통과했다(실측 2026-08-24). 그래서 (a) 주석을 걷어낸 실행 셸에서만 읽고
 *      (b) 부정 목록 대신 allowlist 정확 비교를 한다. 부정 목록은 나열하지 않은
 *      미래 값에 항상 fail-open 이다(rules §8).
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ─────────────────────
 *   - **스텝이 실제로 실행되는지·성공하는지는 보지 않는다.** 여기는 정적 문자열
 *     스캔이다. "파일이 있다 ≠ 실행된다 ≠ 성공한다". 닫기 경로의 실측은 다음
 *     stable 릴리스 런 로그에서 `Stall-issue reconciliation complete.` 를
 *     확인하는 것뿐이다.
 *   - **셸 로직의 정확성은 검증하지 않는다.** prefix/suffix 로 태그를 되찾는
 *     파라미터 확장, `case` 매칭, `-eo pipefail` 하의 루프 종료 코드는 이 파일
 *     밖이다(2026-08-24 에 fake `gh` 하네스로 6케이스 수동 실행해 확인했고,
 *     그 하네스는 리포에 남아 있지 않다).
 *   - **GitHub 이 이 워크플로를 어떻게 파싱하는지는 모른다.** YAML 라이브러리를
 *     쓰지 않는다(이 플러그인은 zero runtime deps). 문자열이 파일에 있다는 것과
 *     그것이 유효한 워크플로라는 것은 다른 진술이다.
 *   - **다른 세 escalation 제목**(`could not land on master`,
 *     `could not be pushed`, `needs manual merge`)은 대상이 아니다. 그것들은
 *     닫기 짝이 없고, 여기서 요구하지도 않는다.
 *
 * @module tests/firewall/badge-stall-issue-lifecycle
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 리포 루트 — GitHub 가 실제로 실행하는 워크플로는 여기 아래에만 있다. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const RELEASE_YML = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

/** 정체 이슈 제목의 단일 진실원 변수명. 워크플로 최상위 `env:` 에 있다. */
const PREFIX_VAR = 'STALL_TITLE_PREFIX';
const SUFFIX_VAR = 'STALL_TITLE_SUFFIX';

/** 여는 스텝 / 닫는 스텝의 `name:` — 둘 다 실재해야 한다. */
const DETECT_STEP = 'Detect silent badge-sync stall';
const CLOSE_STEP = 'Close resolved badge-sync stall issues';

const source = readFileSync(RELEASE_YML, 'utf-8');

/**
 * `- name: <step>` 부터 다음 `- name:` 직전까지를 잘라낸다.
 *
 * YAML 파서가 아니라 스텝 경계만 나누는 최소 절단기다. 스텝 본문 안의 셸 주석에
 * `- name:` 이 나오면 잘못 자르는데, 현재 release.yml 에는 그런 줄이 없다
 * (아래 "스캐너 자기검증"이 이 전제를 단언으로 고정한다).
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
  const body = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return body.join('\n');
}

/**
 * 스텝 본문에서 **실행되는 셸만** 남긴다: `#` 주석 줄을 버리고 `\` 줄 연속을 잇는다.
 *
 * 이게 없으면 산문이 단언을 충족시킨다. 실측 2026-08-24: `release.yml` 에
 * `--state merged` 가 2회 등장하는데 하나는 주석(`# \`--state merged\` is the whole
 * verdict…`)이고 하나가 실제 명령이다. 명령을 `--state closed` 로 바꿔도 주석이
 * `toContain('--state merged')` 를 채워 11/11 이 통과했다 — 게이트가 막겠다고
 * 선언한 시나리오가 그대로 지나간 거짓 그린이었다.
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
 * 스텝 안 모든 `gh pr list` 호출의 `--state` 값을 등장 순서대로 뽑는다.
 *
 * 값을 **추출해서 allowlist 와 정확히 비교**하려고 만들었다. 부정 목록
 * (`not.toContain('--state all')`)은 나열한 한 값만 막고 `closed`·`open` 같은
 * 미래 값에 fail-open 이다(rules §8). `--state` 가 아예 없으면 `null` 이 들어가
 * 그것도 allowlist 비교에서 걸린다.
 *
 * @param {string} stepBody sliceStep 결과
 * @returns {(string|null)[]} 호출별 --state 값. 플래그가 없으면 null
 */
function ghPrListStates(stepBody) {
  const shell = executableShell(stepBody);
  const states = [];
  for (const match of shell.matchAll(/gh pr list\b([^\n]*)/g)) {
    const flag = /--state[= ]+(\S+)/.exec(match[1]);
    states.push(flag ? flag[1] : null);
  }
  return states;
}

describe('badge-stall 이슈 제목 단일 진실원', () => {
  it('release.yml 을 실제로 읽었다 (경로 오해석 방지)', () => {
    // 경로를 잘못 잡아 빈 문자열을 스캔하고도 "리터럴 0건"으로 green 이 되는 것을 막는다.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('name: Release');
  });

  it('제목 prefix/suffix 가 최상위 env 에 선언돼 있다', () => {
    expect(source).toMatch(new RegExp(`^env:\\s*$`, 'm'));
    expect(source).toMatch(new RegExp(`^\\s{2}${PREFIX_VAR}: "`, 'm'));
    expect(source).toMatch(new RegExp(`^\\s{2}${SUFFIX_VAR}: "`, 'm'));
  });

  it('제목 리터럴이 env 선언 밖에서 재등장하지 않는다', () => {
    // 이 게이트의 존재 이유. 두 스텝이 각자 문자열을 들고 있으면 한쪽만
    // 리워딩되는 순간 닫기 로직이 아무 소리 없이 매칭에 실패한다.
    //
    // **suffix 로만** 잰다. prefix(`badge-sync PR `)는 형제 escalation 제목
    // "chore(release): badge-sync PR ${TAG} needs manual merge" 와 앞부분을
    // 공유하고 다른 이슈 본문 산문에도 들어 있어서(실측 2026-08-24: release.yml
    // 안에 prefix 3회 / suffix 1회) 개수로 가둘 수 없다. suffix 는 이 제목에만
    // 있는 판별부라 누가 전체 제목을 인라인으로 다시 써 넣으면 반드시 걸린다.
    const literal = 'is stalled — required checks never started';
    const occurrences = source.split(literal).length - 1;
    // 선언 1회. 산문 주석에서 언급하고 싶으면 이 단언을 같이 고쳐라 —
    // 그러라고 정확한 횟수로 박아뒀다.
    expect(
      occurrences,
      `"${literal}" 가 ${occurrences}회 등장한다. env 선언 1회만 허용된다.`,
    ).toBe(1);
  });
});

describe('badge-stall 이슈 여닫이 경로', () => {
  const detectBody = sliceStep(source, DETECT_STEP);
  const closeBody = sliceStep(source, CLOSE_STEP);

  it('여는 스텝과 닫는 스텝이 둘 다 존재한다', () => {
    expect(detectBody, `"${DETECT_STEP}" 스텝이 없다`).not.toBeNull();
    expect(closeBody, `"${CLOSE_STEP}" 스텝이 없다`).not.toBeNull();
  });

  it('여는 스텝이 env 로 제목을 조립한다', () => {
    expect(detectBody).toContain(`\${${PREFIX_VAR}}`);
    expect(detectBody).toContain(`\${${SUFFIX_VAR}}`);
    expect(detectBody).toContain('gh issue create');
  });

  it('닫는 스텝이 같은 env 로 제목을 되짚어 이슈를 닫는다', () => {
    expect(closeBody).toContain(`\${${PREFIX_VAR}}`);
    expect(closeBody).toContain(`\${${SUFFIX_VAR}}`);
    expect(closeBody).toContain('gh issue close');
  });

  it('닫는 스텝은 머지된 PR 로만 해소를 판정한다', () => {
    // 실제 `gh pr list` 명령줄에서 뽑은 값을 allowlist 와 **정확히** 비교한다.
    // `merged` 외 어떤 값도(`all`·`closed`·`open`, 플래그 누락 포함) RED 다.
    //
    // 왜 이 형태여야 하는가: `closed` 는 머지된 PR 을 포함하므로 "머지 안 된 채
    // 닫힌 PR"(누가 배지 싱크를 폐기한 경우)까지 해소로 오판해 사람이 알아야 할
    // 이슈를 조용히 닫는다. 리더 실측 2026-08-24:
    // `gh pr list --state closed --head chore/sync-readme-badges-v4.49.0` 이
    // 머지된 #108 을 반환했다.
    expect(ghPrListStates(closeBody)).toEqual(['merged']);
  });

  it('닫는 스텝이 릴리스를 실패시키지 않는다', () => {
    // 이 잡이 도는 시점에 GitHub Release 는 이미 발행돼 있다. 정리 로직 버그가
    // 릴리스를 빨갛게 만들면 안 된다 — 감지기와 같은 자세다.
    expect(closeBody).toContain('continue-on-error: true');
  });
});

describe('스캐너 자기검증', () => {
  // 게이트 자체가 거짓 green 이 되지 않게 절단기를 직접 검증한다.
  it('sliceStep 이 없는 스텝에 null 을 돌려준다', () => {
    expect(sliceStep(source, 'No Such Step Name Anywhere')).toBeNull();
  });

  it('sliceStep 이 스텝 경계를 넘어가지 않는다', () => {
    const closeBody = sliceStep(source, CLOSE_STEP);
    // 닫는 스텝 바로 뒤 스텝의 고유 문자열이 새어 들어오면 절단 실패다.
    expect(closeBody).not.toContain('actions/setup-node');
  });

  it('잘라내는 두 스텝 이름이 파일 안에서 유일하다 (절단기 전제)', () => {
    // `sliceStep` 은 findIndex 로 첫 매치만 잡는다. 같은 이름이 두 번 나오면
    // 조용히 엉뚱한 본문을 검사하게 된다.
    //
    // 파일 **전체** 스텝 이름이 유일한 것은 아니다 — 실측 2026-08-24 로
    // `- name:` 27줄 / 고유 25개이고, 겹치는 둘은 잡이 달라 정상인
    // `Checkout repository`(validate·release)와 `Setup Node.js 22`
    // (validate·sync-readmes)다. 그래서 전역이 아니라 이 게이트가 실제로
    // 자르는 두 이름만 요구한다.
    for (const stepName of [DETECT_STEP, CLOSE_STEP]) {
      const hits = source
        .split(/\r?\n/)
        .filter((l) => l.trim() === `- name: ${stepName}`).length;
      expect(hits, `"${stepName}" 가 ${hits}회 등장한다`).toBe(1);
    }
  });

  it('주석 안의 --state 는 단언을 충족시키지 못한다 (거짓 그린의 원인)', () => {
    // 이 파일의 거짓 그린을 만든 정확한 배치를 합성 픽스처로 재현한다: 주석은
    // `merged` 라 말하는데 명령은 `closed` 인 상태. 옛 단언
    // (`toContain('--state merged')`)은 주석 때문에 통과했다.
    //
    // release.yml 의 실제 주석 문구를 세지 않는 이유: 산문은 계약이 아니다.
    // 누가 주석을 정당하게 고쳐도 RED 가 되면 이번엔 반대 방향 오탐이 된다.
    // 실파일 보호는 위 allowlist 단언이 이미 맡고 있다.
    const lying = [
      '            # `--state merged` is the whole verdict: an issue is only resolved',
      '            merged_at="$(gh pr list --head "${branch}" --state closed --limit 1)"',
    ].join('\n');
    expect(lying).toContain('--state merged'); // 옛 단언은 이걸로 통과했다
    expect(ghPrListStates(lying)).toEqual(['closed']); // 새 단언은 명령만 본다
    expect(ghPrListStates(lying)).not.toEqual(['merged']);
  });

  it('ghPrListStates 가 줄 연속(`\\`)을 넘어 --state 를 찾는다', () => {
    // 실제 명령은 `--limit 1 \` 로 줄이 바뀐다. 줄 단위로만 봤다면 값을 놓치고
    // null 을 돌려주는데, 그러면 allowlist 비교가 엉뚱한 이유로 RED 가 된다.
    const body = [
      '            merged_at="$(gh pr list --head "${b}" --state merged --limit 1 \\',
      "              --json mergedAt --jq '.[0].mergedAt // empty')\"",
    ].join('\n');
    expect(ghPrListStates(body)).toEqual(['merged']);
  });

  it('ghPrListStates 가 변이를 값으로 구분한다', () => {
    const mk = (state) => `x="$(gh pr list --head "$b" --state ${state} --limit 1)"`;
    expect(ghPrListStates(mk('all'))).toEqual(['all']);
    expect(ghPrListStates(mk('closed'))).toEqual(['closed']);
    expect(ghPrListStates(mk('open'))).toEqual(['open']);
    // 플래그 자체가 사라져도 통과하면 안 된다.
    expect(ghPrListStates('x="$(gh pr list --head "$b" --limit 1)"')).toEqual([null]);
    // 호출이 아예 없으면 빈 배열 — allowlist 비교에서 RED.
    expect(ghPrListStates('echo no calls here')).toEqual([]);
  });
});
