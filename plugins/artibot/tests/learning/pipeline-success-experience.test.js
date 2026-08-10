/**
 * Pipeline — session scoring inputs and success-experience synthesis.
 *
 * Covers `buildSessionResult` (the transcript-signal -> scoring-input mapping)
 * and the `type: 'success'` experience synthesized inside runSelfEvaluation.
 * The latter is private, so it is driven through the exported shutdownLearning().
 *
 * History worth keeping in view: every case below used to be expressed in terms
 * of `sessionData.completedTasks`, a SessionEnd payload field that is never
 * populated. The cases passed against mocks while the production path scored
 * every real session identically. They are re-expressed here against the signal
 * record that actually arrives — same behaviours, real input vocabulary. A test
 * whose fixture cannot occur in production proves the fixture, not the code.
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
vi.mock('../../lib/learning/knowledge-demotion.js', () => ({
  hotSwap: vi.fn(async () => null),
}));

const { buildSessionResult, shutdownLearning } = await import('../../lib/learning/pipeline.js');

/**
 * A measured signal record, shaped like resolveSessionSignals() output.
 * @param {object} [over] - Fields to override
 * @returns {object}
 */
function signals(over = {}) {
  return {
    source: 'transcript',
    toolCalls: 100,
    toolErrors: 2,
    filesTouched: 5,
    filesSeen: 12,
    wallClockMs: 60000,
    firstTs: null,
    lastTs: null,
    byTool: {},
    main: { toolCalls: 100, toolErrors: 2, filesTouched: 5, filesSeen: 12 },
    subagent: { toolCalls: 0, toolErrors: 0, filesTouched: 0, filesSeen: 0 },
    subagentFiles: 0,
    ...over,
  };
}

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

describe('buildSessionResult — signal to scoring input', () => {
  it('maps filesSeen to filesEngaged and filesTouched to filesModified', () => {
    // The two denominators are not interchangeable: filesEngaged is what the
    // efficiency ladder divides by. Swapping them roughly doubles every ratio
    // and silently re-grades every session, so the mapping is pinned here.
    const result = buildSessionResult(signals({ filesSeen: 12, filesTouched: 5 }));
    expect(result.filesEngaged).toBe(12);
    expect(result.filesModified).toBe(5);
  });

  it('passes tool calls through', () => {
    expect(buildSessionResult(signals({ toolCalls: 143 })).toolCalls).toBe(143);
  });

  it('never supplies duration, so wall-clock cannot become an efficiency score', () => {
    // Diverges from PRD §5.3 on measured grounds: 8 of 92 real sessions engage
    // no files, and with a duration present they fall through to the v1 ladder
    // and score 1 for having merely stayed open. self-evaluator.js:480-482
    // returns no ratio for them deliberately; this keeps that decision intact.
    expect(buildSessionResult(signals({ wallClockMs: 987 })).duration).toBeUndefined();
    expect(buildSessionResult(signals({ wallClockMs: 99999999 })).duration).toBeUndefined();
  });

  it('leaves a file-less session without an efficiency denominator', () => {
    // The pairing that matters: no files AND no duration means scoreEfficiency
    // has nothing to judge and returns its neutral score, rather than reading a
    // long session as an inefficient one.
    const result = buildSessionResult(signals({ filesSeen: 0, filesTouched: 0, wallClockMs: 5000000 }));
    expect(result.filesEngaged).toBe(0);
    expect(result.duration).toBeUndefined();
  });

  it('leaves testsPass undefined — no transcript signal reports test outcomes', () => {
    // Guards the specific regression this replaced: testsPass used to be
    // derived from the same count as success, so two dimensions moved as one.
    expect(buildSessionResult(signals()).testsPass).toBeUndefined();
    expect(buildSessionResult(signals({ toolErrors: 90 })).testsPass).toBeUndefined();
  });

  it('marks a low-error session successful', () => {
    expect(buildSessionResult(signals({ toolCalls: 100, toolErrors: 2 })).success).toBe(true);
  });

  it('marks a session past the error-rate ceiling unsuccessful', () => {
    expect(buildSessionResult(signals({ toolCalls: 10, toolErrors: 6 })).success).toBe(false);
  });

  it('treats the error-rate ceiling as inclusive', () => {
    // 25% exactly still counts as success; just past it does not.
    expect(buildSessionResult(signals({ toolCalls: 4, toolErrors: 1 })).success).toBe(true);
    expect(buildSessionResult(signals({ toolCalls: 100, toolErrors: 26 })).success).toBe(false);
  });

  it('leaves success undefined when a measured session ran no tools', () => {
    // No calls means no rate to judge — not a failure.
    expect(buildSessionResult(signals({ toolCalls: 0, toolErrors: 0 })).success).toBeUndefined();
  });

  it('reports every field absent when nothing could be measured', () => {
    // source:'none' must not be laundered into an observation of an idle
    // session — that conflation is the bug this work exists to remove.
    const result = buildSessionResult({
      source: 'none', toolCalls: 0, toolErrors: 0,
      filesTouched: 0, filesSeen: 0, wallClockMs: null,
    });
    expect(result.success).toBeUndefined();
    expect(result.duration).toBeUndefined();
    expect(result.testsPass).toBeUndefined();
    expect(result.toolCalls).toBeUndefined();
    expect(result.filesEngaged).toBeUndefined();
    expect(result.filesModified).toBeUndefined();
  });

});

