/**
 * Mission ledger append for the tasks middleware (runtime layer, L5).
 *
 * EXTRACTED from `tasks.js`, behavior-neutral. That file had reached 819 lines
 * (measured 2026-09-23), past the 800-line file ceiling (plugin `CLAUDE.md`
 * Quality Gates), with more wiring still due in `tasks.js#recordMissionCompile`.
 * The cut follows a seam the code already had: everything from the
 * compiler-name allowlist through `appendMissionEvent` produces the ONE ledger
 * line per prompt, and none of it touches the StateStore. The store write, the
 * row mutators and the compile orchestration stay in `tasks.js`, under its
 * "Mission compile (T-25)" block comment, which still describes the three paths
 * a substantive prompt writes — this module owns the first of them.
 *
 * WHAT CROSSES THE BOUNDARY. `tasks.js` imports four names:
 * {@link resolveMissionIdentity} and {@link appendMissionEvent} for the append,
 * and {@link missionTitle} / {@link missionIntentRevision} for the store row.
 * The last two are why the ledger line and the store row agree by construction
 * — both read the same expression — so they are defined here once and imported,
 * never copied.
 *
 * Fail-open, unchanged: a refused or thrown append becomes a status string,
 * never an exception. The prompt has to survive its own bookkeeping.
 *
 * @module lib/runtime/middleware/mission-ledger
 */

import { createHash } from 'node:crypto';
import { appendLedgerEvent } from '../ledger.js';
import { sessionFallbackMissionId } from '../event-writer.js';

/**
 * Ledger event names this middleware may append, keyed by the spelling
 * `compileMission()` returns in `meta.ledgerEvent`.
 *
 * An ALLOWLIST map, not a normalizer. A rule that rewrote hyphens into dots
 * and underscores would fail OPEN for every event name the compiler invents
 * later (verification-discipline §8); a name absent from this table is skipped
 * and recorded instead.
 *
 * The hyphenated key is a real observed value, not defensive padding:
 * `lib/mission/compiler.js#compileMission` returns `'mission-candidate-deferred'`
 * in its `meta.ledgerEvent` — design §3.1's spelling — while the ledger
 * vocabulary registers `mission.candidate_deferred`
 * (`schemas/ledger-events.allowlist.json#/events/mission.candidate_deferred`,
 * whose `spec` field records that normalization). The allowlist is the
 * canonical vocabulary, so the append uses its name.
 */
const LEDGER_EVENT_BY_COMPILER_NAME = Object.freeze({
  'mission.created': 'mission.created',
  'mission-candidate-deferred': 'mission.candidate_deferred',
  'mission.candidate_deferred': 'mission.candidate_deferred',
});

/**
 * Cap on the ledger `title`. `mission.created` REQUIRES it, so the writer's
 * oversize fold cannot drop it — an unbounded goal string would push the whole
 * line past the 4 KB cap and get it rejected outright.
 */
const MISSION_TITLE_MAX = 120;

/** Cap on recorded signals, so a long signal list cannot crowd the same line. */
const MISSION_SIGNALS_MAX = 20;

/**
 * Longest host `prompt_id` a key is built from — the bound
 * `lib/observability/decision-events.js#MAX_PROMPT_ID_LENGTH` applies to the
 * same payload field. A longer one gets no key rather than a line pushed
 * toward the 4 KB cap by an id nobody bounded.
 */
const PROMPT_ID_MAX = 128;

/** Hex characters of the `data` digest in a mission event key. */
const DATA_DIGEST_CHARS = 16;

/**
 * The project root the ledger is written under.
 *
 * INJECTED, never derived: `pluginRoot` also has a `runtime/` directory, so a
 * writer that guessed would land in the wrong tree (event-writer.js module
 * header). The hook-payload keys mirror `middleware/memory.js#buildQueryContext`,
 * which is where this pipeline already reads the working directory from.
 *
 * @param {object} state
 * @returns {string|null} null when no root is knowable — append is then skipped
 */
function resolveProjectRoot(state) {
  const hookData = state.input?.hookData || {};
  const candidates = [
    state.input?.projectRoot,
    state.context?.projectRoot,
    hookData.cwd,
    hookData.working_directory,
    hookData.path,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c.length > 0);
  return found || null;
}

