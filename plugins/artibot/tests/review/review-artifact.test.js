/**
 * `lib/review/review-artifact` — the `review.md` SERIALIZER / PARSER.
 *
 * Why this module exists at all: `lib/runtime/artifact-lifecycle.js#apply`
 * writes `options.content.review` to `.artibot/missions/<M>/review.md`
 * VERBATIM — there is no renderer between the caller and the disk. So the
 * shape of a review artifact was, until this module, whatever string the
 * nearest call site happened to build. This suite pins the shape instead.
 *
 * ── The five properties this suite is here to hold ─────────────────────────
 *  1. ROUND-TRIP IDENTITY. `parseReviewMd(serializeReviewMd(x)).review`
 *     deep-equals the NORMALISED `x`. Asserting only "parse succeeds" would
 *     pass for a parser that dropped `based_on` entirely, which is exactly the
 *     field the staleness gate reads.
 *  2. THE VERDICT VOCABULARY IS THE IMPORTED ONE, WITH NO COERCION. Lower-case
 *     `'pass'` and the plausible-but-wrong `'APPROVE'` both THROW. A
 *     serializer that up-cased `'pass'` would launder an unreviewed answer
 *     into a `PASS` row; a parser that accepted it would do the same on read.
 *  3. A REFUSAL IS A THROW, NOT A DEFAULT. Every invalid input to
 *     `serializeReviewMd` raises `TypeError` naming the field. There is no
 *     "best effort" render: a review artifact that exists is a review artifact
 *     the runtime may act on.
 *  4. THE BYTES ARE DETERMINISTIC. Same input twice => byte-identical string,
 *     LF only, exactly one trailing newline. `review.md` is committed and
 *     diffed; a key-order or line-ending wobble would show up as a content
 *     change that no one made.
 *  5. THE PATH IS THE ONE PATH. `review-v2.md` / `review-final.md` / a
 *     `review.md` outside `.artibot/missions/<mission id>/` are all refused,
 *     mirroring the "파생 파일 금지" rule `lib/intent/artifact.js
 *     #assertIntentFilePath` applies to `intent.md`.
 *
 * ── What this suite does NOT prove ─────────────────────────────────────────
 *  - That anything writes the file. This module does no I/O by design; the
 *    write site is a sibling bundle. Green here says the STRING is right, not
 *    that a review ever reached the disk.
 *  - That `based_on` values are FRESH. Freshness is
 *    `lib/runtime/artifact-lifecycle-gates.js#classifyStaleness`, which
 *    compares against live revisions this module cannot see. Green here says
 *    the two members survive a round trip, nothing about their truth.
 *  - That the BODY is meaningful. The canon is the frontmatter; the body is a
 *    human-readable projection and is deliberately unvalidated on read.
 *
 * @module tests/review/review-artifact
 */

import { describe, expect, it } from 'vitest';

import {
  assertReviewFilePath,
  FIRST_REVIEW_REVISION,
  isAllowedReviewFilePath,
  parseReviewMd,
  REVIEW_ARTIFACT_BASENAME,
  REVIEW_SCHEMA_VERSION,
  reviewArtifactPath,
  serializeReviewMd,
} from '../../lib/review/review-artifact.js';
import { CANONICAL_VERDICTS } from '../../lib/review/independent-reviewer.js';

const MISSION = 'M-20260914-001';

/** The maximal input: every optional field present. */
function fullInput(overrides = {}) {
  return {
    missionId: MISSION,
    verdict: 'REPAIR_REQUIRED',
    findingsRef: 'transcript:agent-reviewer-3',
    verificationId: 'v-20260914-01',
    revision: 4,
    basedOn: { intentRevision: 2, planRevision: 5 },
    reviewerId: 'independent-reviewer',
    model: 'claude-opus-5',
    ts: '2026-09-14T01:23:45.000Z',
    ...overrides,
  };
}

