/**
 * scripts/hooks/project-bootstrap.js — the SessionStart hook that (1) keeps the
 * `.artibot/` runtime files out of a user's commits and (2) gives a project that
 * has no installed rules a digest of them.
 *
 * The hook is run as a REAL child process, the way the dispatcher runs it: payload
 * on stdin, JSON on stdout, exit code 0 on every path. Everything it decides
 * lives in `lib/project-state/project-bootstrap.js`, whose policy table is pinned
 * in-process at the bottom.
 *
 * ISOLATION. The child gets a throwaway `cwd` (no repository above it), a
 * throwaway HOME/USERPROFILE (the seam `getHomeDir()` reads), and an environment
 * scrubbed of GIT_* , ARTIBOT_PROJECT_BOOTSTRAP and any inherited
 * CLAUDE_PLUGIN_ROOT — that last one would otherwise point the hook at the
 * developer's installed plugin cache. Every repository the hook may write into is
 * a temp repository this file made.
 *
 * WHAT THIS FILE DOES NOT SEE: the dispatcher fan-out (its own suite), the host's
 * handling of `additionalContext`, and a real Claude Code session.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PROJECT_BOOTSTRAP_ENV,
  resolveProjectBootstrapPolicy,
} from '../../lib/project-state/project-bootstrap.js';
import { BLOCK_BEGIN, BLOCK_END } from '../../lib/project-state/runtime-exclude.js';
import { DIGEST_MAX_BYTES } from '../../lib/project-state/rules-digest.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'project-bootstrap.js');

/** Environment the child may inherit: no GIT_*, no bootstrap switch, no plugin root. */
const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && key !== PROJECT_BOOTSTRAP_ENV && key !== 'CLAUDE_PLUGIN_ROOT',
  ),
);

/** @type {string} spawn cwd: a directory with no repository above it */
let sandboxCwd;
/** @type {string[]} everything else this file made */
const made = [];

beforeAll(() => {
  sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-bootstrap-cwd-'));
});

afterAll(() => {
  fs.rmSync(sandboxCwd, { recursive: true, force: true });
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `artibot-bootstrap-${tag}-`));
  made.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, env: BASE_ENV, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo() {
  const dir = tmp('repo');
  git(dir, ['init', '-q']);
  return dir;
}

/** A home directory; with `rules` it holds `.claude/rules/artibot/<file>` for each. */
function makeHome(rules = null) {
  const home = tmp('home');
  if (rules !== null) {
    const dir = path.join(home, '.claude', 'rules', 'artibot');
    fs.mkdirSync(dir, { recursive: true });
    for (const file of rules) fs.writeFileSync(path.join(dir, file), '# rule\n');
  }
  return home;
}

