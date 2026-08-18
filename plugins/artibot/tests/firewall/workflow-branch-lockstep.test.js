/**
 * 검사 목적: 필수 체크를 내는 워크플로들의 `push.branches` 목록 lockstep 강제.
 *
 * master 브랜치 보호의 required status checks 는 **커밋 SHA 에 붙는다**. 어떤 브랜치가
 * 워크플로의 `push.branches` 목록 밖에 있으면 그 SHA 에는 check run 이 아예 생기지
 * 않고, 그 브랜치를 `--ff-only` 로 master 에 올려도 직푸시와 똑같이 required check 를
 * 우회한다. 지금까지 이 목록은 CONTRIBUTING.md 의 산문 경고("Keep the two branch lists
 * in lockstep")로만 유지되는 **수동 불변식**이었다. 이 파일이 그 불변식을 red 로 만든다.
 *
 * 게이트는 3중이다.
 *   1. `push.branches` 를 가진 루트 워크플로는 **전부** 동일한 목록이어야 한다.
 *      (allowlist 가 아니라 "전부 일치" 라서 신규 워크플로에 fail-closed 다.
 *      새 워크플로가 다른 목록을 들고 들어오면 등록 없이도 자동으로 red 가 된다.
 *      단 **파서가 읽을 수 있는 표기법에 한해서다** — 아래 "못 보는 것" 참조.)
 *   2. required context 를 내는 워크플로 2개는 `push.branches` 를 **반드시 가져야**
 *      한다. 트리거를 통째로 지우는 우회를 막는다.
 *   3. 두 워크플로의 job `name:` 템플릿 + matrix 를 전개한 결과가 REQUIRED_CONTEXTS
 *      4개를 **전부 포함**해야 한다. job 이름을 바꾸면 브랜치 보호가 영원히
 *      "expected" 상태로 굳는데, 그 리네임을 여기서 잡는다. matrix 전개는
 *      `include:` 병합까지 모델링한다(buildMatrixCombinations).
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ─────────────────────
 *   - **브랜치 보호의 실제 required contexts 는 원격 상태다.** REQUIRED_CONTEXTS 는
 *     그 원격 값의 수동 사본이다. 누가 GitHub UI 에서 required check 를 추가/변경하면
 *     이 테스트는 아무것도 모른다. 재확인 명령은 REQUIRED_CONTEXTS 주석에 있다.
 *   - **`pull_request` 트리거의 branches 는 검사하지 않는다.** ci.yml 은
 *     `[master, main, "artibot/**"]`, plugin-validate.yml 은 필터 없음으로 **의도적으로
 *     다르다**. PR 경로는 required check 가 PR 머지 버튼에서 강제되므로 side-branch
 *     ff-only 우회 문제와 성질이 다르다.
 *   - **워크플로가 실행되고도 실패/스킵하는 경우**는 정적 스캔 밖이다. 여기는 "check run
 *     이 생기는가"만 본다.
 *   - `plugins/artibot/.github/workflows/ci.yml` 은 **스캔 대상이 아니다.** GitHub 는
 *     리포 루트 `.github/workflows/` 만 실행하므로 중첩 디렉터리의 워크플로는 check run
 *     을 내지 않는다. (실측 2026-08-15: 해당 파일은 `push.paths` 만 있고 `branches` 없음.)
 *   - **파서가 읽지 못하는 YAML 표기법이 있다.** 아래 4형태는 `null` 을 돌려주므로
 *     "목록 없음"과 구별되지 않는다 (2026-08-15 파서 직접 호출로 실측, 아래 describe
 *     에 단언으로 고정):
 *       · 여러 줄 flow (`branches: [` 다음 줄부터 항목)
 *       · `on: [push, pull_request]` 같은 최상위 flow 시퀀스
 *       · `branches-ignore:` (`branches:` 의 반대편 표기)
 *       · 따옴표 친 `"on":` 키
 *     required 2파일이 이 형태를 쓰면 위 게이트 2번(`not.toBeNull()`)이 RED 로 잡으므로
 *     **required 경로는 여전히 fail-closed 다.** 남는 노출은 "신규 **비**-required
 *     워크플로가 여러 줄 flow 로 다른 목록을 들고 오면 조용히 비교에서 빠진다"뿐이고,
 *     그런 워크플로는 required context 를 내지 않으므로 ff-only 우회를 만들지 않는다.
 *     파서를 넓히는 것 자체는 환영이지만 **넓히면 이 문단과 아래 단언도 같이 고쳐야
 *     한다** — 그러라고 단언으로 박아뒀다.
 *     (위 4형태는 `extractPushBranches` 얘기다. matrix 전개기는 별개이고 아래 두
 *     항목이 그쪽 한계다.)
 *   - **matrix `exclude:` 는 모델링하지 않는다.** 쓰인 job 은 이름을 하나도 내지
 *     않으므로 required context 를 내던 job 이 `exclude:` 를 도입하면 게이트가 RED
 *     가 된다(fail-closed — 조합을 빼는 키를 모른 채 전개하면 실제로는 생기지 않는
 *     check run 을 "있다"고 판정하게 된다). 확장하려면 이 문단과
 *     "`exclude:` 가 있으면 이름을 하나도 내지 않는다" 단언을 같이 고쳐라.
 *   - **이름 중복은 검사하지 않는다.** 서로 다른 조합이 같은 이름을 내면 GitHub 에는
 *     동명 check run 이 2개 생기고 required 판정이 모호해지는데, 여기서는 Set 으로
 *     합쳐져 1개로 보인다. ci.yml 이 Windows 레그에 `os-label` 접미사를 붙이는 이유가
 *     그 중복 회피인데, **그 접미사를 지우는 편집은 이 게이트로 잡히지 않는다.**
 *
 * @module tests/firewall/workflow-branch-lockstep
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');
/** 리포 루트 — GitHub 가 실제로 실행하는 워크플로는 여기 아래에만 있다. */
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * master 브랜치 보호의 required status checks 사본.
 *
 * 원격 상태의 **수동 미러**다. 재확인:
 *   gh api repos/Yoodaddy0311/artibot/branches/master/protection \
 *     --jq '.required_status_checks.contexts'
 * 실측 2026-08-15 09:5x KST 로 아래 4개와 일치했다.
 */
