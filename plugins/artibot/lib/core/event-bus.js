/**
 * In-memory, per-process event bus for fire-and-forget observability signals.
 *
 * SCOPE & CONTRACT (read before adding emit calls):
 * - Per-process only. Each hook / runtime invocation is a separate short-lived
 *   Node process, so listeners registered in one process never see emits from
 *   another. This bus does NOT carry data across prompts, hooks, or sessions.
 * - Fire-and-forget. `emit()` to a type with no subscriber is an intentional
 *   no-op (returns 0), not an error. Producers must not assume delivery.
 * - Not for session-level aggregation. Cross-prompt/session stats must be
 *   persisted to disk (see runtime/token-usage-session.json) — the in-memory
 *   bus cannot survive process exit.
 *
 * A subscriber must be instantiated in the SAME process as the producer to
 * receive events (e.g. an observability sink attached within preparePrompt()).
 *
 * @module lib/core/event-bus
 */

/** @type {Map<string, Set<Function>>} */
let listeners = new Map();

/** @type {Map<string, any>} */
let lastEvents = new Map();

/**
 * Subscribe to an event type.
 * @param {string} eventType
 * @param {Function} handler - (data) => void
 * @returns {{ unsubscribe: () => void }}
 */
export function on(eventType, handler) {
  if (typeof eventType !== 'string' || !eventType) {
    throw new TypeError('eventType must be a non-empty string');
  }
  if (typeof handler !== 'function') {
    throw new TypeError('handler must be a function');
  }

  if (!listeners.has(eventType)) {
    listeners.set(eventType, new Set());
  }
  listeners.get(eventType).add(handler);

  return {
    unsubscribe() {
      const set = listeners.get(eventType);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          listeners.delete(eventType);
        }
      }
    },
  };
}

/**
 * Emit an event to all subscribers.
 * @param {string} eventType
 * @param {any} data
 * @returns {number} Number of handlers invoked
 */
export function emit(eventType, data) {
  if (typeof eventType !== 'string' || !eventType) {
    throw new TypeError('eventType must be a non-empty string');
  }

  // Store a frozen copy for replay (preserve immutability for objects)
  const snapshot = data !== null && typeof data === 'object'
    ? Object.freeze({ ...data })
    : data;
  lastEvents.set(eventType, snapshot);

  const set = listeners.get(eventType);
  if (!set || set.size === 0) {
    return 0;
  }

  let count = 0;
  for (const handler of set) {
    try {
      handler(snapshot);
      count += 1;
    } catch (err) {
      process.stderr.write(
        `[event-bus] handler error on "${eventType}": ${err?.message ?? err}\n`,
      );
    }
  }

  return count;
}

/**
 * Get the last emitted event data for a type.
 * @param {string} eventType
 * @returns {any | undefined}
 */
export function getLastEvent(eventType) {
  return lastEvents.get(eventType);
}

/**
 * Remove all listeners and clear event cache.
 */
export function reset() {
  listeners = new Map();
  lastEvents = new Map();
}

/**
 * Get event bus statistics.
 * @returns {{ eventTypes: number, totalListeners: number, cachedEvents: number }}
 */
export function getStats() {
  let totalListeners = 0;
  for (const set of listeners.values()) {
    totalListeners += set.size;
  }

  return {
    eventTypes: listeners.size,
    totalListeners,
    cachedEvents: lastEvents.size,
  };
}
