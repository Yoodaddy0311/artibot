/**
 * `lib/checkpoint/resume-controller` — the Resume Contract (Scorecard §51)
 * steps 1..9 as a REPORT.
 *
 * One `describe` per step, in the Scorecard's order. There is deliberately no
 * test for step 10 "Resume": performing the resume is out of this module's
 * scope (Canary), and a test for it here would imply the module does it.
 *
 * Every port is a hand-written fake that records its calls. The real
 * `state-manager` / `checkpoint-service` are NOT imported: importing them
 * would test three units at once, and the point of the port shape is that this
 * module can be judged without any of them.
 */

import { describe, expect, it } from 'vitest';

import { buildResumeReport, RESUME_BLOCK_REASONS } from '../../lib/checkpoint/resume-controller.js';

const MISSION = 'm-1';
const NOW_MS = Date.parse('2026-09-14T12:00:00.000Z');

/** A checkpoint shaped like `contracts.js#CHECKPOINT_REQUIRED_RULES` (:531). */
const CHECKPOINT = Object.freeze({
  mission_id: MISSION,
  session_id: 's-1',
  intent_revision: 1,
  plan_revision: 1,
  active_tasks: [],
  completed_action_results: [],
  current_model: 'opus',
  resumable: true,
});

/** Live shape measured 2026-09-14: revisions are NESTED under intent/plan. */
const MISSION_RECORD = Object.freeze({
  title: 'demo',
  status: 'active',
  intent: { path: 'intent.md', revision: 1 },
  plan: { path: 'plan.md', revision: 1 },
});

/** Live default measured 2026-09-14: all 9 graphs carry `tasks: []`. */
const GRAPH_EMPTY = Object.freeze({ schema_version: 1, mission_id: MISSION, tasks: [] });

const RECONCILE_CLEAN = Object.freeze({
  ok: true,
  drifted: false,
  applied: false,
  gaps: [],
  missingInStore: [],
  extraInStore: [],
  warnings: [],
  storeVersion: 17,
  snapshotVersion: 17,
});

/**
 * @param {object} [over] - Per-port overrides; `null` removes a port entirely.
 * @returns {object} Ports plus a `calls` log.
 */
function makePorts(over = {}) {
  const calls = [];
  const base = {
    latestValid: async () => ({
      ok: true,
      record: { checkpoint_id: 'cp-1', ts: '2026-09-14T11:00:00.000Z', checkpoint: CHECKPOINT },
      errors: [],
    }),
    getMission: () => MISSION_RECORD,
    getTaskGraph: () => GRAPH_EMPTY,
    getLease: () => null,
    isLeaseExpired: () => false,
    reconcile: () => RECONCILE_CLEAN,
    resolveModel: (previous) => previous,
    now: () => NOW_MS,
  };
  const ports = { calls };
  for (const [name, fn] of Object.entries({ ...base, ...over })) {
    if (fn === null) continue;
    ports[name] = (...args) => {
      calls.push({ port: name, args });
      return fn(...args);
    };
  }
  return ports;
}

/**
 * @param {object} report - A ResumeReport.
 * @param {number} step - Step number 1..9.
 * @returns {object} That step's entry.
 */
function stepOf(report, step) {
  return report.steps.find((s) => s.step === step);
}

/**
 * @param {object} over - Fields to overlay on the base checkpoint.
 * @returns {Function} A `latestValid` fake returning that checkpoint.
 */
function withCheckpoint(over) {
  return async () => ({
    ok: true,
    record: { checkpoint_id: 'cp-1', ts: 't', checkpoint: { ...CHECKPOINT, ...over } },
    errors: [],
  });
}

/**
 * One fixture per declared reason, so the emitted set can be compared against
 * the declared set in both directions. A declared reason that no fixture
 * provokes is either dead vocabulary or an untested branch, and a reason that
 * appears in a report without being declared is invisible to every reviewer
 * who reads only the constant — the equality below catches both.
 * @type {ReadonlyArray<{name: string, over: object}>}
 */
