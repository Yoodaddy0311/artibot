/**
 * 사람 게이트 강제 판정 코어 — `decideHumanGate` (CA-04 L1).
 *
 * `human-gates.js#classify` 는 "이 행동이 HG-nn 에 해당한다"만 말한다(기록 전용).
 * 이 모듈은 그 위에서 **강제 여부 하나**를 정한다:
 *   매트릭스 적중 → 행별 보호 범위 술어 → `permissions.humanGates.enforce` 설정
 *   → `pass | record | ask | deny` (ENFORCE_DECISIONS, allowlist).
 * 판정 대상 행은 HG-07·HG-12·HG-13 (ENFORCEABLE_GATE_IDS). 그 밖 행 적중은 기록만.
 * HG-07 강제 시점은 오너 결정 O2 대기 — 매트릭스 판정 대상이지만 ENFORCE_DEFAULTS.gates 에는 없다.
 *
 * ── 순수성 계약 ─────────────────────────────────────────────────────────────
 *  파일·네트워크 I/O, 환경변수, 시계, 난수, node 내장 모듈 로딩 0. 설정 객체와 플러그인
 *  루트는 전부 인자로 주입된다(환경변수의 플러그인 루트를 여기서 읽지 않는다). 같은 입력
 *  → 같은 출력. tests/security/human-gate-enforce.test.js 가 소스 스캔으로 핀한다.
 *
 * ── 호출자 0 · 기본 off ─────────────────────────────────────────────────────
 *  훅 배선(L2) 전이라 프로덕션 호출자가 없다. 설정 키 부재 = ENFORCE_DEFAULTS = 꺼짐
 *  (출하 artibot.config.json 에는 이 키가 없다 — 이 줄기는 그 파일을 편집하지 않는다).
 *  부재·부분·이상 설정의 해석은 resolveEnforceConfig 한 곳에만 있다.
 *  artibot config 의 `permissions.humanGates` 는 호스트 settings.json 의
 *  `permissions.allow/ask` 와 별개다(이름만 같은 다른 계층).
 *  강제('ask'/'deny')는 다음이 전부 참일 때만 나온다:
 *    적중 ∧ 보호 범위 ∧ enabled===true ∧ 설정 검증 통과 ∧ mode==='enforce' ∧ gate∈gates.
 *  그때 permissionMode ∈ askHonoredModes 면 'ask', 목록 밖·부재·비문자열이면 'deny'.
 *  강제가 꺼져 있어도 `wouldDecide` 에 "강제했다면" 결정을 남긴다(섀도 계측용).
 *
 * ── 설계 선택과 근거 ────────────────────────────────────────────────────────
 *  (1) 설정 이상값 → **강제 안 함 + configErrors 노출**(fail-closed 아님). 근거:
 *      ① 부분만 맞는 설정은 오너 의도가 모호하다 — 어느 쪽으로 추측해도 틀릴 수 있다.
 *      ② ask/deny 는 사용자에게 보이는 행동 변화이고, askHonored 밖 모드에서는 deny 라
 *         오타 하나가 에이전트 루프 전체를 막는다.
 *      ③ 출하 설정의 오타는 selfcheck 게이트(validateEnforceConfig)가 CI 에서 잡는다.
 *      ④ 적대적 에이전트에 대한 방어력은 같다 — 설정 파일 자체가 HG-13 보호 대상이고,
 *         더 쉬운 우회(enabled:false)가 똑같이 그 게이트를 거친다.
 *      단 enabled 는 엄격히 `=== true` 만 켜짐이다(킬스위치 — 'true' 문자열은 꺼짐+오류).
 *      빠진 키는 오류가 아니라 ENFORCE_DEFAULTS 로 채운다(전부 가장 약한 값). 기본
 *      askHonoredModes 는 [] — L0 호스트 ask 프로브 결과로 채울 자리이고 [미확인]이다.
 *  (2) 경로는 **항상 소문자로 비교**한다(플랫폼 인자 없음). 대소문자 구분 파일시스템에서는
 *      `.Claude/Settings.json` 도 보호로 보게 되는데, 이는 과보호 방향이라 순수성을 위해
 *      감수한다. msys 형 `/c/…` 는 `c:/…` 로 접는다.
 *  (3) Bash 경로 행은 `$` 앵커 행 패턴 대신 두 탐지의 합이다: (a) 명령 토큰마다
 *      isClaudeConfigPath, (b) worktree 접두를 벗긴 명령에 비앵커·창 제한(192) 매치
 *      `.claude/ … <보호 basename>`(cd 뒤 상대 이름 같은 형을 잡으려고 토큰을 넘는다).
 *  (4) Bash 면제는 allowlist: 단일 세그먼트(셸 체인·치환·리다이렉트 문자 없음) ∧ 선두 동사
 *      ∈ EXEMPT_LEAD_VERBS 또는 git 하위명령 ∈ EXEMPT_GIT_SUBCOMMANDS(전역 옵션도 allowlist)
 *      ∧ `tee`·`-i…`·`--output…`·`--pre…` 없음. 면제는 HG-07/12/13 에 똑같이 적용된다
 *      (`grep "gh pr merge" docs` 같은 인용을 기록만 하게). echo·printf 는 리다이렉트 없이는
 *      아무것도 쓰지 않으므로 읽기 전용 목록에 더했다.
 *  (5) 플래그 행(HG-12 `--dangerously-skip-permissions`, HG-13 `--no-verify`·
 *      `bypassPre(Commit|Push)Hooks true`)의 보호 범위 = "면제가 아닌 모든 Bash". git 동사
 *      문맥 allowlist 로 좁히면 모르는 래퍼(`bash -c`, npm 스크립트, 별칭)에서 fail-open 이라
 *      택하지 않았다. 대가: `git commit -m "… --no-verify …"` 는 거짓 양성이다.
 *  (6) HG-07: `gh pr merge`·`git push … main` 은 항상 보호. curl 행은 명령 안의 **모든**
 *      대상 호스트가 loopback(127.0.0.0/8 · localhost · ::1)일 때만 비보호. 대상 = 스킴 URL 의
 *      호스트 ∪ 호스트 모양 맨 토큰. 대상이 없으면 loopback 을 증명 못 하므로 보호. 값이
 *      대상이 아닌 curl 옵션(CURL_VALUE_OPTIONS)의 인자만 건너뛴다 — `--proxy`·`--connect-to`
 *      등 나머지 옵션 인자는 대상으로 본다(fail-closed).
 *  (7) pluginRoot 는 절대 경로일 때만 쓴다(상대면 무시). 설치 캐시는 `.claude` 세그먼트로
 *      이미 보호된다. pluginRoot 가 worktree 소스 자신이면 그 소스의 보호 basename 은 보호다.
 *  (8) 이 경로는 `classify` 를 부르지 않는다. 매트릭스 행은 evaluateMatrix 가 같은 규칙으로
 *      평가하되 HG-13[2] 원본(`\s*["':=\s]+` — 인접 런이 공백을 공유하는 2차식, 규칙 단독
 *      20K 공백 약 200ms, tests/helpers/regex-scan.js 카탈로그 (vi))만 창 제한 대체 매처
 *      BYPASS_HOOKS_TRUE 로 바꾼다(MATRIX_PATTERN_SUBSTITUTES). 행 자체는 불변. 교체 전 이
 *      모듈 전체 경로 실측(2026-09-28 14:58, `bypassPreCommitHooks`+공백×n, 3회 중앙값):
 *      n=2,500/5,000/10,000/20,000 → 6.7/21.1/117.5/375.4ms. **같은 호출에서 classify 도 부르는
 *      호출자(L2 기록 경로 등)는 그 2차식 비용을 그대로 물려받는다** — 원본 행 수리는 후속.
 *  (9) 입력 길이·토큰 수 상한은 두지 않는다. 경로 정규화·토큰화·worktree 조각 제거·URL
 *      추출은 전부 입력에 선형이다(세그먼트 최대화 필러 스윕이 테스트에서 핀). 캡을 두면 캡을
 *      넘긴 토큰이 조용히 비보호가 되는 fail-open 이 되고, 캡 초과를 보호로 간주하면 긴
 *      정상 명령이 거짓 양성이 된다 — 선형이 증명된 동안은 어느 쪽 비용도 살 이유가 없다.
 *      2026-09-28 toPathSegments 가 reduce+spread 로 세그먼트 수에 2차식이었다(122,880B
 *      `a://` 채움 5,018.4ms → 수리 후 3.5ms, 3회 중앙값, 15:15). 누적은 지역 배열 push/pop 로 한다.
 *
 * ── 이 설계가 못 보는 것 ────────────────────────────────────────────────────
 *  1. Bash 간접 쓰기: 변수 확장(`$P/settings.json`, `$CLAUDE_CONFIG_DIR/…`), `node -e`·
 *     python·perl 이 파일을 쓰는 형, 심볼릭 링크·정션, 인코딩·이스케이프 우회(base64 | sh 등),
 *     cwd 가 `.claude/` 안일 때의 맨 이름(`cd` 가 같은 명령에 없으면), 스크립트 파일 실행.
 *  2. HG-07 정규식 3종 밖의 외부 쓰기: wget --post-*, httpie, python requests, `gh api -X POST`,
 *     `curl -d`(-X 없는 암묵 POST), `-X` 가 curl 뒤 192자를 넘는 형 — 매트릭스 적중이
 *     필요조건이므로 여기서도 안 보인다.
 *  3. 관리형(managed) settings 경로 [미확인] — OS 별 정책 경로는 보호 집합에 없다.
 *  4. 상대 경로의 pluginRoot 소속 판정 — 순수 함수라 cwd 를 모른다.
 *  5. 8.3 단축형과 긴 이름의 동일성 — 경로에 `.claude` 세그먼트가 없고 pluginRoot 와 표기가
 *     다르면(HEECHA~1 대 긴 이름) 놓친다. 파일시스템 조회 없이는 풀 수 없다.
 *  6. HG-13 의 다른 우회: `git commit -n`, `HUSKY=0`, `core.hooksPath` 변경 — 매트릭스 밖.
 *  7. 거짓 양성(강제 시 ask/deny): 커밋 메시지 속 `--no-verify`, curl `-o out.json` 이 아닌
 *     위치의 파일명·본문 속 도메인 모양 문자열, `.claude/` 를 읽고 다른 곳에 쓰는 체인.
 *  8. HG-13[2] 대체 매처는 구분자 17자 이상(`bypassPrePushHooks` 와 `true` 사이 공백·따옴표·
 *     콜론 등)을 놓친다 — 원본은 잡는다(테스트가 이 차이를 핀). 이 모듈의 ReDoS 스윕은
 *     대체 매처와 전체 경로를 재고, 원본 행의 2차식은 재지 않는다(측정값은 (8) 참조).
 *
 * @module lib/security/human-gate-enforce
 */

