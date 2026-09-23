/**
 * `lib/checkpoint/save-checkpoint` — the `/save` checkpoint pass over a
 * session's active missions.
 *
 * Two kinds of test sit side by side here, and neither replaces the other.
 * The hand-written port fakes (the style of `checkpoint-service.test.js`)
 * cover order, skip paths and failure recording, because those are statements
 * about THIS module. The last block wires the REAL state store, the REAL
 * checkpoint file store and the REAL ledger writer over a temp directory,
 * because the field mapping is a statement about the live record shape — a
 * fake that returns `{ intent: { revision: 1 } }` proves only that the fake
 * was written to match the module.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCheckpointService,
  missionCheckpointedIdempotencyKey,
} from '../../lib/checkpoint/checkpoint-service.js';
import { createFileStoreAdapter } from '../../lib/checkpoint/adapters/file-store.js';
import { createCheckpointStore } from '../../lib/checkpoint/checkpoint-store.js';
import {
  buildSaveCheckpoint,
  isSaveCheckpointEnabled,
  SAVE_CHECKPOINT_CONFIG_PATH,
  SAVE_CHECKPOINT_EVENT,
  SAVE_CHECKPOINT_PORT_ORDER,
  SAVE_CHECKPOINT_SOURCE,
  SAVE_CHECKPOINT_TRIGGER,
  SAVE_SKIP_REASONS,
} from '../../lib/checkpoint/save-checkpoint.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { getAllowlist } from '../../lib/runtime/event-writer.js';
import { validateCheckpoint } from '../../lib/supervisor/contracts.js';

const MID = 'M-20260921-001';
const SESSION = 's-1';

const REAL_REPORT_RESUMABLE = false;

/**
 * Ports that record their own call order into a shared log.
 *
 * @param {object} [over] - Per-port overrides.
 * @returns {object} Ports plus `log`, `events` and `reports`.
 */
function fakePorts(over = {}) {
  const log = [];
  const events = [];
  const reports = [];
  const tap = (name, fn) => (...args) => {
    log.push(name);
    return fn(...args);
  };
  return {
    log,
    events,
    reports,
    listActiveMissionIds: over.listActiveMissionIds ?? (() => [MID]),
    getMission: tap('getMission', over.getMission ?? (() => ({
      status: 'executing',
      intent: { path: 'i.md', revision: 2 },
      plan: { path: 'p.md', revision: 3 },
    }))),
    getTaskGraph: tap('getTaskGraph', over.getTaskGraph ?? (() => ({
      schema_version: 1,
      mission_id: MID,
      tasks: [{ id: 'T-1', status: 'queued' }, { id: 'T-2', status: 'done' }, { id: 'T-3', status: 'executing' }],
    }))),
    checkpointService: {
      checkpoint: tap('checkpoint', over.checkpoint ?? (() => ({
        ok: true, checkpoint_id: 'cp-1', ts: '2026-09-21T00:00:00Z', errors: [],
      }))),
      latestValid: over.latestValid ?? (() => ({ ok: false, record: null, errors: [] })),
    },
    buildResumeReport: tap('buildResumeReport', over.buildResumeReport ?? ((ports, options) => {
      reports.push({ ports, options });
      return { mission_id: options.missionId, resumable: true, blocked_by: [] };
    })),
    appendEvent: tap('appendEvent', over.appendEvent ?? ((envelope) => {
      events.push(envelope);
      return { ok: true };
    })),
  };
}

