/**
 * `plan.md` — the plan artifact SERIALIZER and PARSER.
 *
 * Why this exists: `lib/runtime/artifact-lifecycle.js#apply` writes artifact
 * content to `.artibot/missions/<M>/<kind>.md` verbatim — it renders nothing.
 * Without a serializer the artifact's shape is whatever the nearest call site
 * happened to build, which makes `based_on` (the input of the staleness gate)
 * a per-call-site convention rather than a contract. This module is that
 * contract, and it is the only place the shape is decided.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * PURE. No `fs`, no `process`, no clock. The timestamp arrives as `ts` so the
 * bytes are a function of the input alone; {@link assertPlanFilePath} is the
 * hook a write site calls before touching the disk, keeping "파생 파일 금지"
 * enforceable without dragging I/O in here. `lib/runtime` is L5 and this file
 * is L2, so the runtime imports this — never the other way round.
 *
 * ── Deliberate non-reuse ───────────────────────────────────────────────────
 * `lib/review/review-artifact.js` carries a one-level YAML reader of exactly
 * the shape this module needs, and it does not export it. Its header
 * §"Deliberate non-reuse" (`lib/review/review-artifact.js:18-25`) is the
 * standing ruling and applies here unchanged: rather than widen a sibling
 * module's surface for a second caller — or extract a shared serializer that
 * both artifacts depend on — this file carries its own reader sized to what a
 * plan frontmatter actually is (one level, scalars only). The cost is a third
 * parser; the benefit is that no artifact's format can drift by accident
 * through a shared helper, which is the failure a shared serializer invites and
 * no test would catch.
 *
 * ── The frontmatter is the canon ───────────────────────────────────────────
 * {@link parsePlanMd} validates the frontmatter and does NOT validate the body.
 * The body is a human-readable projection of the six things a plan answers
 * (design package-v1.1 `05_PLAN_AND_TASK_STATE.md:9-16`); the machine-read
 * truth is the frontmatter. Validating prose here would invent a second,
 * weaker canon and invite call sites to depend on it.
 *
 * ── A plan revision is not a new file ──────────────────────────────────────
 * `05_PLAN_AND_TASK_STATE.md:24-30` forbids `plan-v2.md` / `plan-final.md` /
 * `plan-new.md` by name: a plan is a route and revising it is normal, so the
 * revision lives in the frontmatter and the history lives in Git.
 * {@link assertPlanFilePath} is where that rule becomes executable.
 *
 * @module lib/planning/plan-artifact
 */

import path from 'node:path';

import { isMissionId } from '../mission/mission-id.js';

/** The one legal basename. A plan revision edits this file; it never forks. */
export const PLAN_ARTIFACT_BASENAME = 'plan.md';

/** Frontmatter `schema_version`. Bump only with a reader that accepts both. */
export const PLAN_SCHEMA_VERSION = 1;

/** The revision a first plan carries. Revisions count from 1, not 0. */
export const FIRST_PLAN_REVISION = 1;

/**
 * How the plan was produced.
 *
 * Mirrors `schemas/ledger-events.allowlist.json#enums.plan_mode`, which is the
 * vocabulary a `plan.revised` ledger line may carry (`events['plan.revised']
 * .fields.mode.enum_ref`). Embedded rather than imported because this module is
 * pure and reads no files; `tests/planning/plan-artifact.test.js` READS that
 * JSON and compares, so unlike the `based_on` copy below this one is checked.
 */
export const PLAN_MODES = Object.freeze(['plan', 'ultraplan']);

/**
 * The mode a caller with no evidence must declare.
 *
 * Leader decision 5: at hook time there is no source for how the plan was
 * produced, so the hook writes the conservative member rather than guessing
 * `ultraplan` from the size of the work. Recording a guess as a fact is the
 * failure this default exists to avoid — see the test header's note that green
 * here says nothing about how the plan was actually made.
 */
export const DEFAULT_PLAN_MODE = 'plan';

/**
 * `based_on` members for a plan, in render order.
 *
 * Mirrors `lib/runtime/artifact-lifecycle-gates.js#BASED_ON_MEMBERS_BY_KIND`
 * for `ArtifactKind.PLAN` (`:156-164`, Hardening §5). It is embedded rather
 * than imported because that module is L5 and this one is L2.
 *
 * The equivalent copy in `lib/review/review-artifact.js:50-62` is UNCHECKED and
 * says so: the source constant is module-private, so no import and no test
 * compares them. This copy is checked anyway — `tests/planning/
 * plan-artifact.test.js` reads the gates module's SOURCE TEXT and extracts the
 * PLAN entry with an anchored regex (with a negative control proving the regex
 * matched), then compares. Drift here is red; drift in the review copy is not.
 */