import { getGateRow, HUMAN_GATE_MATRIX } from './human-gates.js';

/** 결정 어휘. 뒤로 갈수록 강하다(pass < record < ask < deny). */
export const ENFORCE_DECISIONS = Object.freeze(['pass', 'record', 'ask', 'deny']);

/** `enforce.mode` allowlist. */
export const ENFORCE_MODES = Object.freeze(['shadow', 'enforce']);

/** 판정 대상 행. `enforce.gates` 는 이 집합의 부분집합이어야 한다. */
export const ENFORCEABLE_GATE_IDS = Object.freeze(['HG-07', 'HG-12', 'HG-13']);

/** 전체 config 객체 안의 enforce 설정 위치 — 이 상수와 readEnforceConfig 한 곳에만 둔다. */
export const ENFORCE_CONFIG_PATH = Object.freeze(['permissions', 'humanGates', 'enforce']);

/** enforce 객체의 키 allowlist(전부 필수). */
export const ENFORCE_CONFIG_KEYS = Object.freeze(['enabled', 'mode', 'gates', 'askHonoredModes']);

/** 사유 어휘. 결과의 `reason` 과 각 hit 의 `reason` 은 이 안에만 있다. */
export const ENFORCE_REASONS = Object.freeze([
  'invalid-input',
  'no-hit',
  'row-not-enforceable',
  'out-of-scope',
  'gate-not-configured',
  'mode-ask-honored',
  'mode-not-ask-honored',
  'enforce-disabled',
  'config-invalid',
  'shadow-mode',
]);

