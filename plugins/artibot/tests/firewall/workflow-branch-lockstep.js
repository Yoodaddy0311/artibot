/**
 * 워크플로 락스텝 게이트의 **파서·전개기**. 테스트가 아니라 라이브러리다 —
 * vitest 의 `include` 는 `.test.js` 로 끝나는 파일만 수집하므로(vitest.config.js:89)
 * 이 파일은 테스트로 실행되지 않는다.
 *
 * 판정(어떤 이름이 required 인지, 어떤 목록이 lockstep 인지)은 여기 없다 —
 * 전부 `workflow-branch-lockstep.test.js` 에 있고, 이 모듈이 못 보는 것도
 * 그 파일 헤더의 "이 게이트가 못 보는 것" 목록에 적혀 있다. 파서를 넓히면
 * 그 목록과 거기 딸린 단언을 같이 고쳐야 한다.
 *
 * `citation-resolution.js` / `repo-judgment-vocab.js` 와 같은 이유로 분리됐고,
 * 같은 이유로 **import 가 하나도 없다** — 순수 문자열 함수만 있어서 vitest 없이
 * plain node 로도 임의 워크플로에 적용할 수 있다.
 *
 * @module tests/firewall/workflow-branch-lockstep
 */
// ───────────────────────────── 파서 ─────────────────────────────
// YAML 라이브러리를 쓰지 않는다: 이 플러그인은 zero runtime deps 이고, 게이트가
// devDependency 하나 때문에 설치 상태에 따라 green/red 가 갈리면 안 된다.
// 대신 파서 자체를 workflow-branch-lockstep.test.js 의 "스캐너 자기검증"
// describe 들로 검증한다.

/**
 * 최상위 `on:` 블록 안의 `push:` 매핑에서 `branches:` 목록을 뽑는다.
 *
 * flow(`[a, "b"]`) / block(`- a`) 양쪽을 지원한다. `pull_request:` 아래의
 * `branches:` 를 절대 집어오지 않는 것이 이 함수의 핵심 계약이다.
 *
 * @param {string} yaml 워크플로 파일 전체 텍스트
 * @returns {string[] | null} 브랜치 목록. `push.branches` 가 없으면 null
 */
