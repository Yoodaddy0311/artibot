/**
 * `.artibot/project.md` 내용 계약 — 선언과 정본이 갈라지는 것을 막는다.
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────────────────
 * `artibot-entry-parity`(T-01)는 `.artibot/project.md` 의 **존재**만 본다(그 파일
 * 헤더 사각지대 5번이 명시). 내용은 아무도 안 보면 조용히 썩는다. 이 파일이
 * 그 내용 쪽을 든다.
 *
 * 설계 §3.5 는 사람 게이트를 **층 분리**로 못박았다 — "강제는 훅, 선언은
 * project.md, 같은 13행이 `project.md#Human Approval Boundaries` 의 본문이 된다".
 * 층을 나누면 두 벌이 생기고, 두 벌은 갈라진다. 그래서 게이트가 필요하다.
 *
 * ── 왜 문서가 매트릭스를 import 하지 않는가 ─────────────────────────────────
 * 렌더하면 갈라지지 않지만, 마크다운은 코드를 실행하지 않는다. 사람이 읽는
 * 파일에 13행을 **글자로** 쓰는 것이 선언의 요점이다(설계가 "선언" 이라 부른 것이
 * 이것이다). 대신 이 테스트가 매번 두 벌을 대조한다. 갈라지면 레드다.
 *
 * ── 기대값을 이 파일에 박지 않는 이유 ───────────────────────────────────────
 * 세 축의 기대값을 전부 **추적 정본에서 파싱해 온다**:
 *   1. 필수 절 목록  ← `.artibot/guides/v5-design/package-v1.1/18_PROJECT_TEMPLATE.md`
 *   2. 원칙 14 제목  ← `.artibot/guides/v5-design/package/01_PHILOSOPHY_CONSTITUTION.md`
 *   3. 게이트 13행    ← `lib/security/human-gates.js#HUMAN_GATE_MATRIX`
 * 기대값을 테스트 안에 문자열로 박으면 정본이 바뀔 때 고쳐야 할 자리가 둘이
 * 되고, 그중 하나만 고치면 게이트가 조용히 다른 것을 지킨다. 정본이 움직여서
 * 여기가 레드가 되는 것은 **의도**다 — 게이트의 오작동이 아니다.
 *
 * ── 이 게이트가 못 보는 것 ──────────────────────────────────────────────────
 *  1. **선언이 실제로 지켜지는지 못 본다.** 문서에 `human` 이라 적혀 있는 것과
 *     오늘 코드가 그 행동을 막는 것은 다른 진술이다. 표의 `강제` 열이 현행
 *     실측(`enforcement`)과 같은지는 보지만, 그 실측이 옳은지는 매트릭스의
 *     주장을 그대로 믿는다. 훅의 실동작은 `human-gate-matrix-selfcheck` 와
 *     훅 자신의 테스트 몫이다.
 *  2. **원칙의 "현행 정본 위치" 가 실재하는 경로인지 못 본다.** 형태(경로처럼
 *     생긴 백틱 토큰)만 본다. 도달성 검사는 링크 스캐너 영역이고
 *     `scripts/ci/ci-utils.js#ROOT_SCAN_FILES` 는 `.artibot/` 를 훑지 않는다.
 *  3. **판정 어휘(성문화/부분/없음/충돌)가 맞는지 못 본다.** 그 판정은 사람이
 *     한 것이고 재측정 주기는 이 게이트 밖이다.
 *  4. **4K 자 예산을 강제하지 않는다.** `CLAUDE.md:92-96` 의 예산은 하네스가
 *     자동 로드하는 지시 파일에 대한 것이고 `project.md` 는 자동 로드되지
 *     않는다(읽기 순서를 따라 **명시적으로** 읽힌다). 그래서 여기서는 크기를
 *     **관측만** 한다 — 레드로 만들지 않는다. 관측값이 필요한 사람은 이
 *     테스트 이름에 찍힌 숫자를 본다.
 *
 * @module tests/firewall/project-md-contract
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { HUMAN_GATE_MATRIX } from '../../lib/security/human-gates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `<repo>/plugins/artibot/tests/firewall` 에서 네 단계 위가 리포 루트다. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const PROJECT_MD = join(REPO_ROOT, '.artibot', 'project.md');
const SECTION_TEMPLATE = join(
  REPO_ROOT,
  '.artibot',
  'guides',
  'v5-design',
  'package-v1.1',
  '18_PROJECT_TEMPLATE.md',
);
const CONSTITUTION = join(
  REPO_ROOT,
  '.artibot',
  'guides',
  'v5-design',
  'package',
  '01_PHILOSOPHY_CONSTITUTION.md',
);

/** 설계 §3.5 가 project.md 본문으로 지정한 절. */
const GATE_SECTION = 'Human Approval Boundaries';
/** 헌법 A-2 가 착지하는 절. */
const PRINCIPLES_SECTION = 'Core Principles';

