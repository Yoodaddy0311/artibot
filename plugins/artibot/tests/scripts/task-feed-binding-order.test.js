/**
 * `scripts/split/task-feed.mjs#resolveRunMission` — SH-11 pre-flip item L2: the
 * plan's OWN key is looked at before a binding record is read or judged.
 *
 * `readMissionBinding` is not a cheap probe for a plan that carries a record: it
 * parses the record, compares it with `plan.runId`, and then reads `run.json`
 * (the F3 cross-check), which throws on a damaged file. `resolveRunMission` used
 * to call it for EVERY run, before it asked the canary switch, so a run that
 * carried a record while the key was OFF still had its record judged and its
 * `run.json` opened — the switch did not make the OFF path inert. The siblings
 * (`readWorkerState`, `writeWorkerState`) already ask in the right order: the
 * plan's key, then the switch, then the record. These tests pin the same order
 * for the resolver every feed and lease sync goes through.
 *
 * The witness for "the record was not read" is a damaged `run.json`: the record
 * judge cannot finish without opening it, so a switch-OFF call that returns an
 * answer did not run the judge.
 *
 * WHAT THIS CANNOT SEE (rules section 9): a stub of `readMissionBinding` — the
 * module graph is real, so "never called" is shown by a damaged file it would
 * have tripped on, not by a call counter. Two processes racing on the files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { syncLaneLease } from '../../scripts/split/lane-lease.mjs';
import { feedLimb, resolveRunMission } from '../../scripts/split/task-feed.mjs';

const SESSION = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20261019-Sabcd1234';
const RUN = 'split-t';
const PLAN = { runId: RUN, limbs: [{ limb: 'auth', affectedPaths: ['lib/auth/**'] }] };
const OFF = { split: { missionBinding: { enabled: false } } };
const ON = { split: { missionBinding: { enabled: true } } };
const RECORD = { mission_id: MISSION, run_id: RUN, generation: 1, bound_at: '2026-10-19T04:00:00.000Z', bound_by_session: SESSION };
const DAMAGED = '{ this is not json';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-task-feed-order-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const splitDir = () => path.join(root, '.artibot', 'split');

/** plan.json (with a record when `binding` is given) and run.json under the tmp root. */
function seedRunFiles({ binding = null, run = JSON.stringify({ runId: RUN }) } = {}) {
  fs.mkdirSync(splitDir(), { recursive: true });
  fs.writeFileSync(path.join(splitDir(), 'plan.json'), JSON.stringify({ ...PLAN, ...(binding ? { missionBinding: binding } : {}) }));
  fs.writeFileSync(path.join(splitDir(), 'run.json'), run);
}

function makeStore() {
  const store = createStateStore({ projectRoot: root, sessionId: SESSION, renderProjectionFile: false, appendEvent: () => ({ ok: true }) });
  const seeded = store.updateMission(MISSION, () => ({ status: 'executing', intent: { path: 'i.md', revision: 1 }, plan: { path: 'p.md', revision: 1 } }), { reason: 'test.seed' });
  expect(seeded.ok).toBe(true);
  return store;
}

const resolve = (store, honorBinding) => resolveRunMission({ parentRoot: root, state: store.getState(), sessionId: SESSION, honorBinding });

describe('L2 — the plan\'s key first, the switch second, the record last', () => {
  it('switch OFF: a plan that carries a record is answered `legacy` + disabled WITHOUT the record being read — a damaged run.json cannot trip it', () => {
    seedRunFiles({ binding: RECORD, run: DAMAGED });
    const store = makeStore();
    expect(resolve(store, false)).toEqual({ mode: 'legacy', missionId: MISSION, binding: { status: 'disabled' } });
    expect(resolve(store, () => false)).toEqual({ mode: 'legacy', missionId: MISSION, binding: { status: 'disabled' } });
    expect(resolve(store, undefined)).toEqual({ mode: 'legacy', missionId: MISSION, binding: { status: 'disabled' } });
  });

  it('CONTROL — switch ON: the same files ARE judged, and the damaged run.json is loud (the record is read only for a run that honours it)', () => {
    seedRunFiles({ binding: RECORD, run: DAMAGED });
    expect(() => resolve(makeStore(), true)).toThrow(SyntaxError);
  });

  it('CONTROL — switch ON with intact files binds, so the OFF answer above is the switch, not a broken fixture', () => {
    seedRunFiles({ binding: RECORD });
    expect(resolve(makeStore(), true)).toMatchObject({ mode: 'bound', missionId: MISSION });
  });

  it('no key at all: the switch is never asked (not even a throwing one) and a damaged run.json is not opened', () => {
    seedRunFiles({ run: DAMAGED });
    let asked = 0;
    const port = () => { asked += 1; throw new Error('config must not be read for a plan with no record'); };
    expect(resolve(makeStore(), port)).toEqual({ mode: 'legacy', missionId: MISSION });
    expect(asked).toBe(0);
  });

  it('a missing plan.json is the legacy answer, as before; a damaged one is loud, as before', () => {
    fs.mkdirSync(splitDir(), { recursive: true });
    const store = makeStore();
    expect(resolve(store, true)).toEqual({ mode: 'legacy', missionId: MISSION });
    fs.writeFileSync(path.join(splitDir(), 'plan.json'), DAMAGED);
    expect(() => resolve(store, false)).toThrow(SyntaxError);
  });

  it('switch ON, record vanished between the key check and the record read: legacy, not a crash', () => {
    // The two reads are two moments; a writer that drops the key in between must read as "no record".
    seedRunFiles({ binding: RECORD });
    const store = makeStore();
    const planPath = path.join(splitDir(), 'plan.json');
    const withRecord = fs.readFileSync(planPath, 'utf-8');
    let asked = 0;
    const port = () => {
      asked += 1;
      fs.writeFileSync(planPath, JSON.stringify(PLAN)); // the key is gone by the time the record is read
      return true;
    };
    expect(resolve(store, port)).toEqual({ mode: 'legacy', missionId: MISSION });
    expect(asked).toBe(1);
    expect(withRecord).toContain('missionBinding');
  });
});

describe('L2 — what the OFF path looks like from the callers', () => {
  it('feedLimb with the key OFF and a damaged run.json still feeds by the legacy rule (it used to skip as store-threw)', () => {
    seedRunFiles({ binding: RECORD, run: DAMAGED });
    const store = makeStore();
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store, config: OFF });
    expect(r).toMatchObject({ fed: true, skipped: null, missionId: MISSION, claim: 'claimed', binding: { status: 'disabled' } });
  });

  it('syncLaneLease with the key OFF and a damaged run.json renews the legacy lease (it used to skip as store-threw)', () => {
    seedRunFiles({ binding: RECORD });
    const store = makeStore();
    expect(feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => store, config: OFF }).claim).toBe('claimed');
    fs.writeFileSync(path.join(splitDir(), 'run.json'), DAMAGED);
    const r = syncLaneLease({ parentRoot: root, limb: 'auth', state: 'active', sessionId: SESSION }, { openStore: () => store, config: OFF });
    expect(r).toMatchObject({ outcome: 'renewed', missionId: MISSION, binding: { status: 'disabled' } });
  });

  it('CONTROL — with the key ON the damaged file is the record judge\'s to refuse: feedLimb skips (record-only, never a throw)', () => {
    seedRunFiles({ binding: RECORD, run: DAMAGED });
    const r = feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION }, { openStore: () => makeStore(), config: ON });
    expect(r.fed).toBe(false);
    expect(r.skipped).toMatch(/^store-threw:/);
  });
});
