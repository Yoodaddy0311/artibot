/**
 * Real-process contract for the edge paths of `scripts/ledger/session-coverage.mjs`: what it
 * refuses (an `--exclude-sessions` list it cannot honour, a malformed request), the key set it
 * still prints when the fold throws, the one retry after a Windows loader failure, and that
 * importing the script runs nothing.
 *
 * Split out of `session-coverage-cli.test.js` for the 800-line standard (V5-BACKLOG section 3);
 * the cases moved verbatim. None of them seeds a ledger, so the seeding helpers stay behind;
 * the project-root, CLI-runner and one-line-parser helpers are repeated below instead of shared.
 * Isolation is the original's: every case builds its own `mkdtempSync` root and uses it as both
 * the child cwd and `--cwd`. The design rationale, why every root carries
 * `artibot.config.json`, and the list of what the suite cannot see are in
 * `session-coverage-cli.test.js`.
 *
 * @module tests/ledger/session-coverage-cli-edges
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { spawnSyncRetryDllInit, STATUS_DLL_INIT_FAILED } from '../helpers/spawn-retry.js';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'session-coverage.mjs');

/** The exact key set the module header promises a caller can parse blind. */
const STDOUT_KEYS = [
  'event', 'measured_at', 'ledger_path', 'since',
  'ended', 'with_receipts', 'coverage', 'fallback_sessions',
  'by_status', 'by_reason', 'disagree',
  'receipt_only_sessions', 'receipt_sessions', 'duplicate_ended_rows',
  'malformed_ended', 'census',
  'exclude_sessions', 'views',
];

/** Every view carries these, and only these. */
const VIEW_KEYS = ['coverage', 'ended', 'skipped', 'skipped_by_cause', 'unresolved_models', 'with_receipts'];

/** @type {string} */
let tmp;

/** A project root the Artibot guards will actually run inside. */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/**
 * Run the CLI inside a project root.
 *
 * Through `spawnSyncRetryDllInit`: a child that exits 0xC0000142 with no output
 * died in the Windows loader before the CLI ran, and gets exactly one more
 * attempt (see the helper). Every assertion still reads the attempt it gets.
 * `deps.spawn` exists only for the case that pins this routing.
 */
