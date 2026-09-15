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
 * THE TWO EXTRA READS FAIL TO ABSENT, NEVER TO A GUESS. Naming the incumbent
 * tier costs a bounded tail read of the host transcript, and counting its
 * residency costs a second one over the run ledger. Both are best-effort: a
 * missing `transcript_path`, an unreadable file, no assistant record, or a
 * `message.model` this repo's catalog does not name all resolve to NOT SUPPLYING
 * `currentTier` — and `actionsSinceSwitch` is never supplied without it, because
 * a residency count against an unknown incumbent counts nothing. The router
 * already distinguishes the two states honestly (`residency:unavailable` plus
 * `hysteresis:residency-unknown` when the counter is absent, `minimum-residency`
 * only for a MEASURED shortfall), so silence here degrades into the existing
 * unknown branch rather than inventing a seat the session never held. The ledger
 * read is skipped entirely when the tier read came back empty.
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
import { MODELS } from '../../lib/core/model-catalog.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { classifyAction } from '../../lib/routing/action-classifier.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';
import { classifyComplexity } from '../../lib/cognitive/router.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { readLedgerTail, readNdjsonTail } from '../../lib/runtime/ledger-tail.js';
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
 * How much of `transcript_path` is read to find the incumbent model — 256 KB.
 *
 * MEASURED, not guessed (21 transcripts of this project, 2026-09-15). The
 * transcript is not a small file: median 3.9 MB, largest 29.2 MB, so an
 * unbounded read on a BLOCK POINT is out of the question. What matters is the
 * distance from EOF back to the start of the last assistant record, because
 * everything after it (tool_result payloads, user turns) is dead weight this
 * hook must still cross. Over the 18 transcripts that contain an assistant
 * record at all, that distance was p50 11.8 KB, p90 28.0 KB, max 81.9 KB;
 * 64 KB covers 17/18 and 128 KB covers 18/18. 256 KB is the 18/18 bound with
 * ~3.2x headroom over the worst case observed.
 *
 * THE HEADROOM IS NOT PADDING. A single transcript line reached 846 KB in the
 * same sample, and `readNdjsonTail` DISCARDS the line the window lands inside
 * (it is almost always a fragment). A window near the size of one line is a
 * window that can return nothing, so the budget has to clear the record it is
 * hunting for by a wide margin — and when it does not, the result is `null`,
 * which is the honest answer, not a wrong tier.
 *
 * Deliberately NOT inherited from `ledger-tail.js#DEFAULT_TAIL_BYTES`: that
 * 128 KB is derived from the ledger's 4 KB per-line cap, and the transcript has
 * no such cap. Same window rule, different stream, different budget. NOT
 * comparable to the 8 MB in `_review-stop-record.js:129` — Stop is not a block
 * point and can afford a read this one cannot.
 * @type {number}
 */
export const TRANSCRIPT_TAIL_BYTES = 262144;

/**
 * How much of the run ledger is read to count residency — 512 KB.
 *
 * A SEPARATE BUDGET FROM THE TRANSCRIPT'S, because it answers a different
 * question. The transcript read needs to reach ONE record (the last assistant
 * turn). This read needs to reach the `minimum_residency` barrier's worth of
 * THIS SESSION'S rows — default 3 (`route-hysteresis.js:76`) — through a ledger
 * where every concurrent session's rows are interleaved with them. Sessions
 * running in parallel are what push a session's own previous row arbitrarily
 * far back, so the window has to clear that interleaving, not just three lines.
 *
 * MEASURED on the live ledger (987,547 B / 1,175 rows, 2026-09-15 02:54Z),
 * as the share of rows whose preceding three same-session rows all fall inside
 * the window:
 *
 *   128 KB -> 69/73   256 KB -> 73/73 (0 headroom)   512 KB -> 73/73
 *
 * 128 KB — the inherited default this originally used — produces 4/73 FALSE
 * `minimum-residency` holds: a real switch blocked by a shortfall that never
 * happened. 256 KB clears the sample but with zero margin, since the largest
 * observed gap between one session's consecutive rows was 134,596 B, and a
 * busier day widens exactly that gap. 512 KB is the same 73/73 with room for
 * the interleaving to grow.
 *
 * THE COST IS NOT THE CONSTRAINT HERE. `readNdjsonTail` p50 went 0.86 ms at
 * 128 KB to 2.75 ms at 512 KB — under 1% of the hook's ~240 ms end-to-end,
 * which is dominated by node process startup. Under-counting, by contrast,
 * changes a routing decision.
 * @type {number}
 */