/** A fake plugin root: an artibot.config.json and stub rule files. */
function makePluginRoot({ config, rules = [] }) {
  const root = tmp('plugin');
  fs.writeFileSync(path.join(root, 'artibot.config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  for (const name of rules) fs.writeFileSync(path.join(root, 'rules', `${name}.md`), `# ${name}\n`);
  return root;
}

/**
 * Run the hook as a child process.
 *
 * @param {object} params - Inputs.
 * @param {unknown} [params.payload] - Serialised to stdin unless `stdin` is given.
 * @param {string} [params.stdin] - Raw stdin, for malformed-input cases.
 * @param {string} [params.home] - HOME/USERPROFILE for the child.
 * @param {Record<string, string>} [params.env] - Extra environment.
 * @param {string} [params.cwd] - Spawn cwd; defaults to the sandbox.
 * @returns {{status: number|null, stdout: string, stderr: string}} Outcome.
 */
function runHook({ payload, stdin, home = makeHome(), env = {}, cwd }) {
  const child = spawnSync(process.execPath, [HOOK], {
    cwd: cwd ?? sandboxCwd,
    input: stdin ?? JSON.stringify(payload ?? {}),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...BASE_ENV, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, USERPROFILE: home, HOME: home, ...env },
  });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

const excludeFile = (repo) => path.join(repo, '.git', 'info', 'exclude');
const payloadFor = (cwd) => ({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's-1', cwd });

describe('project-bootstrap hook (spawned)', () => {
  it('writes the exclude block and emits the digest for a git project with no installed rules', () => {
    const repo = makeRepo();
    const out = runHook({ payload: payloadFor(repo) });

    expect(out.status).toBe(0);
    expect(fs.readFileSync(excludeFile(repo), 'utf8')).toContain(BLOCK_BEGIN);
    expect(out.stderr).toContain('runtime exclude inserted');

    const parsed = JSON.parse(out.stdout);
    expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const digest = parsed.hookSpecificOutput.additionalContext;
    expect(digest.startsWith('[artibot:rules]')).toBe(true);
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(digest).toContain(path.join(PLUGIN_ROOT, 'rules'));
  });

  it('is quiet and byte-stable on the second session start', () => {
    const repo = makeRepo();
    const home = makeHome();
    runHook({ payload: payloadFor(repo), home });
    const first = fs.readFileSync(excludeFile(repo), 'utf8');

    const again = runHook({ payload: payloadFor(repo), home });

    expect(again.status).toBe(0);
    expect(again.stderr).toBe('');
    expect(fs.readFileSync(excludeFile(repo), 'utf8')).toBe(first);
    expect(first.split(BLOCK_BEGIN).length - 1).toBe(1);
    expect(first).toContain(BLOCK_END);
    expect(JSON.parse(again.stdout).hookSpecificOutput.additionalContext).toContain('[artibot:rules]');
  });

  it('emits nothing when the rules are installed in HOME, yet still writes the exclude block', () => {
    const repo = makeRepo();
    const out = runHook({ payload: payloadFor(repo), home: makeHome(['dev-protocol.md']) });

    expect(out.status).toBe(0);
    expect(out.stdout).toBe('');
    expect(fs.readFileSync(excludeFile(repo), 'utf8')).toContain(BLOCK_BEGIN);
  });

  it('honours ARTIBOT_PROJECT_BOOTSTRAP=off: no block, no stdout, exit 0', () => {
    const repo = makeRepo();
    const before = fs.readFileSync(excludeFile(repo), 'utf8');

    const out = runHook({ payload: payloadFor(repo), env: { [PROJECT_BOOTSTRAP_ENV]: 'off' } });

    expect(out.status).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('');
    expect(fs.readFileSync(excludeFile(repo), 'utf8')).toBe(before);
  });

  it('honours projectBootstrap.gitExclude=false in the plugin config, and still emits the digest', () => {
    const repo = makeRepo();
    const before = fs.readFileSync(excludeFile(repo), 'utf8');
    const root = makePluginRoot({
      config: { projectBootstrap: { gitExclude: false } },
      rules: ['dev-protocol', 'quality-gates'],
    });

    const out = runHook({ payload: payloadFor(repo), env: { CLAUDE_PLUGIN_ROOT: root } });

    expect(out.status).toBe(0);
    expect(fs.readFileSync(excludeFile(repo), 'utf8')).toBe(before);
    const digest = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
    expect(digest).toContain(path.join(root, 'rules'));
    expect(digest.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2, l.indexOf(':'))))
      .toEqual(['dev-protocol', 'quality-gates']);
  });

  it('honours projectBootstrap.rulesDigest=false in the plugin config, and still writes the block', () => {
    const repo = makeRepo();
    const root = makePluginRoot({ config: { projectBootstrap: { rulesDigest: false } }, rules: ['dev-protocol'] });

    const out = runHook({ payload: payloadFor(repo), env: { CLAUDE_PLUGIN_ROOT: root } });

    expect(out.status).toBe(0);
    expect(out.stdout).toBe('');
    expect(fs.readFileSync(excludeFile(repo), 'utf8')).toContain(BLOCK_BEGIN);
  });

  it('is ON when the plugin config is missing or unreadable', () => {
    const repo = makeRepo();
    const root = tmp('bare-plugin'); // no artibot.config.json, no rules
    const out = runHook({ payload: payloadFor(repo), env: { CLAUDE_PLUGIN_ROOT: root } });
    expect(out.status).toBe(0);
    expect(fs.readFileSync(excludeFile(repo), 'utf8')).toContain(BLOCK_BEGIN);
  });

  it('outside a git repository: exit 0, the digest still comes, nothing is created', () => {
    const plain = tmp('plain');
    const out = runHook({ payload: payloadFor(plain) });

    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    expect(fs.readdirSync(plain)).toEqual([]);
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain('[artibot:rules]');
  });

  it('uses the process cwd when the payload names none', () => {
    const repo = makeRepo();
    const out = runHook({ payload: { hook_event_name: 'SessionStart' }, cwd: repo });
    expect(out.status).toBe(0);
    expect(fs.readFileSync(excludeFile(repo), 'utf8')).toContain(BLOCK_BEGIN);
  });

  it.each([
    ['empty stdin', ''],
    ['not JSON', 'this is not json'],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['a JSON string', '"cwd"'],
    ['a non-string cwd', JSON.stringify({ cwd: 42 })],
  ])('survives %s: exit 0, no crash output', (_label, stdin) => {
    const out = runHook({ stdin, home: makeHome(['x.md']) });
    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe('');
  });

  it('exits 0 and only reports on stderr when the exclude cannot be written', () => {
    const repo = makeRepo();
    const file = excludeFile(repo);
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file); // a directory where the file belongs

    const out = runHook({ payload: payloadFor(repo), home: makeHome(['x.md']) });

    expect(out.status).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('runtime exclude not written (read-failed)');
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it('stays QUIET on a read-only exclude: exit 0, empty stderr, nothing written — a lock is a choice, not an error', () => {
    const repo = makeRepo();
    const file = excludeFile(repo);
    const before = fs.readFileSync(file);
    fs.chmodSync(file, 0o444);
    let out;
    try {
      out = runHook({ payload: payloadFor(repo), home: makeHome(['x.md']) });
    } finally {
      fs.chmodSync(file, 0o666);
    }

    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe('');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('reports a UTF-16 exclude with the remedy and leaves it byte for byte', () => {
    const repo = makeRepo();
    const file = excludeFile(repo);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('node_modules/\r\n', 'utf16le')]);
    fs.writeFileSync(file, utf16);

    const out = runHook({ payload: payloadFor(repo), home: makeHome(['x.md']) });

    expect(out.status).toBe(0);
    expect(out.stderr).toContain('runtime exclude not written (utf16-exclude)');
    expect(out.stderr).toContain('re-save it as UTF-8');
    expect(fs.readFileSync(file).equals(utf16)).toBe(true);
  });

  it('keeps a cp949-edited exclude intact through a real hook run', () => {
    const repo = makeRepo();
    const file = excludeFile(repo);
    const cp949 = Buffer.concat([Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]), Buffer.from('/\n')]);
    fs.writeFileSync(file, cp949);

    const out = runHook({ payload: payloadFor(repo), home: makeHome(['x.md']) });

    expect(out.status).toBe(0);
    const after = fs.readFileSync(file);
    expect(after.subarray(0, cp949.length).equals(cp949)).toBe(true);
    expect(after.includes(Buffer.from(BLOCK_BEGIN))).toBe(true);
  });
});

