/**
 * OB-24 / R1 follow-up (architect review, 2026-09-29) -- the SESSION-DAY MARKER.
 *
 * A direct hook fires on every tool call, so one row per firing cost ~21.5k rows
 * (+6-8 MB) a day and broke owner decision O8=a1 ("1 dispatch = 1 row"). The row
 * is now the FIRST firing per (UTC day, session, slot, hook), decided by a marker
 * file the tap looks at BEFORE it loads the ledger writer:
 *
 *   <git common dir>/artibot/hook-seen/<UTC YYYY-MM-DD>/<sha1(session_id)[:16]>.<slot>.<hook>
 *
 * marker exists -> skip (the writer's module graph, the ~30-65 ms, is never
 * loaded); otherwise append the row, and ONLY IF the append was ok create the
 * marker with `wx`, ignoring EEXIST. Never claim first: an `exit(0)` tail that
 * cut the append would then have silenced the whole session-day. The accepted
 * cost is a rare duplicate when two firings of the same hook race on the first.
 *
 * This is the IN-PROCESS half: the pure path, the prune, and the flow with the
 * recorder replaced by a SPY (the "import spy" that proves the writer is not
 * loaded when the marker exists). The spawned half is in
 * `hook-fired-direct.test.js`, which also reads the process's real module log.
 *
 * WHERE THE CODE IS. `directMarkerPath`, `pruneHookSeen` and `fireOnceDirect`
 * live in `scripts/hooks/_hook-seen-marker.js` since review R1 SHOULD 2
 * (2026-09-30); they used to be exports of `_main-entry.js`, which keeps
 * `hookStem` and `directHookName` (the name rule below) and is what the marker
 * module imports `DIRECT_HOOK_SLOTS` from. Nothing else changed here: the
 * expectations are the ones the code had before it moved.
 *
 * WHAT THIS FILE CANNOT SEE (rules section 9)
 *   - REAL PARALLELISM. The duplicate on racing first firings is accepted, not
 *     pinned: the outcome is a race, and asserting it either way would be a lie.
 *   - A REAL PROCESS EXIT. `fireOnceDirect` is awaited here; whether a marker
 *     survives an `exit(0)` tail is the append-then-claim order, pinned below by
 *     "the marker does not exist while the append runs".
 *   - THE CLOCK OF A REAL DAY BOUNDARY. `nowMs` is injected; a spawned hook that
 *     crosses UTC midnight is simulated in the sibling file by moving the marker
 *     directory to yesterday.
 *
 * @module tests/hooks/hook-fired-direct-marker
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  hookSeenDirOf, MAIN_ENTRY_URL, makeLinkedWorktree, makeSandbox, markerFiles, PLUGIN_ROOT, removeSandboxes,
  storeDirOf,
} from '../helpers/hook-fired-harness.js';

const COMMON_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'project-state', 'git-common-dir.js')).href;
const STORE_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'project-state', 'store-location.js')).href;
const MARKER_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_hook-seen-marker.js')).href;

let entry;
let marker;

beforeAll(async () => {
  entry = await import(MAIN_ENTRY_URL);
  marker = await import(MARKER_URL);
});

afterEach(removeSandboxes);

const SID = randomUUID();
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const DAY_MS = 86_400_000;
const sha16 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

describe('directMarkerPath: one marker per (UTC day, session, slot, hook)', () => {
  const STORE = path.resolve(path.sep, 'some', 'common-dir', 'artibot');
  const args = (over = {}) => ({ storeDir: STORE, sessionId: SID, slot: 'PreToolUse', hook: 'pre-bash', nowMs: NOW, ...over });

  it('is <store>/hook-seen/<UTC day>/<first 16 hex of sha1(session)>.<slot>.<hook>', () => {
    expect(marker.directMarkerPath(args()))
      .toBe(path.join(STORE, 'hook-seen', '2026-09-29', `${sha16(SID)}.PreToolUse.pre-bash`));
  });

  it('hashes the session id: the raw id never reaches the disk', () => {
    expect(marker.directMarkerPath(args())).not.toContain(SID);
  });

  it('rolls the day at UTC midnight, whatever the local zone is', () => {
    const day = (nowMs) => path.basename(path.dirname(marker.directMarkerPath(args({ nowMs }))));
    expect(day(Date.parse('2026-09-29T23:59:59.999Z'))).toBe('2026-09-29');
    expect(day(Date.parse('2026-09-30T00:00:00.000Z'))).toBe('2026-09-30');
    expect(day(Date.parse('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01');
  });

  it('is the same for the same triple and different for another session, slot or hook', () => {
    const base = marker.directMarkerPath(args());
    expect(marker.directMarkerPath(args({ nowMs: NOW + 5_000 }))).toBe(base);
    expect(marker.directMarkerPath(args({ sessionId: randomUUID() }))).not.toBe(base);
    expect(marker.directMarkerPath(args({ slot: 'PostToolUseFailure' }))).not.toBe(base);
    expect(marker.directMarkerPath(args({ hook: 'bash-risk-guard' }))).not.toBe(base);
  });

  it.each([
    ['a path separator in the hook name', { hook: 'a/b' }],
    ['a parent segment as the hook name', { hook: '..' }],
    ['a backslash in the hook name', { hook: 'a\\b' }],
    ['an empty hook name', { hook: '' }],
    ['a dispatcher slot', { slot: 'Stop' }],
    ['a slot that is not a name', { slot: '../x' }],
    ['a blank session id', { sessionId: '   ' }],
    ['a non-string session id', { sessionId: 42 }],
    ['an invalid clock', { nowMs: Number.NaN }],
    ['a relative store directory', { storeDir: 'artibot' }],
  ])('refuses %s: a marker name can never leave its directory', (_label, over) => {
    expect(marker.directMarkerPath(args(over))).toBeNull();
  });
});

describe('hookStem: the one name rule the tap and the audit CLI share', () => {
  it.each([
    ['pre-bash.js', 'pre-bash'],
    ['session-ledger.mjs', 'session-ledger'],
    ['x.cjs', 'x'],
    ['/p/scripts/hooks/pre-write.js', 'pre-write'],
    ['a.b.js', 'a.b'],
    ['noext', 'noext'],
    ['data.json', 'data.json'],
  ])('%s -> %s', (file, stem) => {
    expect(entry.hookStem(file)).toBe(stem);
  });

  it('is what directHookName applies to a file URL', () => {
    const url = pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-bash.js')).href;
    expect(entry.directHookName(url)).toBe(entry.hookStem('pre-bash.js'));
  });
});

describe('pruneHookSeen: only stale UTC date directories go', () => {
  /** A hook-seen directory with a marker file in each named entry. */
  function seenWith(sb, names) {
    const dir = path.join(sb.root, 'seen');
    mkdirSync(dir);
    for (const n of names) {
      mkdirSync(path.join(dir, n));
      writeFileSync(path.join(dir, n, 'a.PreToolUse.pre-bash'), '');
    }
    return dir;
  }

  it('removes date directories older than 7 days and keeps today and the last 7', () => {
    const sb = makeSandbox('prune');
    const dir = seenWith(sb, ['2026-09-29', '2026-09-28', '2026-09-22', '2026-09-21', '2026-09-01', '2025-12-31']);
    marker.pruneHookSeen(dir, '2026-09-29');
    // 09-22 is exactly 7 days back (kept); 09-21 is 8 (gone).
    expect(readdirSync(dir).sort()).toEqual(['2026-09-22', '2026-09-28', '2026-09-29']);
  });

  it('never touches a name that is not a UTC date, nor a date in the future', () => {
    const sb = makeSandbox('prune');
    const keep = ['README', '2026-9-1', '2026-09-01.bak', 'notes', '2027-01-01'];
    const dir = seenWith(sb, [...keep, '2026-01-01']);
    marker.pruneHookSeen(dir, '2026-09-29');
    expect(readdirSync(dir).sort()).toEqual([...keep].sort());
  });

  it('is silent when the directory is missing', () => {
    const sb = makeSandbox('prune');
    expect(() => marker.pruneHookSeen(path.join(sb.root, 'nowhere'), '2026-09-29')).not.toThrow();
  });

  it('does not follow a link: a linked date directory survives, and so does its target', () => {
    const sb = makeSandbox('prune');
    const dir = seenWith(sb, ['2026-09-29']);
    // The target lives INSIDE the sandbox, so even a broken prune could only hurt the sandbox.
    const target = path.join(sb.root, 'outside-target');
    mkdirSync(target);
    writeFileSync(path.join(target, 'keep.txt'), 'must survive');
    const link = path.join(dir, '2026-01-01');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    marker.pruneHookSeen(dir, '2026-09-29');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(target, 'keep.txt'), 'utf-8')).toBe('must survive');
  });
});

