/**
 * `outcome.md` — the outcome artifact SERIALIZER and PARSER.
 *
 * Why this exists: `lib/runtime/artifact-lifecycle.js#apply` writes artifact
 * content to `.artibot/missions/<M>/<kind>.md` verbatim — it renders nothing.
 * Without a serializer the artifact's shape is whatever the nearest call site
 * happened to build, which makes `based_on` (the input of the staleness gate) a
 * per-call-site convention rather than a contract. This module is that
 * contract, and it is the only place the shape is decided.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * PURE. No `fs`, no `process`, no clock. The timestamp arrives as `ts` so the
 * bytes are a function of the input alone; {@link assertOutcomeFilePath} is the
 * hook a write site calls before touching the disk. `lib/runtime` is L5 and
 * this file is L2, so the runtime imports this — never the other way round.
 *
 * ── It renders; it does not judge ──────────────────────────────────────────
 * Design `ARTIBOT-5.0-DESIGN.md:180` makes this file's EXISTENCE the definition
 * of completion: it is refused while `## Verification` carries UNMEASURED,
 * while `## Review` is not PASS, and while an asked human question is
 * unresolved. NONE of that is decided here — the refusal lives in
 * `lib/runtime/artifact-lifecycle-gates.js#outcomeBlockCode` and the hook that
 * calls it. The one body fact reported here is
 * {@link OutcomeFindingCode}.REQUIRED_SECTION_EMPTY, a FINDING rather than a
 * parse error so a gate can act on it while a reader still gets the bytes.
 *
 * ── What this module cannot see ────────────────────────────────────────────
 *  1. COMPLETION IS A DERIVED VERDICT, NOT A HUMAN DECLARATION. Nobody says
 *     "done" here; a writer derives the claim and this file records it.
 *  2. THE INPUTS ARE LEDGER ROWS ONLY — no self-report channel, and no value
 *     here is cross-checked against the rows it claims to summarise.
 *  3. `{accepted: null}` IS A TRIGGER, NOT COMPLETION.
 *     `lib/runtime/ledger.js#currentMission` (:477-493) counts a null `accepted`
 *     as still OPEN — the file records DEFERRAL (design `:222`, window D3).
 *  4. `verification_id` IS NOT UNIQUE — a constant verdict hash plus a
 *     second-resolution stamp (`lib/verification/verify-rate.js:26-38`), so two
 *     sessions firing in the same second collide and every check here passes.
 *  5. MISSIONS OF A STILL-ACTIVE SESSION ARE OUTSIDE THE DENOMINATOR — an
 *     unfinished mission has no outcome yet and is not a missing one.
 *
 * ── Deliberate non-reuse ───────────────────────────────────────────────────
 * `lib/review/review-artifact.js` and `lib/planning/plan-artifact.js` each
 * carry a one-level YAML reader of nearly this shape and neither exports it.
 * The ruling in `lib/review/review-artifact.js:18-25` applies here unchanged:
 * this file carries its own reader, sized to an outcome frontmatter (one level,
 * one nested `based_on` mapping, one string sequence). The cost is a third
 * parser; the benefit is that no artifact's format can drift through a shared
 * helper — the failure a shared serializer invites and no test would catch.
 *
 * THE FRONTMATTER IS THE CANON: the body is a human-readable projection of the
 * seven questions an outcome answers (`11_REVIEW_OUTCOME_LEDGER.md:26-49`) and
 * its prose is never validated. A RE-JUDGEMENT IS NOT A NEW FILE: it rewrites
 * this one file, never forking `outcome-v2.md` (`artifact-governance` #1).
 *
 * @module lib/mission/outcome-artifact
 */

import path from 'node:path';

import { isMissionId } from './mission-id.js';

/** The one legal basename. A re-judged outcome edits this file; it never forks. */
export const OUTCOME_ARTIFACT_BASENAME = 'outcome.md';

/** Frontmatter `schema_version`. Bump only with a reader that accepts both. */
export const OUTCOME_SCHEMA_VERSION = 1;

