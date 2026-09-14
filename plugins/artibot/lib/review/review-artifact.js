/**
 * `review.md` — the review artifact SERIALIZER and PARSER.
 *
 * Why this exists: `lib/runtime/artifact-lifecycle.js#apply` writes
 * `options.content.review` to `.artibot/missions/<M>/review.md` verbatim — it
 * renders nothing. Without a serializer the artifact's shape is whatever the
 * nearest call site happened to build, which makes `based_on` (the input of
 * the staleness gate) a per-call-site convention rather than a contract. This
 * module is that contract, and it is the only place the shape is decided.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * PURE. No `fs`, no `process`, no clock. The timestamp arrives as `ts` so the
 * bytes are a function of the input alone; {@link assertReviewFilePath} is the
 * hook a write site calls before touching the disk, keeping "파생 파일 금지"
 * enforceable without dragging I/O in here. `lib/runtime` is L5 and this file
 * is L2, so the runtime imports this — never the other way round.
 *
 * ── Deliberate non-reuse ───────────────────────────────────────────────────
 * `lib/intent/artifact.js` already carries a minimal YAML reader/writer for
 * `intent.md`, but it does not export it. Rather than widen that module's
 * surface for a second caller, this file carries its own reader sized to what
 * a review frontmatter actually is: one level of nesting, scalars only. The
 * cost is a second small parser; the benefit is that neither artifact's format
 * can drift by accident through a shared helper.
 *
 * ── The frontmatter is the canon ───────────────────────────────────────────
 * {@link parseReviewMd} validates the frontmatter and does NOT validate the
 * body. The body is a human-readable projection of `verdict`; the machine-read
 * truth is the frontmatter, and the substantive judgement lives in the
 * document `findings_ref` points at. Validating prose here would invent a
 * second, weaker canon and invite call sites to depend on it.
 *
 * @module lib/review/review-artifact
 */

import path from 'node:path';

import { isMissionId } from '../mission/mission-id.js';
import { CANONICAL_VERDICTS } from './independent-reviewer.js';

/** The one legal basename. A review revision edits this file; it never forks. */
export const REVIEW_ARTIFACT_BASENAME = 'review.md';

/** Frontmatter `schema_version`. Bump only with a reader that accepts both. */
export const REVIEW_SCHEMA_VERSION = 1;

/** The revision a first review carries. Revisions count from 1, not 0. */
export const FIRST_REVIEW_REVISION = 1;

/**
 * `based_on` members for a review, in render order.
 *
 * Mirrors `lib/runtime/artifact-lifecycle-gates.js#BASED_ON_MEMBERS_BY_KIND`
 * for `ArtifactKind.REVIEW` (ADDENDUM-HARDENING §5). It is embedded rather
 * than imported because that module is L5 and this one is L2; the pair is
 * asserted by the round-trip suite, not by the import graph.
 */
const REVIEW_BASED_ON_MEMBERS = Object.freeze(['intent_revision', 'plan_revision']);

/** Names a review artifact must never be forked into. Quoted in the throw. */
const KNOWN_DERIVED_REVIEW_NAMES = Object.freeze([
  'review-v2.md',
  'review-final.md',
  'review-old.md',
]);

/** Parse error codes. Callers switch on these, not on the message text. */
const ErrorCode = Object.freeze({
  FRONTMATTER_MISSING: 'FRONTMATTER_MISSING',
  FRONTMATTER_UNSUPPORTED: 'FRONTMATTER_UNSUPPORTED',
  MISSING_KEY: 'MISSING_KEY',
  INVALID_VALUE: 'INVALID_VALUE',
});

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * True only for a timestamp that survives `new Date(ts).toISOString()`
 * unchanged. `'2026-09-14T01:23:45Z'` parses fine and is therefore tempting,
 * but it re-serialises with milliseconds — so accepting it would let two
 * spellings of the same instant produce two different files.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value === '') return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString() === value;
}

