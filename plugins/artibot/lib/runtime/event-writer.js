/**
 * Central run-ledger event writer — envelope assembly, vocabulary allowlist,
 * per-line byte cap, secret redaction, and the single append primitive.
 *
 * ONE physical ledger of record (design ARTIBOT-5.0-DESIGN.md §3.6; lane 6
 * §2.1/§5-①):
 *
 *   <projectRoot>/.artibot/runtime/ledger.jsonl   — one JSON object per line
 *
 * `projectRoot` is INJECTED, never derived here. `pluginRoot` also has a
 * `runtime/` directory, so the leading `.artibot/` in the configured path is
 * load-bearing and a writer that guessed its own root would write to the wrong
 * tree (§3.6 operating clause 10).
 *
 * Four guarantees, in the order they run:
 *
 *  1. ENVELOPE — `{v, ts, event, mission_id, session_id, source, pid, seq, …}`
 *     assembled here so no caller can invent a field. `mission_id` is REQUIRED
 *     on every line; with no caller-supplied one the session fallback
 *     `M-<YYYYMMDD>-S<sid8>` is synthesized (lane 6 §2.5). The shape is
 *     schemas/ledger-envelope.schema.json, which is `additionalProperties:
 *     false` — an unknown top-level key is REJECTED, not dropped, because
 *     dropping is the silent pass this layer exists to prevent.
 *
 *  2a. RECEIPT SCHEMA — the three events that carry a `data_schema`
 *     (`route.selected`, `context.compiled`, `usage.receipt`) have their whole
 *     `data` object validated against that sibling schema, and a receipt that
 *     repeats `mission_id` or `session_id` must repeat the ENVELOPE's value.
 *     The validator is hand-rolled over a keyword subset rather than ajv;
 *     `./ledger-schema.js` carries the dependency measurement behind that
 *     choice and the list of keywords it knowingly does not run.
 *
 *  2. ALLOWLIST — schemas/ledger-events.allowlist.json is the single source of
 *     truth for the vocabulary, and it is an ALLOWLIST, not a denylist: a
 *     denylist is fail-open for every event name invented later
 *     (verification-discipline §8). An unregistered — or registered but
 *     contract-violating — event is NOT appended. A `ledger.rejected` line is
 *     appended in its place, so the rejection is recorded rather than silent
 *     (design §3.6 "미등록 event 는 ledger.rejected 로 기록 후 무시").
 *
 *  3. BYTE CAP — `Buffer.byteLength(line, 'utf8')` measured BEFORE the append.
 *     JSON Schema cannot measure the serialized length of the document
 *     validating against it, which is why the cap lives here. Over the cap the
 *     non-required `data` keys are folded away behind an `evidence_refs`
 *     marker (§3.6); a line that still does not fit is rejected. The cap also
 *     protects the concurrency guarantee below.
 *
 *  4. REDACTION — every STRING FIELD is scrubbed before serialization, never
 *     the serialized line, and the walk carries cycle and depth guards so
 *     caller-supplied `data` cannot overflow the stack. `./ledger-redaction.js`
 *     holds both, and the reasoning for each.
 *
 * CONCURRENCY — no lock, and no read-modify-write, ever. One line is one
 * `appendFileSync` with the `'a'` flag, which structurally removes the
 * lost-update class that costs decision-trail.js 21 of 60 lines across
 * processes (lane 6 §0 row 3, §2.8). A small write is not split, which is what
 * the 4 KB cap buys; tests/firewall/ledger-append-survival.test.js fixes that
 * as a measurement rather than an inference. Duplicates and gaps are judged BY
 * THE READER on `(session_id, source, pid, seq)` (`ledger.js#dedupeKey`) — the
 * writer never reads the file it appends to.
 *
 * LAYERING: this module is L5; importing L3 and L2 is downward and allowed.
 *
 * NEVER THROWS, AND THAT IS ENFORCED, NOT ASSERTED. `writeEvent` wraps its
 * whole body in a catch that turns any escaped exception into
 * `{ok:false, reason:'writer-exception:<name>'}`, and `redactDeep` carries its
 * own cycle and depth guards so the common way to reach that catch is closed at
 * the source. `ledger.js#appendLedgerEvent` delegates here and inherits both.
 *
 * OBSERVE STAGE — Phase 0 ships this with ZERO callers: it records, and
 * changes no behavior.
 *
 * @module lib/runtime/event-writer
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readClock } from '../core/clock.js';
import { SOURCES } from '../supervisor/event-types.js';
import { redactDeep, UNSAFE_KEYS } from './ledger-redaction.js';
import {
  foldDeclaredEnums,
  matchesType,
  validateAgainstSchema,
} from './ledger-schema.js';

// Re-exported so the writer stays the single import surface for the ledger's
// validation vocabulary; the implementation lives in ledger-schema.js.
export {
  ENUM_CASE_FOLD,
  UNCHECKED_SCHEMA_KEYWORDS,
  validateAgainstSchema,
} from './ledger-schema.js';
export {
  BUDGET_MARKER,
  CIRCULAR_MARKER,
  DEPTH_MARKER,
  MAX_REDACT_DEPTH,
  MAX_REDACT_NODES,
  redactDeep,
} from './ledger-redaction.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Envelope schema version emitted by Phase 0. */
export const ENVELOPE_VERSION = 1;

