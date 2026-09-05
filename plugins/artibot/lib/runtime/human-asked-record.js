/**
 * The one place a blocked tool call becomes a `human.asked` ledger line.
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
 * Pull the classified subject out of a payload for one tool.
 *
 * An unrecognised tool yields an empty subject and no hits — it is UNCLASSIFIED,
 * not safe, and the caller still records the block. The human-gate matrix is an
 * allowlist (lib/security/human-gates.js header "allowlist 형"), so a tool
 * outside it has no row to match, which is a different statement from "no row
 * matched".
 *
 * @param {object|null} hookData
 * @param {string} tool
 * @param {{classify: Function}} gates
 * @returns {{subject: string, hits: Array<{id: string}>}}
 */
function classifySubject(hookData, tool, gates) {
  if (tool === 'Bash') {
    const command = hookData?.tool_input?.command;
    const subject = typeof command === 'string' ? command : '';
    return {
      subject,
      hits: subject === '' ? [] : gates.classify({ tool: 'Bash', command: subject }).hits,
    };
  }
  if (tool === 'Write' || tool === 'Edit') {
    const filePath = hookData?.tool_input?.file_path;
    const subject = typeof filePath === 'string' ? filePath : '';
    return {
      subject,
      hits: subject === '' ? [] : gates.classify({ tool, path: subject }).hits,
    };
  }
  return { subject: '', hits: [] };
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
    const { subject, hits } = classifySubject(hookData, tool, gates);
    const gate = strictestGate(hits, gates.getGateRow);
    const data = {
      question_id: buildQuestionId(hookData?.session_id, gate, subject),
      hits: hits.map((hit) => hit.id),
      reason,
      decision: 'block',
      tool,
    };
    if (gate !== null) data.gate = gate;
    if ((tool === 'Write' || tool === 'Edit') && subject !== '') data.path = subject;
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