/** 보호 basename. artibot.config.json 은 HG-13, 나머지는 HG-12 에 속한다. */
export const PROTECTED_CONFIG_BASENAMES = Object.freeze([
  'settings.json',
  'settings.local.json',
  'hooks.json',
  'dispatch-table.json',
  'artibot.config.json',
]);

/** 경로 probe 로 보호 범위를 정하는 도구(HG-12·HG-13 행의 tools 중 Bash 를 뺀 것). */
export const PATH_TOOLS = Object.freeze(['Write', 'Edit']);

/** Bash 면제 — 리다이렉트 없이는 아무것도 쓰지 않는 선두 동사. */
export const EXEMPT_LEAD_VERBS = Object.freeze(['cat', 'head', 'tail', 'grep', 'rg', 'ls', 'stat', 'echo', 'printf']);

/** Bash 면제 — 읽기 전용 git 하위명령. */
export const EXEMPT_GIT_SUBCOMMANDS = Object.freeze(['show', 'diff', 'log']);

/** git 면제 판정에서 건너뛰어도 되는 전역 옵션(`-C <path>` 는 인자를 하나 먹는다). `-c` 는 설정 주입이라 없다. */
export const EXEMPT_GIT_GLOBAL_OPTIONS = Object.freeze(['--no-pager', '-P', '--no-optional-locks']);

/** 값이 전송 대상이 아닌 curl 옵션 — 다음 토큰을 대상 후보에서 뺀다. 목록 밖 옵션 인자는 대상으로 본다. */
export const CURL_VALUE_OPTIONS = Object.freeze([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary',
  '--data-urlencode', '--json', '-F', '--form', '-o', '--output', '-u', '--user',
  '-A', '--user-agent', '-w', '--write-out',
]);

/** HG-07 patterns 중 loopback 완화를 받는 curl 행의 인덱스(테스트가 결합을 핀한다). */
export const HG07_CURL_PATTERN_INDEX = 0;

/**
 * 출하 기본값 — 설정 키가 없거나 일부만 있을 때 빈 자리를 채운다(resolveEnforceConfig).
 * 전부 가장 약한 쪽이다: 꺼짐 · shadow · 초기 gates(HG-07 은 오너 결정 O2 대기라 제외).
 * askHonoredModes 는 L0 호스트 ask 프로브 결과로 채울 자리다 — 호스트가 어느 권한 모드에서
 * ask 를 실제로 존중하는지 [미확인]이므로 [](강제 시 전부 deny, allowlist fail-closed).
 */
export const ENFORCE_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'shadow',
  gates: Object.freeze(['HG-12', 'HG-13']),
  askHonoredModes: Object.freeze([]),
});

/**
 * 이 모듈의 정규식 전부(ReDoS 카탈로그 등록 대상). 가변 길이 런은 전부 192 이하로 창
 * 제한이고, g·y 플래그가 없다(공유 lastIndex 상태 없음). BARE_* · IPV4_LOOPBACK 은 `^`
 * 앵커라 시작 위치가 하나다. BASH_* 는 슬래시로 정규화·소문자화한 명령에 댄다.
 * 내부 참조용 이름표이고, 외부 계약은 아래 ENFORCE_PATTERNS 배열이다.
 */