/** Ledger path relative to <projectRoot>. Fallback when config is unreadable. */
export const DEFAULT_LEDGER_REL = path.join('.artibot', 'runtime', 'ledger.jsonl');

/** Per-line byte cap. Fallback when neither config nor allowlist is readable. */
export const DEFAULT_LINE_MAX_BYTES = 4096;

/** Envelope keys that must be present on every line. */
export const REQUIRED_ENVELOPE_KEYS = Object.freeze([
  'v', 'ts', 'event', 'mission_id', 'session_id', 'source', 'pid', 'seq',
]);

/**
 * Envelope keys that MAY be present. The union with the required keys is the
 * closed set: `ledger-envelope.schema.json` is `additionalProperties:false`,
 * so anything outside it is a rejection, not a silent drop.
 */
export const OPTIONAL_ENVELOPE_KEYS = Object.freeze([
  'action_id', 'task_id', 'run_id', 'routing_epoch_id', 'idempotency_key',
  'worker', 'model', 'actor', 'data',
]);

const ALLOWED_ENVELOPE_KEYS = new Set([
  ...REQUIRED_ENVELOPE_KEYS, ...OPTIONAL_ENVELOPE_KEYS,
]);

/**
 * Copies of the three `pattern` strings in
 * schemas/ledger-envelope.schema.json. They are copies because this module
 * validates without a JSON Schema engine, and a copy is a thing that drifts:
 * a widened schema pattern with an unchanged regex here rejects lines the
 * schema now allows, silently and only in production.
 *
 * EXPORTED SO THE DRIFT IS TESTABLE. tests/firewall/ledger-vocab-allowlist.js
 * compares each `.source` against the schema string it copies, so the two
 * cannot diverge without a red gate.
 */
export const MISSION_ID_RE = /^M-\d{8}-(?:\d{3,}|S[0-9A-Za-z]{8})$/;
export const EVENT_RE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;
export const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/;

/** The one event the rejection path may write. Never rejected recursively. */
export const REJECTED_EVENT = 'ledger.rejected';

const PLUGIN_ROOT_URL = new URL('../../', import.meta.url);

// ---------------------------------------------------------------------------
// Cached JSON sources (allowlist, config, receipt schemas)
// ---------------------------------------------------------------------------

/** @type {Map<string, object|null>} */
const jsonCache = new Map();

/**
 * Read and cache a JSON file under the plugin root. Never throws — an
 * unreadable source degrades to `null` and the caller falls back to a
 * hardcoded default, because a writer that throws takes its caller down.
 *
 * @param {string} rel POSIX-style path relative to the plugin root
 * @returns {object|null}
 */