export const RESIDENCY_TAIL_BYTES = 524288;

/**
 * The host's placeholder `message.model` on an assistant record it injected
 * itself rather than one a model produced (interrupts, error notices).
 *
 * It is SKIPPED, not treated as unknown. Measured on the same 21 transcripts:
 * 30/8769 assistant records carry it, and on 1/21 it is the LAST assistant
 * record — so reading it literally would erase a known incumbent roughly one
 * session in twenty for a record that is not a model turn at all. Scanning past
 * it reaches the real one. Any OTHER unrecognised id stops the scan and yields
 * null: the last real turn IS the incumbent, and skipping past an id we cannot
 * name would report a tier the session has already left.
 * @type {string}
 */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * The tier whose catalog entry has exactly this `id`, or null.
 *
 * EXACT, full-id match only. The catalog field is `id` (`model-catalog.js:140`
 * `MODELS`), and `adaptive-model-router.js#modelIdentity` is what later renames
 * it to `model_id` on the receipt — this reads the catalog, so it reads `id`.
 * No prefix, alias or suffix tolerance: an id the catalog does not name is a
 * tier this repo cannot price, and the router's `models.current` is typed as a
 * priced identity. Measured consequence, same sample: `claude-sonnet-5` appears
 * on 293/8769 assistant records while the catalog's sonnet entry is
 * `claude-sonnet-4-6`, so those resolve to null today. That is CATALOG DRIFT
 * reported as unknown, which is the fail-closed half of the trade; widening the
 * matcher here would paper over it in the one place nobody would look.
 *
 * @param {unknown} modelId - `message.model` off a transcript record
 * @returns {string|null} Tier key ('opus' | 'fable' | …), or null
 */
function tierForModelId(modelId) {
  if (typeof modelId !== 'string' || modelId.trim() === '') return null;
  for (const [tier, spec] of Object.entries(MODELS)) {
    if (spec?.id === modelId) return tier;
  }
  return null;
}

/**
 * The tier that was in effect for this session immediately before this
 * decision, read from the host transcript, or null when nothing evidences one.
 *
 * ONLY `message.model` IS EXTRACTED. The transcript is the richest text in the
 * whole system — prompts, file contents, tool results, absolute paths. Nothing
 * but the model id crosses out of this function, so nothing else can reach the
 * receipt, the ledger or stderr. `tests/hooks/route-observe-pre.test.js` proves
 * it with a sentinel string planted in the transcript and asserted absent from
 * the written ledger.
 *
 * Never throws: `readNdjsonTail` already yields `[]` for a missing or corrupt
 * file, and the outer catch covers the rest.
 *
 * @param {unknown} transcriptPath - `payload.transcript_path`
 * @returns {string|null} Tier key, or null when unavailable/unrecognised
 */
