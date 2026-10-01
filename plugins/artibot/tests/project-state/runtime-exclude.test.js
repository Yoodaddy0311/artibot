/**
 * lib/project-state/runtime-exclude.js — the managed `.artibot` block in the git
 * common dir's `info/exclude`.
 *
 * Two kinds of case, for two different claims:
 *
 *   - `applyManagedBlock` is pure, so the byte-level promises (idempotent,
 *     replaces a stale block, preserves every line outside the markers, keeps
 *     CRLF, refuses unbalanced markers) are asserted on strings.
 *   - Everything that depends on what GIT does — that the patterns really ignore
 *     the runtime files and really leave the canonical ones visible, that one
 *     block serves a linked worktree, that our common-dir resolution agrees with
 *     `git rev-parse --git-common-dir` — runs against REAL temporary repositories
 *     and real `git status`. A stubbed git would prove the branches are wired and
 *     nothing about whether the patterns mean what we think.
 *
 * WHAT THIS FILE DOES NOT SEE: a git older or newer than the one it ran on (the
 * measurements in the module header are git 2.54.0.windows.1), a user's global
 * `core.excludesFile`, and a real Claude Code session — the hook wiring is
 * `tests/hooks/project-bootstrap.test.js`.
 *
 * Ambient GIT_* variables (a pre-push hook exports GIT_DIR) are scrubbed from
 * every environment handed to git or to the code under test, so the suite judges
 * the temp repositories and not whatever repository launched it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runProjectBootstrap } from '../../lib/project-state/project-bootstrap.js';
import {
  applyManagedBlock,
  BLOCK_BEGIN,
  BLOCK_END,
  ensureRuntimeExclude,
  renderManagedBlock,
  resolveCommonDir,
  RUNTIME_EXCLUDE_ENTRIES,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `artibot-exclude-${tag}-`));
  made.push(dir);
  return dir;
}

/** Run git in `cwd` with a scrubbed environment and no signing/hooks surprises. */
function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, env: ENV, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A plain repository (`git init`). */
function makeRepo() {
  const dir = tmp('repo');
  git(dir, ['init', '-q']);
  return dir;
}

/** A repository with one commit and a linked worktree beside it. */
function makeRepoWithWorktree() {
  const repo = makeRepo();
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'init']);
  const worktree = path.join(tmp('wt'), 'linked');
  git(repo, ['worktree', 'add', '-q', worktree, '-b', 'linked-branch']);
  return { repo, worktree };
}

/** The common dir exactly as git reports it, made absolute. */
function gitCommonDir(cwd) {
  return path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']));
}

/** Canonical spelling, so 8.3 short names and long names compare equal. */
function canonical(p) {
  return fs.realpathSync.native(p);
}

function exclusePath(commonDir) {
  return path.join(commonDir, 'info', 'exclude');
}

/** Create one file, making its parents. */
function touch(root, rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x\n');
}

/** Canonical files — meant to be tracked, so they must stay visible. */
const CANONICAL_FILES = ['.artibot/project.md', '.artibot/missions/m-0001.md', '.artibot/adr/ADR-001.md'];

/**
 * Create one file for every managed entry (a directory entry gets a file inside
 * it) plus the canonical files, under `root`/`prefix`.
 */
