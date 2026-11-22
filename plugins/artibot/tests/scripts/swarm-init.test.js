/**
 * scripts/swarm-init.js#initSwarm — the two writes whose outcome was ignored.
 *
 * `scripts/utils/index.js#atomicWriteSync` stopped throwing in the 2026-11-21 review (M4)
 * and answers false instead. initSwarm ignored both answers (review follow-up,
 * "atomicWriteSync return value ignored" x4):
 *   - the artibot.config.json write: a config that never enabled the git backend still printed
 *     "Config updated" and went on to RECORD OPT-IN CONSENT and say "Swarm ready";
 *   - the swarm-profile.json write: "Profile written ... commit this file" for a file that
 *     does not exist.
 * These cases pin that a false answer rejects (the CLI's catch prints `[swarm-init] <message>`
 * and exits 1 — the signal swarm-autodetect#applyProfile reads), and that a failed config
 * write stops before consent is recorded.
 *
 * ISOLATION (this module writes a TRACKED file and the user's consent): the plugin root is a
 * mkdtemp directory (`getPluginRoot` mocked), the swarm backend and consent store are mocked
 * whole (no clone, no network, no home write), and `execSync` throws if anything reaches it.
 * Importing the module is inert thanks to its isMainEntry guard.
 *
 * HOW A FAILURE IS PRODUCED: `node:fs#renameSync` is wrapped so a rename onto the one path in
 * `state.renameTo` throws a non-transient `EIO` — the technique of
 * tests/core/atomic-write-honest-result.test.js.
 *
 * WHAT THIS DOES NOT SEE: the CLI exit code itself (running the real script would touch the
 * real config, home and network), the scaffold/push branch (the clone already has a README),
 * `--reset`, and the real swarm backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ renameTo: null, pluginRoot: null, cloneDir: null, calls: [] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const renameSync = (from, to) => {
    if (state.renameTo !== null && String(to) === state.renameTo) {
      throw Object.assign(new Error(`EIO: injected rename failure -> ${to}`), { code: 'EIO' });
    }
    return actual.renameSync(from, to);
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const execSync = (cmd) => {
    state.calls.push(`execSync ${cmd}`);
    throw new Error('execSync is not available in this test');
  };
  return { ...actual, execSync, default: { ...actual, execSync } };
});

vi.mock('../../lib/core/platform.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getPluginRoot: () => state.pluginRoot };
});

vi.mock('../../lib/swarm/git-backend.js', () => ({
  ensureSwarmClone: async () => ({ cloneDir: state.cloneDir, freshClone: false }),
  ensureMachineHash: async () => 'test-machine-hash',
  gitHealthCheck: async () => ({ ok: true, message: 'mocked' }),
}));

vi.mock('../../lib/swarm/swarm-config.js', () => ({
  optIn: async () => { state.calls.push('optIn'); return { optedIn: true }; },
  optOut: async () => { state.calls.push('optOut'); return { optedIn: false }; },
}));

const { initSwarm } = await import('../../scripts/swarm-init.js');

const REPO = 'https://example.invalid/owner/swarm.git';
const CONFIG = { other: 1, swarm: { enabled: false } };

let dir;
let out;
let outSpy;
let errSpy;
let configPath;
let profilePath;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-swarm-init-'));
  state.pluginRoot = path.join(dir, 'plugin');
  state.cloneDir = path.join(dir, 'clone');
  state.calls = [];
  mkdirSync(state.pluginRoot);
  mkdirSync(state.cloneDir);
  writeFileSync(path.join(state.cloneDir, 'README.md'), '# existing\n');
  configPath = path.join(state.pluginRoot, 'artibot.config.json');
  profilePath = path.join(state.pluginRoot, '.claude-plugin', 'swarm-profile.json');
  writeFileSync(configPath, JSON.stringify(CONFIG));
  out = [];
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  state.renameTo = null;
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('initSwarm', () => {
  it('enables the git backend, records consent and writes the profile when every write lands', async () => {
    await initSwarm(REPO);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config).toMatchObject({ other: 1, swarm: { enabled: true, backend: 'git', gitRepoUrl: REPO } });
    expect(state.calls).toEqual(['optIn']);
    expect(JSON.parse(readFileSync(profilePath, 'utf8'))).toMatchObject({ repoUrl: REPO, backend: 'git' });
    const text = out.join('');
    expect(text).toContain(`Config updated: ${configPath}`);
    expect(text).toContain(`Profile written: ${profilePath}`);
    expect(text).toContain('Swarm ready.');
  });

  it('rejects before recording consent when the config write does not land', async () => {
    state.renameTo = configPath;

    await expect(initSwarm(REPO)).rejects.toThrow(/artibot\.config\.json/);

    expect(state.calls).not.toContain('optIn');
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(CONFIG);
    expect(existsSync(profilePath)).toBe(false);
    const text = out.join('');
    expect(text).not.toContain('Config updated');
    expect(text).not.toContain('Swarm ready');
  });

  it('rejects without claiming the profile was written when the profile write does not land', async () => {
    state.renameTo = profilePath;

    await expect(initSwarm(REPO)).rejects.toThrow(/swarm-profile\.json/);

    expect(existsSync(profilePath)).toBe(false);
    const text = out.join('');
    expect(text).not.toContain('Profile written');
    expect(text).not.toContain('Swarm ready');
  });

  it('never reaches a shell command on these paths', async () => {
    state.renameTo = configPath;
    await expect(initSwarm(REPO)).rejects.toThrow();
    state.renameTo = null;
    await initSwarm(REPO);

    expect(state.calls.filter((c) => c.startsWith('execSync'))).toEqual([]);
  });
});
