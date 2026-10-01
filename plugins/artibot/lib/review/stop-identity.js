/**
 * Who was this SubagentStop? — a reviewer's identity when the payload only
 * carries a teammate NAME.
 *
 * ── The defect this exists to close (SH-05 · CA-17 · SH-02) ────────────────
 * `scripts/hooks/_review-stop-record.js#isReviewerStop` gates the whole review
 * path on an ALLOWLIST of agent types. A team spawn reports
 * `agent_type === <the teammate's NAME>` on SubagentStop (`review-f1`, `rv-w36`,
 * `review-portable-a`), so no name can ever match, and `review.completed` /
 * `review.claim_audit` have 0 rows in the whole ledger: of 6,692 live stop rows
 * only 4 ever carried a `review_ledger` column, all four `team-*-inspector`
 * names (spawn ledger copy, 2026-09-30T10:01Z). The definition type the spawner
 * chose (`artibot:code-reviewer`) exists in two places and only two:
 *   - the host's `agent-<id>.meta.json` beside the transcript, as
 *     `customAgentType` — on 67 of 617 meta files, and on NONE of the 426
 *     name-typed files that came from `team_name` spawns (census 2026-09-30);
 *   - the spawn's own ledger trail: `route.selected` (PreToolUse, the receipt)
 *     and `route.bound` (SubagentStart, the join).
 *
 * ── What this module does, in order, first ACCEPTED candidate wins ──────────
 *   1. the stop's own type (the caller's allowlist may already say yes);
 *   2. the host meta file: `agentType`, then `customAgentType`;
 *   3. the ledger trail, through ONE answer (never a vote between joins):
 *        a. EXACT — the `route.bound` row whose `data.agent_id` is this agent.
 *           Its `data.subagent_type` when present (2026-09-30 onward), else the
 *           type in the joined `route.selected` key. A bind whose `confidence`
 *           is not `exact`/`name` is a positional (FIFO) guess and resolves
 *           NOTHING: 14 of 790 live binds are, and their receipt may be another
 *           spawn's. A receipt with an empty type resolves nothing either.
 *        b. NAME — ONLY when the whole window holds no `route.bound` row for
 *           this agent id AT ALL (a FIFO, typeless or unresolvable bind counts
 *           as one, and closes this door). The newest `route.selected` row whose
 *           `worker` is this agent's name, same session, written in
 *           [START - 10 min, START], and not already bound to a DIFFERENT
 *           agent_id. If that newest eligible receipt has an empty type the
 *           answer is "unresolved": older receipts are not consulted.
 *      The type is the tail of the receipt's `idempotency_key`
 *      (`route.pre:<tool_use_id>:<prompt_id>:<subagent_type>`): `route.selected`
 *      has NO `data.subagent_type` (0 of 794 live rows).
 *
 * WHY (b) IS THAT NARROW. Each clause closes a ledger in which a BUILDER was
 * recognised as a reviewer (opus review of 0390e273, cases A-D): a stale
 * same-name receipt (A), one another agent had already consumed (A), one a FIFO
 * bind stepped past (B), one the spawn's own empty-typed receipt stepped past
 * (C), one written after START (D). The window is the one the START-side binder
 * itself applies to a receipt (`subagent-handler.js#RECEIPT_WINDOW_MS`, 10 min):
 * an older receipt could not have been this spawn's bind candidate. There is NO
 * slack after START: PreToolUse precedes SubagentStart and `startedAt` is taken
 * after the bind, so the true receipt is never later, and the +1 s this module
 * first carried bought nothing but case D. It also needs the scan to have covered
 * the WHOLE window: "no bind row for this agent" is a fact about a window that
 * was read to its edge, not about one the parse budget cut short.
 *
 * THE ALLOWLIST IS NOT HERE. `accept` is injected, so this module cannot widen
 * who counts as a reviewer: it only finds out which type a stop belongs to.
 *
 * ── Bounded ─────────────────────────────────────────────────────────────────
 * The ledger grows without bound and this runs on SubagentStop, so the scan
 * (`./tail-scan.js`, sized from a measurement — see there) reads backwards from
 * the end, stops at the first exact answer, and never goes further than
 * {@link STOP_SCAN_BYTES}. A scan is a native `indexOf` per needle over each
 * chunk, and a line is parsed ONLY when it is a `route.bound` / `route.selected`
 * row that holds a needle — 90% of live rows are `hook.fired`, which never parse,
 * and rows that merely MENTION an agent id (`run_id` of a `usage.receipt`, a
 * hook payload) are skipped without being counted against the budget. `bytesRead`
 * and `candidates` come back with every answer so a test can assert bounded work
 * without a wall-clock.
 *
 * FAIL CLOSED. Every failure — unreadable, torn, oversize, not found, cap hit —
 * is "no identity", which `isReviewerStop` reads as "not a reviewer", exactly as
 * before this module existed. Nothing here throws, and nothing here writes.
 *
 * ── What green tests here do NOT prove ──────────────────────────────────────
 *  - That the window reaches a reviewer that ran far longer than any in the
 *    measurement, or a RESUMED reviewer whose bind row is hours old: those fall
 *    out of the window and are simply not recorded.
 *  - That a real `route.selected` exists for every spawn. The PreToolUse hook
 *    writes none when the classifier finds no phase (`no-receipt`).
 *  - That the name join can never be wrong: a builder whose own bind row is
 *    missing, with an UNBOUND same-name reviewer receipt inside the 10 minutes
 *    before its START, is still taken for that reviewer. The verdict gate
 *    (`parseReviewVerdict`) is what stands between that and a ledger line.
 *  - That `customAgentType` / `agentType` in the meta file keep their meaning:
 *    it is an UNDOCUMENTED host file (`tests/hooks/fixtures/host-files/`).
 *
 * L2: node built-ins only. The ledger PATH arrives from the caller
 * (`lib/runtime` is L5 and may not be imported here).
 *
 * @module lib/review/stop-identity
 */