function materialize(root, prefix = '') {
  for (const entry of RUNTIME_EXCLUDE_ENTRIES) {
    const rel = entry.replace(/^\*\*\//, '');
    touch(root, path.posix.join(prefix, rel.endsWith('/') ? `${rel}inside.txt` : rel));
  }
  for (const rel of CANONICAL_FILES) touch(root, path.posix.join(prefix, rel));
}

/** Untracked paths `git status` shows, sorted. */
function visibleUntracked(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=all'])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
}

// ---------------------------------------------------------------------------
// The block text
// ---------------------------------------------------------------------------
describe('RUNTIME_EXCLUDE_ENTRIES / renderManagedBlock', () => {
  it('lists each entry once, all under the any-depth .artibot prefix', () => {
    expect(new Set(RUNTIME_EXCLUDE_ENTRIES).size).toBe(RUNTIME_EXCLUDE_ENTRIES.length);
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) expect(entry.startsWith('**/.artibot/')).toBe(true);
    expect(Object.isFrozen(RUNTIME_EXCLUDE_ENTRIES)).toBe(true);
  });

  it('renders the begin marker, the entries, then the end marker — and nothing canonical', () => {
    const lines = renderManagedBlock().split('\n');
    expect(lines[0]).toBe(BLOCK_BEGIN);
    expect(lines.at(-1)).toBe(BLOCK_END);
    expect(lines.filter((l) => !l.startsWith('#'))).toEqual([...RUNTIME_EXCLUDE_ENTRIES]);
    for (const canonicalName of ['missions', 'adr', 'project.md']) {
      expect(lines.some((l) => !l.startsWith('#') && l.includes(canonicalName)), canonicalName).toBe(false);
    }
  });

  it('joins with the requested line terminator', () => {
    const crlf = renderManagedBlock(RUNTIME_EXCLUDE_ENTRIES, '\r\n');
    expect(crlf.split('\r\n')[0]).toBe(BLOCK_BEGIN);
    expect(/(^|[^\r])\n/.test(crlf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyManagedBlock — pure
// ---------------------------------------------------------------------------
describe('applyManagedBlock', () => {
  const USER = '# my own rules\nnode_modules/\n*.log\n';

  it('inserts into an empty file', () => {
    const { text, action } = applyManagedBlock('');
    expect(action).toBe('inserted');
    expect(text).toBe(`${renderManagedBlock()}\n`);
  });

  it('appends after existing content, separated by one blank line, and keeps every existing byte', () => {
    const { text, action } = applyManagedBlock(USER);
    expect(action).toBe('inserted');
    expect(text.startsWith(USER)).toBe(true);
    expect(text).toBe(`${USER}\n${renderManagedBlock()}\n`);
  });

  it('finishes an unterminated last line before appending', () => {
    const { text } = applyManagedBlock('keep-me');
    expect(text.startsWith('keep-me\n\n')).toBe(true);
    expect(text.endsWith(`${BLOCK_END}\n`)).toBe(true);
  });

  it('is idempotent — the second pass reports unchanged and returns the same bytes', () => {
    const first = applyManagedBlock(USER);
    const second = applyManagedBlock(first.text);
    expect(second.action).toBe('unchanged');
    expect(second.text).toBe(first.text);
    expect(applyManagedBlock(second.text).text).toBe(first.text);
  });

  it('replaces a stale block in place and preserves the lines before and after it', () => {
    const stale = [
      BLOCK_BEGIN,
      '# written by an older version',
      '**/.artibot/state.yaml',
      '**/.artibot/old-thing/',
      BLOCK_END,
    ].join('\n');
    const before = `# top of the file\nfoo/\n\n${stale}\n\nbar/\n# last user line\n`;

    const { text, action } = applyManagedBlock(before);

    expect(action).toBe('replaced');
    expect(text).toBe(`# top of the file\nfoo/\n\n${renderManagedBlock()}\n\nbar/\n# last user line\n`);
    expect(text).not.toContain('old-thing');
    expect(text).not.toContain('older version');
  });

  it('replaces every managed block it finds and deletes none', () => {
    const stale = `${BLOCK_BEGIN}\n**/.artibot/stale/\n${BLOCK_END}`;
    const { text, action } = applyManagedBlock(`a/\n${stale}\nb/\n${stale}\nc/\n`);
    expect(action).toBe('replaced');
    expect(text).toBe(`a/\n${renderManagedBlock()}\nb/\n${renderManagedBlock()}\nc/\n`);
  });

  it('keeps CRLF: an inserted block uses CRLF and no bare LF is introduced', () => {
    const crlfUser = '# mine\r\nnode_modules/\r\n';
    const { text } = applyManagedBlock(crlfUser);
    expect(text.startsWith(crlfUser)).toBe(true);
    expect(/(^|[^\r])\n/.test(text)).toBe(false);
  });

  it('keeps CRLF when replacing, and every byte outside the markers', () => {
    const crlf = (s) => s.split('\n').join('\r\n');
    const stale = crlf(`${BLOCK_BEGIN}\n**/.artibot/old/\n${BLOCK_END}`);
    const before = `${crlf('first/\n\n')}${stale}${crlf('\nafter/\n')}`;
    const { text, action } = applyManagedBlock(before);
    expect(action).toBe('replaced');
    expect(text).toBe(`${crlf('first/\n\n')}${renderManagedBlock(RUNTIME_EXCLUDE_ENTRIES, '\r\n')}${crlf('\nafter/\n')}`);
    expect(/(^|[^\r])\n/.test(text)).toBe(false);
  });

  it('keeps a file that ends right after the end marker without adding a line break', () => {
    const stale = `${BLOCK_BEGIN}\n**/.artibot/old/\n${BLOCK_END}`;
    const { text, action } = applyManagedBlock(`x/\n${stale}`);
    expect(action).toBe('replaced');
    expect(text).toBe(`x/\n${renderManagedBlock()}`);
  });

  it.each([
    ['a begin marker with no end', `keep/\n${BLOCK_BEGIN}\n**/.artibot/x/\nmore/\n`],
    ['an end marker with no begin', `keep/\n${BLOCK_END}\nmore/\n`],
    ['a begin marker nested inside a block', `${BLOCK_BEGIN}\n${BLOCK_BEGIN}\n${BLOCK_END}\n`],
    ['the markers in the wrong order', `${BLOCK_END}\nkeep/\n${BLOCK_BEGIN}\n`],
  ])('refuses %s and leaves the text untouched', (_label, broken) => {
    const { text, action } = applyManagedBlock(broken);
    expect(action).toBe('malformed');
    expect(text).toBe(broken);
  });

  it('does not treat a marker inside a longer line as a marker', () => {
    const { action } = applyManagedBlock(`# note: ${BLOCK_BEGIN} is our marker\nkeep/\n`);
    expect(action).toBe('inserted');
  });
});

// ---------------------------------------------------------------------------
// Against real git
// ---------------------------------------------------------------------------
describe('ensureRuntimeExclude against a real repository', () => {
  it('hides every runtime file and leaves every canonical file visible (main checkout)', () => {
    const repo = makeRepo();
    materialize(repo);
    expect(visibleUntracked(repo).length).toBeGreaterThan(CANONICAL_FILES.length); // control: nothing is ignored yet

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    expect(visibleUntracked(repo)).toEqual([...CANONICAL_FILES].sort());
  });

  it('also covers a nested .artibot directory (a hook whose project root is not the repo root)', () => {
    const repo = makeRepo();
    materialize(repo, 'packages/app');
    ensureRuntimeExclude({ cwd: repo, env: ENV });
    expect(visibleUntracked(repo)).toEqual(CANONICAL_FILES.map((f) => `packages/app/${f}`).sort());
  });

  it('resolves from a subdirectory to the same file the repository root uses', () => {
    const repo = makeRepo();
    const deep = path.join(repo, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });

    const result = ensureRuntimeExclude({ cwd: deep, env: ENV });

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    expect(canonical(result.file)).toBe(canonical(exclusePath(path.join(repo, '.git'))));
  });

  it('writes ONE block that serves the main checkout and a linked worktree alike', () => {
    const { repo, worktree } = makeRepoWithWorktree();
    materialize(repo);
    materialize(worktree);

    const fromWorktree = ensureRuntimeExclude({ cwd: worktree, env: ENV });

    expect(fromWorktree).toMatchObject({ ok: true, action: 'inserted' });
    // The file is the COMMON dir's, not the worktree's own git dir.
    expect(canonical(fromWorktree.file)).toBe(canonical(exclusePath(path.join(repo, '.git'))));
    expect(visibleUntracked(worktree)).toEqual([...CANONICAL_FILES].sort());
    expect(visibleUntracked(repo)).toEqual([...CANONICAL_FILES].sort());
    // Asking again from the main checkout finds the block already there.
    expect(ensureRuntimeExclude({ cwd: repo, env: ENV })).toMatchObject({ ok: true, action: 'unchanged' });
  });

  it('agrees with `git rev-parse --git-common-dir` from the root, a subdirectory and a linked worktree', () => {
    const { repo, worktree } = makeRepoWithWorktree();
    const cwds = [
      repo,
      (() => { const d = path.join(repo, 'sub', 'deep'); fs.mkdirSync(d, { recursive: true }); return d; })(),
      worktree,
      (() => { const d = path.join(worktree, 'sub', 'deep'); fs.mkdirSync(d, { recursive: true }); return d; })(),
    ];
    for (const cwd of cwds) {
      expect(canonical(resolveCommonDir(cwd, { env: ENV })), cwd).toBe(canonical(gitCommonDir(cwd)));
    }
  });

  it('is idempotent on disk — a second call changes neither the bytes nor the directory', () => {
    const repo = makeRepo();
    const first = ensureRuntimeExclude({ cwd: repo, env: ENV });
    const infoDir = path.dirname(first.file);
    const bytes = fs.readFileSync(first.file, 'utf8');
    const listing = fs.readdirSync(infoDir).sort();

    const second = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(second).toMatchObject({ ok: true, action: 'unchanged' });
    expect(fs.readFileSync(first.file, 'utf8')).toBe(bytes);
    expect(fs.readdirSync(infoDir).sort()).toEqual(listing); // no tmp droppings
    expect(bytes.split(BLOCK_BEGIN).length - 1).toBe(1);
  });

  it('WRITES NOTHING when the block is already current (not merely the same bytes)', () => {
    const repo = makeRepo();
    const { file } = ensureRuntimeExclude({ cwd: repo, env: ENV });
    // Pin the mtime far in the past: a rewrite — even of identical bytes — moves it.
    const past = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);

    expect(ensureRuntimeExclude({ cwd: repo, env: ENV })).toMatchObject({ ok: true, action: 'unchanged' });

    expect(fs.statSync(file).mtime.toISOString()).toBe(past.toISOString());
  });

  it('replaces a stale block on disk and keeps the user\'s own lines', () => {
    const repo = makeRepo();
    const file = exclusePath(path.join(repo, '.git'));
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(
      file,
      `${original}\nmine-before/\n${BLOCK_BEGIN}\n**/.artibot/state.yaml\n${BLOCK_END}\nmine-after/\n`,
    );

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: true, action: 'replaced' });
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain(`${original}\nmine-before/\n${BLOCK_BEGIN}`);
    expect(after.endsWith(`${BLOCK_END}\nmine-after/\n`)).toBe(true);
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) expect(after).toContain(`${entry}\n`);
  });

  it('creates info/exclude when the repository has no info directory', () => {
    const repo = makeRepo();
    fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true });

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    expect(fs.readFileSync(result.file, 'utf8')).toBe(`${renderManagedBlock()}\n`);
  });

  it('leaves a file with unbalanced markers alone and says why', () => {
    const repo = makeRepo();
    const file = exclusePath(path.join(repo, '.git'));
    const broken = `${fs.readFileSync(file, 'utf8')}${BLOCK_BEGIN}\nuser-stuff/\n`;
    fs.writeFileSync(file, broken);

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: false, reason: 'malformed-block' });
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  });

  it('reports a read failure instead of overwriting something it cannot read', () => {
    const repo = makeRepo();
    const file = exclusePath(path.join(repo, '.git'));
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file); // a directory where the file should be: readFileSync -> EISDIR

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: false, reason: 'read-failed' });
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it('does not throw when info is a file, and reports the failure', () => {
    const repo = makeRepo();
    const info = path.join(repo, '.git', 'info');
    fs.rmSync(info, { recursive: true, force: true });
    fs.writeFileSync(info, 'not a directory');

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result.ok).toBe(false);
    expect(['read-failed', 'write-failed']).toContain(result.reason);
    expect(fs.readFileSync(info, 'utf8')).toBe('not a directory');
  });

  it('writes through a linked info directory (junction or symlink) and keeps the link', () => {
    // Needs no privilege on Windows (a junction), so unlike the file-symlink case
    // below it runs on every machine this suite runs on. Only a file named
    // `exclude` is ever touched inside a linked directory, which is why this is
    // allowed while a linked FILE is not.
    const repo = makeRepo();
    const info = path.join(repo, '.git', 'info');
    const central = tmp('central-info');
    fs.writeFileSync(path.join(central, 'exclude'), '# shared info dir\n');
    fs.rmSync(info, { recursive: true, force: true });
    fs.symlinkSync(central, info, 'junction');

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    expect(fs.lstatSync(info).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(central, 'exclude'), 'utf8')).toContain(BLOCK_BEGIN);
    expect(fs.readFileSync(path.join(central, 'exclude'), 'utf8').startsWith('# shared info dir\n')).toBe(true);
  });

  it('refuses to write through a symlinked info/exclude and leaves the link and its target alone', (ctx) => {
    // The link is project input: following it writes wherever it points. A real
    // link needs a privilege Windows grants only with Developer Mode or
    // elevation, so this case is reported as skipped there, with the reason; the
    // spy-based case below drives the same branch on every platform.
    const repo = makeRepo();
    const central = path.join(tmp('central'), 'some-other-file');
    const file = exclusePath(path.join(repo, '.git'));
    fs.writeFileSync(central, '# not ours to touch\n');
    fs.rmSync(file, { force: true });
    try {
      fs.symlinkSync(central, file, 'file');
    } catch (err) {
      ctx.skip(`symlink not permitted here (${err.code})`);
      return;
    }

    const result = ensureRuntimeExclude({ cwd: repo, env: ENV });

    expect(result).toMatchObject({ ok: false, reason: 'symlinked-exclude' });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(central, 'utf8')).toBe('# not ours to touch\n');
  });

  it('refuses a link-reporting exclude on every platform (spy on lstat) and writes nothing', () => {
    const repo = makeRepo();
    const file = exclusePath(path.join(repo, '.git'));
    const before = fs.readFileSync(file, 'utf8');
    const listing = fs.readdirSync(path.dirname(file)).sort();
    const realLstat = fs.lstatSync.bind(fs);
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((p, ...rest) => (
      path.resolve(String(p)) === path.resolve(file) ? { isSymbolicLink: () => true } : realLstat(p, ...rest)
    ));
    let result;
    try {
      result = ensureRuntimeExclude({ cwd: repo, env: ENV });
    } finally {
      spy.mockRestore();
    }

    expect(result).toMatchObject({ ok: false, reason: 'symlinked-exclude', file });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(listing);
  });
});