const REASON_FIXTURES = Object.freeze([
  { name: 'nothing stored', over: { latestValid: async () => ({ ok: false, record: null, errors: [] }) } },
  {
    name: 'stored but invalid',
    over: { latestValid: async () => ({ ok: false, record: null, errors: ['plan_revision: must be an integer >= 0'] }) },
  },
  { name: 'no latestValid port at all', over: { latestValid: null } },
  {
    name: 'a record that carries no checkpoint',
    over: { latestValid: async () => ({ ok: true, record: { checkpoint_id: 'cp-1', ts: 't' }, errors: [] }) },
  },
  { name: 'mission absent', over: { getMission: () => null } },
  { name: 'intent revision mismatch', over: { getMission: () => ({ ...MISSION_RECORD, intent: { revision: 7 } }) } },
  { name: 'plan revision mismatch', over: { getMission: () => ({ ...MISSION_RECORD, plan: { revision: 9 } }) } },
  { name: 'task graph absent', over: { getTaskGraph: () => null } },
  {
    name: 'active task absent from the graph',
    over: {
      latestValid: withCheckpoint({ active_tasks: ['T-9'] }),
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }] }),
    },
  },
  { name: 'active task carrying no id', over: { latestValid: withCheckpoint({ active_tasks: [{ status: 'open' }] }) } },
  {
    name: 'expired lease',
    over: {
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }] }),
      getLease: () => ({ owner: 'w-1', expires_at: '2026-09-14T10:00:00.000Z' }),
      isLeaseExpired: () => true,
    },
  },
  { name: 'no clock', over: { now: null } },
  {
    name: 'a lease the adapter refuses to judge',
    over: {
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }] }),
      getLease: () => ({ owner: 'w-1' }),
      isLeaseExpired: () => { throw new TypeError('lease adapter: expires_at must be a non-empty ISO-8601 string'); },
    },
  },
  {
    name: 'ledger drift with gaps and an extra version',
    over: { reconcile: () => ({ ...RECONCILE_CLEAN, ok: false, drifted: true, gaps: [3], extraInStore: [5] }) },
  },
  { name: 'reconcile throwing', over: { reconcile: () => { throw new Error('journal unreadable'); } } },
  { name: 'no model resolves', over: { resolveModel: () => null } },
]);

describe('report shape', () => {
  it('returns exactly the nine reportable steps, never a step 10', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(report.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(report.steps.every((s) => typeof s.name === 'string' && s.name.length > 0)).toBe(true);
  });

  it('carries the mission id and a summary evidence block', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(report.mission_id).toBe(MISSION);
    expect(report.evidence.checkpoint_id).toBe('cp-1');
    expect(report.evidence.ts).toBe('2026-09-14T11:00:00.000Z');
    expect(report.evidence.previous_model).toBe('opus');
    expect(report.evidence.current_model).toBe('opus');
    expect(report.evidence.counts).toMatchObject({
      active_tasks: 0,
      graph_tasks: 0,
      completed_action_results: 0,
      expired_leases: 0,
      blocked_by: 0,
    });
  });

  it('publishes every block reason it can emit, all under the reconcile: prefix', () => {
    const values = Object.values(RESUME_BLOCK_REASONS);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v.startsWith('reconcile:'))).toBe(true);
    expect(Object.isFrozen(RESUME_BLOCK_REASONS)).toBe(true);
  });

  it(`emits every one of the ${Object.keys(RESUME_BLOCK_REASONS).length} declared reasons, and nothing undeclared`, async () => {
    const emitted = new Set();
    for (const fixture of REASON_FIXTURES) {
      const report = await buildResumeReport(makePorts(fixture.over), { missionId: MISSION });
      for (const reason of report.blocked_by) emitted.add(reason);
    }
    expect([...emitted].sort()).toEqual(Object.values(RESUME_BLOCK_REASONS).sort());
  });

  it('resumes only when nothing blocks and the checkpoint says resumable', async () => {
    const clean = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(clean.blocked_by).toEqual([]);
    expect(clean.resumable).toBe(true);

    const notResumable = makePorts({
      latestValid: async () => ({
        ok: true,
        record: { checkpoint_id: 'cp-2', ts: 't', checkpoint: { ...CHECKPOINT, resumable: false } },
        errors: [],
      }),
    });
    const report = await buildResumeReport(notResumable, { missionId: MISSION });
    expect(report.blocked_by).toEqual([]);
    expect(report.resumable).toBe(false);
  });

  it('throws TypeError for a missing or non-string mission id', async () => {
    await expect(buildResumeReport(makePorts(), { missionId: '' })).rejects.toThrow(TypeError);
    await expect(buildResumeReport(makePorts(), {})).rejects.toThrow(TypeError);
    await expect(buildResumeReport(makePorts())).rejects.toThrow(TypeError);
  });

  it('returns a report instead of throwing when every port throws', async () => {
    const thrower = () => { throw new Error('port exploded'); };
    const ports = makePorts({
      latestValid: async () => thrower(),
      getMission: thrower,
      getTaskGraph: thrower,
      getLease: thrower,
      isLeaseExpired: thrower,
      reconcile: thrower,
      resolveModel: thrower,
      now: thrower,
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(report.steps.every((s) => s.ok !== true)).toBe(true);
    expect(report.resumable).toBe(false);
    expect(report.blocked_by.every((r) => r.startsWith('reconcile:'))).toBe(true);
  });

  it('degrades a missing port to ok:null, never to ok:true', async () => {
    const ports = makePorts({
      latestValid: null, getMission: null, getTaskGraph: null, getLease: null,
      isLeaseExpired: null, reconcile: null, resolveModel: null, now: null,
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(report.steps.map((s) => s.ok)).toEqual([null, null, null, null, null, null, null, null, null]);
    expect(report.resumable).toBe(false);
  });
});

describe('step 1 — Load latest valid checkpoint', () => {
  it('is ok when a record exists', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(stepOf(report, 1).ok).toBe(true);
    expect(stepOf(report, 1).evidence.checkpoint_id).toBe('cp-1');
  });

  it('blocks with checkpoint-missing when nothing is stored', async () => {
    const ports = makePorts({ latestValid: async () => ({ ok: false, record: null, errors: [] }) });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 1).ok).toBe(false);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.CHECKPOINT_MISSING);
    expect(report.resumable).toBe(false);
  });

  it('marks the checkpoint-reading steps skipped rather than ok when there is none', async () => {
    const ports = makePorts({ latestValid: async () => ({ ok: false, record: null, errors: [] }) });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    for (const step of [3, 4, 5, 6, 9]) {
      expect(stepOf(report, step).ok).toBe(null);
      expect(stepOf(report, step).evidence.skipped).toBe('no-valid-checkpoint');
    }
  });
});

