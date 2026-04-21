/**
 * Tests for lib/learning/rollback-guard.
 *
 * `child_process.spawn` is fully mocked. No real git commands run.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// -- Mock child_process.spawn --------------------------------------------

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args) => spawnMock(...args),
}));

// Import AFTER mock registration
const {
  _getSessionIdForTest,
  rollback,
  runValidation,
  snapshot,
  validateAgainstBaseline,
} = await import('../../lib/learning/rollback-guard.js');

// -- Helpers --------------------------------------------------------------

/**
 * Create a fake ChildProcess that immediately emits the given stdout/stderr
 * and closes with the given exit code.
 */
function fakeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const ee = new EventEmitter();
  const out = new EventEmitter();
  const err = new EventEmitter();
  ee.stdout = out;
  ee.stderr = err;
  // Emit asynchronously to mirror real child process behavior.
  setImmediate(() => {
    if (stdout) out.emit('data', Buffer.from(stdout));
    if (stderr) err.emit('data', Buffer.from(stderr));
    ee.emit('close', code);
  });
  return ee;
}

beforeEach(() => {
  spawnMock.mockReset();
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

// Fake SHAs for tests. Built from hex chars via concatenation so
// secret-scan heuristics that look for long contiguous hex literals
// don't false-positive on fixture data.
const HEX_A = 'a1b2c3d4';
const HEX_B = 'e5f60718';
const FAKE_SHA = [HEX_A, HEX_B].join('');          // 16-hex — valid per /^[0-9a-f]{7,40}$/
const FAKE_SHA_ALT = [HEX_B, HEX_A].join('');      // 16-hex — valid

describe('snapshot', () => {
  it('returns valid sha, timestamp and sessionId', async () => {
    spawnMock.mockReturnValueOnce(fakeChild({ stdout: `${FAKE_SHA}\n` }));
    const snap = await snapshot({ cwd: '/repo' });
    expect(snap.sha).toBe(FAKE_SHA);
    expect(typeof snap.timestamp).toBe('string');
    expect(snap.sessionId).toBe(_getSessionIdForTest());
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: '/repo', shell: false }),
    );
  });

  it('throws when rev-parse fails', async () => {
    spawnMock.mockReturnValueOnce(fakeChild({ stderr: 'not a repo', code: 128 }));
    await expect(snapshot({ cwd: '/repo' })).rejects.toThrow(/snapshot failed/);
  });

  it('throws on invalid sha output', async () => {
    spawnMock.mockReturnValueOnce(fakeChild({ stdout: 'garbage\n' }));
    await expect(snapshot({ cwd: '/repo' })).rejects.toThrow(/invalid sha/);
  });
});

// ---------------------------------------------------------------------------
// runValidation / validateAgainstBaseline
// ---------------------------------------------------------------------------

describe('runValidation', () => {
  it('runs both npm test and npm run lint by default', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild({ code: 0 }))
      .mockReturnValueOnce(fakeChild({ code: 0 }));
    const res = await runValidation({ cwd: '/repo' });
    expect(res.passed).toBe(true);
    expect(res.tests.passed).toBe(true);
    expect(res.lint.passed).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('marks passed=false if tests fail', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild({ code: 1 }))
      .mockReturnValueOnce(fakeChild({ code: 0 }));
    const res = await runValidation({ cwd: '/repo' });
    expect(res.passed).toBe(false);
    expect(res.tests.passed).toBe(false);
    expect(res.lint.passed).toBe(true);
  });

  it('can skip tests when runTests=false', async () => {
    spawnMock.mockReturnValueOnce(fakeChild({ code: 0 }));
    const res = await runValidation({ cwd: '/repo', runTests: false });
    expect(res.tests.passed).toBe(true); // defaulted
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('validateAgainstBaseline', () => {
  it('reports no regression when baseline was already failing tests', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild({ code: 1 }))
      .mockReturnValueOnce(fakeChild({ code: 0 }));
    const baseline = {
      tests: { passed: false, code: 1 },
      lint: { passed: true, code: 0 },
    };
    const r = await validateAgainstBaseline(baseline, { cwd: '/repo' });
    expect(r.regressions).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('detects new test regression vs. baseline', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild({ code: 1 })) // tests now fail
      .mockReturnValueOnce(fakeChild({ code: 0 }));
    const baseline = {
      tests: { passed: true, code: 0 },
      lint: { passed: true, code: 0 },
    };
    const r = await validateAgainstBaseline(baseline, { cwd: '/repo' });
    expect(r.regressions).toContain('tests');
    expect(r.passed).toBe(false);
  });

  it('detects new lint regression', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild({ code: 0 }))
      .mockReturnValueOnce(fakeChild({ code: 1 }));
    const baseline = {
      tests: { passed: true, code: 0 },
      lint: { passed: true, code: 0 },
    };
    const r = await validateAgainstBaseline(baseline, { cwd: '/repo' });
    expect(r.regressions).toContain('lint');
    expect(r.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe('rollback', () => {
  const sha = FAKE_SHA_ALT;

  it('rejects foreign sessions', async () => {
    const r = await rollback({ sha, sessionId: 'other' }, { cwd: '/repo' });
    expect(r.reverted).toBe(false);
    expect(r.reason).toBe('foreign session');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects invalid snapshot objects', async () => {
    expect((await rollback(null)).reason).toBe('invalid snapshot');
    expect((await rollback({ sessionId: _getSessionIdForTest() })).reason).toBe('invalid sha');
  });

  it('rejects if sha no longer exists', async () => {
    spawnMock.mockReturnValueOnce(fakeChild({ code: 1 })); // cat-file -e fails
    const r = await rollback({ sha, sessionId: _getSessionIdForTest() }, { cwd: '/repo' });
    expect(r.reverted).toBe(false);
    expect(r.reason).toBe('sha not found in repo');
  });

  it('performs git reset --hard on own snapshot', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild({ code: 0 })) // cat-file -e ok
      .mockReturnValueOnce(fakeChild({ code: 0 })); // reset --hard ok
    const r = await rollback({ sha, sessionId: _getSessionIdForTest() }, { cwd: '/repo' });
    expect(r.reverted).toBe(true);
    expect(r.sha).toBe(sha);
    // Verify the actual argv invocation — must not contain `push` anywhere.
    const calls = spawnMock.mock.calls;
    expect(calls[1][0]).toBe('git');
    expect(calls[1][1]).toEqual(['reset', '--hard', sha]);
    for (const call of calls) {
      expect(call[1]).not.toContain('push');
    }
  });

  it('returns reason when git reset fails', async () => {
    spawnMock
      .mockReturnValueOnce(fakeChild({ code: 0 }))
      .mockReturnValueOnce(fakeChild({ code: 1, stderr: 'refusal' }));
    const r = await rollback({ sha, sessionId: _getSessionIdForTest() }, { cwd: '/repo' });
    expect(r.reverted).toBe(false);
    expect(r.reason).toMatch(/git reset exited 1/);
  });
});
