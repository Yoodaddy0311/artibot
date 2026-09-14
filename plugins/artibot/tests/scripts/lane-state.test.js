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
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setLaneState } from '../../scripts/split/lane-state.mjs';
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
