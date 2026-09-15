#!/usr/bin/env node
/**
 * PostToolUse(`Skill`) — the `tool.used` WRITER, and the first one there has
 * ever been.
 *
 * WHY THIS FILE EXISTS. `tool.used` has been a REGISTERED EVENT WITH NO
 * EMITTER. Measured 2026-09-15 ~10:5x KST: the live ledger held 0 `tool.used`
 * rows out of 1,052 lines, and `grep -rn "tool\.used" lib scripts` returned
 * nothing but readers and comments. `lib/replay/existence-audit.js` therefore
 * reported `unmeasured` for the `skills` kind — its own `CARRIER_NOTES.skills`
 * said the field did not exist — so the CLAUDE.md Existence Audit rule ("소비처
 * 0 + 발화 0 이 2릴리스 연속이면 제거 후보") could not be evaluated for any
 * skill at all. A silence nobody was listening for is not evidence of disuse,
 * which is exactly why nothing was allowed to be deleted for it. This hook
 * makes the sound audible: one ledger line per Skill tool call, carrying the
 * skill name, so `CARRIERS.skills = { event: 'tool.used', field: 'skill' }`
 * starts returning numbers.
 *
 * THE SHAPE, AND THE TWO DECISIONS INSIDE IT (owner, 2026-09-15, W11-Q3 (a)):
 *
 *   { event:'tool.used', session_id, mission_id, action_id:<tool_use_id>,
 *     source:'hook',
 *     data:{ tool:'Skill', ok, duration_ms, skill:<name> } }
 *
 * THE HOST FACTS BELOW ARE ONE FROZEN LIVE PROBE, cited rather than restated:
 * `tests/hooks/fixtures/host-payloads/PostToolUse.Skill.json` — host 2.1.272,
 * captured 2026-09-15 11:05-11:19 KST, 2 PostToolUse Skill rows (4 rows
 * counting PreToolUse). Two rows is a key-NAME measurement, not a
 * distribution: it says these keys exist, never how often a value varies.
 *
 *   ① AN UNKNOWN SKILL OMITS THE KEY — it never writes `null` or `''`. The
 *      allowlist declares `fields.skill.type = "string"` for `tool.used`
 *      (`schemas/ledger-events.allowlist.json`, event `tool.used`) and
 *      `lib/runtime/ledger-schema.js#matchesType` refuses null for a string
 *      type, so either placeholder turns the whole row into a
 *      `type-violation:skill` REJECTION. Omitting keeps the row — the firing
 *      is still counted, only its name is missing, which is the honest record.
 *   ② `duration_ms` IS THE HOST'S NUMBER, and null only when there isn't one.
 *      The limb brief specified a fixed null on the premise that "the host
 *      gives no duration". THAT PREMISE IS FALSE, and the correction is
 *      measured: `tests/hooks/fixtures/host-payloads/PostToolUse.Skill.json`
 *      (host 2.1.272, live probe 2026-09-15 11:05-11:10 KST) records
 *      `duration_ms` as a TOP-LEVEL PostToolUse key of JSON type number on 2/2
 *      rows — not nested in `tool_response`. The key is in the allowlist's
 *      `required`, so it must always be PRESENT; null is what it holds when
 *      the host sends nothing usable, which is a different statement from a
 *      fabricated `0`. No `fields` type is declared for it, so null passes the
 *      contract layer.
 *
 * `ok` IS THE HOST'S BOOLEAN WHENEVER THERE IS ONE. The live fixture carries
 * `tool_response` for Skill as `{allowedTools, commandName, success}` with
 * `success` a boolean on 2/2 rows, so the key is measured and is read. Only
 * its `false` VALUE is unobserved — a different fact from an unobserved key,
 * and not a reason to discard the field: a hardcoded true would write a
 * FALSELY SUCCESSFUL row the day a failure arrives, which is the mirror image
 * of inventing a measurement.
 *
 * ABSENT OR NON-BOOLEAN DEFAULTS TO TRUE, because PostToolUse is the success
 * slot and a failing call may instead divert to PostToolUseFailure (a
 * different slot, not wired here). "The host said nothing about failure" must
 * not be spelled like "the host reported a failure". Until a failing Skill
 * call is actually measured, a failure RATE taken from these rows still has no
 * trustworthy denominator.
 *
 * MUTE, LIKE EVERY DISPATCHED HOOK. `_posttooluse-dispatcher.js` MERGES the
 * stdout of every child it spawns (`mergeResults`), so anything printed here
 * becomes hook output the host acts on. Nothing is ever written to stdout —
 * this module does not import `writeStdout` at all. Errors go to stderr under
 * `[artibot:tool-used-record]`, `process.exitCode` is pinned to 0, and `main()`
 * cannot throw.
 *
 * `tool_name !== 'Skill'` RETURNS ON THE FIRST CHECK. The dispatch-table row
 * already routes only `Skill` here (`hooks/dispatch-table.json`, PostToolUse
 * slot), so this second guard is what makes a mis-scoped route cost nothing —
 * the same defence-in-depth `route-observe-pre.js` uses for `Agent`.
 *
 * WHAT THIS HOOK CANNOT SEE (rules §9 — write it next to the gate):
 *   - WHETHER `tool_input.skill` SURVIVES THE NEXT HOST. It is a MEASURED key
 *     on host 2.1.272 — present on 4/4 Skill rows (2 PreToolUse + 2
 *     PostToolUse) in `tests/hooks/fixtures/host-payloads/PostToolUse.Skill.json`
 *     — and not a contract the host owes anyone. The read stays defensive, so
 *     a renamed key yields rows with no `skill`, never a rejected row and
 *     never a crash; a fixture diff is how that would be noticed. Note the
 *     sibling key `tool_input.args` is present only when the caller passed
 *     arguments (1/2 scenarios) and is deliberately not recorded — the
 *     allowlist declares no field for it, and arguments are payload, not
 *     identity.
 *   - A ROW THAT LOST ITS `skill` TO THE BYTE CAP. Over 4,096 B
 *     (`artibot.config.json#/ledger/maxLineBytes`) the writer FOLDS rather
 *     than rejects: `event-writer.js#foldOversized` keeps only the allowlist's
 *     `required` keys — `tool`, `ok`, `duration_ms` — drops `skill`, and the
 *     line is ACCEPTED. The audit then counts that firing as `absent`, not as
 *     a rejection, so a fold is invisible in the ledger's own error stream.
 *     `record()` writes one stderr line when it happens; nothing else can see
 *     it. A 303 B typical line makes this remote, not impossible.
 *   - SKILL ACTIVATIONS THAT NEVER GO THROUGH THE `Skill` TOOL. Native
 *     description-matched activation (CLAUDE.md, "Auto-invoke Principle") loads
 *     a skill without a tool call, and produces no row. A `fired: 0` here means
 *     "never invoked through the tool", not "never used".
 *   - WHETHER THE SKILL DID ANY GOOD. This records an invocation.
 *
 * @module scripts/hooks/tool-used-record
 */

