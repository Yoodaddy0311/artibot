import { describe, it, expect } from 'vitest';
import {
  createRng,
  TASK_FAMILIES,
  AGENTS,
  SKILLS,
  FAMILY_PREFERENCES,
  generateEpisodes,
  splitEpisodes,
  matrixSparsity,
  pairAccuracy,
  parseArgs,
} from '../../scripts/benchmark-joint-policy.mjs';

describe('benchmark-joint-policy (smoke)', () => {
  describe('createRng', () => {
    it('deterministic for same seed', () => {
      const r1 = createRng(42);
      const r2 = createRng(42);
      expect(r1()).toBe(r2());
      expect(r1()).toBe(r2());
    });

    it('different seeds diverge', () => {
      const r1 = createRng(1);
      const r2 = createRng(2);
      expect(r1()).not.toBe(r2());
    });

    it('produces values in [0, 1)', () => {
      const r = createRng(123);
      for (let i = 0; i < 50; i++) {
        const v = r();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });
  });

  describe('constants', () => {
    it('TASK_FAMILIES non-empty array', () => {
      expect(Array.isArray(TASK_FAMILIES)).toBe(true);
      expect(TASK_FAMILIES.length).toBeGreaterThan(0);
    });

    it('AGENTS non-empty array', () => {
      expect(Array.isArray(AGENTS)).toBe(true);
      expect(AGENTS.length).toBeGreaterThan(0);
    });

    it('SKILLS non-empty array', () => {
      expect(Array.isArray(SKILLS)).toBe(true);
      expect(SKILLS.length).toBeGreaterThan(0);
    });

    it('FAMILY_PREFERENCES frozen and covers families', () => {
      expect(Object.isFrozen(FAMILY_PREFERENCES)).toBe(true);
      for (const fam of TASK_FAMILIES) {
        expect(FAMILY_PREFERENCES[fam]).toBeDefined();
      }
    });
  });

  describe('generateEpisodes', () => {
    it('deterministic with seed', () => {
      const a = generateEpisodes({ count: 20, seed: 42 });
      const b = generateEpisodes({ count: 20, seed: 42 });
      expect(a.length).toBe(20);
      expect(b.length).toBe(20);
      expect(a[0]).toEqual(b[0]);
    });

    it('different seeds produce different episodes', () => {
      const a = generateEpisodes({ count: 10, seed: 1 });
      const b = generateEpisodes({ count: 10, seed: 2 });
      expect(a[0]).not.toEqual(b[0]);
    });

    it('each episode has taskFamily + selectedAgent + skillsUsed + reward', () => {
      const eps = generateEpisodes({ count: 5, seed: 10 });
      for (const e of eps) {
        expect(typeof e.taskFamily).toBe('string');
        expect(typeof e.selectedAgent).toBe('string');
        expect(Array.isArray(e.skillsUsed)).toBe(true);
        expect(typeof e.reward).toBe('number');
      }
    });
  });

  describe('splitEpisodes', () => {
    it('splits at trainRatio boundary', () => {
      const eps = new Array(100).fill(null).map((_, i) => ({ i }));
      const { train, heldOut } = splitEpisodes(eps, 0.8);
      expect(train.length).toBe(80);
      expect(heldOut.length).toBe(20);
    });

    it('default ratio 0.8', () => {
      const eps = new Array(10).fill(null).map((_, i) => ({ i }));
      const { train, heldOut } = splitEpisodes(eps);
      expect(train.length + heldOut.length).toBe(10);
    });
  });

  describe('matrixSparsity', () => {
    it('all-zero matrix is fully sparse', () => {
      const m = [[0, 0], [0, 0]];
      const s = matrixSparsity([m]);
      expect(s).toBeCloseTo(1.0);
    });

    it('mixed matrix returns fraction below threshold', () => {
      const m = [[0, 1], [0, 1]];
      const s = matrixSparsity([m]);
      expect(s).toBeCloseTo(0.5);
    });
  });

  describe('pairAccuracy', () => {
    it('100% when predict matches labeled pair', () => {
      const heldOut = [
        { labeledAgent: 'a', labeledSkill: 's1', taskFamily: 'f', intent: 'i' },
      ];
      const predict = () => ({ agent: 'a', skill: 's1' });
      expect(pairAccuracy(heldOut, predict)).toBe(1.0);
    });

    it('0% on complete mismatch', () => {
      const heldOut = [
        { labeledAgent: 'a', labeledSkill: 's1', taskFamily: 'f', intent: 'i' },
      ];
      const predict = () => ({ agent: 'b', skill: 's2' });
      expect(pairAccuracy(heldOut, predict)).toBe(0);
    });

    it('empty held-out returns 0 safely', () => {
      expect(pairAccuracy([], () => ({}))).toBe(0);
    });
  });

  describe('parseArgs', () => {
    it('parses --episodes and --seed', () => {
      const opts = parseArgs(['--episodes', '50', '--seed', '7']);
      expect(opts.episodes).toBe(50);
      expect(opts.seed).toBe(7);
    });

    it('--output flag', () => {
      const opts = parseArgs(['--output', '/tmp/out.json']);
      expect(opts.output).toBe('/tmp/out.json');
    });

    it('--help flag', () => {
      const opts = parseArgs(['--help']);
      expect(opts.help).toBe(true);
    });
  });
});
