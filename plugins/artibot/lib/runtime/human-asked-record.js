/**
 * The one place a blocked tool call becomes a `human.asked` ledger line — and,
 * since T-40, the one place a person's answer becomes the `human.resolved` line
 * that closes it.
 *
 * Extracted from `scripts/hooks/pre-bash.js` (T-39) so Bash and the write-side
 * hooks record the same shape through the same code instead of two copies that
 * drift. The contract sections below moved here verbatim with it — this module
 * is now their single home, and the hooks carry a pointer rather than a copy.
 *
 * ── WHY L5 (2026-09-05 leader ruling) ───────────────────────────────────────
 *  This module appends to the ledger, so it depends on `lib/runtime/ledger.js`.
 *  At L5 that is a SIBLING import, and its other two dependencies —
 *  `lib/security/human-gates.js` and `lib/git/project-root.js` — are both L2,
 *  so every edge points DOWNWARD and the 5-Layer rule (5→4→3→2→1) holds with
 *  nothing to work around.
 *
 *  The T-39 brief first placed this file at `lib/security/human-asked-record.js`.
 *  That was REJECTED on 2026-09-05: `lib/security` is registered at L2
 *  (eslint.config.js, the L2 `files[]` list) and the L2 block forbids importing
 *  the runtime layer, so the ledger call would have been an L2 → L5 upward
 *  call — exactly the edge design §1-8 names when it requires such calls to
 *  arrive as injected ports. Moving the module is the remedy the L2 block's own
 *  comment prescribes ("the correct move is to move the module, not to
 *  re-register the directory"), and it is available here precisely because this
 *  file has no reason to live below the layer it writes to.
 *
 * ── THIS MODULE DOES NOT DECIDE ANYTHING ────────────────────────────────────
 *  `recordHumanAsked` records; it never blocks, never lifts a block, and never
 *  returns a value a caller could branch on. CALLERS MUST INVOKE IT AFTER
 *  `writeStdout`, so the decision is already on the wire before any bookkeeping
 *  runs and cannot be delayed, reordered, or altered by it.
 *
 * ── OBSERVE CONTRACT (PRD R-03 "행동 변화 0") ────────────────────────────────
 *  This is RECORDING ONLY. It creates no new block, lifts no existing one, and
 *  does not touch the bytes on stdout: `decision` and `reason` are produced
 *  exactly where and how they were before.
 *  `tests/firewall/hook-decision-invariance.test.js` fixes that as a
 *  measurement — identical stdout bytes whether the ledger lands, fails, or is
 *  never attempted.
 *
 *  The approve path records NOTHING. Observe is scoped to the block points
 *  (design §3.5 OD-5); an event on every approved call would be a different
 *  feature with a different volume profile.
 *
 * ── WHY THE APPEND CANNOT TAKE THE HOOK DOWN ────────────────────────────────
 *  The ledger modules are loaded with `await import()` inside a try/catch, not
 *  as top-level imports. A top-level import that failed to resolve would kill
 *  the hook process before it could write ANY decision — the hook would emit
 *  nothing at all, which is worse than fail-closed. `appendLedgerEvent`
 *  additionally never throws by contract (lib/runtime/ledger.js), so the catch
 *  here covers the resolution failure and anything a future refactor adds.
 *  `node:crypto` is the only static import for the same reason: it is a Node
 *  builtin and cannot fail to resolve.
 *
 *  THE DEFERRED LOADING IS FAIL-SAFETY, NOT LAYER AVOIDANCE. Every specifier
 *  below is a legal edge from L5 and would lint clean as a static import; it is
 *  deferred only so a resolution failure cannot cost the hook its decision. The
 *  distinction matters because `no-restricted-imports` does not inspect dynamic
 *  `import()`, so a reader could otherwise mistake this shape for the
 *  linter-dodge that `lib/replay/load.js` documents and rejects.
 *
 * ── WHY THE PROJECT ROOT IS NOT DERIVED ─────────────────────────────────────
 *  The root comes from the hook payload's `cwd` and from nowhere else. With no
 *  `cwd` the record is SKIPPED rather than anchored on `process.cwd()`:
 *  Artibot is also installed globally under the user's `.claude` directory, and
 *  a derived root writes one project's blocked calls into another project's
 *  ledger. A missing record is recoverable; a record filed under the wrong
 *  project is a false history. Claude Code sends `cwd` on every PreToolUse
 *  payload, so this branch is not the production path — see the deviation note
 *  in the test.
 *
 *  `recordHumanResolved` inherits this rule unchanged. Its `cwd` arrives as an
 *  explicit argument rather than inside a payload, but the reason is the same
 *  and so is the behaviour: no injected root, no record.
 *
 * ── `kind` IS A SELF-REPORT, AND THAT IS THE HOLE ───────────────────────────
 *  `human.resolved.kind` is written BY THE MODEL about the model's own
 *  interaction. Nothing measures it, and nothing can: correction, decision and
 *  approval are distinguished only by what the person meant, which exists
 *  nowhere in the payload. So `kind` is recorded with `kind_source:
 *  'self-report'` beside it — a reader must never mistake it for an
 *  observation.
 *
 *  THE ROUTE THAT UNDERMINES THIS IS THE SAME ONE THAT IMPLEMENTS IT (design
 *  §5 C9 class). A model that wants its scorecard to read well can call this
 *  with any `kind` it likes, or label a guess an `approval`, or simply not call
 *  it at all — the CLI is opt-in and no hook fires it. The asked side is
 *  written by the hook precisely because the model cannot be trusted to report
 *  its own blocks; the resolved side has no such writer, so an unresolved
 *  `human.asked` is evidence while a `human.resolved` is testimony. Do not
 *  compute a "resolution rate" from these two and call it a measurement.
 *
 * ── THE PRICE OF A DETERMINISTIC question_id ────────────────────────────────
 *  `buildQuestionId` is deterministic so a resolution can find the ask it
 *  answers (see its own comment). The mirror image bites HERE: two genuinely
 *  different questions about one subject in one session collapse onto one id,
 *  so ONE `human.resolved` closes EVERY `human.asked` that shares it. Pairing
 *  statistics are therefore biased in a known direction — unresolved asks are
 *  UNDER-counted, never over-counted. A join on `question_id` answers "was this
 *  subject ever resolved", not "how many asks are still open".
 *
 * ── NEITHER FUNCTION HERE DECIDES ANYTHING ──────────────────────────────────
 *  `recordHumanResolved` records too. It does not apply the decision it
 *  records, does not lift a block, and returns nothing a caller could branch
 *  on. It runs after the person has already answered and after the model has
 *  already acted on that answer.
 *
 * ── WHY THE PRECONDITIONS ARE CHECKED HERE AND NOT LEFT TO THE WRITER ───────
 *  `event-writer.js` turns a contract violation into a `ledger.rejected` line
 *  rather than silence, which is right for an unexpected caller and wrong for
 *  this one: a rejected line loses the record AND appends noise. So every rule
 *  this module can check up front, it checks — a missing `session_id`
 *  (`invalid-envelope:session_id`), a missing `decision`
 *  (`missing-required-data:decision`), a `kind` outside its enum
 *  (`enum-violation:kind`), an oversized `decision` (`line-too-large:…`).
 *  Skipping is the cheaper failure, and it is the only one that leaves the
 *  ledger honest. `HUMAN_RESOLVED_KINDS` and
 *  `HUMAN_RESOLVED_DECISION_MAX_BYTES` are both copies of what the schema says,
 *  pinned against it by the unit test rather than read at runtime.
 *
 *  THE CHECKS ARE NOT COMPLETE, AND THE GAP IS NAMED. `data.path` carries the
 *  Write/Edit subject verbatim and is not length-checked, so a path longer than
 *  the residual byte budget still produces a `ledger.rejected` line. See
 *  `HUMAN_RESOLVED_DECISION_MAX_BYTES` for the measurement and the open hole.
 *
 * @module lib/runtime/human-asked-record
 */

