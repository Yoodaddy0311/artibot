/**
 * lib/project-state/runtime-exclude.js — the hardening that followed review.
 *
 *   B1  The exclude file is handled as RAW BYTES. Read as UTF-8 it lost every
 *       invalid byte on the way out (`caf` + 0xE9 came back as 63 61 66 ef bf bd),
 *       which breaks a cp949-edited file and corrupts a UTF-16 one. The module
 *       header promises "every byte outside the block is preserved exactly";
 *       these cases hold it to that, on real repositories and real files.
 *   S2  A file nobody may write is skipped QUIETLY, and a rewrite keeps the
 *       original mode (a POSIX rename replaces the inode and would lose it).
 *   S3  The walk up from `cwd` mirrors git: a bare repository nested inside
 *       another repository, and a `.git` directory, are no-ops instead of reaching
 *       the outer repository; `GIT_CEILING_DIRECTORIES` stops the climb.
 *   Race  The file is re-read just before the rename; if another writer (the host
 *       keeps its own section in this file) got there first, nothing is written.
 *
 * Git's own verdict is asked wherever the expectation is "what git does": the
 * walk is only right if it agrees with `git rev-parse`, not with our reading of
 * git's documentation. Ambient GIT_* variables are scrubbed from every
 * environment, as in the sibling suite.
 *
 * WHAT THIS FILE DOES NOT SEE: the UTF-16 verdict is a policy (skip, say so) and
 * is asserted as one — that git cannot read such a file is documented git
 * behaviour, not something these cases re-measure. A real POSIX mode round trip
 * runs only on POSIX (skipped, by name, on Windows); the `chmod` spy case covers
 * the same wiring on every platform but not the OS semantics.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyManagedBlock,
  BLOCK_BEGIN,
  BLOCK_END,
  ensureRuntimeExclude,
} from '../../lib/project-state/runtime-exclude.js';

/** Environment with every GIT_* variable removed. */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

/** Everything made during a test, removed in afterEach. */
const made = [];

afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

/** @returns {string} A fresh temp directory, registered for cleanup. */
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `artibot-exclude-hard-${tag}-`));
  made.push(dir);
  return dir;
}

/** Run git in `cwd` under `env`, with no signing surprises. */
function git(cwd, args, env = ENV) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Whether git itself finds a repository from `cwd` under `env`. */
function gitFindsRepo(cwd, env = ENV) {
  try {
    git(cwd, ['rev-parse', '--git-dir'], env);
    return true;
  } catch {
    return false;
  }
}

/** A plain repository (`git init`). */
function makeRepo() {
  const dir = tmp('repo');
  git(dir, ['init', '-q']);
  return dir;
}

const infoDir = (repo) => path.join(repo, '.git', 'info');
const excludeOf = (repo) => path.join(infoDir(repo), 'exclude');

/** Replace the repository's info/exclude with exactly these bytes. */
function seed(repo, bytes) {
  fs.writeFileSync(excludeOf(repo), bytes);
  return excludeOf(repo);
}

/** Pin an old mtime on `file`; a later rewrite — even of identical bytes — moves it. */
function pinMtime(file) {
  const past = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(file, past, past);
  return past.toISOString();
}

