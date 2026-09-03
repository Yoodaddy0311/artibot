/**
 * 사람 게이트 단일 정본 표 — `HUMAN_GATE_MATRIX` (HG-01 … HG-13).
 *
 * 설계 정본: ARTIBOT-5.0-DESIGN §3.5 "사람 게이트 단일 지점" · 레인 5 §1-D(강제 지점
 * 실측 10행) · §3-C(코드 강제 단일 지점) · §5-③(`.artibot/project.md#Human Approval
 * Boundaries` 본문 = 이 13행). 행 구성은 v5 설계 패키지
 * `.artibot/guides/v5-design/package/11_SAFE_AUTONOMY_HUMAN_GATES.md` 의 게이트 표
 * **10행** + vNext `.artibot/guides/vnext-design/09_SECURITY_GOVERNANCE.md` 의 Action
 * Risk Matrix 중 `secret/credential change`·`permission escalation`·`security policy
 * disable` **3행** = 13행이다.
 *
 * ── Observe 단계의 계약 (PRD §3 "행동 변화 0") ──────────────────────────────
 *  이 모듈은 **분류·기록만** 한다. 어떤 차단도 새로 만들지 않는다. `classify()` 가
 *  hit 를 돌려주는 것은 "막아야 한다" 가 아니라 "이 행동이 HG-nn 에 해당한다" 는
 *  뜻이다. 훅 배선(기존 block 지점에서 사유 토큰·원장 기록)은 T-39 가 소유하며,
 *  그때에도 `decision` 은 불변이다(PRD R-03).
 *
 * ── allowlist 형 (설계 §1-7) ────────────────────────────────────────────────
 *  행·`default`·`enforcement`·`probe`·`tools` 전부 열거형이다. 부정 목록이 아니다.
 *  매칭되지 않은 행동은 "안전" 이 아니라 **미분류**다 — 이 표는 미분류를 통과로
 *  해석하지 않는다(그 판단은 소비자 몫).
 *
 * ── 중복 정의 금지 (레인 5 §3-C) ────────────────────────────────────────────
 *  이미 `lib/core/blocked-patterns.js` 의 BLOCKED_PATTERNS 또는
 *  `lib/autopilot/safety.js` 의 DANGEROUS_PATTERNS 가 잡는 패턴은 **여기서 다시
 *  정의하지 않는다.** 대신 `existingCoverage[]` 로 그 파일·규칙 id 를 인용한다.
 *  각 행의 `patterns[]` 는 레인 5 §1-D 가 실측한 **구멍(현행 0건)** 만 담는다.
 *  `tests/firewall/human-gate-matrix-selfcheck.test.js` 가 두 파일과의 정규식 원문
 *  교집합이 0 임을 고정한다.
 *
 * ── 다중 hit 의 해석 ────────────────────────────────────────────────────────
 *  한 행동이 여러 행에 걸릴 수 있다(예: `artibot.config.json` 쓰기 = HG-02 로컬 편집
 *  ∧ HG-13 보안 정책 비활성화). `classify()` 는 매트릭스 순서대로 **전부** 돌려준다.
 *  단일 판정이 필요한 소비자는 가장 엄격한 `default` 를 취한다(human > policy > auto).
 *  이 모듈은 그 축약을 하지 않는다 — Observe 단계에서 축약은 정보 손실이다.
 *
 * @module lib/security/human-gates
 */

/** 행의 기본 처리. allowlist — 이 3값 밖은 `validateMatrix` 가 거부한다. */
export const GATE_DEFAULTS = Object.freeze(['auto', 'policy', 'human']);

/**
 * 2026-09-02 기준 **현행** 강제 지점. 설계 목표가 아니라 실측값이다.
 *  - `hook`  : PreToolUse 훅이 실제로 막는다(부분 강제는 `enforcementNote` 로 표기)
 *  - `prose` : 문서·프롬프트에만 있고 코드 0
 *  - `none`  : 강제도 산문도 없다
 */
export const GATE_ENFORCEMENTS = Object.freeze(['hook', 'prose', 'none']);

/** 패턴을 어떤 입력에 대는가. */
export const GATE_PROBES = Object.freeze(['command', 'path', 'both']);

