import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  packagePatterns,
  unpackWeights,
  mergeWeights,
} from '../../lib/swarm/pattern-packager.js';

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
}));

const { readJsonFile } = await import('../../lib/core/file.js');

// Helper: build a valid pattern
function makePattern(type, category, overrides = {}) {
  return {
    key: `${type}::${category}`,
    type,
    category,
    sampleSize: 10,
    confidence: 0.8,
    bestData: {},
    ...overrides,
  };
}

describe('packagePatterns()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJsonFile.mockResolvedValue(null);
  });

  it('returns empty weights when no patterns provided', async () => {
    const result = await packagePatterns([]);
    expect(result.weights).toEqual({ tools: {}, errors: {}, commands: {}, teams: {} });
    expect(result.metadata.packagedCount).toBe(0);
  });

  it('skips patterns with insufficient sample size', async () => {
    const pattern = makePattern('tool', 'Read', { sampleSize: 2 });
    const result = await packagePatterns([pattern]);
    expect(result.weights.tools).toEqual({});
  });

  it('skips patterns with low confidence', async () => {
    const pattern = makePattern('tool', 'Read', { confidence: 0.3 });
    const result = await packagePatterns([pattern]);
    expect(result.weights.tools).toEqual({});
  });

  it('packages tool patterns into weights.tools', async () => {
    const pattern = makePattern('tool', 'Read', {
      bestData: { successRate: 0.95, avgMs: 100 },
    });
    const result = await packagePatterns([pattern]);
    expect(result.weights.tools.Read).toBeDefined();
    expect(result.weights.tools.Read.successRate).toBeGreaterThan(0);
    expect(result.weights.tools.Read.confidence).toBe(0.8);
  });

  it('packages error patterns into weights.errors (anonymized key)', async () => {
    const pattern = makePattern('error', 'TypeError', {
      bestData: { recoverable: true },
    });
    const result = await packagePatterns([pattern]);
    const keys = Object.keys(result.weights.errors);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe('TypeError'); // anonymized
    expect(keys[0]).toMatch(/^[a-f0-9]{12}$/);
  });

  it('packages success/command patterns into weights.commands', async () => {
    const pattern = makePattern('success', 'build', {
      bestData: { duration: 30000, filesModified: 5, testsPass: true },
    });
    const result = await packagePatterns([pattern]);
    expect(result.weights.commands.build).toBeDefined();
    expect(result.weights.commands.build.effectiveness).toBe(0.8);
  });

  it('packages team patterns into weights.teams', async () => {
    const pattern = makePattern('team', 'leader', {
      bestData: { size: 3, duration: 60000 },
    });
    const result = await packagePatterns([pattern]);
    expect(result.weights.teams.leader).toBeDefined();
    expect(result.weights.teams.leader.effectiveness).toBe(0.8);
    expect(result.weights.teams.leader.optimalSize).toBe(3);
  });

  it('returns checksum as 64-char hex string', async () => {
    const result = await packagePatterns([]);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('includes metadata with packagedAt timestamp', async () => {
    const result = await packagePatterns([]);
    expect(result.metadata.packagedAt).toBeTruthy();
    expect(new Date(result.metadata.packagedAt).toISOString()).toBeTruthy();
  });

  it('loads patterns from disk when none provided', async () => {
    readJsonFile.mockResolvedValue({ patterns: [] });
    await packagePatterns(); // no arg
    expect(readJsonFile).toHaveBeenCalled();
  });

  it('normalizes successRate to 0-1 range', async () => {
    const pattern = makePattern('tool', 'Write', {
      bestData: { successRate: 1.5, avgMs: 0 },
    });
    const result = await packagePatterns([pattern]);
    expect(result.weights.tools.Write.successRate).toBeLessThanOrEqual(1);
  });
});