describe('module constants', () => {
  it('pins the canary config path, trigger, source and event name', () => {
    expect(SAVE_CHECKPOINT_CONFIG_PATH).toBe('runtime.checkpoint.saveOnSave');
    expect(SAVE_CHECKPOINT_TRIGGER).toBe('/save');
    expect(SAVE_CHECKPOINT_SOURCE).toBe('supervisor');
    expect(SAVE_CHECKPOINT_EVENT).toBe('mission.checkpointed');
  });

  it('freezes the port order and the skip reasons', () => {
    expect(SAVE_CHECKPOINT_PORT_ORDER).toEqual(
      ['getMission', 'getTaskGraph', 'checkpoint', 'buildResumeReport', 'appendEvent'],
    );
    expect(Object.isFrozen(SAVE_CHECKPOINT_PORT_ORDER)).toBe(true);
    expect(SAVE_SKIP_REASONS).toEqual({
      SESSION_MISSING: 'skip:session-missing',
      NO_ACTIVE_MISSION: 'skip:no-active-mission',
      MISSION_MISSING: 'skip:mission-missing',
    });
    expect(Object.isFrozen(SAVE_SKIP_REASONS)).toBe(true);
  });
});

describe('isSaveCheckpointEnabled', () => {
  it('is true only for a strict boolean true at runtime.checkpoint.saveOnSave', () => {
    expect(isSaveCheckpointEnabled({ runtime: { checkpoint: { saveOnSave: true } } })).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
    ['missing checkpoint block', { runtime: {} }],
    ['string "true"', { runtime: { checkpoint: { saveOnSave: 'true' } } }],
    ['number 1', { runtime: { checkpoint: { saveOnSave: 1 } } }],
    ['explicit false', { runtime: { checkpoint: { saveOnSave: false } } }],
  ])('is false for %s', (_label, config) => {
    expect(isSaveCheckpointEnabled(config)).toBe(false);
  });
});

describe('buildSaveCheckpoint — field mapping', () => {
  it('maps every allowlisted field from the args and the nested mission revisions', async () => {
    const seen = [];
    const ports = fakePorts({
      checkpoint: (content, options) => {
        seen.push({ content, options });
        return { ok: true, checkpoint_id: 'cp-1', ts: '2026-09-21T00:00:00Z', errors: [] };
      },
    });
    await buildSaveCheckpoint(ports, { sessionId: SESSION });

    expect(seen).toHaveLength(1);
    expect(seen[0].content).toEqual({
      mission_id: MID,
      session_id: SESSION,
      intent_revision: 2,
      plan_revision: 3,
      active_tasks: ['T-1', 'T-3'],
      completed_action_results: [],
      routing_epoch: null,
      current_model: null,
      artifact_versions: {},
      replay_cursor: null,
      ledger_cursor: null,
      resumable: true,
    });
    expect(seen[0].options).toEqual({ trigger: SAVE_CHECKPOINT_TRIGGER });
  });

  it('accepts an explicit trigger override', async () => {
    const seen = [];
    const ports = fakePorts({
      checkpoint: (content, options) => {
        seen.push(options);
        return { ok: true, checkpoint_id: 'cp-1', ts: null, errors: [] };
      },
    });
    await buildSaveCheckpoint(ports, { sessionId: SESSION, trigger: 'model-switch' });
    expect(seen[0]).toEqual({ trigger: 'model-switch' });
  });

  it('treats a missing task graph as no active tasks', async () => {
    const seen = [];
    const ports = fakePorts({
      getTaskGraph: () => null,
      checkpoint: (content) => {
        seen.push(content);
        return { ok: true, checkpoint_id: 'cp-1', ts: null, errors: [] };
      },
    });
    await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(seen[0].active_tasks).toEqual([]);
  });

  it('copies a non-integer revision as-is rather than defaulting it', async () => {
    const seen = [];
    const ports = fakePorts({
      getMission: () => ({ status: 'executing', plan: { revision: 3 } }),
      checkpoint: (content) => {
        seen.push(content);
        return { ok: true, checkpoint_id: 'cp-1', ts: null, errors: [] };
      },
    });
    await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(seen[0].intent_revision).toBeUndefined();
    expect(seen[0].plan_revision).toBe(3);
  });

  it('returns the row shape the prose renders', async () => {
    const ports = fakePorts();
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.skipped).toBeNull();
    expect(out.rows).toEqual([{
      mission_id: MID,
      status: 'saved',
      reason: null,
      checkpoint_id: 'cp-1',
      ts: '2026-09-21T00:00:00Z',
      resumable: true,
      blocked_by: [],
      errors: [],
      ledger: { ok: true, reason: null },
    }]);
  });
});