describe('fireOnceDirect: the marker decides, before the writer is ever loaded', () => {
  /**
   * Real resolvers for the work tree and the store, a SPY for the recorder, a
   * fixed clock. `loads` counts every loader call: the import spy.
   */
  function rig(recorder) {
    const loads = { common: 0, store: 0, recorder: 0 };
    const rows = [];
    const impl = recorder ?? ((a) => { rows.push(a); return { ok: true, folded: false }; });
    const deps = {
      hook: 'pre-bash',
      nowMs: NOW,
      loadCommon: () => { loads.common += 1; return import(COMMON_URL); },
      loadStore: () => { loads.store += 1; return import(STORE_URL); },
      loadRecorder: async () => { loads.recorder += 1; return { recordDirectHookFired: impl }; },
    };
    return { loads, rows, run: (fired, over = {}) => marker.fireOnceDirect({ ...deps, fired, ...over }) };
  }
  const fired = (sb, over = {}) => ({ session_id: SID, hook_event_name: 'PreToolUse', cwd: sb.repo, tool_use_id: 'toolu_1', ...over });
  const markerOf = (sb, over = {}) => marker.directMarkerPath({
    storeDir: storeDirOf(sb), sessionId: SID, slot: 'PreToolUse', hook: 'pre-bash', nowMs: NOW, ...over,
  });

  it('first firing: loads the recorder once, appends one row, then claims the marker', async () => {
    const sb = makeSandbox('fire');
    const r = rig();
    expect(await r.run(fired(sb))).toBe('recorded');
    expect(r.loads.recorder).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ hook: 'pre-bash', projectRoot: sb.repo });
    expect(existsSync(markerOf(sb))).toBe(true);
  });

  it('second firing of the same session/slot/hook: the recorder is NOT loaded, and no row is written', async () => {
    const sb = makeSandbox('fire');
    const r = rig();
    await r.run(fired(sb));
    expect(await r.run(fired(sb, { tool_use_id: 'toolu_2' }))).toBe('seen');
    expect(await r.run(fired(sb, { tool_use_id: 'toolu_3' }))).toBe('seen');
    expect(r.loads.recorder, 'the writer must not be loaded once the marker exists').toBe(1);
    expect(r.rows).toHaveLength(1);
  });

  it('another hook, another slot and another session are each their own first firing', async () => {
    const sb = makeSandbox('fire');
    const r = rig();
    expect(await r.run(fired(sb))).toBe('recorded');
    expect(await r.run(fired(sb), { hook: 'bash-risk-guard' })).toBe('recorded');
    expect(await r.run(fired(sb, { hook_event_name: 'PostToolUseFailure' }))).toBe('recorded');
    expect(await r.run(fired(sb, { session_id: randomUUID() }))).toBe('recorded');
    expect(r.rows).toHaveLength(4);
    expect(markerFiles(sb)).toHaveLength(4);
  });

  it('a new UTC day records the same triple again, and the previous day\'s marker stays', async () => {
    const sb = makeSandbox('fire');
    const r = rig();
    expect(await r.run(fired(sb))).toBe('recorded');
    expect(await r.run(fired(sb))).toBe('seen');
    expect(await r.run(fired(sb), { nowMs: NOW + DAY_MS })).toBe('recorded');
    expect(await r.run(fired(sb), { nowMs: NOW + DAY_MS })).toBe('seen');
    expect(r.rows).toHaveLength(2);
    expect(markerFiles(sb).map((f) => f.split('/')[0])).toEqual(['2026-09-29', '2026-09-30']);
  });

  it('a failed append claims nothing: no marker, and the next firing tries again', async () => {
    const sb = makeSandbox('fire');
    const failing = rig(() => ({ ok: false, reason: 'append-failed' }));
    expect(await failing.run(fired(sb))).toBe('append-failed');
    expect(existsSync(markerOf(sb))).toBe(false);
    expect(markerFiles(sb)).toEqual([]);

    const healthy = rig();
    expect(await healthy.run(fired(sb))).toBe('recorded');
    expect(existsSync(markerOf(sb))).toBe(true);
  });

  it('never claims first: the marker does not exist while the append is running', async () => {
    const sb = makeSandbox('fire');
    const seenDuringAppend = [];
    const r = rig((a) => { seenDuringAppend.push(existsSync(markerOf(sb))); return { ok: true, a }; });
    await r.run(fired(sb));
    expect(seenDuringAppend).toEqual([false]);
    expect(existsSync(markerOf(sb))).toBe(true);
  });

  it('an unwritable marker directory costs a later duplicate, never a crash or a lost row', async () => {
    const sb = makeSandbox('fire');
    mkdirSync(storeDirOf(sb), { recursive: true });
    writeFileSync(hookSeenDirOf(sb), 'a FILE where the marker directory must go');
    const r = rig();
    expect(await r.run(fired(sb))).toBe('recorded');
    expect(await r.run(fired(sb))).toBe('recorded');
    expect(r.rows).toHaveLength(2);
  });

  it('no session id: nothing is loaded at all and nothing is written', async () => {
    const sb = makeSandbox('fire');
    const r = rig();
    for (const bad of [undefined, '', '   ', 7]) {
      expect(await r.run(fired(sb, { session_id: bad }))).toBe('no-session');
    }
    expect(r.loads).toEqual({ common: 0, store: 0, recorder: 0 });
    expect(existsSync(hookSeenDirOf(sb))).toBe(false);
  });

  it('a hook name that cannot be a marker file name: no row, no marker, the recorder is not loaded', async () => {
    const sb = makeSandbox('fire');
    const r = rig();
    // Fail closed on volume: with no marker there would be no dedupe, i.e. a row per firing again.
    expect(await r.run(fired(sb), { hook: 'a/b' })).toBe('no-marker');
    expect(r.loads.recorder).toBe(0);
    expect(r.rows).toEqual([]);
    expect(existsSync(hookSeenDirOf(sb))).toBe(false);
  });

  it('a cwd with no work tree above it: the recorder is not loaded and no marker directory appears', async () => {
    const sb = makeSandbox('fire');
    const bare = path.join(sb.root, 'bare');
    mkdirSync(bare);
    const r = rig();
    expect(await r.run(fired(sb, { cwd: bare }))).toBe('no-work-tree');
    expect(r.loads.recorder).toBe(0);
    expect(existsSync(hookSeenDirOf(sb))).toBe(false);
  });

  it('claims through the store location: from a linked worktree the marker lands in the MAIN store', async () => {
    const sb = makeSandbox('fire');
    const wt = makeLinkedWorktree(sb);
    const r = rig();
    expect(await r.run(fired(sb, { cwd: wt }))).toBe('recorded');
    expect(markerFiles(sb)).toEqual([`2026-09-29/${sha16(SID)}.PreToolUse.pre-bash`]);
    expect(readdirSync(wt).sort()).toEqual(['.git']);
    // The main-store marker is what the second worktree window sees, too.
    expect(await r.run(fired(sb))).toBe('seen');
  });
});
