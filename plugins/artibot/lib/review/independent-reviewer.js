/**
 * Independent review **contract** owner. This module does not review anything:
 * it builds the review request, and it judges whether a returned verdict is
 * admissible. Performing the review is the reviewer agent's job.
 *
 * ── Why the signatures look the way they do ────────────────────────────────
 * `buildReviewRequest` takes `missionDir` and reads `intent.md` off disk
 * through an injected port. There is deliberately NO signature that accepts
 * intent text. The failure this closes is measured, not hypothetical: the
 * cross-check prompt in `commands/team.md` interpolates
 * `요구사항: {original requirements}` — the leader's own summary — so today's
 * default path has the reviewer judging against a worker-local paraphrase
 * rather than the canonical file. A parameter that can carry intent text will
 * eventually carry the leader's paraphrase again, so the parameter does not
 * exist. (That string sits at `commands/team.md:279`, measured 2026-09-02; the
 * file is owned by T-07 and edited concurrently, so cite the string, not the
 * line number.)
 *
 * Clean-room input allowlist: intent, ADR, plan, diff, tests, evidence,
 * constraints. Builder chat transcripts and builder self-assessment have no
 * slot in the interface at all — an allowlist, not a denylist, so a field
 * invented tomorrow is rejected rather than silently forwarded.
 *
 * ── Fail-closed reading of a verdict ───────────────────────────────────────
 * `parseReviewVerdict` returns `ok:true` ONLY for a document that validates as
 * `schemas/review-output.schema.json#definitions.reviewOutputV2`. Everything
 * else — malformed input, a legacy-vocabulary document, an unknown token, an
 * ambiguous token — returns `ok:false` with `verdict:null`. "The reviewer did
 * not give a usable answer" must never be read as `PASS`. The folded legacy
 * value, when one exists, is reported under the separate `foldedVerdict` field
 * whose name makes it obvious that it is an observation, not an admissible
 * verdict.
 *
 * ── Layer / purity ─────────────────────────────────────────────────────────
 * L2. No filesystem, no clock, no randomness, no network. Every outside fact
 * arrives through a port:
 *   - `readFile(absPath) => string | Promise<string>` (intent.md)
 *   - `validateSchema(doc) => { ok, errors }` (optional; an ajv-backed
 *     validator when the caller has one — ajv is NOT a declared dependency of
 *     this package, so the module never imports it)
 *   - the spawn ledger reader, for `builderId`, is called by the CALLER:
 *     `lib/learning/ledger/spawn-ledger.js#readSpawns` is L3 and an L2 module
 *     may not import it (`eslint.config.js` L2 block).
 *
 * Model routing is delegated, never decided here: callers use
 * `resolveModel(reviewerAgentName, { role: 'review' })` so the fable allowlist
 * and FABLE_DENYLIST comparisons are inherited. `resolveModelForPhase('review')`
 * takes no agent name and therefore cannot see the denylist — do not use it.
 *
 * ── What this module does NOT do (do not mistake its green tests) ──────────
 *  1. It does not decide state transitions. Verdict consumption belongs to the
 *     Mission Controller; the reviewer may not edit intent or plan.
 *  2. It does not prove a review happened. It judges a document it is handed.
 *  3. `assertIndependence` compares two ids it is given. It cannot tell you
 *     that the id it was given is really the builder's — see the note on that
 *     function for the join-key gap in the spawn ledger.
 *  4. Free-text verdict extraction reads uppercase vocabulary tokens only. A
 *     bare lowercase `pass` in prose is NOT a verdict here, by design.
 *
 * @module lib/review/independent-reviewer
 */

import path from 'node:path';

/**
 * The five canonical verdicts (ADDENDUM-HARDENING §15), in schema enum order.
 * Mirrors `schemas/review-output.schema.json#definitions.reviewOutputV2.
 * properties.verdict.enum`; the mirror is checked by
 * `tests/review/independent-reviewer.drift.test.js`.
 */
export const CANONICAL_VERDICTS = Object.freeze([
  'PASS',
  'REPAIR_REQUIRED',
  'REPLAN_REQUIRED',
  'INTENT_REVIEW_REQUIRED',
  'BLOCK',
]);

/**
 * The two work natures a reviewed report can be stratified by, in allowlist
 * order. Mirrors `schemas/ledger-events.allowlist.json#enums.claim_nature`;
 * the mirror is checked by `tests/review/independent-reviewer.drift.test.js`,
 * and it is embedded rather than read because this module does no I/O.
 *
 * Fixed by owner decision MP-1 (`ARTIBOT-5.0-DESIGN.md` 부록 0-2 후속(3),
 * 2026-09-04): the tag attaches to the ARTIFACT, not to the assignment — a
 * report is `judge` because it contains a judgement sentence. There is no
 * `unknown` member on purpose: an untagged report is dropped from the
 * denominator (설계 §4.4 #4), and a third value would let it accumulate as its
 * own stratum instead.
 */
export const CLAIM_NATURES = Object.freeze(['process', 'judge']);

