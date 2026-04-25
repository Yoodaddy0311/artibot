import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  emptyPolicy,
  MODEL_TYPE,
  POLICY_VERSION,
  resolvePolicyPaths,
} from '../../../lib/learning/grpo/joint-policy.js';

describe('joint-policy pure helpers (smoke)', () => {
  describe('emptyPolicy', () => {
    it('returns a fresh record with expected shape', () => {
      const p = emptyPolicy();
      expect(p.version).toBe(POLICY_VERSION);
      expect(p.modelType).toBe(MODEL_TYPE);
      expect(p.trainedAt).toBeNull();
      expect(typeof p.correlation).toBe('object');
      expect(typeof p.metrics).toBe('object');
    });

    it('each call returns an independent object (no shared state)', () => {
      const a = emptyPolicy();
      const b = emptyPolicy();
      a.correlation.fam1 = { agent1: { agentCount: 1, skills: {} } };
      expect(b.correlation.fam1).toBeUndefined();
    });
  });

  describe('resolvePolicyPaths', () => {
    it('returns policyFile and snapshotDir strings', () => {
      const { policyFile, snapshotDir } = resolvePolicyPaths();
      expect(typeof policyFile).toBe('string');
      expect(typeof snapshotDir).toBe('string');
      expect(policyFile.length).toBeGreaterThan(0);
      expect(snapshotDir.length).toBeGreaterThan(0);
    });

    it('honours an explicit policyPath override', () => {
      const custom = '/tmp/artibot-test-joint.json';
      const { policyFile } = resolvePolicyPaths(custom);
      expect(policyFile).toBe(custom);
    });
  });

  describe('DEFAULTS', () => {
    it('is frozen and exposes correlation tuning knobs', () => {
      expect(Object.isFrozen(DEFAULTS)).toBe(true);
      expect(DEFAULTS.lambda).toBeGreaterThan(0);
      expect(DEFAULTS.lambda).toBeLessThanOrEqual(1);
      expect(DEFAULTS.minCorrelationEpisodes).toBeGreaterThanOrEqual(1);
      expect(DEFAULTS.threshold).toBeGreaterThanOrEqual(0);
      expect(DEFAULTS.threshold).toBeLessThanOrEqual(1);
      expect(DEFAULTS.maxTriggers).toBeGreaterThanOrEqual(1);
      expect(DEFAULTS.maxAgentsPerFamily).toBeGreaterThanOrEqual(1);
      expect(DEFAULTS.maxSkillsPerCell).toBeGreaterThanOrEqual(1);
    });
  });

  describe('module constants', () => {
    it('POLICY_VERSION is a positive integer', () => {
      expect(Number.isInteger(POLICY_VERSION)).toBe(true);
      expect(POLICY_VERSION).toBeGreaterThan(0);
    });

    it('MODEL_TYPE is a non-empty string', () => {
      expect(typeof MODEL_TYPE).toBe('string');
      expect(MODEL_TYPE.length).toBeGreaterThan(0);
    });
  });
});
