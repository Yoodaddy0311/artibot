/**
 * Firewall gate — a loaded checkpoint is a COPY, and mutating it cannot reach
 * the stored record.
 *
 * WHY THIS GATE EXISTS. Scorecard §25 makes state isolation the checkpoint
 * store's load-bearing property and §52 names the procedure: save, load, mutate
 * what you loaded, load again, and require the persisted original to be
 * unchanged. Recovery and replay both read checkpoints and both hand what they
 * read to code that is free to edit it; if the store returns its own reference,
 * an ordinary in-place edit silently rewrites history that is supposed to be
 * append-only, and nothing anywhere else in the system would notice. That
 * failure leaves no error and no log line, so a gate is the only detector.
 *
 * HOW THE COPY IS MADE, AND WHY THAT WAY. `structuredClone`, on both the save
 * input and every read result. Three candidates were available:
 *   - `structuredClone` — chosen. It is what `lib/project-state/projection.js#clone`
 *     already uses for the same job on the same kind of record, so the two
 *     stores answer "what is a deep copy here?" identically instead of drifting
 *     apart. It is built in (this package has zero runtime dependencies) and it
 *     THROWS on a value it cannot copy, which surfaces a bug rather than
 *     silently dropping a key the way a `JSON.parse(JSON.stringify(...))` round
 *     trip does with `undefined` inside an array.
 *   - JSON round trip — rejected: silent lossiness, as above.
 *   - copy-on-write / freeze — rejected: it moves the guarantee into every
 *     caller's discipline, and `Object.freeze` in particular would make §52's
 *     procedure impossible to run, because assigning to a frozen object THROWS
 *     under ESM strict mode. The gate must be able to perform the mutation and
 *     then observe that it did not land. Returned values are therefore NOT
 *     frozen, by design.
 *
 * FOUR MUTATIONS, NOT ONE. A shallow copy passes a top-level assignment and
 * fails on everything nested, so a single-case gate would go green on the
 * cheapest wrong implementation. The four below are the distinct reference
 * paths out of a JSON-shaped record: a top-level key, a nested object's key, an
 * array's length, and an array element.
 *
 * SELF-VERIFICATION. The procedure is a function, and one `it` feeds it a store
 * that deliberately hands out its internal references. If the procedure does
 * not go red on that store, every green above it is meaningless. A detector
 * that has never been shown failing proves nothing when it passes.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - NON-JSON VALUE TYPES. Every fixture here is JSON-shaped. `structuredClone`
 *     copies `Date`, `Map`, `Set` and `RegExp`, but the FILE adapter serializes
 *     through `JSON.stringify`, so those types do not survive a round trip
 *     through disk at all. Whether a caller may put one in a checkpoint is the
 *     validator's question (`checkpoint-validator.js`), and this gate does not
 *     answer it.
 *   - PROTOTYPE POLLUTION. `structuredClone` drops the prototype and returns a
 *     plain object, so a mutation through `__proto__` is not the same
 *     experiment as the four below. It is UNMEASURED here.
 *   - SYMBOL KEYS AND FUNCTIONS. `structuredClone` throws on a function and
 *     ignores symbol keys. No fixture below contains either, so the behaviour
 *     on them is UNMEASURED.
 *   - CONCURRENT MUTATION. Everything here is single-threaded and sequential.
 *     Two readers editing one loaded record at the same time is not measured.
 *   - THE VALIDATOR'S COPY. Only this store is measured. Whether
 *     `checkpoint-validator.js` or `checkpoint-service.js` preserve the same
 *     isolation is their own tests' question.
 *   - THE FILE ROWS DO NOT PIN copy(). Measured 2026-09-12 by review: with the
 *     store's `copy()` replaced by the identity function, the 8 file-adapter
 *     rows below STAY GREEN, because `file-store.js#readAll` re-parses the
 *     JSONL on every read and so isolates by itself. Only the 8 memory-adapter
 *     rows detect a store that has stopped copying. The file rows therefore
 *     measure the adapter round trip, not the store's clone — both are kept
 *     because production runs the file adapter, and the memory rows are the
 *     ones that guard the store.
 *
 * @module tests/firewall/checkpoint-immutability
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCheckpointStore, createMemoryAdapter } from '../../lib/checkpoint/checkpoint-store.js';
import { createFileStoreAdapter } from '../../lib/checkpoint/adapters/file-store.js';

const MISSION = 'M-20260912-001';

/** A nested, array-bearing checkpoint — every mutation path below needs one. */
function fixture() {
  return {
    mission_id: MISSION,
    phase: 'build',
    metrics: { tokens: 120, nested: { deeper: 'original' } },
    tasks: [{ id: 'T-1', status: 'done' }, { id: 'T-2', status: 'open' }],
  };
}

