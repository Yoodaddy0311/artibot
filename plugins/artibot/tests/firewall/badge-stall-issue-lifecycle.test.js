/**
 * 검사 목적: release.yml 배지 escalation 이슈 **4종의 여닫이 계약** 고정.
 *
 * `sync-readmes` 잡은 배지 싱크가 master 에 닿지 못할 때 이슈를 연다. 그런데
 * **닫는 쪽이 없었다** — #107(v4.48.0)·#109(v4.49.0)는 각각의 PR #106·#108 이
 * 2026-08-22 / 08-23 에 머지된 뒤에도 2026-08-24 까지 OPEN 이었다.
 * `Close resolved badge-sync escalation issues` 스텝이 그 나머지 절반이고, 이
 * 파일이 여는 스텝들과 닫는 스텝이 **같은 제목 문자열을 공유한다는 것**을 red 로
 * 만든다.
 *
 * 4종 (KINDS 상수가 정본):
 *   stall  정체 감지기         PR 모드  PR_BRANCH_PREFIX  머지된 PR
 *   merge  auto-merge 거부     PR 모드  PR_BRANCH_PREFIX  머지된 PR
 *   push   브랜치 푸시 거부    PR 모드  PR_BRANCH_PREFIX  머지된 PR
 *   land   ff 경로 실패        ff 모드  FF_BRANCH_PREFIX  머지된 PR **또는** master 포함
 *
 * 게이트는 6중이다.
 *   1. 4종 제목이 워크플로 최상위 `env:` 의 prefix/suffix 쌍으로만 존재한다.
 *      리터럴 재등장을 금지하는 게 핵심이다 — 여는 스텝이 자기 문자열을 들고
 *      있으면 한쪽만 리워딩되는 순간 닫기 로직이 **조용히** 매칭에 실패한다.
 *      감지기가 제거하려던 바로 그 종류의 무관측 실패다. 브랜치 이름도 같은
 *      이유로 env 다: 닫는 쪽이 이슈에서 브랜치를 **역산**해야 한다.
 *   2. 여는 스텝 3개와 닫는 스텝이 **모두 존재하고**, 각자 자기 env 를 참조한다.
 *   3. 닫는 스텝의 `case` 4개 arm 이 (매칭 prefix/suffix, 태그를 벗겨내는
 *      prefix/suffix, 브랜치 prefix) 를 **같은 종에서** 가져온다. arm 간
 *      복붙 오류(PUSH 로 매칭하고 MERGE 로 벗기기)는 태그를 망가뜨리는데
 *      런타임에는 아무 소리도 안 난다.
 *   4. env 실값 기준으로 4종 패턴이 **상호 배타**다. `stall` 과 `merge` 는
 *      prefix 가 바이트 단위로 동일하고 suffix 로만 갈린다 — 여기가 실제
 *      위험 지점이라 값으로 잰다.
 *   5. 닫기 스텝의 `gh pr list` **명령줄에서 뽑은** `--state` 값이 `['merged']` 와
 *      정확히 일치한다. `closed` 로 넓히면 "머지 안 된 채 닫힌 PR"(누가 배지 싱크를
 *      폐기한 경우)까지 해소로 오판해 사람이 알아야 할 이슈를 조용히 닫는다.
 *   6. `land` 전용 containment 판정의 두 값이 allowlist 정확 비교다:
 *      `gh api` compare 경로 1건, `LANDED_COMPARE_STATUSES` = identical·behind.
 *
 *      5·6 이 allowlist 정확 비교인 이유: 5 는 처음에 `toContain('--state merged')` +
 *      `not.toContain('--state all')` 이었고 **거짓 그린이었다**. 명령을
 *      `--state closed` 로 바꿔도 바로 위 주석이 positive 를 채워 11/11 이
 *      통과했다(실측 2026-08-24). 그래서 (a) 주석을 걷어낸 실행 셸에서만 읽고
 *      (b) 부정 목록 대신 allowlist 정확 비교를 한다. 부정 목록은 나열하지 않은
 *      미래 값에 항상 fail-open 이다(rules §8).
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ─────────────────────
 *   - **스텝이 실제로 실행되는지·성공하는지는 보지 않는다.** 여기는 정적 문자열
 *     스캔이다. "파일이 있다 ≠ 실행된다 ≠ 성공한다". 닫기 경로의 실측은 다음
 *     stable 릴리스 런 로그에서 `Stall-issue reconciliation complete.` 를
 *     확인하는 것뿐이다. 4종 확장 후에도 **라이브 발화 0회**다.
 *   - **셸 실행 자체는 검증하지 않는다.** 아래 4·5·6 은 셸 텍스트에서 뽑은
 *     값을 JS 로 재현해 재는 것이라 **모델과 실물이 어긋나면 못 본다**.
 *     2026-08-24 에 fake `gh`(PATH 선행 스크립트) 하네스로 실물 셸을
 *     `bash -eo pipefail` 아래 **25케이스 전건 통과**시켰고(4종 × 해소/미해소,
 *     compare 4상태, 쿼리 3종 장애, 손편집 제목, 4종 혼합), 변이 3건
 *     (allowlist 에 `ahead` 추가 / `push` arm 삭제 / `land` compare 폴백 무력화)이
 *     전부 RED 로 뒤집히는 것까지 확인했다. **그 하네스는 리포에 없다** —
 *     bash 의존이라 vitest 게이트로 못 옮긴다.
 *   - **`compare` 의 의미는 GitHub 계약이고 여기서 검증하지 않는다.**
 *     `identical`/`behind` 가 정말 "브랜치 커밋이 전부 master 에 있다"인지는
 *     라이브 API 로만 확인된다. 실측 미완 — v4.51.0 에서 ff 착지가 실패해
 *     `land` 이슈 #114 가 실제로 열렸으나(2026-08-28), master 가 그 브랜치를
 *     포함하지 않아 compare 기반 **해소** 는 아직 한 번도 일어나지 않았다.
 *     (여는 경로는 실측됨, 닫는 경로는 여전히 미실측.)
 *   - **`land` 의 containment 신호는 ff 스텝이 브랜치를 지우지 않는다는 데
 *     의존한다.** 누가 ff 성공 후 `git push --delete` 를 넣으면 compare 가
 *     404 가 되어 닫기가 조용히 멈춘다. 그 부재는 여기서 단언하지 않는다.
 *   - **GitHub 이 이 워크플로를 어떻게 파싱하는지는 모른다.** YAML 라이브러리를
 *     쓰지 않는다(이 플러그인은 zero runtime deps). 문자열이 파일에 있다는 것과
 *     그것이 유효한 워크플로라는 것은 다른 진술이다. 2026-08-24 `actionlint
 *     -shellcheck= -pyflakes=` exit 0 / 세 스텝 본문 `shellcheck -s bash` exit 0
 *     은 이 파일 밖의 수동 실측이다.
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

/** 닫는 스텝의 `name:`. */
const CLOSE_STEP = 'Close resolved badge-sync escalation issues';

