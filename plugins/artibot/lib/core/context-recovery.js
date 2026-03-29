/**
 * Context window overflow detection and recovery.
 * Provides phased token-budget management: detects overflow risk,
 * recommends truncation targets, truncates outputs, and builds
 * recovery summaries.
 *
 * Token estimation: 4 characters ~ 1 token.
 *
 * @module lib/core/context-recovery
 */

/** Characters per estimated token. */
const CHARS_PER_TOKEN = 4;

/**
 * Context window limit recovery system.
 *
 * @example
 * const cr = new ContextRecovery();
 * if (cr.detectOverflow(180_000, 200_000)) {
 *   const targets = cr.suggestTruncation(toolOutputs);
 *   const truncated = targets.map(t => cr.truncateOutput(t, 500));
 *   const summary = cr.buildRecoverySummary(truncated);
 * }
 */
export class ContextRecovery {
  /**
   * @param {object} [options]
   * @param {number} [options.charsPerToken=4] - Characters-per-token heuristic.
   */
  constructor(options = {}) {
    this._charsPerToken = options.charsPerToken || CHARS_PER_TOKEN;
  }

  /**
   * Detect whether the current token usage exceeds a threshold.
   *
   * @param {number} currentTokens - Current estimated token count.
   * @param {number} maxTokens - Maximum token budget.
   * @param {number} [threshold=0.9] - Fraction of maxTokens that triggers overflow.
   * @returns {{ overflow: boolean, usage: number, remaining: number }}
   */
  detectOverflow(currentTokens, maxTokens, threshold = 0.9) {
    const limit = maxTokens * threshold;
    const usage = maxTokens > 0 ? currentTokens / maxTokens : 0;
    const remaining = Math.max(0, maxTokens - currentTokens);

    return Object.freeze({
      overflow: currentTokens >= limit,
      usage: Math.round(usage * 10000) / 10000,
      remaining,
    });
  }

  /**
   * Rank tool outputs by estimated token size, largest first.
   * Each output object should have at least a `content` string field.
   *
   * @param {Array<{ id?: string, content: string }>} toolOutputs
   * @returns {Array<{ id?: string, content: string, estimatedTokens: number }>}
   */
  suggestTruncation(toolOutputs) {
    if (!Array.isArray(toolOutputs)) return [];

    return toolOutputs
      .map((output) => ({
        ...output,
        estimatedTokens: this._estimateTokens(output.content || ''),
      }))
      .sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  }

  /**
   * Truncate a tool output to approximately `targetTokens` tokens,
   * preserving the beginning and end with a middle ellipsis marker.
   *
   * @param {{ id?: string, content: string }} output - The output to truncate.
   * @param {number} targetTokens - Desired token budget for the result.
   * @returns {{ id?: string, content: string, originalTokens: number, truncated: boolean }}
   */
  truncateOutput(output, targetTokens) {
    const content = output.content || '';
    const originalTokens = this._estimateTokens(content);

    if (originalTokens <= targetTokens) {
      return Object.freeze({
        ...output,
        originalTokens,
        truncated: false,
      });
    }

    const targetChars = targetTokens * this._charsPerToken;
    const marker = '\n\n... [truncated] ...\n\n';
    const available = Math.max(0, targetChars - marker.length);
    const headSize = Math.ceil(available * 0.6);
    const tailSize = Math.floor(available * 0.4);

    const head = content.slice(0, headSize);
    const tail = content.slice(content.length - tailSize);

    return Object.freeze({
      ...output,
      content: head + marker + tail,
      originalTokens,
      truncated: true,
    });
  }

  /**
   * Build a summary of what was truncated for context recovery.
   *
   * @param {Array<{ id?: string, content: string, originalTokens?: number, truncated?: boolean }>} truncatedOutputs
   * @returns {{ summary: string, totalSaved: number, itemCount: number }}
   */
  buildRecoverySummary(truncatedOutputs) {
    if (!Array.isArray(truncatedOutputs)) {
      return Object.freeze({ summary: '', totalSaved: 0, itemCount: 0 });
    }

    const truncated = truncatedOutputs.filter((o) => o.truncated);
    if (truncated.length === 0) {
      return Object.freeze({
        summary: 'No outputs were truncated.',
        totalSaved: 0,
        itemCount: 0,
      });
    }

    const lines = truncated.map((o) => {
      const label = o.id || '(unnamed)';
      const saved = o.originalTokens - this._estimateTokens(o.content);
      return `- ${label}: ~${o.originalTokens} -> ~${this._estimateTokens(o.content)} tokens (saved ~${saved})`;
    });

    const totalSaved = truncated.reduce((sum, o) => {
      return sum + (o.originalTokens - this._estimateTokens(o.content));
    }, 0);

    const summary = [
      `[Context Recovery] Truncated ${truncated.length} output(s):`,
      ...lines,
      `Total saved: ~${totalSaved} tokens`,
    ].join('\n');

    return Object.freeze({
      summary,
      totalSaved,
      itemCount: truncated.length,
    });
  }

  // ─── Internal ────────────────────────────────────────────────────

  /**
   * Estimate token count from character length.
   * @private
   * @param {string} text
   * @returns {number}
   */
  _estimateTokens(text) {
    return Math.ceil((text || '').length / this._charsPerToken);
  }
}
