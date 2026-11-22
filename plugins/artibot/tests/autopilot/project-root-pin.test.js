/**
 * `options.projectRoot` validation at start and back-fill on resume/abort
 * (Phase 3 cross-check follow-up F3, 2026-11-21).
 *
 * START: `project-root-pin.js#pinProjectRoot` (then in `engine.js`) used to keep any non-empty caller string
 * verbatim. A relative `.` names wherever the NEXT process happens to stand; an
 * MSYS spelling `/c/Users/…` is "absolute" to win32 `path.isAbsolute` but
 * resolves to `C:\c\Users\…`. Both are now replaced by the project resolved
 * from the process cwd, and a root inside the plugin tree is reported.
 *
 * RESUME/ABORT: a session stored before the pin carries no `projectRoot`, so
 * the generators resolved the project from the RESUMING process's cwd — abort
 * from another repository and the report landed in that repository. The
 * session's own `lockScope.cwd` (pinned at its start) now back-fills it. The
 * fixture copies the shape of the real pre-pin session measured 2026-11-21
 * (`options` without `projectRoot`, `lockScope { repoIdentity, cwd: <repo top> }`,
 * phase CROSS_CHECK, `pausedReason: 'max-duration-exceeded'`) — the real state
 * file is not read or touched by this test.
 *
 * Isolation: the session/lock store is redirected by `tests/setup/state-dir.js`;
 * every project directory is a `mkdtemp` tree; `process.cwd` is spied, not
 * changed.
 *
 * WHAT THIS CANNOT SEE: whether the model passes `options.projectRoot` in the
 * slash command (unmeasured), and sessions whose `lockScope` is null (non-git
 * start) — those still resolve from the resuming cwd, there is no record to
 * back-fill from.
 *
 * @module tests/autopilot/project-root-pin
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { abortAutopilot, resumeAutopilot, startAutopilot } from '../../lib/autopilot/engine.js';
import { deleteSessionArtifacts, loadSession, saveSession } from '../../lib/autopilot/session-store.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';
import { isLocked, releaseLock } from '../../lib/autopilot/lock.js';

/**
 * True when `child` is `parent` or beneath it (case-insensitive on win32), both
 * in canonical spelling — an 8.3 tmpdir (`C:\Users\RUNNER~1\…`, the GitHub
 * Windows runner) must not make a long parent and a short child look disjoint.
 */
function inside(parent, child) {
  const canon = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
  const rel = path.relative(canon(parent), canon(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

let tmpRoot;
let projectDir;
let otherRepo;
let savedPluginRoot;
const cleanups = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'ap-root-pin-'));
  projectDir = path.join(tmpRoot, '내 프로젝트');
  mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  mkdirSync(path.join(projectDir, 'src', 'deep'), { recursive: true });
  otherRepo = path.join(tmpRoot, 'other-repo');
  mkdirSync(path.join(otherRepo, '.git'), { recursive: true });
  savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(projectDir, 'src', 'deep'));
});

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) {
    try { cleanups.pop()(); } catch { /* best-effort */ }
  }
  if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Start with a caller-supplied root. Every value passed is a path under the
 * mkdtemp tree, or a relative/MSYS spelling the engine replaces with the
 * project resolved from the SPIED cwd — which is also under the mkdtemp tree.
 */
async function start(task, root) {
  const r = await startAutopilot({ task, mode: 'plan', options: { keepAwake: false, tui: false, projectRoot: root } });
  cleanups.push(() => {
    const s = loadSession(r.sessionId);
    if (s?.featureKey) releaseLock(s.featureKey, r.sessionId, s.lockScope || {});
    deleteSessionArtifacts(r.sessionId);
  });
  // A pre-fix run kept "." and wrote the PRD relative to the REAL process cwd
  // (the spy does not move fs) — observed once while confirming RED. Never
  // leave that file behind.
  if (typeof r.prdPath === 'string' && !path.isAbsolute(r.prdPath)) {
    cleanups.push(() => rmSync(r.prdPath, { force: true }));
  }
  return r;
}

