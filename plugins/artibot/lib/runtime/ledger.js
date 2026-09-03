/**
 * Central run ledger — the append surface plus the read projections over it.
 *
 * The physical file is ONE append-only JSONL stream per project
 * (`<projectRoot>/.artibot/runtime/ledger.jsonl`); the write mechanics,
 * envelope, vocabulary allowlist, byte cap, and redaction all live in
 * `./event-writer.js`. This module is the API that callers and readers use:
 *
 *   appendLedgerEvent  — write one event (delegates to the writer)
 *   readAllEvents      — every well-formed line, deduped
 *   foldMissions       — the v1.0 run-ledger view, reconstructed per mission
 *   currentMission     — the mission a session is currently inside
 *
 * WHY A FOLD AND NOT A SECOND FILE — v1.0 §13 blueprinted a structured
 * `runtime/run-ledger.js` object while v1.1 §11/§02 specifies one central
 * event stream. Both are satisfied with one physical file: the event stream is
 * the record, and `foldMissions` reconstructs the v1.0 run-ledger SHAPE as a
 * read projection (lane 6 §2.12 — "v1.0 의 run-ledger.js 는 만들지 않고
 * ledger.js#foldMissions 가 v1.0 스키마 객체를 반환"). Nothing derived is ever
 * written back: a projection that is persisted becomes a second source of
 * truth, and then the two disagree.
 *
 * DEDUPE IS THE READER'S JOB — the writer never reads the file it appends to,
 * so a duplicate line is possible in principle and is resolved here, on
 * `(session_id, source, pid, seq)` (lane 6 §2.8 names the last three; the
 * session is added because a reused pid otherwise erases a later line — see
 * {@link dedupeKey}). Gaps are visible in the same key but are NOT judged here:
 * counting missing sequence numbers is /doctor Check 8's job (T-43), and
 * duplicating that logic would create a second answer to one question.
 *
 * WHAT THE FOLD CANNOT FILL (known gaps, recorded as gaps rather than zeros):
 *   - `execution.files` — no Phase 0 event carries touched-file paths.
 *     `worker.claimed.owns[]` is an ownership declaration, not a touch list,
 *     so folding it in here would answer a different question. Stays `[]`.
 *   - `route.effort` — route.selected's data contract is
 *     route-receipt.schema.json, which has no effort field. Stays `null`.
 *   - `review.verdict` — returned VERBATIM in the canonical five-value
 *     vocabulary (PASS | REPAIR_REQUIRED | REPLAN_REQUIRED |
 *     INTENT_REVIEW_REQUIRED | BLOCK). The v1.0 schema's three-value
 *     `pass|repair|replan` enum is a superseded draft — schemas/
 *     verdict-adapter-map.json records it as source `design-v1.0-08` — and
 *     narrowing five values into three here would be an undeclared adapter
 *     inside a read projection. The vocabulary adapter is T-17's.
 *
 * OBSERVE STAGE — Phase 0 ships this with ZERO callers. It records; it changes
 * no behavior.
 *
 * @module lib/runtime/ledger
 */

import { existsSync, readFileSync } from 'node:fs';
import { ledgerFilePath, writeEvent } from './event-writer.js';

export { ledgerFilePath } from './event-writer.js';

/** Events that describe the ledger's own bookkeeping, not a mission's work. */
const META_EVENTS = new Set(['ledger.rejected']);

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append one event to the project's central ledger.
 *
 * Thin by design: every rule (envelope, allowlist, cap, redaction) belongs to
 * the writer, so there is exactly one place a line can be shaped. Never throws.
 *
 * @param {string} projectRoot absolute project root (INJECTED — never derived)
 * @param {object} event caller fields; `event`, `session_id`, `source` at minimum
 * @param {{now?: () => Date, seq?: number, pid?: number, ledgerPath?: string,
 *          maxLineBytes?: number}} [opts]
 * @returns {object} the writer's result — see event-writer.js#writeEvent
 */
