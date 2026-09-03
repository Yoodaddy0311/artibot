#!/usr/bin/env node
/**
 * SubagentStart / SubagentStop hook.
 * Tracks teammate registration and deregistration.
 * Usage: node subagent-handler.js start|stop
 */

import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { cleanupStaleStateTmpFiles, createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';
import { getPolicyModel, resolveModel } from '../../lib/core/model-policy.js';
import { loadConfig } from '../../lib/core/config.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { appendSpawn } from '../../lib/learning/ledger/spawn-ledger.js';
import { classifyAction, derivePhase, getActionClassForAgent } from '../../lib/routing/action-classifier.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';
import { classifyComplexity } from '../../lib/cognitive/router.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { isMissionId, sessionFallbackMissionId } from '../../lib/mission/mission-id.js';
import { isMainEntry } from './_main-entry.js';

/**
 * Read an explicitly-requested model from the hook payload, if present.
 * Spawn payloads carry the model under varying keys depending on the caller;
 * check all known locations defensively.
 * @param {object} hookData - Parsed hook data
 * @returns {string|null} The requested model, or null when none was specified
 */
function extractRequestedModel(hookData) {
  return hookData?.model || hookData?.tool_input?.model || hookData?.agent_model || null;
}

/**
 * Resolve the policy-canonical model for an agent type and compare it against
 * any explicitly-requested model.
 *
 * Best-effort and advisory only — must NEVER throw (teammate registration
 * runs regardless). Hooks run as a fresh Node process with an empty config
 * cache, so the policy is hydrated explicitly via loadConfig(); if hydration
 * fails or the agent is not listed in any populated policy bucket
 * (getPolicyModel → null), the canonical model is untrustworthy and the
 * advisory is suppressed rather than emitting a false-positive warning.
 *
 * The hydrated config is returned alongside so the routing observer below can
 * reuse it: passing the SAME config into `routeModel` is what makes the
 * receipt's `models.selected` provably the value this function computed,
 * rather than a second, independently-loaded answer to one question.
 *
 * @param {string} agentType - The spawning agent's type
 * @param {string|null} requestedModel - Model explicitly requested in the payload
 * @returns {Promise<{ canonicalModel: string|null, modelMismatch: boolean, config: object|undefined }>}
 */
async function checkModelPolicy(agentType, requestedModel) {
  try {
    const config = await loadConfig();
    // getPolicyModel returns the bucket model only when the agent is listed in
    // a populated policy; null means empty/unloaded policy OR unknown agent —
    // either way the canonical is not trustworthy, so we don't warn. When it
    // IS listed, the canonical must be the EFFECTIVE tier after the fable
    // opt-in gate/denylist (e.g. security-reviewer in a fable bucket → opus),
    // so the advisory compares against resolveModel, not the raw bucket.
    if (getPolicyModel(agentType, config) === null) {
      return { canonicalModel: null, modelMismatch: false, config };
    }
    const canonicalModel = resolveModel(agentType, {}, config);
    const modelMismatch = Boolean(requestedModel) && requestedModel !== canonicalModel;
    return { canonicalModel, modelMismatch, config };
  } catch {
    return { canonicalModel: null, modelMismatch: false, config: undefined };
  }
}

/**
 * Project root for both ledgers, resolved from the payload `cwd` the same way
 * session-ledger.mjs does (a mid-session `cd` must not fork the ledger tree).
 * Without a `cwd` there is no trustworthy root, so callers skip rather than
 * guess from process.cwd(). Never throws.
 *
 * @param {object} hookData - Parsed hook payload
 * @returns {string|null} Absolute project root, or null when unresolvable
 */
function payloadProjectRoot(hookData) {
  try {
    const cwd = hookData?.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) return null;
    const root = resolveProjectRoot(cwd);
    return typeof root === 'string' && root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * Append one line to the project-local spawn ledger
 * (`<projectRoot>/.artibot/ledger/spawns.ndjson`). Best-effort audit surface
 * for fan-out counts and model-policy drift — must NEVER throw and never
 * touches stdout.
 *
 * @param {object} hookData - Parsed hook payload
 * @param {string|null} projectRoot - Root from {@link payloadProjectRoot}
 * @param {object} record - Spawn record fields (see spawn-ledger.js)
 * @returns {{ ok: boolean, reason?: string }}
 */
function recordSpawn(hookData, projectRoot, record) {
  try {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      return { ok: false, reason: 'no-cwd' };
    }
    return appendSpawn(projectRoot, {
      sessionId: hookData?.session_id || hookData?.sessionId || null,
      agentName: hookData?.agent_name || hookData?.name || null,
      ...record,
    });
  } catch (err) {
    return { ok: false, reason: err?.message || 'record-failed' };
  }
}

// ---------------------------------------------------------------------------
// v5 routing observation (T-31) — OBSERVE ONLY
//
// Nothing in this block changes which model actually spawns. `checkModelPolicy`
// above remains the sole source of the advisory message and of
// `canonicalModel`; what follows records a SHADOW RouteReceipt beside it so a
// later phase can compare the recommendation against what really ran.
//
// TWO FIELDS ARE BOTH NAMED `source` AND THEY ARE NOT THE SAME FIELD. One line
// of this ledger carries both, and reading one for the other is the mistake
// this note exists to prevent:
//   envelope `source`  — WHO EMITTED the line. Enum of eight
//     (`ledger-envelope.schema.json`): human | supervisor | worker | reviewer |
//     hook | git | gate | scheduler. Ours is `hook` — see LEDGER_SOURCE below.
//   receipt `data.source` — PROVENANCE OF THE DECISION. Enum of two
//     (`route-receipt.schema.json`): production | shadow. Ours is `shadow`,
//     set by `adaptive-model-router.js:524` from its `RECEIPT_SOURCE`; the hook
//     never writes it.
// So one route.selected line reads `source: 'hook'` on the envelope and
// `data.source: 'shadow'` inside it, which is exactly what the design
// specifies: `route.selected{source:'shadow', shadow_of}` (§3.6). `shadow_of`
// is a THIRD, separate field — the pairing pointer, not a provenance label —
// and it does not stand in for either of the two above.
// ---------------------------------------------------------------------------

/**
 * Envelope `source` for `route.selected`: the TRUTH about who emitted the
 * line, which for this event is a hook. Not to be confused with the receipt's
 * own `data.source` (`shadow`) — see the two-fields note above.
 *
 * It was briefly 'scheduler' because the vocabulary allowlist
 * (`schemas/ledger-events.allowlist.json#/events/route.selected/sources`)
 * permitted only that, and the writer rejects any source outside the list
 * (`lib/runtime/event-writer.js:561`). Naming a source you are not is sender
 * forgery, so the fix was to widen the allowlist, not to relabel the emitter —
 * T-15 added `hook` (measured 2026-09-02 18:08, sources now
 * `["scheduler","hook"]`). If this ever has to change again, change the
 * allowlist; do not make the hook claim to be something else.
 * @type {string}
 */
const LEDGER_SOURCE = 'hook';

/**
 * `execution_profile_version` for Phase 0. `lib/routing/execution-profile.js`
 * exports no version constant (measured 2026-09-02) and the receipt schema
 * types the field as a counter with minimum 1, so Phase 0 emits 1.
 * @type {number}
 */
const PROFILE_VERSION = 1;

/** Reason strings land on the spawn record; keep them short. @type {number} */
const REASON_MAX = 60;

/**
 * Action classes whose spawn is a review-phase action. Derived from the
 * classifier's own vocabulary — `review` and `architecture` are the two
 * classes `ACTION_CLASS_TIERS` places on the review tier — and consulted only
 * when the payload names no `resolveModel` role that `derivePhase` recognises.
 *
 * T-27 `lib/routing/action-classifier.js` MIGRATION CANDIDATE (leader ruling,
 * 2026-09-02): this is a class→phase mapping, which is classifier vocabulary,
 * not hook logic. It lives here only for the Observe phase, because
 * `action-classifier.js` exports `derivePhase` (role→phase) and no class→phase
 * counterpart. When one is added there, delete this set and call it instead —
 * a second place that decides what "review" means is how the two drift apart.
 * @type {Set<string>}
 */
const REVIEW_ACTION_CLASSES = new Set(['review', 'architecture']);

/**
 * Free text describing the action the spawn is about to perform.
 *
 * The complexity port scores TEXT; with no text `action.complexity` is absent
 * and the receipt cannot satisfy `schemas/route-receipt.schema.json`, which
 * requires it. The append is then SKIPPED rather than fabricating a score — an
 * invented complexity is indistinguishable from a measured one once written.
 *
 * ALWAYS RETURNS NULL IN PRODUCTION TODAY, AND THAT IS NOT A KEY-NAME BUG.
 * MEASURED 2026-09-03 against the Claude Code **2.1.259** binary
 * (`~/.local/share/claude/versions/2.1.259`, Zod hook-input schema table at
 * byte offset ~183,955,500), the whole SubagentStart payload is
 *   { session_id, transcript_path, cwd, prompt_id?, permission_mode?,
 *     agent_id, agent_type, effort?, hook_event_name: 'SubagentStart' }
 * — no `prompt`, no `description`, no `tool_input` under any spelling. Live
 * confirmation: `.artibot/ledger/spawns.ndjson`, 10/10 starts after the 4.53.0
 * install carry `route_ledger: 'skipped:no-action-text'`, and the same file's
 * `agentName: null` independently confirms the absence of `name`/`agent_name`.
 *
 * So DO NOT "fix" this by adding more key spellings: there is no key to find.
 * The only source of an action description at SubagentStart time is the parent
 * transcript at `transcript_path` (the Agent tool_use carries `description` and
 * `prompt`), which needs an agent_id→tool_use_id correlation this payload does
 * not supply. That is a design decision, not a rename — do not take it here.
 *
 * The unified `extractUserPromptText` in `lib/core/hook-utils.js` deliberately
 * does NOT cover this function: a SubagentStart action description and a
 * UserPromptSubmit prompt are different payloads answering different questions,
 * and merging their key lists would only hide this measurement again.
 *
 * @param {object} hookData - Parsed hook payload
 * @returns {string|null} Non-blank text, or null
 */
function extractActionText(hookData) {
  const toolInput = hookData?.tool_input;
  const candidates = [
    hookData?.prompt, toolInput?.prompt, hookData?.description, toolInput?.description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

/**
 * Spawn nesting depth, when the payload names one.
 *
 * MEASURED 2026-09-02 (`grep -rn depth scripts/hooks/*.js` → 2 hits, both
 * prose): no SubagentStart payload key in this repo carries a depth, and the
 * fields this handler reads are agent_id / agent_type / name / cwd /
 * session_id. The probe is therefore forward-looking — it returns null until
 * the host supplies one of these keys, and the record stores that null
 * EXPLICITLY so a reader can tell "not supplied" from "top level".
 *
 * @param {object} hookData - Parsed hook payload
 * @returns {number|null} Non-negative integer depth, or null
 */
function extractDepth(hookData) {
  const candidates = [
    hookData?.depth, hookData?.agent_depth, hookData?.nesting_depth, hookData?.tool_input?.depth,
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

/**
 * Task Graph node id when the payload names one.
 * @param {object} hookData - Parsed hook payload
 * @returns {string|null}
 */
function extractTaskId(hookData) {
  const value = hookData?.task_id ?? hookData?.taskId ?? hookData?.tool_input?.task_id;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Mission id for the ledger envelope: the payload's when it names a valid one,
 * otherwise the session fallback `M-YYYYMMDD-S<sid8>`.
 *
 * The state store is NOT consulted: `~/.claude/artibot-state.json` carries no
 * mission field (measured 2026-09-02 — `grep -rn 'missionId|mission_id'
 * lib/core/hook-utils.js scripts/hooks/` → 0 hits), so a state branch here
 * would be dead code posing as a source.
 *
 * `sessionFallbackMissionId` THROWS on a session id with fewer than eight
 * alphanumerics, so the call is guarded and degrades to null.
 *
 * @param {object} hookData - Parsed hook payload
 * @param {string|null} sessionId - Session id from the payload
 * @returns {string|null} A valid mission id, or null
 */
function resolveMissionId(hookData, sessionId) {
  const declared = hookData?.mission_id ?? hookData?.missionId;
  if (isMissionId(declared)) return declared;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  try {
    const id = sessionFallbackMissionId({ sessionId, nowMs: Date.now() });
    return isMissionId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Reason the receipt cannot be appended, or null when it can.
 *
 * Checked BEFORE the append so a structurally incomplete receipt is skipped
 * instead of writing a `ledger.rejected` line on every spawn: the writer
 * records refusals, and one refusal per spawn is noise, not observability.
 *
 * @param {object|null} receipt - RouteReceipt from `routeModel`
 * @returns {string|null} Short reason code, or null when appendable
 */
function receiptGap(receipt) {
  if (!receipt || typeof receipt !== 'object') return 'no-receipt';
  const epoch = receipt.routing_epoch_id;
  if (typeof epoch !== 'string' || epoch === '') return 'no-epoch';
  if (typeof receipt.action?.phase !== 'string') return 'no-phase';
  if (typeof receipt.action?.complexity !== 'number') return 'no-complexity';
  return null;
}

/**
 * Lifecycle phase for one spawn, or NULL when nothing supports either answer.
 *
 * Three sources, in order, and the third one is the reason this function
 * exists as a named thing instead of a ternary:
 *   1. `derivePhase(role)` — the payload named a real `resolveModel` role.
 *   2. the action class — `review` and `architecture` ARE review-phase actions,
 *      so a class is evidence about the phase.
 *   3. nothing. `factors.source === 'default'` is the classifier stating that
 *      NO signal identified the action: not the command table, not the agent
 *      table, not the text, not the tool/file footprint. Its `implement` is a
 *      safe FALLBACK CLASS, not an observation, so it cannot be read as
 *      evidence of a build phase.
 *
 * Case 3 returns null and the caller then skips the ledger append with
 * `skipped:no-phase`, because `route-receipt.schema.json` requires
 * `action.phase`. That is the same rule the other fields already follow: when
 * the value is not known, record the gap and skip — never invent one. The
 * previous form of this code answered `'build'` here, which put a fabricated
 * phase into an append-only ledger where it was indistinguishable from a
 * measured one (T-50 §4).
 *
 * @param {string} agentRole - Role from the payload
 * @param {object} classified - `classifyAction` result
 * @returns {'build'|'review'|null} The phase, or null when unevidenced
 */
function spawnPhase(agentRole, classified) {
  const fromRole = derivePhase(agentRole);
  if (fromRole !== null) return fromRole;
  if (REVIEW_ACTION_CLASSES.has(classified?.actionClass)) return 'review';
  if (classified?.factors?.source === 'default') return null;
  return 'build';
}

/**
 * Build the shadow RouteReceipt for one spawn.
 *
 * `role` is deliberately NOT handed to `routeModel`: it would flow into
 * `resolveModel(agentType, {role})` and make `models.selected` describe a role
 * the hook invented. Only `phase` (a classification field) is supplied, so
 * `models.selected` stays equal to the `canonicalModel` the hook records.
 *
 * @param {object} ctx - See {@link observeRoute}
 * @returns {{ receipt: object|null, reason: string|null }}
 */
function buildRouteReceipt(ctx) {
  const text = extractActionText(ctx.hookData);
  if (text === null) return { receipt: null, reason: 'no-action-text' };
  const input = { text, agentType: ctx.agentType, role: ctx.agentRole };
  const classifierOptions = { classifyComplexity };
  const classified = classifyAction(input, classifierOptions);
  const timestamp = new Date().toISOString();
  const evidence = {
    route_receipt_id: `rr-${ctx.agentId}-${timestamp}`,
    mission_id: ctx.missionId,
    session_id: ctx.sessionId,
    execution_profile_version: PROFILE_VERSION,
    timestamp,
    // The production line this shadow mirrors: the spawn-ledger record for
    // this agent. A spawn has no ledger seq, so the spawn identity is what
    // pairs the two sides.
    shadow_of: `spawn:${ctx.agentId}`,
  };
  if (ctx.taskId !== null) evidence.task_id = ctx.taskId;
  const receipt = routeModel({
    agentType: ctx.agentType,
    epoch: ctx.agentId,
    config: ctx.config,
    phase: spawnPhase(ctx.agentRole, classified),
    input,
    classifierOptions,
    evidence,
  });
  return { receipt, reason: null };
}

/**
 * Record one `route.selected` line and report what the spawn record should
 * carry. NEVER throws: every failure becomes a `skipped:<reason>` string and
 * the hook's stdout is untouched either way.
 *
 * @param {object} ctx - `{ hookData, agentId, agentType, agentRole, sessionId,
 *   missionId, taskId, projectRoot, config }`
 * @returns {{ recommendedModel: string|null, actionClass: string|null,
 *   routeLedger: string }}
 */
function observeRoute(ctx) {
  const base = {
    recommendedModel: null,
    actionClass: getActionClassForAgent(ctx.agentType),
    routeLedger: 'skipped:unknown',
  };
  const skip = (reason) => ({
    ...base, routeLedger: `skipped:${String(reason).slice(0, REASON_MAX)}`,
  });
  try {
    if (typeof ctx.agentId !== 'string' || ctx.agentId === '') return skip('no-epoch');
    if (typeof ctx.sessionId !== 'string' || ctx.sessionId === '') return skip('no-session');
    if (ctx.missionId === null) return skip('no-mission');
    const { receipt, reason } = buildRouteReceipt(ctx);
    if (receipt === null) return skip(reason);
    const observed = {
      recommendedModel: receipt.models?.recommended?.model_id ?? null,
      actionClass: receipt.action?.type ?? base.actionClass,
    };
    const gap = receiptGap(receipt);
    if (gap !== null) return { ...observed, routeLedger: `skipped:${gap}` };
    if (ctx.projectRoot === null) return { ...observed, routeLedger: 'skipped:no-cwd' };
    const envelope = {
      event: 'route.selected',
      session_id: ctx.sessionId,
      mission_id: ctx.missionId,
      routing_epoch_id: ctx.agentId,
      source: LEDGER_SOURCE,
      data: receipt,
    };
    if (ctx.taskId !== null) envelope.task_id = ctx.taskId;
    const result = appendLedgerEvent(ctx.projectRoot, envelope);
    if (result?.ok === true) return { ...observed, routeLedger: 'ok' };
    const why = String(result?.reason ?? 'append-failed').slice(0, REASON_MAX);
    return { ...observed, routeLedger: `skipped:${why}` };
  } catch (err) {
    return skip(err?.message || 'route-failed');
  }
}

/**
 * Elapsed ms since a tracked agent's `startedAt` (ISO string written on
 * `start`). Undefined when the agent was never tracked or the stamp is unusable.
 * @param {object|undefined} tracked - `state.agents[agentId]` entry
 * @param {number} [nowMs=Date.now()]
 * @returns {number|undefined}
 */
function spawnDurationMs(tracked, nowMs = Date.now()) {
  const startedMs = Date.parse(tracked?.startedAt ?? '');
  if (!Number.isFinite(startedMs)) return undefined;
  const d = nowMs - startedMs;
  return d >= 0 ? d : undefined;
}

function loadState() {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return { agents: {} };
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { agents: {} };
  }
}

function saveState(state) {
  const statePath = getStatePath();
  atomicWriteSync(statePath, state);
}

/**
 * Derive a deterministic teamId from session context. Stable for the
 * duration of one Claude Code session so team-weight rounds aggregate
 * under a single id.
 */
function deriveTeamId(hookData) {
  const sessionId = hookData?.session_id || hookData?.sessionId || null;
  return sessionId ? `team-${sessionId}` : `team-${Date.now()}`;
}

/**
 * Pick a coarse domain bucket from hook payload. Falls back to the
 * teammate role; finally to `general` so downstream GRPO bucketing has
 * a non-undefined key.
 */
function deriveDomain(hookData, agentRole) {
  return hookData?.domain || hookData?.agent_type || agentRole || 'general';
}

/**
 * Idempotent team-context initializer. Only writes top-level fields
 * (`teamId`, `domain`, `startedAt`) when missing or carrying stale
 * non-numeric `startedAt` left over from a previous session-end snapshot.
 * `startedAt` is stored as numeric ms — team-idle-handler computes
 * `Date.now() - teamState.startedAt`.
 */
function initTeamContext(loaded, hookData, agentRole) {
  const teamId = loaded.teamId ?? deriveTeamId(hookData);
  const domain = loaded.domain ?? deriveDomain(hookData, agentRole);
  const startedAt = typeof loaded.startedAt === 'number'
    ? loaded.startedAt
    : Date.now();
  return { teamId, domain, startedAt };
}

/**
 * SubagentStart: register the teammate, observe the routing decision, and
 * append the spawn record. Neither ledger write can affect registration or the
 * advisory message — both are best-effort and swallow every failure.
 *
 * @param {object} hookData - Parsed hook payload
 * @param {{agentId: string, agentRole: string, agentType: string, statePath: string}} ids
 * @returns {Promise<void>}
 */
async function handleStart(hookData, ids) {
  const { agentId, agentRole, agentType, statePath } = ids;
  const requestedModel = extractRequestedModel(hookData);
  const { canonicalModel, modelMismatch, config } = await checkModelPolicy(agentType, requestedModel);
  const sessionId = hookData?.session_id || hookData?.sessionId || null;
  const taskId = extractTaskId(hookData);
  const missionId = resolveMissionId(hookData, sessionId);
  const projectRoot = payloadProjectRoot(hookData);
  const route = observeRoute({
    hookData, agentId, agentType, agentRole, sessionId, missionId, taskId, config, projectRoot,
  });
  withFileLock(statePath, () => {
    const loaded = loadState();
    saveState({
      ...loaded,
      ...initTeamContext(loaded, hookData, agentRole),
      agents: {
        ...(loaded.agents || {}),
        [agentId]: {
          role: agentRole,
          agentType,
          active: true,
          startedAt: new Date().toISOString(),
          canonicalModel,
          modelMismatch,
          recommendedModel: route.recommendedModel,
          actionClass: route.actionClass,
        },
      },
    });
  });
  recordSpawn(hookData, projectRoot, {
    event: 'start', agentId, agentType, requestedModel, canonicalModel, modelMismatch,
    recommendedModel: route.recommendedModel,
    actionClass: route.actionClass,
    routing_epoch_id: agentId,
    depth: extractDepth(hookData),
    mission_id: missionId,
    ...(taskId === null ? {} : { task_id: taskId }),
    route_ledger: route.routeLedger,
  });
  let message = `[team] Agent registered: ${agentId} (${agentRole})`;
  if (modelMismatch) {
    message += `\n[model-policy] '${agentType}' spawned with ${requestedModel} but policy says ${canonicalModel}`;
  }
  writeStdout({ message });
}

/**
 * SubagentStop: deregister the teammate and append the stop record. No
 * `route.selected` line is written here — a routing decision belongs to the
 * START of an epoch, and one epoch must not produce two.
 *
 * @param {object} hookData - Parsed hook payload
 * @param {{agentId: string, agentType: string, statePath: string}} ids
 * @returns {void}
 */
function handleStop(hookData, ids) {
  const { agentId, agentType, statePath } = ids;
  let tracked;
  withFileLock(statePath, () => {
    const loaded = loadState();
    const existing = (loaded.agents || {})[agentId];
    tracked = existing;
    saveState(existing
      ? {
          ...loaded,
          agents: {
            ...(loaded.agents || {}),
            [agentId]: { ...existing, active: false, stoppedAt: new Date().toISOString() },
          },
        }
      : loaded);
  });
  const taskId = extractTaskId(hookData);
  const sessionId = hookData?.session_id || hookData?.sessionId || null;
  recordSpawn(hookData, payloadProjectRoot(hookData), {
    event: 'stop',
    agentId,
    agentType: tracked?.agentType ?? agentType,
    canonicalModel: tracked?.canonicalModel ?? null,
    modelMismatch: tracked?.modelMismatch === true,
    durationMs: spawnDurationMs(tracked),
    recommendedModel: tracked?.recommendedModel ?? null,
    actionClass: tracked?.actionClass ?? null,
    routing_epoch_id: agentId,
    depth: extractDepth(hookData),
    mission_id: resolveMissionId(hookData, sessionId),
    ...(taskId === null ? {} : { task_id: taskId }),
  });
  writeStdout({ message: `[team] Agent deregistered: ${agentId}` });
}

export async function main() {
  const action = process.argv[2]; // 'start' or 'stop'
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const agentId = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData);
  const agentType = hookData?.agent_type || agentRole;

  const statePath = getStatePath();
  // Best-effort: sweep orphan `.tmp.<pid>` files (>1min old) that prior
  // crashes or EPERM failures may have left in ~/.claude/.
  cleanupStaleStateTmpFiles(statePath);

  const ids = { agentId, agentRole, agentType, statePath };
  if (action === 'start') {
    await handleStart(hookData, ids);
  } else if (action === 'stop') {
    handleStop(hookData, ids);
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('subagent-handler', { exit: true }));
}
