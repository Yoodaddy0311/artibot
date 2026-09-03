/**
 * Replay — the central ledger's READ MODEL, reconstructed per Action.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * The ledger (`.artibot/runtime/ledger.jsonl`) is the record. This module turns
 * that flat event stream into an index keyed by Action, so a consumer can ask
 * "what happened in this action" without re-scanning the stream itself.
 *
 * The index is a REGENERABLE PROJECTION and nothing here persists it. Design
 * §8.3-2 settled this explicitly: the author's proposal of an independent
 * Replay Store was conceded, and Replay became "원장의 읽기 모델(재생성 가능
 * 인덱스). 정본은 ledger.jsonl 하나" (ARTIBOT-5.0-DESIGN.md §8.3-2; also the
 * §6·§43 row of §8.2, "Replay Store 는 원장의 읽기 모델(인덱스) 이지 두 번째 진실원이
 * 아니다"). A projection that gets persisted becomes a second source of truth,
 * and then the two disagree — the same reasoning `lib/runtime/ledger.js` gives
 * for `foldMissions`. So there is no persistence API in this directory at all:
 * `serializeIndex` returns a STRING and the caller decides what to do with it.
 * `tests/replay/no-second-source.test.js` greps this directory to keep it that
 * way, because a rule stated only in a comment is not a rule.
 *
 * PURITY (design §1-8, L2)
 * ---------------------------------------------------------------------------
 * No clock, no filesystem, no randomness. `buildReplay` takes an events ARRAY.
 * Reading the ledger from disk is `./load.js`, and even that module holds no
 * filesystem call of its own — it receives the reader as an injected port. See
 * that file's header for why the obvious `import { readAllEvents }` is a layer
 * violation rather than a convenience.
 *
 * NOT A SECOND ANSWER TO `foldMissions`
 * ---------------------------------------------------------------------------
 * `ledger.js#foldMissions` reconstructs the v1.0 run-ledger SHAPE per mission
 * (route/economics/execution/review/verification/outcome). `missions[]` here is
 * deliberately a DIFFERENT view: which actions a mission contains, its event
 * histogram, and its time span. It carries no verdict, no cost total, and no
 * accepted flag. Two modules answering "what was this mission's cost" with
 * separately-maintained arithmetic is how the two answers drift, so this one
 * does not answer it.
 *
 * ── WHAT THIS MODULE CANNOT SEE (repo rule §9: write it next to the gate) ────
 *  1. WHETHER AN ACTION IS REALLY ONE ACTION. `action_id` is OPTIONAL in the
 *     envelope. When a line has none, the action key is DERIVED from
 *     `routing_epoch_id` (the epoch's effective unit is the spawn, decision G1)
 *     or, failing that, from `(mission_id, session_id)` — which lumps a whole
 *     session into one bucket. Every action record carries `keyed_by` saying
 *     which of the three it was, and the index carries `attribution` counts, so
 *     a consumer can tell a measured action from a derived one instead of
 *     reading both as the same thing. A derived action is NOT a gap (nothing is
 *     missing from the ledger), which is why it is reported as resolution and
 *     not as damage.
 *  2. WHETHER A `seq` GAP IS A LOST LINE. A gap in `(source, pid, seq)` is
 *     consistent with a lost write AND with a process that emitted through more
 *     than one path. It is reported, never judged. Counting gaps as a health
 *     verdict is /doctor Check 8's job (T-43); duplicating that judgment here
 *     would create a second answer to one question.
 *  3. THE DEDUPE KEY IS DUPLICATED FROM `ledger.js#dedupeEvents`. Both key on
 *     `(session_id, source, pid, seq)` joined with NUL (verified 2026-09-02
 *     17:5x against `ledger.js#dedupeKey`, same term order, same separator).
 *     This module cannot import that function — it lives at L5 and this is L2 —
 *     so the key is restated here and compared BEHAVIOURALLY by
 *     `tests/replay/no-second-source.test.js`. If that test is deleted, the two
 *     can drift silently.
 *  4. THE ENVELOPE CONTRACT IS A LOCAL COPY. `REQUIRED_ENVELOPE_KEYS` restates
 *     `schemas/ledger-envelope.schema.json#/required` because reading the
 *     schema file would mean filesystem access in a pure module. The test suite
 *     reads the schema and compares, so the copy cannot drift unnoticed. What
 *     is checked here is PRESENCE AND PRIMITIVE TYPE — not the `ts` pattern,
 *     not the `mission_id` pattern, not allowlist membership of `event`. A line
 *     this module accepts is therefore "well-enough-formed to index", which is
 *     a weaker statement than "valid", and the writer (T-20) remains the only
 *     full validator.
 *
 * @module lib/replay/replay
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Envelope keys required on every ledger line.
 *
 * Verbatim from `schemas/ledger-envelope.schema.json#/required` (8 keys, same
 * order). See "WHAT THIS MODULE CANNOT SEE" #4 for why this is a copy and what
 * pins it.
 */
