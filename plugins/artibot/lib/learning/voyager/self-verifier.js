/**
 * Voyager Self-Verification — shadow-dry-run pre-flight check.
 *
 * Before a draft reaches the staging directory, this module performs a
 * purely local, LLM-free sanity check:
 *
 *   for each past episode in the cluster → compute token-based cosine
 *   similarity between (proposal.trigger ∪ proposal.process) and
 *   (episode.intent ∪ episode.tools). Aggregate into a 3-tier verdict:
 *
 *     - >= 70% of episodes above threshold → "accept"
 *     - >= 50% below threshold            → "reject"
 *     - otherwise                          → "review"
 *
 * Rejected proposals are dropped BEFORE staging; "review" proposals are
 * still staged but annotated with `metadata.preflightVerdict: "review"`
 * so the user can see why the curator flagged them.
 *
 * HARD constraints (mirror the curator module):
 *   - Zero LLM calls, zero external network I/O.
 *   - Deterministic — same inputs always produce the same verdict.
 *   - Opt-out via `config.learning.voyager.selfVerify: false` (default true).
 *
 * Paper alignment: Voyager's "self-verification" step re-runs the skill in
 * the Minecraft sandbox and asks GPT-4 whether the outcome matched the
 * task description. We cannot do that locally, so we approximate by
 * measuring textual overlap against the very episodes that inspired the
 * proposal. Low overlap means the scaffolded trigger/process drifted from
 * the observed pattern and is unlikely to be useful.
 *
 * @module lib/learning/voyager/self-verifier
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_ACCEPT_RATIO = 0.7;
const DEFAULT_REJECT_RATIO = 0.5;
const MIN_TOKEN_LENGTH = 3;
const MAX_TOKENS_PER_DOC = 128;

const VERDICT_ACCEPT = 'accept';
const VERDICT_REJECT = 'reject';
const VERDICT_REVIEW = 'review';

// ---------------------------------------------------------------------------
// Pure tokenizer / cosine helpers — shared fallback when no injector is passed.
// ---------------------------------------------------------------------------

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length >= MIN_TOKEN_LENGTH)
    .slice(0, MAX_TOKENS_PER_DOC);
}

function termFrequency(tokens) {
  const tf = new Map();
  for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
  return tf;
}

function defaultCosineSimilarity(aTokens, bTokens) {
  if (!aTokens?.length || !bTokens?.length) return 0;
  const aTf = termFrequency(aTokens);
  const bTf = termFrequency(bTokens);
  let dot = 0;
  for (const [term, aCount] of aTf) {
    const bCount = bTf.get(term);
    if (bCount) dot += aCount * bCount;
  }
  if (dot === 0) return 0;
  let aNorm = 0;
  for (const v of aTf.values()) aNorm += v * v;
  let bNorm = 0;
  for (const v of bTf.values()) bNorm += v * v;
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

// ---------------------------------------------------------------------------
// Proposal / episode document extraction
// ---------------------------------------------------------------------------

function extractProposalDoc(proposal) {
  if (!proposal || typeof proposal !== 'object') return [];
  const triggerParts = collectTriggerText(proposal);
  const processParts = collectProcessText(proposal);
  return tokenize([triggerParts, processParts].filter(Boolean).join(' '));
}

function collectTriggerText(proposal) {
  const bits = [];
  if (Array.isArray(proposal.toolUnion)) bits.push(proposal.toolUnion.join(' '));
  if (Array.isArray(proposal.triggers)) bits.push(proposal.triggers.join(' '));
  if (typeof proposal.trigger === 'string') bits.push(proposal.trigger);
  if (typeof proposal.exampleIntent === 'string') bits.push(proposal.exampleIntent);
  return bits.join(' ');
}

function collectProcessText(proposal) {
  if (typeof proposal.process === 'string' && proposal.process.length > 0) {
    return proposal.process;
  }
  if (Array.isArray(proposal.frames)) {
    return proposal.frames
      .slice(0, 5)
      .map((f) => (f && typeof f === 'object' ? String(f.intent ?? '') : ''))
      .join(' ');
  }
  return '';
}

function extractEpisodeDoc(episode) {
  if (!episode || typeof episode !== 'object') return [];
  const parts = [];
  if (typeof episode.intent === 'string') parts.push(episode.intent);
  if (typeof episode.summary === 'string') parts.push(episode.summary);
  if (typeof episode.title === 'string') parts.push(episode.title);
  if (Array.isArray(episode.tools)) parts.push(episode.tools.join(' '));
  if (Array.isArray(episode.keywords)) parts.push(episode.keywords.join(' '));
  return tokenize(parts.join(' '));
}

// ---------------------------------------------------------------------------
// Verdict aggregation
// ---------------------------------------------------------------------------

function aggregateVerdict(scores, { threshold, acceptRatio, rejectRatio }) {
  const total = scores.length;
  if (total === 0) {
    return {
      verdict: VERDICT_REVIEW,
      score: 0,
      passCount: 0,
      failCount: 0,
      total: 0,
      reasons: Object.freeze(['no-episodes-to-verify']),
    };
  }
  let passCount = 0;
  const failures = [];
  for (const s of scores) {
    if (s.similarity >= threshold) passCount += 1;
    else failures.push(s);
  }
  const failCount = total - passCount;
  const passRatio = passCount / total;
  const failRatio = failCount / total;
  const avgScore = scores.reduce((acc, s) => acc + s.similarity, 0) / total;

  const reasons = [];
  if (passRatio >= acceptRatio) {
    reasons.push(`pass-ratio ${passRatio.toFixed(2)} >= ${acceptRatio}`);
    return freezeVerdict(VERDICT_ACCEPT, avgScore, passCount, failCount, total, reasons);
  }
  if (failRatio >= rejectRatio) {
    reasons.push(`fail-ratio ${failRatio.toFixed(2)} >= ${rejectRatio}`);
    if (failures.length > 0) {
      const worst = failures
        .slice()
        .sort((a, b) => a.similarity - b.similarity)[0];
      reasons.push(`worst-episode-score ${worst.similarity.toFixed(3)}`);
    }
    return freezeVerdict(VERDICT_REJECT, avgScore, passCount, failCount, total, reasons);
  }
  reasons.push(`pass-ratio ${passRatio.toFixed(2)} between ${rejectRatio} and ${acceptRatio}`);
  return freezeVerdict(VERDICT_REVIEW, avgScore, passCount, failCount, total, reasons);
}

function freezeVerdict(verdict, avgScore, passCount, failCount, total, reasons) {
  return Object.freeze({
    verdict,
    score: Number(avgScore.toFixed(3)),
    passCount,
    failCount,
    total,
    reasons: Object.freeze(reasons.slice()),
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SelfVerifierOptions
 * @property {object} [episodicStore] - Optional; used only when verify() is
 *   called without explicit pastEpisodes.
 * @property {(a: string[], b: string[]) => number} [cosineSimilarity]
 *   - Optional override. Default is the module's built-in token-cosine.
 * @property {object} [config] - Resolved artibot config object. Used to read
 *   `config.learning.voyager.selfVerify`. Defaults to enabled.
 *
 * @param {SelfVerifierOptions} [options]
 * @returns {{enabled: boolean, verifyProposal: Function, batchVerify: Function}}
 */