function isVerdict(value) {
  return typeof value === 'string' && CANONICAL_VERDICTS.includes(value);
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/** Split a `/`- or `\`-separated path into non-empty segments. */
function segmentsOf(p) {
  return p.replace(/\\/g, '/').split('/').filter((s) => s !== '');
}

/**
 * True when `p` ends in `.artibot/missions/<mission id>/review.md`.
 *
 * Stricter than the intent equivalent on purpose: `lib/intent/artifact.js
 * #isAllowedIntentFilePath` judges the BASENAME only, which accepts a
 * `review.md` sitting anywhere. Here the mission directory is part of the
 * contract, because a review artifact outside a mission has nothing to be a
 * revision of.
 *
 * @param {unknown} p Path or path fragment, `/` or `\` separated.
 * @returns {boolean}
 */
export function isAllowedReviewFilePath(p) {
  if (typeof p !== 'string' || p.trim() === '') return false;
  const segments = segmentsOf(p);
  if (segments.length < 4) return false;
  const [dot, missions, missionId, basename] = segments.slice(-4);
  return dot === '.artibot'
    && missions === 'missions'
    && isMissionId(missionId)
    && basename === REVIEW_ARTIFACT_BASENAME;
}

/**
 * Throw unless `p` is the one allowed review artifact path.
 *
 * @param {unknown} p
 * @returns {void}
 * @throws {Error} When the path is anything else.
 */
export function assertReviewFilePath(p) {
  if (isAllowedReviewFilePath(p)) return;
  throw new Error(
    `파생 review 파일 금지: '${String(p)}' — 한 Mission 에는 `
    + `'.artibot/missions/<mission id>/${REVIEW_ARTIFACT_BASENAME}' 하나만 존재한다. `
    + '재검수는 새 파일이 아니라 같은 파일의 revision 증가다. '
    + `(알려진 위반 예: ${KNOWN_DERIVED_REVIEW_NAMES.join(' · ')})`,
  );
}

/**
 * Build the review artifact path for a mission.
 *
 * @param {string} projectRoot Absolute or relative project root.
 * @param {string} missionId
 * @returns {string} Platform-separated path.
 * @throws {TypeError} When either argument is unusable.
 */
export function reviewArtifactPath(projectRoot, missionId) {
  if (!isNonEmptyString(projectRoot)) {
    throw new TypeError(`reviewArtifactPath: projectRoot must be a non-empty string (got ${typeof projectRoot})`);
  }
  if (!isMissionId(missionId)) {
    throw new TypeError(`reviewArtifactPath: missionId must match the mission id pattern (got ${JSON.stringify(missionId)})`);
  }
  return path.join(projectRoot, '.artibot', 'missions', missionId, REVIEW_ARTIFACT_BASENAME);
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

function refuse(message) {
  throw new TypeError(`serializeReviewMd: ${message}`);
}

/**
 * Validate the required scalars, returning the defaulted `revision`.
 *
 * @param {object} input
 * @returns {number}
 */
function normalizeRequiredScalars(input) {
  if (!isMissionId(input.missionId)) {
    refuse(`missionId must match the mission id pattern (got ${JSON.stringify(input.missionId)})`);
  }
  if (!isVerdict(input.verdict)) {
    refuse(
      `verdict must be one of ${CANONICAL_VERDICTS.join(' · ')} — exact case, no coercion `
      + `(got ${JSON.stringify(input.verdict)})`,
    );
  }
  if (!isNonEmptyString(input.findingsRef)) {
    refuse(`findingsRef must be a non-empty string (got ${JSON.stringify(input.findingsRef)})`);
  }
  if (!isNonEmptyString(input.verificationId)) {
    refuse(`verificationId must be a non-empty string (got ${JSON.stringify(input.verificationId)})`);
  }
  if (!isIsoTimestamp(input.ts)) {
    refuse(`ts must be an ISO timestamp that round-trips through Date#toISOString (got ${JSON.stringify(input.ts)})`);
  }

  const revision = input.revision === undefined ? FIRST_REVIEW_REVISION : input.revision;
  if (!isInteger(revision) || revision < FIRST_REVIEW_REVISION) {
    refuse(`revision must be an integer >= ${FIRST_REVIEW_REVISION} (got ${JSON.stringify(input.revision)})`);
  }
  return revision;
}

/**
 * Validate `basedOn`. `planRevision` is optional and normalises to `null`,
 * `intentRevision` is not: a review with no declared intent revision cannot be
 * checked for staleness at all, which is worse than a review that is stale.
 *
 * @param {object} input
 * @returns {{ intentRevision: number, planRevision: number|null }}
 */
function normalizeBasedOn(input) {
  if (!isPlainObject(input.basedOn)) {
    refuse(
      `basedOn must be a plain object with ${REVIEW_BASED_ON_MEMBERS.join(' + ')} `
      + `(got ${JSON.stringify(input.basedOn)})`,
    );
  }
  const { intentRevision } = input.basedOn;
  if (!isInteger(intentRevision) || intentRevision < 0) {
    refuse(`basedOn.intentRevision must be an integer >= 0 (got ${JSON.stringify(intentRevision)})`);
  }
  const raw = input.basedOn.planRevision;
  const planRevision = raw === undefined ? null : raw;
  if (planRevision !== null && (!isInteger(planRevision) || planRevision < 0)) {
    refuse(`basedOn.planRevision must be an integer >= 0 or null (got ${JSON.stringify(raw)})`);
  }
  return { intentRevision, planRevision };
}

/**
 * Validate the two optional identity fields. Absent and `null` are the same
 * thing here, and both render as an ABSENT key rather than a null value — a
 * key holding `null` reads as "we asked and the answer was nothing", which is
 * not what an unrecorded reviewer means.
 *
 * @param {object} input
 * @returns {{ reviewerId: string|null, model: string|null }}
 */
function normalizeIdentity(input) {
  const out = { reviewerId: null, model: null };
  for (const field of ['reviewerId', 'model']) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (!isNonEmptyString(value)) {
      refuse(`${field} must be a non-empty string or null (got ${JSON.stringify(value)})`);
    }
    out[field] = value;
  }
  return out;
}

/**
 * Validate and normalise a serializer input.
 *
 * Unknown keys are dropped rather than rendered: the frontmatter is a fixed
 * schema, and a passthrough would let a caller smuggle a field the reader
 * refuses into a file the runtime already wrote.
 *
 * @param {unknown} input
 * @returns {object} Normalised review.
 */
function normalizeInput(input) {
  if (!isPlainObject(input)) {
    refuse(`input must be a plain object (got ${input === null ? 'null' : typeof input})`);
  }

  const revision = normalizeRequiredScalars(input);
  const basedOn = normalizeBasedOn(input);
  const { reviewerId, model } = normalizeIdentity(input);

  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    missionId: input.missionId,
    verdict: input.verdict,
    findingsRef: input.findingsRef,
    verificationId: input.verificationId,
    revision,
    basedOn,
    reviewerId,
    model,
    ts: input.ts,
  };
}