export const PLAN_BASED_ON_MEMBERS = Object.freeze(['intent_revision']);

/**
 * The body's sections, in render order.
 *
 * The six items are `05_PLAN_AND_TASK_STATE.md:9-16` verbatim — what `plan.md`
 * answers. They are a fixed list rather than free-form headings so that a plan
 * missing its rollback points is visibly missing them (the section renders
 * {@link NOT_RECORDED}) instead of being indistinguishable from a plan that
 * never had any.
 */
export const PLAN_SECTIONS = Object.freeze([
  Object.freeze({ key: 'decomposition', heading: 'Work decomposition' }),
  Object.freeze({ key: 'dependencies', heading: 'Dependencies' }),
  Object.freeze({ key: 'order', heading: 'Execution order' }),
  Object.freeze({ key: 'topology', heading: 'Model / topology expectations' }),
  Object.freeze({ key: 'checkpoints', heading: 'Verification checkpoints' }),
  Object.freeze({ key: 'rollback', heading: 'Rollback points' }),
]);

/** Rendered in place of a section the caller supplied nothing for. */
const NOT_RECORDED = '_(not yet recorded)_';

/** Names a plan artifact must never be forked into. Quoted in the throw. */
const KNOWN_DERIVED_PLAN_NAMES = Object.freeze([
  'plan-v2.md',
  'plan-final.md',
  'plan-new.md',
]);

/**
 * Shape `actor.type` must match.
 *
 * The same plain-lowercase-identifier rule as `lib/runtime/
 * artifact-lifecycle-gates.js#LAYER_NAME_PATTERN` (`:134`), and for the same
 * reason it gives there: no enum is invented. A closed list of actor types
 * would make a new caller's honest label an invalid document, while a free
 * string would let event payload reach the artifact unshaped.
 */
const ACTOR_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

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

function isPlanMode(value) {
  return typeof value === 'string' && PLAN_MODES.includes(value);
}

function isActorType(value) {
  return typeof value === 'string' && ACTOR_TYPE_PATTERN.test(value);
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

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/** Split a `/`- or `\`-separated path into non-empty segments. */
function segmentsOf(p) {
  return p.replace(/\\/g, '/').split('/').filter((s) => s !== '');
}

/**
 * The `<mission id>` segment of an allowed plan path, or `null`.
 *
 * One function answers both "is this the path" and "whose plan is it", because
 * a caller that derives the mission from the path must not be able to derive it
 * from a path the predicate would have refused.
 *
 * @param {unknown} p
 * @returns {string|null}
 */
function missionSegmentOf(p) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  const segments = segmentsOf(p);
  if (segments.length < 4) return null;
  const [dot, missions, missionId, basename] = segments.slice(-4);
  const allowed = dot === '.artibot'
    && missions === 'missions'
    && isMissionId(missionId)
    && basename === PLAN_ARTIFACT_BASENAME;
  return allowed ? missionId : null;
}

/**
 * True when `p` ends in `.artibot/missions/<mission id>/plan.md`.
 *
 * The mission directory is part of the contract, not just the basename: a
 * `plan.md` outside a mission has nothing to be a revision of.
 *
 * @param {unknown} p Path or path fragment, `/` or `\` separated.
 * @returns {boolean}
 */
export function isAllowedPlanFilePath(p) {
  return missionSegmentOf(p) !== null;
}

/**
 * The mission id a plan path belongs to, or `null` when the path is not the one
 * allowed plan path. The hook derives the mission from the path with this.
 *
 * @param {unknown} p
 * @returns {string|null}
 */
export function missionIdFromPlanPath(p) {
  return missionSegmentOf(p);
}

/**
 * Throw unless `p` is the one allowed plan artifact path.
 *
 * @param {unknown} p
 * @returns {void}
 * @throws {Error} When the path is anything else.
 */
export function assertPlanFilePath(p) {
  if (isAllowedPlanFilePath(p)) return;
  throw new Error(
    `파생 plan 파일 금지: '${String(p)}' — 한 Mission 에는 `
    + `'.artibot/missions/<mission id>/${PLAN_ARTIFACT_BASENAME}' 하나만 존재한다. `
    + '재계획은 새 파일이 아니라 같은 파일의 revision 증가다. '
    + `(알려진 위반 예: ${KNOWN_DERIVED_PLAN_NAMES.join(' · ')})`,
  );
}