const REQUIRED_CONTEXTS = [
  'Validate (Node 22)',
  'Validate (Node 24)',
  'Validate artibot plugin.json structure',
  'Validate artibot-cowork plugin.json structure',
];

/** required context 를 내는 워크플로 파일명. 여기 있는 파일은 트리거 삭제가 금지된다. */
const REQUIRED_CHECK_WORKFLOWS = ['ci.yml', 'plugin-validate.yml'];

// ───────────────────────────── 파서 ─────────────────────────────
// YAML 라이브러리를 쓰지 않는다: 이 플러그인은 zero runtime deps 이고, 게이트가
// devDependency 하나 때문에 설치 상태에 따라 green/red 가 갈리면 안 된다.
// 대신 파서 자체를 아래 "스캐너 자기검증" describe 로 검증한다.

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
 * flow(`k: [a, b]`) / block(`k:` + `- a`) 벡터와 `include:` 매핑 목록을 구분해서
 * 담는다. `exclude:` 는 **일부러 지원하지 않고 unsupported 로 표시**한다 — 조합을
 * 빼는 키를 모른 채 전개하면 실제로는 생기지 않는 check run 이름을 게이트가
 * "있다"고 판정한다(fail-open). 표시된 job 은 이름을 하나도 내지 않으므로
 * `exclude:` 를 처음 쓰는 사람이 RED 로 이 모델을 확장하게 된다.
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
      if (!MATRIX_RESERVED_KEYS.has(flow[1])) vectors[flow[1]] = splitFlowList(flow[2]);
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

// ───────────────────────── 실제 리포에 대한 게이트 ─────────────────────────

/** 루트 워크플로 파일들을 읽는다. */
function readWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(WORKFLOW_DIR, file), 'utf-8') }));
}