/**
 * The raw session id for the ledger envelope.
 *
 * Read raw rather than through `resolveDecisionRunId`, which sanitizes for use
 * as a filename; the envelope wants the session's own id, and the writer
 * derives the `M-YYYYMMDD-S<sid8>` fallback mission id from it.
 *
 * @param {object} state
 * @returns {string|null}
 */
function resolveSessionId(state) {
  const candidates = [state.input?.hookData?.session_id, state.input?.sessionId];
  const found = candidates.find((c) => typeof c === 'string' && c.trim().length > 0);
  return found ? found.trim() : null;
}

/**
 * The mission title, capped.
 *
 * EXTRACTED so the ledger line and the store row cannot drift apart. They have
 * to agree by construction, not because two call sites happen to spell the same
 * expression today: `/doctor` Check 8 pairs a `mission.created` event with the
 * store entry it created, and a title that matched when it was written and
 * diverged three edits later is a mismatch nobody would think to look for.
 *
 * @param {object} result `compileMission()` output
 * @param {string} prompt raw prompt, the fallback when the contract has no goal
 * @returns {string} the goal (or prompt) truncated to MISSION_TITLE_MAX
 */
export function missionTitle(result, prompt) {
  const goal = typeof result.contract?.goal === 'string' && result.contract.goal.length > 0
    ? result.contract.goal
    : prompt;
  return String(goal).slice(0, MISSION_TITLE_MAX);
}

/**
 * The intent revision for this compile.
 *
 * No revision source exists in Phase 0 — `intent_revision` is the caller's,
 * copied through by `compiler.js#assignOptionalFields`, and this caller has
 * none, so a first compile is revision 1. Revisions are T-24's.
 *
 * EXTRACTED for the same reason as {@link missionTitle}: the ledger's
 * `intent_revision` and the store's `mission.intent.revision` are ONE fact, and
 * the pairing stays checkable only while they stay one expression.
 *
 * @param {object} result `compileMission()` output
 * @returns {number} an integer >= 1
 */
export function missionIntentRevision(result) {
  return Number.isInteger(result.contract?.intent_revision)
    ? result.contract.intent_revision
    : 1;
}

/**
 * The three identifiers the append and the store write MUST agree on, resolved
 * once from one instant.
 *
 * WHY ONCE. `sessionFallbackMissionId` folds its instant down to a UTC DATE.
 * Two independent `now()` reads that straddle midnight therefore produce
 * `M-20260904-S…` and `M-20260905-S…` for the same prompt, and the
 * `mission.created` event and its paired `state.updated` land on two different
 * missions — one of them an orphan with no `mission.created` and the other a
 * mission whose write nobody recorded, which is exactly the pair `/doctor`
 * Check 8 exists to find. The window is a few milliseconds a day, so it would
 * never be reproduced by a test that did not deliberately aim at it, and the
 * damage it leaves behind is indistinguishable from a lost update.
 *
 * `missionId` is null EXACTLY when `sessionId` is: `sessionFallbackMissionId`
 * refuses only a non-string or empty session id, and `resolveSessionId` already
 * returns null in that case. The two are therefore checked together downstream
 * rather than given separate refusal reasons for a state that cannot differ.
 *
 * @param {object} state middleware state
 * @param {number} nowMs the single epoch-ms reading for this prompt
 * @returns {{projectRoot: string|null, sessionId: string|null, missionId: string|null}}
 */
export function resolveMissionIdentity(state, nowMs) {
  const projectRoot = resolveProjectRoot(state);
  const sessionId = resolveSessionId(state);
  return {
    projectRoot,
    sessionId,
    missionId: sessionId ? sessionFallbackMissionId(sessionId, new Date(nowMs)) : null,
  };
}

/**
 * The `data` object for one mission ledger line — the minimum each event's
 * allowlist entry requires, and nothing else.
 *
 * The contract itself is NOT written to the ledger. It carries verbatim spans
 * of the user's prompt, and the ledger line is capped at 4 KB; the contract
 * stays in memory on the task envelope, where the cap does not apply.
 *
 * @param {string} eventName resolved allowlist event name
 * @param {object} result `compileMission()` output
 * @param {string} prompt raw prompt, the title fallback
 * @returns {object}
 */