export const REQUIRED_ENVELOPE_KEYS = Object.freeze([
  'v', 'ts', 'event', 'mission_id', 'session_id', 'source', 'pid', 'seq',
]);

/**
 * The ledger's own bookkeeping event. `readAllEvents` filters these out unless
 * `includeRejected` is set; when a caller DOES pass them in, they are recorded
 * as gaps rather than folded into an action, because a rejected line describes
 * a line that never entered the history.
 */
export const REJECTED_EVENT = 'ledger.rejected';

/** Event names this index projects into their own top-level arrays. */
export const PROJECTED_EVENTS = Object.freeze({
  route: 'route.selected',
  switch: 'model.switched',
  usage: 'usage.receipt',
  context: 'context.compiled',
});

/**
 * Gap kinds. An ALLOWLIST, not a free-form string: a consumer that switches on
 * `gap.type` must fail on an unknown kind rather than silently ignore it.
 */
export const GAP_TYPES = Object.freeze({
  ENVELOPE: 'envelope',
  DUPLICATE: 'duplicate',
  SEQ: 'seq_gap',
  REJECTED: 'rejected',
});

/** How an action's grouping key was obtained, best resolution first. */
export const ATTRIBUTION = Object.freeze(['action_id', 'routing_epoch_id', 'session_id']);

/**
 * Key separator: NUL, matching `ledger.js#dedupeKey` byte for byte.
 *
 * It must be a character that CANNOT occur in the values being joined, or a
 * crafted `session_id` could forge another line's key and get that line dropped
 * as a duplicate. A printable separator such as a space is not safe, because a
 * session id may legally contain one.
 *
 * WRITTEN AS THE ESCAPE `\0`, NEVER AS A RAW NUL BYTE. A literal NUL in the
 * source makes every byte-oriented tool treat this file as binary — ripgrep
 * stops at that offset and prints "Binary file ... matches", so a later `grep`
 * for anything below this line silently returns nothing. Measured 2026-09-02:
 * this file was written with a raw NUL and did exactly that to two of my own
 * searches before the leader's `grep -rlaP '\x00'` sweep caught it. The escape
 * is the identical byte at runtime and costs nothing.
 */
const SEP = '\0';

// ---------------------------------------------------------------------------
// Envelope screening
// ---------------------------------------------------------------------------

/**
 * Is `value` an integer? `seq`, `pid` and `v` are integers in the envelope, and
 * accepting `"3"` here would make two spellings of the same line sort apart.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true when a safe integer.
 */
function isInt(value) {
  return Number.isInteger(value);
}

/**
 * Is `value` a non-empty string?
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true when a non-empty string.
 */
