/**
 * `lib/verification/unified-verifier.js` — three verification layers folded
 * into one verdict, with `UNMEASURED` as a first-class status.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The defect this closes (design §1.4-C) is a vocabulary defect before it is a
 * logic one: a layer that could not be measured has no value to report today,
 * so it gets written as a pass or dropped. Both claim knowledge nobody has.
 * `UNMEASURED` is the third value. It is not an error and not a soft fail — it
 * is the honest answer to "what did the behavioral layer say?" when no
 * behavioral runner exists. The same shape is already in this repo:
 * `lib/git/limb-landing-check.js` returns `UNSUPPORTED` (never `PASS`) when git
 * cannot run `merge-tree --write-tree`, precisely so an unmeasured merge is not
 * read as a clean one.
 *
 * ── The fold ───────────────────────────────────────────────────────────────
 *   any layer FAIL                        → FAIL
 *   every layer UNMEASURED                → UNMEASURED   (floor; see below)
 *   a *required* layer UNMEASURED         → UNMEASURED
 *   otherwise                             → PASS
 *
 * The all-unmeasured floor is not redundant with the `required` rule. `required`
 * is a caller option because which layers are mandatory is design decision C4,
 * still open — and a caller passing `required: []` would otherwise get `PASS`
 * out of a run in which nothing at all was measured. That is the exact reading
 * this module exists to make unsayable, so the floor holds regardless of config.
 *
 * ── What a PASS from this module does NOT mean (rules §9) ───────────────────
 * `PASS` means "no layer said FAIL, and every layer named in `required` was
 * measured". With the default `required: ['deterministic']` and no behavioral
 * runner in existence, a `PASS` will routinely come back with a non-empty
 * `unmeasured[]`. **`status` alone is not a completion condition.** The
 * completion gate (design §5.4 — outcome.md generation) reads `unmeasured[]` and
 * `regressions[]` as well, and refuses generation while `UNMEASURED` remains.
 * That rule lives in the generator, not here; this module measures and reports.
 *
 * `regressions[]` likewise never moves `status`. A regression that matters
 * already shows up as a layer FAIL; a missing baseline is an unmeasured axis,
 * not a failure, and making a first-ever run FAIL or UNMEASURED on that ground
 * would punish the absence of history.
 *
 * ── Adapters are ports, not imports ────────────────────────────────────────
 * Each `layers.<name>` entry is a plain result object, or a zero-argument
 * function returning one (called once; a throw becomes `UNMEASURED`, never a
 * pass). Nothing here spawns a process, reads a file or writes one.
 *   • deterministic — an exit-code result in the shape
 *     `lib/autopilot/goal-evaluator.js#evaluateGoal` returns
 *     (`{ met, confidence, exitCode, stdout, stderr, reason }`), optionally with
 *     `command`. That function is *not* called from here. A non-numeric
 *     `exitCode` is `UNMEASURED`, which is the whole point: `evaluateGoal`
 *     returns `{ met: false, exitCode: null, reason: 'no validationCommand —
 *     manual evaluation required' }`, and reading that as FAIL would be as wrong
 *     as reading it as PASS.
 *   • behavioral — `behavioralShell()` is the only behavioral adapter that
 *     exists. It takes a scenario spec and always returns `UNMEASURED`, because
 *     there is no runner. It counts the declared scenarios so the Observe
 *     denominator ("층별 UNMEASURED 비율") has a numerator to sit against.
 *   • operational — read-only readings from `lib/supervisor/` and
 *     `lib/observability/`. A reading with no `min`/`max` bound does not vote:
 *     a number without a threshold is an observation, not a verdict, and a layer
 *     of pure observations is `UNMEASURED`.
 *
 * ── Evidence is passed through, never invented ─────────────────────────────
 * `evidence[]` entries follow `schemas/review-output.schema.json#/definitions/
 * evidence`: `kind: 'file'` pins `file` + `line`, `kind: 'command'` pins
 * `command` + `output`. Entries that do not fit are dropped and counted in the
 * layer's `reason` — never reshaped into something that would validate. Metric
 * readings have no evidence kind in that schema, so the operational layer emits
 * evidence only when the caller supplies already-shaped entries.
 *
 * ── verification_id ────────────────────────────────────────────────────────
 *   `v1-<sha256[0..12]>-<YYYYMMDDTHHMMSSZ>`   e.g. `v1-3f9a2b1c8d04-20260902T071530Z`
 * The hash covers everything returned except `verification_id` and
 * `measured_at`; the timestamp is the second half, so two identical
 * measurements taken at different times share a hash and differ as ids. Any
 * holder of the returned object can recompute the id — that is what makes it
 * checkable as a join key across review.md / outcome.md / ledger.jsonl
 * (design §5.5). `schemas/review-output.schema.json:337` deliberately asserts
 * no pattern; the `v1-` prefix is here so a later format change is
 * distinguishable rather than silently colliding in that join.
 *
 * The clock port is `() => Date` and nothing else — see `lib/core/clock.js`
 * for why the narrower contract is the point. `verify()` always returns a real
 * `measured_at`. `buildVerificationId` still accepts a null timestamp and
 * stamps the literal `unknown`, because a fabricated time would be worse than
 * an obviously missing one, but `verify()` cannot reach that branch.
 *
 * ── Bad input is UNMEASURED, not FAIL ──────────────────────────────────────
 * No layer input throws. Unusable layer input means nothing was measured, and
 * that is what gets reported. This differs from `limb-landing-check.js`, which
 * returns `FAIL` on bad input — it had two values and FAIL was its fail-closed
 * one. Here the third value says exactly what happened, and it is equally
 * fail-closed downstream: the completion gate refuses on `UNMEASURED` as it
 * does on `FAIL`.
 *
 * The one exception is the `now` port, which throws `TypeError` on a wrong-typed
 * clock (T-51 review #6). The line is deliberate: a layer that could not be
 * measured is a fact about the work being verified and belongs in the verdict,
 * whereas a clock of the wrong type is a defect in the calling code and has no
 * verdict to belong to. Callers that were relying on "never throws" should note
 * that only a malformed `now` can trip it.
 *
 * ── warnings[] ─────────────────────────────────────────────────────────────
 * Facts about the verdict's own construction, not about the work verified —
 * which is why they are a separate list and never move `status`. Today's only
 * entry is `unserializable_evidence`: `note` and `measured_at` are copied out
 * of caller evidence unchecked, so a circular object could reach the id hash
 * and make `JSON.stringify` throw (T-50 review #3 reproduced exactly that).
 * Such fields become `[unserializable]` and are named here instead.
 *
 * The substitution reaches the returned verdict, not just the id hash: a
 * verdict is data on its way to the ledger and to outcome.md, so handing back
 * an object that cannot be serialized would only move the same `TypeError` one
 * layer out into the writer. `JSON.stringify(verify(…))` therefore never
 * throws. The cost is that a caller does not get its own `note` object back —
 * `warnings[]` says which field was replaced and why.
 *
 * @module lib/verification/unified-verifier
 */