/**
 * escalation 4종의 계약. 여는 스텝 이름, env 변수명, 브랜치 prefix 변수명이
 * 한 곳에 모여 있다 — 종을 하나 더 추가하는 사람이 여기만 고치면 나머지
 * 단언이 전부 따라온다.
 */
const KINDS = [
  {
    kind: 'stall',
    openStep: 'Detect silent badge-sync stall',
    prefixVar: 'STALL_TITLE_PREFIX',
    suffixVar: 'STALL_TITLE_SUFFIX',
    branchVar: 'PR_BRANCH_PREFIX',
  },
  {
    kind: 'merge',
    openStep: 'Land badge sync via PR + auto-merge',
    prefixVar: 'MERGE_TITLE_PREFIX',
    suffixVar: 'MERGE_TITLE_SUFFIX',
    branchVar: 'PR_BRANCH_PREFIX',
  },
  {
    kind: 'push',
    openStep: 'Land badge sync via PR + auto-merge',
    prefixVar: 'PUSH_TITLE_PREFIX',
    suffixVar: 'PUSH_TITLE_SUFFIX',
    branchVar: 'PR_BRANCH_PREFIX',
  },
  {
    kind: 'land',
    openStep: 'Land badge sync via ci/** side branch (PAT)',
    prefixVar: 'LAND_TITLE_PREFIX',
    suffixVar: 'LAND_TITLE_SUFFIX',
    branchVar: 'FF_BRANCH_PREFIX',
  },
];

/** 잘라내야 하는 스텝 전부 — 절단기 전제(이름 유일성) 검증 대상이기도 하다. */
const SLICED_STEPS = [CLOSE_STEP, ...new Set(KINDS.map((k) => k.openStep))];

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

