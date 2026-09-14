/**
 * `lib/verification/verify-rate.js` — the pure fold that turns `verify.completed`
 * ledger lines into "how many Stop-hook denominators did a `/verify`
 * self-report answer?".
 *
 * ── Two writers, one event ──────────────────────────────────────────────────
 * `scripts/hooks/dev-verify-gate.js#recordUnmeasuredDenominator` (:315, read
 * 2026-09-14) writes the DENOMINATOR: `verify({ layers: {} })` folded to four
 * lines, every layer `unmeasured`, evidence empty. It fires whether or not any
 * verification happened. `scripts/ledger/record-verify.mjs` writes the
 * NUMERATOR: four lines for one `/verify` self-report. Both carry
 * `source: 'gate'` because the allowlist accepts no other value
 * (`schemas/ledger-events.allowlist.json:401`), and there is no `kind_source`
 * field to add. So the ONLY ledger-visible difference between the two writers
 * is {@link SELF_REPORT_NOTE} sitting in `data.evidence[0].note`.
 *
 * ── WHY THE UNIT IS `verification_id`, NOT THE LINE ─────────────────────────
 * Only the DETERMINISTIC line of a self-report carries that note
 * (`record-verify.mjs:315`). Its behavioral and operational lines are
 * `unmeasured` with empty evidence — byte-identical in shape to the hook's.
 * Classifying line by line would therefore read every self-report as three
 * extra hook firings: the denominator grows by 3 for each numerator of 1, and
 * a repository where EVERY session self-reported would still report a rate of
 * 25%. Lines are grouped first, and the group is classified once.
 *
 * THE GROUPING KEY IS `(session_id, verification_id)`, NOT THE ID ALONE. A
 * `verification_id` is `v1-<hash of the verdict>-<stamp at SECOND resolution>`
 * (`unified-verifier.js#buildVerificationId` :534-577), and the hook's verdict
 * is the CONSTANT `verify({ layers: {} })` — so its hash never varies. Measured
 * 2026-09-14 14:47 KST: five back-to-back calls returned one id
 * (`v1-83866286c2d8-20260914T054755Z`, 5 of 5 identical), and all 13
 * `verification_id`s in this machine's live ledger share the hash
 * `83866286c2d8`. Only the second separates two sessions' Stop hooks, so two
 * that fire in the same second collide — and keying on the id alone would fold
 * them into ONE firing, under-counting the denominator exactly when the machine
 * is busiest. The writer already treats the pair as the identity:
 * `verify-writer.js#verifyCompletedIdempotencyKey` (:101-102) keys on
 * `<event>:<session>:<verification_id>[:layer]`.
 *
 * ── Three buckets, and nothing guessed into the first two ───────────────────
 * self_report — some line of the id carries the note.
 * hook        — no note, and some line is `unmeasured`.
 * other       — everything else, which today means a real measurement nobody
 *               writes yet. It is reported rather than folded into `hook`,
 *               because a future measured line is not a missing self-report.
 *
 * ── WHAT THIS READER CANNOT SEE (rules §9 — stated next to the number) ──────
 *  - "NO /verify RAN" vs "NOBODY REPORTED ONE". Identical in the ledger, and
 *    this module cannot separate them. `record-verify.mjs:106-111` says the
 *    same thing from the writer's side. A low rate is not evidence that
 *    verification is not happening.
 *  - A SELF-REPORT IN A SESSION THE HOOK NEVER FIRED IN. Counted in
 *    `ids.self_report` and `sessions.self_report`, and in NO rate — it has no
 *    denominator to belong to. Both rates therefore undercount the reporting
 *    that actually happened.
 *  - UPSTREAM LOSS. This module never touches a file. A line the ledger reader
 *    dropped is invisible here; only the census that
 *    `scripts/ledger/verify-rate.mjs` prints beside the rate can show it.
 *  - A LINE WITH NO `session_id`. The envelope writer refuses one
 *    (`lib/runtime/event-writer.js:444-445`), but the reader does not
 *    (`lib/runtime/ledger.js:270` checks only `event`), so a hand-written or
 *    externally-produced line reaches this fold. Such an id is counted in
 *    `ids.*` and joined to NOTHING: it appears in no session and in neither
 *    rate. Pooling every sessionless id under one empty key would be worse
 *    than dropping it — two unrelated runs would answer each other and invent
 *    a rate of 1.
 *  - A LINE WITH NO `verification_id`. That field is OPTIONAL in the allowlist
 *    (`ledger-events.allowlist.json:382` requires `result` and `evidence`
 *    only), so such a line is valid and unjoinable. It is counted in
 *    `lines.verify_completed` and in no id.
 *  - WHETHER A SELF-REPORT IS TRUE. `--status PASS` is a claim; nothing behind
 *    it ran a linter.
 *  - HOW LITTLE HISTORY THERE IS TO READ. Measured on this machine's parent
 *    ledger 2026-09-14 14:31 KST: 810 non-blank lines spanning 2026-09-03 to
 *    that moment, of which 16 are `verify.completed` — 4 hook firings over 3
 *    sessions, 0 self-reports, every one of them written between 14:21 and
 *    14:28 KST that same day. The denominator only just started being written;
 *    a rate over it is a reading of the last ten minutes, not of the eleven
 *    days the ledger covers. A `null` rate is an absent measurement, a `0` one
 *    is four unanswered firings, and neither is a trend.
 *
 * @module lib/verification/verify-rate
 */

