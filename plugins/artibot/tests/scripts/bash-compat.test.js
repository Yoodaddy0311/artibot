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
  probeSh,
  probeShCandidate,
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

/**
 * `sh` is a SEPARATE question from `bash`, and the difference is not academic.
 * Measured 2026-08-15 on this box, from a PowerShell whose PATH comes only from
 * the registry: `bash` resolves (to the WSL launcher) while `sh` does not
 * resolve at all. A suite that spawns `sh` therefore cannot reuse probeBash().
 */
describe('probeSh contract', () => {
  it('returns the documented shape', () => {
    const r = probeSh();
    expect(typeof r.ok).toBe('boolean');
    expect(typeof r.reason).toBe('string');
    expect(r.sh === null || typeof r.sh === 'string').toBe(true);
  });

  it('carries a reason exactly when it is not ok', () => {
    const r = probeSh();
    if (r.ok) expect(r.reason).toBe('');
    else expect(r.reason.length).toBeGreaterThan(0);
  });

  it('memoizes — repeat calls return the identical object', () => {
    expect(probeSh()).toBe(probeSh());
  });

  it('re-probes after resetBashProbeCache()', () => {
    const before = probeSh();
    resetBashProbeCache();
    const after = probeSh();
    expect(after).not.toBe(before);
    expect(after.ok).toBe(before.ok); // same environment, same verdict
  });

  it('names a shell it actually validated when ok', () => {
    const r = probeSh();
    if (!r.ok) return; // verdict is environment-dependent; POSIX pin is below
    expect(r.sh.length).toBeGreaterThan(0);
    expect(probeShCandidate(r.sh).ok, `re-probe of ${r.sh} disagreed`).toBe(true);
  });
});

describe('probeShCandidate', () => {
  it('rejects a binary that does not exist, without throwing', () => {
    let res;
    expect(() => { res = probeShCandidate('artibot-no-such-shell-xyz'); }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(res.reason.length).toBeGreaterThan(0);
  });

  it('rejects empty and undefined candidates', () => {
    expect(probeShCandidate('').ok).toBe(false);
    expect(probeShCandidate(undefined).ok).toBe(false);
  });

  // NEGATIVE CONTROL. This is the assertion that stops the probe from decaying
  // back into an existence check. `process.execPath` definitely exists and
  // definitely spawns; it is simply not a POSIX shell. A probe that answers
  // "can I spawn it" says yes here, and that answer is what picked a `sh.exe`
  // which starts fine but silently drops stdin (measured 2026-08-15:
  // Git\usr\bin\sh.exe delivered an empty stdin and had no grep/sed/awk).
  it('rejects a real executable that is not a POSIX shell', () => {
    const res = probeShCandidate(process.execPath);
    expect(res.ok, 'node was accepted as a POSIX shell').toBe(false);
  });
});

// Anti-fail-open, same contract as the probeBash pin above: on POSIX there is
// no ambiguity about `sh`, so a false verdict there means the probe broke — and
// a broken probe would silently skip the 23 landing-flow gate tests in CI.
describe.skipIf(isWindows)('probeSh on POSIX (CI) must succeed', () => {
  it('reports ok — otherwise the pre-push gate suite would silently skip in CI', () => {
    const r = probeSh();
    expect(r.ok, `probe failed on POSIX: ${r.reason}`).toBe(true);
  });

  // LINUX INVARIANCE PIN. The Windows candidate derivation must stay invisible
  // to CI: on POSIX the first candidate is the literal 'sh', it wins, and every
  // caller therefore spawns exactly what it spawned before this module grew an
  // sh probe. If a refactor ever lets the derived-path machinery answer here,
  // CI's execution path would have changed silently — so it is pinned, not
  // argued. `sh` (not an absolute path) is the whole assertion.
  it("resolves the bare 'sh' — the derived candidate search never runs on POSIX", () => {
    expect(probeSh().sh).toBe('sh');
  });
});
