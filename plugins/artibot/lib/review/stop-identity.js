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
 *           is not `exact`/`name` is a positional (FIFO) guess and is IGNORED:
 *           14 of 790 live binds are, and their receipt may be another spawn's.
 *        b. NAME — the most recent `route.selected` row whose `worker` is this
 *           agent's name, same session, written no later than this agent's
 *           START. Used only when (a) gave nothing.
 *      The type is the tail of the receipt's `idempotency_key`
 *      (`route.pre:<tool_use_id>:<prompt_id>:<subagent_type>`): `route.selected`
 *      has NO `data.subagent_type` (0 of 794 live rows).
 *
 * THE ALLOWLIST IS NOT HERE. `accept` is injected, so this module cannot widen
 * who counts as a reviewer: it only finds out which type a stop belongs to.
 *
 * ── Bounded, and sized from a measurement ───────────────────────────────────
 * The ledger grows without bound and this runs on SubagentStop, so the scan
 * reads backwards from the end in chunks, stops at the first answer, and never
 * goes further than {@link STOP_SCAN_BYTES}. Bytes between a spawn's bind row and
 * its stop, measured against a 62,152-line / 24.6 MB ledger copy (2026-09-30):
 *
 *                          n     p50      p90      p99      max
 *   reviewer-ish stops    276   123 KB   371 KB   1.38 MB  1.47 MB
 *   every stop with bind 1216   170 KB   772 KB   3.39 MB  4.97 MB
 *
 * Share of those stops whose bind row lies inside a window of that size
 * (reviewer-ish / every stop): 128 KB, the window `subagent-handler.js` uses for
 * its receipt scan, 54% / 43%; 1 MiB 99% / 93%; 4 MiB 100% / 99.7%; 8 MiB
 * 100% / 100% — hence a number of its own. A scan is a native `indexOf` per
 * needle over each chunk and a `JSON.parse` only of lines that contain a needle
 * — 90% of live rows are `hook.fired`, which never parse. `bytesRead` and
 * `candidates` come back with every answer so a test can assert bounded work
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
 *  - That `customAgentType` / `agentType` in the meta file keep their meaning:
 *    it is an UNDOCUMENTED host file (`tests/hooks/fixtures/host-files/`).
 *
 * L2: node built-ins only. The ledger PATH arrives from the caller
 * (`lib/runtime` is L5 and may not be imported here).
 *
 * @module lib/review/stop-identity
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

/**
 * Furthest back from the ledger's end a scan reads. 8 MiB is the bound the same
 * hook already uses for a subagent transcript tail
 * (`_review-stop-record.js#TRANSCRIPT_TAIL_BYTES`) and is 1.6x the largest
 * bind-to-stop distance measured (4.97 MB over 1,216 stops).
 * @type {number}
 */
export const STOP_SCAN_BYTES = 8 * 1024 * 1024;

/** Bytes per read; a line is ~330 B, so one chunk holds ~800 lines. @type {number} */
export const STOP_SCAN_CHUNK_BYTES = 256 * 1024;

/** Most lines one scan will decode and parse before it gives up. @type {number} */
export const STOP_SCAN_MAX_CANDIDATES = 512;

/** A meta file is a few hundred bytes; a larger one is not read. @type {number} */
export const STOP_META_MAX_BYTES = 65536;

/**
 * A line longer than this with no newline in it is not a ledger (the writer caps
 * a line at 4 KB); the scan stops rather than concatenate it without bound.
 * @type {number}
 */
const MAX_CARRY_BYTES = 64 * 1024;

/**
 * How far AFTER an agent's START a same-name receipt may have been written and
 * still be taken for that agent's own. PreToolUse precedes SubagentStart, so the
 * true receipt is never later; the margin absorbs clock granularity only.
 * @type {number}
 */
export const STOP_START_SLACK_MS = 1000;

/** Prefix of the correlation key `route-observe-pre.js#receiptKey` writes. */
const RECEIPT_KEY_PREFIX = 'route.pre:';

/** `route.bound` confidences that came from an identity match, not a position. */
const TRUSTED_BIND_CONFIDENCE = Object.freeze(['exact', 'name']);

/** The fallback id `hook-utils.js#extractAgentId` returns when the payload has none. */
const UNKNOWN_AGENT_ID = 'unknown';

const NEWLINE = 0x0a;

/** @param {unknown} value @returns {string|null} the string, or null when empty or not one */
const text = (value) => (typeof value === 'string' && value !== '' ? value : null);

/** @param {unknown} value @returns {string|null} a usable spawn id, or null */
const usableId = (value) => {
  const id = text(value);
  return id === null || id === UNKNOWN_AGENT_ID ? null : id;
};

