/**
 * `lib/checkpoint/checkpoint-service` — validate-then-save, and the first two
 * steps of the Resume Contract. The store is a hand-written fake that records
 * its calls: the real store lands in a sibling limb and importing it here
 * would test two units at once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCheckpointService } from '../../lib/checkpoint/checkpoint-service.js';

const FULL = Object.freeze({
  mission_id: 'm-1',
  session_id: 's-1',
  intent_revision: 3,
  plan_revision: 5,
  execution_profile_version: 2,
  active_tasks: [],
  completed_action_results: [],
  routing_epoch: 'epoch-7',
  current_model: 'opus',
  artifact_versions: {},
  replay_cursor: 0,
  ledger_cursor: 12,
  resumable: true,
});

const RECORD = Object.freeze({
  v: 1, checkpoint_id: 'cp-1', mission_id: 'm-1', ts: '2026-09-12T00:00:00Z', checkpoint: FULL,
});

/**
 * @param {object} [over]
 * @returns {{ calls: Array<{ method: string, args: unknown[] }>, save: Function, load: Function, latest: Function, list: Function }}
 */
function fakeStore(over = {}) {
  const calls = [];
  const record = (method, fn) => async (...args) => {
    calls.push({ method, args });
    return fn(...args);
  };
  return {
    calls,
    save: record('save', over.save ?? (() => ({ checkpoint_id: 'cp-1', ts: '2026-09-12T00:00:00Z' }))),
    load: record('load', over.load ?? (() => null)),
    latest: record('latest', over.latest ?? (() => RECORD)),
    list: record('list', over.list ?? (() => [])),
  };
}

const NOW = () => '2026-09-12T09:00:00Z';

describe('createCheckpointService', () => {
  it('refuses to build without a store exposing save and latest', () => {
    expect(() => createCheckpointService({})).toThrow(TypeError);
    expect(() => createCheckpointService({ store: { save: () => {} } })).toThrow(TypeError);
  });
});

describe('checkpoint()', () => {
  let store;
  beforeEach(() => { store = fakeStore(); });

  it('saves a valid checkpoint and returns the store id and ts', async () => {
    const svc = createCheckpointService({ store, now: NOW });
    const r = await svc.checkpoint(FULL, { trigger: 'model-switch' });
    expect(r).toEqual({ ok: true, checkpoint_id: 'cp-1', ts: '2026-09-12T00:00:00Z', errors: [] });
    expect(store.calls.filter((c) => c.method === 'save')).toHaveLength(1);
    expect(store.calls[0].args[0]).toBe(FULL);
  });

  it('falls back to now() when the store returns no ts', async () => {
    store = fakeStore({ save: () => ({ checkpoint_id: 'cp-2' }) });
    const svc = createCheckpointService({ store, now: NOW });
    await expect(svc.checkpoint(FULL, { trigger: 't' })).resolves.toEqual({
      ok: true, checkpoint_id: 'cp-2', ts: '2026-09-12T09:00:00Z', errors: [],
    });
  });

  it('does not touch the store when validation fails', async () => {
    const svc = createCheckpointService({ store, now: NOW });
    const r = await svc.checkpoint({ ...FULL, mission_id: '' }, { trigger: 't' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('mission_id: must be'))).toBe(true);
    expect(r.checkpoint_id).toBeUndefined();
    expect(store.calls).toHaveLength(0);
  });

  it('uses an injected validate in place of the contract validator', async () => {
    const validate = vi.fn(() => ({ ok: false, errors: ['nope'] }));
    const svc = createCheckpointService({ store, validate, now: NOW });
    await expect(svc.checkpoint(FULL, { trigger: 't' })).resolves.toEqual({ ok: false, errors: ['nope'] });
    expect(validate).toHaveBeenCalledWith(FULL);
    expect(store.calls).toHaveLength(0);
  });

  it('lets a store failure reject rather than reporting it as invalid', async () => {
    store = fakeStore({ save: () => { throw new Error('disk full'); } });
    const svc = createCheckpointService({ store, now: NOW });
    await expect(svc.checkpoint(FULL, { trigger: 't' })).rejects.toThrow('disk full');
  });
});