/**
 * Keys `buildReviewRequest` accepts; anything else is rejected. `readFile` is
 * the port, not review material. `intent` is absent on purpose — adding it back
 * is a contract change, not a convenience.
 */
export const REVIEW_REQUEST_INPUT_KEYS = Object.freeze([
  'missionDir',
  'plan',
  'adr',
  'diff',
  'tests',
  'evidence',
  'constraints',
  'builderId',
  'readFile',
]);

/**
 * Required fields of `reviewOutputV2`, mirroring the schema's `required` array.
 * Drift against the schema file is red in
 * `tests/review/independent-reviewer.drift.test.js`.
 */
export const V2_REQUIRED_FIELDS = Object.freeze([
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
]);

/** `mission_id` pattern, mirrored from the v2 schema (drift-tested). */
export const MISSION_ID_PATTERN = /^M-\d{8}-(?:\d{3,}|S[0-9A-Za-z]{8})$/;

/**
 * Legacy vocabulary → canonical verdict, mirroring the rows of
 * `schemas/verdict-adapter-map.json`. That JSON file stays the data original;
 * this table is embedded so the module performs no I/O, and
 * `tests/review/independent-reviewer.drift.test.js` fails red the moment the
 * two disagree. `verdict:null` + `ambiguous:true` means the token does not
 * determine a verdict and a human resolves it — it is never guessed.
 *
 * @type {ReadonlyArray<{source: string, token: string, verdict: string|null,
 *   ambiguous: boolean, candidates: string[]}>}
 */
export const ADAPTER_ROWS = Object.freeze([
  { source: 'design-v1.0-08', token: 'pass', verdict: 'PASS', ambiguous: false, candidates: [] },
  { source: 'design-v1.0-08', token: 'repair', verdict: 'REPAIR_REQUIRED', ambiguous: false, candidates: [] },
  { source: 'design-v1.0-08', token: 'replan', verdict: 'REPLAN_REQUIRED', ambiguous: false, candidates: [] },
  { source: 'schema-v1', token: 'pass', verdict: 'PASS', ambiguous: false, candidates: [] },
  { source: 'schema-v1', token: 'warning', verdict: 'PASS', ambiguous: false, candidates: [] },
  { source: 'schema-v1', token: 'fail', verdict: 'REPAIR_REQUIRED', ambiguous: false, candidates: [] },
  { source: 'code-reviewer', token: 'APPROVE', verdict: 'PASS', ambiguous: false, candidates: [] },
  { source: 'code-reviewer', token: 'REQUEST_CHANGES', verdict: 'REPAIR_REQUIRED', ambiguous: false, candidates: [] },
  { source: 'code-reviewer', token: 'REJECT', verdict: 'BLOCK', ambiguous: false, candidates: [] },
  { source: 'spec-reviewer', token: 'SPEC_PASS', verdict: 'PASS', ambiguous: false, candidates: [] },
  { source: 'spec-reviewer', token: 'SPEC_WARN', verdict: 'PASS', ambiguous: false, candidates: [] },
  {
    source: 'spec-reviewer',
    token: 'SPEC_FAIL',
    verdict: null,
    ambiguous: true,
    candidates: ['REPAIR_REQUIRED', 'INTENT_REVIEW_REQUIRED'],
  },
  { source: 'quality-reviewer', token: 'QUALITY_PASS', verdict: 'PASS', ambiguous: false, candidates: [] },
  { source: 'quality-reviewer', token: 'QUALITY_WARN', verdict: 'PASS', ambiguous: false, candidates: [] },
  { source: 'quality-reviewer', token: 'QUALITY_FAIL', verdict: 'REPAIR_REQUIRED', ambiguous: false, candidates: [] },
]);

/**
 * Tokens that may be recognised inside free-running prose. Lowercase
 * draft/schema-v1 tokens (`pass`, `fail`, `warning`, `repair`, `replan`) are
 * excluded on purpose: "the tests pass" is a sentence, not a verdict. They are
 * honoured only as a structured `verdict` field or a labelled `verdict:` line.
 */
const PROSE_SAFE_TOKENS = Object.freeze([
  ...CANONICAL_VERDICTS,
  'APPROVE',
  'REQUEST_CHANGES',
  'REJECT',
  'SPEC_PASS',
  'SPEC_WARN',
  'SPEC_FAIL',
  'QUALITY_PASS',
  'QUALITY_WARN',
  'QUALITY_FAIL',
]);