describe('buildSaveCheckpoint — skip paths', () => {
  it.each([
    ['an absent session id', {}],
    ['an empty session id', { sessionId: '' }],
    ['a non-string session id', { sessionId: 7 }],
  ])('skips the whole run for %s and calls no port', async (_label, options) => {
    const ports = fakePorts();
    const out = await buildSaveCheckpoint(ports, options);
    expect(out).toEqual({ skipped: SAVE_SKIP_REASONS.SESSION_MISSING, rows: [] });
    expect(ports.log).toEqual([]);
  });

  it('skips the run when there is no active mission', async () => {
    const ports = fakePorts({ listActiveMissionIds: () => [] });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out).toEqual({ skipped: SAVE_SKIP_REASONS.NO_ACTIVE_MISSION, rows: [] });
    expect(ports.log).toEqual([]);
  });

  it('skips one mission whose record has gone, touching no later port for it', async () => {
    const ports = fakePorts({ getMission: () => null });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.skipped).toBeNull();
    expect(out.rows).toEqual([{
      mission_id: MID,
      status: 'skipped',
      reason: SAVE_SKIP_REASONS.MISSION_MISSING,
      checkpoint_id: null,
      ts: null,
      resumable: null,
      blocked_by: [],
      errors: [],
      ledger: null,
    }]);
    expect(ports.log).toEqual(['getMission']);
  });

  it('takes an explicit missionIds override in place of the list port', async () => {
    let listed = 0;
    const ports = fakePorts({ listActiveMissionIds: () => { listed += 1; return ['M-20260921-999']; } });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION, missionIds: [MID] });
    expect(listed).toBe(0);
    expect(out.rows.map((r) => r.mission_id)).toEqual([MID]);
  });
});

describe('buildSaveCheckpoint — rejection', () => {
  it('records the real validator errors and stops before the report and the ledger', async () => {
    const saved = [];
    const service = createCheckpointService({
      store: {
        save: async (c) => { saved.push(c); return { checkpoint_id: 'cp-never', ts: 'x' }; },
        latest: async () => null,
      },
      appendEvent: null,
    });
    const ports = fakePorts({
      // No `intent.revision`: the REAL validateCheckpoint must reject it.
      getMission: () => ({ status: 'executing', plan: { path: 'p.md', revision: 3 } }),
    });
    ports.checkpointService.checkpoint = (content, options) => {
      ports.log.push('checkpoint');
      return service.checkpoint(content, options);
    };

    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });

    expect(saved).toEqual([]);
    expect(out.rows[0].status).toBe('rejected');
    expect(out.rows[0].errors).toContain('intent_revision: must be an integer >= 0');
    expect(out.rows[0].checkpoint_id).toBeNull();
    expect(out.rows[0].ledger).toBeNull();
    expect(ports.log).toEqual(['getMission', 'getTaskGraph', 'checkpoint']);
    expect(ports.events).toEqual([]);
    expect(ports.reports).toEqual([]);
  });

  it('records a rejection with no errors array as an empty list', async () => {
    const ports = fakePorts({ checkpoint: () => ({ ok: false }) });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0]).toMatchObject({ status: 'rejected', errors: [] });
  });
});

describe('buildSaveCheckpoint — port order', () => {
  it('calls the five ports in exactly the frozen order', async () => {
    const ports = fakePorts();
    await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(ports.log).toEqual(['getMission', 'getTaskGraph', 'checkpoint', 'buildResumeReport', 'appendEvent']);
    expect(ports.log).toEqual([...SAVE_CHECKPOINT_PORT_ORDER]);
  });

  it('hands the report only read ports and the mission id', async () => {
    const ports = fakePorts();
    await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(ports.reports).toHaveLength(1);
    expect(Object.keys(ports.reports[0].ports).sort()).toEqual(['getMission', 'getTaskGraph', 'latestValid']);
    expect(ports.reports[0].options).toEqual({ missionId: MID });
  });
});

