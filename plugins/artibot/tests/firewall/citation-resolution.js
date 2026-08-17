/**
 * 인용 해소 술어. **테스트가 아니라 라이브러리다** (파일명이 `*.test.js` 가
 * 아니므로 vitest `include` 에 걸리지 않는다).
 *
 * 문서 속 `` `path:NN` `` / `` `path#symbol` `` 인용이 실제로 해소되는지
 * (파일이 있는지, 줄번호가 파일 길이 안인지, 심볼이 존재하는지) 판정한다.
 * 정책은 있으나 게이트가 없던 자리를 메운다 — `problem-validation` 스킬이
 * 증거 인용을 *요구*만 하고 검증하지 않았고, 2026-08-17 벤치마크 세션에서
 * 유령 인용 실사고 2건(경로 오인용·수치 과대)이 재발했다.
 *
 * 분리 이유는 `repo-judgment-vocab.js` 와 동일하다: 격리 트리에서 **vitest
 * 없이 plain node 로** 임의 문서에 적용할 수 있어야 한다. 그래서 이 모듈은
 * `node:fs` 를 import 하지 않는다 — 파일 접근은 전부 주입된 facade 로 한다.
 *
 * ## 이 게이트가 못 보는 것 (게이트 옆에 적지 않으면 게이트가 다음 착시의 근거가 된다)
 *
 * 1. 줄번호가 파일 길이 **안**이지만 엉뚱한 줄을 가리키는 경우 — 대부분의
 *    실제 썩음이 이 형태다. 이 게이트는 "매달린 인용이 아님"만 증명하고
 *    "옳은 곳을 가리킴"은 영원히 증명하지 못한다.
 * 2. 백틱 없는 산문 인용(`safety.js:141` 류) — **의도적으로** 탐지하지 않는다.
 *    백틱은 저자의 명시적 "코드 참조" 신호이자 opt-out 장치다. 탐지기를
 *    산문까지 넓히면 오탐 대응용 부정 목록이 자라기 시작하고 fail-open 으로
 *    끝난다. 테스트의 음성 단언이 이 확장을 명시적으로 막는다.
 * 3. 베어 베이스네임 인용(`index.js:59` 류, census 43건) — 해소가 원리적으로
 *    모호해서 skip 으로 계수만 한다. 정규화는 후속 과제다.
 * 4. `#symbol` 이 주석·문자열 안에서만 매치해도 선언 정규식이 놓치면 통과/
 *    잡으면 오탐일 수 있다 — 선언 앵커 정규식은 AST 가 아니다.
 * 5. 점 표기 심볼(`MODELS.opus.id`)은 JSON 이 아닌 파일에선 머리 세그먼트만
 *    검사한다. YAML 심볼은 미지원(zero-dep 파서 없음)으로 선언한다.
 * 6. `path (line 123)` · `L123` 등 변형 표기 — v1 문법 밖.
 * 7. `scripts/ci/validate-doc-links.js#maskCodeFences` 를 **재사용하면 안 된다**
 *    — 그 함수는 인라인 코드스팬까지 지우므로 백틱 인용이 전부 사라져
 *    추출 0 = 무음 fail-open 이 된다 (2026-08-17 적대 검증에서 확인).
 *    그래서 아래 `maskFencedBlocks` 는 펜스 블록만 지운다.
 *
 * @module tests/firewall/citation-resolution
 */

/** 검사 대상 확장자 allowlist — 미등록 확장자는 skip('ext-not-checked'). */
export const CHECKED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.md', '.sh'];

/**
 * 인용 경로의 첫 세그먼트 → 해소 기준점 명시 맵. 미등록 = skip('root-not-listed') —
 * 외부 레포 인용(`admission.py` 류)과 gitignore 루트(`runtime/` 류 — CI 체크아웃에
 * 없어 로컬 초록/CI 빨강 분기를 만든다)를 부정 목록 없이 배제한다 (rules §8).
 *
 * **폴백 탐색 금지**가 이 맵의 존재 이유다: "여러 루트를 순차 시도" 방식은
 * cowork 문서의 `lib/x.js` 가 artibot 루트에서 우연히 해소되는 크로스 루트
 * 위음성을 만든다 (2026-08-17 적대 검증 C4). 세그먼트당 기준점은 정확히 하나다.
 */
