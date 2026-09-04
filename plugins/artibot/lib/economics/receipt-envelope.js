/**
 * Envelope adapter for Attempt Receipts.
 *
 * `usage-receipt.js` deliberately stops at receipt DATA — it "does not append
 * to the ledger" (its own header). This module is the missing half: it turns
 * that data into the `usage.receipt` envelope inputs
 * `lib/runtime/event-writer.js#writeEvent` accepts, and nothing else. It reads
 * no files, imports no module, and holds no state, so it can be exercised
 * without a ledger, a transcript, or a clock.
 *
 * WHY THE IDEMPOTENCY KEY EXISTS
 * ------------------------------
 * `lib/runtime/ledger.js#applyUsageReceipt` SUMS every `usage.receipt` line it
 * folds. A SessionEnd that fires twice over one session — a `--resume` that
 * ends again is the observed way — would therefore double the spend of every
 * run it already recorded. The key names the (session, run, model) triple that
 * one receipt covers, so a caller can ask the ledger whether that exact receipt
 * is already there before appending a second one.
 *
 * The triple is (session, run, model) rather than (session, run) because
 * `buildUsageReceipts` splits a run that served more than one model into one
 * receipt per model (its `meta.multiModelRuns`). Keying on the run alone would
 * make the second model's receipt look like a repeat of the first and drop
 * real spend.
 *
 * THE KEY HAS NO CONTENT COMPONENT, AND THAT IS A CHOSEN UNDER-COUNT. A session
 * that ends, resumes, and ends again has a LARGER transcript the second time,
 * but its (session, run, model) triples are the same, so the second SessionEnd
 * skips them and the increment is never recorded. Putting a counter into the
 * key would record both lines, and the ledger's fold would then sum them —
 * the double count this key exists to prevent. Measured 2026-09-05: a manual
 * SessionEnd at 08:44 froze the main run at requests=33/output=44,602 while
 * a re-parse at 08:50 read 45/54,885. Fixing this belongs to the reader
 * (`ledger.js#applyUsageReceipt`, latest-per-key instead of sum), not here.
 *
 * SOURCE
 * ------
 * The envelope's `source` names WHO WROTE THE LINE, not whose tokens it
 * counts, and the SessionEnd hook writes it. So these envelopes carry
 * `source: 'hook'` and `schemas/ledger-events.allowlist.json#/events/usage.receipt`
 * lists `hook` alongside the pre-existing `worker`.
 * {@link USAGE_RECEIPT_SOURCE} is the single place that spelling lives.
 *
 * @module lib/economics/receipt-envelope
 */

/**
 * Ledger event name these envelopes carry.
 * Must match the key in `schemas/ledger-events.allowlist.json#/events`.
 * @type {string}
 */
export const USAGE_RECEIPT_EVENT = 'usage.receipt';

/**
 * Envelope `source` for a usage receipt.
 *
 * `hook`, by leader ruling 2026-09-05: the envelope's `source` field records
 * WHICH SUBJECT WROTE THE LINE, and the line is written by the SessionEnd hook
 * (`scripts/hooks/session-end.js#recordUsageReceipts`). The worker whose tokens
 * the receipt counts is not the writer, and it is already named inside the
 * data — `run_id` identifies the spawn, so nothing is lost by spelling the
 * writer honestly here.
 *
 * The allowlist was widened to match rather than the constant bent to fit the
 * allowlist: `sources` now reads `["worker", "hook"]`, keeping `worker` valid
 * for any future in-process writer. If that ruling reverses, this constant is
 * the only code edit.
 * @type {string}
 */
export const USAGE_RECEIPT_SOURCE = 'hook';

/**
 * Fields a receipt must carry as non-empty strings before it can be enveloped.
 *
 * An ALLOWLIST of what must be present, not a denylist of known-bad shapes:
 * `run_id` and `mission_id` are envelope identity fields (a mismatch is a
 * `receipt-identity-mismatch` rejection) and `model_identity.model_id` is what
 * makes the key unique per model. Anything missing one of them cannot be keyed
 * correctly, so it is dropped rather than enveloped with `undefined` in the key.
 * @type {readonly string[]}
 */
const REQUIRED_RECEIPT_PATHS = Object.freeze(['run_id', 'mission_id', 'model_identity.model_id']);

/**
 * Read a dotted path and return it only when it is a non-empty string.
 * @param {unknown} obj
 * @param {string} dotted
 * @returns {string|null}
 */
function readString(obj, dotted) {
  let cursor = obj;
  for (const segment of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = cursor[segment];
  }
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
}

/**
 * Whether a receipt carries every field {@link toUsageReceiptEnvelopes} needs.
 * @param {unknown} receipt
 * @returns {boolean}
 */
function isEnvelopable(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  return REQUIRED_RECEIPT_PATHS.every((dotted) => readString(receipt, dotted) !== null);
}

/**
 * The key that identifies one receipt's spend within one session.
 *
 * Colon-joined because every component is already a constrained identifier
 * (a session id, a transcript file stem, a catalog model id) and none of them
 * contains a colon in any observed shape. Total by design: a malformed receipt
 * yields a key containing `undefined` rather than throwing, because the caller
 * that filters malformed receipts is {@link toUsageReceiptEnvelopes} and this
 * function must stay usable for a plain lookup.
 *
 * @param {string} sessionId - Envelope `session_id`.
 * @param {object} receipt - One Attempt Receipt.
 * @returns {string} `usage.receipt:<session>:<run>:<model_id>`
 */
export function usageReceiptIdempotencyKey(sessionId, receipt) {
  const runId = receipt?.run_id;
  const modelId = receipt?.model_identity?.model_id;
  return `${USAGE_RECEIPT_EVENT}:${sessionId}:${runId}:${modelId}`;
}

/**
 * Turn Attempt Receipts into `usage.receipt` envelope inputs.
 *
 * The identity fields are lifted from the receipt onto the envelope on
 * purpose: `event-writer.js#RECEIPT_IDENTITY_FIELDS` requires that a key
 * present on both sides agrees, and lifting them is what makes the ledger
 * queryable by `mission_id` / `run_id` without parsing `data`.
 *
 * ARGUMENTS throw; CONTENT does not. A missing session id would produce a key
 * that silently collides across sessions, so it fails loudly. A single
 * malformed receipt is dropped from the result instead — the other receipts in
 * the same session are real measurements and refusing all of them would lose
 * spend that was correctly measured.
 *
 * @param {object[]} receipts - Receipts from `buildUsageReceipts`.
 * @param {object} options
 * @param {string} options.sessionId - The session the receipts were read from.
 * @returns {object[]} One envelope input per well-formed receipt, in order.
 * @throws {TypeError} When `sessionId` is not a non-empty string, or
 *   `receipts` is not an array.
 */
export function toUsageReceiptEnvelopes(receipts, options = {}) {
  const { sessionId } = options ?? {};
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('toUsageReceiptEnvelopes: sessionId must be a non-empty string');
  }
  if (!Array.isArray(receipts)) {
    throw new TypeError('toUsageReceiptEnvelopes: receipts must be an array');
  }

  const envelopes = [];
  for (const receipt of receipts) {
    if (!isEnvelopable(receipt)) continue;
    envelopes.push({
      event: USAGE_RECEIPT_EVENT,
      session_id: sessionId,
      mission_id: receipt.mission_id,
      run_id: receipt.run_id,
      model: receipt.model_identity.model_id,
      idempotency_key: usageReceiptIdempotencyKey(sessionId, receipt),
      source: USAGE_RECEIPT_SOURCE,
      data: receipt,
    });
  }
  return envelopes;
}