import { createHash } from 'node:crypto';

import { readClock } from '../core/clock.js';

/** Canonical layer order. Every `layers[]` and `regressions[]` follows it. */
export const LAYERS = Object.freeze(['deterministic', 'behavioral', 'operational']);

/**
 * Layers whose `UNMEASURED` forces an overall `UNMEASURED`. Only deterministic
 * by default: making behavioral required would make every run UNMEASURED while
 * no runner exists, and design decision C4 (which layers are mandatory) is open.
 */
export const DEFAULT_REQUIRED_LAYERS = Object.freeze(['deterministic']);

/** Prefix of every id this version emits. Bump with the format, never silently. */
export const VERIFICATION_ID_VERSION = 'v1';

const EVIDENCE_KEYS = Object.freeze(['kind', 'file', 'line', 'command', 'output', 'measured_at', 'note']);

/**
 * @param {unknown} v
 * @returns {string} Short type description for a reason string.
 */
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Rebuild one evidence entry with a fixed key order, or reject it.
 *
 * Fixed key order is not cosmetic: caller key order would otherwise leak into
 * `verification_id`, so two logically identical verdicts could hash differently.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null} `null` when the entry does not satisfy
 *   its kind's required fields.
 */
function canonicalEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = /** @type {Record<string, any>} */ (raw);
  if (e.kind === 'file') {
    if (typeof e.file !== 'string' || !e.file.trim()) return null;
    if (!Number.isInteger(e.line) || Number(e.line) < 1) return null;
  } else if (e.kind === 'command') {
    if (typeof e.command !== 'string' || !e.command.trim()) return null;
    if (typeof e.output !== 'string') return null;
  } else {
    return null;
  }
  const out = {};
  for (const k of EVIDENCE_KEYS) {
    if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  }
  return out;
}

/**
 * Keep the evidence entries that match the schema, count the rest.
 *
 * @param {unknown} list
 * @returns {{ kept: Array<Record<string, unknown>>, dropped: number }}
 */
export function sanitizeEvidence(list) {
  if (list === undefined || list === null) return { kept: [], dropped: 0 };
  if (!Array.isArray(list)) return { kept: [], dropped: 1 };
  const kept = [];
  let dropped = 0;
  for (const raw of list) {
    const e = canonicalEvidence(raw);
    if (e) kept.push(e);
    else dropped += 1;
  }
  return { kept, dropped };
}

/** Marker written into the id hash in place of a value JSON cannot represent. */
const UNSERIALIZABLE = '[unserializable]';

/**
 * @param {unknown} v
 * @returns {boolean} Whether `JSON.stringify` can represent the value.
 */
