/**
 * intent-md.template.md — 구조 계약 테스트.
 *
 * 지키는 것 (이 파일이 실제로 검사하는 것):
 *  (a) v1.1 17 원본 템플릿의 8개 절이 하나도 사라지지 않고, 상대 순서도 유지된다.
 *  (b) 설계 §3.1 "Mission Contract vs intent.md 판정" 의 보강 5곳이 존재한다 —
 *      frontmatter `autonomy{mode,human_gates}` · `## Success Criteria` 4소절 ·
 *      `## Explicit Scope` 아래 `### Bounded Blindspots`/`### Excluded` ·
 *      `## Completion` 절 · `explicit_requests[]` frontmatter 분리.
 *  (c) Hardening 메타가 frontmatter 에 있다 — §29 `schema_version`,
 *      §24 provenance 4종 + `actor{type,id}`, §2·§20 `execution_profile` 8축,
 *      §5 `based_on` 부재의 명시적 사유(주석), v1.1 17 의 `review{...}`.
 *  (d) 파생 파일 금지 문구가 템플릿 상단(첫 `##` 헤딩보다 위)에 있고 금지
 *      파일명 4종을 전부 열거한다.
 *
 * 못 보는 것 (이 게이트가 구조적으로 잡지 못하는 것):
 *  - 의미론: 절이 존재하는지만 본다. 그 절에 쓸모 있는 내용이 채워지는지,
 *    작성자가 `explicit_requests` 를 정직하게 적는지는 못 본다.
 *  - 허용값: `execution_profile` 하위 값(deep/balanced/…)의 유효성을 검사하지
 *    않는다. 허용값 정본은 `schemas/execution-profile.schema.json`(T-18)이고
 *    이 템플릿의 값은 예시일 뿐이다. 여기서 값을 단언하면 정본이 둘이 된다.
 *  - YAML 유효성: js-yaml 이 리포 의존성에 없어(zero-dep) 줄 기반으로 파싱한다.
 *    들여쓰기가 깨진 YAML 을 파서 수준에서 잡지는 못한다.
 *  - 소비자 정합: 이 템플릿을 읽는 런타임이 아직 없다. "템플릿이 있다" 는
 *    "런타임이 이 형식을 읽고 쓴다" 와 다른 진술이다.
 *  - 실사용: 실제 `.artibot/missions/<id>/intent.md` 가 이 형식으로 생성되는지는
 *    이 테스트의 범위 밖이다.
 *  - slice 단언의 해상도: 템플릿의 `## Original Request` 는 비어 있으므로
 *    `"".slice(0,0) === ""` 는 **공허참에 가깝다**. 이 단언이 잡는 것은 누군가
 *    예시 `text` 에 요약 문장을 채워 넣고 `span` 을 그대로 두는 드리프트 하나뿐이다.
 *    실제 작성물에서 verbatim 규칙이 지켜지는지는 파서·검증기(T-13 이후)가 볼 몫이다.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../schemas/intent-md.template.md',
);

const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
const lines = raw.split(/\r?\n/);

/** frontmatter 본문 줄(양쪽 `---` 제외)과 body 시작 인덱스. */
function splitFrontmatter() {
  expect(lines[0]).toBe('---');
  const closing = lines.findIndex((l, i) => i > 0 && l === '---');
  expect(closing).toBeGreaterThan(0);
  return { fm: lines.slice(1, closing), bodyStart: closing + 1 };
}

const { fm, bodyStart } = splitFrontmatter();
const body = lines.slice(bodyStart);

