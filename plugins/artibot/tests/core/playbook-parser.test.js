import { describe, expect, it } from 'vitest';
import {
  KNOWN_ACTIONS,
  KNOWN_PATTERNS,
  parsePlaybook,
  serializePlaybook,
  validatePlaybook,
} from '../../lib/core/playbook-parser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('KNOWN_PATTERNS', () => {
  it('contains expected patterns', () => {
    expect(KNOWN_PATTERNS.has('leader')).toBe(true);
    expect(KNOWN_PATTERNS.has('council')).toBe(true);
    expect(KNOWN_PATTERNS.has('swarm')).toBe(true);
    expect(KNOWN_PATTERNS.has('pipeline')).toBe(true);
    expect(KNOWN_PATTERNS.has('watchdog')).toBe(true);
    expect(KNOWN_PATTERNS.has('unknown')).toBe(false);
  });
});

describe('KNOWN_ACTIONS', () => {
  it('contains expected actions', () => {
    for (const action of ['plan', 'design', 'implement', 'review', 'merge', 'analyze', 'fix', 'verify', 'scan', 'assess']) {
      expect(KNOWN_ACTIONS.has(action)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parsePlaybook()
// ---------------------------------------------------------------------------

describe('parsePlaybook()', () => {
  it('parses a simple 1-phase playbook', () => {
    const result = parsePlaybook('[leader] plan');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]).toEqual({ order: 0, pattern: 'leader', action: 'plan', label: 'plan' });
  });

  it('parses the feature playbook', () => {
    const result = parsePlaybook('[leader] plan -> [council] design -> [swarm] implement -> [council] review -> [leader] merge');
    expect(result.phases).toHaveLength(5);
    expect(result.phases[0]).toEqual({ order: 0, pattern: 'leader', action: 'plan', label: 'plan' });
    expect(result.phases[1]).toEqual({ order: 1, pattern: 'council', action: 'design', label: 'design' });
    expect(result.phases[2]).toEqual({ order: 2, pattern: 'swarm', action: 'implement', label: 'implement' });
    expect(result.phases[3]).toEqual({ order: 3, pattern: 'council', action: 'review', label: 'review' });
    expect(result.phases[4]).toEqual({ order: 4, pattern: 'leader', action: 'merge', label: 'merge' });
  });

  it('parses the bugfix playbook', () => {
    const result = parsePlaybook('[leader] analyze -> [pipeline] fix -> [council] verify');
    expect(result.phases).toHaveLength(3);
    expect(result.phases[1]).toEqual({ order: 1, pattern: 'pipeline', action: 'fix', label: 'fix' });
  });

  it('parses the refactor playbook', () => {
    const result = parsePlaybook('[council] assess -> [pipeline] refactor -> [swarm] test -> [council] review');
    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].pattern).toBe('council');
    expect(result.phases[1].action).toBe('refactor');
  });

  it('parses the security playbook', () => {
    const result = parsePlaybook('[leader] scan -> [council] assess -> [pipeline] fix -> [council] verify');
    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].action).toBe('scan');
    expect(result.phases[2].pattern).toBe('pipeline');
  });

  it('parses the marketing-campaign playbook', () => {
    const result = parsePlaybook('[leader] strategy -> [council] plan -> [swarm] create -> [council] review -> [leader] launch');
    expect(result.phases).toHaveLength(5);
    expect(result.phases[4].action).toBe('launch');
  });

  it('parses the marketing-audit playbook', () => {
    const result = parsePlaybook('[leader] scan -> [council] assess -> [pipeline] optimize -> [council] verify');
    expect(result.phases).toHaveLength(4);
  });

  it('parses the content-launch playbook', () => {
    const result = parsePlaybook('[leader] plan -> [swarm] create -> [council] review -> [leader] publish');
    expect(result.phases).toHaveLength(4);
    expect(result.phases[3].action).toBe('publish');
  });

  it('parses the competitive-analysis playbook', () => {
    const result = parsePlaybook('[council] research -> [swarm] analyze -> [council] synthesize -> [leader] report');
    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].action).toBe('research');
    expect(result.phases[3].action).toBe('report');
  });

  it('trims whitespace around segments', () => {
    const result = parsePlaybook('  [leader] plan  ->  [swarm] implement  ');
    expect(result.phases).toHaveLength(2);
  });

  it('returns empty phases for empty string', () => {
    expect(parsePlaybook('')).toEqual({ phases: [] });
    expect(parsePlaybook('   ')).toEqual({ phases: [] });
  });

  it('returns empty phases for null or undefined', () => {
    expect(parsePlaybook(null)).toEqual({ phases: [] });
    expect(parsePlaybook(undefined)).toEqual({ phases: [] });
  });

  it('returns empty phases for non-string non-object', () => {
    expect(parsePlaybook(42)).toEqual({ phases: [] });
  });

  it('skips segments with invalid format (no brackets)', () => {
    const result = parsePlaybook('leader plan -> [council] design');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].pattern).toBe('council');
  });

  it('handles backward-compatible already-parsed object', () => {
    const alreadyParsed = {
      phases: [
        { order: 0, pattern: 'leader', action: 'plan', label: 'plan' },
      ],
    };
    const result = parsePlaybook(alreadyParsed);
    expect(result).toBe(alreadyParsed); // same reference
  });

  it('normalizes pattern and action to lowercase', () => {
    const result = parsePlaybook('[LEADER] PLAN -> [Council] Design');
    expect(result.phases[0].pattern).toBe('leader');
    expect(result.phases[0].action).toBe('plan');
    expect(result.phases[1].pattern).toBe('council');
    expect(result.phases[1].action).toBe('design');
  });
});

