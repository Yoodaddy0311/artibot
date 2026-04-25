import { describe, expect, it } from 'vitest';
import {
  adjustSkillScore,
  correlationOf,
  DEFAULTS,
  emptyPolicy,
  familyEvidence,
  normalizeEpisode,
  updateCorrelation,
} from '../../../lib/learning/grpo/joint-policy.js';

// ---------------------------------------------------------------------------
// normalizeEpisode
// ---------------------------------------------------------------------------

describe('normalizeEpisode', () => {
  function validBase(extra = {}) {
    return {
      reward: 1,
      taskFamily: 'fam1',
      selectedAgent: 'agent-a',
      ...extra,
    };
  }

  it('returns a normalized episode for the canonical shape', () => {
    const out = normalizeEpisode(
      validBase({ skillsUsed: ['skill-x', 'skill-y'], isExploration: false }),
    );
    expect(out.family).toBe('fam1');
    expect(out.agent).toBe('agent-a');
    expect(out.skills).toEqual(['skill-x', 'skill-y']);
    expect(out.reward).toBe(1);
    expect(out.exploration).toBe(false);
  });

  it('skills defaults to empty array when missing', () => {
    expect(normalizeEpisode(validBase()).skills).toEqual([]);
  });

  it('filters non-string and empty skill names', () => {
    const out = normalizeEpisode(
      validBase({ skillsUsed: ['ok', '', null, 42, 'good'] }),
    );
    expect(out.skills).toEqual(['ok', 'good']);
  });

  it('returns null when the agent normalizer rejects', () => {
    expect(normalizeEpisode(null)).toBeNull();
    expect(normalizeEpisode({})).toBeNull();
    expect(normalizeEpisode({ reward: 1, taskFamily: 'x' })).toBeNull();
  });

  it('handles non-array skillsUsed gracefully', () => {
    const out = normalizeEpisode(validBase({ skillsUsed: 'not-an-array' }));
    expect(out.skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// correlationOf
// ---------------------------------------------------------------------------

describe('correlationOf', () => {
  function policyWith(family, agent, count, skills) {
    const p = emptyPolicy();
    p.correlation[family] = Object.create(null);
    p.correlation[family][agent] = { agentCount: count, skills };
    return p;
  }

  it('returns 0 for null/empty policy', () => {
    expect(correlationOf(null, 'f', 'a', 's')).toBe(0);
    expect(correlationOf(undefined, 'f', 'a', 's')).toBe(0);
    expect(correlationOf(emptyPolicy(), 'missing', 'a', 's')).toBe(0);
  });

  it('returns 0 when family present but agent missing', () => {
    const p = policyWith('f', 'a', 5, { s: 3 });
    expect(correlationOf(p, 'f', 'other', 's')).toBe(0);
  });

  it('returns 0 when agentCount is non-positive or invalid', () => {
    expect(correlationOf(policyWith('f', 'a', 0, { s: 1 }), 'f', 'a', 's')).toBe(0);
    expect(correlationOf(policyWith('f', 'a', NaN, { s: 1 }), 'f', 'a', 's')).toBe(0);
  });

  it('returns 0 when skill count is missing or non-positive', () => {
    expect(correlationOf(policyWith('f', 'a', 10, {}), 'f', 'a', 'absent')).toBe(0);
    expect(correlationOf(policyWith('f', 'a', 10, { s: 0 }), 'f', 'a', 's')).toBe(0);
  });

  it('returns the conditional probability clamped to [0, 1]', () => {
    expect(correlationOf(policyWith('f', 'a', 10, { s: 4 }), 'f', 'a', 's')).toBeCloseTo(0.4);
    // skill > agent (impossible in practice but bound enforced)
    expect(correlationOf(policyWith('f', 'a', 10, { s: 50 }), 'f', 'a', 's')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// familyEvidence
// ---------------------------------------------------------------------------

describe('familyEvidence', () => {
  it('returns 0 for null/empty policy or missing family', () => {
    expect(familyEvidence(null, 'f')).toBe(0);
    expect(familyEvidence(emptyPolicy(), 'f')).toBe(0);
  });

  it('sums agentCount across the family', () => {
    const p = emptyPolicy();
    p.correlation.fam = Object.create(null);
    p.correlation.fam.a1 = { agentCount: 3, skills: {} };
    p.correlation.fam.a2 = { agentCount: 5, skills: {} };
    p.correlation.fam.broken = { agentCount: NaN, skills: {} }; // ignored
    expect(familyEvidence(p, 'fam')).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// adjustSkillScore
// ---------------------------------------------------------------------------

describe('adjustSkillScore', () => {
  it('returns 0 for non-finite scores', () => {
    expect(adjustSkillScore(NaN, 0.5)).toBe(0);
    expect(adjustSkillScore(Infinity, 0.5)).toBe(0);
  });

  it('treats non-finite corr as 0 (no change)', () => {
    expect(adjustSkillScore(0.5, NaN)).toBeCloseTo(0.5);
    expect(adjustSkillScore(0.5, Infinity)).toBeCloseTo(0.5);
  });

  it('clamps corr into [0, 1]', () => {
    // negative corr → treated as 0 → no change
    expect(adjustSkillScore(0.4, -0.5, 1)).toBeCloseTo(0.4);
    // corr > 1 → clamped → score * (1 + 1*1) = 2*score → clamp to 1
    expect(adjustSkillScore(0.6, 5, 1)).toBe(1);
  });

  it('uses the default lambda when omitted', () => {
    const out = adjustSkillScore(0.4, 0.5);
    expect(out).toBeCloseTo(0.4 * (1 + DEFAULTS.lambda * 0.5));
  });

  it('clamps the adjusted result into [0, 1]', () => {
    expect(adjustSkillScore(0.9, 1, 5)).toBe(1);
    expect(adjustSkillScore(0, 1, 5)).toBe(0);
  });

  it('falls back to original score if adjusted is non-finite (defensive)', () => {
    // lambda=Infinity → finite check via Number.isFinite
    // Lambda=Infinity is intercepted (not Number.isFinite) → treated as 0 → no change
    expect(adjustSkillScore(0.5, 0.5, Infinity)).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// updateCorrelation
// ---------------------------------------------------------------------------

describe('updateCorrelation', () => {
  it('handles empty / null episode lists', () => {
    const t = emptyPolicy();
    const out1 = updateCorrelation(t, undefined);
    expect(out1).toEqual({ episodesUsed: 0, familiesTouched: 0, agentSkillPairs: 0 });

    const out2 = updateCorrelation(t, []);
    expect(out2).toEqual({ episodesUsed: 0, familiesTouched: 0, agentSkillPairs: 0 });
  });

  it('skips exploration episodes', () => {
    const t = emptyPolicy();
    const result = updateCorrelation(t, [
      { family: 'f', agent: 'a', skills: ['s'], reward: 1, exploration: true },
    ]);
    expect(result.episodesUsed).toBe(0);
    expect(t.correlation.f).toBeUndefined();
  });

  it('skips falsy entries', () => {
    const t = emptyPolicy();
    const result = updateCorrelation(t, [null, undefined, false]);
    expect(result.episodesUsed).toBe(0);
  });

  it('folds non-exploration episodes into the tensor', () => {
    const t = emptyPolicy();
    const result = updateCorrelation(t, [
      { family: 'f', agent: 'a', skills: ['s1', 's2'], reward: 1, exploration: false },
      { family: 'f', agent: 'a', skills: ['s1'], reward: 1, exploration: false },
      { family: 'f', agent: 'b', skills: [], reward: 0, exploration: false },
    ]);
    expect(result.episodesUsed).toBe(3);
    expect(result.familiesTouched).toBe(1);
    expect(result.agentSkillPairs).toBe(3);

    expect(t.correlation.f.a.agentCount).toBe(2);
    expect(t.correlation.f.a.skills.s1).toBe(2);
    expect(t.correlation.f.a.skills.s2).toBe(1);
    expect(t.correlation.f.b.agentCount).toBe(1);
  });

  it('counts touched families uniquely across episodes', () => {
    const t = emptyPolicy();
    const result = updateCorrelation(t, [
      { family: 'f1', agent: 'a', skills: [], reward: 1, exploration: false },
      { family: 'f2', agent: 'a', skills: [], reward: 1, exploration: false },
      { family: 'f1', agent: 'b', skills: [], reward: 1, exploration: false },
    ]);
    expect(result.familiesTouched).toBe(2);
  });

  it('trims agents per family when above maxAgentsPerFamily', () => {
    const t = emptyPolicy();
    const episodes = [];
    // 5 distinct agents with descending counts
    for (let i = 0; i < 5; i++) {
      const agent = `a${i}`;
      const repeats = 5 - i; // a0 → 5, a1 → 4, a2 → 3, a3 → 2, a4 → 1
      for (let r = 0; r < repeats; r++) {
        episodes.push({ family: 'f', agent, skills: [], reward: 1, exploration: false });
      }
    }
    updateCorrelation(t, episodes, { maxAgentsPerFamily: 3 });
    const remaining = Object.keys(t.correlation.f);
    expect(remaining.length).toBe(3);
    // Lowest-count agents (a4, a3) should have been dropped.
    expect(remaining).not.toContain('a4');
    expect(remaining).not.toContain('a3');
  });

  it('trims skills per cell when above maxSkillsPerCell', () => {
    const t = emptyPolicy();
    const episodes = [];
    for (let i = 0; i < 5; i++) {
      // s0 used 5x, s1 4x, s2 3x, s3 2x, s4 1x
      const skill = `s${i}`;
      for (let r = 0; r < 5 - i; r++) {
        episodes.push({ family: 'f', agent: 'a', skills: [skill], reward: 1, exploration: false });
      }
    }
    updateCorrelation(t, episodes, { maxSkillsPerCell: 2 });
    const skills = Object.keys(t.correlation.f.a.skills);
    expect(skills.length).toBe(2);
    expect(skills).toContain('s0');
    expect(skills).toContain('s1');
  });

  it('honours DEFAULTS when maxAgents/maxSkills options omitted', () => {
    const t = emptyPolicy();
    const result = updateCorrelation(t, [
      { family: 'f', agent: 'a', skills: ['x'], reward: 1, exploration: false },
    ]);
    expect(result.episodesUsed).toBe(1);
    // No trimming because we are well under defaults.
    expect(t.correlation.f.a.skills.x).toBe(1);
  });
});
