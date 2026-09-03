/**
 * Firewall — every StateStore write is paired 1:1 with one
 * `state.updated{state_version}` in the ledger.
 *
 * This gate exists because the pairing is what makes lost updates DETECTABLE.
 * `state_version` increases monotonically and the matching event lands in the
 * same transaction, so a gap in the ledger's version sequence is direct
 * evidence that a write was lost (design ARTIBOT-5.0-DESIGN.md §3.6; `/doctor`
 * Check 8). If a store write can ever commit without its event, that check
 * silently stops working and nothing else in the system notices.
 *
 * ── What this gate does NOT cover ─────────────────────────────────────────
 * Stated here rather than left implicit, so the gate does not itself become
 * the next false-confidence signal:
 *
 *  - **Real concurrency.** Every case below is single-process and
 *    single-threaded. `withFileLock` is advisory and fail-OPEN, so contention
 *    behaviour under N real processes is NOT measured here. The sibling gate
 *    `ledger-append-survival.test.js` (T-20) owns the 3-process 60/60 append
 *    measurement; this file owns the pairing rule only.
 *  - **The real ledger writer.** The port is a recording stub. Envelope
 *    completion (`v`/`ts`/`pid`/`seq`), the 4KB line cap and the vocabulary
 *    allowlist are T-20's, and a change there is not visible here.
 *  - **Windows `'a'`-flag atomicity.** Unmeasured; not claimed.
 *  - **state.yaml.** The projection is deliberately outside the transaction,
 *    so a failed render cannot fail a committed write. Its determinism IS
 *    checked below, but its absence is not a pairing violation.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeEvent } from '../../lib/runtime/event-writer.js';
import { createStateStore, readJournal, reduceProjectState } from '../../lib/project-state/state-manager.js';
import {
  cleanup, makeStore, mission, MISSION_ID, seed, task,
} from '../project-state/helpers.js';

const roots = [];
const store$ = (overrides) => {
  const made = makeStore(overrides);
  roots.push(made.projectRoot);
  return made;
};

afterEach(() => {
  while (roots.length > 0) cleanup(roots.pop());
});

/** Versions carried by the recorded `state.updated` events, in order. */
const ledgerVersions = (ledger) => ledger.events
  .filter((e) => e.event === 'state.updated')
  .map((e) => e.data.state_version);

