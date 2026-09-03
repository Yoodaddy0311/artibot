/**
 * Shared harness for StateStore tests.
 *
 * Everything the store touches outside its own directory is a port, so the
 * harness supplies a tmpdir project root, a fake git resolver, a recording
 * ledger port and a hand-cranked clock. No test in this directory runs `git`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../../lib/project-state/state-manager.js';

export const MISSION_ID = 'M-20260902-001';
export const T0 = Date.parse('2026-09-02T00:00:00.000Z');

/** @returns {string} A fresh tmpdir that the caller must remove. */
export function makeProjectRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'artibot-state-'));
}

/** @param {string} dir - Directory to remove, ignoring failures. */
export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A ledger port that records what it was handed.
 *
 * The return SHAPE is the real writer's: `lib/runtime/event-writer.js#writeEvent`
 * yields `{ok: true, …}` on success and `{ok: false, reason}` on failure, and
 * never emits `appended`. A stub shaped `{appended: …}` was what let the store's
 * refusal predicate look correct while missing every real failure — a fixture
 * whose shape differs from production proves nothing about production.
 *
 * @param {object} [opts] - Behaviour switches.
 * @param {boolean} [opts.refuse=false] - Return `{ok:false, reason}` instead of accepting.
 * @param {boolean} [opts.throws=false] - Throw instead of returning.
 * @param {boolean} [opts.legacyAppendedShape=false] - Use the older `{appended: …}`
 *   shape, which simpler in-process ports still return and the predicate must
 *   keep accepting.
 * @returns {{port: Function, events: object[], state: object}} The port, its
 *   recording, and the live switch object a test may mutate.
 */
export function makeLedgerPort(opts = {}) {
  const events = [];
  // `opts` is kept live rather than copied, so a test can flip `refuse` or
  // `throws` mid-run and exercise recovery on ONE store.
  const state = { ...opts };
  const port = (event) => {
    if (state.throws) throw new Error('ledger unavailable');
    if (state.legacyAppendedShape) {
      if (state.refuse) return { appended: false, errors: ['event not in allowlist'] };
      events.push(event);
      return { appended: true };
    }
    if (state.refuse) return { ok: false, reason: 'event not in allowlist' };
    events.push(event);
    return { ok: true, path: '<stub>', event: event.event, seq: events.length, bytes: 0 };
  };
  return { port, events, state };
}

/** A clock the test advances by hand. */
export function makeClock(startMs = T0) {
  let ms = startMs;
  return {
    now: () => new Date(ms),
    advance: (delta) => { ms += delta; },
    set: (value) => { ms = value; },
  };
}

/**
 * Build a store over a tmpdir with a `.git` common dir.
 *
 * @param {object} [overrides] - Options merged into `createStateStore`.
 * @returns {object} `{store, projectRoot, ledger, clock}`.
 */
export function makeStore(overrides = {}) {
  const projectRoot = makeProjectRoot();
  const ledger = makeLedgerPort(overrides.ledgerOpts);
  const clock = makeClock();
  const store = createStateStore({
    projectRoot,
    sessionId: 'sess-test',
    project: 'artibot',
    appendEvent: ledger.port,
    resolveGitCommonDir: () => '.git',
    now: clock.now,
    ...overrides.storeOptions,
  });
  return { store, projectRoot, ledger, clock };
}

/** A schema-valid mission. */
export function mission(overrides = {}) {
  return {
    title: 'adaptive-intelligence-routing',
    status: 'executing',
    intent: { path: `missions/${MISSION_ID}/intent.md`, revision: 2 },
    plan: { path: `missions/${MISSION_ID}/plan.md`, revision: 5 },
    ...overrides,
  };
}

/** A schema-valid task node. */
export function task(id, overrides = {}) {
  return { id, mission_id: MISSION_ID, status: 'queued', ...overrides };
}

/** A Task Graph holding the given tasks. */
export function graph(tasks, missionId = MISSION_ID) {
  return { schema_version: 1, mission_id: missionId, tasks };
}

/** Seed a store with one mission and its graph, returning the commit result. */
export function seed(store, tasks = [], missionOverrides = {}) {
  return store.updateMission(MISSION_ID, () => mission(missionOverrides), {
    graph: graph(tasks),
    reason: 'seed',
  });
}