// ---------------------------------------------------------------------------
// B1 — raw bytes
// ---------------------------------------------------------------------------
describe('B1 — bytes outside the block come back exactly', () => {
  const SAMPLES = [
    ['latin-1 e-acute (the measured case: 63 61 66 e9 2f 0a)', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2f, 0x0a])],
    ['cp949 hangul (b0 a1 b3 aa)', Buffer.concat([Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]), Buffer.from('/\n')])],
    ['a UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# comment\nnode_modules/\n')])],
    ['CRLF lines with high bytes', Buffer.concat([Buffer.from('a/\r\n'), Buffer.from([0xe9, 0xff, 0x80]), Buffer.from('\r\nb/\r\n')])],
    ['no trailing newline, a high byte last', Buffer.from([0x61, 0x2f, 0x0a, 0xb0])],
    ['every byte value except NUL and LF', Buffer.from(Array.from({ length: 256 }, (_, i) => i).filter((b) => b !== 0 && b !== 0x0a))],
  ];

  it.each(SAMPLES)('inserts after %s without changing a byte of it', (_label, bytes) => {
    const repo = makeRepo();
    const file = seed(repo, bytes);

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    const after = fs.readFileSync(file);
    expect(after.subarray(0, bytes.length).toString('hex')).toBe(bytes.toString('hex'));
    expect(after.includes(Buffer.from(BLOCK_BEGIN))).toBe(true);
  });

  it.each(SAMPLES)('is idempotent on %s: the second call writes nothing at all', (_label, bytes) => {
    const repo = makeRepo();
    const file = seed(repo, bytes);
    ensureRuntimeExclude({ cwd: repo, env: ENV });
    const first = fs.readFileSync(file);
    const pinned = pinMtime(file);

    expect(ensureRuntimeExclude({ cwd: repo, env: ENV })).toMatchObject({ ok: true, action: 'unchanged' });

    expect(fs.readFileSync(file).equals(first)).toBe(true);
    expect(fs.statSync(file).mtime.toISOString()).toBe(pinned);
  });

  it('replaces a stale block that sits between non-UTF-8 lines, keeping both sides byte for byte', () => {
    const head = Buffer.concat([Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]), Buffer.from('/\n')]); // cp949 before
    const stale = Buffer.from(`${BLOCK_BEGIN}\n**/.artibot/old/\n${BLOCK_END}\n`);
    const tail = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('/\n')]); // latin-1 after
    const repo = makeRepo();
    const file = seed(repo, Buffer.concat([head, stale, tail]));

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: true, action: 'replaced' });
    const after = fs.readFileSync(file);
    expect(after.subarray(0, head.length).equals(head)).toBe(true);
    expect(after.subarray(after.length - tail.length).equals(tail)).toBe(true);
    expect(after.includes(Buffer.from('**/.artibot/old/'))).toBe(false);
    expect(after.includes(Buffer.from('**/.artibot/state.yaml'))).toBe(true);
  });

  it('round-trips every single byte value through the pure function', () => {
    for (let b = 0; b <= 255; b += 1) {
      const original = Buffer.from([0x41, b, 0x0a]);
      const out = applyManagedBlock(original.toString('latin1'));
      expect(out.action, `byte ${b}`).toBe('inserted');
      expect(Buffer.from(out.text, 'latin1').subarray(0, 3).equals(original), `byte ${b}`).toBe(true);
    }
  });

  it('does not mistake UTF-8 text with multibyte characters for UTF-16', () => {
    const utf8 = Buffer.from('# 한글 주석\nnode_modules/\n', 'utf8');
    const repo = makeRepo();
    const file = seed(repo, utf8);

    expect(ensureRuntimeExclude({ cwd: repo, env: ENV })).toMatchObject({ ok: true, action: 'inserted' });
    expect(fs.readFileSync(file).subarray(0, utf8.length).equals(utf8)).toBe(true);
  });

  it('reads a marker through trailing spaces and tabs, but not through a 0xA0 byte (ASCII-only trim)', () => {
    const stale = `${BLOCK_BEGIN}  \t\n**/.artibot/old/\n${BLOCK_END}\t \n`;
    expect(applyManagedBlock(stale).action).toBe('replaced');

    // U+00A0 is what the latin-1 view of a 0xA0 byte looks like — a legitimate
    // trail byte of a cp949 character, not whitespace. A `trimEnd()` would eat it
    // and read this ordinary comment line as our begin marker.
    const nbsp = String.fromCharCode(0xa0);
    const notAMarker = `${BLOCK_BEGIN}${nbsp}\nuser/\n`;
    const out = applyManagedBlock(notAMarker);
    expect(out.action).toBe('inserted');
    expect(out.text.startsWith(notAMarker)).toBe(true);
  });
});

describe('B1 — a UTF-16 exclude is never touched, and never turned into mojibake', () => {
  const UTF16 = [
    ['UTF-16LE with a BOM (what PowerShell 5.1 `>>` writes)', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('node_modules/\r\n', 'utf16le')])],
    ['UTF-16BE with a BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00, 0x61, 0x00, 0x2f, 0x00, 0x0a])])],
    ['UTF-16LE without a BOM (NUL bytes)', Buffer.from('node_modules/\n', 'utf16le')],
    ['ASCII lines followed by a UTF-16 tail (mixed)', Buffer.concat([Buffer.from('a/\n'), Buffer.from('b/\n', 'utf16le')])],
  ];

  it.each(UTF16)('leaves %s byte for byte, names the remedy, and leaves no temp file', (_label, bytes) => {
    const repo = makeRepo();
    const file = seed(repo, bytes);
    const listing = fs.readdirSync(infoDir(repo)).sort();

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: false, reason: 'utf16-exclude', file });
    expect(result.error).toContain('UTF-8');
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(infoDir(repo)).sort()).toEqual(listing);

    // Idempotent: asking again says the same thing and still changes nothing.
    expect(ensureRuntimeExclude({ cwd: repo, env: ENV })).toEqual(result);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(infoDir(repo)).sort()).toEqual(listing);
  });
});