export function extractPushBranches(yaml) {
  const lines = yaml.split(/\r?\n/);

  let inOn = false;
  let inPush = false;
  let pushIndent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 주석/빈 줄은 어떤 블록 상태도 바꾸지 않는다. plugin-validate.yml 은 `on:` 과
    // `push:` 사이에 20줄짜리 주석 블록이 있어서 이 처리가 필수다.
    if (/^\s*(#.*)?$/.test(line)) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      // 최상위 키. `on:` 진입 또는 다른 최상위 키로 이탈.
      inOn = /^on:\s*(#.*)?$/.test(line);
      inPush = false;
      continue;
    }
    if (!inOn) continue;

    if (inPush && indent <= pushIndent) {
      // push 형제 키(`pull_request:` 등)로 빠져나왔다.
      inPush = false;
    }

    if (!inPush) {
      if (/^\s*push:\s*(#.*)?$/.test(line)) {
        inPush = true;
        pushIndent = indent;
      }
      continue;
    }

    const flow = line.match(/^\s*branches:\s*\[(.*)\]\s*(#.*)?$/);
    if (flow) return splitFlowList(flow[1]);

    if (/^\s*branches:\s*(#.*)?$/.test(line)) {
      return readBlockList(lines, i + 1);
    }
  }
  return null;
}

/** flow 시퀀스 본문(`master, "ci/**"`)을 항목 배열로 쪼갠다. */
function splitFlowList(body) {
  return body
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item.length > 0);
}

/** `start` 줄부터 이어지는 block 시퀀스(`- item`)를 읽는다. */
function readBlockList(lines, start) {
  const items = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = line.match(/^\s*-\s*(.+?)\s*(#.*)?$/);
    if (!item) break;
    items.push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return items;
}

/**
 * job 의 `name:` 템플릿을 그 job 의 matrix 로 전개해 실제 check run 이름 집합을 만든다.
 *
 * `${{ matrix.k }}` 참조만 치환한다. 다른 표현식(`github.*` 등)이 남아 있으면 그
 * 이름은 정적으로 확정할 수 없으므로 결과에서 제외한다 — 못 푸는 것을 푼 척하지 않는다.
 *
 * matrix 는 **`include:` 병합까지 모델링한다**(buildMatrixCombinations 참조).
 * 벡터 키의 데카르트 곱만 보던 이전 판정은 include 전용 키를 "못 읽은 matrix" 로
 * 취급해 그 job 의 이름을 통째로 버렸다 — ci.yml 의 Windows 레그가 정확히 그
 * 형태였고, required context 4개를 내는 job 이 0개로 보여 게이트가 RED 였다.
 *
 * @param {string} yaml 워크플로 파일 전체 텍스트
 * @returns {string[]} 전개된 job 이름들 (중복 제거)
 */
export function renderJobNames(yaml) {
  const lines = yaml.split(/\r?\n/);

  // `jobs:` 최상위 블록의 시작 위치
  let jobsStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^jobs:\s*(#.*)?$/.test(lines[i])) {
      jobsStart = i + 1;
      break;
    }
  }
  if (jobsStart === -1) return [];

  // 2-space 들여쓰기 job 키로 블록을 자른다.
  const blocks = [];
  let current = null;
  for (let i = jobsStart; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && !/^\s*(#.*)?$/.test(line)) break; // 다른 최상위 키
    const jobKey = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (jobKey) {
      current = { key: jobKey[1], lines: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  const names = [];
  for (const block of blocks) {
    const body = block.lines.join('\n');
    const nameLine = body.match(/^ {4}name:\s*(.+?)\s*$/m);
    if (!nameLine) continue;
    const template = nameLine[1].replace(/^["']|["']$/g, '');

    const matrix = extractMatrix(block.lines);
    // matrix 블록이 아예 없는 job 은 조합 1개(빈 조합)로 본다. 그런 job 의 이름에
    // `${{ matrix.x }}` 가 있으면 knownKeys 가 비어 있어 아래에서 fail-closed 된다.
    const combinations = matrix === null ? [{}] : buildMatrixCombinations(matrix);
    const knownKeys = matrix === null ? new Set() : matrixKeys(matrix);
    names.push(...expandTemplate(template, combinations, knownKeys));
  }
  return [...new Set(names)];
}

/** matrix 의 예약 키. 나머지는 전부 값 벡터(차원)로 본다. */
const MATRIX_RESERVED_KEYS = new Set(['include', 'exclude']);

/**
 * job 블록에서 `strategy.matrix` 를 구조로 읽는다.
 *
 * flow(`k: [a, b]`) / block(`k:` + `- a`) 벡터와 block 형 `include:` 매핑 목록을
 * 구분해서 담는다.
 *
 * **모델링하지 않는 것은 전부 `unsupported` 로 넘긴다** — 그 job 은 이름을 하나도
 * 내지 않으므로(buildMatrixCombinations) 게이트가 RED 가 되고, 처음 쓰는 사람이
 * 모델을 확장하게 된다. 조용히 건너뛰면 반대가 된다: 조합을 빼는 `exclude:` 를
 * 못 본 채 전개하면 실제로는 생기지 않는 check run 이름을 게이트가 "있다" 고
 * 판정하고, required context 가 사라진 것을 영영 모른다.
 *   - `exclude:` — block·flow 양쪽 다 (조합을 빼는 의미론을 구현하지 않았다)
 *   - flow 형 `include: [{...}]` — 본문이 매핑 시퀀스라 이 파서가 못 읽는다
 *     (block 형 `include:` 만 readMappingList 로 읽는다)
 *
 * @param {string[]} jobLines job 블록의 줄들
 * @returns {{vectors: Record<string, string[]>, includes: Record<string, string>[],
 *   unsupported: string[]} | null} matrix 블록이 없으면 null
 */
function extractMatrix(jobLines) {
  const vectors = {};
  const includes = [];
  const unsupported = [];
  let found = false;
  let inMatrix = false;
  let matrixIndent = -1;

  for (let i = 0; i < jobLines.length; i += 1) {
    const line = jobLines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;

    if (inMatrix && indent <= matrixIndent) inMatrix = false;

    if (!inMatrix) {
      if (/^\s*matrix:\s*(#.*)?$/.test(line)) {
        inMatrix = true;
        found = true;
        matrixIndent = indent;
      }
      continue;
    }

    const flow = line.match(/^\s*([A-Za-z0-9_-]+):\s*\[(.*)\]\s*(#.*)?$/);
    if (flow) {
      // 예약 키가 flow 로 오면 **읽지 못한다** — `include: [{os: x}]` /
      // `exclude: [{node-version: 20}]` 의 본문은 매핑 시퀀스라 splitFlowList 가
      // 다루는 스칼라 목록이 아니다. 예전 판은 이 줄을 그냥 건너뛰었고, 그게
      // fail-open 이었다: flow 형 `exclude` 가 조용히 무시돼 실제로는 지워질
      // 조합의 이름을 게이트가 계속 "있다"고 판정했다(실측 2026-08-19 —
      // `exclude: [{node-version: 22}]` 를 준 job 이 required context 인
      // "Validate (Node 22)" 를 포함한 이름 3개를 그대로 냈다). 브랜치 보호가
      // 영구 미충족으로 굳는 경로다. block 분기와 **같은 판정**을 내도록
      // unsupported 로 넘긴다.
      if (MATRIX_RESERVED_KEYS.has(flow[1])) {
        unsupported.push(flow[1]);
        continue;
      }
      vectors[flow[1]] = splitFlowList(flow[2]);
      continue;
    }

    const blockKey = line.match(/^\s*([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (!blockKey) continue;

    if (blockKey[1] === 'exclude') {
      unsupported.push('exclude');
      continue;
    }
    if (blockKey[1] === 'include') {
      includes.push(...readMappingList(jobLines, i + 1, indent));
      continue;
    }
    const items = readBlockList(jobLines, i + 1);
    if (items.length > 0) vectors[blockKey[1]] = items;
  }

  return found ? { vectors, includes, unsupported } : null;
}

/**
 * `include:` 아래의 매핑 시퀀스를 읽는다.
 *
 * ```yaml
 * include:
 *   - os: windows-latest      ← 새 엔트리 시작
 *     node-version: 22        ← 같은 엔트리의 이어지는 쌍
 * ```
 *
 * @param {string[]} lines
 * @param {number} start `include:` 다음 줄
 * @param {number} parentIndent `include:` 자체의 들여쓰기
 * @returns {Record<string, string>[]}
 */
function readMappingList(lines, start, parentIndent) {
  const entries = [];
  let current = null;

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break; // include 블록 밖으로 나왔다

    const dash = line.match(/^\s*-\s*(.*)$/);
    if (dash) {
      current = {};
      entries.push(current);
      assignPair(current, dash[1]);
      continue;
    }
    if (!current) break;
    assignPair(current, line.trim());
  }
  return entries;
}

/** `k: v` 한 쌍을 파싱해 대상 객체에 넣는다. 형태가 아니면 무시. */
function assignPair(target, text) {
  const pair = text.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
  if (!pair) return;
  target[pair[1]] = parseScalar(pair[2]);
}

/**
 * 스칼라 값 하나를 읽는다. 따옴표가 있으면 그 안쪽을 **공백까지 그대로** 살린다
 * (`" on Windows"` 의 선행 공백이 이름 접미사로 유효하다). 따옴표가 없으면 뒤쪽
 * 주석을 떼고 trim.
 */
function parseScalar(raw) {
  const quoted = raw.match(/^"([^"]*)"/) || raw.match(/^'([^']*)'/);
  if (quoted) return quoted[1];
  return raw.replace(/\s+#.*$/, '').trim();
}

/** 벡터 키 ∪ include 엔트리에 등장하는 모든 키. */
function matrixKeys(matrix) {
  const keys = new Set(Object.keys(matrix.vectors));
  for (const entry of matrix.includes) for (const key of Object.keys(entry)) keys.add(key);
  return keys;
}

/**
 * matrix 를 GitHub 의 `include:` 병합 의미론대로 조합 목록으로 전개한다.
 *
 * 규칙(GitHub Actions 문서 "Adding configurations"): include 엔트리의 키:값 쌍은,
 * **원본 matrix 값을 덮어쓰지 않는 한** 기존 모든 조합에 더해진다. 어느 조합에도
 * 더할 수 없으면 **새 조합**이 된다. 그래서 "원본 키인지" 가 판정의 전부다 —
 * include 전용 키(예: `os-label`)는 절대 충돌을 만들지 않고, 원본 키(예: `os`)에서
 * 값이 다르면 병합이 막혀 새 조합이 생긴다.
 *
 * ci.yml 이 `os: [ubuntu-latest]` 라는 **단일 값 차원**을 두는 이유가 이것이다.
 * `os` 가 원본 키라서 `{windows-latest, 22}` 가 어느 ubuntu 조합과도 병합되지
 * 못하고 4번째 조합이 된다. 그 줄이 없으면 같은 include 가 기존 Node 22 조합에
 * **병합되어** 그 레그를 Windows 로 옮겨버린다(추가가 아니라 이동).
 *
 * @param {{vectors: Record<string, string[]>, includes: Record<string, string>[],
 *   unsupported: string[]}} matrix
 * @returns {Record<string, string>[]} 조합 목록
 */
function buildMatrixCombinations(matrix) {
  if (matrix.unsupported.length > 0) return [];

  // 벡터가 하나도 없으면 base 는 빈 목록이고 include 엔트리 하나하나가 조합이 된다
  // (include-only matrix). 여기서 `[{}]` 로 시작하면 모든 엔트리가 그 빈 조합에
  // 병합돼 조합이 1개로 뭉개진다 — GitHub 은 엔트리당 job 1개를 만든다.
  const hasVectors = Object.keys(matrix.vectors).length > 0;
  let base = hasVectors ? [{}] : [];

  for (const [key, values] of Object.entries(matrix.vectors)) {
    const next = [];
    for (const combination of base) {
      for (const value of values) next.push({ ...combination, [key]: value });
    }
    base = next;
  }

  // 병합 대상은 **벡터에서 나온 base 조합뿐**이다. include 가 만든 조합은 뒤이은
  // include 엔트리의 병합 대상이 아니다 — 그것까지 대상에 넣으면 원본 키가 없는
  // matrix 에서 엔트리들이 서로에게 병합돼 조합이 1개로 붕괴한다(이 코드의 첫
  // 판이 정확히 그랬고, "include-only matrix 는 엔트리당 조합 1개" 테스트가
  // 마지막 엔트리 하나만 내면서 그 결함을 잡았다).
  const originalKeys = new Set(Object.keys(matrix.vectors));
  const added = [];
  for (const entry of matrix.includes) {
    const targets = base.filter((combination) =>
      Object.entries(entry).every(
        ([key, value]) => !originalKeys.has(key) || combination[key] === value,
      ),
    );
    if (targets.length === 0) {
      added.push({ ...entry });
      continue;
    }
    for (const target of targets) Object.assign(target, entry);
  }
  return [...base, ...added];
}

/**
 * `${{ matrix.k }}` 를 조합별로 치환한다.
 *
 * 조합에 없는 키는 **빈 문자열**이다 — include 전용 키가 base 조합에서 갖는 값이
 * 정확히 그것이다. 다만 matrix 어디에도 없는 키를 참조하면 파서가 그 matrix 를
 * 못 읽었을 가능성과 구별되지 않으므로 이름을 하나도 내지 않는다(fail-closed).
 *
 * @param {string} template
 * @param {Record<string, string>[]} combinations
 * @param {Set<string>} knownKeys
 * @returns {string[]}
 */
function expandTemplate(template, combinations, knownKeys) {
  const pattern = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g;
  const refs = [...template.matchAll(pattern)].map((m) => m[1]);
  for (const key of refs) {
    if (!knownKeys.has(key)) return [];
  }

  const rendered = combinations.map((combination) =>
    template.replace(pattern, (_, key) => combination[key] ?? ''),
  );
  // 정적으로 못 푸는 표현식이 남은 이름은 버린다.
  return [...new Set(rendered)].filter((name) => !name.includes('${{'));
}

/**
 * 훅의 `required_contexts='A|B|C'` 한 줄을 파싱한다.
 *
 * 훅은 sh 라 이 목록을 파이프로 이어붙인 문자열로 들고 있다(이름에 공백이 있어
 * 공백 분리가 불가능하다). 여기서 그 한 줄을 읽어 REQUIRED_CONTEXTS 와 대조한다.
 *
 * @param {string} source
 * @returns {string[] | null} 파싱 실패면 null
 */
export function extractHookRequiredContexts(source) {
  const match = source.match(/^required_contexts='([^']*)'$/m);
  if (!match) return null;
  return match[1].split('|');
}