export function appendLedgerEvent(projectRoot, event, opts = {}) {
  return writeEvent(projectRoot, event, opts);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Parse one JSONL line. Returns null for blank, corrupt, or non-object lines.
 *
 * A corrupt line is SKIPPED, never thrown on: a torn tail (the process died
 * mid-append) must not make the whole history unreadable.
 *
 * @param {string} line
 * @returns {object|null}
 */
function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * The reader-side identity of one ledger line.
 *
 * `session_id` IS PART OF THE KEY, and leaving it out loses lines. `seq`
 * restarts at 0 in every process and the ledger outlives any one of them, so
 * the operating system reusing a pid across sessions or a reboot is enough to
 * make a later line collide with an older one and be dropped as a "duplicate".
 * The four fields together are what actually identify a line.
 *
 * The separator is `\0` rather than a space or a colon because a session id is
 * caller-supplied: without a byte that cannot occur inside a field, two
 * different lines could be spelled into the same key.
 *
 * WRITTEN AS THE ESCAPE `\0`, NEVER AS A LITERAL NUL BYTE. The same byte in the
 * source file makes ripgrep classify the whole file as binary and print
 * `Binary file … matches` instead of the match, so everything after the first
 * occurrence stops being greppable — measured at 62% of this file when it was
 * a literal. Identical bytes at runtime, and the file stays searchable.
 *
 * @param {object} e
 * @returns {string}
 */
export function dedupeKey(e) {
  return `${e?.session_id}\0${e?.source}\0${e?.pid}\0${e?.seq}`;
}

/**
 * Drop duplicate lines on {@link dedupeKey}, keeping the first occurrence. Pure.
 *
 * @param {object[]} events
 * @returns {object[]}
 */
export function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const key = dedupeKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Read every well-formed line of the ledger, deduped and in file order.
 *
 * @param {string} projectRoot
 * @param {{since?: string|number|Date, mission_id?: string, session_id?: string,
 *          event?: string, includeRejected?: boolean, ledgerPath?: string}} [filter]
 *   `includeRejected` defaults to false — `ledger.rejected` lines record the
 *   writer's own refusals and are not part of any mission's history.
 * @returns {object[]} `[]` when the file is missing or unreadable
 */
export function readAllEvents(projectRoot, filter = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return [];
  const file = ledgerFilePath(projectRoot, filter);
  let raw;
  try {
    if (!existsSync(file)) return [];
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const sinceMs = filter.since === undefined ? null : new Date(filter.since).getTime();
  const out = [];
  for (const line of raw.split('\n')) {
    const e = parseLine(line);
    if (!e || typeof e.event !== 'string') continue;
    if (!filter.includeRejected && META_EVENTS.has(e.event)) continue;
    if (filter.mission_id && e.mission_id !== filter.mission_id) continue;
    if (filter.session_id && e.session_id !== filter.session_id) continue;
    if (filter.event && e.event !== filter.event) continue;
    if (Number.isFinite(sinceMs) && !(Date.parse(e.ts) >= sinceMs)) continue;
    out.push(e);
  }
  return dedupeEvents(out);
}

// ---------------------------------------------------------------------------
// Fold — the v1.0 run-ledger projection
// ---------------------------------------------------------------------------

/**
 * An empty run-ledger record. Every branch of the fold starts here, so a
 * mission with no matching events yields the same SHAPE as a complete one and
 * a reader never has to branch on `undefined`.
 *
 * @param {string} missionId
 * @returns {object}
 */
function emptyRun(missionId) {
  return {
    mission_id: missionId,
    action_id: null,
    route: { model: null, effort: null, reason: [] },
    topology: { mode: null },
    economics: {
      fresh_input: 0, cached_input: 0, output: 0, thinking: 0, total_cost: 0,
    },
    execution: { tools: [], files: [], retries: 0 },
    review: { model: null, verdict: null, findings: [] },
    verification: { result: null, evidence: [] },
    outcome: { accepted: null },
  };
}

/**
 * Fold the routing events. Later events win: `model.switched.to` is the model
 * in force after the switch, so the last one is the mission's model.
 *
 * @param {object} run
 * @param {object} e
 * @returns {void}
 */
function applyRouteEvent(run, e) {
  const d = e.data ?? {};
  if (e.event === 'route.selected') {
    if (typeof d.models?.selected === 'string') run.route.model = d.models.selected;
    if (Array.isArray(d.reason)) run.route.reason.push(...d.reason);
  } else if (e.event === 'model.switched') {
    if (typeof d.to === 'string') run.route.model = d.to;
    if (typeof d.reason === 'string') run.route.reason.push(d.reason);
  } else if (e.event === 'topology.selected') {
    if (typeof d.mode === 'string') run.topology.mode = d.mode;
  }
}

/**
 * Fold one `usage.receipt` into the economics totals. Costs and token counts
 * ACCUMULATE — one mission has many attempts, and the receipt is per attempt
 * (Hardening §3: cost is Run-scoped).
 *
 * @param {object} run
 * @param {object} e
 * @returns {void}
 */
function applyUsageReceipt(run, e) {
  const u = e.data?.usage ?? {};
  const c = e.data?.cost ?? {};
  const add = (n) => (Number.isFinite(n) ? n : 0);
  run.economics.fresh_input += add(u.fresh_input_tokens);
  run.economics.cached_input += add(u.cached_input_tokens);
  run.economics.output += add(u.output_tokens);
  run.economics.thinking += add(u.thinking_tokens);
  run.economics.total_cost += add(c.total);
}

/**
 * Fold the execution, review, verification, and outcome events.
 *
 * `outcome.accepted` takes the LAST value written. §2.6 makes acceptance a
 * deferred, append-only judgment: `{accepted:null}` is appended when the
 * mission ends and a second line carries the real verdict once the observation
 * window closes. The reader takes the last value; `null` means "not yet
 * judged", which is why it is a value here and not an absence.
 *
 * @param {object} run
 * @param {object} e
 * @returns {void}
 */
function applyOutcomeEvent(run, e) {
  const d = e.data ?? {};
  if (e.event === 'tool.used') {
    if (typeof d.tool === 'string') run.execution.tools.push(d.tool);
  } else if (e.event === 'retry.scheduled') {
    run.execution.retries += 1;
  } else if (e.event === 'review.completed') {
    if (typeof e.model === 'string') run.review.model = e.model;
    if (typeof d.verdict === 'string') run.review.verdict = d.verdict;
    if (typeof d.findings_ref === 'string') run.review.findings.push(d.findings_ref);
  } else if (e.event === 'verify.completed') {
    if (typeof d.result === 'string') run.verification.result = d.result;
    if (Array.isArray(d.evidence)) run.verification.evidence.push(...d.evidence);
  } else if (e.event === 'mission.completed') {
    run.outcome.accepted = d.accepted ?? null;
  }
}

/**
 * Fold the ledger into one v1.0 run-ledger-shaped object per mission.
 *
 * The shape mirrors `schemas/run-ledger.schema.yaml` (v1.0 design package):
 * `{mission_id, action_id, route, topology, economics, execution, review,
 * verification, outcome}`. Read the module header for the three fields Phase 0
 * cannot populate and why they are left empty rather than guessed.
 *
 * @param {string} projectRoot
 * @param {{mission_id?: string, since?: string|number|Date, ledgerPath?: string}} [filter]
 * @returns {object[]} one record per mission, ordered by first appearance
 */
export function foldMissions(projectRoot, filter = {}) {
  const events = readAllEvents(projectRoot, filter);
  /** @type {Map<string, object>} */
  const runs = new Map();
  for (const e of events) {
    const id = typeof e.mission_id === 'string' ? e.mission_id : null;
    if (!id) continue;
    if (!runs.has(id)) runs.set(id, emptyRun(id));
    const run = runs.get(id);
    if (typeof e.action_id === 'string') run.action_id = e.action_id;
    applyRouteEvent(run, e);
    if (e.event === 'usage.receipt') applyUsageReceipt(run, e);
    applyOutcomeEvent(run, e);
  }
  return [...runs.values()];
}

// ---------------------------------------------------------------------------
// Current mission
// ---------------------------------------------------------------------------

/**
 * The mission a session is currently inside, read from the ledger.
 *
 * A mission counts as open until a `mission.completed` line carries a non-null
 * `accepted`: §2.6 appends `{accepted:null}` first, so treating the first
 * completion line as closure would end a mission that is still awaiting its
 * acceptance verdict. When no mission is open, the most recent mission for the
 * session is returned — a session always has a mission_id, because a
 * non-substantive one gets the session fallback.
 *
 * NOT the canonical carrier: `state.yaml#active_missions` is
 * (lane 6 §2.5), and this is the ledger's own answer to the same question. Use
 * it for reconstruction and cross-checking, not as a replacement for the state
 * store (T-21).
 *
 * @param {string} projectRoot
 * @param {{session_id?: string, ledgerPath?: string}} [filter]
 * @returns {string|null}
 */
export function currentMission(projectRoot, filter = {}) {
  const events = readAllEvents(projectRoot, filter);
  const closed = new Set();
  let latest = null;
  for (const e of events) {
    if (typeof e.mission_id !== 'string') continue;
    latest = e.mission_id;
    if (e.event === 'mission.completed' && (e.data?.accepted ?? null) !== null) {
      closed.add(e.mission_id);
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const id = events[i].mission_id;
    if (typeof id === 'string' && !closed.has(id)) return id;
  }
  return latest;
}
