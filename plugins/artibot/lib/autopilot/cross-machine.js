/**
 * Cross-machine resume support for autopilot sessions.
 *
 * Solves the v4.8 sibling-PC drift bug (see MEMORY.md):
 * a session paused on machine A and resumed on machine B would silently
 * apply local checkpoints without first reconciling with the base branch
 * the other machine had advanced. This module:
 *
 *   - Stamps `state.machineId = hostname_username` on save (immutably).
 *   - Detects drift between the persisted machineId and the current host.
 *   - Returns the rebase command sequence as an ARRAY — caller decides
 *     whether to execute it (the orchestrator MAY skip in dry-run mode).
 *
 * DATA POLICY: this module computes commands; it never executes
 * `git fetch` / `git push` itself. Caller (engine.js) executes locally.
 *
 * @module lib/autopilot/cross-machine
 */

import os from 'node:os';

/**
 * Compute a stable machine identifier: `hostname_username`.
 * Both halves are sanitized so they survive JSON round-trip and filename
 * comparison. Falls back to literal `'unknown'` when either lookup throws.
 *
 * @returns {string}
 */
export function computeMachineId() {
  let host = 'unknown';
  let user = 'unknown';
  try {
    const h = os.hostname();
    if (typeof h === 'string' && h) host = sanitizeIdPart(h);
  } catch { /* keep default */ }
  try {
    const info = os.userInfo();
    if (info && typeof info.username === 'string' && info.username) {
      user = sanitizeIdPart(info.username);
    }
  } catch { /* keep default */ }
  return `${host}_${user}`;
}

/**
 * Restrict an id part to alnum/_/-/. so the joined machineId is safe in
 * filenames and JSON comparisons. Truncates to 64 chars per part.
 * @param {string} s
 * @returns {string}
 */
function sanitizeIdPart(s) {
  const cleaned = s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  return cleaned || 'unknown';
}

/**
 * Immutably stamp `machineId` on a state object. Returns a NEW state
 * reference — input is not mutated. Existing machineId is preserved
 * unless `opts.force` is true.
 *
 * @param {object} state
 * @param {{ force?: boolean, machineId?: string }} [opts]
 * @returns {object} new state
 */
export function recordMachineId(state, opts = {}) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('recordMachineId: state must be an object');
  }
  const next = { ...state };
  const incoming = typeof opts.machineId === 'string' && opts.machineId
    ? opts.machineId
    : computeMachineId();
  if (!next.machineId || opts.force === true) {
    next.machineId = incoming;
  }
  return next;
}

/**
 * Detect whether the persisted machineId differs from the current host.
 * Returns a structured drift report. `needsRebase` is the actionable bit
 * the orchestrator should branch on.
 *
 * @param {object} state
 * @param {{ machineId?: string }} [opts] - inject current id for tests
 * @returns {{
 *   driftedFrom: string|null,
 *   currentMachine: string,
 *   needsRebase: boolean,
 *   hasPriorMachine: boolean
 * }}
 */
export function detectMachineDrift(state, opts = {}) {
  const currentMachine = typeof opts.machineId === 'string' && opts.machineId
    ? opts.machineId
    : computeMachineId();
  if (!state || typeof state !== 'object') {
    return { driftedFrom: null, currentMachine, needsRebase: false, hasPriorMachine: false };
  }
  const prior = typeof state.machineId === 'string' && state.machineId ? state.machineId : null;
  if (!prior) {
    return { driftedFrom: null, currentMachine, needsRebase: false, hasPriorMachine: false };
  }
  if (prior === currentMachine) {
    return { driftedFrom: null, currentMachine, needsRebase: false, hasPriorMachine: true };
  }
  return { driftedFrom: prior, currentMachine, needsRebase: true, hasPriorMachine: true };
}

/**
 * Branch-name validator — alnum/_/-/.//, no leading dash. Mirrors the
 * conservative shape used by phase-diff isSafeSha but allows `/` for
 * `origin/main`-style refs.
 * @param {unknown} ref
 * @returns {boolean}
 */
function isSafeRef(ref) {
  return typeof ref === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$/.test(ref);
}

/**
 * Build the rebase command sequence for a drift recovery flow.
 *
 * Returns an ARRAY of `{ cmd: 'git', args: [...] }` records. The caller
 * decides whether to invoke them (dry-run mode may skip the fetch step).
 *
 * Default sequence: `git fetch <remote> <baseBranch>` then
 * `git rebase <remote>/<baseBranch>`. Both refs validated.
 *
 * @param {{ baseBranch?: string, remote?: string }} [opts]
 * @returns {Array<{ cmd: string, args: string[] }>}
 */
export function prepareRebase(opts = {}) {
  const remote = typeof opts.remote === 'string' && opts.remote ? opts.remote : 'origin';
  const baseBranch = typeof opts.baseBranch === 'string' && opts.baseBranch
    ? opts.baseBranch
    : 'main';
  if (!isSafeRef(remote) || !isSafeRef(baseBranch)) {
    throw new RangeError(`prepareRebase: unsafe ref (remote=${remote}, base=${baseBranch})`);
  }
  return [
    { cmd: 'git', args: ['fetch', remote, baseBranch] },
    { cmd: 'git', args: ['rebase', `${remote}/${baseBranch}`] },
  ];
}
