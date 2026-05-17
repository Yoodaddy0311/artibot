/**
 * Unit tests for lib/autopilot/dry-run.js
 */
import { describe, expect, it, vi } from 'vitest';
import { createDryRunGitRunner, wrapPhaseForDryRun } from '../../lib/autopilot/dry-run.js';

describe('createDryRunGitRunner', () => {
  it('returns empty string by default', () => {
    const { runner } = createDryRunGitRunner();
    expect(runner(['status'], '/cwd')).toBe('');
  });

  it('records every call in .calls', () => {
    const { runner, calls } = createDryRunGitRunner();
    runner(['fetch', 'origin'], '/repo');
    runner(['log', '-1'], '/repo');
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['fetch', 'origin']);
    expect(calls[0].cwd).toBe('/repo');
  });

  it('respondWith allows custom canned stdout', () => {
    const { runner, respondWith } = createDryRunGitRunner();
    respondWith((args) => (args[0] === 'rev-parse' ? '/repo/root\n' : ''));
    expect(runner(['rev-parse', '--show-toplevel'], '/x')).toBe('/repo/root\n');
    expect(runner(['status'], '/x')).toBe('');
  });

  it('reset clears calls and responder', () => {
    const { runner, calls, respondWith, reset } = createDryRunGitRunner();
    respondWith(() => 'x');
    runner(['log'], '/x');
    expect(calls).toHaveLength(1);
    reset();
    expect(calls).toHaveLength(0);
    expect(runner(['log'], '/x')).toBe('');
  });

  it('swallows responder exceptions', () => {
    const { runner, respondWith } = createDryRunGitRunner();
    respondWith(() => { throw new Error('boom'); });
    expect(runner(['status'], '/x')).toBe('');
  });

  it('handles non-array args defensively', () => {
    const { runner, calls } = createDryRunGitRunner();
    runner(null, undefined);
    expect(calls[0].args).toEqual([]);
    expect(calls[0].cwd).toBe('');
  });
});

describe('wrapPhaseForDryRun', () => {
  it('throws TypeError when phaseFn is not a function', () => {
    expect(() => wrapPhaseForDryRun(null)).toThrow(TypeError);
  });

  it('forwards dryRun=true into the opts', () => {
    const inner = vi.fn(() => ({ status: 'passed' }));
    const wrapped = wrapPhaseForDryRun(inner);
    wrapped({ foo: 1 });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0][0].dryRun).toBe(true);
    expect(inner.mock.calls[0][0].foo).toBe(1);
  });

  it('attaches dryRunCalls / dryRunWrites to object result', () => {
    const inner = (opts) => {
      opts.gitRunner(['status'], '/cwd');
      opts.fs.writeFileSync('/tmp/x', 'data');
      return { status: 'passed' };
    };
    const sourceFs = { writeFileSync() { throw new Error('should not be called'); } };
    const wrapped = wrapPhaseForDryRun(inner, { sourceFs });
    const result = wrapped();
    expect(result.status).toBe('passed');
    expect(result.dryRunCalls).toHaveLength(1);
    expect(result.dryRunWrites).toHaveLength(1);
    expect(result.dryRunWrites[0].method).toBe('writeFileSync');
  });

  it('blocks fs writes — sourceFs method never invoked', () => {
    const spy = vi.fn();
    const sourceFs = { writeFileSync: spy, readFileSync: () => 'ok' };
    const wrapped = wrapPhaseForDryRun((opts) => {
      opts.fs.writeFileSync('/tmp/x', 'data');
      return {};
    }, { sourceFs });
    wrapped();
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes through user-supplied gitRunner', () => {
    const userRunner = vi.fn(() => 'user-out');
    const wrapped = wrapPhaseForDryRun((opts) => {
      const out = opts.gitRunner(['status'], '/x');
      return { out };
    });
    const result = wrapped({ gitRunner: userRunner });
    expect(result.out).toBe('user-out');
    expect(userRunner).toHaveBeenCalledTimes(1);
  });

  it('returns non-object result unchanged', () => {
    const wrapped = wrapPhaseForDryRun(() => 'just-a-string');
    expect(wrapped()).toBe('just-a-string');
  });
});
