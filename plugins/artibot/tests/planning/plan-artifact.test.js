/**
 * `lib/planning/plan-artifact` — the `plan.md` SERIALIZER / PARSER.
 *
 * Why this module exists at all: `lib/runtime/artifact-lifecycle.js#apply`
 * writes artifact content to `.artibot/missions/<M>/<kind>.md` VERBATIM — there
 * is no renderer between the caller and the disk. Until this module the shape
 * of a plan artifact was whatever string the nearest call site happened to
 * build, which makes `based_on` — the input of the staleness gate
 * (`artifact-lifecycle-gates.js#classifyStaleness`) — a per-call-site
 * convention rather than a contract. This suite pins the shape.
 *
 * ── The properties this suite is here to hold ──────────────────────────────
 *  1. ROUND-TRIP IDENTITY. `parsePlanMd(serializePlanMd(x)).plan` deep-equals
 *     the NORMALISED `x`, AND re-serialising that parsed object with the same
 *     sections yields BYTE-IDENTICAL text. Asserting only "parse succeeds"
 *     would pass for a parser that dropped `based_on` entirely.
 *  2. THE VOCABULARIES ARE THE CANON'S, READ NOT COPIED. `PLAN_MODES` is
 *     compared against `schemas/ledger-events.allowlist.json#enums.plan_mode`,
 *     and `PLAN_BASED_ON_MEMBERS` against the SOURCE TEXT of
 *     `lib/runtime/artifact-lifecycle-gates.js#BASED_ON_MEMBERS_BY_KIND` —
 *     that constant is module-private, so an import is impossible and a value
 *     copied into this file would drift in lockstep with the module's copy and
 *     prove nothing. The extractor carries a negative control.
 *  3. A REFUSAL IS A THROW, NOT A DEFAULT. Every invalid input to
 *     `serializePlanMd` raises `TypeError` naming the field. There is no "best
 *     effort" render: a plan artifact that exists is one the runtime may act on.
 *  4. THE BYTES ARE DETERMINISTIC. Same input twice => byte-identical string,
 *     LF only, exactly one trailing newline. `plan.md` is committed and diffed.
 *  5. THE PATH IS THE ONE PATH. `plan-v2.md` / `plan-final.md` / `plan-new.md`
 *     / a `plan.md` outside `.artibot/missions/<mission id>/` are all refused
 *     (design package-v1.1 `05_PLAN_AND_TASK_STATE.md:24-30` — "Do not create
 *     plan-v2.md / plan-final.md / plan-new.md", revision lives in frontmatter).
 *  6. THE READER HARDENING CARRIES OVER. `__proto__:` nesting cannot smuggle a
 *     key, duplicate keys are refused, and unimplemented YAML is refused BY
 *     NAME rather than skipped.
 *
 * ── What this suite does NOT prove ─────────────────────────────────────────
 *  - That anything WRITES the file. This module does no I/O by design; the
 *    write site (`scripts/hooks/_plan-observe-record.js`) is a sibling bundle.
 *    Green here says the STRING is right, not that a plan reached the disk.
 *  - That `based_on` values are FRESH. Freshness is
 *    `lib/runtime/artifact-lifecycle-gates.js#classifyStaleness`, which compares
 *    against live revisions this module cannot see. Green here says the member
 *    survives a round trip, nothing about its truth.
 *  - That the BODY is meaningful. The canon is the frontmatter; the body is a
 *    human-readable projection and is deliberately unvalidated on read. A
 *    section whose prose contradicts the plan is invisible to every assertion
 *    below.
 *  - That `mode` reflects how the plan was actually produced. The serializer
 *    records what the caller declares; at hook time there is no source for it
 *    and the caller takes `DEFAULT_PLAN_MODE`.
 *
 * @module tests/planning/plan-artifact
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertPlanFilePath,
  DEFAULT_PLAN_MODE,
  FIRST_PLAN_REVISION,
  isAllowedPlanFilePath,
  missionIdFromPlanPath,
  parsePlanMd,
  PLAN_ARTIFACT_BASENAME,
  PLAN_BASED_ON_MEMBERS,
  PLAN_MODES,
  PLAN_SCHEMA_VERSION,
  PLAN_SECTIONS,
  planArtifactPath,
  serializePlanMd,
} from '../../lib/planning/plan-artifact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const GATES_SOURCE_PATH = join(PLUGIN_ROOT, 'lib', 'runtime', 'artifact-lifecycle-gates.js');
const ALLOWLIST_PATH = join(PLUGIN_ROOT, 'schemas', 'ledger-events.allowlist.json');

const MISSION = 'M-20260914-001';
const SESSION_MISSION = 'M-20260914-S04c7da6b';
const TS = '2026-09-14T01:23:45.000Z';

/** The maximal input: every optional field present, every section filled. */
function fullInput(overrides = {}) {
  return {
    missionId: MISSION,
    revision: 4,
    basedOn: { intentRevision: 2 },
    mode: 'ultraplan',
    actor: { type: 'hook', id: 'plan-observe-record' },
    ts: TS,
    sections: {
      decomposition: ['A 모듈 분해', 'B 훅 배선'],
      dependencies: 'B 는 A 의 export 계약에 의존한다',
      order: ['A', 'B'],
      topology: 'opus / split 8창',
      checkpoints: ['vitest 표적 스위트', 'eslint --max-warnings=0'],
      rollback: 'batch 커밋 단위로 revert',
    },
    ...overrides,
  };
}