function isStr(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Which required envelope keys a line fails, and why.
 *
 * Presence AND primitive type, because a `seq` of `"7"` is present but unusable
 * as an ordering term — reporting it as present would put a broken line into
 * the index instead of into `gaps[]`.
 *
 * `ts` additionally has to be PARSEABLE. Ordering is `(ts, source, pid, seq)`,
 * so an unparseable timestamp has no position; admitting it would make the
 * order depend on input order, which requirement (3) forbids.
 *
 * @param {unknown} event - candidate ledger line.
 * @returns {string[]} failing key names; empty when the line is indexable.
 */
export function envelopeFaults(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return ['(not an object)'];
  const e = /** @type {Record<string, unknown>} */ (event);
  const faults = [];
  if (!isInt(e.v)) faults.push('v');
  if (!isStr(e.ts) || !Number.isFinite(Date.parse(/** @type {string} */ (e.ts)))) faults.push('ts');
  if (!isStr(e.event)) faults.push('event');
  if (!isStr(e.mission_id)) faults.push('mission_id');
  if (!isStr(e.session_id)) faults.push('session_id');
  if (!isStr(e.source)) faults.push('source');
  if (!isInt(e.pid)) faults.push('pid');
  if (!isInt(e.seq)) faults.push('seq');
  return faults;
}

/**
 * The `(session_id, source, pid, seq)` dedupe key.
 *
 * `session_id` leads because PID IS REUSED. An operating system recycles
 * process ids, and the ledger outlives any one process, so two unrelated
 * processes months apart can carry the same `pid`. Without the session term
 * their lines collide on `(source, pid, seq)` and the reader silently drops
 * one as a "duplicate" — a lost line that looks like successful dedupe.
 *
 * Shape restated from `ledger.js#dedupeEvents`; see "WHAT THIS MODULE CANNOT
 * SEE" #3, which also records that the two are mid-transition.
 *
 * @param {object} e - a screened ledger line.
 * @returns {string} dedupe key.
 */
export function dedupeKey(e) {
  return `${e.session_id}${SEP}${e.source}${SEP}${e.pid}${SEP}${e.seq}`;
}

// ---------------------------------------------------------------------------
// Deterministic order
// ---------------------------------------------------------------------------

/**
 * Total order over screened lines: `(ts, source, pid, seq)`.
 *
 * Total, not merely consistent: after dedupe, `(source, pid, seq)` is unique,
 * so no two remaining lines compare equal. That is what makes requirement (3)
 * hold — a shuffled input yields a byte-identical index rather than merely a
 * similar one.
 *
 * @param {object} a - left line.
 * @param {object} b - right line.
 * @returns {number} negative, zero, or positive.
 */
export function compareEvents(a, b) {
  const ta = Date.parse(a.ts);
  const tb = Date.parse(b.ts);
  if (ta !== tb) return ta - tb;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.pid !== b.pid) return a.pid - b.pid;
  return a.seq - b.seq;
}

/**
 * Screen, deduplicate, and order the input.
 *
 * Three things leave the stream here, each recorded rather than dropped:
 * a malformed envelope, a `ledger.rejected` line, and a duplicate of a line
 * already kept. "Recorded rather than dropped" is the whole point of
 * requirement (4): a reader must be able to see that the index is missing
 * something, because an index that silently omits looks exactly like a run
 * where nothing happened.
 *
 * @param {object[]} events - raw lines, any order.
 * @returns {{ordered: object[], gaps: object[]}} ordered lines and what left.
 */
export function orderEvents(events) {
  const gaps = [];
  const screened = [];
  const list = Array.isArray(events) ? events : [];
  list.forEach((e, index) => {
    const faults = envelopeFaults(e);
    if (faults.length > 0) {
      gaps.push({ type: GAP_TYPES.ENVELOPE, index, missing: faults });
      return;
    }
    if (e.event === REJECTED_EVENT) {
      gaps.push({
        type: GAP_TYPES.REJECTED,
        index,
        source: e.source,
        pid: e.pid,
        seq: e.seq,
        reason: typeof e.data?.reason === 'string' ? e.data.reason : null,
      });
      return;
    }
    screened.push(e);
  });

  screened.sort(compareEvents);

  const seen = new Set();
  const ordered = [];
  for (const e of screened) {
    const key = dedupeKey(e);
    if (seen.has(key)) {
      gaps.push({
        type: GAP_TYPES.DUPLICATE,
        session_id: e.session_id,
        source: e.source,
        pid: e.pid,
        seq: e.seq,
        event: e.event,
      });
      continue;
    }
    seen.add(key);
    ordered.push(e);
  }
  return { ordered, gaps };
}

