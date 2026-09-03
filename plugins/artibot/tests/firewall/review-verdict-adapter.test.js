/**
 * 검사 목적: review-output verdict **v2 5어휘**와 **기존 4어휘 어댑터 매핑표**를
 * 데이터로 고정하고, v1 스키마가 한 바이트도 바뀌지 않았음을 증명한다.
 *
 * 왜 파이어월인가 — verdict 는 "구현이 틀렸다"와 "계획/스펙이 틀렸다"를 가르는
 * 유일한 어휘다. 지금 파이프라인에는 후자를 표현할 말이 아예 없어서 전부
 * `SPEC_FAIL`(=구현 문제)로 접혀 왔다(레인 4 §5.3). 매핑표가 조용히 바뀌면 그
 * 구분이 다시 사라지는데, 런타임에는 아무 소리도 나지 않는다.
 *
 * 게이트 8중:
 *   1. v1 루트 스키마 불변 — verdict enum `pass|fail|warning`, findings 필수 3종,
 *      critical/high 의 suggestion 조건부 required. 기존
 *      `tests/schemas/review-output.schema.test.js` 와 **의도적으로 겹친다**:
 *      v2 추가가 v1 을 건드리지 않았다는 것이 이 작업의 핵심 계약이라 여기서도 잰다.
 *   2. `definitions.finding` 이 루트 `properties.findings.items` 와 **깊은 값까지
 *      동일**. v2 가 finding 을 참조로 재사용하므로 두 벌이 갈라지면 같은 이름의
 *      서로 다른 계약이 생긴다. 드리프트를 red 로 만든다.
 *   3. v2 verdict enum = 매핑표 `target_verdicts` = Hardening §15 5종. 세 곳이
 *      값과 순서까지 일치해야 한다(한쪽만 늘어나는 것이 가장 흔한 드리프트).
 *   4. 매핑 **전건** — 5개 출처 어휘의 토큰 총수와 행 수가 같고, 각 토큰이 정확히
 *      한 번 나온다. 누락(fail-open)과 중복(모순 매핑) 둘 다 잡는다.
 *   5. `SPEC_FAIL` 은 `ambiguous:true` · `verdict:null` · candidates 정확히
 *      `[REPAIR_REQUIRED, INTENT_REVIEW_REQUIRED]`, 그리고 **유일한 ambiguous 행**.
 *      자동 분류가 생기는 순간 red.
 *   6. `INTENT_REVIEW_REQUIRED` 에 도달하는 비-ambiguous 행이 **0건**임을 고정한다.
 *      이건 결함이 아니라 실측된 어휘 갭이고, 누가 임의 매핑을 채워 넣으면 red.
 *   7. 출처 파일 5종이 실재하고 각자 자기 토큰을 **실제로 포함**한다. 매핑표가
 *      상상 속 어휘를 들고 있지 않다는 것을 리포 파일로 접지한다.
 *   8. v2 필수 13필드(v1.1 참조 6종 + verification_id 포함)와 mission_id 패턴.
 *      ajv 로 인스턴스 수준까지 잰다. **ajv 가 없으면 skip 이 아니라 red** 다 —
 *      스키마를 읽을 수 있는 것은 ajv 뿐이라, 부재는 "약한 검증"이 아니라 "무검증"이다.
 *
 * ── 이 게이트가 못 보는 것 ─────────────────────────────────────────────
 * - **매핑표는 어휘만 본다. findings 내용의 의미는 못 본다.** `SPEC_FAIL` 이 실제로
 *   구현 미달인지 요구사항 모순인지는 findings 본문을 읽어야 알 수 있고, 이 테스트는
 *   그 판단을 하지 않는다(그래서 ambiguous 로 사람에게 올린다).
 * - `warning`/`*_WARN` → `PASS` 강등이 **정보 손실 없이** findings 로 보존되는지는
 *   어댑터 구현의 몫이다. 여기서는 매핑 방향만 고정한다.
 * - 어댑터 **구현체가 존재하지 않는다**(T-33·T-35 소관). 이 파일은 데이터 계약만
 *   재고, 런타임이 이 표를 실제로 읽는지는 재지 않는다.
 * - 스테이지 결합 규칙(SPEC_PASS ∧ QUALITY_PASS)은 `note` 로만 적혀 있고 기계
 *   검증 대상이 아니다.
 * - `cited_line` 은 참고값이다. 줄이 밀려도 red 가 되지 않는다(토큰 포함만 잰다).
 * - `verification_id` 형식은 설계에서 **미정**이라 `minLength:1` 외에는 재지 않는다.
 * - mission_id 패턴은 T-24(발급자)와 **아직 대조되지 않았다**. 발급 형식이 다르면
 *   이 게이트는 그린인 채로 런타임이 거부당한다.
 * - **게이트 8b 를 강제하는 ajv 의 버전을 이 파일은 고정하지 못한다.** ajv 는
 *   TRANSITIVE 의존(eslint -> ajv)으로만 들어온다: package.json 에 `ajv` 선언이
 *   없고, package-lock 은 6.15.0 을, 디스크의 설치 트리는 6.12.6 을 가리킨다
 *   (둘 다 2026-09-03 실측). eslint 를 올리는 것만으로 오라클이 사라질 수 있고,
 *   그때의 정답은 devDependency 선언이지 skip 복구가 아니다.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Imported defensively at module scope only so that a missing ajv produces the
// explicit AJV_MISSING failure below instead of an unresolved-import crash
// whose message says nothing about what to do. Absence is still a FAILURE: the
// instance-level block THROWS and goes RED — it is never skipped — when ajv
// cannot be resolved, matching tests/schemas/review-output.schema.test.js,
// which T-54 moved off the same skip.
let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '../..');
const SCHEMA_PATH = path.join(PLUGIN_ROOT, 'schemas/review-output.schema.json');
const MAP_PATH = path.join(PLUGIN_ROOT, 'schemas/verdict-adapter-map.json');

const CANONICAL_VERDICTS = [
  'PASS',
  'REPAIR_REQUIRED',
  'REPLAN_REQUIRED',
  'INTENT_REVIEW_REQUIRED',
  'BLOCK',
];

const V2_REQUIRED = [
  'schema_version',
  'verdict',
  'findings',
  'evidence',
  'recommended_action',
  'mission_id',
  'intent_revision',
  'plan_revision',
  'diff_ref',
  'test_evidence',
  'regression_evidence',
  'verification_id',
  'next_steps',
];

const SIX_MANDATORY_REFERENCES = [
  'mission_id',
  'intent_revision',
  'plan_revision',
  'diff_ref',
  'test_evidence',
  'regression_evidence',
];

const loadJson = async (p) => JSON.parse(await readFile(p, 'utf-8'));
const loadSchema = () => loadJson(SCHEMA_PATH);
const loadMap = () => loadJson(MAP_PATH);

describe('gate 1 — v1 root schema is untouched by the v2 addition', () => {
  it('keeps the v1 verdict enum', async () => {
    const schema = await loadSchema();
    expect(schema.properties.verdict.enum).toEqual(['pass', 'fail', 'warning']);
  });

  it('keeps the v1 findings required triple', async () => {
    const schema = await loadSchema();
    expect(schema.properties.findings.items.required).toEqual([
      'severity',
      'file',
      'description',
    ]);
  });

  it('keeps the critical/high conditional suggestion rule', async () => {
    const schema = await loadSchema();
    const rule = schema.properties.findings.items.allOf.find(
      (r) => r.then && Array.isArray(r.then.required) && r.then.required.includes('suggestion'),
    );
    expect(rule).toBeTruthy();
    expect(rule.if.properties.severity.enum).toEqual(['critical', 'high']);
    expect(rule.if.required).toEqual(['severity']);
  });

  it('does not add schema_version to the v1 root', async () => {
    // v1 documents carry no schema_version; adding one at the root would break
    // every existing producer under `additionalProperties: false`.
    const schema = await loadSchema();
    expect(schema.properties.schema_version).toBeUndefined();
    expect(schema.required).toEqual(['verdict', 'findings', 'next_steps']);
  });

  it('still has exactly one top-level description (raw-line count, as the v1 suite measures it)', async () => {
    const raw = await readFile(SCHEMA_PATH, 'utf-8');
    const topLevel = raw
      .split('\n')
      .filter((line) => /^\s{2}"description":/.test(line));
    expect(topLevel).toHaveLength(1);
  });
});

describe('gate 2 — definitions.finding must not drift from the v1 finding', () => {
  it('is deep-equal to properties.findings.items', async () => {
    const schema = await loadSchema();
    expect(schema.definitions.finding).toEqual(schema.properties.findings.items);
  });

  it('is referenced by v2 findings rather than re-inlined', async () => {
    const schema = await loadSchema();
    expect(schema.definitions.reviewOutputV2.properties.findings.items).toEqual({
      $ref: '#/definitions/finding',
    });
  });
});

describe('gate 3 — the 5 canonical verdicts agree in all three places', () => {
  it('schema v2 enum equals the canonical list, in order', async () => {
    const schema = await loadSchema();
    expect(schema.definitions.reviewOutputV2.properties.verdict.enum).toEqual(
      CANONICAL_VERDICTS,
    );
  });

  it('adapter map target_verdicts equals the canonical list, in order', async () => {
    const map = await loadMap();
    expect(map.target_verdicts).toEqual(CANONICAL_VERDICTS);
  });

  it('v2 is discriminated by schema_version const 2', async () => {
    const schema = await loadSchema();
    expect(schema.definitions.reviewOutputV2.properties.schema_version.const).toBe(2);
  });
});

describe('gate 4 — mapping covers every legacy token exactly once', () => {
  it('row count equals the total token count across all sources', async () => {
    const map = await loadMap();
    const tokenCount = map.sources.reduce((a, s) => a + s.vocabulary.length, 0);
    expect(map.rows).toHaveLength(tokenCount);
    expect(tokenCount).toBe(15);
  });

  it('every (source, token) pair from sources[] has exactly one row', async () => {
    const map = await loadMap();
    const rowKeys = map.rows.map((r) => `${r.source}:${r.token}`);
    expect(new Set(rowKeys).size).toBe(rowKeys.length); // no duplicate rows

    const expected = map.sources.flatMap((s) => s.vocabulary.map((t) => `${s.id}:${t}`));
    expect(rowKeys.slice().sort()).toEqual(expected.slice().sort());
  });

  it('every non-ambiguous row lands on a canonical verdict with no candidates', async () => {
    const map = await loadMap();
    for (const row of map.rows.filter((r) => !r.ambiguous)) {
      expect(CANONICAL_VERDICTS, `${row.source}:${row.token} -> ${row.verdict}`).toContain(
        row.verdict,
      );
      expect(row.candidates).toEqual([]);
    }
  });

  it('declares fail-closed handling for unmapped and ambiguous tokens', async () => {
    const map = await loadMap();
    // Not a deny-list: an unknown token must be rejected, never defaulted to PASS.
    expect(map.rules.unmapped_token).toBe('reject');
    expect(map.rules.ambiguous_token).toBe('escalate_to_human');
  });
});

describe('gate 5 — SPEC_FAIL is ambiguous and is the only ambiguous row', () => {
  it('carries no verdict and exactly the two candidates', async () => {
    const map = await loadMap();
    const row = map.rows.find((r) => r.source === 'spec-reviewer' && r.token === 'SPEC_FAIL');
    expect(row).toBeTruthy();
    expect(row.ambiguous).toBe(true);
    expect(row.verdict).toBeNull();
    expect(row.candidates).toEqual(['REPAIR_REQUIRED', 'INTENT_REVIEW_REQUIRED']);
  });

  it('is the only row in the table marked ambiguous', async () => {
    const map = await loadMap();
    const ambiguous = map.rows.filter((r) => r.ambiguous);
    expect(ambiguous.map((r) => `${r.source}:${r.token}`)).toEqual([
      'spec-reviewer:SPEC_FAIL',
    ]);
  });
});

describe('gate 6 — the vocabulary gap is pinned, not papered over', () => {
  it('no non-ambiguous row reaches INTENT_REVIEW_REQUIRED', async () => {
    const map = await loadMap();
    const reaching = map.rows.filter(
      (r) => !r.ambiguous && r.verdict === 'INTENT_REVIEW_REQUIRED',
    );
    expect(reaching).toEqual([]);
    expect(map.unreachable_verdicts.INTENT_REVIEW_REQUIRED).toBeTruthy();
  });

  it('REPLAN_REQUIRED is reached only by the superseded draft token replan', async () => {
    const map = await loadMap();
    const reaching = map.rows.filter((r) => r.verdict === 'REPLAN_REQUIRED');
    expect(reaching).toHaveLength(1);
    expect(reaching[0].source).toBe('design-v1.0-08');
    expect(reaching[0].token).toBe('replan');
  });

  it('BLOCK is reached only by REJECT', async () => {
    const map = await loadMap();
    const reaching = map.rows.filter((r) => r.verdict === 'BLOCK');
    expect(reaching).toHaveLength(1);
    expect(reaching[0].token).toBe('REJECT');
  });
});

describe('gate 7 — every source vocabulary is grounded in a real repo file', () => {
  it('each source file exists and literally contains each of its tokens', async () => {
    const map = await loadMap();
    for (const source of map.sources) {
      const abs = path.resolve(REPO_ROOT, source.file);
      expect(existsSync(abs), `${source.id}: missing ${source.file}`).toBe(true);
      const text = await readFile(abs, 'utf-8');
      for (const token of source.vocabulary) {
        expect(text, `${source.id}: token ${token} absent from ${source.file}`).toContain(
          token,
        );
      }
    }
  });

  it('lists exactly the five known vocabularies', async () => {
    const map = await loadMap();
    expect(map.sources.map((s) => s.id)).toEqual([
      'design-v1.0-08',
      'schema-v1',
      'code-reviewer',
      'spec-reviewer',
      'quality-reviewer',
    ]);
  });
});

describe('gate 8 — v2 required fields and mission_id shape', () => {
  it('requires all 13 fields, in order', async () => {
    const schema = await loadSchema();
    expect(schema.definitions.reviewOutputV2.required).toEqual(V2_REQUIRED);
  });

  it('keeps the six mandatory references non-optional', async () => {
    const schema = await loadSchema();
    const required = schema.definitions.reviewOutputV2.required;
    for (const field of SIX_MANDATORY_REFERENCES) {
      expect(required, `${field} must stay required`).toContain(field);
    }
  });

  it('accepts both the canonical and the session-fallback mission_id forms', async () => {
    const schema = await loadSchema();
    const re = new RegExp(schema.definitions.reviewOutputV2.properties.mission_id.pattern);
    expect(re.test('M-20260902-001')).toBe(true); // canonical M-YYYYMMDD-NNN
    expect(re.test('M-20260902-Sa1b2c3d4')).toBe(true); // fallback M-YYYYMMDD-S<sid8>
    expect(re.test('M-001')).toBe(false); // v1.1 doc illustration, not the canonical form
    expect(re.test('20260902-001')).toBe(false);
    expect(re.test('M-20260902-S123')).toBe(false); // sid8 must be 8 characters
  });

  it('closes the v2 object to unknown properties', async () => {
    const schema = await loadSchema();
    expect(schema.definitions.reviewOutputV2.additionalProperties).toBe(false);
  });
});

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to DECLARE the dependency, and
 * the wrong one — restoring the skip — is the one that looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so the review-output v2 contract cannot be enforced and this gate',
  'proves nothing. ajv is only a TRANSITIVE dependency here (eslint -> ajv);',
  "package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

describe('gate 8b — ajv instance behaviour (red, never skipped, without ajv)', () => {
  const evidence = [{ kind: 'command', command: 'npx vitest run', output: '15 passed' }];

  const validV2 = () => ({
    schema_version: 2,
    verdict: 'PASS',
    findings: [],
    evidence,
    recommended_action: 'proceed to outcome generation',
    mission_id: 'M-20260902-001',
    intent_revision: 1,
    plan_revision: 2,
    diff_ref: 'abc1234..def5678',
    test_evidence: evidence,
    regression_evidence: evidence,
    verification_id: 'V-abc123',
    next_steps: [],
  });

  async function stripped() {
    const schema = await loadSchema();
    const clone = JSON.parse(JSON.stringify(schema));
    // ajv v6's bundled meta-schema does not register the draft-07 $id URI; drop
    // $schema to avoid a meta-ref lookup miss, exactly as the v1 suite does.
    delete clone.$schema;
    return clone;
  }

  // Throws AJV_MISSING rather than returning null: a null validator turns
  // every assertion below into "validate is not a function", which buries the
  // real cause. A throwing compiler makes each test fail with the fix instead.
  async function compileRoot() {
    if (Ajv === null) throw new Error(AJV_MISSING);
    return new Ajv({ allErrors: true }).compile(await stripped());
  }

  async function compileV2() {
    if (Ajv === null) throw new Error(AJV_MISSING);
    const clone = await stripped();
    return new Ajv({ allErrors: true }).compile({
      definitions: clone.definitions,
      $ref: '#/definitions/reviewOutputV2',
    });
  }

  it('accepts a complete v2 document', async () => {
    const validate = await compileV2();
    expect(validate(validV2()), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a v2 document missing any one of the six references', async () => {
    const validate = await compileV2();
    for (const field of SIX_MANDATORY_REFERENCES) {
      const doc = validV2();
      delete doc[field];
      expect(validate(doc), `missing ${field} should be invalid`).toBe(false);
    }
  });

  it('rejects a v2 document missing verification_id', async () => {
    const validate = await compileV2();
    const doc = validV2();
    delete doc.verification_id;
    expect(validate(doc)).toBe(false);
  });

  it('rejects a legacy lowercase verdict under v2', async () => {
    const validate = await compileV2();
    const doc = validV2();
    doc.verdict = 'pass';
    expect(validate(doc)).toBe(false);
  });

  it('rejects evidence that pins neither file:line nor command/output', async () => {
    const validate = await compileV2();
    const doc = validV2();
    doc.evidence = [{ kind: 'file', note: 'trust me' }];
    expect(validate(doc)).toBe(false);
  });

  it('rejects an empty evidence array', async () => {
    const validate = await compileV2();
    const doc = validV2();
    doc.evidence = [];
    expect(validate(doc)).toBe(false);
  });

  it('rejects a malformed mission_id', async () => {
    const validate = await compileV2();
    const doc = validV2();
    doc.mission_id = 'M-001';
    expect(validate(doc)).toBe(false);
  });

  it('still accepts a v1 document against the unchanged root schema', async () => {
    const validate = await compileRoot();
    const v1 = {
      verdict: 'fail',
      findings: [
        { severity: 'critical', file: 'a.ts', description: 'sqli', suggestion: 'parameterize' },
      ],
      next_steps: ['fix it'],
    };
    expect(validate(v1), JSON.stringify(validate.errors)).toBe(true);
  });

  it('has a real oracle — present, and able to say NO as well as YES', async () => {
    // 위의 accept 단언들은 "전부 통과시키는" 검증기에도 그린이고, reject 단언들은
    // "전부 거부하는" 검증기에도 그린이다. 두 방향을 함께 요구해야 나머지가 값을
    // 갖는다. 비교값 자체에 조치 문구를 실어, 실패 diff 가 곧 지시가 되게 한다.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');

    const validate = await compileV2();
    expect(validate(validV2()), JSON.stringify(validate.errors)).toBe(true);

    const broken = validV2();
    broken.verdict = 'not-a-verdict';
    expect(validate(broken)).toBe(false);
  });

  it('still rejects a v1 critical finding with no suggestion', async () => {
    const validate = await compileRoot();
    const v1 = {
      verdict: 'fail',
      findings: [{ severity: 'critical', file: 'a.ts', description: 'sqli' }],
      next_steps: ['fix it'],
    };
    expect(validate(v1)).toBe(false);
  });
});
