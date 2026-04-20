import { describe, expect, it } from 'vitest';
import {
  applyMode,
  detectMode,
  getActiveMode,
  getModeConfig,
  MODES,
} from '../../lib/cognitive/context-modes.js';

// ---------------------------------------------------------------------------
// MODES enum
// ---------------------------------------------------------------------------

describe('MODES', () => {
  it('has exactly 5 modes', () => {
    expect(Object.keys(MODES)).toHaveLength(5);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MODES)).toBe(true);
  });

  it.each(['DEV', 'REVIEW', 'PLAN', 'DEBUG', 'RESEARCH'])(
    'contains %s',
    (mode) => {
      expect(MODES[mode]).toBe(mode);
    },
  );
});

// ---------------------------------------------------------------------------
// getModeConfig
// ---------------------------------------------------------------------------

describe('getModeConfig', () => {
  it('returns DEV config with wildcard skills', () => {
    const cfg = getModeConfig(MODES.DEV);
    expect(cfg.skills).toBe('*');
    expect(cfg.tools).toContain('Write');
    expect(cfg.tools).toContain('Edit');
    expect(cfg.guardrails).toBe('standard');
  });

  it('returns REVIEW config with write-restricted guardrails', () => {
    const cfg = getModeConfig(MODES.REVIEW);
    expect(cfg.skills).toEqual(['code-review', 'testing-standards']);
    expect(cfg.tools).not.toContain('Write');
    expect(cfg.tools).not.toContain('Edit');
    expect(cfg.guardrails).toBe('write-restricted');
  });

  it('returns PLAN config with read-only guardrails', () => {
    const cfg = getModeConfig(MODES.PLAN);
    expect(cfg.skills).toEqual(['plan', 'estimate', 'design']);
    expect(cfg.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(cfg.guardrails).toBe('read-only');
  });

  it('returns DEBUG config with Bash access', () => {
    const cfg = getModeConfig(MODES.DEBUG);
    expect(cfg.skills).toEqual(['troubleshoot', 'systematic-debugging']);
    expect(cfg.tools).toContain('Bash');
    expect(cfg.guardrails).toBe('standard');
  });

  it('returns RESEARCH config with WebSearch', () => {
    const cfg = getModeConfig(MODES.RESEARCH);
    expect(cfg.skills).toEqual(['content', 'explain']);
    expect(cfg.tools).toContain('WebSearch');
    expect(cfg.guardrails).toBe('read-only');
  });

  it('throws on invalid mode', () => {
    expect(() => getModeConfig('INVALID')).toThrow('Invalid mode');
  });

  it('returns a defensive copy (mutating result does not affect internals)', () => {
    const cfg1 = getModeConfig(MODES.REVIEW);
    cfg1.tools.push('Write');
    const cfg2 = getModeConfig(MODES.REVIEW);
    expect(cfg2.tools).not.toContain('Write');
  });
});

// ---------------------------------------------------------------------------
// detectMode — keyword matching
// ---------------------------------------------------------------------------

describe('detectMode', () => {
  describe('keyword matching', () => {
    it.each([
      ['please review this code', MODES.REVIEW],
      ['코드 리뷰 해주세요', MODES.REVIEW],
      ['レビューお願いします', MODES.REVIEW],
      ['代码审查', MODES.REVIEW],
    ])('detects REVIEW from: "%s"', (intent, expected) => {
      expect(detectMode(intent)).toBe(expected);
    });

    it.each([
      ['plan the architecture', MODES.PLAN],
      ['설계 문서 작성해줘', MODES.PLAN],
      ['estimate the effort', MODES.PLAN],
      ['plan this feature', MODES.PLAN],
    ])('detects PLAN from: "%s"', (intent, expected) => {
      expect(detectMode(intent)).toBe(expected);
    });

    it.each([
      ['debug this error', MODES.DEBUG],
      ['there is a bug in login', MODES.DEBUG],
      ['에러 수정해줘', MODES.DEBUG],
      ['fix the crash', MODES.DEBUG],
      ['调试这个问题', MODES.DEBUG],
    ])('detects DEBUG from: "%s"', (intent, expected) => {
      expect(detectMode(intent)).toBe(expected);
    });

    it.each([
      ['research best practices', MODES.RESEARCH],
      ['explain how hooks work', MODES.RESEARCH],
      ['이 개념 설명해줘', MODES.RESEARCH],
      ['研究一下', MODES.RESEARCH],
    ])('detects RESEARCH from: "%s"', (intent, expected) => {
      expect(detectMode(intent)).toBe(expected);
    });
  });

  describe('complexity fallback', () => {
    it('returns PLAN for high complexity (>= 0.7) with no keyword match', () => {
      expect(detectMode('implement feature X', { complexity: 0.8 })).toBe(MODES.PLAN);
    });

    it('returns DEV for low complexity (< 0.3) with no keyword match', () => {
      expect(detectMode('add a button', { complexity: 0.1 })).toBe(MODES.DEV);
    });

    it('returns DEV for mid complexity with no keyword match', () => {
      expect(detectMode('refactor the module', { complexity: 0.5 })).toBe(MODES.DEV);
    });

    it('returns DEV when no routing provided', () => {
      expect(detectMode('do something')).toBe(MODES.DEV);
    });
  });

  describe('keyword takes priority over complexity', () => {
    it('returns REVIEW even with high complexity', () => {
      expect(detectMode('review my PR', { complexity: 0.9 })).toBe(MODES.REVIEW);
    });

    it('returns DEBUG even with low complexity', () => {
      expect(detectMode('fix this bug', { complexity: 0.1 })).toBe(MODES.DEBUG);
    });
  });

  describe('edge cases', () => {
    it('handles empty intent', () => {
      expect(detectMode('')).toBe(MODES.DEV);
    });

    it('handles null intent', () => {
      expect(detectMode(null)).toBe(MODES.DEV);
    });

    it('handles undefined intent', () => {
      expect(detectMode(undefined)).toBe(MODES.DEV);
    });

    it('is case-insensitive', () => {
      expect(detectMode('REVIEW this')).toBe(MODES.REVIEW);
      expect(detectMode('DEBUG the issue')).toBe(MODES.DEBUG);
    });
  });
});

// ---------------------------------------------------------------------------
// applyMode
// ---------------------------------------------------------------------------

describe('applyMode', () => {
  it('adds mode to state.context', () => {
    const state = { session: 'abc', context: { domain: 'frontend' } };
    const result = applyMode(MODES.REVIEW, state);
    expect(result.context.mode).toBe(MODES.REVIEW);
    expect(result.context.domain).toBe('frontend');
    expect(result.session).toBe('abc');
  });

  it('does not mutate original state', () => {
    const state = { context: { domain: 'backend' } };
    const result = applyMode(MODES.PLAN, state);
    expect(state.context.mode).toBeUndefined();
    expect(result.context.mode).toBe(MODES.PLAN);
  });

  it('creates context if state has none', () => {
    const result = applyMode(MODES.DEV, {});
    expect(result.context.mode).toBe(MODES.DEV);
  });

  it('creates context if state is null-ish', () => {
    const result = applyMode(MODES.DEBUG, null);
    expect(result.context.mode).toBe(MODES.DEBUG);
  });

  it('throws on invalid mode', () => {
    expect(() => applyMode('INVALID', {})).toThrow('Invalid mode');
  });
});

// ---------------------------------------------------------------------------
// getActiveMode
// ---------------------------------------------------------------------------

describe('getActiveMode', () => {
  it('returns mode from state.context.mode', () => {
    expect(getActiveMode({ context: { mode: MODES.REVIEW } })).toBe(MODES.REVIEW);
  });

  it('returns null when no mode set', () => {
    expect(getActiveMode({ context: {} })).toBeNull();
  });

  it('returns null when no context', () => {
    expect(getActiveMode({})).toBeNull();
  });

  it('returns null for null state', () => {
    expect(getActiveMode(null)).toBeNull();
  });

  it('returns null for invalid mode value', () => {
    expect(getActiveMode({ context: { mode: 'BOGUS' } })).toBeNull();
  });

  it.each(Object.values(MODES))('returns valid mode: %s', (mode) => {
    expect(getActiveMode({ context: { mode } })).toBe(mode);
  });
});
