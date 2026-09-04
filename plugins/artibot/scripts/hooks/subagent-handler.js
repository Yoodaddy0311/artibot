#!/usr/bin/env node
/**
 * SubagentStart / SubagentStop hook.
 * Tracks teammate registration and deregistration.
 * Usage: node subagent-handler.js start|stop
 */

import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { cleanupStaleStateTmpFiles, createErrorHandler, extractAgentId, extractAgentRole, getStatePath } from '../../lib/core/hook-utils.js';
import { withFileLock } from '../../lib/core/file-lock.js';
import { getPolicyModel, resolveModel } from '../../lib/core/model-policy.js';
import { loadConfig } from '../../lib/core/config.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { appendSpawn } from '../../lib/learning/ledger/spawn-ledger.js';
import { getActionClassForAgent } from '../../lib/routing/action-classifier.js';
import { appendLedgerEvent, ledgerFilePath } from '../../lib/runtime/ledger.js';
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
 * The hydrated config is returned alongside because `loadConfig` is the one
 * expensive call on this hot path and a second, independently-loaded answer to
 * the same question is how two callers end up disagreeing about policy.
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
// v5 routing observation (T-31) — OBSERVE ONLY. STAGE 2 OF 2: THE BIND.
//
// Nothing in this block changes which model actually spawns. `checkModelPolicy`
// above remains the sole source of the advisory message and of
// `canonicalModel`; what follows TIES THIS SPAWN to the shadow RouteReceipt
// that `scripts/hooks/route-observe-pre.js` already wrote at PreToolUse, so a
// later phase can compare the recommendation against what really ran.
//
// WHY THE RECEIPT IS NO LONGER BUILT HERE. The SubagentStart payload carries
// no action text under any spelling (2.1.259 binary schema; re-measured live
// on 2.1.260 — top-level keys are agent_id, agent_type, cwd, hook_event_name,
// prompt_id, session_id, transcript_path). The old path therefore recorded
// `skipped:no-action-text` on 71/71 live spawns: a scoring pipeline with no
// input. The text exists on the PreToolUse `tool_input`, so the receipt is
// written there and this hook writes the JOIN — a second line, `route.bound`,
// never an update to the first (the ledger is append-only).
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
 * Envelope `source` for `route.bound` — and the value this hook MATCHES ON
 * when it scans for `route.selected` receipts: the TRUTH about who emitted the
 * line, which for both events is a hook. Not to be confused with the receipt's
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

