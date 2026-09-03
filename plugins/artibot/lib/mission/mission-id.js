/**
 * Substantive-mission judgment and `mission_id` issuance.
 *
 * SUBSTANTIVE IS AN ALLOWLIST, NOT A DENY LIST
 * --------------------------------------------
 * v1.1 04 defined "not substantive" by listing what to exclude (greetings, tiny
 * rewrites, trivial questions, ephemeral work). A deny list passes everything
 * it has not enumerated, which for mission CREATION is fail-open — one greeting
 * variant nobody listed produces a mission folder. Writing a file is the
 * expensive direction to undo, so design §3.1 inverts it: a request is
 * substantive only when at least one of six named signals fires, and an
 * unjudgeable request produces NO mission (the caller records
 * `mission-candidate-deferred` in the ledger instead).
 *
 * TWO-STAGE ISSUANCE (design §3.3)
 * --------------------------------
 *   ① prompt time   — only S3~S6 are measurable; no tool has run yet, so S1/S2
 *                     could only be guessed. A candidate id is computed and
 *                     ZERO files are created.
 *   ② first write tool / explicit command — S1·S2 become facts and the mission
 *                     is promoted.
 * `judgeSubstantive` enforces that split through `stage`: at `stage: 'prompt'`
 * the S1/S2 inputs are IGNORED even when supplied, and the skip is reported.
 *
 * PARENT-SESSION-ONLY ISSUANCE. `/split` opens up to four windows. If each
 * window issued its own `M-YYYYMMDD-NNN`, the counters would collide, so only
 * the parent session issues and workers INHERIT (v1.1 09 §2/§3). This module
 * documents and supports that rule — `inheritMissionId` is the worker's path —
 * but it cannot enforce it: a pure function cannot tell which session called
 * it. The enforcement point is the caller, plus the existing ownership gate
 * (`lib/git/limb-landing-check.js`) that catches a worker writing into
 * `.artibot/missions/**` when that path is absent from `plan.json.affectedPaths`.
 *
 * PURITY (design §1-8, L2): no clock, no filesystem, no randomness. `nowMs` and
 * the counter are inputs; the caller owns the counter's persistence and
 * uniqueness.
 *
 * WHAT THIS MODULE CANNOT SEE
 * ---------------------------
 *  - It does not measure S1/S2. `completion.expected_actions` is an assertion
 *    from the caller; at execution stage the caller is expected to derive it
 *    from an actual tool call, and nothing here verifies that it did.
 *  - It does not detect follow-ups. S6 needs `activeMission` + `followUp` from
 *    a `state.yaml` lookup (design §6.2 puts that above memory in precedence);
 *    passing a remembered mission instead of a looked-up one defeats the rule
 *    and is invisible here.
 *  - Counter uniqueness is the caller's. Two callers passing 7 both get -007.
 *
 * @module lib/mission/mission-id
 */

import { COMPLETION_EXPECTATIONS } from '../intent/interpreter.js';
import { MISSION_ID_PATTERN } from './contract.js';

export { MISSION_ID_PATTERN };

/**
 * Completion expectation vocabulary (design 02, 7 kinds) — RE-EXPORTED, not
 * copied.
 *
 * This module previously carried its own array with `'pr'` lowercased while the
 * canon and `lib/intent/interpreter.js` both say `'PR'`. A duplicated
 * vocabulary drifts silently the moment one side is edited, and the case
 * mismatch made a caller's `'PR'` fail a subset test that looked correct. The
 * single source is `interpreter.js#COMPLETION_EXPECTATIONS`, which transcribes
 * the canon verbatim; `lib/planning/question-gate.js:40` already imports from
 * there, so this follows the established direction.
 *
 * Layer-safe: both modules are L2, and `interpreter.js` imports nothing at all
 * (measured 2026-09-03), so this edge cannot close a cycle.
 *
 * `tests/mission/mission-id.test.js` asserts REFERENCE identity, not value
 * equality — a future re-introduced copy with identical contents would still
 * fail there.
 */
export const COMPLETION_ACTIONS = COMPLETION_EXPECTATIONS;

/** The six substantive signals (design §3.1). */
export const SUBSTANTIVE_SIGNALS = Object.freeze({
  S1: 'completion expectation includes a repository write',
  S2: 'completion expectation includes commit, PR, or deploy',
  S3: 'explicit_requests has 2 or more entries',
  S4: 'intent_confidence.product_decision_required is true',
  S5: 'explicit /plan /ultraplan /split /autopilot /implement invocation',
  S6: 'follow-up touching an existing mission\'s intent_revision',
});

/** Signals measurable at prompt time (design §3.3 stage ①). */
export const PROMPT_STAGE_SIGNALS = Object.freeze(['S3', 'S4', 'S5', 'S6']);

/** Signals that only become facts once a tool runs (stage ②). */
export const EXECUTION_STAGE_SIGNALS = Object.freeze(['S1', 'S2']);

/**
 * Completion actions that write to the repository → S1.
 * Spelled verbatim from {@link COMPLETION_ACTIONS}; a subset test fails if an
 * entry here ever stops being a member of the canonical seven.
 */