function readPluginJson(rel) {
  if (jsonCache.has(rel)) return jsonCache.get(rel);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(new URL(rel, PLUGIN_ROOT_URL), 'utf-8'));
  } catch {
    parsed = null;
  }
  jsonCache.set(rel, parsed);
  return parsed;
}

/**
 * Drop every cached JSON source. Test seam.
 * @returns {void}
 */
export function resetSources() {
  jsonCache.clear();
}

/**
 * The event vocabulary allowlist (single source of truth).
 * @returns {{events: object, enums: object, limits: object}}
 */
export function getAllowlist() {
  const raw = readPluginJson('schemas/ledger-events.allowlist.json');
  return {
    events: raw?.events && typeof raw.events === 'object' ? raw.events : {},
    enums: raw?.enums && typeof raw.enums === 'object' ? raw.enums : {},
    limits: raw?.limits && typeof raw.limits === 'object' ? raw.limits : {},
  };
}

/**
 * Resolved ledger settings.
 *
 * PRECEDENCE — explicit option > `artibot.config.json#/ledger` > the
 * allowlist's `limits.line_max_bytes` > the hardcoded default. Two files state
 * the cap; config wins because it is the operator knob, and the allowlist
 * supplies the value when config is absent. Both read 4096 today, so the order
 * is a tie-break rule rather than an observed difference — and the vocabulary
 * gate fails if the two ever disagree.
 *
 * @param {{ledgerPath?: string, maxLineBytes?: number}} [opts]
 * @returns {{rel: string, maxLineBytes: number}}
 */
export function getLedgerSettings(opts = {}) {
  const cfg = readPluginJson('artibot.config.json')?.ledger;
  const rel = typeof opts.ledgerPath === 'string' && opts.ledgerPath.length > 0
    ? opts.ledgerPath
    : (typeof cfg?.path === 'string' && cfg.path.length > 0 ? cfg.path : DEFAULT_LEDGER_REL);
  const candidates = [
    opts.maxLineBytes,
    cfg?.maxLineBytes,
    getAllowlist().limits?.line_max_bytes,
    DEFAULT_LINE_MAX_BYTES,
  ];
  const maxLineBytes = candidates.find((n) => Number.isFinite(n) && n > 0);
  return { rel, maxLineBytes };
}

/**
 * Absolute ledger file path for a project root.
 * @param {string} projectRoot
 * @param {{ledgerPath?: string}} [opts]
 * @returns {string}
 */
export function ledgerFilePath(projectRoot, opts = {}) {
  return path.join(projectRoot, getLedgerSettings(opts).rel);
}

/**
 * The schema named by an event's `data_schema` — for the three receipt events,
 * that schema IS the contract for the whole `data` object.
 *
 * @param {string} file schema file name, e.g. 'route-receipt.schema.json'
 * @returns {object|null} null when the file is missing or unparseable
 */
function dataSchema(file) {
  return readPluginJson(`schemas/${file}`);
}

/**
 * Top-level `required` of a receipt schema.
 * @param {string} file
 * @returns {string[]}
 */
function dataSchemaRequired(file) {
  const req = dataSchema(file)?.required;
  return Array.isArray(req) ? req : [];
}

// ---------------------------------------------------------------------------
// Sequence counter
// ---------------------------------------------------------------------------

let seqCounter = 0;

/**
 * Next per-process sequence number. Monotonic from 0, never reused, and never
 * coordinated across processes.
 *
 * That is exactly why the reader's dedupe key is
 * `(session_id, source, pid, seq)` and not the three fields alone: a counter
 * each process owns restarts at 0 in the next one, so a reused pid would make
 * a later line collide with an older one. `lib/runtime/ledger.js#dedupeKey` is
 * the single definition.
 *
 * @returns {number}
 */
export function nextSeq() {
  const n = seqCounter;
  seqCounter += 1;
  return n;
}

/**
 * Reset the per-process counter. Test seam.
 * @returns {void}
 */