const RE = Object.freeze({
  BASH_HG12_PATH: /\.claude\/[^\n]{0,192}(?<![\w.-])(?:settings(?:\.local)?|hooks|dispatch-table)\.json(?![\w.-])/i,
  BASH_HG13_PATH: /\.claude\/[^\n]{0,192}(?<![\w.-])artibot\.config\.json(?![\w.-])/i,
  SKIP_PERMISSIONS_FLAG: /(?<![\w-])--dangerously-skip-permissions(?![\w-])/i,
  NO_VERIFY_FLAG: /(?<![\w-])--no-verify(?![\w-])/i,
  BYPASS_HOOKS_TRUE: /\bbypassPre(?:Commit|Push)Hooks["':=\s]{1,16}true\b/i,
  SHELL_CHAIN_META: /[;&|\n\r`>]|\$\(|<\(/,
  TOKEN_SEPARATOR: /[\s=<>|;&()'"`,]/,
  WHITESPACE: /\s/,
  URL_AUTHORITY: /\b[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/?#'"<>\\]{1,192})/i,
  BARE_HOST: /^(?:localhost|[a-z0-9-]{1,63}\.[a-z0-9.-]{1,192})(?::\d{1,5})?(?:[/?#]|$)/i,
  BARE_IPV6_HOST: /^\[[0-9a-f:.]{2,64}\](?::\d{1,5})?(?:[/?#]|$)/i,
  IPV4_LOOPBACK: /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
});

/**
 * 새 정규식 카탈로그 — 동결 배열, 항목마다 고정 `id` + `pattern`(RegExp).
 * tests/autopilot/safety.test.js 가 import 해 findUnboundedRuns·ceilingFor 로 스캔한다.
 * @type {ReadonlyArray<Readonly<{id: string, pattern: RegExp}>>}
 */
export const ENFORCE_PATTERNS = Object.freeze(
  Object.entries(RE).map(([id, pattern]) => Object.freeze({ id, pattern })),
);

/**
 * 강제 경로에서 매트릭스 행 패턴 대신 쓰는 창 제한 대체 매처. 키 = `<행 id>[<패턴 인덱스>]`,
 * 값 = ENFORCE_PATTERNS 의 id. HG-13[2] 원본 `\s*["':=\s]+` 는 인접 런이 공백을 공유하는
 * 2차식이다(tests/helpers/regex-scan.js 못 보는 것 (vi) 실례). 행은 불변이어야 하므로 이
 * 경로만 대체하고, 정상 입력 동치는 테스트 표가 핀한다.
 */
export const MATRIX_PATTERN_SUBSTITUTES = Object.freeze({ 'HG-13[2]': 'BYPASS_HOOKS_TRUE' });

const WORKTREE_MARKER = '.claude/worktrees/';

/** @param {*} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/** @param {*} value @returns {string|undefined} */
function stringOrUndefined(value) {
  return typeof value === 'string' ? value : undefined;
}

// ── 설정 ───────────────────────────────────────────────────────────────────

/**
 * 전체 config 에서 enforce 객체를 꺼낸다. 경로 중간이 없거나 객체가 아니면 undefined.
 * @param {*} config
 * @returns {*}
 */
export function readEnforceConfig(config) {
  let node = config;
  for (const key of ENFORCE_CONFIG_PATH) {
    if (node === null || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, key)) {
      return undefined;
    }
    node = node[key];
  }
  return node;
}

/** 미지 키(오타 포함) 거부. 빠진 키는 오류가 아니다 — ENFORCE_DEFAULTS 가 채운다. */
function checkEnforceKeys(enforce) {
  return Object.keys(enforce)
    .filter((key) => !ENFORCE_CONFIG_KEYS.includes(key))
    .map((key) => `enforce.${key}: unknown key (allowed: ${ENFORCE_CONFIG_KEYS.join('|')})`);
}

/** @param {object} enforce @returns {string[]} */
function checkEnforceScalars(enforce) {
  const errors = [];
  if (Object.hasOwn(enforce, 'enabled') && typeof enforce.enabled !== 'boolean') {
    errors.push(`enforce.enabled: must be a boolean, got ${JSON.stringify(enforce.enabled)}`);
  }
  if (Object.hasOwn(enforce, 'mode') && !ENFORCE_MODES.includes(enforce.mode)) {
    errors.push(`enforce.mode: unknown mode ${JSON.stringify(enforce.mode)} (allowed: ${ENFORCE_MODES.join('|')})`);
  }
  return errors;
}

/**
 * @param {string} where
 * @param {*} list
 * @param {(item: *, at: string) => string|null} checkItem
 * @returns {string[]}
 */
function checkStringList(where, list, checkItem) {
  if (!Array.isArray(list)) return [`${where}: must be an array of strings`];
  return list.flatMap((item, index) => {
    const at = `${where}[${index}]`;
    if (!isNonEmptyString(item)) return [`${at}: must be a non-empty string, got ${JSON.stringify(item)}`];
    if (list.indexOf(item) !== index) return [`${at}: duplicate ${JSON.stringify(item)}`];
    const problem = checkItem(item, at);
    return problem === null ? [] : [problem];
  });
}

/** @param {string[]} matrixIds @returns {(id: string, at: string) => string|null} */
function gateIdChecker(matrixIds) {
  return (id, at) => {
    if (!matrixIds.includes(id)) return `${at}: unknown gate id ${JSON.stringify(id)}`;
    if (!ENFORCEABLE_GATE_IDS.includes(id)) {
      return `${at}: ${JSON.stringify(id)} is not enforceable (allowed: ${ENFORCEABLE_GATE_IDS.join('|')})`;
    }
    return null;
  };
}

/**
 * enforce 설정 검증. 부재(undefined)와 부분 설정(빠진 키)은 위반 0 이다 — 빈 자리는
 * ENFORCE_DEFAULTS 로 읽힌다. 미지 키·타입 오류·미지 mode·미지/판정 대상 밖 gate id·중복을 거부한다.
 * selfcheck 게이트가 출하 설정과 일부러 깨뜨린 합성 설정에 대고 부른다.
 *
 * @param {*} enforce - `readEnforceConfig(config)` 의 결과
 * @param {ReadonlyArray<{id: string}>} [matrix=HUMAN_GATE_MATRIX]
 * @returns {string[]} 위반 목록. 빈 배열이면 통과
 */
export function validateEnforceConfig(enforce, matrix = HUMAN_GATE_MATRIX) {
  if (enforce === undefined) return [];
  if (enforce === null || typeof enforce !== 'object' || Array.isArray(enforce)) {
    return ['enforce: must be an object'];
  }
  const matrixIds = Array.isArray(matrix) ? matrix.map((row) => (row ? row.id : undefined)) : [];
  const gateErrors = Object.hasOwn(enforce, 'gates')
    ? checkStringList('enforce.gates', enforce.gates, gateIdChecker(matrixIds))
    : [];
  const modeErrors = Object.hasOwn(enforce, 'askHonoredModes')
    ? checkStringList('enforce.askHonoredModes', enforce.askHonoredModes, () => null)
    : [];
  return [...checkEnforceKeys(enforce), ...checkEnforceScalars(enforce), ...gateErrors, ...modeErrors];
}

/**
 * 부재·부분·이상 설정의 해석 규칙 — 이 함수 하나에만 둔다.
 *  - 키 부재(경로 중간 포함) → ENFORCE_DEFAULTS 그대로(꺼짐), present:false.
 *  - 있는 키만 덮고 빠진 키는 ENFORCE_DEFAULTS.
 *  - 이상값은 가장 약한 쪽으로 읽는다: enabled 는 `=== true` 만 켜짐, gates 는 판정 대상
 *    id 만 남김, 비배열 목록은 []. 검증 오류는 errors 로 노출하고 decideHumanGate 는
 *    errors 가 있으면 강제하지 않는다.
 *
 * @param {*} config - 전체 artibot config 객체
 * @returns {Readonly<{present: boolean, errors: ReadonlyArray<string>, enabled: boolean,
 *   mode: *, gates: ReadonlyArray<string>, askHonoredModes: ReadonlyArray<string>}>}
 */
export function resolveEnforceConfig(config) {
  const raw = readEnforceConfig(config);
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const valueOf = (key) => (Object.hasOwn(source, key) ? source[key] : ENFORCE_DEFAULTS[key]);
  const gates = valueOf('gates');
  const askHonoredModes = valueOf('askHonoredModes');
  return Object.freeze({
    present: raw !== undefined,
    errors: Object.freeze(validateEnforceConfig(raw)),
    enabled: valueOf('enabled') === true,
    mode: valueOf('mode'),
    gates: Object.freeze(Array.isArray(gates) ? gates.filter((id) => ENFORCEABLE_GATE_IDS.includes(id)) : []),
    askHonoredModes: Object.freeze(Array.isArray(askHonoredModes) ? askHonoredModes.filter(isNonEmptyString) : []),
  });
}

// ── 경로 ───────────────────────────────────────────────────────────────────

/** @param {string} ch @returns {boolean} */
function isAsciiLetter(ch) {
  return ch >= 'a' && ch <= 'z';
}

/**
 * `\`→`/`, 소문자화, msys 드라이브(`/c/…`→`c:/…`), 빈·`.` 세그먼트 제거, `..` 해소.
 * 절대 posix 경로는 첫 원소 '/', 드라이브 경로는 첫 원소 'c:' 로 표시한다.
 * @param {string} p
 * @returns {string[]}
 */
function toPathSegments(p) {
  const slashed = p.split('\\').join('/').toLowerCase();
  const msys = slashed.length >= 2 && slashed[0] === '/' && isAsciiLetter(slashed[1])
    && (slashed.length === 2 || slashed[2] === '/');
  const text = msys ? `${slashed[1]}:${slashed.slice(2)}` : slashed;
  const headLength = text.startsWith('/') ? 1 : 0;
  // 지역 누적 배열(외부에 새지 않음 — 호출자는 읽기만 한다). reduce + spread 는 세그먼트 수에
  // 2차식이었다(헤더 설계 선택 (9) 실측).
  const out = headLength === 1 ? ['/'] : [];
  for (const seg of text.split('/')) {
    if (seg === '' || seg === '.') continue;
    const last = out[out.length - 1];
    const poppable = out.length > headLength && last !== '..' && !last.endsWith(':');
    if (seg === '..' && poppable) out.pop();
    else out.push(seg);
  }
  return out;
}

/** @param {string[]} segs @returns {boolean} */
function isAbsoluteSegments(segs) {
  return segs.length > 0 && (segs[0] === '/' || (segs[0].length === 2 && segs[0][1] === ':'));
}

/** 마지막 `.claude/worktrees/<name>/` 까지 벗긴다(name 뒤에 무언가 있을 때만). */
function stripWorktreePrefix(segs) {
  for (let i = segs.length - 4; i >= 0; i -= 1) {
    if (segs[i] === '.claude' && segs[i + 1] === 'worktrees') return segs.slice(i + 3);
  }
  return segs;
}

/** @param {*} pluginRoot @returns {string[]} 절대 경로가 아니면 [] */
function rootSegmentsOf(pluginRoot) {
  if (!isNonEmptyString(pluginRoot)) return [];
  const segs = toPathSegments(pluginRoot);
  return isAbsoluteSegments(segs) ? segs : [];
}

/** @param {string[]} segs @param {string[]} rootSegs @returns {boolean} */
function isUnder(segs, rootSegs) {
  if (rootSegs.length === 0 || segs.length <= rootSegs.length) return false;
  return rootSegs.every((seg, index) => segs[index] === seg);
}

/**
 * 보호 범위 술어 — 이 경로가 Claude/Artibot 설정 파일인가.
 *
 * 보호 = basename ∈ PROTECTED_CONFIG_BASENAMES ∧
 *   ( `.claude/worktrees/<name>/` 를 벗긴 뒤에도 디렉터리에 `.claude` 세그먼트가 있다
 *     ∨ 경로가 절대 pluginRoot 아래다 ).
 * 줄기 worktree 안의 리포 소스는 소스 사본이라 비보호, worktree 자신의 `.claude/…` 는 보호.
 *
 * @param {*} p
 * @param {{pluginRoot?: string}} [options]
 * @returns {boolean}
 */
export function isClaudeConfigPath(p, options = {}) {
  if (!isNonEmptyString(p)) return false;
  const segs = toPathSegments(p);
  if (!PROTECTED_CONFIG_BASENAMES.includes(segs[segs.length - 1])) return false;
  if (stripWorktreePrefix(segs).slice(0, -1).includes('.claude')) return true;
  const pluginRoot = options !== null && typeof options === 'object' ? options.pluginRoot : undefined;
  return isUnder(segs, rootSegmentsOf(pluginRoot));
}

/** @param {string} p @returns {'HG-12'|'HG-13'} */
function gateForPath(p) {
  const segs = toPathSegments(p);
  return segs[segs.length - 1] === 'artibot.config.json' ? 'HG-13' : 'HG-12';
}

// ── Bash ───────────────────────────────────────────────────────────────────

/** @param {string} command @returns {string[]} */
function commandTokens(command) {
  return command.split(RE.TOKEN_SEPARATOR).filter((token) => token !== '');
}

/** @param {string} ch @returns {boolean} */
function endsWorktreeName(ch) {
  return ch === '/' || RE.TOKEN_SEPARATOR.test(ch);
}

/**
 * 정규화된 명령 문자열에서 `.claude/worktrees/<name>/` 조각을 지운다(선형 1회 순회).
 * @param {string} text - 슬래시 정규화·소문자화된 명령
 * @returns {string}
 */
function stripWorktreeSpans(text) {
  const parts = [];
  let from = 0;
  let at = text.indexOf(WORKTREE_MARKER, from);
  while (at !== -1) {
    parts.push(text.slice(from, at));
    let end = at + WORKTREE_MARKER.length;
    while (end < text.length && !endsWorktreeName(text[end])) end += 1;
    from = text[end] === '/' ? end + 1 : end;
    at = text.indexOf(WORKTREE_MARKER, from);
  }
  parts.push(text.slice(from));
  return parts.join('');
}

/** @param {string} command @param {string|undefined} pluginRoot @returns {Set<string>} */
function bashPathGateIds(command, pluginRoot) {
  const tokenIds = commandTokens(command)
    .filter((token) => isClaudeConfigPath(token, { pluginRoot }))
    .map(gateForPath);
  const stripped = stripWorktreeSpans(command.split('\\').join('/').toLowerCase());
  const windowIds = [['HG-12', RE.BASH_HG12_PATH], ['HG-13', RE.BASH_HG13_PATH]]
    .filter(([, re]) => re.test(stripped))
    .map(([id]) => id);
  return new Set([...tokenIds, ...windowIds]);
}

/** @param {string} command @returns {Set<string>} */
function bashFlagGateIds(command) {
  const hg12 = RE.SKIP_PERMISSIONS_FLAG.test(command) ? ['HG-12'] : [];
  const hg13 = RE.NO_VERIFY_FLAG.test(command) || RE.BYPASS_HOOKS_TRUE.test(command)
    ? ['HG-13']
    : [];
  return new Set([...hg12, ...hg13]);
}

/** @param {string} word @returns {boolean} */
function isWriteLeaningWord(word) {
  return word === 'tee' || word.startsWith('-i') || word.startsWith('--output') || word.startsWith('--pre');
}

/** @param {string[]} args - `git` 뒤 단어들 @returns {string|null} 하위명령(소문자) */
function gitSubcommand(args) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-C') {
      i += 2;
    } else if (EXEMPT_GIT_GLOBAL_OPTIONS.includes(arg)) {
      i += 1;
    } else {
      return arg.startsWith('-') ? null : arg.toLowerCase();
    }
  }
  return null;
}

/**
 * 면제 판정(allowlist). 단일 세그먼트 ∧ 선두 동사가 읽기 전용 ∧ 쓰기 쪽 단어 없음.
 * @param {string} command
 * @returns {boolean}
 */
function isInertBashCommand(command) {
  const text = command.trim();
  if (text === '' || RE.SHELL_CHAIN_META.test(text)) return false;
  const words = text.split(RE.WHITESPACE).filter((word) => word !== '');
  if (words.some(isWriteLeaningWord)) return false;
  const leadSegs = words[0].split('\\').join('/').split('/');
  const verb = leadSegs[leadSegs.length - 1].toLowerCase();
  if (verb === 'git') return EXEMPT_GIT_SUBCOMMANDS.includes(gitSubcommand(words.slice(1)));
  return EXEMPT_LEAD_VERBS.includes(verb);
}

/** @param {string|undefined} command @param {string|undefined} pluginRoot */
function analyzeBash(command, pluginRoot) {
  if (!isNonEmptyString(command)) {
    return Object.freeze({ inert: false, pathIds: new Set(), flagIds: new Set() });
  }
  return Object.freeze({
    inert: isInertBashCommand(command),
    pathIds: bashPathGateIds(command, pluginRoot),
    flagIds: bashFlagGateIds(command),
  });
}

// ── HG-07 loopback ─────────────────────────────────────────────────────────

/** @param {string} authority - `userinfo@host:port` @returns {string} 소문자 호스트 */
function hostOfAuthority(authority) {
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    return close === -1 ? hostPort : hostPort.slice(1, close);
  }
  const colons = hostPort.split(':').length - 1;
  return colons > 1 ? hostPort : hostPort.split(':')[0];
}

/** @param {string} token @returns {string[]} 토큰 안 스킴 URL 들의 authority */
function urlAuthorities(token) {
  const found = [];
  let rest = token;
  let match = RE.URL_AUTHORITY.exec(rest);
  while (match !== null) {
    found.push(match[1]);
    rest = rest.slice(match.index + match[0].length);
    match = RE.URL_AUTHORITY.exec(rest);
  }
  return found;
}

/** @param {string} token @returns {string[]} 이 토큰이 가리키는 대상 호스트 */
function hostsInToken(token) {
  const authorities = urlAuthorities(token);
  if (authorities.length > 0) return authorities.map(hostOfAuthority);
  if (!RE.BARE_HOST.test(token) && !RE.BARE_IPV6_HOST.test(token)) return [];
  const cut = [...token].findIndex((ch) => ch === '/' || ch === '?' || ch === '#');
  return [hostOfAuthority(cut === -1 ? token : token.slice(0, cut))];
}

/** @param {string} host @returns {boolean} */
function isLoopbackHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  return RE.IPV4_LOOPBACK.test(host) && host.split('.').every((octet) => Number(octet) <= 255);
}