/**
 * Quote a string value.
 *
 * Always quoted, never bare: `findings_ref` legitimately carries a colon
 * (`transcript:agent-x`), and a bare `2026-09-14` would be re-read as a date by
 * anything less narrow than the reader below. `JSON.stringify` is the escape
 * function because the reader is `JSON.parse` — one pair, no third spelling.
 *
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return JSON.stringify(value);
}

/**
 * Render a review artifact.
 *
 * Key order is fixed, values are LF-joined, and the string ends in exactly one
 * newline: the file is committed, so a same-input render must be byte-stable
 * or it shows up in a diff as a change nobody made.
 *
 * @param {object} input See {@link normalizeInput}.
 * @returns {string}
 * @throws {TypeError} Naming the offending field.
 */
export function serializeReviewMd(input) {
  const review = normalizeInput(input);

  const lines = [
    '---',
    `schema_version: ${review.schemaVersion}`,
    `mission_id: ${quote(review.missionId)}`,
    `verdict: ${quote(review.verdict)}`,
    `findings_ref: ${quote(review.findingsRef)}`,
    `verification_id: ${quote(review.verificationId)}`,
    `revision: ${review.revision}`,
    'based_on:',
    `  intent_revision: ${review.basedOn.intentRevision}`,
  ];
  if (review.basedOn.planRevision !== null) {
    lines.push(`  plan_revision: ${review.basedOn.planRevision}`);
  }
  if (review.reviewerId !== null) lines.push(`reviewer_id: ${quote(review.reviewerId)}`);
  if (review.model !== null) lines.push(`model: ${quote(review.model)}`);
  lines.push(`created_at: ${quote(review.ts)}`);
  lines.push(`updated_at: ${quote(review.ts)}`);
  lines.push('---');

  lines.push(
    '',
    '# Review',
    '',
    '## Verdict',
    '',
    review.verdict,
    '',
    '<!-- 판정의 정본은 findings_ref 가 가리키는 문서다. 이 파일은 review.completed '
    + '이벤트의 프로젝션이며 런타임이 쓴다(Hardening §6). 손으로 고치지 말 것. -->',
  );

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function makeError(code, message) {
  return { code, message };
}

/**
 * Read one frontmatter scalar.
 *
 * @param {string} raw Text after `key:`, already trimmed.
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
function readScalar(raw) {
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
 * Slice out the frontmatter body, CRLF-normalised.
 *
 * @param {unknown} text
 * @returns {string[]|null} `null` when the document has no frontmatter.
 */
function frontmatterLines(text) {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  return end === -1 ? null : lines.slice(1, end);
}

/**
 * Name the YAML feature a line uses that this reader does not implement, or
 * `null` when the line is within the supported subset.
 *
 * Refusing by NAME rather than skipping is the point: a reader that ignored a
 * sequence would report a file it did not understand as a file it agreed with.
 *
 * @param {string} trimmed
 * @param {number} indent
 * @param {string} raw Text after `key:`, or `''`.
 * @returns {string|null}
 */
function unsupportedFeature(trimmed, indent, raw) {
  if (trimmed === '-' || trimmed.startsWith('- ')) return '시퀀스는 지원하지 않는다';
  if (indent !== 0 && indent !== 2) return `중첩은 한 단계까지다 (indent ${indent})`;
  if (raw.startsWith('|') || raw.startsWith('>')) return '블록 스칼라는 지원하지 않는다';
  if (raw.startsWith('&') || raw.startsWith('*')) return '앵커/별칭은 지원하지 않는다';
  if (raw.startsWith('[') || raw.startsWith('{')) return 'flow 컬렉션은 지원하지 않는다';
  return null;
}

/**
 * Fold one frontmatter line into `map`.
 *
 * @param {string} line
 * @param {object} map Mutated.
 * @param {string|null} parent Key of the open nested mapping, if any.
 * @param {{code: string, message: string}[]} errors Mutated.
 * @returns {string|null} The parent for the next line.
 */
function foldFrontmatterLine(line, map, parent, errors) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return parent;

  const indent = line.length - line.trimStart().length;
  const match = KEY_LINE.exec(trimmed);
  const raw = match === null ? '' : (match[2] ?? '').trim();

  const unsupported = unsupportedFeature(trimmed, indent, raw);
  if (unsupported !== null) {
    errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `${unsupported}: ${trimmed}`));
    return parent;
  }
  if (match === null) {
    errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `key: value 형태가 아니다: ${trimmed}`));
    return parent;
  }

  const key = match[1];
  if (raw === '') {
    if (indent !== 0) {
      errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `중첩은 한 단계까지다: ${trimmed}`));
      return parent;
    }
    map[key] = {};
    return key;
  }

  const scalar = readScalar(raw);
  if (!scalar.ok) {
    errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `${key}: ${scalar.reason}`));
    return parent;
  }
  if (indent === 0) {
    map[key] = scalar.value;
    return null;
  }
  if (parent !== null && isPlainObject(map[parent])) {
    map[parent][key] = scalar.value;
    return parent;
  }
  errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `부모 없는 들여쓰기: ${trimmed}`));
  return parent;
}

