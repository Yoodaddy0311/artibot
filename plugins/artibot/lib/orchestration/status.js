/**
 * Task status state machine.
 * Fine-grained lifecycle states for orchestrated tasks with strict transition rules.
 *
 * @module lib/orchestration/status
 */

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

/** All valid task statuses */
export const STATUS = Object.freeze({
  PENDING: 'PENDING',
  WAITING_ON_DEPS: 'WAITING_ON_DEPS',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  ERROR: 'ERROR',
  KILLED: 'KILLED',
  SKIPPED: 'SKIPPED',
});

// ---------------------------------------------------------------------------
// Transition rules
// ---------------------------------------------------------------------------

/**
 * Valid state transitions.
 * Maps each status to the set of statuses it can transition to.
 */
const VALID_TRANSITIONS = Object.freeze({
  [STATUS.PENDING]: [STATUS.WAITING_ON_DEPS, STATUS.RUNNING, STATUS.SKIPPED],
  [STATUS.WAITING_ON_DEPS]: [STATUS.RUNNING, STATUS.SKIPPED],
  [STATUS.RUNNING]: [STATUS.SUCCESS, STATUS.FAILURE, STATUS.ERROR, STATUS.KILLED],
  [STATUS.SUCCESS]: [],
  [STATUS.FAILURE]: [],
  [STATUS.ERROR]: [],
  [STATUS.KILLED]: [],
  [STATUS.SKIPPED]: [],
});

/** Terminal statuses (no further transitions allowed) */
const TERMINAL_STATUSES = Object.freeze(
  new Set([STATUS.SUCCESS, STATUS.FAILURE, STATUS.ERROR, STATUS.KILLED, STATUS.SKIPPED]),
);

/** Statuses that can be cancelled (not yet terminal, not completed) */
const CANCELLABLE_STATUSES = Object.freeze(
  new Set([STATUS.PENDING, STATUS.WAITING_ON_DEPS, STATUS.RUNNING]),
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and perform a status transition.
 * Returns a new status value (never mutates input).
 *
 * @param {string} current - Current status
 * @param {string} next - Target status
 * @returns {string} The new status (same as `next`)
 * @throws {Error} If either status is invalid or the transition is not allowed
 */
export function transition(current, next) {
  const allStatuses = Object.values(STATUS);

  if (!allStatuses.includes(current)) {
    throw new Error(
      `Invalid current status: "${current}". Valid: ${allStatuses.join(', ')}`,
    );
  }
  if (!allStatuses.includes(next)) {
    throw new Error(
      `Invalid target status: "${next}". Valid: ${allStatuses.join(', ')}`,
    );
  }

  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new Error(
      `Invalid transition: ${current} -> ${next}. `
      + `Allowed from ${current}: ${allowed.join(', ') || 'none (terminal state)'}`,
    );
  }

  return next;
}

/**
 * Check whether a status is terminal (no further transitions possible).
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Check whether a task in the given status can be cancelled.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function canCancel(status) {
  return CANCELLABLE_STATUSES.has(status);
}

/**
 * Get allowed transitions from a given status.
 *
 * @param {string} status
 * @returns {string[]}
 */
export function allowedTransitions(status) {
  const allowed = VALID_TRANSITIONS[status];
  if (!allowed) {
    throw new Error(`Invalid status: "${status}"`);
  }
  return [...allowed];
}