/**
 * The four reference paths out of a JSON-shaped record. Each is its own `it`.
 * @type {ReadonlyArray<{name: string, mutate: (cp: object) => void}>}
 */
const MUTATIONS = [
  { name: 'top-level key assignment', mutate: (cp) => { cp.phase = 'HIJACKED'; } },
  { name: 'nested object key assignment', mutate: (cp) => { cp.metrics.nested.deeper = 'HIJACKED'; } },
  { name: 'array push', mutate: (cp) => { cp.tasks.push({ id: 'T-INJECTED', status: 'done' }); } },
  { name: 'array element replacement', mutate: (cp) => { cp.tasks[0] = { id: 'T-SWAPPED', status: 'x' }; } },
];

/** @type {string} */
let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'artibot-checkpoint-immut-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The adapters under test, each with a way to read the persisted bytes. The
 * memory adapter has no bytes, so its `bytes` is null and the byte assertion is
 * skipped for it — the record-level assertion still runs.
 * @type {ReadonlyArray<{name: string, make: () => {store: object, bytes: (() => string)|null}}>}
 */
const ADAPTERS = [
  {
    name: 'memory adapter',
    make: () => ({ store: createCheckpointStore({ adapter: createMemoryAdapter() }), bytes: null }),
  },
  {
    name: 'file adapter',
    make: () => {
      const file = path.join(dir, 'checkpoints.jsonl');
      return {
        store: createCheckpointStore({ adapter: createFileStoreAdapter({ dir }) }),
        bytes: () => readFileSync(file, 'utf-8'),
      };
    },
  },
];

/**
 * Scorecard §52, as a function so it can be pointed at a store that fails it.
 *
 * The comparison target is a copy taken BEFORE the save. Comparing against the
 * caller's own object would pass even on a store that retains it, because the
 * mutation would have changed both sides.
 *
 * @param {object} params - Procedure inputs.
 * @param {object} params.store - Store under test.
 * @param {(cp: object) => void} params.mutate - The edit a reader performs.
 * @param {'load'|'latest'} params.via - Which reader returns the record.
 * @param {(() => string)|null} [params.bytes] - Persisted bytes, when there are any.
 * @returns {Promise<void>} Resolves when the store held; rejects when it leaked.
 */
async function assertImmutable({ store, mutate, via, bytes = null }) {
  const input = fixture();
  const expected = structuredClone(input);
  const { checkpoint_id: id } = await store.save(input);

  const before = bytes ? bytes() : null;
  const read = async () => (via === 'load' ? store.load(id) : store.latest(MISSION));

  const loaded = await read();
  expect(loaded.checkpoint).toEqual(expected);
  mutate(loaded.checkpoint);

  const reloaded = await read();
  expect(reloaded.checkpoint).toEqual(expected);
  if (bytes) expect(bytes()).toBe(before);
}