export const SEGMENT_ROOT_KIND = {
  lib: 'plugin', scripts: 'plugin', commands: 'plugin', skills: 'plugin',
  agents: 'plugin', docs: 'plugin', tests: 'plugin', hooks: 'plugin',
  rules: 'plugin', 'output-styles': 'plugin', '.claude-plugin': 'plugin', bin: 'plugin',
  plugins: 'repo', '.github': 'repo',
};

/** 하위 호환 조회용 세그먼트 목록 (정본은 SEGMENT_ROOT_KIND). */
export const ROOT_SEGMENTS = Object.keys(SEGMENT_ROOT_KIND);

/** 문법 예시용 플레이스홀더 리터럴 — 인용이 아니다. */
export const PLACEHOLDER_LITERALS = ['file:line', 'file_path:line_number', 'path:NN', 'file.js:123'];

/**
 * skip 사유 열거형 allowlist. 이 목록 밖의 사유로 skip 하는 코드 경로는
 * 존재할 수 없게 작성한다 — skip 이 쓰레기통이 되면 분모가 조용히 무너진다.
 */
export const SKIP_REASONS = [
  'placeholder', 'out-of-repo-prefix', 'bare-basename', 'ext-not-checked', 'root-not-listed',
];

/** resolve 판정 6값. 불리언으로 뭉치면 소비자마다 재분류가 갈라진다. */
export const STATUSES = ['ok', 'missing-file', 'out-of-range', 'unknown-symbol', 'read-error'];

