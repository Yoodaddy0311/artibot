/**
 * Self-verification for the bash path-compatibility probe.
 *
 * WHY THIS FILE EXISTS — the probe is now a GATE, and gates fail open:
 *   `probeBash()` decides whether 12 installer/statusline harness tests run or
 *   skip. If it ever returns `{ ok: false }` unconditionally — a bad refactor,
 *   a temp dir that is not writable, a marker typo — those 12 tests vanish and
 *   the suite still reports green. That is precisely the "gate that cannot see
 *   its own failure" mode this repo has been bitten by before, so the probe
 *   gets a probe.
 *
 *   The load-bearing assertion is {@link !POSIX} below: on Linux (CI) there is
 *   exactly one bash and it can open POSIX paths, so `ok` MUST be true. If a
 *   change ever makes the probe unable to validate itself, CI goes red here
 *   instead of quietly skipping the suites that depend on it.
 *
 * @module tests/scripts/bash-compat
 */

import { describe, expect, it } from 'vitest';
import {
  announceBashSkip,
  probeBash,
  resetBashProbeCache,
  toBashPath,
} from '../../scripts/utils/bash-compat.js';

const isWindows = process.platform === 'win32';

describe('toBashPath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toBashPath('C:\\Users\\x\\y.sh')).toBe('C:/Users/x/y.sh');
  });

  it('leaves an already-POSIX path untouched', () => {
    expect(toBashPath('/tmp/x/y.sh')).toBe('/tmp/x/y.sh');
  });

  it('is idempotent', () => {
    const once = toBashPath('C:\\a\\b');
    expect(toBashPath(once)).toBe(once);
  });
});

describe('probeBash contract', () => {
  it('returns the documented shape', () => {
    const r = probeBash();
    expect(typeof r.ok).toBe('boolean');
    expect(typeof r.reason).toBe('string');
    expect(r.bash === null || typeof r.bash === 'string').toBe(true);
  });

  it('carries a reason exactly when it is not ok', () => {
    const r = probeBash();
    if (r.ok) expect(r.reason).toBe('');
    else expect(r.reason.length).toBeGreaterThan(0);
  });

  it('memoizes — repeat calls return the identical object', () => {
    expect(probeBash()).toBe(probeBash());
  });

  it('re-probes after resetBashProbeCache()', () => {
    const before = probeBash();
    resetBashProbeCache();
    const after = probeBash();
    expect(after).not.toBe(before);
    expect(after.ok).toBe(before.ok); // same environment, same verdict
  });
});

// The anti-fail-open assertion. Windows is intentionally exempt: there the
// verdict legitimately depends on which shell launched the process (Git Bash
// -> true, PowerShell/WSL -> false), so pinning it would just re-encode the
// bug. On POSIX there is no such ambiguity.
describe.skipIf(isWindows)('probeBash on POSIX (CI) must succeed', () => {
  it('reports ok — otherwise the harness suites would silently skip in CI', () => {
    const r = probeBash();
    expect(r.ok, `probe failed on POSIX: ${r.reason}`).toBe(true);
  });
});

describe('announceBashSkip', () => {
  it('does not throw and tolerates an explicit reason', () => {
    expect(() => announceBashSkip('unit-test/self-check', 'synthetic reason')).not.toThrow();
  });
});
