/**
 * bash-risk-guard's BLOCK path must not ask git the same question twice.
 *
 * When a `danger` command is blocked inside an allowlisted repository, the hook
 * records the danger into "the active autopilot session" — and since owner
 * decision D2 only into a session of THIS project (`session-project.js`). Telling
 * whose the session is needs the asker's repo identity, and the hook had already
 * asked git for it: `isAutopilotAllowed` runs `git config --get remote.origin.url`
 * to check the allowlist. The first version of the project filter looked the
 * identity up again through `lib/git/repo-identity.js`, which runs the SAME
 * command — a second spawn, measured at about 0.85 s on the block path under load
 * by the reviewer of 6b410964.
 *
 * This file pins the fix from outside the process: it runs the real hook with a
 * preload (`fixtures/count-git-spawns.mjs`) that records every git spawn, and
 * asserts there is exactly one. A unit test of a helper could not show that — the
 * thing being guarded is how many processes the hook starts.
 *
 * The scenarios are chosen so the identity IS needed: the session was started
 * from a different directory of the same repository (a linked worktree), so the
 * directory test alone cannot decide and the filter has to know who is asking.
 *
 * WHAT THIS FILE CANNOT SEE (rules §9):
 *   - Wall time. The count is exact; the seconds it saves depend on the machine.
 *     The before/after timing is in the commit message, not asserted here.
 *   - Any git spawn made by a grandchild (the hook starts none today).
 *   - Whether the real host hands the hook the same `cwd` the tests do.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Each case starts a real hook process; the budget buys headroom for load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'bash-risk-guard.js');
const COUNTER = path.join(PLUGIN_ROOT, 'tests', 'hooks', 'fixtures', 'count-git-spawns.mjs');
const COUNTER_URL = `file://${COUNTER.split(path.sep).join('/')}`;

const BLOCK_STDOUT = '{"decision":"block","reason":"[artibot:bash-risk-guard] Dangerous command blocked: '
  + 'Destructive git push --force (matched: git-force-push). Command: \\"git push --force origin main\\"."}';

let base;
let home;
let repo;
let elsewhere;

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-rbg-id-'));
  home = path.join(base, 'home');
  repo = path.join(base, 'repo-main');
  elsewhere = path.join(base, 'elsewhere');
  mkdirSync(path.join(home, '.claude', 'artibot'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(
    path.join(home, '.claude', 'artibot', 'autopilot-allowlist.json'),
    JSON.stringify({ version: 1, repos: ['Owner/Proj'] }),
    'utf-8',
  );
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['remote', 'add', 'origin', 'https://github.com/Owner/Proj.git'], repo);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * Run the real hook on a blocked `git push --force` in `repo`, with `sessions`
 * sitting in a sandbox store, and report what it did.
 *
 * @param {Record<string, object>} sessions id -> session state
 * @param {string} label unique per call (store and log names)
 * @returns {{ status: number|null, stdout: string, gitCalls: string[][], after: Record<string, string> }}
 */
function runHook(sessions, label) {
  const store = path.join(base, `store-${label}`);
  const log = path.join(base, `git-${label}.log`);
  mkdirSync(store, { recursive: true });
  for (const [id, state] of Object.entries(sessions)) {
    writeFileSync(path.join(store, `${id}.json`), JSON.stringify(state), 'utf-8');
  }
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    ARTIBOT_AUTOPILOT_STORE_DIR: store,
    ARTIBOT_AUTOPILOT_STORE_DIR_ROOT: PLUGIN_ROOT,
    GIT_SPAWN_LOG: log,
  };
  delete env.ARTIBOT_STATE_DIR;
  delete env.ARTIBOT_STATE_DIR_HOME;
  delete env.CLAUDE_PLUGIN_ROOT;
  const payload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'git push --force origin main' },
    cwd: repo,
  });
  const out = spawnSync(process.execPath, ['--import', COUNTER_URL, HOOK], {
    input: payload, env, encoding: 'utf-8',
  });
  const gitCalls = existsSync(log)
    ? readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const after = Object.fromEntries(Object.keys(sessions)
    .map((id) => [id, readFileSync(path.join(store, `${id}.json`), 'utf-8')]));
  return { status: out.status, stdout: out.stdout, gitCalls, after };
}

const scoped = (id, identity, cwd) => ({
  sessionId: id, phase: 'EXECUTE', schemaVersion: 3, lockScope: { repoIdentity: identity, cwd },
});

/** Did the hook write a danger into this session? Its file is no longer what we wrote. */
const wasRecorded = (state, afterText) => afterText !== JSON.stringify(state);

describe('bash-risk-guard block path — one git spawn, not two', () => {
  it('records into a same-repo session started elsewhere WITHOUT a second identity lookup', () => {
    const mine = scoped('ap-mine', 'owner/proj', elsewhere);
    const r = runHook({ 'ap-mine': mine }, 'same-repo');

    expect(r.status).toBe(0);
    expect(r.stdout).toBe(BLOCK_STDOUT);
    // Decided by identity, not by directory (`elsewhere` is not inside `repo`):
    expect(wasRecorded(mine, r.after['ap-mine'])).toBe(true);
    // The allowlist check's remote lookup is the ONLY git process.
    expect(r.gitCalls).toEqual([['config', '--get', 'remote.origin.url']]);
  });

  it('still refuses another project\'s session, on the identity the gate handed over', () => {
    const theirs = scoped('ap-theirs', 'someone/else', elsewhere);
    const r = runHook({ 'ap-theirs': theirs }, 'foreign');

    expect(r.status).toBe(0);
    expect(r.stdout).toBe(BLOCK_STDOUT);
    expect(wasRecorded(theirs, r.after['ap-theirs'])).toBe(false);
    expect(r.gitCalls).toEqual([['config', '--get', 'remote.origin.url']]);
  });

  it('picks this project\'s session even when another project\'s is listed beside it', () => {
    const mine = scoped('ap-a-mine', 'owner/proj', elsewhere);
    const theirs = scoped('ap-b-theirs', 'someone/else', elsewhere);
    const r = runHook({ 'ap-a-mine': mine, 'ap-b-theirs': theirs }, 'both');

    expect(wasRecorded(mine, r.after['ap-a-mine'])).toBe(true);
    expect(wasRecorded(theirs, r.after['ap-b-theirs'])).toBe(false);
    expect(r.gitCalls).toHaveLength(1);
  });

  it('spawns git once even when the directory alone settles the match (the lookup stays lazy)', () => {
    const here = scoped('ap-here', 'owner/proj', repo);
    const r = runHook({ 'ap-here': here }, 'same-dir');

    expect(wasRecorded(here, r.after['ap-here'])).toBe(true);
    expect(r.gitCalls).toHaveLength(1);
  });

  it('spawns git once when no autopilot session exists at all', () => {
    const r = runHook({}, 'none');

    expect(r.status).toBe(0);
    expect(r.stdout).toBe(BLOCK_STDOUT);
    expect(r.gitCalls).toHaveLength(1);
  });
});
