/**
 * `hook.fired` — the DISPATCHER-LEVEL carrier for the Existence Audit's `hooks`
 * kind.
 *
 * WHY THIS FILE EXISTS. `lib/replay/existence-audit.js#CARRIERS.hooks` has been
 * `null` since the 2026-09-02 survey and was re-measured still null on
 * 2026-09-15: across the registered events, no `data` field names a HOOK. The
 * closest candidates name an agent, a memory file or a tool — one level off
 * every time. So the CLAUDE.md Existence Audit rule ("소비처 0 + 발화 0 이
 * 2릴리스 연속이면 제거 후보") could not be evaluated for any hook at all, and a
 * `fired: 0` for a hook would have been indistinguishable from a silence nobody
 * was listening for. This module makes the firing audible.
 *
 * ONE ROW PER DISPATCH, NOT ONE PER HANDLER (owner decision O8 = a1,
 * 2026-09-17). A PostToolUse Edit payload runs six handlers; the alternative
 * shape would have written six lines for one tool call, multiplying the
 * ledger's line count by the fan-out of the busiest slot. Instead the handler
 * array is FOLDED INTO the row:
 *
 *   { event:'hook.fired', session_id, mission_id, source:'hook', action_id?,
 *     data:{ slot, hooks:[...names], failed:[...names], count, tool? } }
 *
 * `data.hooks` is every handler the dispatcher actually spawned for this
 * payload, in dispatch order. `data.failed` is the SUBSET whose spawn status
 * was not `ok` — `spawnHook` resolves `'ok' | 'timeout' | 'error'` and never
 * rejects (`scripts/hooks/_dispatcher-utils.js#spawnHook`), so a failure is a
 * status, not an exception. `count` is `hooks.length`, restated so a reader
 * folding thousands of rows does not have to materialise every array.
 *
 * NAMES ARE RECORDED RAW (leader decision sh29-3). The spelling is whatever the
 * dispatch table (`hooks/dispatch-table.json`) calls the entry. Normalising
 * here would put a second naming authority between the table and the audit, and
 * the audit's whole job is to match a name against a file that exists.
 *
 * `tool` IS PRESENT ONLY FOR PostToolUse, and only when `extractToolName`
 * returned one. The five other slots have no tool, and an OMITTED key is the
 * honest record of that: the allowlist declares `fields.tool.type = "string"`
 * and `lib/runtime/ledger-schema.js#matchesType` refuses `null` against a
 * declared string, so writing `null` would turn the whole row into a
 * `type-violation:tool` REJECTION rather than a row missing one field. The same
 * reasoning `tool-used-record.js` applies to `skill`.
 *
 * ── O8-i SWITCH (owner decision 2026-09-17) ────────────────────────────────
 * `artibot.config.json#/ledger/hookFired/slots` is an ALLOWLIST of dispatcher
 * slot names. A dispatch whose slot is not on it is skipped here with
 * `{ok:false, reason:'slot-disabled'}` and writes no row. It exists so the
 * owner can silence the NOISIEST slot alone — PostToolUse dispatched >= 679
 * times/day (measured 2026-09-15) — after two Shadow releases, without an env
 * var that would disable the whole dispatcher.
 *
 * DEFAULT ON, AND THAT DIRECTION IS THE POINT. When the key is ABSENT or its
 * value is NOT AN ARRAY, {@link readHookFiredSlots} returns `null` and every
 * slot is recorded exactly as it was before this switch existed. An older
 * config, a partial install or a malformed edit therefore cannot silently
 * silence the carrier; only a deliberate array can. (The array direction is
 * itself an allowlist, so a slot added later is OFF until someone lists it —
 * fail-closed in the generating direction, rules §8. An EMPTY array is a real
 * allowlist of none and records nothing.) The read never throws: an unreadable
 * or unparsable config degrades to `null`, i.e. to recording everything.
 *
 * DISABLING A SLOT IS NOT MEASURING IT AT ZERO. With a slot off, its hooks
 * carry no `hook.fired` row at all, so `lib/replay/existence-audit.js` reads
 * them as `unmeasured:carrier-event-absent-from-ledger` — NOT as `fired: 0`.
 * That distinction is the whole reason this module was written, so turning a
 * slot off removes those hooks from the Existence Audit's denominator rather
 * than making them removal candidates.
 *
 * NOT A HOOK, AND NOT A 13th ENTRY IN ANY DISPATCH TABLE. This is a LIBRARY
 * module called in-process by the dispatchers after they have written their
 * merged stdout. It has no `main()`, no stdin read and no direct-run guard,
 * because there is nothing to guard: importing it runs nothing. Registering it
 * as a hook would have cost one more `node` spawn per dispatch and would have
 * recorded itself as a handler, which is a measurement of the measurement.
 *
 * MUTE, LIKE EVERYTHING INSIDE A DISPATCH. The dispatcher MERGES child stdout
 * into the host's hook output (`mergeResults`), and it has already written that
 * document by the time this runs. A single byte on stdout from here would be
 * appended AFTER a complete JSON document and corrupt it. Nothing is ever
 * written to stdout; errors go to stderr under `[artibot:hook-fired-record]`.
 * {@link recordHookFired} never throws, so a carrier fault cannot reach the
 * slot even if the caller forgot its own try/catch.
 *
 * ── WHAT THIS MODULE CANNOT SEE (rules §9 — write it next to the gate) ──────
 *   - A DISPATCH THAT RAN ZERO HANDLERS. PostToolUse returns before spawning
 *     anything when its tool-filtered table is empty, and UserPromptSubmit
 *     returns on a non-user prompt; neither writes a row (the other four
 *     slots always run their whole table). "0 handlers fired" is therefore
 *     ABSENT from the ledger rather than recorded as a zero. That is
 *     deliberate — the audit counts firings of a named hook, and a dispatch
 *     that named none has nothing to attribute — but it means `hook.fired`
 *     row counts are NOT a count of dispatcher invocations.
 *   - THE COST OF A NON-GIT `cwd`. `resolveProjectRoot` falls back to a
 *     `git rev-parse` spawn when `payload.cwd` has no `.git` ancestor
 *     (`lib/git/project-root.js`, ~240-360 ms per dispatcher process measured
 *     2026-09-17, vs ~2 ms inside a repository) and the row then lands in
 *     `<cwd>/.artibot/runtime/`. `session-ledger.mjs` already pays the same
 *     price on Stop/SessionEnd; whether to skip non-git cwd instead is a
 *     policy decision that belongs to that resolver, not to this writer.
 *   - WHETHER A HANDLER DID ANYTHING. `status: 'ok'` means the child exited,
 *     not that it acted. A hook that returns immediately on its own guard is
 *     indistinguishable here from one that did work.
 *   - A ROW THAT LOST ITS ARRAYS TO THE BYTE CAP. Over 4,096 B
 *     (`artibot.config.json#/ledger/maxLineBytes`) `foldOversized` keeps only
 *     the allowlist's `required` keys — `slot` and `hooks` — drops `failed`,
 *     `count` and `tool`, and the line is ACCEPTED. A fold writes one stderr
 *     line here and is invisible in the ledger's own error stream.
 *   - HOOKS THE HOST RUNS OUTSIDE AN ARTIBOT DISPATCHER. Only the six
 *     dispatchers call this. A hook registered directly in settings.json
 *     produces no row.
 *
 * @module scripts/hooks/_hook-fired-record
 */