import { readFileSync, statSync } from 'node:fs';

import {
  positiveInt, scanLedgerTail, TAIL_SCAN_BYTES, TAIL_SCAN_CHUNK_BYTES,
} from './tail-scan.js';

/** Furthest back from the ledger's end a scan reads (see `./tail-scan.js`). @type {number} */
export const STOP_SCAN_BYTES = TAIL_SCAN_BYTES;

/** Bytes per read. @type {number} */
export const STOP_SCAN_CHUNK_BYTES = TAIL_SCAN_CHUNK_BYTES;

/**
 * Most `route.bound` / `route.selected` lines one scan will parse before it gives
 * up. Only those rows count: the name join reads every bind row in the window
 * (~270 per 8 MiB on the live ledger, 2026-09-30), so 1,024 leaves 4x headroom.
 * @type {number}
 */
export const STOP_SCAN_MAX_CANDIDATES = 1024;

/** A meta file is a few hundred bytes; a larger one is not read. @type {number} */
export const STOP_META_MAX_BYTES = 65536;

/**
 * How far BEFORE an agent's START a same-name receipt may have been written and
 * still be taken for that agent's own: the window the START-side binder applies
 * (`subagent-handler.js#RECEIPT_WINDOW_MS`).
 * @type {number}
 */
export const STOP_NAME_JOIN_WINDOW_MS = 10 * 60 * 1000;

/** Prefix of the correlation key `route-observe-pre.js#receiptKey` writes. */
const RECEIPT_KEY_PREFIX = 'route.pre:';

/** `route.bound` confidences that came from an identity match, not a position. */
const TRUSTED_BIND_CONFIDENCE = Object.freeze(['exact', 'name']);

/** The fallback id `hook-utils.js#extractAgentId` returns when the payload has none. */
const UNKNOWN_AGENT_ID = 'unknown';

/**
 * The literal bytes of the two event keys the ledger writer emits (compact JSON,
 * `"event"` right after `ts`). Pinned as raw bytes by
 * `tests/hooks/subagent-handler-routing-fields.test.js`.
 */
const BOUND_EVENT = '"event":"route.bound"';
const SELECTED_EVENT = '"event":"route.selected"';

/** @param {unknown} value @returns {string|null} the string, or null when empty or not one */
const text = (value) => (typeof value === 'string' && value !== '' ? value : null);

/** @param {unknown} value @returns {string|null} a usable spawn id, or null */
const usableId = (value) => {
  const id = text(value);
  return id === null || id === UNKNOWN_AGENT_ID ? null : id;
};

/**
 * The `subagent_type` segment of a receipt key
 * `route.pre:<tool_use_id>:<prompt_id>:<subagent_type>` — the mirror of
 * `subagent-handler.js#parseReceiptKey`, which is module-private to a hook this
 * layer may not import. `subagent_type` absorbs the remainder because it is the
 * one part that may contain a colon (`artibot:code-reviewer`). A key whose
 * `tool_use_id` disagrees with the row's own epoch has been mangled and is not
 * trusted; an empty `prompt_id` is legal, an empty type is no type.
 *
 * @param {unknown} key `idempotency_key` of a `route.selected` row
 * @param {unknown} epoch `routing_epoch_id` of the same row
 * @returns {string|null} the type the spawner passed, or null
 */
