/**
 * The one place the question gate's verdict becomes a ledger line: the four
 * conditions of `lib/planning/question-gate.js` and their conjunction
 * `required`, recorded as ONE `adr.question_gate_evaluated` event per prompt
 * (SH-18; ARTIBOT-5.0-DESIGN.md §7.3, §48 item #27 "ADR question gate(4조건
 * 기록)" — Shadow row; the four conditions are ADDENDUM-HARDENING.md §18).
 *
 * The emitter is `lib/runtime/middleware/tasks.js#recordMissionCompile` on the
 * UserPromptSubmit path, beside the mission event it already appends (through
 * `tasks.js#recordQuestionGate`); this module is what it calls.
 *
 * ── WHY L5 (2026-09-23, same ruling shape as human-asked-record.js) ─────────
 *  This module appends to the ledger, so it depends on `lib/runtime/ledger.js`.
 *  At L5 that is a SIBLING import. Its other dependency,
 *  `lib/planning/question-gate.js`, is L2 (eslint.config.js, the L2 `files[]`
 *  list registers `lib/planning/**`), and that module's own only edge is
 *  `lib/intent/interpreter.js`, also L2. So every edge points DOWNWARD and the
 *  5-Layer rule (5→4→3→2→1) holds with nothing to work around.
 *
 *  The record does not belong in `lib/planning`: that is L2, and the L2 block
 *  forbids importing the runtime layer, so the ledger call would be an L2 → L5
 *  upward edge. The gate stays pure (its header: "no clock, no filesystem");
 *  the I/O lives here, one layer up, where the writer is a sibling.
 *
 * ── OBSERVE CONTRACT (PRD R-03 "행동 변화 0") ────────────────────────────────
 *  This is RECORDING ONLY. It does not ask a question, does not decide whether
 *  one is asked, does not block, and does not touch stdout or the prompt. No
 *  runtime caller acts on the gate's verdict today — `evaluateQuestionGate`
 *  and `lib/intent/confidence.js` have no caller under lib/, scripts/, hooks/
 *  or bin/ (grep, 2026-09-23) — so there is no decision here for a failed
 *  record to disturb, and enforcement is a later row (CA-15, Canary).
 *  A failed record must stay that way: {@link buildQuestionGateData} returns
 *  `null` instead of throwing and {@link appendQuestionGateEvent} returns a
 *  status string instead of throwing. Neither returns anything a caller
 *  should branch on beyond logging the status.
 *
 * ── THE INTERPRETATION LIMITATION, RECORDED IN THE DATA ─────────────────────
 *  `evaluateConditions` lets an `interpretIntent()` output make conditions 2
 *  (material downstream impact) and 4 (cost of a wrong assumption) true on its
 *  own — an escalating completion expectation (commit or beyond) or a
 *  structural work purpose (design / migrate / release). On the
 *  UserPromptSubmit path NO interpretation exists: nothing under lib/ or
 *  scripts/ calls `interpretIntent`, and no middleware puts one on
 *  `state.context` (grep, 2026-09-23). On that path those two routes are
 *  therefore ALWAYS false, and conditions 2 and 4 can only come from prompt
 *  cues (plus, for 4, the classifier's `factors.risk`).
 *
 *  A reader of the line must be able to tell "false because the prompt had no
 *  cue" from "false because the input that could have made it true was never
 *  supplied". So every line carries `interpretation_present`, and it is a
 *  REQUIRED key: the writer's oversized-line fold keeps only required keys, and
 *  a line that lost the marker would read as a complete evaluation.
 *
 * ── WHY config IS NOT FORWARDED ─────────────────────────────────────────────
 *  `evaluateConditions` honours `config.question_gate.force`, which pins a
 *  condition to a value. This record deliberately does not forward any config:
 *  a pinned value is an operator override, not an observation of the prompt,
 *  and recording it under the same keys would mix the two in the measured
 *  distribution. The key is also unreachable today — no shipped config file
 *  declares `question_gate` (grep over *.json, 2026-09-23), and
 *  `recordMissionCompile` receives no config at all.
 *
 * ── NO IDEMPOTENCY KEY ──────────────────────────────────────────────────────
 *  The line carries no `idempotency_key`. The reader dedupes on
 *  `ledger.js#dedupeKey` (session_id, source, pid, seq, ts), and no reader of
 *  THIS event consumes `idempotency_key` (readers of other events do), so a
 *  key would be decoration. The cost is named:
 *  a re-fired UserPromptSubmit for one prompt writes a second, identical-data
 *  line, exactly as the sibling mission event does.
 *
 * @module lib/runtime/question-gate-record
 */