export function createSelfVerifier(options = {}) {
  const { episodicStore, config } = options || {};
  const cosine = typeof options?.cosineSimilarity === 'function'
    ? options.cosineSimilarity
    : defaultCosineSimilarity;

  const enabled = resolveEnabled(config);

  async function resolveEpisodes(explicitEpisodes, proposal) {
    if (Array.isArray(explicitEpisodes)) return explicitEpisodes;
    if (Array.isArray(proposal?.frames)) return proposal.frames;
    if (episodicStore && typeof episodicStore.listEpisodes === 'function') {
      const all = await episodicStore.listEpisodes();
      return Array.isArray(all) ? all : [];
    }
    return [];
  }

  /**
   * Verify a single proposal against a set of episodes.
   *
   * @param {{proposal: object, pastEpisodes?: object[], threshold?: number,
   *          acceptRatio?: number, rejectRatio?: number}} params
   * @returns {Promise<{verdict: string, score: number, passCount: number,
   *                   failCount: number, total: number,
   *                   reasons: readonly string[]}>}
   */
  async function verifyProposal(params) {
    const threshold = normalizeRatio(params?.threshold, DEFAULT_THRESHOLD);
    const acceptRatio = normalizeRatio(params?.acceptRatio, DEFAULT_ACCEPT_RATIO);
    const rejectRatio = normalizeRatio(params?.rejectRatio, DEFAULT_REJECT_RATIO);

    if (!enabled) {
      return Object.freeze({
        verdict: VERDICT_ACCEPT,
        score: 1,
        passCount: 0,
        failCount: 0,
        total: 0,
        reasons: Object.freeze(['self-verify-disabled']),
      });
    }

    const proposal = params?.proposal;
    if (!proposal || typeof proposal !== 'object') {
      return Object.freeze({
        verdict: VERDICT_REJECT,
        score: 0,
        passCount: 0,
        failCount: 0,
        total: 0,
        reasons: Object.freeze(['invalid-proposal']),
      });
    }

    const proposalTokens = extractProposalDoc(proposal);
    if (proposalTokens.length === 0) {
      return Object.freeze({
        verdict: VERDICT_REVIEW,
        score: 0,
        passCount: 0,
        failCount: 0,
        total: 0,
        reasons: Object.freeze(['empty-proposal-tokens']),
      });
    }

    const episodes = await resolveEpisodes(params?.pastEpisodes, proposal);
    const scores = [];
    for (const ep of episodes) {
      const epTokens = extractEpisodeDoc(ep);
      if (epTokens.length === 0) continue;
      const sim = clampUnit(cosine(proposalTokens, epTokens));
      scores.push({ similarity: sim });
    }

    return aggregateVerdict(scores, { threshold, acceptRatio, rejectRatio });
  }

  /**
   * Verify an array of proposals. Each result is keyed by its input index.
   *
   * @param {object[]} proposals
   * @param {{pastEpisodes?: object[], threshold?: number}} [params]
   * @returns {Promise<object[]>}
   */
  async function batchVerify(proposals, params = {}) {
    if (!Array.isArray(proposals)) return [];
    const results = [];
    for (const proposal of proposals) {
      const r = await verifyProposal({ ...params, proposal });
      results.push(Object.freeze({ signature: proposal?.signature ?? null, ...r }));
    }
    return results;
  }

  return Object.freeze({
    enabled,
    verifyProposal,
    batchVerify,
  });
}

// ---------------------------------------------------------------------------
// Config / option normalization
// ---------------------------------------------------------------------------

function resolveEnabled(config) {
  // Default: enabled. Any explicit boolean false disables; anything else enables.
  const v = config?.learning?.voyager?.selfVerify;
  if (v === false) return false;
  return true;
}

function normalizeRatio(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampUnit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// Public named constants + internals (for tests)
// ---------------------------------------------------------------------------

export const VERDICTS = Object.freeze({
  ACCEPT: VERDICT_ACCEPT,
  REJECT: VERDICT_REJECT,
  REVIEW: VERDICT_REVIEW,
});

export const _internals = Object.freeze({
  tokenize,
  defaultCosineSimilarity,
  extractProposalDoc,
  extractEpisodeDoc,
  aggregateVerdict,
  resolveEnabled,
  normalizeRatio,
  clampUnit,
  DEFAULT_THRESHOLD,
  DEFAULT_ACCEPT_RATIO,
  DEFAULT_REJECT_RATIO,
});