import { parseJSON, readStdin } from '../utils/index.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { isMissionId, sessionFallbackMissionId } from '../../lib/mission/mission-id.js';
import { isMainEntry } from './_main-entry.js';

/** The one tool this hook answers to. Compared with `===`, never a prefix. */
export const SKILL_TOOL = 'Skill';

/** The registered event this hook writes. */
export const TOOL_USED_EVENT = 'tool.used';

/**
 * Envelope `source` — who emitted the line. `tool.used`'s allowlist entry
 * permits `hook` and nothing else.
 * @type {string}
 */
const LEDGER_SOURCE = 'hook';

/** stderr label. The only channel this module may speak on. */
const ERR_TAG = '[artibot:tool-used-record]';

/**
 * A non-blank string, or null. Every payload key is read through this so `''`,
 * numbers, null and objects all degrade the same way.
 * @param {unknown} value
 * @returns {string|null}
 */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The host's own measurement of how long the tool call took, or null when it
 * did not give one. Zero is a VALUE here, not an absence.
 *
 * Negative is refused rather than recorded: a duration cannot be negative, so
 * one would be a host or transport defect, and null ("not measured") is the
 * honest record of a number that cannot mean what it says.
 *
 * @param {unknown} value `payload.duration_ms`
 * @returns {number|null}
 */
function durationMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The host's verdict on the call: its own boolean when it sent one, else true.
 *
 * THE KEY IS MEASURED; ONLY THE FALSE VALUE IS NOT. `tool_response.success` is
 * a boolean on 2/2 PostToolUse Skill rows in the live fixture, so this is not
 * a field nobody has seen — what nobody has seen is a `false` in it. Those are
 * different facts, and ignoring a present key because one of its two values is
 * unobserved would write a TRUE row on the day a failure arrives. That is the
 * mirror image of inventing a measurement, and just as wrong.
 *
 * The default is true because PostToolUse is the success slot: an absent or
 * non-boolean `success` means the host said nothing about failure, which is
 * not the same statement as a failure and must not be spelled like one.
 *
 * @param {unknown} toolResponse `payload.tool_response`
 * @returns {boolean}
 */
function okFlag(toolResponse) {
  const success = toolResponse?.success;
  return typeof success === 'boolean' ? success : true;
}