/**
 * Build the plan artifact path for a mission.
 *
 * @param {string} projectRoot Absolute or relative project root.
 * @param {string} missionId
 * @returns {string} Platform-separated path.
 * @throws {TypeError} When either argument is unusable.
 */
export function planArtifactPath(projectRoot, missionId) {
  if (!isNonEmptyString(projectRoot)) {
    throw new TypeError(`planArtifactPath: projectRoot must be a non-empty string (got ${typeof projectRoot})`);
  }
  if (!isMissionId(missionId)) {
    throw new TypeError(`planArtifactPath: missionId must match the mission id pattern (got ${JSON.stringify(missionId)})`);
  }
  return path.join(projectRoot, '.artibot', 'missions', missionId, PLAN_ARTIFACT_BASENAME);
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

function refuse(message) {
  throw new TypeError(`serializePlanMd: ${message}`);
}

/**
 * Validate the required scalars, returning the defaulted `revision` and `mode`.
 *
 * @param {object} input
 * @returns {{ revision: number, mode: string }}
 */
function normalizeRequiredScalars(input) {
  if (!isMissionId(input.missionId)) {
    refuse(`missionId must match the mission id pattern (got ${JSON.stringify(input.missionId)})`);
  }
  if (!isIsoTimestamp(input.ts)) {
    refuse(`ts must be an ISO timestamp that round-trips through Date#toISOString (got ${JSON.stringify(input.ts)})`);
  }

  const revision = input.revision === undefined ? FIRST_PLAN_REVISION : input.revision;
  if (!isInteger(revision) || revision < FIRST_PLAN_REVISION) {
    refuse(`revision must be an integer >= ${FIRST_PLAN_REVISION} (got ${JSON.stringify(input.revision)})`);
  }

  const mode = input.mode === undefined ? DEFAULT_PLAN_MODE : input.mode;
  if (!isPlanMode(mode)) {
    refuse(
      `mode must be one of ${PLAN_MODES.join(' · ')} — exact case, no coercion `
      + `(got ${JSON.stringify(input.mode)})`,
    );
  }
  return { revision, mode };
}

/**
 * Validate `basedOn`. `intentRevision` is REQUIRED: a plan with no declared
 * intent revision cannot be checked for staleness at all, which is worse than a
 * plan that is stale.
 *
 * @param {object} input
 * @returns {{ intentRevision: number }}
 */
function normalizeBasedOn(input) {
  if (!isPlainObject(input.basedOn)) {
    refuse(
      `basedOn must be a plain object with ${PLAN_BASED_ON_MEMBERS.join(' + ')} `
      + `(got ${JSON.stringify(input.basedOn)})`,
    );
  }
  const { intentRevision } = input.basedOn;
  if (!isInteger(intentRevision) || intentRevision < 0) {
    refuse(`basedOn.intentRevision must be an integer >= 0 (got ${JSON.stringify(intentRevision)})`);
  }
  return { intentRevision };
}

/**
 * Validate `actor`. Required, both members: a plan artifact whose writer is
 * unrecorded cannot be audited against the ledger line that claims to have
 * produced it.
 *
 * @param {object} input
 * @returns {{ type: string, id: string }}
 */
function normalizeActor(input) {
  if (!isPlainObject(input.actor)) {
    refuse(`actor must be a plain object with type + id (got ${JSON.stringify(input.actor)})`);
  }
  const { type, id } = input.actor;
  if (!isActorType(type)) {
    refuse(`actor.type must match ${ACTOR_TYPE_PATTERN} (got ${JSON.stringify(type)})`);
  }
  if (!isNonEmptyString(id)) {
    refuse(`actor.id must be a non-empty string (got ${JSON.stringify(id)})`);
  }
  return { type, id };
}

/**
 * Validate the optional `sections` bag into `key -> string[]` render lines.
 *
 * An EMPTY array is refused rather than treated as absent: "the caller had a
 * list and it was empty" and "the caller recorded nothing" are different facts,
 * and collapsing them would render the second one's placeholder over the first.
 * Unknown section keys are dropped, like unknown top-level keys.
 *
 * @param {object} input
 * @returns {Record<string, string[]>}
 */
function normalizeSections(input) {
  const { sections } = input;
  if (sections !== undefined && !isPlainObject(sections)) {
    refuse(`sections must be a plain object when present (got ${JSON.stringify(sections)})`);
  }

  const out = {};
  for (const { key } of PLAN_SECTIONS) {
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
 * Validate and normalise a serializer input.
 *
 * Unknown keys are dropped rather than rendered: the frontmatter is a fixed
 * schema, and a passthrough would let a caller smuggle a field the reader
 * refuses into a file the runtime already wrote.
 *
 * @param {unknown} input
 * @returns {object} Normalised plan.
 */
function normalizeInput(input) {
  if (!isPlainObject(input)) {
    refuse(`input must be a plain object (got ${input === null ? 'null' : typeof input})`);
  }

  const { revision, mode } = normalizeRequiredScalars(input);

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    missionId: input.missionId,
    revision,
    basedOn: normalizeBasedOn(input),
    mode,
    actor: normalizeActor(input),
    ts: input.ts,
    sections: normalizeSections(input),
  };
}

/**
 * Quote a string value. Always quoted, never bare: an actor id legitimately
 * carries a colon, and a bare `2026-09-14` would be re-read as a date by
 * anything less narrow than the reader below. `JSON.stringify` is the escape
 * function because the reader is `JSON.parse` — one pair, no third spelling.
 *
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return JSON.stringify(value);
}

/** The frontmatter block, in fixed key order. */
function frontmatterLinesOf(plan) {
  return [
    '---',
    `schema_version: ${plan.schemaVersion}`,
    `mission_id: ${quote(plan.missionId)}`,
    `revision: ${plan.revision}`,
    'based_on:',
    `  intent_revision: ${plan.basedOn.intentRevision}`,
    `mode: ${quote(plan.mode)}`,
    'actor:',
    `  type: ${quote(plan.actor.type)}`,
    `  id: ${quote(plan.actor.id)}`,
    `created_at: ${quote(plan.ts)}`,
    `updated_at: ${quote(plan.ts)}`,
    '---',
  ];
}

/** The body: title, the six sections in order, then the do-not-edit note. */
function bodyLinesOf(plan) {
  const lines = ['', '# Plan'];
  for (const { key, heading } of PLAN_SECTIONS) {
    const content = plan.sections[key] ?? [NOT_RECORDED];
    lines.push('', `## ${heading}`, '', ...content);
  }
  lines.push(
    '',
    '<!-- 이 파일은 plan.revised 이벤트의 프로젝션이며 런타임이 쓴다. 손으로 고치지 말 것. '
    + 'revision 은 frontmatter 로만 올린다 — 파생 파일 금지'
    + `(${KNOWN_DERIVED_PLAN_NAMES.join(' · ')}). -->`,
  );
  return lines;
}

/**
 * Render a plan artifact.
 *
 * Key order is fixed, values are LF-joined, and the string ends in exactly one
 * newline: the file is committed, so a same-input render must be byte-stable or
 * it shows up in a diff as a change nobody made.
 *
 * @param {object} input See {@link normalizeInput}.
 * @returns {string}
 * @throws {TypeError} Naming the offending field.
 */
export function serializePlanMd(input) {
  const plan = normalizeInput(input);
  return `${[...frontmatterLinesOf(plan), ...bodyLinesOf(plan)].join('\n')}\n`;
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
 * A key/value bag with NO prototype. Frontmatter keys come from the file, so a
 * plain `{}` would let a document declare `__proto__:` and have its children
 * answer lookups for keys it never declared.
 *
 * @returns {object}
 */
function emptyMap() {
  return Object.create(null);
}

/**
 * Report a key that is being declared a second time. Last-wins is the wrong
 * default for a document a gate reads: the second line would silently replace a
 * value the first line already put past validation.
 *
 * @param {object} bag
 * @param {string} key
 * @param {string} trimmed Source line, for the message.
 * @param {{code: string, message: string}[]} errors Mutated.
 * @returns {boolean} True when the key was already present.
 */
function isDuplicateKey(bag, key, trimmed, errors) {
  if (!Object.hasOwn(bag, key)) return false;
  errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `중복 키는 지원하지 않는다: ${trimmed}`));
  return true;
}

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
 * `null` when the line is within the supported subset. Refusing by NAME rather
 * than skipping is the point: a reader that ignored a sequence would report a
 * file it did not understand as a file it agreed with.
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
    if (isDuplicateKey(map, key, trimmed, errors)) return parent;
    map[key] = emptyMap();
    return key;
  }

  const scalar = readScalar(raw);
  if (!scalar.ok) {
    errors.push(makeError(ErrorCode.FRONTMATTER_UNSUPPORTED, `${key}: ${scalar.reason}`));
    return parent;
  }
  if (indent === 0) {
    if (isDuplicateKey(map, key, trimmed, errors)) return parent;
    map[key] = scalar.value;
    return null;
  }
  if (parent !== null && isPlainObject(map[parent])) {
    if (!isDuplicateKey(map[parent], key, trimmed, errors)) map[parent][key] = scalar.value;
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

  const map = emptyMap();
  let parent = null;
  for (const line of lines) {
    parent = foldFrontmatterLine(line, map, parent, errors);
  }
  return map;
}

