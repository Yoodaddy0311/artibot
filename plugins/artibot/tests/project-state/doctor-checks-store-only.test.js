/**
 * `/doctor` Check 8 and the store-only heartbeat (design D11, backlog follow-up c).
 *
 * The superset invariant `ledger ⊇ store` says every committed store version has a paired
 * `state.updated`. A clock-driven lease renewal (`heartbeatWorker({storeOnly: true})`)
 * deliberately has none, so `compareLedgerVersions` would read every tick as a lost update
 * (`ledger-subset-violation`, FAIL) unless it knows which versions are declared store-only.
 * It reads that from the JOURNAL (`journal.js#storeOnlyVersions`: every record of the version
 * marked `store_only: true` AND a heartbeat-shaped kind), never from the caller's word.
 *
 * What is measured:
 *  - a declared store-only version is NOT a violation, and the check says how many versions it
 *    left out of the comparison (a `pass` finding — "not compared" must be visible, not silent);
 *  - the exemption is an ALLOWLIST read per version: an unmarked version, a marked version of
 *    another kind, a version with one unmarked record, and a loosely-typed mark all stay FAIL;
 *  - an ordinary unpaired version beside store-only ones is still named, alone;
 *  - the real thing end to end: a REAL store, its real journal, the ledger rows it really wrote
 *    — Check 8 reads that healthy, and reads the SAME journal with the marks stripped as the
 *    lost updates they would be (so the exemption is what is holding the verdict).
 *
 * What it cannot see (rules §9): a LOST store-only write. Those versions are excluded from the
 * ledger comparison by design, so no ledger reading can miss them; only the journal's own
 * sequence (`checkStateVersionGaps`) sees a hole, and a lost heartbeat is a lease renewal the next
 * tick repeats. It also cannot tell a genuine tick from a hand-written journal line carrying the
 * mark — the mark is a declaration in a file the store writes, not a signature.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLedgerStateParity, CheckStatus } from '../../lib/project-state/doctor-checks.js';
import { readJournal, reduceProjectState } from '../../lib/project-state/journal.js';
import { buildProjection } from '../../lib/project-state/projection.js';
import {
  cleanup, makeStore, MISSION_ID, seed, task,
} from './helpers.js';

const MID = MISSION_ID;
const TS = '2026-09-02T00:00:00.000Z';
const LEASE = {
  owner: 't', acquired_at: TS, expires_at: '2026-09-03T00:00:00.000Z', heartbeat_at: TS,
};

/** v1: the mission, its graph holding one task, and the claim's lease — an ordinary, paired commit. */
const setup = () => [
  {
    v: 1, ts: TS, state_version: 1, kind: 'mission.upsert', mission_id: MID,
    mission: { status: 'executing', intent: { path: 'i', revision: 1 }, plan: { path: 'p', revision: 1 } },
  },
  {
    v: 1, ts: TS, state_version: 1, kind: 'graph.upsert', mission_id: MID,
    graph: { schema_version: 1, mission_id: MID, tasks: [{ id: 't', mission_id: MID, status: 'claimed', owner: 't' }] },
  },
];

/** One heartbeat renewal as the store writes it: a node and a lease under ONE version. */
const beat = (version, over = {}) => [
  {
    v: 1, ts: TS, state_version: version, store_only: true, reason: 'split.lease-tick', kind: 'task.upsert', mission_id: MID,
    task: { id: 't', mission_id: MID, status: 'claimed', owner: 't', heartbeat_source: 'lease-tick' }, ...over,
  },
  {
    v: 1, ts: TS, state_version: version, store_only: true, reason: 'split.lease-tick', kind: 'lease.set', mission_id: MID,
    task_id: 't', lease: LEASE, ...over,
  },
];

const stateUpdated = (version) => ({
  event: 'state.updated', mission_id: MID, session_id: 's', source: 'supervisor', ts: TS,
  data: { state_version: version, status: 'executing', reason: 'test' },
});

/**
 * Check 8 over a hand-built journal. The projection is derived from the journal's own fold on
 * purpose: these cases are about the VERSION SETS, and the projection comparison has its own
 * cases in doctor-checks-8-9.test.js against hand-written projections.
 */
const parity = (journal, events) => checkLedgerStateParity({
  journal,
  events,
  projection: buildProjection(reduceProjectState(journal, { project: 'artibot' }).state),
  project: 'artibot',
});
const codes = (result) => result.findings.map((f) => f.code);
const finding = (result, code) => result.findings.find((f) => f.code === code);

