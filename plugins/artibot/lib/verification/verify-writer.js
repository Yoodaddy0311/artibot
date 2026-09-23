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

// ---------------------------------------------------------------------------
// The byte cap
// ---------------------------------------------------------------------------

/**
 * ── Why the writer bounds evidence at all ───────────────────────────────────
 * The deterministic adapter (`./unified-verifier.js#normalizeDeterministic`,
 * :311-319 on 2026-09-12) puts a command's FULL stdout+stderr into
 * `evidence[0].output` and truncates nothing. A vitest run is a few KB, so an
 * unbounded line is several times the ledger's cap, and the ledger's own
 * overflow path cannot save it: `lib/runtime/event-writer.js#foldOversized`
 * (:658 on 2026-09-12) drops only the keys the event does NOT require, which for
 * `verify.completed` means `layer` and `verification_id` — `evidence` is
 * required and stays. The folded line is still over the cap, so
 * `appendWithinCap` (:752) refuses it as `line-too-large`.
 *
 * Measured before this bound existed (11:05 KST 2026-09-12): 5 KB of captured
 * output produced a 5,492-byte overall line and a 5,530-byte deterministic
 * line; 40 KB produced 41,332 and 41,370. Both over 4096, both rejected — while
 * the two layers nobody ran, carrying no evidence, landed at 334 and 336 bytes.
 * The reader therefore saw `pass 0` and two `unmeasured` lines with no
 * `verification_id`: a verdict that PASSED read as a verdict that was not
 * measured. That is the exact substitution this module exists to prevent, so
 * shortening the evidence is the honest trade and dropping the line is not.
 */

/**
 * Pinned copy of `schemas/ledger-events.allowlist.json#limits.line_max_bytes`
 * (read 2026-09-12: `4096`). Copied rather than imported because the allowlist
 * is L5 data owned by the ledger and this is an L2 module. The copy is held
 * honest by a drift assertion in `tests/verification/verify-writer.test.js`
 * that reads the allowlist and compares.
 */
export const LEDGER_LINE_MAX_BYTES = 4096;

/**
 * Bytes held back from the cap for what `lib/runtime/event-writer.js#buildEnvelope`
 * (:396 on 2026-09-12) adds AFTER this module hands its input over: `v`, `ts`,
 * `pid`, `seq`, and a `mission_id` fallback when the caller supplied none. Those
 * keys are ~113 bytes at their widest, and the test measures the real overhead
 * against this number rather than trusting the arithmetic.
 *
 * The remainder is deliberate slack for the one thing this module cannot
 * measure: `redactDeep` runs downstream and `[REDACTED_KEY]` is LONGER than the
 * short secret it replaces, so redaction can GROW a line this module already
 * sized. The slack absorbs the realistic case. It is NOT a proof — output dense
 * with short secrets could still overflow, and the ledger's own
 * fold-then-reject path stays the backstop for that.
 */
export const LINE_RESERVE_BYTES = 512;

/**
 * The evidence fields this module will shorten. `kind`, `file`, `line`,
 * `command` and `measured_at` are IDENTITY — shortening them would leave an
 * entry that no longer says which measurement it came from, which is worse than
 * a short one that does.
 */
const BOUNDED_EVIDENCE_FIELDS = Object.freeze(['output', 'note']);

/**
 * Present in every value this module shortened, so a reader can tell a short
 * output from a command that printed little. Exported for the test and for any
 * reader that needs to detect the condition rather than pattern-match prose.
 */
export const EVIDENCE_TRUNCATION_MARK = '…[truncated ';

/**
 * Names how much went, not just that something did. A bare ellipsis would let a
 * 40 KB output and a 4 KB one look alike in the ledger.
 *
 * @param {number} keptBytes
 * @param {number} totalBytes
 * @returns {string}
 */
function truncationSuffix(keptBytes, totalBytes) {
  return `${EVIDENCE_TRUNCATION_MARK}${totalBytes - keptBytes} of ${totalBytes} bytes]`;
}