export function resetSeq() {
  seqCounter = 0;
}

// ---------------------------------------------------------------------------
// mission_id
// ---------------------------------------------------------------------------

/**
 * UTC date part of an ISO timestamp, as YYYYMMDD.
 * @param {string} ts
 * @returns {string}
 */
function utcDatePart(ts) {
  const d = new Date(ts);
  const use = Number.isFinite(d.getTime()) ? d : new Date();
  return use.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Session fallback mission id `M-<YYYYMMDD>-S<sid8>` (lane 6 §2.5), used when
 * the substantive-mission gate issues no mission but the ledger still requires
 * a `mission_id` on every line.
 *
 * `sid8` is the session id's first 8 alphanumeric characters. When the id
 * yields fewer than 8, a sha256 prefix of the whole id is used instead: the
 * envelope pattern demands exactly 8 alphanumerics, and padding would collide
 * two short ids onto one mission. Both branches are deterministic, so the same
 * session always folds to the same id.
 *
 * @param {string} sessionId
 * @param {string|Date} [when] timestamp the date part is taken from
 * @returns {string|null} null when sessionId is unusable
 */
export function sessionFallbackMissionId(sessionId, when) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const ts = when instanceof Date ? when.toISOString() : (when ?? new Date().toISOString());
  const alnum = sessionId.replace(/[^0-9A-Za-z]/g, '');
  const sid8 = alnum.length >= 8
    ? alnum.slice(0, 8)
    : createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  return `M-${utcDatePart(ts)}-S${sid8}`;
}

// ---------------------------------------------------------------------------
// Envelope assembly
// ---------------------------------------------------------------------------

/**
 * Assemble one envelope. Pure: no I/O, no validation, no append. The caller's
 * unknown keys are carried through UNCHANGED so `validateEnvelope` can reject
 * them — stripping here would hide the caller's mistake.
 *
 * THE CLOCK IS A PORT, AND A WRONG ONE IS REFUSED. `opts.now` goes through
 * `lib/core/clock.js#readClock`, whose contract is `() => Date` and nothing
 * else. This module used to accept a non-function `now` and quietly fall back
 * to the wall clock, which meant a test believing it had injected a fixed
 * clock could be reading real time with no signal that it was. A misspelled
 * port is a wiring defect in the caller, so it now surfaces: readClock throws
 * a labelled TypeError and {@link writeEvent}'s catch returns
 * `{ok:false, reason:'writer-exception:TypeError'}`. Nothing throws out.
 *
 * A caller-supplied `ts` short-circuits the clock entirely, so a malformed
 * `now` alongside an explicit `ts` is never consulted and never complained
 * about — the clock is only judged when it is actually read.
 *
 * @param {object} input caller fields (`event` and `session_id` at minimum)
 * @param {{now?: () => Date, seq?: number, pid?: number}} [opts]
 * @returns {object} envelope
 * @throws {TypeError} via readClock when `opts.now` is present but not
 *   `() => Date`. Callers reach this only through `writeEvent`, which catches.
 */
export function buildEnvelope(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const ts = typeof src.ts === 'string' && src.ts.length > 0
    ? src.ts
    : readClock(opts.now, 'event-writer');
  const missionId = typeof src.mission_id === 'string' && src.mission_id.length > 0
    ? src.mission_id
    : sessionFallbackMissionId(src.session_id, ts);
  const env = {
    v: ENVELOPE_VERSION,
    ts,
    event: src.event,
    session_id: src.session_id,
    source: src.source,
    pid: Number.isInteger(opts.pid) ? opts.pid : process.pid,
    seq: Number.isInteger(opts.seq) ? opts.seq : nextSeq(),
  };
  if (missionId !== null) env.mission_id = missionId;
  for (const key of Object.keys(src)) {
    if (REQUIRED_ENVELOPE_KEYS.includes(key) || UNSAFE_KEYS.has(key)) continue;
    if (src[key] === undefined) continue;
    env[key] = src[key];
  }
  return env;
}