describe('shutdownLearning — scoring inputs reach the evaluator', () => {
  it('scores from signals and labels their provenance', async () => {
    await shutdownLearning({
      sessionId: 'sess-signals',
      project: 'artibot',
      signals: signals({ toolCalls: 200, toolErrors: 4, filesTouched: 9, filesSeen: 21 }),
    });

    expect(evaluateResult).toHaveBeenCalledTimes(1);
    const [, result, options] = evaluateResult.mock.calls[0];
    expect(result.toolCalls).toBe(200);
    expect(result.filesEngaged).toBe(21);
    expect(result.filesModified).toBe(9);
    expect(options.signalSource).toBe('transcript');
  });

  it('falls back to empty signals when the hook supplied none', async () => {
    // The hook returns null if signal extraction threw. Scoring must still run,
    // recorded honestly as unmeasured rather than crashing session teardown.
    await shutdownLearning({ sessionId: 'sess-nosignals', project: 'artibot' });

    const [, result, options] = evaluateResult.mock.calls[0];
    expect(result.success).toBeUndefined();
    expect(result.toolCalls).toBeUndefined();
    expect(options.signalSource).toBe('none');
  });

  it('ignores completedTasks — the field that produced the constant grades', async () => {
    // completedTasks still rides along for other consumers, but a session whose
    // signals say it went badly must not be rescued by it.
    await shutdownLearning({
      sessionId: 'sess-ignore',
      project: 'artibot',
      completedTasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
      errors: [],
      signals: signals({ toolCalls: 10, toolErrors: 6 }),
    });

    expect(evaluateResult.mock.calls[0][1].success).toBe(false);
    expect(calledWithType('success')).toBeUndefined();
  });
});

describe('shutdownLearning — session summary metadata', () => {
  it('supplies measured counts the summary cannot get from an absent history', async () => {
    // Without this the stored summary is always commandCount 0 / errorCount 0 /
    // duration null, because SessionEnd carries no event history.
    await shutdownLearning({
      sessionId: 'sess-meta',
      project: 'artibot',
      signals: signals({ toolCalls: 143, toolErrors: 4, wallClockMs: 77000 }),
    });

    expect(summarizeSession).toHaveBeenCalledTimes(1);
    expect(summarizeSession.mock.calls[0][0].metadata).toEqual({
      commandCount: 143, errorCount: 4, duration: 77000,
    });
  });

  it('leaves an unmeasured session without fabricated counts', async () => {
    // "Nothing recorded" must not be rewritten as a measured zero.
    await shutdownLearning({
      sessionId: 'sess-meta-none',
      project: 'artibot',
      signals: { source: 'none', toolCalls: 0, toolErrors: 0, filesTouched: 0, filesSeen: 0, wallClockMs: null },
    });
    expect(summarizeSession.mock.calls[0][0].metadata).toBeUndefined();
  });

  it('does not clobber metadata a caller already supplied', async () => {
    await shutdownLearning({
      sessionId: 'sess-meta-keep',
      project: 'artibot',
      metadata: { duration: 111, custom: 'keep' },
      signals: signals({ toolCalls: 143, wallClockMs: 77000 }),
    });
    const { metadata } = summarizeSession.mock.calls[0][0];
    expect(metadata.duration).toBe(111);
    expect(metadata.custom).toBe('keep');
    expect(metadata.commandCount).toBe(143);
  });

  it('passes a null wall-clock through as null rather than dropping the key', async () => {
    await shutdownLearning({
      sessionId: 'sess-meta-null',
      project: 'artibot',
      signals: signals({ wallClockMs: null }),
    });
    expect(summarizeSession.mock.calls[0][0].metadata.duration).toBeNull();
  });
});

