/**
 * Behaviour pins for the Checkpoint Store's four verbs.
 *
 * The store is the append port for mission checkpoints (design §8.2, adopting scorecard §21-26;
 * scorecard §22 interface, §25 state isolation). It knows FOUR things: append a
 * record, fetch one back by id, fetch a mission's last one, and list a
 * mission's ids in write order. It deliberately does NOT know the 13-field
 * checkpoint schema — that is `checkpoint-validator.js`'s job, and a second
 * copy of the field list here would be the drift this split avoids.
 *
 * Everything below runs on the in-memory adapter. The file adapter's own
 * concerns (framing, torn lines, concurrency) are `file-store.test.js`; the
 * no-reference-escape property is `tests/firewall/checkpoint-immutability.test.js`.
 *
 * @module tests/checkpoint/checkpoint-store
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createCheckpointStore, createMemoryAdapter } from '../../lib/checkpoint/checkpoint-store.js';

/** A checkpoint body. Shape is the caller's; the store only reads `mission_id`. */
function checkpoint(missionId, extra = {}) {
  return {
    mission_id: missionId,
    phase: 'build',
    tasks: [{ id: 'T-1', status: 'done' }],
    metrics: { tokens: 120 },
    ...extra,
  };
}

/**
 * A deterministic id source, so assertions can name ids instead of matching
 * them. The default generator's uniqueness is pinned separately below.
 * @param {string} prefix - Id prefix.
 * @returns {() => string} Sequential id generator.
 */
function seqIds(prefix) {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

/** @type {{adapter: object, store: object}} */
let ctx;

beforeEach(() => {
  const adapter = createMemoryAdapter();
  ctx = {
    adapter,
    store: createCheckpointStore({
      adapter,
      newId: seqIds('cp'),
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    }),
  };
});

describe('save', () => {
  it('save returns the new checkpoint_id and the record timestamp', async () => {
    const res = await ctx.store.save(checkpoint('M-20260912-001'));
    expect(res).toEqual({ checkpoint_id: 'cp-1', ts: '2026-09-12T00:00:00.000Z' });
  });

  it('save appends exactly one envelope-wrapped record per call', async () => {
    await ctx.store.save(checkpoint('M-20260912-001'));
    await ctx.store.save(checkpoint('M-20260912-001'));
    const records = await ctx.adapter.readAll();
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      v: 1,
      checkpoint_id: 'cp-1',
      mission_id: 'M-20260912-001',
      ts: '2026-09-12T00:00:00.000Z',
      checkpoint: checkpoint('M-20260912-001'),
    });
  });

  it('save rejects when mission_id is absent, because latest and list are keyed on it', async () => {
    await expect(ctx.store.save({ phase: 'build' })).rejects.toThrow(/mission_id/);
    expect(await ctx.adapter.readAll()).toHaveLength(0);
  });

  it('save rejects an empty-string mission_id', async () => {
    await expect(ctx.store.save(checkpoint(''))).rejects.toThrow(/mission_id/);
  });

  it('save rejects a non-string mission_id', async () => {
    await expect(ctx.store.save(checkpoint(42))).rejects.toThrow(/mission_id/);
  });

  it('save rejects a non-object checkpoint', async () => {
    await expect(ctx.store.save(null)).rejects.toThrow(/checkpoint/);
    await expect(ctx.store.save('M-1')).rejects.toThrow(/checkpoint/);
  });

  it('save does not keep the caller object, so a later caller mutation cannot rewrite history', async () => {
    const body = checkpoint('M-20260912-001');
    const { checkpoint_id: id } = await ctx.store.save(body);
    body.phase = 'MUTATED-AFTER-SAVE';
    body.tasks.push({ id: 'T-999', status: 'done' });
    const loaded = await ctx.store.load(id);
    expect(loaded.checkpoint.phase).toBe('build');
    expect(loaded.checkpoint.tasks).toHaveLength(1);
  });

  it('save accepts checkpoints whose fields the store does not know, leaving schema to the validator', async () => {
    const res = await ctx.store.save({ mission_id: 'M-20260912-001', anything: { at: 'all' } });
    const loaded = await ctx.store.load(res.checkpoint_id);
    expect(loaded.checkpoint.anything).toEqual({ at: 'all' });
  });
});

