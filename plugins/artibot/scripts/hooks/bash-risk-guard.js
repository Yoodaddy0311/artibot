#!/usr/bin/env node
/**
 * Bash risk guard — PreToolUse hook.
 *
 * Wires lib/autopilot/safety.js#classifyRisk into the runtime Bash tool path
 * (audit ap-20260702 W-01: classifyRisk was defined + tested but never called
 * at runtime). For each Bash command:
 *   - `danger`  → block the call (PreToolUse blocking protocol).
 *   - `caution` → non-blocking warning surfaced via the `message` field.
 *   - `safe`    → stay silent (approve by omission).
 *
 * When a `danger` command is seen inside an autopilot-allowlisted repo with an
 * active session, the risk is best-effort recorded into that session's state
 * (severity='danger') so shouldPause() freezes the run on the next tick — this
 * is the runtime feeder for the previously-dead branch in safety.js (I-04).
 *
 * Fail-open contract: this is a supplementary guard layered on top of the
 * fail-closed dangerous-command guard in pre-bash.js. Any error in THIS hook
 * must never block the call — the catch handler intentionally omits a
 * blockReason so a hook crash approves by omission (never-throw, exit 0).
 *
 * @module scripts/hooks/bash-risk-guard
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';
import { classifyRisk } from '../../lib/autopilot/safety.js';
import { isMainEntry } from './_dispatcher-utils.js';

/** Max command length echoed back in a message/reason (avoid flooding output). */
const CMD_ECHO_MAX = 160;

/** Autopilot phases that are terminal or already frozen — skip risk recording. */
const INACTIVE_PHASES = new Set(['COMPLETED', 'ABORTED', 'PAUSED']);

/**
 * Truncate a command string for safe echoing in hook output.
 * @param {string} cmd
 * @returns {string}
 */
function echoCommand(cmd) {
  const s = String(cmd);
  return s.length > CMD_ECHO_MAX ? `${s.slice(0, CMD_ECHO_MAX)}…` : s;
}

/**
 * Pure classification of a hook payload. Returns the stdout envelope to emit,
 * or null to stay silent (approve). Only Bash calls are inspected — every
 * other tool passes through untouched so this hook never interferes with
 * Write/Edit/etc.
 *
 * @param {object} hookData - Parsed PreToolUse payload
 * @returns {{ decision?: string, reason?: string, message?: string, matchedId?: string }|null}
 */
export function evaluateBashRisk(hookData) {
  if (extractToolName(hookData) !== 'Bash') return null;

  const command = hookData?.tool_input?.command || '';
  if (!command) return null;

  const risk = classifyRisk({ command });

  if (risk.level === 'danger') {
    return {
      decision: 'block',
      matchedId: risk.matchedId,
      reason:
        `[artibot:bash-risk-guard] Dangerous command blocked: ${risk.reason} ` +
        `(matched: ${risk.matchedId}). Command: "${echoCommand(command)}".`,
    };
  }

  if (risk.level === 'caution') {
    return {
      message:
        `[artibot:bash-risk-guard] Caution: ${risk.reason} ` +
        `(matched: ${risk.matchedId}). Proceeding — verify this is intended.`,
    };
  }

  return null;
}

/**
 * Locate the most-recently-modified active autopilot session, or null.
 * "Active" = has a phase that is not terminal/paused. Best-effort; any error
 * yields null so the caller stays silent.
 *
 * @param {object} store - session-store module (listSessions/loadSession/getSessionPath)
 * @param {object} fs - node:fs (statSync)
 * @returns {object|null} session state
 */
export function findActiveSession(store, fs) {
  let best = null;
  let bestMtime = -Infinity;
  for (const id of store.listSessions()) {
    const state = store.loadSession(id);
    if (!state || !state.phase || INACTIVE_PHASES.has(state.phase)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(store.getSessionPath(id)).mtimeMs;
    } catch {
      /* missing/locked session file — leave mtime at 0 */
    }
    if (mtime >= bestMtime) {
      bestMtime = mtime;
      best = state;
    }
  }
  return best;
}

/**
 * Best-effort I-04 linkage: on a danger classification inside an
 * autopilot-allowlisted repo, record the risk into the active session so
 * shouldPause() can freeze the run. Never throws — linkage failure must not
 * affect the block decision.
 *
 * @param {object} hookData
 * @param {string} command
 */
async function recordDangerForActiveSession(hookData, command) {
  try {
    const cwd = hookData?.cwd || process.cwd();
    const { isAutopilotAllowed } = await import('../../lib/autopilot/repo-identity.js');
    if (!isAutopilotAllowed(cwd)) return; // capture-only gate (same as git-autopilot-guard)

    const store = await import('../../lib/autopilot/session-store.js');
    const fs = await import('node:fs');
    const active = findActiveSession(store, fs);
    if (!active) return;

    const { recordRiskEvent } = await import('../../lib/autopilot/engine-state.js');
    const risk = classifyRisk({ command });
    recordRiskEvent(active, {
      level: 'danger',
      reason: risk.reason,
      matchedId: risk.matchedId,
      command,
    });
  } catch {
    /* best-effort — never block or throw on linkage failure */
  }
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const result = evaluateBashRisk(hookData);
  if (!result) return; // safe / non-Bash / empty → approve by omission

  if (result.decision === 'block') {
    await recordDangerForActiveSession(hookData, hookData?.tool_input?.command || '');
    writeStdout({ decision: 'block', reason: result.reason });
    return;
  }

  if (result.message) {
    writeStdout({ message: result.message });
  }
}

// Only drive stdin when invoked as a hook child process — importing the module
// (unit tests) must not consume stdin. Fail-open: no blockReason is passed, so
// a hook error approves by omission.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('bash-risk-guard', { exit: true, writeStdout }));
}