// ---------------------------------------------------------------------------
// validatePlaybook()
// ---------------------------------------------------------------------------

describe('validatePlaybook()', () => {
  it('validates a correct playbook as valid', () => {
    const pb = parsePlaybook('[leader] plan -> [swarm] implement');
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects a playbook with zero phases', () => {
    const { valid, errors } = validatePlaybook({ phases: [] });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('at least 1'))).toBe(true);
  });

  it('rejects null input', () => {
    const { valid, errors } = validatePlaybook(null);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects non-object input', () => {
    const { valid, errors } = validatePlaybook('bad');
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects playbook without phases array', () => {
    const { valid, errors } = validatePlaybook({ foo: 'bar' });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('phases array'))).toBe(true);
  });

  it('rejects unknown patterns', () => {
    const pb = {
      phases: [{ order: 0, pattern: 'unknown', action: 'plan', label: 'plan' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("unknown pattern 'unknown'"))).toBe(true);
  });

  it('rejects empty action', () => {
    const pb = {
      phases: [{ order: 0, pattern: 'leader', action: '', label: '' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('action'))).toBe(true);
  });

  it('validates all 8 system playbooks correctly', () => {
    const playbooks = [
      '[leader] plan -> [council] design -> [swarm] implement -> [council] review -> [leader] merge',
      '[leader] analyze -> [pipeline] fix -> [council] verify',
      '[council] assess -> [pipeline] refactor -> [swarm] test -> [council] review',
      '[leader] scan -> [council] assess -> [pipeline] fix -> [council] verify',
      '[leader] strategy -> [council] plan -> [swarm] create -> [council] review -> [leader] launch',
      '[leader] scan -> [council] assess -> [pipeline] optimize -> [council] verify',
      '[leader] plan -> [swarm] create -> [council] review -> [leader] publish',
      '[council] research -> [swarm] analyze -> [council] synthesize -> [leader] report',
    ];

    for (const pb of playbooks) {
      const parsed = parsePlaybook(pb);
      const { valid, errors } = validatePlaybook(parsed);
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    }
  });

  it('accumulates multiple errors', () => {
    const pb = {
      phases: [
        { order: 0, pattern: 'bad1', action: '', label: '' },
        { order: 1, pattern: 'bad2', action: 'plan', label: 'plan' },
      ],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// serializePlaybook()
// ---------------------------------------------------------------------------

describe('serializePlaybook()', () => {
  it('serializes a single-phase playbook', () => {
    const pb = { phases: [{ order: 0, pattern: 'leader', action: 'plan', label: 'plan' }] };
    expect(serializePlaybook(pb)).toBe('[leader] plan');
  });

  it('serializes a multi-phase playbook', () => {
    const pb = parsePlaybook('[leader] plan -> [council] design -> [swarm] implement');
    const str = serializePlaybook(pb);
    expect(str).toBe('[leader] plan -> [council] design -> [swarm] implement');
  });

  it('round-trips all 8 system playbooks', () => {
    const originals = [
      '[leader] plan -> [council] design -> [swarm] implement -> [council] review -> [leader] merge',
      '[leader] analyze -> [pipeline] fix -> [council] verify',
      '[council] assess -> [pipeline] refactor -> [swarm] test -> [council] review',
      '[leader] scan -> [council] assess -> [pipeline] fix -> [council] verify',
      '[leader] strategy -> [council] plan -> [swarm] create -> [council] review -> [leader] launch',
      '[leader] scan -> [council] assess -> [pipeline] optimize -> [council] verify',
      '[leader] plan -> [swarm] create -> [council] review -> [leader] publish',
      '[council] research -> [swarm] analyze -> [council] synthesize -> [leader] report',
    ];

    for (const orig of originals) {
      const parsed = parsePlaybook(orig);
      const serialized = serializePlaybook(parsed);
      expect(serialized).toBe(orig);
    }
  });

  it('returns empty string for null input', () => {
    expect(serializePlaybook(null)).toBe('');
    expect(serializePlaybook(undefined)).toBe('');
  });

  it('returns empty string for object without phases', () => {
    expect(serializePlaybook({})).toBe('');
  });

  it('returns empty string for empty phases array', () => {
    expect(serializePlaybook({ phases: [] })).toBe('');
  });
});
