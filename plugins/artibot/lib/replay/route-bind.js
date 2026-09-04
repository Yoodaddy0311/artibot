/**
 * Route receipt ↔ bind JOIN — the read-model half of design §2.3.
 *
 * TWO HOOKS, TWO LINES, NO SIDE FILE
 * ---------------------------------------------------------------------------
 * `scripts/hooks/route-observe-pre.js` writes a `route.selected` receipt at
 * PreToolUse(Agent), keyed by the host's `tool_use_id` (its `routing_epoch_id`
 * and `data.shadow_of = 'tool_use:<id>'`). `scripts/hooks/subagent-handler.js#
 * bindRoute` writes a `route.bound` line at SubagentStart naming that
 * `tool_use_id` and the `agent_id` that actually spawned — or, when no receipt
 * matched, records `route_ledger: 'skipped:unbound'` on the spawn record in
 * `.artibot/ledger/spawns.ndjson` and writes nothing to the central ledger.
 *
 * Neither hook keeps a pending list. The bind side re-derives its candidates
 * from the ledger tail on every spawn, and this module re-derives the SAME
 * join from the same lines for the reader — `ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md`
 * §3: "읽기 모델(`lib/replay`)이 `tool_use_id` 로 조인 … 별도 상태 파일을
 * 두지 않는다 — 두 번째 진실원 금지". A join that were persisted would be a
 * second answer to "which receipt did this spawn come from", and the two
 * answers would drift the moment either file rotated.
 *
 * WHAT IS COMPUTED HERE AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * `joinRouteBinds` COUNTS; it does not JUDGE. Design §2.3 states three
 * invariants and this module surfaces the raw material for two of them:
 *   1. 1:1 — one `tool_use_id` binds at most one `agent_id` and vice versa.
 *      Violations are listed in `conflicts[]`. `bindRoute` enforces this by
 *      construction on the writer side, so a conflict here means a writer
 *      guarantee broke, not a normal outcome.
 *   3. RESIDUE — receipts that never bound (`unbound_receipts[]`), reported
 *      beside the spawn ledger's `skipped:unbound` count (`countUnboundSpawns`).
 *      The two numbers come from two different files with two different
 *      retentions; putting them side by side is the whole point, and deciding
 *      what a mismatch means is `/doctor` Check 10's job
 *      (`lib/project-state/doctor-checks.js#checkRouteBindResidue`).
 * Invariant 2 (subagent_type preservation) needs the spawn record's
 * `canonicalModel` next to the receipt's prediction, which the bind line already
 * carries as `selected_model` / `recommended_model`; it is not re-derived here.
 *
 * PURITY (design §1-8, L2). No clock, no filesystem, no randomness. Every list
 * in the result is sorted on a stable key so a shuffled input serializes to the
 * same bytes — the same requirement `replay.js` meets.
 *
 * ── WHAT THIS MODULE CANNOT SEE (repo rule §9: write it next to the gate) ────
 *  1. WHETHER A BOUND PAIR IS THE RIGHT PAIR. Tier-3 FIFO binds are guesses
 *     (`bindRoute`, `confidence: 'fifo'`); a wrong receipt bound to a spawn is
 *     indistinguishable from a right one in this join. Equal residue counts do
 *     not prove correctness, only that nothing was left over.
 *  2. LEGITIMATE ASYMMETRY. A spawn that never went through the `Agent` tool
 *     (SDK / scheduler / loop) has no receipt and is a normal `skipped:unbound`;
 *     a tool call the host cancelled or a spawn whose SubagentStart never fired
 *     leaves an unbound receipt with no spawn; a receipt older than the bind
 *     side's 10-minute window or beyond its 128 KB tail is unbound by design.
 *     All of these are reported, none of them are judged here.
 *  3. PRE-4.55 RECEIPTS. Lines whose `data.shadow_of` starts with `spawn:` were
 *     written by the retired SubagentStart path and can never bind; they are
 *     excluded from `receipts` and counted under `ignored.pre_tool_use_only`.
 *  4. THE SPAWN LEDGER'S SESSION SCOPE. `countUnboundSpawns` filters on the
 *     record's own `sessionId`; a record written with a null session (the hook
 *     had no `session_id`) lands in the `null` bucket and is not attributed.
 *
 * @module lib/replay/route-bind
 */

/** The two ledger events this join reads. */
export const ROUTE_EVENTS = Object.freeze({
  receipt: 'route.selected',
  bind: 'route.bound',
});

/**
 * `data.shadow_of` prefix of a PreToolUse receipt. Restated from
 * `scripts/hooks/subagent-handler.js#TOOL_USE_SHADOW_PREFIX` (the hook is a
 * script and this is L2, so the constant cannot be imported); the bind test
 * fixtures pin the two spellings against each other.
 */
export const TOOL_USE_SHADOW_PREFIX = 'tool_use:';

/**
 * The spawn-record `route_ledger` value that means "no receipt matched"
 * (`subagent-handler.js#bindRoute`).
 */