function isSerializable(v) {
  try {
    JSON.stringify(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace the fields of one evidence entry that JSON cannot represent.
 *
 * Field-level rather than entry-level on purpose: a circular `note` should not
 * erase the `file` and `line` that identify the entry, because collapsing whole
 * entries to one marker would make two different unserializable entries hash
 * alike. Key order is preserved, so the id stays deterministic.
 *
 * @param {unknown} entry
 * @returns {{ entry: unknown, fields: Array<string> }}
 */
function serializableEntry(entry) {
  if (isSerializable(entry)) return { entry, fields: [] };
  if (!entry || typeof entry !== 'object') return { entry: UNSERIALIZABLE, fields: ['<entry>'] };
  const out = {};
  const fields = [];
  for (const [k, val] of Object.entries(entry)) {
    if (isSerializable(val)) {
      out[k] = val;
    } else {
      out[k] = UNSERIALIZABLE;
      fields.push(k);
    }
  }
  // A cycle can close through the entry itself rather than any single field.
  if (!isSerializable(out)) return { entry: UNSERIALIZABLE, fields: fields.length ? fields : ['<entry>'] };
  return { entry: out, fields };
}

/**
 * Make an evidence list safe to hash, and say what had to be replaced.
 *
 * Evidence is the only part of a verdict that carries caller-supplied objects
 * verbatim (`note` and `measured_at` are copied through unchecked), so it is
 * the only place a cycle can enter. T-50 #3 reproduced it: a circular
 * `evidence[0].note` made `JSON.stringify` throw out of a function documented
 * as pure, which contradicted the module's "the only throw is a bad clock".
 *
 * @param {ReadonlyArray<unknown>} evidence
 * @returns {{ entries: Array<unknown>, warnings: Array<{ code: string, detail: string }> }}
 */
function serializableEvidence(evidence) {
  const entries = [];
  const warnings = [];
  evidence.forEach((raw, i) => {
    const { entry, fields } = serializableEntry(raw);
    entries.push(entry);
    for (const field of fields) {
      warnings.push({
        code: 'unserializable_evidence',
        detail: `evidence[${i}].${field} could not be serialized — hashed as "${UNSERIALIZABLE}"`,
      });
    }
  });
  return { entries, warnings };
}

/**
 * @param {number} dropped
 * @returns {string} Suffix naming dropped evidence, or `''`.
 */
function droppedNote(dropped) {
  if (!dropped) return '';
  return ` (${dropped} evidence entr${dropped === 1 ? 'y' : 'ies'} dropped — not file/command shaped)`;
}

/**
 * @param {string} layer
 * @param {'PASS'|'FAIL'|'UNMEASURED'} status
 * @param {string} reason
 * @param {Array<Record<string, unknown>>} evidence
 */
function layerRow(layer, status, reason, evidence) {
  return { layer, status, reason, evidence };
}

/**
 * Fold an exit-code result into the deterministic layer.
 *
 * @param {unknown} raw - `evaluateGoal`-shaped result, optionally with
 *   `command` (the exact command run) and `evidence`.
 * @returns {{ layer: string, status: 'PASS'|'FAIL'|'UNMEASURED', reason: string, evidence: Array<Record<string, unknown>> }}
 */
export function normalizeDeterministic(raw) {
  if (raw === undefined || raw === null) {
    return layerRow('deterministic', 'UNMEASURED', 'layer not supplied', []);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return layerRow('deterministic', 'UNMEASURED', `unusable adapter result (${describe(raw)})`, []);
  }
  const r = /** @type {Record<string, any>} */ (raw);
  const { kept, dropped } = sanitizeEvidence(r.evidence);
  const evidence = kept.slice();
  if (typeof r.command === 'string' && r.command.trim()) {
    const output = [String(r.stdout ?? ''), String(r.stderr ?? '')].filter((s) => s !== '').join('\n');
    const synthesized = canonicalEvidence({
      kind: 'command',
      command: r.command.trim(),
      output,
      measured_at: typeof r.measured_at === 'string' ? r.measured_at : undefined,
    });
    if (synthesized) evidence.unshift(synthesized);
  }
  const note = droppedNote(dropped);
  const given = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : '';
  if (typeof r.exitCode !== 'number' || !Number.isFinite(r.exitCode)) {
    const why = given || 'no reason given';
    return layerRow('deterministic', 'UNMEASURED', `${why} — no numeric exitCode, nothing was run${note}`, evidence);
  }
  const reason = given || `exit code ${r.exitCode}`;
  return layerRow('deterministic', r.exitCode === 0 ? 'PASS' : 'FAIL', `${reason}${note}`, evidence);
}

/**
 * The behavioral adapter. Always `UNMEASURED` — there is no runner, and a
 * scenario list is a declaration, not a measurement.
 *
 * @param {unknown} spec - Scenario array, or `{ scenarios: [...] }`.
 * @returns {{ layer: string, status: 'UNMEASURED', reason: string, evidence: Array<Record<string, unknown>> }}
 */
export function behavioralShell(spec) {
  let scenarios = [];
  if (Array.isArray(spec)) scenarios = spec;
  else if (spec && typeof spec === 'object' && Array.isArray(/** @type {any} */ (spec).scenarios)) {
    scenarios = /** @type {any} */ (spec).scenarios;
  }
  return layerRow('behavioral', 'UNMEASURED',
    `no behavioral runner exists — ${scenarios.length} scenario(s) declared, 0 executed`, []);
}

/**
 * Fold read-only operational readings. A reading votes only when it carries a
 * `min` and/or `max` bound and a finite `value`; unbounded readings are
 * observations and do not decide anything.
 *
 * @param {unknown} raw - `{ readings: [{ metric, value, min?, max? }], evidence? }`
 * @returns {{ layer: string, status: 'PASS'|'FAIL'|'UNMEASURED', reason: string, evidence: Array<Record<string, unknown>> }}
 */
export function normalizeOperational(raw) {
  if (raw === undefined || raw === null) {
    return layerRow('operational', 'UNMEASURED', 'layer not supplied', []);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return layerRow('operational', 'UNMEASURED', `unusable adapter result (${describe(raw)})`, []);
  }
  const r = /** @type {Record<string, any>} */ (raw);
  const readings = Array.isArray(r.readings) ? r.readings : [];
  const { kept, dropped } = sanitizeEvidence(r.evidence);
  const note = droppedNote(dropped);
  const violations = [];
  let bounded = 0;
  for (const reading of readings) {
    if (!reading || typeof reading !== 'object' || Array.isArray(reading)) continue;
    const hasMin = typeof reading.min === 'number' && Number.isFinite(reading.min);
    const hasMax = typeof reading.max === 'number' && Number.isFinite(reading.max);
    if (!hasMin && !hasMax) continue;
    if (typeof reading.value !== 'number' || !Number.isFinite(reading.value)) continue;
    bounded += 1;
    const name = typeof reading.metric === 'string' && reading.metric.trim() ? reading.metric.trim() : 'unnamed';
    if (hasMin && reading.value < reading.min) violations.push(`${name}=${reading.value} < min ${reading.min}`);
    if (hasMax && reading.value > reading.max) violations.push(`${name}=${reading.value} > max ${reading.max}`);
  }
  if (bounded === 0) {
    return layerRow('operational', 'UNMEASURED',
      `${readings.length} reading(s), 0 comparable to a bound — readings are observations, not a verdict${note}`,
      kept);
  }
  if (violations.length) {
    return layerRow('operational', 'FAIL',
      `${violations.length}/${bounded} bound(s) violated: ${violations.join('; ')}${note}`, kept);
  }
  return layerRow('operational', 'PASS', `${bounded} bound(s) satisfied${note}`, kept);
}

const NORMALIZERS = Object.freeze({
  deterministic: normalizeDeterministic,
  behavioral: behavioralShell,
  operational: normalizeOperational,
});

/**
 * Resolve one layer port and normalize its result. A port that throws is
 * `UNMEASURED` — an adapter blowing up is not evidence of anything passing.
 *
 * @param {string} layer
 * @param {unknown} input - Result object, or a zero-argument function.
 */
function buildLayerRow(layer, input) {
  let raw = input;
  if (typeof input === 'function') {
    try {
      raw = input();
    } catch (err) {
      const msg = (err && /** @type {any} */ (err).message) || 'adapter threw';
      return layerRow(layer, 'UNMEASURED', `adapter threw: ${msg}`, []);
    }
  }
  return NORMALIZERS[layer](raw);
}

/**
 * @param {ReadonlyArray<{ layer: string, status: string }>} rows
 * @param {ReadonlyArray<string>} required
 * @returns {'PASS'|'FAIL'|'UNMEASURED'}
 */
function foldStatus(rows, required) {
  if (rows.some((r) => r.status === 'FAIL')) return 'FAIL';
  if (rows.every((r) => r.status === 'UNMEASURED')) return 'UNMEASURED';
  if (rows.some((r) => r.status === 'UNMEASURED' && required.includes(r.layer))) return 'UNMEASURED';
  return 'PASS';
}

/**
 * @param {unknown} value
 * @returns {Array<string>} Known layer names in canonical order; the default on
 *   anything unusable, so a malformed option cannot widen what counts as PASS.
 */
function normalizeRequired(value) {
  if (!Array.isArray(value)) return [...DEFAULT_REQUIRED_LAYERS];
  return LAYERS.filter((l) => value.includes(l));
}

/**
 * Back-compatible re-export. The canonical home is `lib/core/clock.js` (L1),
 * where the definition moved once three consumers appeared on three different
 * layers — an L5 module borrowing its clock from a verification module is
 * backwards. See that file for the contract and for why a wrong-typed clock
 * throws while an unmeasured layer does not.
 *
 * Production importers of this re-export: **0** as of 2026-09-03. All three
 * consumers reach past it to the definition — `runtime/event-writer.js:79`,
 * `project-state/state-manager.js:87`, `topology/split-state.js:68`. The only
 * thing importing this symbol from here is
 * `tests/verification/unified-verifier.test.js`, which exists to pin the
 * re-export itself. It is kept for import paths outside this repo's control;
 * with no production importer it is a legitimate Existence Audit removal
 * candidate, and deleting it should take that test with it.
 */
export { readClock };

/**
 * Read the previous PASS through the injected port.
 *
 * @param {unknown} readLastPass - `() => { verification_id, measured_at, layers: [{ layer, status }] } | null`
 * @returns {{ map: Map<string, string>|null, reason: string }}
 */
function readBaseline(readLastPass) {
  if (typeof readLastPass !== 'function') {
    return { map: null, reason: 'no readLastPass port supplied — no baseline' };
  }
  let record;
  try {
    record = readLastPass();
  } catch (err) {
    const msg = (err && /** @type {any} */ (err).message) || 'threw';
    return { map: null, reason: `readLastPass threw: ${msg} — no baseline` };
  }
  if (record === null || record === undefined) {
    return { map: null, reason: 'no previous PASS recorded — no baseline' };
  }
  const rec = /** @type {Record<string, any>} */ (record);
  if (typeof record !== 'object' || Array.isArray(record) || !Array.isArray(rec.layers)) {
    return { map: null, reason: 'baseline record carries no layers[] — no baseline' };
  }
  const map = new Map();
  for (const row of rec.layers) {
    if (!row || typeof row !== 'object') continue;
    if (!LAYERS.includes(row.layer)) continue;
    if (typeof row.status !== 'string') continue;
    map.set(row.layer, row.status);
  }
  return { map, reason: '' };
}

/**
 * Compare this run against the previous PASS, one row per layer always.
 *
 * A layer that was PASS and is now unmeasured is reported `UNMEASURED`, not a
 * regression: losing the measurement is not the same as losing the property,
 * and calling it a regression would be the mirror of calling it a pass.
 *
 * @param {ReadonlyArray<{ layer: string, status: string }>} rows
 * @param {unknown} readLastPass
 */
function buildRegressions(rows, readLastPass) {
  const { map, reason } = readBaseline(readLastPass);
  return LAYERS.map((layer) => {
    const row = rows.find((r) => r.layer === layer);
    const to = row ? row.status : 'UNMEASURED';
    if (!map) return { layer, from: null, to, status: 'UNMEASURED', detail: reason };
    const from = map.has(layer) ? map.get(layer) : null;
    if (from === null) {
      return { layer, from, to, status: 'UNMEASURED', detail: 'baseline has no row for this layer' };
    }
    if (from !== 'PASS') {
      return {
        layer, from, to, status: 'UNMEASURED',
        detail: `baseline status ${from} is not PASS — nothing to regress from`,
      };
    }
    if (to === 'FAIL') return { layer, from, to, status: 'FAIL', detail: 'was PASS, now FAIL' };
    if (to === 'UNMEASURED') {
      return { layer, from, to, status: 'UNMEASURED', detail: 'was PASS, now unmeasured — regression not decidable' };
    }
    return { layer, from, to, status: 'PASS', detail: 'still PASS' };
  });
}

/**
 * Derive the join key from a verdict. Pure and reproducible: anyone holding the
 * returned object can recompute the same id from it.
 *
 * @param {object} verdict - A `verify()` result (or the same fields).
 * @param {string|null} measuredAt - ISO timestamp, or `null` for an unusable clock.
 * @returns {string} `v1-<sha256[0..12]>-<YYYYMMDDTHHMMSSZ|unknown>`
 */
export function buildVerificationId(verdict, measuredAt) {
  const v = /** @type {Record<string, any>} */ (verdict && typeof verdict === 'object' ? verdict : {});
  const shape = {
    v: 1,
    status: v.status ?? null,
    required: Array.isArray(v.required) ? v.required : [],
    layers: (Array.isArray(v.layers) ? v.layers : []).map((r) => ({
      layer: r?.layer ?? null,
      status: r?.status ?? null,
      reason: r?.reason ?? null,
    })),
    evidence: serializableEvidence(Array.isArray(v.evidence) ? v.evidence : []).entries,
    unmeasured: (Array.isArray(v.unmeasured) ? v.unmeasured : []).map((u) => ({
      layer: u?.layer ?? null,
      reason: u?.reason ?? null,
      required: u?.required ?? null,
    })),
    regressions: (Array.isArray(v.regressions) ? v.regressions : []).map((r) => ({
      layer: r?.layer ?? null,
      from: r?.from ?? null,
      to: r?.to ?? null,
      status: r?.status ?? null,
      detail: r?.detail ?? null,
    })),
    warnings: (Array.isArray(v.warnings) ? v.warnings : []).map((w) => ({
      code: String(w?.code ?? ''),
      detail: String(w?.detail ?? ''),
    })),
  };
  let payload;
  try {
    payload = JSON.stringify(shape);
  } catch {
    // Backstop. `serializableEvidence` already covers the only field that
    // carries caller-supplied objects, so reaching here means something new
    // grew a cycle. An id that says so beats a throw from a pure function.
    payload = JSON.stringify({ v: 1, status: String(shape.status ?? ''), payload: UNSERIALIZABLE });
  }
  const hash = createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
  const stamp = typeof measuredAt === 'string' && measuredAt
    ? measuredAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    : 'unknown';
  return `${VERIFICATION_ID_VERSION}-${hash}-${stamp}`;
}

/**
 * Fold the three layers into one verdict. Never throws, never writes, never
 * spawns; every effect arrives through an injected port.
 *
 * @param {object} [p]
 * @param {{ deterministic?: unknown, behavioral?: unknown, operational?: unknown }} [p.layers]
 *   Per-layer adapter result, or a zero-argument function returning one.
 * @param {ReadonlyArray<string>} [p.required=DEFAULT_REQUIRED_LAYERS] - Layers
 *   whose `UNMEASURED` forces an overall `UNMEASURED`. Design decision C4 is
 *   open, so this is an input option and not read from config.
 * @param {() => object|null} [p.readLastPass] - Port returning the previous PASS
 *   record. Absent or empty → the regression axis is `UNMEASURED`, not a pass.
 * @param {() => Date} [p.now] - Injected clock. Must return a valid `Date`;
 *   epoch ms and ISO strings are rejected (T-51 review #6). Omit for `new Date()`.
 * @throws {TypeError} When `now` is present but is not a function returning a
 *   valid `Date`. This is the only throw in the module.
 * @returns {Readonly<{
 *   status: 'PASS'|'FAIL'|'UNMEASURED',
 *   layers: ReadonlyArray<{ layer: string, status: string, reason: string, evidence: ReadonlyArray<object> }>,
 *   evidence: ReadonlyArray<object>,
 *   unmeasured: ReadonlyArray<{ layer: string, reason: string, required: boolean }>,
 *   regressions: ReadonlyArray<{ layer: string, from: string|null, to: string, status: string, detail: string }>,
 *   warnings: ReadonlyArray<{ code: string, detail: string }>,
 *   required: ReadonlyArray<string>,
 *   measured_at: string,
 *   verification_id: string,
 * }>}
 */
export function verify(p = {}) {
  const opts = p && typeof p === 'object' && !Array.isArray(p) ? /** @type {Record<string, any>} */ (p) : {};
  const layersIn = opts.layers && typeof opts.layers === 'object' && !Array.isArray(opts.layers)
    ? opts.layers
    : {};
  const required = normalizeRequired(opts.required);
  const measuredAt = readClock(opts.now, 'unified-verifier');

  const rows = LAYERS.map((layer) => buildLayerRow(layer, layersIn[layer]));
  const unmeasured = rows
    .filter((r) => r.status === 'UNMEASURED')
    .map((r) => ({ layer: r.layer, reason: r.reason, required: required.includes(r.layer) }));
  const status = foldStatus(rows, required);
  const regressions = buildRegressions(rows, opts.readLastPass);

  // Sanitize once over the flattened list, then re-slice it back onto the rows
  // in the same order. Doing it per row instead would leave the layer copies
  // holding the original cycle, and `JSON.stringify(result)` would still throw
  // through `layers[].evidence` — the top-level array is not the only carrier.
  const { entries, warnings } = serializableEvidence(rows.flatMap((r) => r.evidence));
  let cut = 0;
  const evidenceByRow = rows.map((r) => entries.slice(cut, (cut += r.evidence.length)));

  const verdict = {
    status,
    layers: Object.freeze(rows.map((r, i) => Object.freeze({
      layer: r.layer,
      status: r.status,
      reason: r.reason,
      evidence: Object.freeze(evidenceByRow[i].map((e) => Object.freeze(e))),
    }))),
    evidence: Object.freeze(entries.map((e) => Object.freeze(e))),
    unmeasured: Object.freeze(unmeasured.map((u) => Object.freeze(u))),
    regressions: Object.freeze(regressions.map((g) => Object.freeze(g))),
    warnings: Object.freeze(warnings.map((w) => Object.freeze(w))),
    required: Object.freeze(required),
    measured_at: measuredAt,
  };

  return Object.freeze({
    ...verdict,
    verification_id: buildVerificationId(verdict, measuredAt),
  });
}

// ---------------------------------------------------------------------------
// The `verify.completed` ledger writer
// ---------------------------------------------------------------------------

/**
 * ── Why the writer lives here and still does no I/O ─────────────────────────
 * `buildVerifyCompletedEvents` is pure: it turns a verdict into ledger envelope
 * INPUTS and returns them. `recordVerification` performs the append through two
 * injected ports and never imports `lib/runtime/ledger.js` — an L2 module
 * importing L5 would be the wrong direction, and the port keeps this file's
 * "never writes, never spawns" property intact.
 *
 * ── One line per layer, plus one overall ────────────────────────────────────
 * The reader (`lib/runtime/artifact-lifecycle-gates.js#tallyLayer`, :262 on
 * 2026-09-12) buckets by `data.layer` and tallies `data.result` per bucket, so a
 * single folded line would make the per-layer denominator unreadable. The
 * overall line carries NO `layer` key on purpose: that reader buckets a missing
 * layer as `unspecified`, which is exactly what the fold of three layers is.
 *
 * ── Fail-closed, and all-or-nothing ────────────────────────────────────────
 * A status this module cannot map produces ZERO inputs, not the subset it could
 * map. A partial set would land some layers and silently omit others, and the
 * reader has no way to tell an omitted layer from one that was never declared —
 * it would read as a smaller denominator rather than as a failure to write.
 * Nothing here guesses a `verify_result`: `toVerifyResult` maps the three
 * statuses `verify()` produces and returns `null` for everything else, so an
 * `UNMEASURED` layer reaches the ledger as `unmeasured` and never as a pass.
 */

/** The one event name this module writes. */
export const VERIFY_COMPLETED_EVENT = 'verify.completed';

/**
 * The only `source` the allowlist accepts for it
 * (`schemas/ledger-events.allowlist.json#events.verify.completed.sources`,
 * read 2026-09-12 — `["gate"]`).
 */
export const VERIFY_LEDGER_SOURCE = 'gate';

/**
 * A `Map`, not an object literal: a literal would answer
 * `toVerifyResult('constructor')` with a function off `Object.prototype`, and a
 * caller's truthiness check would read that as a successful mapping.
 */
const VERIFY_RESULT_BY_STATUS = new Map([
  ['PASS', 'pass'],
  ['FAIL', 'fail'],
  ['UNMEASURED', 'unmeasured'],
]);

/**
 * Envelope shape for `mission_id`, copied from
 * `lib/runtime/event-writer.js#MISSION_ID_RE` (:157 on 2026-09-12) rather than
 * imported, because importing L5 from here would invert the layer order. A
 * mission id this rejects is OMITTED, never sent: the writer's
 * `sessionFallbackMissionId` then supplies a valid one, whereas a malformed id
 * would take the whole line down as `invalid-envelope:mission_id`.
 */
const MISSION_ID_SHAPE = /^M-\d{8}-(?:\d{3,}|S[0-9A-Za-z]{8})$/;

/**
 * The ledger spelling of a verdict status.
 *
 * Only the three UPPERCASE statuses map. A lowercase `'pass'` returns `null`
 * even though `lib/runtime/ledger-schema.js#ENUM_CASE_FOLD` would accept it on
 * the writer side: that is the writer's tolerance for other producers, and
 * accepting it here would make this function a silent identity for its own
 * output, so a double conversion would look like a success.
 *
 * @param {unknown} status
 * @returns {'pass'|'fail'|'unmeasured'|null} `null` for anything else — never a guess.
 */
export function toVerifyResult(status) {
  if (typeof status !== 'string') return null;
  const mapped = VERIFY_RESULT_BY_STATUS.get(status);
  return mapped === undefined ? null : mapped;
}

/**
 * Idempotency key for one `verify.completed` line.
 *
 * Mirrors `lib/economics/receipt-envelope.js#usageReceiptIdempotencyKey`
 * (`<event>:<session>:<identity…>`, :123 on 2026-09-12). The layer suffix is
 * what keeps a layer line from colliding with the overall line of the same
 * verdict — without it, four lines would share one key and three would dedupe
 * away.
 *
 * @param {string} sessionId
 * @param {string} verificationId
 * @param {string} [layer] Omit (or pass a blank/non-string) for the overall line.
 * @returns {string}
 */
export function verifyCompletedIdempotencyKey(sessionId, verificationId, layer) {
  const base = `${VERIFY_COMPLETED_EVENT}:${sessionId}:${verificationId}`;
  if (typeof layer !== 'string' || !layer.trim()) return base;
  return `${base}:${layer}`;
}

/**
 * One ledger envelope input. `data` carries the four contract keys and nothing
 * else — an envelope key duplicated into `data` would be a second, divergent
 * copy of a field the envelope already owns.
 *
 * @param {{ sessionId: string, missionId: string|null, verificationId: string,
 *   layer: string|null, result: string, evidence: Array<unknown> }} p
 * @returns {object}
 */
function verifyEventInput(p) {
  const data = {};
  if (p.layer !== null) data.layer = p.layer;
  data.result = p.result;
  data.evidence = p.evidence;
  data.verification_id = p.verificationId;
  return {
    event: VERIFY_COMPLETED_EVENT,
    session_id: p.sessionId,
    ...(p.missionId === null ? {} : { mission_id: p.missionId }),
    source: VERIFY_LEDGER_SOURCE,
    idempotency_key: verifyCompletedIdempotencyKey(
      p.sessionId, p.verificationId, p.layer === null ? undefined : p.layer,
    ),
    data,
  };
}

/**
 * The lines a verdict should produce, before any status is mapped. One entry per
 * `LAYERS` member always, so a verdict missing a layer row is visible as a
 * missing row rather than as one fewer line.
 *
 * @param {Record<string, any>} v
 * @param {boolean} includeOverall
 * @returns {Array<{ layer: string|null, status: unknown, evidence: Array<unknown>, missing: boolean }>}
 */
function planVerifyLines(v, includeOverall) {
  const rows = Array.isArray(v.layers) ? v.layers : [];
  const planned = includeOverall
    ? [{ layer: null, status: v.status, evidence: evidenceList(v.evidence), missing: false }]
    : [];
  for (const layer of LAYERS) {
    const row = rows.find((r) => r && typeof r === 'object' && r.layer === layer);
    planned.push({
      layer,
      status: row ? row.status : undefined,
      evidence: row ? evidenceList(row.evidence) : [],
      missing: !row,
    });
  }
  return planned;
}

/**
 * A fresh array of the entries `verify()` already sanitized. Copied because the
 * verdict is frozen and the value travels on to a writer; the entries
 * themselves are passed through unchanged — evidence is never padded here.
 *
 * @param {unknown} list
 * @returns {Array<unknown>}
 */
function evidenceList(list) {
  return Array.isArray(list) ? [...list] : [];
}

/**
 * Why one planned line could not be mapped, in a reason string that names both
 * the place and the value.
 *
 * @param {{ layer: string|null, status: unknown, missing: boolean }} line
 * @returns {string}
 */
function unmappableReason(line) {
  const where = line.layer === null ? 'overall status' : `layer ${line.layer}`;
  if (line.missing) return `${where}: no row in verdict.layers — nothing measured to report`;
  const shown = typeof line.status === 'string' ? JSON.stringify(line.status) : describe(line.status);
  return `${where}: ${shown} maps to no verify_result — refusing to guess, 0 lines written`;
}

/**
 * Turn one verdict into `verify.completed` envelope inputs. Pure.
 *
 * @param {object} verdict - A `verify()` result (or the same fields).
 * @param {{ sessionId?: string, missionId?: string, includeOverall?: boolean }} [ctx]
 *   `includeOverall` defaults to true. A `missionId` outside
 *   {@link MISSION_ID_SHAPE} is omitted, not rejected.
 * @returns {{ ok: true, inputs: Array<object> } | { ok: false, reason: string, inputs: [] }}
 *   `ok: false` always carries ZERO inputs — never the mappable subset.
 */
export function buildVerifyCompletedEvents(verdict, ctx = {}) {
  const c = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? /** @type {any} */ (ctx) : {};
  const sessionId = typeof c.sessionId === 'string' ? c.sessionId.trim() : '';
  if (!sessionId) {
    return { ok: false, inputs: [], reason: 'no session_id — the line could not be joined to a session' };
  }
  const v = verdict && typeof verdict === 'object' && !Array.isArray(verdict)
    ? /** @type {Record<string, any>} */ (verdict)
    : null;
  if (!v) return { ok: false, inputs: [], reason: `unusable verdict (${describe(verdict)})` };
  const verificationId = typeof v.verification_id === 'string' ? v.verification_id.trim() : '';
  if (!verificationId) {
    return { ok: false, inputs: [], reason: 'no verification_id — the join key across review/outcome/ledger is missing' };
  }
  const missionId = typeof c.missionId === 'string' && MISSION_ID_SHAPE.test(c.missionId)
    ? c.missionId
    : null;
  const inputs = [];
  for (const line of planVerifyLines(v, c.includeOverall !== false)) {
    const result = toVerifyResult(line.status);
    if (result === null) return { ok: false, inputs: [], reason: unmappableReason(line) };
    inputs.push(verifyEventInput({
      sessionId, missionId, verificationId, layer: line.layer, result, evidence: line.evidence,
    }));
  }
  return { ok: true, inputs };
}

/**
 * Read the keys already in the ledger through the optional port.
 *
 * A port that throws yields `keys: null`, which makes {@link recordVerification}
 * reject every line. That is deliberately STRICTER than
 * `scripts/hooks/session-end.js#existingReceiptKeys` (:576 on 2026-09-12), which
 * swallows the throw and appends anyway: a duplicated `verify.completed`
 * inflates the reader's per-layer tally into a false measurement, while a line
 * that was not written is a visible absence. This module prefers the absence.
 *
 * An ABSENT port is different again — it is treated as "no keys known", the same
 * way `readBaseline` treats a missing `readLastPass` as an absence of
 * information rather than a defect.
 *
 * @param {unknown} port
 * @returns {{ keys: Set<string>|null, reason: string }}
 */
function readExistingKeys(port) {
  if (port === undefined || port === null) return { keys: new Set(), reason: '' };
  if (typeof port !== 'function') return { keys: null, reason: 'port-missing:existingKeys' };
  let raw;
  try {
    raw = port();
  } catch {
    return { keys: null, reason: 'port-threw:existingKeys' };
  }
  if (raw === undefined || raw === null) return { keys: new Set(), reason: '' };
  const keys = new Set();
  try {
    for (const k of /** @type {Iterable<unknown>} */ (raw)) {
      if (typeof k === 'string' && k.length > 0) keys.add(k);
    }
  } catch {
    // A non-iterable is a wiring defect, and guessing "no duplicates" from it
    // would be the double-count this function exists to avoid.
    return { keys: null, reason: 'port-threw:existingKeys' };
  }
  return { keys, reason: '' };
}

/**
 * Append one line through the port, and say what happened to it.
 *
 * @param {unknown} append
 * @param {object} input
 * @returns {{ status: 'appended'|'rejected', reason?: string }}
 */
function appendOne(append, input) {
  if (typeof append !== 'function') return { status: 'rejected', reason: 'port-missing:append' };
  let res;
  try {
    res = append(input);
  } catch {
    return { status: 'rejected', reason: 'port-threw:append' };
  }
  if (res && typeof res === 'object' && /** @type {any} */ (res).ok) return { status: 'appended' };
  const reason = /** @type {any} */ (res)?.reason;
  return { status: 'rejected', reason: typeof reason === 'string' && reason ? reason : 'append-failed' };
}

/**
 * Record a verdict as `verify.completed` lines through injected ports.
 *
 * NEVER THROWS. A throwing port becomes a `rejected` line with
 * `port-threw:<name>`, because a verdict that could not be recorded is a fact
 * the caller has to be able to report, and an exception out of here would make
 * the whole verification look like it never ran.
 *
 * @param {object} verdict - A `verify()` result.
 * @param {{ sessionId?: string, missionId?: string, includeOverall?: boolean }} [ctx]
 * @param {{ append?: (input: object) => object, existingKeys?: () => Iterable<string> }} [ports]
 *   `append` is `lib/runtime/ledger.js#appendLedgerEvent` bound to a project
 *   root; `existingKeys` is optional and defaults to "no keys known".
 * @returns {{ appended: number, deduped: number, rejected: number, skipped: number,
 *   reason?: string, lines: Array<{ key: string, layer: string|null,
 *   status: 'appended'|'deduped'|'rejected', reason?: string }> }}
 *   `skipped: 1` with `lines: []` and a `reason` means nothing was built.
 */
export function recordVerification(verdict, ctx = {}, ports = {}) {
  const built = buildVerifyCompletedEvents(verdict, ctx);
  if (!built.ok) {
    return { appended: 0, deduped: 0, rejected: 0, skipped: 1, reason: built.reason, lines: [] };
  }
  const p = ports && typeof ports === 'object' && !Array.isArray(ports) ? /** @type {any} */ (ports) : {};
  const seen = readExistingKeys(p.existingKeys);
  const tally = { appended: 0, deduped: 0, rejected: 0, skipped: 0 };
  const lines = [];
  for (const input of built.inputs) {
    const key = input.idempotency_key;
    const layer = Object.prototype.hasOwnProperty.call(input.data, 'layer') ? input.data.layer : null;
    if (seen.keys === null) {
      tally.rejected += 1;
      lines.push({ key, layer, status: 'rejected', reason: seen.reason });
      continue;
    }
    if (seen.keys.has(key)) {
      tally.deduped += 1;
      lines.push({ key, layer, status: 'deduped' });
      continue;
    }
    const outcome = appendOne(p.append, input);
    if (outcome.status === 'appended') {
      seen.keys.add(key);
      tally.appended += 1;
      lines.push({ key, layer, status: 'appended' });
    } else {
      tally.rejected += 1;
      lines.push({ key, layer, status: 'rejected', reason: outcome.reason });
    }
  }
  return { ...tally, lines };
}