describe('checkpoint() ledger port', () => {
  it('calls nothing when appendEvent is left null', async () => {
    const store = fakeStore();
    const svc = createCheckpointService({ store, now: NOW });
    await expect(svc.checkpoint(FULL, { trigger: 't' })).resolves.toMatchObject({ ok: true });
    expect(store.calls.map((c) => c.method)).toEqual(['save']);
  });

  it('emits one mission.checkpointed envelope with no source key', async () => {
    const appendEvent = vi.fn();
    const svc = createCheckpointService({ store: fakeStore(), appendEvent, now: NOW });
    await svc.checkpoint(FULL, { trigger: 'model-switch' });
    expect(appendEvent).toHaveBeenCalledTimes(1);
    const envelope = appendEvent.mock.calls[0][0];
    expect(envelope).toEqual({
      event: 'mission.checkpointed',
      mission_id: 'm-1',
      data: { checkpoint_id: 'cp-1', trigger: 'model-switch' },
    });
    expect(Object.keys(envelope)).not.toContain('source');
    expect(Object.keys(envelope.data)).not.toContain('source');
  });

  it('omits trigger rather than inventing one when none is given', async () => {
    const appendEvent = vi.fn();
    const svc = createCheckpointService({ store: fakeStore(), appendEvent, now: NOW });
    await svc.checkpoint(FULL);
    expect(appendEvent.mock.calls[0][0].data).toEqual({ checkpoint_id: 'cp-1' });
  });

  it('does not emit when validation failed', async () => {
    const appendEvent = vi.fn();
    const svc = createCheckpointService({ store: fakeStore(), appendEvent, now: NOW });
    await svc.checkpoint({ ...FULL, resumable: 'yes' }, { trigger: 't' });
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('keeps the checkpoint ok when the port throws (best-effort)', async () => {
    const appendEvent = vi.fn(() => { throw new Error('ledger down'); });
    const svc = createCheckpointService({ store: fakeStore(), appendEvent, now: NOW });
    await expect(svc.checkpoint(FULL, { trigger: 't' })).resolves.toMatchObject({ ok: true, checkpoint_id: 'cp-1' });
  });

  it('keeps the checkpoint ok when the port rejects', async () => {
    const appendEvent = vi.fn(() => Promise.reject(new Error('ledger down')));
    const svc = createCheckpointService({ store: fakeStore(), appendEvent, now: NOW });
    await expect(svc.checkpoint(FULL, { trigger: 't' })).resolves.toMatchObject({ ok: true });
  });
});

describe('latestValid()', () => {
  it('returns the record when the stored checkpoint validates', async () => {
    const store = fakeStore();
    const svc = createCheckpointService({ store, now: NOW });
    await expect(svc.latestValid('m-1')).resolves.toEqual({ ok: true, record: RECORD, errors: [] });
    expect(store.calls).toEqual([{ method: 'latest', args: ['m-1'] }]);
  });

  it('returns null with no errors when the mission has no checkpoint', async () => {
    const svc = createCheckpointService({ store: fakeStore({ latest: () => null }), now: NOW });
    await expect(svc.latestValid('m-1')).resolves.toEqual({ ok: false, record: null, errors: [] });
  });

  it('withholds the record when the stored checkpoint fails validation', async () => {
    const bad = { ...RECORD, checkpoint: { ...FULL, plan_revision: -1 } };
    const svc = createCheckpointService({ store: fakeStore({ latest: () => bad }), now: NOW });
    const r = await svc.latestValid('m-1');
    expect(r.ok).toBe(false);
    expect(r.record).toBeNull();
    expect(r.errors.some((e) => e.startsWith('plan_revision: must be'))).toBe(true);
  });

  it('rejects a record without a checkpoint envelope', async () => {
    const svc = createCheckpointService({ store: fakeStore({ latest: () => ({ v: 1, checkpoint_id: 'c' }) }), now: NOW });
    const r = await svc.latestValid('m-1');
    expect(r.ok).toBe(false);
    expect(r.record).toBeNull();
    expect(r.errors).toContain('checkpoint: must be an object');
  });

  it.each([['', 'empty'], [null, 'null'], [7, 'a number']])('refuses %s missionId without hitting the store', async (missionId) => {
    const store = fakeStore();
    const svc = createCheckpointService({ store, now: NOW });
    const r = await svc.latestValid(missionId);
    expect(r).toEqual({ ok: false, record: null, errors: ['mission_id: must be a non-empty string'] });
    expect(store.calls).toHaveLength(0);
  });

  it('stops at schema validation and does not compare revisions', async () => {
    const svc = createCheckpointService({ store: fakeStore(), now: NOW });
    const r = await svc.latestValid('m-1');
    expect(r.ok).toBe(true);
    expect(Object.keys(r)).toEqual(['ok', 'record', 'errors']);
  });
});
