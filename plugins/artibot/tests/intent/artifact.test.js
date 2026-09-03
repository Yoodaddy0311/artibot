/**
 * T-23 — `lib/intent/artifact.js`.
 *
 * The T-12 template (`schemas/intent-md.template.md`) is read off disk rather
 * than inlined: a copy would let the parser keep passing after the template
 * moved on, which is the exact drift this pair exists to catch.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  assertIntentFilePath,
  checkSpanConsistency,
  COMPLETION_ACTIONS,
  INTENT_ARTIFACT_BASENAME,
  INTENT_SECTIONS,
  isAllowedIntentFilePath,
  KNOWN_DERIVED_INTENT_NAMES,
  parseIntentMd,
  serializeIntentMd,
  WARNING_SEVERITY,
  WarningCode,
} from '../../lib/intent/artifact.js';
// 정본 span 검사기. 이 테스트는 두 구현이 같은 판정을 내는지만 본다 —
// 어긋나면 contract.js 가 옳고 artifact.js 가 버그다(오너 판정 2026-09-02).
import { verifyExplicitRequestSpans } from '../../lib/mission/contract.js';
// 완료 기대 어휘의 정본. 아래에서 참조 동일성을 단언한다.
import { COMPLETION_EXPECTATIONS } from '../../lib/intent/interpreter.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_PATH = join(PKG_ROOT, 'schemas', 'intent-md.template.md');
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');

/**
 * A filled-in mission document.
 *
 * `text` is DERIVED from the slice rather than written by hand, so the
 * fixture cannot drift out of exact match by a typo. Owner ruling 2026-09-02:
 * `text` quotes the original verbatim; summarising or normalising it is a
 * violation, and `lib/mission/contract.js#verifyExplicitRequestSpans` is the
 * canonical checker of that rule.
 */
const ORIGINAL_REQUEST = 'intent.md 파서를 만들고, 라운드트립을 테스트로 고정한다.';
const SPAN_A = [0, ORIGINAL_REQUEST.indexOf(',')];
const SPAN_B = [ORIGINAL_REQUEST.indexOf('라운드트립'), ORIGINAL_REQUEST.length - 1];
const TEXT_A = ORIGINAL_REQUEST.slice(SPAN_A[0], SPAN_A[1]);
const TEXT_B = ORIGINAL_REQUEST.slice(SPAN_B[0], SPAN_B[1]);

const FILLED = [
  '---',
  'schema_version: 1',
  'mission_id: M-20260902-001',
  'status: executing',
  'intent_revision: 2',
  'created_by: artibot-ef',
  'updated_by: artibot-ef',
  'created_at: 2026-09-02T06:29:36Z',
  'updated_at: 2026-09-02T07:12:00Z',
  'actor:',
  '  type: agent',
  '  id: autopilot-tyc5j4-T23',
  'explicit_requests:',
  `  - text: "${TEXT_A}"`,
  `    span: [${SPAN_A[0]}, ${SPAN_A[1]}]`,
  `  - text: "${TEXT_B}"`,
  `    span: [${SPAN_B[0]}, ${SPAN_B[1]}]`,
  'autonomy:',
  '  mode: agent_led',
  '  human_gates: [HG-01, HG-07]',
  'execution_profile:',
  '  reasoning:',
  '    depth: deep',
  '  review:',
  '    independent: true',
  '    strictness: high',
  '    model: fable-5.1',
  'review:',
  '  independent: true',
  '  model: fable-5.1',
  '---',
  '',
  '# Intent',
  '',
  '## Original Request',
  '',
  ORIGINAL_REQUEST,
  '',
  '## Interpreted Goal',
  '',
  '무손실 투영 파서를 착지시킨다.',
  '',
  '## Explicit Scope',
  '',
  '- lib/intent/artifact.js',
  '- tests/intent/artifact.test.js',
  '',
  '### Bounded Blindspots',
  '',
  '- 템플릿 절 누락 경고',
  '',
  '### Excluded',
  '',
  '- 다른 lib/intent 모듈 수정',
  '',
  '## Systemic Scope',
  '',
  '직접 인과가 확인될 때만 확장한다.',
  '',
  '## Success Criteria',
  '',
  '### Functional',
  '',
  '- parse 와 serialize 가 동작한다',
  '',
  '### Behavioral',
  '',
  '- 파생 파일 이름을 거부한다',
  '',
  '### Regression',
  '',
  '- 기존 intent 테스트가 깨지지 않는다',
  '',
  '### Evidence',
  '',
  '- npx vitest run tests/intent/',
  '',
  '## Completion',
  '',
  '- [x] answer',
  '- [ ] artifact',
  '- [x] implement',
  '- [x] test',
  '- [ ] commit',
  '- [ ] PR',
  '- [ ] deploy',
  '',
  '## Constraints',
  '',
  '- 다른 파일 수정 금지',
  '- 커밋 금지',
  '',
  '## User Decisions',
  '',
  '- Q: 최소 YAML 파서를 새로 쓸까? A: 그렇다 (2026-09-02)',
  '',
  '## Intent Refinements',
  '',
  '### Revision 2',
  '',
  'Reason: 범위 명확화',
  '',
].join('\n');