describe('unpackWeights()', () => {
  it('returns empty array for null input', () => {
    expect(unpackWeights(null)).toEqual([]);
  });

  it('returns empty array for non-object input', () => {
    expect(unpackWeights('string')).toEqual([]);
  });

  it('unpacks tool weights into pattern array', () => {
    const globalWeights = {
      tools: { Read: { successRate: 0.9, avgLatency: 0.8, confidence: 0.85, sampleSize: 50 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].key).toBe('tool::Read');
    expect(patterns[0].type).toBe('tool');
    expect(patterns[0].source).toBe('swarm-global');
  });

  it('unpacks error weights into pattern array', () => {
    const globalWeights = {
      errors: { abc123def456: { frequency: 0.3, recoverable: 1.0, sampleSize: 10 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns[0].key).toBe('error::abc123def456');
    expect(patterns[0].bestData.recoverable).toBe(true);
  });

  it('unpacks command weights into pattern array', () => {
    const globalWeights = {
      commands: { build: { effectiveness: 0.9, avgDuration: 0.8, filesModified: 0.7, testsPass: 0.9, sampleSize: 30 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns[0].key).toBe('success::build');
    expect(patterns[0].type).toBe('success');
  });

  it('unpacks team weights into pattern array', () => {
    const globalWeights = {
      teams: { leader: { effectiveness: 0.85, optimalSize: 3, avgDuration: 0.6, sampleSize: 15 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns[0].key).toBe('team::leader');
    expect(patterns[0].bestData.size).toBe(3);
  });

  it('includes extractedAt timestamp on all patterns', () => {
    const globalWeights = {
      tools: { Read: { successRate: 0.9, sampleSize: 10 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns[0].extractedAt).toBeTruthy();
  });

  it('handles partial weights (only tools)', () => {
    const globalWeights = { tools: { Read: { successRate: 0.8, sampleSize: 5 } } };
    const patterns = unpackWeights(globalWeights);
    expect(patterns).toHaveLength(1);
    expect(patterns.every((p) => p.type === 'tool')).toBe(true);
  });
});

describe('mergeWeights()', () => {
  const localWeights = {
    tools: { Read: { successRate: 0.8, confidence: 0.7, sampleSize: 10 } },
    errors: {},
    commands: {},
    teams: {},
  };
  const globalWeights = {
    tools: { Read: { successRate: 0.95, confidence: 0.9, sampleSize: 50 } },
    errors: {},
    commands: { build: { effectiveness: 0.85, sampleSize: 30 } },
    teams: {},
  };

  it('returns empty object for null+null', () => {
    expect(mergeWeights(null, null)).toEqual({});
  });

  it('returns global when local is null', () => {
    expect(mergeWeights(null, globalWeights)).toBe(globalWeights);
  });

  it('returns local when global is null', () => {
    expect(mergeWeights(localWeights, null)).toBe(localWeights);
  });

  it('applies default 30/70 ratio for numeric fields', () => {
    const merged = mergeWeights(localWeights, globalWeights);
    const expected = 0.8 * 0.3 + 0.95 * 0.7;
    expect(merged.tools.Read.successRate).toBeCloseTo(expected, 3);
  });

  it('accepts custom merge ratio', () => {
    const merged = mergeWeights(localWeights, globalWeights, [0.5, 0.5]);
    const expected = 0.8 * 0.5 + 0.95 * 0.5;
    expect(merged.tools.Read.successRate).toBeCloseTo(expected, 3);
  });

  it('includes global-only keys in merged result', () => {
    const merged = mergeWeights(localWeights, globalWeights);
    expect(merged.commands.build).toBeDefined();
    expect(merged.commands.build.effectiveness).toBe(0.85);
  });

  it('includes local-only keys in merged result', () => {
    const local = {
      tools: {},
      errors: {},
      commands: { localCmd: { effectiveness: 0.6, sampleSize: 5 } },
      teams: {},
    };
    const global_ = { tools: {}, errors: {}, commands: {}, teams: {} };
    const merged = mergeWeights(local, global_);
    expect(merged.commands.localCmd).toBeDefined();
  });

  it('preserves all weight categories in output', () => {
    const merged = mergeWeights(localWeights, globalWeights);
    expect(merged).toHaveProperty('tools');
    expect(merged).toHaveProperty('errors');
    expect(merged).toHaveProperty('commands');
    expect(merged).toHaveProperty('teams');
  });

  it('handles mergeEntries where local has value but global does not', () => {
    const local = {
      tools: { Read: { successRate: 0.8, customField: 'localOnly', sampleSize: 10 } },
      errors: {},
      commands: {},
      teams: {},
    };
    const global_ = {
      tools: { Read: { successRate: 0.9 } },
      errors: {},
      commands: {},
      teams: {},
    };
    const merged = mergeWeights(local, global_);
    // customField exists only in local, should be preserved
    expect(merged.tools.Read.customField).toBe('localOnly');
  });

  it('handles mergeEntries where global has value but local does not', () => {
    const local = {
      tools: { Read: { successRate: 0.8 } },
      errors: {},
      commands: {},
      teams: {},
    };
    const global_ = {
      tools: { Read: { successRate: 0.9, globalOnly: 'fromGlobal' } },
      errors: {},
      commands: {},
      teams: {},
    };
    const merged = mergeWeights(local, global_);
    // globalOnly exists only in global, should be preserved
    expect(merged.tools.Read.globalOnly).toBe('fromGlobal');
  });

  it('handles mergeEntries where both have non-numeric values (local takes precedence)', () => {
    const local = {
      tools: { Read: { label: 'local-label', successRate: 0.8 } },
      errors: {},
      commands: {},
      teams: {},
    };
    const global_ = {
      tools: { Read: { label: 'global-label', successRate: 0.9 } },
      errors: {},
      commands: {},
      teams: {},
    };
    const merged = mergeWeights(local, global_);
    // Non-numeric: localVal !== undefined, so local takes precedence
    expect(merged.tools.Read.label).toBe('local-label');
  });

  it('handles mergeEntries where localVal is undefined and globalVal is non-numeric', () => {
    const local = {
      tools: { Read: { successRate: 0.8 } },
      errors: {},
      commands: {},
      teams: {},
    };
    const global_ = {
      tools: { Read: { successRate: 0.9, tag: 'global-tag' } },
      errors: {},
      commands: {},
      teams: {},
    };
    const merged = mergeWeights(local, global_);
    // tag only in global, localVal is undefined -> falls to else branch
    expect(merged.tools.Read.tag).toBe('global-tag');
  });
});

describe('packagePatterns() additional branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJsonFile.mockResolvedValue(null);
  });

  it('skips patterns without a key', async () => {
    const pattern = { sampleSize: 10, confidence: 0.8, bestData: {} };
    const result = await packagePatterns([pattern]);
    expect(result.metadata.packagedCount).toBe(0);
  });

  it('handles error pattern with recoverable=false', async () => {
    const pattern = makePattern('error', 'NetworkError', {
      bestData: { recoverable: false, message: 'Connection refused to server at port 5432' },
    });
    const result = await packagePatterns([pattern]);
    const keys = Object.keys(result.weights.errors);
    expect(keys).toHaveLength(1);
    const errorWeight = result.weights.errors[keys[0]];
    expect(errorWeight.recoverable).toBe(0.0);
  });

  it('handles error pattern with recoverable=undefined (neutral 0.5)', async () => {
    const pattern = makePattern('error', 'UnknownError', {
      bestData: { message: 'Something went wrong' },
    });
    const result = await packagePatterns([pattern]);
    const keys = Object.keys(result.weights.errors);
    const errorWeight = result.weights.errors[keys[0]];
    expect(errorWeight.recoverable).toBe(0.5);
  });

  it('handles error pattern with empty/missing message', async () => {
    const pattern = makePattern('error', 'EmptyMsg', {
      bestData: {},
    });
    const result = await packagePatterns([pattern]);
    const keys = Object.keys(result.weights.errors);
    expect(keys).toHaveLength(1);
    // signature should anonymize the category since message is missing
    expect(result.weights.errors[keys[0]].signature).toMatch(/^[a-f0-9]{12}$/);
  });

  it('handles command pattern with testsPass=false', async () => {
    const pattern = makePattern('success', 'deploy', {
      bestData: { duration: 10000, filesModified: 2, testsPass: false },
    });
    const result = await packagePatterns([pattern]);
    expect(result.weights.commands.deploy.testsPass).toBe(0.0);
  });

  it('handles command pattern with testsPass=undefined (neutral 0.5)', async () => {
    const pattern = makePattern('success', 'deploy', {
      bestData: { duration: 10000, filesModified: 2 },
    });
    const result = await packagePatterns([pattern]);
    expect(result.weights.commands.deploy.testsPass).toBe(0.5);
  });

  it('only includes non-empty categories in metadata.categories', async () => {
    const pattern = makePattern('tool', 'Read', {
      bestData: { successRate: 0.9, avgMs: 100 },
    });
    const result = await packagePatterns([pattern]);
    expect(result.metadata.categories).toContain('tools');
    expect(result.metadata.categories).not.toContain('errors');
    expect(result.metadata.categories).not.toContain('commands');
    expect(result.metadata.categories).not.toContain('teams');
  });

  it('handles unknown pattern type (not tool/error/success/team)', async () => {
    const pattern = makePattern('unknown', 'something', {});
    const result = await packagePatterns([pattern]);
    expect(result.metadata.packagedCount).toBe(0);
  });
});

describe('unpackWeights() additional branches', () => {
  it('handles error weight with recoverable < 0.5 (maps to false)', () => {
    const globalWeights = {
      errors: { sig123: { frequency: 0.3, recoverable: 0.3, sampleSize: 10 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns[0].bestData.recoverable).toBe(false);
  });

  it('handles command weight with testsPass < 0.5 (maps to false)', () => {
    const globalWeights = {
      commands: { test: { effectiveness: 0.9, avgDuration: 0.8, filesModified: 0.7, testsPass: 0.3, sampleSize: 5 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns[0].bestData.testsPass).toBe(false);
  });

  it('handles empty weights object (no categories)', () => {
    const patterns = unpackWeights({});
    expect(patterns).toEqual([]);
  });

  it('handles weights with only errors section', () => {
    const globalWeights = {
      errors: { sig1: { frequency: 0.5, recoverable: 0.8, sampleSize: 3 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe('error');
  });

  it('handles weights with only teams section', () => {
    const globalWeights = {
      teams: { pipeline: { effectiveness: 0.7, optimalSize: 4, avgDuration: 0.5, sampleSize: 8 } },
    };
    const patterns = unpackWeights(globalWeights);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe('team');
    expect(patterns[0].bestData.pattern).toBe('pipeline');
  });
});