/** The minimal input: every defaultable field absent, no sections. */
function minimalInput(overrides = {}) {
  return {
    missionId: MISSION,
    basedOn: { intentRevision: 0 },
    actor: { type: 'worker', id: 'w-1' },
    ts: TS,
    ...overrides,
  };
}

/** Error codes present in a parse result, as a plain array of strings. */
function codesOf(result) {
  return result.errors.map((e) => e.code);
}

/**
 * Pull the PLAN member list out of the gates module's SOURCE TEXT.
 *
 * `BASED_ON_MEMBERS_BY_KIND` is module-private (no `export`), so this is the
 * only way to compare the two lists without exporting an L5 constant. Anchored
 * on the declaration first and the `[ArtifactKind.PLAN]` entry second, because
 * `[ArtifactKind.PLAN]` also appears in `STALE_VERDICT_BY_KIND` a few lines
 * above with a different value shape.
 *
 * @param {string} source
 * @returns {string[]|null} `null` when nothing matched — the negative control.
 */
function extractPlanBasedOnMembers(source) {
  const block = /const BASED_ON_MEMBERS_BY_KIND = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(source);
  if (block === null) return null;
  const entry = /\[ArtifactKind\.PLAN\]:\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(block[1]);
  if (entry === null) return null;
  const members = [...entry[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  return members.length === 0 ? null : members;
}

function gatesSource() {
  return readFileSync(GATES_SOURCE_PATH, 'utf8');
}

function allowlist() {
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
}

/** Frontmatter key names in render order, nested keys included, in-order. */
function frontmatterKeys(text) {
  return text
    .split('\n---')[0]
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.trim().split(':')[0]);
}

// ---------------------------------------------------------------------------
// (1) Round trip
// ---------------------------------------------------------------------------

describe('plan-artifact 왕복 — serialize -> parse -> serialize 가 입력을 보존한다', () => {
  it('전체 필드를 가진 입력이 정규화형 그대로 되돌아온다', () => {
    const parsed = parsePlanMd(serializePlanMd(fullInput()));

    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.plan).toEqual({
      schemaVersion: PLAN_SCHEMA_VERSION,
      missionId: MISSION,
      revision: 4,
      basedOn: { intentRevision: 2 },
      mode: 'ultraplan',
      actor: { type: 'hook', id: 'plan-observe-record' },
      ts: TS,
    });
  });

  it('선택 필드를 생략하면 기본 revision·기본 mode 로 정규화된다', () => {
    const parsed = parsePlanMd(serializePlanMd(minimalInput()));

    expect(parsed.ok).toBe(true);
    expect(parsed.plan).toEqual({
      schemaVersion: PLAN_SCHEMA_VERSION,
      missionId: MISSION,
      revision: FIRST_PLAN_REVISION,
      basedOn: { intentRevision: 0 },
      mode: DEFAULT_PLAN_MODE,
      actor: { type: 'worker', id: 'w-1' },
      ts: TS,
    });
  });

  it('파싱 결과를 같은 sections 로 재직렬화하면 바이트가 동일하다', () => {
    for (const input of [fullInput(), minimalInput()]) {
      const first = serializePlanMd(input);
      const parsed = parsePlanMd(first);

      expect(parsed.ok).toBe(true);
      const again = serializePlanMd({ ...parsed.plan, sections: input.sections });
      expect(again, JSON.stringify(input.missionId)).toBe(first);
    }
  });

  it('CRLF 로 변환된 같은 문서가 같은 결과를 낸다', () => {
    const lf = serializePlanMd(fullInput());
    const crlf = lf.replace(/\n/g, '\r\n');

    expect(crlf).not.toBe(lf);
    expect(parsePlanMd(crlf)).toEqual(parsePlanMd(lf));
  });

  it('세션 폴백 mission id 도 왕복한다', () => {
    const parsed = parsePlanMd(serializePlanMd(minimalInput({ missionId: SESSION_MISSION })));

    expect(parsed.ok).toBe(true);
    expect(parsed.plan.missionId).toBe(SESSION_MISSION);
  });

  it('두 mode 가 전부 왕복한다', () => {
    for (const mode of PLAN_MODES) {
      const parsed = parsePlanMd(serializePlanMd(minimalInput({ mode })));
      expect(parsed.ok, `${mode} 왕복`).toBe(true);
      expect(parsed.plan.mode).toBe(mode);
    }
    expect(PLAN_MODES.length).toBe(2);
  });

  it('큰 revision 과 큰 intent_revision 이 정수로 살아남는다', () => {
    const parsed = parsePlanMd(serializePlanMd(fullInput({
      revision: 137,
      basedOn: { intentRevision: 908 },
    })));

    expect(parsed.plan.revision).toBe(137);
    expect(parsed.plan.basedOn).toEqual({ intentRevision: 908 });
  });
});

