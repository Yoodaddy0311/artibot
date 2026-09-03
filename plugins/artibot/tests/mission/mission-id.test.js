/**
 * lib/mission/mission-id.js — the substantive allowlist and id issuance.
 *
 * WHAT THESE TESTS CANNOT SEE
 * ---------------------------
 *  - They assert the JUDGMENT, not the inputs. Every signal is fed here as a
 *    caller assertion; whether a real prompt pipeline supplies truthful
 *    `expected_actions` or a state-backed `activeMission` is out of scope and
 *    belongs to T-25's wiring test.
 *  - Signal DISTRIBUTION over live prompts is unmeasured. These cases prove each
 *    signal fires in isolation; they say nothing about how often any of them
 *    fires in practice, which is exactly what the Observe stage is for.
 */

import { describe, expect, it } from 'vitest';

import { COMPLETION_EXPECTATIONS } from '../../lib/intent/interpreter.js';
import {
  COMPLETION_ACTIONS,
  detectSlashCommand,
  EXECUTION_STAGE_SIGNALS,
  formatMissionDate,
  inheritMissionId,
  isMissionId,
  issueMissionId,
  judgeSubstantive,
  PROMPT_STAGE_SIGNALS,
  S1_WRITE_ACTIONS,
  S2_SHIP_ACTIONS,
  S5_COMMANDS,
  sessionFallbackMissionId,
  SUBSTANTIVE_SIGNALS,
} from '../../lib/mission/mission-id.js';

const CANON_SEVEN = ['answer', 'artifact', 'implement', 'test', 'commit', 'PR', 'deploy'];

describe('completion vocabulary is single-sourced, not copied', () => {
  it('is the SAME OBJECT as interpreter.js#COMPLETION_EXPECTATIONS', () => {
    // Reference identity, deliberately: a re-introduced copy with identical
    // contents would pass toEqual and fail here, which is the drift this guards.
    expect(COMPLETION_ACTIONS).toBe(COMPLETION_EXPECTATIONS);
  });

  it('carries the canonical seven with PR uppercased', () => {
    expect(COMPLETION_ACTIONS).toEqual(CANON_SEVEN);
    expect(COMPLETION_ACTIONS).toContain('PR');
    expect(COMPLETION_ACTIONS).not.toContain('pr');
  });

  it('S1 and S2 are verbatim SUBSETS of the canonical seven', () => {
    for (const action of [...S1_WRITE_ACTIONS, ...S2_SHIP_ACTIONS]) {
      expect(COMPLETION_ACTIONS).toContain(action);
    }
  });

  it('S1 and S2 are disjoint and neither claims "answer"', () => {
    const s1 = new Set(S1_WRITE_ACTIONS);
    expect(S2_SHIP_ACTIONS.some((a) => s1.has(a))).toBe(false);
    expect([...S1_WRITE_ACTIONS, ...S2_SHIP_ACTIONS]).not.toContain('answer');
  });
});

describe('completion matching folds case', () => {
  it('accepts the canonical "PR" and fires S2', () => {
    const result = judgeSubstantive({
      stage: 'execution',
      completion: { expected_actions: ['PR'] },
    });
    expect(result.signals).toEqual(['S2']);
  });

  it('accepts a lowercased "pr" from a looser caller', () => {
    expect(judgeSubstantive({
      stage: 'execution',
      completion: { expected_actions: ['pr'] },
    }).signals).toEqual(['S2']);
  });

  it('reports the CANONICAL spelling whatever the caller typed', () => {
    const lower = judgeSubstantive({
      stage: 'execution',
      completion: { expected_actions: ['pr', 'IMPLEMENT'] },
    });
    expect(lower.details.S2).toBe('ship action(s): PR');
    expect(lower.details.S1).toBe('repository-write action(s): implement');
  });

  it('still rejects a word outside the seven', () => {
    expect(judgeSubstantive({
      stage: 'execution',
      completion: { expected_actions: ['prr', 'preview'] },
    }).signals).toEqual([]);
  });
});

const twoRequests = [
  { text: 'a', span: { start: 0, end: 1 } },
  { text: 'b', span: { start: 2, end: 3 } },
];