/**
 * Read the frontmatter block into a one-level-deep plain object.
 *
 * @param {unknown} text
 * @param {{code: string, message: string}[]} errors Mutated.
 * @returns {object|null} `null` when there is no frontmatter at all.
 */
function readFrontmatter(text, errors) {
  const lines = frontmatterLines(text);
  if (lines === null) return null;

  const map = {};
  let parent = null;
  for (const line of lines) {
    parent = foldFrontmatterLine(line, map, parent, errors);
  }
  return map;
}

/**
 * Require a key and validate it. Absent beats invalid: a missing key yields
 * `MISSING_KEY` only, so a caller never has to read two errors to learn one
 * fact.
 *
 * @returns {boolean} Whether the value is present AND valid.
 */
function checkRequired(source, key, label, predicate, expectation, errors) {
  const value = source[key];
  if (value === undefined) {
    errors.push(makeError(ErrorCode.MISSING_KEY, `필수 키 누락: ${label}`));
    return false;
  }
  if (!predicate(value)) {
    errors.push(makeError(ErrorCode.INVALID_VALUE, `${label} ${expectation} (got ${JSON.stringify(value)})`));
    return false;
  }
  return true;
}

/**
 * Top-level frontmatter keys a review must carry, with their value contract.
 *
 * A table rather than a run of calls so that "what is required" is one list a
 * reader can diff against the serializer's key order, instead of a control
 * flow they have to trace.
 */
