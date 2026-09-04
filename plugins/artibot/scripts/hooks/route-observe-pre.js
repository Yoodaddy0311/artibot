#!/usr/bin/env node
/**
 * PreToolUse(`Agent`) — the SHADOW ROUTE RECEIPT, recorded where the text
 * actually exists.
 *
 * WHY THIS FILE EXISTS. The receipt used to be built at SubagentStart, and the
 * SubagentStart payload carries no action text at all — measured against host
 * 2.1.259 (binary Zod table) and again live on 2.1.260
 * (`tests/hooks/fixtures/host-payloads/PreToolUse.Agent.json`). The result was
 * `route_ledger: 'skipped:no-action-text'` on 71/71 live spawns: a receipt
 * pipeline that recorded nothing. The one place the host DOES hand over the
 * action text and the agent type is the PreToolUse payload for the `Agent`
 * tool, so the receipt is written here (design
 * `.artibot/guides/v5-design/ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md` §1), and
 * `subagent-handler.js` writes a second `route.bound` line at SubagentStart
 * that ties this receipt to the `agent_id` that actually spawned (§2, §3).
 *
 * PRETOOLUSE IS A BLOCK POINT, SO THIS HOOK IS MUTE. exit 2 (and a
 * `permissionDecision` on stdout) is how a PreToolUse hook CANCELS the tool
 * call. An observer that can cancel a spawn is not an observer. Therefore:
 *
 *   - NOTHING is ever written to stdout. Not on success, not on failure. This
 *     module does not import `writeStdout` at all, so there is no line to
 *     accidentally reach.
 *   - `main()` never throws — the whole body is wrapped, and the direct-run
 *     guard below re-catches so even an import-time surprise cannot escape.
 *   - `process.exitCode` is pinned to 0 before anything else runs.
 *   - `tool_name !== 'Agent'` returns on the FIRST check, before any ledger,
 *     config or classifier module is touched. The `hooks.json` matcher already
 *     restricts this hook to the Agent tool; this is the second, independent
 *     defence, and it is what makes a mis-scoped matcher cost nothing.
 *
 * `tests/firewall/host-payload-contract.test.js` holds those properties over
 * eight payload shapes (§4).
 *
 * WHAT THIS HOOK CANNOT SEE (rules §9 — write it next to the gate):
 *   - Spawns that never go through the `Agent` tool (SDK / scheduled / loop
 *     entry points). They produce a SubagentStart with no receipt to bind, and
 *     `skipped:unbound` is the correct record for them, not a defect.
 *   - Whether the host truncates or masks a very large `tool_input.prompt`.
 *     The 64 KB case is a firewall fixture, never a live measurement.
 *   - Whether the recommendation is any GOOD. `route-scorer` is uncalibrated
 *     in Phase 0; this records a decision, it does not validate one.
 *
 * @module scripts/hooks/route-observe-pre
 */

import { parseJSON, readStdin } from '../utils/index.js';
import { loadConfig } from '../../lib/core/config.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { classifyAction } from '../../lib/routing/action-classifier.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';
import { classifyComplexity } from '../../lib/cognitive/router.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { isMissionId, sessionFallbackMissionId } from '../../lib/mission/mission-id.js';
import { isMainEntry } from './_main-entry.js';

/** The one tool this hook answers to. Everything else returns immediately. */
export const AGENT_TOOL = 'Agent';

/**
 * Envelope `source` — who emitted the line. `hook` is the truth and the
 * allowlist admits it (`schemas/ledger-events.allowlist.json#/events/
 * route.selected/sources`). The receipt's own `data.source` is a DIFFERENT
 * field with a different enum (`shadow`), set by the router, not here; the
 * long note in `subagent-handler.js` explains why the two must not be read
 * for one another.
 * @type {string}
 */
const LEDGER_SOURCE = 'hook';

/**
 * `execution_profile_version` for Phase 0 — same constant, same reason, as the
 * one in `subagent-handler.js`: `lib/routing/execution-profile.js` exports no
 * version and the receipt schema types the field as a counter with minimum 1.
 * @type {number}
 */
const PROFILE_VERSION = 1;