import { createHash } from 'node:crypto';

/**
 * Strictness order of a gate row's `default`. `human-gates.js` deliberately
 * does NOT reduce multiple hits to one row ("Observe 단계에서 축약은 정보
 * 손실이다", lib/security/human-gates.js header "다중 hit 의 해석"), so the full
 * `hits[]` is what the ledger line carries; `gate` is the single strictest id,
 * added on top for readers that need one value.
 */
export const GATE_SEVERITY = Object.freeze({ human: 3, policy: 2, auto: 1 });

/**
 * `question_id` format — `q-<sid8>-<sha256(gate|subject)[:12]>`.
 *
 * Ruled by the leader for T-39 (2026-09-02) and recorded in the design §0-2
 * correction table: the allowlist makes `question_id` required but no canonical
 * document states how one is issued, so these constants are that format's one
 * home. `sid8` is the session id's first 8 characters, or `nosess` when the
 * payload carries none.
 *
 * DETERMINISTIC on purpose. The same subject blocked again in the same session
 * is the same question, and a later `human.resolved` has to be able to find
 * every ask it answers. A random or timestamped id would turn each re-block
 * into a new unanswered question, so the ask-without-resolution signal
 * (design §3.4 OD-5) would read as a backlog that nothing can ever close.
 *
 * The cost is the mirror image: two genuinely separate asks for one subject in
 * one session collapse onto one id and are indistinguishable here.
 */