/** Labelled verdict lines emitted by the four reviewer vocabularies. */
const LABELLED_VERDICT_LINE =
  /^[\s>*_-]*(?:verdict|judgment|judgement|판정|평결)\s*[:=]\s*["'`]?([A-Za-z_]+)["'`]?/gim;

/**
 * A contract violation on the way IN — a caller handed this module something
 * the interface refuses to carry. Thrown rather than returned, because these
 * are programming errors at the call site and an `{ok:false}` here would invite
 * the caller to continue with a half-built request.
 */
export class ReviewContractError extends Error {
  /**
   * @param {string} code machine-readable cause
   * @param {string} message human-readable detail
   * @param {object} [details] extra context (offending keys, path, …)
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReviewContractError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {unknown} v value to test
 * @returns {boolean} true when `v` is a non-empty string after trimming
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * @param {unknown} v value to test
 * @returns {boolean} true when `v` is an array with at least one entry
 */
function isNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

/**
 * @param {object} o object to probe
 * @param {string} k key to probe for
 * @returns {boolean} true when `k` is an own property of `o`
 */
function has(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * Parse the top-level scalar keys of a YAML front-matter block.
 *
 * Deliberately a subset: only `key: value` lines at column 0 between the first
 * two `---` fences. Nested blocks (`actor:`, `execution_profile:`) and list
 * items are skipped rather than guessed at. A fuller YAML reader would mean a
 * new dependency for two fields.
 *
 * @param {string} text file contents
 * @returns {Record<string, string>|null} scalar map, or null when no front matter
 */
export function parseFrontMatterScalars(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!m) return null;
  const out = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (/^\s/.test(rawLine)) continue; // nested — not a top-level scalar
    const line = rawLine.replace(/\s+#.*$/, '').trimEnd();
    if (line === '' || line.startsWith('#') || line.startsWith('-')) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (value === '') continue; // block header such as `actor:`, no scalar
    out[kv[1]] = value;
  }
  return out;
}

/**
 * @param {unknown} v value to coerce
 * @returns {number|null} `v` as a non-negative integer, or null
 */
function toRevision(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string' || !/^\d+$/.test(v.trim())) return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Read and validate `<missionDir>/intent.md` through the port.
 *
 * @param {string} missionDir mission folder
 * @param {(p: string) => string|Promise<string>} readFile file-read port
 * @returns {Promise<{intent: string, missionId: string, intentRevision: number, intentPath: string}>}
 *   the canonical intent and its identity fields
 * @throws {ReviewContractError} when intent.md is unreadable or its front
 *   matter lacks a canonical `mission_id` / `intent_revision`
 */
async function readCanonicalIntent(missionDir, readFile) {
  const intentPath = path.join(missionDir, 'intent.md');
  let intent;
  try {
    intent = await readFile(intentPath);
  } catch (err) {
    throw new ReviewContractError(
      'intent_unreadable',
      `canonical intent could not be read: ${intentPath}`,
      { intentPath, cause: err instanceof Error ? err.message : String(err) },
    );
  }
  if (typeof intent !== 'string' || intent.trim() === '') {
    throw new ReviewContractError(
      'intent_unreadable',
      `canonical intent is empty: ${intentPath}`,
      { intentPath },
    );
  }
  const fm = parseFrontMatterScalars(intent);
  if (fm === null) {
    throw new ReviewContractError(
      'intent_frontmatter_invalid',
      `intent.md has no front matter: ${intentPath}`,
      { intentPath },
    );
  }
  const missionId = fm.mission_id;
  const intentRevision = toRevision(fm.intent_revision);
  if (!isNonEmptyString(missionId) || !MISSION_ID_PATTERN.test(missionId)) {
    throw new ReviewContractError(
      'intent_frontmatter_invalid',
      `intent.md mission_id is missing or not canonical: ${String(missionId)}`,
      { intentPath, missionId: missionId ?? null },
    );
  }
  if (intentRevision === null) {
    throw new ReviewContractError(
      'intent_frontmatter_invalid',
      'intent.md intent_revision is missing or not a non-negative integer',
      { intentPath, intentRevision: fm.intent_revision ?? null },
    );
  }
  return { intent, missionId, intentRevision, intentPath };
}

/**
 * Build a clean-room review request from the mission folder.
 *
 * The canonical intent is READ HERE from `<missionDir>/intent.md`. It is not a
 * parameter and cannot be supplied, overridden, or paraphrased by the caller.
 *
 * @param {object} input request inputs, restricted to
 *   {@link REVIEW_REQUEST_INPUT_KEYS}
 * @param {string} input.missionDir absolute path to the mission folder
 * @param {(p: string) => string|Promise<string>} input.readFile file-read port
 * @param {string} input.builderId agent id that produced the work under review
 * @param {unknown} [input.plan] plan text or reference
 * @param {unknown} [input.adr] ADR text or reference
 * @param {unknown} [input.diff] diff text or git ref
 * @param {unknown} [input.tests] test output or reference
 * @param {unknown} [input.evidence] evidence entries
 * @param {unknown} [input.constraints] constraints handed to the builder
 * @returns {Promise<Readonly<object>>} frozen ReviewRequest
 * @throws {ReviewContractError} on any unknown key or unreadable intent
 */
export async function buildReviewRequest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ReviewContractError('invalid_input', 'buildReviewRequest expects an object');
  }
  const unknown = Object.keys(input).filter((k) => !REVIEW_REQUEST_INPUT_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ReviewContractError(
      'unknown_input_key',
      `clean-room allowlist rejects: ${unknown.join(', ')}. `
        + 'Intent is read from missionDir; builder chat and builder self-assessment have no slot.',
      { unknown, allowed: [...REVIEW_REQUEST_INPUT_KEYS] },
    );
  }
  const { missionDir, readFile, builderId } = input;
  if (!isNonEmptyString(missionDir)) {
    throw new ReviewContractError('missing_mission_dir', 'missionDir is required');
  }
  if (typeof readFile !== 'function') {
    throw new ReviewContractError('missing_read_file_port', 'readFile port is required');
  }
  if (!isNonEmptyString(builderId)) {
    throw new ReviewContractError(
      'missing_builder_id',
      'builderId is required — independence cannot be asserted without it',
    );
  }

  const { intent, missionId, intentRevision, intentPath } = await readCanonicalIntent(
    missionDir,
    readFile,
  );

  return Object.freeze({
    missionDir,
    intentPath,
    missionId,
    intentRevision,
    intent,
    plan: input.plan ?? null,
    adr: input.adr ?? null,
    diff: input.diff ?? null,
    tests: input.tests ?? null,
    evidence: input.evidence ?? null,
    constraints: input.constraints ?? null,
    builderId,
  });
}

/**
 * Resolve one legacy token against every adapter row that uses it.
 *
 * @param {string} token source-vocabulary token
 * @returns {{found: boolean, verdict: string|null, ambiguous: boolean,
 *   candidates: string[], sources: string[]}} fold outcome
 */
export function foldLegacyToken(token) {
  const key = typeof token === 'string' ? token.trim().toLowerCase() : '';
  const rows = ADAPTER_ROWS.filter((r) => r.token.toLowerCase() === key);
  if (rows.length === 0) {
    return { found: false, verdict: null, ambiguous: false, candidates: [], sources: [] };
  }
  const sources = rows.map((r) => r.source);
  if (rows.some((r) => r.ambiguous)) {
    const candidates = [...new Set(rows.flatMap((r) => r.candidates))];
    return { found: true, verdict: null, ambiguous: true, candidates, sources };
  }
  const verdicts = [...new Set(rows.map((r) => r.verdict))];
  if (verdicts.length > 1) {
    // Two sources spell the same token but mean different verdicts. No row
    // does this today; if one ever does, escalate rather than pick one.
    return { found: true, verdict: null, ambiguous: true, candidates: verdicts, sources };
  }
  return { found: true, verdict: verdicts[0], ambiguous: false, candidates: [], sources };
}

/**
 * @param {string} text reviewer output
 * @returns {string[]} distinct verdict tokens found in prose or labelled lines
 */
function extractTokens(text) {
  const found = new Set();
  LABELLED_VERDICT_LINE.lastIndex = 0;
  let m = LABELLED_VERDICT_LINE.exec(text);
  while (m !== null) {
    found.add(m[1]);
    m = LABELLED_VERDICT_LINE.exec(text);
  }
  for (const token of PROSE_SAFE_TOKENS) {
    if (new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(text)) found.add(token);
  }
  return [...found];
}

/**
 * @param {string} raw reviewer output
 * @returns {object|null} parsed JSON document, or null when none is present
 */
function extractJsonDocument(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed);
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
    } catch {
      // not a bare JSON document — fall through to the fenced-block attempt
    }
  }
  const fence = /```(?:json)?\s*\r?\n([\s\S]*?)```/gi;
  let m = fence.exec(raw);
  while (m !== null) {
    try {
      const doc = JSON.parse(m[1]);
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
    } catch {
      // this fenced block is not JSON — try the next one
    }
    m = fence.exec(raw);
  }
  return null;
}