import { readFileSync } from 'node:fs';

import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { isMissionId, sessionFallbackMissionId } from '../../lib/mission/mission-id.js';

/** The registered event this module writes. */
export const HOOK_FIRED_EVENT = 'hook.fired';

/**
 * Envelope `source` — who emitted the line. `hook.fired`'s allowlist entry
 * permits `hook` and nothing else.
 * @type {string}
 */
const LEDGER_SOURCE = 'hook';

/** stderr label. The only channel this module may speak on. */
const ERR_TAG = '[artibot:hook-fired-record]';

/**
 * A non-blank string, or null. Every payload key is read through this so `''`,
 * numbers, null and objects all degrade the same way.
 * @param {unknown} value
 * @returns {string|null}
 */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Plugin root, for the one config file this module reads. */
const PLUGIN_ROOT_URL = new URL('../../', import.meta.url);

/** Sentinel: the config has not been consulted in this process yet. */
const UNREAD = Symbol('hook-fired-slots-unread');

/**
 * Per-PROCESS memo of the config value. A dispatcher process handles one
 * payload and exits, so this caches at most one read; it is deliberately NOT a
 * cross-process cache, and a config edit takes effect on the next dispatch.
 * @type {readonly string[]|null|typeof UNREAD}
 */
let slotsMemo = UNREAD;

