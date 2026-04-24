/**
 * Working Memory Store (L1) — in-RAM, token-budget-aware.
 *
 * Design reference: _design/hierarchical-memory-2026-04-24.md Section 5.3 (Phase C).
 *
 * Responsibilities:
 *   - append(entry)           — capture in-flight context (tool calls, prompts,
 *                               tool results, corrections) during a session.
 *   - snapshot()              — read-only view of the current Working contents.
 *   - flush({reason})         — compute importance_score; if >= threshold,
 *                               promote a compressed episode to the injected
 *                               Episodic store; always clears the buffer.
 *   - partialFlush({minTokens}) — drop oldest entries when token budget is hit
 *                               (compaction-survival guarantee).
 *   - tokenBudget() / getBudgetStatus() — introspect token usage.
 *   - reset()                 — test-only full reset.
 *
 * Importance-score formula (design Section 3.1):
 *   score = tool_calls·0.3 + errors·0.5 + successes·0.4 + user_corrections·0.8
 * Threshold for Episodic promotion: >= 1.0 (noise gate 0.85 logs-only).
 *
 * Zero runtime deps. Pure RAM. All public reads return frozen copies.
 *
 * @module lib/learning/memory/working
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 200_000;
const DEFAULT_PARTIAL_FLUSH_SIZE = 40_000;
const PARTIAL_FLUSH_TRIGGER_RATIO = 0.9; // 180K of 200K
const MIN_ENTRY_TOKENS = 10;
const PROMOTION_THRESHOLD = 1.0;
const NOISE_FLOOR = 0.85;
const CHARS_PER_TOKEN = 4;

const IMPORTANCE_WEIGHTS = Object.freeze({
  tool_call: 0.3,
  error: 0.5,
  success: 0.4,
  user_correction: 0.8,
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Deterministic token estimation — body length / 4 with a 10-token floor.
 * Accuracy is secondary to determinism (matches summarization.js estimator).
 *
 * @param {unknown} body
 * @returns {number}
 */
export function estimateEntryTokens(body) {
  if (body === null || body === undefined) return MIN_ENTRY_TOKENS;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const raw = Math.ceil(String(text).length / CHARS_PER_TOKEN);
  return Math.max(MIN_ENTRY_TOKENS, raw);
}

/**
 * Count classified entry kinds → importance-score inputs.
 *
 * @param {Array<{kind?: string}>} entries
 * @returns {{tool_calls: number, errors: number, successes: number, user_corrections: number}}
 */
export function tallyEntryKinds(entries) {
  const counts = { tool_calls: 0, errors: 0, successes: 0, user_corrections: 0 };
  for (const e of entries) {
    switch (e?.kind) {
      case 'tool_call': counts.tool_calls += 1; break;
      case 'error': counts.errors += 1; break;
      case 'success': counts.successes += 1; break;
      case 'user_correction': counts.user_corrections += 1; break;
      default: break;
    }
  }
  return counts;
}

/**
 * Importance score per design Section 3.1.
 *
 * @param {{tool_calls: number, errors: number, successes: number, user_corrections: number}} tally
 * @returns {number}
 */
export function computeImportanceScore(tally) {
  const t = tally || {};
  return (
    (t.tool_calls || 0) * IMPORTANCE_WEIGHTS.tool_call
    + (t.errors || 0) * IMPORTANCE_WEIGHTS.error
    + (t.successes || 0) * IMPORTANCE_WEIGHTS.success
    + (t.user_corrections || 0) * IMPORTANCE_WEIGHTS.user_correction
  );
}

function genId(now) {
  const rand = Math.random().toString(36).slice(2, 7);
  return `wk_${now}_${rand}`;
}

function buildEntry(raw, now) {
  const body = raw?.body ?? raw?.content ?? '';
  const tokens = typeof raw?.tokens === 'number' && raw.tokens > 0
    ? Math.max(MIN_ENTRY_TOKENS, Math.floor(raw.tokens))
    : estimateEntryTokens(body);
  return Object.freeze({
    id: raw?.id || genId(now),
    createdAt: now,
    kind: typeof raw?.kind === 'string' ? raw.kind : 'generic',
    body,
    tokens,
    tags: Object.freeze(Array.isArray(raw?.tags) ? raw.tags.slice(0, 16) : []),
  });
}

