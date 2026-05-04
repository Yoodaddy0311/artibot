/**
 * Loop Detector: Detects repetitive tool call patterns.
 *
 * Monitors tool call history using a circular buffer and identifies
 * when an agent is stuck in a loop calling the same tool with the
 * same arguments repeatedly. This prevents token waste from infinite
 * loop patterns.
 *
 * Detection strategies:
 *   - Consecutive identical calls (3 = warn, 5 = block)
 *   - Non-consecutive frequency (7 of last 10 = warn)
 *
 * @module lib/cognitive/loop-detector
 */

// ---------------------------------------------------------------------------
// Constants (defaults)
// ---------------------------------------------------------------------------

/** Default maximum history entries (circular buffer size) */
const DEFAULT_MAX_HISTORY = 20;

/** Default consecutive identical calls to trigger warn */
const DEFAULT_WARN_THRESHOLD = 3;

/** Default consecutive identical calls to trigger block */
const DEFAULT_BLOCK_THRESHOLD = 5;

/** Window size for non-consecutive frequency check */
const FREQUENCY_WINDOW = 10;

/** Frequency count within window to trigger warn */
const FREQUENCY_THRESHOLD = 7;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute a simple hash of tool arguments for comparison.
 * Uses string representation — sufficient for duplicate detection.
 *
 * @param {*} args - Tool call arguments
 * @returns {string} Hash string
 */
function hashArgs(args) {
  if (args === undefined || args === null) return 'null';
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * Build a fingerprint tuple key from tool name, args, and optional step context.
 * When stepId is provided, the fingerprint is scoped to that step,
 * preventing false positives during multi-step reasoning iterations.
 *
 * @param {string} toolName - Name of the tool
 * @param {*} args - Tool call arguments
 * @param {string} [stepId] - Optional step ID for multi-step loop isolation
 * @returns {string} Fingerprint key
 */
function buildFingerprint(toolName, args, stepId) {
  const base = `${toolName || ''}::${hashArgs(args)}`;
  return stepId ? `${stepId}::${base}` : base;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LoopDetectorConfig
 * @property {number} [maxHistory=20] - Circular buffer size
 * @property {number} [warnThreshold=3] - Consecutive identical calls for warn
 * @property {number} [blockThreshold=5] - Consecutive identical calls for block
 * @property {Array<{ tool: string, fingerprint: string }>} [initialHistory] - Pre-seed history for state restoration
 */

/**
 * @typedef {object} LoopDetectionResult
 * @property {boolean} detected - Whether a loop was detected
 * @property {'none'|'warn'|'block'} severity - Severity level
 * @property {number} count - Number of repetitions found
 * @property {string} [fingerprint] - The repeated fingerprint (when detected)
 */

/**
 * @typedef {object} LoopDetector
 * @property {(toolCall: { tool: string, args?: * }) => LoopDetectionResult} detectLoop
 * @property {() => ReadonlyArray<{ tool: string, fingerprint: string }>} getLoopHistory
 * @property {() => void} resetHistory
 */

/**
 * Create a new loop detector instance.
 *
 * @param {LoopDetectorConfig} [config] - Configuration overrides
 * @returns {LoopDetector} Loop detector instance
 * @example
 * const detector = createLoopDetector({ warnThreshold: 2 });
 * const result = detector.detectLoop({ tool: 'Read', args: { file: 'a.js' } });
 * if (result.detected) console.warn('Loop detected:', result.severity);
 */
export function createLoopDetector(config = {}) {
  const maxHistory = config.maxHistory ?? DEFAULT_MAX_HISTORY;
  const warnThreshold = config.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
  const blockThreshold = config.blockThreshold ?? DEFAULT_BLOCK_THRESHOLD;

  /** @type {Array<{ tool: string, fingerprint: string }>} */
  let history = Array.isArray(config.initialHistory)
    ? config.initialHistory.slice(-maxHistory)
    : [];

  /**
   * Record a tool call and check for loop patterns.
   *
   * @param {{ tool: string, args?: *, stepId?: string }} toolCall - The tool call to check.
   *   When stepId is provided, the fingerprint is scoped to that step,
   *   isolating multi-step reasoning iterations from triggering false positives.
   * @returns {LoopDetectionResult}
   */
  function detectLoop(toolCall) {
    const tool = toolCall.tool || '';
    const fingerprint = buildFingerprint(tool, toolCall.args, toolCall.stepId);

    // Append to circular buffer (immutable: create new array)
    const entry = Object.freeze({ tool, fingerprint });
    const newHistory = [...history, entry];
    history = newHistory.length > maxHistory
      ? newHistory.slice(newHistory.length - maxHistory)
      : newHistory;

    // --- Check 1: Consecutive identical calls ---
    const consecutiveCount = countConsecutiveTrailing(history, fingerprint);

    if (consecutiveCount >= blockThreshold) {
      return {
        detected: true,
        severity: 'block',
        count: consecutiveCount,
        fingerprint,
      };
    }

    if (consecutiveCount >= warnThreshold) {
      return {
        detected: true,
        severity: 'warn',
        count: consecutiveCount,
        fingerprint,
      };
    }

    // --- Check 2: Non-consecutive frequency in recent window ---
    const window = history.slice(-FREQUENCY_WINDOW);
    const frequencyCount = window.filter((e) => e.fingerprint === fingerprint).length;

    if (window.length >= FREQUENCY_WINDOW && frequencyCount >= FREQUENCY_THRESHOLD) {
      return {
        detected: true,
        severity: 'warn',
        count: frequencyCount,
        fingerprint,
      };
    }

    return { detected: false, severity: 'none', count: consecutiveCount };
  }

  /**
   * Get the current call history.
   *
   * @returns {ReadonlyArray<{ tool: string, fingerprint: string }>}
   */
  function getLoopHistory() {
    return Object.freeze([...history]);
  }

  /**
   * Reset the call history.
   *
   * @returns {void}
   */
  function resetHistory() {
    history = [];
  }

  return Object.freeze({ detectLoop, getLoopHistory, resetHistory });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count how many trailing entries in the history share the same fingerprint.
 *
 * @param {Array<{ fingerprint: string }>} entries - History array
 * @param {string} fingerprint - Fingerprint to match
 * @returns {number} Count of consecutive trailing matches
 */
function countConsecutiveTrailing(entries, fingerprint) {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].fingerprint !== fingerprint) break;
    count++;
  }
  return count;
}
