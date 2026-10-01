/**
 * Which project a stored autopilot session belongs to (O2, owner decision D2).
 *
 * Until D2 the store sat inside the plugin root — already shared by every project
 * on the machine, but only within one plugin version. It is now ONE store per
 * user, across projects and across versions, so "the most recent session" and
 * "every session" stop meaning "this project's". Two consumers ask that question
 * without naming a session: `engine.getStatus()` with no id, and the
 * `/autopilot list` command (`engine.listSessions()` in commands/autopilot.md).
 * A third WRITES on the strength of the answer: `bash-risk-guard.js#findActiveSession`
 * records a danger event into "the active session", which can pause a run.
 *
 * WHAT A SESSION KNOWS ABOUT ITS PROJECT — measured 2026-09-30 on the four real
 * sessions in the owner's plugin cache: all four carry `lockScope`
 * (`{ repoIdentity, cwd }`, pinned at start by `engine.js#resolveLockScope`), none
 * carries `options.projectRoot`, and none has a top-level `cwd`. `prdPath` is NOT
 * a project key: all four point into the plugin's own tree
 * (`.../marketplaces/artibot/docs/PRD/...`), because `generatePRD` defaults its
 * root to `<pluginRoot>/../..` when the caller omits `projectRoot`.
 *
 * The three answers and what each is for:
 *   match     the session's repo identity equals the asker's, or the asker is
 *             working inside (never above) the directory the session recorded
 *   foreign   it recorded a project and that project is provably someone else's
 *   unscoped  it recorded none (pre-scoping sessions, non-git directories) — so
 *             it cannot be proven foreign and stays visible rather than vanish
 *
 * WHAT THIS FILE CANNOT SEE (rules §9):
 *   - Real sessions. Fixtures are a few fields; the live ones carry dozens.
 *   - A project that moved or was re-cloned: its old sessions read as foreign
 *     unless the remote (and so the identity) is unchanged.
 *   - Whether the model actually calls the project-scoped API. commands/*.md is
 *     not part of this change; `engine.listSessions()` is scoped by default so
 *     the unmodified command is covered, but a doc that called the raw store
 *     would not be.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as project from '../../lib/autopilot/session-project.js';
import * as barrel from '../../lib/autopilot/index.js';
import { getStatus } from '../../lib/autopilot/engine.js';
import { deleteSessionArtifacts, saveSession } from '../../lib/autopilot/session-store.js';
import { getRepoIdentity } from '../../lib/git/repo-identity.js';
import { findActiveSession } from '../../scripts/hooks/bash-risk-guard.js';

/** Build a session state that recorded a project the way `startAutopilot` does. */
function scoped(sessionId, repoIdentity, cwd, extra = {}) {
  return { sessionId, phase: 'EXECUTE', lockScope: { repoIdentity, cwd }, ...extra };
}