/**
 * provenance frontmatter. 근거는 두 곳이며 **합집합**을 요구한다 —
 * ADDENDUM §24(7키) + §29 `schema_version` + §41 `actor`. 설계 §3.7 채택행이
 * 5키만 나열한 것은 §24 의 부분 인용이므로, 더 넓은 §24 를 기준으로 잡는다.
 * 부분집합을 기준으로 잡으면 나머지 키가 조용히 사라져도 그린이 된다.
 */
const REQUIRED_FRONTMATTER_KEYS = [
  'schema_version',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
  'revision',
  'based_on',
  'evidence_refs',
  'actor',
];

/**
 * CRLF/LF 무관하게 줄로 자른다. 이 리포의 워킹트리는 CRLF 다 — `\r` 을 안
 * 벗기면 표 셀 끝에 `\r` 이 붙어 문자열 비교가 조용히 전부 어긋난다.
 * @param {string} text - 원문
 * @returns {string[]} 줄 배열
 */
function toLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * `## ` 제목만 순서대로 뽑는다. frontmatter 안의 `## ` 는 없다고 본다
 * (YAML 에서 `#` 는 주석이라 실무상 나타나지 않는다).
 * @param {string} text - 마크다운 전문
 * @returns {string[]} 제목 배열
 */
function h2Headings(text) {
  return toLines(text)
    .filter((l) => /^##\s+\S/.test(l))
    .map((l) => l.replace(/^##\s+/, '').trim());
}

/**
 * `## <heading>` 아래 다음 `## ` 전까지의 줄.
 * @param {string} text - 마크다운 전문
 * @param {string} heading - `## ` 뒤의 제목
 * @returns {string[]|null} 절이 없으면 null
 */
function sectionLines(text, heading) {
  const lines = toLines(text);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * `1. foo` 형태의 순서 목록 본문만 순서대로.
 * @param {string} text - 마크다운 전문
 * @param {string} heading - 절 제목
 * @returns {string[]|null} 절이 없으면 null
 */
function orderedItems(text, heading) {
  const lines = sectionLines(text, heading);
  if (lines === null) return null;
  return lines
    .map((l) => /^\s*\d+\.\s+(.*\S)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * 절 안의 마크다운 표를 셀 배열로 판다. 구분줄(`|---|`)과 헤더는 버린다.
 * @param {string} text - 마크다운 전문
 * @param {string} heading - 절 제목
 * @returns {string[][]} 데이터 행의 셀 배열
 */
function tableRows(text, heading) {
  const lines = sectionLines(text, heading) ?? [];
  return lines
    .filter((l) => l.trim().startsWith('|') && l.trim().endsWith('|'))
    .map((l) =>
      l
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim().replace(/^`|`$/g, '')),
    )
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
}

/**
 * 헌법 문서의 `## <n>. <제목>` 을 번호순으로.
 * @param {string} text - 헌법 전문
 * @returns {{n: number, title: string}[]} 번호와 제목
 */
function constitutionPrinciples(text) {
  return toLines(text)
    .map((l) => /^##\s+(\d+)\.\s+(.*\S)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ n: Number(m[1]), title: m[2].trim() }))
    .sort((a, b) => a.n - b.n);
}

/**
 * 백틱 토큰 중 **경로처럼 생긴 것**이 하나라도 있는가.
 * `/` 를 포함해야 경로로 친다 — `` `auto` `` 같은 값 인용을 위치로 오인하지 않기 위해서다.
 * @param {string} item - 목록 항목 본문
 * @returns {boolean} 경로 토큰 유무
 */
function hasCanonicalLocation(item) {
  return [...item.matchAll(/`([^`]+)`/g)].some(([, tok]) => tok.includes('/'));
}

/**
 * 선두 YAML frontmatter 의 최상위 키 집합.
 * @param {string} text - 마크다운 전문
 * @returns {string[]|null} frontmatter 가 아니면 null
 */
function frontmatterKeys(text) {
  const lines = toLines(text);
  if (lines[0]?.trim() !== '---') return null;
  const keys = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') return keys;
    const m = /^([A-Za-z_][\w-]*):/.exec(lines[i]);
    if (m) keys.push(m[1]);
  }
  return null; // 종료 구분자를 못 만났으면 frontmatter 가 아니다
}

const projectText = existsSync(PROJECT_MD) ? readFileSync(PROJECT_MD, 'utf8') : null;
const templateText = existsSync(SECTION_TEMPLATE) ? readFileSync(SECTION_TEMPLATE, 'utf8') : null;
const constitutionText = existsSync(CONSTITUTION) ? readFileSync(CONSTITUTION, 'utf8') : null;

describe('project.md 계약 — 분모', () => {
  it('세 파일이 전부 실재한다 (하나라도 없으면 아래 단언은 공허하다)', () => {
    expect({
      project: projectText !== null,
      template: templateText !== null,
      constitution: constitutionText !== null,
    }).toEqual({ project: true, template: true, constitution: true });
  });

  it('정본에서 비어 있지 않은 기대값이 파싱된다', () => {
    expect(h2Headings(templateText).length).toBeGreaterThanOrEqual(8);
    expect(constitutionPrinciples(constitutionText)).toHaveLength(14);
    expect(HUMAN_GATE_MATRIX).toHaveLength(13);
  });
});

describe('필수 절 — 템플릿이 선언한 절이 전부 있다', () => {
  it('템플릿의 `## ` 절이 하나도 빠지지 않았다', () => {
    const actual = new Set(h2Headings(projectText));
    const missing = h2Headings(templateText).filter((h) => !actual.has(h));
    expect(missing).toEqual([]);
  });

  it('절 순서가 템플릿과 같다', () => {
    const expectedOrder = h2Headings(templateText);
    const actualOrder = h2Headings(projectText).filter((h) => expectedOrder.includes(h));
    expect(actualOrder).toEqual(expectedOrder);
  });

  it('빈 절이 없다 (제목만 있고 본문 0줄인 절 금지)', () => {
    const empty = h2Headings(templateText).filter((h) => {
      const body = sectionLines(projectText, h) ?? [];
      return body.every((l) => l.trim() === '');
    });
    expect(empty).toEqual([]);
  });
});

describe('provenance frontmatter — 누가 왜 만들었는지가 남는다', () => {
  it('선두 frontmatter 가 파싱된다', () => {
    expect(frontmatterKeys(projectText)).not.toBeNull();
  });

  it('요구 키가 전부 있다 (ADDENDUM §24 + §29 + §41)', () => {
    const keys = new Set(frontmatterKeys(projectText) ?? []);
    expect(REQUIRED_FRONTMATTER_KEYS.filter((k) => !keys.has(k))).toEqual([]);
  });

  it('schema_version 은 1 이다', () => {
    const line = toLines(projectText).find((l) => /^schema_version:/.test(l));
    expect(line?.split(':')[1].trim()).toBe('1');
  });
});

describe('Core Principles — 헌법 14원칙이 정본 위치와 함께 있다', () => {
  const items = orderedItems(projectText ?? '', PRINCIPLES_SECTION) ?? [];
  const principles = constitutionPrinciples(constitutionText ?? '');

  it('항목이 정확히 14개다', () => {
    expect(items).toHaveLength(14);
  });

  for (const { n, title } of principles) {
    it(`${n}. ${title} — 제목이 그대로 있다`, () => {
      expect(items[n - 1] ?? '').toContain(title);
    });
  }

  it('모든 항목이 현행 정본 위치(경로 토큰)를 하나 이상 인용한다', () => {
    const without = items
      .map((item, i) => ({ n: i + 1, ok: hasCanonicalLocation(item) }))
      .filter((r) => !r.ok)
      .map((r) => r.n);
    expect(without).toEqual([]);
  });

  it('충돌·미적용 항목이 결정 id 와 함께 표기된다 (조용한 채택 금지)', () => {
    // 레인 7 §1 이 충돌로 판정한 §6·§12 와 범위충돌 §11. 결정 id 없이 적으면
    // 다음 사람이 "이미 채택된 원칙" 으로 읽는다.
    for (const [n, decision] of [[6, 'A1'], [11, 'A3'], [12, 'A4']]) {
      expect({ n, has: (items[n - 1] ?? '').includes(decision) }).toEqual({ n, has: true });
    }
  });
});

describe('Human Approval Boundaries — 선언 13행이 매트릭스와 일치한다', () => {
  const rows = tableRows(projectText ?? '', GATE_SECTION).filter((c) => /^HG-\d+$/.test(c[0]));

  it('데이터 행이 정확히 13행이다', () => {
    expect(rows).toHaveLength(HUMAN_GATE_MATRIX.length);
  });

  it('id·행동·기본값이 매트릭스와 순서까지 같다', () => {
    const actual = rows.map(([id, action, dflt]) => ({ id, action, default: dflt }));
    const expected = HUMAN_GATE_MATRIX.map((r) => ({
      id: r.id,
      action: r.action,
      default: r.default,
    }));
    expect(actual).toEqual(expected);
  });

  it('강제 열이 매트릭스의 현행 실측과 같다', () => {
    const actual = rows.map(([id, , , enf]) => ({ id, enforcement: enf }));
    const expected = HUMAN_GATE_MATRIX.map((r) => ({ id: r.id, enforcement: r.enforcement }));
    expect(actual).toEqual(expected);
  });

  it('policyRef 를 가진 행만 policyRef 를 적었다', () => {
    const actual = rows.map(([id, , , , ref]) => ({ id, policyRef: ref === '—' ? null : ref }));
    const expected = HUMAN_GATE_MATRIX.map((r) => ({ id: r.id, policyRef: r.policyRef }));
    expect(actual).toEqual(expected);
  });

  it('allowlist 임을 본문이 명시한다 (미분류를 통과로 읽지 않게)', () => {
    const body = (sectionLines(projectText, GATE_SECTION) ?? []).join('\n');
    expect(body).toContain('allowlist');
    expect(body).toContain('미분류');
  });
});

describe('크기 — 관측만 (레드로 만들지 않는다)', () => {
  it(`관측: ${projectText === null ? 'n/a' : Buffer.byteLength(projectText)}B / ${
    projectText === null ? 'n/a' : [...projectText].length
  }자 — 4K 자 예산은 자동 로드 지시 파일의 것이고 project.md 는 대상이 아니다`, () => {
    expect(typeof projectText).toBe('string');
  });
});

describe('스캐너 자기검증 — 추출기가 실제로 드리프트를 본다', () => {
  const GOOD = [
    '---',
    'schema_version: 1',
    'actor:',
    '  type: agent',
    '---',
    '',
    '# Project',
    '',
    '## Core Principles',
    '',
    '1. **One** — 첫째. `docs/a.md:1`',
    '2. **Two** — 둘째. `lib/b.js`',
    '',
    '## Human Approval Boundaries',
    '',
    '| id | 행동 | 기본 |',
    '|---|---|---|',
    '| HG-01 | 읽기 | auto |',
    '| HG-02 | 편집 | auto |',
    '',
    '## References',
    '',
    '- 링크',
  ].join('\n');

  it('절이 없으면 null 을 돌려준다 (빈 배열로 통과하지 않는다)', () => {
    expect(orderedItems('# Project\n', 'Core Principles')).toBeNull();
    expect(sectionLines('# Project\n', 'References')).toBeNull();
  });

  it('절 경계를 넘어가 다음 절을 빨아들이지 않는다', () => {
    expect(orderedItems(GOOD, 'Core Principles')).toHaveLength(2);
    expect(tableRows(GOOD, 'Core Principles')).toEqual([]);
  });

  it('표에서 구분줄과 헤더를 구분한다', () => {
    const rows = tableRows(GOOD, 'Human Approval Boundaries');
    expect(rows[0]).toEqual(['id', '행동', '기본']);
    expect(rows.filter((c) => /^HG-\d+$/.test(c[0]))).toHaveLength(2);
  });

  it('CRLF 에서도 셀 끝에 캐리지리턴이 남지 않는다', () => {
    const crlf = GOOD.replace(/\n/g, '\r\n');
    expect(tableRows(crlf, 'Human Approval Boundaries')).toEqual(
      tableRows(GOOD, 'Human Approval Boundaries'),
    );
    expect(orderedItems(crlf, 'Core Principles')).toEqual(orderedItems(GOOD, 'Core Principles'));
  });

  it('빈 절을 빈 절로 판정한다', () => {
    const emptied = GOOD.replace('- 링크', '');
    expect((sectionLines(emptied, 'References') ?? []).every((l) => l.trim() === '')).toBe(true);
    expect((sectionLines(GOOD, 'References') ?? []).every((l) => l.trim() === '')).toBe(false);
  });

  it('경로 없는 원칙 줄을 통과시키지 않는다', () => {
    expect(hasCanonicalLocation('1. **One** — 첫째. `auto`')).toBe(false);
    expect(hasCanonicalLocation('1. **One** — 첫째. `docs/a.md:1`')).toBe(true);
  });

  it('frontmatter 종료 구분자가 없으면 null 이다', () => {
    expect(frontmatterKeys('---\nschema_version: 1\n# Project\n')).toBeNull();
    expect(frontmatterKeys('# Project\n')).toBeNull();
    expect(frontmatterKeys(GOOD)).toEqual(['schema_version', 'actor']);
  });

  it('헌법 파서가 번호 없는 제목을 원칙으로 세지 않는다', () => {
    const sample = '## 1. Alpha\n\n## Final philosophy\n\n## 2. Beta\n';
    expect(constitutionPrinciples(sample)).toEqual([
      { n: 1, title: 'Alpha' },
      { n: 2, title: 'Beta' },
    ]);
  });
});