/**
 * The longest prefix of `s` that fits in `maxBytes` UTF-8 bytes, cut on a
 * character boundary.
 *
 * Boundary-aware on purpose: slicing a Buffer mid-character and decoding it
 * yields U+FFFD, which re-encodes to THREE bytes and could push the line back
 * over the cap the slice was meant to bring it under.
 *
 * @param {string} s
 * @param {number} maxBytes
 * @returns {string}
 */
function sliceUtf8(s, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * A copy of one entry whose bounded fields fit `shareBytes` each, or the entry
 * itself when nothing needed shortening.
 *
 * Returns a COPY. The verdict it came from is the caller's, and
 * `verification_id` is hashed from the full evidence — mutating an entry here
 * would move the join key that ties this line to `review.md` and `outcome.md`.
 *
 * @param {unknown} entry
 * @param {number} shareBytes
 * @returns {unknown}
 */
function shrinkEvidenceEntry(entry, shareBytes) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const e = /** @type {Record<string, unknown>} */ (entry);
  let out = null;
  for (const key of BOUNDED_EVIDENCE_FIELDS) {
    const value = e[key];
    if (typeof value !== 'string') continue;
    const total = Buffer.byteLength(value, 'utf8');
    if (total <= shareBytes) continue;
    const head = sliceUtf8(value, shareBytes);
    if (out === null) out = { ...e };
    out[key] = `${head}${truncationSuffix(Buffer.byteLength(head, 'utf8'), total)}`;
  }
  return out ?? entry;
}

/**
 * The entry that stands in for evidence dropped whole. A COUNT, because an
 * absent entry reads to the gate as a smaller denominator while a counted one
 * reads as a measurement that did not fit.
 *
 * Shaped as a `command` entry so it satisfies
 * `./unified-verifier.js#canonicalEvidence` if it is ever fed back through.
 *
 * @param {number} dropped
 * @param {number} total
 * @returns {Record<string, unknown>}
 */
function dropMarkerEntry(dropped, total) {
  return {
    kind: 'command',
    command: 'verify-writer:evidence-bound',
    output: `${dropped} of ${total} evidence entries dropped to fit the ${LEDGER_LINE_MAX_BYTES}-byte ledger line cap`,
  };
}

/**
 * Serialized size of one line, newline included — the unit the cap is measured
 * in (`lib/runtime/event-writer.js#lineBytes`, :635 on 2026-09-12).
 *
 * `Infinity` for anything `JSON.stringify` refuses, which routes a circular
 * entry to the most-reduced candidate instead of throwing out of a module whose
 * contract is that it never throws.
 *
 * @param {object} input
 * @returns {number}
 */
function lineBytesOf(input) {
  try {
    return Buffer.byteLength(`${JSON.stringify(input)}\n`, 'utf8');
  } catch {
    return Infinity;
  }
}

/**
 * The most complete version of one line that fits `limit` bytes.
 *
 * Three stages, each strictly more lossy than the last, and every stage is
 * MEASURED rather than computed — JSON escaping means a string cut to N bytes
 * can serialize to more than N, so the only trustworthy budget is one that has
 * been serialized and weighed.
 *
 *   1. shorten `output`/`note` to a shared per-field budget, halving until it
 *      fits;
 *   2. shorten them to nothing but their marker;
 *   3. drop whole entries from the END, leaving a counted marker entry.
 *
 * Deterministic at every stage: the same verdict always yields the same line, so
 * a re-run dedupes on its idempotency key instead of appending a second,
 * differently-shortened copy.
 *
 * A line still over `limit` with NO evidence at all is returned as-is. That
 * needs a session or verification id of some kilobytes, and it is the one case
 * this module genuinely cannot fix — the ledger's rejection is then the right
 * outcome rather than something to paper over here.
 *
 * @param {(evidence: Array<unknown>) => object} build
 * @param {Array<unknown>} evidence
 * @param {number} limit
 * @returns {object}
 */