describe('classifySessionProject (pure — no git, no disk)', () => {
  let tmp;
  let appA;
  let appB;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-sproj-'));
    appA = path.join(tmp, 'app');
    appB = path.join(tmp, 'app2'); // shares a string prefix with appA on purpose
    mkdirSync(path.join(appA, 'packages', 'x'), { recursive: true });
    mkdirSync(appB, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('calls a session foreign when both its repo identity and its directory belong to another project', () => {
    const state = scoped('s', 'owner/a', appA);
    expect(project.classifySessionProject(state, { cwd: appB, repoIdentity: 'owner/b' })).toBe('foreign');
  });

  it('matches on repo identity even from a different directory (a linked worktree)', () => {
    const state = scoped('s', 'owner/a', appA);
    const worktree = path.join(tmp, 'somewhere', 'else');
    expect(project.classifySessionProject(state, { cwd: worktree, repoIdentity: 'owner/a' })).toBe('match');
  });

  it('matches from the recorded directory itself and from inside it', () => {
    const state = scoped('s', null, appA);
    expect(project.classifySessionProject(state, { cwd: appA, repoIdentity: null })).toBe('match');
    expect(project.classifySessionProject(state, { cwd: path.join(appA, 'packages', 'x'), repoIdentity: null }))
      .toBe('match');
  });

  it('does NOT match when the asker stands ABOVE the recorded directory', () => {
    // An ancestor would match every child project's session, and the decision
    // drives WRITES (the danger recorder pauses the run it picks). Reaching a
    // session from a parent directory takes the same repo identity, or standing
    // inside the project — never merely containing it.
    const state = scoped('s', null, path.join(appA, 'packages', 'x'));
    expect(project.classifySessionProject(state, { cwd: appA, repoIdentity: null })).toBe('foreign');
  });

  it('gives a common parent (the home directory, say) no project at all', () => {
    const inA = scoped('a', null, appA);
    const inB = scoped('b', null, appB);
    const query = { cwd: tmp, repoIdentity: null };
    expect(project.classifySessionProject(inA, query)).toBe('foreign');
    expect(project.classifySessionProject(inB, query)).toBe('foreign');
  });

  it('still matches a session recorded from a SUBDIRECTORY when the identity agrees', () => {
    // The price of the one-way rule is paid only for projects with no identity.
    const state = scoped('s', 'owner/a', path.join(appA, 'packages', 'x'));
    expect(project.classifySessionProject(state, { cwd: appA, repoIdentity: 'owner/a' })).toBe('match');
  });

  it('does not treat a shared string prefix as containment (app vs app2)', () => {
    const state = scoped('s', null, appA);
    expect(project.classifySessionProject(state, { cwd: appB, repoIdentity: null })).toBe('foreign');
  });

  it('reads options.projectRoot when the session has no lockScope', () => {
    const state = { sessionId: 's', options: { projectRoot: appA } };
    expect(project.classifySessionProject(state, { cwd: appA, repoIdentity: null })).toBe('match');
    expect(project.classifySessionProject(state, { cwd: appB, repoIdentity: null })).toBe('foreign');
  });

  it('calls a session with no recorded project unscoped, never foreign', () => {
    const q = { cwd: appB, repoIdentity: 'owner/b' };
    expect(project.classifySessionProject({ sessionId: 's' }, q)).toBe('unscoped');
    expect(project.classifySessionProject({ sessionId: 's', lockScope: null }, q)).toBe('unscoped');
    expect(project.classifySessionProject({ sessionId: 's', options: {} }, q)).toBe('unscoped');
    expect(project.classifySessionProject(null, q)).toBe('unscoped');
    expect(project.classifySessionProject('not a state', q)).toBe('unscoped');
  });

  it('does not let a different identity veto a matching directory (the remote was added later)', () => {
    const state = scoped('s', 'root-abc123', appA);
    expect(project.classifySessionProject(state, { cwd: appA, repoIdentity: 'owner/a' })).toBe('match');
  });

  it.runIf(process.platform === 'win32')('compares directories case-insensitively on Windows', () => {
    const state = scoped('s', null, appA.toUpperCase());
    expect(project.classifySessionProject(state, { cwd: appA.toLowerCase(), repoIdentity: null })).toBe('match');
  });
});

describe('listSessionsForProject / classifyStoredSessions (injected store)', () => {
  const states = {
    'ap-a-old': scoped('ap-a-old', 'owner/a', '/x/a', { createdAt: '2026-09-01T00:00:00Z' }),
    'ap-b-new': scoped('ap-b-new', 'owner/b', '/x/b', { createdAt: '2026-09-29T00:00:00Z' }),
    'ap-legacy': { sessionId: 'ap-legacy', phase: 'PAUSED' },
    'ap-corrupt': null,
  };
  const deps = {
    listSessions: () => Object.keys(states),
    loadSession: (id) => states[id],
    getRepoIdentity: () => 'owner/a',
  };

  it('keeps this project and the unscoped, hides the foreign, and preserves store order', () => {
    expect(project.listSessionsForProject('/x/a', deps)).toEqual(['ap-a-old', 'ap-legacy', 'ap-corrupt']);
  });

  it('labels instead of hiding when asked to (foreign included)', () => {
    expect(project.classifyStoredSessions('/x/a', deps)).toEqual([
      { id: 'ap-a-old', project: 'match' },
      { id: 'ap-b-new', project: 'foreign' },
      { id: 'ap-legacy', project: 'unscoped' },
      { id: 'ap-corrupt', project: 'unscoped' },
    ]);
  });

  it('resolves the asker identity ONCE, not once per session', () => {
    const many = {
      'ap-f1': scoped('ap-f1', 'owner/b', '/x/b'),
      'ap-f2': scoped('ap-f2', 'owner/c', '/x/c'),
      'ap-f3': scoped('ap-f3', 'owner/d', '/x/d'),
    };
    let calls = 0;
    const listed = project.listSessionsForProject('/x/a', {
      listSessions: () => Object.keys(many),
      loadSession: (id) => many[id],
      getRepoIdentity: () => { calls += 1; return 'owner/a'; },
    });
    expect(listed).toEqual([]);
    expect(calls).toBe(1);
  });

  it('looks the identity up at all only when a directory fails to decide (a git spawn costs 160-370 ms)', () => {
    let calls = 0;
    const cheap = {
      'ap-here': scoped('ap-here', 'owner/a', '/x/a'),
      'ap-loose': { sessionId: 'ap-loose' },
    };
    const listed = project.listSessionsForProject('/x/a', {
      listSessions: () => Object.keys(cheap),
      loadSession: (id) => cheap[id],
      getRepoIdentity: () => { calls += 1; return 'owner/a'; },
    });
    expect(listed).toEqual(['ap-here', 'ap-loose']);
    expect(calls).toBe(0);
    // ...and an empty store asks nothing at all.
    project.listSessionsForProject('/x/a', {
      listSessions: () => [],
      loadSession: () => null,
      getRepoIdentity: () => { calls += 1; return 'owner/a'; },
    });
    expect(calls).toBe(0);
  });

  it('survives a store that throws', () => {
    expect(project.listSessionsForProject('/x/a', { ...deps, listSessions: () => { throw new Error('boom'); } }))
      .toEqual([]);
  });

  it('sessionFilterFor builds the predicate the danger recorder uses', () => {
    const mine = project.sessionFilterFor('/x/a', { getRepoIdentity: () => 'owner/a' });
    expect(mine(states['ap-a-old'])).toBe(true);
    expect(mine(states['ap-b-new'])).toBe(false);
    expect(mine(states['ap-legacy'])).toBe(true);
  });
});

describe('the real store and real repositories', () => {
  const ids = [];
  let sandbox;
  let repoA;
  let repoAWorktree;
  let repoB;

  function git(args, cwd) {
    return execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  }

  function initRepo(dir, remote) {
    mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'main', '.'], dir);
    git(['config', 'user.email', 'test@example.invalid'], dir);
    git(['config', 'user.name', 'test'], dir);
    git(['remote', 'add', 'origin', remote], dir);
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n', 'utf-8');
    git(['add', 'seed.txt'], dir);
    git(['commit', '-qm', 'init'], dir);
  }

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'artibot-sproj-git-'));
    repoA = path.join(sandbox, 'repo-a');
    initRepo(repoA, 'https://github.com/Example/Project-A.git');
    repoAWorktree = path.join(sandbox, 'repo-a-limb');
    git(['worktree', 'add', '-q', repoAWorktree, '-b', 'worktree-limb'], repoA);
    repoB = path.join(sandbox, 'repo-b');
    initRepo(repoB, 'git@github.com:Other/Project-B.git');
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  afterEach(() => {
    while (ids.length) {
      try { deleteSessionArtifacts(ids.pop()); } catch { /* best effort */ }
    }
  });

  function put(state) {
    ids.push(state.sessionId);
    saveSession(state);
    return state.sessionId;
  }

  it('project B does not see project A as its own, and a worktree of A still does', () => {
    const idA = getRepoIdentity(repoA);
    const idB = getRepoIdentity(repoB);
    expect(idA).toBe('example/project-a');
    const a = put(scoped(`ap-proj-a-${process.pid}`, idA, repoA));
    const b = put(scoped(`ap-proj-b-${process.pid}`, idB, repoB));
    const loose = put({ sessionId: `ap-proj-loose-${process.pid}`, phase: 'PAUSED' });

    const fromB = project.listSessionsForProject(repoB);
    expect(fromB).toContain(b);
    expect(fromB).toContain(loose);
    expect(fromB).not.toContain(a);

    const fromAWorktree = project.listSessionsForProject(repoAWorktree);
    expect(fromAWorktree).toContain(a);
    expect(fromAWorktree).not.toContain(b);
  });
});

