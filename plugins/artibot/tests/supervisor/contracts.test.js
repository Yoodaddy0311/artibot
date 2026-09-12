/**
 * `lib/supervisor/contracts` — validators mirror the design JSON schemas.
 *
 * The design's own example files are used as the positive fixtures when they
 * are present; the structural negatives are hand-written.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_FIELDS,
  CHECKPOINT_REQUIRED_FIELDS,
  isLaneOpsState,
  isLaneTerminal,
  isRunTerminal,
  LANE_OPS_STATES,
  LANE_OPS_TO_LANE_STATE,
  LANE_STATES,
  RUN_LINEAR_STATES,
  RUN_STATES,
  validateCheckpoint,
  validateEvent,
  validateLaneState,
  validateRunState,
} from '../../lib/supervisor/contracts.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN = path.resolve(PLUGIN_ROOT, '..', '..', 'docs', 'artibot-vnext-autonomous-runtime-design-v1.0', 'artibot-vnext-design');

/**
 * @param {string} rel
 * @returns {string|null}
 */
function designFile(rel) {
  try {
    return readFileSync(path.join(DESIGN, rel), 'utf-8');
  } catch {
    return null;
  }
}

const GOOD = Object.freeze({
  version: 1, eventId: 'e1', ts: '2026-09-01T08:00:00Z', runId: 'split-x', laneId: null,
  type: 'run-created', source: 'supervisor', actionId: null, evidenceRef: null, data: {},
});

describe('state vocabularies', () => {
  it('run/lane enums match the schema files when present', () => {
    const run = designFile('contracts/run-state.schema.json');
    const lane = designFile('contracts/lane-state.schema.json');
    if (run) expect([...RUN_STATES]).toEqual(JSON.parse(run).properties.state.enum);
    if (lane) expect([...LANE_STATES]).toEqual(JSON.parse(lane).properties.state.enum);
  });

  it('linear chain is a subset of RUN_STATES ending in COMPLETED', () => {
    for (const s of RUN_LINEAR_STATES) expect(RUN_STATES).toContain(s);
    expect(RUN_LINEAR_STATES[0]).toBe('CREATED');
    expect(RUN_LINEAR_STATES.at(-1)).toBe('COMPLETED');
  });

  it('terminal predicates', () => {
    expect(isRunTerminal('COMPLETED')).toBe(true);
    expect(isRunTerminal('BLOCKED')).toBe(false);
    expect(isLaneTerminal('ABORTED')).toBe(true);
    expect(isLaneTerminal('DONE')).toBe(true);
    expect(isLaneTerminal('FAILED_RECOVERABLE')).toBe(false);
  });

  it('every ops state maps onto a real lane state; nothing outside the allowlist is an ops state', () => {
    // Pins the allowlist, so widening it has to come through here. `failed` was
    // added 9th (v5 T-45); why it is safe, and the emitter count that makes it
    // safe, live in tests/supervisor/v11-status-mapping.test.js.
    expect(LANE_OPS_STATES).toEqual([
      'pending', 'active', 'awaiting-dispatch', 'review', 'serial-gate', 'closing', 'done', 'suspended',
      'failed',
    ]);
    for (const ops of LANE_OPS_STATES) {
      expect(isLaneOpsState(ops)).toBe(true);
      expect(LANE_STATES).toContain(LANE_OPS_TO_LANE_STATE[ops]);
    }
    expect(Object.keys(LANE_OPS_TO_LANE_STATE).sort()).toEqual([...LANE_OPS_STATES].sort());
    expect(isLaneOpsState('ACTIVE')).toBe(false);
    expect(isLaneOpsState('running')).toBe(false);
    expect(isLaneOpsState(null)).toBe(false);
  });
});

