/**
 * M11 (2026-11-21): where an autopilot PRD / report lands when the caller does
 * not name a project root.
 *
 * `generatePRD` and `generateReport` fell back to `<pluginRoot>/../..`. That is
 * the repository root only in a source checkout (`<repo>/plugins/artibot`). In
 * an installed plugin the plugin root is the marketplace mirror or the version
 * cache, so the fallback named a directory inside `~/.claude/plugins/` —
 * measured in the 2026-11-21 session: the PRD of a real run was written to
 * `~/.claude/plugins/cache/artibot/docs/PRD/`. `commands/autopilot.md` Step 2
 * never passed `options.projectRoot`, so every installed run took the fallback.
 *
 * The fix has two halves and this file pins both:
 *   1. `startAutopilot` pins `options.projectRoot` to the user's project
 *      (resolved from the process cwd) when the caller left it empty, so the
 *      session records it and resume/abort write to the same place;
 *   2. the generators' own fallback is the user's project, not the plugin tree,
 *      for callers that bypass the engine and for sessions stored before (1).
 *
 * Isolation: every artifact root here is a `mkdtemp` directory. The "cache"
 * plugin root is a fake directory inside that temp tree, so the pre-fix
 * fallback also lands inside it. The engine case keeps the real plugin root (the
 * store sandbox pairs with it) and removes any PRD that lands outside the
 * temp project, so a pre-fix run cannot leave a file in the repository.
 *
 * WHAT THIS CANNOT SEE: the process cwd is spied, not changed — the result
 * holds for code that reads `process.cwd()`, which is what the engine does. It
 * also does not run the slash command, so whether the model really passes
 * `options.projectRoot` (the documented Step 2 call) stays unmeasured.
 *
 * @module tests/autopilot/artifact-root-default
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generatePRD } from '../../lib/autopilot/prd-generator.js';
import { generateReport } from '../../lib/autopilot/report-generator.js';
import { startAutopilot } from '../../lib/autopilot/engine.js';
import { deleteSessionArtifacts, loadSession, saveSession } from '../../lib/autopilot/session-store.js';

/** True when `child` is `parent` or beneath it. */
function inside(parent, child) {
  const rel = path.relative(realpathSync.native(parent), child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

let tmpRoot;
let projectDir;
let cacheRoot;
let savedPluginRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'ap-artifact-root-'));
  // The user's project: a git checkout (a `.git` entry is what
  // `lib/git/project-root.js#resolveProjectRoot` looks for first), Korean +
  // space in the name, and the shell sitting in a subdirectory of it.
  const projectRoot = path.join(tmpRoot, '내 프로젝트');
  projectDir = projectRoot;
  mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  mkdirSync(path.join(projectDir, 'src', 'deep'), { recursive: true });
  // An installed plugin's version-cache root, the layout the field run had.
  cacheRoot = path.join(tmpRoot, 'home', '.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.71.16');
  mkdirSync(cacheRoot, { recursive: true });
  savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(projectDir, 'src', 'deep'));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Where the pre-fix fallback resolved for the fake cache root. */
function cacheFallback(...parts) {
  return path.join(path.resolve(cacheRoot, '..', '..'), ...parts);
}

describe('generator fallback root (no projectRoot passed)', () => {
  it('generatePRD writes into the user project, not the plugin cache', () => {
    process.env.CLAUDE_PLUGIN_ROOT = cacheRoot;
    const { filePath } = generatePRD({ task: 'cache root probe', sessionId: 'ap-root-probe-1' });
    expect(existsSync(cacheFallback('docs', 'PRD'))).toBe(false);
    expect(inside(projectDir, filePath)).toBe(true);
    expect(path.relative(realpathSync.native(projectDir), filePath).split(path.sep).slice(0, 2))
      .toEqual(['docs', 'PRD']);
    expect(existsSync(filePath)).toBe(true);
  });

  it('generateReport writes into the user project, not the plugin cache', () => {
    process.env.CLAUDE_PLUGIN_ROOT = cacheRoot;
    const sessionId = 'ap-20261121-000000-rootpr';
    saveSession({ sessionId, task: 'report root probe', mode: 'plan', phase: 'REPORT', phases: [] });
    try {
      expect(loadSession(sessionId)).toBeTruthy(); // denominator: the session is really there
      const { filePath } = generateReport(sessionId);
      expect(existsSync(cacheFallback('reports', 'AUTOPILOT'))).toBe(false);
      expect(filePath).toBeTruthy();
      expect(inside(projectDir, filePath)).toBe(true);
      expect(path.relative(realpathSync.native(projectDir), filePath).split(path.sep).slice(0, 2))
        .toEqual(['reports', 'AUTOPILOT']);
    } finally {
      try { deleteSessionArtifacts(sessionId); } catch { /* best-effort */ }
    }
  });

  it('an explicit projectRoot still wins over the fallback', () => {
    process.env.CLAUDE_PLUGIN_ROOT = cacheRoot;
    const elsewhere = path.join(tmpRoot, 'explicit');
    const { filePath } = generatePRD({ task: 'explicit', sessionId: 'ap-root-probe-2', projectRoot: elsewhere });
    expect(inside(elsewhere, filePath)).toBe(true);
  });
});

describe('startAutopilot pins options.projectRoot', () => {
  let sessionId = null;
  let strayPrd = null;
  afterEach(() => {
    if (sessionId) {
      try { deleteSessionArtifacts(sessionId); } catch { /* best-effort */ }
    }
    // A pre-fix run writes the PRD next to the source checkout; never leave it.
    if (strayPrd && !inside(projectDir, strayPrd) && existsSync(strayPrd)) unlinkSync(strayPrd);
    sessionId = null;
    strayPrd = null;
  });

  it('records the project the run was started in and writes its PRD there', async () => {
    const r = await startAutopilot({ task: 'pin project root 검증', mode: 'plan', options: { keepAwake: false, tui: false } });
    sessionId = r.sessionId;
    strayPrd = r.prdPath;
    const state = loadSession(r.sessionId);
    expect(state).toBeTruthy();
    expect(state.options.projectRoot).toBe(realpathSync.native(projectDir));
    expect(typeof r.prdPath).toBe('string');
    expect(inside(projectDir, r.prdPath)).toBe(true);
  });

  it('leaves a caller-supplied projectRoot untouched', async () => {
    const explicit = path.join(tmpRoot, 'explicit-root');
    const r = await startAutopilot({
      task: 'explicit project root 유지',
      mode: 'plan',
      options: { keepAwake: false, tui: false, projectRoot: explicit },
    });
    sessionId = r.sessionId;
    strayPrd = r.prdPath;
    expect(loadSession(r.sessionId).options.projectRoot).toBe(explicit);
    expect(inside(explicit, r.prdPath)).toBe(true);
  });
});