describe('1:1 pairing — one committed write, one state.updated', () => {
  it('pairs a mission create', () => {
    const { store, ledger } = store$();
    const out = seed(store);
    expect(ledgerVersions(ledger)).toEqual([out.state_version]);
  });

  it('pairs every write across a full task lifecycle', () => {
    const { store, ledger } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    store.heartbeatWorker({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    store.releaseTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', status: 'done' });

    expect(ledgerVersions(ledger)).toEqual([1, 2, 3, 4]);
    expect(store.getState().state_version).toBe(4);
  });

  it('leaves no gap in the version sequence — a gap IS the lost-update signal', () => {
    const { store, ledger } = store$();
    for (let i = 0; i < 12; i += 1) {
      store.updateMission(MISSION_ID, () => mission(), { reason: `write-${i}` });
    }
    const versions = ledgerVersions(ledger);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(store.reconcile({ ledgerVersions: versions }))
      .toMatchObject({ gaps: [], missingInStore: [], extraInStore: [] });
  });

  it('emits an envelope carrying every field the allowlist requires', () => {
    const { store, ledger } = store$();
    seed(store);
    const event = ledger.events[0];
    expect(event).toMatchObject({
      event: 'state.updated',
      mission_id: MISSION_ID,
      session_id: 'sess-test',
      source: 'supervisor',
      data: { state_version: 1, status: 'executing', reason: 'seed' },
    });
    // `data.status` is the mission_status vocabulary, not the task one.
    expect(['queued', 'planning', 'executing', 'blocked', 'reviewing', 'completed', 'failed'])
      .toContain(event.data.status);
  });

  it('never emits a second event for one write', () => {
    const { store, ledger } = store$();
    // A single commit that produces TWO journal records still pairs with ONE
    // event: the transaction is the unit, not the record.
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    const { records } = readJournal(store.paths.journal);
    expect(records.filter((r) => r.state_version === 2)).toHaveLength(2);
    expect(ledgerVersions(ledger)).toEqual([1, 2]);
  });
});

describe('a refused write emits nothing and changes nothing', () => {
  it('emits no event when validation refuses the draft', () => {
    const { store, ledger } = store$();
    store.updateMission(MISSION_ID, () => mission({ status: 'running' }), { reason: 'invalid' });
    expect(ledger.events).toHaveLength(0);
    expect(store.getState().state_version).toBe(0);
  });

  it('emits no event on a CAS conflict', () => {
    const { store, ledger } = store$();
    seed(store);
    store.updateMission(MISSION_ID, (m) => m, { expectedVersion: 0, reason: 'stale' });
    expect(ledgerVersions(ledger)).toEqual([1]);
  });
});

describe('the ledger is fail-closed — a refused event abandons the write', () => {
  it('does not commit when the port returns {appended:false}', () => {
    const { store } = store$({ ledgerOpts: { refuse: true } });
    const out = seed(store);
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toMatch(/ledger refused state\.updated/);
    expect(out.errors.join(' ')).toMatch(/store write abandoned/);
    expect(store.getState().state_version).toBe(0);
    expect(readJournal(store.paths.journal).records).toEqual([]);
  });

  it('does not commit when the port throws', () => {
    const { store } = store$({ ledgerOpts: { throws: true } });
    const out = seed(store);
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toMatch(/ledger port threw/);
    expect(store.getState().state_version).toBe(0);
  });

  it('leaves no version to skip — the next write takes the number the abandoned one did not', () => {
    const { store, ledger } = store$({ ledgerOpts: { refuse: true } });
    expect(seed(store).ok).toBe(false);
    ledger.state.refuse = false;
    const recovered = seed(store);
    expect(recovered.ok).toBe(true);
    expect(recovered.state_version).toBe(1);
    expect(ledgerVersions(ledger)).toEqual([1]);
  });
});

describe('CAS conflict, then retry', () => {
  it('reports the current version, and the retry at that version commits once', () => {
    const { store, ledger } = store$();
    seed(store);
    const stale = store.updateMission(MISSION_ID, (m) => ({ ...m, status: 'reviewing' }), {
      expectedVersion: 0, reason: 'stale',
    });
    expect(stale).toMatchObject({ ok: false, conflict: true, currentVersion: 1 });

    const retry = store.updateMission(MISSION_ID, (m) => ({ ...m, status: 'reviewing' }), {
      expectedVersion: stale.currentVersion, reason: 'retry',
    });
    expect(retry.state_version).toBe(2);
    expect(ledgerVersions(ledger)).toEqual([1, 2]);
    expect(store.getMission(MISSION_ID).status).toBe('reviewing');
  });

  it('two racing writers produce two versions, not one lost update', () => {
    const { store, ledger } = store$();
    seed(store);
    const base = store.getState().state_version;

    const a = store.updateMission(MISSION_ID, (m) => ({ ...m, title: 'A' }), {
      expectedVersion: base, reason: 'writer-a',
    });
    const b = store.updateMission(MISSION_ID, (m) => ({ ...m, title: 'B' }), {
      expectedVersion: base, reason: 'writer-b',
    });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, conflict: true });

    const bRetry = store.updateMission(MISSION_ID, (m) => ({ ...m, title: 'B' }), {
      expectedVersion: b.currentVersion, reason: 'writer-b-retry',
    });
    expect(bRetry.ok).toBe(true);
    expect(ledgerVersions(ledger)).toEqual([1, 2, 3]);
    expect(store.getMission(MISSION_ID).title).toBe('B');
  });
});