// ---------------------------------------------------------------------------
// (2) The vocabularies are read from the canon, not copied
// ---------------------------------------------------------------------------

describe('plan 어휘 — 정본 파일에서 읽어 대조한다', () => {
  it('PLAN_BASED_ON_MEMBERS 가 gates 소스의 PLAN 목록과 같다', () => {
    const members = extractPlanBasedOnMembers(gatesSource());

    expect(members, 'gates 소스에서 PLAN based_on 목록을 추출하지 못했다').not.toBeNull();
    expect([...PLAN_BASED_ON_MEMBERS]).toEqual(members);
  });

  it('추출기 자기검증 — 앵커가 없는 텍스트에서는 null 을 돌려준다 (음성 대조군)', () => {
    expect(extractPlanBasedOnMembers('const X = 1;\n')).toBeNull();
    expect(extractPlanBasedOnMembers(
      'const BASED_ON_MEMBERS_BY_KIND = Object.freeze({\n  [ArtifactKind.REVIEW]: Object.freeze([]),\n});\n',
    )).toBeNull();
    expect(extractPlanBasedOnMembers(gatesSource())).not.toBeNull();
  });

  it('직렬화된 based_on 블록의 키가 정확히 그 목록이다', () => {
    const text = serializePlanMd(fullInput());
    const nested = text
      .split('\n---')[0]
      .split('\n')
      .filter((l) => /^ {2}\w+:/.test(l))
      .map((l) => l.trim().split(':')[0]);

    expect(nested).toEqual([...PLAN_BASED_ON_MEMBERS, 'type', 'id']);
    expect([...PLAN_BASED_ON_MEMBERS]).toEqual(extractPlanBasedOnMembers(gatesSource()));
  });

  it('PLAN_MODES 가 원장 allowlist 의 enums.plan_mode 와 같다', () => {
    const json = allowlist();

    expect(json.enums.plan_mode, 'allowlist 에 enums.plan_mode 가 없다').toBeDefined();
    expect([...PLAN_MODES]).toEqual(json.enums.plan_mode);
    expect(json.events['plan.revised'].fields.mode.enum_ref).toBe('plan_mode');
    expect(json.events['plan.revised'].required).toEqual(['revision', 'mode']);
  });

  it('DEFAULT_PLAN_MODE 는 어휘 안의 값이다', () => {
    expect(PLAN_MODES).toContain(DEFAULT_PLAN_MODE);
    expect(DEFAULT_PLAN_MODE).toBe('plan');
  });

  it('PLAN_SECTIONS 가 설계 05 의 여섯 항목을 순서대로 담는다', () => {
    expect(PLAN_SECTIONS.map((s) => s.key)).toEqual([
      'decomposition', 'dependencies', 'order', 'topology', 'checkpoints', 'rollback',
    ]);
    for (const section of PLAN_SECTIONS) {
      expect(typeof section.heading, section.key).toBe('string');
      expect(section.heading.trim()).not.toBe('');
    }
  });

  it('상수가 얼어 있어 호출자가 어휘를 늘릴 수 없다', () => {
    expect(Object.isFrozen(PLAN_MODES)).toBe(true);
    expect(Object.isFrozen(PLAN_BASED_ON_MEMBERS)).toBe(true);
    expect(Object.isFrozen(PLAN_SECTIONS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (3) serialize refuses
// ---------------------------------------------------------------------------

describe('serializePlanMd 거부 — 잘못된 입력은 TypeError 로 끝난다', () => {
  it('mission id 패턴 밖을 던진다', () => {
    expect(() => serializePlanMd(minimalInput({ missionId: 'mission-1' }))).toThrow(TypeError);
    expect(() => serializePlanMd(minimalInput({ missionId: 'mission-1' }))).toThrow(/missionId/);
  });

  it('revision 0 을 던진다 (첫 리비전은 1)', () => {
    expect(() => serializePlanMd(minimalInput({ revision: 0 }))).toThrow(/revision/);
    expect(() => serializePlanMd(minimalInput({ revision: 1.5 }))).toThrow(/revision/);
    expect(FIRST_PLAN_REVISION).toBe(1);
  });

  it('basedOn.intentRevision 누락·음수·소수를 던진다', () => {
    expect(() => serializePlanMd(minimalInput({ basedOn: {} }))).toThrow(/intentRevision/);
    expect(() => serializePlanMd(minimalInput({ basedOn: { intentRevision: -1 } }))).toThrow(/intentRevision/);
    expect(() => serializePlanMd(minimalInput({ basedOn: { intentRevision: 1.5 } }))).toThrow(/intentRevision/);
  });

  it('basedOn 자체가 없거나 객체가 아니면 던진다', () => {
    const input = minimalInput();
    delete input.basedOn;
    expect(() => serializePlanMd(input)).toThrow(/basedOn/);
    expect(() => serializePlanMd(minimalInput({ basedOn: [] }))).toThrow(/basedOn/);
    expect(() => serializePlanMd(minimalInput({ basedOn: null }))).toThrow(/basedOn/);
  });

  it("어휘 밖 mode — 'Plan' 과 'ultra' 를 강등/추정 없이 던진다", () => {
    expect(() => serializePlanMd(minimalInput({ mode: 'Plan' }))).toThrow(/mode/);
    expect(() => serializePlanMd(minimalInput({ mode: 'ULTRAPLAN' }))).toThrow(/mode/);
    expect(() => serializePlanMd(minimalInput({ mode: 'ultra' }))).toThrow(/mode/);
    expect(() => serializePlanMd(minimalInput({ mode: null }))).toThrow(/mode/);
  });

  it('actor 누락·형태 밖 type·빈 id 를 던진다', () => {
    const input = minimalInput();
    delete input.actor;
    expect(() => serializePlanMd(input)).toThrow(/actor/);
    expect(() => serializePlanMd(minimalInput({ actor: { type: 'Hook', id: 'x' } }))).toThrow(/actor\.type/);
    expect(() => serializePlanMd(minimalInput({ actor: { type: '1hook', id: 'x' } }))).toThrow(/actor\.type/);
    expect(() => serializePlanMd(minimalInput({ actor: { type: 'a'.repeat(33), id: 'x' } }))).toThrow(/actor\.type/);
    expect(() => serializePlanMd(minimalInput({ actor: { type: 'hook', id: '' } }))).toThrow(/actor\.id/);
    expect(() => serializePlanMd(minimalInput({ actor: { type: 'hook', id: '   ' } }))).toThrow(/actor\.id/);
  });

  it('32자 actor.type 은 허용한다 (경계는 상한이지 금지가 아니다)', () => {
    const type = `a${'b'.repeat(31)}`;
    expect(type).toHaveLength(32);
    expect(parsePlanMd(serializePlanMd(minimalInput({ actor: { type, id: 'x' } }))).plan.actor.type).toBe(type);
  });

  it('ISO 가 아닌 ts 를 던진다', () => {
    expect(() => serializePlanMd(minimalInput({ ts: '2026-09-14 01:23:45' }))).toThrow(/ts/);
    expect(() => serializePlanMd(minimalInput({ ts: '2026-09-14T01:23:45Z' }))).toThrow(/ts/);
    expect(() => serializePlanMd(minimalInput({ ts: 'not-a-date' }))).toThrow(/ts/);
  });

  it('입력 자체가 객체가 아니면 던진다', () => {
    expect(() => serializePlanMd(null)).toThrow(TypeError);
    expect(() => serializePlanMd('plan')).toThrow(TypeError);
    expect(() => serializePlanMd([])).toThrow(TypeError);
  });

  it('섹션 값의 타입이 계약 밖이면 그 섹션 이름으로 던진다', () => {
    expect(() => serializePlanMd(minimalInput({ sections: { decomposition: 42 } }))).toThrow(/decomposition/);
    expect(() => serializePlanMd(minimalInput({ sections: { order: '' } }))).toThrow(/order/);
    expect(() => serializePlanMd(minimalInput({ sections: { order: ['a', ''] } }))).toThrow(/order/);
    expect(() => serializePlanMd(minimalInput({ sections: { rollback: [] } }))).toThrow(/rollback/);
    expect(() => serializePlanMd(minimalInput({ sections: { rollback: {} } }))).toThrow(/rollback/);
    expect(() => serializePlanMd(minimalInput({ sections: [] }))).toThrow(/sections/);
    expect(() => serializePlanMd(minimalInput({ sections: 'text' }))).toThrow(/sections/);
  });

  it('미지 키·미지 섹션은 무시되고 출력에 새지 않는다', () => {
    const text = serializePlanMd(minimalInput({
      secretNote: 'do not render',
      status: 'done',
      sections: { unknownSection: 'do not render either' },
    }));

    expect(text).not.toMatch(/do not render/);
    expect(text).not.toMatch(/secret_note|secretNote|unknownSection/);
    expect(text).toBe(serializePlanMd(minimalInput()));
  });
});

// ---------------------------------------------------------------------------
// (4) Determinism, shape, body
// ---------------------------------------------------------------------------

describe('plan.md 바이트 — 결정적이고 LF 다', () => {
  it('같은 입력을 두 번 직렬화하면 바이트가 같다', () => {
    expect(serializePlanMd(fullInput())).toBe(serializePlanMd(fullInput()));
    expect(serializePlanMd(minimalInput())).toBe(serializePlanMd(minimalInput()));
  });

  it('CR 이 없고 끝 개행이 정확히 하나다', () => {
    for (const text of [serializePlanMd(fullInput()), serializePlanMd(minimalInput())]) {
      expect(text).not.toMatch(/\r/);
      expect(text.endsWith('\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
    }
  });

  it('frontmatter 키 순서가 고정돼 있다', () => {
    expect(frontmatterKeys(serializePlanMd(fullInput()))).toEqual([
      'schema_version',
      'mission_id',
      'revision',
      'based_on',
      'intent_revision',
      'mode',
      'actor',
      'type',
      'id',
      'created_at',
      'updated_at',
    ]);
  });

  it('문자열 값은 큰따옴표로 인용되고 정수는 그대로다', () => {
    const text = serializePlanMd(fullInput());

    expect(text).toContain('schema_version: 1');
    expect(text).toContain(`mission_id: "${MISSION}"`);
    expect(text).toContain('revision: 4');
    expect(text).toContain('  intent_revision: 2');
    expect(text).toContain('mode: "ultraplan"');
    expect(text).toContain('  type: "hook"');
    expect(text).toContain('  id: "plan-observe-record"');
    expect(text).toContain(`created_at: "${TS}"`);
    expect(text).toContain(`updated_at: "${TS}"`);
  });

  it('본문이 제목과 여섯 섹션 제목을 순서대로 담는다', () => {
    const text = serializePlanMd(fullInput());
    const headings = text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));

    expect(text).toContain('# Plan');
    expect(headings).toEqual(PLAN_SECTIONS.map((s) => s.heading));
  });

  it('배열 섹션은 불릿, 문자열 섹션은 그대로 렌더된다', () => {
    const text = serializePlanMd(fullInput());

    expect(text).toContain('- A 모듈 분해\n- B 훅 배선');
    expect(text).toContain('\nB 는 A 의 export 계약에 의존한다\n');
  });

  it('빠진 섹션은 자리표시자 한 줄이 된다 — 빈 섹션은 없다', () => {
    const text = serializePlanMd(minimalInput());
    const placeholders = text.split('\n').filter((l) => l === '_(not yet recorded)_');

    expect(placeholders).toHaveLength(PLAN_SECTIONS.length);
    expect(text).not.toMatch(/\n\n\n/);
  });

  it('손으로 고치지 말라는 주석으로 끝난다', () => {
    const text = serializePlanMd(fullInput());

    expect(text).toMatch(/<!--[\s\S]*손으로 고치지 말 것[\s\S]*-->\n$/);
    expect(text).toMatch(/<!--[\s\S]*plan\.revised[\s\S]*-->/);
    expect(text).toMatch(/<!--[\s\S]*파생 파일 금지[\s\S]*-->/);
  });

  it('created_at 과 updated_at 이 둘 다 ts 다', () => {
    const parsed = parsePlanMd(serializePlanMd(fullInput()));
    const text = serializePlanMd(fullInput());

    expect(text.match(new RegExp(TS, 'g'))).toHaveLength(2);
    expect(parsed.plan.ts).toBe(TS);
  });
});

// ---------------------------------------------------------------------------
// (5) parse refuses
// ---------------------------------------------------------------------------

describe('parsePlanMd 거부 — 읽을 수 없는 문서는 plan:null 이다', () => {
  it('frontmatter 가 없으면 FRONTMATTER_MISSING 이다', () => {
    const result = parsePlanMd('# Plan\n\n## Work decomposition\n\n- a\n');

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(codesOf(result)).toEqual(['FRONTMATTER_MISSING']);
  });

  it('닫는 --- 가 없으면 FRONTMATTER_MISSING 이다', () => {
    expect(codesOf(parsePlanMd(`---\nmission_id: "${MISSION}"\n`))).toEqual(['FRONTMATTER_MISSING']);
  });

  it('문자열이 아닌 입력도 FRONTMATTER_MISSING 으로 닫힌다', () => {
    for (const bad of [null, undefined, 42, {}]) {
      const result = parsePlanMd(bad);
      expect(result.ok, String(bad)).toBe(false);
      expect(result.plan).toBeNull();
      expect(codesOf(result)).toEqual(['FRONTMATTER_MISSING']);
    }
  });

  it('필수 키를 하나씩 지우면 그 키 이름으로 MISSING_KEY 가 난다', () => {
    const required = [
      'schema_version',
      'mission_id',
      'revision',
      'intent_revision',
      'mode',
      'created_at',
      'updated_at',
    ];
    const text = serializePlanMd(fullInput());

    for (const key of required) {
      const damaged = text.split('\n').filter((l) => !l.trim().startsWith(`${key}:`)).join('\n');
      const result = parsePlanMd(damaged);

      expect(result.ok, `${key} 삭제`).toBe(false);
      expect(result.plan).toBeNull();
      expect(codesOf(result), `${key} 삭제`).toContain('MISSING_KEY');
      expect(result.errors.some((e) => e.message.includes(key)), `${key} 이름이 메시지에`).toBe(true);
    }
  });

  it('actor.type / actor.id 를 지우면 그 이름으로 MISSING_KEY 가 난다', () => {
    const text = serializePlanMd(fullInput());

    for (const key of ['type', 'id']) {
      const damaged = text.split('\n').filter((l) => !l.trim().startsWith(`${key}:`)).join('\n');
      const result = parsePlanMd(damaged);

      expect(result.ok, `actor.${key} 삭제`).toBe(false);
      expect(result.errors.some((e) => e.message.includes(`actor.${key}`)), `actor.${key}`).toBe(true);
    }
  });

  it('based_on 블록이 통째로 없으면 intent_revision 누락으로 잡힌다', () => {
    const text = serializePlanMd(fullInput())
      .split('\n')
      .filter((l) => !/^\s*(based_on:|intent_revision:)/.test(l))
      .join('\n');
    const result = parsePlanMd(text);

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_KEY' && e.message.includes('intent_revision'))).toBe(true);
  });

  it('actor 블록이 통째로 없으면 두 멤버 누락으로 잡힌다', () => {
    const text = serializePlanMd(fullInput())
      .split('\n')
      .filter((l) => !/^(actor:)|^ {2}(type|id):/.test(l))
      .join('\n');
    const result = parsePlanMd(text);

    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.message.includes('actor.'))).toHaveLength(2);
  });

  it('어휘 밖 mode 는 INVALID_VALUE 다 (읽을 때도 강등 없음)', () => {
    const result = parsePlanMd(serializePlanMd(fullInput()).replace('"ultraplan"', '"Ultraplan"'));

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('mode'))).toBe(true);
  });

  it('틀린 schema_version 은 INVALID_VALUE 다', () => {
    const result = parsePlanMd(serializePlanMd(fullInput()).replace('schema_version: 1', 'schema_version: 2'));

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('schema_version'))).toBe(true);
  });

  it('정수가 아닌 revision, 패턴 밖 mission_id, 비 ISO ts 가 각각 INVALID_VALUE 다', () => {
    const base = serializePlanMd(fullInput());

    const badRevision = parsePlanMd(base.replace('revision: 4', 'revision: "four"'));
    expect(badRevision.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('revision'))).toBe(true);

    const badMission = parsePlanMd(base.replace(`"${MISSION}"`, '"mission-1"'));
    expect(badMission.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('mission_id'))).toBe(true);

    const badTs = parsePlanMd(base.replace(new RegExp(TS, 'g'), '어제'));
    expect(badTs.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('updated_at'))).toBe(true);
  });

  it('revision 0 은 읽을 때도 INVALID_VALUE 다', () => {
    const result = parsePlanMd(serializePlanMd(fullInput()).replace('revision: 4', 'revision: 0'));

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('revision'))).toBe(true);
  });

  it('오류가 여러 개면 전부 모아 돌려준다', () => {
    const result = parsePlanMd('---\nschema_version: 1\n---\n');

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(3);
    expect(new Set(codesOf(result))).toEqual(new Set(['MISSING_KEY']));
  });

  it('본문은 검증하지 않는다 — 본문이 통째로 없어도 ok 다', () => {
    const text = serializePlanMd(fullInput());
    const frontmatterOnly = `${text.split('\n---')[0]}\n---\n`;
    const result = parsePlanMd(frontmatterOnly);

    expect(result.ok).toBe(true);
    expect(result.plan.mode).toBe('ultraplan');
  });

  it('미지 frontmatter 키는 무시된다', () => {
    const result = parsePlanMd(serializePlanMd(fullInput()).replace('revision: 4', 'future_key: "x"\nrevision: 4'));

    expect(result.ok).toBe(true);
    expect(result.plan).not.toHaveProperty('futureKey');
  });
});