import { evaluateConditions, GATE_CONDITIONS, requiresQuestion } from '../planning/question-gate.js';
import { appendLedgerEvent } from './ledger.js';

/**
 * The event name. `adr.*` because design §7.3 #27 files the question gate under
 * ADR work and `ADDENDUM-HARDENING.md` names the namespace (`adr.accepted`);
 * V5-BACKLOG SH-18 measures progress as "`adr.*` 이벤트 0". Registered in
 * `schemas/ledger-events.allowlist.json` — the only home of the vocabulary.
 * @type {string}
 */
export const QUESTION_GATE_EVENT = 'adr.question_gate_evaluated';

/**
 * The data key that records whether an `interpretIntent()` output was
 * supplied. See the module header for why it exists.
 * @type {string}
 */
export const INTERPRETATION_PRESENT_KEY = 'interpretation_present';

/**
 * Build the `data` object for one question-gate line.
 *
 * The four condition keys are the gate's own names, read from
 * `GATE_CONDITIONS` rather than copied, so a fifth condition added there
 * appears here too — and is then refused by the allowlist test until the
 * allowlist types it.
 *
 * Pure. Never throws: a throw inside the gate (a hostile `prompt` whose
 * `toString` throws, a getter on `interpretation`) yields `null`, which
 * {@link appendQuestionGateEvent} turns into `skipped:no-data`.
 *
 * @param {object} [input]
 * @param {string} [input.prompt] - Raw user text.
 * @param {object} [input.intent] - `detectIntent()` output (unused by the gate today).
 * @param {object} [input.classification] - `classifyComplexity()` output.
 * @param {object} [input.interpretation] - `interpretIntent()` output, when one exists.
 * @returns {Record<string, boolean>|null}
 */
export function buildQuestionGateData(input = {}) {
  try {
    const { prompt, intent, classification, interpretation } = input ?? {};
    const conditions = evaluateConditions({ prompt, intent, classification, interpretation });
    return {
      ...Object.fromEntries(GATE_CONDITIONS.map((key) => [key, conditions[key] === true])),
      required: requiresQuestion(conditions),
      [INTERPRETATION_PRESENT_KEY]: interpretation !== null && typeof interpretation === 'object',
    };
  } catch {
    return null;
  }
}

/**
 * Append the one question-gate line for this prompt.
 *
 * Mirrors `appendMissionEvent` (`middleware/mission-ledger.js`, split out of
 * `tasks.js` on 2026-09-23): never throws, every refusal becomes a short
 * status string, and the mission and session ids are passed explicitly so this
 * line and the paired mission event name the same mission across a UTC
 * midnight. `identity` is exactly what `resolveMissionIdentity` (same module)
 * returns, taken whole so the root and the ids cannot come from two sources.
 *
 * @param {{projectRoot?: string|null, sessionId?: string|null, missionId?: string|null}} identity
 * @param {Record<string, boolean>|null} data - {@link buildQuestionGateData} output
 * @param {number} nowMs - The single epoch-ms reading for this prompt.
 * @param {{appendLedgerEvent?: Function}} [deps] - Injected writer port (tests).
 * @returns {string} `appended` | `rejected:<reason>` | `skipped:<why>` | `error:<message>`
 */
export function appendQuestionGateEvent(identity, data, nowMs, deps = {}) {
  const { projectRoot = null, sessionId = null, missionId = null } = identity ?? {};
  if (!projectRoot) return 'skipped:no-project-root';
  if (!sessionId || !missionId) return 'skipped:no-session-id';
  if (!data) return 'skipped:no-data';

  const append = deps.appendLedgerEvent ?? appendLedgerEvent;
  try {
    const written = append(projectRoot, {
      event: QUESTION_GATE_EVENT,
      mission_id: missionId,
      session_id: sessionId,
      // Registered `sources: ["hook"]`. The emitter runs inside the
      // UserPromptSubmit hook pipeline, so 'hook' is accurate as well as the
      // only permitted value. A literal on purpose: the hook-emitter scan reads
      // it here to classify this call.
      source: 'hook',
      data,
    }, { now: () => new Date(nowMs) });
    return written?.ok ? 'appended' : `rejected:${written?.reason ?? 'unknown'}`;
  } catch (err) {
    return `error:${err?.message ?? 'append-threw'}`;
  }
}