function fitLine(build, evidence, limit) {
  const full = build(evidence);
  if (lineBytesOf(full) <= limit) return full;

  const emptied = evidence.map((e) => shrinkEvidenceEntry(e, 0));
  const floor = lineBytesOf(build(emptied));
  let share = Math.max(0, limit - floor);
  while (share > 0) {
    const candidate = build(evidence.map((e) => shrinkEvidenceEntry(e, share)));
    if (lineBytesOf(candidate) <= limit) return candidate;
    share = Math.floor(share / 2);
  }

  const bare = build(emptied);
  if (lineBytesOf(bare) <= limit) return bare;

  for (let keep = emptied.length - 1; keep >= 0; keep -= 1) {
    const candidate = build([
      ...emptied.slice(0, keep),
      dropMarkerEntry(emptied.length - keep, emptied.length),
    ]);
    if (lineBytesOf(candidate) <= limit) return candidate;
  }
  return build([]);
}

/**
 * One ledger envelope input. `data` carries the four contract keys and nothing
 * else — an envelope key duplicated into `data` would be a second, divergent
 * copy of a field the envelope already owns.
 *
 * `data.evidence` is bounded here, at the last point before the line leaves this
 * module. The verdict's own evidence is untouched.
 *
 * @param {{ sessionId: string, missionId: string|null, verificationId: string,
 *   layer: string|null, result: string, evidence: Array<unknown> }} p
 * @returns {object}
 */
