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
 *  This module is RECORDING ONLY. It does not ask a question, does not decide
 *  whether one is asked, does not block, and does not touch stdout or the
 *  prompt. Enforcement (CA-15) lives in the CALLER, behind the
 *  `runtime.questionGate.enforce` kill switch (default off):
 *  `tasks.js#recordQuestionGate` returns the {@link buildQuestionGateData}
 *  object it recorded, and with the switch on `tasks.js` hands that same
 *  object to `question-gate.js#decideQuestionGateEnforcement` and, when it
 *  blocks, appends an ADVISORY directive to the prompt. Nothing about the
 *  decision is written back here or to the ledger.
 *  A failed record must stay that way: {@link buildQuestionGateData} returns
 *  `null` instead of throwing and {@link appendQuestionGateEvent} returns a
 *  status string instead of throwing. A `null` or a failure status is only
 *  logged; the one thing a caller branches on is a recorded data object.
 *
 * ── THE INTERPRETATION INPUT, RECORDED IN THE DATA ──────────────────────────
 *  `evaluateConditions` lets an `interpretIntent()` output make conditions 2
 *  (material downstream impact) and 4 (cost of a wrong assumption) true on its
 *  own — an escalating completion expectation (commit or beyond) or a
 *  structural work purpose (design / migrate / release). Condition 4 also reads
 *  the classifier: `factors.risk >= 0.5` makes it true.
 *
 *  HISTORY, kept because it explains every row written before CA-15. On the
 *  UserPromptSubmit path NO interpretation existed: nothing under lib/ or
 *  scripts/ called `interpretIntent`, and no middleware put one on
 *  `state.context` (grep, 2026-09-23). Nor did the classification arrive: the
 *  caller read `state.context.routing.classification`, but `router.js` spreads
 *  the classification INTO `routing`, so that key was always undefined
 *  (measured 2026-09-29 on the real router: a prompt with `factors.risk` 0.6
 *  recorded condition 4 false, and every row said `interpretation_present:
 *  false`). Those rows can read conditions 2 and 4 from prompt cues alone.
 *
 *  NOW (CA-15, 2026-09-29). `tasks.js#recordQuestionGate` makes ONE
 *  `interpretIntent({ prompt, intent, classification })` call per prompt (an
 *  L5 -> L2 edge, so downward) and reads the classification from `routing`
 *  itself. The call lives in the caller, not here: this module stays a
 *  recorder that takes what it is handed. For a reader of the ledger that means
 *  conditions 2 and 4 are true on prompts they were false on before, so rows
 *  before and after that change are NOT comparable (the SH-18 distribution
 *  shifts at that SHA), and `interpretation_present` is true on every row whose
 *  interpretation was produced.
 *
 *  A reader of the line must still be able to tell "false because the prompt had
 *  no cue" from "false because the input that could have made it true was never
 *  supplied". So every line carries `interpretation_present`, and it is a
 *  REQUIRED key: the writer's oversized-line fold keeps only required keys, and
 *  a line that lost the marker would read as a complete evaluation. It is now
 *  false only when no interpretation reached the recorder, which on the
 *  UserPromptSubmit path means `tasks.js#interpretForGate` caught a throw.
 *
 * ── THE INTERPRETATION STATUS (CA-15 follow-up b) ───────────────────────────
 *  `interpretation_present:false` alone cannot tell three things apart: a row
 *  written before CA-15 (nothing ever supplied an interpretation, and there is
 *  no other key to say so), a row written after it where `interpretIntent()`
 *  THREW, and a caller that simply supplied none. The first two were separable
 *  only by `ts` against the CA-15 landing, which no reader should have to
 *  carry. So every line now also carries `interpretation_status`, a closed
 *  vocabulary ({@link INTERPRETATION_STATUSES}: `ok` | `threw` | `absent`) and
 *  a REQUIRED key for the same reason as the marker: a row that lost it would
 *  read as one written before this change. A row from before this change has NO
 *  such key at all, and that absence is what marks it. That is wider than
 *  "before CA-15": the CA-15 input fold (b6a152cf) already shipped in v4.69.0, so
 *  an install of that release wrote rows that carry a real interpretation
 *  (`interpretation_present:true`) or a throw (`false`) and still have no status
 *  key. A throw from that stretch and a row from before CA-15 both read `false`
 *  without the key, so telling them apart still takes `ts` against the CA-15
 *  landing. `threw` is reported by the caller (`input.interpretationThrew`),
 *  because only the caller can see the throw; the recorder maps the fact onto
 *  the vocabulary and never sees the error. `interpretation_present` is kept as
 *  it was (readers of SH-18 and the Q2-O1 flip criteria count it), and is true
 *  exactly when the status is `ok`.
 *
 * ── WHY config IS NOT FORWARDED ─────────────────────────────────────────────
 *  `evaluateConditions` honours `config.question_gate.force`, which pins a
 *  condition to a value. This record deliberately does not forward any config:
 *  a pinned value is an operator override, not an observation of the prompt,
 *  and recording it under the same keys would mix the two in the measured
 *  distribution. The key is also unreachable today — no shipped config file
 *  declares `question_gate` (grep over *.json, 2026-09-23). Since CA-15
 *  `recordMissionCompile` receives ONE config-derived value, the enforce
 *  switch boolean, and it goes to the enforcement decision, not here.
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
 * The data key that says WHY an interpretation was or was not part of this
 * evaluation. See the module header ("THE INTERPRETATION STATUS").
 * @type {string}
 */