const QUESTION_ID_PREFIX = 'q-';
const QUESTION_ID_SESSION_CHARS = 8;
const QUESTION_ID_HASH_CHARS = 12;
const QUESTION_ID_NO_SESSION = 'nosess';

/**
 * The strictest gate among the hits, or null when there are none.
 *
 * `null` is truthful, not a placeholder: it means the existing blocked-patterns
 * layer caught the call and no HG row claims it. The key is then OMITTED from
 * the event rather than written as null — the allowlist types
 * `human.asked.data.gate` as a string, so a null would make the whole line a
 * `ledger.rejected` and the record would be lost.
 *
 * @param {Array<{id: string}>} hits
 * @param {(id: string) => {default?: string}|null} getGateRow
 * @returns {string|null}
 */
export function strictestGate(hits, getGateRow) {
  let best = null;
  let bestScore = 0;
  for (const hit of hits) {
    const score = GATE_SEVERITY[getGateRow(hit.id)?.default] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = hit.id;
    }
  }
  return best;
}

/**
 * The join key a later `human.resolved` line points back at. Exported so the
 * format has one testable definition rather than a copy in each gate.
 *
 * The gate is folded into the hash, so the same subject reaching a different
 * gate is a different question — the thing being asked changed even though the
 * subject did not.
 *
 * The hash input is `gate|subject`, unchanged from when this function lived in
 * the Bash hook and took a `command`. Bash ids are therefore byte-identical
 * across the extraction; `subject` is only the wider name for the same slot
 * (a command for Bash, a file path for Write and Edit).
 *
 * @param {string|undefined} sessionId
 * @param {string|null} gate strictest gate id, or null when no row claims it
 * @param {string} subject the command (Bash) or file path (Write, Edit)
 * @returns {string}
 */
export function buildQuestionId(sessionId, gate, subject) {
  const sid8 = typeof sessionId === 'string' && sessionId.length > 0
    ? sessionId.slice(0, QUESTION_ID_SESSION_CHARS)
    : QUESTION_ID_NO_SESSION;
  const digest = createHash('sha256')
    .update(`${gate ?? ''}|${subject}`)
    .digest('hex')
    .slice(0, QUESTION_ID_HASH_CHARS);
  return `${QUESTION_ID_PREFIX}${sid8}-${digest}`;
}

/**
 * The `data` key each tool carries its subject in, and nothing else.
 *
 * An unrecognised tool is ABSENT from this map rather than mapped to a default.
 * The human-gate matrix is an allowlist (lib/security/human-gates.js header
 * "allowlist 형"), so a tool outside it has no row to match — UNCLASSIFIED, not
 * safe, which is a different statement from "no row matched".
 */
const SUBJECT_KEY = Object.freeze({
  Bash: 'command', Write: 'file_path', Edit: 'file_path',
});

/**
 * Pull the raw subject out of a PreToolUse payload for one tool.
 *
 * Split out of `classifySubject` for T-40 so the resolved path, which receives
 * a subject as a plain argument, can share the classification below without
 * synthesizing a fake payload to feed it. The extraction rule is unchanged: the
 * Bash command or the Write/Edit file path, and an empty string for anything
 * that is not a string or not a tool this module knows.
 *
 * @param {object|null} hookData
 * @param {string} tool
 * @returns {string}
 */