describe('buildSaveCheckpoint — ledger', () => {
  it('emits the mission.checkpointed envelope with the supervisor source', async () => {
    const ports = fakePorts();
    await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(ports.events).toEqual([{
      event: SAVE_CHECKPOINT_EVENT,
      mission_id: MID,
      session_id: SESSION,
      source: SAVE_CHECKPOINT_SOURCE,
      idempotency_key: `mission.checkpointed:${MID}:cp-1`,
      data: { checkpoint_id: 'cp-1', trigger: SAVE_CHECKPOINT_TRIGGER, resumable: true },
    }]);
  });

  it('records a refused append without failing the row', async () => {
    const ports = fakePorts({ appendEvent: () => ({ ok: false, reason: 'source-not-allowed:worker' }) });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0].status).toBe('saved');
    expect(out.rows[0].ledger).toEqual({ ok: false, reason: 'source-not-allowed:worker' });
  });

  it('records a thrown append by error name and never rethrows', async () => {
    const ports = fakePorts({
      appendEvent: () => { throw new TypeError('ledger is closed'); },
    });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0].status).toBe('saved');
    expect(out.rows[0].ledger).toEqual({ ok: false, reason: 'threw:TypeError' });
  });

  it('records an append that returns nothing as not ok', async () => {
    const ports = fakePorts({ appendEvent: () => undefined });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0].ledger).toEqual({ ok: false, reason: null });
  });
});

describe('buildSaveCheckpoint — ledger idempotency key', () => {
  /**
   * Ports whose checkpoint service hands out the given ids in order.
   *
   * @param {string[]} ids - Checkpoint ids, one per save.
   * @returns {object} Ports from {@link fakePorts}.
   */
  function portsSaving(ids) {
    const queue = [...ids];
    return fakePorts({
      checkpoint: () => ({ ok: true, checkpoint_id: queue.shift(), ts: '2026-09-21T00:00:00Z', errors: [] }),
    });
  }

  it('is the checkpoint service key for the same mission and checkpoint', async () => {
    const ports = portsSaving(['cp-1']);
    await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(ports.events[0].idempotency_key).toBe(missionCheckpointedIdempotencyKey(MID, 'cp-1'));
  });

  it('re-announcing the same checkpoint reuses the key, whatever the session, trigger or verdict', async () => {
    const first = portsSaving(['cp-1']);
    await buildSaveCheckpoint(first, { sessionId: SESSION });
    const again = fakePorts({
      checkpoint: () => ({ ok: true, checkpoint_id: 'cp-1', ts: '2026-09-21T00:00:09Z', errors: [] }),
      buildResumeReport: () => ({ resumable: false, blocked_by: ['x'] }),
    });
    await buildSaveCheckpoint(again, { sessionId: 's-2', trigger: 'model-switch' });
    expect(first.events[0].idempotency_key).toEqual(expect.any(String));
    expect(again.events[0].idempotency_key).toBe(first.events[0].idempotency_key);
  });

  it('a new checkpoint gets a new key, and so does another mission', async () => {
    const ports = portsSaving(['cp-1', 'cp-2', 'cp-1']);
    await buildSaveCheckpoint(ports, { sessionId: SESSION, missionIds: [MID, MID, 'M-20260921-002'] });
    expect(ports.events.map((e) => e.idempotency_key)).toEqual([
      `mission.checkpointed:${MID}:cp-1`,
      `mission.checkpointed:${MID}:cp-2`,
      'mission.checkpointed:M-20260921-002:cp-1',
    ]);
  });

  it('omits the key, rather than emitting a blank one, when the save returned no id', async () => {
    const ports = fakePorts({ checkpoint: () => ({ ok: true, ts: '2026-09-21T00:00:00Z', errors: [] }) });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0].checkpoint_id).toBeNull();
    expect(ports.events).toHaveLength(1);
    expect(Object.keys(ports.events[0])).not.toContain('idempotency_key');
  });
});

