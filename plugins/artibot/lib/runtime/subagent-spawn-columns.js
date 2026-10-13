/**
 * Spawn-ledger columns of a SubagentStart / SubagentStop: what the hook derives from the
 * host's own files and from the entry a START replaces, kept apart from the hook so each
 * rule can be read and tested without running one.
 *
 *   - depth and parent  : the payload's depth, else the host's `agent-<id>.meta.json`
 *   - served model/tier : the last real assistant turn of the subagent transcript, and
 *                         `servedDrift` against the policy tier
 *   - policy columns    : carried over a resume START (`carryPolicyColumns`)
 *   - durationMs        : `spawnDurationMs`
 *
 * Extracted from `scripts/hooks/subagent-handler.js` (973 lines against the 800-line cap)
 * with the bodies unchanged; the hook re-exports the names its tests import. Not a hook:
 * nothing here runs on import. Every reader of a host file is best-effort and never throws.
 *
 * @module lib/runtime/subagent-spawn-columns
 */

import { readFileSync, statSync } from 'node:fs';
// Static, so Start pays it too: 2.5-4.2 ms marginal after the rest of the graph (N=5, 2026-10-13).
import { resolveModelIdentity } from '../economics/usage-receipt.js';
import { readNdjsonTail } from './ledger-tail.js';

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
export function extractDepth(hookData) {
  const candidates = [
    hookData?.depth, hookData?.agent_depth, hookData?.nesting_depth, hookData?.tool_input?.depth,
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

/**
 * `depth_source` of a depth read from the host's meta file. The host counts an
 * in-process teammate as 0, the design canon (section 7.2, max_depth row) as 1:
 * the number is recorded UNCHANGED and this label says whose it is.
 * @type {string}
 */
export const HOST_META_SOURCE = 'host-meta';

/** A meta file is a few hundred bytes; a larger one is not read. @type {number} */
export const HOST_META_MAX_BYTES = 65536;

/**
 * Depth and parent from the host-written `agent-<id>.meta.json` beside the
 * subagent transcript (`agent_transcript_path` is `agent-<id>.jsonl`). An
 * UNDOCUMENTED file, so every failure is "no value": missing or oversize, garbled
 * or non-object JSON, renamed keys, wrong types. Only `spawnDepth` and
 * `parentAgentId` leave this function, by name (frozen key names:
 * `tests/hooks/fixtures/host-files/SubagentMeta.json`). The file appears ~1 s
 * AFTER SubagentStart (R7 recon, 3/3), so only Stop reads it. Never throws.
 * @param {unknown} transcriptPath - `agent_transcript_path` of a SubagentStop payload
 * @returns {{depth: number|null, parentAgentId: string|null}}
 */
export function readHostSubagentMeta(transcriptPath) {
  const none = { depth: null, parentAgentId: null };
  try {
    if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return none;
    const file = `${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`;
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > HOST_META_MAX_BYTES) return none;
    const meta = JSON.parse(readFileSync(file, 'utf-8'));
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return none;
    const parent = typeof meta.parentAgentId === 'string' ? meta.parentAgentId.trim() : '';
    return {
      depth: Number.isInteger(meta.spawnDepth) && meta.spawnDepth >= 0 ? meta.spawnDepth : null,
      parentAgentId: parent === '' ? null : parent.slice(0, 128),
    };
  } catch {
    return none;
  }
}

/**
 * The depth columns of a STOP row. A depth the payload itself carries wins and
 * stays unlabelled (its unit is unknown); otherwise the meta file's depth is used,
 * labelled {@link HOST_META_SOURCE}. An explicit null means "read, found nothing".
 * @param {object} hookData - Parsed SubagentStop payload
 * @returns {{depth: number|null, parent_agent_id: string|null, depth_source: string|null}}
 */
export function stopDepthFields(hookData) {
  const fromPayload = extractDepth(hookData);
  const meta = readHostSubagentMeta(hookData?.agent_transcript_path);
  const fromMeta = fromPayload === null && meta.depth !== null;
  return {
    depth: fromMeta ? meta.depth : fromPayload,
    parent_agent_id: meta.parentAgentId,
    depth_source: fromMeta ? HOST_META_SOURCE : null,
  };
}

/**
 * Tail of the subagent transcript read for its served model, in bytes: 512 KiB.
 *
 * MEASURED 2026-10-13 over 1,034 subagent transcripts under ~/.claude/projects (size
 * p50 1.3 MB, max 22.3 MB): the last real assistant line STARTS 10,098 B (p50),
 * 43,499 B (p99) and 146,974 B (max) before EOF; 65,536 B reaches it in 1,016 of the
 * 1,020 transcripts that have a real turn, 262,144 B in all 1,020. 512 KiB is 3.6x the
 * worst case and 2.8-3.2 ms p50 through `readNdjsonTail` (two runs, warm cache, Node 24,
 * Windows). A turn older than the window, or a line larger than it, is not found: the
 * answer is null, never a guess.
 * @type {number}
 */
export const SERVED_TAIL_BYTES = 524288;

/** The host's placeholder `message.model` on a record it wrote itself: not a served model. */
const SYNTHETIC_MODEL = '<synthetic>';

/** Longest served id kept on a row; the ledger writer scrubs string columns but caps none. */
const SERVED_MODEL_MAX = 128;

/**
 * The model the host SERVED a subagent: `message.model` of the last real assistant turn
 * of its transcript (`agent_transcript_path` of a SubagentStop payload) and that id's
 * catalog tier.
 *
 * Neither hook payload carries a model key (host 2.1.260 Start, 2.1.269 Stop), so START
 * cannot know and `canonicalModel` is policy. The host meta file's `model` is the REQUEST
 * (`sonnet`), and a request is not evidence of what ran, so it is not read. The tier goes
 * through `resolveModelIdentity`, the one transcript-id to tier resolver: it strips the
 * `[1m]` and `-YYYYMMDD` qualifiers transcripts append, where `tierForModelId` alone
 * answers null. An id the catalog does not name keeps its `servedModel` with a null tier
 * (1 of 1,034 transcripts: `claude-opus-4-8`).
 *
 * ONLY `message.model` LEAVES: a transcript holds prompts, file contents and paths. The
 * LAST turn wins (1 of 1,034 transcripts held two real ids); `<synthetic>` records
 * (interrupts, error notices) are scanned past. Never throws; null means "looked, found
 * no real turn".
 *
 * @param {unknown} transcriptPath - `agent_transcript_path` of a SubagentStop payload
 * @returns {{servedModel: string|null, servedTier: string|null}}
 */
export function readServedModel(transcriptPath) {
  const none = { servedModel: null, servedTier: null };
  try {
    if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return none;
    const records = readNdjsonTail(transcriptPath, { tailBytes: SERVED_TAIL_BYTES });
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const id = records[i]?.type === 'assistant' ? records[i]?.message?.model : null;
      if (typeof id !== 'string' || id.trim() === '' || id === SYNTHETIC_MODEL) continue;
      const servedModel = id.trim().slice(0, SERVED_MODEL_MAX);
      return { servedModel, servedTier: resolveModelIdentity(servedModel)?.tier ?? null };
    }
    return none;
  } catch {
    return none;
  }
}

