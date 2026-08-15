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
 *      "expected" 상태로 굳는데, 그 리네임을 여기서 잡는다.
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
 * @param {string} yaml 워크플로 파일 전체 텍스트
 * @returns {string[]} 전개된 job 이름들
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
    names.push(...expandTemplate(template, matrix));
  }
  return names;
}

/**
 * job 블록에서 `strategy.matrix.<key>: [ ... ]` flow 목록들을 뽑는다.
 * block 시퀀스 형식의 matrix 값도 읽는다.
 */
function extractMatrix(jobLines) {
  const matrix = {};
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
        matrixIndent = indent;
      }
      continue;
    }

    const flow = line.match(/^\s*([A-Za-z0-9_-]+):\s*\[(.*)\]\s*(#.*)?$/);
    if (flow) {
      matrix[flow[1]] = splitFlowList(flow[2]);
      continue;
    }
    const blockKey = line.match(/^\s*([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (blockKey) {
      const items = readBlockList(jobLines, i + 1);
      if (items.length > 0) matrix[blockKey[1]] = items;
    }
  }
  return matrix;
}

/** `${{ matrix.k }}` 를 matrix 값들의 데카르트 곱으로 전개한다. */
function expandTemplate(template, matrix) {
  const refs = [...template.matchAll(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g)].map(
    (m) => m[1],
  );

  let rendered = [template];
  for (const key of refs) {
    const values = matrix[key];
    if (!values) return []; // matrix 를 못 읽었으면 이름을 확정하지 않는다
    const next = [];
    for (const base of rendered) {
      for (const value of values) {
        next.push(
          base.replace(
            new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, 'g'),
            value,
          ),
        );
      }
    }
    rendered = next;
  }
  // 정적으로 못 푸는 표현식이 남은 이름은 버린다.
  return rendered.filter((name) => !name.includes('${{'));
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

describe('스캐너 자기검증 — renderJobNames', () => {
  it('matrix 를 전개해 check run 이름을 만든다 (ci.yml 실제 형태)', () => {
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