import { VERIFY_COMPLETED_EVENT } from './verify-writer.js';

export { VERIFY_COMPLETED_EVENT };

/**
 * The one ledger-visible mark separating a self-reported line from one a hook
 * measured.
 *
 * A PINNED COPY of `scripts/ledger/record-verify.mjs#SELF_REPORT_NOTE`, not an
 * import: a library module importing a script inverts the dependency and would
 * drag `unified-verifier.js` plus the ledger writer into every reader. The two
 * strings are asserted byte-equal by `tests/verification/verify-rate.test.js`,
 * so the copy cannot drift silently.
 */
export const SELF_REPORT_NOTE = 'self-report: recorded by scripts/ledger/record-verify.mjs';

/** `v1-<12 hex>-<YYYYMMDDTHHMMSSZ>` (`unified-verifier.js#buildVerificationId` :573). */
const STAMP_SHAPE = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Does this line carry the self-report marker?
 *
 * Entry ZERO only. `verify-writer.js#fitLine` drops evidence from the END to
 * fit the 4096-byte line cap, which is why the writer puts the marker first
 * (`record-verify.mjs:63-65`); a marker found further back survived a
 * different code path than the one this reader has a contract with.
 *
 * @param {unknown} event one ledger line
 * @returns {boolean}
 */
export function isSelfReportLine(event) {
  if (event === null || typeof event !== 'object') return false;
  const { evidence } = /** @type {{data?: {evidence?: unknown}}} */ (event).data ?? {};
  return Array.isArray(evidence) && evidence[0]?.note === SELF_REPORT_NOTE;
}

/**
 * When this verification happened, in epoch ms, or `null` when neither source
 * can say.
 *
 * `ts` first because it is the envelope's own clock; the stamp inside
 * `verification_id` is a fallback at SECOND resolution, and it is `unknown`
 * whenever the verifier had no usable clock.
 *
 * @param {{ts?: unknown}} event
 * @param {string} id
 * @returns {number|null}
 */