/**
 * Every JSON object a reviewer's answer contains: the whole string when it is
 * itself one JSON document, plus the body of every fenced block that parses.
 *
 * Separate from {@link extractJsonDocument}, which returns the FIRST match and
 * whose signature is unchanged. Two differences matter and both are deliberate:
 *
 *  1. This one returns all of them, because "two blocks disagree" is a
 *     condition a first-wins reader cannot see.
 *  2. The fence scan is LINE-BASED rather than the regex
 *     `/```(?:json)?\s*\r?\n([\s\S]*?)```/g`. Measured 2026-09-05: given a
 *     bash block followed by a JSON block, that regex pairs the bash block's
 *     CLOSING fence with the JSON block's opening one, yields a single empty
 *     body, and never sees the JSON. A reader built on it would silently find
 *     one document where there are two.
 *
 * @param {string} raw reviewer output
 * @returns {object[]} parsed JSON objects, in document order
 */
function extractJsonDocuments(raw) {
  const docs = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed);
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) docs.push(doc);
    } catch {
      // not one bare document — the fenced blocks below are the other shape
    }
  }
  const lines = raw.split(/\r?\n/);
  let body = null;
  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    if (body === null) {
      if (isFence) body = [];
      continue;
    }
    if (isFence) {
      try {
        const doc = JSON.parse(body.join('\n'));
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) docs.push(doc);
      } catch {
        // this block is prose, a diff, or a shell transcript — not a document
      }
      body = null;
      continue;
    }
    body.push(line);
  }
  return docs;
}