/** frontmatter 최상위 키(들여쓰기 0, 주석 아님). */
function topLevelKeys() {
  return fm
    .map((l) => /^([A-Za-z_][A-Za-z0-9_]*):/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * `parent:` 블록의 줄들. 빈 줄이나 들여쓰기 없는 줄을 만나면 끝난다.
 * (템플릿은 블록 내부에 빈 줄·들여쓰기 0 주석을 두지 않는 규약을 지킨다.)
 */
function blockLines(parent) {
  const start = fm.findIndex((l) => l.startsWith(`${parent}:`));
  expect(start, `frontmatter 에 ${parent}: 가 없다`).toBeGreaterThanOrEqual(0);
  const out = [];
  for (let i = start + 1; i < fm.length; i += 1) {
    const l = fm[i];
    if (l.trim() === '') break;
    if (!/^\s/.test(l)) break;
    out.push(l);
  }
  return out;
}

/** `parent:` 블록의 직계 자식 키(들여쓰기 정확히 2칸). */
function directChildKeys(parent) {
  return blockLines(parent)
    .map((l) => /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** body 의 `## ` 헤딩 목록(순서 보존). */
function h2List() {
  return body
    .map((l) => /^## (.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].trim());
}

/** `## <name>` 절의 본문 줄(다음 `## ` 전까지). */
function sectionLines(name) {
  const start = body.findIndex((l) => l.trim() === `## ${name}`);
  expect(start, `## ${name} 절이 없다`).toBeGreaterThanOrEqual(0);
  const rest = body.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** `## Original Request` 의 원문 본문 — 작성 안내용 HTML 주석은 원문이 아니다. */
function originalRequestText() {
  return sectionLines('Original Request')
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/** `explicit_requests` 첫 예시 항목의 `text` 와 `span`. */
function firstExplicitRequestExample() {
  const block = blockLines('explicit_requests');
  const textLine = block.find((l) => /^\s*- text:/.test(l)) ?? '';
  const spanLine = block.find((l) => /^\s*span:/.test(l)) ?? '';
  const text = /^\s*- text:\s*"(.*)"\s*$/.exec(textLine);
  const span = /^\s*span:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*$/.exec(spanLine);
  return {
    spanLine,
    text: text ? text[1] : undefined,
    start: span ? Number(span[1]) : undefined,
    end: span ? Number(span[2]) : undefined,
  };
}

/** 어떤 절의 `### ` 소절 목록(순서 보존). */
function h3ListIn(sectionName) {
  return sectionLines(sectionName)
    .map((l) => /^### (.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].trim());
}

// v1.1 17 (.artibot/guides/v5-design/package-v1.1/17_INTENT_TEMPLATE.md) 원본 8절.
const V11_SECTIONS = [
  'Original Request',
  'Interpreted Goal',
  'Explicit Scope',
  'Systemic Scope',
  'Success Criteria',
  'Constraints',
  'User Decisions',
  'Intent Refinements',
];

// Hardening §2 execution_profile 8축 (허용값 정본은 T-18).
const EXECUTION_PROFILE_KEYS = [
  'reasoning',
  'autonomy',
  'performance',
  'parallelism',
  'planning',
  'context',
  'review',
  'completion',
];

// package 02 "completion expectation" 기대 행동 7종.
const COMPLETION_ACTIONS = [
  'answer',
  'artifact',
  'implement',
  'test',
  'commit',
  'PR',
  'deploy',
];

describe('intent-md.template.md — frontmatter 필수 키', () => {
  it('frontmatter 가 파일 첫 줄에서 열리고 닫힌다', () => {
    expect(lines[0]).toBe('---');
    expect(bodyStart).toBeGreaterThan(1);
  });

  it('공통 메타·provenance·계약 키를 모두 선언한다', () => {
    const keys = topLevelKeys();
    for (const key of [
      'schema_version',
      'mission_id',
      'status',
      'intent_revision',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
      'actor',
      'explicit_requests',
      'autonomy',
      'execution_profile',
      'review',
    ]) {
      expect(keys, `frontmatter 최상위 키 ${key} 누락`).toContain(key);
    }
  });

  it('schema_version 은 1 이다 (Hardening §29)', () => {
    expect(fm.some((l) => /^schema_version:\s*1\s*$/.test(l))).toBe(true);
  });

  it('actor 는 type 과 id 를 갖는다 (T-19 공통 메타)', () => {
    expect(directChildKeys('actor')).toEqual(['type', 'id']);
  });

  it('review 는 independent 와 model 을 갖는다 (v1.1 17 원본 키)', () => {
    expect(directChildKeys('review')).toEqual(['independent', 'model']);
  });

  it('based_on 키를 두지 않고, 부재 사유를 주석으로 남긴다 (Hardening §5)', () => {
    // intent 는 아티팩트 의존 그래프의 최상위라 상위 개정이 없다.
    expect(topLevelKeys()).not.toContain('based_on');
    const note = fm.filter((l) => l.trim().startsWith('#')).join('\n');
    expect(note).toMatch(/based_on/);
    expect(note).toMatch(/최상위/);
  });
});

describe('intent-md.template.md — 보강 5곳 (설계 §3.1)', () => {
  it('보강① autonomy{mode, human_gates} 를 frontmatter 에 둔다', () => {
    expect(directChildKeys('autonomy')).toEqual(['mode', 'human_gates']);
  });

  it('보강① autonomy.mode 의 3값을 주석으로 열거한다', () => {
    const fmText = fm.join('\n');
    for (const mode of ['guided', 'agent_led', 'autonomous']) {
      expect(fmText, `autonomy.mode 허용값 ${mode} 미표기`).toMatch(
        new RegExp(mode),
      );
    }
  });

  it('보강② Success Criteria 를 4소절로 나눈다', () => {
    expect(h3ListIn('Success Criteria')).toEqual([
      'Functional',
      'Behavioral',
      'Regression',
      'Evidence',
    ]);
  });

  it('보강③ Explicit Scope 아래에 Bounded Blindspots / Excluded 를 둔다', () => {
    expect(h3ListIn('Explicit Scope')).toEqual([
      'Bounded Blindspots',
      'Excluded',
    ]);
  });

  it('보강④ Completion 절이 기대 행동 7종을 체크박스로 갖는다', () => {
    const checkboxes = sectionLines('Completion')
      .map((l) => /^- \[[ xX]\] (.+)$/.exec(l))
      .filter(Boolean)
      .map((m) => m[1].trim());
    expect(checkboxes).toEqual(COMPLETION_ACTIONS);
  });

  it('보강⑤ explicit_requests[] 를 frontmatter 배열 {text, span} 으로 분리한다', () => {
    const block = blockLines('explicit_requests');
    expect(block.some((l) => /^\s*- text:/.test(l))).toBe(true);
    expect(block.some((l) => /^\s*span:/.test(l))).toBe(true);
  });

  it('보강⑤ 예시 text 는 Original Request 원문의 slice(start, end) 와 같다', () => {
    // 정본 규칙(설계 §3.1 · 레인 1 §3.4): text 는 원문의 verbatim 부분문자열이고
    // span 은 필수다. 요약·정규화한 문장을 text 에 넣으면 보호 대상이 원문에서
    // 떨어져 나가 "조용한 대체" 를 잡을 수 없게 된다.
    const { text, start, end, spanLine } = firstExplicitRequestExample();
    expect(typeof text, 'text 예시를 "..." 형태로 파싱하지 못했다').toBe('string');
    expect(Number.isInteger(start) && Number.isInteger(end)).toBe(true);
    expect(spanLine, 'span 은 null 을 허용하지 않는다').not.toMatch(/null/);
    expect(originalRequestText().slice(start, end)).toBe(text);
  });

  it('보강⑤ Original Request 는 원문 보존 절로 남는다', () => {
    const text = sectionLines('Original Request').join('\n');
    expect(text).toMatch(/원문/);
    // span 오프셋이 이 절을 가리킨다는 사실이 템플릿에 적혀 있어야
    // 나중에 이 절을 다듬어 span 을 깨뜨리는 일이 줄어든다.
    expect(text).toMatch(/span/);
  });
});

describe('intent-md.template.md — v1.1 17 원본 8절 보존', () => {
  it('# Intent H1 을 유지한다', () => {
    expect(body.some((l) => l.trim() === '# Intent')).toBe(true);
  });

  it('원본 8절이 하나도 빠지지 않는다', () => {
    const present = h2List();
    for (const section of V11_SECTIONS) {
      expect(present, `v1.1 17 의 ## ${section} 절이 사라졌다`).toContain(
        section,
      );
    }
  });

  it('원본 8절의 상대 순서가 유지된다 (신설 절 삽입은 허용)', () => {
    const known = new Set(V11_SECTIONS);
    expect(h2List().filter((h) => known.has(h))).toEqual(V11_SECTIONS);
  });

  it('신설 절은 Completion 하나뿐이다', () => {
    const known = new Set(V11_SECTIONS);
    expect(h2List().filter((h) => !known.has(h))).toEqual(['Completion']);
  });
});

describe('intent-md.template.md — 파생 파일 금지', () => {
  const firstH2 = lines.findIndex((l) => /^## /.test(l));
  const head = lines
    .slice(0, firstH2 === -1 ? lines.length : firstH2)
    .join('\n');

  it('금지 문구가 첫 ## 헤딩보다 위(템플릿 상단)에 있다', () => {
    expect(firstH2).toBeGreaterThan(0);
    expect(head).toMatch(/금지/);
  });

  it('금지 파일명 4종을 전부 열거한다 (Hardening §4)', () => {
    for (const name of [
      'intent-v2.md',
      'intent-final.md',
      'intent-agent-a.md',
      'interpreted-intent.md',
    ]) {
      expect(head, `금지 목록에 ${name} 이 없다`).toContain(name);
    }
  });

  it('개정은 새 파일이 아니라 intent_revision 으로 한다고 명시한다', () => {
    expect(head).toMatch(/intent_revision/);
    expect(head).toMatch(/Intent Refinements/);
  });
});

describe('intent-md.template.md — execution_profile (Hardening §2·§20)', () => {
  it('8축을 정확히 그 순서로 갖는다', () => {
    expect(directChildKeys('execution_profile')).toEqual(
      EXECUTION_PROFILE_KEYS,
    );
  });

  it('허용값 정본이 T-18 스키마임을 주석으로 못박는다', () => {
    // 이 템플릿이 허용값을 정의하면 정본이 둘이 된다.
    expect(fm.join('\n')).toMatch(/execution-profile\.schema\.json/);
  });
});