// ---------------------------------------------------------------------------
// Validation — envelope layer
// ---------------------------------------------------------------------------

/**
 * Validate the envelope against ledger-envelope.schema.json's constraints.
 * Returns a short machine-readable reason, or null when the envelope is valid.
 *
 * @param {object} env
 * @returns {string|null}
 */
export function validateEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return 'invalid-envelope:not-object';
  for (const key of Object.keys(env)) {
    if (!ALLOWED_ENVELOPE_KEYS.has(key)) return `unknown-envelope-key:${key}`;
  }
  if (!Number.isInteger(env.v) || env.v < 1) return 'invalid-envelope:v';
  if (typeof env.ts !== 'string' || !TS_RE.test(env.ts)) return 'invalid-envelope:ts';
  if (typeof env.event !== 'string' || !EVENT_RE.test(env.event)) return 'invalid-envelope:event';
  if (typeof env.mission_id !== 'string' || !MISSION_ID_RE.test(env.mission_id)) {
    return 'invalid-envelope:mission_id';
  }
  if (typeof env.session_id !== 'string' || env.session_id.length === 0) {
    return 'invalid-envelope:session_id';
  }
  if (!SOURCES.includes(env.source)) return 'invalid-envelope:source';
  if (!Number.isInteger(env.pid) || env.pid < 0) return 'invalid-envelope:pid';
  if (!Number.isInteger(env.seq) || env.seq < 0) return 'invalid-envelope:seq';
  if (env.data !== undefined
      && (typeof env.data !== 'object' || env.data === null || Array.isArray(env.data))) {
    return 'invalid-envelope:data';
  }
  return validateOptionalEnvelope(env);
}

/**
 * The optional envelope keys that carry their own constraints.
 * @param {object} env
 * @returns {string|null}
 */
function validateOptionalEnvelope(env) {
  const nonEmpty = [
    'action_id', 'task_id', 'run_id', 'routing_epoch_id',
    'idempotency_key', 'worker', 'model',
  ];
  for (const key of nonEmpty) {
    if (env[key] === undefined) continue;
    if (typeof env[key] !== 'string' || env[key].length === 0) return `invalid-envelope:${key}`;
  }
  if (env.actor === undefined) return null;
  const a = env.actor;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'invalid-envelope:actor';
  if (Object.keys(a).some((k) => k !== 'type' && k !== 'id')) return 'invalid-envelope:actor';
  if (!['human', 'agent', 'runtime'].includes(a.type)) return 'invalid-envelope:actor';
  if (typeof a.id !== 'string' || a.id.length === 0) return 'invalid-envelope:actor';
  return null;
}

// ---------------------------------------------------------------------------
// Validation — vocabulary layer
// ---------------------------------------------------------------------------

/**
 * The `data` keys an event must carry: its allowlist `required`, or — for the
 * three receipt events — the top-level `required` of the schema its
 * `data_schema` names, because for those the receipt schema IS the data
 * contract (T-15 ↔ T-16 leader ruling).
 *
 * @param {object} spec allowlist entry
 * @returns {string[]}
 */
function requiredDataKeys(spec) {
  if (typeof spec?.data_schema === 'string') return dataSchemaRequired(spec.data_schema);
  return Array.isArray(spec?.required) ? spec.required : [];
}

/**
 * Type and enum checks for declared `fields`. Presence is governed by
 * `required`; these apply only when the key is actually present.
 *
 * @param {object} data
 * @param {object} [fields]
 * @param {object} enums
 * @returns {string|null}
 */