export const UNBOUND_ROUTE_LEDGER = 'skipped:unbound';

/** Spawn-ledger `event` value that carries `route_ledger` (start rows only). */
const SPAWN_START = 'start';

/**
 * Is `value` a non-empty string?
 * @param {unknown} value
 * @returns {boolean}
 */
function isStr(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Stable string order for sort callbacks.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Is this ledger line a PreToolUse receipt this join can bind?
 *
 * Three conditions, all from the writer (`route-observe-pre.js#observePre`):
 * the event name, a non-empty `routing_epoch_id` (the `tool_use_id`), and a
 * `data.shadow_of` under the `tool_use:` prefix. The bind side reads the same
 * three (`subagent-handler.js#collectReceipts`), so reader and writer agree on
 * what a candidate is.
 *
 * @param {object} e - screened ledger line
 * @returns {boolean}
 */
export function isPreToolUseReceipt(e) {
  if (!e || typeof e !== 'object' || e.event !== ROUTE_EVENTS.receipt) return false;
  if (!isStr(e.routing_epoch_id)) return false;
  const shadowOf = e.data?.shadow_of;
  return isStr(shadowOf) && shadowOf.startsWith(TOOL_USE_SHADOW_PREFIX);
}

/**
 * One receipt, reduced to the keys the join needs.
 * @param {object} e
 * @returns {object}
 */
function receiptOf(e) {
  return {
    tool_use_id: e.routing_epoch_id,
    session_id: e.session_id,
    mission_id: e.mission_id,
    ts: e.ts,
    worker: isStr(e.worker) ? e.worker : null,
    action_class: isStr(e.data?.action?.type) ? e.data.action.type : null,
  };
}

/**
 * One bind line, reduced to the keys the join needs.
 * @param {object} e
 * @returns {object}
 */
function bindOf(e) {
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  return {
    tool_use_id: isStr(d.tool_use_id) ? d.tool_use_id : null,
    agent_id: isStr(d.agent_id) ? d.agent_id : null,
    session_id: e.session_id,
    mission_id: e.mission_id,
    ts: e.ts,
    confidence: isStr(d.confidence) ? d.confidence : null,
    method: isStr(d.method) ? d.method : null,
  };
}

/**
 * Sort key for receipt/bind records: session, then time, then id.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function byRecord(a, b) {
  return cmp(a.session_id, b.session_id)
    || cmp(a.ts, b.ts)
    || cmp(a.tool_use_id ?? '', b.tool_use_id ?? '')
    || cmp(a.agent_id ?? '', b.agent_id ?? '');
}

/**
 * Group bind lines by one key and list the keys that appear more than once —
 * invariant 1 in both directions, run once per direction.
 *
 * @param {object[]} binds
 * @param {'tool_use_id'|'agent_id'} key - the side being checked
 * @param {'agent_id'|'tool_use_id'} other - the side listed on the conflict
 * @param {string} type - conflict label
 * @returns {object[]} conflicts
 */
function conflictsOn(binds, key, other, type) {
  const groups = new Map();
  for (const b of binds) {
    if (b[key] === null) continue;
    if (!groups.has(b[key])) groups.set(b[key], []);
    groups.get(b[key]).push(b);
  }
  const out = [];
  for (const [value, members] of groups) {
    if (members.length < 2) continue;
    out.push({
      type,
      [key]: value,
      [`${other}s`]: members.map((m) => m[other]).filter((v) => v !== null).sort(cmp),
      count: members.length,
    });
  }
  return out.sort((a, b) => cmp(a[key], b[key]));
}

/**
 * Join receipts to binds by `tool_use_id`.
 *
 * Accepts the screened, deduplicated lines `orderEvents` produces (or any array
 * of ledger lines — screening is not repeated here, so pass what `buildReplay`
 * already screened). Returns every list sorted on a stable key.
 *
 * @param {object[]} ordered - ledger lines
 * @returns {{
 *   receipts: number, binds: number,
 *   bound: object[], unbound_receipts: object[], orphan_binds: object[],
 *   conflicts: object[],
 *   ignored: {pre_tool_use_only: number, malformed_binds: number},
 *   by_session: Record<string, {receipts: number, binds: number,
 *     bound: number, unbound_receipts: number, orphan_binds: number}>
 * }} `bound` pairs a receipt with its bind; `unbound_receipts` are receipts no
 *   bind names; `orphan_binds` are binds whose receipt is not in the input
 *   (rotated out, or a window this read did not cover); `conflicts` are
 *   invariant-1 violations; `ignored.pre_tool_use_only` counts `route.selected`
 *   lines that are not PreToolUse receipts (the retired `spawn:` shape).
 */
export function joinRouteBinds(ordered) {
  const list = Array.isArray(ordered) ? ordered : [];
  const receipts = new Map();
  const binds = [];
  const duplicateReceipts = [];
  let preToolUseOnly = 0;
  let malformedBinds = 0;

  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (e.event === ROUTE_EVENTS.receipt) {
      if (!isPreToolUseReceipt(e)) {
        preToolUseOnly += 1;
        continue;
      }
      const r = receiptOf(e);
      if (receipts.has(r.tool_use_id)) {
        duplicateReceipts.push({
          type: 'receipt_duplicate', tool_use_id: r.tool_use_id, session_id: r.session_id,
        });
        continue;
      }
      receipts.set(r.tool_use_id, r);
      continue;
    }
    if (e.event === ROUTE_EVENTS.bind) {
      const b = bindOf(e);
      if (b.tool_use_id === null || b.agent_id === null) {
        malformedBinds += 1;
        continue;
      }
      binds.push(b);
    }
  }

  const boundTools = new Set(binds.map((b) => b.tool_use_id));
  const bound = [];
  const orphanBinds = [];
  for (const b of binds) {
    const r = receipts.get(b.tool_use_id);
    if (r === undefined) {
      orphanBinds.push(b);
      continue;
    }
    bound.push({ ...b, receipt_ts: r.ts, worker: r.worker, action_class: r.action_class });
  }
  const unboundReceipts = [...receipts.values()].filter((r) => !boundTools.has(r.tool_use_id));

  const conflicts = [
    ...duplicateReceipts.sort((a, b) => cmp(a.tool_use_id, b.tool_use_id)),
    ...conflictsOn(binds, 'tool_use_id', 'agent_id', 'tool_use_bound_twice'),
    ...conflictsOn(binds, 'agent_id', 'tool_use_id', 'agent_bound_twice'),
  ];

  const bySession = {};
  const bump = (sid, key) => {
    const s = isStr(sid) ? sid : 'null';
    if (!bySession[s]) {
      bySession[s] = { receipts: 0, binds: 0, bound: 0, unbound_receipts: 0, orphan_binds: 0 };
    }
    bySession[s][key] += 1;
  };
  for (const r of receipts.values()) bump(r.session_id, 'receipts');
  for (const b of binds) bump(b.session_id, 'binds');
  for (const b of bound) bump(b.session_id, 'bound');
  for (const r of unboundReceipts) bump(r.session_id, 'unbound_receipts');
  for (const b of orphanBinds) bump(b.session_id, 'orphan_binds');
  const sortedBySession = {};
  for (const sid of Object.keys(bySession).sort(cmp)) sortedBySession[sid] = bySession[sid];

  return {
    receipts: receipts.size,
    binds: binds.length,
    bound: bound.sort(byRecord),
    unbound_receipts: unboundReceipts.sort(byRecord),
    orphan_binds: orphanBinds.sort(byRecord),
    conflicts,
    ignored: { pre_tool_use_only: preToolUseOnly, malformed_binds: malformedBinds },
    by_session: sortedBySession,
  };
}