describe('load', () => {
  it('load returns the full record for a known checkpoint_id', async () => {
    const { checkpoint_id: id } = await ctx.store.save(checkpoint('M-20260912-001'));
    const loaded = await ctx.store.load(id);
    expect(loaded.checkpoint_id).toBe(id);
    expect(loaded.mission_id).toBe('M-20260912-001');
    expect(loaded.checkpoint).toEqual(checkpoint('M-20260912-001'));
  });

  it('load returns null for an unknown checkpoint_id rather than throwing', async () => {
    await ctx.store.save(checkpoint('M-20260912-001'));
    expect(await ctx.store.load('cp-does-not-exist')).toBeNull();
  });

  it('load returns null on an empty store', async () => {
    expect(await ctx.store.load('cp-1')).toBeNull();
  });
});

describe('latest', () => {
  it('latest returns the last record saved for that mission', async () => {
    await ctx.store.save(checkpoint('M-A', { phase: 'plan' }));
    await ctx.store.save(checkpoint('M-A', { phase: 'build' }));
    await ctx.store.save(checkpoint('M-A', { phase: 'review' }));
    const got = await ctx.store.latest('M-A');
    expect(got.checkpoint_id).toBe('cp-3');
    expect(got.checkpoint.phase).toBe('review');
  });

  it('latest keeps two interleaved missions apart', async () => {
    await ctx.store.save(checkpoint('M-A', { phase: 'a1' }));
    await ctx.store.save(checkpoint('M-B', { phase: 'b1' }));
    await ctx.store.save(checkpoint('M-A', { phase: 'a2' }));
    await ctx.store.save(checkpoint('M-B', { phase: 'b2' }));
    expect((await ctx.store.latest('M-A')).checkpoint.phase).toBe('a2');
    expect((await ctx.store.latest('M-B')).checkpoint.phase).toBe('b2');
  });

  it('latest returns null for a mission that has never been saved', async () => {
    await ctx.store.save(checkpoint('M-A'));
    expect(await ctx.store.latest('M-UNKNOWN')).toBeNull();
  });

  it('latest returns null for a missing or non-string mission id', async () => {
    await ctx.store.save(checkpoint('M-A'));
    expect(await ctx.store.latest(undefined)).toBeNull();
    expect(await ctx.store.latest('')).toBeNull();
  });
});

describe('list', () => {
  it('list returns that mission checkpoint_ids in save order', async () => {
    await ctx.store.save(checkpoint('M-A'));
    await ctx.store.save(checkpoint('M-A'));
    await ctx.store.save(checkpoint('M-A'));
    expect(await ctx.store.list('M-A')).toEqual(['cp-1', 'cp-2', 'cp-3']);
  });

  it('list excludes other missions ids', async () => {
    await ctx.store.save(checkpoint('M-A'));
    await ctx.store.save(checkpoint('M-B'));
    await ctx.store.save(checkpoint('M-A'));
    expect(await ctx.store.list('M-A')).toEqual(['cp-1', 'cp-3']);
    expect(await ctx.store.list('M-B')).toEqual(['cp-2']);
  });

  it('list returns an empty array for an unknown mission', async () => {
    expect(await ctx.store.list('M-UNKNOWN')).toEqual([]);
  });
});

describe('the default id generator', () => {
  it('gives every save a distinct id within one process', async () => {
    const store = createCheckpointStore({ adapter: createMemoryAdapter() });
    const ids = [];
    for (let i = 0; i < 200; i += 1) {
      // Sequential on purpose: same-millisecond saves are the case a
      // clock-only id loses, and that is what this measures.
      ids.push((await store.save(checkpoint('M-A'))).checkpoint_id);
    }
    expect(new Set(ids).size).toBe(200);
  });

  it('carries the process id, so two processes cannot collide on counter alone', async () => {
    const store = createCheckpointStore({ adapter: createMemoryAdapter() });
    const { checkpoint_id: id } = await store.save(checkpoint('M-A'));
    expect(id).toContain(String(process.pid));
  });
});

describe('adapter injection', () => {
  it('refuses an adapter that cannot append and read', () => {
    expect(() => createCheckpointStore({ adapter: {} })).toThrow(/adapter/);
    expect(() => createCheckpointStore({})).toThrow(/adapter/);
  });

  it('awaits an adapter whose append and readAll are async', async () => {
    const records = [];
    const store = createCheckpointStore({
      adapter: {
        append: async (r) => { records.push(r); },
        readAll: async () => records,
      },
      newId: seqIds('async'),
    });
    await store.save(checkpoint('M-A'));
    expect((await store.latest('M-A')).checkpoint_id).toBe('async-1');
  });
});