describe('workflow push.branches lockstep', () => {
  const workflows = readWorkflows();

  it('스캔 대상 워크플로가 실재한다 (디렉터리 오해석 방지)', () => {
    // 경로를 잘못 잡아 0개를 읽고도 "전부 일치"로 green 이 되는 것을 막는다.
    expect(workflows.length).toBeGreaterThan(0);
    const names = workflows.map((w) => w.file);
    for (const required of REQUIRED_CHECK_WORKFLOWS) {
      expect(names).toContain(required);
    }
  });

  it('required check 워크플로는 push.branches 를 반드시 가진다', () => {
    for (const file of REQUIRED_CHECK_WORKFLOWS) {
      const workflow = workflows.find((w) => w.file === file);
      const branches = extractPushBranches(workflow.text);
      expect(branches, `${file} 에 on.push.branches 가 없다`).not.toBeNull();
      expect(branches.length).toBeGreaterThan(0);
    }
  });

  it('push.branches 를 가진 루트 워크플로는 전부 같은 목록이다', () => {
    const withBranches = workflows
      .map((w) => ({ file: w.file, branches: extractPushBranches(w.text) }))
      .filter((w) => w.branches !== null);

    // 목록을 가진 파일이 하나도 없으면 위 테스트가 이미 red 다. 여기서는 비교만 한다.
    const anchor = withBranches.find((w) => w.file === 'ci.yml');
    for (const entry of withBranches) {
      expect(
        entry.branches,
        `${entry.file} 의 push.branches 가 ci.yml 과 어긋난다. ` +
          `한쪽만 고치면 목록 밖 브랜치가 check run 없이 --ff-only 로 master 에 올라간다.`,
      ).toEqual(anchor.branches);
    }
  });

  it('job name 템플릿이 required context 4개를 전부 낸다', () => {
    const rendered = new Set(
      workflows
        .filter((w) => REQUIRED_CHECK_WORKFLOWS.includes(w.file))
        .flatMap((w) => renderJobNames(w.text)),
    );
    for (const context of REQUIRED_CONTEXTS) {
      expect(
        [...rendered],
        `required context "${context}" 를 내는 job 이 없다. job name 또는 matrix 를 ` +
          `바꿨다면 브랜치 보호의 required checks 도 함께 갱신해야 한다.`,
      ).toContain(context);
    }
  });
});

// ───────────────────── 스캐너 자기검증 (게이트가 거짓 green 이 되지 않게) ─────────────────────

describe('스캐너 자기검증 — extractPushBranches', () => {
  it('flow 시퀀스를 읽는다', () => {
    const yaml = ['on:', '  push:', '    branches: [master, "ci/**"]'].join('\n');
    expect(extractPushBranches(yaml)).toEqual(['master', 'ci/**']);
  });

  it('block 시퀀스를 읽는다', () => {
    const yaml = ['on:', '  push:', '    branches:', '      - master', '      - "ci/**"'].join(
      '\n',
    );
    expect(extractPushBranches(yaml)).toEqual(['master', 'ci/**']);
  });

  it('on: 과 push: 사이의 주석 블록을 건너뛴다 (plugin-validate.yml 실제 형태)', () => {
    const yaml = [
      'name: Plugin Validation',
      '',
      'on:',
      '  # 긴 주석',
      '  # 여러 줄',
      '',
      '  push:',
      '    branches: [master, main, "artibot/**", "ci/**"]',
    ].join('\n');
    expect(extractPushBranches(yaml)).toEqual(['master', 'main', 'artibot/**', 'ci/**']);
  });

  it('pull_request.branches 를 push.branches 로 오인하지 않는다', () => {
    const yaml = [
      'on:',
      '  push:',
      '    branches: [master, "ci/**"]',
      '  pull_request:',
      '    branches: [dev]',
    ].join('\n');
    expect(extractPushBranches(yaml)).toEqual(['master', 'ci/**']);
  });

  it('push 가 없고 pull_request 만 있으면 null 이다 (PR 목록을 훔쳐오지 않는다)', () => {
    const yaml = ['on:', '  pull_request:', '    branches: [master]'].join('\n');
    expect(extractPushBranches(yaml)).toBeNull();
  });

  it('push.tags 만 있으면 null 이다 (release.yml 실제 형태)', () => {
    const yaml = ['on:', '  push:', '    tags:', '      - "v*"'].join('\n');
    expect(extractPushBranches(yaml)).toBeNull();
  });

  it('on: 블록 밖의 branches 를 읽지 않는다', () => {
    const yaml = [
      'on:',
      '  workflow_dispatch:',
      'jobs:',
      '  push:',
      '    branches: [nope]',
    ].join('\n');
    expect(extractPushBranches(yaml)).toBeNull();
  });

  // 아래 4건은 "파서가 지원하는 것"이 아니라 **지원하지 않는다는 사실**을 고정한다.
  // 주석만 남기면 누가 파서를 넓혔을 때 헤더의 "못 보는 것" 문단이 조용히 거짓이 된다.
  // 이 리포가 반복해서 밟은 실패 유형이 정확히 그것(게이트가 못 보는 것을 적어놨는데
  // 코드가 바뀌어 서술이 거짓말이 되는 것)이라 코드로 박제한다.
  // 파서를 넓히는 것은 개선이다 — 다만 이 단언이 RED 가 되므로 헤더도 같이 고치게 된다.
  describe('의도된 파서 한계 (넓히려면 헤더의 "못 보는 것" 문단도 같이 고쳐라)', () => {
    it('여러 줄 flow 시퀀스를 읽지 못한다', () => {
      const yaml = ['on:', '  push:', '    branches: [', '      master,', '      "ci/**"', '    ]'].join(
        '\n',
      );
      expect(extractPushBranches(yaml)).toBeNull();
    });

    it('최상위 flow 시퀀스 `on: [push, pull_request]` 를 읽지 못한다', () => {
      expect(extractPushBranches('on: [push, pull_request]')).toBeNull();
    });

    it('`branches-ignore:` 를 읽지 못한다', () => {
      const yaml = ['on:', '  push:', '    branches-ignore: [docs/**]'].join('\n');
      expect(extractPushBranches(yaml)).toBeNull();
    });

    it('따옴표 친 `"on":` 키를 읽지 못한다', () => {
      const yaml = ['"on":', '  push:', '    branches: [master, "ci/**"]'].join('\n');
      expect(extractPushBranches(yaml)).toBeNull();
    });
  });

  it('drift 를 실제로 감지한다 — 일부러 어긋나게 만든 사본은 불일치로 나온다', () => {
    // 게이트의 핵심 계약: 두 목록이 다르면 다르다고 말해야 한다.
    const good = ['on:', '  push:', '    branches: [master, main, "artibot/**", "ci/**"]'].join(
      '\n',
    );
    const drifted = ['on:', '  push:', '    branches: [master, main, "artibot/**"]'].join('\n');
    expect(extractPushBranches(good)).not.toEqual(extractPushBranches(drifted));
  });
});

