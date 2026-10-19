/**
 * `state-manager.js` — the two commit-path changes of the SH-12 lease-tick lane
 * (backlog follow-ups c and b), measured against a REAL StateStore in a tmpdir.
 *
 *  c. STORE-ONLY COMMITS (design D11: "heartbeat is the store's, the central ledger
 *     gets only task.claimed/released"). The store used to append its own
 *     `state.updated` for EVERY commit, so a clock-driven lease renewal cost one
 *     central-ledger row per tick. `heartbeatWorker({storeOnly: true})` is the opt-out,
 *     and it is the heartbeat's alone: no other writer forwards the flag. The records
 *     of that commit carry `store_only: true`, which is what the three `ledger ⊇ store`
 *     readers key on (`journal.js#storeOnlyVersions`, tested in journal.test.js).
 *
 *  b. A SNAPSHOT THAT CANNOT BE WRITTEN. The journal is the record and the snapshot is
 *     its cache (`loadSnapshot` rebuilds from the journal). A snapshot rename that ran
 *     out of retries used to throw out of `commit` AFTER the ledger and the journal had
 *     taken the write, so callers (`lane-lease.mjs`, `lease-reclaim.js`) reported a
 *     write that had landed as one that had not. It is now a warning on an `ok:true`
 *     result.
 *
 * How the failure is made: a DIRECTORY is parked where the snapshot file goes. The
 * rename onto it fails on every platform (EISDIR on POSIX; EPERM on Windows, which the
 * store's own retry budget then spends, ~150ms) — a real filesystem refusal, not a
 * spy on a named import (tests/helpers/patient-rename.js explains why that is blind).
 *
 * What it cannot see (rules §9): a rename that fails on its first attempt and lands on
 * its third (that is `lib/core/file.js`'s own retry, pinned in tests/core/file.test.js);
 * how often a real host loses the rename (the 2026-10-01 measurement is in the
 * patient-rename helper header); concurrency (`state-updated-pairing.test.js` and
 * `file-lock-contention.test.js` own that); and the ledger side of a store-only commit
 * under the REAL writer (lease-tick-wiring.test.js drives child processes against it).
 */

import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { checkStateVersionGaps } from '../../lib/project-state/doctor-checks.js';
import {
  CAS_SKIPPED_WARNING,
  readJournal,
  reduceProjectState,
  SNAPSHOT_WRITE_FAILED_WARNING,
} from '../../lib/project-state/state-manager.js';
import {
  cleanup, makeStore, MISSION_ID, seed, T0, task,
} from './helpers.js';

const roots = [];
const store$ = (overrides) => {
  const made = makeStore(overrides);
  roots.push(made.projectRoot);
  return made;
};

afterEach(() => {
  while (roots.length > 0) cleanup(roots.pop());
});