/** @param {unknown} value @param {number} fallback @returns {number} a positive integer */
const positiveInt = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
);

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
 * Read exactly `buf.length` bytes at `position`, or as many as the file has.
 * @param {number} fd @param {Buffer} buf @param {number} position
 * @returns {number} bytes read
 */
function readFully(fd, buf, position) {
  let total = 0;
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, position + total);
    if (n <= 0) break;
    total += n;
  }
  return total;
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

/**
 * Fold one parsed row into the search state. The caller has already matched the
 * row against a needle, so the exact field checks here are what make it a hit.
 *
 * @param {object} row parsed ledger row
 * @param {object} st search state (mutated)
 * @param {{agentId: string|null, name: string|null, sessionId: string|null, notAfterMs: number|null}} q the query
 * @returns {void}
 */
function absorb(row, st, q) {
  if (row.event === 'route.bound') {
    if (st.exactDone || q.agentId === null || row.data?.agent_id !== q.agentId) return;
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
    st.epoch = text(row.data?.tool_use_id) ?? text(row.action_id);
    st.epochDone = st.epoch === null;
    return;
  }
  if (row.event !== 'route.selected') return;
  if (st.epoch !== null && !st.epochDone && row.routing_epoch_id === st.epoch) {
    st.epochDone = true;
    const type = subagentTypeFromReceiptKey(row.idempotency_key, row.routing_epoch_id);
    if (type !== null) st.exact = { type, source: 'route.bound>route.selected' };
  }
  if (!st.workerDone && row.worker === q.name && row.session_id === q.sessionId) {
    if (q.notAfterMs !== null) {
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts) || ts > q.notAfterMs) return;
    }
    const type = subagentTypeFromReceiptKey(row.idempotency_key, row.routing_epoch_id);
    if (type !== null) {
      st.workerType = type;
      st.workerDone = true;
    }
  }
}

/** @param {object} st search state @returns {boolean} nothing left to look for */
const finished = (st) => st.exact !== null
  || (st.exactDone && (st.epoch === null || st.epochDone) && st.workerDone);

/**
 * Search one decoded run of WHOLE lines, newest line first.
 *
 * Needles are JSON-quoted (`"<agent id>"`, `"worker":"<name>"`, `"<tool_use_id>"`)
 * so a hit is almost always the row wanted; `absorb` makes the exact check.
 * Per needle the next candidate line is cached, and only recomputed once a line
 * at or after it has been consumed, so a run costs one backward `lastIndexOf`
 * sweep per needle rather than one per candidate.
 *
 * @param {string} body whole lines, oldest first
 * @param {object} st search state (mutated)
 * @param {object} q query
 * @param {{id: string|null, worker: string|null}} needles fixed needles
 * @param {number} maxCandidates parse budget across the whole scan
 * @returns {boolean} true when the scan should stop (answer found, or budget spent)
 */
function searchRun(body, st, q, needles, maxCandidates) {
  const cache = { id: undefined, worker: undefined, epoch: undefined };
  let limit = body.length;
  for (;;) {
    const active = [];
    if (needles.id !== null && !st.exactDone) active.push(['id', needles.id]);
    if (needles.worker !== null && !st.workerDone) active.push(['worker', needles.worker]);
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
    st.parsed += 1;
    const row = parseRow(body.slice(best.start, best.end));
    if (row !== null) absorb(row, st, q);
    if (finished(st)) return true;
    if (st.parsed >= maxCandidates) return true;
    if (best.start === 0) return false;
    limit = best.start - 1;
  }
}

/**
 * Normalise a query into what `searchRun` needs: the exact-check fields and the
 * two fixed needles. The exact join needs a usable agent id; the name join needs
 * a name AND a session, and is bounded by the START time when one is given.
 *
 * @param {{agentId?: unknown, name?: unknown, sessionId?: unknown, startedAtMs?: unknown}} [query]
 * @returns {{q: object, needles: {id: string|null, worker: string|null}}}
 */
function planSearch(query) {
  const agentId = usableId(query?.agentId);
  const name = text(query?.name);
  const sessionId = text(query?.sessionId);
  const startedAtMs = Number.isFinite(query?.startedAtMs) ? query.startedAtMs : null;
  return {
    q: { agentId, name, sessionId, notAfterMs: startedAtMs === null ? null : startedAtMs + STOP_START_SLACK_MS },
    needles: {
      id: agentId === null ? null : JSON.stringify(agentId),
      worker: name === null || sessionId === null ? null : `"worker":${JSON.stringify(name)}`,
    },
  };
}

