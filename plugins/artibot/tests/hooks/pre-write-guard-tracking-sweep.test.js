import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The first Read of a session sweeps stale read-tracking files from the temp dir (child process).
 *
 * `lib/core/read-tracking-sweep.js#pruneStaleTrackingFiles` (pinned by `tests/core/read-tracking-sweep.test.js`)
 * does the deleting; this file runs `pre-write-guard.js` the way the host runs it — `node pre-write-guard.js`,
 * a PostToolUse Read payload on stdin, `os.tmpdir()` pointed at a throwaway dir — and pins WHEN it runs:
 * once, when the session has no tracking file yet. A session that already has one must not pay for a
 * directory listing on every Read.
 *
 * Every case uses a throwaway temp dir; the real one is never touched.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-write-guard.js');

const DAY = 24 * 60 * 60 * 1000;

function ageBy(file, ms) {
  const when = new Date(Date.now() - ms);
  utimesSync(file, when, when);
}

describe('pre-write-guard — the first Read of a session sweeps the temp dir (child process)', () => {
  let tmp;
  let tmpDir;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-sweep-hook-')));
    tmpDir = path.join(tmp, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /** One PostToolUse Read firing with os.tmpdir() pointed at the throwaway dir. */
  function fireRead(sessionId) {
    const env = { ...process.env, TEMP: tmpDir, TMP: tmpDir, TMPDIR: tmpDir, ARTIBOT_HOOK_FIRED_DIRECT: 'off' };
    for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) delete env[key];
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(tmp, 'some-file.js') },
      session_id: sessionId,
      cwd: tmp,
    };
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env,
      cwd: tmp,
      windowsHide: true,
      timeout: 30000,
    });
    return { status: res.status, stderr: String(res.stderr || '') };
  }

  it('removes a stale tracking file, keeps a fresh one and records the new session', () => {
    const stale = path.join(tmpDir, 'artibot-read-tracking-stale-session.json');
    const fresh = path.join(tmpDir, 'artibot-read-tracking-fresh-session.json');
    const unrelated = path.join(tmpDir, 'something-else.json');
    writeFileSync(stale, '[]', 'utf-8');
    writeFileSync(fresh, '[]', 'utf-8');
    writeFileSync(unrelated, '{}', 'utf-8');
    ageBy(stale, 10 * DAY);
    ageBy(unrelated, 10 * DAY);

    const out = fireRead('sweep-session-new');

    expect(out.status).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(path.join(tmpDir, 'artibot-read-tracking-sweep-session-new.json'))).toBe(true);
  });

  it('does not sweep again once the session already has its tracking file', () => {
    writeFileSync(path.join(tmpDir, 'artibot-read-tracking-sweep-session-known.json'), '[]', 'utf-8');
    const stale = path.join(tmpDir, 'artibot-read-tracking-stale-session.json');
    writeFileSync(stale, '[]', 'utf-8');
    ageBy(stale, 10 * DAY);

    const out = fireRead('sweep-session-known');

    expect(out.status).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });
});