describe('the projection is a regenerable view of the store', () => {
  it('re-rendering reproduces the file on disk byte for byte', () => {
    const { store } = store$();
    seed(store, [
      task('W-1', { owner: 'routing-worker', status: 'executing', file_ownership: ['lib/routing/**'] }),
      task('W-2', { status: 'blocked', blockers: ['gate:3'] }),
    ]);
    const onDisk = readFileSync(store.paths.projection, 'utf-8');
    expect(store.renderProjection()).toBe(onDisk);
  });

  it('a deleted projection is reproduced identically', () => {
    const { store } = store$();
    seed(store, [task('W-1', { owner: 'w', status: 'executing' })]);
    const before = readFileSync(store.paths.projection, 'utf-8');
    writeFileSync(store.paths.projection, 'corrupted by hand\n');
    store.writeProjection();
    expect(readFileSync(store.paths.projection, 'utf-8')).toBe(before);
  });

  it('folding the journal reproduces the committed snapshot exactly', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    store.heartbeatWorker({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });

    const { records } = readJournal(store.paths.journal);
    const { state, warnings } = reduceProjectState(records, { project: 'artibot' });
    expect(warnings).toEqual([]);
    expect(state).toEqual(store.getState());
    expect(JSON.stringify(state)).toBe(JSON.stringify(store.getState()));
  });

  it('a projection rendered from a rebuilt store matches one rendered from the snapshot', () => {
    const { store } = store$();
    seed(store, [task('W-1', { owner: 'w', status: 'executing' })]);
    const fromSnapshot = store.renderProjection();
    writeFileSync(store.paths.snapshot, '');
    expect(store.renderProjection()).toBe(fromSnapshot);
  });
});

describe('the event tells the truth about the transition it records', () => {
  it('reports a removed mission with the status it actually held', () => {
    const { store, ledger } = store$();
    store.updateMission(MISSION_ID, () => mission({ status: 'completed' }), { reason: 'finish' });
    store.updateMission(MISSION_ID, () => null, { reason: 'archive' });
    const archived = ledger.events.at(-1);
    expect(archived.data.reason).toBe('archive');
    // Not 'failed': the mission left active_missions completed, and the event
    // must not turn an archive into a failure.
    expect(archived.data.status).toBe('completed');
  });
});

describe('the refusal predicate is measured against the REAL writer', () => {
  // A′ (T-51): every case above drives a stub. A stub agrees with whatever
  // predicate you wrote, so it cannot tell you the predicate matches
  // production. These two drive `lib/runtime/event-writer.js#writeEvent`
  // itself — the layer rule binds lib/, not tests/ — and are the only cases
  // here that would have caught the `{appended:false}`-only check reading
  // every real writer failure as success.
  const realStore = (projectRoot, writerOpts = {}) => createStateStore({
    projectRoot,
    sessionId: 'sess-real',
    project: 'artibot',
    resolveGitCommonDir: () => '.git',
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    appendEvent: (envelope) => writeEvent(projectRoot, envelope, writerOpts),
  });

  it('commits when the real writer returns {ok:true} and the line lands on disk', () => {
    const { projectRoot } = store$();
    const store = realStore(projectRoot);

    const out = seed(store);
    expect(out.ok).toBe(true);
    expect(out.state_version).toBe(1);

    const ledger = path.join(projectRoot, '.artibot', 'runtime', 'ledger.jsonl');
    const lines = readFileSync(ledger, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const updated = lines.filter((l) => l.event === 'state.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0].data.state_version).toBe(1);
  });

  it('abandons the write when the real writer returns {ok:false}', () => {
    const { projectRoot } = store$();
    // A 1-byte line cap makes the writer reject for a real, writer-owned
    // reason (`line-too-large:<n>`) rather than a reason the test invented.
    const store = realStore(projectRoot, { maxLineBytes: 1 });

    const out = seed(store);
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toMatch(/ledger refused state\.updated/);
    expect(out.errors.join(' ')).toMatch(/line-too-large/);
    expect(out.errors.join(' ')).toMatch(/store write abandoned/);

    // The store must be untouched: no version, no journal.
    expect(store.getState().state_version).toBe(0);
    expect(readJournal(store.paths.journal).records).toEqual([]);
  });
});

describe('both port shapes count as a refusal', () => {
  it.each([
    ['the real writer shape {ok:false}', {}],
    ['the legacy in-process shape {appended:false}', { legacyAppendedShape: true }],
  ])('%s abandons the write', (_label, extra) => {
    const { store } = store$({ ledgerOpts: { refuse: true, ...extra } });
    const out = seed(store);
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toMatch(/ledger refused state\.updated/);
    expect(store.getState().state_version).toBe(0);
  });

  it('a port that returns nothing is NOT a refusal — silence means appended', () => {
    const { projectRoot } = store$();
    const store = createStateStore({
      projectRoot, sessionId: 's', project: 'artibot',
      resolveGitCommonDir: () => '.git',
      appendEvent: () => undefined,
    });
    expect(seed(store).ok).toBe(true);
  });
});