function subjectOf(hookData, tool) {
  const key = SUBJECT_KEY[tool];
  if (key === undefined) return '';
  const value = hookData?.tool_input?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Classify one already-extracted subject under one tool.
 *
 * A subject belonging to an unrecognised tool is COLLAPSED to the empty string
 * rather than passed through. Both writers must agree on this or the two halves
 * of a pair would hash different subjects and stop joining — and the asked side
 * has collapsed it since T-39, so the resolved side follows rather than leads.
 *
 * @param {string} subject
 * @param {string} tool
 * @param {{classify: Function}} gates
 * @returns {{subject: string, hits: Array<{id: string}>}}
 */
function classifySubject(subject, tool, gates) {
  if (SUBJECT_KEY[tool] === undefined || subject === '') return { subject: '', hits: [] };
  const input = tool === 'Bash' ? { tool: 'Bash', command: subject } : { tool, path: subject };
  return { subject, hits: gates.classify(input).hits };
}

/**
 * Everything a ledger line needs to say WHICH question it is about, derived
 * once so no caller re-derives it differently.
 *
 * Exported for the CLI, which prints a `question_id` to stdout and records one
 * through `recordHumanResolved`. Those two values reaching a reader from two
 * different derivations is the single failure that would make the join
 * untrustworthy AND invisible — the model would file its answer under an id it
 * was never shown.
 *
 * `gates` is INJECTED when the caller already loaded the module (the two
 * recorders below), and deferred-imported otherwise, so a standalone caller
 * pays for one import and the recorders do not pay twice.
 *
 * @param {{sessionId?: string, tool: string, subject: string}} question
 * @param {{classify: Function, getGateRow: Function}} [gates]
 * @returns {Promise<{question_id: string, gate: string|null, hits: string[],
 *                    subject: string}>}
 */
export async function describeHumanQuestion(question, gates) {
  const { sessionId, tool, subject } = question ?? {};
  const g = gates ?? await import('../security/human-gates.js');
  const classified = classifySubject(typeof subject === 'string' ? subject : '', tool, g);
  const gate = strictestGate(classified.hits, g.getGateRow);
  return {
    question_id: buildQuestionId(sessionId, gate, classified.subject),
    gate,
    hits: classified.hits.map((hit) => hit.id),
    subject: classified.subject,
  };
}

/**
 * The `kind` vocabulary, copied from `schemas/ledger-events.allowlist.json`
 * (`enums.human_resolved_kind`) so this module never has to read and parse a
 * file on a path that must not throw. The copy is pinned against the schema by
 * `tests/runtime/human-resolved-record.test.js`; a copy without that comparison
 * is how the two silently diverge.
 */
export const HUMAN_RESOLVED_KINDS = Object.freeze(['correction', 'decision', 'approval']);

/**
 * The largest `decision` this module will try to record, in BYTES.
 *
 * WHY A LIMIT EXISTS AT ALL. `decision` is the only REQUIRED key of
 * `human.resolved`, and `event-writer.js#foldOversized` keeps exactly the
 * required keys plus `evidence_refs`. So an oversized decision fails in one of
 * two ways, neither of them visible to the caller:
 *   - slightly over the cap: the fold succeeds by dropping everything else,
 *     INCLUDING `question_id`. The line lands and joins nothing.
 *   - far over: the folded line is still too big and the whole record becomes a
 *     `ledger.rejected` line. MEASURED 2026-09-13 — a 5,000-byte decision
 *     produced `line-too-large:5251`, one noise line and no record.
 * Refusing up front is the only outcome that leaves the ledger honest.
 *
 * WHY 3072 AND NOT `limits.line_max_bytes`. Deriving it would mean reading and
 * parsing `schemas/ledger-events.allowlist.json` inside a synchronous function
 * on a path that must never throw, which is the opposite of the deferred-import
 * contract this module is built on. So it is a code constant with headroom, and
 * the drift is caught by a test instead: the pin in
 * `tests/runtime/human-resolved-record.test.js` MEASURES the envelope overhead
 * from a real written line and asserts this constant plus that overhead still
 * fits under the allowlist's cap.
 *
 * WHAT THIS DOES NOT COVER — `path`. The Write/Edit subject is copied onto the
 * line as `data.path`, it is caller-supplied, and its length is unbounded. The
 * budget left for it is whatever the cap has after this constant and the
 * envelope, measured at 721 bytes on 2026-09-13. A longer path still overflows
 * and still lands as `ledger.rejected`, exactly as before. That case is
 * UNMEASURED by any test here and is a known, open hole — not a solved problem.
 */
export const HUMAN_RESOLVED_DECISION_MAX_BYTES = 3072;

/**
 * Why a `human.resolved` record would be skipped, or null when it will be
 * written.
 *
 * Exported so the CLI can TELL THE CALLER it recorded nothing instead of
 * exiting 0 over a silent no-op. One function, two consumers: the recorder
 * branches on it and the CLI prints it, so "what gets written" and "what the
 * model is told was written" cannot disagree.
 *
 * THE REASONS ARE NOT ALL THE SAME KIND OF RULE. Four of them pre-empt a
 * rejection `event-writer.js` would otherwise append — `no-session-id`
 * (`invalid-envelope:session_id`), `no-decision`
 * (`missing-required-data:decision`), `kind-not-in-enum` (`enum-violation:kind`)
 * and `decision-too-long` (`line-too-large:…`). `no-project-root` is NOT one of
 * them: the writer would accept an injected root perfectly well, and this
 * module refuses to invent one for reasons of its own (see the header, "WHY THE
 * PROJECT ROOT IS NOT DERIVED"). Conflating the two would suggest the rule
 * could be relaxed by changing the writer, which is not so.
 *
 * @param {object} args same shape `recordHumanResolved` takes
 * @returns {string|null}
 */
export function humanResolvedSkipReason(args) {
  const { cwd, sessionId, decision, kind } = args ?? {};
  if (typeof cwd !== 'string' || cwd === '') return 'no-project-root';
  if (typeof sessionId !== 'string' || sessionId === '') return 'no-session-id';
  if (typeof decision !== 'string' || decision === '') return 'no-decision';
  // BYTES, not `.length`. The cap the writer applies is a byte cap, so a
  // character count would wave through any decision written in a script whose
  // characters cost more than one byte — 1,100 Korean characters are 3,300
  // bytes and would be rejected by a writer this function had just approved.
  if (Buffer.byteLength(decision, 'utf8') > HUMAN_RESOLVED_DECISION_MAX_BYTES) {
    return 'decision-too-long';
  }
  // `undefined` and `null` both mean "not reported", which is legal — the
  // allowlist leaves `kind` optional. Anything else must be in the enum: a
  // present-but-invalid `kind` is `enum-violation:kind`, and case is NOT folded
  // for this enum (lib/runtime/ledger-schema.js#ENUM_CASE_FOLD carries
  // `verify_result` only), so 'APPROVAL' is as invalid as 'guess'.
  if (kind !== undefined && kind !== null && !HUMAN_RESOLVED_KINDS.includes(kind)) {
    return 'kind-not-in-enum';
  }
  return null;
}

/**
 * Append one `human.asked` line for a block. Best effort in every direction:
 * a failed import, an unwritable ledger, a missing root, or a rejected line all
 * end here silently, because the decision has already been written and nothing
 * this function does may change it. IT NEVER THROWS.
 *
 * `path` is carried only for Write and Edit, where it is the subject and is not
 * otherwise recoverable from the line. Bash does NOT get a `command` key: the
 * reason string already quotes it, and adding one would change the shape of a
 * line that is already in the field.
 *
 * @param {{hookData: object|null, tool: string, reason: string}} args
 *   `hookData` is the payload that was blocked, when known; `tool` is the tool
 *   name as the hook saw it; `reason` is the reason string sent to stdout,
 *   verbatim. Taken WHOLE and destructured inside the try, not in the parameter
 *   list: a parameter default only fills in for `undefined`, so `null` would
 *   throw at binding time — BEFORE the try — and the "never throws" contract
 *   above would be false for the one argument a miswired caller is most likely
 *   to pass. Production passes an object literal at all six call sites; this
 *   guards the contract itself, not a live path.
 * @returns {Promise<void>} always resolves, always undefined
 */
export async function recordHumanAsked(args) {
  try {
    const { hookData, tool, reason } = args ?? {};
    const cwd = hookData?.cwd;
    if (typeof cwd !== 'string' || cwd === '') return; // no injected root — see header
    const [gates, ledger, root] = await Promise.all([
      import('../security/human-gates.js'),
      import('./ledger.js'),
      import('../git/project-root.js'),
    ]);
    // Key INSERTION ORDER below is the order these keys have had in the field
    // since T-39. `question`'s fields are spelled out one by one rather than
    // spread, so the T-40 refactor that introduced `describeHumanQuestion`
    // could not reorder a line already in the ledger.
    const question = await describeHumanQuestion(
      { sessionId: hookData?.session_id, tool, subject: subjectOf(hookData, tool) }, gates,
    );
    const data = {
      question_id: question.question_id,
      hits: question.hits,
      reason,
      decision: 'block',
      tool,
    };
    if (question.gate !== null) data.gate = question.gate;
    if ((tool === 'Write' || tool === 'Edit') && question.subject !== '') {
      data.path = question.subject;
    }
    ledger.appendLedgerEvent(root.resolveProjectRoot(cwd), {
      event: 'human.asked',
      session_id: hookData?.session_id,
      source: 'hook',
      data,
    });
  } catch {
    // Recording never changes the decision, and never fails louder than it.
  }
}

/**
 * Append one `human.resolved` line for an answer a person gave. Best effort in
 * every direction, exactly like its twin above: a failed import, an unwritable
 * ledger, a missing root, or a precondition this module refuses to violate all
 * end here silently. IT NEVER THROWS.
 *
 * Unlike `recordHumanAsked` this takes a SUBJECT rather than a payload: there
 * is no hook payload at this point, only what the model can name. The subject
 * must be spelled exactly as the blocked call spelled it — the same command
 * string, the same file path — because `question_id` hashes it and a
 * near-miss produces a well-formed id that joins nothing.
 *
 * `hits` is deliberately NOT carried. The asked line already records which
 * gates fired; repeating the list here would be a second, unreviewed copy that
 * can disagree with the first after a matrix change, and `gate` alone is enough
 * for a reader who has only this line.
 *
 * @param {{cwd: string, sessionId: string, tool: string, subject: string,
 *          decision: string, kind?: string|null}} args
 *   Taken WHOLE and destructured INSIDE the try, not in the parameter list: a
 *   parameter default only fills in for `undefined`, so `null` would throw at
 *   binding time — before the try — and the "never throws" contract would be
 *   false for the argument a miswired caller is most likely to pass.
 * @returns {Promise<void>} always resolves, always undefined
 */
export async function recordHumanResolved(args) {
  try {
    const { cwd, sessionId, tool, subject, decision, kind } = args ?? {};
    // Checked BEFORE any import: every one of these would otherwise become a
    // `ledger.rejected` line, which loses the record and appends noise.
    if (humanResolvedSkipReason({ cwd, sessionId, decision, kind }) !== null) return;
    const [gates, ledger, root] = await Promise.all([
      import('../security/human-gates.js'),
      import('./ledger.js'),
      import('../git/project-root.js'),
    ]);
    const question = await describeHumanQuestion({ sessionId, tool, subject }, gates);
    const data = { question_id: question.question_id, decision };
    // Omitted rather than written as undefined: `JSON.stringify` drops an
    // undefined value but `Object.keys` keeps the key, so writing one makes the
    // in-memory record and the serialized line disagree about their own shape.
    if (typeof tool === 'string' && tool !== '') data.tool = tool;
    if (kind !== undefined && kind !== null) {
      data.kind = kind;
      // Never written without `kind`, and never omitted with it. The marker is
      // what stops a reader treating a self-report as an observation.
      data.kind_source = 'self-report';
    }
    if (question.gate !== null) data.gate = question.gate;
    if ((tool === 'Write' || tool === 'Edit') && question.subject !== '') {
      data.path = question.subject;
    }
    ledger.appendLedgerEvent(root.resolveProjectRoot(cwd), {
      event: 'human.resolved',
      session_id: sessionId,
      // `human`, not `hook`: a person answered and the model is relaying it.
      // The allowlist permits both spellings, so this line is the only thing
      // that says which one a reader will actually see.
      source: 'human',
      data,
    });
  } catch {
    // Recording an answer must never become a second problem for the caller.
  }
}
