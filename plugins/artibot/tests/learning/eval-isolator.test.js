import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvalIsolator } from '../../lib/learning/eval-isolator.js';
import * as eventBus from '../../lib/core/event-bus.js';

afterEach(() => {
  eventBus.reset();
});

// ---------------------------------------------------------------------------
// prepareEvalContext
// ---------------------------------------------------------------------------

describe('eval-isolator/prepareEvalContext', () => {
  it('includes outputs and modifiedFiles', () => {
    const isolator = createEvalIsolator();
    const result = isolator.prepareEvalContext({
      outputs: ['code-block-1'],
      modifiedFiles: ['a.js', 'b.js'],
      testResults: { pass: 10, fail: 0 },
      originalRequest: 'build feature X',
      contract: { scope: 'module' },
    });

    expect(result.outputs).toEqual(['code-block-1']);
    expect(result.modifiedFiles).toEqual(['a.js', 'b.js']);
    expect(result.testResults).toEqual({ pass: 10, fail: 0 });
    expect(result.originalRequest).toBe('build feature X');
    expect(result.contract).toEqual({ scope: 'module' });
  });

  it('excludes reasoning from the context', () => {
    const isolator = createEvalIsolator();
    const result = isolator.prepareEvalContext({
      outputs: ['result'],
      reasoning: 'I chose this because...',
      attempts: [{ try: 1 }, { try: 2 }],
      debugLog: ['step1', 'step2'],
    });

    expect(result.reasoning).toBeUndefined();
    expect(result.attempts).toBeUndefined();
    expect(result.debugLog).toBeUndefined();
    expect(result.outputs).toEqual(['result']);
  });

  it('excludes all non-whitelisted fields', () => {
    const isolator = createEvalIsolator();
    const result = isolator.prepareEvalContext({
      outputs: [],
      randomExtra: 'should be stripped',
      internalState: { x: 1 },
      chainOfThought: ['thinking...'],
    });

    const keys = Object.keys(result);
    expect(keys).toEqual(['outputs', 'modifiedFiles', 'testResults', 'originalRequest', 'contract']);
  });

  it('handles null/undefined implementationResult gracefully', () => {
    const isolator = createEvalIsolator();

    const fromNull = isolator.prepareEvalContext(null);
    expect(fromNull.outputs).toEqual([]);
    expect(fromNull.modifiedFiles).toEqual([]);
    expect(fromNull.testResults).toBeNull();
    expect(fromNull.originalRequest).toBeNull();
    expect(fromNull.contract).toBeNull();

    const fromUndefined = isolator.prepareEvalContext(undefined);
    expect(fromUndefined.outputs).toEqual([]);
  });

  it('handles empty object', () => {
    const isolator = createEvalIsolator();
    const result = isolator.prepareEvalContext({});

    expect(result.outputs).toEqual([]);
    expect(result.modifiedFiles).toEqual([]);
    expect(result.testResults).toBeNull();
    expect(result.originalRequest).toBeNull();
    expect(result.contract).toBeNull();
  });

  it('preserves null testResults vs missing testResults', () => {
    const isolator = createEvalIsolator();

    const withNull = isolator.prepareEvalContext({ testResults: null });
    expect(withNull.testResults).toBeNull();

    const withValue = isolator.prepareEvalContext({ testResults: { pass: 5 } });
    expect(withValue.testResults).toEqual({ pass: 5 });
  });

  it('emits feature:eval-separated event by default', () => {
    const handler = vi.fn();
    eventBus.on('feature:eval-separated', handler);

    const isolator = createEvalIsolator();
    isolator.prepareEvalContext({
      outputs: ['code'],
      modifiedFiles: ['x.js'],
      testResults: { pass: 1 },
      contract: { scope: 'file' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const data = handler.mock.calls[0][0];
    expect(data.hasOutputs).toBe(true);
    expect(data.hasModifiedFiles).toBe(true);
    expect(data.hasTestResults).toBe(true);
    expect(data.hasContract).toBe(true);
    expect(data.timestamp).toBeTruthy();
  });

  it('does not emit event when emitEvents=false', () => {
    const handler = vi.fn();
    eventBus.on('feature:eval-separated', handler);

    const isolator = createEvalIsolator({ emitEvents: false });
    isolator.prepareEvalContext({ outputs: ['x'] });

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not mutate the original implementationResult', () => {
    const isolator = createEvalIsolator();
    const original = {
      outputs: ['a'],
      reasoning: 'secret',
      modifiedFiles: ['b.js'],
    };
    const originalCopy = JSON.parse(JSON.stringify(original));

    isolator.prepareEvalContext(original);

    expect(original).toEqual(originalCopy);
  });
});

// ---------------------------------------------------------------------------
// tagEvalResult
// ---------------------------------------------------------------------------

describe('eval-isolator/tagEvalResult', () => {
  it('appends isolation metadata to evalResult', () => {
    const isolator = createEvalIsolator();
    const evalResult = { overall: 4.2, grade: 'A', feedback: 'Good' };
    const tagged = isolator.tagEvalResult(evalResult);

    expect(tagged.overall).toBe(4.2);
    expect(tagged.grade).toBe('A');
    expect(tagged.feedback).toBe('Good');
    expect(tagged.isolation.method).toBe('context-separation');
    expect(tagged.isolation.reasoningExcluded).toBe(true);
    expect(tagged.isolation.evaluatorBias).toBe('skeptical');
    expect(tagged.isolation.timestamp).toBeTruthy();
  });

  it('does not mutate the original evalResult', () => {
    const isolator = createEvalIsolator();
    const original = { overall: 3.5 };
    const originalCopy = { ...original };

    isolator.tagEvalResult(original);

    expect(original).toEqual(originalCopy);
    expect(original.isolation).toBeUndefined();
  });

  it('handles null evalResult', () => {
    const isolator = createEvalIsolator();
    const tagged = isolator.tagEvalResult(null);

    expect(tagged.isolation.method).toBe('context-separation');
    expect(tagged.isolation.reasoningExcluded).toBe(true);
  });

  it('handles undefined evalResult', () => {
    const isolator = createEvalIsolator();
    const tagged = isolator.tagEvalResult(undefined);

    expect(tagged.isolation).toBeDefined();
    expect(tagged.isolation.evaluatorBias).toBe('skeptical');
  });

  it('overwrites existing isolation field if present', () => {
    const isolator = createEvalIsolator();
    const evalResult = { isolation: { old: true }, score: 5 };
    const tagged = isolator.tagEvalResult(evalResult);

    expect(tagged.isolation.method).toBe('context-separation');
    expect(tagged.isolation.old).toBeUndefined();
    expect(tagged.score).toBe(5);
  });
});