for (const adapter of ADAPTERS) {
  for (const via of ['load', 'latest']) {
    describe(`${adapter.name} — ${via} returns a copy`, () => {
      for (const { name, mutate } of MUTATIONS) {
        it(`survives ${name} on the returned checkpoint`, async () => {
          const { store, bytes } = adapter.make();
          await assertImmutable({ store, mutate, via, bytes });
        });
      }
    });
  }
}

/**
 * A store that does exactly what this gate forbids: it keeps what the caller
 * handed it and returns that same object. Four methods, no copying anywhere.
 * @returns {object} A deliberately leaky store.
 */
function createLeakyStore() {
  const records = [];
  return {
    save: async (checkpoint) => {
      const record = {
        v: 1,
        checkpoint_id: `leak-${records.length + 1}`,
        mission_id: checkpoint.mission_id,
        ts: '2026-09-12T00:00:00.000Z',
        checkpoint,
      };
      records.push(record);
      return { checkpoint_id: record.checkpoint_id, ts: record.ts };
    },
    load: async (id) => records.find((r) => r.checkpoint_id === id) ?? null,
    latest: async (missionId) => [...records].reverse().find((r) => r.mission_id === missionId) ?? null,
    list: async (missionId) => records.filter((r) => r.mission_id === missionId).map((r) => r.checkpoint_id),
  };
}

/**
 * Run the procedure and hand back whatever it threw.
 *
 * The failure is inspected rather than merely counted: a rejection caused by a
 * `TypeError` in the fake store would satisfy a bare `rejects.toThrow()` while
 * proving nothing about the procedure's ability to SEE a leak. Requiring an
 * assertion failure pins that the deep-equality check is what went red.
 *
 * @param {object} params - Same inputs as {@link assertImmutable}.
 * @returns {Promise<Error|null>} The thrown error, or null if it passed.
 */
async function failureFrom(params) {
  return assertImmutable(params).then(() => null, (err) => err);
}

describe('the procedure itself', () => {
  for (const { name, mutate } of MUTATIONS) {
    it(`goes red on a leaky store for ${name}, so a green above is not vacuous`, async () => {
      const err = await failureFrom({ store: createLeakyStore(), mutate, via: 'load' });
      expect(err).not.toBeNull();
      expect(err.name).toBe('AssertionError');
    });
  }

  it('goes red on a leaky store through latest as well as load', async () => {
    const err = await failureFrom({ store: createLeakyStore(), mutate: MUTATIONS[0].mutate, via: 'latest' });
    expect(err).not.toBeNull();
    expect(err.name).toBe('AssertionError');
  });

  it('goes red on a leaky store byte check too, not only the record check', async () => {
    // The file-adapter rows above also assert the persisted bytes. A leaky
    // store that somehow reproduced the record would still have to reproduce
    // the bytes, so this pins that the byte arm of the procedure is reachable.
    const err = await failureFrom({
      store: createLeakyStore(),
      mutate: MUTATIONS[1].mutate,
      via: 'load',
      bytes: () => 'constant',
    });
    expect(err).not.toBeNull();
    expect(err.name).toBe('AssertionError');
  });

  it('does not freeze what it returns, because a frozen record makes §52 unrunnable', async () => {
    const { store } = ADAPTERS[0].make();
    const { checkpoint_id: id } = await store.save(fixture());
    const loaded = await store.load(id);
    expect(Object.isFrozen(loaded)).toBe(false);
    expect(Object.isFrozen(loaded.checkpoint)).toBe(false);
    expect(() => { loaded.checkpoint.phase = 'writable'; }).not.toThrow();
  });

  it('hands out a distinct object on every read, not one cached copy', async () => {
    const { store } = ADAPTERS[0].make();
    const { checkpoint_id: id } = await store.save(fixture());
    const a = await store.load(id);
    const b = await store.load(id);
    expect(a).not.toBe(b);
    expect(a.checkpoint).not.toBe(b.checkpoint);
    expect(a.checkpoint.tasks).not.toBe(b.checkpoint.tasks);
    expect(a).toEqual(b);
  });
});