/**
 * Require a key and validate it. Absent beats invalid: a missing key yields
 * `MISSING_KEY` only, so a caller never has to read two errors to learn one
 * fact. Presence is `Object.hasOwn`, not `!== undefined` — only a key the
 * DOCUMENT declared counts, whatever the bag may inherit.
 *
 * @returns {boolean} Whether the value is present AND valid.
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
 * Top-level frontmatter keys a plan must carry, with their value contract. A
 * table rather than a run of calls so that "what is required" is one list a
 * reader can diff against the serializer's key order.
 */
const REQUIRED_SCALARS = Object.freeze([
  ['schema_version', (v) => v === PLAN_SCHEMA_VERSION, `must be ${PLAN_SCHEMA_VERSION}`],
  ['mission_id', isMissionId, 'must match the mission id pattern'],
  ['revision', (v) => isInteger(v) && v >= FIRST_PLAN_REVISION, `must be an integer >= ${FIRST_PLAN_REVISION}`],
  ['mode', isPlanMode, `must be one of ${PLAN_MODES.join(' · ')} — exact case, no coercion`],
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
 * @returns {{ intentRevision: unknown }}
 */
function readBasedOn(map, errors) {
  const source = isPlainObject(map.based_on) ? map.based_on : emptyMap();
  checkRequired(
    source, 'intent_revision', 'based_on.intent_revision',
    (v) => isInteger(v) && v >= 0, 'must be an integer >= 0', errors,
  );
  return { intentRevision: source.intent_revision };
}

/**
 * Read the `actor` block. Both members are required, and a missing block
 * reports both — one error per fact the document failed to state.
 *
 * @param {object} map
 * @param {{code: string, message: string}[]} errors Mutated.
 * @returns {{ type: unknown, id: unknown }}
 */
function readActor(map, errors) {
  const source = isPlainObject(map.actor) ? map.actor : emptyMap();
  checkRequired(source, 'type', 'actor.type', isActorType, `must match ${ACTOR_TYPE_PATTERN}`, errors);
  checkRequired(source, 'id', 'actor.id', isNonEmptyString, 'must be a non-empty string', errors);
  return { type: source.type, id: source.id };
}

/**
 * Read a plan artifact. CRLF is accepted because the file round-trips through
 * Windows checkouts; only the frontmatter is validated (see the module note on
 * why the body is not). Errors accumulate — one call reports every problem in
 * the file — but a single error is fatal: `plan` is `null` unless the whole
 * frontmatter is admissible, so no caller can act on a half-read plan.
 *
 * @param {unknown} text
 * @returns {{ ok: boolean, plan: object|null, errors: {code: string, message: string}[] }}
 */
export function parsePlanMd(text) {
  const errors = [];
  const map = readFrontmatter(text, errors);

  if (map === null) {
    return {
      ok: false,
      plan: null,
      errors: [makeError(
        ErrorCode.FRONTMATTER_MISSING,
        '문서가 --- 로 열리고 --- 로 닫히는 frontmatter 로 시작하지 않는다',
      )],
    };
  }

  const basedOn = readBasedOn(map, errors);
  const actor = readActor(map, errors);
  for (const [key, predicate, expectation] of REQUIRED_SCALARS) {
    checkRequired(map, key, key, predicate, expectation, errors);
  }

  if (errors.length > 0) return { ok: false, plan: null, errors };

  return {
    ok: true,
    errors,
    plan: {
      schemaVersion: map.schema_version,
      missionId: map.mission_id,
      revision: map.revision,
      basedOn: { intentRevision: basedOn.intentRevision },
      mode: map.mode,
      actor: { type: actor.type, id: actor.id },
      // `created_at` is validated but not projected: the runtime writes both
      // stamps from one `ts`, so a file where they differ was hand-edited, and
      // the later of the two is the one a reader should act on.
      ts: map.updated_at,
    },
  };
}
