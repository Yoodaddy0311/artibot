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
 * @param {string} agentType - The spawning agent's type
 * @param {string|null} requestedModel - Model explicitly requested in the payload
 * @returns {Promise<{ canonicalModel: string|null, modelMismatch: boolean }>}
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
      return { canonicalModel: null, modelMismatch: false };
    }
    const canonicalModel = resolveModel(agentType, {}, config);
    const modelMismatch = Boolean(requestedModel) && requestedModel !== canonicalModel;
    return { canonicalModel, modelMismatch };
  } catch {
    return { canonicalModel: null, modelMismatch: false };
  }
}

/**
 * Append one line to the project-local spawn ledger
 * (`<projectRoot>/.artibot/ledger/spawns.ndjson`). Best-effort audit surface
 * for fan-out counts and model-policy drift — must NEVER throw and never
 * touches stdout. The project root is resolved from the payload `cwd` the
 * same way session-ledger.mjs does (a mid-session `cd` must not fork the
 * ledger tree); without a `cwd` there is no trustworthy root, so the record
 * is skipped rather than guessed from process.cwd().
 *
 * @param {object} hookData - Parsed hook payload
 * @param {object} record - Spawn record fields (see spawn-ledger.js)
 * @returns {{ ok: boolean, reason?: string }}
 */
function recordSpawn(hookData, record) {
  try {
    const cwd = hookData?.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, reason: 'no-cwd' };
    return appendSpawn(resolveProjectRoot(cwd), {
      sessionId: hookData?.session_id || hookData?.sessionId || null,
      agentName: hookData?.agent_name || hookData?.name || null,
      ...record,
    });
  } catch (err) {
    return { ok: false, reason: err?.message || 'record-failed' };
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

  if (action === 'start') {
    const requestedModel = extractRequestedModel(hookData);
    const { canonicalModel, modelMismatch } = await checkModelPolicy(agentType, requestedModel);
    withFileLock(statePath, () => {
      const loaded = loadState();
      const teamCtx = initTeamContext(loaded, hookData, agentRole);
      const updatedState = {
        ...loaded,
        ...teamCtx,
        agents: {
          ...(loaded.agents || {}),
          [agentId]: {
            role: agentRole,
            agentType,
            active: true,
            startedAt: new Date().toISOString(),
            canonicalModel,
            modelMismatch,
          },
        },
      };
      saveState(updatedState);
    });
    recordSpawn(hookData, {
      event: 'start', agentId, agentType, requestedModel, canonicalModel, modelMismatch,
    });
    let message = `[team] Agent registered: ${agentId} (${agentRole})`;
    if (modelMismatch) {
      message += `\n[model-policy] '${agentType}' spawned with ${requestedModel} but policy says ${canonicalModel}`;
    }
    writeStdout({ message });
  } else if (action === 'stop') {
    let tracked;
    withFileLock(statePath, () => {
      const loaded = loadState();
      const existing = (loaded.agents || {})[agentId];
      tracked = existing;
      const updatedState = existing
        ? {
            ...loaded,
            agents: {
              ...(loaded.agents || {}),
              [agentId]: {
                ...existing,
                active: false,
                stoppedAt: new Date().toISOString(),
              },
            },
          }
        : loaded;
      saveState(updatedState);
    });
    recordSpawn(hookData, {
      event: 'stop',
      agentId,
      agentType: tracked?.agentType ?? agentType,
      canonicalModel: tracked?.canonicalModel ?? null,
      modelMismatch: tracked?.modelMismatch === true,
      durationMs: spawnDurationMs(tracked),
    });
    writeStdout({
      message: `[team] Agent deregistered: ${agentId}`,
    });
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('subagent-handler', { exit: true }));
}