function validateDeclaredFields(data, fields, enums) {
  if (!fields || typeof fields !== 'object') return null;
  for (const [key, decl] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    if (decl?.type !== undefined && !matchesType(data[key], decl.type)) {
      return `type-violation:${key}`;
    }
    if (typeof decl?.enum_ref === 'string') {
      const allowed = enums[decl.enum_ref];
      if (Array.isArray(allowed) && !allowed.includes(data[key])) {
        return `enum-violation:${key}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Receipt data
// ---------------------------------------------------------------------------

/**
 * Envelope keys a receipt may repeat inside its own `data`. Where BOTH carry a
 * value they must be the SAME value: one identity with two spellings is how a
 * receipt ends up attributed to the wrong mission. Checked only when both sides
 * are present, so this can never reject a receipt that merely omits a key.
 *
 * The design names `mission_id` and `session_id`; the other four are the
 * remaining keys the envelope and the receipt schemas both define, folded in
 * under the same rule because the argument for them is identical.
 */
export const RECEIPT_IDENTITY_FIELDS = Object.freeze([
  'mission_id', 'session_id', 'action_id', 'task_id', 'run_id', 'routing_epoch_id',
]);

/**
 * A receipt must not disagree with the envelope that carries it.
 * @param {object} env
 * @returns {string|null}
 */
function validateReceiptIdentity(env) {
  const data = env.data;
  if (!data || typeof data !== 'object') return null;
  for (const key of RECEIPT_IDENTITY_FIELDS) {
    if (data[key] === undefined || env[key] === undefined) continue;
    if (data[key] !== env[key]) return `receipt-identity-mismatch:${key}`;
  }
  return null;
}

/**
 * The whole `data_schema` path: schema readable, `data` satisfies it, and the
 * receipt's own identity fields agree with the envelope's.
 *
 * An unreadable schema is a REJECTION, not a pass. The alternative — validating
 * when the file happens to load and waving the line through when it does not —
 * makes the check depend on the filesystem, which is the shape of a gate that
 * goes green while measuring nothing.
 *
 * @param {object} env
 * @param {object} spec allowlist entry carrying `data_schema`
 * @returns {string|null}
 */
function validateReceipt(env, spec) {
  const schema = dataSchema(spec.data_schema);
  if (!schema) return `data-schema-unreadable:${spec.data_schema}`;
  const shape = validateAgainstSchema(env.data ?? {}, schema);
  if (shape) return `receipt-${shape}`;
  return validateReceiptIdentity(env);
}

/**
 * Return an envelope whose case-folded enum fields carry canonical spellings.
 * Thin wrapper: the rule and its rationale live in `./ledger-schema.js`, and
 * the allowlist is passed in so that module never imports back into this one.
 *
 * @param {object} env
 * @returns {object} the same object when nothing needed folding
 */
export function normalizeDeclaredEnums(env) {
  return foldDeclaredEnums(env, getAllowlist());
}

/**
 * Validate the event against its allowlist entry: membership, permitted
 * `sources`, mandatory envelope keys, required `data` keys, and declared field
 * types / enums. Fail-closed at every step.
 *
 * @param {object} env
 * @returns {string|null} rejection reason, or null when the contract holds
 */
export function validateEventContract(env) {
  const { events, enums } = getAllowlist();
  const spec = Object.prototype.hasOwnProperty.call(events, env.event) ? events[env.event] : null;
  if (!spec) return 'unregistered-event';
  if (Array.isArray(spec.sources) && !spec.sources.includes(env.source)) {
    return `source-not-allowed:${env.source}`;
  }
  for (const key of spec.required_envelope ?? []) {
    if (env[key] === undefined) return `missing-required-envelope:${key}`;
  }
  const data = env.data && typeof env.data === 'object' ? env.data : {};
  for (const key of requiredDataKeys(spec)) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) return `missing-required-data:${key}`;
  }
  if (typeof spec.data_schema === 'string') return validateReceipt(env, spec);
  return validateDeclaredFields(data, spec.fields, enums);
}

// ---------------------------------------------------------------------------
// Serialization and the byte cap
// ---------------------------------------------------------------------------

/**
 * Serialize one envelope to its ledger line, newline included.
 * @param {object} env
 * @returns {string}
 */
export function serializeLine(env) {
  return `${JSON.stringify(env)}\n`;
}

/**
 * Byte length of a serialized line, newline included — the quantity the cap is
 * measured against.
 * @param {object} env
 * @returns {number}
 */
export function lineBytes(env) {
  return Buffer.byteLength(serializeLine(env), 'utf8');
}

/** Cap on the fold marker so the marker itself cannot overflow the line. */
const FOLD_MARKER_MAX = 180;

/**
 * Fold an oversized line: drop every `data` key the event does not require and
 * leave a marker in `data.evidence_refs` naming what went, so the line records
 * that it was folded instead of silently shrinking (§3.6 "초과분은
 * evidence_refs 로"). The dropped content stays in whatever raw log produced
 * it; the ledger keeps the reference.
 *
 * NOT APPLIED to `data_schema` events. Those three receipt schemas are
 * `additionalProperties:false`, so injecting `evidence_refs` would produce a
 * line that violates its own contract — an oversized receipt is rejected
 * instead, which is the honest outcome.
 *
 * @param {object} env
 * @param {object} spec allowlist entry
 * @returns {{env: object, folded: boolean, dropped: string[]}}
 */
export function foldOversized(env, spec) {
  const data = env.data;
  if (typeof spec?.data_schema === 'string') return { env, folded: false, dropped: [] };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { env, folded: false, dropped: [] };
  }
  const keep = new Set([...requiredDataKeys(spec ?? {}), 'evidence_refs']);
  const dropped = Object.keys(data).filter((k) => !keep.has(k));
  if (dropped.length === 0) return { env, folded: false, dropped: [] };
  const nextData = {};
  for (const key of Object.keys(data)) {
    if (keep.has(key)) nextData[key] = data[key];
  }
  const refs = Array.isArray(nextData.evidence_refs) ? [...nextData.evidence_refs] : [];
  refs.push(`ledger-fold:dropped=${dropped.join(',')}`.slice(0, FOLD_MARKER_MAX));
  nextData.evidence_refs = refs;
  return { env: { ...env, data: nextData }, folded: true, dropped };
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * The one append primitive. `'a'` flag, one `appendFileSync` per line, no
 * lock, no read-modify-write.
 *
 * @param {string} file absolute ledger path
 * @param {string} line serialized line, newline included
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function appendLine(file, line) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, line, { encoding: 'utf-8', flag: 'a' });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.code || err?.message || 'append-failed' };
  }
}

/**
 * Append the `ledger.rejected` line that stands in for a refused event.
 *
 * The rejection path can never reject itself: a refused `ledger.rejected` is
 * dropped rather than retried, because a recursive rejection would fill the
 * ledger with the failure it is reporting. `recorded:false` says the rejection
 * itself could not be written — the one case where a refusal is silent, and
 * it is reported in the return value rather than hidden.
 *
 * @param {string} file
 * @param {object} env the refused envelope (for its identity fields)
 * @param {string} reason
 * @param {number} maxLineBytes
 * @returns {{ok: false, reason: string, rejected: true, recorded: boolean}}
 */
function writeRejection(file, env, reason, maxLineBytes) {
  const rawEvent = typeof env?.event === 'string' ? env.event : String(env?.event ?? '');
  if (rawEvent === REJECTED_EVENT) {
    return { ok: false, reason, rejected: true, recorded: false };
  }
  const missionId = typeof env?.mission_id === 'string' && MISSION_ID_RE.test(env.mission_id)
    ? env.mission_id
    : sessionFallbackMissionId(env?.session_id, env?.ts);
  const rejection = {
    v: ENVELOPE_VERSION,
    ts: typeof env?.ts === 'string' && TS_RE.test(env.ts) ? env.ts : new Date().toISOString(),
    event: REJECTED_EVENT,
    session_id: env?.session_id,
    source: SOURCES.includes(env?.source) ? env.source : 'gate',
    pid: process.pid,
    seq: nextSeq(),
    data: { raw_event: rawEvent.slice(0, 200), reason: reason.slice(0, 200) },
  };
  if (missionId !== null) rejection.mission_id = missionId;
  const line = serializeLine(rejection);
  if (validateEnvelope(rejection) !== null
      || Buffer.byteLength(line, 'utf8') > maxLineBytes) {
    return { ok: false, reason, rejected: true, recorded: false };
  }
  return { ok: false, reason, rejected: true, recorded: appendLine(file, line).ok === true };
}

/**
 * Append the validated envelope, folding once if it does not fit and rejecting
 * when even the folded line is over the cap.
 *
 * @param {string} file
 * @param {object} env validated, redacted envelope
 * @param {number} maxLineBytes
 * @returns {object} same result shape as {@link writeEvent}
 */
function appendWithinCap(file, env, maxLineBytes) {
  const spec = getAllowlist().events[env.event];
  let candidate = env;
  let folded = false;
  let dropped = [];
  if (lineBytes(candidate) > maxLineBytes) {
    const result = foldOversized(candidate, spec);
    candidate = result.env;
    folded = result.folded;
    dropped = result.dropped;
  }
  const bytes = lineBytes(candidate);
  if (bytes > maxLineBytes) {
    return { ...writeRejection(file, env, `line-too-large:${bytes}`, maxLineBytes), path: file };
  }
  const wrote = appendLine(file, serializeLine(candidate));
  if (!wrote.ok) return { ok: false, reason: wrote.reason, path: file };
  return {
    ok: true, path: file, event: candidate.event, seq: candidate.seq, bytes, folded, dropped,
  };
}

/**
 * Assemble, validate, redact, cap, and append one ledger event.
 *
 * NEVER THROWS. Every failure is a returned result, because the callers this
 * is built for are hooks and short-lived processes that must not be taken down
 * by their own bookkeeping.
 *
 * @param {string} projectRoot absolute project root (INJECTED — never derived)
 * @param {object} input caller fields; `event`, `session_id`, `source` at minimum
 * @param {{now?: () => Date, seq?: number, pid?: number, ledgerPath?: string,
 *          maxLineBytes?: number}} [opts]
 * @returns {{ok: true, path: string, event: string, seq: number, bytes: number,
 *            folded: boolean, dropped: string[]}
 *          | {ok: false, reason: string, rejected?: boolean, recorded?: boolean,
 *             path?: string}}
 */
export function writeEvent(projectRoot, input, opts = {}) {
  try {
    return assembleAndAppend(projectRoot, input, opts);
  } catch (err) {
    // The outermost promise of this module is that it returns instead of
    // throwing, and a promise that holds only for the inputs we thought of is
    // not a promise. Anything unforeseen — a caller's exotic `data`, a getter
    // that throws, a filesystem the fs guards did not model — becomes a result
    // here. Named by constructor so the reason still says what happened.
    return { ok: false, reason: `writer-exception:${err?.constructor?.name ?? 'Error'}` };
  }
}

/**
 * The body of {@link writeEvent}, separated so the wrapper above is nothing but
 * the guarantee. May throw; only its caller may not.
 *
 * @param {string} projectRoot
 * @param {object} input
 * @param {object} opts
 * @returns {object} same result shape as {@link writeEvent}
 */
function assembleAndAppend(projectRoot, input, opts) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return { ok: false, reason: 'no-project-root' };
  }
  const { maxLineBytes } = getLedgerSettings(opts);
  const file = ledgerFilePath(projectRoot, opts);
  const env = redactDeep(buildEnvelope(input, opts));

  const envelopeError = validateEnvelope(env);
  if (envelopeError) {
    return { ...writeRejection(file, env, envelopeError, maxLineBytes), path: file };
  }
  // Folding runs BETWEEN the two layers: the envelope must already be
  // well-formed for the event name to be trustworthy, and the contract layer
  // must judge the canonical spelling rather than the one the caller sent.
  const folded = normalizeDeclaredEnums(env);
  const contractError = validateEventContract(folded);
  if (contractError) {
    return { ...writeRejection(file, folded, contractError, maxLineBytes), path: file };
  }
  return appendWithinCap(file, folded, maxLineBytes);
}
