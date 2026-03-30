/**
 * Runtime summarization middleware.
 * Manages context window by summarizing conversation history when token
 * thresholds are exceeded. Inspired by deer-flow's compaction pattern:
 * max-token trigger → summarize older turns → preserve recent messages.
 *
 * @module lib/runtime/middleware/summarization
 */

import { emit } from '../../core/event-bus.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Rough token estimation from character count.
 *
 * @param {string} text
 * @param {number} charsPerToken
 * @returns {number}
 */
function estimateTokens(text, charsPerToken) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Split a conversation-style prompt into logical segments.
 * Each segment is separated by double newlines or turn markers.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSegments(text) {
  if (!text) return [];
  return text.split(/\n{2,}/).filter((s) => s.trim().length > 0);
}

/**
 * Partition segments into older (compactable) and recent (preserved).
 *
 * @param {string[]} segments
 * @param {number} preserveRecent
 * @returns {{ older: string[], recent: string[] }}
 */
function partitionSegments(segments, preserveRecent) {
  if (segments.length <= preserveRecent) {
    return { older: [], recent: segments };
  }
  const cutoff = segments.length - preserveRecent;
  return {
    older: segments.slice(0, cutoff),
    recent: segments.slice(cutoff),
  };
}

/**
 * Generate a compact summary of older segments.
 * Extracts key sentences (first sentence of each segment) and joins them.
 *
 * @param {string[]} olderSegments
 * @param {number} summaryRatio - Fraction of original to retain (0.0–1.0).
 * @returns {string}
 */
function summarizeSegments(olderSegments, summaryRatio) {
  if (olderSegments.length === 0) return '';

  const sentences = olderSegments.map((seg) => {
    const firstSentence = seg.split(/[.!?\n]/)[0]?.trim();
    return firstSentence || seg.slice(0, 120).trim();
  });

  const targetCount = Math.max(1, Math.ceil(sentences.length * summaryRatio));
  const selected = sentences.slice(0, targetCount);

  return '[Context summary]\n' + selected.join('\n');
}

/**
 * Rebuild the prompt by replacing older content with a summary
 * and keeping recent segments intact.
 *
 * @param {string} summary
 * @param {string[]} recentSegments
 * @returns {string}
 */
function rebuildPrompt(summary, recentSegments) {
  const parts = [];
  if (summary) parts.push(summary);
  parts.push(...recentSegments);
  return parts.join('\n\n');
}

/**
 * Calculate compaction statistics.
 *
 * @param {number} originalTokens
 * @param {number} compactedTokens
 * @returns {{ savedTokens: number, reductionPercent: number }}
 */
function calcCompactionStats(originalTokens, compactedTokens) {
  const savedTokens = Math.max(0, originalTokens - compactedTokens);
  const reductionPercent = originalTokens > 0
    ? Math.round((savedTokens / originalTokens) * 100)
    : 0;
  return { savedTokens, reductionPercent };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a summarization middleware with deer-flow-style conversation compaction.
 *
 * @param {object} [options]
 * @param {number} [options.maxTokens=50000] - Token threshold to trigger compaction.
 * @param {number} [options.summaryRatio=0.3] - Fraction of older content to retain in summary.
 * @param {number} [options.preserveRecent=5] - Number of recent segments to keep verbatim.
 * @param {number} [options.charsPerToken=4] - Characters-per-token estimation ratio.
 * @param {number} [options.compactThresholdChars] - Legacy char-based threshold (overrides maxTokens).
 * @returns {(state: object) => Promise<object>}
 *
 * // TODO: bridge config.output.maxContextLength as an alternative threshold
 * // for context window management. Currently maxTokens (token-based) is used
 * // but maxContextLength (character-based) from config is not consumed.
 */
export function createSummarizationMiddleware(options = {}) {
  const {
    maxTokens = 50000,
    summaryRatio = 0.3,
    preserveRecent = 5,
    charsPerToken = 4,
    compactThresholdChars,
  } = options;

  // Support legacy char-based config
  const effectiveMaxChars = compactThresholdChars ?? maxTokens * charsPerToken;

  return async function summarizationMiddleware(state) {
    const originalPrompt = state.userPrompt;
    const promptLength = originalPrompt.length;
    const estimatedTokens = estimateTokens(originalPrompt, charsPerToken);
    const shouldCompact = promptLength >= effectiveMaxChars;

    if (!shouldCompact) {
      state.context.summarization = {
        shouldCompact: false,
        estimatedTokens,
        maxTokens,
        promptLength,
      };
      return state;
    }

    // Perform compaction
    const segments = splitSegments(originalPrompt);
    const { older, recent } = partitionSegments(segments, preserveRecent);
    const summary = summarizeSegments(older, summaryRatio);
    const compacted = rebuildPrompt(summary, recent);

    const compactedTokens = estimateTokens(compacted, charsPerToken);
    const { savedTokens, reductionPercent } = calcCompactionStats(estimatedTokens, compactedTokens);

    state.userPrompt = compacted;

    state.context.summarization = {
      shouldCompact: true,
      compacted: true,
      estimatedTokens,
      compactedTokens,
      savedTokens,
      reductionPercent,
      maxTokens,
      promptLength,
      compactedLength: compacted.length,
      segmentsTotal: segments.length,
      segmentsPreserved: recent.length,
      segmentsSummarized: older.length,
    };

    state.messageParts.push(`compact=${reductionPercent}%`);

    emit('feature:token-saving', { detail: `compacted ${reductionPercent}%` });

    return state;
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  estimateTokens as _estimateTokens,
  splitSegments as _splitSegments,
  partitionSegments as _partitionSegments,
  summarizeSegments as _summarizeSegments,
  rebuildPrompt as _rebuildPrompt,
  calcCompactionStats as _calcCompactionStats,
};