/**
 * `based_on` members, in render order. Mirrors
 * `lib/runtime/artifact-lifecycle-gates.js#BASED_ON_MEMBERS_BY_KIND` for
 * `ArtifactKind.OUTCOME` (`:156-164`, Hardening §5), embedded because that
 * module is L5 and this one is L2. The copy is CHECKED — the test extracts the
 * OUTCOME entry from the gates SOURCE TEXT with an anchored regex (plus a
 * negative control), so drift here is red.
 */
export const OUTCOME_BASED_ON_MEMBERS = Object.freeze([
  'intent_revision', 'plan_revision', 'review_revision',
]);

/**
 * The body's sections, in render order — `11_REVIEW_OUTCOME_LEDGER.md:26-49`
 * verbatim, compared by the test against that document's own fenced example
 * rather than against a copy. Fixed rather than free-form so that an outcome
 * missing its verification is visibly missing it (the section renders
 * {@link OUTCOME_NOT_RECORDED}).
 */
export const OUTCOME_SECTIONS = Object.freeze([
  Object.freeze({ key: 'mission', heading: 'Mission' }),
  Object.freeze({ key: 'accepted_result', heading: 'Accepted Result' }),
  Object.freeze({ key: 'changes', heading: 'Changes' }),
  Object.freeze({ key: 'verification', heading: 'Verification' }),
  Object.freeze({ key: 'review', heading: 'Review' }),
  Object.freeze({ key: 'blindspots', heading: 'Remaining Blindspots' }),
  Object.freeze({ key: 'followups', heading: 'Follow-ups' }),
]);

/**
 * The sections that may NOT be empty. `ARTIBOT-5.0-DESIGN.md:180` allows
 * exactly two empty ones — Remaining Blindspots and Follow-ups — because
 * "nothing left unseen" is a real answer and an empty Verification is not.
 */
export const OUTCOME_REQUIRED_SECTION_KEYS = Object.freeze([
  'mission', 'accepted_result', 'changes', 'verification', 'review',
]);

/**
 * Rendered in place of a section the caller supplied nothing for. Exported
 * because it is the byte string {@link parseOutcomeMd} reads as "not recorded".
 */
export const OUTCOME_NOT_RECORDED = '_(not yet recorded)_';

/** Body findings. Non-fatal — the frontmatter is still returned. */
export const OutcomeFindingCode = Object.freeze({
  REQUIRED_SECTION_EMPTY: 'REQUIRED_SECTION_EMPTY',
});

/** Names an outcome artifact must never be forked into. Quoted in the throw. */
const KNOWN_DERIVED_OUTCOME_NAMES = Object.freeze([
  'outcome-v2.md', 'outcome-final.md', 'outcome-new.md', 'outcome-old.md',
]);

/**
 * The only frontmatter key that may carry a sequence: a reader that accepted
 * sequences generally would have to decide what a nested one means.
 */
const SEQUENCE_KEYS = Object.freeze(['evidence_refs']);

/**
 * Shape `actor.type` must match — `#LAYER_NAME_PATTERN`'s rule, for its reason:
 * a closed list would make a new caller's honest label an invalid document; a
 * free string would let event payload reach the artifact unshaped.
 */
const ACTOR_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Parse error codes. Callers switch on these, not on the message text. */
const ErrorCode = Object.freeze({
  FRONTMATTER_MISSING: 'FRONTMATTER_MISSING',
  FRONTMATTER_UNSUPPORTED: 'FRONTMATTER_UNSUPPORTED',
  MISSING_KEY: 'MISSING_KEY',
  INVALID_VALUE: 'INVALID_VALUE',
});

// ── Predicates ─────────────────────────────────────────────────────────────

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isRevision = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isActorType = (v) => typeof v === 'string' && ACTOR_TYPE_PATTERN.test(v);
const isRefList = (v) => Array.isArray(v) && v.every(isNonEmptyString);

/** Three-valued, and `null` is a VALUE here — not "absent". */
const isAccepted = (v) => v === true || v === false || v === null;