const REQUIRED_SCALARS = Object.freeze([
  ['schema_version', (v) => v === REVIEW_SCHEMA_VERSION, `must be ${REVIEW_SCHEMA_VERSION}`],
  ['mission_id', isMissionId, 'must match the mission id pattern'],
  ['verdict', isVerdict, `must be one of ${CANONICAL_VERDICTS.join(' · ')} — exact case, no coercion`],
  ['findings_ref', isNonEmptyString, 'must be a non-empty string'],
  ['verification_id', isNonEmptyString, 'must be a non-empty string'],
  ['revision', (v) => isInteger(v) && v >= FIRST_REVIEW_REVISION, `must be an integer >= ${FIRST_REVIEW_REVISION}`],
  ['created_at', isIsoTimestamp, 'must be an ISO timestamp'],
  ['updated_at', isIsoTimestamp, 'must be an ISO timestamp'],
]);

/**
 * Read the `based_on` block.
 *
 * A missing `based_on:` block and a present one missing `intent_revision`
 * report the SAME error, because they are the same fact — no declared intent
 * revision — and a caller should not have to handle two shapes of it.
 *
 * @param {object} map
 * @param {{code: string, message: string}[]} errors Mutated.
 * @returns {{ intentRevision: unknown, planRevision: number|null }}
 */
function readBasedOn(map, errors) {
  const source = isPlainObject(map.based_on) ? map.based_on : {};
  checkRequired(
    source, 'intent_revision', 'based_on.intent_revision',
    (v) => isInteger(v) && v >= 0, 'must be an integer >= 0', errors,
  );

  const raw = source.plan_revision;
  if (raw === undefined || raw === null) return { intentRevision: source.intent_revision, planRevision: null };
  if (isInteger(raw) && raw >= 0) return { intentRevision: source.intent_revision, planRevision: raw };

  errors.push(makeError(
    ErrorCode.INVALID_VALUE,
    `based_on.plan_revision must be an integer >= 0 or absent (got ${JSON.stringify(raw)})`,
  ));
  return { intentRevision: source.intent_revision, planRevision: null };
}

/**
 * Read the two optional identity keys. Absent and `null` both mean "not
 * recorded"; anything else present must be a usable string.
 *
 * @param {object} map
 * @param {{code: string, message: string}[]} errors Mutated.
 * @returns {{ reviewer_id: string|null, model: string|null }}
 */
function readIdentity(map, errors) {
  const out = { reviewer_id: null, model: null };
  for (const key of ['reviewer_id', 'model']) {
    const value = map[key];
    if (value === undefined || value === null) continue;
    if (isNonEmptyString(value)) {
      out[key] = value;
      continue;
    }
    errors.push(makeError(
      ErrorCode.INVALID_VALUE,
      `${key} must be a non-empty string or absent (got ${JSON.stringify(value)})`,
    ));
  }
  return out;
}

/**
 * Read a review artifact.
 *
 * CRLF is accepted because the file round-trips through Windows checkouts;
 * only the frontmatter is validated (see the module note on why the body is
 * not). Errors accumulate — one call reports every problem in the file — but
 * a single error is fatal: `review` is `null` unless the whole frontmatter is
 * admissible, so no caller can act on a half-read judgement.
 *
 * @param {unknown} text
 * @returns {{ ok: boolean, review: object|null, errors: {code: string, message: string}[] }}
 */
export function parseReviewMd(text) {
  const errors = [];
  const map = readFrontmatter(text, errors);

  if (map === null) {
    return {
      ok: false,
      review: null,
      errors: [makeError(
        ErrorCode.FRONTMATTER_MISSING,
        '문서가 --- 로 열리고 --- 로 닫히는 frontmatter 로 시작하지 않는다',
      )],
    };
  }

  const basedOn = readBasedOn(map, errors);
  const identity = readIdentity(map, errors);
  for (const [key, predicate, expectation] of REQUIRED_SCALARS) {
    checkRequired(map, key, key, predicate, expectation, errors);
  }

  if (errors.length > 0) return { ok: false, review: null, errors };

  return {
    ok: true,
    errors,
    review: {
      schemaVersion: map.schema_version,
      missionId: map.mission_id,
      verdict: map.verdict,
      findingsRef: map.findings_ref,
      verificationId: map.verification_id,
      revision: map.revision,
      basedOn: { intentRevision: basedOn.intentRevision, planRevision: basedOn.planRevision },
      reviewerId: identity.reviewer_id,
      model: identity.model,
      // `created_at` is validated but not projected: the runtime writes both
      // stamps from one `ts`, so a file where they differ was hand-edited, and
      // the later of the two is the one a reader should act on.
      ts: map.updated_at,
    },
  };
}