/** The minimal input: every optional field absent. */
function minimalInput(overrides = {}) {
  return {
    missionId: MISSION,
    verdict: 'PASS',
    findingsRef: 'transcript:agent-x',
    verificationId: 'v-1',
    basedOn: { intentRevision: 0 },
    ts: '2026-09-14T01:23:45.000Z',
    ...overrides,
  };
}

/** Error codes present in a parse result, as a plain array of strings. */
function codesOf(result) {
  return result.errors.map((e) => e.code);
}

// ---------------------------------------------------------------------------
// (1) Round trip
// ---------------------------------------------------------------------------

describe('review-artifact 왕복 — serialize -> parse 가 입력을 보존한다', () => {
  it('전체 필드를 가진 입력이 정규화형 그대로 되돌아온다', () => {
    const input = fullInput();
    const parsed = parseReviewMd(serializeReviewMd(input));

    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.review).toEqual({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      missionId: MISSION,
      verdict: 'REPAIR_REQUIRED',
      findingsRef: 'transcript:agent-reviewer-3',
      verificationId: 'v-20260914-01',
      revision: 4,
      basedOn: { intentRevision: 2, planRevision: 5 },
      reviewerId: 'independent-reviewer',
      model: 'claude-opus-5',
      ts: '2026-09-14T01:23:45.000Z',
    });
  });

  it('선택 필드를 생략하면 null 과 기본 revision 으로 정규화된다', () => {
    const parsed = parseReviewMd(serializeReviewMd(minimalInput()));

    expect(parsed.ok).toBe(true);
    expect(parsed.review).toEqual({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      missionId: MISSION,
      verdict: 'PASS',
      findingsRef: 'transcript:agent-x',
      verificationId: 'v-1',
      revision: FIRST_REVIEW_REVISION,
      basedOn: { intentRevision: 0, planRevision: null },
      reviewerId: null,
      model: null,
      ts: '2026-09-14T01:23:45.000Z',
    });
  });

  it('CRLF 로 변환된 같은 문서가 같은 결과를 낸다', () => {
    const lf = serializeReviewMd(fullInput());
    const crlf = lf.replace(/\n/g, '\r\n');

    expect(crlf).not.toBe(lf);
    expect(parseReviewMd(crlf)).toEqual(parseReviewMd(lf));
  });

  it('planRevision: null 은 키를 생략하고, 생략과 같은 곳으로 되돌아온다', () => {
    const withNull = serializeReviewMd(minimalInput({ basedOn: { intentRevision: 0, planRevision: null } }));

    expect(withNull).not.toMatch(/plan_revision/);
    expect(withNull).toBe(serializeReviewMd(minimalInput()));
  });

  it('reviewerId / model 이 null 이면 키 자체가 없다', () => {
    const text = serializeReviewMd(minimalInput({ reviewerId: null, model: null }));

    expect(text).not.toMatch(/reviewer_id/);
    expect(text).not.toMatch(/^model:/m);
    expect(parseReviewMd(text).review.reviewerId).toBeNull();
  });

  it('다섯 정본 verdict 가 전부 왕복한다', () => {
    for (const verdict of CANONICAL_VERDICTS) {
      const parsed = parseReviewMd(serializeReviewMd(minimalInput({ verdict })));
      expect(parsed.ok, `${verdict} 왕복`).toBe(true);
      expect(parsed.review.verdict).toBe(verdict);
    }
    expect(CANONICAL_VERDICTS.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// (2) serialize refuses
// ---------------------------------------------------------------------------

describe('serializeReviewMd 거부 — 잘못된 입력은 TypeError 로 끝난다', () => {
  it("소문자 'pass' 를 대문자로 강등/승격하지 않고 던진다", () => {
    expect(() => serializeReviewMd(minimalInput({ verdict: 'pass' }))).toThrow(TypeError);
    expect(() => serializeReviewMd(minimalInput({ verdict: 'pass' }))).toThrow(/verdict/);
  });

  it("어휘 밖의 그럴듯한 'APPROVE' 를 던진다", () => {
    expect(() => serializeReviewMd(minimalInput({ verdict: 'APPROVE' }))).toThrow(/verdict/);
  });

  it('미지 verdict 를 던진다', () => {
    expect(() => serializeReviewMd(minimalInput({ verdict: 'MAYBE' }))).toThrow(/verdict/);
  });

  it('verdict 누락을 던진다', () => {
    const input = minimalInput();
    delete input.verdict;
    expect(() => serializeReviewMd(input)).toThrow(/verdict/);
  });

  it('mission id 패턴 밖을 던진다', () => {
    expect(() => serializeReviewMd(minimalInput({ missionId: 'mission-1' }))).toThrow(/missionId/);
  });

  it('빈 findingsRef 를 던진다', () => {
    expect(() => serializeReviewMd(minimalInput({ findingsRef: '' }))).toThrow(/findingsRef/);
    expect(() => serializeReviewMd(minimalInput({ findingsRef: '   ' }))).toThrow(/findingsRef/);
  });

  it('verificationId 누락을 던진다', () => {
    const input = minimalInput();
    delete input.verificationId;
    expect(() => serializeReviewMd(input)).toThrow(/verificationId/);
  });

  it('basedOn.intentRevision 누락을 던진다', () => {
    expect(() => serializeReviewMd(minimalInput({ basedOn: {} }))).toThrow(/intentRevision/);
  });

  it('음수 intentRevision 을 던진다', () => {
    expect(() => serializeReviewMd(minimalInput({ basedOn: { intentRevision: -1 } }))).toThrow(/intentRevision/);
  });

  it('소수 intentRevision 을 던진다', () => {
    expect(() => serializeReviewMd(minimalInput({ basedOn: { intentRevision: 1.5 } }))).toThrow(/intentRevision/);
  });

  it('revision 0 을 던진다 (첫 리비전은 1)', () => {
    expect(() => serializeReviewMd(minimalInput({ revision: 0 }))).toThrow(/revision/);
    expect(FIRST_REVIEW_REVISION).toBe(1);
  });

  it('ISO 가 아닌 ts 를 던진다', () => {
    expect(() => serializeReviewMd(minimalInput({ ts: '2026-09-14 01:23:45' }))).toThrow(/ts/);
    expect(() => serializeReviewMd(minimalInput({ ts: '2026-09-14T01:23:45Z' }))).toThrow(/ts/);
    expect(() => serializeReviewMd(minimalInput({ ts: 'not-a-date' }))).toThrow(/ts/);
  });

  it('basedOn 자체가 없거나 객체가 아니면 던진다', () => {
    const input = minimalInput();
    delete input.basedOn;
    expect(() => serializeReviewMd(input)).toThrow(/basedOn/);
    expect(() => serializeReviewMd(minimalInput({ basedOn: [] }))).toThrow(/basedOn/);
  });

  it('입력 자체가 객체가 아니면 던진다', () => {
    expect(() => serializeReviewMd(null)).toThrow(TypeError);
    expect(() => serializeReviewMd('review')).toThrow(TypeError);
  });

  it('미지 키는 무시되고 출력에 새지 않는다', () => {
    const text = serializeReviewMd(minimalInput({ secretNote: 'do not render', status: 'done' }));

    expect(text).not.toMatch(/do not render/);
    expect(text).not.toMatch(/secret_note|secretNote/);
    expect(text).toBe(serializeReviewMd(minimalInput()));
  });
});

// ---------------------------------------------------------------------------
// (3) parse refuses
// ---------------------------------------------------------------------------

describe('parseReviewMd 거부 — 읽을 수 없는 문서는 review:null 이다', () => {
  it('frontmatter 가 없으면 FRONTMATTER_MISSING 이다', () => {
    const result = parseReviewMd('# Review\n\n## Verdict\n\nPASS\n');

    expect(result.ok).toBe(false);
    expect(result.review).toBeNull();
    expect(codesOf(result)).toEqual(['FRONTMATTER_MISSING']);
  });

  it('닫는 --- 가 없으면 FRONTMATTER_MISSING 이다', () => {
    const result = parseReviewMd('---\nmission_id: "M-20260914-001"\n');

    expect(codesOf(result)).toEqual(['FRONTMATTER_MISSING']);
    expect(result.review).toBeNull();
  });

  it('문자열이 아닌 입력도 FRONTMATTER_MISSING 으로 닫힌다', () => {
    for (const bad of [null, undefined, 42, {}]) {
      const result = parseReviewMd(bad);
      expect(result.ok, String(bad)).toBe(false);
      expect(codesOf(result)).toEqual(['FRONTMATTER_MISSING']);
    }
  });

  it('필수 키를 하나씩 지우면 그 키 이름으로 MISSING_KEY 가 난다', () => {
    const required = [
      'schema_version',
      'mission_id',
      'verdict',
      'findings_ref',
      'verification_id',
      'revision',
      'intent_revision',
      'created_at',
      'updated_at',
    ];
    const text = serializeReviewMd(fullInput());

    for (const key of required) {
      const damaged = text.split('\n').filter((l) => !l.trim().startsWith(`${key}:`)).join('\n');
      const result = parseReviewMd(damaged);

      expect(result.ok, `${key} 삭제`).toBe(false);
      expect(result.review).toBeNull();
      expect(codesOf(result), `${key} 삭제`).toContain('MISSING_KEY');
      expect(result.errors.some((e) => e.message.includes(key)), `${key} 이름이 메시지에 있다`).toBe(true);
    }
  });

  it('based_on 블록이 통째로 없으면 intent_revision 누락으로 잡힌다', () => {
    const text = serializeReviewMd(fullInput())
      .split('\n')
      .filter((l) => !/^\s*(based_on:|intent_revision:|plan_revision:)/.test(l))
      .join('\n');
    const result = parseReviewMd(text);

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_KEY' && e.message.includes('intent_revision'))).toBe(true);
  });

  it('어휘 밖 verdict 는 INVALID_VALUE 다 (읽을 때도 강등 없음)', () => {
    const text = serializeReviewMd(fullInput()).replace('"REPAIR_REQUIRED"', '"approve"');
    const result = parseReviewMd(text);

    expect(result.ok).toBe(false);
    expect(result.review).toBeNull();
    expect(result.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('verdict'))).toBe(true);
  });

  it('정수가 아닌 revision, 패턴 밖 mission_id, 비 ISO ts 가 각각 INVALID_VALUE 다', () => {
    const base = serializeReviewMd(fullInput());

    const badRevision = parseReviewMd(base.replace('revision: 4', 'revision: "four"'));
    expect(badRevision.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('revision'))).toBe(true);

    const badMission = parseReviewMd(base.replace(`"${MISSION}"`, '"mission-1"'));
    expect(badMission.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('mission_id'))).toBe(true);

    const badTs = parseReviewMd(base.replace(/"2026-09-14T01:23:45\.000Z"/g, '"어제"'));
    expect(badTs.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('updated_at'))).toBe(true);
  });

  it('오류가 여러 개면 전부 모아 돌려준다', () => {
    const result = parseReviewMd('---\nschema_version: 1\n---\n');

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(3);
    expect(new Set(codesOf(result))).toEqual(new Set(['MISSING_KEY']));
  });

  it('시퀀스는 FRONTMATTER_UNSUPPORTED 다', () => {
    const text = serializeReviewMd(fullInput()).replace('revision: 4', 'tags:\n  - a\n  - b\nrevision: 4');
    const result = parseReviewMd(text);

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain('FRONTMATTER_UNSUPPORTED');
  });

  it('블록 스칼라·앵커·2단계 중첩도 FRONTMATTER_UNSUPPORTED 다', () => {
    const base = serializeReviewMd(fullInput());
    const cases = [
      base.replace('revision: 4', 'note: |\n  두 줄\n  짜리\nrevision: 4'),
      base.replace('revision: 4', 'anchor: &a 1\nrevision: 4'),
      base.replace('  plan_revision: 5', '  plan_revision: 5\n  deep:\n    deeper: 1'),
    ];

    for (const [i, text] of cases.entries()) {
      const result = parseReviewMd(text);
      expect(result.ok, `case ${i}`).toBe(false);
      expect(codesOf(result), `case ${i}`).toContain('FRONTMATTER_UNSUPPORTED');
    }
  });

  it('콜론이 든 findings_ref 가 값 째로 살아남는다', () => {
    const parsed = parseReviewMd(serializeReviewMd(fullInput({ findingsRef: 'transcript:agent-x#L10:20' })));

    expect(parsed.ok).toBe(true);
    expect(parsed.review.findingsRef).toBe('transcript:agent-x#L10:20');
  });

  it('본문은 검증하지 않는다 — 본문이 통째로 없어도 ok 다', () => {
    const text = serializeReviewMd(fullInput());
    const frontmatterOnly = `${text.split('\n---')[0]}\n---\n`;
    const result = parseReviewMd(frontmatterOnly);

    expect(result.ok).toBe(true);
    expect(result.review.verdict).toBe('REPAIR_REQUIRED');
  });

  it('미지 frontmatter 키는 무시된다', () => {
    const text = serializeReviewMd(fullInput()).replace('revision: 4', 'future_key: "x"\nrevision: 4');
    const result = parseReviewMd(text);

    expect(result.ok).toBe(true);
    expect(result.review).not.toHaveProperty('futureKey');
  });
});