export function subagentTypeFromReceiptKey(key, epoch) {
  if (typeof key !== 'string' || !key.startsWith(RECEIPT_KEY_PREFIX)) return null;
  if (typeof epoch !== 'string' || epoch === '') return null;
  const rest = key.slice(RECEIPT_KEY_PREFIX.length);
  if (!rest.startsWith(`${epoch}:`)) return null;
  const tail = rest.slice(epoch.length + 1);
  const cut = tail.indexOf(':');
  if (cut < 0) return null;
  return text(tail.slice(cut + 1));
}

/**
 * The identity keys of the host's `agent-<id>.meta.json`, which sits beside the
 * subagent transcript (`agent_transcript_path` is `agent-<id>.jsonl`). An
 * UNDOCUMENTED file, so every failure is "no value": not a `.jsonl` path, missing,
 * oversize, garbled, not an object, a key that is not a non-empty string. Only
 * these two keys leave this function. NEVER THROWS.
 *
 * @param {unknown} transcriptPath `agent_transcript_path` of a SubagentStop payload
 * @returns {{agentType: string|null, customAgentType: string|null}} both null on any failure
 */
export function readStopMeta(transcriptPath) {
  const none = { agentType: null, customAgentType: null };
  try {
    if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return none;
    const file = `${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`;
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > STOP_META_MAX_BYTES) return none;
    const meta = JSON.parse(readFileSync(file, 'utf-8'));
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return none;
    return { agentType: text(meta.agentType), customAgentType: text(meta.customAgentType) };
  } catch {
    return none;
  }
}

/**
 * The line of `body` that holds the last match of `needle` starting at or before
 * `from`: `{start, end}` (end excludes the newline), or null.
 * @param {string} body @param {string} needle @param {number} from
 * @returns {{start: number, end: number}|null}
 */
function lineAround(body, needle, from) {
  const at = body.lastIndexOf(needle, from);
  if (at < 0) return null;
  const start = body.lastIndexOf('\n', at) + 1;
  const nl = body.indexOf('\n', at);
  return { start, end: nl < 0 ? body.length : nl };
}