describe('ensureRuntimeExclude outside a repository', () => {
  it('is a no-op: reports not-a-repo and creates nothing', () => {
    const dir = tmp('plain');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi');
    const before = fs.readdirSync(dir).sort();
    const execGit = vi.fn(() => { throw new Error('git must not be spawned for a non-repo'); });

    const result = ensureRuntimeExclude({ cwd: dir, env: ENV, execGit });

    expect(result).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(execGit).not.toHaveBeenCalled();
  });

  it('is a no-op for a missing, empty or non-string cwd', () => {
    for (const cwd of [undefined, '', null, 42]) {
      expect(ensureRuntimeExclude({ cwd, env: ENV })).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    }
  });

  it('never creates a git directory for a worktree whose main repository is gone', () => {
    const orphan = tmp('orphan');
    const gone = path.join(tmp('gone-parent'), 'deleted-main');
    fs.writeFileSync(path.join(orphan, '.git'), `gitdir: ${path.join(gone, '.git', 'worktrees', 'w')}\n`);

    const result = ensureRuntimeExclude({ cwd: orphan, env: ENV });

    expect(result).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('treats a bare `.git` directory without HEAD as not a repository', () => {
    const dir = tmp('fake');
    fs.mkdirSync(path.join(dir, '.git'));
    expect(ensureRuntimeExclude({ cwd: dir, env: ENV })).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    expect(fs.existsSync(path.join(dir, '.git', 'info'))).toBe(false);
  });
});

describe('the git subprocess', () => {
  it('is not spawned on the normal path', () => {
    const repo = makeRepo();
    const execGit = vi.fn(() => { throw new Error('must not run'); });
    expect(ensureRuntimeExclude({ cwd: repo, env: ENV, execGit })).toMatchObject({ ok: true, action: 'inserted' });
    expect(execGit).not.toHaveBeenCalled();
  });

  it.each(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'])(
    'is asked when %s redirects git\'s discovery, and its answer is validated',
    (variable) => {
      const execGit = vi.fn(() => `${path.join(tmp('nowhere'), 'no-such-git-dir')}\n`);
      const result = ensureRuntimeExclude({ cwd: tmp('cwd'), env: { ...ENV, [variable]: 'x' }, execGit });
      expect(execGit).toHaveBeenCalledTimes(1);
      expect(execGit.mock.calls[0][0]).toEqual(['rev-parse', '--git-common-dir']);
      expect(result).toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    },
  );

  it('finds the repository through a real GIT_DIR / GIT_WORK_TREE redirect (real git, a generous budget)', () => {
    const repo = makeRepo();
    const elsewhere = tmp('elsewhere'); // no repository above it
    // The same arguments the production runner passes, with a budget a machine
    // running several suites at once cannot exceed. The production runner's own
    // 2 s budget is exercised by the next case.
    const realGit = (args, options) => execFileSync('git', args, {
      ...options, encoding: 'utf8', timeout: 120000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });

    const result = ensureRuntimeExclude({
      cwd: elsewhere,
      env: { ...ENV, GIT_DIR: path.join(repo, '.git'), GIT_WORK_TREE: repo },
      execGit: realGit,
    });

    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    expect(canonical(result.file)).toBe(canonical(exclusePath(path.join(repo, '.git'))));
  });

  it('finds the repository through the PRODUCTION git runner (2 s budget)', (ctx) => {
    const repo = makeRepo();
    const elsewhere = tmp('elsewhere');
    const started = Date.now();

    const result = ensureRuntimeExclude({
      cwd: elsewhere,
      env: { ...ENV, GIT_DIR: path.join(repo, '.git'), GIT_WORK_TREE: repo },
    });

    // The runner gives up after 2 s and the walk degrades to a safe no-op. On a
    // machine busy enough that git itself needs that long, that is the designed
    // outcome, not a defect — report it as skipped, with the reason, rather than red.
    if (result.action === 'skipped' && Date.now() - started >= 1900) {
      ctx.skip('git needed the whole 2 s budget on this loaded machine; the generous-budget case above holds the behaviour');
      return;
    }
    expect(result).toMatchObject({ ok: true, action: 'inserted' });
    expect(canonical(result.file)).toBe(canonical(exclusePath(path.join(repo, '.git'))));
  });

  it('degrades to a no-op when git fails or prints nothing', () => {
    const env = { ...ENV, GIT_DIR: 'x' };
    expect(ensureRuntimeExclude({ cwd: tmp('a'), env, execGit: () => { throw new Error('boom'); } }))
      .toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
    expect(ensureRuntimeExclude({ cwd: tmp('b'), env, execGit: () => '\n' }))
      .toEqual({ ok: true, action: 'skipped', reason: 'not-a-repo' });
  });
});

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------
describe('opt-out is respected', () => {
  /** Run the bootstrap with the digest disabled so only the exclude job is in play. */
  function bootstrap(repo, { env = ENV, config }) {
    return runProjectBootstrap({
      payload: { cwd: repo }, env, homeDir: tmp('home'), pluginRoot: tmp('root'), config,
    });
  }

  it('projectBootstrap.gitExclude=false writes nothing', () => {
    const repo = makeRepo();
    const file = exclusePath(path.join(repo, '.git'));
    const before = fs.readFileSync(file, 'utf8');

    const result = bootstrap(repo, { config: { projectBootstrap: { gitExclude: false } } });

    expect(result.exclude).toBeNull();
    expect(result.policy.gitExclude).toMatchObject({ enabled: false, source: 'config' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('env ARTIBOT_PROJECT_BOOTSTRAP=off writes nothing, whatever the config says', () => {
    const repo = makeRepo();
    const file = exclusePath(path.join(repo, '.git'));
    const before = fs.readFileSync(file, 'utf8');

    const result = bootstrap(repo, {
      env: { ...ENV, ARTIBOT_PROJECT_BOOTSTRAP: 'off' },
      config: { projectBootstrap: { gitExclude: true } },
    });

    expect(result.exclude).toBeNull();
    expect(result.policy.gitExclude).toMatchObject({ enabled: false, source: 'env' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('is ON by default — no key, no env — and the block lands', () => {
    const repo = makeRepo();
    const result = bootstrap(repo, { config: {} });
    expect(result.policy.gitExclude).toMatchObject({ enabled: true, source: 'default' });
    expect(result.exclude).toMatchObject({ ok: true, action: 'inserted' });
  });

  it('turning it off later does not remove a block already written (it only stops writing)', () => {
    const repo = makeRepo();
    bootstrap(repo, { config: {} });
    const file = exclusePath(path.join(repo, '.git'));
    const written = fs.readFileSync(file, 'utf8');

    bootstrap(repo, { config: { projectBootstrap: { gitExclude: false } } });

    expect(fs.readFileSync(file, 'utf8')).toBe(written);
  });
});