/**
 * Structural gate for a `schema_version: 2` document.
 *
 * Runs unconditionally, so a caller without an ajv-backed validator still gets
 * a fail-closed answer instead of a free pass. It checks presence, coarse type,
 * the verdict enum, the mission id pattern, and the `minItems: 1` evidence
 * arrays.
 *
 * **What this check does not see**: the conditional `suggestion` requirement on
 * critical/high findings, the `kind`-dependent requirements inside an evidence
 * entry, and `additionalProperties:false`. Those are exactly why the
 * `validateSchema` port exists — a document that passes here is not thereby
 * schema-valid.
 *
 * @param {object} doc candidate v2 document
 * @returns {{code: string, message: string, path?: string}[]} structural errors
 */
function checkV2Structure(doc) {
  const errors = [];
  for (const field of V2_REQUIRED_FIELDS) {
    if (!has(doc, field)) {
      errors.push({
        code: 'missing_required',
        message: `missing required field: ${field}`,
        path: field,
      });
    }
  }
  const bad = (p, message) => errors.push({ code: 'invalid_field', message, path: p });

  if (has(doc, 'verdict') && !CANONICAL_VERDICTS.includes(doc.verdict)) {
    errors.push({
      code: 'verdict_not_canonical',
      message: `verdict is not one of the five canonical values: ${String(doc.verdict)}`,
      path: 'verdict',
    });
  }
  if (has(doc, 'findings') && !Array.isArray(doc.findings)) {
    bad('findings', 'findings must be an array');
  }
  for (const field of ['evidence', 'test_evidence', 'regression_evidence']) {
    if (has(doc, field) && !isNonEmptyArray(doc[field])) {
      bad(field, `${field} must be a non-empty array (minItems 1)`);
    }
  }
  if (has(doc, 'next_steps') && !Array.isArray(doc.next_steps)) {
    bad('next_steps', 'next_steps must be an array');
  }
  for (const field of ['recommended_action', 'diff_ref', 'verification_id']) {
    if (has(doc, field) && !isNonEmptyString(doc[field])) {
      bad(field, `${field} must be a non-empty string`);
    }
  }
  if (has(doc, 'mission_id')
    && !(isNonEmptyString(doc.mission_id) && MISSION_ID_PATTERN.test(doc.mission_id))) {
    bad('mission_id', `mission_id does not match ${MISSION_ID_PATTERN.source}`);
  }
  for (const field of ['intent_revision', 'plan_revision']) {
    if (has(doc, field) && !(Number.isInteger(doc[field]) && doc[field] >= 0)) {
      bad(field, `${field} must be an integer >= 0`);
    }
  }
  return errors;
}

/**
 * Normalize a result, keeping `verdict` null whenever `ok` is false so no
 * caller can read an inadmissible answer as a verdict.
 *
 * @param {object} base partial result
 * @returns {object} normalized result
 */
function result(base) {
  const out = {
    ok: base.ok === true,
    verdict: base.ok === true ? base.verdict : null,
    errors: base.errors ?? [],
    schemaVersion: base.schemaVersion ?? null,
    foldedVerdict: base.foldedVerdict ?? null,
    sources: base.sources ?? [],
  };
  if (base.ambiguous === true) {
    out.ambiguous = true;
    out.candidates = base.candidates ?? [];
  }
  return out;
}

/**
 * Run the optional schema-validator port, folding its outcome into `errors`.
 *
 * @param {object} doc candidate document
 * @param {(d: object) => {ok: boolean, errors?: unknown[]}} validateSchema port
 * @param {object[]} errors error list, appended in place
 * @returns {void}
 */