function summariseForEpisode(entries, tally, score, now) {
  const first = entries[0];
  const title = first?.kind === 'user_correction'
    ? `working:correction @${now}`
    : `working:session @${now}`;
  const linesList = entries
    .slice(0, 40)
    .map((e) => {
      const snippet = typeof e.body === 'string'
        ? e.body.slice(0, 200)
        : JSON.stringify(e.body).slice(0, 200);
      return `[${e.kind}] ${snippet}`;
    });
  const summary = linesList.join('\n');
  return {
    title,
    summary,
    keywords: Array.from(new Set(entries.flatMap((e) => e.tags || []))).slice(0, 20),
    importanceScore: Number(score.toFixed(3)),
    tally: { ...tally },
    timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WorkingStoreOptions
 * @property {number} [tokenBudget=200000]
 * @property {() => number} [now]
 * @property {{appendEpisode: Function} | null} [episodicStore] - Optional; when
 *   absent, flush() reports score but never promotes (useful in unit tests).
 * @property {{info?: Function, warn?: Function}} [logger]
 */

/**
 * Create a Working memory store.
 *
 * @param {WorkingStoreOptions} [options]
 * @returns {object} Frozen WorkingStore interface
 */
export function createWorkingStore(options = {}) {
  const tokenBudget = typeof options.tokenBudget === 'number' && options.tokenBudget > 0
    ? Math.floor(options.tokenBudget)
    : DEFAULT_TOKEN_BUDGET;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const episodicStore = options.episodicStore || null;
  const logger = options.logger || { info() {}, warn() {} };

  // Mutable closure state — intentionally scoped and never exposed directly.
  let entries = [];
  let totalTokens = 0;
  let lastFlushAt = 0;
  const flushSubscribers = new Set();

  function currentEntries() {
    return entries;
  }

  function budgetStatus() {
    const used = totalTokens;
    const ratio = tokenBudget > 0 ? used / tokenBudget : 0;
    return Object.freeze({
      used,
      budget: tokenBudget,
      ratio,
      willPartialFlush: ratio >= PARTIAL_FLUSH_TRIGGER_RATIO,
    });
  }

  function append(raw) {
    const ts = now();
    const entry = buildEntry(raw, ts);
    entries = [...entries, entry];
    totalTokens += entry.tokens;
    return Object.freeze({
      id: entry.id,
      tokens: entry.tokens,
      totalTokens,
    });
  }

  function snapshot() {
    return Object.freeze({
      entries: Object.freeze(entries.map((e) => Object.freeze({ ...e }))),
      tokens: totalTokens,
      budget: tokenBudget,
      lastFlushAt,
    });
  }

  async function partialFlush({ minTokens = DEFAULT_PARTIAL_FLUSH_SIZE } = {}) {
    if (entries.length === 0) return Object.freeze({ dropped: 0, tokensFreed: 0 });

    let dropped = 0;
    let tokensFreed = 0;
    const keep = [];
    for (const e of entries) {
      if (tokensFreed < minTokens) {
        tokensFreed += e.tokens;
        dropped += 1;
      } else {
        keep.push(e);
      }
    }
    entries = keep;
    totalTokens = keep.reduce((acc, e) => acc + e.tokens, 0);
    logger.info?.(`[working] partialFlush dropped=${dropped} tokensFreed=${tokensFreed}`);
    return Object.freeze({ dropped, tokensFreed });
  }

  async function flush({ reason = 'session-close' } = {}) {
    const current = currentEntries();
    if (current.length === 0) {
      return Object.freeze({
        promoted: false,
        skipped: true,
        importanceScore: 0,
        reason: 'empty',
      });
    }

    const tally = tallyEntryKinds(current);
    const score = computeImportanceScore(tally);
    const ts = now();

    let promoted = false;
    let skipped = false;
    let skipReason = null;

    if (score >= PROMOTION_THRESHOLD && episodicStore?.appendEpisode) {
      try {
        const episodePayload = summariseForEpisode(current, tally, score, ts);
        await episodicStore.appendEpisode({
          sessionId: `working-${ts}`,
          ...episodePayload,
        });
        promoted = true;
        logger.info?.(`[working] flushed -> episodic score=${score.toFixed(3)} reason=${reason}`);
      } catch (err) {
        logger.warn?.(`[working] flush promote failed: ${err?.message || err}`);
        skipped = true;
        skipReason = 'episodic-error';
      }
    } else if (score >= NOISE_FLOOR) {
      skipped = true;
      skipReason = 'below-threshold';
      logger.info?.(`[working] score=${score.toFixed(3)} below 1.0 — not promoting`);
    } else {
      skipped = true;
      skipReason = 'noise';
      logger.info?.(`[working] score=${score.toFixed(3)} below noise floor — dropped`);
    }

    // Always clear regardless of promotion outcome — Working layer is
    // session-scoped and must not leak across flushes.
    entries = [];
    totalTokens = 0;
    lastFlushAt = ts;

    const result = Object.freeze({
      promoted,
      skipped,
      skipReason,
      importanceScore: Number(score.toFixed(3)),
      reason,
      flushedAt: ts,
      tally: Object.freeze({ ...tally }),
    });

    for (const sub of flushSubscribers) {
      try { sub(result); } catch { /* best-effort */ }
    }
    return result;
  }

  function tokenBudgetView() {
    return Object.freeze({ used: totalTokens, budget: tokenBudget });
  }

  function reset() {
    entries = [];
    totalTokens = 0;
    lastFlushAt = 0;
  }

  function onFlush(fn) {
    if (typeof fn !== 'function') return () => {};
    flushSubscribers.add(fn);
    return () => flushSubscribers.delete(fn);
  }

  async function maybePartialFlush() {
    const status = budgetStatus();
    if (!status.willPartialFlush) return null;
    return partialFlush({ minTokens: DEFAULT_PARTIAL_FLUSH_SIZE });
  }

  return Object.freeze({
    append,
    snapshot,
    flush,
    partialFlush,
    maybePartialFlush,
    tokenBudget: tokenBudgetView,
    getBudgetStatus: budgetStatus,
    reset,
    onFlush,
  });
}

// Constants re-export — callers (retriever, middleware, tests) can introspect
// thresholds without hard-coding duplicates.
export const WORKING_CONSTANTS = Object.freeze({
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_PARTIAL_FLUSH_SIZE,
  PARTIAL_FLUSH_TRIGGER_RATIO,
  MIN_ENTRY_TOKENS,
  PROMOTION_THRESHOLD,
  NOISE_FLOOR,
  IMPORTANCE_WEIGHTS,
});