export const S1_WRITE_ACTIONS = Object.freeze(['artifact', 'implement', 'test']);

/** Completion actions that ship → S2. Verbatim members of the canonical seven. */
export const S2_SHIP_ACTIONS = Object.freeze(['commit', 'PR', 'deploy']);

/**
 * Case-insensitive lookup: lowercased action → its canonical spelling.
 *
 * Callers write `'PR'` or `'pr'` depending on where the value came from, and a
 * case-sensitive `includes()` silently dropped one of them. Matching folds
 * case; REPORTING uses the canonical spelling, so `details.S2` always shows the
 * canon's `'PR'` regardless of what the caller typed.
 */
function canonicalLookup(list) {
  return new Map(list.map((action) => [action.toLowerCase(), action]));
}

const S1_LOOKUP = canonicalLookup(S1_WRITE_ACTIONS);
const S2_LOOKUP = canonicalLookup(S2_SHIP_ACTIONS);

/** Slash commands whose explicit invocation is signal S5. */
export const S5_COMMANDS = Object.freeze([
  'plan', 'ultraplan', 'split', 'autopilot', 'implement',
]);

/**
 * Detect a leading slash command in a prompt.
 *
 * SINGLE DEFINITION. This export is the only `detectSlashCommand` in the repo
 * (measured 2026-09-03). `scripts/hooks/runtime-prompt.js:35` imports it; the
 * byte-identical module-private copy that file used to carry was removed by
 * T-50 #10, so there is no longer a second implementation to keep in step.
 *
 * Callers that have already computed the command should still pass it as
 * `slashCommand` into {@link judgeSubstantive} rather than have it recomputed
 * here — same answer either way, one less pass over the prompt.
 *
 * @param {string} prompt
 * @returns {string|null} Lowercased command name, or null.
 */