/**
 * True only for a timestamp that survives `Date#toISOString` unchanged: a `Z`
 * spelling re-serialises with milliseconds, so accepting it would let two
 * spellings of one instant produce two different files.
 */
function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value === '') return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString() === value;
}

// ── Path ───────────────────────────────────────────────────────────────────

/** Split a `/`- or `\`-separated path into non-empty segments. */
const segmentsOf = (p) => p.replace(/\\/g, '/').split('/').filter((s) => s !== '');

/**
 * The `<mission id>` segment of an allowed outcome path, or `null`. One function
 * answers both "is this the path" and "whose outcome is it": a caller must not
 * derive a mission from a path the predicate would have refused.
 */
function missionSegmentOf(p) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  const segments = segmentsOf(p);
  if (segments.length < 4) return null;
  const [dot, missions, missionId, basename] = segments.slice(-4);
  const allowed = dot === '.artibot'
    && missions === 'missions'
    && isMissionId(missionId)
    && basename === OUTCOME_ARTIFACT_BASENAME;
  return allowed ? missionId : null;
}

/**
 * True when `p` ends in `.artibot/missions/<mission id>/outcome.md`. The
 * mission directory is part of the contract: an `outcome.md` outside a mission
 * has no mission to be the outcome of.
 *
 * @param {unknown} p Path or path fragment, `/` or `\` separated.
 * @returns {boolean}
 */
export function isAllowedOutcomeFilePath(p) {
  return missionSegmentOf(p) !== null;
}

/**
 * The mission id an outcome path belongs to, or `null` when it is not the one
 * allowed outcome path.
 *
 * @param {unknown} p
 * @returns {string|null}
 */
export function missionIdFromOutcomePath(p) {
  return missionSegmentOf(p);
}

/**
 * Throw unless `p` is the one allowed outcome artifact path.
 *
 * @param {unknown} p
 * @returns {void}
 * @throws {Error} When the path is anything else.
 */
export function assertOutcomeFilePath(p) {
  if (isAllowedOutcomeFilePath(p)) return;
  throw new Error(
    `파생 outcome 파일 금지: '${String(p)}' — 한 Mission 에는 `
    + `'.artibot/missions/<mission id>/${OUTCOME_ARTIFACT_BASENAME}' 하나만 존재한다. `
    + '판정 지연 뒤의 재판정은 새 파일이 아니라 같은 파일의 갱신이다. '
    + `(알려진 위반 예: ${KNOWN_DERIVED_OUTCOME_NAMES.join(' · ')})`,
  );
}

/**
 * Build the outcome artifact path for a mission.
 *
 * @param {string} projectRoot Absolute or relative project root.
 * @param {string} missionId
 * @returns {string} Platform-separated path.
 * @throws {TypeError} When either argument is unusable.
 */
export function outcomeArtifactPath(projectRoot, missionId) {
  if (!isNonEmptyString(projectRoot)) {
    throw new TypeError(`outcomeArtifactPath: projectRoot must be a non-empty string (got ${typeof projectRoot})`);
  }
  if (!isMissionId(missionId)) {
    throw new TypeError(`outcomeArtifactPath: missionId must match the mission id pattern (got ${JSON.stringify(missionId)})`);
  }
  return path.join(projectRoot, '.artibot', 'missions', missionId, OUTCOME_ARTIFACT_BASENAME);
}

// ── Serialize ──────────────────────────────────────────────────────────────

function refuse(message) {
  throw new TypeError(`serializeOutcomeMd: ${message}`);
}

/**
 * Validate `basedOn`. All three members are REQUIRED: an undeclared upstream
 * revision cannot be checked for staleness at all — worse than being stale.
 */
function normalizeBasedOn(input) {
  if (!isPlainObject(input.basedOn)) {
    refuse(
      'basedOn must be a plain object with intentRevision + planRevision + reviewRevision '
      + `(got ${JSON.stringify(input.basedOn)})`,
    );
  }
  const out = {};
  for (const member of ['intentRevision', 'planRevision', 'reviewRevision']) {
    const value = input.basedOn[member];
    if (!isRevision(value)) {
      refuse(`basedOn.${member} must be an integer >= 0 (got ${JSON.stringify(value)})`);
    }
    out[member] = value;
  }
  return out;
}

