/**
 * Pipeline — success-experience synthesis (Stage B Area 1).
 *
 * Covers the new code path at pipeline.js:166-182 that synthesizes a
 * `type: 'success'` experience inside runSelfEvaluation when
 * sessionResult.success === true. The function is private; we drive it
 * through the exported shutdownLearning() integration point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const collectExperience = vi.fn(async () => {});
const evaluateResult = vi.fn(async () => {});
const getImprovementSuggestions = vi.fn(async () => ({
  overallTrend: 'improving',
  weakDimensions: [],
  suggestions: [],
}));
const summarizeSession = vi.fn(async () => {});
const saveMemory = vi.fn(async () => {});
const collectDailyExperiences = vi.fn(async () => {});
const batchLearn = vi.fn(async () => null);
const extractRules = vi.fn(() => []);
const injectRules = vi.fn(async () => []);
const evaluateGroup = vi.fn(() => ({ candidates: [], avgScore: 0, bestScore: 0 }));
const updateWeights = vi.fn(async () => ({}));

vi.mock('../../lib/learning/lifelong-learner.js', () => ({
  collectExperience,
  collectDailyExperiences,
  batchLearn,
}));
vi.mock('../../lib/learning/self-evaluator.js', () => ({
  evaluateResult,
  getImprovementSuggestions,
}));
vi.mock('../../lib/learning/memory-manager.js', () => ({
  summarizeSession,
  saveMemory,
}));
vi.mock('../../lib/learning/rule-extractor.js', () => ({
  extractRules,
}));
vi.mock('../../lib/learning/skill-injector.js', () => ({
  injectRules,
}));
vi.mock('../../lib/learning/grpo-optimizer.js', () => ({
  evaluateGroup,
  updateWeights,
}));
vi.mock('../../lib/learning/knowledge-demotion.js', () => ({
  hotSwap: vi.fn(async () => null),
}));

const { shutdownLearning } = await import('../../lib/learning/pipeline.js');

function calledWithType(type) {
  return collectExperience.mock.calls.find((args) => args[0]?.type === type);
}

beforeEach(() => {
  collectExperience.mockClear();
  evaluateResult.mockClear();
  getImprovementSuggestions.mockClear();
  summarizeSession.mockClear();
  collectDailyExperiences.mockClear();
  batchLearn.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('shutdownLearning — success experience synthesis', () => {
  it('records a type:"success" experience when session has no errors', async () => {
    const sessionData = {
      sessionId: 'sess-1',
      project: 'artibot',
      errors: [],
      duration: 12345,
      filesModified: ['a.js', 'b.js'],
      completedTasks: [{ id: 't1' }, { id: 't2' }],
    };

    await shutdownLearning(sessionData);

    const successCall = calledWithType('success');
    expect(successCall).toBeDefined();
    const payload = successCall[0];
    expect(payload.category).toBe('session');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.data.taskId).toBe('sess-1');
    expect(payload.data.strategy).toBe('session');
    expect(payload.data.duration).toBe(12345);
    expect(payload.data.filesModified).toBe(2);
    expect(payload.data.testsPass).toBe(true);
  });

  it('does NOT record a success experience when session has errors', async () => {
    const sessionData = {
      sessionId: 'sess-2',
      project: 'artibot',
      errors: [{ message: 'boom' }],
      duration: 999,
      filesModified: [],
      completedTasks: [],
    };

    await shutdownLearning(sessionData);

    expect(calledWithType('success')).toBeUndefined();
    expect(calledWithType('self-evaluation')).toBeDefined();
  });

  it('still records self-evaluation experience even when success path fires', async () => {
    const sessionData = {
      sessionId: 'sess-3',
      project: 'artibot',
      errors: [],
      duration: 1,
      filesModified: [],
      completedTasks: [],
    };

    await shutdownLearning(sessionData);

    expect(calledWithType('self-evaluation')).toBeDefined();
    expect(calledWithType('success')).toBeDefined();
    expect(collectExperience).toHaveBeenCalledTimes(2);
  });

  it('coerces missing duration to null and missing filesModified count to 0', async () => {
    const sessionData = {
      sessionId: 'sess-4',
      project: 'artibot',
      errors: [],
      completedTasks: [],
    };

    await shutdownLearning(sessionData);

    const successCall = calledWithType('success');
    expect(successCall).toBeDefined();
    expect(successCall[0].data.duration).toBeNull();
    expect(successCall[0].data.filesModified).toBe(0);
    expect(successCall[0].data.testsPass).toBeNull();
  });

  it('skips success synthesis when self-evaluator throws (fail-soft)', async () => {
    evaluateResult.mockRejectedValueOnce(new Error('eval blew up'));

    const sessionData = {
      sessionId: 'sess-5',
      project: 'artibot',
      errors: [],
      duration: 100,
      filesModified: ['x.js'],
      completedTasks: [{ id: 't1' }],
    };

    const result = await shutdownLearning(sessionData);

    expect(calledWithType('success')).toBeUndefined();
    expect(result.evaluated).toBeNull();
    expect(result.summarized).toBe(true);
  });
});