// ---------------------------------------------------------------------------
// (4) Path
// ---------------------------------------------------------------------------

describe('review 아티팩트 경로 — 파생 파일 금지', () => {
  it('POSIX·Windows 구분자 둘 다 허용한다', () => {
    expect(isAllowedReviewFilePath(`.artibot/missions/${MISSION}/review.md`)).toBe(true);
    expect(isAllowedReviewFilePath(`C:\\repo\\.artibot\\missions\\${MISSION}\\review.md`)).toBe(true);
  });

  it('파생 이름·다른 아티팩트·missions 밖·비 mission id 를 거부한다', () => {
    const rejected = [
      `.artibot/missions/${MISSION}/review-v2.md`,
      `.artibot/missions/${MISSION}/review-final.md`,
      `.artibot/missions/${MISSION}/intent.md`,
      '.artibot/review.md',
      '.artibot/missions/not-a-mission/review.md',
    ];

    for (const p of rejected) {
      expect(isAllowedReviewFilePath(p), p).toBe(false);
    }
  });

  it('한 단계 더 깊은 하위 디렉터리도 거부한다', () => {
    expect(isAllowedReviewFilePath(`.artibot/missions/${MISSION}/sub/review.md`)).toBe(false);
  });

  it('빈 값·비문자열을 거부한다', () => {
    for (const bad of ['', '   ', null, undefined, 7]) {
      expect(isAllowedReviewFilePath(bad), String(bad)).toBe(false);
    }
  });

  it('assertReviewFilePath 는 허용 경로에 조용하고 나머지에 throw 한다', () => {
    expect(() => assertReviewFilePath(`.artibot/missions/${MISSION}/review.md`)).not.toThrow();
    expect(() => assertReviewFilePath(`.artibot/missions/${MISSION}/review-v2.md`)).toThrow(/review-v2\.md/);
  });

  it('reviewArtifactPath 가 허용 경로를 만든다', () => {
    const p = reviewArtifactPath('C:\\repo', MISSION);

    expect(isAllowedReviewFilePath(p)).toBe(true);
    expect(p.replace(/\\/g, '/')).toBe(`C:/repo/.artibot/missions/${MISSION}/review.md`);
    expect(REVIEW_ARTIFACT_BASENAME).toBe('review.md');
  });

  it('reviewArtifactPath 는 mission id 가 아니면 던진다', () => {
    expect(() => reviewArtifactPath('C:\\repo', 'mission-1')).toThrow(/missionId/);
  });
});

