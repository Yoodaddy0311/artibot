/**
 * `lib/checkpoint/checkpoint-validator` — the delegation must stay a
 * delegation. These tests compare it against `lib/supervisor/contracts`
 * directly, so a second, drifting copy of the field list would fail here.
 */

import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_FIELDS,
  CHECKPOINT_REQUIRED_FIELDS,
  isResumable,
  validateCheckpoint,
} from '../../lib/checkpoint/checkpoint-validator.js';
import * as contracts from '../../lib/supervisor/contracts.js';

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

const CASES = [
  ['full', FULL],
  ['minimal', { mission_id: 'm', session_id: 's', intent_revision: 0, plan_revision: 0, resumable: true }],
  ['missing mission_id', { ...FULL, mission_id: undefined }],
  ['wrong type', { ...FULL, plan_revision: '5' }],
  ['unknown key', { ...FULL, extra: 1 }],
  ['not an object', []],
  ['null', null],
];

describe('checkpoint-validator delegation', () => {
  it.each(CASES)('returns exactly the contracts result for %s', (_label, input) => {
    expect(validateCheckpoint(input)).toEqual(contracts.validateCheckpoint(input));
  });

  it('re-exports the field constants by identity, not by copy', () => {
    expect(CHECKPOINT_FIELDS).toBe(contracts.CHECKPOINT_FIELDS);
    expect(CHECKPOINT_REQUIRED_FIELDS).toBe(contracts.CHECKPOINT_REQUIRED_FIELDS);
  });
});

describe('isResumable', () => {
  it('is true for a store record whose checkpoint validates and is resumable', () => {
    expect(isResumable({ v: 1, checkpoint_id: 'c1', mission_id: 'm-1', ts: '2026-09-12T00:00:00Z', checkpoint: FULL })).toBe(true);
  });

  it('is false when the checkpoint says resumable: false', () => {
    const record = { v: 1, checkpoint_id: 'c1', mission_id: 'm-1', ts: '2026-09-12T00:00:00Z', checkpoint: { ...FULL, resumable: false } };
    expect(isResumable(record)).toBe(false);
  });

  it('is false when the checkpoint fails validation', () => {
    const record = { v: 1, checkpoint_id: 'c1', mission_id: 'm-1', ts: '2026-09-12T00:00:00Z', checkpoint: { ...FULL, extra: 1 } };
    expect(isResumable(record)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty record', {}],
    ['an array', []],
    ['a bare checkpoint (no record envelope)', FULL],
  ])('is false for %s', (_label, input) => {
    expect(isResumable(input)).toBe(false);
  });
});
