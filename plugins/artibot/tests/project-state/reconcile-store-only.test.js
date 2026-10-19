/**
 * `reconcile.js#compareLedger` and the store-only heartbeat (design D11, follow-up c).
 *
 * `extraInStore` ("in the store, not in the ledger") is the BROKEN invariant: a write landed with
 * no event. A store-only commit (`heartbeatWorker({storeOnly: true})`) has no event by design, so
 * the comparison must leave the versions the JOURNAL declares store-only
 * (`journal.js#storeOnlyVersions`) out of `extraInStore` — and list them under `storeOnly`, so a
 * reader can tell "nothing extra" from "extra, but declared".
 *
 * What is measured, against a REAL store whose ledger port records what it was handed: the
 * partition `store versions = ledger ∪ declared store-only` reads clean; an undeclared version
 * beside declared ones is still extra; a journal with its marks stripped reads every one of them
 * extra (so the declaration is what is holding the verdict); a hole in the sequence is still a gap.
 *
 * What it cannot see (rules §9): `reconcileStore` is handed `ledgerVersions` by its caller, and no
 * production caller supplies them today (`lib/checkpoint/resume-controller.js` passes none, pinned
 * in resume-controller.test.js) — so this exemption has no live reader yet; it keeps the comparison
 * true for the day one appears. The live `ledger ⊇ store` reader is `/doctor` Check 8
 * (doctor-checks-store-only.test.js).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, makeStore, MISSION_ID, seed, task } from './helpers.js';

const roots = [];
afterEach(() => { while (roots.length > 0) cleanup(roots.pop()); });

/** v1 seed, v2 claim (both paired), v3 and v4 store-only beats, v5 an ordinary beat (paired). */
const worked = () => {
  const made = makeStore();
  roots.push(made.projectRoot);
  const { store, clock } = made;
  seed(store, [task('W-1')]);
  store.claimTask({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', ttlMs: 60_000 });
  for (let i = 0; i < 2; i += 1) {
    clock.advance(1_000);
    store.heartbeatWorker({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a', heartbeatSource: 'lease-tick', storeOnly: true });
  }
  clock.advance(1_000);
  store.heartbeatWorker({ missionId: MISSION_ID, taskId: 'W-1', owner: 'a' });
  return made;
};
const ledgerVersions = (ledger) => ledger.events.map((e) => e.data.state_version);

describe('reconcile — store-only versions are not extra-in-store', () => {
  it('reads the partition clean: ledger [1, 2, 5] + declared [3, 4] = the store\'s five versions', () => {
    const { store, ledger } = worked();
    expect(ledgerVersions(ledger)).toEqual([1, 2, 5]);

    expect(store.reconcile({ ledgerVersions: ledgerVersions(ledger) })).toMatchObject({
      ok: true, drifted: false, gaps: [], missingInStore: [], extraInStore: [], storeOnly: [3, 4], storeVersion: 5,
    });
  });

  it('lists the declared versions even when no ledger was supplied, and compares nothing', () => {
    const { store } = worked();
    expect(store.reconcile()).toMatchObject({ gaps: [], missingInStore: [], extraInStore: [], storeOnly: [3, 4] });
  });

  it('reports no declaration for a store that never wrote a store-only commit', () => {
    const made = makeStore();
    roots.push(made.projectRoot);
    seed(made.store);
    expect(made.store.reconcile({ ledgerVersions: [1] })).toMatchObject({ extraInStore: [], storeOnly: [] });
  });

  it('still names a version that has no ledger row and no declaration, beside the declared ones', () => {
    const { store, ledger } = worked();
    // The ledger is missing the ordinary beat's row (version 5): a write that landed with no event.
    const out = store.reconcile({ ledgerVersions: ledgerVersions(ledger).filter((v) => v !== 5) });
    expect(out.extraInStore).toEqual([5]);
    expect(out.storeOnly).toEqual([3, 4]);
  });

  it('still keeps the benign direction: a ledger version the store has not reached is missing-in-store, not extra', () => {
    const { store, ledger } = worked();
    const out = store.reconcile({ ledgerVersions: [...ledgerVersions(ledger), 6] });
    expect(out).toMatchObject({ missingInStore: [6], extraInStore: [] });
  });

  it('reads the declaration from the journal: with the marks stripped the same versions are extra', () => {
    const { store, ledger } = worked();
    const text = readFileSync(store.paths.journal, 'utf-8');
    expect(text).toContain('"store_only":true,');
    writeFileSync(store.paths.journal, text.replaceAll('"store_only":true,', ''));

    const out = store.reconcile({ ledgerVersions: ledgerVersions(ledger) });

    expect(out.extraInStore).toEqual([3, 4]);
    expect(out.storeOnly).toEqual([]);
  });

  it('does not turn a hole in the store sequence into a declaration: a missing version is still a gap', () => {
    const { store, ledger } = worked();
    const lines = readFileSync(store.paths.journal, 'utf-8').split('\n').filter(Boolean);
    const withoutV4 = lines.filter((l) => JSON.parse(l).state_version !== 4);
    writeFileSync(store.paths.journal, `${withoutV4.join('\n')}\n`);

    const out = store.reconcile({ ledgerVersions: ledgerVersions(ledger) });

    expect(out.gaps).toEqual([4]);
    expect(out.storeOnly).toEqual([3]);
  });
});