function buildMissionLedgerData(eventName, result, prompt) {
  if (eventName === 'mission.created') {
    return {
      title: missionTitle(result, prompt),
      intent_revision: missionIntentRevision(result),
    };
  }
  return {
    reason: result.deferred ? 'substantive-gate:deferred' : 'substantive-gate:not-substantive',
    signals: Array.isArray(result.signals) ? result.signals.slice(0, MISSION_SIGNALS_MAX) : [],
    // THE TITLE CARRIER FOR STAGE ② (design §3.1 "mission_id 발급 2단계").
    //
    // A deferred candidate is the only record of what the user asked for, and
    // `scripts/hooks/intent-observe-pre.js` promotes it to `mission.created`
    // at the session's first write tool — by which time the prompt is gone.
    // Without this key the promotion has to name the mission after the file
    // being written, which is a filename, not an intent.
    //
    // The allowlist declares `mission.candidate_deferred` with
    // `required: []` and typed `fields {reason, signals}` only;
    // `event-writer.js#validateDeclaredFields` type-checks DECLARED keys and
    // passes undeclared ones, so this rides legally without widening the
    // schema. Capped by `missionTitle` at MISSION_TITLE_MAX for the same
    // reason `mission.created` is: the line has a 4 KB budget.
    title: missionTitle(result, prompt),
  };
}

/**
 * Idempotency key for one mission lifecycle line (SH-14).
 *
 * Shape follows `lib/context/rehydration.js#contextCompiledIdempotencyKey`
 * (`<event>:<scope>:<id>:<digest16>`), with the mission in the scope slot as
 * `lib/checkpoint/checkpoint-service.js#missionCheckpointedIdempotencyKey` has
 * it: the line's identity is the mission it opens or defers.
 *
 * THE ID IS THE HOST'S `prompt_id`, because nothing else on the line tells two
 * prompts apart. `mission_id` is one per session per UTC day, and Phase 0 has
 * no revision source, so two different prompts in one session-day would share
 * `<event>:<mission>:r1` — two facts collapsed into one key. The prompt id is
 * minted once per prompt, so a re-fired hook for the same prompt carries it
 * again and a new prompt (even with the same text) does not. No clock is read:
 * a clock-derived part would make every re-fire a new key.
 *
 * The digest is over the `data` actually appended, so the same prompt compiled
 * into a different line is a different key. `JSON.stringify` is canonical
 * enough here: {@link buildMissionLedgerData} is the one builder of `data` and
 * writes its keys in a fixed order.
 *
 * @param {unknown} eventName resolved allowlist event name
 * @param {unknown} missionId
 * @param {unknown} promptId the hook payload's `prompt_id`
 * @param {object} data the line's `data`
 * @returns {string|null} `null` without a usable part — the caller then omits
 *   the field, since the envelope refuses a blank key.
 */
export function missionEventIdempotencyKey(eventName, missionId, promptId, data) {
  const parts = [eventName, missionId, promptId];
  if (parts.some((p) => typeof p !== 'string' || p.length === 0)) return null;
  if (promptId.length > PROMPT_ID_MAX) return null;
  const digest = createHash('sha256')
    .update(JSON.stringify(data ?? null))
    .digest('hex')
    .slice(0, DATA_DIGEST_CHARS);
  return `${eventName}:${missionId}:${promptId}:${digest}`;
}

/**
 * The envelope for one mission ledger line, written as a literal per event.
 *
 * ONE LITERAL OBJECT PER ALLOWLIST NAME, and nothing for any other name. The
 * event name and `source` are inline string literals so
 * `tests/firewall/hook-emitter-sources-rule.test.js` can read both statically
 * instead of carrying this emitter as a scanner exception (SH-30). A name
 * outside the two branches gets `null`, never a fallback envelope: an `else`
 * here would fail OPEN for every event name added to
 * {@link LEDGER_EVENT_BY_COMPILER_NAME} later without a branch of its own.
 *
 * Key order is the order the writer's extra keys land on disk in —
 * `idempotency_key` before `data` — and is pinned byte for byte by the SH-30
 * characterization block in `tests/runtime/middleware/mission-ledger.test.js`.
 *
 * @param {string} eventName resolved allowlist event name
 * @param {{missionId: string, sessionId: string, key: string|null, data: object}} parts
 * @returns {object|null} the envelope, or `null` for a name with no branch
 */
