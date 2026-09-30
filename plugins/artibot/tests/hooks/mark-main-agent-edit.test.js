import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * mark-main-agent-edit.js — PostToolUse marker for the dev-verify-gate.
 *
 * Contract under test:
 *   - On Edit / Write / MultiEdit calls from the main orchestrator agent,
 *     write `last-main-agent-edit.timestamp` into THIS session's gate directory
 *     under the project store (`<store>/gates/sessions/<session>/`, O2).
 *   - On the same tools but inside a subagent (Task-spawned teammate)
 *     context, do NOT write the marker.
 *   - On non-edit tools (Bash, Read, Grep, etc.), do NOT write the marker.
 *   - On absent / unknown tool name, do NOT write the marker.
 *   - Outside a git work tree, or in a work tree that is not an Artibot repo, do
 *     NOT write the marker: no Stop gate could ever read it.
 *   - Marker write failures must not throw out of the hook.
 *
 * `atomicWriteSync` is captured rather than performed, so a case observes WHICH
 * file would be written; directories, repo detection and pruning are real
 * filesystem work in throwaway projects. The cross-process behaviour (another
 * project's edit vs this project's gate) is measured with real spawns in
 * `gate-state-project-scope.test.js`.
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  stdin: '',
  atomicWrites: [],
};

// ---------------------------------------------------------------------------
// Mocks (must be hoisted via vi.mock — referencing local state is allowed
// because mockState is module-scoped, not test-scoped).
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(async () => mockState.stdin),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); } catch { return null; }
  }),
  atomicWriteSync: vi.fn((file, data) => {
    mockState.atomicWrites.push({ file, data });
  }),
}));

// Everything real except the error handler (whose real form exits the process).
// `isArtibotRepo` and `extractToolName` are part of what this hook decides with.
vi.mock('../../lib/core/hook-utils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createErrorHandler: vi.fn(() => () => undefined),
}));

const {
  isSubagentContext, getMarkerPath, resolveMarkerTarget, main,
} = await import('../../scripts/hooks/mark-main-agent-edit.js');
const {
  GATE_FILES, GATE_STATE_KEEP_MS, NO_SESSION_SLOT, sessionSlot,
} = await import('../../lib/project-state/gate-markers.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** @type {string[]} */
const roots = [];

/**
 * A throwaway project. A bare `.git` DIRECTORY is all `resolveGitCommonDir`
 * needs to call it a work tree (no git process is involved anywhere in the hook).
 *
 * @param {{ artibot?: boolean, git?: boolean }} [opts]
 * @returns {string} canonical project root
 */
function makeProject({ artibot = true, git = true } = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'mark-edit-')));
  roots.push(root);
  if (git) mkdirSync(path.join(root, '.git'));
  if (artibot) {
    mkdirSync(path.join(root, 'plugins', 'artibot'), { recursive: true });
    writeFileSync(path.join(root, 'plugins', 'artibot', 'CLAUDE.md'), '# stub\n');
  }
  return root;
}

function setStdin(payload) {
  mockState.stdin = typeof payload === 'string' ? payload : JSON.stringify(payload);
}

function reset() {
  mockState.stdin = '';
  mockState.atomicWrites = [];
  vi.clearAllMocks();
}

const digest = (id) => createHash('sha1').update(id).digest('hex').slice(0, 16);