describe('validateEvent', () => {
  it('accepts the design example stream line by line', () => {
    const text = designFile('examples/events.example.ndjson');
    if (!text) return;
    const lines = text.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(validateEvent(JSON.parse(l))).toEqual({ ok: true, errors: [] });
  });

  it('accepts a minimal envelope and rejects each missing required field', () => {
    expect(validateEvent(GOOD).ok).toBe(true);
    for (const key of ['version', 'eventId', 'ts', 'runId', 'type', 'source']) {
      const bad = { ...GOOD };
      delete bad[key];
      const r = validateEvent(bad);
      expect(r.ok, key).toBe(false);
      expect(r.errors.join(' ')).toContain(key);
    }
  });

  it('rejects wrong version, bad type pattern, unknown source, unknown key, bad ts', () => {
    expect(validateEvent({ ...GOOD, version: 2 }).ok).toBe(false);
    expect(validateEvent({ ...GOOD, type: 'RunCreated' }).ok).toBe(false);
    expect(validateEvent({ ...GOOD, type: 'x' }).ok).toBe(false);
    expect(validateEvent({ ...GOOD, source: 'model' }).ok).toBe(false);
    expect(validateEvent({ ...GOOD, sessionId: 'nope' }).errors).toContain('unknown key: sessionId');
    expect(validateEvent({ ...GOOD, ts: 'yesterday' }).ok).toBe(false);
    expect(validateEvent({ ...GOOD, laneId: 7 }).ok).toBe(false);
    expect(validateEvent(null).ok).toBe(false);
    expect(validateEvent([]).ok).toBe(false);
  });
});

describe('validateRunState / validateLaneState', () => {
  it('accepts the design run-state example', () => {
    const text = designFile('examples/run-state.example.json');
    if (!text) return;
    expect(validateRunState(JSON.parse(text))).toEqual({ ok: true, errors: [] });
  });

  it('flags structural problems with the offending path', () => {
    const base = {
      version: 1, runId: 'r', state: 'CREATED', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', lanes: {},
    };
    expect(validateRunState(base).ok).toBe(true);
    expect(validateRunState({ ...base, state: 'RUNNING' }).ok).toBe(false);
    expect(validateRunState({ ...base, lanes: [] }).ok).toBe(false);
    expect(validateRunState({ ...base, exceptionCount: -1 }).ok).toBe(false);
    const r = validateRunState({ ...base, lanes: { a: { laneId: 'a', state: 'NOPE', attempt: 0, ownedPaths: [] } } });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/^lanes\.a: state/);
  });

  it('lane: attempt integer, ownedPaths unique strings, verdict enum', () => {
    const ok = { laneId: 'a', state: 'PENDING', attempt: 0, ownedPaths: ['x/'] };
    expect(validateLaneState(ok).ok).toBe(true);
    expect(validateLaneState({ ...ok, attempt: 1.5 }).ok).toBe(false);
    expect(validateLaneState({ ...ok, ownedPaths: ['x/', 'x/'] }).ok).toBe(false);
    expect(validateLaneState({ ...ok, reviewVerdict: 'MAYBE' }).ok).toBe(false);
    expect(validateLaneState({ ...ok, reviewVerdict: null }).ok).toBe(true);
    expect(validateLaneState({ ...ok, lastHeartbeatAt: 'soon' }).ok).toBe(false);
  });
});

/**
 * The 13 keys of the design's "Checkpoint content" block, in its order. Kept
 * written out here on purpose: if the module's own constant were the only
 * copy, the test would agree with any drift in it.
 */
const SCORECARD_CHECKPOINT_KEYS = [
  'mission_id',
  'session_id',
  'intent_revision',
  'plan_revision',
  'execution_profile_version',
  'active_tasks',
  'completed_action_results',
  'routing_epoch',
  'current_model',
  'artifact_versions',
  'replay_cursor',
  'ledger_cursor',
  'resumable',
];

const FULL_CHECKPOINT = Object.freeze({
  mission_id: 'm-1',
  session_id: 's-1',
  intent_revision: 3,
  plan_revision: 5,
  execution_profile_version: 2,
  active_tasks: [{ id: 't1' }],
  completed_action_results: [{ id: 'a1' }],
  routing_epoch: 'epoch-7',
  current_model: 'opus',
  artifact_versions: { 'docs/x.md': 2 },
  replay_cursor: 0,
  ledger_cursor: 12,
  resumable: true,
});