function orderingKey(event, id) {
  const fromTs = Date.parse(/** @type {string} */ (event.ts));
  if (Number.isFinite(fromTs)) return fromTs;
  const m = STAMP_SHAPE.exec(id);
  if (m === null) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * Group the lines by `(session_id, verification_id)`, counting every line that
 * could not be grouped.
 *
 * The separator is `\0` rather than a colon or a space for the reason
 * `lib/runtime/ledger.js#dedupeKey` (:131-133) gives: a session id is
 * caller-supplied, so without a byte that cannot occur inside a field two
 * different pairs could be spelled into the same key.
 *
 * @param {unknown[]} events
 * @returns {{lines: {total: number, verify_completed: number, skipped: number},
 *            ids: Map<string, {id: string, session: string, selfReport: boolean,
 *                              unmeasured: boolean, at: number|null}>}}
 */
function groupById(events) {
  const lines = { total: 0, verify_completed: 0, skipped: 0 };
  const ids = new Map();
  for (const event of events) {
    lines.total += 1;
    if (event === null || typeof event !== 'object'
      || /** @type {{event?: unknown}} */ (event).event !== VERIFY_COMPLETED_EVENT) {
      lines.skipped += 1;
      continue;
    }
    lines.verify_completed += 1;
    const e = /** @type {{session_id?: unknown, data?: {verification_id?: unknown, result?: unknown}}} */ (event);
    const id = e.data?.verification_id;
    if (typeof id !== 'string' || id === '') continue;
    const session = typeof e.session_id === 'string' ? e.session_id : '';
    const at = orderingKey(e, id);
    const prior = ids.get(`${session}\0${id}`);
    if (prior === undefined) {
      ids.set(`${session}\0${id}`, {
        id,
        session,
        selfReport: isSelfReportLine(event),
        unmeasured: e.data?.result === 'unmeasured',
        at,
      });
      continue;
    }
    prior.selfReport = prior.selfReport || isSelfReportLine(event);
    prior.unmeasured = prior.unmeasured || e.data?.result === 'unmeasured';
    // First seen wins: a run's position in time is when it STARTED.
    if (at !== null && (prior.at === null || at < prior.at)) prior.at = at;
  }
  return { lines, ids };
}

/**
 * Split the grouped runs into the three buckets, and index the joinable ones
 * by session.
 *
 * `counts` covers every run. `bySession` covers only those with a session to
 * join on, so `counts.hook` and the firing denominator can legitimately differ
 * — see the sessionless bullet in the module header.
 *
 * @param {Map<string, {id: string, session: string, selfReport: boolean,
 *                      unmeasured: boolean, at: number|null}>} ids
 * @returns {{counts: {hook: number, self_report: number, other: number, unknown_stamp: number},
 *            bySession: Map<string, {hook: object[], self: object[]}>,
 *            unordered: number}}
 */
function classify(ids) {
  const counts = { hook: 0, self_report: 0, other: 0, unknown_stamp: 0 };
  const bySession = new Map();
  let unordered = 0;
  for (const rec of ids.values()) {
    if (!STAMP_SHAPE.test(rec.id)) counts.unknown_stamp += 1;
    const bucket = rec.selfReport ? 'self' : (rec.unmeasured ? 'hook' : null);
    if (bucket === null) {
      counts.other += 1;
      continue;
    }
    if (bucket === 'self') counts.self_report += 1;
    else counts.hook += 1;
    if (rec.session === '') continue;
    if (rec.at === null) unordered += 1;
    if (!bySession.has(rec.session)) bySession.set(rec.session, { hook: [], self: [] });
    bySession.get(rec.session)[bucket].push(rec);
  }
  return { counts, bySession, unordered };
}

/**
 * A rate, or `null` when there is no denominator to divide by.
 *
 * Never `NaN`: `0/0` printed as a number reads to a dashboard as a real
 * measurement of zero, which is the opposite of "nothing was measured".
 *
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number|null}
 */
function rateOf(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * @typedef {object} VerifyRate
 * @property {{total: number, verify_completed: number, skipped: number}} lines
 * @property {{hook: number, self_report: number, other: number, unknown_stamp: number}} ids
 *   `unknown_stamp` OVERLAPS the three buckets — it counts runs whose
 *   `verification_id` does NOT end in a `YYYYMMDDTHHMMSSZ` stamp, of which
 *   `-unknown` is the writer's own spelling (`buildVerificationId` :573-575).
 *   A clock problem, not a fourth kind of verification.
 * @property {{hook: number, self_report: number, answered: number, rate: number|null}} sessions
 *   `answered` = sessions holding at least one hook id AND at least one
 *   self-report id, in any order.
 * @property {{hook: number, answered: number, unordered: number, rate: number|null}} firings
 *   Per hook run: answered iff the same session holds a self-report run that
 *   started at or after it. `hook` here counts only runs that HAVE a session to
 *   join on, so it is `ids.hook` minus the sessionless ones — a denominator
 *   that included runs nothing could ever answer would read low for a
 *   bookkeeping reason. `unordered` counts joinable runs of EITHER bucket whose
 *   position in time could not be established — an overlapping count, and a
 *   reason a low `rate` may be a reading problem rather than a reporting one.
 */

/**
 * Fold `verify.completed` lines into the answered-firing rate. Pure, never
 * throws, and accepts any input: a reader whose job is to measure a gap must
 * not become the gap.
 *
 * @param {unknown} events ledger lines, in any order
 * @returns {VerifyRate}
 */
export function computeVerifyRate(events) {
  const { lines, ids } = groupById(Array.isArray(events) ? events : []);
  const { counts, bySession, unordered } = classify(ids);

  const sessions = { hook: 0, self_report: 0, answered: 0, rate: null };
  const firings = { hook: 0, answered: 0, unordered, rate: null };
  for (const { hook, self } of bySession.values()) {
    firings.hook += hook.length;
    if (hook.length > 0) sessions.hook += 1;
    if (self.length > 0) sessions.self_report += 1;
    if (hook.length > 0 && self.length > 0) sessions.answered += 1;
    for (const fire of hook) {
      if (fire.at === null) continue;
      if (self.some((s) => s.at !== null && s.at >= fire.at)) firings.answered += 1;
    }
  }
  sessions.rate = rateOf(sessions.answered, sessions.hook);
  firings.rate = rateOf(firings.answered, firings.hook);

  return { lines, ids: counts, sessions, firings };
}