/** @param {string} command @returns {boolean} 대상이 하나 이상이고 전부 loopback */
function allTargetsLoopback(command) {
  const tokens = commandTokens(command);
  const hosts = tokens.flatMap((token, index) => (
    index > 0 && CURL_VALUE_OPTIONS.includes(tokens[index - 1]) ? [] : hostsInToken(token)
  ));
  return hosts.length > 0 && hosts.every(isLoopbackHost);
}

/** @param {string} command @returns {boolean} */
function hg07InScope(command) {
  const patterns = getGateRow('HG-07').patterns;
  const alwaysProtected = patterns.filter((_, index) => index !== HG07_CURL_PATTERN_INDEX);
  if (alwaysProtected.some((re) => re.test(command))) return true;
  return !allTargetsLoopback(command);
}

// ── 판정 ───────────────────────────────────────────────────────────────────

/**
 * @param {string} id
 * @param {{tool: string, command?: string, path?: string, pluginRoot?: string}} request
 * @param {{inert: boolean, pathIds: Set<string>, flagIds: Set<string>}|null} bash
 * @returns {boolean}
 */
function isInScope(id, request, bash) {
  if (!ENFORCEABLE_GATE_IDS.includes(id)) return false;
  if (request.tool === 'Bash') {
    if (bash === null || bash.inert || !isNonEmptyString(request.command)) return false;
    if (id === 'HG-07') return hg07InScope(request.command);
    return bash.pathIds.has(id) || bash.flagIds.has(id);
  }
  if (PATH_TOOLS.includes(request.tool) && id !== 'HG-07') {
    return isClaudeConfigPath(request.path, { pluginRoot: request.pluginRoot }) && gateForPath(request.path) === id;
  }
  return false;
}