/**
 * Missing `seq` numbers, PER PROCESS, reported as RANGES.
 *
 * Grouped by `(session_id, pid)`. Two terms, each excluded for its own reason:
 *
 *   - NOT by `source`. `event-writer.js#nextSeq` is one module-level counter per
 *     process — "Next per-process sequence number ... never coordinated across
 *     processes" — and a single process legitimately emits under several
 *     `source` values. Splitting the counter by source reports a hole in every
 *     ordinary multi-source process. (Measured 2026-09-02: an early draft did
 *     exactly that and reported two gaps in a clean five-line stream.)
 *   - BUT WITH `session_id`, because PID IS REUSED. Grouping by `pid` alone
 *     merges two unrelated processes that happened to hold the same id into one
 *     stream, so one process's numbering appears to fill the other's holes and
 *     a real loss is masked.
 *
 * @@ RESIDUAL FABRICATION PATH — the mirror of the bug above, NOT closed here.
 * The counter's true scope is the PROCESS, and `session_id` is narrower than
 * that. If one process ever emits under two session ids, its single counter is
 * split across two buckets (session A gets 0,2 and session B gets 1,3) and BOTH
 * buckets report holes that were never lost. Nothing in the envelope identifies
 * a process INSTANCE, so neither `pid` nor `session_id` is the counter's scope
 * and no grouping available today is exactly right. This grouping is the
 * leader's ruling on which of the two errors to accept (2026-09-02): masking a
 * real loss under pid reuse was judged worse than fabricating one under
 * multi-session processes, because the writers visible today pass a single
 * `ctx.sessionId` per process. If a long-lived multi-session writer ever
 * appears, this becomes a live defect and the fix is a process-instance id in
 * the envelope, not another grouping key.
 *
 * Ranges rather than an enumeration on purpose: one lost writer can leave a gap
 * of thousands, and an index that allocates one object per missing number turns
 * a reporting path into a memory problem.
 *
 * Only the interval between the lowest and highest observed `seq` is examined.
 * A stream that lost its first or last lines shows no gap here, because nothing
 * in the data says where it should have started or stopped — that absence is
 * unknowable from the ledger alone, and guessing a boundary would manufacture a
 * finding.
 *
 * CANNOT SEE: pid reuse. Two processes that held the same pid at different
 * times are one stream here. The second one restarts its counter at 0, so its
 * lines interleave with the first's instead of showing as a gap. Nothing in the
 * envelope distinguishes them.
 *
 * @param {object[]} ordered - screened, deduplicated lines.
 * @returns {object[]} seq-gap records, ordered by pid then position.
 */
export function findSeqGaps(ordered) {
  /** @type {Map<string, {session_id: string, pid: number, seqs: number[]}>} */
  const streams = new Map();
  for (const e of ordered) {
    const key = `${e.session_id}${SEP}${e.pid}`;
    if (!streams.has(key)) streams.set(key, { session_id: e.session_id, pid: e.pid, seqs: [] });
    streams.get(key).seqs.push(e.seq);
  }
  const gaps = [];
  for (const { session_id: sessionId, pid, seqs } of streams.values()) {
    seqs.sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i += 1) {
      const prev = seqs[i - 1];
      const cur = seqs[i];
      if (cur > prev + 1) {
        gaps.push({
          type: GAP_TYPES.SEQ,
          session_id: sessionId,
          pid,
          from: prev + 1,
          to: cur - 1,
          count: cur - prev - 1,
        });
      }
    }
  }
  gaps.sort((a, b) => (
    a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : a.pid - b.pid || a.from - b.from
  ));
  return gaps;
}

// ---------------------------------------------------------------------------
// Action attribution
// ---------------------------------------------------------------------------

/**
 * The action bucket a line belongs to, and how that was decided.
 *
 * Three resolutions, best first — see "WHAT THIS MODULE CANNOT SEE" #1 for why
 * the fallbacks are labelled rather than hidden.
 *
 * @param {object} e - a screened line.
 * @returns {{key: string, keyed_by: string}} bucket key and its resolution.
 */
export function actionKeyOf(e) {
  if (isStr(e.action_id)) {
    return { key: `action_id${SEP}${e.action_id}`, keyed_by: 'action_id' };
  }
  if (isStr(e.routing_epoch_id)) {
    return {
      key: `routing_epoch_id${SEP}${e.mission_id}${SEP}${e.routing_epoch_id}`,
      keyed_by: 'routing_epoch_id',
    };
  }
  return {
    key: `session_id${SEP}${e.mission_id}${SEP}${e.session_id}`,
    keyed_by: 'session_id',
  };
}