function verifyEventInput(p) {
  const build = (evidence) => {
    const data = {};
    if (p.layer !== null) data.layer = p.layer;
    data.result = p.result;
    data.evidence = evidence;
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
  };
  return fitLine(build, p.evidence, LEDGER_LINE_MAX_BYTES - LINE_RESERVE_BYTES);
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
 * Register one APPENDED line's evidence through the optional port.
 *
 * The evidence handed over is the line's own `data.evidence`, after the byte cap
 * shortened it, not the verdict's. It is still PRE-REDACTION: the ledger
 * redacts inside its own append (`lib/runtime/event-writer.js`, `redactDeep`
 * over the built envelope, :816 on 2026-09-23), and the append result does not
 * return the stored envelope. This module cannot import that redaction (L2 may
 * not import `lib/runtime/`), so the PORT CONTRACT carries the obligation:
 *
 *   The bound port MUST register `entries` exactly as the ledger stores them:
 *   redacted by `lib/runtime/ledger-redaction.js#redactDeep` AT THE ENVELOPE'S
 *   `data.evidence` POSITION, i.e.
 *   `redactDeep({ data: { evidence: entries } }).data.evidence`.
 *
 * A bare `redactDeep(entries)` is not the same pass. The walk counts
 * `MAX_REDACT_DEPTH` (64) from the value it is given, and the ledger gives it the
 * envelope, where the evidence sits two levels down. So a `note` nested 61+ deep
 * is cut to the depth marker in the ledger and survives a bare call (B3 probe,
 * 2026-09-23). The node budget (`MAX_REDACT_NODES`) counts object nodes, and
 * every envelope member walked before `data.evidence` is a scalar, so the
 * wrapper reproduces that count too. That is read from the code, not measured.
 *
 * Two things depend on it. First, the hash would otherwise be a confirmation
 * oracle for a redacted secret: the ledger shows `[REDACTED_…]`, but anyone
 * who can guess the secret can hash a candidate entry and match it against the
 * registry row. Second, only then does a registry row's hash recompute from the
 * ledger line its `source` names. Otherwise the hash matches the line only when
 * redaction changed nothing.
 *
 * `source` is that line's idempotency key, which already begins with the event
 * name (`verify.completed:<session>:<verification_id>[:<layer>]`). The row
 * points at the line. The line carries no evidence ids: its `data` allowlist
 * and 4 KB cap belong to the ledger.
 *
 * @param {Function} port - `lib/verification/evidence-registry.js#registerEvidence`
 *   bound to a project root, as `(entries, source) => result`, registering
 *   `entries` redacted at the envelope's `data.evidence` position (see above).
 * @param {object} input - The envelope input that was just appended.
 * @returns {{ ids: string[], appended: number, reused: number, reason?: string }}
 */
function registerLineEvidence(port, input) {
  const failed = (reason) => ({ ids: [], appended: 0, reused: 0, reason });
  let res;
  try {
    res = port(input.data.evidence, input.idempotency_key);
  } catch {
    return failed('port-threw:registerEvidence');
  }
  const r = /** @type {any} */ (res);
  if (!r || typeof r !== 'object' || !Array.isArray(r.ids)
    || !Number.isInteger(r.appended) || !Number.isInteger(r.reused)) {
    return failed('port-invalid:registerEvidence');
  }
  const ids = r.ids.filter((id) => typeof id === 'string' && id.length > 0);
  const out = { ids, appended: r.appended, reused: r.reused };
  return typeof r.reason === 'string' && r.reason ? { ...out, reason: r.reason } : out;
}

/**
 * Fold one line's registration into the running result. Each id is kept once:
 * the overall line and a layer line carry the same entries, so the second
 * registration answers with ids the first one already reported.
 *
 * @param {{ ids: string[], appended: number, reused: number }} acc - Mutated.
 * @param {Set<string>} reasons - Mutated.
 * @param {{ ids: string[], appended: number, reused: number, reason?: string }} r
 * @returns {void}
 */
function mergeLineEvidence(acc, reasons, r) {
  for (const id of r.ids) {
    if (!acc.ids.includes(id)) acc.ids.push(id);
  }
  acc.appended += r.appended;
  acc.reused += r.reused;
  if (r.reason) reasons.add(r.reason);
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
 * @param {{ append?: (input: object) => object, existingKeys?: () => Iterable<string>,
 *   registerEvidence?: (entries: Array<unknown>, source: string) =>
 *     { ids: string[], appended: number, reused: number, reason?: string } }} [ports]
 *   `append` is `lib/runtime/ledger.js#appendLedgerEvent` bound to a project
 *   root; `existingKeys` is optional and defaults to "no keys known".
 *   `registerEvidence` is optional too: `lib/verification/evidence-registry.js#registerEvidence`
 *   bound to a project root, and it MUST register `entries` exactly as the ledger
 *   stores them: `lib/runtime/ledger-redaction.js#redactDeep` applied at the
 *   envelope's `data.evidence` position,
 *   `redactDeep({ data: { evidence: entries } }).data.evidence`, not a bare
 *   `redactDeep(entries)`. `entries` arrive here unredacted. Registered any
 *   other way, the hash is a confirmation oracle for a secret the ledger
 *   redacted and no longer recomputes from the stored line
 *   (see {@link registerLineEvidence}). It is called
 *   once per APPENDED line that carries evidence, in line order, in a second
 *   pass AFTER every append has been attempted. A held or stranded registry lock
 *   can stall for up to the file lock's 5 s timeout, and in the second pass that
 *   stall cannot delay a ledger line. A deduped or rejected line registers
 *   nothing. Its failures never change the tally.
 * @returns {{ appended: number, deduped: number, rejected: number, skipped: number,
 *   reason?: string, lines: Array<{ key: string, layer: string|null,
 *   status: 'appended'|'deduped'|'rejected', reason?: string }>,
 *   evidence?: { ids: string[], appended: number, reused: number, reason?: string } }}
 *   `skipped: 1` with `lines: []` and a `reason` means nothing was built.
 *   `evidence` is present only when a `registerEvidence` port was supplied.
 *   `ids` holds each registry id once. `reason` holds the distinct port failures
 *   joined with `; `.
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
  const wantsEvidence = p.registerEvidence !== undefined && p.registerEvidence !== null;
  const evidence = { ids: [], appended: 0, reused: 0 };
  const evidenceReasons = new Set();
  const appendedInputs = [];
  if (wantsEvidence && typeof p.registerEvidence !== 'function') evidenceReasons.add('port-missing:registerEvidence');
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
      appendedInputs.push(input);
    } else {
      tally.rejected += 1;
      lines.push({ key, layer, status: 'rejected', reason: outcome.reason });
    }
  }
  if (!wantsEvidence) return { ...tally, lines };
  // Second pass: every ledger append is already done, so a slow registry lock
  // delays only the registration.
  for (const input of appendedInputs) {
    if (typeof p.registerEvidence === 'function'
      && Array.isArray(input.data.evidence) && input.data.evidence.length > 0) {
      mergeLineEvidence(evidence, evidenceReasons, registerLineEvidence(p.registerEvidence, input));
    }
  }
  const reason = [...evidenceReasons].join('; ');
  return { ...tally, lines, evidence: reason ? { ...evidence, reason } : evidence };
}
