/**
 * Runtime summarization middleware.
 * Decides whether prompt/context compaction should be requested.
 *
 * @module lib/runtime/middleware/summarization
 */

/**
 * @param {object} [options]
 * @param {number} [options.compactThresholdChars=1800]
 * @returns {(state: object) => Promise<object>}
 */
export function createSummarizationMiddleware(options = {}) {
  const { compactThresholdChars = 1800 } = options;

  return async function summarizationMiddleware(state) {
    const length = state.userPrompt.length;
    const shouldCompact = length >= compactThresholdChars;

    state.context.summarization = {
      shouldCompact,
      compactThresholdChars,
      promptLength: length,
    };

    if (shouldCompact) {
      state.messageParts.push('compact=1');
    }

    return state;
  };
}