/**
 * Count occurrences of a field across events, WITH THE DENOMINATOR.
 *
 * Returns `absent` and `total` beside `counts` because a bare histogram cannot
 * be read as a rate: "Bash: 12" answers nothing without knowing whether it is
 * 12 of 12 or 12 of 4,000, and T-44's existence audit exists precisely to
 * establish denominators that were never measured before.
 *
 * Events whose value is absent or non-scalar land in `absent` rather than in a
 * synthetic bucket, so no real value can ever collide with the "missing" label.
 *
 * @param {object[]} events - lines to count over.
 * @param {string|((e: object) => unknown)} key - envelope field name, or a
 *   selector returning the value to count.
 * @returns {{counts: Record<string, number>, absent: number, total: number}}
 *   `counts` is key-sorted, so the same input serializes identically.
 */
export function countBy(events, key) {
  const pick = typeof key === 'function' ? key : (e) => e?.[key];
  const tally = new Map();
  let absent = 0;
  let total = 0;
  for (const e of Array.isArray(events) ? events : []) {
    total += 1;
    const raw = pick(e);
    const usable = typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw))
      || typeof raw === 'boolean';
    if (!usable) {
      absent += 1;
      continue;
    }
    const label = String(raw);
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  const counts = {};
  for (const label of [...tally.keys()].sort()) counts[label] = tally.get(label);
  return { counts, absent, total };
}

/**
 * Group ordered lines into action records.
 *
 * Records hold REFERENCES to the caller's event objects, never copies. An index
 * that clones is a second copy of the history in memory and drifts from the
 * ledger the moment either side is mutated; a reference cannot.
 *
 * @param {object[]} ordered - screened, deduplicated, ordered lines.
 * @param {{includeEvents?: boolean}} [opts] - `includeEvents` (default true)
 *   attaches the member lines; set false when only the counts are wanted.
 * @returns {object[]} action records, ordered by first appearance.
 */
export function foldByAction(ordered, opts = {}) {
  const includeEvents = opts.includeEvents !== false;
  /** @type {Map<string, object>} */
  const actions = new Map();
  for (const e of ordered) {
    const { key, keyed_by: keyedBy } = actionKeyOf(e);
    if (!actions.has(key)) {
      actions.set(key, {
        key,
        keyed_by: keyedBy,
        action_id: isStr(e.action_id) ? e.action_id : null,
        mission_id: e.mission_id,
        session_id: e.session_id,
        routing_epoch_id: isStr(e.routing_epoch_id) ? e.routing_epoch_id : null,
        task_id: isStr(e.task_id) ? e.task_id : null,
        run_id: isStr(e.run_id) ? e.run_id : null,
        first_ts: e.ts,
        last_ts: e.ts,
        event_counts: {},
        events: [],
      });
    }
    const action = actions.get(key);
    action.last_ts = e.ts;
    if (includeEvents) action.events.push(e);
    else action.events = [];
    action.event_counts[e.event] = (action.event_counts[e.event] ?? 0) + 1;
  }
  for (const action of actions.values()) {
    action.event_counts = sortKeys(action.event_counts);
  }
  return [...actions.values()];
}

/**
 * A shallow copy of `obj` with keys in sorted order.
 *
 * Property order is observable through `JSON.stringify`, so a histogram built
 * in encounter order would serialize differently for a shuffled input and break
 * requirement (3).
 *
 * @param {Record<string, number>} obj - counts.
 * @returns {Record<string, number>} same entries, sorted keys.
 */
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/**
 * Mission-level summary: which actions, how many of each event, what time span.
 *
 * Deliberately NOT the v1.0 run-ledger shape — see the module header, "NOT A
 * SECOND ANSWER TO `foldMissions`".
 *
 * @param {object[]} ordered - screened, deduplicated, ordered lines.
 * @param {object[]} actions - records from `foldByAction`.
 * @returns {object[]} mission records, ordered by first appearance.
 */