/**
 * Validate `accepted` and `supersedes` together. `accepted` has no default, and
 * `supersedes` is refused alongside `accepted: null`: a deferred line closes
 * nothing, so naming a superseded line would record a closure that did not
 * happen (design `:222` — the null line comes FIRST).
 */
function normalizeVerdict(input) {
  if (!Object.hasOwn(input, 'accepted') || !isAccepted(input.accepted)) {
    refuse(`accepted must be true, false or null — no default (got ${JSON.stringify(input.accepted)})`);
  }
  const { supersedes } = input;
  if (supersedes === undefined) return { accepted: input.accepted, supersedes: undefined };
  if (!isNonEmptyString(supersedes)) {
    refuse(`supersedes must be a non-empty string when present (got ${JSON.stringify(supersedes)})`);
  }
  if (input.accepted === null) {
    refuse('supersedes must be absent when accepted is null — 유보 줄은 아무것도 대체하지 않는다');
  }
  return { accepted: input.accepted, supersedes };
}

/**
 * Validate `actor`. Both members required: an outcome whose writer is
 * unrecorded cannot be audited against the ledger line that claims it.
 */
function normalizeActor(input) {
  if (!isPlainObject(input.actor)) {
    refuse(`actor must be a plain object with type + id (got ${JSON.stringify(input.actor)})`);
  }
  const { type, id } = input.actor;
  if (!isActorType(type)) refuse(`actor.type must match ${ACTOR_TYPE_PATTERN} (got ${JSON.stringify(type)})`);
  if (!isNonEmptyString(id)) refuse(`actor.id must be a non-empty string (got ${JSON.stringify(id)})`);
  return { type, id };
}

/**
 * Validate the optional `sections` bag into `key -> string[]` render lines. An
 * EMPTY array is refused rather than treated as absent: collapsing "had a list
 * and it was empty" into "recorded nothing" would render the wrong one.
 */
function normalizeSections(input) {
  const { sections } = input;
  if (sections !== undefined && !isPlainObject(sections)) {
    refuse(`sections must be a plain object when present (got ${JSON.stringify(sections)})`);
  }

  const out = {};
  for (const { key } of OUTCOME_SECTIONS) {
    const value = sections === undefined ? undefined : sections[key];
    if (value === undefined) continue;
    if (isNonEmptyString(value)) {
      out[key] = [value];
      continue;
    }
    const usable = Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
    if (!usable) {
      refuse(
        `sections.${key} must be a non-empty string or a non-empty array of non-empty strings `
        + `(got ${JSON.stringify(value)})`,
      );
    }
    out[key] = value.map((entry) => `- ${entry}`);
  }
  return out;
}

/**
 * Validate and normalise a serializer input. Unknown keys are dropped: a
 * passthrough would smuggle a field the reader refuses into a written file.
 */
function normalizeInput(input) {
  if (!isPlainObject(input)) {
    refuse(`input must be a plain object (got ${input === null ? 'null' : typeof input})`);
  }
  if (!isMissionId(input.missionId)) {
    refuse(`missionId must match the mission id pattern (got ${JSON.stringify(input.missionId)})`);
  }
  if (!isIsoTimestamp(input.ts)) {
    refuse(`ts must be an ISO timestamp that round-trips through Date#toISOString (got ${JSON.stringify(input.ts)})`);
  }
  if (!isNonEmptyString(input.verificationId)) {
    refuse(`verificationId must be a non-empty string (got ${JSON.stringify(input.verificationId)})`);
  }
  if (!isRefList(input.evidenceRefs)) {
    refuse(
      'evidenceRefs must be an array of non-empty strings — [] when there are none, never absent '
      + `(got ${JSON.stringify(input.evidenceRefs)})`,
    );
  }

  const verdict = normalizeVerdict(input);
  return {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    missionId: input.missionId,
    basedOn: normalizeBasedOn(input),
    verificationId: input.verificationId,
    evidenceRefs: [...input.evidenceRefs],
    accepted: verdict.accepted,
    supersedes: verdict.supersedes,
    actor: normalizeActor(input),
    ts: input.ts,
    sections: normalizeSections(input),
  };
}