/** 행의 probe 에 맞는 입력 문자열들(classify 의 probe 선택과 같은 규칙). */
function rowProbes(row, request) {
  const wantsCommand = row.probe === 'command' || row.probe === 'both';
  const wantsPath = row.probe === 'path' || row.probe === 'both';
  return [
    ...(wantsCommand && isNonEmptyString(request.command) ? [request.command] : []),
    ...(wantsPath && isNonEmptyString(request.path) ? [request.path] : []),
  ];
}

/** 행 패턴 — MATRIX_PATTERN_SUBSTITUTES 에 등록된 자리만 창 제한 대체 매처로 바꾼다. */
function rowPatterns(row) {
  return row.patterns.map((pattern, index) => {
    const substitute = MATRIX_PATTERN_SUBSTITUTES[`${row.id}[${index}]`];
    return substitute === undefined ? pattern : RE[substitute];
  });
}

/**
 * 매트릭스 적중 id 목록 — `classify` 와 같은 규칙(도구 allowlist · probe 선택 · 매트릭스 순서)
 * 이되 HG-13[2] 만 창 제한 대체 매처로 평가한다. 강제 경로가 classify 를 부르지 않는 이유는
 * 그 2차식을 차단 경로로 물려받지 않기 위해서다. 정상 입력에서 classify 와의 동치는 테스트가 핀.
 *
 * @param {{tool?: string, command?: string, path?: string}} [input]
 * @returns {string[]}
 */