/** @param {string} line @returns {object|null} a parsed ledger object, or null */
function parseRow(line) {
  try {
    const row = JSON.parse(line);
    return row !== null && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

/** @returns {object} a fresh search state */
const newState = () => ({
  exact: null,
  exactDone: false, // a route.bound row for THIS agent was seen, whatever its confidence
  epoch: null,
  epochDone: false,
  workerType: null,
  workerSettled: false, // an eligible same-name receipt was seen; its type may be null
  otherBound: new Set(), // tool_use_ids already bound to a DIFFERENT agent_id
  parsed: 0,
});

/**
 * Fold one `route.bound` row into the search state. A bind row for THIS agent
 * closes the name join for good, whatever it says; one for another agent only
 * marks its receipt as spoken for.
 *
 * @param {object} row parsed `route.bound` row
 * @param {object} st search state (mutated)
 * @param {{agentId: string}} q the query
 * @returns {void}
 */
function absorbBound(row, st, q) {
  const toolUse = text(row.data?.tool_use_id) ?? text(row.action_id);
  if (row.data?.agent_id !== q.agentId) {
    if (toolUse !== null && !st.workerSettled) st.otherBound.add(toolUse);
    return;
  }
  if (st.exactDone) return;
  st.exactDone = true;
  if (!TRUSTED_BIND_CONFIDENCE.includes(row.data?.confidence)) {
    st.epochDone = true;
    return;
  }
  const direct = text(row.data?.subagent_type);
  if (direct !== null) {
    st.exact = { type: direct, source: 'route.bound' };
    return;
  }
  st.epoch = toolUse;
  st.epochDone = toolUse === null;
}

/**
 * Fold one `route.selected` row into the search state: it may be the receipt the
 * exact join is waiting for, and/or the newest ELIGIBLE same-name receipt.
 *
 * @param {object} row parsed `route.selected` row
 * @param {object} st search state (mutated)
 * @param {{name: string|null, sessionId: string|null, notBeforeMs: number|null, notAfterMs: number|null}} q
 * @returns {void}
 */
function absorbSelected(row, st, q) {
  if (st.epoch !== null && !st.epochDone && row.routing_epoch_id === st.epoch) {
    st.epochDone = true;
    const type = subagentTypeFromReceiptKey(row.idempotency_key, row.routing_epoch_id);
    if (type !== null) st.exact = { type, source: 'route.bound>route.selected' };
  }
  if (st.workerSettled || st.exactDone || q.notAfterMs === null) return;
  if (row.worker !== q.name || row.session_id !== q.sessionId) return;
  const ts = Date.parse(row.ts);
  if (!Number.isFinite(ts) || ts > q.notAfterMs || ts < q.notBeforeMs) return;
  if (st.otherBound.has(row.routing_epoch_id)) return;
  st.workerSettled = true;
  st.workerType = subagentTypeFromReceiptKey(row.idempotency_key, row.routing_epoch_id);
}

/** @param {object} st search state @returns {boolean} the exact join has nothing left to look for */
const finished = (st) => st.exact !== null
  || (st.exactDone && (st.epoch === null || st.epochDone));

/**
 * Search one decoded run of WHOLE lines, newest line first.
 *
 * Needles are JSON-quoted (`"<agent id>"`, `"worker":"<name>"`, `"<tool_use_id>"`)
 * or the literal `route.bound` event key, so a hit is almost always a row wanted;
 * a line is parsed — and counted against `maxCandidates` — only when it really is
 * a `route.bound` / `route.selected` row, and `absorb*` makes the exact check.
 * Per needle the next candidate line is cached, and only recomputed once a line
 * at or after it has been consumed, so a run costs one backward `lastIndexOf`
 * sweep per needle rather than one per candidate.
 *
 * @param {string} body whole lines, oldest first
 * @param {object} st search state (mutated)
 * @param {object} q query
 * @param {{id: string, worker: string|null, bound: string|null}} needles fixed needles
 * @param {number} maxCandidates parse budget across the whole scan
 * @returns {boolean} true when the scan should stop (answer found, or budget spent)
 */
function searchRun(body, st, q, needles, maxCandidates) {
  const cache = {};
  let limit = body.length;
  for (;;) {
    const active = [];
    const nameJoinOpen = !st.workerSettled && !st.exactDone;
    if (!st.exactDone) active.push(['id', needles.id]);
    if (needles.worker !== null && nameJoinOpen) active.push(['worker', needles.worker]);
    if (needles.bound !== null && nameJoinOpen) active.push(['bound', needles.bound]);
    if (st.epoch !== null && !st.epochDone) active.push(['epoch', JSON.stringify(st.epoch)]);
    let best = null;
    for (const [key, needle] of active) {
      let hit = cache[key];
      if (hit === undefined || (hit !== null && hit.start > limit)) {
        hit = lineAround(body, needle, limit);
        cache[key] = hit;
      }
      if (hit !== null && (best === null || hit.start > best.start)) best = hit;
    }
    if (best === null) return false;
    const line = body.slice(best.start, best.end);
    const isBound = line.includes(BOUND_EVENT);
    if (isBound || line.includes(SELECTED_EVENT)) {
      st.parsed += 1;
      const row = parseRow(line);
      if (row !== null) {
        if (isBound) absorbBound(row, st, q);
        else absorbSelected(row, st, q);
      }
      if (finished(st) || st.parsed >= maxCandidates) return true;
    }
    if (best.start === 0) return false;
    limit = best.start - 1;
  }
}

/**
 * Normalise a query into what `searchRun` needs: the exact-check fields and the
 * fixed needles. The exact join needs a usable agent id (without one there is
 * nothing to join and no way to show "no bind row for this agent", so the name
 * join is off too); the name join additionally needs a name, a session and the
 * START time that bounds it.
 *
 * @param {{agentId?: unknown, name?: unknown, sessionId?: unknown, startedAtMs?: unknown}} [query]
 * @returns {{q: object, needles: {id: string|null, worker: string|null, bound: string|null}}}
 */
function planSearch(query) {
  const agentId = usableId(query?.agentId);
  const name = text(query?.name);
  const sessionId = text(query?.sessionId);
  const startedAtMs = Number.isFinite(query?.startedAtMs) ? query.startedAtMs : null;
  const nameJoin = agentId !== null && name !== null && sessionId !== null && startedAtMs !== null;
  return {
    q: {
      agentId,
      name,
      sessionId,
      notAfterMs: startedAtMs,
      notBeforeMs: startedAtMs === null ? null : startedAtMs - STOP_NAME_JOIN_WINDOW_MS,
    },
    needles: {
      id: agentId === null ? null : JSON.stringify(agentId),
      worker: nameJoin ? `"worker":${JSON.stringify(name)}` : null,
      bound: nameJoin ? BOUND_EVENT : null,
    },
  };
}

/**
 * Find the `subagent_type` a spawn was started with, from the ledger's tail.
 *
 * READS BACKWARDS (`./tail-scan.js`) and stops at the first exact answer: a chunk
 * that holds no needle costs one native `indexOf` per needle and no decode of its
 * lines. At most `maxBytes + 1` bytes are read. The name join is only answered
 * from a scan that covered the WHOLE window (`exhausted`): a scan the parse
 * budget or a read error cut short has not shown that no bind row exists. NEVER
 * THROWS.
 *
 * @param {unknown} ledgerPath absolute ledger file path; anything else finds nothing
 * @param {{agentId?: unknown, name?: unknown, sessionId?: unknown, startedAtMs?: unknown}} [query]
 *   `agentId` enables the exact join; with `name`, `sessionId` and `startedAtMs` (the
 *   agent's START time) the name join is enabled too, bounded to the 10 minutes before START
 * @param {{maxBytes?: number, chunkBytes?: number, maxCandidates?: number, endOffset?: number}} [opts]
 *   caps, and `endOffset` — read as if the file ended there (replay and tests)
 * @returns {{type: string|null, source: string|null, bytesRead: number, candidates: number,
 *   exhausted: boolean}} `source` is `route.bound` | `route.bound>route.selected` |
 *   `route.selected:worker`; `exhausted` says the whole window was read
 */
export function findSpawnSubagentType(ledgerPath, query, opts = {}) {
  const st = newState();
  let scan = { bytesRead: 0, status: 'error' };
  const result = () => {
    const nameJoin = scan.status === 'exhausted' && !st.exactDone && st.workerType !== null;
    const hit = st.exact ?? (nameJoin ? { type: st.workerType, source: 'route.selected:worker' } : null);
    return {
      type: hit?.type ?? null,
      source: hit?.source ?? null,
      bytesRead: scan.bytesRead,
      candidates: st.parsed,
      exhausted: scan.status === 'exhausted',
    };
  };
  try {
    const { q, needles } = planSearch(query);
    if (q.agentId === null) return result();
    const maxCandidates = positiveInt(opts.maxCandidates, STOP_SCAN_MAX_CANDIDATES);
    scan = scanLedgerTail(ledgerPath, opts, (run) => searchRun(run, st, q, needles, maxCandidates));
    return result();
  } catch {
    return result();
  }
}

/**
 * Resolve a SubagentStop's agent type to one the caller ACCEPTS, or to nothing.
 *
 * Candidates are offered to `accept` in order — the stop's own type, the meta
 * file's `agentType` then `customAgentType`, then the single answer of the ledger
 * join — and the first accepted one is returned. The ledger is only consulted
 * when nothing earlier was accepted, and the path thunk is only called then.
 * Every candidate is recorded in `seen` with where it came from, so a caller or a
 * test can tell "found a type and refused it" from "found nothing".
 *
 * NEVER THROWS; a throwing `accept` or path thunk is "no identity".
 *
 * @param {{agentType?: unknown, agentId?: unknown, sessionId?: unknown,
 *   transcriptPath?: unknown, startedAtMs?: unknown}} stop what the hook knows of this stop
 * @param {{accept?: (type: string) => boolean, ledgerPath?: () => (string|null),
 *   scan?: object}} [ports] `accept` is the caller's allowlist; `scan` overrides
 *   {@link findSpawnSubagentType}'s caps
 * @returns {{identity: string|null, source: string|null, seen: Array<{source: string, type: string}>}}
 */
export function resolveStopIdentity(stop, ports) {
  const seen = [];
  try {
    const accept = typeof ports?.accept === 'function' ? ports.accept : () => false;
    const offer = (source, type) => {
      if (text(type) === null) return null;
      seen.push({ source, type });
      return accept(type) === true ? { identity: type, source, seen } : null;
    };
    const direct = offer('stop-type', stop?.agentType);
    if (direct !== null) return direct;

    const meta = readStopMeta(stop?.transcriptPath);
    const fromMeta = offer('meta.agentType', meta.agentType) ?? offer('meta.customAgentType', meta.customAgentType);
    if (fromMeta !== null) return fromMeta;

    const ledgerPath = typeof ports?.ledgerPath === 'function' ? ports.ledgerPath() : null;
    if (text(ledgerPath) !== null) {
      const hit = findSpawnSubagentType(ledgerPath, {
        agentId: stop?.agentId, name: stop?.agentType, sessionId: stop?.sessionId, startedAtMs: stop?.startedAtMs,
      }, ports?.scan ?? {});
      const fromLedger = offer(hit.source ?? 'ledger', hit.type);
      if (fromLedger !== null) return fromLedger;
    }
    return { identity: null, source: null, seen };
  } catch {
    return { identity: null, source: null, seen };
  }
}