/**
 * Quote a string value. Always quoted: an evidence ref carries a colon and a
 * space. `JSON.stringify` pairs with the reader's `JSON.parse` — no third
 * spelling.
 */
function quote(value) {
  return JSON.stringify(value);
}

/**
 * The `evidence_refs` block. An empty list renders inline as `[]` — the one flow
 * collection admitted — because a bare `evidence_refs:` with nothing under it
 * is indistinguishable from an interrupted write.
 */
function evidenceLinesOf(refs) {
  if (refs.length === 0) return ['evidence_refs: []'];
  return ['evidence_refs:', ...refs.map((ref) => `  - ${quote(ref)}`)];
}

/** The frontmatter block, in fixed key order. */
function frontmatterLinesOf(outcome) {
  return [
    '---',
    `schema_version: ${outcome.schemaVersion}`,
    `mission_id: ${quote(outcome.missionId)}`,
    'based_on:',
    `  intent_revision: ${outcome.basedOn.intentRevision}`,
    `  plan_revision: ${outcome.basedOn.planRevision}`,
    `  review_revision: ${outcome.basedOn.reviewRevision}`,
    `verification_id: ${quote(outcome.verificationId)}`,
    ...evidenceLinesOf(outcome.evidenceRefs),
    `accepted: ${String(outcome.accepted)}`,
    ...(outcome.supersedes === undefined ? [] : [`supersedes: ${quote(outcome.supersedes)}`]),
    'actor:',
    `  type: ${quote(outcome.actor.type)}`,
    `  id: ${quote(outcome.actor.id)}`,
    `created_at: ${quote(outcome.ts)}`,
    `updated_at: ${quote(outcome.ts)}`,
    '---',
  ];
}

/** The body: title, the seven sections in order, then the do-not-edit note. */
function bodyLinesOf(outcome) {
  const lines = ['', '# Outcome'];
  for (const { key, heading } of OUTCOME_SECTIONS) {
    const content = outcome.sections[key] ?? [OUTCOME_NOT_RECORDED];
    lines.push('', `## ${heading}`, '', ...content);
  }
  lines.push(
    '',
    '<!-- 이 파일은 mission.completed 이벤트의 프로젝션이며 런타임이 쓴다. 손으로 고치지 말 것. '
    + '재판정은 새 파일이 아니라 같은 파일의 갱신이다 — 파생 파일 금지'
    + `(${KNOWN_DERIVED_OUTCOME_NAMES.join(' · ')}). -->`,
  );
  return lines;
}

/**
 * Render an outcome artifact. Key order is fixed and the string ends in exactly
 * one newline: the file is committed, so a same-input render must be
 * byte-stable or it shows up in a diff as a change nobody made.
 *
 * @param {object} input See {@link normalizeInput}.
 * @returns {string}
 * @throws {TypeError} Naming the offending field.
 */
export function serializeOutcomeMd(input) {
  const outcome = normalizeInput(input);
  return `${[...frontmatterLinesOf(outcome), ...bodyLinesOf(outcome)].join('\n')}\n`;
}

// ── Parse: frontmatter reader ──────────────────────────────────────────────

const makeError = (code, message) => ({ code, message });

/** Read one frontmatter scalar. Only a {@link SEQUENCE_KEYS} key may carry `[]`. */
function readScalar(raw, key = '') {
  if (raw === '[]' && SEQUENCE_KEYS.includes(key)) return { ok: true, value: [] };
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value !== 'string') return { ok: false, reason: 'quoted value is not a string' };
      return { ok: true, value };
    } catch {
      return { ok: false, reason: 'unterminated or badly escaped quoted scalar' };
    }
  }
  if (raw === 'null' || raw === '~') return { ok: true, value: null };
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  if (/^-?\d+$/.test(raw)) return { ok: true, value: Number(raw) };
  return { ok: true, value: raw };
}