// ---------------------------------------------------------------------------
// S2 — read-only, and the mode of a rewritten file
// ---------------------------------------------------------------------------
describe('S2 — a file nobody may write is left alone, quietly', () => {
  /** Run `fn` with `file` made read-only; always restore it so cleanup can delete it. */
  function withReadOnly(file, fn) {
    fs.chmodSync(file, 0o444);
    try {
      return fn();
    } finally {
      fs.chmodSync(file, 0o666);
    }
  }

  it('skips a read-only exclude as ok:true (quiet — nothing for the hook to report) and changes nothing', () => {
    const repo = makeRepo();
    const file = excludeOf(repo);
    const bytes = fs.readFileSync(file);
    const listing = fs.readdirSync(infoDir(repo)).sort();

    const result = withReadOnly(file, () => ensureRuntimeExclude({ cwd: repo, env: ENV }));

    expect(result).toEqual({ ok: true, action: 'skipped', reason: 'read-only', file });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(infoDir(repo)).sort()).toEqual(listing);
  });

  it('keeps the lock when the file would also need a stale-block replacement', () => {
    const repo = makeRepo();
    const file = seed(repo, `user/\n${BLOCK_BEGIN}\n**/.artibot/old/\n${BLOCK_END}\n`);
    const bytes = fs.readFileSync(file);

    const result = withReadOnly(file, () => ensureRuntimeExclude({ cwd: repo, env: ENV }));

    expect(result).toMatchObject({ ok: true, action: 'skipped', reason: 'read-only' });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('control: the same file, once writable again, is written', () => {
    const repo = makeRepo();
    const file = excludeOf(repo);
    withReadOnly(file, () => ensureRuntimeExclude({ cwd: repo, env: ENV }));

    expect(ensureRuntimeExclude({ cwd: repo, env: ENV })).toMatchObject({ ok: true, action: 'inserted' });
  });

  it('puts the original mode back on the temp file before the rename (chmod spy — every platform)', () => {
    const repo = makeRepo();
    const file = excludeOf(repo);
    const original = fs.statSync(file).mode & 0o7777;
    const spy = vi.spyOn(fs, 'chmodSync');
    let calls;
    let result;
    try {
      result = ensureRuntimeExclude({ cwd: repo, env: ENV });
      calls = [...spy.mock.calls];
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    const onTemp = calls.find(([target]) => String(target).startsWith(file) && String(target).includes('.tmp.'));
    expect(onTemp, 'chmod on the temp sibling').toBeDefined();
    expect(onTemp[1]).toBe(original);
  });

  it.skipIf(process.platform === 'win32')('keeps a 0640 exclude at 0640 after a rewrite (POSIX — a rename replaces the inode)', () => {
    const repo = makeRepo();
    const file = excludeOf(repo);
    fs.chmodSync(file, 0o640);

    expect(ensureRuntimeExclude({ cwd: repo, env: ENV })).toMatchObject({ ok: true, action: 'inserted' });

    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });
});

// ---------------------------------------------------------------------------
// S3 — bare repositories and GIT_CEILING_DIRECTORIES
// ---------------------------------------------------------------------------
describe('S3 — the walk mirrors git: bare repositories', () => {
  /** An outer repository holding a real bare repository at vendor/mirror.git. */
  function outerWithBare() {
    const outer = makeRepo();
    const vendor = path.join(outer, 'vendor');
    fs.mkdirSync(vendor, { recursive: true });
    git(vendor, ['init', '-q', '--bare', 'mirror.git']);
    return { outer, bare: path.join(vendor, 'mirror.git') };
  }

  it('is a no-op inside a bare repository nested in another repository — git agrees it is bare', () => {
    const { outer, bare } = outerWithBare();
    const outerExclude = fs.readFileSync(excludeOf(outer));

    for (const cwd of [bare, path.join(bare, 'refs', 'heads'), path.join(bare, 'objects', 'info')]) {
      expect(git(cwd, ['rev-parse', '--is-bare-repository']), `git on ${cwd}`).toBe('true');
      expect(ensureRuntimeExclude({ cwd, env: ENV }), cwd).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    }
    expect(fs.readFileSync(excludeOf(outer)).equals(outerExclude)).toBe(true);
  });

  it('control: a plain directory in the same place still reaches the outer repository', () => {
    const { outer } = outerWithBare();
    const plain = path.join(outer, 'vendor', 'not-a-repo');
    fs.mkdirSync(plain);

    const result = ensureRuntimeExclude({ cwd: plain, env: ENV });

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    expect(fs.readFileSync(excludeOf(outer), 'utf8')).toContain(BLOCK_BEGIN);
  });

  it('control: a directory with only a HEAD file is not bare — HEAD, objects/ and refs/ together are', () => {
    const { outer } = outerWithBare();
    const lookalike = path.join(outer, 'vendor', 'lookalike');
    fs.mkdirSync(lookalike);
    fs.writeFileSync(path.join(lookalike, 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(lookalike, 'objects')); // refs/ missing

    expect(ensureRuntimeExclude({ cwd: lookalike, env: ENV })).toMatchObject({ ok: true, action: 'inserted' });
  });

  it('is a no-op inside a .git directory (git treats that as the git dir, not the work tree)', () => {
    const repo = makeRepo();
    const hooks = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const before = fs.readFileSync(excludeOf(repo));

    expect(git(hooks, ['rev-parse', '--is-inside-git-dir'])).toBe('true');
    expect(ensureRuntimeExclude({ cwd: hooks, env: ENV })).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    expect(fs.readFileSync(excludeOf(repo)).equals(before)).toBe(true);
  });
});

describe('S3 — the walk mirrors git: GIT_CEILING_DIRECTORIES', () => {
  /** An outer repository with a nested directory two levels down. */
  function outerWithDeep() {
    const outer = makeRepo();
    const deep = path.join(outer, 'sub', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    return { outer, deep, sub: path.join(outer, 'sub') };
  }

  it('stops at a ceiling that is the repository root: git finds nothing, so neither does the walk', () => {
    const { outer, deep } = outerWithDeep();
    const env = { ...ENV, GIT_CEILING_DIRECTORIES: outer };
    const before = fs.readFileSync(excludeOf(outer));

    expect(gitFindsRepo(deep, env)).toBe(false);
    expect(ensureRuntimeExclude({ cwd: deep, env })).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    expect(fs.readFileSync(excludeOf(outer)).equals(before)).toBe(true);
  });

  it('stops at a ceiling between the start and the repository root', () => {
    const { outer, deep, sub } = outerWithDeep();
    const env = { ...ENV, GIT_CEILING_DIRECTORIES: sub };

    expect(gitFindsRepo(deep, env)).toBe(false);
    expect(ensureRuntimeExclude({ cwd: deep, env })).toMatchObject({ ok: true, action: 'skipped' });
    expect(fs.readFileSync(excludeOf(outer), 'utf8')).not.toContain(BLOCK_BEGIN);
  });

  it('never excludes the start directory itself (git: "it will not exclude the current working directory")', () => {
    const { outer } = outerWithDeep();
    const env = { ...ENV, GIT_CEILING_DIRECTORIES: outer };

    expect(gitFindsRepo(outer, env)).toBe(true);
    expect(ensureRuntimeExclude({ cwd: outer, env })).toMatchObject({ ok: true, action: 'inserted' });
  });

  it('is not stopped by a ceiling ABOVE the repository root', () => {
    const { outer, deep } = outerWithDeep();
    const env = { ...ENV, GIT_CEILING_DIRECTORIES: path.dirname(outer) };

    expect(gitFindsRepo(deep, env)).toBe(true);
    expect(ensureRuntimeExclude({ cwd: deep, env })).toMatchObject({ ok: true, action: 'inserted' });
  });

  it('is not stopped by an unrelated ceiling, or by empty and relative entries', () => {
    const { deep } = outerWithDeep();
    const env = { ...ENV, GIT_CEILING_DIRECTORIES: ['', 'relative/dir', tmp('unrelated')].join(path.delimiter) };

    expect(gitFindsRepo(deep, env)).toBe(true);
    expect(ensureRuntimeExclude({ cwd: deep, env })).toMatchObject({ ok: true, action: 'inserted' });
  });

  it('matches a ceiling that is spelled with a trailing separator', () => {
    const { deep, sub } = outerWithDeep();
    const env = { ...ENV, GIT_CEILING_DIRECTORIES: `${sub}${path.sep}` };

    expect(gitFindsRepo(deep, env)).toBe(false);
    expect(ensureRuntimeExclude({ cwd: deep, env })).toMatchObject({ ok: true, action: 'skipped' });
  });

  it('matches a ceiling through a link to the same directory — git resolves both sides, and so does the walk', () => {
    const { outer, deep, sub } = outerWithDeep();
    const link = path.join(tmp('alias'), 'via-link');
    fs.symlinkSync(outer, link, 'junction'); // a junction needs no privilege on Windows; elsewhere a plain symlink

    const cwdViaLink = path.join(link, 'sub', 'deep');
    const ceilingViaLink = path.join(link, 'sub');
    for (const [label, cwd, ceiling] of [
      ['cwd through the link, ceiling the real path', cwdViaLink, sub],
      ['cwd the real path, ceiling through the link', deep, ceilingViaLink],
    ]) {
      const env = { ...ENV, GIT_CEILING_DIRECTORIES: ceiling };
      expect(gitFindsRepo(cwd, env), `git: ${label}`).toBe(false);
      expect(ensureRuntimeExclude({ cwd, env }), label).toMatchObject({ ok: true, action: 'skipped' });
    }
    expect(fs.readFileSync(excludeOf(outer), 'utf8')).not.toContain(BLOCK_BEGIN);

    // Control: the same directory through the link, with no ceiling, still reaches the repository.
    expect(ensureRuntimeExclude({ cwd: cwdViaLink, env: ENV })).toMatchObject({ ok: true, action: 'inserted' });
  });

  it('honours the first matching entry of a list', () => {
    const { outer, deep } = outerWithDeep();
    const env = { ...ENV, GIT_CEILING_DIRECTORIES: [tmp('elsewhere'), outer].join(path.delimiter) };

    expect(gitFindsRepo(deep, env)).toBe(false);
    expect(ensureRuntimeExclude({ cwd: deep, env })).toMatchObject({ ok: true, action: 'skipped' });
  });
});

// ---------------------------------------------------------------------------
// Race — the host keeps its own section in this file
// ---------------------------------------------------------------------------
describe('a concurrent writer of the same file', () => {
  /** Spy on readFileSync so `onSecondRead` runs just before the re-read of `file`. */
  function interceptRereads(file, onSecondRead) {
    const real = fs.readFileSync.bind(fs);
    let reads = 0;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...rest) => {
      if (path.resolve(String(target)) === path.resolve(file)) {
        reads += 1;
        if (reads === 2) onSecondRead();
      }
      return real(target, ...rest);
    });
    return { spy, reads: () => reads };
  }

  it('writes nothing, reports it, and leaves the other writer\'s bytes when the file changes before the rename', () => {
    const repo = makeRepo();
    const file = excludeOf(repo);
    const listing = fs.readdirSync(infoDir(repo)).sort();
    const hostSection = '\n# claude-code-runtime\n.claude/worktrees/\n';
    const { spy } = interceptRereads(file, () => fs.appendFileSync(file, hostSection));
    let result;
    try {
      result = ensureRuntimeExclude({ cwd: repo, env: ENV });
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ ok: false, reason: 'changed-during-write', file });
    const after = fs.readFileSync(file, 'utf8');
    expect(after.endsWith(hostSection)).toBe(true);
    expect(after).not.toContain(BLOCK_BEGIN);
    expect(fs.readdirSync(infoDir(repo)).sort()).toEqual(listing); // the temp file was removed
  });

  it('control: the same spy with no interference still writes (the re-read is one extra read, not a veto)', () => {
    const repo = makeRepo();
    const file = excludeOf(repo);
    const { spy, reads } = interceptRereads(file, () => {});
    let result;
    try {
      result = ensureRuntimeExclude({ cwd: repo, env: ENV });
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    expect(reads()).toBe(2); // the initial read and the pre-rename re-read
  });

  it('counts a file that vanished after the first read as changed, and writes nothing', () => {
    const repo = makeRepo();
    const file = excludeOf(repo);
    const { spy } = interceptRereads(file, () => fs.rmSync(file));
    let result;
    try {
      result = ensureRuntimeExclude({ cwd: repo, env: ENV });
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ ok: false, reason: 'changed-during-write' });
    expect(fs.existsSync(file)).toBe(false);
  });
});
