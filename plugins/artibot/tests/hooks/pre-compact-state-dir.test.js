import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The PreCompact snapshot follows the state-dir resolver (child process).
 *
 * `scripts/hooks/pre-compact.js` wrote `~/.claude/artibot-pre-compact.json` on every
 * PreCompact event whatever `ARTIBOT_STATE_DIR` said, so a hooked, non-interactive
 * session that was handed an override still wrote the REAL file (found by the
 * 2026-10-20 hook-writer census after the owner's promptfoo PoC; the hook has no gate).
 * `tests/core/hook-utils-pre-compact-path.test.js` pins the path function; this file
 * runs the hook the way the host runs it — `node pre-compact.js`, payload on stdin, the
 * PoC's environment — because a unit test of the path says nothing about the parent
 * directory the write needs.
 *
 * Every case uses a throwaway home; the real one is never touched.
 *
 * WHAT THIS FILE CANNOT SEE: the reader, `post-compact-rehydrate.js`. It asks the same
 * function, and its gate (`contextLifecycle.enabled`) is off in the shipped config; the reader is
 * run as a child process, with the gate opened, by `tests/hooks/post-compact-rehydrate-state-dir.test.js`.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-compact.js');

const SID = 'sess-pre-compact-sd';
const PAYLOAD = { hook_event_name: 'PreCompact', trigger: 'manual', session_id: SID, cwd: os.tmpdir() };

describe('pre-compact — the snapshot follows ARTIBOT_STATE_DIR', () => {
  let tmp;
  let home;
  let stateDir;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-pc-sd-')));
    home = path.join(tmp, 'home');
    stateDir = path.join(tmp, 'state');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const homeFile = () => path.join(home, '.claude', 'artibot-pre-compact.json');
  const stateFile = () => path.join(stateDir, 'artibot-pre-compact.json');

  /** One firing; `override` is `undefined` for none, or the `{ dir, mintedFor }` pair. */
  function fire(override) {
    // CLAUDE_PLUGIN_ROOT keeps the hook's other artifact (<plugin root>/../../runtime/state/pre-compact-*.md) inside the
    // throwaway tree instead of the repository checkout the test runs from.
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ARTIBOT_HOOK_FIRED_DIRECT: 'off',
      CLAUDE_PLUGIN_ROOT: path.join(tmp, 'plugins', 'artibot'),
    };
    // The host session ids and the state-dir seam must not leak into the child unless a case sets them.
    for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME']) {
      delete env[key];
    }
    if (override) {
      env.ARTIBOT_STATE_DIR = override.dir;
      env.ARTIBOT_STATE_DIR_HOME = override.mintedFor;
    }
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(PAYLOAD),
      encoding: 'utf-8',
      env,
      cwd: tmp,
      windowsHide: true,
      timeout: 30000,
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }

  it('writes the snapshot inside the override and leaves ~/.claude/artibot-pre-compact.json alone', () => {
    const out = fire({ dir: stateDir, mintedFor: home });

    expect(out.status).toBe(0);
    expect(existsSync(stateFile())).toBe(true);
    const snapshot = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(snapshot.sessionId).toBe(SID);
    expect(typeof snapshot.savedAt).toBe('string');
    expect(existsSync(homeFile())).toBe(false);
  });

  it('keeps writing ~/.claude/artibot-pre-compact.json when no override is set (production invariance)', () => {
    const out = fire();

    expect(out.status).toBe(0);
    expect(JSON.parse(readFileSync(homeFile(), 'utf-8')).sessionId).toBe(SID);
    expect(existsSync(stateDir)).toBe(false);
  });

  it('ignores an override minted for another home (a child handed its own HOME)', () => {
    const out = fire({ dir: stateDir, mintedFor: path.join(tmp, 'some-other-home') });

    expect(out.status).toBe(0);
    expect(existsSync(homeFile())).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
  });
});