// ---------------------------------------------------------------------------
// (6) Reader hardening
// ---------------------------------------------------------------------------

describe('parsePlanMd 키 동일성 — 상속 키와 중복 키는 값이 아니다', () => {
  it('__proto__ 아래에 심은 mode 를 상속으로 주워 읽지 않는다', () => {
    const text = serializePlanMd(fullInput())
      .split('\n')
      .filter((l) => !l.startsWith('mode:'))
      .join('\n')
      .replace('based_on:', '__proto__:\n  mode: "plan"\nbased_on:');
    const result = parsePlanMd(text);

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.errors.some((e) => e.code === 'MISSING_KEY' && e.message.includes('mode'))).toBe(true);
  });

  it('Object.prototype 의 이름을 키로 써도 그 상속값이 값으로 통하지 않는다', () => {
    const text = serializePlanMd(fullInput())
      .split('\n')
      .filter((l) => !l.startsWith('mission_id:'))
      .join('\n')
      .replace('based_on:', 'constructor: "x"\nbased_on:');
    const result = parsePlanMd(text);

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_KEY' && e.message.includes('mission_id'))).toBe(true);
  });

  it('중복 최상위 키를 거부한다 — 뒤 줄이 앞 줄을 조용히 덮지 않는다', () => {
    const result = parsePlanMd(serializePlanMd(fullInput()).replace('created_at:', 'mode: "plan"\ncreated_at:'));

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(codesOf(result)).toContain('FRONTMATTER_UNSUPPORTED');
    expect(result.errors.some((e) => e.message.includes('mode'))).toBe(true);
  });

  it('중복 중첩 키도 거부한다 — based_on 도 같은 구멍을 갖지 않는다', () => {
    const result = parsePlanMd(
      serializePlanMd(fullInput()).replace('  intent_revision: 2', '  intent_revision: 2\n  intent_revision: 99'),
    );

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('FRONTMATTER_UNSUPPORTED');
    expect(result.errors.some((e) => e.message.includes('intent_revision'))).toBe(true);
  });

  it('시퀀스·블록 스칼라·앵커·flow·2단계 중첩을 이름으로 거부한다', () => {
    const base = serializePlanMd(fullInput());
    const cases = [
      ['시퀀스', base.replace('revision: 4', 'tags:\n  - a\n  - b\nrevision: 4')],
      ['블록 스칼라', base.replace('revision: 4', 'note: |\n  두 줄\n  짜리\nrevision: 4')],
      ['앵커', base.replace('revision: 4', 'anchor: &a 1\nrevision: 4')],
      ['flow', base.replace('revision: 4', 'flow: [a, b]\nrevision: 4')],
      ['2단계 중첩', base.replace('  intent_revision: 2', '  intent_revision: 2\n  deep:\n    deeper: 1')],
    ];

    for (const [label, text] of cases) {
      const result = parsePlanMd(text);
      expect(result.ok, label).toBe(false);
      expect(codesOf(result), label).toContain('FRONTMATTER_UNSUPPORTED');
    }
  });

  it('정상 문서는 중복·미지원 판정에 걸리지 않는다 (판정기 자기검증)', () => {
    expect(parsePlanMd(serializePlanMd(fullInput())).ok).toBe(true);
    expect(parsePlanMd(serializePlanMd(minimalInput())).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (7) Path
// ---------------------------------------------------------------------------

describe('plan 아티팩트 경로 — 파생 파일 금지', () => {
  it('POSIX·Windows 구분자 둘 다 허용한다', () => {
    expect(isAllowedPlanFilePath(`.artibot/missions/${MISSION}/plan.md`)).toBe(true);
    expect(isAllowedPlanFilePath(`C:\\repo\\.artibot\\missions\\${MISSION}\\plan.md`)).toBe(true);
    expect(isAllowedPlanFilePath(`.artibot/missions/${SESSION_MISSION}/plan.md`)).toBe(true);
  });

  it('파생 이름·다른 아티팩트·missions 밖·비 mission id 를 거부한다', () => {
    const rejected = [
      `.artibot/missions/${MISSION}/plan-v2.md`,
      `.artibot/missions/${MISSION}/plan-final.md`,
      `.artibot/missions/${MISSION}/plan-new.md`,
      `.artibot/missions/${MISSION}/intent.md`,
      `.artibot/missions/${MISSION}/sub/plan.md`,
      '.artibot/plan.md',
      'docs/plan.md',
      '.artibot/missions/not-a-mission/plan.md',
    ];

    for (const p of rejected) {
      expect(isAllowedPlanFilePath(p), p).toBe(false);
    }
  });

  it('빈 값·비문자열을 거부한다', () => {
    for (const bad of ['', '   ', null, undefined, 7]) {
      expect(isAllowedPlanFilePath(bad), String(bad)).toBe(false);
    }
  });

  it('assertPlanFilePath 는 허용 경로에 조용하고 나머지에 파생 이름을 열거하며 throw 한다', () => {
    expect(() => assertPlanFilePath(`.artibot/missions/${MISSION}/plan.md`)).not.toThrow();
    expect(() => assertPlanFilePath(`.artibot/missions/${MISSION}/plan-v2.md`)).toThrow(/plan-v2\.md/);
    expect(() => assertPlanFilePath(`.artibot/missions/${MISSION}/plan-v2.md`)).toThrow(/plan-final\.md/);
    expect(() => assertPlanFilePath(`.artibot/missions/${MISSION}/plan-v2.md`)).toThrow(/plan-new\.md/);
    expect(() => assertPlanFilePath(null)).toThrow();
  });

  it('missionIdFromPlanPath 가 허용 경로에서만 id 를 돌려준다', () => {
    expect(missionIdFromPlanPath(`.artibot/missions/${MISSION}/plan.md`)).toBe(MISSION);
    expect(missionIdFromPlanPath(`C:\\repo\\.artibot\\missions\\${SESSION_MISSION}\\plan.md`)).toBe(SESSION_MISSION);
    expect(missionIdFromPlanPath(`.artibot/missions/${MISSION}/plan-v2.md`)).toBeNull();
    expect(missionIdFromPlanPath('.artibot/missions/not-a-mission/plan.md')).toBeNull();
    expect(missionIdFromPlanPath(null)).toBeNull();
  });

  it('planArtifactPath 가 허용 경로를 만들고 그 id 를 되돌려준다', () => {
    const p = planArtifactPath('C:\\repo', MISSION);

    expect(isAllowedPlanFilePath(p)).toBe(true);
    expect(p.replace(/\\/g, '/')).toBe(`C:/repo/.artibot/missions/${MISSION}/plan.md`);
    expect(missionIdFromPlanPath(p)).toBe(MISSION);
    expect(PLAN_ARTIFACT_BASENAME).toBe('plan.md');
  });

  it('planArtifactPath 는 인자가 쓸 수 없으면 던진다', () => {
    expect(() => planArtifactPath('C:\\repo', 'mission-1')).toThrow(/missionId/);
    expect(() => planArtifactPath('', MISSION)).toThrow(/projectRoot/);
    expect(() => planArtifactPath(null, MISSION)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// (8) Realistic sizes
// ---------------------------------------------------------------------------

describe('plan.md 현실 크기 — 픽스처가 라이브 값과 같은 자릿수인가', () => {
  it('여덟 줄기 분해와 긴 체크포인트 목록이 왕복한다', () => {
    const decomposition = Array.from({ length: 8 }, (_, i) => `줄기 ${i + 1}: ${'모듈 분해 '.repeat(6)}`);
    const checkpoints = Array.from({ length: 12 }, (_, i) => `checkpoint-${i}: npx vitest run tests/planning/*.test.js`);
    const text = serializePlanMd(fullInput({ sections: { decomposition, checkpoints } }));
    const parsed = parsePlanMd(text);

    expect(parsed.ok).toBe(true);
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(20);
    expect(serializePlanMd({ ...parsed.plan, sections: { decomposition, checkpoints } })).toBe(text);
  });

  it('콜론·따옴표·백슬래시가 든 섹션 문자열이 본문에서 살아남는다', () => {
    const dependencies = 'C:\\repo\\lib\\a.js -> "b.js" (구분자: 역슬래시)';
    const text = serializePlanMd(fullInput({ sections: { dependencies } }));

    expect(text).toContain(dependencies);
    expect(parsePlanMd(text).ok).toBe(true);
  });
});
