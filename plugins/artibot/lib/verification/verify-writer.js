/**
 * `lib/verification/verify-writer.js` — the `verify.completed` ledger writer:
 * pure envelope builders plus one port-driven recorder.
 *
 * ── Why this is a sibling module and still does no I/O ───────────────────────
 * The fold lives in `./unified-verifier.js`; this file only turns a finished
 * verdict into ledger lines, so the two have no reason to share a file — and
 * keeping them apart is what stops the verifier from growing past the 800-line
 * guideline it had already reached with both halves in it.
 *
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
 *
 * @module lib/verification/verify-writer
 */

import { describe, LAYERS } from './unified-verifier.js';

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
