/**
 * `lib/mission/outcome-artifact` — the `outcome.md` SERIALIZER / PARSER.
 *
 * Why this module exists at all: `lib/runtime/artifact-lifecycle.js#apply`
 * writes artifact content to `.artibot/missions/<M>/<kind>.md` VERBATIM — there
 * is no renderer between the caller and the disk. Until this module the shape
 * of an outcome artifact was whatever string the nearest call site happened to
 * build, which makes `based_on` — the input of the staleness gate
 * (`artifact-lifecycle-gates.js#classifyStaleness`) — a per-call-site
 * convention rather than a contract. This suite pins the shape.
 *
 * ── The properties this suite is here to hold ──────────────────────────────
 *  1. ROUND-TRIP IDENTITY. `parseOutcomeMd(serializeOutcomeMd(x)).outcome`
 *     deep-equals the NORMALISED `x`, AND re-serialising it yields
 *     BYTE-IDENTICAL text. Asserting only "parse succeeds" would pass for a
 *     parser that dropped `evidence_refs` entirely.
 *  2. `accepted` KEEPS ITS THREE VALUES — `null`/`true`/`false`, never the
 *     strings. `lib/runtime/ledger.js#currentMission` (:477-493) reads a
 *     non-null `accepted` as "mission closed", and `"null"` is non-null: it
 *     would close a mission the judgement window has not closed.
 *  3. THE VOCABULARIES ARE THE CANON'S, READ NOT COPIED.
 *     `OUTCOME_BASED_ON_MEMBERS` is compared against the SOURCE TEXT of
 *     `artifact-lifecycle-gates.js#BASED_ON_MEMBERS_BY_KIND` (module-private,
 *     so an import is impossible and a copy here would drift in lockstep and
 *     prove nothing), `OUTCOME_SECTIONS` against the design package's own
 *     fenced example. Both extractors carry a negative control.
 *  4. A REFUSAL IS A THROW, NOT A DEFAULT — every invalid serializer input
 *     raises `TypeError` naming the field.
 *  5. THE BYTES ARE DETERMINISTIC. Same input twice => byte-identical, LF only,
 *     exactly one trailing newline. `outcome.md` is committed.
 *  6. THE PATH IS THE ONE PATH — the four derived names and any `outcome.md`
 *     outside `.artibot/missions/<mission id>/` are refused.
 *  7. A PLACEHOLDER IN A REQUIRED SECTION IS A REPORTED FINDING. The serializer
 *     renders it without judging; `parseOutcomeMd` reports
 *     `REQUIRED_SECTION_EMPTY` for the five sections `ARTIBOT-5.0-DESIGN.md:180`
 *     does NOT allow to be empty, so a gate can refuse on it.
 *
 * ── What this suite does NOT prove ─────────────────────────────────────────
 *  - That anything WRITES the file. The write site is a sibling bundle, and the
 *    live UNMEASURED gate (`#outcomeBlockCode`) refuses before it. Green here
 *    says the STRING is right, not that an outcome reached the disk.
 *  - That the outcome is TRUE. `accepted`, `verification_id` and the prose are
 *    the caller's declarations, never checked against the rows they summarise.
 *  - That `based_on` is FRESH — that is `classifyStaleness`, against live
 *    revisions this module cannot see.
 *  - That a `verification_id` identifies ONE verification: it is a constant
 *    hash plus a second-resolution stamp (`verify-rate.js:26-38`), so two
 *    sessions in one second collide and every assertion below still passes.
 *
 * @module tests/mission/outcome-artifact
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertOutcomeFilePath,
  isAllowedOutcomeFilePath,
  missionIdFromOutcomePath,
  OUTCOME_ARTIFACT_BASENAME,
  OUTCOME_BASED_ON_MEMBERS,
  OUTCOME_NOT_RECORDED,
  OUTCOME_REQUIRED_SECTION_KEYS,
  OUTCOME_SCHEMA_VERSION,
  OUTCOME_SECTIONS,
  outcomeArtifactPath,
  OutcomeFindingCode,
  parseOutcomeMd,
  serializeOutcomeMd,
} from '../../lib/mission/outcome-artifact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');
const GATES_SOURCE_PATH = join(PLUGIN_ROOT, 'lib', 'runtime', 'artifact-lifecycle-gates.js');
const LEDGER_DOC_PATH = join(
  REPO_ROOT, '.artibot', 'guides', 'v5-design', 'package-v1.1', '11_REVIEW_OUTCOME_LEDGER.md',
);

const MISSION = 'M-20260915-001';
const SESSION_MISSION = 'M-20260915-S04c7da6b';
const TS = '2026-09-15T01:23:45.000Z';
const VERIFICATION_ID = 'v1-83866286c2d8-20260915T012345Z';

/** Refs with a colon and a space — the two characters a bare YAML scalar loses. */
const REFS = Object.freeze([
  'ledger:mission:M-20260915-001:completed:null',
  'transcript:sess-1',
  'note: 두 단어 사이 공백',
]);

