import { describe, expect, it } from 'vitest';

import {
  _internals,
  VERDICTS,
  createSelfVerifier,
} from '../../../lib/learning/voyager/self-verifier.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProposal(overrides = {}) {
  return {
    signature: 'sig-abc',
    exampleIntent: 'refactor pricing module split smaller files',
    toolUnion: ['read', 'edit', 'bash'],
    frames: [
      { intent: 'refactor pricing module split smaller files', tools: ['read', 'edit'] },
    ],
    ...overrides,
  };
}

function makeEpisode(overrides = {}) {
  return {
    intent: 'refactor pricing module split smaller files',
    summary: 'refactor pricing module split smaller files',
    tools: ['read', 'edit', 'bash'],
    keywords: ['refactor', 'pricing'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('self-verifier — internals', () => {
  it('tokenize drops short tokens and non-word chars', () => {
    const toks = _internals.tokenize('Refactor! the pricing-module v2.');
    expect(toks).toContain('refactor');
    expect(toks).toContain('pricing-module');
    expect(toks).not.toContain('the');
    expect(toks).not.toContain('v2');
  });

  it('tokenize caps token count to avoid pathological inputs', () => {
    const huge = Array.from({ length: 1000 }, (_, i) => `token${i}abc`).join(' ');
    const toks = _internals.tokenize(huge);
    expect(toks.length).toBeLessThanOrEqual(128);
  });

  it('defaultCosineSimilarity returns 1 for identical token bags', () => {
    const a = ['refactor', 'pricing', 'module'];
    const b = ['refactor', 'pricing', 'module'];
    expect(_internals.defaultCosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('defaultCosineSimilarity returns 0 for disjoint token bags', () => {
    expect(_internals.defaultCosineSimilarity(['alpha'], ['beta'])).toBe(0);
    expect(_internals.defaultCosineSimilarity([], ['beta'])).toBe(0);
    expect(_internals.defaultCosineSimilarity(null, ['beta'])).toBe(0);
  });

  it('defaultCosineSimilarity is symmetric and in [0,1]', () => {
    const a = ['refactor', 'module', 'pricing'];
    const b = ['refactor', 'service', 'pricing'];
    const ab = _internals.defaultCosineSimilarity(a, b);
    const ba = _internals.defaultCosineSimilarity(b, a);
    expect(ab).toBeCloseTo(ba, 10);
    expect(ab).toBeGreaterThan(0);
    expect(ab).toBeLessThan(1);
  });

  it('extractProposalDoc combines trigger and process text', () => {
    const toks = _internals.extractProposalDoc({
      exampleIntent: 'deploy staging tests pass',
      toolUnion: ['bash', 'read'],
      triggers: ['deploy'],
    });
    expect(toks).toContain('deploy');
    expect(toks).toContain('bash');
  });

  it('extractEpisodeDoc reads intent, tools, keywords', () => {
    const toks = _internals.extractEpisodeDoc({
      intent: 'lint cleanup run',
      tools: ['grep', 'edit'],
      keywords: ['lint'],
    });
    expect(toks).toContain('lint');
    expect(toks).toContain('grep');
  });

  it('resolveEnabled defaults to true and honours explicit false', () => {
    expect(_internals.resolveEnabled()).toBe(true);
    expect(_internals.resolveEnabled({})).toBe(true);
    expect(_internals.resolveEnabled({ learning: {} })).toBe(true);
    expect(_internals.resolveEnabled({ learning: { voyager: {} } })).toBe(true);
    expect(_internals.resolveEnabled({
      learning: { voyager: { selfVerify: true } },
    })).toBe(true);
    expect(_internals.resolveEnabled({
      learning: { voyager: { selfVerify: false } },
    })).toBe(false);
  });

  it('normalizeRatio clamps to [0,1] and falls back on invalid', () => {
    expect(_internals.normalizeRatio(0.5, 0.8)).toBe(0.5);
    expect(_internals.normalizeRatio(-1, 0.8)).toBe(0);
    expect(_internals.normalizeRatio(2, 0.8)).toBe(1);
    expect(_internals.normalizeRatio('x', 0.8)).toBe(0.8);
    expect(_internals.normalizeRatio(NaN, 0.8)).toBe(0.8);
  });

  it('clampUnit squishes values into [0,1]', () => {
    expect(_internals.clampUnit(-0.2)).toBe(0);
    expect(_internals.clampUnit(1.5)).toBe(1);
    expect(_internals.clampUnit(0.7)).toBe(0.7);
    expect(_internals.clampUnit(NaN)).toBe(0);
  });

  it('aggregateVerdict returns review on zero scores', () => {
    const v = _internals.aggregateVerdict([], {
      threshold: 0.8, acceptRatio: 0.7, rejectRatio: 0.5,
    });
    expect(v.verdict).toBe(VERDICTS.REVIEW);
    expect(v.total).toBe(0);
  });

  it('aggregateVerdict accepts when pass ratio clears acceptRatio', () => {
    const v = _internals.aggregateVerdict(
      [{ similarity: 0.9 }, { similarity: 0.95 }, { similarity: 0.88 }],
      { threshold: 0.8, acceptRatio: 0.7, rejectRatio: 0.5 },
    );
    expect(v.verdict).toBe(VERDICTS.ACCEPT);
    expect(v.passCount).toBe(3);
  });

  it('aggregateVerdict rejects when fail ratio clears rejectRatio', () => {
    const v = _internals.aggregateVerdict(
      [{ similarity: 0.2 }, { similarity: 0.1 }, { similarity: 0.95 }],
      { threshold: 0.8, acceptRatio: 0.7, rejectRatio: 0.5 },
    );
    expect(v.verdict).toBe(VERDICTS.REJECT);
    expect(v.failCount).toBe(2);
  });

  it('aggregateVerdict falls to review for mixed ratios', () => {
    // 2 pass / 2 fail out of 4 = 50/50 — neither accept nor reject band.
    // pass-ratio 0.5 < acceptRatio 0.7, fail-ratio 0.5 >= rejectRatio 0.5
    // so the tie goes to reject by design. Use a different configuration:
    const v = _internals.aggregateVerdict(
      [
        { similarity: 0.9 },
        { similarity: 0.85 },
        { similarity: 0.4 },
      ],
      { threshold: 0.8, acceptRatio: 0.7, rejectRatio: 0.5 },
    );
    expect(v.verdict).toBe(VERDICTS.REVIEW);
  });
});

// ---------------------------------------------------------------------------

describe('createSelfVerifier — verifyProposal', () => {
  it('returns accept when the proposal mirrors its past episodes', async () => {
    const verifier = createSelfVerifier();
    const proposal = makeProposal();
    const episodes = [makeEpisode(), makeEpisode(), makeEpisode()];
    const result = await verifier.verifyProposal({ proposal, pastEpisodes: episodes });
    expect(result.verdict).toBe(VERDICTS.ACCEPT);
    expect(result.passCount).toBe(3);
    expect(result.total).toBe(3);
    expect(result.score).toBeGreaterThan(0.8);
  });

  it('returns reject when most episodes drift below threshold', async () => {
    const verifier = createSelfVerifier();
    const proposal = makeProposal();
    const episodes = [
      makeEpisode({ intent: 'lint only cleanup', tools: ['grep'], keywords: [], summary: 'lint only cleanup' }),
      makeEpisode({ intent: 'write docs api jsdoc', tools: ['doc-writer'], keywords: [], summary: 'write docs api' }),
      makeEpisode({ intent: 'deploy staging run tests', tools: ['bash'], keywords: [], summary: 'deploy staging tests' }),
    ];
    const result = await verifier.verifyProposal({ proposal, pastEpisodes: episodes });
    expect(result.verdict).toBe(VERDICTS.REJECT);
    expect(result.failCount).toBeGreaterThanOrEqual(2);
    expect(result.reasons.some((r) => r.startsWith('fail-ratio'))).toBe(true);
  });

  it('returns review for borderline mixed-similarity clusters', async () => {
    const verifier = createSelfVerifier();
    const proposal = makeProposal();
    const episodes = [
      makeEpisode(), // strong match → pass
      makeEpisode(), // strong match → pass
      makeEpisode({ intent: 'noise unrelated content here now only', tools: [], keywords: [], summary: 'noise unrelated now' }),
    ];
    const result = await verifier.verifyProposal({ proposal, pastEpisodes: episodes });
    // 2 pass / 3 = 0.66 pass-ratio → not accept (>=0.7), 1 fail / 3 = 0.33 → not reject (>=0.5)
    expect(result.verdict).toBe(VERDICTS.REVIEW);
  });

  it('returns review on empty pastEpisodes', async () => {
    const verifier = createSelfVerifier();
    const result = await verifier.verifyProposal({
      proposal: makeProposal(),
      pastEpisodes: [],
    });
    expect(result.verdict).toBe(VERDICTS.REVIEW);
    expect(result.reasons).toContain('no-episodes-to-verify');
  });

  it('returns reject on invalid proposal', async () => {
    const verifier = createSelfVerifier();
    const result = await verifier.verifyProposal({ proposal: null, pastEpisodes: [] });
    expect(result.verdict).toBe(VERDICTS.REJECT);
    expect(result.reasons).toContain('invalid-proposal');
  });

  it('returns review when proposal has no extractable tokens', async () => {
    const verifier = createSelfVerifier();
    const result = await verifier.verifyProposal({
      proposal: { signature: 'x' },
      pastEpisodes: [makeEpisode()],
    });
    expect(result.verdict).toBe(VERDICTS.REVIEW);
    expect(result.reasons).toContain('empty-proposal-tokens');
  });

  it('falls back to proposal.frames when pastEpisodes is undefined', async () => {
    const verifier = createSelfVerifier();
    const proposal = makeProposal({
      frames: [
        { intent: 'refactor pricing module split files', tools: ['read', 'edit'] },
        { intent: 'refactor pricing module split files', tools: ['read', 'edit'] },
        { intent: 'refactor pricing module split files', tools: ['read', 'edit'] },
      ],
    });
    const result = await verifier.verifyProposal({ proposal });
    expect(result.total).toBe(3);
    expect(result.verdict).toBe(VERDICTS.ACCEPT);
  });

  it('falls back to episodicStore.listEpisodes when no frames and no pastEpisodes', async () => {
    const store = {
      listEpisodes: async () => [makeEpisode(), makeEpisode()],
    };
    const verifier = createSelfVerifier({ episodicStore: store });
    const proposal = { signature: 's', exampleIntent: 'refactor pricing module', toolUnion: ['read'] };
    const result = await verifier.verifyProposal({ proposal });
    expect(result.total).toBe(2);
  });

  it('respects threshold parameter override', async () => {
    const verifier = createSelfVerifier();
    const proposal = makeProposal();
    const episodes = [makeEpisode(), makeEpisode(), makeEpisode()];
    // With an absurd threshold of 1.1, nothing can pass — all fail → reject.
    const result = await verifier.verifyProposal({
      proposal,
      pastEpisodes: episodes,
      threshold: 1.1,
    });
    expect(result.verdict).toBe(VERDICTS.REJECT);
  });

  it('is deterministic — same inputs always yield the same verdict', async () => {
    const verifier = createSelfVerifier();
    const proposal = makeProposal();
    const episodes = [makeEpisode(), makeEpisode(), makeEpisode()];
    const a = await verifier.verifyProposal({ proposal, pastEpisodes: episodes });
    const b = await verifier.verifyProposal({ proposal, pastEpisodes: episodes });
    expect(a.verdict).toBe(b.verdict);
    expect(a.score).toBe(b.score);
    expect(a.passCount).toBe(b.passCount);
  });

  it('honours custom cosineSimilarity injection', async () => {
    let called = 0;
    const verifier = createSelfVerifier({
      cosineSimilarity: () => {
        called += 1;
        return 0.99;
      },
    });
    const proposal = makeProposal();
    const episodes = [makeEpisode(), makeEpisode()];
    const result = await verifier.verifyProposal({ proposal, pastEpisodes: episodes });
    expect(called).toBeGreaterThan(0);
    expect(result.verdict).toBe(VERDICTS.ACCEPT);
  });

  it('clamps injected cosine values outside [0,1]', async () => {
    const verifier = createSelfVerifier({
      cosineSimilarity: () => 5, // wildly out of range
    });
    const result = await verifier.verifyProposal({
      proposal: makeProposal(),
      pastEpisodes: [makeEpisode()],
    });
    // Clamped down to 1, which is >= threshold (0.8) → pass.
    expect(result.verdict).toBe(VERDICTS.ACCEPT);
  });
});

// ---------------------------------------------------------------------------

describe('createSelfVerifier — opt-out', () => {
  it('reports enabled=false and short-circuits to accept when config disables it', async () => {
    const verifier = createSelfVerifier({
      config: { learning: { voyager: { selfVerify: false } } },
    });
    expect(verifier.enabled).toBe(false);
    const result = await verifier.verifyProposal({
      proposal: makeProposal(),
      pastEpisodes: [makeEpisode({ intent: 'totally-unrelated-token-bag-here', tools: [], keywords: [], summary: '' })],
    });
    expect(result.verdict).toBe(VERDICTS.ACCEPT);
    expect(result.reasons).toContain('self-verify-disabled');
  });

  it('reports enabled=true by default', () => {
    expect(createSelfVerifier().enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('createSelfVerifier — batchVerify', () => {
  it('runs verifyProposal across an array and attaches the signature', async () => {
    const verifier = createSelfVerifier();
    const proposals = [
      makeProposal({ signature: 'a' }),
      makeProposal({ signature: 'b' }),
    ];
    const episodes = [makeEpisode(), makeEpisode(), makeEpisode()];
    const results = await verifier.batchVerify(proposals, { pastEpisodes: episodes });
    expect(results).toHaveLength(2);
    expect(results[0].signature).toBe('a');
    expect(results[1].signature).toBe('b');
    for (const r of results) expect(r.verdict).toBe(VERDICTS.ACCEPT);
  });

  it('returns an empty array for non-array input', async () => {
    const verifier = createSelfVerifier();
    expect(await verifier.batchVerify(null)).toEqual([]);
    expect(await verifier.batchVerify(undefined)).toEqual([]);
    expect(await verifier.batchVerify({})).toEqual([]);
  });
});