describe('a declared store-only version is not a lost update', () => {
  it('passes, and reports how many versions it left out of the comparison', () => {
    const result = parity([...setup(), ...beat(2), ...beat(3)], [stateUpdated(1)]);

    expect(codes(result)).not.toContain('ledger-subset-violation');
    expect(result.status).toBe(CheckStatus.PASS);
    expect(result.findings).toEqual([expect.objectContaining({
      code: 'store-only-versions', status: CheckStatus.PASS, count: 2, first: 2, last: 3,
    })]);
    expect(finding(result, 'store-only-versions').detail).toMatch(/not compared/i);
  });

  it('counts every declared version, however far apart the paired ones sit', () => {
    const journal = [
      ...setup(), ...beat(2),
      { ...setup()[0], state_version: 3 },
      ...beat(4), ...beat(5), ...beat(6),
    ];
    const result = parity(journal, [stateUpdated(1), stateUpdated(3)]);
    expect(result.status).toBe(CheckStatus.PASS);
    expect(finding(result, 'store-only-versions')).toMatchObject({ count: 4, first: 2, last: 6 });
  });

  it('compares, and does not exclude, a store-only version the ledger ALSO holds', () => {
    const result = parity([...setup(), ...beat(2)], [stateUpdated(1), stateUpdated(2)]);
    expect(result.status).toBe(CheckStatus.PASS);
    expect(result.findings).toEqual([]);
  });

  it('leaves the benign direction alone: a ledger version the store has not reached still warns', () => {
    const result = parity([...setup(), ...beat(2)], [stateUpdated(1), stateUpdated(3)]);
    expect(result.status).toBe(CheckStatus.WARN);
    expect(codes(result)).toEqual(expect.arrayContaining(['store-behind-ledger', 'store-only-versions']));
    expect(codes(result)).not.toContain('ledger-subset-violation');
  });
});

describe('the exemption is an allowlist, read per version — everything else stays a violation', () => {
  const violation = (journal, events = [stateUpdated(1)]) => {
    const result = parity(journal, events);
    return { result, versions: finding(result, 'ledger-subset-violation')?.versions };
  };

  it('an unmarked heartbeat-shaped version is a lost update, exactly as before', () => {
    const unmarked = beat(2).map(({ store_only: _m, reason: _r, ...r }) => r);
    const { result, versions } = violation([...setup(), ...unmarked]);
    expect(result.status).toBe(CheckStatus.FAIL);
    expect(versions).toEqual([2]);
    expect(codes(result)).not.toContain('store-only-versions');
  });

  it.each([
    ['mission.upsert', { kind: 'mission.upsert', mission: { status: 'failed', intent: { path: 'i', revision: 1 }, plan: { path: 'p', revision: 1 } } }],
    ['graph.upsert', { kind: 'graph.upsert', graph: { schema_version: 1, mission_id: MID, tasks: [] } }],
    ['lease.clear', { kind: 'lease.clear', task_id: 't' }],
    ['task.remove', { kind: 'task.remove', task_id: 't' }],
  ])('a marked %s is not heartbeat-shaped: the mark alone is not the rule', (_kind, over) => {
    const forged = { v: 1, ts: TS, state_version: 2, store_only: true, mission_id: MID, ...over };
    const { result, versions } = violation([...setup(), forged]);
    expect(result.status).toBe(CheckStatus.FAIL);
    expect(versions).toEqual([2]);
  });

  it('one unmarked record voids the version, though its sibling carries the mark', () => {
    const [node, lease] = beat(2);
    const { store_only: _mark, ...unmarkedLease } = lease;
    const { result, versions } = violation([...setup(), node, unmarkedLease]);
    expect(result.status).toBe(CheckStatus.FAIL);
    expect(versions).toEqual([2]);
  });

  it.each([['the string "true"', 'true'], ['the number 1', 1], ['an object', {}]])(
    'a mark that is %s is not the boolean true',
    (_label, mark) => {
      const { result, versions } = violation([...setup(), ...beat(2, { store_only: mark })]);
      expect(result.status).toBe(CheckStatus.FAIL);
      expect(versions).toEqual([2]);
    },
  );

  it('names an ordinary unpaired version alone, next to store-only ones', () => {
    const ordinary = { ...setup()[0], state_version: 3 };
    const result = parity([...setup(), ...beat(2), ordinary, ...beat(4)], [stateUpdated(1)]);
    expect(result.status).toBe(CheckStatus.FAIL);
    expect(finding(result, 'ledger-subset-violation').versions).toEqual([3]);
    expect(finding(result, 'store-only-versions')).toMatchObject({ count: 2, first: 2, last: 4 });
  });

  it('keeps the withdrawn-name path honest: with the project name unresolved the superset check still runs', () => {
    const journal = [...setup(), ...beat(2)];
    const result = checkLedgerStateParity({ journal, events: [stateUpdated(1)], projection: 'state_version: 2\n' });
    expect(codes(result)).toContain('project-name-unresolved');
    expect(codes(result)).not.toContain('ledger-subset-violation');
    expect(codes(result)).toContain('store-only-versions');
  });
});