/**
 * Walk `[lowest, top)` of an open file from its END, `chunkBytes` at a time, and
 * hand each run of WHOLE lines (newest run first) to `onRun` until it says stop.
 *
 * What a chunk boundary splits is carried as BYTES to the next older chunk, so a
 * line is only ever decoded whole and a multibyte character is never decoded
 * half-read. Lines after a region's first newline are whole; what precedes it is
 * the tail of a line that began in an older chunk — or, at the window's edge
 * (`lowest > 0`), a line the window cut, which is dropped. A short read, or a
 * carry past {@link MAX_CARRY_BYTES} (not a ledger), ends the walk.
 *
 * @param {number} fd open file descriptor
 * @param {{top: number, lowest: number, chunkBytes: number}} window byte range and chunk size
 * @param {{bytesRead: number}} io counter, updated as chunks are read
 * @param {(run: string) => boolean} onRun receives whole lines; true stops the walk
 * @returns {void}
 */
function scanBackwards(fd, { top, lowest, chunkBytes }, io, onRun) {
  let end = top;
  let carry = Buffer.alloc(0);
  while (end > lowest) {
    const start = Math.max(lowest, end - chunkBytes);
    const chunk = Buffer.allocUnsafe(end - start);
    if (readFully(fd, chunk, start) !== chunk.length) return;
    io.bytesRead += chunk.length;
    const region = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
    const firstNl = region.indexOf(NEWLINE);
    // No newline at all in an interior region means the whole region is one partial line.
    const wholeFrom = start === 0 ? 0 : (firstNl < 0 ? region.length : firstNl + 1);
    carry = start === 0 ? Buffer.alloc(0) : region.subarray(0, firstNl < 0 ? region.length : firstNl);
    if (carry.length > MAX_CARRY_BYTES) return;
    if (wholeFrom < region.length && onRun(region.subarray(wholeFrom).toString('utf8'))) return;
    end = start;
  }
}

/**
 * Find the `subagent_type` a spawn was started with, from the ledger's tail.
 *
 * READS BACKWARDS, in chunks, and stops at the first answer: a chunk that holds
 * no needle costs one native `indexOf` per needle and no decode of its lines.
 * At most `maxBytes + 1` bytes are read — one byte of look-behind tells a line
 * the window edge cut from a whole one. See {@link scanBackwards} for how chunk
 * boundaries are handled. NEVER THROWS.
 *
 * @param {unknown} ledgerPath absolute ledger file path; anything else finds nothing
 * @param {{agentId?: unknown, name?: unknown, sessionId?: unknown, startedAtMs?: unknown}} [query]
 *   `agentId` enables the exact join; `name` + `sessionId` enable the name join, which
 *   `startedAtMs` (the agent's START time) bounds so a LATER same-name spawn is never taken
 * @param {{maxBytes?: number, chunkBytes?: number, maxCandidates?: number, endOffset?: number}} [opts]
 *   caps, and `endOffset` — read as if the file ended there (replay and tests)
 * @returns {{type: string|null, source: string|null, bytesRead: number, candidates: number}}
 *   `source` is `route.bound` | `route.bound>route.selected` | `route.selected:worker`
 */
export function findSpawnSubagentType(ledgerPath, query, opts = {}) {
  const st = {
    exact: null, exactDone: false, epoch: null, epochDone: false, workerType: null, workerDone: false, parsed: 0,
  };
  const io = { bytesRead: 0 };
  const result = () => {
    const hit = st.exact
      ?? (st.workerType === null ? null : { type: st.workerType, source: 'route.selected:worker' });
    return { type: hit?.type ?? null, source: hit?.source ?? null, bytesRead: io.bytesRead, candidates: st.parsed };
  };
  let fd = null;
  try {
    if (typeof ledgerPath !== 'string' || ledgerPath === '') return result();
    const { q, needles } = planSearch(query);
    st.exactDone = needles.id === null;
    st.workerDone = needles.worker === null;
    if (finished(st)) return result();

    const maxCandidates = positiveInt(opts.maxCandidates, STOP_SCAN_MAX_CANDIDATES);
    fd = openSync(ledgerPath, 'r');
    const size = fstatSync(fd).size;
    const top = Number.isFinite(opts.endOffset) && opts.endOffset >= 0
      ? Math.min(size, Math.floor(opts.endOffset))
      : size;
    const floor = Math.max(0, top - positiveInt(opts.maxBytes, STOP_SCAN_BYTES));
    scanBackwards(fd, {
      top,
      // One byte of look-behind: when it is a newline, the line at `floor` is whole.
      lowest: floor > 0 ? floor - 1 : 0,
      chunkBytes: positiveInt(opts.chunkBytes, STOP_SCAN_CHUNK_BYTES),
    }, io, (run) => searchRun(run, st, q, needles, maxCandidates));
    return result();
  } catch {
    return result();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
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