/**
 * Normalise an allowlist candidate. THE ONE PLACE the default-ON rule is
 * decided, so the config path and the `opts.slots` override cannot disagree.
 *
 * Anything that is not an array — absent, `null`, a string, an object, a
 * malformed edit — becomes `null`, which means "record every slot". Inside an
 * array, entries that are not non-blank strings are DROPPED rather than
 * poisoning the list: a blank name matches no slot and would only make the
 * allowlist look longer than it is.
 *
 * @param {unknown} value
 * @returns {readonly string[]|null} null = every slot
 */
function normaliseSlots(value) {
  if (!Array.isArray(value)) return null;
  return Object.freeze(value.filter((entry) => str(entry) !== null));
}

/**
 * The O8-i allowlist in force for this call.
 *
 * PRECEDENCE — explicit `opts.slots` > `artibot.config.json#/ledger/hookFired/
 * slots` > default ON. Mirrors `lib/runtime/event-writer.js#getLedgerSettings`
 * (:217-239), which resolves the sibling `ledger` keys the same way.
 *
 * Passing `opts.slots` is also the documented TEST SEAM for a malformed config
 * value: a non-array override travels the same {@link normaliseSlots} branch
 * the config value does, so a suite can pin "malformed => default ON" without
 * writing to the real config.
 *
 * Never throws. An unreadable or unparsable config yields `null`.
 *
 * @param {{slots?: unknown}} [opts]
 * @returns {readonly string[]|null} null = every slot is recorded
 */
export function readHookFiredSlots(opts = {}) {
  if (opts?.slots !== undefined) return normaliseSlots(opts.slots);
  if (slotsMemo === UNREAD) {
    let raw;
    try {
      const cfg = JSON.parse(readFileSync(new URL('artibot.config.json', PLUGIN_ROOT_URL), 'utf-8'));
      raw = cfg?.ledger?.hookFired?.slots;
    } catch {
      raw = undefined;
    }
    slotsMemo = normaliseSlots(raw);
  }
  return slotsMemo;
}

/**
 * Mission id for the envelope: the payload's when it names a valid one, else
 * the session fallback `M-YYYYMMDD-S<sid8>`. Mirrors
 * `tool-used-record.js#resolveMissionId` exactly — two different fallbacks
 * would scatter one session's rows across two missions.
 *
 * @param {object} payload
 * @param {string|null} sessionId
 * @returns {string|null}
 */