export function detectSlashCommand(prompt) {
  const trimmed = String(prompt || '').trimStart();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.slice(1).match(/^([a-z][a-z0-9_-]{0,31})(?=\s|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function normalizeActions(completion) {
  const list = completion?.expected_actions;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => typeof a === 'string')
    .map((a) => a.trim().toLowerCase());
}

/**
 * Judge whether a request is substantive.
 *
 * @param {object} input
 * @param {'prompt'|'execution'} [input.stage='prompt'] - Which signals may fire.
 *   Defaults to the conservative stage.
 * @param {Array} [input.explicitRequests] - The compiled `explicit_requests`.
 * @param {object} [input.intentConfidence] - The compiled `intent_confidence`.
 * @param {object} [input.completion] - `{expected_actions: string[]}`.
 * @param {string} [input.prompt] - Raw prompt; used only if `slashCommand` is absent.
 * @param {string|null} [input.slashCommand] - Pre-detected command name.
 * @param {object|null} [input.activeMission] - `{mission_id, intent_revision}` from state.
 * @param {boolean} [input.followUp=false] - Caller asserts this continues `activeMission`.
 * @returns {{
 *   substantive: boolean,
 *   signals: string[],
 *   deferred: boolean,
 *   stage: string,
 *   evaluated: string[],
 *   skipped: {signal: string, reason: string}[],
 *   details: Record<string, string>
 * }}
 * @throws {TypeError} on an unknown stage — fail-closed.
 */
export function judgeSubstantive(input = {}) {
  const stage = input.stage ?? 'prompt';
  if (stage !== 'prompt' && stage !== 'execution') {
    throw new TypeError(`judgeSubstantive: unknown stage "${stage}" (prompt|execution)`);
  }

  const evaluated = stage === 'prompt'
    ? [...PROMPT_STAGE_SIGNALS]
    : [...EXECUTION_STAGE_SIGNALS, ...PROMPT_STAGE_SIGNALS];
  const skipped = [];
  if (stage === 'prompt') {
    for (const s of EXECUTION_STAGE_SIGNALS) {
      skipped.push({
        signal: s,
        reason: 'not measurable before any tool has run (design §3.3 stage ①)',
      });
    }
  }

  const signals = [];
  const details = {};
  const actions = normalizeActions(input.completion);

  if (evaluated.includes('S1')) {
    const hit = actions.filter((a) => S1_LOOKUP.has(a)).map((a) => S1_LOOKUP.get(a));
    if (hit.length > 0) {
      signals.push('S1');
      details.S1 = `repository-write action(s): ${hit.join(', ')}`;
    }
  }
  if (evaluated.includes('S2')) {
    const hit = actions.filter((a) => S2_LOOKUP.has(a)).map((a) => S2_LOOKUP.get(a));
    if (hit.length > 0) {
      signals.push('S2');
      details.S2 = `ship action(s): ${hit.join(', ')}`;
    }
  }

  const requests = Array.isArray(input.explicitRequests) ? input.explicitRequests : [];
  if (requests.length >= 2) {
    signals.push('S3');
    details.S3 = `${requests.length} explicit requests`;
  }

  if (input.intentConfidence?.product_decision_required === true) {
    signals.push('S4');
    details.S4 = 'product_decision_required is true';
  }

  const command = input.slashCommand !== undefined && input.slashCommand !== null
    ? String(input.slashCommand).toLowerCase()
    : detectSlashCommand(input.prompt);
  if (command && S5_COMMANDS.includes(command)) {
    signals.push('S5');
    details.S5 = `/${command}`;
  }

  const active = input.activeMission;
  if (input.followUp === true
    && active
    && typeof active.mission_id === 'string'
    && MISSION_ID_PATTERN.test(active.mission_id)) {
    signals.push('S6');
    details.S6 = `follow-up to ${active.mission_id}`
      + (Number.isInteger(active.intent_revision) ? ` r${active.intent_revision}` : '');
  }

  const substantive = signals.length > 0;
  return { substantive, signals, deferred: !substantive, stage, evaluated, skipped, details };
}

/**
 * Format the date half of a mission id.
 *
 * UTC on purpose: a pure function must be deterministic, and a local-time
 * conversion would make the same `nowMs` produce different ids on two machines.
 * A caller that needs a local calendar day passes `date` directly.
 *
 * @param {number} nowMs - Epoch milliseconds.
 * @returns {string} `YYYYMMDD`
 * @throws {TypeError} when `nowMs` is not a finite number.
 */
export function formatMissionDate(nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError('formatMissionDate: nowMs must be a finite number (epoch ms)');
  }
  const d = new Date(nowMs);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function resolveDate({ date, nowMs }) {
  if (date !== undefined) {
    if (typeof date !== 'string' || !/^[0-9]{8}$/.test(date)) {
      throw new TypeError('mission-id: date must be a YYYYMMDD string');
    }
    return date;
  }
  return formatMissionDate(nowMs);
}

/**
 * Issue a mission id `M-YYYYMMDD-NNN`.
 *
 * The counter is supplied by the caller — this function does not read, write,
 * or remember one. Only the PARENT session should call this; `/split` workers
 * call `inheritMissionId` instead (see the module header).
 *
 * The counter is zero-padded to three digits and may run PAST three: the
 * schema pattern is `\d{3,}`, widened so a busy day cannot overflow the id
 * space. There is therefore no upper bound to clamp against — a clamped
 * counter would collide with a real id, which is worse than a long one.
 *
 * @param {object} input
 * @param {number} input.counter - The caller's per-day sequence, an integer >= 1.
 * @param {number} [input.nowMs] - Epoch ms; required unless `date` is given.
 * @param {string} [input.date] - `YYYYMMDD` override for a local calendar day.
 * @returns {string}
 * @throws {TypeError} on a non-integer or non-positive counter — fail-closed.
 */
export function issueMissionId(input = {}) {
  const { counter } = input;
  if (!Number.isInteger(counter) || counter < 1) {
    throw new TypeError(
      `issueMissionId: counter must be an integer >= 1 (got ${JSON.stringify(counter)})`,
    );
  }
  const datePart = resolveDate(input);
  return `M-${datePart}-${String(counter).padStart(3, '0')}`;
}

/**
 * Build the session fallback id `M-YYYYMMDD-S<sid8>`.
 *
 * Non-substantive interactions still emit ledger envelopes, and the envelope
 * schema (T-17) requires `mission_id`. Rather than leaving the field empty or
 * inventing a mission, the session supplies one derived from its own id, so a
 * deferred candidate stays traceable without a mission folder ever existing.
 *
 * `sid8` is the FIRST 8 alphanumeric characters of `sessionId`, in order.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {number} [input.nowMs]
 * @param {string} [input.date] - `YYYYMMDD` override.
 * @returns {string}
 * @throws {TypeError} when `sessionId` yields fewer than 8 alphanumerics.
 *   Padding would fabricate identity, so this fails closed instead.
 */
export function sessionFallbackMissionId(input = {}) {
  const raw = String(input.sessionId ?? '');
  const alnum = raw.replace(/[^0-9A-Za-z]/g, '');
  if (alnum.length < 8) {
    throw new TypeError(
      'sessionFallbackMissionId: sessionId must contain at least 8 alphanumeric'
      + ` characters (got ${alnum.length} from ${JSON.stringify(raw)})`,
    );
  }
  const datePart = resolveDate(input);
  return `M-${datePart}-S${alnum.slice(0, 8)}`;
}

/**
 * Validate a mission id against the schema pattern.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMissionId(value) {
  return typeof value === 'string' && MISSION_ID_PATTERN.test(value);
}

/**
 * The worker path: take the parent's mission id unchanged.
 *
 * Exists so "worker inherits" is a call in the code rather than a convention
 * in a document — a worker that reaches for `issueMissionId` is then visibly
 * doing something else.
 *
 * @param {string} parentMissionId
 * @returns {string}
 * @throws {TypeError} when the parent id is malformed.
 */
export function inheritMissionId(parentMissionId) {
  if (!isMissionId(parentMissionId)) {
    throw new TypeError(
      `inheritMissionId: malformed parent mission id ${JSON.stringify(parentMissionId)}`,
    );
  }
  return parentMissionId;
}
