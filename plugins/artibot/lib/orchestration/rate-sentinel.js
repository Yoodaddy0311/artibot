/**
 * Rate Limit Sentinel for Agent Teams parallel execution.
 * Tracks per-model RPM/TPM via sliding windows, auto-throttles at
 * configurable thresholds, and provides exponential backoff on 429 errors.
 *
 * @module lib/orchestration/rate-sentinel
 */

// ---------------------------------------------------------------------------
// SlidingWindow
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 60_000;

/**
 * 1-minute sliding window that tracks requests and token counts.
 * Entries older than windowMs are automatically trimmed on push/sum.
 */
export class SlidingWindow {
  /** @type {Array<{ timestamp: number, tokens: number }>} */
  #entries;
  #windowMs;
  #now;

  /**
   * @param {number} [windowMs=60000]
   * @param {object} [options]
   * @param {() => number} [options.now]
   */
  constructor(windowMs = DEFAULT_WINDOW_MS, options = {}) {
    this.#entries = [];
    this.#windowMs = windowMs;
    this.#now = options.now || Date.now;
  }

  /**
   * Add an entry to the window.
   * @param {number} timestamp
   * @param {number} [tokens=0]
   */
  push(timestamp, tokens = 0) {
    this.#trim(timestamp - this.#windowMs);
    this.#entries.push({ timestamp, tokens });
  }

  /**
   * Sum all entries within the current window.
   * @returns {{ requests: number, tokens: number }}
   */
  sum() {
    this.#trim(this.#now() - this.#windowMs);
    let requests = 0;
    let tokens = 0;
    for (const e of this.#entries) {
      requests++;
      tokens += e.tokens;
    }
    return Object.freeze({ requests, tokens });
  }

  /**
   * Remove entries older than the given timestamp.
   * @param {number} olderThan
   */
  #trim(olderThan) {
    let i = 0;
    while (i < this.#entries.length && this.#entries[i].timestamp < olderThan) {
      i++;
    }
    if (i > 0) this.#entries.splice(0, i);
  }

  /** @returns {number} */
  get length() {
    return this.#entries.length;
  }

  /** Clear all entries. */
  reset() {
    this.#entries = [];
  }
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  models: {
    opus: { rpm: 50, tpm: 100_000 },
    sonnet: { rpm: 100, tpm: 200_000 },
  },
  throttleAt: 0.8,
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 60_000,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeConfig(user) {
  const base = { ...DEFAULT_CONFIG, ...user };
  base.models = { ...DEFAULT_CONFIG.models, ...(user?.models || {}) };
  return Object.freeze(base);
}

function calcWaitMs(used, limit, windowMs) {
  if (limit <= 0) return 0;
  const fraction = used / limit;
  const remaining = Math.max(0, 1 - fraction);
  return remaining < 0.01 ? windowMs : Math.ceil(windowMs * (1 - remaining) * 0.5);
}

function clampDelay(baseDelay, attempt, maxDelay) {
  return Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
}

// ---------------------------------------------------------------------------
// createRateSentinel
// ---------------------------------------------------------------------------

/**
 * Create a Rate Limit Sentinel instance.
 *
 * @param {object} [config]
 * @returns {RateSentinel}
 */
export function createRateSentinel(config = {}) {
  const cfg = mergeConfig(config);
  const now = config.now || Date.now;
  const windowMs = DEFAULT_WINDOW_MS;

  /** @type {Map<string, SlidingWindow>} */
  const windows = new Map();

  /** @type {Map<string, number>} */
  const retryAttempts = new Map();

  function getWindow(model) {
    if (!windows.has(model)) {
      windows.set(model, new SlidingWindow(windowMs, { now }));
    }
    return windows.get(model);
  }

  function getLimits(model) {
    return cfg.models[model] || { rpm: 50, tpm: 100_000 };
  }

  return {
    acquire(model, estimatedTokens = 0) {
      const win = getWindow(model);
      const limits = getLimits(model);
      const { requests, tokens } = win.sum();

      const rpmThreshold = limits.rpm * cfg.throttleAt;
      if (requests >= rpmThreshold) {
        return Object.freeze({
          allowed: false,
          waitMs: calcWaitMs(requests, limits.rpm, windowMs),
          reason: 'rpm_throttle',
        });
      }

      const tpmThreshold = limits.tpm * cfg.throttleAt;
      if (tokens + estimatedTokens >= tpmThreshold) {
        return Object.freeze({
          allowed: false,
          waitMs: calcWaitMs(tokens + estimatedTokens, limits.tpm, windowMs),
          reason: 'tpm_throttle',
        });
      }

      return Object.freeze({ allowed: true, waitMs: 0, reason: null });
    },

    record(model, actualTokens = 0) {
      const win = getWindow(model);
      win.push(now(), actualTokens);
      retryAttempts.set(model, 0);
    },

    onError(model, statusCode) {
      if (statusCode !== 429) {
        return Object.freeze({ retryAfterMs: 0, attempt: 0, exhausted: false });
      }

      const prev = retryAttempts.get(model) || 0;
      const attempt = prev + 1;
      retryAttempts.set(model, attempt);

      if (attempt > cfg.maxRetries) {
        return Object.freeze({ retryAfterMs: 0, attempt, exhausted: true });
      }

      return Object.freeze({
        retryAfterMs: clampDelay(cfg.baseDelay, attempt, cfg.maxDelay),
        attempt,
        exhausted: false,
      });
    },

    getCapacity(model) {
      const win = getWindow(model);
      const limits = getLimits(model);
      const { requests, tokens } = win.sum();

      const rpmPct = limits.rpm > 0 ? requests / limits.rpm : 0;
      const tpmPct = limits.tpm > 0 ? tokens / limits.tpm : 0;

      return Object.freeze({
        rpm: Object.freeze({
          used: requests,
          limit: limits.rpm,
          pct: Math.round(rpmPct * 10000) / 10000,
        }),
        tpm: Object.freeze({
          used: tokens,
          limit: limits.tpm,
          pct: Math.round(tpmPct * 10000) / 10000,
        }),
      });
    },

    reset() {
      for (const win of windows.values()) win.reset();
      windows.clear();
      retryAttempts.clear();
    },
  };
}