describe('step 2 — Validate schema', () => {
  it('is ok when the stored checkpoint validates', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(stepOf(report, 2).ok).toBe(true);
  });

  it('blocks with checkpoint-invalid when the record fails validation', async () => {
    const ports = makePorts({
      latestValid: async () => ({ ok: false, record: null, errors: ['plan_revision: must be an integer >= 0'] }),
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 1).ok).toBe(true);
    expect(stepOf(report, 2).ok).toBe(false);
    expect(stepOf(report, 2).evidence.errors).toEqual(['plan_revision: must be an integer >= 0']);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.CHECKPOINT_INVALID);
  });
});

describe('step 3 — Validate Intent revision', () => {
  it('is ok when the checkpoint revision equals the live mission revision', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(stepOf(report, 3).ok).toBe(true);
    expect(stepOf(report, 3).evidence).toMatchObject({ checkpoint: 1, mission: 1 });
  });

  it('blocks with intent-revision on a mismatch', async () => {
    const ports = makePorts({
      getMission: () => ({ ...MISSION_RECORD, intent: { path: 'intent.md', revision: 4 } }),
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 3).ok).toBe(false);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.INTENT_REVISION);
  });

  it('fails closed with revision-unknown when the mission is absent', async () => {
    const report = await buildResumeReport(makePorts({ getMission: () => null }), { missionId: MISSION });
    expect(stepOf(report, 3).ok).toBe(null);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.REVISION_UNKNOWN);
  });

  it('fails closed when the live revision is not an integer', async () => {
    const ports = makePorts({ getMission: () => ({ ...MISSION_RECORD, intent: { path: 'i.md' } }) });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 3).ok).toBe(null);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.REVISION_UNKNOWN);
  });
});

describe('step 4 — Validate Plan revision', () => {
  it('is ok when the checkpoint revision equals the live mission revision', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(stepOf(report, 4).ok).toBe(true);
    expect(stepOf(report, 4).evidence).toMatchObject({ checkpoint: 1, mission: 1 });
  });

  it('blocks with plan-revision on a mismatch, independently of the intent step', async () => {
    const ports = makePorts({
      getMission: () => ({ ...MISSION_RECORD, plan: { path: 'plan.md', revision: 9 } }),
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 3).ok).toBe(true);
    expect(stepOf(report, 4).ok).toBe(false);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.PLAN_REVISION);
    expect(report.blocked_by).not.toContain(RESUME_BLOCK_REASONS.INTENT_REVISION);
  });
});