// ---------------------------------------------------------------------------
// (5) Determinism and shape
// ---------------------------------------------------------------------------

describe('review.md 바이트 — 결정적이고 LF 다', () => {
  it('같은 입력을 두 번 직렬화하면 바이트가 같다', () => {
    expect(serializeReviewMd(fullInput())).toBe(serializeReviewMd(fullInput()));
  });

  it('CR 이 없고 끝 개행이 정확히 하나다', () => {
    const text = serializeReviewMd(fullInput());

    expect(text).not.toMatch(/\r/);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('frontmatter 키 순서가 고정돼 있다', () => {
    const text = serializeReviewMd(fullInput());
    const keys = text
      .split('\n---')[0]
      .split('\n')
      .slice(1)
      .filter((l) => l.trim() !== '')
      .map((l) => l.trim().split(':')[0]);

    expect(keys).toEqual([
      'schema_version',
      'mission_id',
      'verdict',
      'findings_ref',
      'verification_id',
      'revision',
      'based_on',
      'intent_revision',
      'plan_revision',
      'reviewer_id',
      'model',
      'created_at',
      'updated_at',
    ]);
  });

  it('문자열 값은 큰따옴표로 인용되고 정수는 그대로다', () => {
    const text = serializeReviewMd(fullInput());

    expect(text).toContain(`mission_id: "${MISSION}"`);
    expect(text).toContain('findings_ref: "transcript:agent-reviewer-3"');
    expect(text).toContain('revision: 4');
    expect(text).toContain('  intent_revision: 2');
    expect(text).toContain('schema_version: 1');
  });

  it('본문이 제목·판정·손대지 말라는 주석을 담는다', () => {
    const text = serializeReviewMd(fullInput());

    expect(text).toContain('# Review');
    expect(text).toContain('## Verdict');
    expect(text).toContain('\nREPAIR_REQUIRED\n');
    expect(text).toMatch(/<!--[\s\S]*손으로 고치지 말 것[\s\S]*-->/);
  });

  it('created_at 과 updated_at 이 둘 다 ts 다', () => {
    const text = serializeReviewMd(fullInput());

    expect(text).toContain('created_at: "2026-09-14T01:23:45.000Z"');
    expect(text).toContain('updated_at: "2026-09-14T01:23:45.000Z"');
  });
});

// ---------------------------------------------------------------------------
// (6) Realistic sizes
// ---------------------------------------------------------------------------

describe('review.md 현실 크기 — 픽스처가 라이브 값과 같은 자릿수인가', () => {
  it('64자 hex verification_id 와 긴 findings_ref 가 왕복한다', () => {
    const verificationId = 'a3f'.repeat(22).slice(0, 64);
    const findingsRef = `transcript:${'agent-reviewer-'.repeat(8)}42`;
    const input = fullInput({ verificationId, findingsRef, model: 'claude-opus-5[1m]' });
    const parsed = parseReviewMd(serializeReviewMd(input));

    expect(verificationId).toHaveLength(64);
    expect(parsed.ok).toBe(true);
    expect(parsed.review.verificationId).toBe(verificationId);
    expect(parsed.review.findingsRef).toBe(findingsRef);
    expect(parsed.review.model).toBe('claude-opus-5[1m]');
  });

  it('큰 revision 과 큰 based_on 값이 정수로 살아남는다', () => {
    const parsed = parseReviewMd(serializeReviewMd(fullInput({
      revision: 137,
      basedOn: { intentRevision: 41, planRevision: 908 },
    })));

    expect(parsed.review.revision).toBe(137);
    expect(parsed.review.basedOn).toEqual({ intentRevision: 41, planRevision: 908 });
  });
});