describe('engine.getStatus() without an id', () => {
  const ids = [];

  afterEach(() => {
    while (ids.length) {
      try { deleteSessionArtifacts(ids.pop()); } catch { /* best effort */ }
    }
  });

  function put(state) {
    ids.push(state.sessionId);
    saveSession(state);
    return state.sessionId;
  }

  const here = () => ({ repoIdentity: getRepoIdentity(process.cwd()), cwd: process.cwd() });
  const elsewhere = () => ({ repoIdentity: 'some-other/project', cwd: path.join(os.tmpdir(), 'not-this-project') });

  it("returns this project's most recent session, not a newer session of another project", async () => {
    const mine = put({
      sessionId: `ap-status-mine-${process.pid}`, phase: 'EXECUTE', createdAt: '2026-09-01T00:00:00.000Z', lockScope: here(),
    });
    put({
      sessionId: `ap-status-other-${process.pid}`, phase: 'EXECUTE', createdAt: '2026-09-30T00:00:00.000Z', lockScope: elsewhere(),
    });

    const status = await getStatus();

    expect(status?.sessionId).toBe(mine);
  });

  it('answers null rather than another project\'s session when this project has none', async () => {
    put({
      sessionId: `ap-status-only-other-${process.pid}`, phase: 'EXECUTE', createdAt: '2026-09-30T00:00:00.000Z', lockScope: elsewhere(),
    });

    const status = await getStatus();

    // The store may also hold unscoped sessions from other tests in this worker;
    // what must never come back is the foreign one.
    expect(status?.sessionId).not.toBe(`ap-status-only-other-${process.pid}`);
  });

  it('still returns ANY session when it is asked for by id (naming one is an explicit act)', async () => {
    const other = put({
      sessionId: `ap-status-named-${process.pid}`, phase: 'EXECUTE', createdAt: '2026-09-30T00:00:00.000Z', lockScope: elsewhere(),
    });

    expect((await getStatus(other))?.sessionId).toBe(other);
  });
});

