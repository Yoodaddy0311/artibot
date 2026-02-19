import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('debug', () => {
  let stderrSpy;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  describe('when ARTIBOT_DEBUG=1', () => {
    it('debug() writes to stderr', async () => {
      vi.stubEnv('ARTIBOT_DEBUG', '1');
      // Re-import to pick up the env change
      const { debug } = await import('../../lib/core/debug.js');
      debug('test', 'hello');
      expect(stderrSpy).toHaveBeenCalled();
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('[artibot:test]');
      expect(output).toContain('hello');
    });

    it('debug() formats objects as JSON', async () => {
      vi.stubEnv('ARTIBOT_DEBUG', '1');
      const { debug } = await import('../../lib/core/debug.js');
      debug('test', { key: 'val' });
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('"key"');
      expect(output).toContain('"val"');
    });

    it('debug() handles null and undefined', async () => {
      vi.stubEnv('ARTIBOT_DEBUG', '1');
      const { debug } = await import('../../lib/core/debug.js');
      debug('test', null, undefined);
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('null');
      expect(output).toContain('undefined');
    });

    it('createDebugger() returns a scoped logger', async () => {
      vi.stubEnv('ARTIBOT_DEBUG', '1');
      const { createDebugger } = await import('../../lib/core/debug.js');
      const log = createDebugger('mymod');
      log('test message');
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('[artibot:mymod]');
      expect(output).toContain('test message');
    });

    it('isDebugEnabled() returns true', async () => {
      vi.stubEnv('ARTIBOT_DEBUG', '1');
      const { isDebugEnabled } = await import('../../lib/core/debug.js');
      expect(isDebugEnabled()).toBe(true);
    });
  });

  describe('when ARTIBOT_DEBUG is not set', () => {
    it('debug() does not write to stderr', async () => {
      vi.stubEnv('ARTIBOT_DEBUG', '');
      const { debug } = await import('../../lib/core/debug.js');
      debug('test', 'should not appear');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('isDebugEnabled() returns false', async () => {
      vi.stubEnv('ARTIBOT_DEBUG', '');
      const { isDebugEnabled } = await import('../../lib/core/debug.js');
      expect(isDebugEnabled()).toBe(false);
    });
  });
});
