/**
 * `scripts/split/lane-state.mjs` — the writer chain (`setLaneState` →
 * `lib/topology/split-state.js#writeWorkerState`) and the `ledger` return.
 *
 * The CLI-level cases (refusals, `--list`, key preservation) live in
 * `tests/scripts/split-tools.test.js`; this file pins only what the 2026-09-14
 * chain change added: the record shape the projection writer stamps and the
 * `ledger` word that makes a skipped event visible to the caller.
 *
 * What this file cannot see: no ledger port is injected by the CLI, so the
 * `appended` value never occurs here — `skipped:*` is the only outcome this
 * writer can produce, and that hole is reported, not filled.
 *
 * It also pins the CLI output contract of the lease sync (2026-09-23): the
 * `lease` key is the ONE key `--json` gained, and the human line and exit
 * code do not move. What the sync does to a store is measured in
 * `tests/scripts/lane-lease.test.js`; no store is opened from this file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, setLaneState } from '../../scripts/split/lane-state.mjs';
import { readRunJson, writeRunJson } from '../../lib/git/split-run-file.js';
import { readLaneOpsState } from '../../lib/supervisor/lane-monitor.js';

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function seed() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-state-'));
  tmpDirs.push(parent);
  const dir = path.join(parent, '.artibot', 'split');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ runId: 'split-t', limbs: [{ limb: 'auth' }] }));
  writeRunJson(parent, { runId: 'split-t', windowReuse: { auth: 'w-a @ /p' }, metrics: { n: 1 } });
  return parent;
}

describe('setLaneState → writeWorkerState chain', () => {
  it('records the ops word through the projection writer and the reader sees it', () => {
    const parent = seed();
    const now = () => new Date('2026-09-14T06:00:00.000Z');
    const r = setLaneState({ limb: 'auth', state: 'active' }, { cwd: parent, now });
    const run = readRunJson(parent);
    expect(readLaneOpsState(run, 'auth')).toBe('active');
    expect(run.lanes.auth).toMatchObject({ state: 'active', since: '2026-09-14T06:00:00.000Z', window: 'w-a', projected_from: 'run.json' });
    expect(typeof run.lanes.auth.updated_at).toBe('string');
    expect(run.windowReuse).toEqual({ auth: 'w-a @ /p' });
    expect(run.metrics).toEqual({ n: 1 });
    expect(r.window).toBe('w-a');
  });

  it('exposes the ledger outcome: active owes no event, done owes one this CLI cannot append', () => {
    const parent = seed();
    const active = setLaneState({ limb: 'auth', state: 'active' }, { cwd: parent });
    expect(active.ledger).toBe('skipped:no-event');
    const done = setLaneState({ limb: 'auth', state: 'done' }, { cwd: parent });
    expect(done.ledger).toMatch(/^skipped:/);
    expect(done.ledger).not.toBe('appended');
    expect(readLaneOpsState(readRunJson(parent), 'auth')).toBe('done');
  });
});

describe('main → lease sync: record-only output contract', () => {
  /** Exactly the keys `--json` printed before the lease sync existed. */
  const PRE_SYNC_KEYS = ['changed', 'ledger', 'limb', 'note', 'previous', 'since', 'state', 'window'];
  const now = () => new Date('2026-09-23T02:00:00.000Z');
  const collect = () => {
    const out = []; const err = [];
    return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, stdout: () => out.join(''), stderr: () => err.join('') };
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  it('--json gains exactly one key, `lease`, holding the sync result verbatim', () => {
    const parent = seed();
    /** @type {any} */ let seen = null;
    const c = collect();
    const code = main(['auth', 'done', '--json'], {
      cwd: parent, now, ...c.io,
      syncLease: (input) => { seen = input; return { outcome: 'released:done', missionId: 'M-20260923-Sabcd1234' }; },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout());
    expect(Object.keys(parsed).sort()).toEqual([...PRE_SYNC_KEYS, 'lease'].sort());
    expect(parsed.lease).toEqual({ outcome: 'released:done', missionId: 'M-20260923-Sabcd1234' });
    expect(seen).toEqual({ parentRoot: path.resolve(parent), limb: 'auth', state: 'done' });
  });

  it('a throwing sync changes neither the exit code nor the human line', () => {
    const parent = seed();
    const c = collect();
    const code = main(['auth', 'done'], { cwd: parent, now, ...c.io, syncLease: () => { throw new Error('boom'); } });
    expect(code).toBe(0);
    expect(c.stdout()).toBe('auth: unknown → done since 2026-09-23T02:00:00.000Z window=w-a\n');
    expect(c.stderr()).toBe('');

    const j = collect();
    expect(main(['auth', 'done', '--json'], { cwd: parent, now, ...j.io, syncLease: () => { throw new Error('boom'); } })).toBe(0);
    expect(JSON.parse(j.stdout()).lease).toEqual({ outcome: 'skipped:sync-threw:boom', missionId: null });
  });

  it('a refused lane write never reaches the sync, and its --json keys are unchanged', () => {
    const parent = seed();
    let calls = 0;
    const c = collect();
    expect(main(['auth', 'running', '--json'], { cwd: parent, ...c.io, syncLease: () => { calls += 1; } })).toBe(1);
    expect(Object.keys(JSON.parse(c.stdout())).sort()).toEqual(['allowlist', 'error']);
    expect(main(['--list', '--json'], { cwd: parent, ...collect().io, syncLease: () => { calls += 1; } })).toBe(0);
    expect(calls).toBe(0);
  });

  it('the default sync is wired: with no session id in the env it skips before opening any store', () => {
    const parent = seed();
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
    vi.stubEnv('CLAUDE_SESSION_ID', '');
    const c = collect();
    expect(main(['auth', 'done', '--json'], { cwd: parent, now, ...c.io })).toBe(0);
    expect(JSON.parse(c.stdout()).lease).toEqual({ outcome: 'skipped:no-session-id', missionId: null });
    // No store directory appeared under the tmp parent.
    expect(fs.existsSync(path.join(parent, '.artibot', 'runtime'))).toBe(false);
  });
});