describe('pinProjectRoot rejects unusable caller values', () => {
  it('replaces a relative "." with the project resolved from the process cwd', async () => {
    const r = await start('pin rejects relative dot', '.');
    const state = loadSession(r.sessionId);
    expect(state.options.projectRoot).toBe(realpathSync.native(projectDir));
    expect(inside(projectDir, r.prdPath)).toBe(true);
    expect(readEvents(r.sessionId).filter((e) => e.type === 'project-root-replaced')).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')('replaces an MSYS-style /c/... path on win32', async () => {
    const msys = `/${projectDir[0].toLowerCase()}${projectDir.slice(2).replace(/\\/g, '/')}`;
    const r = await start('pin rejects msys spelling', msys);
    expect(loadSession(r.sessionId).options.projectRoot).toBe(realpathSync.native(projectDir));
  });

  it('keeps an absolute caller value verbatim and emits no replacement tick', async () => {
    const explicit = path.join(tmpRoot, 'explicit-root');
    const r = await start('pin keeps absolute value', explicit);
    expect(loadSession(r.sessionId).options.projectRoot).toBe(explicit);
    expect(readEvents(r.sessionId).filter((e) => e.type === 'project-root-replaced')).toHaveLength(0);
    expect(readEvents(r.sessionId).filter((e) => e.type === 'project-root-in-plugin-tree')).toHaveLength(0);
  });

  it('reports (once) a project root inside the plugin tree', async () => {
    const pluginRoot = path.join(tmpRoot, 'home', '.claude', 'plugins', 'cache', 'artibot', 'artibot', '9.9.9');
    mkdirSync(path.join(pluginRoot, 'docs'), { recursive: true });
    // Changing the plugin root drops the paired store override; the store then
    // follows ARTIBOT_STATE_DIR, which tests/setup/state-dir.js also sandboxes.
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    const r = await start('pin warns plugin tree', path.join(pluginRoot, 'docs'));
    const hits = readEvents(r.sessionId).filter((e) => e.type === 'project-root-in-plugin-tree');
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe('warn');
  });
});

/** A session stored before the pin, shaped like the real 2026-11-21 one. */
function preRunSession(sessionId, featureKey) {
  const repoTop = realpathSync.native(projectDir);
  const now = new Date().toISOString();
  saveSession({
    sessionId,
    task: 'pre-pin fixture',
    mode: 'default',
    createdAt: now,
    updatedAt: now,
    options: { maxDuration: '8h', notify: false, team: true, budgetTokens: 2000000, budget: 2000000, fast: false },
    phase: 'CROSS_CHECK',
    lastPhase: 'CROSS_CHECK',
    pendingPhase: null,
    pausedReason: 'max-duration-exceeded',
    activePhaseAttempt: null,
    attemptJournal: [],
    phases: [],
    checkpoints: [],
    errors: [],
    featureKey,
    lockScope: { repoIdentity: 'owner/pre-pin-fixture', cwd: repoTop },
    schemaVersion: 3,
  });
  cleanups.push(() => {
    releaseLock(featureKey, sessionId, { repoIdentity: 'owner/pre-pin-fixture', cwd: repoTop });
    deleteSessionArtifacts(sessionId);
  });
  return repoTop;
}

describe('resume/abort back-fill projectRoot from lockScope.cwd', () => {
  it('abort from another repository writes the report into the session\'s own project', async () => {
    const id = 'ap-20261121-000001-prepin';
    const repoTop = preRunSession(id, 'pre-pin-abort-fixture');
    process.cwd.mockReturnValue(otherRepo);
    const out = await abortAutopilot(id, { graceful: true });
    expect(out.reportPath).toBeTruthy();
    expect(inside(projectDir, out.reportPath)).toBe(true);
    expect(existsSync(path.join(otherRepo, 'reports'))).toBe(false);
    const after = loadSession(id);
    expect(after.options.projectRoot).toBe(repoTop);
  });

  it('resume back-fills without touching the lock scope or the other options', async () => {
    const id = 'ap-20261121-000002-prepin';
    const featureKey = 'pre-pin-resume-fixture';
    const repoTop = preRunSession(id, featureKey);
    process.cwd.mockReturnValue(otherRepo);
    const out = await resumeAutopilot(id);
    expect(out.status).not.toBe('blocked');
    const after = loadSession(id);
    expect(after.options.projectRoot).toBe(repoTop);
    expect(after.lockScope).toEqual({ repoIdentity: 'owner/pre-pin-fixture', cwd: repoTop });
    expect(after.options).toMatchObject({ maxDuration: '8h', notify: false, team: true, budgetTokens: 2000000, budget: 2000000, fast: false });
    // The lock was (re)taken under the session's ORIGINAL scoped key.
    const lock = isLocked(featureKey, after.lockScope);
    expect(lock.locked).toBe(true);
    expect(lock.holder?.sessionId).toBe(id);
  });

  it('leaves a session without a lockScope alone (nothing to back-fill from)', async () => {
    const id = 'ap-20261121-000003-prepin';
    const now = new Date().toISOString();
    saveSession({ sessionId: id, task: 'no scope', mode: 'plan', createdAt: now, updatedAt: now, options: {}, phase: 'CROSS_CHECK', phases: [], lockScope: null });
    cleanups.push(() => deleteSessionArtifacts(id));
    await abortAutopilot(id, { graceful: false });
    expect(loadSession(id).options.projectRoot).toBeUndefined();
  });
});