/** The maximal input: every optional field present, every section filled. */
function fullInput(overrides = {}) {
  return {
    missionId: MISSION,
    basedOn: { intentRevision: 2, planRevision: 4, reviewRevision: 1 },
    verificationId: VERIFICATION_ID,
    evidenceRefs: [...REFS],
    accepted: true,
    supersedes: 'mission:M-20260915-001:completed:null',
    actor: { type: 'hook', id: 'mission-complete-record' },
    ts: TS,
    sections: {
      mission: 'outcome.md 직렬화기를 만든다',
      accepted_result: ['직렬화기 착지', '파서 착지'],
      changes: ['lib/mission/outcome-artifact.js 신설'],
      verification: 'vitest 표적 스위트 green',
      review: 'PASS',
      blindspots: ['라이브 도달은 UNMEASURED 게이트가 막는다'],
      followups: 'census 모듈은 별 번들',
    },
    ...overrides,
  };
}

/** The minimal input: no sections, no supersedes, empty refs, accepted null. */
function minimalInput(overrides = {}) {
  return {
    missionId: MISSION,
    basedOn: { intentRevision: 0, planRevision: 0, reviewRevision: 0 },
    verificationId: VERIFICATION_ID,
    evidenceRefs: [],
    accepted: null,
    actor: { type: 'worker', id: 'w-1' },
    ts: TS,
    ...overrides,
  };
}

/** Error codes present in a parse result, as a plain array of strings. */
function codesOf(result) {
  return result.errors.map((e) => e.code);
}

/** Finding codes present in a parse result. */
function findingCodesOf(result) {
  return result.findings.map((f) => f.code);
}

/**
 * Pull the OUTCOME member list out of the gates module's SOURCE TEXT.
 *
 * `BASED_ON_MEMBERS_BY_KIND` is module-private (no `export`), so this is the
 * only way to compare the two lists without exporting an L5 constant. Anchored
 * on the declaration first and the `[ArtifactKind.OUTCOME]` entry second,
 * because `[ArtifactKind.OUTCOME]` also appears in `STALE_VERDICT_BY_KIND` a
 * few lines above with a different value shape.
 *
 * @param {string} source
 * @returns {string[]|null} `null` when nothing matched — the negative control.
 */