/**
 * @typedef {Object} HumanGateRow
 * @property {string} id - `HG-01` … `HG-13`
 * @property {string} action - 행동 이름(정본 표의 행)
 * @property {'auto'|'policy'|'human'} default
 * @property {'hook'|'prose'|'none'} enforcement - 2026-09-02 현행
 * @property {string} [enforcementNote] - 부분 강제일 때 무엇까지만 강제되는지
 * @property {string|null} policyRef - `policy:<config key>` 또는 null
 * @property {string} [note] - `policyRef` 를 가진 행의 `default` 가 `policy` 가
 *   아닐 때 **필수** — 왜 승격/강등됐는지. 정본 표와 실제 값이 어긋난 자리를
 *   조용히 두지 않기 위한 것이다(`checkDecidability` 가 강제).
 * @property {'command'|'path'|'both'} probe
 * @property {ReadonlyArray<string>} tools - 이 행이 보는 도구 allowlist
 * @property {ReadonlyArray<RegExp>} patterns - **신규** 패턴만(구멍)
 * @property {ReadonlyArray<string>} existingCoverage - 이미 잡는 곳의 인용
 * @property {string} evidence - 근거(file:line 또는 정본 절)
 * @property {{reason: string, evidence: string}} [undetectable] - 패턴화 불가 선언
 */

/**
 * HG-01 … HG-13. 순서는 v5 §11 표 10행 → vNext §09 3행.
 * @type {ReadonlyArray<HumanGateRow>}
 */