export function resolveMissionId(payload, sessionId) {
  const declared = payload?.mission_id ?? payload?.missionId;
  if (isMissionId(declared)) return declared;
  if (sessionId === null) return null;
  try {
    const id = sessionFallbackMissionId({ sessionId, nowMs: Date.now() });
    return isMissionId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Build the ledger envelope for one dispatch. PURE: no I/O, no append.
 *
 * Returns null — rather than a half-envelope — whenever the inputs cannot
 * produce a row the writer would accept, so the caller has one branch instead
 * of a validation of its own.
 *
 * @param {object} args
 * @param {string} args.slot the dispatcher's EVENT_NAME, e.g. 'PostToolUse'
 * @param {object} args.payload the parsed host payload
 * @param {Array<{name: string, status: string}>} args.results one entry per
 *   spawned handler, exactly what `spawnHook` resolves to; extra keys such as
 *   `stdout` are ignored
 * @param {string} [args.tool] PostToolUse only, from `extractToolName(payload)`
 * @returns {object|null} caller-level envelope, or null when not recordable
 */
export function buildHookFiredEnvelope({ slot, payload, results, tool } = {}) {
  const slotName = str(slot);
  if (slotName === null) return null;
  if (!Array.isArray(results)) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const sessionId = str(payload.session_id) ?? str(payload.sessionId);
  if (sessionId === null) return null;
  const missionId = resolveMissionId(payload, sessionId);
  if (missionId === null) return null;

  // An entry without a usable name is SKIPPED rather than recorded as a blank:
  // the audit matches names against files, and '' matches nothing while still
  // inflating `count`.
  const named = results.filter((r) => str(r?.name) !== null);
  const hooks = named.map((r) => r.name);
  const failed = named.filter((r) => r?.status !== 'ok').map((r) => r.name);

  const envelope = {
    event: HOOK_FIRED_EVENT,
    session_id: sessionId,
    mission_id: missionId,
    source: LEDGER_SOURCE,
    data: {
      slot: slotName,
      hooks,
      failed,
      count: hooks.length,
    },
  };
  // OMITTED, NEVER EMPTY. `validateOptionalEnvelope` rejects an empty-string
  // `action_id`, so a payload carrying neither correlation key still records
  // the dispatch rather than losing the whole row. `tool_use_id` wins over
  // `prompt_id` because a tool slot's row correlates with the tool call; only
  // UserPromptSubmit has a prompt id to fall back to.
  const actionId = str(payload.tool_use_id) ?? str(payload.prompt_id);
  if (actionId !== null) envelope.action_id = actionId;
  const toolName = str(tool);
  if (toolName !== null) envelope.data.tool = toolName;
  return envelope;
}

/**
 * Build and append. NEVER throws, NEVER writes stdout.
 *
 * The O8-i allowlist is consulted AFTER the envelope is built, not before.
 * Order matters for the reason string and nothing else: an unusable call is
 * `not-recordable` whatever the allowlist says, and only a WELL-FORMED row for
 * an unlisted slot is `slot-disabled`. Gating first would relabel every garbage
 * call as `slot-disabled`, because garbage is never on an allowlist. No row is
 * written either way — the append is the last step.
 *
 * @param {object} args see {@link buildHookFiredEnvelope}
 * @param {unknown} [args.slots] TEST-ONLY override of the O8-i allowlist. The
 *   six dispatchers do not pass it; see {@link readHookFiredSlots}.
 * @returns {{ok: true, folded: boolean} | {ok: false, reason: string}}
 *   `folded` true means the row was accepted WITHOUT `failed`/`count`/`tool`.
 */
export function recordHookFired(args) {
  try {
    const envelope = buildHookFiredEnvelope(args || {});
    if (envelope === null) return { ok: false, reason: 'not-recordable' };
    const allowed = readHookFiredSlots({ slots: args?.slots });
    if (allowed !== null && !allowed.includes(envelope.data.slot)) {
      return { ok: false, reason: 'slot-disabled' };
    }
    // FAIL-CLOSED ON A MISSING cwd, like tool-used-record.js#record. Falling
    // back to `process.cwd()` would aim the write at whatever repository the
    // dispatcher happened to be launched from, which is a different project's
    // ledger.
    const cwd = str(args?.payload?.cwd);
    if (cwd === null) return { ok: false, reason: 'no-cwd' };
    const projectRoot = resolveProjectRoot(cwd);
    if (str(projectRoot) === null) return { ok: false, reason: 'no-project-root' };

    const result = appendLedgerEvent(projectRoot, envelope);
    if (result?.ok === true) {
      if (result.folded === true) {
        const dropped = Array.isArray(result.dropped) ? result.dropped.join(',') : '';
        try {
          process.stderr.write(`${ERR_TAG} folded: dropped=${dropped}\n`);
        } catch { /* ignore */ }
      }
      return { ok: true, folded: result.folded === true };
    }
    return { ok: false, reason: String(result?.reason ?? 'append-failed') };
  } catch (err) {
    try {
      process.stderr.write(`${ERR_TAG} ${err?.message || 'record-failed'}\n`);
    } catch { /* ignore */ }
    return { ok: false, reason: err?.message || 'record-failed' };
  }
}