afterEach(() => {
  while (roots.length > 0) {
    try { rmSync(roots.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// isSubagentContext
// ---------------------------------------------------------------------------
describe('isSubagentContext', () => {
  it('returns false for plain main-agent hook data', () => {
    expect(isSubagentContext({ tool_name: 'Edit', session_id: 'abc' })).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isSubagentContext({})).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isSubagentContext(null)).toBe(false);
    expect(isSubagentContext(undefined)).toBe(false);
  });

  it('returns false for non-object payloads', () => {
    expect(isSubagentContext('string')).toBe(false);
    expect(isSubagentContext(42)).toBe(false);
  });

  it('returns true when subagent_id is set', () => {
    expect(isSubagentContext({ subagent_id: 'sub-123' })).toBe(true);
  });

  it('returns true when subagent_type is set', () => {
    expect(isSubagentContext({ subagent_type: 'code-reviewer' })).toBe(true);
  });

  it('returns true when parent_session_id is set', () => {
    expect(isSubagentContext({ parent_session_id: 'parent-abc' })).toBe(true);
  });

  it("returns true when role is 'teammate'", () => {
    expect(isSubagentContext({ role: 'teammate' })).toBe(true);
  });

  it("returns false when role is 'orchestrator'", () => {
    expect(isSubagentContext({ role: 'orchestrator' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getMarkerPath — the layout is pinned HERE, literally, so a change to it is a
// visible test edit and not a silent move of where every gate looks.
// ---------------------------------------------------------------------------
describe('getMarkerPath', () => {
  it('puts the marker in the session directory of the git store (F3: <common dir>/artibot)', () => {
    const root = makeProject();
    expect(getMarkerPath(root, 'sess-1')).toBe(path.join(
      root, '.git', 'artibot', 'gates', 'sessions', digest('sess-1'), 'last-main-agent-edit.timestamp',
    ));
  });

  it('falls back to <root>/.artibot/runtime when git cannot be resolved (the store rule, not a new one)', () => {
    const root = makeProject({ git: false });
    expect(getMarkerPath(root, 'sess-1')).toBe(path.join(
      root, '.artibot', 'runtime', 'gates', 'sessions', digest('sess-1'), 'last-main-agent-edit.timestamp',
    ));
  });

  it('uses the no-session slot when the payload has no usable session id', () => {
    const root = makeProject();
    for (const id of [undefined, null, '', '   ', 42]) {
      expect(getMarkerPath(root, id), `id=${JSON.stringify(id)}`)
        .toBe(path.join(root, '.git', 'artibot', 'gates', 'sessions', NO_SESSION_SLOT, GATE_FILES.mainAgentEdit));
    }
  });

  it('never lets a session id choose its own path segments', () => {
    const root = makeProject();
    const hostile = '../../../../etc/passwd';
    const p = getMarkerPath(root, hostile);
    expect(p.startsWith(path.join(root, '.git', 'artibot', 'gates', 'sessions'))).toBe(true);
    expect(path.basename(path.dirname(p))).toBe(sessionSlot(hostile));
    expect(p).not.toContain('etc');
  });

  it('is not derived from the plugin root, whatever CLAUDE_PLUGIN_ROOT says', () => {
    const root = makeProject();
    const before = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = path.join(os.tmpdir(), 'some-plugin-root', '4.99.0');
    try {
      const p = getMarkerPath(root, 'sess-1');
      expect(p.startsWith(root)).toBe(true);
      expect(p).not.toContain('some-plugin-root');
    } finally {
      if (before === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = before;
    }
  });
});

// ---------------------------------------------------------------------------
// resolveMarkerTarget
// ---------------------------------------------------------------------------
describe('resolveMarkerTarget', () => {
  it('resolves the work-tree root from the payload cwd, including a subdirectory', () => {
    const root = makeProject();
    const sub = path.join(root, 'plugins', 'artibot');
    const target = resolveMarkerTarget({ cwd: sub, session_id: 's1' });
    expect(target?.projectRoot).toBe(root);
    expect(target?.file).toBe(getMarkerPath(root, 's1'));
  });

  it('accepts the camelCase session key the ledger recorder also accepts', () => {
    const root = makeProject();
    expect(resolveMarkerTarget({ cwd: root, sessionId: 's2' })?.file).toBe(getMarkerPath(root, 's2'));
  });

  it('returns null outside a git work tree (no Stop gate runs there)', () => {
    const root = makeProject({ git: false });
    expect(resolveMarkerTarget({ cwd: root, session_id: 's1' })).toBeNull();
  });

  it('returns null in a git project that is not an Artibot repo (the gates bail there)', () => {
    const root = makeProject({ artibot: false });
    expect(resolveMarkerTarget({ cwd: root, session_id: 's1' })).toBeNull();
  });

  it('follows a linked-worktree pointer to the ONE shared store, with a session slot of its own', () => {
    // `.git` is a FILE in a linked worktree: `gitdir: <main>/.git/worktrees/w`,
    // and that directory's `commondir` names `../..`.
    const mainTree = makeProject();
    const gitdir = path.join(mainTree, '.git', 'worktrees', 'w');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'mark-edit-wt-')));
    roots.push(wt);
    writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    mkdirSync(path.join(wt, 'plugins', 'artibot'), { recursive: true });
    writeFileSync(path.join(wt, 'plugins', 'artibot', 'CLAUDE.md'), '# stub\n');

    const fromWt = resolveMarkerTarget({ cwd: wt, session_id: 'sw' });
    const fromMain = resolveMarkerTarget({ cwd: mainTree, session_id: 'sm' });

    expect(path.dirname(path.dirname(fromWt.dir))).toBe(path.dirname(path.dirname(fromMain.dir)));
    expect(fromWt.dir).not.toBe(fromMain.dir);
  });
});

// ---------------------------------------------------------------------------
// main() — integration through stdin
// ---------------------------------------------------------------------------
describe('main()', () => {
  let root;

  beforeEach(() => {
    reset();
    root = makeProject();
  });

  const editPayload = (over = {}) => ({
    tool_name: 'Edit', tool_input: { file_path: '/x.js' }, session_id: 'sess-main', cwd: root, ...over,
  });

  it('writes the marker on Edit from main agent', async () => {
    setStdin(editPayload());
    await main();
    expect(mockState.atomicWrites).toHaveLength(1);
    expect(mockState.atomicWrites[0].file).toBe(getMarkerPath(root, 'sess-main'));
    // Body must be a valid ISO 8601 timestamp followed by a newline.
    expect(mockState.atomicWrites[0].data).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n$/,
    );
  });

  it('writes the marker on Write from main agent', async () => {
    setStdin(editPayload({ tool_name: 'Write', tool_input: { file_path: '/x.js', content: 'hi' } }));
    await main();
    expect(mockState.atomicWrites).toHaveLength(1);
  });

  it('writes the marker on MultiEdit from main agent', async () => {
    setStdin(editPayload({ tool_name: 'MultiEdit', tool_input: { file_path: '/x.js', edits: [] } }));
    await main();
    expect(mockState.atomicWrites).toHaveLength(1);
  });

  it('writes two sessions of one project to two different files', async () => {
    setStdin(editPayload({ session_id: 'sess-a' }));
    await main();
    setStdin(editPayload({ session_id: 'sess-b' }));
    await main();
    const files = mockState.atomicWrites.map((w) => w.file);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
  });

  it('does NOT write the marker on Edit inside a subagent', async () => {
    setStdin(editPayload({ subagent_id: 'sub-xyz' }));
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it("does NOT write the marker when role is 'teammate'", async () => {
    setStdin(editPayload({
      tool_name: 'Write',
      tool_input: { file_path: '/x.js', content: 'hi' },
      role: 'teammate',
    }));
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write the marker on Bash', async () => {
    setStdin(editPayload({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write the marker on Read', async () => {
    setStdin(editPayload({ tool_name: 'Read' }));
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write the marker on missing tool name', async () => {
    setStdin({ tool_input: { file_path: '/x.js' }, session_id: 's', cwd: root });
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write the marker on malformed JSON stdin', async () => {
    setStdin('not-json{{');
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT throw when stdin is empty', async () => {
    setStdin('');
    await expect(main()).resolves.toBeUndefined();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write — and creates no directory — outside an Artibot repo', async () => {
    const stranger = makeProject({ artibot: false });
    setStdin(editPayload({ cwd: stranger }));
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
    expect(existsSync(path.join(stranger, '.git', 'artibot'))).toBe(false);
  });

  it('does NOT write — and creates no directory — outside a git work tree', async () => {
    const plain = makeProject({ git: false });
    setStdin(editPayload({ cwd: plain }));
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
    expect(existsSync(path.join(plain, '.artibot'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Pruning: one directory per session must not grow without bound.
  // -------------------------------------------------------------------------
  describe('pruning of idle session directories', () => {
    const sessionsDir = () => path.join(root, '.git', 'artibot', 'gates', 'sessions');
    const DAY = 24 * 60 * 60 * 1000;

    /** A slot-shaped directory last touched `ageMs` ago. */
    function plantSlot(name, ageMs) {
      const dir = path.join(sessionsDir(), name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, GATE_FILES.mainAgentEdit), 'x');
      const when = new Date(Date.now() - ageMs);
      utimesSync(dir, when, when);
      return dir;
    }

    it('the process that CREATES a session directory removes idle ones and keeps the rest', async () => {
      const stale = plantSlot('aaaaaaaaaaaaaaaa', GATE_STATE_KEEP_MS + DAY);
      const fresh = plantSlot('bbbbbbbbbbbbbbbb', DAY);
      const foreign = path.join(sessionsDir(), 'not-a-slot-name');
      mkdirSync(foreign, { recursive: true });
      const old = new Date(Date.now() - GATE_STATE_KEEP_MS - DAY);
      utimesSync(foreign, old, old);

      setStdin(editPayload({ session_id: 'sess-new' }));
      await main();

      expect(existsSync(stale), 'idle slot removed').toBe(false);
      expect(existsSync(fresh), 'recent slot kept').toBe(true);
      expect(existsSync(foreign), 'a name this module did not mint is never touched').toBe(true);
      expect(existsSync(path.dirname(mockState.atomicWrites[0].file)), 'own slot exists').toBe(true);
    });

    it('a process that finds its directory already there does not prune', async () => {
      setStdin(editPayload({ session_id: 'sess-again' }));
      await main(); // creates the session directory

      const stale = plantSlot('cccccccccccccccc', GATE_STATE_KEEP_MS + DAY);
      setStdin(editPayload({ session_id: 'sess-again' }));
      await main(); // the directory exists now: not the creator

      expect(existsSync(stale), 'only a creator pays for the prune').toBe(true);
    });
  });
});