/**
 * 스텝 안 모든 `gh api "<path>"` 의 경로를 등장 순서대로 뽑는다.
 *
 * `--state` 와 같은 이유로 allowlist 정확 비교용이다. compare 의 base 를
 * `master` 가 아닌 것으로 바꾸거나 엉뚱한 엔드포인트를 추가하면 배열이 달라져
 * RED 가 된다.
 *
 * @param {string} stepBody sliceStep 결과
 * @returns {string[]} 호출별 API 경로
 */
function ghApiPaths(stepBody) {
  const shell = executableShell(stepBody);
  return [...shell.matchAll(/gh api\s+"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * compare 폴백을 감싸는 **가장 가까운 앞선** `kind` 동등 비교의 리터럴을 뽑는다.
 *
 * 왜 필요한가: 바로 아래 containment 단언 둘은 `gh api` 경로와
 * `LANDED_COMPARE_STATUSES` 의 **값**만 잰다. 그 코드가 실제로 **도달 가능한지**는
 * 보지 않았다. 실측 2026-08-24: 가드를 `"land"` -> `"landx"` 로 바꾸는 변이에서
 * 이 파일 전건이 GREEN 이었다 — 종 이름이 어긋나면 폴백이 영구 도달불가가 되는데도
 * 게이트가 조용했다. "값이 맞다"와 "그 값을 쓰는 코드가 돈다"는 다른 진술이다.
 *
 * 가드 줄을 문자열 통째로 매칭(`toContain('elif [ "${kind}" = "land" ]; then')`)
 * 하지 않는 이유는 5·6 과 같다: 공백·조건 순서 같은 정당한 리팩터에까지 RED 를
 * 내면 이번엔 반대 방향 오탐이다. 그래서 표기가 아니라 **비교 대상 종 이름**만
 * 뽑아 allowlist 비교한다.
 *
 * @param {string} stepBody sliceStep 결과
 * @returns {string | null} 폴백을 감싸는 가드가 비교하는 종 이름.
 *   compare 호출이 없거나 앞선 가드가 하나도 없으면 null (둘 다 RED 로 간다)
 */
function compareFallbackKind(stepBody) {
  const shell = executableShell(stepBody);
  const apiIdx = shell.search(/gh api\s+"[^"]*\/compare\//);
  if (apiIdx === -1) return null;
  // `[ "${kind}" = "x" ]` 와 `[ "x" = "${kind}" ]` 양쪽 표기를 받는다.
  const guardRe =
    /\[\s*"\$\{kind\}"\s*=\s*"([a-z]+)"\s*\]|\[\s*"([a-z]+)"\s*=\s*"\$\{kind\}"\s*\]/g;
  const guards = [...shell.slice(0, apiIdx).matchAll(guardRe)];
  const last = guards.at(-1);
  return last ? (last[1] ?? last[2]) : null;
}

/**
 * `NAME="a b c"` 형태 셸 변수를 공백 분리 배열로 읽는다.
 *
 * @param {string} stepBody sliceStep 결과
 * @param {string} varName 변수명
 * @returns {string[] | null} 값 배열. 변수가 없으면 null
 */
function shellWordList(stepBody, varName) {
  const m = new RegExp(`${varName}="([^"]*)"`).exec(executableShell(stepBody));
  if (!m) return null;
  return m[1].split(/\s+/).filter(Boolean);
}

/**
 * 최상위 `env:` 블록의 `NAME: "value"` 쌍을 읽는다.
 *
 * js-yaml 을 쓰지 않는 이유: 이 플러그인은 zero runtime deps 이고 devDeps 에도
 * YAML 파서가 없다(실측 2026-08-24 `require.resolve('js-yaml')` 실패). 대신
 * 아래 "스캐너 자기검증"이 파싱 건수와 값 비어있음을 단언으로 가둔다.
 *
 * @param {string} yaml 워크플로 전체 텍스트
 * @returns {Record<string, string>} env 이름 → 값
 */
function parseTopLevelEnv(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l === 'env:');
  if (start === -1) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // 다음 최상위 키(jobs:)에서 종료
    const m = /^ {2}([A-Z0-9_]+): "(.*)"$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * 닫는 스텝의 `case` arm 4개를 구조화해 읽는다.
 *
 * arm 하나는 다음 모양이다:
 * ```
 * "${X_TITLE_PREFIX}"*"${X_TITLE_SUFFIX}")
 *   kind="x"
 *   tag="${title#"${X_TITLE_PREFIX}"}"
 *   tag="${tag%"${X_TITLE_SUFFIX}"}"
 *   branch="${?_BRANCH_PREFIX}${tag}" ;;
 * ```
 * 매칭에 쓴 변수와 태그를 벗겨내는 데 쓴 변수가 **갈라지는 복붙 오류**를 잡으려고
 * 다섯 개를 따로 뽑는다.
 *
 * @param {string} stepBody sliceStep 결과
 * @returns {{matchPrefix:string,matchSuffix:string,kind:string|null,
 *            stripPrefix:string|null,stripSuffix:string|null,
 *            branchVar:string|null}[]} arm 목록
 */
function parseKindArms(stepBody) {
  const shell = executableShell(stepBody);
  const armRe = /"\$\{([A-Z0-9_]+)\}"\*"\$\{([A-Z0-9_]+)\}"\)/g;
  const starts = [...shell.matchAll(armRe)];
  return starts.map((m, i) => {
    const from = m.index + m[0].length;
    const to = i + 1 < starts.length ? starts[i + 1].index : shell.length;
    const chunk = shell.slice(from, to);
    const pick = (re) => {
      const hit = re.exec(chunk);
      return hit ? hit[1] : null;
    };
    return {
      matchPrefix: m[1],
      matchSuffix: m[2],
      kind: pick(/kind="([a-z]+)"/),
      stripPrefix: pick(/tag="\$\{title#"\$\{([A-Z0-9_]+)\}"\}"/),
      stripSuffix: pick(/tag="\$\{tag%"\$\{([A-Z0-9_]+)\}"\}"/),
      branchVar: pick(/branch="\$\{([A-Z0-9_]+)\}\$\{tag\}"/),
    };
  });
}

/**
 * bash `case "$t" in "$p"*"$s")` 의 매칭 조건을 그대로 재현한다.
 *
 * `*` 는 0자 이상이므로 조건은 "prefix 로 시작 + suffix 로 끝 + 둘이 겹치지 않을
 * 만큼 길다" 셋 전부다. 길이 조건을 빠뜨리면 짧은 제목에서 오탐이 난다.
 *
 * @param {string} title 이슈 제목
 * @param {string} prefix
 * @param {string} suffix
 * @returns {boolean}
 */
function globMatches(title, prefix, suffix) {
  return (
    title.length >= prefix.length + suffix.length &&
    title.startsWith(prefix) &&
    title.endsWith(suffix)
  );
}

const ENV = parseTopLevelEnv(source);

describe('badge escalation 제목 단일 진실원', () => {
  it('release.yml 을 실제로 읽었다 (경로 오해석 방지)', () => {
    // 경로를 잘못 잡아 빈 문자열을 스캔하고도 "리터럴 0건"으로 green 이 되는 것을 막는다.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('name: Release');
  });

  it('4종 제목 prefix/suffix + 브랜치 prefix 가 최상위 env 에 선언돼 있다', () => {
    expect(source).toMatch(/^env:\s*$/m);
    for (const { kind, prefixVar, suffixVar, branchVar } of KINDS) {
      for (const v of [prefixVar, suffixVar, branchVar]) {
        expect(source, `${kind}: ${v} 선언이 없다`).toMatch(
          new RegExp(`^\\s{2}${v}: "`, 'm'),
        );
        expect(ENV[v], `${kind}: ${v} 값이 비었다`).toBeTruthy();
      }
    }
  });

  it('제목 리터럴이 env 선언 밖에서 재등장하지 않는다', () => {
    // 이 게이트의 존재 이유. 여는 스텝이 자기 문자열을 들고 있으면 한쪽만
    // 리워딩되는 순간 닫기 로직이 아무 소리 없이 매칭에 실패한다.
    //
    // 정확한 횟수로 박는다 — 산문에서 언급하고 싶으면 이 표를 같이 고쳐라.
    // 실측 2026-08-24, 각 초과분이 무엇인지까지 적는다:
    //   `chore(release): badge-sync PR ` 2 = STALL/MERGE prefix 선언 2건.
    //     두 종이 prefix 를 바이트 단위로 공유한다(suffix 로만 갈린다).
    //   ` could not be pushed` 2 = PUSH_TITLE_SUFFIX 선언 1 + ff 경로 재시도
    //     실패 이슈 **본문** 산문 1("could not be pushed, so the retry was
    //     abandoned"). 본문은 제목이 아니라 매칭에 영향이 없다.
    //   나머지 5개는 전부 env 선언 1회뿐이다.
    const expected = [
      ['chore(release): badge-sync PR ', 2],
      [' is stalled — required checks never started', 1],
      [' needs manual merge', 1],
      ['chore(release): badge sync ', 1],
      [' could not land on master', 1],
      ['chore(release): badge-sync branch ', 1],
      [' could not be pushed', 2],
    ];
    for (const [literal, count] of expected) {
      const seen = source.split(literal).length - 1;
      expect(seen, `"${literal}" 가 ${seen}회 등장한다 (기대 ${count}회)`).toBe(count);
    }
  });

  it('브랜치 리터럴이 env 선언 밖에서 재등장하지 않는다', () => {
    // 닫는 쪽은 이슈 제목에서 브랜치를 **역산**한다. 여는 쪽이 브랜치 이름을
    // 리터럴로 들고 있으면 리네이밍 한 번에 닫기가 존재하지 않는 브랜치를
    // 조회하게 되고, 그 결과는 "머지 안 됨"과 구분되지 않는다.
    //
    // 실측 2026-08-24: 각 2회 = env 선언 1 + 랜딩 전략을 설명하는 **주석** 1.
    // 주석은 실행되지 않으므로 드리프트 위험이 아니다.
    for (const [literal, count] of [
      ['ci/sync-badges-', 2],
      ['chore/sync-readme-badges-', 2],
    ]) {
      const seen = source.split(literal).length - 1;
      expect(seen, `"${literal}" 가 ${seen}회 등장한다 (기대 ${count}회)`).toBe(count);
    }
  });

  it('4종 제목 패턴이 상호 배타다 (stall 과 merge 는 prefix 가 동일하다)', () => {
    // 값으로 잰다. `stall` 과 `merge` 는 prefix 가 바이트 단위로 같아서
    // suffix 하나가 유일한 판별부다. 누가 suffix 를 서로 접두 관계가 되게
    // 바꾸면(예: merge suffix 를 stall suffix 의 꼬리로) 한 이슈가 두 arm 에
    // 걸리고, `case` 는 먼저 쓴 arm 을 택해 **틀린 브랜치**를 조회한다.
    const tag = 'v9.9.9';
    for (const own of KINDS) {
      const title = `${ENV[own.prefixVar]}${tag}${ENV[own.suffixVar]}`;
      for (const other of KINDS) {
        const hit = globMatches(title, ENV[other.prefixVar], ENV[other.suffixVar]);
        expect(hit, `${own.kind} 제목이 ${other.kind} 패턴에 ${hit ? '' : '안 '}걸린다`).toBe(
          own.kind === other.kind,
        );
      }
    }
  });
});

describe('badge escalation 여닫이 경로', () => {
  const closeBody = sliceStep(source, CLOSE_STEP);

  it('여는 스텝 3개와 닫는 스텝이 모두 존재한다', () => {
    expect(closeBody, `"${CLOSE_STEP}" 스텝이 없다`).not.toBeNull();
    for (const step of new Set(KINDS.map((k) => k.openStep))) {
      expect(sliceStep(source, step), `"${step}" 스텝이 없다`).not.toBeNull();
    }
  });

  it('각 종의 여는 스텝이 자기 env 쌍으로 제목을 조립한다', () => {
    for (const { kind, openStep, prefixVar, suffixVar } of KINDS) {
      const body = executableShell(sliceStep(source, openStep) ?? '');
      expect(body, `${kind}: ${openStep} 이 \${${prefixVar}} 를 안 쓴다`).toContain(
        `\${${prefixVar}}`,
      );
      expect(body, `${kind}: ${openStep} 이 \${${suffixVar}} 를 안 쓴다`).toContain(
        `\${${suffixVar}}`,
      );
      expect(body).toContain('gh issue create');
    }
  });

  it('여는 스텝이 브랜치도 env 로 조립한다', () => {
    for (const { kind, openStep, branchVar } of KINDS) {
      // stall 감지기는 브랜치를 직접 만들지 않고 badge_pr 스텝 출력에서 받는다.
      if (openStep === 'Detect silent badge-sync stall') continue;
      const body = executableShell(sliceStep(source, openStep) ?? '');
      expect(body, `${kind}: ${openStep} 이 \${${branchVar}} 를 안 쓴다`).toContain(
        `BRANCH="\${${branchVar}}\${GITHUB_REF_NAME}"`,
      );
    }
  });

  it('닫는 스텝의 case arm 4개가 종별로 일관된 변수를 쓴다', () => {
    const arms = parseKindArms(closeBody);
    expect(
      arms.map((a) => a.kind),
      'case arm 종류/순서가 KINDS 와 다르다',
    ).toEqual(KINDS.map((k) => k.kind));
    for (const [i, expectedKind] of KINDS.entries()) {
      const arm = arms[i];
      // 매칭한 변수 == 벗겨내는 변수. 갈라지면 태그가 망가지는데 런타임에는
      // 아무 소리도 안 난다.
      expect(arm.matchPrefix, `${arm.kind} arm 매칭 prefix`).toBe(expectedKind.prefixVar);
      expect(arm.matchSuffix, `${arm.kind} arm 매칭 suffix`).toBe(expectedKind.suffixVar);
      expect(arm.stripPrefix, `${arm.kind} arm 태그 벗기기 prefix`).toBe(expectedKind.prefixVar);
      expect(arm.stripSuffix, `${arm.kind} arm 태그 벗기기 suffix`).toBe(expectedKind.suffixVar);
      expect(arm.branchVar, `${arm.kind} arm 브랜치 prefix`).toBe(expectedKind.branchVar);
    }
  });

  it('닫는 스텝이 같은 env 로 이슈를 닫는다', () => {
    const shell = executableShell(closeBody);
    for (const { prefixVar, suffixVar, branchVar } of KINDS) {
      for (const v of [prefixVar, suffixVar, branchVar]) {
        expect(shell, `닫는 스텝이 \${${v}} 를 안 쓴다`).toContain(`\${${v}}`);
      }
    }
    expect(shell).toContain('gh issue close');
  });

  it('닫는 스텝은 머지된 PR 로만 PR-모드 해소를 판정한다', () => {
    // 실제 `gh pr list` 명령줄에서 뽑은 값을 allowlist 와 **정확히** 비교한다.
    // `merged` 외 어떤 값도(`all`·`closed`·`open`, 플래그 누락 포함) RED 다.
    //
    // 왜 이 형태여야 하는가: `closed` 는 머지된 PR 을 포함하므로 "머지 안 된 채
    // 닫힌 PR"(누가 배지 싱크를 폐기한 경우)까지 해소로 오판해 사람이 알아야 할
    // 이슈를 조용히 닫는다. 리더 실측 2026-08-24:
    // `gh pr list --state closed --head chore/sync-readme-badges-v4.49.0` 이
    // 머지된 #108 을 반환했다.
    //
    // 그 실측은 `closed` 로 잰 것이라, 워크플로가 **실제로 쓰는** `--state merged`
    // 가 `--delete-branch` 로 **지워진 브랜치**에도 동작하는지는 증명하지 않는다.
    // 별개 진술이라 따로 쟀다 — 실측 2026-08-24 16:58 KST, Yoodaddy0311/artibot:
    //   gh api repos/.../branches/chore/sync-readme-badges-v4.49.0
    //     -> 404 "Branch not found"  (브랜치는 실제로 지워져 있다)
    //   gh pr list --head chore/sync-readme-badges-v4.49.0 --state merged --limit 1
    //     -> [{"number":108,"mergedAt":"2026-08-23T02:54:48Z","state":"MERGED"}]
    // 즉 브랜치가 없어도 머지 PR 은 반환된다. 닫기 경로의 PR-모드 판정은 브랜치
    // 잔존에 의존하지 않는다. (`land` 의 compare 폴백은 반대다 — 그쪽은 브랜치가
    // 남아 있어야 하고, 그 전제는 위 "못 보는 것" 목록에 이미 적혀 있다.)
    //
    // 호출이 정확히 1건인 것도 계약이다 — 4종이 같은 쿼리를 공유하므로
    // 종마다 사본이 생기면 그때부터 하나만 고쳐지는 드리프트가 시작된다.
    expect(ghPrListStates(closeBody)).toEqual(['merged']);
  });

  it('land 전용 containment 판정이 allowlist 정확 비교다', () => {
    // ff 경로는 PR 을 열지 않고 master 로 직접 fast-forward 하므로, 성공이
    // 남기는 유일한 흔적이 "브랜치가 master 에 포함됨"이다.
    //
    // base 는 반드시 master 다. 다른 ref 를 base 로 두면 "포함됨"이 전혀 다른
    // 뜻이 되고, 그 오판의 방향은 **이슈를 잘못 닫는 쪽**이다.
    expect(ghApiPaths(closeBody)).toEqual([
      'repos/${GITHUB_REPOSITORY}/compare/master...${branch}',
    ]);
    // 부정 목록이 아니라 허용 목록(rules §8). GitHub 이 status 값을 추가해도
    // 자동 통과되지 않는다. `ahead`·`diverged` 는 브랜치 커밋이 master 에
    // 없다는 뜻이므로 해소가 아니다.
    expect(shellWordList(closeBody, 'LANDED_COMPARE_STATUSES')).toEqual([
      'identical',
      'behind',
    ]);
    // 도달성. 위 두 값이 다 맞아도 폴백이 `land` 아닌 종에 묶여 있으면 영구
    // 도달불가고, 그러면 `land` 이슈는 PR 이 없어 절대 닫히지 않는다.
    // 실측 2026-08-24: 이 단언 이전에는 가드를 `landx` 로 바꿔도 전건 GREEN 이었다.
    expect(compareFallbackKind(closeBody)).toBe('land');
  });

  it('닫는 스텝이 릴리스를 실패시키지 않는다', () => {
    // 이 잡이 도는 시점에 GitHub Release 는 이미 발행돼 있다. 정리 로직 버그가
    // 릴리스를 빨갛게 만들면 안 된다 — 감지기와 같은 자세다.
    expect(closeBody).toContain('continue-on-error: true');
  });

  it('닫는 스텝이 종결 로그를 남긴다 (라이브 발화 확인 문구)', () => {
    // 이 문자열이 릴리스 런 로그에 뜨는 것이 "닫기 경로가 실제로 실행됐다"의
    // 유일한 증거다. 핸드오프가 그렇게 지정했으므로 리워딩하면 RED 다.
    expect(executableShell(closeBody)).toContain('Stall-issue reconciliation complete.');
  });
});

describe('스캐너 자기검증', () => {
  // 게이트 자체가 거짓 green 이 되지 않게 절단기·추출기를 직접 검증한다.
  it('sliceStep 이 없는 스텝에 null 을 돌려준다', () => {
    expect(sliceStep(source, 'No Such Step Name Anywhere')).toBeNull();
  });

  it('sliceStep 이 스텝 경계를 넘어가지 않는다', () => {
    const closeBody = sliceStep(source, CLOSE_STEP);
    // 닫는 스텝 바로 뒤 스텝의 고유 문자열이 새어 들어오면 절단 실패다.
    expect(closeBody).not.toContain('actions/setup-node');
  });

  it('잘라내는 스텝 이름들이 파일 안에서 유일하다 (절단기 전제)', () => {
    // `sliceStep` 은 findIndex 로 첫 매치만 잡는다. 같은 이름이 두 번 나오면
    // 조용히 엉뚱한 본문을 검사하게 된다.
    //
    // 파일 **전체** 스텝 이름이 유일한 것은 아니다 — 겹치는 둘은 잡이 달라
    // 정상인 `Checkout repository`(validate·release)와 `Setup Node.js 22`
    // (validate·sync-readmes)다. 그래서 전역이 아니라 이 게이트가 실제로
    // 자르는 이름들만 요구한다.
    for (const stepName of SLICED_STEPS) {
      const hits = source
        .split(/\r?\n/)
        .filter((l) => l.trim() === `- name: ${stepName}`).length;
      expect(hits, `"${stepName}" 가 ${hits}회 등장한다`).toBe(1);
    }
  });

  it('parseTopLevelEnv 가 env 블록만, 전량 읽는다', () => {
    // 파싱이 조용히 0건이 되면 위의 "값이 비었다" 단언들이 undefined 를 통과시킬
    // 뻔한다 — 그래서 건수를 박는다.
    const names = Object.keys(ENV).sort();
    expect(names).toEqual([
      'FF_BRANCH_PREFIX',
      'LAND_TITLE_PREFIX',
      'LAND_TITLE_SUFFIX',
      'MERGE_TITLE_PREFIX',
      'MERGE_TITLE_SUFFIX',
      'PR_BRANCH_PREFIX',
      'PUSH_TITLE_PREFIX',
      'PUSH_TITLE_SUFFIX',
      'STALL_TITLE_PREFIX',
      'STALL_TITLE_SUFFIX',
    ]);
    // 잡 수준 env 나 `jobs:` 아래 내용을 빨아들이면 안 된다.
    expect(ENV.GH_TOKEN).toBeUndefined();
    expect(parseTopLevelEnv('env:\n  A: "x"\njobs:\n  b:\n    env:\n      C: "y"\n')).toEqual({
      A: 'x',
    });
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

  it('ghApiPaths 가 주석을 무시하고 줄 연속을 넘어 경로를 찾는다', () => {
    const body = [
      '              # gh api "repos/x/compare/EVIL...${branch}" would be a lie',
      '              s="$(gh api \\',
      '                "repos/${R}/compare/master...${branch}" \\',
      "                --jq '.status')\"",
    ].join('\n');
    expect(ghApiPaths(body)).toEqual(['repos/${R}/compare/master...${branch}']);
    expect(ghApiPaths('echo none')).toEqual([]);
  });

  it('compareFallbackKind 가 도달성 변이를 잡는다', () => {
    const body = (guard) =>
      [
        '            if [ -n "${merged_at}" ]; then',
        '              resolution="a PR merged"',
        `            elif ${guard}; then`,
        '              # gh api "repos/${R}/compare/master...${branch}" in a comment',
        '              s="$(gh api "repos/${R}/compare/master...${branch}")"',
        '            fi',
      ].join('\n');
    expect(compareFallbackKind(body('[ "${kind}" = "land" ]'))).toBe('land');
    // 실파일에서 살아남았던 바로 그 변이.
    expect(compareFallbackKind(body('[ "${kind}" = "landx" ]'))).toBe('landx');
    // 표기 흔들림은 통과시킨다 — 정당한 리팩터에 오탐 RED 를 내지 않는다.
    expect(compareFallbackKind(body('[  "${kind}"  =  "land"  ]'))).toBe('land');
    expect(compareFallbackKind(body('[ "land" = "${kind}" ]'))).toBe('land');
    // 가드가 통째로 사라져 모든 종이 compare 를 타면 null — allowlist 비교에서 RED.
    expect(compareFallbackKind(body('true'))).toBeNull();
    // compare 호출 자체가 없어도 null.
    expect(compareFallbackKind('elif [ "${kind}" = "land" ]; then :')).toBeNull();
  });

  it('shellWordList 가 변이를 값으로 구분한다', () => {
    expect(shellWordList('X="identical behind"', 'X')).toEqual(['identical', 'behind']);
    expect(shellWordList('X="identical behind ahead"', 'X')).toEqual([
      'identical',
      'behind',
      'ahead',
    ]);
    expect(shellWordList('X=""', 'X')).toEqual([]);
    // 변수가 통째로 사라지면 null — allowlist 비교에서 RED.
    expect(shellWordList('Y="identical"', 'X')).toBeNull();
    // 주석 안의 선언은 값이 아니다.
    expect(shellWordList('# X="ahead"\nX="behind"', 'X')).toEqual(['behind']);
  });

  it('parseKindArms 가 매칭/벗기기 변수 불일치를 잡아낸다', () => {
    // 실제로 일어나는 복붙 오류를 합성 픽스처로 재현한다: PUSH 로 매칭하고
    // MERGE 로 벗기는 arm. 태그가 조용히 망가지는데 실행은 성공한다.
    const bad = [
      '  "${PUSH_TITLE_PREFIX}"*"${PUSH_TITLE_SUFFIX}")',
      '    kind="push"',
      '    tag="${title#"${MERGE_TITLE_PREFIX}"}"',
      '    tag="${tag%"${PUSH_TITLE_SUFFIX}"}"',
      '    branch="${PR_BRANCH_PREFIX}${tag}" ;;',
    ].join('\n');
    const [arm] = parseKindArms(bad);
    expect(arm.matchPrefix).toBe('PUSH_TITLE_PREFIX');
    expect(arm.stripPrefix).toBe('MERGE_TITLE_PREFIX');
    expect(arm.stripPrefix).not.toBe(arm.matchPrefix); // 실파일 단언이 잡는 지점
    expect(arm.kind).toBe('push');
    expect(arm.branchVar).toBe('PR_BRANCH_PREFIX');
    // arm 이 없으면 빈 배열 — 위 `toEqual(KINDS...)` 비교에서 RED.
    expect(parseKindArms('case "$t" in *) : ;; esac')).toEqual([]);
  });

  it('globMatches 가 bash case 의 길이 조건까지 재현한다', () => {
    expect(globMatches('AxB', 'A', 'B')).toBe(true);
    expect(globMatches('AB', 'A', 'B')).toBe(true); // `*` 는 0자도 매치
    // prefix 와 suffix 가 겹칠 만큼 짧으면 bash 도 매치하지 않는다.
    expect(globMatches('A', 'A', 'A')).toBe(false);
    expect(globMatches('xAB', 'A', 'B')).toBe(false);
    expect(globMatches('ABx', 'A', 'B')).toBe(false);
  });
});