export function resolveIncumbentTier(transcriptPath) {
  try {
    if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') return null;
    const records = readNdjsonTail(transcriptPath, { tailBytes: TRANSCRIPT_TAIL_BYTES });
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i];
      if (record?.type !== 'assistant') continue;
      const modelId = record?.message?.model;
      if (modelId === SYNTHETIC_MODEL) continue;
      return tierForModelId(modelId);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * How many consecutive prior decisions in THIS session already sat on `tier`.
 *
 * Walks the ledger tail backwards over this session's `route.selected` rows and
 * counts while `data.models.current.tier` still equals `tier`, stopping at the
 * first row that names a different tier or none. That stop is the switch: the
 * count is the residency since it, which is exactly what
 * `route-hysteresis.js:487` compares against the `minimum_residency` barrier
 * (default 3, `DEFAULT_SWITCH_POLICY`).
 *
 * ROWS FROM OTHER SESSIONS ARE SKIPPED, NOT STOPPERS. One ledger carries every
 * session in the project interleaved, so treating a neighbour's row as a
 * boundary would report a shortfall that never happened — and a shortfall is
 * the reading that BLOCKS a switch. Only this session's own history can end its
 * own residency.
 *
 * Under-counts by design when the run is older than the tail window: the window
 * is a window (`ledger-tail.js` header), and a low count fails toward holding
 * the incumbent, which is the safe direction. Safe is not free, though — an
 * under-count reads as `minimum-residency`, a MEASURED shortfall, so it blocks
 * a switch that should have happened. {@link RESIDENCY_TAIL_BYTES} is sized
 * against that failure, not against read cost.
 *
 * @param {unknown} events - Parsed ledger rows in append order
 * @param {string|null} sessionId - The session whose rows count
 * @param {string|null} tier - Incumbent tier from {@link resolveIncumbentTier}
 * @returns {number} Consecutive count; 0 when there is nothing to count
 */
export function countActionsSinceSwitch(events, sessionId, tier) {
  if (!Array.isArray(events)) return 0;
  if (typeof tier !== 'string' || tier === '') return 0;
  if (typeof sessionId !== 'string' || sessionId === '') return 0;
  let count = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const row = events[i];
    if (row?.event !== 'route.selected') continue;
    if (row?.session_id !== sessionId) continue;
    if (row?.data?.models?.current?.tier !== tier) break;
    count += 1;
  }
  return count;
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
 * `currentTier` and `actionsSinceSwitch` go in TOGETHER OR NOT AT ALL, as two
 * TOP-LEVEL `routeModel` keys — not inside `input`, which is the classifier's
 * bag (`adaptive-model-router.js:462-463` reads them off `src`, and `src` is
 * the argument object itself). Omitting the pair is what leaves the receipt
 * byte-identical to the pre-K1 one, because `routeModel` maps a missing
 * `currentTier` to `models.current: null` and a missing counter to
 * `actionsSinceSwitch: 0` plus `residency:unavailable` — the exact shape this
 * hook emitted before it could see either.
 *
 * @param {{toolUseId: string, sessionId: string, missionId: string,
 *   agentType: string|null, text: string, config: object|undefined,
 *   currentTier?: string|null, actionsSinceSwitch?: number|null}} ctx
 * @returns {object|null} Receipt, or null when it would be structurally
 *   incomplete (the append is then skipped rather than fabricated)
 */
export function buildReceipt(ctx) {
  const input = { text: ctx.text, agentType: ctx.agentType ?? undefined };
  const classifierOptions = { classifyComplexity };
  const phase = receiptPhase(classifyAction(input, classifierOptions));
  if (phase === null) return null;
  const timestamp = new Date().toISOString();
  const incumbent = str(ctx.currentTier);
  const receipt = routeModel({
    agentType: ctx.agentType ?? undefined,
    epoch: ctx.toolUseId,
    config: ctx.config,
    phase,
    input,
    classifierOptions,
    ...(incumbent === null ? {} : {
      currentTier: incumbent,
      actionsSinceSwitch: typeof ctx.actionsSinceSwitch === 'number'
        ? ctx.actionsSinceSwitch
        : 0,
    }),
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

    // Incumbent first, ledger second: the residency count is meaningless
    // without a tier to count, so the second read is not paid for unless the
    // first one produced something. On a block point that ordering IS the
    // budget — the common "no transcript" case costs one `existsSync`.
    const currentTier = resolveIncumbentTier(hookData?.transcript_path);
    const actionsSinceSwitch = currentTier === null
      ? null
      : countActionsSinceSwitch(
        readLedgerTail(projectRoot, { tailBytes: RESIDENCY_TAIL_BYTES }),
        sessionId,
        currentTier,
      );

    const receipt = buildReceipt({
      toolUseId,
      sessionId,
      missionId,
      agentType: str(toolInput.subagent_type),
      text,
      config,
      currentTier,
      actionsSinceSwitch,
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