describe('the autopilot barrel (what commands/autopilot.md calls as `engine.*`)', () => {
  const ids = [];

  afterEach(() => {
    while (ids.length) {
      try { deleteSessionArtifacts(ids.pop()); } catch { /* best effort */ }
    }
  });

  function put(state) {
    ids.push(state.sessionId);
    saveSession(state);
    return state.sessionId;
  }

  it('lists the current project by default and keeps the raw listing one name away', () => {
    const mine = put(scoped(`ap-barrel-mine-${process.pid}`, getRepoIdentity(process.cwd()), process.cwd()));
    const other = put(scoped(`ap-barrel-other-${process.pid}`, 'some-other/project', path.join(os.tmpdir(), 'not-this-project')));

    const scopedList = barrel.listSessions();
    expect(scopedList).toContain(mine);
    expect(scopedList).not.toContain(other);

    const all = barrel.listAllSessions();
    expect(all).toContain(mine);
    expect(all).toContain(other);
  });

  it('exposes the classification helpers for a caller that wants labels', () => {
    expect(typeof barrel.classifyStoredSessions).toBe('function');
    expect(typeof barrel.classifySessionProject).toBe('function');
  });
});

describe('bash-risk-guard findActiveSession — the one consumer that WRITES on the answer', () => {
  const store = (sessions) => ({
    listSessions: () => Object.keys(sessions),
    loadSession: (id) => sessions[id] ?? null,
    getSessionPath: (id) => `/store/${id}.json`,
  });
  const fs = (mtimes) => ({ statSync: (p) => ({ mtimeMs: mtimes[path.basename(p, '.json')] ?? 0 }) });

  const sessions = {
    'ap-mine-old': scoped('ap-mine-old', 'owner/a', '/x/a'),
    'ap-other-new': scoped('ap-other-new', 'owner/b', '/x/b'),
  };
  const mtimes = { 'ap-mine-old': 1000, 'ap-other-new': 9000 };

  it('without a project filter it keeps the old behaviour: the newest active session anywhere', () => {
    expect(findActiveSession(store(sessions), fs(mtimes))).toBe(sessions['ap-other-new']);
  });

  it("with a project filter it picks this project's session even though another project's is newer", () => {
    const mine = project.sessionFilterFor('/x/a', { getRepoIdentity: () => 'owner/a' });
    expect(findActiveSession(store(sessions), fs(mtimes), mine)).toBe(sessions['ap-mine-old']);
  });

  it('records nothing rather than reaching into another project when this one has no active session', () => {
    const onlyOther = { 'ap-other-new': sessions['ap-other-new'] };
    const mine = project.sessionFilterFor('/x/a', { getRepoIdentity: () => 'owner/a' });
    expect(findActiveSession(store(onlyOther), fs(mtimes), mine)).toBeNull();
  });
});