/**
 * How much of `tool_input.prompt` is fed to the complexity scorer when there
 * is no `description`. The classifier reads keywords; a whole multi-KB prompt
 * only adds noise and cost. Design §1.3.
 * @type {number}
 */
const PROMPT_TEXT_MAX = 2000;

/**
 * The ONLY `tool_input` keys this hook reads — an allowlist, not a denylist,
 * so a host that starts sending new keys cannot widen what we consume by
 * accident (verification-discipline §8).
 *
 * `description`, `prompt`, `subagent_type` are present on 6/6 live rows;
 * `name` only on named (team-style) spawns; `model` was NEVER OBSERVED,
 * because no probe scenario passed one — it is read defensively and its
 * absence is not evidence that it cannot appear
 * (`fixtures/host-payloads/PreToolUse.Agent.json`).
 */
export const TOOL_INPUT_KEYS = Object.freeze([
  'prompt', 'description', 'subagent_type', 'name', 'model',
]);

/**
 * The action text to classify: `description` first, `prompt` truncated second.
 *
 * `description` wins because it is the caller's own one-line summary of the
 * intent, while `prompt` on this repo's spawns opens with the `[artibot:effort
 * …]` directive envelope and runs to several KB — keyword-matching that scores
 * the harness rather than the work. Basis: transcript observation, i.e. a
 * JUDGEMENT, not a measurement of classifier accuracy on both inputs.
 *
 * @param {object|null|undefined} toolInput - `payload.tool_input`
 * @returns {string|null} Non-blank text, or null when neither key carries any
 */
export function extractActionText(toolInput) {
  const description = toolInput?.description;
  if (typeof description === 'string' && description.trim() !== '') return description;
  const prompt = toolInput?.prompt;
  if (typeof prompt === 'string' && prompt.trim() !== '') return prompt.slice(0, PROMPT_TEXT_MAX);
  return null;
}

