/**
 * Plugin Lifecycle Protocol.
 * Implements a state machine for plugin lifecycle management:
 *   init -> ready -> active -> shutdown
 *
 * States: UNINITIALIZED, INITIALIZING, READY, ACTIVE, SHUTTING_DOWN, STOPPED
 *
 * @module lib/core/lifecycle
 */

/** All valid lifecycle states */
export const STATES = Object.freeze({
  UNINITIALIZED: 'UNINITIALIZED',
  INITIALIZING: 'INITIALIZING',
  READY: 'READY',
  ACTIVE: 'ACTIVE',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  STOPPED: 'STOPPED',
});

/**
 * Valid state transitions.
 * Maps each state to the set of states it can transition to.
 */
const VALID_TRANSITIONS = Object.freeze({
  [STATES.UNINITIALIZED]: [STATES.INITIALIZING],
  [STATES.INITIALIZING]: [STATES.READY, STATES.STOPPED],
  [STATES.READY]: [STATES.ACTIVE, STATES.SHUTTING_DOWN],
  [STATES.ACTIVE]: [STATES.SHUTTING_DOWN, STATES.READY],
  [STATES.SHUTTING_DOWN]: [STATES.STOPPED],
  [STATES.STOPPED]: [],
});

/**
 * Create a new lifecycle state machine instance.
 *
 * @returns {{
 *   getState: () => string,
 *   transition: (newState: string) => { from: string, to: string, timestamp: string },
 *   onStateChange: (callback: Function) => () => void,
 *   getHistory: () => Array<{ from: string, to: string, timestamp: string }>,
 *   canTransition: (newState: string) => boolean,
 *   reset: () => void
 * }}
 * @example
 * const lc = createLifecycle();
 * lc.getState(); // 'UNINITIALIZED'
 * lc.transition('INITIALIZING');
 * lc.transition('READY');
 * lc.getState(); // 'READY'
 */
export function createLifecycle() {
  let currentState = STATES.UNINITIALIZED;
  const listeners = new Set();
  const history = [];

  /**
   * Get the current lifecycle state.
   * @returns {string}
   */
  function getState() {
    return currentState;
  }

  /**
   * Check whether a transition to the given state is valid.
   * @param {string} newState - Target state
   * @returns {boolean}
   */
  function canTransition(newState) {
    if (!Object.values(STATES).includes(newState)) {
      return false;
    }
    const allowed = VALID_TRANSITIONS[currentState];
    return allowed.includes(newState);
  }

  /**
   * Transition to a new state.
   * Throws if the transition is invalid.
   *
   * @param {string} newState - Target state
   * @returns {{ from: string, to: string, timestamp: string }}
   */
  function transition(newState) {
    if (!Object.values(STATES).includes(newState)) {
      throw new Error(`Invalid state: "${newState}". Valid states: ${Object.values(STATES).join(', ')}`);
    }

    if (!canTransition(newState)) {
      throw new Error(
        `Invalid transition: ${currentState} -> ${newState}. `
        + `Allowed transitions from ${currentState}: ${VALID_TRANSITIONS[currentState].join(', ') || 'none'}`,
      );
    }

    const from = currentState;
    currentState = newState;

    const entry = {
      from,
      to: newState,
      timestamp: new Date().toISOString(),
    };
    history.push(entry);

    for (const listener of listeners) {
      listener({ ...entry });
    }

    return { ...entry };
  }

  /**
   * Register a callback for state changes.
   * Returns an unsubscribe function.
   *
   * @param {Function} callback - (entry: { from: string, to: string, timestamp: string }) => void
   * @returns {() => void} Unsubscribe function
   */
  function onStateChange(callback) {
    if (typeof callback !== 'function') {
      throw new Error('onStateChange requires a function callback');
    }
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  /**
   * Get the full transition history.
   * @returns {Array<{ from: string, to: string, timestamp: string }>}
   */
  function getHistory() {
    return history.map((e) => ({ ...e }));
  }

  /**
   * Reset the state machine to UNINITIALIZED (for testing).
   */
  function reset() {
    currentState = STATES.UNINITIALIZED;
    history.length = 0;
    listeners.clear();
  }

  return { getState, transition, onStateChange, getHistory, canTransition, reset };
}

/** Singleton lifecycle instance for the plugin */
const defaultLifecycle = createLifecycle();

/**
 * Get the current plugin lifecycle state (singleton).
 * Convenience export for hook scripts.
 *
 * @returns {string}
 * @example
 * import { getCurrentState } from '../lib/core/lifecycle.js';
 * if (getCurrentState() !== 'ACTIVE') {
 *   console.error('Plugin is not active');
 * }
 */
export function getCurrentState() {
  return defaultLifecycle.getState();
}

export { defaultLifecycle };