const KEY_LINE = /^([A-Za-z0-9_]+):(?:[ \t]+(.*))?$/;

/**
 * A key/value bag with NO prototype: keys come from the file, and a plain `{}`
 * would let a document declare `__proto__:` and have its children answer
 * lookups for keys it never declared.
 */
function emptyMap() {
  return Object.create(null);
}

/**
 * Report a key declared twice. Last-wins is the wrong default for a document a
 * gate reads: the second line would silently replace a validated value.
 */
function isDuplicateKey(bag, key, trimmed, errors) {
  if (!Object.hasOwn(bag, key)) return false;
  errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `중복 키는 지원하지 않는다: ${trimmed}`));
  return true;
}

/** Slice out the frontmatter block, CRLF-normalised. `null` when there is none. */
function frontmatterLines(text) {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  return end === -1 ? null : lines.slice(1, end);
}

/**
 * Name the YAML feature a line uses that this reader does not implement, or
 * `null` when it is in the supported subset. Refusing by NAME is the point: a
 * reader that skipped a construct would report a file it did not understand as
 * one it agreed with.
 */
function unsupportedFeature(indent, raw, key) {
  if (indent !== 0 && indent !== 2) return `중첩은 한 단계까지다 (indent ${indent})`;
  if (raw.startsWith('|') || raw.startsWith('>')) return '블록 스칼라는 지원하지 않는다';
  if (raw.startsWith('&') || raw.startsWith('*')) return '앵커/별칭은 지원하지 않는다';
  if (raw.startsWith('[') || raw.startsWith('{')) {
    if (raw === '[]' && SEQUENCE_KEYS.includes(key)) return null;
    return 'flow 컬렉션은 지원하지 않는다';
  }
  return null;
}

/** Fold a `- item` line into the open sequence. Returns the next parent. */
function foldSequenceItem(trimmed, indent, map, parent, errors) {
  const holder = parent === null ? null : map[parent];
  if (indent !== 2 || !Array.isArray(holder)) {
    errors.push(makeError(
      ErrorCode.FRONTMATTER_UNSUPPORTED,
      `시퀀스는 ${SEQUENCE_KEYS.join(' · ')} 아래에서만 지원한다: ${trimmed}`,
    ));
    return parent;
  }
  const scalar = readScalar(trimmed.slice(1).trim());
  if (!scalar.ok) {
    errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `${parent}: ${scalar.reason}`));
    return parent;
  }
  holder.push(scalar.value);
  return parent;
}

/** Fold a `key: value` (or block-opening `key:`) line. Returns the next parent. */
function foldKeyLine(line, map, parent, errors) {
  const { key, raw, indent, trimmed } = line;
  if (raw === '') {
    if (indent !== 0) {
      errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `중첩은 한 단계까지다: ${trimmed}`));
      return parent;
    }
    if (isDuplicateKey(map, key, trimmed, errors)) return parent;
    map[key] = SEQUENCE_KEYS.includes(key) ? [] : emptyMap();
    return key;
  }

  const scalar = readScalar(raw, key);
  if (!scalar.ok) {
    errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `${key}: ${scalar.reason}`));
    return parent;
  }
  if (indent === 0) {
    if (!isDuplicateKey(map, key, trimmed, errors)) map[key] = scalar.value;
    return null;
  }
  if (parent !== null && isPlainObject(map[parent])) {
    if (!isDuplicateKey(map[parent], key, trimmed, errors)) map[parent][key] = scalar.value;
    return parent;
  }
  errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `부모 없는 들여쓰기: ${trimmed}`));
  return parent;
}