/** 테스트용 job 한 개짜리 워크플로를 만든다. */
function jobYaml(name, matrixLines) {
  return [
    'jobs:',
    '  validate:',
    `    name: ${name}`,
    ...(matrixLines.length > 0 ? ['    strategy:', '      matrix:', ...matrixLines] : []),
  ].join('\n');
}

describe('스캐너 자기검증 — renderJobNames', () => {
  it('단일 차원 matrix 를 전개해 check run 이름을 만든다', () => {
    const yaml = [
      'jobs:',
      '  validate:',
      '    name: Validate (Node ${{ matrix.node-version }})',
      '    strategy:',
      '      matrix:',
      '        node-version: [20, 22, 24]',
    ].join('\n');
    expect(renderJobNames(yaml)).toEqual([
      'Validate (Node 20)',
      'Validate (Node 22)',
      'Validate (Node 24)',
    ]);
  });

  it('matrix 없는 고정 이름을 그대로 낸다', () => {
    const yaml = ['jobs:', '  release:', '    name: Create GitHub Release'].join('\n');
    expect(renderJobNames(yaml)).toEqual(['Create GitHub Release']);
  });

  it('정적으로 못 푸는 표현식이 남은 이름은 버린다', () => {
    const yaml = ['jobs:', '  x:', '    name: Run ${{ github.event_name }}'].join('\n');
    expect(renderJobNames(yaml)).toEqual([]);
  });

  it('job 이름 리네임을 감지한다 — 바뀐 이름은 required context 와 다르다', () => {
    const yaml = [
      'jobs:',
      '  validate:',
      '    name: Verify (Node ${{ matrix.node-version }})',
      '    strategy:',
      '      matrix:',
      '        node-version: [22, 24]',
    ].join('\n');
    expect(renderJobNames(yaml)).not.toContain('Validate (Node 22)');
  });
});