const MINIMAL_CHECKPOINT = Object.freeze({
  mission_id: 'm-1', session_id: 's-1', intent_revision: 0, plan_revision: 0, resumable: false,
});

/**
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function withoutKey(key) {
  const copy = { ...FULL_CHECKPOINT };
  delete copy[key];
  return copy;
}

describe('validateCheckpoint', () => {
  it('the field list is the 13 keys of the design block, in order', () => {
    expect([...CHECKPOINT_FIELDS]).toEqual(SCORECARD_CHECKPOINT_KEYS);
    expect(CHECKPOINT_FIELDS).toHaveLength(13);
  });

  it('every required field is one of the 13', () => {
    for (const key of CHECKPOINT_REQUIRED_FIELDS) expect(CHECKPOINT_FIELDS).toContain(key);
    expect(CHECKPOINT_REQUIRED_FIELDS.length).toBeLessThan(CHECKPOINT_FIELDS.length);
  });

  it('accepts a checkpoint carrying all 13 fields', () => {
    expect(validateCheckpoint(FULL_CHECKPOINT)).toEqual({ ok: true, errors: [] });
  });

  it('accepts a checkpoint carrying only the required fields', () => {
    expect(validateCheckpoint(MINIMAL_CHECKPOINT)).toEqual({ ok: true, errors: [] });
  });

  it.each([...CHECKPOINT_REQUIRED_FIELDS])('rejects a checkpoint missing %s', (key) => {
    const r = validateCheckpoint(withoutKey(key));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith(`${key}: must be`))).toBe(true);
  });

  it.each([
    ['mission_id', ''],
    ['mission_id', 7],
    ['session_id', 7],
    ['intent_revision', -1],
    ['intent_revision', 1.5],
    ['plan_revision', '4'],
    ['resumable', 'true'],
    ['execution_profile_version', -1],
    ['active_tasks', {}],
    ['completed_action_results', 'none'],
    ['artifact_versions', []],
    ['current_model', 7],
    ['routing_epoch', 7],
    ['replay_cursor', -1],
    ['ledger_cursor', 1.5],
  ])('rejects %s of the wrong type', (key, bad) => {
    const r = validateCheckpoint({ ...FULL_CHECKPOINT, [key]: bad });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith(`${key}: must be`))).toBe(true);
  });

  it.each(['execution_profile_version', 'current_model', 'routing_epoch', 'replay_cursor', 'ledger_cursor'])(
    'accepts null for the nullable optional %s',
    (key) => {
      expect(validateCheckpoint({ ...FULL_CHECKPOINT, [key]: null }).ok).toBe(true);
    },
  );

  it('accepts the string forms of the cursor and profile fields', () => {
    const r = validateCheckpoint({
      ...FULL_CHECKPOINT,
      execution_profile_version: 'v2',
      replay_cursor: 'evt-9',
      ledger_cursor: 'evt-9',
      routing_epoch: { id: 'e7' },
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('rejects an unknown top-level key (allowlist, fail-closed)', () => {
    const r = validateCheckpoint({ ...FULL_CHECKPOINT, model_hint: 'opus' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('unknown key: model_hint');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'checkpoint'],
    ['a number', 3],
  ])('rejects %s as the checkpoint', (_label, input) => {
    expect(validateCheckpoint(input)).toEqual({ ok: false, errors: ['checkpoint: must be an object'] });
  });

  it('reports every problem at once rather than the first', () => {
    const r = validateCheckpoint({ mission_id: '', session_id: 1, intent_revision: -1 });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('never throws for hostile input', () => {
    expect(() => validateCheckpoint(Object.create(null))).not.toThrow();
    expect(() => validateCheckpoint(new Map())).not.toThrow();
  });
});