export function missionLedgerEnvelope(eventName, { missionId, sessionId, key, data }) {
  // Omitted, never blank, without a usable key: see missionEventIdempotencyKey.
  const keyed = key === null ? {} : { idempotency_key: key };
  // `mission_id` is PASSED EXPLICITLY rather than left to the writer's
  // fallback. `event-writer.js#buildEnvelope` prefers a non-empty
  // `src.mission_id` and only otherwise derives one from `(session_id, ts)` —
  // so handing it the id computed here is what makes this event and the paired
  // `state.updated` name the same mission across a UTC midnight.
  //
  // Both events are registered `sources: ["hook"]`. This middleware runs
  // inside the UserPromptSubmit hook pipeline, so 'hook' is accurate as well
  // as the only permitted value.
  if (eventName === 'mission.created') {
    return {
      event: 'mission.created',
      mission_id: missionId,
      session_id: sessionId,
      source: 'hook',
      ...keyed,
      data,
    };
  }
  if (eventName === 'mission.candidate_deferred') {
    return {
      event: 'mission.candidate_deferred',
      mission_id: missionId,
      session_id: sessionId,
      source: 'hook',
      ...keyed,
      data,
    };
  }
  return null;
}

/**
 * Append the one mission event for this prompt.
 *
 * Never throws and never affects the middleware result: every refusal becomes
 * a short status string. `appendLedgerEvent` already returns rather than
 * throws, but it is wrapped anyway — a bookkeeping call must not be able to
 * take its caller down.
 *
 * @param {object} state
 * @param {object} result `compileMission()` output
 * @param {number} nowMs the single epoch-ms reading for this prompt
 * @param {{projectRoot: string|null, sessionId: string|null, missionId: string|null}} identity
 *   from {@link resolveMissionIdentity} — shared with the store write
 * @returns {{ok: boolean, status: string, event?: string}}
 */
export function appendMissionEvent(state, result, nowMs, identity) {
  const compilerName = result.meta?.ledgerEvent;
  const eventName = Object.prototype.hasOwnProperty.call(
    LEDGER_EVENT_BY_COMPILER_NAME, compilerName,
  ) ? LEDGER_EVENT_BY_COMPILER_NAME[compilerName] : null;
  if (!eventName) return { ok: false, status: `skipped:unknown-event:${compilerName}` };

  const { projectRoot, sessionId, missionId } = identity;
  if (!projectRoot) return { ok: false, status: 'skipped:no-project-root' };
  // One reason for both, because they cannot differ — see
  // `resolveMissionIdentity`. A separate `skipped:no-mission-id` status would
  // be an unreachable branch that a reader would waste time trying to trigger.
  if (!sessionId || !missionId) return { ok: false, status: 'skipped:no-session-id' };

  try {
    const data = buildMissionLedgerData(eventName, result, String(state.input?.prompt ?? ''));
    // Omitted, never blank, without a usable prompt id: see the builder.
    const key = missionEventIdempotencyKey(
      eventName, missionId, state.input?.hookData?.prompt_id, data,
    );
    const envelope = missionLedgerEnvelope(eventName, { missionId, sessionId, key, data });
    // Statically unreachable today: every value of LEDGER_EVENT_BY_COMPILER_NAME
    // has a branch, and the hook-emitter gate pins that the map's values and
    // the envelope literals are the same set. Kept as the fail-closed answer
    // for a map entry added without a branch — the same skip as an unknown
    // compiler name, so no new status word exists for it.
    if (envelope === null) return { ok: false, status: `skipped:unknown-event:${compilerName}` };
    const written = appendLedgerEvent(projectRoot, envelope, { now: () => new Date(nowMs) });
    return written?.ok
      ? { ok: true, status: 'appended', event: eventName }
      : { ok: false, status: `rejected:${written?.reason ?? 'unknown'}`, event: eventName };
  } catch (err) {
    return { ok: false, status: `error:${err?.message ?? 'append-threw'}`, event: eventName };
  }
}