/** One mission, one task claimed by 'a' for a minute: the next commit is version 3. */
const claimed = () => {
  const made = store$();
  seed(made.store, [task('W-1')]);
  expect(made.store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', ttlMs: 60_000 }).ok).toBe(true);
  return made;
};
const beat = (store, extra = {}) => store.heartbeatWorker({
  missionId: MISSION_ID, taskId: 'W-1', owner: 'a', ...extra,
});
const journalAt = (store, version) => readJournal(store.paths.journal).records
  .filter((r) => r.state_version === version);

describe('store-only commits — a heartbeat renewal that leaves no ledger row (design D11)', () => {
  it('commits the renewal and takes a state_version, but the ledger gains no row', () => {
    const { store, ledger, clock } = claimed();
    const rows = ledger.events.length;
    clock.advance(500);

    const out = beat(store, { heartbeatSource: 'lease-tick', reason: 'split.lease-tick', storeOnly: true });

    expect(out).toMatchObject({ ok: true, state_version: 3, storeOnly: true });
    expect(ledger.events).toHaveLength(rows);
    expect(store.getState().state_version).toBe(3);
    const at = new Date(T0 + 500).toISOString();
    expect(store.getLease(MISSION_ID, 'W-1').heartbeat_at).toBe(at);
    expect(store.getTaskGraph(MISSION_ID).tasks[0]).toMatchObject({ heartbeat_at: at, heartbeat_source: 'lease-tick' });
  });

  it('marks every record of that commit, carrying the reason the ledger row would have carried', () => {
    const { store } = claimed();
    beat(store, { heartbeatSource: 'lease-tick', reason: 'split.lease-tick', storeOnly: true });
    expect(journalAt(store, 3).map((r) => [r.kind, r.store_only, r.reason]))
      .toEqual([['task.upsert', true, 'split.lease-tick'], ['lease.set', true, 'split.lease-tick']]);
  });

  it('defaults the recorded reason the way the ledger row would have', () => {
    const { store } = claimed();
    beat(store, { storeOnly: true });
    expect(journalAt(store, 3).map((r) => r.reason)).toEqual(['worker.heartbeat:W-1', 'worker.heartbeat:W-1']);
  });

  it('marks only the commit that asked: the claim before it and an ordinary heartbeat after it carry no mark', () => {
    const { store, ledger } = claimed();
    beat(store, { storeOnly: true });
    const rows = ledger.events.length;
    beat(store);
    expect(ledger.events).toHaveLength(rows + 1);
    for (const version of [1, 2, 4]) {
      expect(journalAt(store, version).length, `v${version}`).toBeGreaterThan(0);
      expect(journalAt(store, version).some((r) => 'store_only' in r), `v${version}`).toBe(false);
    }
    expect(journalAt(store, 3).every((r) => r.store_only === true)).toBe(true);
  });

  it('leaves an ordinary heartbeat exactly as it was: one paired row, no mark, no storeOnly on the result', () => {
    const { store, ledger } = claimed();
    const rows = ledger.events.length;
    const out = beat(store);
    expect(out.ok).toBe(true);
    expect(out).not.toHaveProperty('storeOnly');
    expect(ledger.events).toHaveLength(rows + 1);
    expect(ledger.events.at(-1).data).toMatchObject({ state_version: 3, reason: 'worker.heartbeat:W-1' });
    expect(journalAt(store, 3).some((r) => 'store_only' in r || 'reason' in r)).toBe(false);
  });

  it('is the heartbeat\'s alone: claim, release and update keep their ledger row even when they are asked', () => {
    const { store, ledger } = store$();
    seed(store, [task('W-1')]);
    const rows = ledger.events.length;
    expect(store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', storeOnly: true }).ok).toBe(true);
    expect(store.updateMission(MISSION_ID, (m) => ({ ...m, title: 'again' }), { reason: 'rename', storeOnly: true }).ok).toBe(true);
    expect(store.releaseTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', storeOnly: true }).ok).toBe(true);
    expect(ledger.events).toHaveLength(rows + 3);
    expect(readJournal(store.paths.journal).records.some((r) => 'store_only' in r)).toBe(false);
  });

  it('is strict about the flag: only the boolean true opts out', () => {
    const { store, ledger } = claimed();
    for (const flag of ['true', 1, {}, 'yes']) {
      const rows = ledger.events.length;
      expect(beat(store, { storeOnly: flag }).ok, String(flag)).toBe(true);
      expect(ledger.events, String(flag)).toHaveLength(rows + 1);
    }
  });

  it('still validates and still CAS-guards: nothing is written for a stale version, a foreign owner or a missing task', () => {
    const { store, ledger } = claimed();
    const rows = ledger.events.length;
    const before = readFileSync(store.paths.journal, 'utf-8');
    expect(beat(store, { storeOnly: true, expectedVersion: 1 })).toMatchObject({ ok: false, conflict: true, currentVersion: 2 });
    expect(beat(store, { storeOnly: true, owner: 'b' }).errors[0]).toMatch(/held by 'a', not 'b'/);
    expect(store.heartbeatWorker({ missionId: MISSION_ID, taskId: 'W-9', storeOnly: true }).errors[0]).toMatch(/no task/);
    expect(ledger.events).toHaveLength(rows);
    expect(readFileSync(store.paths.journal, 'utf-8')).toBe(before);
    expect(store.getState().state_version).toBe(2);
  });

  it('keeps the CAS-skipped warning honest: a guarded store-only write has none, an unguarded one has it', () => {
    const { store } = claimed();
    expect(beat(store, { storeOnly: true, expectedVersion: 2 }).warnings).not.toContain(CAS_SKIPPED_WARNING);
    expect(beat(store, { storeOnly: true }).warnings).toContain(CAS_SKIPPED_WARNING);
  });

  it('folds like any other commit: the journal still reproduces the committed snapshot exactly', () => {
    const { store, clock } = claimed();
    clock.advance(500);
    beat(store, { heartbeatSource: 'lease-tick', storeOnly: true });
    clock.advance(500);
    beat(store);
    const { records } = readJournal(store.paths.journal);
    const { state, warnings } = reduceProjectState(records, { project: 'artibot' });
    expect(warnings).toEqual([]);
    expect(state).toEqual(store.getState());
    expect(JSON.stringify(state)).toBe(JSON.stringify(store.getState()));
  });

  it('is still counted by the store\'s own version check: no gap, no duplicate, in a run of store-only commits', () => {
    const { store, clock } = claimed();
    for (let i = 0; i < 4; i += 1) {
      clock.advance(1_000);
      expect(beat(store, { heartbeatSource: 'lease-tick', storeOnly: true }).ok).toBe(true);
    }
    const journal = readJournal(store.paths.journal).records;
    expect(checkStateVersionGaps({ journal })).toMatchObject({ status: 'pass', gaps: [], regressions: [], duplicates: [] });
    expect(journal.at(-1).state_version).toBe(6);
  });
});

describe('a snapshot that cannot be written does not fail a committed write (follow-up b)', () => {
  /** Park a directory where the snapshot file goes: a rename onto it never lands. */
  const blockSnapshot = (store) => {
    rmSync(store.paths.snapshot, { force: true });
    mkdirSync(store.paths.snapshot);
  };
  const unblockSnapshot = (store) => rmSync(store.paths.snapshot, { recursive: true, force: true });
  const warned = (out) => (out.warnings ?? []).filter((w) => w.startsWith(SNAPSHOT_WRITE_FAILED_WARNING));

  it('answers ok:true with a warning after the ledger and the journal took the write', () => {
    const { store, ledger } = store$();
    seed(store, [task('W-1')]);
    blockSnapshot(store);

    const out = store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });

    expect(out.ok).toBe(true);
    expect(out.state_version).toBe(2);
    expect(out.lease.owner).toBe('a');
    expect(warned(out)).toHaveLength(1);
    expect(warned(out)[0]).toContain('version 2');
    expect(ledger.events.map((e) => e.data.state_version)).toEqual([1, 2]);
    expect(journalAt(store, 2).map((r) => r.kind)).toEqual(['task.upsert', 'lease.set']);
  });

  it('leaves no temp file behind, and does not touch what sits at the snapshot path', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    blockSnapshot(store);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    expect(readdirSync(store.paths.dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
    expect(readdirSync(store.paths.snapshot)).toEqual([]);
  });

  it('says nothing of the kind on a healthy commit', () => {
    const { store } = store$();
    expect(warned(seed(store))).toEqual([]);
    expect(warned(store.updateMission(MISSION_ID, (m) => m, { reason: 'again' }))).toEqual([]);
  });

  it('is a cache miss, not a loss: the next read rebuilds the committed state from the journal', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    blockSnapshot(store);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });

    expect(store.getState().state_version).toBe(2);
    expect(store.getLease(MISSION_ID, 'W-1').owner).toBe('a');
    expect(store.getTaskGraph(MISSION_ID).tasks[0]).toMatchObject({ status: 'claimed', owner: 'a' });
  });

  it('heals on the next commit that can write it: the snapshot lands at the newest version', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    blockSnapshot(store);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    unblockSnapshot(store);

    const next = beat(store);

    expect(next.ok).toBe(true);
    expect(warned(next)).toEqual([]);
    expect(JSON.parse(readFileSync(store.paths.snapshot, 'utf-8')).state_version).toBe(3);
    expect(store.reconcile()).toMatchObject({ drifted: false, snapshotVersion: 3, storeVersion: 3 });
  });

  it('reports the stale cache as drift until it heals, instead of hiding it', () => {
    const { store } = store$();
    seed(store, [task('W-1')]);
    blockSnapshot(store);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
    unblockSnapshot(store);
    // The snapshot file is absent while the journal holds version 2.
    expect(store.reconcile()).toMatchObject({ drifted: true, storeVersion: 2, snapshotVersion: null });
  });

  it('covers a store-only commit too, and the result still says so', () => {
    const { store, ledger } = store$();
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', ttlMs: 60_000 });
    const rows = ledger.events.length;
    blockSnapshot(store);

    const out = beat(store, { heartbeatSource: 'lease-tick', storeOnly: true });

    expect(out).toMatchObject({ ok: true, state_version: 3, storeOnly: true });
    expect(warned(out)).toHaveLength(1);
    expect(ledger.events).toHaveLength(rows);
    expect(store.getTaskGraph(MISSION_ID).tasks[0].heartbeat_source).toBe('lease-tick');
  });
});
