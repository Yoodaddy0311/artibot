/**
 * One deterministic `/split` lifecycle with the SH-11 key OFF, as a transcript.
 *
 * Shared by `tests/scripts/split-switch-off-identity.test.js` and by whoever
 * regenerates its golden. The scenario is the whole OFF path the SH-11 pre-flip
 * work could have touched, in order, against REAL files and a REAL StateStore
 * under a tmpdir, with every clock injected:
 *
 *   seed mission -> feed (asked to bind, key off) -> lane-state active / review
 *   / done, each followed by the lease sync -> record a fork point in plan.json
 *
 * and it returns everything observable: what each call returned, the bytes of
 * `run.json` and `plan.json`, the store journal, the ledger rows the store
 * appended, and the directory listing of `.artibot/split` (so a stray lock or
 * temp file shows). Absolute tmp paths are replaced by `<ROOT>`.
 *
 * It imports the code under test by relative path on purpose: copied unchanged
 * into a `git archive` of the BASE tree it runs the BASE code, which is how the
 * golden in `tests/fixtures/split-switch-off-golden.json` was produced.
 *
 * @module tests/helpers/split-off-scenario
 */

import fs from 'node:fs';
import path from 'node:path';
import { updatePlanJson } from '../../lib/git/split-run-file.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { syncLaneLease } from '../../scripts/split/lane-lease.mjs';
import { setLaneState } from '../../scripts/split/lane-state.mjs';
import { feedLimb } from '../../scripts/split/task-feed.mjs';

export const SESSION = 'abcd1234-ef56-7890-1234-567890abcdef';
export const MISSION = 'M-20260929-Sabcd1234';
export const RUN = 'split-off-1';
const T0 = Date.parse('2026-09-29T05:00:00.000Z');
const HOUR = 3_600_000;
const OFF = { split: { missionBinding: { enabled: false } } };
const PLAN = {
  runId: RUN,
  base: 'b'.repeat(40),
  limbs: [
    { limb: 'auth', affectedPaths: ['lib/auth/**', 'tests/auth/**'] },
    { limb: 'billing', affectedPaths: ['lib/billing.js'] },
  ],
};

/**
 * Run the scenario with `Date` frozen to the scenario's own hand-cranked clock.
 *
 * WHY THE WHOLE `Date` AND NOT JUST THE `now` PORTS: the legacy feed's graph
 * merge stamps `created_at` / `updated_at` with `new Date()` (`task-feed.mjs#
 * mergeAndWrite` passes no port), and those stamps land in the journal and in
 * the digest of the `state.updated` idempotency key — so a transcript with a
 * live wall clock in it could never be compared byte for byte. The override is
 * restored in a `finally`, and nothing in the scenario contends for a lock (the
 * one thing a frozen `Date.now()` would hang).
 *
 * @param {string} root - An existing empty directory (the parent root).
 * @returns {object} The transcript, JSON-safe, tmp paths replaced.
 */
export function runOffScenario(root) {
  const clock = { t: T0 };
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.t);
      else super(...args);
    }

    static now() { return clock.t; }
  }
  globalThis.Date = FrozenDate;
  try {
    return scenario(root, clock);
  } finally {
    globalThis.Date = RealDate;
  }
}

/** @param {string} root @param {{ t: number }} clock @returns {object} */
function scenario(root, clock) {
  const splitDir = path.join(root, '.artibot', 'split');
  fs.mkdirSync(splitDir, { recursive: true });
  fs.writeFileSync(path.join(splitDir, 'plan.json'), `${JSON.stringify(PLAN, null, 2)}\n`);
  fs.writeFileSync(path.join(splitDir, 'run.json'), `${JSON.stringify({ runId: RUN }, null, 2)}\n`);

  const now = () => new Date(clock.t);
  /** @type {object[]} */ const ledger = [];
  const store = createStateStore({
    projectRoot: root,
    project: 'artibot-off-identity',
    sessionId: SESSION,
    renderProjectionFile: false,
    now,
    appendEvent: (e) => { ledger.push(e); return { ok: true }; },
  });
  const seeded = store.updateMission(MISSION, () => ({
    status: 'executing',
    intent: { path: '.artibot/intent.md', revision: 1 },
    plan: { path: '.artibot/plan.md', revision: 1 },
  }), { reason: 'test.seed' });
  if (!seeded.ok) throw new Error(`scenario seed refused: ${seeded.errors?.[0]}`);

  /** @type {Array<[string, unknown]>} */ const steps = [];
  const ports = { openStore: () => store, now, config: OFF };

  steps.push(['feed auth (bind asked, key off)', feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION, bind: true }, ports)]);
  steps.push(['feed auth again', feedLimb({ parentRoot: root, plan: PLAN, limb: 'auth', sessionId: SESSION, bind: true }, ports)]);
  for (const state of ['active', 'review', 'done']) {
    clock.t += HOUR;
    steps.push([`lane-state auth ${state}`, setLaneState({ limb: 'auth', state, window: 'w-auth', note: `n-${state}` }, {
      cwd: root, now, config: OFF, sessionId: SESSION, openStore: () => store,
    })]);
    steps.push([`lease sync ${state}`, syncLaneLease({ parentRoot: root, limb: 'auth', state, sessionId: SESSION }, { openStore: () => store, config: OFF })]);
  }
  clock.t += HOUR;
  steps.push(['forkPoint recorded', updatePlanJson(root, (cur) => ({
    ...cur,
    limbs: cur.limbs.map((l) => (l.limb === 'auth' ? { ...l, forkPoint: 'f'.repeat(40) } : l)),
  }))]);

  const text = (name) => fs.readFileSync(path.join(splitDir, name), 'utf-8');
  const transcript = {
    steps,
    runJson: text('run.json'),
    planJson: text('plan.json'),
    journal: fs.readFileSync(store.paths.journal, 'utf-8'),
    ledger,
    splitDir: fs.readdirSync(splitDir).sort(),
    graph: store.getTaskGraph(MISSION),
    leases: store.getState().task_leases,
  };
  return scrub(JSON.parse(JSON.stringify(transcript)), root);
}

/**
 * Replace the tmp root in every string (both slash spellings) with `<ROOT>`, and
 * spell a path that starts there with forward slashes, so the transcript is the
 * same on every host.
 *
 * @param {unknown} v
 * @param {string} root
 * @returns {unknown}
 */
function scrub(v, root) {
  if (typeof v === 'string') {
    const swapped = v.split(root).join('<ROOT>').split(root.replace(/\\/g, '/')).join('<ROOT>');
    return swapped.startsWith('<ROOT>') ? swapped.replace(/\\/g, '/') : swapped;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, root));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, root)]));
  return v;
}