function extractOutcomeBasedOnMembers(source) {
  const block = /const BASED_ON_MEMBERS_BY_KIND = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(source);
  if (block === null) return null;
  const entry = /\[ArtifactKind\.OUTCOME\]:\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(block[1]);
  if (entry === null) return null;
  const members = [...entry[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  return members.length === 0 ? null : members;
}

/**
 * Pull the seven body headings out of the design package's fenced example.
 *
 * Anchored on the `## outcome.md` heading first and the fence that follows it
 * second — the example's own `## Mission` lines sit at column 0 inside the
 * fence, so a section regex that stopped at the next `## ` would stop inside
 * the block it is trying to read.
 *
 * @param {string} source
 * @returns {string[]|null} `null` when nothing matched — the negative control.
 */
function extractDocHeadings(source) {
  const heading = /(^|\n)## outcome\.md\n/.exec(source);
  if (heading === null) return null;
  const fence = /```markdown\n([\s\S]*?)```/.exec(source.slice(heading.index));
  if (fence === null) return null;
  const headings = fence[1]
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim());
  return headings.length === 0 ? null : headings;
}

/**
 * Read a canon file LF-normalised. Both are checked out CRLF on Windows and LF
 * on CI, so an extractor anchored on `\n` would match on one and not the other
 * — and "the regex found nothing" reads exactly like "the constant drifted".
 *
 * @param {string} file
 * @returns {string}
 */
function canonText(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const gatesSource = () => canonText(GATES_SOURCE_PATH);
const ledgerDoc = () => canonText(LEDGER_DOC_PATH);

/** Frontmatter `key:` names in render order, nested keys included, in-order. */
function frontmatterKeys(text) {
  return text
    .split('\n---')[0]
    .split('\n')
    .slice(1)
    .filter((l) => /^ *[A-Za-z0-9_]+:/.test(l))
    .map((l) => l.trim().split(':')[0]);
}

/** The `## ` headings of the rendered body, in order. */
function bodyHeadings(text) {
  return text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
}

// ── (1) Round trip ─────────────────────────────────────────────────────────

describe('outcome-artifact 왕복 — serialize -> parse -> serialize 가 입력을 보존한다', () => {
  it('전체 필드를 가진 입력이 정규화형 그대로 되돌아온다', () => {
    const parsed = parseOutcomeMd(serializeOutcomeMd(fullInput()));
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.outcome).toEqual({
      schemaVersion: OUTCOME_SCHEMA_VERSION,
      missionId: MISSION,
      basedOn: { intentRevision: 2, planRevision: 4, reviewRevision: 1 },
      verificationId: VERIFICATION_ID,
      evidenceRefs: [...REFS],
      accepted: true,
      supersedes: 'mission:M-20260915-001:completed:null',
      actor: { type: 'hook', id: 'mission-complete-record' },
      ts: TS,
    });
  });

  it('최소 입력이 supersedes 없이, 빈 evidence_refs 로 왕복한다', () => {
    const parsed = parseOutcomeMd(serializeOutcomeMd(minimalInput()));
    expect(parsed.ok).toBe(true);
    expect(parsed.outcome).toEqual({
      schemaVersion: OUTCOME_SCHEMA_VERSION,
      missionId: MISSION,
      basedOn: { intentRevision: 0, planRevision: 0, reviewRevision: 0 },
      verificationId: VERIFICATION_ID,
      evidenceRefs: [],
      accepted: null,
      actor: { type: 'worker', id: 'w-1' },
      ts: TS,
    });
    expect(Object.hasOwn(parsed.outcome, 'supersedes')).toBe(false);
  });

  it('파싱 결과를 같은 sections 로 재직렬화하면 바이트가 동일하다', () => {
    for (const input of [fullInput(), minimalInput()]) {
      const first = serializeOutcomeMd(input);
      const parsed = parseOutcomeMd(first);

      expect(parsed.ok).toBe(true);
      const again = serializeOutcomeMd({ ...parsed.outcome, sections: input.sections });
      expect(again, JSON.stringify(input.accepted)).toBe(first);
    }
  });

  it('accepted 세 값이 불리언·null 로 살아남는다 — 문자열로 강등되지 않는다', () => {
    for (const accepted of [true, false, null]) {
      const text = serializeOutcomeMd(minimalInput({ accepted }));
      const parsed = parseOutcomeMd(text);

      expect(parsed.ok, String(accepted)).toBe(true);
      expect(parsed.outcome.accepted, String(accepted)).toBe(accepted);
      expect(typeof parsed.outcome.accepted, String(accepted)).not.toBe('string');
      expect(text).toContain(`accepted: ${String(accepted)}`);
      expect(text).not.toContain(`accepted: "${String(accepted)}"`);
    }
  });

  it('콜론·공백을 담은 evidence_refs 가 항목 경계를 잃지 않는다', () => {
    const parsed = parseOutcomeMd(serializeOutcomeMd(fullInput()));
    expect(parsed.outcome.evidenceRefs).toEqual([...REFS]);
    expect(parsed.outcome.evidenceRefs).toHaveLength(3);
  });

  it('CRLF 로 변환된 같은 문서가 같은 결과를 낸다', () => {
    const lf = serializeOutcomeMd(fullInput());
    const crlf = lf.replace(/\n/g, '\r\n');

    expect(crlf).not.toBe(lf);
    expect(parseOutcomeMd(crlf)).toEqual(parseOutcomeMd(lf));
  });

  it('세션 폴백 mission id 와 큰 revision 이 그대로 왕복한다', () => {
    const session = parseOutcomeMd(serializeOutcomeMd(minimalInput({ missionId: SESSION_MISSION })));
    expect(session.ok).toBe(true);
    expect(session.outcome.missionId).toBe(SESSION_MISSION);

    const big = parseOutcomeMd(serializeOutcomeMd(fullInput({
      basedOn: { intentRevision: 908, planRevision: 137, reviewRevision: 12 },
    })));
    expect(big.outcome.basedOn).toEqual({
      intentRevision: 908, planRevision: 137, reviewRevision: 12,
    });
  });
});

// ── (2) The vocabularies are read from the canon, not copied ───────────────

describe('outcome 어휘 — 정본 파일에서 읽어 대조한다', () => {
  it('OUTCOME_BASED_ON_MEMBERS 가 gates 소스의 OUTCOME 목록과 같다', () => {
    const members = extractOutcomeBasedOnMembers(gatesSource());
    expect(members, 'gates 소스에서 OUTCOME based_on 목록을 추출하지 못했다').not.toBeNull();
    expect([...OUTCOME_BASED_ON_MEMBERS]).toEqual(members);
    expect(members).toEqual(['intent_revision', 'plan_revision', 'review_revision']);
  });

  it('추출기 자기검증 — 앵커가 없는 텍스트에서는 null 을 돌려준다 (음성 대조군)', () => {
    expect(extractOutcomeBasedOnMembers('const X = 1;\n')).toBeNull();
    expect(extractOutcomeBasedOnMembers(
      'const BASED_ON_MEMBERS_BY_KIND = Object.freeze({\n  [ArtifactKind.PLAN]: Object.freeze([]),\n});\n',
    )).toBeNull();
    expect(extractOutcomeBasedOnMembers(gatesSource())).not.toBeNull();
  });

  it('OUTCOME_SECTIONS 제목이 설계 11 의 펜스 예시와 순서까지 같다', () => {
    const headings = extractDocHeadings(ledgerDoc());
    expect(headings, '설계 11 에서 outcome.md 절 제목을 추출하지 못했다').not.toBeNull();
    expect(OUTCOME_SECTIONS.map((s) => s.heading)).toEqual(headings);
  });

  it('제목 추출기 자기검증 — 다른 문서·다른 절에서는 null 이다 (음성 대조군)', () => {
    expect(extractDocHeadings('## plan.md\n\n```markdown\n## Work decomposition\n```\n\n## x\n')).toBeNull();
    expect(extractDocHeadings('## outcome.md\n\n본문뿐\n\n## ledger.jsonl\n')).toBeNull();
    expect(extractDocHeadings(ledgerDoc())).not.toBeNull();
  });

  it('OUTCOME_SECTIONS 가 일곱 절을 고정 순서로 담고, 필수는 그중 다섯이다 (설계 :180)', () => {
    expect(OUTCOME_SECTIONS.map((s) => s.key)).toEqual([
      'mission', 'accepted_result', 'changes', 'verification', 'review', 'blindspots', 'followups',
    ]);
    expect(OUTCOME_SECTIONS.map((s) => s.heading)).toEqual([
      'Mission', 'Accepted Result', 'Changes', 'Verification', 'Review',
      'Remaining Blindspots', 'Follow-ups',
    ]);
    expect([...OUTCOME_REQUIRED_SECTION_KEYS]).toEqual([
      'mission', 'accepted_result', 'changes', 'verification', 'review',
    ]);
    expect(OUTCOME_SECTIONS.map((s) => s.key).filter(
      (k) => !OUTCOME_REQUIRED_SECTION_KEYS.includes(k),
    )).toEqual(['blindspots', 'followups']);
  });

  it('상수가 얼어 있어 호출자가 어휘를 늘릴 수 없다', () => {
    expect(Object.isFrozen(OUTCOME_BASED_ON_MEMBERS)).toBe(true);
    expect(Object.isFrozen(OUTCOME_SECTIONS)).toBe(true);
    expect(Object.isFrozen(OUTCOME_REQUIRED_SECTION_KEYS)).toBe(true);
    expect(Object.isFrozen(OutcomeFindingCode)).toBe(true);
    expect(OUTCOME_ARTIFACT_BASENAME).toBe('outcome.md');
    expect(OUTCOME_SCHEMA_VERSION).toBe(1);
  });
});

// ── (3) The path is the one path ───────────────────────────────────────────

describe('outcome 경로 — 파생 파일명과 미션 밖 경로를 거부한다', () => {
  const ALLOWED = `.artibot/missions/${MISSION}/outcome.md`;

  it('허용 경로를 인식하고 mission id 를 되돌려준다', () => {
    for (const p of [ALLOWED, `/repo/${ALLOWED}`, `C:/repo/${ALLOWED}`, ALLOWED.replace(/\//g, '\\')]) {
      expect(isAllowedOutcomeFilePath(p), p).toBe(true);
    }
    expect(missionIdFromOutcomePath(`/repo/${ALLOWED}`)).toBe(MISSION);
    expect(() => assertOutcomeFilePath(ALLOWED)).not.toThrow();
  });

  it('파생 파일명 넷과 미션 디렉터리 밖의 outcome.md 를 전부 거부한다', () => {
    for (const name of ['outcome-v2.md', 'outcome-final.md', 'outcome-new.md', 'outcome-old.md']) {
      const p = `.artibot/missions/${MISSION}/${name}`;
      expect(isAllowedOutcomeFilePath(p), name).toBe(false);
      expect(missionIdFromOutcomePath(p), name).toBeNull();
      expect(() => assertOutcomeFilePath(p), name).toThrow(/파생/);
    }
    for (const p of [
      'outcome.md',
      '.artibot/outcome.md',
      `.artibot/missions/${MISSION}/sub/outcome.md`,
      '.artibot/missions/not-a-mission/outcome.md',
      `.artibot/runs/${MISSION}/outcome.md`,
      '',
      null,
      42,
    ]) {
      expect(isAllowedOutcomeFilePath(p), String(p)).toBe(false);
      expect(() => assertOutcomeFilePath(p), String(p)).toThrow();
    }
  });

  it('outcomeArtifactPath 가 미션 디렉터리 아래 한 파일을 만든다', () => {
    const built = outcomeArtifactPath('/repo', MISSION);

    expect(isAllowedOutcomeFilePath(built)).toBe(true);
    expect(missionIdFromOutcomePath(built)).toBe(MISSION);
    expect(built.replace(/\\/g, '/')).toBe(`/repo/.artibot/missions/${MISSION}/outcome.md`);
    expect(() => outcomeArtifactPath('', MISSION)).toThrow(TypeError);
    expect(() => outcomeArtifactPath('/repo', 'mission-1')).toThrow(TypeError);
  });
});

// ── (4) serialize refuses ──────────────────────────────────────────────────

describe('serializeOutcomeMd 거부 — 잘못된 입력은 TypeError 로 끝난다', () => {
  it('mission id 패턴 밖·비객체 입력·비 ISO ts 를 던진다', () => {
    expect(() => serializeOutcomeMd(minimalInput({ missionId: 'mission-1' }))).toThrow(/missionId/);
    for (const bad of [null, 'outcome', []]) {
      expect(() => serializeOutcomeMd(bad), String(bad)).toThrow(TypeError);
    }
    for (const ts of ['2026-09-15 01:23:45', '2026-09-15T01:23:45Z', 'not-a-date']) {
      expect(() => serializeOutcomeMd(minimalInput({ ts })), ts).toThrow(/ts/);
    }
  });

  it('basedOn 세 멤버를 각각 이름으로 요구한다', () => {
    const base = { intentRevision: 1, planRevision: 1, reviewRevision: 1 };
    for (const member of ['intentRevision', 'planRevision', 'reviewRevision']) {
      const damaged = { ...base };
      delete damaged[member];
      expect(() => serializeOutcomeMd(minimalInput({ basedOn: damaged })), member)
        .toThrow(new RegExp(member));
      expect(() => serializeOutcomeMd(minimalInput({ basedOn: { ...base, [member]: -1 } })), member)
        .toThrow(new RegExp(member));
      expect(() => serializeOutcomeMd(minimalInput({ basedOn: { ...base, [member]: 1.5 } })), member)
        .toThrow(new RegExp(member));
    }
    const input = minimalInput();
    delete input.basedOn;
    expect(() => serializeOutcomeMd(input)).toThrow(/basedOn/);
    expect(() => serializeOutcomeMd(minimalInput({ basedOn: [] }))).toThrow(/basedOn/);
  });

  it('accepted 는 세 값뿐이고 누락은 기본값이 되지 않는다', () => {
    const input = minimalInput();
    delete input.accepted;
    expect(() => serializeOutcomeMd(input)).toThrow(/accepted/);
    for (const bad of ['true', 'null', 0, 1, undefined]) {
      expect(() => serializeOutcomeMd(minimalInput({ accepted: bad })), String(bad)).toThrow(/accepted/);
    }
  });

  it('accepted 가 null 인데 supersedes 를 들고 오면 던진다', () => {
    expect(() => serializeOutcomeMd(minimalInput({ supersedes: 'x' }))).toThrow(/supersedes/);
    expect(() => serializeOutcomeMd(minimalInput({ accepted: true, supersedes: 'x' }))).not.toThrow();
    expect(() => serializeOutcomeMd(minimalInput({ accepted: true, supersedes: '' }))).toThrow(/supersedes/);
    expect(() => serializeOutcomeMd(minimalInput({ accepted: false, supersedes: 7 }))).toThrow(/supersedes/);
  });

  it('verificationId·evidenceRefs 의 누락·타입 밖 값을 던진다 — 빈 배열만 허용이다', () => {
    const noId = minimalInput();
    delete noId.verificationId;
    expect(() => serializeOutcomeMd(noId)).toThrow(/verificationId/);
    expect(() => serializeOutcomeMd(minimalInput({ verificationId: '   ' }))).toThrow(/verificationId/);
    expect(() => serializeOutcomeMd(minimalInput({ verificationId: 7 }))).toThrow(/verificationId/);

    const input = minimalInput();
    delete input.evidenceRefs;
    expect(() => serializeOutcomeMd(input)).toThrow(/evidenceRefs/);
    expect(() => serializeOutcomeMd(minimalInput({ evidenceRefs: 'ledger:x' }))).toThrow(/evidenceRefs/);
    expect(() => serializeOutcomeMd(minimalInput({ evidenceRefs: ['ok', ''] }))).toThrow(/evidenceRefs/);
    expect(() => serializeOutcomeMd(minimalInput({ evidenceRefs: ['ok', 7] }))).toThrow(/evidenceRefs/);
    expect(() => serializeOutcomeMd(minimalInput({ evidenceRefs: [] }))).not.toThrow();
  });

  it('actor 누락·형태 밖 type·빈 id 를 던진다', () => {
    const input = minimalInput();
    delete input.actor;
    expect(() => serializeOutcomeMd(input)).toThrow(/actor/);
    expect(() => serializeOutcomeMd(minimalInput({ actor: { type: 'Hook', id: 'x' } }))).toThrow(/actor\.type/);
    expect(() => serializeOutcomeMd(minimalInput({ actor: { type: '1hook', id: 'x' } }))).toThrow(/actor\.type/);
    expect(() => serializeOutcomeMd(minimalInput({ actor: { type: 'hook', id: '' } }))).toThrow(/actor\.id/);
  });

  it('섹션 값의 타입이 계약 밖이면 그 섹션 이름으로 던진다', () => {
    expect(() => serializeOutcomeMd(minimalInput({ sections: { mission: 42 } }))).toThrow(/mission/);
    expect(() => serializeOutcomeMd(minimalInput({ sections: { changes: [] } }))).toThrow(/changes/);
    expect(() => serializeOutcomeMd(minimalInput({ sections: { changes: ['a', ''] } }))).toThrow(/changes/);
    expect(() => serializeOutcomeMd(minimalInput({ sections: { review: '' } }))).toThrow(/review/);
    expect(() => serializeOutcomeMd(minimalInput({ sections: 'text' }))).toThrow(/sections/);
  });

  it('미지 키·미지 섹션은 무시되고 출력에 새지 않는다', () => {
    const text = serializeOutcomeMd(minimalInput({
      secretNote: 'do not render',
      blockCode: 'UNMEASURED_VERIFICATION',
      sections: { unknownSection: 'do not render either' },
    }));

    expect(text).not.toMatch(/do not render/);
    expect(text).not.toMatch(/secretNote|block_code|unknownSection/);
    expect(text).toBe(serializeOutcomeMd(minimalInput()));
  });
});

// ── (5) Determinism, shape, body ───────────────────────────────────────────

describe('outcome.md 바이트 — 결정적이고 LF 다', () => {
  it('같은 입력을 두 번 직렬화하면 바이트가 같고, CR 없이 끝 개행이 하나다', () => {
    expect(serializeOutcomeMd(fullInput())).toBe(serializeOutcomeMd(fullInput()));
    expect(serializeOutcomeMd(minimalInput())).toBe(serializeOutcomeMd(minimalInput()));
    for (const text of [serializeOutcomeMd(fullInput()), serializeOutcomeMd(minimalInput())]) {
      expect(text).not.toMatch(/\r/);
      expect(text.endsWith('\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
    }
  });

  it('frontmatter 키 순서가 고정돼 있다 (supersedes 포함)', () => {
    expect(frontmatterKeys(serializeOutcomeMd(fullInput()))).toEqual([
      'schema_version',
      'mission_id',
      'based_on',
      'intent_revision',
      'plan_revision',
      'review_revision',
      'verification_id',
      'evidence_refs',
      'accepted',
      'supersedes',
      'actor',
      'type',
      'id',
      'created_at',
      'updated_at',
    ]);
  });

  it('supersedes 가 없으면 그 키 자체가 없다 — 빈 값으로 렌더되지 않는다', () => {
    const text = serializeOutcomeMd(minimalInput());

    expect(frontmatterKeys(text)).not.toContain('supersedes');
    expect(text.split('\n---')[0]).not.toMatch(/supersedes/);
  });

  it('문자열 값은 큰따옴표로 인용되고 정수·불리언은 그대로다', () => {
    const text = serializeOutcomeMd(fullInput());

    expect(text).toContain('schema_version: 1');
    expect(text).toContain(`mission_id: "${MISSION}"`);
    expect(text).toContain('  intent_revision: 2');
    expect(text).toContain('  plan_revision: 4');
    expect(text).toContain('  review_revision: 1');
    expect(text).toContain(`verification_id: "${VERIFICATION_ID}"`);
    expect(text).toContain('accepted: true');
    expect(text).toContain('  type: "hook"');
    expect(text).toContain(`created_at: "${TS}"`);
    expect(text).toContain(`updated_at: "${TS}"`);
  });

  it('evidence_refs 는 인용된 블록 시퀀스, 빈 목록은 [] 다', () => {
    const text = serializeOutcomeMd(fullInput());

    expect(text).toContain('evidence_refs:\n  - "ledger:mission:M-20260915-001:completed:null"');
    expect(text).toContain('  - "transcript:sess-1"');
    expect(text).toContain('  - "note: 두 단어 사이 공백"');
    expect(serializeOutcomeMd(minimalInput())).toContain('evidence_refs: []');
  });

  it('본문이 제목과 일곱 절 제목을 순서대로 담고, 배열은 불릿으로 렌더된다', () => {
    const text = serializeOutcomeMd(fullInput());

    expect(text).toContain('# Outcome');
    expect(bodyHeadings(text)).toEqual(OUTCOME_SECTIONS.map((s) => s.heading));
    expect(bodyHeadings(serializeOutcomeMd(minimalInput()))).toEqual(OUTCOME_SECTIONS.map((s) => s.heading));
    expect(text).toContain('- 직렬화기 착지\n- 파서 착지');
    expect(text).toContain('\noutcome.md 직렬화기를 만든다\n');
  });

  it('빠진 절은 자리표시자 한 줄이 된다 — 빈 절은 없다', () => {
    const text = serializeOutcomeMd(minimalInput());
    const placeholders = text.split('\n').filter((l) => l === OUTCOME_NOT_RECORDED);

    expect(OUTCOME_NOT_RECORDED).toBe('_(not yet recorded)_');
    expect(placeholders).toHaveLength(OUTCOME_SECTIONS.length);
    expect(text).not.toMatch(/\n\n\n/);
  });

  it('손으로 고치지 말라는 주석으로 끝나고, 두 시각이 둘 다 ts 다', () => {
    const text = serializeOutcomeMd(fullInput());

    expect(text).toMatch(/<!--[\s\S]*손으로 고치지 말 것[\s\S]*-->\n$/);
    expect(text).toMatch(/<!--[\s\S]*mission\.completed[\s\S]*-->/);
    expect(text).toMatch(/<!--[\s\S]*파생 파일 금지[\s\S]*-->/);
    expect(text.match(new RegExp(TS, 'g'))).toHaveLength(2);
    expect(parseOutcomeMd(text).outcome.ts).toBe(TS);
  });
});

// ── (6) parse refuses ──────────────────────────────────────────────────────

describe('parseOutcomeMd 거부 — 읽을 수 없는 문서는 outcome:null 이다', () => {
  it('frontmatter 가 없거나 안 닫히거나 문자열이 아니면 FRONTMATTER_MISSING 이다', () => {
    const noFm = parseOutcomeMd('# Outcome\n\n## Mission\n\n- a\n');
    expect(noFm.ok).toBe(false);
    expect(noFm.outcome).toBeNull();
    expect(codesOf(noFm)).toEqual(['FRONTMATTER_MISSING']);

    expect(codesOf(parseOutcomeMd(`---\nmission_id: "${MISSION}"\n`))).toEqual(['FRONTMATTER_MISSING']);
    for (const bad of [null, undefined, 42, {}]) {
      const result = parseOutcomeMd(bad);
      expect(result.ok, String(bad)).toBe(false);
      expect(result.outcome).toBeNull();
      expect(codesOf(result)).toEqual(['FRONTMATTER_MISSING']);
    }
  });

  it('필수 키를 하나씩 지우면 그 키 이름으로 MISSING_KEY 가 난다', () => {
    const required = [
      'schema_version', 'mission_id', 'intent_revision', 'plan_revision', 'review_revision',
      'verification_id', 'evidence_refs', 'accepted', 'created_at', 'updated_at',
    ];
    const text = serializeOutcomeMd(fullInput());

    for (const key of required) {
      const damaged = text.split('\n').filter((l) => !l.trim().startsWith(`${key}:`)).join('\n');
      const result = parseOutcomeMd(damaged);

      expect(result.ok, `${key} 삭제`).toBe(false);
      expect(result.outcome).toBeNull();
      expect(codesOf(result), `${key} 삭제`).toContain('MISSING_KEY');
      expect(result.errors.some((e) => e.message.includes(key)), `${key} 이름이 메시지에`).toBe(true);
    }
  });

  it('accepted 어휘 밖과 null+supersedes 조합이 INVALID_VALUE 다 — "null" 은 null 이 아니다', () => {
    const base = serializeOutcomeMd(fullInput());
    for (const bad of ['"null"', '"true"', '1', '"yes"']) {
      const result = parseOutcomeMd(base.replace('accepted: true', `accepted: ${bad}`));
      expect(result.ok, bad).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('accepted')), bad).toBe(true);
    }

    const deferred = parseOutcomeMd(
      serializeOutcomeMd(minimalInput()).replace('accepted: null', 'accepted: null\nsupersedes: "x"'),
    );
    expect(deferred.ok).toBe(false);
    expect(deferred.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('supersedes'))).toBe(true);
  });

  it('틀린 schema_version·패턴 밖 mission_id·비 ISO ts 가 각각 INVALID_VALUE 다', () => {
    const base = serializeOutcomeMd(fullInput());

    const badSchema = parseOutcomeMd(base.replace('schema_version: 1', 'schema_version: 2'));
    expect(badSchema.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('schema_version'))).toBe(true);

    const badMission = parseOutcomeMd(base.replace(`"${MISSION}"`, '"mission-1"'));
    expect(badMission.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('mission_id'))).toBe(true);

    const badTs = parseOutcomeMd(base.replace(new RegExp(TS, 'g'), '어제'));
    expect(badTs.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('updated_at'))).toBe(true);
  });

  it('based_on 블록이 통째로 없으면 세 멤버 누락으로 잡힌다', () => {
    const text = serializeOutcomeMd(fullInput())
      .split('\n')
      .filter((l) => !/^\s*(based_on:|intent_revision:|plan_revision:|review_revision:)/.test(l))
      .join('\n');
    const result = parseOutcomeMd(text);

    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.code === 'MISSING_KEY' && e.message.includes('based_on.'))).toHaveLength(3);
  });

  it('비문자열 evidence_refs 항목은 INVALID_VALUE, 그 밖의 시퀀스는 이름으로 거부한다', () => {
    const item = parseOutcomeMd(serializeOutcomeMd(fullInput()).replace('  - "transcript:sess-1"', '  - 7'));
    expect(item.ok).toBe(false);
    expect(item.errors.some((e) => e.code === 'INVALID_VALUE' && e.message.includes('evidence_refs'))).toBe(true);

    const stray = parseOutcomeMd(
      serializeOutcomeMd(fullInput()).replace('accepted: true', 'tags:\n  - a\naccepted: true'),
    );
    expect(stray.ok).toBe(false);
    expect(codesOf(stray)).toContain('FRONTMATTER_UNSUPPORTED');
    expect(stray.errors.some((e) => e.message.includes('시퀀스'))).toBe(true);
  });

  it('블록 스칼라·앵커·flow·2단계 중첩을 이름으로 거부한다', () => {
    const base = serializeOutcomeMd(fullInput());
    const cases = [
      ['블록 스칼라', base.replace('accepted: true', 'note: |\n  두 줄\n  짜리\naccepted: true')],
      ['앵커', base.replace('accepted: true', 'anchor: &a 1\naccepted: true')],
      ['flow', base.replace('accepted: true', 'flow: [a, b]\naccepted: true')],
      ['2단계 중첩', base.replace('  plan_revision: 4', '  plan_revision: 4\n  deep:\n    deeper: 1')],
    ];

    for (const [label, text] of cases) {
      const result = parseOutcomeMd(text);
      expect(result.ok, label).toBe(false);
      expect(codesOf(result), label).toContain('FRONTMATTER_UNSUPPORTED');
    }
  });

  it('__proto__ 아래에 심은 값과 중복 키를 값으로 읽지 않는다', () => {
    const smuggled = serializeOutcomeMd(fullInput())
      .split('\n')
      .filter((l) => !l.startsWith('verification_id:'))
      .join('\n')
      .replace('based_on:', '__proto__:\n  verification_id: "x"\nbased_on:');
    const smuggledResult = parseOutcomeMd(smuggled);

    expect(smuggledResult.ok).toBe(false);
    expect(smuggledResult.errors.some(
      (e) => e.code === 'MISSING_KEY' && e.message.includes('verification_id'),
    )).toBe(true);

    const duplicate = parseOutcomeMd(
      serializeOutcomeMd(fullInput()).replace('created_at:', 'accepted: false\ncreated_at:'),
    );
    expect(duplicate.ok).toBe(false);
    expect(codesOf(duplicate)).toContain('FRONTMATTER_UNSUPPORTED');
  });

  it('미지 frontmatter 키는 무시되고, 정상 문서는 어느 판정에도 걸리지 않는다', () => {
    const result = parseOutcomeMd(
      serializeOutcomeMd(fullInput()).replace('accepted: true', 'future_key: "x"\naccepted: true'),
    );

    expect(result.ok).toBe(true);
    expect(result.outcome).not.toHaveProperty('futureKey');
    expect(parseOutcomeMd(serializeOutcomeMd(minimalInput())).ok).toBe(true);
  });
});