describe('buildSaveCheckpoint — report failure', () => {
  it('leaves resumable null, blocks on report:threw, and still writes the ledger', async () => {
    const ports = fakePorts({
      buildResumeReport: () => { throw new Error('report blew up'); },
    });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0]).toMatchObject({
      status: 'saved',
      resumable: null,
      blocked_by: ['report:threw'],
      ledger: { ok: true, reason: null },
    });
    expect(ports.log).toEqual([...SAVE_CHECKPOINT_PORT_ORDER]);
    expect(ports.events[0].data.resumable).toBeNull();
  });

  it('carries the report blocked_by through when the report says not resumable', async () => {
    const ports = fakePorts({
      buildResumeReport: (p, o) => ({ mission_id: o.missionId, resumable: false, blocked_by: ['checkpoint:absent'] }),
    });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0]).toMatchObject({ resumable: false, blocked_by: ['checkpoint:absent'] });
  });
});

describe('buildSaveCheckpoint — multiple missions', () => {
  it('produces one independent row per mission id', async () => {
    const other = 'M-20260921-002';
    const ports = fakePorts({
      listActiveMissionIds: () => [MID, other],
      getMission: (id) => (id === other
        ? null
        : { status: 'executing', intent: { revision: 2 }, plan: { revision: 3 } }),
    });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows.map((r) => [r.mission_id, r.status])).toEqual([[MID, 'saved'], [other, 'skipped']]);
    expect(ports.log).toEqual([...SAVE_CHECKPOINT_PORT_ORDER, 'getMission']);
  });
});

describe('buildSaveCheckpoint — mission isolation', () => {
  const OTHER = 'M-20260921-002';

  /** A message shaped like a path, so a leak into the rows is unmistakable. */
  const SENTINEL = '/secret/path/token-xyz';

  /** The record the default fake returns, restated where a per-id fake replaces it. */
  const LIVE_MISSION = { status: 'executing', intent: { revision: 2 }, plan: { revision: 3 } };

  it('records the first mission as errored and still saves the ones behind it', async () => {
    const ports = fakePorts({
      listActiveMissionIds: () => [MID, OTHER],
      getMission: (id) => {
        if (id === MID) throw new Error('mission read failed');
        return LIVE_MISSION;
      },
    });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.skipped).toBeNull();
    expect(out.rows.map((r) => [r.mission_id, r.status])).toEqual([[MID, 'errored'], [OTHER, 'saved']]);
    // The throwing mission touches no later port; the next one runs the full order.
    expect(ports.log).toEqual(['getMission', ...SAVE_CHECKPOINT_PORT_ORDER]);
  });

  it('leaves the rows already built byte-identical when the last mission throws', async () => {
    const clean = await buildSaveCheckpoint(
      fakePorts({ listActiveMissionIds: () => [MID, OTHER] }),
      { sessionId: SESSION },
    );
    expect(clean.rows.map((r) => r.status)).toEqual(['saved', 'saved']);

    const ports = fakePorts({
      listActiveMissionIds: () => [MID, OTHER],
      checkpoint: (content) => {
        if (content.mission_id === OTHER) throw new Error('store is full');
        return { ok: true, checkpoint_id: 'cp-1', ts: '2026-09-21T00:00:00Z', errors: [] };
      },
    });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0]).toEqual(clean.rows[0]);
    expect(out.rows[1]).toMatchObject({ mission_id: OTHER, status: 'errored', reason: 'threw:Error' });
  });

  it('names the constructor of a rejected store promise', async () => {
    // `checkpoint-service.js#saveCheckpoint` REJECTS on a store failure rather
    // than returning `{ ok: false }`, so this is the real path, not a synthetic one.
    const ports = fakePorts({ checkpoint: () => Promise.reject(new TypeError('disk gone')) });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0]).toMatchObject({ status: 'errored', reason: 'threw:TypeError' });
  });

  it('falls back to Error for an anonymous error class whose constructor name is empty', async () => {
    let thrown = null;
    const ports = fakePorts({
      getMission: () => {
        // NOT assigned to a binding first: named evaluation would give it a name.
        thrown = new (class extends Error {})('anon');
        throw thrown;
      },
    });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    // Proves the fixture premise rather than assuming it: `?? 'Error'` would
    // pass this class through as `threw:`, only `|| 'Error'` catches it.
    expect(thrown.constructor.name).toBe('');
    expect(out.rows[0].reason).toBe('threw:Error');
  });

  it('carries no byte of the exception message into the rows', async () => {
    const ports = fakePorts({
      getTaskGraph: () => { throw new Error(`graph read failed: ${SENTINEL}`); },
    });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0].status).toBe('errored');
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('returns the full errored row shape, never a silently skipped one', async () => {
    const ports = fakePorts({ getMission: () => { throw new RangeError('out of range'); } });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows).toEqual([{
      mission_id: MID,
      status: 'errored',
      reason: 'threw:RangeError',
      checkpoint_id: null,
      ts: null,
      resumable: null,
      blocked_by: [],
      errors: [],
      ledger: null,
    }]);
  });

  it('does not reuse the validator-only rejected status for a store failure', async () => {
    const ports = fakePorts({ checkpoint: () => { throw new Error('store is full'); } });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0].status).not.toBe('rejected');
    expect(out.rows[0].status).toBe('errored');
  });

  it('survives a thrown null, which has no constructor to name', async () => {
    // `throw null` is legal and reaches the same catch, where `err.constructor`
    // would itself throw — the optional chain is what keeps the row a row.
    const ports = fakePorts({ getMission: () => { throw null; } });
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.skipped).toBeNull();
    expect(out.rows[0]).toMatchObject({ status: 'errored', reason: 'threw:Error' });
  });
});