const SPAN_RE = /`([^`\n]+)`/g;
const CITE_RE = /^([A-Za-z0-9_.@/-]+\.[A-Za-z0-9]+)(?::([0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*)|#([A-Za-z_$][A-Za-z0-9_.$()-]*))$/;

/**
 * 펜스 블록(``` / ~~~)만 공백으로 지운다. 인라인 코드스팬은 **보존**한다 —
 * 인용이 바로 그 안에 있기 때문이다 (모듈 헤더 blindspot #7).
 *
 * @param {string} text
 * @returns {string}
 */
export function maskFencedBlocks(text) {
  return String(text).replace(/\r\n/g, '\n').replace(
    /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm,
    (block) => block.replace(/[^\n]/g, ' ')
  );
}

/**
 * 백틱 코드스팬 안에서 인용 형태 문자열을 추출한다.
 *
 * @param {string} markdown
 * @returns {Array<{raw:string, path:string, lines:string|null, symbol:string|null}>}
 */
export function extractCitations(markdown) {
  const masked = maskFencedBlocks(markdown);
  const out = [];
  for (const [, span] of masked.matchAll(SPAN_RE)) {
    const m = span.trim().match(CITE_RE);
    if (!m) continue;
    out.push({ raw: span.trim(), path: m[1], lines: m[2] ?? null, symbol: m[3] ?? null });
  }
  return out;
}

/**
 * checkable allowlist 5조건. 전부 만족해야 검사 대상 — 불만족은 열거형
 * 사유와 함께 skip 으로 **계수**된다 (무시가 아니다).
 *
 * @param {{raw:string, path:string}} cite
 * @returns {{checkable:true}|{checkable:false, skip:string}}
 */
export function classifyCitation(cite) {
  if (PLACEHOLDER_LITERALS.includes(cite.raw)) return { checkable: false, skip: 'placeholder' };
  if (/^(~|\/|[A-Za-z]:|\.\.\/)/.test(cite.path)) return { checkable: false, skip: 'out-of-repo-prefix' };
  if (!cite.path.includes('/')) return { checkable: false, skip: 'bare-basename' };
  const ext = cite.path.slice(cite.path.lastIndexOf('.'));
  if (!CHECKED_EXTENSIONS.includes(ext)) return { checkable: false, skip: 'ext-not-checked' };
  if (!ROOT_SEGMENTS.includes(cite.path.split('/')[0])) return { checkable: false, skip: 'root-not-listed' };
  return { checkable: true };
}

/**
 * BOM 제거 + CRLF/CR/LF 정규화 + 말미 개행 무시 기준의 줄 수.
 * `existsSync` 식 줄 세기 오산(FO-8)을 막는 유일한 정본.
 *
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const arr = s.split(/\r\n|\r|\n/);
  if (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
  return arr.length;
}

/**
 * Markdown 헤딩 → 앵커. `validate-doc-links.js#headingToAnchor` 와 동작이
 * 같아야 한다 — 직접 import 하지 않는 이유는 그 모듈이 `node:fs` 를 물고
 * 있어 plain-node 이식성이 깨지기 때문이고, 두 구현의 lockstep 은 테스트의
 * parity 단언이 지킨다.
 *
 * @param {string} heading
 * @returns {string}
 */
export function mdHeadingAnchor(heading) {
  return String(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/ /g, '-')
    .replace(/-+$/g, '');
}

/** @param {string} body @param {string} name @returns {boolean} */
function hasJsSymbol(body, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(^|\\s)(export\\s+)?(default\\s+)?(async\\s+)?(function\\*?|class|const|let|var)\\s+${n}\\b` +
    `|export\\s*\\{[^}]*\\b${n}\\b` +
    `|^\\s*${n}\\s*[:(]`, 'm'
  );
  return re.test(body);
}

/** @param {string} body @param {string} name @returns {boolean} */
function hasShSymbol(body, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\n)\\s*(function\\s+${n}\\b|${n}\\s*\\(\\))`).test(body);
}

/** @param {unknown} parsed @param {string} dotted @returns {boolean} */
function hasJsonPath(parsed, dotted) {
  let node = parsed;
  for (const key of dotted.split('.')) {
    if (node === null || typeof node !== 'object' || !(key in node)) return false;
    node = node[key];
  }
  return true;
}

/**
 * 심볼 존재 검사 — 대상 확장자별 타입드 리졸버. substring 검사 금지
 * (자기 인용·주석 매치 오탐). 점 표기는 JSON 만 전체 경로, 그 외 머리만.
 *
 * @param {string} ext
 * @param {string} body
 * @param {string} symbol
 * @returns {boolean}
 */
export function hasSymbol(ext, body, symbol) {
  const bare = symbol.replace(/\(\)$/, '');
  if (ext === '.json') {
    try { return hasJsonPath(JSON.parse(body), bare); } catch { return false; }
  }
  if (ext === '.sh') return hasShSymbol(body, bare.split('.')[0]);
  if (ext === '.md') {
    const anchor = mdHeadingAnchor(bare.replace(/-/g, ' '));
    const anchors = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => mdHeadingAnchor(m[1]));
    return anchors.includes(mdHeadingAnchor(bare)) || anchors.includes(anchor);
  }
  return hasJsSymbol(body, bare.split('.')[0]);
}

/**
 * 인용 1건 해소. 파일 접근은 전부 facade 로 — 이 모듈은 디스크를 모른다.
 * 기준점은 `SEGMENT_ROOT_KIND` 로 정확히 하나를 고른다 — 폴백 탐색 없음.
 *
 * @param {{path:string, lines:string|null, symbol:string|null}} cite
 * @param {{readFile:(joined:string)=>string|null}} fsFacade
 *   `readFile` 은 존재하지 않으면 null, 읽기 실패면 throw 하도록 구현한다.
 * @param {{plugin:string, repo:string}} rootsCtx - 문서가 속한 플러그인 루트와
 *   리포 루트 (forward-slash).
 * @returns {{status:string, detail?:string}}
 */
