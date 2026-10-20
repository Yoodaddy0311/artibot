import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The PostCompact record and bundle follow the state-dir resolver (child process).
 *
 * `scripts/hooks/post-compact-rehydrate.js` saved `~/.claude/artibot-post-compact.json` and
 * `~/.claude/artibot/post-compact/post-compact-<stamp>.md` whatever `ARTIBOT_STATE_DIR` said, so a
 * hooked, non-interactive session that was handed an override AND had `split.contextLifecycle.enabled`
 * on still wrote the REAL files (the last two outputs of the 2026-10-20 hook-writer census; the gate
 * ships off). `tests/core/hook-utils-post-compact-path.test.js` pins the path functions; this file runs
 * the hook the way the host runs it — `node post-compact-rehydrate.js`, payload on stdin, the PoC's
 * environment, the gate opened through the documented env overlay `ARTIBOT_CONTEXT_LIFECYCLE_JSON`.
 *
 * It also covers the READER side that `tests/hooks/pre-compact-state-dir.test.js` cannot see: the
 * hook must take the PreCompact snapshot from the redirected state dir, and must not pick up one
 * left in the real `~/.claude` when redirected.
 *
 * Every case uses a throwaway home and a plain (non-git) working directory; the real home is never
 * touched.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'post-compact-rehydrate.js');

const SID = 'sess-post-compact-sd';

describe('post-compact-rehydrate — the record and the bundle follow ARTIBOT_STATE_DIR', () => {
  let tmp;
  let home;
  let work;
  let stateDir;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-pcr-sd-')));
    home = path.join(tmp, 'home');
    work = path.join(tmp, 'work');
    stateDir = path.join(tmp, 'state');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(work, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const homeRecord = () => path.join(home, '.claude', 'artibot-post-compact.json');
  const homeBundleDir = () => path.join(home, '.claude', 'artibot', 'post-compact');
  const stateRecord = () => path.join(stateDir, 'artibot-post-compact.json');
  const stateBundleDir = () => path.join(stateDir, 'post-compact');
  const bundlesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^post-compact-.*\.md$/.test(f)) : []);

  /** One firing; `override` is `undefined` for none, or the `{ dir, mintedFor }` pair. */
  function fire(override) {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ARTIBOT_HOOK_FIRED_DIRECT: 'off',
      // The gate ships off; the documented overlay opens it. The git budget is widened for a loaded machine.
      ARTIBOT_CONTEXT_LIFECYCLE_JSON: JSON.stringify({ enabled: true, gitTimeoutMs: 10000 }),
    };
    // The host session ids and the state-dir seam must not leak into the child unless a case sets them.
    for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME']) {
      delete env[key];
    }
    if (override) {
      env.ARTIBOT_STATE_DIR = override.dir;
      env.ARTIBOT_STATE_DIR_HOME = override.mintedFor;
    }
    const payload = {
      hook_event_name: 'PostCompact',
      compact_trigger: 'manual',
      compact_summary: 'summary written by the host',
      session_id: SID,
      cwd: work,
    };
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env,
      cwd: work,
      windowsHide: true,
      timeout: 30000,
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }

  /** A PreCompact snapshot that belongs to ANOTHER tree, so the hook refuses it and says whose it was. */
  function snapshotFromAnotherTree(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      savedAt: '2026-10-20T00:00:00.000Z',
      reason: 'pre-compact',
      summary: { current_work: 'something from the other tree' },
      gitState: { cwd: path.join(tmp, 'the-other-tree'), branch: 'other-branch', head: 'abcdef123456' },
    }), 'utf-8');
  }

  it('writes the record and the bundle inside the override and leaves ~/.claude alone', () => {
    const out = fire({ dir: stateDir, mintedFor: home });

    expect(out.status).toBe(0);
    const record = JSON.parse(readFileSync(stateRecord(), 'utf-8'));
    expect(record.sessionId).toBe(SID);
    const bundles = bundlesIn(stateBundleDir());
    expect(bundles).toHaveLength(1);
    expect(record.bundlePath).toBe(path.join(stateBundleDir(), bundles[0]));
    // The pointer the model is handed names the redirected bundle, not a path under ~/.claude.
    expect(JSON.parse(out.stdout.trim()).systemMessage).toContain(`bundle: ${record.bundlePath}`);
    expect(existsSync(homeRecord())).toBe(false);
    expect(existsSync(homeBundleDir())).toBe(false);
  });

  it('keeps writing the two ~/.claude paths when no override is set (production invariance)', () => {
    const out = fire();

    expect(out.status).toBe(0);
    expect(JSON.parse(readFileSync(homeRecord(), 'utf-8')).sessionId).toBe(SID);
    expect(bundlesIn(homeBundleDir())).toHaveLength(1);
    expect(existsSync(stateDir)).toBe(false);
  });

  it('ignores an override minted for another home (a child handed its own HOME)', () => {
    const out = fire({ dir: stateDir, mintedFor: path.join(tmp, 'some-other-home') });

    expect(out.status).toBe(0);
    expect(existsSync(homeRecord())).toBe(true);
    expect(bundlesIn(homeBundleDir())).toHaveLength(1);
    expect(existsSync(stateDir)).toBe(false);
  });

  it('reads the PreCompact snapshot from the redirected state dir', () => {
    snapshotFromAnotherTree(path.join(stateDir, 'artibot-pre-compact.json'));

    const out = fire({ dir: stateDir, mintedFor: home });

    expect(out.status).toBe(0);
    const record = JSON.parse(readFileSync(stateRecord(), 'utf-8'));
    // The snapshot's own cwd comes back in the identity check: the file in the state dir was read.
    expect(record.identity.snapshot.cwd).toBe(path.join(tmp, 'the-other-tree'));
    expect(record.identity.ok).toBe(false);
  });

  it('does not pick up a snapshot left in the real ~/.claude when redirected', () => {
    snapshotFromAnotherTree(path.join(home, '.claude', 'artibot-pre-compact.json'));

    const out = fire({ dir: stateDir, mintedFor: home });

    expect(out.status).toBe(0);
    const record = JSON.parse(readFileSync(stateRecord(), 'utf-8'));
    expect(record.identity.snapshot.cwd).toBeNull();
  });
});
