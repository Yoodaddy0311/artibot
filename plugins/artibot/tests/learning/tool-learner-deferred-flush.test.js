/**
 * tool-learner.js — the two flushes nobody awaits: the debounce timer armed by
 * recordUsage/pruneOldRecords (tool-history.js#markDirty) and the `beforeExit`
 * handler. Both used to call the async flushToDisk() and drop the promise, so a
 * save that THREW (lock create error, write error — saveHistory rethrows every
 * error but ELOCKTIMEOUT) became an unhandled rejection, which ends a Node >=15
 * process with exit code 1 and a stack trace.
 *
 * Measured 2026-11-22 before the fix (child process, state dir replaced by a
 * regular file so the lock's mkdir fails with EEXIST): the timer path exited 1
 * at ~5.1s; the beforeExit path exited 1 as well once it had work.
 *
 * Reachability, stated rather than hidden:
 *   - The TIMER path is reachable in any process that leaves the flush to the
 *     debounce (the PostToolUse hook does not — it awaits flushToDisk itself).
 *   - The BEFOREEXIT path has work only while dirty with no timer armed. A
 *     dirty flag always comes with a ref'd timer (markDirty), and the timer's
 *     flush clears the flag, so no production sequence reaches it; the case
 *     below FORCES that state (clears the timer, keeps the flag) to exercise
 *     the handler itself.
 *
 * Each case is a real child process with its own throwaway HOME; the debounce
 * is compressed to 0ms in the child (a setTimeout shim) so no case waits 5s.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEARNER_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'learning', 'tool-learner.js')).href;
const HISTORY_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'learning', 'tool-history.js')).href;

const CHILD = `
const [learnerUrl, historyUrl, mode] = process.argv.slice(2);
if (mode === 'timer') {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
}
const learner = await import(learnerUrl);
const history = await import(historyUrl);
await learner.recordUsage('Read', 'read:js:file', 1);
process.stderr.write('[child] recorded\\n');
if (mode === 'beforeExit') {
  clearTimeout(history.getDirtyState().timer);
  process.stderr.write('[child] timer cleared, dirty=' + history.getDirtyState().dirty + '\\n');
}
`;

let tmp;
let home;
let childFile;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'artibot-tl-deferred-'));
  home = path.join(tmp, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  childFile = path.join(tmp, 'child.mjs');
  writeFileSync(childFile, CHILD, 'utf-8');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The state dir the child resolves: `<home>/.claude/artibot`. */
const stateDir = () => path.join(home, '.claude', 'artibot');

/** Make every save throw: a regular FILE where the state directory should be. */
function blockStateDir() {
  writeFileSync(stateDir(), 'not a directory');
}

/** @param {'timer'|'beforeExit'} mode */
function runChild(mode) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ['ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']) {
    delete env[key];
  }
  const res = spawnSync(process.execPath, [childFile, LEARNER_URL, HISTORY_URL, mode], {
    encoding: 'utf-8', env, cwd: tmp, windowsHide: true, timeout: 30_000,
  });
  return { status: res.status, stderr: String(res.stderr || '') };
}

describe('tool-learner — a deferred flush that throws is logged, not raised', () => {
  it('debounce timer: the process still exits 0 and says the flush failed', () => {
    blockStateDir();
    const out = runChild('timer');
    expect(out.stderr).toContain('[child] recorded');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain('[artibot:tool-learner] deferred flush failed');
    expect(out.stderr).not.toMatch(/Node\.js v\d/);
  });

  it('beforeExit (forced: dirty, no timer): the process still exits 0 and says the flush failed', () => {
    blockStateDir();
    const out = runChild('beforeExit');
    expect(out.stderr).toContain('[child] timer cleared, dirty=true');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain('[artibot:tool-learner] deferred flush failed');
    expect(out.stderr).not.toMatch(/Node\.js v\d/);
  });

  it('control — a writable state dir: the debounced flush writes the row and logs nothing', () => {
    const out = runChild('timer');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).not.toContain('deferred flush failed');
    const file = path.join(stateDir(), 'tool-history.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8')).contexts['read:js:file']).toHaveLength(1);
  });
});