describe('step 5 — Restore Task Graph (reported, never restored)', () => {
  it('is ok for the live default of an empty graph and no active tasks', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(stepOf(report, 5).ok).toBe(true);
    expect(stepOf(report, 5).evidence).toMatchObject({
      active_tasks: [], graph_tasks: [], missing_in_graph: [], extra_in_graph: [],
    });
  });

  it('blocks with task-graph-missing when there is no graph', async () => {
    const report = await buildResumeReport(makePorts({ getTaskGraph: () => null }), { missionId: MISSION });
    expect(stepOf(report, 5).ok).toBe(null);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.TASK_GRAPH_MISSING);
  });

  it('blocks with task-graph-drift when an active task is absent from the graph', async () => {
    const ports = makePorts({
      latestValid: async () => ({
        ok: true,
        record: { checkpoint_id: 'cp-1', ts: 't', checkpoint: { ...CHECKPOINT, active_tasks: ['T-1', { id: 'T-9' }] } },
        errors: [],
      }),
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }] }),
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 5).ok).toBe(false);
    expect(stepOf(report, 5).evidence.missing_in_graph).toEqual(['T-9']);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.TASK_GRAPH_DRIFT);
  });

  it('treats a graph task absent from active_tasks as benign evidence, not drift', async () => {
    const ports = makePorts({
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }, { task_id: 'T-2' }] }),
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 5).ok).toBe(true);
    expect(stepOf(report, 5).evidence.extra_in_graph).toEqual(['T-1', 'T-2']);
    expect(report.blocked_by).not.toContain(RESUME_BLOCK_REASONS.TASK_GRAPH_DRIFT);
  });

  it('fails closed when an active_tasks entry carries no id', async () => {
    const ports = makePorts({
      latestValid: async () => ({
        ok: true,
        record: { checkpoint_id: 'cp-1', ts: 't', checkpoint: { ...CHECKPOINT, active_tasks: [{ status: 'open' }] } },
        errors: [],
      }),
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 5).ok).toBe(null);
    expect(stepOf(report, 5).evidence.unidentified).toBe(1);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.ACTIVE_TASK_ID_UNKNOWN);
  });
});

describe('step 6 — Restore completed Action results (counted, never reused)', () => {
  it('reports the count and ids and blocks on nothing', async () => {
    const ports = makePorts({
      latestValid: async () => ({
        ok: true,
        record: {
          checkpoint_id: 'cp-1',
          ts: 't',
          checkpoint: { ...CHECKPOINT, completed_action_results: ['A-1', { id: 'A-2' }, { status: 'done' }] },
        },
        errors: [],
      }),
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 6).ok).toBe(true);
    expect(stepOf(report, 6).evidence).toMatchObject({ count: 3, ids: ['A-1', 'A-2'], unidentified: 1 });
    expect(report.blocked_by).toEqual([]);
    expect(report.evidence.counts.completed_action_results).toBe(3);
  });
});

describe('step 7 — Find expired worker leases (listed, never reclaimed)', () => {
  it('is ok for the live default of no leases at all', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(stepOf(report, 7).ok).toBe(true);
    expect(stepOf(report, 7).evidence).toMatchObject({ checked: 0, expired: [] });
  });

  it('blocks with lease-expired and names the task ids', async () => {
    const ports = makePorts({
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }, { id: 'T-2' }] }),
      getLease: (_m, taskId) => (taskId === 'T-2' ? null : { owner: 'w-1', expires_at: '2026-09-14T10:00:00.000Z' }),
      isLeaseExpired: () => true,
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 7).ok).toBe(false);
    expect(stepOf(report, 7).evidence.expired).toEqual(['T-1']);
    expect(report.blocked_by.filter((r) => r === RESUME_BLOCK_REASONS.LEASE_EXPIRED)).toHaveLength(1);
    expect(report.evidence.counts.expired_leases).toBe(1);
  });

  it('fails closed with lease-clock-unknown when no clock is injected', async () => {
    const report = await buildResumeReport(makePorts({ now: null }), { missionId: MISSION });
    expect(stepOf(report, 7).ok).toBe(null);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.LEASE_CLOCK_UNKNOWN);
  });

  it('fails closed when the clock returns something the lease adapter would reject', async () => {
    const report = await buildResumeReport(makePorts({ now: () => 'noon' }), { missionId: MISSION });
    expect(stepOf(report, 7).ok).toBe(null);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.LEASE_CLOCK_UNKNOWN);
  });

  it('fails closed when a lease cannot be judged, rather than calling it unexpired', async () => {
    const ports = makePorts({
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }] }),
      getLease: () => ({ owner: 'w-1' }),
      isLeaseExpired: () => { throw new TypeError('lease adapter: expires_at must be a non-empty ISO-8601 string'); },
    });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 7).ok).toBe(null);
    expect(stepOf(report, 7).evidence.unjudged).toEqual(['T-1']);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.LEASE_UNKNOWN);
  });
});