describe('shutdownLearning — success experience synthesis', () => {
  it('records a type:"success" experience for a healthy session', async () => {
    await shutdownLearning({
      sessionId: 'sess-1',
      project: 'artibot',
      signals: signals({ toolCalls: 100, toolErrors: 2, filesTouched: 2, wallClockMs: 12345 }),
    });

    const successCall = calledWithType('success');
    expect(successCall).toBeDefined();
    const payload = successCall[0];
    expect(payload.category).toBe('session');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.data.taskId).toBe('sess-1');
    expect(payload.data.strategy).toBe('session');
    expect(payload.data.duration).toBe(12345);
    expect(payload.data.filesModified).toBe(2);
    // Was `true` before, derived from the same count as success. There is no
    // test-outcome signal in a transcript, so null is the honest record.
    expect(payload.data.testsPass).toBeNull();
  });

  it('does NOT record a success experience when errors dominate', async () => {
    await shutdownLearning({
      sessionId: 'sess-2',
      project: 'artibot',
      signals: signals({ toolCalls: 10, toolErrors: 8 }),
    });

    expect(calledWithType('success')).toBeUndefined();
    expect(calledWithType('self-evaluation')).toBeDefined();
  });

  it('still records self-evaluation experience when the success path fires', async () => {
    await shutdownLearning({
      sessionId: 'sess-3',
      project: 'artibot',
      signals: signals(),
    });

    expect(calledWithType('self-evaluation')).toBeDefined();
    expect(calledWithType('success')).toBeDefined();
    expect(collectExperience).toHaveBeenCalledTimes(2);
  });

  it('still records wall-clock on the success experience row', async () => {
    // Wall-clock is dropped from *scoring*, not from the record. It remains
    // useful data; it just must not be turned into an efficiency verdict.
    await shutdownLearning({
      sessionId: 'sess-wallclock',
      project: 'artibot',
      signals: signals({ wallClockMs: 4242 }),
    });
    expect(calledWithType('success')[0].data.duration).toBe(4242);
  });

  it('coerces an unmeasured duration and file count to null', async () => {
    await shutdownLearning({
      sessionId: 'sess-4',
      project: 'artibot',
      signals: signals({ wallClockMs: null, filesTouched: 0 }),
    });

    const successCall = calledWithType('success');
    expect(successCall).toBeDefined();
    expect(successCall[0].data.duration).toBeNull();
    expect(successCall[0].data.filesModified).toBe(0);
    expect(successCall[0].data.testsPass).toBeNull();
  });

  it('does NOT record success for a session nobody could measure', async () => {
    // Replaces the old "idle session" case. An unmeasured session must not
    // pollute the success-pattern feed, and must not be filed as a failure
    // either — it simply produces no success row.
    await shutdownLearning({
      sessionId: 'sess-unmeasured',
      project: 'artibot',
      signals: { source: 'none', toolCalls: 0, toolErrors: 0, filesTouched: 0, filesSeen: 0, wallClockMs: null },
    });

    expect(calledWithType('success')).toBeUndefined();
    expect(calledWithType('self-evaluation')).toBeDefined();
  });

  it('records success for a productive session carrying transient errors', async () => {
    // Real sessions run 1.59%-4.17% tool-error rates; noise must not disqualify.
    await shutdownLearning({
      sessionId: 'sess-productive',
      project: 'artibot',
      signals: signals({ toolCalls: 279, toolErrors: 8, filesTouched: 17 }),
    });

    const successCall = calledWithType('success');
    expect(successCall).toBeDefined();
    expect(successCall[0].data.filesModified).toBe(17);
  });

  it('records success at the error-rate boundary', async () => {
    await shutdownLearning({
      sessionId: 'sess-boundary',
      project: 'artibot',
      signals: signals({ toolCalls: 4, toolErrors: 1 }),
    });

    expect(calledWithType('success')).toBeDefined();
  });

  it('skips success synthesis when self-evaluator throws (fail-soft)', async () => {
    evaluateResult.mockRejectedValueOnce(new Error('eval blew up'));

    const result = await shutdownLearning({
      sessionId: 'sess-5',
      project: 'artibot',
      signals: signals(),
    });

    expect(calledWithType('success')).toBeUndefined();
    expect(result.evaluated).toBeNull();
    expect(result.summarized).toBe(true);
  });
});
