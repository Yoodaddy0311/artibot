import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * git-autopilot-merge.js — conflict auto-resolution helpers.
 *
 * Phase 2c P0 D-1 fix: filePath is passed as an explicit argv-array element
 * to execFileSync (NOT spliced into a shell command).  Even when filePath
 * contains shell metacharacters, git must receive it verbatim as a single
 * argument and never spawn a shell.
 */

const execFileSyncSpy = vi.fn();
const readFileSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args) => execFileSyncSpy(...args),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: (...args) => readFileSyncMock(...args),
    writeFileSync: (...args) => writeFileSyncMock(...args),
  };
});

let resolveOurs;
let resolveTheirs;
let resolveUnion;

beforeEach(async () => {
  execFileSyncSpy.mockReset();
  readFileSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  // Default: return empty stdout for any git call.
  execFileSyncSpy.mockReturnValue('');
  if (!resolveOurs) {
    const mod = await import('../../scripts/hooks/git-autopilot-merge.js');
    resolveOurs = mod.resolveOurs;
    resolveTheirs = mod.resolveTheirs;
    resolveUnion = mod.resolveUnion;
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

const MALICIOUS = '; touch /tmp/pwn ; echo "; rm -rf /"';

describe('resolveOurs — argv-array safety (D-1)', () => {
  it('passes the file path as a separate argv element (no shell expansion)', () => {
    const r = resolveOurs(MALICIOUS, '/repo');
    expect(r.resolved).toBe(true);
    // Two execFileSync calls: checkout --ours -- <path>, then add -- <path>.
    expect(execFileSyncSpy).toHaveBeenCalledTimes(2);
    const [firstFile, firstArgs] = execFileSyncSpy.mock.calls[0];
    expect(firstFile).toBe('git');
    expect(Array.isArray(firstArgs)).toBe(true);
    // Crucially: the malicious path is the LAST element, intact, with no escaping.
    expect(firstArgs[firstArgs.length - 1]).toBe(MALICIOUS);
    // And the args BEFORE it form the literal git invocation.
    expect(firstArgs.slice(0, -1)).toEqual(['checkout', '--ours', '--']);
    // No call uses a shell option.
    for (const call of execFileSyncSpy.mock.calls) {
      const opts = call[2] || {};
      expect(opts.shell).toBeFalsy();
    }
  });

  it('reports unresolved with strategy=ours when execFileSync throws', () => {
    execFileSyncSpy.mockImplementation(() => {
      throw new Error('git: pathspec did not match');
    });
    const r = resolveOurs(MALICIOUS, '/repo');
    expect(r.resolved).toBe(false);
    expect(r.strategy).toBe('ours');
  });
});

describe('resolveTheirs — argv-array safety (D-1)', () => {
  it('passes the file path as a separate argv element', () => {
    const r = resolveTheirs(MALICIOUS, '/repo');
    expect(r.resolved).toBe(true);
    expect(execFileSyncSpy).toHaveBeenCalledTimes(2);
    const [firstFile, firstArgs] = execFileSyncSpy.mock.calls[0];
    expect(firstFile).toBe('git');
    expect(firstArgs.slice(0, -1)).toEqual(['checkout', '--theirs', '--']);
    expect(firstArgs[firstArgs.length - 1]).toBe(MALICIOUS);
    for (const call of execFileSyncSpy.mock.calls) {
      const opts = call[2] || {};
      expect(opts.shell).toBeFalsy();
    }
  });
});

describe('resolveUnion — argv-array safety (D-1)', () => {
  it('passes the file path as a separate argv element when staging the union result', () => {
    // No conflict markers in returned content -> union "resolves" trivially.
    readFileSyncMock.mockReturnValue('clean content with no markers\n');
    const r = resolveUnion(MALICIOUS, '/repo');
    expect(r.resolved).toBe(true);
    // Exactly one execFileSync call (the `git add -- <path>` after writeFileSync).
    expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
    const [file, args] = execFileSyncSpy.mock.calls[0];
    expect(file).toBe('git');
    expect(args.slice(0, -1)).toEqual(['add', '--']);
    expect(args[args.length - 1]).toBe(MALICIOUS);
  });
});