// ── (7) Required sections are findings, not errors ─────────────────────────

describe('필수 절 판정 — 자리표시자는 finding 이고 frontmatter 는 여전히 읽힌다', () => {
  it('일곱 절이 전부 채워진 문서는 finding 이 없다', () => {
    const result = parseOutcomeMd(serializeOutcomeMd(fullInput()));
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('절을 하나도 안 준 문서는 필수 다섯 절만 finding 을 낸다', () => {
    const result = parseOutcomeMd(serializeOutcomeMd(minimalInput()));

    expect(findingCodesOf(result)).toEqual(Array(5).fill(OutcomeFindingCode.REQUIRED_SECTION_EMPTY));
    expect(result.findings.map((f) => f.section)).toEqual([...OUTCOME_REQUIRED_SECTION_KEYS]);
    expect(result.ok, 'frontmatter 는 읽히므로 ok 는 참이다').toBe(true);
    expect(result.outcome).not.toBeNull();
  });

  it('선택 두 절이 비어 있어도 finding 이 아니다 (설계 :180)', () => {
    const sections = { ...fullInput().sections };
    delete sections.blindspots;
    delete sections.followups;
    expect(parseOutcomeMd(serializeOutcomeMd(fullInput({ sections }))).findings).toEqual([]);
  });

  it('필수 절 하나만 비면 그 절 하나만 finding 이다', () => {
    for (const key of OUTCOME_REQUIRED_SECTION_KEYS) {
      const sections = { ...fullInput().sections };
      delete sections[key];
      const result = parseOutcomeMd(serializeOutcomeMd(fullInput({ sections })));

      expect(result.findings, key).toHaveLength(1);
      expect(result.findings[0].section, key).toBe(key);
      expect(result.findings[0].code, key).toBe(OutcomeFindingCode.REQUIRED_SECTION_EMPTY);
      expect(result.findings[0].message.includes(key)
        || result.findings[0].message.includes(
          OUTCOME_SECTIONS.find((s) => s.key === key).heading,
        ), key).toBe(true);
    }
  });

  it('절 제목이 통째로 없는 문서도 그 절을 finding 으로 센다', () => {
    const result = parseOutcomeMd(`${serializeOutcomeMd(fullInput()).split('\n## Review\n')[0]}\n`);

    expect(findingCodesOf(result)).toContain(OutcomeFindingCode.REQUIRED_SECTION_EMPTY);
    expect(result.findings.map((f) => f.section)).toContain('review');
    expect(result.findings.map((f) => f.section)).not.toContain('mission');
  });

  it('본문이 통째로 없으면 frontmatter 는 ok, 필수 다섯 절은 finding 이다', () => {
    const text = serializeOutcomeMd(fullInput());
    const result = parseOutcomeMd(`${text.split('\n---')[0]}\n---\n`);

    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(5);
  });

  it('frontmatter 가 깨진 문서도 본문 finding 을 함께 보고한다', () => {
    const result = parseOutcomeMd(serializeOutcomeMd(minimalInput()).replace('schema_version: 1', 'schema_version: 9'));

    expect(result.ok).toBe(false);
    expect(result.outcome).toBeNull();
    expect(result.findings).toHaveLength(5);
  });

  it('공백만 채운 필수 절은 채운 것으로 보지 않는다', () => {
    const text = serializeOutcomeMd(fullInput()).replace('\nPASS\n', '\n   \n');
    expect(parseOutcomeMd(text).findings.map((f) => f.section)).toEqual(['review']);
  });
});