// ───────────── 스캐너 자기검증 — include: 병합 의미론 ─────────────
// 이 describe 는 "전개기가 include 를 GitHub 과 같은 규칙으로 푸는가" 만 본다.
// 아래 두 건(충돌 → 새 조합 / 비충돌 → 병합)이 서로를 판별하는 변이 쌍이다:
// "include 는 항상 조합을 추가한다" 는 순진한 모델은 두 번째에서 4개를 내며 죽고,
// "include 는 항상 병합된다" 는 모델은 첫 번째에서 Windows 이름을 못 내며 죽는다.
//
// ── 이 모델이 못 보는 것 (rules §9) ────────────────────────────────
//   - `exclude:` 는 모델링하지 않는다. 쓰인 job 은 이름을 하나도 내지 않아
//     fail-closed 된다(아래 단언으로 고정).
//   - **이름 중복은 검사하지 않는다.** 두 조합이 같은 이름을 내면 GitHub 에서는
//     같은 이름의 check run 이 2개 생기고 required check 판정이 모호해지는데,
//     여기서는 Set 으로 합쳐져 1개로 보인다. ci.yml 이 Windows 레그에
//     `os-label` 접미사를 붙이는 이유가 그 중복 회피이고, 그 접미사를 지우는
//     편집은 이 게이트로는 잡히지 않는다.
//   - 조합 수·순서는 단언하지 않는다. 게이트의 관심사는 **이름 집합**뿐이다.
describe('스캐너 자기검증 — matrix include 병합', () => {
  const NAME = 'Validate (Node ${{ matrix.node-version }})${{ matrix.os-label }}';

  it('원본 키가 충돌하는 include 는 새 조합이 된다 (ci.yml 실제 형태)', () => {
    const names = renderJobNames(
      jobYaml(NAME, [
        '        os: [ubuntu-latest]',
        '        node-version: [20, 22, 24]',
        '        include:',
        '          - os: windows-latest',
        '            node-version: 22',
        '            os-label: " on Windows"',
      ]),
    );
    // base 3개는 이름이 그대로 보존되고(required context 2개 포함), Windows 는 별도 이름.
    expect(names).toEqual([
      'Validate (Node 20)',
      'Validate (Node 22)',
      'Validate (Node 24)',
      'Validate (Node 22) on Windows',
    ]);
  });

  it('include 전용 키는 base 조합에서 빈 문자열이다', () => {
    // 이 한 건이 게이트를 RED 로 만들었던 결함 그 자체다. include 에만 있는 키를
    // "못 읽은 matrix" 로 취급하면 job 전체가 이름을 0개 내고, required context 를
    // 내는 job 이 없다는 거짓 판정이 나온다.
    const names = renderJobNames(
      jobYaml('Validate (Node ${{ matrix.node-version }})${{ matrix.os-label }}', [
        '        os: [ubuntu-latest]',
        '        node-version: [22]',
        '        include:',
        '          - os: windows-latest',
        '            node-version: 22',
        '            os-label: " on Windows"',
      ]),
    );
    expect(names).toContain('Validate (Node 22)');
  });

  it('원본 키가 충돌하지 않는 include 는 기존 조합에 병합된다 (추가가 아니다)', () => {
    // `os` 차원이 없으므로 node-version 22 는 기존 조합과 일치 → 병합.
    // 조합이 늘지 않고 그 레그의 이름만 바뀐다.
    const names = renderJobNames(
      jobYaml(NAME, [
        '        node-version: [20, 22, 24]',
        '        include:',
        '          - node-version: 22',
        '            os-label: " LTS"',
      ]),
    );
    expect(names).toEqual([
      'Validate (Node 20)',
      'Validate (Node 22) LTS',
      'Validate (Node 24)',
    ]);
    // 병합이므로 접미사 없는 "Validate (Node 22)" 는 더 이상 존재하지 않는다.
    expect(names).not.toContain('Validate (Node 22)');
  });

  it('벡터 없는 include-only matrix 는 엔트리당 조합 1개다', () => {
    const names = renderJobNames(
      jobYaml('Validate (Node ${{ matrix.node-version }})', [
        '        include:',
        '          - node-version: 22',
        '          - node-version: 24',
      ]),
    );
    expect(names).toEqual(['Validate (Node 22)', 'Validate (Node 24)']);
  });

  it('따옴표 안의 선행 공백을 살린다', () => {
    const names = renderJobNames(
      jobYaml('Validate${{ matrix.os-label }}', [
        '        node-version: [22]',
        '        include:',
        '          - node-version: 22',
        '            os-label: " on Windows"',
      ]),
    );
    expect(names).toEqual(['Validate on Windows']);
  });

  it('`exclude:` 가 있으면 이름을 하나도 내지 않는다 (fail-closed)', () => {
    // exclude 를 모른 채 전개하면 실제로는 생기지 않는 조합의 이름을 게이트가
    // "있다"고 판정한다. 모르는 건 모른다고 해야 fail-open 이 아니다.
    const names = renderJobNames(
      jobYaml('Validate (Node ${{ matrix.node-version }})', [
        '        node-version: [20, 22, 24]',
        '        exclude:',
        '          - node-version: 20',
      ]),
    );
    expect(names).toEqual([]);
  });

  it('matrix 에 없는 키를 참조하면 이름을 내지 않는다 (파서 실패와 구별 불가)', () => {
    const names = renderJobNames(
      jobYaml('Validate (Node ${{ matrix.node-version }})${{ matrix.nope }}', [
        '        node-version: [22]',
      ]),
    );
    expect(names).toEqual([]);
  });

  it('읽지 못한 matrix 표기법은 이름을 내지 않는다 (여러 줄 flow)', () => {
    const names = renderJobNames(
      jobYaml('Validate (Node ${{ matrix.node-version }})', [
        '        node-version: [',
        '          20,',
        '          22',
        '        ]',
      ]),
    );
    expect(names).toEqual([]);
  });
});

