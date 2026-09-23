/**
 * Unit tests for `tests/helpers/spawn-retry.js`.
 *
 * Every case injects the spawn function and scripts its results, so the retry
 * rule is exercised exactly without depending on a loader failure that cannot
 * be produced on demand. The retry notice goes to this process's stderr, which
 * is observed through a spy on `process.stderr.write` — an object method, so
 * the spy sees the helper's call (unlike a spy on a named `child_process`
 * import). Case ③ is the negative control for that spy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSyncRetryDllInit, STATUS_DLL_INIT_FAILED } from './spawn-retry.js';

/** A spawnSync-shaped result. */
function result(status, stdout = '', stderr = '') {
  return { pid: 1, status, signal: null, stdout, stderr, output: [null, stdout, stderr] };
}

/** An injected spawn that returns `results` in order and records its calls. */
function scripted(...results) {
  const queue = [...results];
  return vi.fn(() => {
    if (queue.length === 0) throw new Error('spawn called more times than scripted');
    return queue.shift();
  });
}

/** Retry notices written to stderr during the case. */
function retryLines(spy) {
  return spy.mock.calls.map(([chunk]) => String(chunk)).filter((s) => s.startsWith('[spawn-retry]'));
}

let stderrSpy;
beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  stderrSpy.mockRestore();
});

describe('spawnSyncRetryDllInit', () => {
  it('pins the status value to 0xC0000142', () => {
    expect(STATUS_DLL_INIT_FAILED).toBe(0xC0000142);
  });

  it('① retries once after a DLL-init failure with no output, and says so', () => {
    const spawn = scripted(result(STATUS_DLL_INIT_FAILED), result(0, '{"ok":true}\n'));

    const res = spawnSyncRetryDllInit('node', ['cli.mjs', '--x'], { cwd: '/tmp/r' }, { spawn });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('{"ok":true}\n');
    expect(spawn).toHaveBeenCalledTimes(2);
    // The retry repeats the SAME invocation, not a variant of it.
    expect(spawn.mock.calls[1]).toEqual(spawn.mock.calls[0]);
    expect(spawn.mock.calls[0]).toEqual(['node', ['cli.mjs', '--x'], { cwd: '/tmp/r' }]);
    const lines = retryLines(stderrSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('0xC0000142');
    expect(lines[0].endsWith('\n')).toBe(true);
  });

  it('① also treats empty Buffers as no output', () => {
    const empty = Buffer.alloc(0);
    const spawn = scripted(result(STATUS_DLL_INIT_FAILED, empty, empty), result(0, Buffer.from('x')));

    const res = spawnSyncRetryDllInit('node', [], {}, { spawn });

    expect(res.status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(retryLines(stderrSpy)).toHaveLength(1);
  });

  it('② returns the second DLL-init failure unchanged — at most one retry', () => {
    const second = result(STATUS_DLL_INIT_FAILED);
    const spawn = scripted(result(STATUS_DLL_INIT_FAILED), second);

    const res = spawnSyncRetryDllInit('node', [], {}, { spawn });

    expect(res).toBe(second);
    expect(res.status).toBe(STATUS_DLL_INIT_FAILED);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(retryLines(stderrSpy)).toHaveLength(1);
  });

  it('③ does not retry an ordinary failure (exit 1)', () => {
    const first = result(1);
    const spawn = scripted(first);

    const res = spawnSyncRetryDllInit('node', [], {}, { spawn });

    expect(res).toBe(first);
    expect(spawn).toHaveBeenCalledTimes(1);
    // Negative control for the stderr spy used by ① and ②.
    expect(retryLines(stderrSpy)).toHaveLength(0);
  });

  it.each([
    ['stderr', result(STATUS_DLL_INIT_FAILED, '', 'boom\n')],
    ['stdout', result(STATUS_DLL_INIT_FAILED, 'partial', '')],
    ['a stderr Buffer', result(STATUS_DLL_INIT_FAILED, Buffer.alloc(0), Buffer.from('b'))],
  ])('④ does not retry a DLL-init exit that wrote to %s — the child ran', (_label, first) => {
    const spawn = scripted(first);

    const res = spawnSyncRetryDllInit('node', [], {}, { spawn });

    expect(res).toBe(first);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(retryLines(stderrSpy)).toHaveLength(0);
  });

  it('④ does not retry when output was not captured (null cannot be proven empty)', () => {
    const first = result(STATUS_DLL_INIT_FAILED, null, null);
    const spawn = scripted(first);

    expect(spawnSyncRetryDllInit('node', [], { stdio: 'ignore' }, { spawn })).toBe(first);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('⑤ does not retry a usage error (exit 2) with empty output', () => {
    const first = result(2);
    const spawn = scripted(first);

    const res = spawnSyncRetryDllInit('node', [], {}, { spawn });

    expect(res).toBe(first);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(retryLines(stderrSpy)).toHaveLength(0);
  });
});