describe('the module is import-safe', () => {
  it('exports main and runs nothing on import', async () => {
    const mod = await import('../../scripts/hooks/project-bootstrap.js');
    expect(typeof mod.main).toBe('function');
  });
});

describe('resolveProjectBootstrapPolicy', () => {
  const ON = { enabled: true, source: 'default', reason: 'default' };

  it('is ON for both jobs by default', () => {
    expect(resolveProjectBootstrapPolicy({ env: {}, config: {} })).toEqual({ gitExclude: ON, rulesDigest: ON });
    expect(resolveProjectBootstrapPolicy({ env: {} })).toEqual({ gitExclude: ON, rulesDigest: ON });
  });

  it('turns one job off per config key, leaving the other on', () => {
    const p = resolveProjectBootstrapPolicy({ env: {}, config: { projectBootstrap: { gitExclude: false } } });
    expect(p.gitExclude).toEqual({
      enabled: false, source: 'config', reason: 'artibot.config.json projectBootstrap.gitExclude=false',
    });
    expect(p.rulesDigest).toEqual(ON);

    const q = resolveProjectBootstrapPolicy({ env: {}, config: { projectBootstrap: { rulesDigest: false } } });
    expect(q.rulesDigest.enabled).toBe(false);
    expect(q.gitExclude).toEqual(ON);
  });

  it.each(['0', 'false', 'off', 'no', ' OFF ', 'No'])('env %j turns both jobs off, beating config', (raw) => {
    const p = resolveProjectBootstrapPolicy({
      env: { [PROJECT_BOOTSTRAP_ENV]: raw }, config: { projectBootstrap: { gitExclude: true, rulesDigest: true } },
    });
    expect(p.gitExclude).toEqual({ enabled: false, source: 'env', reason: `${PROJECT_BOOTSTRAP_ENV}=${raw}` });
    expect(p.rulesDigest.enabled).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', 'ON'])('env %j turns both jobs on, beating a config that says false', (raw) => {
    const p = resolveProjectBootstrapPolicy({
      env: { [PROJECT_BOOTSTRAP_ENV]: raw }, config: { projectBootstrap: { gitExclude: false, rulesDigest: false } },
    });
    expect(p.gitExclude).toMatchObject({ enabled: true, source: 'env' });
    expect(p.rulesDigest).toMatchObject({ enabled: true, source: 'env' });
  });

  it.each(['', '  ', 'disabled', 'maybe', 'nope', '2'])('an unrecognised env value %j falls through to config', (raw) => {
    const off = resolveProjectBootstrapPolicy({
      env: { [PROJECT_BOOTSTRAP_ENV]: raw }, config: { projectBootstrap: { gitExclude: false } },
    });
    expect(off.gitExclude).toMatchObject({ enabled: false, source: 'config' });
    // The allowlist direction: a typo never reads as an opt-out.
    expect(resolveProjectBootstrapPolicy({ env: { [PROJECT_BOOTSTRAP_ENV]: raw }, config: {} }).gitExclude).toEqual(ON);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 42],
    ['an array', []],
    ['projectBootstrap null', { projectBootstrap: null }],
    ['projectBootstrap a string', { projectBootstrap: 'off' }],
    ['projectBootstrap an array', { projectBootstrap: [false] }],
    ['the string "false"', { projectBootstrap: { gitExclude: 'false' } }],
    ['the number 0', { projectBootstrap: { gitExclude: 0 } }],
    ['null values', { projectBootstrap: { gitExclude: null, rulesDigest: null } }],
  ])('stays ON for a malformed config: %s — only a literal false opts out', (_label, config) => {
    expect(resolveProjectBootstrapPolicy({ env: {}, config })).toEqual({ gitExclude: ON, rulesDigest: ON });
  });
});

describe('shipped configuration and documentation', () => {
  const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');

  it('ships both jobs ON, with nothing else under projectBootstrap but a comment', () => {
    expect(config.projectBootstrap.gitExclude).toBe(true);
    expect(config.projectBootstrap.rulesDigest).toBe(true);
    expect(Object.keys(config.projectBootstrap).sort()).toEqual(['comment', 'gitExclude', 'rulesDigest']);
    expect(typeof config.projectBootstrap.comment).toBe('string');
  });

  it('resolves to ON from the shipped config with a clean environment', () => {
    const p = resolveProjectBootstrapPolicy({ env: {}, config });
    expect(p.gitExclude).toMatchObject({ enabled: true, source: 'default' });
    expect(p.rulesDigest).toMatchObject({ enabled: true, source: 'default' });
  });

  it('documents both keys and the env switch where the other config keys are documented', () => {
    expect(readme).toContain('`projectBootstrap.gitExclude`');
    expect(readme).toContain('`projectBootstrap.rulesDigest`');
    expect(readme).toContain(PROJECT_BOOTSTRAP_ENV);
  });
});