export const INTERPRETATION_STATUS_KEY = 'interpretation_status';

const STATUS_OK = 'ok';
const STATUS_THREW = 'threw';
const STATUS_ABSENT = 'absent';

/**
 * The closed vocabulary of {@link INTERPRETATION_STATUS_KEY}: `ok` (an
 * interpretation was supplied), `threw` (the caller's `interpretIntent()` call
 * threw, so none exists), `absent` (none was supplied and nothing threw).
 * `schemas/ledger-events.allowlist.json#/enums/interpretation_status` is the
 * home of the vocabulary on disk; `tests/runtime/question-gate-record.test.js`
 * pins the two equal, the way `human-asked-record.js` pins its `kind` enum.
 * @type {readonly string[]}
 */
export const INTERPRETATION_STATUSES = Object.freeze([STATUS_OK, STATUS_THREW, STATUS_ABSENT]);

/**
 * Map what the caller reported onto {@link INTERPRETATION_STATUSES}.
 *
 * Allowlist-shaped on purpose: `ok` needs a supplied interpretation object,
 * `threw` needs the boolean `true` (a truthy look-alike such as `'true'` or `1`
 * is not a throw report) and no interpretation, and everything else is
 * `absent`. A supplied interpretation outranks a throw report, so
 * `interpretation_present` is true exactly when the status is `ok`.
 *
 * @param {boolean} supplied - an interpretation object was supplied
 * @param {unknown} threw - the caller's report that its interpreter call threw
 * @returns {string}
 */
function interpretationStatusOf(supplied, threw) {
  if (supplied) return STATUS_OK;
  return threw === true ? STATUS_THREW : STATUS_ABSENT;
}

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
 * @param {boolean} [input.interpretationThrew] - the caller's `interpretIntent()`
 *   call threw, so no interpretation exists; only the boolean `true` counts.
 * @returns {Record<string, boolean|string>|null}
 */
export function buildQuestionGateData(input = {}) {
  try {
    const { prompt, intent, classification, interpretation, interpretationThrew } = input ?? {};
    const conditions = evaluateConditions({ prompt, intent, classification, interpretation });
    const supplied = interpretation !== null && typeof interpretation === 'object';
    return {
      ...Object.fromEntries(GATE_CONDITIONS.map((key) => [key, conditions[key] === true])),
      required: requiresQuestion(conditions),
      [INTERPRETATION_PRESENT_KEY]: supplied,
      [INTERPRETATION_STATUS_KEY]: interpretationStatusOf(supplied, interpretationThrew),
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
 * @param {Record<string, boolean|string>|null} data - {@link buildQuestionGateData} output
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
