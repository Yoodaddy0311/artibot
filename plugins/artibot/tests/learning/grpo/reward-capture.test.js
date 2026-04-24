import { describe, expect, it } from 'vitest';
import {
  computeReward,
  computeRewardComponents,
  REWARD_CLIP,
  REWARD_WEIGHTS,
  validateEpisodeForReward,
} from '../../../lib/learning/grpo/reward-capture.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const goldEpisode = Object.freeze({
  toolCalls: [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }],
  errors: 0,
  testPassRatio: 1.0,
  typecheckClean: true,
  userCorrections: 0,
  importanceScore: 1.0,
  promoted: false,
  demoted: false,
  timedOut: false,
});

const badEpisode = Object.freeze({
  toolCalls: [{ exitCode: 1 }],
  errors: 4,
  testPassRatio: 0.0,
  typecheckClean: false,
  userCorrections: 3,
  importanceScore: 1.0,
  timedOut: false,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('REWARD_WEIGHTS & REWARD_CLIP', () => {
  it('exposes frozen weights', () => {
    expect(Object.isFrozen(REWARD_WEIGHTS)).toBe(true);
    expect(() => {
      REWARD_WEIGHTS.toolSuccessPerCall = 999;
    }).toThrow();
  });

  it('exposes frozen clip bounds', () => {
    expect(Object.isFrozen(REWARD_CLIP)).toBe(true);
    expect(REWARD_CLIP.min).toBe(-1.5);
    expect(REWARD_CLIP.max).toBe(1.2);
  });

  it('weights match design Section 3.1 constants', () => {
    expect(REWARD_WEIGHTS.toolSuccessPerCall).toBe(0.1);
    expect(REWARD_WEIGHTS.toolSuccessCap).toBe(0.4);
    expect(REWARD_WEIGHTS.errorPerCount).toBe(0.3);
    expect(REWARD_WEIGHTS.errorCap).toBe(0.9);
    expect(REWARD_WEIGHTS.testPass).toBe(0.5);
    expect(REWARD_WEIGHTS.typecheck).toBe(0.2);
    expect(REWARD_WEIGHTS.correctionPerCount).toBe(0.4);
    expect(REWARD_WEIGHTS.correctionCap).toBe(0.8);
    expect(REWARD_WEIGHTS.promotedBonus).toBe(0.2);
    expect(REWARD_WEIGHTS.demotedPenalty).toBe(0.3);
  });
});

describe('validateEpisodeForReward()', () => {
  it('rejects null', () => {
    expect(validateEpisodeForReward(null).ok).toBe(false);
  });

  it('rejects non-object primitives', () => {
    expect(validateEpisodeForReward('oops').ok).toBe(false);
    expect(validateEpisodeForReward(5).ok).toBe(false);
    expect(validateEpisodeForReward(true).ok).toBe(false);
  });

  it('accepts empty object with safe defaults', () => {
    const res = validateEpisodeForReward({});
    expect(res.ok).toBe(true);
    expect(res.episode.errors).toBe(0);
    expect(res.episode.userCorrections).toBe(0);
    expect(res.episode.importanceScore).toBe(0.5);
    expect(res.episode.timedOut).toBe(false);
  });

  it('rejects NaN testPassRatio', () => {
    expect(validateEpisodeForReward({ testPassRatio: NaN }).ok).toBe(false);
  });

  it('clamps importanceScore above 1', () => {
    const res = validateEpisodeForReward({ importanceScore: 9 });
    expect(res.ok).toBe(true);
    expect(res.episode.importanceScore).toBe(1);
  });

  it('clamps importanceScore below 0', () => {
    const res = validateEpisodeForReward({ importanceScore: -4 });
    expect(res.ok).toBe(true);
    expect(res.episode.importanceScore).toBe(0);
  });

  it('clamps testPassRatio into [0,1]', () => {
    const a = validateEpisodeForReward({ testPassRatio: -2 });
    const b = validateEpisodeForReward({ testPassRatio: 5 });
    expect(a.episode.testPassRatio).toBe(0);
    expect(b.episode.testPassRatio).toBe(1);
  });

  it('floors negative error counts to zero', () => {
    expect(validateEpisodeForReward({ errors: -3 }).episode.errors).toBe(0);
  });

  it('coerces boolean-ish flags', () => {
    const res = validateEpisodeForReward({
      promoted: 1, demoted: '', typecheckClean: 'yes', timedOut: 0,
    });
    expect(res.episode.promoted).toBe(true);
    expect(res.episode.demoted).toBe(false);
    expect(res.episode.typecheckClean).toBe(true);
    expect(res.episode.timedOut).toBe(false);
  });

  it('defaults toolCalls to empty array when missing', () => {
    expect(validateEpisodeForReward({}).episode.toolCalls).toEqual([]);
  });
});

describe('computeReward() — happy path', () => {
  it('gold episode yields positive reward (clipped to ceiling)', () => {
    const { reward } = computeReward(goldEpisode);
    expect(reward).toBeGreaterThan(0);
    expect(reward).toBeLessThanOrEqual(REWARD_CLIP.max);
  });

  it('saturates at REWARD_CLIP.max when signals exceed the ceiling', () => {
    const { reward } = computeReward({
      toolCalls: Array.from({ length: 10 }, () => ({ exitCode: 0 })),
      errors: 0,
      testPassRatio: 1.0,
      typecheckClean: true,
      userCorrections: 0,
      importanceScore: 1.0,
      promoted: true,
    });
    expect(reward).toBe(REWARD_CLIP.max);
  });

  it('hard-negative episode clips to REWARD_CLIP.min', () => {
    const { reward } = computeReward(badEpisode);
    expect(reward).toBe(REWARD_CLIP.min);
  });

  it('neutral episode (all defaults) yields zero', () => {
    const { reward } = computeReward({});
    expect(reward).toBe(0);
  });
});

describe('computeReward() — timeOut short-circuit', () => {
  it('returns 0 when timedOut regardless of other signals', () => {
    const { reward } = computeReward({
      ...goldEpisode,
      timedOut: true,
    });
    expect(reward).toBe(0);
  });

  it('returns 0 when timedOut even with heavy errors', () => {
    const { reward } = computeReward({
      ...badEpisode,
      timedOut: true,
    });
    expect(reward).toBe(0);
  });

  it('components.timedOut reflects the branch', () => {
    const { rewardComponents } = computeReward({ timedOut: true });
    expect(rewardComponents.timedOut).toBe(true);
  });
});

describe('computeReward() — invalid-input guard', () => {
  it('null → reward 0 with invalid flag', () => {
    const { reward, rewardComponents } = computeReward(null);
    expect(reward).toBe(0);
    expect(rewardComponents.invalid).toBe(true);
  });

  it('NaN testPassRatio → reward 0 with invalid flag', () => {
    const { reward, rewardComponents } = computeReward({ testPassRatio: NaN });
    expect(reward).toBe(0);
    expect(rewardComponents.invalid).toBe(true);
  });

  it('primitive input → reward 0', () => {
    expect(computeReward('bad').reward).toBe(0);
    expect(computeReward(42).reward).toBe(0);
  });
});

describe('computeReward() — clipping bounds', () => {
  it('reward is never < REWARD_CLIP.min', () => {
    const { reward } = computeReward({
      errors: 100,
      userCorrections: 100,
      demoted: true,
      importanceScore: 1,
    });
    expect(reward).toBeGreaterThanOrEqual(REWARD_CLIP.min);
  });

  it('reward is never > REWARD_CLIP.max', () => {
    const { reward } = computeReward({
      toolCalls: Array.from({ length: 100 }, () => ({ exitCode: 0 })),
      testPassRatio: 1,
      typecheckClean: true,
      promoted: true,
      importanceScore: 1,
    });
    expect(reward).toBeLessThanOrEqual(REWARD_CLIP.max);
  });

  it('tool success contribution caps at toolSuccessCap', () => {
    const { rewardComponents } = computeReward({
      toolCalls: Array.from({ length: 50 }, () => ({ exitCode: 0 })),
      importanceScore: 1,
    });
    expect(rewardComponents.toolSuccess).toBe(REWARD_WEIGHTS.toolSuccessCap);
  });

  it('error contribution floors at -errorCap', () => {
    const { rewardComponents } = computeReward({
      errors: 50,
      importanceScore: 1,
    });
    expect(rewardComponents.errors).toBe(-REWARD_WEIGHTS.errorCap);
  });

  it('correction contribution floors at -correctionCap', () => {
    const { rewardComponents } = computeReward({
      userCorrections: 50,
      importanceScore: 1,
    });
    expect(rewardComponents.corrections).toBe(-REWARD_WEIGHTS.correctionCap);
  });
});

describe('computeReward() — importance modulator', () => {
  it('importance 0 halves the base (modulator = 0.5)', () => {
    const { rewardComponents } = computeReward({
      toolCalls: [{ exitCode: 0 }],
      typecheckClean: true,
      importanceScore: 0,
    });
    expect(rewardComponents.importanceModulator).toBeCloseTo(0.5, 6);
  });

  it('importance 1 yields modulator 1.0', () => {
    const { rewardComponents } = computeReward({ importanceScore: 1 });
    expect(rewardComponents.importanceModulator).toBeCloseTo(1.0, 6);
  });

  it('importance 0.5 yields modulator 0.75', () => {
    const { rewardComponents } = computeReward({ importanceScore: 0.5 });
    expect(rewardComponents.importanceModulator).toBeCloseTo(0.75, 6);
  });

  it('higher importance yields larger |reward| for same signals', () => {
    const lo = computeReward({
      toolCalls: [{ exitCode: 0 }], typecheckClean: true, importanceScore: 0,
    });
    const hi = computeReward({
      toolCalls: [{ exitCode: 0 }], typecheckClean: true, importanceScore: 1,
    });
    expect(hi.reward).toBeGreaterThan(lo.reward);
  });
});

describe('computeReward() — promotion / demotion', () => {
  it('promoted adds promotedBonus', () => {
    const { rewardComponents } = computeReward({ promoted: true, importanceScore: 0 });
    expect(rewardComponents.promoted).toBe(REWARD_WEIGHTS.promotedBonus);
  });

  it('demoted subtracts demotedPenalty', () => {
    const { rewardComponents } = computeReward({ demoted: true, importanceScore: 0 });
    expect(rewardComponents.demoted).toBe(-REWARD_WEIGHTS.demotedPenalty);
  });

  it('promoted not modulated by importance (always full bonus)', () => {
    const a = computeReward({ promoted: true, importanceScore: 0 });
    const b = computeReward({ promoted: true, importanceScore: 1 });
    expect(a.rewardComponents.promoted).toBe(b.rewardComponents.promoted);
  });
});

describe('computeReward() — determinism', () => {
  it('same input produces identical output', () => {
    const a = computeReward(goldEpisode);
    const b = computeReward(goldEpisode);
    expect(a).toEqual(b);
  });

  it('has no side effects on input', () => {
    const snap = JSON.stringify(goldEpisode);
    computeReward(goldEpisode);
    expect(JSON.stringify(goldEpisode)).toBe(snap);
  });
});

describe('computeRewardComponents() — schema', () => {
  it('returns all component keys', () => {
    const { rewardComponents } = computeRewardComponents({});
    const keys = [
      'toolSuccess', 'errors', 'tests', 'typecheck',
      'corrections', 'promoted', 'demoted',
      'importanceModulator', 'preClip', 'timedOut', 'invalid',
    ];
    for (const k of keys) {
      expect(rewardComponents).toHaveProperty(k);
    }
  });

  it('preClip may exceed REWARD_CLIP bounds before clipping', () => {
    const { reward, rewardComponents } = computeRewardComponents({
      toolCalls: Array.from({ length: 100 }, () => ({ exitCode: 0 })),
      testPassRatio: 1,
      typecheckClean: true,
      promoted: true,
      importanceScore: 1,
    });
    expect(reward).toBe(REWARD_CLIP.max);
    expect(rewardComponents.preClip).toBeGreaterThanOrEqual(REWARD_CLIP.max);
  });
});

describe('computeReward() — design §3.2 shaping table', () => {
  it('task completed, tests pass, no corrections → positive reward', () => {
    const { reward } = computeReward({
      toolCalls: [{ exitCode: 0 }, { exitCode: 0 }],
      errors: 0,
      testPassRatio: 1.0,
      typecheckClean: true,
      userCorrections: 0,
      importanceScore: 0.6,
    });
    expect(reward).toBeGreaterThan(0.5);
  });

  it('task completed with minor correction → partial credit (small positive/neutral)', () => {
    const { reward } = computeReward({
      toolCalls: [{ exitCode: 0 }],
      testPassRatio: 1.0,
      typecheckClean: true,
      userCorrections: 1,
      importanceScore: 0.5,
    });
    // With one correction, reward is attenuated but non-zero.
    expect(reward).toBeGreaterThan(0);
    expect(reward).toBeLessThan(1);
  });

  it('major correction + errors → negative reward', () => {
    const { reward } = computeReward({
      toolCalls: [{ exitCode: 0 }],
      errors: 2,
      userCorrections: 2,
      importanceScore: 0.8,
    });
    expect(reward).toBeLessThan(0);
  });
});

describe('computeReward() — tool-call edge cases', () => {
  it('ignores tool calls with non-zero exit codes', () => {
    const { rewardComponents } = computeReward({
      toolCalls: [{ exitCode: 1 }, { exitCode: 2 }],
      importanceScore: 1,
    });
    expect(rewardComponents.toolSuccess).toBe(0);
  });

  it('ignores null/undefined tool entries defensively', () => {
    const { rewardComponents } = computeReward({
      toolCalls: [null, undefined, { exitCode: 0 }],
      importanceScore: 1,
    });
    expect(rewardComponents.toolSuccess).toBe(REWARD_WEIGHTS.toolSuccessPerCall);
  });

  it('treats missing exitCode as failure', () => {
    const { rewardComponents } = computeReward({
      toolCalls: [{}, { exitCode: undefined }],
      importanceScore: 1,
    });
    expect(rewardComponents.toolSuccess).toBe(0);
  });
});