export function evaluateMatrix(input) {
  if (input === null || typeof input !== 'object') return [];
  const tool = isNonEmptyString(input.tool) ? input.tool : null;
  const request = { command: stringOrUndefined(input.command), path: stringOrUndefined(input.path) };
  return HUMAN_GATE_MATRIX
    .filter((row) => row.patterns.length > 0 && (tool === null || row.tools.includes(tool)))
    .filter((row) => {
      const probes = rowProbes(row, request);
      return rowPatterns(row).some((pattern) => probes.some((probe) => pattern.test(probe)));
    })
    .map((row) => row.id);
}

/** 매트릭스 적중 ∪ Bash 토큰 탐지를 매트릭스 순서로. */
function collectHits(request) {
  const classified = evaluateMatrix(request);
  const bash = request.tool === 'Bash' ? analyzeBash(request.command, request.pluginRoot) : null;
  const detected = bash === null ? [] : [...bash.pathIds, ...bash.flagIds];
  return HUMAN_GATE_MATRIX
    .map((row) => row.id)
    .filter((id) => classified.includes(id) || detected.includes(id))
    .map((id) => ({ id, inScope: isInScope(id, request, bash) }));
}

/** @param {{id: string, inScope: boolean}} hit @param {string} decision @param {string} reason */
function verdict(hit, decision, reason) {
  return Object.freeze({ id: hit.id, inScope: hit.inScope, decision, reason });
}

