/**
 * Unit tests for scripts/update-platform.js — runtime/platform detection
 * helpers extracted from update.js (behavior-preserving split). These import
 * the module DIRECTLY (update.test.js exercises them via update.js re-exports);
 * this file pins the extracted module's own public surface.
 *
 * Covers:
 *   - resolveHome: USERPROFILE / HOME / os.homedir() precedence
 *   - findBash / findPowerShell: platform-aware, never-throw contract
 *   - findInstallScript / findInstallPs1: resolution + never-throw
 *   - inferBashFromGitExecPath / inferBashFromWhere: never-throw best-effort
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  findBash,
  findInstallPs1,
  findInstallScript,
  findPowerShell,
  inferBashFromGitExecPath,
  inferBashFromWhere,
  printManualInstructionsKo,
  resolveHome,
} from '../../scripts/update-platform.js';

const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_HOME = process.env.HOME;

afterEach(() => {
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

describe('resolveHome', () => {
  it('prefers USERPROFILE when set (Windows convention)', () => {
    process.env.USERPROFILE = 'C:\\Users\\WinUser';
    process.env.HOME = '/home/posix';
    expect(resolveHome()).toBe('C:\\Users\\WinUser');
  });

  it('falls back to HOME when USERPROFILE is unset', () => {
    delete process.env.USERPROFILE;
    process.env.HOME = '/home/posix';
    expect(resolveHome()).toBe('/home/posix');
  });

  it('returns a non-empty string when neither env is set (os.homedir fallback)', () => {
    delete process.env.USERPROFILE;
    delete process.env.HOME;
    const result = resolveHome();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('findBash', () => {
  it('returns the string "bash" on non-Windows platforms', () => {
    if (process.platform === 'win32') {
      const result = findBash();
      expect(result === null || typeof result === 'string').toBe(true);
    } else {
      expect(findBash()).toBe('bash');
    }
  });

  it('returns a string path or null and never throws regardless of platform', () => {
    let result;
    expect(() => { result = findBash(); }).not.toThrow();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('findPowerShell', () => {
  it('returns null on non-Windows platforms', () => {
    if (process.platform !== 'win32') {
      expect(findPowerShell()).toBeNull();
    } else {
      const result = findPowerShell();
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });

  it('never throws', () => {
    expect(() => findPowerShell()).not.toThrow();
  });
});

describe('inferBashFromGitExecPath / inferBashFromWhere', () => {
  it('return a string path or null and never throw', () => {
    let a; let b;
    expect(() => { a = inferBashFromGitExecPath(); }).not.toThrow();
    expect(() => { b = inferBashFromWhere(); }).not.toThrow();
    expect(a === null || typeof a === 'string').toBe(true);
    expect(b === null || typeof b === 'string').toBe(true);
  });
});

describe('findInstallScript / findInstallPs1', () => {
  it('findInstallScript returns a string path or null without throwing', () => {
    let result;
    expect(() => { result = findInstallScript(); }).not.toThrow();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('findInstallScript resolves install.sh from the source repo when run in-repo', () => {
    const result = findInstallScript();
    // In the source checkout the sibling install.sh exists.
    expect(typeof result).toBe('string');
    expect(result.endsWith('install.sh')).toBe(true);
  });

  it('findInstallPs1 returns a string path or null without throwing', () => {
    let result;
    expect(() => { result = findInstallPs1(); }).not.toThrow();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('printManualInstructionsKo', () => {
  it('never throws for any combination of resolved/absent installer paths', () => {
    expect(() => printManualInstructionsKo('C:/x/install.ps1', '/x/install.sh')).not.toThrow();
    expect(() => printManualInstructionsKo(null, null)).not.toThrow();
  });
});