function applyValidatorPort(doc, validateSchema, errors) {
  let portResult;
  try {
    portResult = validateSchema(doc);
  } catch (err) {
    errors.push({
      code: 'port_threw',
      message: `validateSchema threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  if (!portResult || portResult.ok !== true) {
    errors.push({
      code: 'port_rejected',
      message: 'injected schema validator rejected the document',
      detail: portResult?.errors ?? null,
    });
  }
}

/**
 * Read a reviewer's answer and decide whether it is an admissible verdict.
 *
 * `ok:true` means the input parsed as a `schema_version: 2` document and
 * satisfied the v2 contract (and the injected validator, when one was given).
 * Nothing else earns `ok:true`. A legacy-vocabulary answer is `ok:false`: its
 * folded value is reported as `foldedVerdict` for Observe-phase measurement and
 * is not a verdict the pipeline may act on.
 *
 * @param {string|object} textOrJson reviewer output: an object, a JSON string,
 *   markdown with a fenced JSON block, or free text carrying a verdict token
 * @param {object} [opts] options
 * @param {(doc: object) => {ok: boolean, errors?: unknown[]}} [opts.validateSchema]
 *   optional JSON-Schema validator port for the v2 definition
 * @returns {{ok: boolean, verdict: string|null, errors: object[],
 *   schemaVersion: number|null, foldedVerdict: string|null, sources: string[],
 *   ambiguous?: true, candidates?: string[]}} parse outcome
 */
export function parseReviewVerdict(textOrJson, opts = {}) {
  const { validateSchema } = opts && typeof opts === 'object' ? opts : {};

  let doc;
  let text = '';
  if (textOrJson && typeof textOrJson === 'object' && !Array.isArray(textOrJson)) {
    doc = textOrJson;
  } else if (typeof textOrJson === 'string' && textOrJson.trim() !== '') {
    text = textOrJson;
    doc = extractJsonDocument(textOrJson);
  } else {
    return result({
      ok: false,
      errors: [{
        code: 'not_parseable',
        message: 'input is neither an object nor a non-empty string',
      }],
    });
  }

  // ── v2 path ─────────────────────────────────────────────────────────────
  if (doc !== null && doc.schema_version === 2) {
    const errors = checkV2Structure(doc);
    if (typeof validateSchema === 'function') applyValidatorPort(doc, validateSchema, errors);
    if (errors.length > 0) return result({ ok: false, errors, schemaVersion: 2 });
    return result({ ok: true, verdict: doc.verdict, schemaVersion: 2, sources: ['v2'] });
  }

  // ── legacy path ─────────────────────────────────────────────────────────
  const schemaVersion = doc !== null ? (doc.schema_version ?? null) : null;
  const tokens = doc !== null && isNonEmptyString(doc.verdict)
    ? [doc.verdict]
    : extractTokens(text);

  if (tokens.length === 0) {
    return result({
      ok: false,
      schemaVersion,
      errors: [{
        code: 'no_verdict_token',
        message: 'no verdict token found. Lowercase prose words are not read as verdicts.',
      }],
    });
  }

  const folds = tokens.map((t) => ({ token: t, ...foldLegacyToken(t) }));
  const mapped = folds.filter((f) => f.found);
  if (mapped.length === 0) {
    return result({
      ok: false,
      schemaVersion,
      errors: [{
        code: 'unmapped_token',
        message: `unknown verdict token(s): ${folds.map((f) => f.token).join(', ')}. `
          + 'An unknown token is rejected, never downgraded to PASS.',
      }],
    });
  }

  const ambiguousFolds = mapped.filter((f) => f.ambiguous);
  if (ambiguousFolds.length > 0) {
    return result({
      ok: false,
      schemaVersion,
      ambiguous: true,
      candidates: [...new Set(ambiguousFolds.flatMap((f) => f.candidates))],
      sources: [...new Set(ambiguousFolds.flatMap((f) => f.sources))],
      errors: [{
        code: 'ambiguous_token',
        message: `${ambiguousFolds.map((f) => f.token).join(', ')} does not determine a verdict; `
          + 'a human resolves it. The adapter does not guess.',
      }],
    });
  }

  const distinct = [...new Set(mapped.map((f) => f.verdict))];
  if (distinct.length > 1) {
    return result({
      ok: false,
      schemaVersion,
      sources: [...new Set(mapped.flatMap((f) => f.sources))],
      errors: [{
        code: 'multiple_tokens',
        message: `conflicting verdict tokens: ${mapped.map((f) => f.token).join(', ')}`,
      }],
    });
  }

  return result({
    ok: false,
    schemaVersion,
    foldedVerdict: distinct[0],
    sources: [...new Set(mapped.flatMap((f) => f.sources))],
    errors: [{
      code: 'legacy_document',
      message: `legacy vocabulary folded to ${distinct[0]}, but the document is not a `
        + 'schema_version 2 review. Not admissible as a verdict.',
    }],
  });
}

/**
 * Normalize a claim-audit result. Every payload field is null (and
 * `evidence_refs` empty) whenever `ok` is false, so a rejected document cannot
 * hand a caller a number it might aggregate. The counterpart of {@link result}
 * for the verdict path, kept separate because the two carry different fields
 * and one shared normalizer would have to guess which shape it was given.
 *
 * @param {object} base partial result
 * @returns {object} normalized result with a fixed key set
 */
function claimResult(base) {
  const ok = base.ok === true;
  const pick = (k) => (ok ? base[k] ?? null : null);
  return {
    ok,
    claims_total: pick('claims_total'),
    claims_refuted: pick('claims_refuted'),
    nature: pick('nature'),
    subject_agent_type: pick('subject_agent_type'),
    subject_model: pick('subject_model'),
    subject_agent_id: pick('subject_agent_id'),
    evidence_refs: ok ? base.evidence_refs ?? [] : [],
    errors: base.errors ?? [],
  };
}

/**
 * Key-order-independent identity for two claim_audit blocks.
 *
 * @param {unknown} value any JSON value
 * @returns {string} a canonical serialization
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * @param {unknown} v value to test
 * @returns {boolean} true when `v` is an integer >= 0
 */
function isCount(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * Read the refutation count out of a reviewer's answer.
 *
 * Feeds the measurement of `DESIGN-MODEL-POLICY-role-override.md` §4.1 — how
 * many of a worker's claims a review overturned — whose numerator is
 * `claims_refuted`, denominator `claims_total`, and strata are subject model ×
 * `nature` × agent definition. The parsed block is appended to the central
 * ledger as `review.claim_audit` (§4.2 option (iii), owner decision MP-4).
 *
 * ── Why this is a SECOND document, not a field of the verdict ──────────────
 * `schemas/review-output.schema.json#definitions.reviewOutputV2` declares
 * `additionalProperties: false`, so a `claim_audit` key inside a v2 verdict
 * would make that verdict schema-invalid. The two blocks therefore travel side
 * by side in one answer and are read by two functions.
 *
 * ── Fail-closed, on the same terms as `parseReviewVerdict` ─────────────────
 * `ok:true` requires a `claim_audit` object with a subject agent type and both
 * counts, present and integral. Everything else returns `ok:false` with every
 * payload field null. In particular a numerator with no denominator is NOT
 * "zero refutations": §4.1 says the numerator alone is not used, and `0`
 * arriving where a denominator was never counted is exactly the shape that
 * reads as a clean report.
 *
 * Two fields may legitimately be absent and parse to `null` instead of failing:
 *  - `nature`, when the leader did not tag the report. §4.4 #4 keeps it null
 *    and drops the row from the denominator rather than guessing a stratum.
 *  - `subject_model`, which cannot be known before the L2 D1 route-receipt
 *    bind lands (SubagentStart carries no model, 설계 §1.3). Absent means
 *    absent; this function never substitutes the reviewer's own tier.
 *
 * ── What it cannot check ───────────────────────────────────────────────────
 * Whether the counting rule of §4.4 #2 was applied — one file:line citation =
 * 1 claim, one number = 1 claim, one judgement sentence = 1 claim. A
 * well-formed block with an invented `claims_total` is `ok:true` here. This
 * function judges a document's shape, exactly as `parseReviewVerdict` does.
 *
 * @param {string|object} textOrJson reviewer output: an object carrying
 *   `claim_audit`, a JSON string, or markdown with a fenced JSON block
 * @returns {{ok: boolean, claims_total: number|null, claims_refuted: number|null,
 *   nature: string|null, subject_agent_type: string|null,
 *   subject_model: string|null, subject_agent_id: string|null,
 *   evidence_refs: unknown[], errors: object[]}} parse outcome
 */
export function parseClaimAudit(textOrJson) {
  let candidates;
  if (textOrJson && typeof textOrJson === 'object' && !Array.isArray(textOrJson)) {
    candidates = [textOrJson];
  } else if (typeof textOrJson === 'string' && textOrJson.trim() !== '') {
    candidates = extractJsonDocuments(textOrJson);
  } else {
    return claimResult({
      ok: false,
      errors: [{
        code: 'not_parseable',
        message: 'input is neither an object nor a non-empty string',
      }],
    });
  }

  const carriers = candidates.filter((d) => has(d, 'claim_audit'));
  if (carriers.length === 0) {
    return claimResult({
      ok: false,
      errors: [{
        code: 'no_claim_audit',
        message: 'no claim_audit block found. A report with no audit block is '
          + 'not an audit of zero claims.',
      }],
    });
  }
  const distinct = [...new Set(carriers.map((d) => stableStringify(d.claim_audit)))];
  if (distinct.length > 1) {
    return claimResult({
      ok: false,
      errors: [{
        code: 'ambiguous_claim_audit',
        message: `${distinct.length} different claim_audit blocks in one answer; `
          + 'a human resolves it. The parser does not pick one.',
      }],
    });
  }

  const block = carriers[0].claim_audit;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return claimResult({
      ok: false,
      errors: [{
        code: 'invalid_field',
        message: 'claim_audit must be an object',
        path: 'claim_audit',
      }],
    });
  }

  const errors = [];
  const bad = (at, message) => errors.push({ code: 'invalid_field', message, path: at });

  if (!isCount(block.claims_total)) {
    bad('claims_total', 'claims_total must be an integer >= 0. A numerator with no '
      + 'counted denominator is not a measurement (설계 §4.1).');
  }
  if (!isCount(block.claims_refuted)) {
    bad('claims_refuted', 'claims_refuted must be an integer >= 0');
  }
  if (isCount(block.claims_total) && isCount(block.claims_refuted)
    && block.claims_refuted > block.claims_total) {
    bad('claims_refuted', `claims_refuted (${block.claims_refuted}) exceeds claims_total `
      + `(${block.claims_total})`);
  }
  if (!isNonEmptyString(block.subject_agent_type)) {
    bad('subject_agent_type', 'subject_agent_type must be a non-empty string — the ledger '
      + 'event requires it and it is the agent-definition stratum');
  }
  if (has(block, 'nature') && !CLAIM_NATURES.includes(block.nature)) {
    bad('nature', `nature must be one of ${CLAIM_NATURES.join('|')} when present; `
      + 'omit the key entirely for an untagged report (설계 §4.4 #4)');
  }
  if (has(block, 'subject_model') && !isNonEmptyString(block.subject_model)) {
    bad('subject_model', 'subject_model must be a non-empty string when present; omit the '
      + 'key until the L2 D1 route-receipt bind can fill it');
  }
  if (has(block, 'subject_agent_id') && !isNonEmptyString(block.subject_agent_id)) {
    bad('subject_agent_id', 'subject_agent_id must be a non-empty string when present');
  }
  if (has(block, 'evidence_refs') && !Array.isArray(block.evidence_refs)) {
    bad('evidence_refs', 'evidence_refs must be an array');
  }

  if (errors.length > 0) return claimResult({ ok: false, errors });

  return claimResult({
    ok: true,
    claims_total: block.claims_total,
    claims_refuted: block.claims_refuted,
    nature: has(block, 'nature') ? block.nature : null,
    subject_agent_type: block.subject_agent_type,
    subject_model: has(block, 'subject_model') ? block.subject_model : null,
    subject_agent_id: has(block, 'subject_agent_id') ? block.subject_agent_id : null,
    evidence_refs: has(block, 'evidence_refs') ? block.evidence_refs : [],
  });
}

/**
 * The builder may not be the final reviewer.
 *
 * Fail-closed on absence: an id that is missing or blank yields `ok:false`,
 * because independence that cannot be shown has not been shown. Comparison is
 * case-insensitive and whitespace-trimmed, which errs toward calling two ids
 * the same.
 *
 * ── The gap this function cannot close ─────────────────────────────────────
 * `builderId` is meant to come from the spawn ledger
 * (`.artibot/ledger/spawns.ndjson`, read by
 * `lib/learning/ledger/spawn-ledger.js#readSpawns` — an L3 module, so the
 * caller reads it and passes the id in). Measured 2026-09-02: a spawn record
 * carries `{ts, sessionId, agentId, agentName, agentType, requestedModel,
 * canonicalModel, modelMismatch, event, durationMs?}` (that file's module
 * header and its `normalizeRecord`) and has **no mission, task, or work-item
 * key**. The ledger can say which agents ran in a session, not which one
 * produced the artifact under review. Until a join key exists — that file is
 * owned by T-31 — `builderId` is caller-asserted, and this check is only as
 * good as that assertion.
 *
 * @param {object} [args] ids to compare
 * @param {string} [args.builderId] agent id that produced the work
 * @param {string} [args.reviewerId] agent id asked to review it
 * @returns {{ok: boolean, reason: string|null}} independence judgement
 */
export function assertIndependence({ builderId, reviewerId } = {}) {
  if (!isNonEmptyString(builderId)) {
    return { ok: false, reason: 'builderId is missing; independence cannot be established' };
  }
  if (!isNonEmptyString(reviewerId)) {
    return { ok: false, reason: 'reviewerId is missing; independence cannot be established' };
  }
  if (builderId.trim().toLowerCase() === reviewerId.trim().toLowerCase()) {
    return { ok: false, reason: `builder and reviewer are the same agent: ${builderId.trim()}` };
  }
  return { ok: true, reason: null };
}

/**
 * Re-check, at review completion, that the intent has not moved underneath the
 * review.
 *
 * A verdict is formed against one revision of `intent.md`. If the file was
 * revised while the review ran, the verdict answers a question nobody is asking
 * any more, and it is void — not a `PASS`, not a `REPAIR_REQUIRED`.
 *
 * @param {object} [args] binding inputs
 * @param {string} [args.missionDir] mission folder
 * @param {number} [args.reviewedRevision] `intent_revision` the verdict was formed against
 * @param {(p: string) => string|Promise<string>} [args.readFile] file-read port
 * @returns {Promise<{ok: boolean, reason: string|null, currentRevision: number|null,
 *   reviewedRevision: number|null}>} binding judgement
 */
export async function assertIntentBinding({ missionDir, reviewedRevision, readFile } = {}) {
  const reviewed = toRevision(reviewedRevision);
  if (!isNonEmptyString(missionDir)) {
    return {
      ok: false,
      reason: 'missionDir is required',
      currentRevision: null,
      reviewedRevision: reviewed,
    };
  }
  if (typeof readFile !== 'function') {
    return {
      ok: false,
      reason: 'readFile port is required',
      currentRevision: null,
      reviewedRevision: reviewed,
    };
  }
  if (reviewed === null) {
    return {
      ok: false,
      reason: 'reviewedRevision is missing or not a non-negative integer',
      currentRevision: null,
      reviewedRevision: null,
    };
  }
  let current;
  try {
    current = (await readCanonicalIntent(missionDir, readFile)).intentRevision;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof ReviewContractError
        ? `canonical intent unreadable at review completion: ${err.code}`
        : `canonical intent unreadable at review completion: ${String(err)}`,
      currentRevision: null,
      reviewedRevision: reviewed,
    };
  }
  if (current !== reviewed) {
    return {
      ok: false,
      reason: `intent was revised during review: reviewed r${reviewed}, on disk r${current}. `
        + 'The verdict is void.',
      currentRevision: current,
      reviewedRevision: reviewed,
    };
  }
  return { ok: true, reason: null, currentRevision: current, reviewedRevision: reviewed };
}