function runCli(args, root, deps = {}) {
  const res = spawnSyncRetryDllInit(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env },
  }, deps);
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** The one JSON line, parsed, with the stream discipline checked first. */
function parseOne(out) {
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  expect(out.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(out.stdout);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-scov-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('session-coverage: --exclude-sessions is refused when it cannot be honoured', () => {
  /**
   * Exit 2, empty stdout, ONE stderr line naming the flag AND the specific
   * problem, no ledger created.
   *
   * The `problem` text is what makes each case discriminating. Before the flag
   * existed, every one of these passed for the WRONG reason: an unknown
   * argument also exits 2 with the flag name in its message. Only the specific
   * wording tells "refused because the list cannot be used" from "refused
   * because the flag is not understood".
   */
  function expectUsageError(args, root, problem) {
    const out = runCli(args, root);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.startsWith('session-coverage:')).toBe(true);
    expect(out.stderr).toContain('--exclude-sessions');
    expect(out.stderr).toContain(problem);
    expect(out.stderr).not.toContain('unknown argument');
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  }

  it.each([
    ['has no value', ['--exclude-sessions'], 'requires a value'],
    ['is blank', ['--exclude-sessions', '   '], 'is blank'],
    ['names a file that does not exist', ['--exclude-sessions', 'no-such-list.txt'], 'file not found'],
    ['names a nested path that does not exist', ['--exclude-sessions', 'missing/dir/list.md'], 'file not found'],
    ['is a comma list with no valid id', ['--exclude-sessions', ',,'], 'no session ids'],
  ])('exits 2 when the flag %s', (_label, args, problem) => {
    expectUsageError(args, makeRoot('U1'), problem);
  });

  it('exits 2 when the value is a directory', () => {
    const root = makeRoot('U2');
    mkdirSync(path.join(root, 'a-directory'), { recursive: true });
    expectUsageError(['--exclude-sessions', 'a-directory'], root, 'not a regular file');
  });

  it('exits 2 when the file holds no session id at all', () => {
    const root = makeRoot('U3');
    writeFileSync(path.join(root, 'prose.md'), '# notes\n\nnothing to see here, really.\n', 'utf-8');
    expectUsageError(['--exclude-sessions', 'prose.md'], root, 'no session ids');
  });

  it('exits 2 when the file is larger than a list has any reason to be', () => {
    const root = makeRoot('U4');
    // Every line is a valid id: it is the SIZE that must refuse it.
    writeFileSync(path.join(root, 'huge.txt'), 'sess-x\n'.repeat(200_000), 'utf-8');
    expectUsageError(['--exclude-sessions', 'huge.txt'], root, 'too large');
  });

  it('CONTROL: a list that CAN be honoured is not refused', () => {
    // Same root shape, same flag, a usable list: the refusals above are about
    // the list, not about the flag.
    const root = makeRoot('U6');
    writeFileSync(path.join(root, 'ok.txt'), 'sess-x\n', 'utf-8');
    const printed = parseOne(runCli(['--cwd', root, '--exclude-sessions', 'ok.txt'], root));
    expect(printed.exclude_sessions).toMatchObject({ source: 'file', requested: 1 });
  });

  it('names the flag in the usage line of an unknown-argument error', () => {
    const out = runCli(['--oops'], makeRoot('U5'));
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('--exclude-sessions');
  });
});

describe('session-coverage: an unexpected throw still prints the same key set', () => {
  it('prints empty views, the request it could echo, and the error', async () => {
    const root = makeRoot('T1');
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let code;
    let written;
    try {
      code = mod.main(
        ['--cwd', root, '--since', '2026-09-10T00:00:00Z', '--exclude-sessions', 'a,b'],
        { readLedger: () => { throw new Error('boom'); } },
      );
    } finally {
      // Read before restoring: mockRestore() also clears the recorded calls.
      written = write.mock.calls.map(([s]) => String(s));
      write.mockRestore();
    }

    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    const printed = JSON.parse(written[0]);
    expect(Object.keys(printed).sort()).toEqual([...STDOUT_KEYS, 'error'].sort());
    expect(printed.error).toBe('boom');
    expect(printed.ended).toBe(0);
    expect(printed.coverage).toBeNull();
    expect(printed.census).toBeNull();
    expect(printed.ledger_path).toBeNull();
    expect(printed.exclude_sessions).toEqual({ source: 'list', path: null, requested: 2, ignored: 0 });
    for (const scope of ['window', 'history']) {
      expect(Object.keys(printed.views[scope].unexcluded).sort()).toEqual(VIEW_KEYS);
      expect(printed.views[scope].unexcluded.coverage).toBeNull();
      expect(printed.views[scope].unexcluded.skipped).toBe(0);
      // Nothing was measured, so nothing was excluded: null, not an empty account.
      expect(printed.views[scope].excluded).toBeNull();
      expect(printed.views[scope].exclusion).toBeNull();
    }
  });
});

describe('session-coverage: what it refuses to answer', () => {
  it.each([
    ['an unknown flag is passed', ['--oops']],
    ['a flag has no value', ['--cwd']],
    ['--since has no value', ['--since']],
    ['--since does not parse to a time', ['--since', 'nonsense']],
    ['--since is empty', ['--since', '   ']],
  ])('exits 2 with an empty stdout when %s', (_label, args) => {
    const root = makeRoot('I');

    const out = runCli(args, root);

    // A malformed request is not an observation. Exiting 0 here would report a
    // measurement that was never taken, so a typo could read as success.
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.startsWith('session-coverage:')).toBe(true);
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  });

  it('still exits 0 when the ledger path is not a readable file', () => {
    const root = makeRoot('J');
    // A DIRECTORY where the ledger file belongs: present, not readable as text.
    mkdirSync(ledgerFilePath(root), { recursive: true });

    const printed = parseOne(runCli(['--cwd', root], root));

    // "The ledger cannot be read" is a finding about the project, not a failure
    // of this script — and the JSON is what says which of the two it was.
    expect(printed.census.file.present).toBe(true);
    expect(printed.census.file.readable).toBe(false);
    expect(printed.ended).toBe(0);
    expect(printed.coverage).toBeNull();
  });
});

describe('session-coverage: the spawn itself', () => {
  it('retries one empty 0xC0000142 exit, and the retry runs the real CLI', () => {
    const root = makeRoot('L');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // First attempt: the loader failure as observed (exit 0xC0000142, 0 bytes
    // out). Second: the real spawn, so parseOne below checks a real run.
    const spawn = vi.fn((...call) => (spawn.mock.calls.length === 1
      ? { status: STATUS_DLL_INIT_FAILED, signal: null, stdout: '', stderr: '' }
      : spawnSync(...call)));

    let printed;
    let notices;
    try {
      printed = parseOne(runCli(['--cwd', root], root, { spawn }));
    } finally {
      // Read before restoring: mockRestore() also clears the recorded calls.
      notices = stderrSpy.mock.calls.map(([s]) => String(s)).filter((s) => s.startsWith('[spawn-retry]'));
      stderrSpy.mockRestore();
    }

    // Two calls means runCli goes through spawnSyncRetryDllInit; a runCli that
    // called spawnSync directly would never touch the injected function.
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][0]).toBe(process.execPath);
    expect(spawn.mock.calls[0][1][0]).toBe(CLI);
    expect(printed.ended).toBe(0);
    expect(notices).toHaveLength(1);
  });
});

describe('session-coverage: it is safe to import', () => {
  it('exposes main and writes nothing when imported rather than run', async () => {
    const root = makeRoot('K');
    const file = ledgerFilePath(root);

    // The direct-run guard is what lets a test import this file without running
    // it. A guard that answers TRUE under import would make this import parse
    // the importer's own argv and print a line; a guard that answers FALSE on a
    // real direct run is fail-open in the quietest way (tests/ci/direct-run-guard).
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);

    expect(typeof mod.main).toBe('function');
    expect(existsSync(file)).toBe(false);
  });
});
