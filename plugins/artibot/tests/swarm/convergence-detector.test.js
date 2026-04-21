import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _CONFIDENCE_CEILING,
  _DEFAULT_CONFIDENCE_BOOST,
  _DEFAULT_CONFIDENCE_THRESHOLD,
  _DEFAULT_MIN_INSTANCES,
  _isSafeObject,
  _isValidContribution,
  _patternKey,
  _RUNTIME_SUBPATH,
  applyBoost,
  detectConvergence,
  getConvergedPatterns,
  persistConvergedPatterns,
} from '../../lib/swarm/convergence-detector.js';
import { rankPatternsWithConvergence } from '../../lib/swarm/collective-hub.js';

/** 32+ hex char pseudo-DP instance hash */
function hash(seed) {
  const base = seed.padEnd(32, '0');
  return Buffer.from(base).toString('hex').slice(0, 64);
}

function makeContribution(instanceSeed, patternId, confidence = 0.8, extras = {}) {
  return {
    instanceHash: hash(instanceSeed),
    pattern: { id: patternId, type: 'tool', signature: `sig-${patternId}`, ...extras },
    confidence,
  };
}

describe('convergence-detector', () => {
  describe('defaults', () => {
    it('exports expected default constants', () => {
      expect(_DEFAULT_MIN_INSTANCES).toBe(3);
      expect(_DEFAULT_CONFIDENCE_BOOST).toBe(0.15);
      expect(_DEFAULT_CONFIDENCE_THRESHOLD).toBe(0.7);
      expect(_CONFIDENCE_CEILING).toBe(1.0);
      expect(_RUNTIME_SUBPATH).toBe('runtime/converged-patterns.json');
    });
  });

  describe('_patternKey', () => {
    it('prefers pattern.id', () => {
      expect(_patternKey({ id: 'abc', type: 't', signature: 's' })).toBe('abc');
    });

    it('falls back to type+signature when id missing', () => {
      expect(_patternKey({ type: 'tool', signature: 'sig' })).toBe('tool:sig');
    });
  });

  describe('_isValidContribution', () => {
    it('accepts a well-formed contribution', () => {
      expect(_isValidContribution(makeContribution('a', 'p1'))).toBe(true);
    });

    it('rejects non-hex instanceHash', () => {
      expect(
        _isValidContribution({ instanceHash: 'NOT_HEX!!', pattern: { id: 'x' }, confidence: 0.8 }),
      ).toBe(false);
    });

    it('rejects out-of-range confidence', () => {
      const bad = makeContribution('a', 'p1', 1.5);
      expect(_isValidContribution(bad)).toBe(false);
    });
  });

  describe('_isSafeObject (prototype pollution guard)', () => {
    it('rejects __proto__ key', () => {
      const raw = JSON.parse('{"__proto__": {"polluted": true}, "id": "x"}');
      expect(_isSafeObject(raw)).toBe(false);
    });

    it('rejects constructor/prototype keys', () => {
      expect(_isSafeObject({ constructor: 'bad', id: 'x' })).toBe(false);
      expect(_isSafeObject({ prototype: 'bad', id: 'x' })).toBe(false);
    });

    it('accepts a normal pattern object', () => {
      expect(_isSafeObject({ id: 'x', type: 'tool' })).toBe(true);
    });
  });

  describe('detectConvergence', () => {
    it('returns empty array for empty / invalid input', async () => {
      expect(await detectConvergence([])).toEqual([]);
      expect(await detectConvergence(null)).toEqual([]);
      expect(await detectConvergence(undefined)).toEqual([]);
    });

    it('does NOT converge below minInstances threshold (2 of 3 required)', async () => {
      const contributions = [
        makeContribution('i1', 'p1', 0.8),
        makeContribution('i2', 'p1', 0.8),
      ];
      const result = await detectConvergence(contributions, { minInstances: 3 });
      expect(result).toEqual([]);
    });

    it('converges when >= minInstances unique instances agree', async () => {
      const contributions = [
        makeContribution('i1', 'p1', 0.8),
        makeContribution('i2', 'p1', 0.82),
        makeContribution('i3', 'p1', 0.78),
      ];
      const result = await detectConvergence(contributions, {
        minInstances: 3,
        confidenceBoost: 0.15,
        confidenceThreshold: 0.7,
      });
      expect(result).toHaveLength(1);
      expect(result[0].instanceCount).toBe(3);
      expect(result[0].originalConfidence).toBeCloseTo(0.8, 2);
      expect(result[0].boostedConfidence).toBeCloseTo(0.95, 2);
      expect(result[0].convergedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('does not double-count duplicate instanceHash values', async () => {
      const contributions = [
        makeContribution('i1', 'p1', 0.8),
        makeContribution('i1', 'p1', 0.8), // same instance, should not count
        makeContribution('i2', 'p1', 0.8),
      ];
      const result = await detectConvergence(contributions, { minInstances: 3 });
      expect(result).toEqual([]);
    });

    it('caps boosted confidence at 1.0', async () => {
      const contributions = [
        makeContribution('i1', 'p1', 0.95),
        makeContribution('i2', 'p1', 0.97),
        makeContribution('i3', 'p1', 0.99),
      ];
      const result = await detectConvergence(contributions, {
        minInstances: 3,
        confidenceBoost: 0.5,
        confidenceThreshold: 0.7,
      });
      expect(result).toHaveLength(1);
      expect(result[0].boostedConfidence).toBe(1.0);
    });

    it('drops patterns whose mean confidence is below threshold', async () => {
      const contributions = [
        makeContribution('i1', 'p1', 0.5),
        makeContribution('i2', 'p1', 0.55),
        makeContribution('i3', 'p1', 0.6),
      ];
      const result = await detectConvergence(contributions, {
        minInstances: 3,
        confidenceThreshold: 0.7,
      });
      expect(result).toEqual([]);
    });

    it('rejects prototype-polluting pattern objects silently', async () => {
      const malicious = JSON.parse(
        '{"instanceHash": "' + hash('i1') + '", "pattern": {"__proto__": {"polluted": true}, "id": "evil"}, "confidence": 0.9}',
      );
      const contributions = [
        malicious,
        malicious,
        malicious,
      ];
      const result = await detectConvergence(contributions, { minInstances: 3 });
      expect(result).toEqual([]);
      // @ts-ignore - proto pollution check
      expect({}.polluted).toBeUndefined();
    });

    it('segregates different pattern ids', async () => {
      const contributions = [
        makeContribution('i1', 'p1', 0.85),
        makeContribution('i2', 'p1', 0.85),
        makeContribution('i3', 'p1', 0.85),
        makeContribution('i1', 'p2', 0.85),
        makeContribution('i2', 'p2', 0.85),
      ];
      const result = await detectConvergence(contributions, { minInstances: 3 });
      expect(result).toHaveLength(1);
      expect(result[0].pattern.id).toBe('p1');
    });
  });

  describe('applyBoost', () => {
    it('returns base confidence when no global siblings match', () => {
      const local = { id: 'p1', confidence: 0.6 };
      expect(applyBoost(local, [], 0.15)).toBe(0.6);
      expect(applyBoost(local, [{ pattern: { id: 'p2' }, instanceCount: 3 }], 0.15)).toBe(0.6);
    });

    it('applies boost when matching sibling exists', () => {
      const local = { id: 'p1', confidence: 0.6 };
      const siblings = [{ pattern: { id: 'p1' }, instanceCount: 3 }];
      expect(applyBoost(local, siblings, 0.15)).toBeCloseTo(0.75, 5);
    });

    it('caps at 1.0', () => {
      const local = { id: 'p1', confidence: 0.95 };
      const siblings = [{ pattern: { id: 'p1' }, instanceCount: 4 }];
      expect(applyBoost(local, siblings, 0.5)).toBe(1.0);
    });

    it('returns 0 for unsafe local pattern', () => {
      const evil = JSON.parse('{"__proto__": {"x": 1}, "id": "p1", "confidence": 0.8}');
      expect(applyBoost(evil, [{ pattern: { id: 'p1' } }], 0.15)).toBe(0);
    });

    it('uses default boost when not provided', () => {
      const local = { id: 'p1', confidence: 0.5 };
      const siblings = [{ pattern: { id: 'p1' } }];
      expect(applyBoost(local, siblings)).toBeCloseTo(0.65, 5);
    });
  });

  describe('persist + getConvergedPatterns', () => {
    let tmp;
    beforeAll(async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), 'artibot-converge-'));
    });
    afterAll(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('returns empty array when no file exists', async () => {
      const patterns = await getConvergedPatterns(tmp);
      expect(patterns).toEqual([]);
    });

    it('persists and reads back converged patterns', async () => {
      const converged = [
        {
          pattern: { id: 'p1', type: 'tool' },
          originalConfidence: 0.8,
          boostedConfidence: 0.95,
          instanceCount: 3,
          convergedAt: '2026-04-20T00:00:00.000Z',
        },
      ];
      const target = await persistConvergedPatterns(tmp, converged);
      expect(target).toMatch(/converged-patterns\.json$/);

      const raw = JSON.parse(await readFile(target, 'utf8'));
      expect(raw.version).toBe(1);
      expect(raw.patterns).toHaveLength(1);

      const readBack = await getConvergedPatterns(tmp);
      expect(readBack).toHaveLength(1);
      expect(readBack[0].pattern.id).toBe('p1');
      expect(readBack[0].boostedConfidence).toBe(0.95);
    });

    it('returns [] on malformed JSON', async () => {
      const target = path.join(tmp, _RUNTIME_SUBPATH);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '{ this is not json', 'utf8');
      expect(await getConvergedPatterns(tmp)).toEqual([]);
    });
  });

  describe('rankPatternsWithConvergence integration', () => {
    const patterns = [
      {
        id: 'p1',
        type: 'tool',
        signature: 'sig-p1',
        successRate: 0.9,
        usageCount: 20,
        contributorCount: 3,
        score: 0,
        lastUpdated: new Date().toISOString(),
      },
    ];

    it('returns only ranked when feature disabled', async () => {
      const out = await rankPatternsWithConvergence(patterns, [], {}, 5);
      expect(out.ranked).toHaveLength(1);
      expect(out.convergence).toEqual([]);
    });

    it('returns convergence metadata when enabled', async () => {
      const contributions = [
        makeContribution('i1', 'p1', 0.85),
        makeContribution('i2', 'p1', 0.85),
        makeContribution('i3', 'p1', 0.85),
      ];
      const out = await rankPatternsWithConvergence(
        patterns,
        contributions,
        {
          ago: {
            swarmConvergence: {
              enabled: true,
              minInstances: 3,
              confidenceBoost: 0.15,
              confidenceThreshold: 0.7,
            },
          },
        },
        5,
      );
      expect(out.ranked).toHaveLength(1);
      expect(out.convergence).toHaveLength(1);
      expect(out.convergence[0].instanceCount).toBe(3);
      expect(out.convergence[0].pattern.id).toBe('p1');
    });

    it('preserves existing ranking behavior (no mutation of skills)', async () => {
      const before = JSON.parse(JSON.stringify(patterns));
      await rankPatternsWithConvergence(patterns, [], {}, 5);
      expect(patterns).toEqual(before);
    });
  });
});