/**
 * What a STOP adds to the START entry it read back: the served model and tier, and
 * `servedDrift`, whether the served tier is not the policy tier (`canonicalModel`,
 * left untouched). It is policy tier versus served tier, intended routes included,
 * NOT an error signal: a sonnet build teammate routed by `/model-routing` reads `true`
 * by design. Drift needs both tiers non-empty, so an untracked stop, an agent no policy
 * lists, or an id the catalog does not name is false ("cannot judge" and "same tier"
 * are both false; the tiers beside it tell them apart).
 *
 * `modelMismatch` is not returned and not touched: it keeps its START meaning
 * (requested model versus policy tier), so served drift never raises it.
 *
 * @param {object|undefined} tracked - `state.agents[agentId]` as the START left it
 * @param {{servedModel?: string|null, servedTier?: string|null}} [served] - {@link readServedModel} output
 * @returns {{servedModel: string|null, servedTier: string|null, servedDrift: boolean}}
 */
export function servedFields(tracked, served) {
  const { servedModel = null, servedTier = null } = served ?? {};
  const policy = tracked?.canonicalModel;
  const servedDrift = typeof policy === 'string' && policy !== ''
    && typeof servedTier === 'string' && servedTier !== ''
    && policy !== servedTier;
  return { servedModel, servedTier, servedDrift };
}