/**
 * A non-blank string, or null. Used for every key read off the payload so that
 * `''`, numbers and objects all degrade the same way.
 * @param {unknown} value
 * @returns {string|null}
 */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Mission id for the envelope: the payload's when it names a valid one, else
 * the session fallback `M-YYYYMMDD-S<sid8>`. Mirrors `subagent-handler.js`
 * exactly so a receipt and its bind row land under the SAME mission — two
 * different fallbacks would split one spawn across two missions.
 *
 * @param {object} hookData - Parsed payload
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
 * The correlation key that has nowhere else to live.
 *
 * BOTH schemas on this line are closed. `ledger-envelope.schema.json` is
 * `additionalProperties:false` (closed key set, enforced by the writer's
 * `unknown-envelope-key` rejection) and `route-receipt.schema.json` is too, so
 * `prompt_id` — the host's 1st-tier correlation key, present on 12/12 live
 * rows — cannot be added as a field to either. Rather than widen a schema this
 * limb does not own, it rides in `idempotency_key`, which is exactly the shape
 * of thing that field is for: re-firing PreToolUse for the same tool_use is
 * the same operation, and this string is the same string.
 *
 * FORMAT (parsed back by `subagent-handler.js#parseReceiptKey`):
 *   `route.pre:<tool_use_id>:<prompt_id>:<subagent_type>`
 * `tool_use_id` is repeated from the envelope's `routing_epoch_id` on purpose:
 * the reader compares them and drops the row when they disagree, so a mangled
 * key is detected rather than trusted. `prompt_id` and `subagent_type` may each
 * be EMPTY — the segment is still written, because a positional format with a
 * missing segment is a format that cannot be parsed. `subagent_type` goes LAST
 * because it is the only part that may itself contain a colon
 * (`artibot:code-reviewer`), so it absorbs the remainder unambiguously.
 *
 * WHY `subagent_type` IS HERE AT ALL. Measured 2026-09-04 on host 2.1.260: an
 * Agent tool spawn reports `agent_type === subagent_type` on its SubagentStart
 * — even when the caller passed a `name` (1/1 rows where a name was passed;
 * 2/2 rows overall). The design's §2.1 assumption that a named spawn reports
 * `agent_type === name` holds for the team/autopilot spawn path (1025 rows in
 * this repo's spawn ledger are name-shaped) but NOT for this one. So the bind
 * side has to be able to match on either identity, and it can only do that if
 * the receipt carries both.
 *
 * @param {string} toolUseId
 * @param {string|null} promptId
 * @param {string|null} subagentType
 * @returns {string}
 */
export function receiptKey(toolUseId, promptId, subagentType) {
  return `route.pre:${toolUseId}:${promptId ?? ''}:${subagentType ?? ''}`;
}

/**
 * Action classes that ARE review-phase actions. Moved here verbatim from
 * `subagent-handler.js`, which no longer classifies anything — one Phase-0
 * home, not two.
 *
 * T-27 MIGRATION CANDIDATE (leader ruling 2026-09-02): this is a class→phase
 * mapping, i.e. classifier vocabulary. `lib/routing/action-classifier.js`
 * exports `derivePhase` (role→phase) and no class→phase counterpart; when one
 * is added there, delete this set and call it instead.
 * @type {Set<string>}
 */
const REVIEW_ACTION_CLASSES = new Set(['review', 'architecture']);

/**
 * Lifecycle phase for one Agent tool call, or NULL when nothing evidences one.
 *
 * There is no role on an Agent `tool_input` (measured: the live key set is
 * description / prompt / subagent_type / run_in_background / name?), so the
 * role→phase path that `subagent-handler.js` used cannot apply here and only
 * the two class-based answers remain:
 *   1. `review` / `architecture` classes ARE review-phase actions.
 *   2. `factors.source === 'default'` is the classifier reporting that NOTHING
 *      identified the action — not the agent table, not the text. Its
 *      `implement` is a FALLBACK CLASS, not an observation, so it is not
 *      evidence of a build phase. Null, and the caller skips the append rather
 *      than writing an invented phase into an append-only ledger (T-50 §4).
 *
 * @param {object} classified - `classifyAction` result
 * @returns {'build'|'review'|null}
 */
export function receiptPhase(classified) {
  if (REVIEW_ACTION_CLASSES.has(classified?.actionClass)) return 'review';
  if (classified?.factors?.source === 'default') return null;
  return 'build';
}

/**
 * Build the shadow RouteReceipt for one Agent tool call.
 *
 * The epoch is the `tool_use_id`: at PreToolUse the spawn does not exist yet,
 * so there is no `agent_id` to name. The bind row promotes the epoch to the
 * `agent_id` (decision G1, "the epoch is the spawn") and this temporary value
 * is what joins the two lines.
 *
 * `models.selected` is the `resolveModel(subagent_type)` policy answer — which
 * in Observe is what `subagent-handler.js` independently computes as
 * `canonicalModel` at spawn time. The design sketched a separate
 * `predicted_selected` key for it; `route-receipt.schema.json` is
 * `additionalProperties:false` and this limb does not own that schema, so the
 * prediction stays in `models.selected` and the bind row records the actual
 * `canonicalModel` beside it. The two are comparable because they are the same
 * function of the same input.
 *
 * @param {{toolUseId: string, sessionId: string, missionId: string,
 *   agentType: string|null, text: string, config: object|undefined}} ctx
 * @returns {object|null} Receipt, or null when it would be structurally
 *   incomplete (the append is then skipped rather than fabricated)
 */
export function buildReceipt(ctx) {
  const input = { text: ctx.text, agentType: ctx.agentType ?? undefined };
  const classifierOptions = { classifyComplexity };
  const phase = receiptPhase(classifyAction(input, classifierOptions));
  if (phase === null) return null;
  const timestamp = new Date().toISOString();
  const receipt = routeModel({
    agentType: ctx.agentType ?? undefined,
    epoch: ctx.toolUseId,
    config: ctx.config,
    phase,
    input,
    classifierOptions,
    evidence: {
      route_receipt_id: `rr-${ctx.toolUseId}-${timestamp}`,
      mission_id: ctx.missionId,
      session_id: ctx.sessionId,
      execution_profile_version: PROFILE_VERSION,
      timestamp,
      // The production line this shadow mirrors is the tool call itself; the
      // spawn it becomes does not exist yet. `subagent-handler.js` names the
      // spawn on the bind line.
      shadow_of: `tool_use:${ctx.toolUseId}`,
    },
  });
  if (typeof receipt?.action?.complexity !== 'number') return null;
  if (typeof receipt?.action?.phase !== 'string') return null;
  return receipt;
}

/**
 * Record one `route.selected` receipt for an Agent tool call.
 *
 * Returns a short outcome string for tests and for the D2 live burn; NOTHING
 * downstream consumes it, and nothing is printed. Never throws.
 *
 * @param {object|null} hookData - Parsed payload
 * @returns {{ ok: boolean, reason?: string, epoch?: string }}
 */
export async function observePre(hookData) {
  try {
    if (hookData?.tool_name !== AGENT_TOOL) return { ok: false, reason: 'not-agent-tool' };

    const toolUseId = str(hookData?.tool_use_id);
    if (toolUseId === null) return { ok: false, reason: 'no-tool-use-id' };
    const sessionId = str(hookData?.session_id) ?? str(hookData?.sessionId);
    if (sessionId === null) return { ok: false, reason: 'no-session' };
    const missionId = resolveMissionId(hookData, sessionId);
    if (missionId === null) return { ok: false, reason: 'no-mission' };

    const cwd = str(hookData?.cwd);
    if (cwd === null) return { ok: false, reason: 'no-cwd' };
    const projectRoot = resolveProjectRoot(cwd);
    if (str(projectRoot) === null) return { ok: false, reason: 'no-project-root' };

    const toolInput = hookData?.tool_input;
    if (!toolInput || typeof toolInput !== 'object') return { ok: false, reason: 'no-tool-input' };
    const text = extractActionText(toolInput);
    if (text === null) return { ok: false, reason: 'no-action-text' };

    let config;
    try {
      config = await loadConfig();
    } catch {
      config = undefined;
    }

    const receipt = buildReceipt({
      toolUseId,
      sessionId,
      missionId,
      agentType: str(toolInput.subagent_type),
      text,
      config,
    });
    if (receipt === null) return { ok: false, reason: 'no-receipt' };

    const envelope = {
      event: 'route.selected',
      session_id: sessionId,
      mission_id: missionId,
      // The Action being routed IS this tool call, and the epoch is temporary
      // until the bind row promotes it to the agent_id.
      routing_epoch_id: toolUseId,
      action_id: toolUseId,
      source: LEDGER_SOURCE,
      data: receipt,
    };
    // `worker` is the envelope's own "worker / limb name" field and a named
    // Agent spawn is exactly that. It is the 2nd-tier correlation key: the
    // host reports `agent_type === <name>` on the matching SubagentStart.
    const name = str(toolInput.name);
    if (name !== null) envelope.worker = name;
    // Always written, even when both halves are empty: the bind side parses
    // this positionally and needs the shape to be constant.
    envelope.idempotency_key = receiptKey(
      toolUseId, str(hookData?.prompt_id), str(toolInput.subagent_type),
    );

    const result = appendLedgerEvent(projectRoot, envelope);
    if (result?.ok === true) return { ok: true, epoch: toolUseId };
    return { ok: false, reason: String(result?.reason ?? 'append-failed') };
  } catch (err) {
    return { ok: false, reason: err?.message || 'observe-failed' };
  }
}

/**
 * Hook entry. Reads stdin, records, and returns — no stdout, no non-zero exit,
 * no throw, under every input.
 * @returns {Promise<{ok: boolean, reason?: string, epoch?: string}>}
 */
export async function main() {
  process.exitCode = 0;
  try {
    const raw = await readStdin();
    // parseJSON returns null on malformed input; observePre then falls out at
    // its first check. Non-JSON stdin is a no-op, not an error.
    return await observePre(parseJSON(raw));
  } catch (err) {
    return { ok: false, reason: err?.message || 'main-failed' };
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// The extra `.catch` is redundant with main()'s own try/catch by design — this
// is a block point, and one guarantee with two independent implementations is
// cheaper than one spawn cancelled in production.
if (isMainEntry(import.meta.url)) {
  main().catch(() => { process.exitCode = 0; });
}