/**
 * Mission id for the envelope: the payload's when it names a valid one, else
 * the session fallback `M-YYYYMMDD-S<sid8>`. Mirrors
 * `route-observe-pre.js#resolveMissionId` exactly — two different fallbacks
 * would scatter one session's rows across two missions.
 *
 * @param {object} hookData
 * @param {string|null} sessionId
 * @returns {string|null}
 */
export function resolveMissionId(hookData, sessionId) {
  const declared = hookData?.mission_id ?? hookData?.missionId;
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
 * Build the ledger envelope for one Skill tool call. PURE: no I/O, no append.
 *
 * Returns null — rather than a half-envelope — whenever the payload cannot
 * produce a row the writer would accept, so the caller has one branch instead
 * of a validation of its own.
 *
 * @param {object|null|undefined} hookData parsed PostToolUse payload
 * @returns {object|null} caller-level envelope, or null when not recordable
 */
export function buildToolUsedEnvelope(hookData) {
  if (!hookData || typeof hookData !== 'object' || Array.isArray(hookData)) return null;
  // `tool` is the legacy alias; tool-tracker.js reads both and so does this.
  const toolName = str(hookData.tool_name) ?? str(hookData.tool);
  if (toolName !== SKILL_TOOL) return null;

  const sessionId = str(hookData.session_id) ?? str(hookData.sessionId);
  if (sessionId === null) return null;
  const missionId = resolveMissionId(hookData, sessionId);
  if (missionId === null) return null;

  const envelope = {
    event: TOOL_USED_EVENT,
    session_id: sessionId,
    mission_id: missionId,
    source: LEDGER_SOURCE,
    data: {
      tool: SKILL_TOOL,
      ok: okFlag(hookData.tool_response),
      duration_ms: durationMs(hookData.duration_ms),
    },
  };
  // OMITTED, NEVER EMPTY. `validateOptionalEnvelope` rejects an empty-string
  // `action_id`, so a payload without a tool_use_id still records the firing
  // rather than losing the whole row to a correlation key it never had.
  const actionId = str(hookData.tool_use_id);
  if (actionId !== null) envelope.action_id = actionId;
  const skill = str(hookData.tool_input?.skill);
  if (skill !== null) envelope.data.skill = skill.trim();
  return envelope;
}

/**
 * Build and append. Separated from {@link main} so the whole decision path is
 * reachable without a spawn or a stdin.
 *
 * @param {object|null|undefined} hookData
 * @returns {{ok: true, folded: boolean} | {ok: false, reason: string}}
 *   `folded` true means the row was accepted WITHOUT its `skill` key.
 */
export function record(hookData) {
  const envelope = buildToolUsedEnvelope(hookData);
  if (envelope === null) return { ok: false, reason: 'not-recordable' };
  // FAIL-CLOSED ON A MISSING cwd, like route-observe-pre.js:303-306. Falling
  // back to `process.cwd()` would aim the write at whatever repository the
  // dispatcher happened to be launched from, which is a different project's
  // ledger.
  const cwd = str(hookData.cwd);
  if (cwd === null) return { ok: false, reason: 'no-cwd' };
  const projectRoot = resolveProjectRoot(cwd);
  if (str(projectRoot) === null) return { ok: false, reason: 'no-project-root' };

  const result = appendLedgerEvent(projectRoot, envelope);
  if (result?.ok === true) {
    // A FOLD IS AN ACCEPTED ROW THAT LOST ITS SKILL NAME. `writeEvent` returns
    // `{folded, dropped}` on success, and stderr is the only channel a
    // dispatched hook has — stdout stays at 0 bytes. Without this line the
    // loss is indistinguishable from a call that named no skill.
    if (result.folded === true) {
      const dropped = Array.isArray(result.dropped) ? result.dropped.join(',') : '';
      try {
        process.stderr.write(`${ERR_TAG} folded: dropped=${dropped}\n`);
      } catch { /* ignore */ }
    }
    return { ok: true, folded: result.folded === true };
  }
  return { ok: false, reason: String(result?.reason ?? 'append-failed') };
}

/**
 * Hook entry. Reads stdin, records, and returns — no stdout, no non-zero exit,
 * no throw, under every input.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function main() {
  process.exitCode = 0;
  try {
    // parseJSON returns null on malformed input; buildToolUsedEnvelope then
    // falls out at its first check. Non-JSON stdin is a no-op, not an error.
    return record(parseJSON(await readStdin()));
  } catch (err) {
    try { process.stderr.write(`${ERR_TAG} ${err?.message || 'main-failed'}\n`); } catch { /* ignore */ }
    return { ok: false, reason: err?.message || 'main-failed' };
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// The extra `.catch` is redundant with main()'s own try/catch by design — one
// guarantee with two independent implementations is cheaper than one skill
// invocation lost to an unhandled rejection.
if (isMainEntry(import.meta.url)) {
  main().catch(() => { process.exitCode = 0; });
}