/** Fold one frontmatter line into `map`. Returns the parent for the next line. */
function foldFrontmatterLine(line, map, parent, errors) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return parent;

  const indent = line.length - line.trimStart().length;
  if (trimmed === '-' || trimmed.startsWith('- ')) {
    return foldSequenceItem(trimmed, indent, map, parent, errors);
  }

  const match = KEY_LINE.exec(trimmed);
  const key = match === null ? '' : match[1];
  const raw = match === null ? '' : (match[2] ?? '').trim();

  const unsupported = unsupportedFeature(indent, raw, key);
  if (unsupported !== null) {
    errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `${unsupported}: ${trimmed}`));
    return parent;
  }
  if (match === null) {
    errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `key: value 형태가 아니다: ${trimmed}`));
    return parent;
  }
  return foldKeyLine({ key, raw, indent, trimmed }, map, parent, errors);
}

/** Read the frontmatter into a one-level-deep bag. `null` when there is none. */
function readFrontmatter(text, errors) {
  const lines = frontmatterLines(text);
  if (lines === null) return null;

  const map = emptyMap();
  let parent = null;
  for (const line of lines) {
    parent = foldFrontmatterLine(line, map, parent, errors);
  }
  return map;
}

// ── Parse: validation ──────────────────────────────────────────────────────

/**
 * Require a key and validate it. Absent beats invalid, so a caller never reads
 * two errors for one fact. Presence is `Object.hasOwn` — only a key the
 * DOCUMENT declared counts.
 */
function checkRequired(source, key, label, predicate, expectation, errors) {
  if (!Object.hasOwn(source, key)) {
    errors.push(makeError(ErrorCode.MISSING_KEY, `필수 키 누락: ${label}`));
    return false;
  }
  const value = source[key];
  if (!predicate(value)) {
    errors.push(makeError(ErrorCode.INVALID_VALUE, `${label} ${expectation} (got ${JSON.stringify(value)})`));
    return false;
  }
  return true;
}

/**
 * Top-level keys an outcome must carry, with their value contract. A table so
 * that "what is required" is one list, diffable against the render order.
 */
const REQUIRED_SCALARS = Object.freeze([
  ['schema_version', (v) => v === OUTCOME_SCHEMA_VERSION, `must be ${OUTCOME_SCHEMA_VERSION}`],
  ['mission_id', isMissionId, 'must match the mission id pattern'],
  ['verification_id', isNonEmptyString, 'must be a non-empty string'],
  ['evidence_refs', isRefList, 'must be a list of non-empty strings ([] when there are none)'],
  ['accepted', isAccepted, 'must be true, false or null — the string "null" is not null'],
  ['created_at', isIsoTimestamp, 'must be an ISO timestamp'],
  ['updated_at', isIsoTimestamp, 'must be an ISO timestamp'],
]);

/**
 * Read the `based_on` block. A missing block and a present one missing a member
 * report the SAME error: they are the same fact, no declared upstream revision.
 */
function readBasedOn(map, errors) {
  const source = isPlainObject(map.based_on) ? map.based_on : emptyMap();
  const out = {};
  for (const member of OUTCOME_BASED_ON_MEMBERS) {
    checkRequired(source, member, `based_on.${member}`, isRevision, 'must be an integer >= 0', errors);
    out[member] = source[member];
  }
  return out;
}

/** Read `actor`. A missing block reports both members — one error per fact. */
function readActor(map, errors) {
  const source = isPlainObject(map.actor) ? map.actor : emptyMap();
  checkRequired(source, 'type', 'actor.type', isActorType, `must match ${ACTOR_TYPE_PATTERN}`, errors);
  checkRequired(source, 'id', 'actor.id', isNonEmptyString, 'must be a non-empty string', errors);
  return { type: source.type, id: source.id };
}

/**
 * Read the optional `supersedes` key, enforcing the same pairing rule the
 * serializer does: a deferred (`accepted: null`) outcome supersedes nothing.
 */
