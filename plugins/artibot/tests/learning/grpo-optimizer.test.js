import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateCandidates,
  evaluateGroup,
  updateWeights,
  evaluateTeamGroup,
  getRecommendation,
  generateTeamCandidates,
  updateTeamWeights,
  getGrpoStats,
  CLI_RULES,
  TEAM_EVALUATION_RULES,
} from '../../lib/learning/grpo-optimizer.js';

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

const { readJsonFile, writeJsonFile } = await import('../../lib/core/file.js');

describe('grpo-optimizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJsonFile.mockResolvedValue(null);
  });

  // ---------------------------------------------------------------------------
  describe('generateCandidates()', () => {
    const baseTask = { id: 'task-1', type: 'build', domain: 'general' };

    it('returns the default number of candidates (5)', () => {
      const candidates = generateCandidates(baseTask);
      expect(candidates).toHaveLength(5);
    });

    it('returns the requested count of candidates', () => {
      const candidates = generateCandidates(baseTask, 3);
      expect(candidates).toHaveLength(3);
    });

    it('each candidate has required fields', () => {
      const candidates = generateCandidates(baseTask);
      for (const c of candidates) {
        expect(c).toHaveProperty('id');
        expect(c).toHaveProperty('taskId', 'task-1');
        expect(c).toHaveProperty('taskType', 'build');
        expect(c).toHaveProperty('domain', 'general');
        expect(c).toHaveProperty('strategy');
        expect(c).toHaveProperty('description');
        expect(c).toHaveProperty('params');
        expect(c).toHaveProperty('index');
      }
    });

    it('generates unique candidate IDs', () => {
      const candidates = generateCandidates(baseTask, 5);
      const ids = candidates.map((c) => c.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);
    });

    it('uses domain-specific strategies for frontend', () => {
      const task = { id: 't1', type: 'build', domain: 'frontend' };
      const candidates = generateCandidates(task, 10);
      const strategies = candidates.map((c) => c.strategy);
      expect(strategies).toContain('component-first');
    });

    it('uses domain-specific strategies for backend', () => {
      const task = { id: 't1', type: 'build', domain: 'backend' };
      const candidates = generateCandidates(task, 10);
      const strategies = candidates.map((c) => c.strategy);
      expect(strategies).toContain('api-first');
    });

    it('uses domain-specific strategies for security', () => {
      const task = { id: 't1', type: 'build', domain: 'security' };
      const candidates = generateCandidates(task, 10);
      const strategies = candidates.map((c) => c.strategy);
      expect(strategies).toContain('threat-model');
    });

    it('defaults domain to general when not provided', () => {
      const task = { id: 't1', type: 'build' };
      const candidates = generateCandidates(task, 3);
      for (const c of candidates) {
        expect(c.domain).toBe('general');
      }
    });

    it('handles missing task id gracefully', () => {
      const task = { type: 'fix', domain: 'general' };
      const candidates = generateCandidates(task, 2);
      for (const c of candidates) {
        expect(c.taskId).toBeNull();
      }
    });

    it('always includes balanced strategy in general domain', () => {
      const task = { id: 't1', type: 'build', domain: 'general' };
      const candidates = generateCandidates(task, 5);
      const strategies = candidates.map((c) => c.strategy);
      expect(strategies).toContain('balanced');
    });
  });

  // ---------------------------------------------------------------------------
  describe('evaluateGroup()', () => {
    const makeCandidates = (results) =>
      results.map((result, i) => ({
        id: `cand-${i}`,
        strategy: `strategy-${i}`,
        result,
      }));

    it('returns rankings, best, worst, spread', () => {
      const candidates = makeCandidates([
        { exitCode: 0, errors: 0, duration: 100, commandLength: 10, sideEffects: 0 },
        { exitCode: 1, errors: 2, duration: 5000, commandLength: 80, sideEffects: 1 },
      ]);
      const result = evaluateGroup(candidates);
      expect(result).toHaveProperty('rankings');
      expect(result).toHaveProperty('best');
      expect(result).toHaveProperty('worst');
      expect(result).toHaveProperty('spread');
    });

    it('ranks successful candidate higher than failed one', () => {
      const candidates = makeCandidates([
        { exitCode: 0, errors: 0, duration: 100, commandLength: 10, sideEffects: 0 },
        { exitCode: 1, errors: 5, duration: 9000, commandLength: 100, sideEffects: 2 },
      ]);
      const result = evaluateGroup(candidates);
      expect(result.rankings[0].candidateId).toBe('cand-0');
      expect(result.rankings[0].rank).toBe(1);
    });

    it('composite scores are between 0 and 1', () => {
      const candidates = makeCandidates([
        { exitCode: 0, errors: 0, duration: 100 },
        { exitCode: 1, errors: 5, duration: 9000 },
      ]);
      const result = evaluateGroup(candidates);
      for (const r of result.rankings) {
        expect(r.composite).toBeGreaterThanOrEqual(0);
        expect(r.composite).toBeLessThanOrEqual(1);
      }
    });

    it('spread is positive when candidates differ', () => {
      const candidates = makeCandidates([
        { exitCode: 0, errors: 0, duration: 100, sideEffects: 0 },
        { exitCode: 1, errors: 5, duration: 9000, sideEffects: 2 },
      ]);
      const result = evaluateGroup(candidates);
      expect(result.spread).toBeGreaterThan(0);
    });

    it('spread is 0 when all candidates are identical', () => {
      const sameResult = { exitCode: 0, errors: 0, duration: 1000, commandLength: 20, sideEffects: 0 };
      const candidates = makeCandidates([sameResult, sameResult]);
      const result = evaluateGroup(candidates);
      expect(result.spread).toBe(0);
    });

    it('accepts custom rules', () => {
      const candidates = makeCandidates([
        { customMetric: 1.0 },
        { customMetric: 0.0 },
      ]);
      const customRules = { customMetric: (r) => r.customMetric ?? 0 };
      const result = evaluateGroup(candidates, customRules);
      expect(result.rankings[0].scores).toHaveProperty('customMetric');
      expect(result.rankings[0].composite).toBe(1.0);
    });

    it('handles empty result object gracefully', () => {
      const candidates = makeCandidates([{}, {}]);
      const result = evaluateGroup(candidates);
      expect(result.rankings).toHaveLength(2);
    });

    it('each ranking entry has candidateId, strategy, scores, composite, rank', () => {
      const candidates = makeCandidates([
        { exitCode: 0 },
        { exitCode: 1 },
      ]);
      const result = evaluateGroup(candidates);
      for (const r of result.rankings) {
        expect(r).toHaveProperty('candidateId');
        expect(r).toHaveProperty('strategy');
        expect(r).toHaveProperty('scores');
        expect(r).toHaveProperty('composite');
        expect(r).toHaveProperty('rank');
      }
    });

    it('ranks are sequential starting from 1', () => {
      const candidates = makeCandidates([
        { exitCode: 0 }, { exitCode: 1 }, { exitCode: 0 },
      ]);
      const result = evaluateGroup(candidates);
      const ranks = result.rankings.map((r) => r.rank).sort((a, b) => a - b);
      expect(ranks).toEqual([1, 2, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('updateWeights()', () => {
    it('returns empty object when rankings is empty', async () => {
      const result = await updateWeights({ rankings: [] }, { persist: false });
      expect(result).toEqual({});
    });

    it('increases weight for best-ranked strategy', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, strategy: 'balanced', composite: 0.9 },
          { rank: 2, strategy: 'thorough', composite: 0.5 },
        ],
        spread: 0.4,
      };
      const weights = await updateWeights(groupResult, { persist: false });
      expect(weights.balanced).toBeGreaterThan(1.0);
    });

    it('decreases weight for worst-ranked strategy', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, strategy: 'balanced', composite: 0.9 },
          { rank: 2, strategy: 'rapid', composite: 0.2 },
        ],
        spread: 0.7,
      };
      const weights = await updateWeights(groupResult, { persist: false });
      expect(weights.rapid).toBeLessThan(1.0);
    });

    it('clamps weights between 0.01 and 5.0', async () => {
      // Start with existing weight near limits
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: { balanced: 4.99 },
        teamWeights: {},
      });
      const groupResult = {
        rankings: [
          { rank: 1, strategy: 'balanced', composite: 1.0 },
        ],
        spread: 0,
      };
      const weights = await updateWeights(groupResult, { persist: false });
      expect(weights.balanced).toBeLessThanOrEqual(5.0);
    });

    it('persists to disk when persist=true', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, strategy: 'balanced', composite: 0.8 },
        ],
        spread: 0,
      };
      await updateWeights(groupResult, { persist: true });
      expect(writeJsonFile).toHaveBeenCalledTimes(1);
    });

    it('does not persist when persist=false', async () => {
      const groupResult = {
        rankings: [{ rank: 1, strategy: 'balanced', composite: 0.8 }],
        spread: 0,
      };
      await updateWeights(groupResult, { persist: false });
      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('respects custom learning rate', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, strategy: 'balanced', composite: 1.0 },
          { rank: 2, strategy: 'rapid', composite: 0.5 },
        ],
        spread: 0.5,
      };
      const slowWeights = await updateWeights(groupResult, { persist: false, learningRate: 0.01 });
      const fastWeights = await updateWeights(groupResult, { persist: false, learningRate: 0.5 });
      // Fast learning rate should produce larger deviation from 1.0
      expect(Math.abs(fastWeights.balanced - 1.0)).toBeGreaterThan(Math.abs(slowWeights.balanced - 1.0));
    });

    it('loads existing weights from history', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: { balanced: 2.0 },
        teamWeights: {},
      });
      const groupResult = {
        rankings: [
          { rank: 1, strategy: 'balanced', composite: 0.9 },
          { rank: 2, strategy: 'speed', composite: 0.5 },
        ],
        spread: 0.4,
      };
      const weights = await updateWeights(groupResult, { persist: false });
      // With 2 rankings, rank 1 gets advantage=+1, so balanced weight increases
      expect(weights.balanced).toBeGreaterThan(2.0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('evaluateTeamGroup()', () => {
    const makeTeamCandidates = (results) =>
      results.map((result, i) => ({
        id: `team-cand-${i}`,
        pattern: ['solo', 'leader', 'swarm'][i % 3],
        size: [0, 3, 5][i % 3],
        domain: 'general',
        agents: [],
        result,
      }));

    it('returns rankings, best, worst, spread', () => {
      const candidates = makeTeamCandidates([
        { taskCount: 10, successCount: 9, completedCount: 9, duration: 30000, teamSize: 3 },
        { taskCount: 10, successCount: 3, completedCount: 3, duration: 120000, teamSize: 5 },
      ]);
      const result = evaluateTeamGroup(candidates);
      expect(result).toHaveProperty('rankings');
      expect(result).toHaveProperty('best');
      expect(result).toHaveProperty('worst');
      expect(result).toHaveProperty('spread');
    });

    it('ranks high success rate team higher', () => {
      const candidates = makeTeamCandidates([
        { taskCount: 10, successCount: 9, completedCount: 9, duration: 30000, teamSize: 3 },
        { taskCount: 10, successCount: 1, completedCount: 1, duration: 90000, teamSize: 5 },
      ]);
      const result = evaluateTeamGroup(candidates);
      // First candidate has higher success rate and faster, should rank #1
      expect(result.rankings[0].pattern).toBe('solo');
    });

    it('each ranking includes pattern, teamSize, domain, agents', () => {
      const candidates = makeTeamCandidates([
        { taskCount: 5, successCount: 5, completedCount: 5 },
        { taskCount: 5, successCount: 2, completedCount: 2 },
      ]);
      const result = evaluateTeamGroup(candidates);
      for (const r of result.rankings) {
        expect(r).toHaveProperty('pattern');
        expect(r).toHaveProperty('teamSize');
        expect(r).toHaveProperty('domain');
        expect(r).toHaveProperty('agents');
        expect(r).toHaveProperty('composite');
      }
    });

    it('composite scores are between 0 and 1', () => {
      const candidates = makeTeamCandidates([
        { taskCount: 10, successCount: 10, completedCount: 10, duration: 5000, teamSize: 1 },
        { taskCount: 10, successCount: 0, completedCount: 0, duration: 300000, teamSize: 10 },
      ]);
      const result = evaluateTeamGroup(candidates);
      for (const r of result.rankings) {
        expect(r.composite).toBeGreaterThanOrEqual(0);
        expect(r.composite).toBeLessThanOrEqual(1);
      }
    });

    it('accepts custom team rules', () => {
      const candidates = makeTeamCandidates([
        { customScore: 1.0 },
        { customScore: 0.0 },
      ]);
      const customRules = { customScore: (r) => r.customScore ?? 0 };
      const result = evaluateTeamGroup(candidates, customRules);
      expect(result.rankings[0].scores).toHaveProperty('customScore');
    });

    it('handles result with zero taskCount gracefully', () => {
      const candidates = makeTeamCandidates([
        { taskCount: 0, successCount: 0, completedCount: 0, duration: 1000, teamSize: 2 },
        { taskCount: 0, successCount: 0, completedCount: 0, duration: 2000, teamSize: 3 },
      ]);
      const result = evaluateTeamGroup(candidates);
      expect(result.rankings).toHaveLength(2);
      for (const r of result.rankings) {
        expect(r.composite).toBeGreaterThanOrEqual(0);
      }
    });

    it('CLI_RULES and TEAM_EVALUATION_RULES are exported', () => {
      expect(CLI_RULES).toBeDefined();
      expect(typeof CLI_RULES.exitCode).toBe('function');
      expect(TEAM_EVALUATION_RULES).toBeDefined();
      expect(typeof TEAM_EVALUATION_RULES.successRate).toBe('function');
    });
  });

  // ---------------------------------------------------------------------------
  describe('getRecommendation()', () => {
    it('returns default task recommendation when no history', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await getRecommendation('task');
      expect(result).toHaveProperty('recommendation', 'balanced');
      expect(result).toHaveProperty('weight', 1.0);
      expect(result).toHaveProperty('alternatives');
    });

    it('returns default team recommendation when no history', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await getRecommendation('team');
      expect(result.recommendation).toBe('leader|3');
      expect(result.weight).toBe(1.0);
    });

    it('recommends highest-weighted task strategy', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: { balanced: 1.5, rapid: 0.8, thorough: 1.2 },
        teamWeights: {},
      });
      const result = await getRecommendation('task');
      expect(result.recommendation).toBe('balanced');
      expect(result.weight).toBe(1.5);
    });

    it('includes up to 3 alternatives', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: { balanced: 1.5, rapid: 0.8, thorough: 1.2, parallel: 1.0 },
        teamWeights: {},
      });
      const result = await getRecommendation('task');
      expect(result.alternatives.length).toBeLessThanOrEqual(3);
    });

    it('recommends highest-weighted team composition', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: {},
        teamWeights: {
          'leader|3|general': 2.0,
          'swarm|5|general': 1.5,
        },
      });
      const result = await getRecommendation('team', { domain: 'general' });
      expect(result.recommendation).toBe('leader|3');
      expect(result.weight).toBe(2.0);
    });

    it('filters team recommendations by domain', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: {},
        teamWeights: {
          'leader|3|frontend': 2.5,
          'swarm|5|backend': 1.8,
        },
      });
      const result = await getRecommendation('team', { domain: 'frontend' });
      expect(result.recommendation).toContain('leader');
    });

    it('alternatives are sorted by weight descending', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: { balanced: 1.5, rapid: 0.8, thorough: 1.2, parallel: 1.0, iterative: 0.9 },
        teamWeights: {},
      });
      const result = await getRecommendation('task');
      // Alternatives should be ordered by weight
      for (let i = 0; i < result.alternatives.length - 1; i++) {
        expect(result.alternatives[i].weight).toBeGreaterThanOrEqual(result.alternatives[i + 1].weight);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('generateTeamCandidates()', () => {
    const baseTask = { id: 'task-1', type: 'build', domain: 'general' };

    it('returns candidates for all default patterns', () => {
      const candidates = generateTeamCandidates(baseTask);
      expect(candidates).toHaveLength(5); // solo, leader, council, swarm, pipeline
    });

    it('each candidate has required fields', () => {
      const candidates = generateTeamCandidates(baseTask);
      for (const c of candidates) {
        expect(c).toHaveProperty('id');
        expect(c).toHaveProperty('taskId', 'task-1');
        expect(c).toHaveProperty('domain', 'general');
        expect(c).toHaveProperty('pattern');
        expect(c).toHaveProperty('size');
        expect(c).toHaveProperty('agents');
        expect(c).toHaveProperty('description');
      }
    });

    it('generates unique candidate IDs', () => {
      const candidates = generateTeamCandidates(baseTask);
      const ids = new Set(candidates.map((c) => c.id));
      expect(ids.size).toBe(candidates.length);
    });

    it('solo pattern has size 0 and empty agents', () => {
      const candidates = generateTeamCandidates(baseTask);
      const solo = candidates.find((c) => c.pattern === 'solo');
      expect(solo).toBeDefined();
      expect(solo.size).toBe(0);
      expect(solo.agents).toEqual([]);
    });

    it('filters to specified patterns', () => {
      const candidates = generateTeamCandidates(baseTask, { patterns: ['solo', 'leader'] });
      expect(candidates).toHaveLength(2);
      const patterns = candidates.map((c) => c.pattern);
      expect(patterns).toContain('solo');
      expect(patterns).toContain('leader');
    });

    it('ignores invalid patterns', () => {
      const candidates = generateTeamCandidates(baseTask, { patterns: ['solo', 'nonexistent'] });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].pattern).toBe('solo');
    });

    it('defaults domain to general when not provided', () => {
      const task = { id: 't1', type: 'fix' };
      const candidates = generateTeamCandidates(task);
      for (const c of candidates) {
        expect(c.domain).toBe('general');
      }
    });

    it('assigns domain-specific agents for frontend', () => {
      const task = { id: 't1', type: 'build', domain: 'frontend' };
      const candidates = generateTeamCandidates(task, { patterns: ['leader'] });
      expect(candidates[0].agents).toContain('frontend-developer');
    });

    it('assigns domain-specific agents for backend', () => {
      const task = { id: 't1', type: 'build', domain: 'backend' };
      const candidates = generateTeamCandidates(task, { patterns: ['leader'] });
      expect(candidates[0].agents).toContain('backend-developer');
    });
  });

  // ---------------------------------------------------------------------------
  describe('updateTeamWeights()', () => {
    it('returns empty object when rankings is empty', async () => {
      const result = await updateTeamWeights({ rankings: [] }, { persist: false });
      expect(result).toEqual({});
    });

    it('increases weight for best-ranked team composition', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, pattern: 'leader', teamSize: 3, domain: 'general', composite: 0.9 },
          { rank: 2, pattern: 'swarm', teamSize: 5, domain: 'general', composite: 0.4 },
        ],
        spread: 0.5,
      };
      const weights = await updateTeamWeights(groupResult, { persist: false });
      expect(weights['leader|3|general']).toBeGreaterThan(1.0);
    });

    it('decreases weight for worst-ranked team composition', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, pattern: 'leader', teamSize: 3, domain: 'general', composite: 0.9 },
          { rank: 2, pattern: 'swarm', teamSize: 5, domain: 'general', composite: 0.3 },
        ],
        spread: 0.6,
      };
      const weights = await updateTeamWeights(groupResult, { persist: false });
      expect(weights['swarm|5|general']).toBeLessThan(1.0);
    });

    it('persists to disk when persist=true', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, pattern: 'leader', teamSize: 3, domain: 'general', composite: 0.8 },
        ],
        spread: 0,
      };
      await updateTeamWeights(groupResult, { persist: true });
      expect(writeJsonFile).toHaveBeenCalledTimes(1);
    });

    it('does not persist when persist=false', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, pattern: 'solo', teamSize: 0, domain: 'general', composite: 0.7 },
        ],
        spread: 0,
      };
      await updateTeamWeights(groupResult, { persist: false });
      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('clamps weights between 0.01 and 5.0', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: {},
        teamWeights: { 'leader|3|general': 4.99 },
      });
      const groupResult = {
        rankings: [
          { rank: 1, pattern: 'leader', teamSize: 3, domain: 'general', composite: 1.0 },
        ],
        spread: 0,
      };
      const weights = await updateTeamWeights(groupResult, { persist: false });
      expect(weights['leader|3|general']).toBeLessThanOrEqual(5.0);
    });

    it('respects custom learning rate', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, pattern: 'leader', teamSize: 3, domain: 'general', composite: 1.0 },
          { rank: 2, pattern: 'swarm', teamSize: 5, domain: 'general', composite: 0.5 },
        ],
        spread: 0.5,
      };
      const slow = await updateTeamWeights(groupResult, { persist: false, learningRate: 0.01 });
      const fast = await updateTeamWeights(groupResult, { persist: false, learningRate: 0.5 });
      expect(Math.abs(fast['leader|3|general'] - 1.0)).toBeGreaterThan(
        Math.abs(slow['leader|3|general'] - 1.0),
      );
    });

    it('uses composite key format pattern|size|domain', async () => {
      const groupResult = {
        rankings: [
          { rank: 1, pattern: 'pipeline', teamSize: 4, domain: 'security', composite: 0.85 },
        ],
        spread: 0,
      };
      const weights = await updateTeamWeights(groupResult, { persist: false });
      expect(weights).toHaveProperty('pipeline|4|security');
    });
  });

  // ---------------------------------------------------------------------------
  describe('getGrpoStats()', () => {
    it('returns stats with all required fields', async () => {
      readJsonFile.mockResolvedValue(null);
      const stats = await getGrpoStats();
      expect(stats).toHaveProperty('totalRounds');
      expect(stats).toHaveProperty('taskRounds');
      expect(stats).toHaveProperty('teamRounds');
      expect(stats).toHaveProperty('weights');
      expect(stats).toHaveProperty('teamWeights');
      expect(stats).toHaveProperty('recentRounds');
    });

    it('returns 0 rounds when no history exists', async () => {
      readJsonFile.mockResolvedValue(null);
      const stats = await getGrpoStats();
      expect(stats.totalRounds).toBe(0);
      expect(stats.taskRounds).toBe(0);
      expect(stats.teamRounds).toBe(0);
      expect(stats.recentRounds).toEqual([]);
    });

    it('counts task and team rounds separately', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [
          { id: 'r1', type: 'task', timestamp: new Date().toISOString() },
          { id: 'r2', type: 'team', timestamp: new Date().toISOString() },
          { id: 'r3', type: 'task', timestamp: new Date().toISOString() },
          { id: 'r4', type: 'team', timestamp: new Date().toISOString() },
          { id: 'r5', type: 'team', timestamp: new Date().toISOString() },
        ],
        weights: { balanced: 1.2 },
        teamWeights: { 'leader|3|general': 1.5 },
      });
      const stats = await getGrpoStats();
      expect(stats.totalRounds).toBe(5);
      expect(stats.taskRounds).toBe(2);
      expect(stats.teamRounds).toBe(3);
    });

    it('respects lookback option', async () => {
      const rounds = Array.from({ length: 100 }, (_, i) => ({
        id: `r${i}`,
        type: i % 2 === 0 ? 'task' : 'team',
        timestamp: new Date().toISOString(),
      }));
      readJsonFile.mockResolvedValue({ rounds, weights: {}, teamWeights: {} });

      const stats = await getGrpoStats({ lookback: 10 });
      expect(stats.recentRounds).toHaveLength(10);
      expect(stats.totalRounds).toBe(100);
    });

    it('returns current weights and teamWeights', async () => {
      readJsonFile.mockResolvedValue({
        rounds: [],
        weights: { balanced: 1.3, rapid: 0.8 },
        teamWeights: { 'leader|3|frontend': 2.0 },
      });
      const stats = await getGrpoStats();
      expect(stats.weights).toEqual({ balanced: 1.3, rapid: 0.8 });
      expect(stats.teamWeights).toEqual({ 'leader|3|frontend': 2.0 });
    });
  });
});