export const HUMAN_GATE_MATRIX = Object.freeze([
  Object.freeze({
    id: 'HG-01',
    action: '읽기·검색·분석',
    default: 'auto',
    enforcement: 'none',
    policyRef: null,
    probe: 'command',
    tools: Object.freeze(['Bash']),
    patterns: Object.freeze([
      /^\s*(?:cat|head|tail|less|more|grep|rg|find|ls|stat|wc|diff|tree)\b/i,
    ]),
    existingCoverage: Object.freeze([]),
    evidence: 'v5 11_SAFE_AUTONOMY_HUMAN_GATES.md 게이트 표 "Read/search/analyze | auto". 강제 불필요 — 분류용 행',
  }),
  Object.freeze({
    id: 'HG-02',
    action: '로컬 되돌릴 수 있는 편집',
    default: 'auto',
    enforcement: 'none',
    policyRef: null,
    probe: 'path',
    tools: Object.freeze(['Write', 'Edit', 'NotebookEdit']),
    patterns: Object.freeze([
      /\.(?:js|mjs|cjs|jsx|ts|tsx|json|md|css|scss|html|py|rb|go|rs|java|sh|yml|yaml|txt)$/i,
    ]),
    existingCoverage: Object.freeze([]),
    evidence: 'v5 게이트 표 "Local reversible edit | auto". 보호 대상 파일은 HG-12·HG-13 이 함께 hit 한다',
  }),
  Object.freeze({
    id: 'HG-03',
    action: '테스트·빌드·린트',
    default: 'auto',
    enforcement: 'none',
    policyRef: null,
    probe: 'command',
    tools: Object.freeze(['Bash']),
    patterns: Object.freeze([
      /^\s*(?:npx\s+|pnpm\s+|yarn\s+)?(?:vitest|jest|pytest|mocha|eslint|tsc|prettier)\b/i,
      /^\s*(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:build|lint|test|typecheck|prebuild))\b/i,
    ]),
    existingCoverage: Object.freeze([]),
    evidence: 'v5 게이트 표 "Tests/build/lint | auto" · vNext 09 Action Risk Matrix "unit test / full build | O"',
  }),
  Object.freeze({
    id: 'HG-04',
    action: '워크트리·브랜치 생성',
    default: 'auto',
    enforcement: 'none',
    policyRef: null,
    probe: 'command',
    tools: Object.freeze(['Bash']),
    patterns: Object.freeze([
      /\bgit\s+worktree\s+(?:add|list|prune)\b/i,
      /\bgit\s+(?:switch|checkout)\s+-[bc]\b/i,
      /\bgit\s+branch\b/i,
    ]),
    existingCoverage: Object.freeze([
      'lib/core/blocked-patterns.js BLOCKED_PATTERNS "git branch -D (force delete)" — 파괴 형은 HG-09',
    ]),
    evidence: 'v5 게이트 표 "Worktree/branch | auto". `git branch -D` 는 HG-09 와 동시 hit',
  }),
  Object.freeze({
    id: 'HG-05',
    action: '로컬 커밋',
    default: 'auto',
    enforcement: 'none',
    enforcementNote: 'v5 표는 "auto when requested by mission" — 그 미션 조건을 코드가 확인하는 지점은 0건(2026-09-02)',
    policyRef: null,
    probe: 'command',
    tools: Object.freeze(['Bash']),
    patterns: Object.freeze([
      /\bgit\s+commit\b/i,
    ]),
    existingCoverage: Object.freeze([]),
    evidence: 'v5 게이트 표 "Local commit | auto when requested by mission" · vNext 09 "commit | 정책"',
  }),
  Object.freeze({
    id: 'HG-06',
    action: 'PR 생성',
    default: 'policy',
    enforcement: 'none',
    policyRef: 'policy:ago.selfControl.autoPR.enabled',
    probe: 'command',
    tools: Object.freeze(['Bash']),
    patterns: Object.freeze([
      /\bgh\s+pr\s+create\b/i,
    ]),
    existingCoverage: Object.freeze([]),
    evidence: 'v5 게이트 표 "PR creation | policy". 키 실재: artibot.config.json 의 ago.selfControl.autoPR.enabled',
  }),
  Object.freeze({
    id: 'HG-07',
    action: '외부 시스템 쓰기',
    default: 'human',
    enforcement: 'none',
    enforcementNote: '레인 5 §1-D 행 4 실측: blockExternalSend 를 읽는 코드 0건. 막는 것은 파이프-투-셸 형뿐이고 curl -X POST 는 safety.js 의 caution(경고)일 뿐 차단이 아니다',
    note: 'v5 §11 = policy, OD-1 로 human 승격',
    policyRef: 'policy:autopilot.safety.blockExternalSend',
    probe: 'command',
    tools: Object.freeze(['Bash']),
    patterns: Object.freeze([
      /\bcurl\b[^\n]*\s-X\s*['"]?(?:POST|PUT|PATCH|DELETE)\b/i,
      /\bgh\s+pr\s+merge\b/i,
      /\bgit\s+push\b[^\n]*\b(?:master|main)\b/i,
    ]),
    existingCoverage: Object.freeze([
      'lib/autopilot/safety.js DANGEROUS_PATTERNS id="curl-external" (level=caution — 차단 아님)',
      'lib/core/blocked-patterns.js BLOCKED_PATTERNS "curl pipe to interpreter"',
    ]),
    evidence: 'v5 게이트 표 "External system write | policy" 이나 OD-1(설계 §0 "파괴·배포·외부쓰기·제품결정은 단계와 무관하게 항상 사람")이 이를 이겨 human. 레인 5 §3-C 행 4 및 행 9(보호 브랜치 직접 push)',
  }),
  Object.freeze({
    id: 'HG-08',
    action: '프로덕션 배포',
    default: 'human',
    enforcement: 'hook',
    enforcementNote: 'npm publish 한 건만 강제된다. 레인 5 §1-D 행 3 실측: gh release · docker push · vercel|fly|netlify deploy · terraform apply · kubectl apply 는 0건',
    policyRef: null,
    probe: 'command',
    tools: Object.freeze(['Bash']),
    patterns: Object.freeze([
      /\bgh\s+release\s+(?:create|upload|edit|delete)\b/i,
      /\bdocker\s+push\b/i,
      /\b(?:vercel|fly|netlify)\s+deploy\b/i,
      /\bterraform\s+apply\b/i,
      /\bkubectl\s+apply\b/i,
    ]),
    existingCoverage: Object.freeze([
      'lib/core/blocked-patterns.js BLOCKED_PATTERNS "npm publish"',
      'lib/autopilot/safety.js DANGEROUS_PATTERNS id="npm-publish"',
    ]),
    evidence: 'v5 게이트 표 "Production deployment | human gate unless pre-authorized" · vNext 09 "prod deploy | 기본 X"',
  }),
  Object.freeze({
    id: 'HG-09',
    action: '되돌릴 수 없는 파괴적 행동',
    default: 'human',
    enforcement: 'hook',
    enforcementNote: 'fs 파괴 · force push · DDL(DROP/TRUNCATE) · DELETE no-WHERE 는 강제된다. 레인 5 §1-D 행 5 실측: UPDATE … SET no-WHERE · prisma migrate deploy · alembic upgrade 는 0건',
    policyRef: null,
    probe: 'command',
    tools: Object.freeze(['Bash']),
    patterns: Object.freeze([
      /\bprisma\s+migrate\s+deploy\b/i,
      /\balembic\s+upgrade\b/i,
      /\bUPDATE\s+[\w."`[\]]+\s+SET\b(?![\s\S]*\bWHERE\b)/i,
    ]),
    existingCoverage: Object.freeze([
      'lib/core/blocked-patterns.js BLOCKED_PATTERNS category="filesystem" (rm -rf 계열)',
      'lib/core/blocked-patterns.js BLOCKED_PATTERNS category="git" (force push · reset --hard · branch -D)',
      'lib/core/blocked-patterns.js BLOCKED_PATTERNS category="database" (DROP/TRUNCATE/DELETE no-WHERE)',
      'lib/autopilot/safety.js DANGEROUS_PATTERNS ids: rm-rf-root · rm-rf-broad · git-force-push · git-reset-hard · sql-drop-table · sql-truncate · sql-delete-no-where',
    ]),
    evidence: 'v5 게이트 표 "Irreversible destructive action | human gate" · vNext 09 "destructive DB migration | X" · 레인 5 §3-C 행 5',
  }),
  Object.freeze({
    id: 'HG-10',
    action: '제품·비즈니스 선택(유효한 값이 둘 이상)',
    default: 'human',
    enforcement: 'prose',
    policyRef: null,
    probe: 'command',
    tools: Object.freeze([]),
    patterns: Object.freeze([]),
    existingCoverage: Object.freeze([]),
    undetectable: Object.freeze({
      reason: '이 행은 도구 호출의 형태가 아니라 의도에 대한 판정이다. {tool, command, path} 어디에도 서명이 없다 — 같은 Edit 이 제품 결정일 수도 아닐 수도 있다. 패턴을 붙이면 반드시 거짓 양성이거나 거짓 음성이 된다.',
      evidence: '레인 5 §1-D 행 8 실측: AskUserQuestion|confirm|approval 을 lib/autopilot·scripts/hooks 에서 검색해 코드 0건. 강제 지점은 산문(Problem-First Gate · v5 ADR 질문)뿐',
    }),
    evidence: 'v5 게이트 표 "Product/business choice with multiple valid values | human decision" · vNext 09 "semantic merge conflict | X"',
  }),
  Object.freeze({
    id: 'HG-11',
    action: '시크릿·크리덴셜 변경',
    default: 'human',
    enforcement: 'hook',
    enforcementNote: '쓰기 측만 강제된다. 두 패턴 집합 모두 artibot-policy 카테고리라 Artibot 리포 밖에서는 스킵된다. 레인 5 §1-D 행 6 실측: 읽기(cat .env)는 미차단',
    policyRef: null,
    probe: 'both',
    tools: Object.freeze(['Bash', 'Write', 'Edit']),
    patterns: Object.freeze([
      /^\s*(?:cat|less|head|tail|more|type)\b[^\n]*\.env(?:\.[\w-]+)?\b/i,
      /^\s*(?:cat|less|head|tail|more|type)\b[^\n]*\b(?:id_rsa|id_ed25519|credentials\.json|kubeconfig)\b/i,
    ]),
    existingCoverage: Object.freeze([
      'lib/core/guard-registry.js:221 SENSITIVE_PATTERNS (Write/Edit 경로)',
      'lib/core/guard-registry.js:238 SECRET_CONTENT_PATTERNS (쓰기 내용)',
      'lib/autopilot/safety.js DANGEROUS_PATTERNS ids: secret-openai · secret-private-key · secret-aws',
    ]),
    evidence: 'vNext 09 Action Risk Matrix "secret/credential change | X | human" · 레인 5 §1-D 행 6',
  }),
  Object.freeze({
    id: 'HG-12',
    action: '권한 상승 (설정·훅·디스패치 자기수정)',
    default: 'human',
    enforcement: 'none',
    enforcementNote: '오히려 화이트리스트다 — scripts/hooks/pre-write-guard.js 의 isWhitelisted 가 .claude/ 를 포함한 경로를 무조건 승인한다',
    policyRef: null,
    probe: 'both',
    tools: Object.freeze(['Bash', 'Write', 'Edit']),
    patterns: Object.freeze([
      /(?:^|[\\/])settings(?:\.local)?\.json$/i,
      /(?:^|[\\/])hooks\.json$/i,
      /(?:^|[\\/])dispatch-table\.json$/i,
      /--dangerously-skip-permissions\b/i,
    ]),
    existingCoverage: Object.freeze([
      'lib/core/blocked-patterns.js BLOCKED_PATTERNS category="permission" (chmod 777 · chown root)',
    ]),
    evidence: 'vNext 09 "permission escalation | X | human" · 레인 5 §1-D 행 7 · §3-C 행 7 · scripts/hooks/pre-write-guard.js isWhitelisted',
  }),
  Object.freeze({
    id: 'HG-13',
    action: '보안 정책 비활성화',
    default: 'human',
    enforcement: 'none',
    policyRef: null,
    probe: 'both',
    tools: Object.freeze(['Bash', 'Write', 'Edit']),
    patterns: Object.freeze([
      /(?:^|[\\/])artibot\.config\.json$/i,
      /--no-verify\b/i,
      /\bbypassPre(?:Commit|Push)Hooks\s*["':=\s]+true\b/i,
    ]),
    existingCoverage: Object.freeze([]),
    evidence: 'vNext 09 "security policy disable | X | human" · 레인 5 §3-C 행 7 · artibot.config.json 의 git.autopilot.bypassPrePushHooks',
  }),
]);

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @param {*} value
 * @param {(item: *) => boolean} isItem
 * @returns {boolean}
 */
function isArrayOf(value, isItem) {
  return Array.isArray(value) && value.every(isItem);
}

/**
 * 열거 어휘 — 알 수 없는 `default`·`enforcement`·`probe` 값을 거부한다.
 * @param {HumanGateRow} row
 * @param {string} where
 * @returns {string[]}
 */
function checkVocabulary(row, where) {
  const errors = [];
  if (!GATE_DEFAULTS.includes(row.default)) {
    errors.push(`${where}: unknown default ${JSON.stringify(row.default)} (allowed: ${GATE_DEFAULTS.join('|')})`);
  }
  if (!GATE_ENFORCEMENTS.includes(row.enforcement)) {
    errors.push(`${where}: unknown enforcement ${JSON.stringify(row.enforcement)} (allowed: ${GATE_ENFORCEMENTS.join('|')})`);
  }
  if (!GATE_PROBES.includes(row.probe)) {
    errors.push(`${where}: unknown probe ${JSON.stringify(row.probe)} (allowed: ${GATE_PROBES.join('|')})`);
  }
  return errors;
}

/**
 * 필드 타입.
 * @param {HumanGateRow} row
 * @param {string} where
 * @returns {string[]}
 */
function checkFieldTypes(row, where) {
  const errors = [];
  if (!isNonEmptyString(row.action)) {
    errors.push(`${where}: action must be a non-empty string`);
  }
  if (!isNonEmptyString(row.evidence)) {
    errors.push(`${where}: evidence must be a non-empty string`);
  }
  if (!isArrayOf(row.patterns, (p) => p instanceof RegExp)) {
    errors.push(`${where}: patterns must be an array of RegExp`);
  }
  if (!isArrayOf(row.tools, (t) => typeof t === 'string')) {
    errors.push(`${where}: tools must be an array of strings`);
  }
  if (!isArrayOf(row.existingCoverage, (c) => typeof c === 'string')) {
    errors.push(`${where}: existingCoverage must be an array of strings`);
  }
  return errors;
}

/**
 * 판정 가능성 — 모든 행은 `patterns`·`policyRef`·`undetectable` 중 하나 이상을 갖는다.
 * @param {HumanGateRow} row
 * @param {string} where
 * @returns {string[]}
 */
function checkDecidability(row, where) {
  const errors = [];
  const policyRefOk = row.policyRef === null
    || (typeof row.policyRef === 'string' && row.policyRef.startsWith('policy:'));
  if (!policyRefOk) {
    errors.push(`${where}: policyRef must be null or "policy:<config key>"`);
  }
  if (row.default === 'policy' && row.policyRef === null) {
    errors.push(`${where}: default="policy" requires a policyRef`);
  }
  // policyRef 를 가졌는데 default 가 policy 가 아니면, 정본 표의 값과 실제 값이
  // 어긋난 자리다(예: HG-07 = v5 §11 policy → OD-1 로 human 승격). 그 자리를
  // 조용히 두면 다음 사람이 어느 쪽이 맞는지 알 수 없다 — `note` 를 강제한다.
  if (policyRefOk && row.policyRef !== null && row.default !== 'policy' && !isNonEmptyString(row.note)) {
    errors.push(`${where}: policyRef on a non-policy row requires a note explaining the divergence`);
  }

  const declared = row.undetectable;
  const hasUndetectable = !!declared
    && typeof declared === 'object'
    && isNonEmptyString(declared.reason)
    && isNonEmptyString(declared.evidence);
  if (declared && !hasUndetectable) {
    errors.push(`${where}: undetectable must carry non-empty reason and evidence`);
  }

  const hasPatterns = Array.isArray(row.patterns) && row.patterns.length > 0;
  const hasPolicyRef = typeof row.policyRef === 'string' && row.policyRef.length > 0;
  if (!hasPatterns && !hasPolicyRef && !hasUndetectable) {
    errors.push(`${where}: needs patterns, a policyRef, or an undetectable declaration`);
  }
  if (hasPatterns && hasUndetectable) {
    errors.push(`${where}: undetectable row must not carry patterns`);
  }
  return errors;
}

/**
 * 매트릭스 형태 검증. 알 수 없는 `default`·`enforcement`·`probe` 값을 거부하고,
 * 모든 행이 `patterns`·`policyRef`·`undetectable` 중 하나 이상을 갖는지 본다.
 *
 * 게이트와 소비자가 같은 규칙을 쓰도록 여기 한 곳에 둔다. 테스트는 이 함수를
 * 정본 매트릭스에 대고 한 번, 일부러 깨뜨린 합성 행에 대고 한 번 호출한다
 * (스캐너 자기검증 — 검증 규율 §10).
 *
 * @param {ReadonlyArray<HumanGateRow>} [matrix=HUMAN_GATE_MATRIX]
 * @returns {string[]} 위반 목록. 빈 배열이면 통과
 */
export function validateMatrix(matrix = HUMAN_GATE_MATRIX) {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return ['matrix is empty or not an array'];
  }
  const errors = [];
  const seen = new Set();
  for (const [index, row] of matrix.entries()) {
    const where = `row[${index}] id=${row && row.id ? row.id : '<missing>'}`;
    if (!row || typeof row !== 'object') {
      errors.push(`${where}: not an object`);
      continue;
    }
    if (typeof row.id !== 'string' || !/^HG-\d{2}$/.test(row.id)) {
      errors.push(`${where}: id must match /^HG-\\d{2}$/`);
    } else if (seen.has(row.id)) {
      errors.push(`${where}: duplicate id`);
    } else {
      seen.add(row.id);
    }
    errors.push(
      ...checkVocabulary(row, where),
      ...checkFieldTypes(row, where),
      ...checkDecidability(row, where),
    );
  }
  return errors;
}

/**
 * 어떤 probe 문자열들을 이 행에 댈지 고른다.
 * @param {HumanGateRow} row
 * @param {{command?: string, path?: string}} input
 * @returns {string[]}
 */
function probesFor(row, input) {
  const out = [];
  if (row.probe === 'command' || row.probe === 'both') {
    if (typeof input.command === 'string' && input.command !== '') out.push(input.command);
  }
  if (row.probe === 'path' || row.probe === 'both') {
    if (typeof input.path === 'string' && input.path !== '') out.push(input.path);
  }
  return out;
}

/**
 * 도구 호출 하나를 매트릭스에 대고 분류한다. **기록만 한다 — 아무것도 막지 않는다.**
 *
 * `tool` 을 주면 그 도구를 `tools` allowlist 에 가진 행만 본다(allowlist 형).
 * `tool` 을 생략하면 도구 필터 없이 payload 만으로 분류한다.
 *
 * @param {{tool?: string, command?: string, path?: string}} [input={}]
 * @returns {{hits: Array<{id: string, reason: string}>}}
 */
export function classify(input = {}) {
  const hits = [];
  if (!input || typeof input !== 'object') return { hits };
  const tool = typeof input.tool === 'string' && input.tool !== '' ? input.tool : null;

  for (const row of HUMAN_GATE_MATRIX) {
    if (row.patterns.length === 0) continue;
    if (tool !== null && !row.tools.includes(tool)) continue;
    const probes = probesFor(row, input);
    if (probes.length === 0) continue;
    const matched = row.patterns.some((pattern) => probes.some((probe) => pattern.test(probe)));
    if (matched) {
      hits.push(Object.freeze({ id: row.id, reason: `human-gate:${row.id}` }));
    }
  }
  return { hits };
}

/**
 * id 로 행을 찾는다.
 * @param {string} id
 * @returns {HumanGateRow|null}
 */
export function getGateRow(id) {
  return HUMAN_GATE_MATRIX.find((row) => row.id === id) || null;
}
