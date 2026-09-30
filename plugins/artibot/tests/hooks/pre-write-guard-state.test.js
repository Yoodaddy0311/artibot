import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blocked, canonical, cleanup, hookPath, makeDir, makeRepo, runHookPatiently,
} from './_gate-state-harness.js';

/**
 * O2 — the write-before-read loop guard (`last-pre-write-block.txt`) belongs to
 * ONE session and outlives a plugin update.
 *
 * WHAT THE FILE IS FOR. `pre-write-guard.js` blocks a Write/Edit of an existing
 * file that was not Read this session. The model's natural reaction is to retry
 * the same call; the guard remembers `session|tool|path` of its last block and
 * lets the IMMEDIATE identical retry through, so a model that does not read the
 * file cannot be blocked forever ("block, retry, block, end the session").
 *
 * THE DEFECT, MEASURED BEFORE THE FIX. The memory was ONE file in the versioned
 * plugin directory, shared by every session of every project. Session S1 is
 * blocked on file A; session S2 (another window, another project) is blocked on
 * file B, overwriting the slot; S1 retries A — the slot no longer names A, so S1
 * is blocked AGAIN. The safety valve fails exactly when several windows are open,
 * which is the normal `/split` and `/team` working shape. A plugin update also
 * erased it.
 *
 * WHAT THESE CANNOT SEE: the host's real PreToolUse envelope beyond the keys the
 * guard reads, and read-tracking races (the tracking file is seeded, not
 * produced by a Read hook).
 */

/** @type {string[]} */
const created = [];
/** @type {string[]} */
const trackingFiles = [];

afterEach(() => {
  for (const file of trackingFiles.splice(0)) {
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
  }
  cleanup(created);
});

let counter = 0;
const sid = (label) => `wbr-${label}-${process.pid}-${Date.now()}-${(counter += 1)}`;

/**
 * A repo the guard enforces in. CANONICAL, because the guard decides "is this
 * file inside the cwd" by string prefix, and `os.tmpdir()` is an 8.3 short name
 * here while the child's `process.cwd()` is not.
 *
 * @param {string} label
 * @returns {string}
 */
function guardedRepo(label) {
  return canonical(makeRepo(created, label, { dirty: false }));
}

/**
 * Seed the session's read-tracking file EMPTY: with no file at all the guard
 * takes its degraded branch and passes, which would make every case vacuous.
 *
 * @param {string} sessionId
 */
function seedTracking(sessionId) {
  const file = path.join(os.tmpdir(), `artibot-read-tracking-${sessionId}.json`);
  writeFileSync(file, '[]', 'utf-8');
  trackingFiles.push(file);
}

/**
 * One Write attempt of `target` by session `sessionId`, in `repo`, answered by
 * the plugin directory `pluginRoot`.
 *
 * @param {string} repo
 * @param {string} pluginRoot
 * @param {string} sessionId
 * @param {string} target
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function attempt(repo, pluginRoot, sessionId, target) {
  return runHookPatiently(hookPath('pre-write-guard.js'), {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: target },
    session_id: sessionId,
    cwd: repo,
  }, { cwd: repo, pluginRoot, env: { ARTIBOT_WRITE_GUARD_MODE: 'block' } });
}

describe('O2 — pre-write-guard keeps its loop-guard memory per session', () => {
  it('CONTROL: the first write of an unread file blocks and the identical retry passes', () => {
    const plugin = makeDir(created, 'plugin');
    const repo = guardedRepo('ctl');
    const session = sid('ctl');
    seedTracking(session);
    const target = path.join(repo, 'src', 'a.js');

    const first = attempt(repo, plugin, session, target);
    const retry = attempt(repo, plugin, session, target);

    expect(blocked(first.stdout), `first. stdout=${first.stdout} stderr=${first.stderr}`).toBe(true);
    expect(first.stdout).toContain('WRITE-BEFORE-READ');
    expect(blocked(retry.stdout), `retry. stdout=${retry.stdout} stderr=${retry.stderr}`).toBe(false);
  }, 120_000);

  it('a block in another session does not defeat this session\'s retry bypass', () => {
    const plugin = makeDir(created, 'plugin');
    const repo = guardedRepo('mix');
    const s1 = sid('s1');
    const s2 = sid('s2');
    seedTracking(s1);
    seedTracking(s2);
    const fileA = path.join(repo, 'src', 'a.js');
    const fileB = path.join(repo, 'src', 'b.js');

    const s1First = attempt(repo, plugin, s1, fileA);
    const s2First = attempt(repo, plugin, s2, fileB);
    const s1Retry = attempt(repo, plugin, s1, fileA);

    expect(blocked(s1First.stdout), `s1First. stderr=${s1First.stderr}`).toBe(true);
    expect(blocked(s2First.stdout), `s2First. stderr=${s2First.stderr}`).toBe(true);
    expect(blocked(s1Retry.stdout), `S1's retry must pass. stdout=${s1Retry.stdout} stderr=${s1Retry.stderr}`)
      .toBe(false);
  }, 180_000);

  it('the retry bypass survives a plugin update (each plugin version is its own directory)', () => {
    const pluginV1 = makeDir(created, 'plugin-v1');
    const pluginV2 = makeDir(created, 'plugin-v2');
    const repo = guardedRepo('upd');
    const session = sid('upd');
    seedTracking(session);
    const target = path.join(repo, 'src', 'a.js');

    const before = attempt(repo, pluginV1, session, target);
    const after = attempt(repo, pluginV2, session, target);

    expect(blocked(before.stdout), `before. stderr=${before.stderr}`).toBe(true);
    expect(blocked(after.stdout), `after. stdout=${after.stdout} stderr=${after.stderr}`).toBe(false);
  }, 120_000);

  it('leaves nothing under the plugin root', () => {
    const plugin = makeDir(created, 'plugin');
    const repo = guardedRepo('ns');
    const session = sid('ns');
    seedTracking(session);

    const run = attempt(repo, plugin, session, path.join(repo, 'src', 'a.js'));

    expect(blocked(run.stdout), `the block must have happened for this case to mean anything. stderr=${run.stderr}`)
      .toBe(true);
    expect(existsSync(path.join(plugin, 'runtime')), 'runtime/ under the plugin root').toBe(false);
  }, 120_000);
});