export function resolveCitation(cite, fsFacade, rootsCtx) {
  const kind = SEGMENT_ROOT_KIND[cite.path.split('/')[0]];
  const base = kind === 'repo' ? rootsCtx.repo : rootsCtx.plugin;
  let body;
  try {
    body = fsFacade.readFile(`${base}/${cite.path}`);
  } catch (err) {
    return { status: 'read-error', detail: String(err && err.message || err) };
  }
  if (body === null || body === undefined) return { status: 'missing-file' };
  if (cite.lines) {
    const n = countLines(body);
    const nums = cite.lines.split(',').flatMap((r) => r.split('-')).map(Number);
    const max = Math.max(...nums);
    if (nums.some((x) => x < 1) || max > n) return { status: 'out-of-range', detail: `line ${max} > ${n}` };
  }
  if (cite.symbol) {
    const ext = cite.path.slice(cite.path.lastIndexOf('.'));
    if (!hasSymbol(ext, body, cite.symbol)) return { status: 'unknown-symbol', detail: cite.symbol };
  }
  return { status: 'ok' };
}

/**
 * 베이스라인 정체성. **줄번호(문서 내 위치)를 넣지 않는다** — 문단 이동만으로
 * 전부 신규 위반이 되는 리플로우 오탐을 막는다.
 *
 * @param {string} docRel @param {string} raw @returns {string}
 */
export function citationIdentity(docRel, raw) {
  return `${docRel.replace(/\\/g, '/')}::${raw}`;
}

/**
 * 문서 1건 전수 판정.
 *
 * @param {string} markdown
 * @param {string} docRel - 리포 기준 상대경로 (정체성 키용).
 * @param {{readFile:(joined:string)=>string|null}} fsFacade
 * @param {{plugin:string, repo:string}} rootsCtx
 * @returns {{total:number, checkable:number, ok:number,
 *   skips:Record<string,number>, violations:Array<{identity:string, status:string, detail?:string}>}}
 */
export function checkDocument(markdown, docRel, fsFacade, rootsCtx) {
  const skips = {}; const violations = [];
  let checkable = 0; let ok = 0;
  const cites = extractCitations(markdown);
  for (const cite of cites) {
    const cls = classifyCitation(cite);
    if (!cls.checkable) {
      if (!SKIP_REASONS.includes(cls.skip)) {
        violations.push({ identity: citationIdentity(docRel, cite.raw), status: 'read-error', detail: `unlisted skip reason: ${cls.skip}` });
        continue;
      }
      skips[cls.skip] = (skips[cls.skip] ?? 0) + 1;
      continue;
    }
    checkable += 1;
    const r = resolveCitation(cite, fsFacade, rootsCtx);
    if (r.status === 'ok') ok += 1;
    else violations.push({ identity: citationIdentity(docRel, cite.raw), status: r.status, detail: r.detail });
  }
  return { total: cites.length, checkable, ok, skips, violations };
}

/**
 * 래칫 판정 — 선례(`lint-skill-descriptions.js#runRatchet`)와 달리 **축소를
 * 강제한다**: 베이스라인 항목이 지금 해소되면 그것도 FAIL 이다 ("빼라").
 * 축소 미강제 래칫은 화석화된다 (2026-08-17 lens-arch 실측 — fixed 는
 * 문구만 출력되고 pass 식에 없었다).
 *
 * @param {string[]} currentViolationIdentities
 * @param {string[]} baseline
 * @returns {{newViolations:string[], resolvedBaseline:string[], pass:boolean}}
 */
export function runCitationRatchet(currentViolationIdentities, baseline) {
  const cur = new Set(currentViolationIdentities);
  const base = new Set(baseline);
  const newViolations = currentViolationIdentities.filter((v) => !base.has(v));
  const resolvedBaseline = baseline.filter((b) => !cur.has(b));
  return { newViolations, resolvedBaseline, pass: newViolations.length === 0 && resolvedBaseline.length === 0 };
}