describe('buildSaveCheckpoint — real store, real file checkpoint store, real ledger', () => {
  let tmp;

  beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), 'ca05-save-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  /**
   * Seed one mission whose shape the REAL state store accepts.
   *
   * The minimal record is not `{ intent: { revision } }`: `validate.js#validateMission`
   * also requires a non-empty `intent.path` / `plan.path`, a mission `status`, and
   * every task to carry its own `mission_id` and a status from `TASK_STATUSES`
   * (`open` is not one of them). Measured 2026-09-21 against validate.js:83-105,194.
   *
   * @returns {object} The live state store.
   */
  function seedStore() {
    const store = createStateStore({
      projectRoot: tmp,
      sessionId: SESSION,
      appendEvent: () => ({ ok: true }),
      resolveGitCommonDir: () => null,
    });
    const result = store.updateMission(MID, () => ({
      status: 'executing',
      intent: { path: 'docs/intent.md', revision: 1 },
      plan: { path: 'docs/plan.md', revision: 1 },
    }), {
      reason: 'seed',
      graph: {
        schema_version: 1,
        mission_id: MID,
        tasks: [
          { id: 'T-1', mission_id: MID, status: 'queued' },
          { id: 'T-2', mission_id: MID, status: 'done' },
        ],
      },
    });
    expect(result.ok).toBe(true);
    return store;
  }

  /**
   * @param {object} store - The live state store.
   * @returns {object} Ports over the real checkpoint file store and the real ledger.
   */
  function realPorts(store) {
    const checkpointStore = createCheckpointStore({
      adapter: createFileStoreAdapter({ dir: path.join(tmp, 'checkpoints') }),
    });
    return {
      checkpointStore,
      listActiveMissionIds: () => Object.keys(store.getState().active_missions),
      getMission: (id) => store.getMission(id),
      getTaskGraph: (id) => store.getTaskGraph(id),
      checkpointService: createCheckpointService({ store: checkpointStore, appendEvent: null }),
      // `ledgerPath` is RELATIVE — `event-writer.js#ledgerFilePath` joins it onto
      // `projectRoot`, so an absolute path here would produce a doubled path and
      // (on Windows) an unwritable one. Everything stays inside `tmp`.
      appendEvent: (e) => appendLedgerEvent(tmp, e, { ledgerPath: 'ledger.jsonl' }),
    };
  }

  /**
   * @returns {object[]} Every parsed line of the temp ledger.
   */
  function readLedger() {
    return readFileSync(path.join(tmp, 'ledger.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l));
  }

  it('saves a checkpoint the real validator accepts and a ledger line the real writer admits', async () => {
    const store = seedStore();
    const ports = realPorts(store);

    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });

    expect(out.skipped).toBeNull();
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0];
    expect(row.status).toBe('saved');
    expect(row.mission_id).toBe(MID);
    expect(row.checkpoint_id).toEqual(expect.any(String));
    expect(row.ledger).toEqual({ ok: true, reason: null });

    const record = await ports.checkpointStore.latest(MID);
    expect(record).not.toBeNull();
    expect(validateCheckpoint(record.checkpoint)).toEqual({ ok: true, errors: [] });
    expect(record.checkpoint.active_tasks).toEqual(['T-1']);
    expect(record.checkpoint.intent_revision).toBe(1);
    expect(record.checkpoint.plan_revision).toBe(1);
    expect(record.checkpoint.session_id).toBe(SESSION);
    expect(record.checkpoint.resumable).toBe(true);

    const lines = readLedger();
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('mission.checkpointed');
    expect(lines[0].source).toBe('supervisor');
    expect(lines[0].mission_id).toBe(MID);
    expect(lines[0].data).toMatchObject({ checkpoint_id: row.checkpoint_id, trigger: SAVE_CHECKPOINT_TRIGGER });
    // The key survives the REAL writer's envelope validation and lands on the
    // written line, not just on the object handed to the port.
    expect(lines[0].idempotency_key).toBe(missionCheckpointedIdempotencyKey(MID, row.checkpoint_id));
    // EVERY key this path emits is DECLARED. The writer only type-checks keys
    // the allowlist declares, so an undeclared key is written unvalidated and
    // no other assertion here would notice: the envelope pin above is on the
    // fake-ports path, and `toMatchObject` is deliberately lenient. This is
    // the one place the real emitter and the real vocabulary meet.
    const declared = Object.keys(getAllowlist().events['mission.checkpointed'].fields);
    expect(Object.keys(lines[0].data).filter((k) => !declared.includes(k))).toEqual([]);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
  });

  it('runs the REAL resume report over the checkpoint it just wrote', async () => {
    const store = seedStore();
    const ports = realPorts(store);
    // No report port: the module falls back to `resume-controller.js`.
    delete ports.buildResumeReport;
    const out = await buildSaveCheckpoint(ports, { sessionId: SESSION });
    expect(out.rows[0].status).toBe('saved');
    // FALSE, and that is the honest answer, not a defect: the report's later
    // steps have no ports here (no lease reader, no reconcile, no model
    // resolver), so it blocks rather than claiming a resume it cannot vouch
    // for. The checkpoint is still saved and still valid — which is exactly
    // the separation this row is here to pin.
    expect(out.rows[0].resumable).toBe(REAL_REPORT_RESUMABLE);
    expect(out.rows[0].blocked_by.length).toBeGreaterThan(0);
    expect(out.rows[0].blocked_by).not.toContain('report:threw');
  });

  it('negative control: the real writer refuses a source outside the event allowlist', () => {
    const envelope = {
      event: SAVE_CHECKPOINT_EVENT,
      mission_id: MID,
      session_id: SESSION,
      source: 'worker',
      data: { checkpoint_id: 'cp-x', trigger: SAVE_CHECKPOINT_TRIGGER },
    };
    const refused = appendLedgerEvent(tmp, envelope, { ledgerPath: 'ledger.jsonl' });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('source-not-allowed:worker');

    // `save` is not an envelope source at all, so it is refused one layer
    // EARLIER, by `validateEnvelope`. The two reasons are different gates and
    // only `worker` proves the per-event allowlist is load-bearing.
    const notASource = appendLedgerEvent(tmp, { ...envelope, source: 'save' }, { ledgerPath: 'ledger.jsonl' });
    expect(notASource.ok).toBe(false);
    expect(notASource.reason).toBe('invalid-envelope:source');

    expect(readLedger().filter((l) => l.event === 'ledger.rejected')).toHaveLength(2);
  });
});