describe('end to end on a REAL store: the ticks it wrote read healthy, and read as lost updates without their marks', () => {
  const roots = [];
  afterEach(() => { while (roots.length > 0) cleanup(roots.pop()); });

  /** A real store with a claimed task, three store-only beats and one ordinary beat. */
  const worked = () => {
    const made = makeStore();
    roots.push(made.projectRoot);
    const { store, clock } = made;
    seed(store, [task('W-1')]);
    store.claimTask({ missionId: MID, taskId: 'W-1', owner: 'a', ttlMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      clock.advance(1_000);
      expect(store.heartbeatWorker({
        missionId: MID, taskId: 'W-1', owner: 'a', heartbeatSource: 'lease-tick', reason: 'split.lease-tick', storeOnly: true,
      }).ok).toBe(true);
    }
    clock.advance(1_000);
    expect(store.heartbeatWorker({ missionId: MID, taskId: 'W-1', owner: 'a' }).ok).toBe(true);
    return made;
  };
  const check = (store, ledger, journal) => checkLedgerStateParity({
    journal, events: ledger.events, projection: store.renderProjection(), project: 'artibot',
  });

  it('reads healthy: 6 store versions, 3 paired by the ledger (seed, claim, the ordinary beat) and 3 declared store-only', () => {
    const { store, ledger } = worked();
    const journal = readJournal(store.paths.journal).records;

    const result = check(store, ledger, journal);

    expect(ledger.events.map((e) => e.data.state_version)).toEqual([1, 2, 6]);
    expect(result.status).toBe(CheckStatus.PASS);
    expect(result.findings).toEqual([expect.objectContaining({ code: 'store-only-versions', count: 3, first: 3, last: 5 })]);
  });

  it('reads the SAME journal with the marks stripped as the lost updates it would be', () => {
    const { store, ledger } = worked();
    const stripped = readJournal(store.paths.journal).records.map(({ store_only: _m, ...r }) => r);

    const result = check(store, ledger, stripped);

    expect(result.status).toBe(CheckStatus.FAIL);
    expect(finding(result, 'ledger-subset-violation').versions).toEqual([3, 4, 5]);
    expect(codes(result)).not.toContain('store-only-versions');
  });
});

describe('commands/doctor.md Check 8 says what the code does', () => {
  // Prose pins: the document is read by the model that runs /doctor, so a row that still said "no paired
  // event = fail" with no exception would have it report every tick as a lost update. They pin the words,
  // not that /doctor was ever run (doctor-checks-8-9.test.js says the same of its own pins).
  const DOCTOR_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands', 'doctor.md');
  const md = readFileSync(DOCTOR_MD, 'utf-8').replace(/\r\n/g, '\n');
  const start = md.indexOf('### Check 8');
  const check8 = md.slice(start, md.indexOf('\n### Check 9', start));

  it('carries the exception on the fail row, so a declared store-only version is not read as a lost update', () => {
    expect(start).toBeGreaterThan(-1);
    expect(check8).toContain('A store version has no paired `state.updated` event, and the journal does not declare it store-only');
  });

  it('names the declaration, its allowlist and the finding that counts what was left out', () => {
    for (const word of ['store_only: true', 'storeOnlyVersions', '`task.upsert` or `lease.set`', 'store-only-versions', 'boolean `true`']) {
      expect(check8, word).toContain(word);
    }
  });

  it('states what it cannot see next to the gate: a lost store-only write, and that the mark is not a signature', () => {
    expect(check8).toContain('A lost store-only write.');
    expect(check8).toContain('checkStateVersionGaps');
    expect(check8).toContain('not a signature');
  });
});