/**
 * Count the spawns the bind side gave up on, from `spawns.ndjson` records.
 *
 * THE AXIS IS DISTINCT `agentId`, NOT LINES. Measured 2026-09-04 on this repo's
 * spawn ledger: counting `start` events under-counted by at least 12 and
 * counting every event double-counted, so both `spawns` (the denominator) and
 * `unbound` (the numerator) are sets of agent ids. `route_ledger` is written on
 * `start` rows only (`subagent-handler.js#handleStart`), so the numerator reads
 * start rows; the denominator reads start ∪ stop so a spawn whose start row
 * was lost still counts once.
 *
 * @param {object[]} records - `readSpawns()` output (any order)
 * @param {{sessionId?: string}} [opts] - keep one session's records only
 * @returns {{spawns: number, unbound: number, unbound_agent_ids: string[],
 *   by_session: Record<string, {spawns: number, unbound: number}>}}
 */
export function countUnboundSpawns(records, opts = {}) {
  const list = Array.isArray(records) ? records : [];
  const only = isStr(opts?.sessionId) ? opts.sessionId : null;
  const spawns = new Map();
  const unbound = new Map();
  for (const r of list) {
    if (!r || typeof r !== 'object' || !isStr(r.agentId)) continue;
    const sid = isStr(r.sessionId) ? r.sessionId : null;
    if (only !== null && sid !== only) continue;
    spawns.set(r.agentId, sid);
    if (r.event === SPAWN_START && r.route_ledger === UNBOUND_ROUTE_LEDGER) unbound.set(r.agentId, sid);
  }
  const bySession = {};
  const bump = (sid, key) => {
    const s = sid ?? 'null';
    if (!bySession[s]) bySession[s] = { spawns: 0, unbound: 0 };
    bySession[s][key] += 1;
  };
  for (const sid of spawns.values()) bump(sid, 'spawns');
  for (const sid of unbound.values()) bump(sid, 'unbound');
  const sortedBySession = {};
  for (const sid of Object.keys(bySession).sort(cmp)) sortedBySession[sid] = bySession[sid];
  return {
    spawns: spawns.size,
    unbound: unbound.size,
    unbound_agent_ids: [...unbound.keys()].sort(cmp),
    by_session: sortedBySession,
  };
}