export function foldMissionIndex(ordered, actions) {
  /** @type {Map<string, object>} */
  const missions = new Map();
  for (const e of ordered) {
    if (!missions.has(e.mission_id)) {
      missions.set(e.mission_id, {
        mission_id: e.mission_id,
        first_ts: e.ts,
        last_ts: e.ts,
        sessions: [],
        action_keys: [],
        event_counts: {},
      });
    }
    const m = missions.get(e.mission_id);
    m.last_ts = e.ts;
    if (!m.sessions.includes(e.session_id)) m.sessions.push(e.session_id);
    m.event_counts[e.event] = (m.event_counts[e.event] ?? 0) + 1;
  }
  for (const action of actions) {
    missions.get(action.mission_id)?.action_keys.push(action.key);
  }
  for (const m of missions.values()) m.event_counts = sortKeys(m.event_counts);
  return [...missions.values()];
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * Lines whose `event` matches, in order.
 *
 * @param {object[]} ordered - screened, ordered lines.
 * @param {string} name - event name.
 * @returns {object[]} matching lines.
 */
function selectEvent(ordered, name) {
  return ordered.filter((e) => e.event === name);
}

/**
 * Build the replay index. PURE — takes events, touches nothing.
 *
 * `switches[]` is expected to be EMPTY in Observe. Design §8.4 puts model
 * switching behind Shadow, so a non-empty array here in Phase 0 is a finding,
 * not a feature — which is why it is a first-class array rather than something
 * a consumer has to go looking for.
 *
 * `totals.received` IS NOT THE LEDGER'S LINE COUNT — see the field's own note
 * below. Reading `received === indexed` as "nothing was lost" is wrong, and the
 * name says `received` rather than `input` so that misreading has to be made
 * deliberately instead of by assumption.
 *
 * @param {object[]} events - ledger lines in any order.
 * @param {{includeEvents?: boolean}} [opts] - forwarded to `foldByAction`.
 * @returns {object} `{missions, actions, routes, switches, usage, context,
 *   attribution, totals, gaps}`. Every field is present on every call, so a
 *   consumer never branches on `undefined`.
 */
export function buildReplay(events, opts = {}) {
  const { ordered, gaps } = orderEvents(events);
  const actions = foldByAction(ordered, opts);
  const seqGaps = findSeqGaps(ordered);
  const attribution = {};
  for (const kind of ATTRIBUTION) {
    attribution[kind] = actions.filter((a) => a.keyed_by === kind).length;
  }
  return {
    missions: foldMissionIndex(ordered, actions),
    actions,
    routes: selectEvent(ordered, PROJECTED_EVENTS.route),
    switches: selectEvent(ordered, PROJECTED_EVENTS.switch),
    usage: selectEvent(ordered, PROJECTED_EVENTS.usage),
    context: selectEvent(ordered, PROJECTED_EVENTS.context),
    attribution,
    totals: {
      // HOW MANY LINES THIS FUNCTION WAS HANDED — not how many the ledger holds.
      //
      // On the `loadReplay` path the reader has already discarded lines, with
      // no counter, before any of them reach here. `ledger.js#readAllEvents`
      // drops a line that fails `parseLine` (a torn tail, a corrupt write), one
      // whose `event` is not a string, `ledger.rejected` lines unless
      // `includeRejected` is set, anything excluded by the `mission_id`,
      // `session_id`, `event` or `since` filters, and finally every duplicate
      // via `dedupeEvents`. Those are SURVIVORS.
      //
      // So `received - indexed` measures only what THIS stage rejected, and
      // every one of those is itemised in `gaps[]`. It does not measure loss
      // upstream, and `received === indexed` therefore means "this stage
      // dropped nothing", NEVER "nothing was lost". Two of the reader's five
      // drop reasons are deliberate selection rather than damage, so even a
      // true raw-line count would not be a loss figure on its own. Counting the
      // ledger's actual lines is the reader's job (T-20) and would require the
      // filesystem, which this module does not have.
      received: Array.isArray(events) ? events.length : 0,
      indexed: ordered.length,
      events: countBy(ordered, 'event').counts,
    },
    gaps: [...gaps, ...seqGaps],
  };
}

/**
 * The index as a JSON STRING. There is no counterpart that writes it anywhere.
 *
 * This is the whole of requirement (2): a caller that wants the index on disk
 * has to reach for its own file API and own that decision, because the moment
 * this directory offers the convenience, the projection acquires a home and
 * becomes the second source of truth §8.3-2 ruled out.
 *
 * @param {object} index - a `buildReplay` result.
 * @param {{indent?: number}} [opts] - `indent` for pretty output; default none.
 * @returns {string} JSON text.
 */
export function serializeIndex(index, opts = {}) {
  return JSON.stringify(index, null, opts.indent ?? 0);
}
