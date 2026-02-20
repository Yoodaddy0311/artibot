import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logError, withErrorBoundary } from '../../lib/core/error.js';

describe('error', () => {
  let stderrSpy;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('logError()', () => {
    it('writes to stderr with correct prefix and message', () => {
      logError('pre-bash', 'something went wrong');
      expect(stderrSpy).toHaveBeenCalledOnce();
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toBe('[artibot:pre-bash] something went wrong\n');
    });

    it('includes cause.message when cause is an Error', () => {
      logError('session-end', 'failed to clean up', new Error('disk full'));
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toBe('[artibot:session-end] failed to clean up: disk full\n');
    });

    it('omits detail when cause is not provided', () => {
      logError('post-tool', 'operation skipped');
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toBe('[artibot:post-tool] operation skipped\n');
    });

    it('omits detail when cause is undefined explicitly', () => {
      logError('my-hook', 'no cause here', undefined);
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toBe('[artibot:my-hook] no cause here\n');
    });

    it('uses string value directly when cause is a plain string', () => {
      logError('router', 'parse failed', 'unexpected token');
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toBe('[artibot:router] parse failed: unexpected token\n');
    });

    it('uses numeric value directly when cause is a number', () => {
      logError('validator', 'exit code non-zero', 1);
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toBe('[artibot:validator] exit code non-zero: 1\n');
    });

    it('formats context with the [artibot:...] prefix', () => {
      logError('my-module', 'error occurred');
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toMatch(/^\[artibot:my-module\] /);
    });

    it('terminates output with a newline', () => {
      logError('hook', 'test');
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toMatch(/\n$/);
    });
  });

  describe('withErrorBoundary()', () => {
    it('returns the wrapped function result on success', async () => {
      const wrapped = withErrorBoundary('ctx', async () => 42);
      const result = await wrapped();
      expect(result).toBe(42);
    });

    it('passes arguments through to the wrapped function', async () => {
      const fn = vi.fn(async (a, b) => a + b);
      const wrapped = withErrorBoundary('ctx', fn);
      const result = await wrapped(3, 4);
      expect(fn).toHaveBeenCalledWith(3, 4);
      expect(result).toBe(7);
    });

    it('returns undefined fallback when the wrapped function throws', async () => {
      const wrapped = withErrorBoundary('ctx', async () => { throw new Error('boom'); });
      const result = await wrapped();
      expect(result).toBeUndefined();
    });

    it('returns the specified fallback value on error', async () => {
      const wrapped = withErrorBoundary('ctx', async () => { throw new Error('fail'); }, null);
      const result = await wrapped();
      expect(result).toBeNull();
    });

    it('returns a custom fallback object on error', async () => {
      const fallback = { status: 'error' };
      const wrapped = withErrorBoundary('ctx', async () => { throw new Error('fail'); }, fallback);
      const result = await wrapped();
      expect(result).toBe(fallback);
    });

    it('logs the error with the provided context name', async () => {
      const wrapped = withErrorBoundary('my-service', async () => { throw new Error('db timeout'); });
      await wrapped();
      expect(stderrSpy).toHaveBeenCalledOnce();
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('[artibot:my-service]');
      expect(output).toContain('db timeout');
    });

    it('logs "Unhandled error" as the message on any thrown error', async () => {
      const wrapped = withErrorBoundary('worker', async () => { throw new Error('oops'); });
      await wrapped();
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('Unhandled error');
    });

    it('does not write to stderr when the wrapped function succeeds', async () => {
      const wrapped = withErrorBoundary('clean', async () => 'ok');
      await wrapped();
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });
});