/** 한 적중의 "강제가 켜져 있다면" 결정. */
function judgeHit(hit, settings, permissionMode) {
  if (!ENFORCEABLE_GATE_IDS.includes(hit.id)) return verdict(hit, 'record', 'row-not-enforceable');
  if (!hit.inScope) return verdict(hit, 'record', 'out-of-scope');
  if (!settings.gates.includes(hit.id)) return verdict(hit, 'record', 'gate-not-configured');
  const honored = isNonEmptyString(permissionMode) && settings.askHonoredModes.includes(permissionMode);
  return honored ? verdict(hit, 'ask', 'mode-ask-honored') : verdict(hit, 'deny', 'mode-not-ask-honored');
}

/** 가장 강한 결정, 동률이면 판정 대상 행, 그다음 매트릭스 순서. */
function drivingVerdict(verdicts) {
  const score = (v) => ENFORCE_DECISIONS.indexOf(v.decision) * 2 + (ENFORCEABLE_GATE_IDS.includes(v.id) ? 1 : 0);
  return verdicts.reduce((best, v) => (score(v) > score(best) ? v : best));
}

/** @returns {Readonly<object>} */
function freezeResult({ decision, wouldDecide, gate, reason, hits, configErrors }) {
  return Object.freeze({
    decision,
    wouldDecide,
    gate,
    reason,
    hits: Object.freeze([...hits]),
    configErrors: Object.freeze([...configErrors]),
  });
}

/** 강제 스위치를 적용해 최종 결정을 낸다. settings = resolveEnforceConfig 결과. */
function settle(verdicts, settings) {
  const configErrors = settings.errors;
  if (verdicts.length === 0) {
    return freezeResult({ decision: 'pass', wouldDecide: 'pass', gate: null, reason: 'no-hit', hits: [], configErrors });
  }
  const driving = drivingVerdict(verdicts);
  const common = { wouldDecide: driving.decision, gate: driving.id, hits: verdicts, configErrors };
  if (driving.decision !== 'ask' && driving.decision !== 'deny') {
    // gates 를 읽지 못해 "미설정"이 된 경우는 그 원인(설정 오류)을 사유로 올린다.
    const unreadable = driving.reason === 'gate-not-configured' && configErrors.length > 0;
    return freezeResult({ ...common, decision: 'record', reason: unreadable ? 'config-invalid' : driving.reason });
  }
  if (!settings.enabled) return freezeResult({ ...common, decision: 'record', reason: 'enforce-disabled' });
  if (configErrors.length > 0) return freezeResult({ ...common, decision: 'record', reason: 'config-invalid' });
  if (settings.mode !== 'enforce') return freezeResult({ ...common, decision: 'record', reason: 'shadow-mode' });
  return freezeResult({ ...common, decision: driving.decision, reason: driving.reason });
}

/**
 * 도구 호출 하나에 대한 사람 게이트 강제 판정. **순수 함수** — 설정·루트는 주입.
 *
 * @param {{
 *   tool: string,
 *   command?: string,
 *   path?: string,
 *   permissionMode?: string,
 *   config?: object,
 *   pluginRoot?: string,
 * }} input
 * @returns {Readonly<{
 *   decision: 'pass'|'record'|'ask'|'deny',
 *   wouldDecide: 'pass'|'record'|'ask'|'deny',
 *   gate: string|null,
 *   reason: string,
 *   hits: ReadonlyArray<Readonly<{id: string, inScope: boolean, decision: string, reason: string}>>,
 *   configErrors: ReadonlyArray<string>,
 * }>}
 */
export function decideHumanGate(input) {
  if (input === null || typeof input !== 'object' || !isNonEmptyString(input.tool)) {
    return freezeResult({
      decision: 'pass', wouldDecide: 'pass', gate: null, reason: 'invalid-input', hits: [], configErrors: [],
    });
  }
  const settings = resolveEnforceConfig(input.config);
  const request = Object.freeze({
    tool: input.tool,
    command: stringOrUndefined(input.command),
    path: stringOrUndefined(input.path),
    pluginRoot: stringOrUndefined(input.pluginRoot),
  });
  const verdicts = collectHits(request).map((hit) => judgeHit(hit, settings, input.permissionMode));
  return settle(verdicts, settings);
}