/** Reason strings land on the spawn record; keep them short. @type {number} */
const REASON_MAX = 60;

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
 * How far back the receipt scan reads the ledger, in bytes.
 *
 * The unbound-receipt list is DERIVED FROM THE LEDGER ITSELF — there is no
 * side file holding pending receipts, because a second store of the same fact
 * is a second answer to one question (design §3, "별도 상태 파일을 두지
 * 않는다"). 128 KB is the design's stated bound: 32 candidate lines at the
 * 4 KB per-line cap. A receipt older than that window is simply not a
 * candidate, and the spawn records `skipped:unbound` — which is the honest
 * outcome, not a lost row.
 *
 * COST IS UNMEASURED. One tail read per spawn, bounded by this constant; no
 * profile has been taken.
 * @type {number}
 */
const RECEIPT_TAIL_BYTES = 131072;

/** Most unbound receipts considered for one spawn (design §2.2, N=32). */
const RECEIPT_CANDIDATES_MAX = 32;

/** How old a receipt may be and still be a candidate (design §2.2, 10 min). */
const RECEIPT_WINDOW_MS = 10 * 60 * 1000;

/**
 * `data.shadow_of` prefix that marks a receipt as one of OURS — written by
 * `route-observe-pre.js` for an Agent tool call. Receipts written by the
 * pre-4.55 SubagentStart path carry `spawn:<agentId>` instead and are NOT
 * bindable: they already name their spawn. Filtering on this is what keeps an
 * old ledger from being re-interpreted under the new scheme.
 * @type {string}
 */
const TOOL_USE_SHADOW_PREFIX = 'tool_use:';

/** Prefix of the correlation key `route-observe-pre.js#receiptKey` writes. */
const RECEIPT_KEY_PREFIX = 'route.pre:';

/**
 * Split `route.pre:<tool_use_id>:<prompt_id>:<subagent_type>` back into its
 * parts.
 *
 * The `tool_use_id` segment is redundant with the envelope's
 * `routing_epoch_id` and is kept precisely so the reader can CHECK it: a key
 * whose id disagrees with the line that carries it has been mangled, and a
 * mangled correlation key must not be used to correlate. Either payload
 * segment may be empty and comes back as null; `subagent_type` absorbs the
 * remainder because it is the one part that may contain a colon.
 *
 * @param {unknown} key - `idempotency_key` from the receipt envelope
 * @param {string} epoch - `routing_epoch_id` of the same line
 * @returns {{promptId: string|null, subagentType: string|null}}
 */
function parseReceiptKey(key, epoch) {
  const empty = { promptId: null, subagentType: null };
  if (typeof key !== 'string' || !key.startsWith(RECEIPT_KEY_PREFIX)) return empty;
  const rest = key.slice(RECEIPT_KEY_PREFIX.length);
  if (!rest.startsWith(`${epoch}:`)) return empty;
  const tail = rest.slice(epoch.length + 1);
  const cut = tail.indexOf(':');
  if (cut < 0) return { promptId: tail.length > 0 ? tail : null, subagentType: null };
  const promptId = tail.slice(0, cut);
  const subagentType = tail.slice(cut + 1);
  return {
    promptId: promptId.length > 0 ? promptId : null,
    subagentType: subagentType.length > 0 ? subagentType : null,
  };
}

/**
 * The comparable form of an agent identity: the last colon-separated segment,
 * so `artibot:code-reviewer` and `code-reviewer` are the same agent. Same
 * normalization `action-classifier.js#getActionClassForAgent` already applies,
 * on purpose — two different answers to "which agent is this" is how a bind
 * and a classification end up describing different agents.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function identityOf(value) {
  if (typeof value !== 'string') return null;
  const bare = value.trim().split(':').pop();
  return bare.length > 0 ? bare : null;
}

/**
 * The last {@link RECEIPT_TAIL_BYTES} of the project ledger, parsed.
 *
 * Reads a WINDOW, not the file: a ledger grows without bound and a spawn hook
 * must not grow with it. The first line of the window is dropped because a
 * byte-offset read almost always lands mid-line — parsing that fragment would
 * either throw (caught, but the whole tail lost) or, worse, succeed on a
 * truncated object. Never throws; an unreadable ledger yields `[]`.
 *
 * @param {string|null} projectRoot
 * @returns {object[]} Parsed lines in append order
 */
function readLedgerTail(projectRoot) {
  let fd = null;
  try {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) return [];
    const file = ledgerFilePath(projectRoot);
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    const start = size > RECEIPT_TAIL_BYTES ? size - RECEIPT_TAIL_BYTES : 0;
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, length, start);
    const raw = buf.toString('utf8').split('\n');
    if (start > 0) raw.shift();
    const out = [];
    for (const line of raw) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch { /* a corrupt line is skipped, not fatal */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}

/**
 * Reduce the ledger tail to the unbound receipts of ONE session.
 *
 * Invariant 1 of design §2.3 (1:1) is enforced here by construction rather
 * than reported after the fact: a `tool_use_id` that already appears on a
 * `route.bound` line is not a candidate, and an `agent_id` that already
 * appears there means this spawn is a replay and binds nothing.
 *
 * @param {object[]} lines - {@link readLedgerTail} output
 * @param {string} sessionId
 * @param {number} nowMs
 * @returns {{candidates: object[], boundAgents: Set<string>}}
 */
function collectReceipts(lines, sessionId, nowMs) {
  const boundToolUses = new Set();
  const boundAgents = new Set();
  const receipts = [];
  for (const line of lines) {
    if (line.session_id !== sessionId) continue;
    if (line.event === 'route.bound') {
      if (typeof line.data?.tool_use_id === 'string') boundToolUses.add(line.data.tool_use_id);
      if (typeof line.data?.agent_id === 'string') boundAgents.add(line.data.agent_id);
      continue;
    }
    if (line.event !== 'route.selected' || line.source !== LEDGER_SOURCE) continue;
    const epoch = line.routing_epoch_id;
    if (typeof epoch !== 'string' || epoch === '') continue;
    const shadowOf = line.data?.shadow_of;
    if (typeof shadowOf !== 'string' || !shadowOf.startsWith(TOOL_USE_SHADOW_PREFIX)) continue;
    const ts = Date.parse(line.ts);
    if (Number.isFinite(ts) && nowMs - ts > RECEIPT_WINDOW_MS) continue;
    const { promptId, subagentType } = parseReceiptKey(line.idempotency_key, epoch);
    receipts.push({
      toolUseId: epoch,
      promptId,
      subagentType,
      name: typeof line.worker === 'string' ? line.worker : null,
      actionClass: line.data?.action?.type ?? null,
      recommendedModel: line.data?.models?.recommended?.model_id ?? null,
    });
  }
  const candidates = receipts
    .filter((r) => !boundToolUses.has(r.toolUseId))
    .slice(-RECEIPT_CANDIDATES_MAX);
  return { candidates, boundAgents };
}

/**
 * Pick the receipt this spawn came from — design §2.2, in order, first hit wins.
 *
 * THE THREE TIERS AND WHAT EACH IS WORTH:
 *   1. `prompt_id` — present on 12/12 live rows (host 2.1.260). Same value
 *      means same prompt; it partitions the candidate pool, it never picks
 *      inside it. When it matches nothing the pool stays whole and the
 *      confidence is downgraded rather than the match refused.
 *   2. IDENTITY — the SubagentStart `agent_type` equals the receipt's `name`
 *      OR its `subagent_type`, both normalized past an `artibot:` prefix. Two
 *      spellings because the host uses BOTH, measured:
 *        · Agent-tool spawns report `agent_type === subagent_type`, even when
 *          the caller passed a name (host 2.1.260, 2026-09-04, 2/2 rows; 1/1
 *          of those had a name and still reported the type).
 *        · team / autopilot spawns report `agent_type === name` (1025-row
 *          census of this repo's `spawns.ndjson`: name-shaped values such as
 *          `team-handoff-9d6dc2-architect` dominate).
 *      The design (§2.1) recorded only the second and called a named spawn
 *      deterministic; the first is a correction from this limb's D2 burn.
 *      Matching on either is what keeps the tier deterministic on both paths.
 *      Same identity twice in one prompt is the failure mode, resolved as
 *      "most recent unbound", and its blast radius is small because the same
 *      identity is usually the same role.
 *   3. FIFO — unnamed spawns have nothing left to match on. The host was NOT
 *      verified to emit SubagentStart in tool_use order (fixture: relative
 *      order agreed in 3/3 scenarios but sibling order was never checked by
 *      content), so this tier is PROBABILISTIC and says so in `confidence`.
 *
 * The confidence vocabulary is three-valued (`exact` | `name` | `fifo`) where
 * the design wrote two (`exact` | `inferred`): `inferred` is split so the
 * deterministic-but-promptless case is countable apart from the guess. `exact`
 * still means exactly what the design says it means — tier 1 AND tier 2 both
 * hit — so the KPI numerator is unchanged.
 *
 * @param {object[]} candidates - {@link collectReceipts} output
 * @param {string|null} promptId - `prompt_id` from the SubagentStart payload
 * @param {string} agentType - `agent_type` from the same payload
 * @returns {{receipt: object, confidence: string, method: string}|null}
 */
function matchReceipt(candidates, promptId, agentType) {
  if (candidates.length === 0) return null;
  let pool = candidates;
  let promptMatched = false;
  if (promptId !== null) {
    const scoped = candidates.filter((c) => c.promptId === promptId);
    if (scoped.length > 0) {
      pool = scoped;
      promptMatched = true;
    }
  }
  const want = identityOf(agentType);
  const byName = want === null ? [] : pool.filter((c) => identityOf(c.name) === want);
  const byType = want === null ? [] : pool.filter((c) => identityOf(c.subagentType) === want);
  // `name` first: when the caller named the spawn, that name is the more
  // specific of the two identities (several spawns can share a subagent_type
  // inside one prompt; two spawns sharing a name is the rarer accident).
  const named = byName.length > 0 ? byName : byType;
  if (named.length > 0) {
    return {
      receipt: named[named.length - 1],
      confidence: promptMatched ? 'exact' : 'name',
      method: promptMatched ? 'prompt_id+name' : 'name-only',
      matchedOn: byName.length > 0 ? 'name' : 'subagent_type',
    };
  }
  return {
    receipt: pool[0],
    confidence: 'fifo',
    method: promptMatched ? 'prompt_id+fifo' : 'fifo-only',
    matchedOn: null,
  };
}

/**
 * Tie one spawn to the receipt `route-observe-pre.js` wrote at PreToolUse, and
 * record that binding as a `route.bound` line.
 *
 * NO RECEIPT IS BUILT HERE ANY MORE. The SubagentStart payload carries no
 * action text under any spelling — measured against the 2.1.259 binary and
 * again live on 2.1.260 — so the old path scored nothing and wrote
 * `skipped:no-action-text` on 71/71 live spawns. The text lives on the
 * PreToolUse payload; this hook's job is the join.
 *
 * NEVER THROWS: every failure becomes a `skipped:<reason>` string and the
 * hook's stdout is untouched either way.
 *
 * @param {object} ctx - `{ hookData, agentId, agentType, sessionId, missionId,
 *   taskId, projectRoot, canonicalModel }`
 * @returns {{ recommendedModel: string|null, actionClass: string|null,
 *   routeLedger: string }}
 */
/**
 * Kept under the pre-L2-D1 name on purpose. `commands/scorecard.md` cites
 * `subagent-handler.js#observeRoute`; the citation gate (tests/firewall/
 * citation-resolution) requires the symbol to exist and the command-doc gate
 * (tests/scorecard/command-doc) forbids deleting that line. The receipt itself
 * now lives in route-observe-pre.js (PreToolUse); this hook only BINDS.
 * Reconciled 2026-09-04 during the v5 2nd-batch integration (leader decision).
 * @param {object} ctx
 * @returns {ReturnType<typeof bindRoute>}
 */
function observeRoute(ctx) {
  return bindRoute(ctx);
}

function bindRoute(ctx) {
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
    if (ctx.projectRoot === null) return skip('no-cwd');

    const { candidates, boundAgents } = collectReceipts(
      readLedgerTail(ctx.projectRoot), ctx.sessionId, Date.now(),
    );
    if (boundAgents.has(ctx.agentId)) return skip('already-bound');
    const promptId = typeof ctx.hookData?.prompt_id === 'string' && ctx.hookData.prompt_id !== ''
      ? ctx.hookData.prompt_id
      : null;
    const match = matchReceipt(candidates, promptId, ctx.agentType);
    // No candidate is a NORMAL outcome, not a defect: a spawn that never went
    // through the Agent tool (SDK / scheduler / loop entry) has no receipt to
    // bind, and so does one whose receipt fell out of the 10-minute window.
    if (match === null) return { ...base, routeLedger: 'skipped:unbound' };

    const observed = {
      recommendedModel: match.receipt.recommendedModel ?? null,
      actionClass: match.receipt.actionClass ?? base.actionClass,
    };
    const data = {
      tool_use_id: match.receipt.toolUseId,
      agent_id: ctx.agentId,
      confidence: match.confidence,
      method: match.method,
    };
    if (typeof ctx.agentType === 'string' && ctx.agentType !== '') data.agent_type = ctx.agentType;
    // WHICH of the two identity spellings matched. Without it, `confidence:
    // 'exact'` cannot be audited against the host behaviour it assumes.
    if (match.matchedOn !== null) data.matched_on = match.matchedOn;
    // The receipt's `models.selected` was a PREDICTION from `subagent_type`;
    // this is the policy answer for the agent that actually spawned. Where the
    // two disagree, the correlation picked the wrong receipt or the prediction
    // was wrong — either way the pair is what makes that visible.
    if (typeof ctx.canonicalModel === 'string') data.selected_model = ctx.canonicalModel;
    if (observed.recommendedModel !== null) data.recommended_model = observed.recommendedModel;
    if (typeof observed.actionClass === 'string') data.action_class = observed.actionClass;

    const envelope = {
      event: 'route.bound',
      session_id: ctx.sessionId,
      mission_id: ctx.missionId,
      // The epoch is now the spawn (decision G1); the receipt's temporary
      // `tool_use_id` epoch is preserved inside `data`.
      routing_epoch_id: ctx.agentId,
      run_id: ctx.agentId,
      action_id: match.receipt.toolUseId,
      source: LEDGER_SOURCE,
      data,
    };
    if (ctx.taskId !== null) envelope.task_id = ctx.taskId;

    const result = appendLedgerEvent(ctx.projectRoot, envelope);
    if (result?.ok === true) return { ...observed, routeLedger: 'ok:bound' };
    const why = String(result?.reason ?? 'append-failed').slice(0, REASON_MAX);
    return { ...observed, routeLedger: `skipped:${why}` };
  } catch (err) {
    return skip(err?.message || 'bind-failed');
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
  const { canonicalModel, modelMismatch } = await checkModelPolicy(agentType, requestedModel);
  const sessionId = hookData?.session_id || hookData?.sessionId || null;
  const taskId = extractTaskId(hookData);
  const missionId = resolveMissionId(hookData, sessionId);
  const projectRoot = payloadProjectRoot(hookData);
  const route = observeRoute({
    hookData, agentId, agentType, sessionId, missionId, taskId, projectRoot, canonicalModel,
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
