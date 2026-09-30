/**
 * SH-11 switch OFF: what the pre-flip work changed, the legacy path must not see.
 *
 * `split.missionBinding.enabled` ships `false`, and the four pre-flip
 * conditions (lease beside the node, single-node `updateTask`, the plan.json
 * lock, the clock-free stale marker) all live in code the OFF path also walks:
 * `claimTask` got an argument, `updatePlanJson` got a lock, `split-state.js` and
 * `task-feed.mjs` were edited. "Shipped off, so nothing changes" is a claim
 * about every byte the legacy path writes and returns, and this file measures
 * it instead of asserting it.
 *
 * HOW. `tests/helpers/split-off-scenario.js` runs one whole OFF lifecycle — seed
 * a mission, feed a limb (asked to bind, key off), feed it again, lane-state
 * active / review / done each followed by the lease sync, record a fork point —
 * against real files and a real StateStore under a tmpdir, with `Date` frozen to
 * the scenario's own clock, and returns everything observable: each call's
 * return value, the bytes of `run.json` and `plan.json`, the store journal, the
 * ledger rows, the listing of `.artibot/split`, the final graph and leases.
 * `tests/fixtures/split-switch-off-golden.json` is that transcript RECORDED
 * FROM THE BASE TREE (`git archive` of ac5dfb4d, this helper copied in
 * unchanged, run twice — the two recordings are byte-equal, sha256 d336db42…).
 * The test runs the same scenario against the code in this tree and requires
 * the transcript to equal the golden.
 *
 * DO NOT REGENERATE THE GOLDEN FROM CHANGED CODE. A golden recorded from the code
 * under test measures nothing. If the OFF path must change on purpose, say so in
 * the commit, re-record from the tree BEFORE the change, and review the diff.
 *
 * WHAT THIS CANNOT SEE (rules §9):
 *  - A path the scenario does not walk: `dispatch.mjs` end to end (its own
 *    OFF tests are in split-tools.test.js and are byte-checked there), a run
 *    that is already bound and then switched OFF (tests/topology/split-state.test.js,
 *    "the OFF path adds nothing"), a legacy lane that loses a write race.
 *  - A different clock. The scenario freezes `Date`, so it cannot see a
 *    difference that only shows under a live clock.
 *  - A different host. Paths are scrubbed to `<ROOT>` and forward slashes, but
 *    the golden was recorded on Windows; nothing here proves a POSIX run.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOffScenario } from '../helpers/split-off-scenario.js';

const GOLDEN = JSON.parse(fs.readFileSync(new URL('../fixtures/split-switch-off-golden.json', import.meta.url), 'utf-8'));

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-off-identity-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('SH-11 switch OFF — byte-identical to the base tree', () => {
  it('the whole OFF lifecycle produces exactly the transcript the base code produced', () => {
    expect(runOffScenario(root)).toEqual(GOLDEN);
  });

  // The same comparison, one artifact at a time, so a failure names WHICH bytes moved.
  it.each([
    ['run.json bytes', 'runJson'],
    ['plan.json bytes', 'planJson'],
    ['the StateStore journal, line for line', 'journal'],
    ['the ledger rows the store appended', 'ledger'],
    ['the files left in .artibot/split (no stray lock, tmp or backup)', 'splitDir'],
    ['the final Task Graph', 'graph'],
    ['the final lease table', 'leases'],
    ['what every call returned, in order', 'steps'],
  ])('%s', (_label, key) => {
    expect(runOffScenario(root)[key]).toEqual(GOLDEN[key]);
  });

  it('the scenario is deterministic: a second run in a fresh root gives the same transcript', () => {
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-off-identity-'));
    try {
      expect(runOffScenario(again)).toEqual(runOffScenario(root));
    } finally {
      fs.rmSync(again, { recursive: true, force: true });
    }
  });

  it('carries no trace of the pre-flip work: no seal in run.json, no lock left, only the legacy record kinds, claims stay "claimed"', () => {
    const t = runOffScenario(root);
    expect(t.runJson).not.toContain('projection_seal');
    expect(t.splitDir).toEqual(['plan.json', 'run.json']);
    const kinds = new Set(t.journal.split('\n').filter(Boolean).map((l) => JSON.parse(l).kind));
    expect([...kinds].sort()).toEqual(['graph.upsert', 'lease.clear', 'lease.set', 'mission.upsert', 'task.upsert']);
    expect(t.steps[0][1]).toMatchObject({ claim: 'claimed' });
    expect(Object.hasOwn(t.steps[0][1], 'lease')).toBe(false); // the bound-feed key never appears on the legacy result
    expect(t.graph.tasks.find((n) => n.id === 'auth').status).toBe('done');
    expect(Object.hasOwn(t.graph.tasks[0], 'ops')).toBe(false); // the legacy feed writes no ops
  });
});