describe('step 8 — Reconcile Ledger (report-only)', () => {
  it('calls reconcile with apply hard-coded false', async () => {
    const ports = makePorts();
    await buildResumeReport(ports, { missionId: MISSION });
    const reconcileCalls = ports.calls.filter((c) => c.port === 'reconcile');
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0].args).toEqual([{ apply: false }]);
  });

  it('never forwards an apply flag handed in through options', async () => {
    const ports = makePorts();
    await buildResumeReport(ports, { missionId: MISSION, apply: true });
    expect(ports.calls.find((c) => c.port === 'reconcile').args[0].apply).toBe(false);
  });

  it('does not pass ledgerVersions, because no production supplier exists', async () => {
    const ports = makePorts();
    await buildResumeReport(ports, { missionId: MISSION });
    expect(ports.calls.find((c) => c.port === 'reconcile').args[0]).not.toHaveProperty('ledgerVersions');
  });

  it('is ok on a clean reconcile and reports its versions', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(stepOf(report, 8).ok).toBe(true);
    expect(stepOf(report, 8).evidence).toMatchObject({ drifted: false, storeVersion: 17, snapshotVersion: 17 });
  });

  it('blocks on drift, on extra-in-store and on gaps, and stays quiet on missing-in-store', async () => {
    const drifted = makePorts({ reconcile: () => ({ ...RECONCILE_CLEAN, ok: false, drifted: true }) });
    expect((await buildResumeReport(drifted, { missionId: MISSION })).blocked_by)
      .toContain(RESUME_BLOCK_REASONS.LEDGER_DRIFT);

    const extra = makePorts({ reconcile: () => ({ ...RECONCILE_CLEAN, extraInStore: [5] }) });
    expect((await buildResumeReport(extra, { missionId: MISSION })).blocked_by)
      .toContain(RESUME_BLOCK_REASONS.LEDGER_EXTRA_IN_STORE);

    const gaps = makePorts({ reconcile: () => ({ ...RECONCILE_CLEAN, gaps: [3] }) });
    expect((await buildResumeReport(gaps, { missionId: MISSION })).blocked_by)
      .toContain(RESUME_BLOCK_REASONS.LEDGER_GAPS);

    const behind = makePorts({ reconcile: () => ({ ...RECONCILE_CLEAN, missingInStore: [18] }) });
    const benign = await buildResumeReport(behind, { missionId: MISSION });
    expect(benign.blocked_by).toEqual([]);
    expect(stepOf(benign, 8).evidence.missingInStore).toEqual([18]);
  });

  it('runs even with no valid checkpoint, because it reads the store and not the checkpoint', async () => {
    const ports = makePorts({ latestValid: async () => ({ ok: false, record: null, errors: [] }) });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 8).ok).toBe(true);
  });
});

describe('step 9 — Re-evaluate model (recorded, never selected)', () => {
  it('records previous, current and whether they are the same', async () => {
    const report = await buildResumeReport(makePorts(), { missionId: MISSION });
    expect(stepOf(report, 9).ok).toBe(true);
    expect(stepOf(report, 9).evidence).toMatchObject({ previous: 'opus', current: 'opus', same: true });
  });

  it('reports a changed model without blocking on it', async () => {
    const ports = makePorts({ resolveModel: () => 'fable' });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 9).ok).toBe(true);
    expect(stepOf(report, 9).evidence).toMatchObject({ previous: 'opus', current: 'fable', same: false });
    expect(report.blocked_by).toEqual([]);
    expect(report.resumable).toBe(true);
  });

  it('passes the checkpoint model to the resolver, not a model of its own', async () => {
    const ports = makePorts();
    await buildResumeReport(ports, { missionId: MISSION });
    expect(ports.calls.find((c) => c.port === 'resolveModel').args).toEqual(['opus']);
  });

  it('fails closed with model-unknown when nothing resolves', async () => {
    const ports = makePorts({ resolveModel: () => null });
    const report = await buildResumeReport(ports, { missionId: MISSION });
    expect(stepOf(report, 9).ok).toBe(null);
    expect(stepOf(report, 9).evidence.current).toBe(null);
    expect(report.blocked_by).toContain(RESUME_BLOCK_REASONS.MODEL_UNKNOWN);
  });
});