// ─────────────────── pre-push 훅의 required_contexts 락스텝 ───────────────────

/** 훅 소스. `.git/hooks/` 의 복사본이 아니라 워크트리 소스가 진실원이다. */
const PRE_PUSH = join(PLUGIN_ROOT, 'scripts', 'git-hooks', 'pre-push');

/**
 * 훅의 `required_contexts='A|B|C'` 한 줄을 파싱한다.
 *
 * 훅은 sh 라 이 목록을 파이프로 이어붙인 문자열로 들고 있다(이름에 공백이 있어
 * 공백 분리가 불가능하다). 여기서 그 한 줄을 읽어 REQUIRED_CONTEXTS 와 대조한다.
 *
 * @param {string} source
 * @returns {string[] | null} 파싱 실패면 null
 */
function extractHookRequiredContexts(source) {
  const match = source.match(/^required_contexts='([^']*)'$/m);
  if (!match) return null;
  return match[1].split('|');
}

/**
 * pre-push 훅이 들고 있는 required context 미러가 이 파일의 목록과 일치하는지.
 *
 * 훅은 push 되는 SHA 에 **이 이름들이 green 으로 붙어 있는지**를 이름 기준으로
 * 확인해서 master 직푸시를 막는다. 개수만 세던 이전 판정은 비필수 run 하나만
 * green 이어도 통과시켰다(실측: master 커밋 146dde99). 그래서 이름 목록이
 * 게이트의 판정 근거가 됐고, 두 사본이 어긋나면 게이트가 조용히 틀린 것을
 * 요구하게 된다.
 *
 * ── 이 락스텝이 못 보는 것 ──────────────────────────────────────────────────
 *   - **원격 브랜치 보호의 실제 값은 여전히 안 본다.** 두 사본이 사이좋게 같이
 *     틀릴 수 있다. REQUIRED_CONTEXTS 주석의 재확인 명령이 유일한 대조 수단이다.
 *   - 개발자 머신의 `.git/hooks/pre-push` 가 이 소스와 같은지는 여기서 안 본다.
 *     그건 훅 자신의 drift 자기검사와 `npm run hooks:install -- --check` 몫이다.
 */
describe('pre-push required_contexts 락스텝', () => {
  const hookSource = readFileSync(PRE_PUSH, 'utf-8');

  it('훅이 미러를 파싱 가능한 한 줄로 들고 있다', () => {
    // 파싱이 깨지면 아래 대조가 통째로 무의미해지므로 먼저 못박는다.
    // 여러 줄로 쪼개거나 큰따옴표로 바꾸면 여기서 RED 가 된다.
    expect(extractHookRequiredContexts(hookSource)).not.toBeNull();
  });

  it('훅의 미러가 REQUIRED_CONTEXTS 와 정확히 일치한다', () => {
    expect(extractHookRequiredContexts(hookSource)).toEqual(REQUIRED_CONTEXTS);
  });

  it('훅이 이름 기준으로 대조한다 (개수 세기로 되돌아가지 않았다)', () => {
    // 개수 판정만 남기고 이름 대조를 지우는 편집이 이 게이트의 원래 결함이었다.
    // 정확 일치 매칭(-Fx)이 사라지면 접두사만 같은 이름이 필수를 만족시킨다.
    expect(hookSource).toContain('grep -Fxq');
    expect(hookSource).toContain('required contexts');
  });

  it('스캐너 자기검증 — 미러가 다르면 파서가 그 차이를 드러낸다', () => {
    // 위 대조가 항상 통과하는 헛돌이가 아님을 확인한다.
    const drifted = hookSource.replace(
      /^required_contexts='[^']*'$/m,
      "required_contexts='Validate (Node 22)'",
    );
    expect(extractHookRequiredContexts(drifted)).toEqual(['Validate (Node 22)']);
    expect(extractHookRequiredContexts(drifted)).not.toEqual(REQUIRED_CONTEXTS);
  });
});