describe('substantive judgment is an ALLOWLIST', () => {
  it('names exactly six signals', () => {
    expect(Object.keys(SUBSTANTIVE_SIGNALS)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  it('the two stage sets partition the six signals with no overlap', () => {
    const union = [...EXECUTION_STAGE_SIGNALS, ...PROMPT_STAGE_SIGNALS].sort();
    expect(union).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
    expect(new Set(union).size).toBe(6);
  });

  it('defers when NOTHING fires — a greeting makes no mission', () => {
    const result = judgeSubstantive({
      explicitRequests: [{ text: '안녕하세요', span: { start: 0, end: 5 } }],
      prompt: '안녕하세요',
    });
    expect(result.substantive).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.signals).toEqual([]);
  });

  it('defers on an unrecognized request rather than passing it through', () => {
    const result = judgeSubstantive({
      explicitRequests: [{ text: '이거 어때', span: { start: 0, end: 5 } }],
      prompt: '이거 어때',
      completion: { expected_actions: ['answer'] },
      stage: 'execution',
    });
    expect(result.deferred).toBe(true);
  });
});

describe('each of the six signals fires on its own', () => {
  it('S1 — a repository-write completion expectation (execution stage)', () => {
    const result = judgeSubstantive({
      stage: 'execution',
      completion: { expected_actions: ['implement'] },
    });
    expect(result.signals).toEqual(['S1']);
    expect(result.substantive).toBe(true);
  });

  it('S2 — commit / PR / deploy (execution stage)', () => {
    const result = judgeSubstantive({
      stage: 'execution',
      completion: { expected_actions: ['answer', 'pr'] },
    });
    expect(result.signals).toEqual(['S2']);
  });

  it('S3 — two or more explicit requests', () => {
    const result = judgeSubstantive({ explicitRequests: twoRequests });
    expect(result.signals).toEqual(['S3']);
    expect(result.details.S3).toMatch(/2 explicit requests/);
  });

  it('S4 — product_decision_required', () => {
    const result = judgeSubstantive({
      intentConfidence: { product_decision_required: true },
    });
    expect(result.signals).toEqual(['S4']);
  });

  it('S5 — an explicit planning/execution command, from the allowlist only', () => {
    for (const command of S5_COMMANDS) {
      expect(judgeSubstantive({ prompt: `/${command} do a thing` }).signals).toEqual(['S5']);
    }
    expect(judgeSubstantive({ prompt: '/daily' }).signals).toEqual([]);
  });

  it('S6 — a follow-up to an existing mission', () => {
    const result = judgeSubstantive({
      followUp: true,
      activeMission: { mission_id: 'M-20260902-001', intent_revision: 2 },
    });
    expect(result.signals).toEqual(['S6']);
    expect(result.details.S6).toBe('follow-up to M-20260902-001 r2');
  });

  it('S6 does NOT fire on a malformed mission id, nor without followUp', () => {
    expect(judgeSubstantive({
      followUp: true, activeMission: { mission_id: 'nope' },
    }).signals).toEqual([]);
    expect(judgeSubstantive({
      activeMission: { mission_id: 'M-20260902-001' },
    }).signals).toEqual([]);
  });
});

describe('two-stage issuance (design §3.3)', () => {
  it('prompt stage IGNORES S1/S2 even when the caller supplies them', () => {
    const result = judgeSubstantive({
      stage: 'prompt',
      completion: { expected_actions: ['implement', 'commit', 'deploy'] },
    });
    expect(result.signals).toEqual([]);
    expect(result.substantive).toBe(false);
    expect(result.skipped.map((s) => s.signal)).toEqual(['S1', 'S2']);
  });

  it('the same input at execution stage promotes it', () => {
    const result = judgeSubstantive({
      stage: 'execution',
      completion: { expected_actions: ['implement', 'commit'] },
    });
    expect(result.signals).toEqual(['S1', 'S2']);
    expect(result.skipped).toEqual([]);
  });

  it('defaults to the conservative prompt stage', () => {
    expect(judgeSubstantive({}).stage).toBe('prompt');
  });

  it('throws on an unknown stage (fail-closed)', () => {
    expect(() => judgeSubstantive({ stage: 'later' })).toThrow(TypeError);
  });
});

describe('detectSlashCommand()', () => {
  it('reads a leading command and lowercases it', () => {
    expect(detectSlashCommand('/Split plan')).toBe('split');
    expect(detectSlashCommand('  /autopilot')).toBe('autopilot');
  });

  it('returns null for prose and for a mid-prompt slash', () => {
    expect(detectSlashCommand('split 을 업그레이드해줘')).toBeNull();
    expect(detectSlashCommand('run lib/a.js /split')).toBeNull();
    expect(detectSlashCommand('')).toBeNull();
  });

  it('an explicitly passed slashCommand overrides prompt detection', () => {
    const result = judgeSubstantive({ prompt: 'no command here', slashCommand: 'plan' });
    expect(result.signals).toEqual(['S5']);
  });
});

describe('mission id issuance', () => {
  // 2026-09-02T00:00:00Z
  const nowMs = Date.UTC(2026, 8, 2, 0, 0, 0);

  it('formats the date half in UTC so the same input yields the same id anywhere', () => {
    expect(formatMissionDate(nowMs)).toBe('20260902');
    expect(formatMissionDate(Date.UTC(2026, 0, 5))).toBe('20260105');
  });

  it('throws when nowMs is not a finite number', () => {
    expect(() => formatMissionDate(undefined)).toThrow(TypeError);
    expect(() => formatMissionDate(Number.NaN)).toThrow(TypeError);
  });

  it('issues M-YYYYMMDD-NNN from a caller-supplied counter', () => {
    expect(issueMissionId({ counter: 1, nowMs })).toBe('M-20260902-001');
    expect(issueMissionId({ counter: 42, nowMs })).toBe('M-20260902-042');
    expect(isMissionId(issueMissionId({ counter: 7, nowMs }))).toBe(true);
  });

  it('lets the counter run past three digits (schema pattern is \\d{3,})', () => {
    const id = issueMissionId({ counter: 1001, nowMs });
    expect(id).toBe('M-20260902-1001');
    expect(isMissionId(id)).toBe(true);
  });

  it('throws on a non-integer or non-positive counter rather than clamping', () => {
    expect(() => issueMissionId({ counter: 0, nowMs })).toThrow(TypeError);
    expect(() => issueMissionId({ counter: 1.5, nowMs })).toThrow(TypeError);
    expect(() => issueMissionId({ nowMs })).toThrow(TypeError);
  });

  it('accepts a YYYYMMDD override for a local calendar day', () => {
    expect(issueMissionId({ counter: 3, date: '20260101' })).toBe('M-20260101-003');
    expect(() => issueMissionId({ counter: 3, date: '2026-01-01' })).toThrow(TypeError);
  });
});

describe('session fallback id', () => {
  const nowMs = Date.UTC(2026, 8, 2);

  it('takes the first 8 alphanumerics of the session id', () => {
    const id = sessionFallbackMissionId({
      sessionId: 'ap-20260902-062936-tyc5j4',
      nowMs,
    });
    expect(id).toBe('M-20260902-Sap202609');
    expect(isMissionId(id)).toBe(true);
  });

  it('throws rather than padding when the session id is too short', () => {
    expect(() => sessionFallbackMissionId({ sessionId: 'ab-12', nowMs })).toThrow(TypeError);
    expect(() => sessionFallbackMissionId({ nowMs })).toThrow(TypeError);
  });

  it('produces an id the contract pattern accepts, so ledger envelopes stay complete', () => {
    const id = sessionFallbackMissionId({ sessionId: 'tyc5j4aa-extra', nowMs });
    expect(id).toBe('M-20260902-Styc5j4aa');
    expect(isMissionId(id)).toBe(true);
  });
});

describe('parent issues, worker inherits', () => {
  it('inheritMissionId returns the parent id unchanged', () => {
    expect(inheritMissionId('M-20260902-001')).toBe('M-20260902-001');
  });

  it('inheritMissionId rejects a malformed parent id', () => {
    expect(() => inheritMissionId('M-2026-1')).toThrow(TypeError);
    expect(() => inheritMissionId(null)).toThrow(TypeError);
  });

  it('isMissionId is the shared predicate', () => {
    expect(isMissionId('M-20260902-Styc5j4aa')).toBe(true);
    expect(isMissionId(42)).toBe(false);
  });
});