describe('lib/intent/artifact', () => {
  describe('T-12 템플릿 픽스처', () => {
    it('경고 없이 파싱된다', () => {
      const { warnings } = parseIntentMd(TEMPLATE);
      expect(warnings).toEqual([]);
    });

    it('frontmatter 를 계약으로 투영한다', () => {
      const { contract } = parseIntentMd(TEMPLATE);
      expect(contract.schema_version).toBe(1);
      expect(contract.mission_id).toBe('M-YYYYMMDD-XXX');
      expect(contract.intent_revision).toBe(1);
      expect(contract.autonomy).toEqual({ mode: 'agent_led', human_gates: [] });
      expect(contract.execution_profile.reasoning).toEqual({ depth: 'deep' });
      expect(contract.execution_profile.completion).toEqual({ verified_outcome_required: true });
      expect(contract.explicit_requests).toEqual([{ text: '', span: { start: 0, end: 0 } }]);
    });

    it('계약에 자리가 없는 provenance 는 source 에 남는다', () => {
      const { contract, source } = parseIntentMd(TEMPLATE);
      expect(source.frontmatter.actor).toEqual({ type: null, id: null });
      expect(Object.keys(source.frontmatter)).toContain('created_at');
      // additionalProperties:false 인 계약에는 들어가면 안 된다.
      expect(contract).not.toHaveProperty('actor');
      expect(contract).not.toHaveProperty('created_at');
    });

    it('빈 절은 빈 값으로 투영되고 절 자체는 15개 다 인식된다', () => {
      const { contract, source, warnings } = parseIntentMd(TEMPLATE);
      expect(Object.keys(source.sections)).toHaveLength(INTENT_SECTIONS.length);
      expect(contract.goal).toBe('');
      expect(contract.scope.requested_target).toEqual([]);
      expect(contract.completion.expected_actions).toEqual([]);
      expect(warnings.filter((w) => w.code === WarningCode.SECTION_MISSING)).toEqual([]);
    });
  });

  describe('무손실 라운드트립', () => {
    it('템플릿: serialize(parse(t), {originalText: t}) 가 바이트 동일하다', () => {
      const { contract } = parseIntentMd(TEMPLATE);
      expect(serializeIntentMd(contract, { originalText: TEMPLATE })).toBe(TEMPLATE);
    });

    it('채워진 문서: serialize(parse(t), {originalText: t}) 가 바이트 동일하다', () => {
      const { contract } = parseIntentMd(FILLED);
      expect(serializeIntentMd(contract, { originalText: FILLED })).toBe(FILLED);
    });

    it('parse(serialize(parse(t))) ≡ parse(t) — 제자리 형태', () => {
      const first = parseIntentMd(FILLED);
      const again = parseIntentMd(serializeIntentMd(first.contract, { originalText: FILLED }));
      expect(again.contract).toEqual(first.contract);
      expect(again.source).toEqual(first.source);
      expect(again.warnings).toEqual(first.warnings);
    });

    it('parse(serialize(parse(t))) ≡ parse(t) — 원본 없는 신규 작성 형태', () => {
      const first = parseIntentMd(FILLED);
      const fresh = serializeIntentMd(first.contract, { originalRequest: first.source.originalRequest });
      const again = parseIntentMd(fresh);
      expect(again.contract).toEqual(first.contract);
      expect(again.source.originalRequest).toBe(first.source.originalRequest);
      expect(again.warnings).toEqual([]);
    });

    it('안내 주석과 미매핑 frontmatter 키가 개정 뒤에도 남는다', () => {
      const { contract } = parseIntentMd(TEMPLATE);
      const revised = serializeIntentMd({ ...contract, intent_revision: 7 }, { originalText: TEMPLATE });
      expect(revised).toContain('# ── 공통 메타 (Hardening §29 schema_version · §24 provenance · T-19 조각) ──');
      expect(revised).toContain('created_by:');
      expect(revised).toContain('intent_revision: 7');
      expect(revised).not.toContain('intent_revision: 1');
    });
  });

  describe('제자리 개정 (serializeIntentMd + originalText)', () => {
    it('바뀐 키와 절만 다시 쓴다', () => {
      const { contract } = parseIntentMd(FILLED);
      const next = {
        ...contract,
        intent_revision: 3,
        goal: '무손실 투영 파서를 착지시킨다. (개정)',
      };
      const out = serializeIntentMd(next, { originalText: FILLED });
      const before = FILLED.split('\n');
      const after = out.split('\n');
      const changed = before
        .map((line, i) => (line === after[i] ? null : i))
        .filter((i) => i !== null);
      expect(changed).toHaveLength(2);
      expect(after[changed[0]]).toBe('intent_revision: 3');
      expect(after[changed[1]]).toBe('무손실 투영 파서를 착지시킨다. (개정)');
    });

    it('다시 쓴 값이 그대로 되읽힌다', () => {
      const { contract } = parseIntentMd(FILLED);
      const next = {
        ...contract,
        status: 'reviewing',
        explicit_requests: [{ text: TEXT_A, span: { start: SPAN_A[0], end: SPAN_A[1] } }],
        scope: { ...contract.scope, requested_target: ['lib/intent/artifact.js'] },
        completion: { expected_actions: ['answer', 'implement'] },
      };
      const reparsed = parseIntentMd(serializeIntentMd(next, { originalText: FILLED })).contract;
      expect(reparsed.status).toBe('reviewing');
      expect(reparsed.explicit_requests).toEqual(next.explicit_requests);
      expect(reparsed.scope.requested_target).toEqual(['lib/intent/artifact.js']);
      expect(reparsed.completion.expected_actions).toEqual(['answer', 'implement']);
    });

    it('계약에 자리가 없는 절은 개정이 건드리지 않는다', () => {
      const { contract } = parseIntentMd(FILLED);
      const out = serializeIntentMd({ ...contract, intent_revision: 9 }, { originalText: FILLED });
      expect(out).toContain('직접 인과가 확인될 때만 확장한다.');
      expect(out).toContain('### Revision 2');
      expect(out).toContain('Reason: 범위 명확화');
      expect(out).toContain(ORIGINAL_REQUEST);
    });

    it('CRLF 문서의 줄바꿈을 보존한다', () => {
      const crlf = FILLED.replace(/\n/g, '\r\n');
      const { contract } = parseIntentMd(crlf);
      const out = serializeIntentMd({ ...contract, intent_revision: 4 }, { originalText: crlf });
      expect(out).toContain('\r\n');
      expect(out).toContain('intent_revision: 4\r\n');
      expect(out.replace(/\r\n/g, '\n')).toBe(
        serializeIntentMd({ ...contract, intent_revision: 4 }, { originalText: FILLED }),
      );
    });

    it('제자리 개정에서 originalRequest 를 함께 주면 거부한다', () => {
      const { contract } = parseIntentMd(FILLED);
      expect(() => serializeIntentMd(contract, { originalText: FILLED, originalRequest: '다른 원문' }))
        .toThrow(/originalRequest/);
    });

    it('contract 가 객체가 아니면 거부한다', () => {
      expect(() => serializeIntentMd(null)).toThrow(TypeError);
    });
  });

  describe('span 정합', () => {
    it('픽스처의 span 이 원문을 그대로 잘라낸다', () => {
      const { contract, source, warnings } = parseIntentMd(FILLED);
      expect(source.originalRequest).toBe(ORIGINAL_REQUEST);
      expect(checkSpanConsistency(contract, source.originalRequest)).toEqual({ ok: true, issues: [] });
      expect(warnings).toEqual([]);
      // 정본 검사기(lib/mission/contract.js)와 같은 규칙인지 직접 대조한다.
      for (const req of contract.explicit_requests) {
        expect(ORIGINAL_REQUEST.slice(req.span.start, req.span.end)).toBe(req.text);
      }
    });

    it('요약·정규화된 text 를 오류로 거부한다', () => {
      const normalized = FILLED.replace(`  - text: "${TEXT_A}"`, '  - text: "intent.md 파서를 만든다"');
      const { warnings } = parseIntentMd(normalized);
      const mismatch = warnings.filter((w) => w.code === WarningCode.SPAN_TEXT_MISMATCH);
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0].severity).toBe('error');
      expect(mismatch[0].path).toBe('explicit_requests[0].span');
    });

    it('한 글자만 어긋나도 잡아낸다', () => {
      const off = checkSpanConsistency(
        { explicit_requests: [{ text: TEXT_A, span: { start: SPAN_A[0], end: SPAN_A[1] - 1 } }] },
        ORIGINAL_REQUEST,
      );
      expect(off.ok).toBe(false);
      expect(off.issues[0].code).toBe(WarningCode.SPAN_TEXT_MISMATCH);
    });

    it('원문 길이를 넘는 end 를 잡아낸다', () => {
      const broken = FILLED.replace(
        `    span: [${SPAN_B[0]}, ${SPAN_B[1]}]`,
        `    span: [${SPAN_B[0]}, ${ORIGINAL_REQUEST.length + 5}]`,
      );
      const { warnings } = parseIntentMd(broken);
      expect(warnings.map((w) => w.code)).toContain(WarningCode.SPAN_OUT_OF_BOUNDS);
      expect(warnings.find((w) => w.code === WarningCode.SPAN_OUT_OF_BOUNDS).path)
        .toBe('explicit_requests[1].span');
    });

    it('start > end 와 음수 start 를 잡아낸다', () => {
      const inverted = checkSpanConsistency(
        { explicit_requests: [{ text: 'x', span: { start: 9, end: 2 } }] },
        ORIGINAL_REQUEST,
      );
      expect(inverted.ok).toBe(false);
      expect(inverted.issues[0].code).toBe(WarningCode.SPAN_INVALID_RANGE);

      const negative = checkSpanConsistency(
        { explicit_requests: [{ text: 'x', span: { start: -1, end: 2 } }] },
        ORIGINAL_REQUEST,
      );
      expect(negative.issues[0].code).toBe(WarningCode.SPAN_INVALID_RANGE);
    });

    it('null span 은 허용하지 않는다 — 파싱은 되지만 오류 등급이다', () => {
      const nulled = FILLED.replace(`    span: [${SPAN_A[0]}, ${SPAN_A[1]}]`, '    span: null');
      const { contract, warnings } = parseIntentMd(nulled);
      expect(contract.explicit_requests[0].span).toBeNull();
      const nulls = warnings.filter((w) => w.code === WarningCode.SPAN_NULL);
      // 같은 항목이 두 번 보고되지 않는다.
      expect(nulls).toHaveLength(1);
      expect(nulls[0].severity).toBe('error');
      expect(nulls[0].message).toContain('inferred_outcomes');
      // 파싱 자체는 계속된다 — 던지지 않는다.
      expect(contract.goal).toBe('무손실 투영 파서를 착지시킨다.');
    });

    it('내용이 있는 text 가 빈 구간을 가리키면 불일치로 잡는다', () => {
      const result = checkSpanConsistency(
        { explicit_requests: [{ text: '무언가', span: { start: 3, end: 3 } }] },
        ORIGINAL_REQUEST,
      );
      expect(result.ok).toBe(false);
      expect(result.issues[0].code).toBe(WarningCode.SPAN_TEXT_MISMATCH);
    });

    it('빈 text 와 빈 구간은 서로 맞으므로 통과한다 (T-12 템플릿 기본값)', () => {
      expect(checkSpanConsistency(
        { explicit_requests: [{ text: '', span: { start: 0, end: 0 } }] },
        '',
      )).toEqual({ ok: true, issues: [] });
    });
  });

  describe('파생 파일 이름 거부', () => {
    it('허용되는 이름은 intent.md 하나뿐이다', () => {
      expect(INTENT_ARTIFACT_BASENAME).toBe('intent.md');
      expect(isAllowedIntentFilePath('intent.md')).toBe(true);
      expect(isAllowedIntentFilePath('.artibot/missions/M-20260902-001/intent.md')).toBe(true);
      expect(isAllowedIntentFilePath('.artibot\\missions\\M-20260902-001\\intent.md')).toBe(true);
    });

    it('템플릿이 이름으로 지목한 파생 파일을 전부 거부한다', () => {
      for (const name of KNOWN_DERIVED_INTENT_NAMES) {
        expect(isAllowedIntentFilePath(name)).toBe(false);
        expect(() => assertIntentFilePath(`.artibot/missions/M-20260902-001/${name}`)).toThrow(/파생 intent 파일 금지/);
      }
    });

    it('목록에 없는 새 파생 이름도 거부한다 (denylist 가 아니라 allowlist)', () => {
      for (const name of ['intent-v3.md', 'intent.backup.md', 'INTENT.md', 'intent.md.bak', 'my-intent.md', '']) {
        expect(isAllowedIntentFilePath(name)).toBe(false);
      }
      expect(isAllowedIntentFilePath(42)).toBe(false);
    });

    it('serializeIntentMd 의 targetPath 가 같은 게이트를 건다', () => {
      const { contract } = parseIntentMd(FILLED);
      expect(() => serializeIntentMd(contract, { originalText: FILLED, targetPath: 'intent-v2.md' }))
        .toThrow(/파생 intent 파일 금지/);
      expect(() => serializeIntentMd(contract, { originalText: FILLED, targetPath: 'a/b/intent.md' }))
        .not.toThrow();
    });
  });

  describe('구조 경고 (검증이 아니라 파싱 단계)', () => {
    it('절이 없으면 경고하되 파싱은 계속한다', () => {
      const trimmed = FILLED.replace('## Constraints\n\n- 다른 파일 수정 금지\n- 커밋 금지\n\n', '');
      const { contract, warnings } = parseIntentMd(trimmed);
      const missing = warnings.filter((w) => w.code === WarningCode.SECTION_MISSING);
      expect(missing).toHaveLength(1);
      expect(missing[0].path).toBe('## Constraints');
      expect(contract.constraints).toEqual([]);
      expect(contract.goal).toBe('무손실 투영 파서를 착지시킨다.');
    });

    it('frontmatter 가 없으면 경고하되 본문은 그대로 읽는다', () => {
      const bodyOnly = FILLED.slice(FILLED.indexOf('# Intent'));
      const { contract, warnings } = parseIntentMd(bodyOnly);
      expect(warnings.map((w) => w.code)).toContain(WarningCode.FRONTMATTER_MISSING);
      expect(contract.goal).toBe('무손실 투영 파서를 착지시킨다.');
      expect(contract).not.toHaveProperty('mission_id');
    });

    it('계약에도 보존 목록에도 없는 frontmatter 키를 알린다', () => {
      const extra = FILLED.replace('status: executing', 'status: executing\nbased_on: 1');
      const { warnings } = parseIntentMd(extra);
      const unmapped = warnings.filter((w) => w.code === WarningCode.FRONTMATTER_UNMAPPED_KEY);
      expect(unmapped).toHaveLength(1);
      expect(unmapped[0].path).toBe('based_on');
    });

    it('정본 7종 밖의 completion 체크박스를 알린다', () => {
      const odd = FILLED.replace('- [ ] deploy', '- [ ] deploy\n- [x] rollback');
      const { contract, warnings } = parseIntentMd(odd);
      expect(warnings.map((w) => w.code)).toContain(WarningCode.COMPLETION_UNKNOWN_ACTION);
      expect(contract.completion.expected_actions).toContain('rollback');
    });

    it('v1.0 문자열 형태의 explicit_requests 를 알린다', () => {
      const legacy = FILLED.replace(
        `  - text: "${TEXT_A}"\n    span: [${SPAN_A[0]}, ${SPAN_A[1]}]`,
        `  - ${TEXT_A}`,
      );
      const { contract, warnings } = parseIntentMd(legacy);
      const legacyWarn = warnings.find((w) => w.code === WarningCode.EXPLICIT_REQUEST_LEGACY_STRING);
      expect(legacyWarn.severity).toBe('error');
      expect(contract.explicit_requests[0]).toEqual({ text: TEXT_A, span: null });
      // LEGACY 를 냈다고 해서 span 결손 보고가 사라지면 안 된다.
      expect(warnings.map((w) => w.code)).toContain(WarningCode.SPAN_NULL);
    });

    it('빈 문자열도 던지지 않고 경고만 낸다', () => {
      const { contract, warnings } = parseIntentMd('');
      expect(warnings.map((w) => w.code)).toContain(WarningCode.FRONTMATTER_MISSING);
      expect(warnings.filter((w) => w.code === WarningCode.SECTION_MISSING))
        .toHaveLength(INTENT_SECTIONS.length);
      expect(contract.goal).toBe('');
    });
  });

  describe('절 ↔ 계약 투영', () => {
    it('본문 절을 계약 필드로 옮긴다', () => {
      const { contract } = parseIntentMd(FILLED);
      expect(contract.goal).toBe('무손실 투영 파서를 착지시킨다.');
      expect(contract.scope).toEqual({
        requested_target: ['lib/intent/artifact.js', 'tests/intent/artifact.test.js'],
        bounded_blindspots: ['템플릿 절 누락 경고'],
        excluded: ['다른 lib/intent 모듈 수정'],
      });
      expect(contract.success).toEqual({
        functional: ['parse 와 serialize 가 동작한다'],
        behavioral: ['파생 파일 이름을 거부한다'],
        regression: ['기존 intent 테스트가 깨지지 않는다'],
        evidence: ['npx vitest run tests/intent/'],
      });
      expect(contract.constraints).toEqual(['다른 파일 수정 금지', '커밋 금지']);
      expect(contract.user_decisions).toEqual(['Q: 최소 YAML 파서를 새로 쓸까? A: 그렇다 (2026-09-02)']);
    });

    it('체크된 completion 항목만 기대 행동이 된다', () => {
      const { contract } = parseIntentMd(FILLED);
      expect(contract.completion.expected_actions).toEqual(['answer', 'implement', 'test']);
      for (const action of ['artifact', 'commit', 'PR', 'deploy']) {
        expect(contract.completion.expected_actions).not.toContain(action);
      }
      expect(COMPLETION_ACTIONS).toHaveLength(7);
    });

    it('COMPLETION_ACTIONS 는 정본을 재수출한 같은 객체다 — 복사본이 아니다', () => {
      // 값 비교가 아니라 참조 비교다. 내용이 같은 사본을 다시 들여놔도 여기서 걸린다.
      expect(COMPLETION_ACTIONS).toBe(COMPLETION_EXPECTATIONS);
    });

    it('review.independent 는 계약의 review.required 가 된다', () => {
      const { contract, source } = parseIntentMd(FILLED);
      expect(source.frontmatter.review).toEqual({ independent: true, model: 'fable-5.1' });
      expect(contract.review).toEqual({ required: true, model: 'fable-5.1' });
      // 되돌릴 때 원래 키 이름으로 돌아간다.
      expect(serializeIntentMd(contract, { originalText: FILLED })).toContain('  independent: true');
    });

    it('Explicit Scope 가 하위 절을 삼키지 않는다', () => {
      const { contract } = parseIntentMd(FILLED);
      expect(contract.scope.requested_target).not.toContain('템플릿 절 누락 경고');
      expect(contract.scope.requested_target).toHaveLength(2);
    });

    it('HTML 주석은 내용으로 읽지 않는다', () => {
      const commented = FILLED.replace(
        '## Interpreted Goal\n\n무손실 투영 파서를 착지시킨다.',
        '## Interpreted Goal\n\n<!-- 여기에 목표를 적는다 -->\n무손실 투영 파서를 착지시킨다.',
      );
      expect(parseIntentMd(commented).contract.goal).toBe('무손실 투영 파서를 착지시킨다.');
    });
  });

  describe('오류 등급 (severity)', () => {
    it('모든 코드에 severity 가 있다 — 빠지면 fail-closed 소비자가 조용히 통과시킨다', () => {
      const codes = Object.values(WarningCode);
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        expect(['error', 'warning']).toContain(WARNING_SEVERITY[code]);
      }
      expect(Object.keys(WARNING_SEVERITY).sort()).toEqual([...codes].sort());
    });

    it('explicit_requests 관련 코드는 전부 error 다', () => {
      for (const code of [
        WarningCode.EXPLICIT_REQUESTS_SHAPE,
        WarningCode.EXPLICIT_REQUEST_LEGACY_STRING,
        WarningCode.SPAN_NULL,
        WarningCode.SPAN_SHAPE,
        WarningCode.SPAN_INVALID_RANGE,
        WarningCode.SPAN_OUT_OF_BOUNDS,
        WarningCode.SPAN_TEXT_MISMATCH,
      ]) {
        expect(WARNING_SEVERITY[code]).toBe('error');
      }
    });

    it('절 누락과 미매핑 키는 warning 이다 — 파싱을 막지 않는다', () => {
      for (const code of [
        WarningCode.FRONTMATTER_MISSING,
        WarningCode.FRONTMATTER_UNSUPPORTED,
        WarningCode.FRONTMATTER_UNMAPPED_KEY,
        WarningCode.SECTION_MISSING,
        WarningCode.COMPLETION_UNKNOWN_ACTION,
      ]) {
        expect(WARNING_SEVERITY[code]).toBe('warning');
      }
    });

    it('정상 픽스처에는 error 가 하나도 없다', () => {
      const { warnings } = parseIntentMd(FILLED);
      expect(warnings.filter((w) => w.severity === 'error')).toEqual([]);
      expect(parseIntentMd(TEMPLATE).warnings.filter((w) => w.severity === 'error')).toEqual([]);
    });
  });

  describe('정본 검사기와 규칙 일치 (lib/mission/contract.js)', () => {
    // 중복 구현은 허용되지만 규칙은 하나여야 한다. ok 판정이 갈리면 이 게이트가 잡는다.
    const cases = [
      ['원문 그대로 잘라낸 정상 항목', [{ text: TEXT_A, span: { start: SPAN_A[0], end: SPAN_A[1] } }], true],
      ['정규화된 text', [{ text: 'intent.md 파서를 만든다', span: { start: SPAN_A[0], end: SPAN_A[1] } }], false],
      ['한 글자 어긋난 end', [{ text: TEXT_A, span: { start: SPAN_A[0], end: SPAN_A[1] - 1 } }], false],
      ['null span', [{ text: TEXT_A, span: null }], false],
      ['원문 길이를 넘는 end', [{ text: TEXT_A, span: { start: 0, end: ORIGINAL_REQUEST.length + 5 } }], false],
      ['start > end', [{ text: TEXT_A, span: { start: 9, end: 2 } }], false],
      ['빈 text 와 빈 구간', [{ text: '', span: { start: 0, end: 0 } }], true],
    ];

    for (const [label, explicitRequests, expected] of cases) {
      it(`${label}: 두 검사기가 같은 판정을 낸다`, () => {
        const contract = { explicit_requests: explicitRequests };
        const mine = checkSpanConsistency(contract, ORIGINAL_REQUEST).ok;
        const canonical = verifyExplicitRequestSpans(contract, ORIGINAL_REQUEST).ok;
        expect(mine).toBe(expected);
        expect(canonical).toBe(expected);
      });
    }

    it('픽스처 전체에 대해서도 두 검사기가 일치한다', () => {
      const { contract, source } = parseIntentMd(FILLED);
      expect(checkSpanConsistency(contract, source.originalRequest).ok).toBe(true);
      expect(verifyExplicitRequestSpans(contract, source.originalRequest).ok).toBe(true);
    });
  });

  describe('최소 YAML 파서', () => {
    it('스칼라 타입을 구분한다', () => {
      const doc = [
        '---',
        'schema_version: 1',
        'mission_id: M-20260902-001',
        'intent_revision: 12',
        'execution_profile:',
        '  review:',
        '    independent: true',
        '    strictness: high',
        '    model: fable-5.1',
        '  completion:',
        '    verified_outcome_required: false',
        'autonomy:',
        '  mode: autonomous',
        '  human_gates: []',
        '---',
      ].join('\n');
      const { contract } = parseIntentMd(doc);
      expect(contract.schema_version).toBe(1);
      expect(contract.intent_revision).toBe(12);
      expect(contract.mission_id).toBe('M-20260902-001');
      expect(contract.execution_profile.review.independent).toBe(true);
      expect(contract.execution_profile.completion.verified_outcome_required).toBe(false);
      expect(contract.execution_profile.review.model).toBe('fable-5.1');
      expect(contract.autonomy.human_gates).toEqual([]);
    });

    it('따옴표 안의 콜론과 이스케이프를 왕복시킨다', () => {
      const tricky = 'A: B 를 "그대로" 유지 \\ 한다';
      const { contract } = parseIntentMd(FILLED);
      const next = { ...contract, explicit_requests: [{ text: tricky, span: { start: 0, end: 5 } }] };
      const reparsed = parseIntentMd(serializeIntentMd(next, { originalText: FILLED })).contract;
      expect(reparsed.explicit_requests[0].text).toBe(tricky);
    });

    it('블록 스칼라를 조용히 잘못 읽지 않고 알린다', () => {
      const doc = ['---', 'mission_id: M-20260902-001', 'status: |', '  executing', '---'].join('\n');
      const { warnings } = parseIntentMd(doc);
      expect(warnings.map((w) => w.code)).toContain(WarningCode.FRONTMATTER_UNSUPPORTED);
    });
  });
});