/**
 * The state entry of a stopped agent: the START entry, closed, plus what the STOP learned.
 * @param {object} existing - `state.agents[agentId]` as the START left it
 * @param {{servedModel?: string|null, servedTier?: string|null}} served - {@link readServedModel} output
 * @returns {object}
 */
export function stoppedEntry(existing, served) {
  return { ...existing, active: false, stoppedAt: new Date().toISOString(), ...servedFields(existing, served) };
}

/**
 * Elapsed ms since a tracked agent's `startedAt` (ISO string written on
 * `start`). Undefined when the agent was never tracked or the stamp is unusable.
 * @param {object|undefined} tracked - `state.agents[agentId]` entry
 * @param {number} [nowMs=Date.now()]
 * @returns {number|undefined}
 */
export function spawnDurationMs(tracked, nowMs = Date.now()) {
  const startedMs = Date.parse(tracked?.startedAt ?? '');
  if (!Number.isFinite(startedMs)) return undefined;
  const d = nowMs - startedMs;
  return d >= 0 ? d : undefined;
}

/** The START columns that come from the bind and describe the spawn, not the turn. */
const POLICY_COLUMNS = Object.freeze(['canonicalModel', 'recommendedModel', 'actionClass']);

const isText = (value) => typeof value === 'string' && value !== '';

/**
 * Whether a START is the resume (or redelivery) of the agent the state file already registers:
 * the entry holds the same `agentType` and this START names one. The one rule behind both
 * things a resume gets, so they cannot disagree about which agent this is: its policy columns
 * carry over ({@link carryPolicyColumns}) and its bind is skipped (`subagent-handler.js#bindRoute`).
 *
 * Identity is the agent type, non-empty on both sides: "both unknown" is not identity, and an
 * id reused by a different agent is another spawn (a host that cuts long teammate names to one
 * length hands two teammates one id; 3 START rows in this repo's spawn ledger, 2026-10-13). A
 * row that only `workflow-status.js` wrote has no `agentType`, so it never counts: that hook
 * runs on the same event and its row can exist before the first START.
 *
 * @param {object|undefined} previous - `state.agents[agentId]`
 * @param {string} agentType - `agent_type` of this START
 * @returns {boolean}
 */
export function isSameRegisteredAgent(previous, agentType) {
  return isText(agentType) && previous !== null && typeof previous === 'object'
    && previous.agentType === agentType;
}

/**
 * The policy columns of a START, each one this START could not compute taken from the
 * entry it replaces.
 *
 * A START for an id that is already registered is the host resuming the teammate (or
 * redelivering the hook), and it cannot recompute them: `bindRoute` answers
 * `skipped:already-bound` before it reads a receipt, and a teammate's `agent_type` is its
 * NAME, which no policy lists. The entry used to be replaced with nulls, so the next STOP
 * read back no policy tier and {@link servedFields} had nothing to compare. MEASURED
 * 2026-10-13 on this repo's spawn ledger: 335 of 814 agent ids have 2 or more START rows,
 * and of the 244 whose first START recorded a `canonicalModel`, 231 have a later START
 * row where it is null.
 *
 * Keyed on the registered entry ({@link isSameRegisteredAgent}), the same rule that skips the
 * bind of such a START, not on the ledger window. It never overrides a value the START
 * computed, never crosses to another `agentType` (an id reused by a different agent) and
 * invents nothing: a spawn that never had a tier stays null. `route_ledger` is not carried,
 * it says what THIS START did.
 *
 * @param {object|undefined} previous - `state.agents[agentId]` as the earlier START left it
 * @param {string} agentType - `agent_type` of this START
 * @param {{canonicalModel?: unknown, recommendedModel?: unknown, actionClass?: unknown}} [fresh]
 * @returns {{canonicalModel: string|null, recommendedModel: string|null, actionClass: string|null}}
 */
export function carryPolicyColumns(previous, agentType, fresh) {
  const same = isSameRegisteredAgent(previous, agentType);
  const out = {};
  for (const key of POLICY_COLUMNS) {
    if (isText(fresh?.[key])) out[key] = fresh[key];
    else out[key] = same && isText(previous[key]) ? previous[key] : null;
  }
  return out;
}