function readSupersedes(map, errors) {
  if (!Object.hasOwn(map, 'supersedes')) return undefined;
  if (!isNonEmptyString(map.supersedes)) {
    errors.push(makeError(
      ErrorCode.INVALID_VALUE,
      `supersedes must be a non-empty string when present (got ${JSON.stringify(map.supersedes)})`,
    ));
    return undefined;
  }
  if (map.accepted === null) {
    errors.push(makeError(
      ErrorCode.INVALID_VALUE,
      'supersedes must be absent when accepted is null — 유보 줄은 아무것도 대체하지 않는다',
    ));
  }
  return map.supersedes;
}

// ── Parse: body findings ───────────────────────────────────────────────────

/** Map each `## ` heading to its content, dropping the trailing HTML comment. */
function bodySectionsOf(text) {
  const out = emptyMap();
  if (typeof text !== 'string') return out;

  let heading = null;
  let buffer = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      if (heading !== null) out[heading] = buffer.join('\n');
      heading = line.slice(3).trim();
      buffer = [];
      continue;
    }
    if (heading !== null && !line.startsWith('<!--')) buffer.push(line);
  }
  if (heading !== null) out[heading] = buffer.join('\n');
  return out;
}

/**
 * One finding per required section that is absent, empty, or still the
 * placeholder. NOT parse errors — the refusal is a gate's call (design `:180`).
 */
function findRequiredSectionGaps(text) {
  const bodies = bodySectionsOf(text);
  const findings = [];
  for (const key of OUTCOME_REQUIRED_SECTION_KEYS) {
    const { heading } = OUTCOME_SECTIONS.find((s) => s.key === key);
    const content = Object.hasOwn(bodies, heading) ? bodies[heading].trim() : null;
    if (content !== null && content !== '' && content !== OUTCOME_NOT_RECORDED) continue;
    findings.push({
      code: OutcomeFindingCode.REQUIRED_SECTION_EMPTY,
      section: key,
      message: content === null
        ? `필수 절이 없다: ## ${heading} (${key})`
        : `필수 절이 비어 있다: ## ${heading} (${key})`,
    });
  }
  return findings;
}

/**
 * Read an outcome artifact. CRLF is accepted because the file round-trips
 * through Windows checkouts. `errors` accumulate but one is fatal: `outcome` is
 * `null` unless the whole frontmatter is admissible. `findings` are separate,
 * never fatal, and are computed even when the frontmatter was refused.
 *
 * @param {unknown} text
 * @returns {{ok: boolean, outcome: object|null,
 *   errors: {code: string, message: string}[],
 *   findings: {code: string, section: string, message: string}[]}}
 */
export function parseOutcomeMd(text) {
  const errors = [];
  const findings = findRequiredSectionGaps(text);
  const map = readFrontmatter(text, errors);

  if (map === null) {
    const why = '문서가 --- 로 열리고 --- 로 닫히는 frontmatter 로 시작하지 않는다';
    const errs = [makeError(ErrorCode.FRONTMATTER_MISSING, why)];
    return { ok: false, outcome: null, findings, errors: errs };
  }

  const basedOn = readBasedOn(map, errors);
  const actor = readActor(map, errors);
  for (const [key, predicate, expectation] of REQUIRED_SCALARS) {
    checkRequired(map, key, key, predicate, expectation, errors);
  }
  const supersedes = readSupersedes(map, errors);

  if (errors.length > 0) return { ok: false, outcome: null, errors, findings };

  return {
    ok: true,
    errors,
    findings,
    outcome: {
      schemaVersion: map.schema_version,
      missionId: map.mission_id,
      basedOn: {
        intentRevision: basedOn.intent_revision,
        planRevision: basedOn.plan_revision,
        reviewRevision: basedOn.review_revision,
      },
      verificationId: map.verification_id,
      evidenceRefs: [...map.evidence_refs],
      accepted: map.accepted,
      ...(supersedes === undefined ? {} : { supersedes }),
      actor: { type: actor.type, id: actor.id },
      // `created_at` is validated but not projected: the runtime writes both
      // stamps from one `ts`, so a file where they differ was hand-edited, and
      // the later of the two is the one a reader should act on.
      ts: map.updated_at,
    },
  };
}
