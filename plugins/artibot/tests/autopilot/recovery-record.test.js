/**
 * SH-06 — tests for `lib/autopilot/recovery-record.js`, the Observe-stage
 * recorder that writes a recovery judgement at the VERIFY result point.
 *
 * The load-bearing claim of this suite is NEGATIVE: the recorder changes no
 * behavior. `nextTarget` / `pendingPhase` / `phase` are snapshotted across a
 * failing VERIFY record and must be identical, and the fixed `IMPROVE`
 * transition must survive. CA-03 is what later reads the journal and acts on
 * it; until then a green run here means "a judgement exists and was written",
 * not "recovery works".
 *
 * ISOLATION. Every session id is unique per test and `deleteSessionArtifacts`
 * removes both the session JSON and the `.events.ndjson` afterwards, which is
 * the same contract `tests/autopilot/telemetry.test.js` uses. No artifact
 * writer (`generatePRD` / `generateReport`) and no decisions-store writer is
 * reached from here, so neither firewall gate applies — `runPhase4Verify` is
 * imported only to pin the `onFailure` payload and is not one of the five
 * engine entry points those gates scan for.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { runPhase4Verify } from '../../lib/autopilot/engine.js';
import { nextTarget, recordPhaseResult } from '../../lib/autopilot/engine-state.js';
import {
  adaptVerdict,
  foldVerify,
  recordRecoveryDecision,
  VERIFY_ON_FAILURE,
} from '../../lib/autopilot/recovery-record.js';
import { deleteSessionArtifacts } from '../../lib/autopilot/session-store.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';
import { ADAPTER_ROWS } from '../../lib/review/independent-reviewer.js';

const tracked = [];

/** A throwaway session id whose artifacts are removed in afterEach. */
function trackSession(label) {
  const id = `ap-test-recovery-record-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tracked.push(id);
  return id;
}

afterEach(() => {
  while (tracked.length) {
    try {
      deleteSessionArtifacts(tracked.pop());
    } catch {
      /* cleanup is best-effort */
    }
  }
});

function makeState(label, overrides = {}) {
  return {
    sessionId: trackSession(label),
    phase: 'VERIFY',
    pendingPhase: null,
    phases: [],
    counters: { buildFailures: 0, testFailures: 0 },
    ...overrides,
  };
}

/** The payload `recordPhaseResult` hands the recorder for a VERIFY result. */
function verifyPayload(status, extra = {}) {
  return { phase: 'VERIFY', status, fixedNext: 'IMPROVE', ...extra };
}

describe('foldVerify — only an explicit signal is a measurement', () => {
  it.each([
    ['explicit status PASS', { status: 'PASS' }, 'PASS'],
    ['explicit status FAIL', { status: 'FAIL' }, 'FAIL'],
    ['explicit status UNMEASURED', { status: 'UNMEASURED' }, 'UNMEASURED'],
    ['boolean ok=true', { ok: true }, 'PASS'],
    ['boolean ok=false', { ok: false }, 'FAIL'],
    ['boolean passed=true', { passed: true }, 'PASS'],
    ['boolean passed=false', { passed: false }, 'FAIL'],
    ['agreeing signals', { status: 'PASS', ok: true, passed: true }, 'PASS'],
  ])('reads %s as %s', (_label, input, expected) => {
    expect(foldVerify(input)).toBe(expected);
  });

  it.each([
    ['free-form driver prose', { lint: 'ok', test: '3 failed' }],
    ['the mcp slot the engine creates', { mcp: { ok: null, violations: [] } }],
    ['a bare exit code', { exitCode: 1 }],
    ['null', null],
    ['undefined', undefined],
    ['a non-object', 'FAIL'],
    ['an empty object', {}],
    ['an unknown status word', { status: 'green' }],
    ['a non-boolean ok', { ok: 'yes' }],
  ])('refuses to guess from %s and answers UNMEASURED', (_label, input) => {
    expect(foldVerify(input)).toBe('UNMEASURED');
  });

  it('treats contradicting explicit signals as unmeasured, not as a vote', () => {
    // A contradiction is not a measurement. Picking either side here would be
    // the fail-open shape UNMEASURED exists to prevent (design section 3.4).
    expect(foldVerify({ status: 'PASS', ok: false })).toBe('UNMEASURED');
    expect(foldVerify({ ok: true, passed: false })).toBe('UNMEASURED');
    expect(foldVerify({ status: 'FAIL', passed: true })).toBe('UNMEASURED');
  });

  it('is pure — folding never mutates its input', () => {
    const input = { status: 'FAIL', ok: false };
    const snapshot = JSON.stringify(input);
    foldVerify(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('adaptVerdict — the adapter map is the only source of mappings', () => {
  it('folds the three tokens the CROSS_CHECK driver is told to emit', () => {
    // engine.js#runPhase3CrossCheck instructs the driver to write
    // "pass" | "warn" | "fail" into state.crossCheck.verdict.
    expect(adaptVerdict('pass')).toBe('PASS');
    expect(adaptVerdict('fail')).toBe('REPAIR_REQUIRED');
    // "warn" is carried by the `autopilot-driver` source in the adapter map,
    // which downgrades it to PASS exactly like every other WARN-family row.
    // This is observability only: the recorder folds a PASS verdict to null
    // before `classify()` sees it (recovery-record.js#judge), so the class,
    // action and verificationStatus are the same as they were when the token
    // was unmapped. See the invariance assertion in "keeps the raw token
    // beside the adapted verdict" below.
    expect(adaptVerdict('warn')).toBe('PASS');
  });

  it('returns null for an unmapped token rather than downgrading it', () => {
    expect(adaptVerdict('LGTM')).toBeNull();
    expect(adaptVerdict('')).toBeNull();
    expect(adaptVerdict(null)).toBeNull();
    expect(adaptVerdict(undefined)).toBeNull();
    expect(adaptVerdict(7)).toBeNull();
  });

  it('returns null for the one ambiguous row instead of picking a candidate', () => {
    expect(adaptVerdict('SPEC_FAIL')).toBeNull();
  });

  it('trims surrounding whitespace before matching', () => {
    expect(adaptVerdict('  fail  ')).toBe('REPAIR_REQUIRED');
  });

  it('agrees with every adapter row — data-driven, so no mapping is hardcoded', () => {
    // Derive the expectation from ADAPTER_ROWS itself. If this function ever
    // grows its own table, a row edit makes the two disagree and this goes red.
    const byToken = new Map();
    for (const row of ADAPTER_ROWS) {
      const key = row.token.toLowerCase();
      if (!byToken.has(key)) byToken.set(key, []);
      byToken.get(key).push(row);
    }
    expect(byToken.size).toBeGreaterThan(8); // the scan found real rows

    for (const [token, rows] of byToken) {
      const verdicts = [...new Set(rows.map((r) => r.verdict))];
      const expected = rows.some((r) => r.ambiguous) || verdicts.length > 1
        ? null
        : verdicts[0];
      expect({ token, verdict: adaptVerdict(token) }).toEqual({ token, verdict: expected });
    }
  });
});

describe('recordRecoveryDecision — a PASS is not a failure and is not recorded', () => {
  it.each([
    ['an explicit PASS verdict', 'pass'],
    ['a driver warn that folds to PASS', 'warn'],
    // Keep the null-fold path covered now that "warn" no longer takes it.
    ['an unmapped verdict that folds to null', 'LGTM'],
    ['no cross-check at all', undefined],
  ])('writes nothing for done + verification PASS with %s', (_label, verdict) => {
    const state = makeState('pass', {
      verifyResult: { status: 'PASS' },
      crossCheck: verdict === undefined ? undefined : { verdict },
    });

    expect(recordRecoveryDecision(state, verifyPayload('done'))).toBeNull();
    expect(state.recoveryJournal).toBeUndefined();
    expect(readEvents(state.sessionId)).toHaveLength(0);
  });

  it('still records when the reviewer said fail even though verification passed', () => {
    const state = makeState('reviewer-fail', {
      verifyResult: { ok: true },
      crossCheck: { verdict: 'fail' },
    });
    const row = recordRecoveryDecision(state, verifyPayload('done'));
    expect(row).not.toBeNull();
    expect(state.recoveryJournal).toHaveLength(1);
  });
});

describe('recordRecoveryDecision — the four trigger shapes', () => {
  const REQUIRED_FIELDS = [
    'at', 'phase', 'status', 'verdictRaw', 'verdict', 'verificationStatus',
    'class', 'classReason', 'action', 'target', 'reason', 'repairAttempts',
    'sameClassAttempts', 'retryLimit', 'fixedNext', 'divergent', 'recordedBy',
  ];

  it.each([
    ['a non-done status', 'failed', { verifyResult: { ok: false } }],
    ['a fail verdict', 'done', { crossCheck: { verdict: 'fail' }, verifyResult: { ok: true } }],
    ['verification folding to FAIL', 'done', { verifyResult: { status: 'FAIL' } }],
    ['done with an unmeasured verification', 'done', { verifyResult: { lint: 'ok' } }],
  ])('records exactly one fully-populated row for %s', (_label, status, overrides) => {
    const state = makeState('trigger', overrides);
    const row = recordRecoveryDecision(state, verifyPayload(status));

    expect(state.recoveryJournal).toHaveLength(1);
    expect(state.recoveryJournal[0]).toBe(row);
    for (const field of REQUIRED_FIELDS) {
      expect({ field, present: Object.hasOwn(row, field) }).toEqual({ field, present: true });
    }
    expect(row.phase).toBe('VERIFY');
    expect(row.status).toBe(status);
    expect(row.fixedNext).toBe('IMPROVE');
    expect(row.divergent).toBe(true);
    expect(row.recordedBy).toBe('recovery-record');
    expect(typeof row.reason).toBe('string');
    expect(row.reason.length).toBeGreaterThan(0);

    const events = readEvents(state.sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('recovery-decided');
    expect(events[0].phase).toBe('VERIFY');
    expect(events[0].data).toMatchObject({
      class: row.class,
      action: row.action,
      target: row.target,
      fixedNext: 'IMPROVE',
      divergent: true,
    });
  });

  it('keeps the raw token beside the adapted verdict', () => {
    const state = makeState('raw', { crossCheck: { verdict: 'warn' }, verifyResult: { ok: false } });
    const row = recordRecoveryDecision(state, verifyPayload('done'));
    expect(row.verdictRaw).toBe('warn');
    expect(row.verdict).toBe('PASS');
    expect(row.verificationStatus).toBe('FAIL');
  });

  it('classifies a driver warn exactly as it did when the token was unmapped', () => {
    // Before the `autopilot-driver` rows existed, "warn" took the same path as
    // any unmapped token: adaptVerdict -> null. "LGTM" still takes that path,
    // so it is the before-control. `judge()` folds a PASS verdict back to null
    // for classify(), which is why adding the mapping is observability only —
    // the raw token becomes readable on the row and nothing else moves.
    const decide = (verdict, label) => {
      const state = makeState(label, {
        crossCheck: { verdict },
        verifyResult: { ok: false },
      });
      return recordRecoveryDecision(state, verifyPayload('done'));
    };
    const warned = decide('warn', 'invariance-warn');
    const unmapped = decide('LGTM', 'invariance-unmapped');

    // Whole-row comparison minus the three fields that must differ by
    // construction (timestamp, the raw token, the adapted verdict): every
    // other field — class, classReason, action, target, reason, attempts,
    // verificationStatus, fixedNext, divergent — has to be byte-identical.
    const everythingElse = ({ at: _at, verdict: _v, verdictRaw: _raw, ...rest }) => rest;
    expect(everythingElse(warned)).toEqual(everythingElse(unmapped));
    // Only the recorded verdict differs — that is the whole delta.
    expect(warned.verdict).toBe('PASS');
    expect(unmapped.verdict).toBeNull();
  });

  it('never lets a reviewer PASS stand in as verification evidence', () => {
    // classify() treats a PASS verdict as a precondition violation, so the
    // recorder hands it null and lets the fold decide the class instead.
    const state = makeState('pass-verdict', {
      crossCheck: { verdict: 'pass' },
      verifyResult: { status: 'FAIL' },
    });
    const row = recordRecoveryDecision(state, verifyPayload('done'));
    expect(row.verdict).toBe('PASS');
    expect(row.verdictRaw).toBe('pass');
    expect(row.class).toBe('implementation');
    expect(row.classReason).not.toMatch(/precondition/i);
  });
});

describe('recordRecoveryDecision — UNMEASURED is fail-closed', () => {
  it('sends an unmeasured done result to a human rather than naming a class', () => {
    const state = makeState('unmeasured', { verifyResult: { lint: 'ok' } });
    const row = recordRecoveryDecision(state, verifyPayload('done'));
    expect(row.verificationStatus).toBe('UNMEASURED');
    expect(row.class).toBe('unknown');
    expect(row.action).toBe('ask_human');
    expect(row.target).toBe('human');
  });
});

describe('VERIFY_ON_FAILURE mirrors the payload the engine actually emits', () => {
  it('matches runPhase4Verify(state).onFailure on retryLimit and escalateTo', () => {
    const state = makeState('onfailure');
    const instruction = runPhase4Verify(state);
    expect(VERIFY_ON_FAILURE.retryLimit).toBe(instruction.onFailure.retryLimit);
    expect(VERIFY_ON_FAILURE.escalateTo).toBe(instruction.onFailure.escalateTo);
  });

  it('snapshots the budget onto the row so an old judgement stays readable', () => {
    const state = makeState('retrylimit-row', { verifyResult: { status: 'FAIL' } });
    const row = recordRecoveryDecision(state, verifyPayload('failed'));
    expect(row.retryLimit).toBe(VERIFY_ON_FAILURE.retryLimit);
  });
});

describe('recordRecoveryDecision — counters and the ladder', () => {
  it('sums build and test failures into repairAttempts', () => {
    const state = makeState('counters', {
      counters: { buildFailures: 1, testFailures: 2 },
      verifyResult: { status: 'FAIL' },
    });
    const row = recordRecoveryDecision(state, verifyPayload('failed'));
    expect(row.repairAttempts).toBe(3);
  });

  it('treats absent or non-integer counters as zero', () => {
    const state = makeState('counters-missing', {
      counters: { buildFailures: 'two' },
      verifyResult: { status: 'FAIL' },
    });
    expect(recordRecoveryDecision(state, verifyPayload('failed')).repairAttempts).toBe(0);
  });

  it('counts the same class in the journal and climbs the rung on a repeat', () => {
    const state = makeState('sameclass', {
      crossCheck: { verdict: 'fail' },
      verifyResult: { status: 'FAIL' },
      recoveryJournal: [{ at: '2026-09-15T00:00:00.000Z', class: 'implementation' }],
    });
    const row = recordRecoveryDecision(state, verifyPayload('failed'));
    expect(row.class).toBe('implementation');
    expect(row.sameClassAttempts).toBe(2);
    // Hardening section 35 rung 2: a repeated same-class failure replans.
    expect(row.action).toBe('replan');
    expect(state.recoveryJournal).toHaveLength(2);
  });
});

describe('recordRecoveryDecision — a recording failure must not block the ACK', () => {
  it('journals the failure and lets recordPhaseResult finish normally', () => {
    const state = makeState('throwing', { verifyResult: { ok: false } });
    // Non-enumerable so JSON.stringify (and therefore persist) skips it, while
    // any read of state.crossCheck inside the recorder throws.
    Object.defineProperty(state, 'crossCheck', {
      get() { throw new Error('injected crossCheck read failure'); },
      enumerable: false,
      configurable: true,
    });

    expect(() => recordPhaseResult(state, { phase: 'VERIFY', status: 'failed' })).not.toThrow();
    expect(state.phases.some((p) => p.name === 'VERIFY' && p.status === 'failed')).toBe(true);

    expect(state.recoveryJournal).toHaveLength(1);
    expect(state.recoveryJournal[0]).toMatchObject({ phase: 'VERIFY', recordFailed: true });
    expect(state.recoveryJournal[0].error).toMatch(/injected crossCheck read failure/);

    const failures = readEvents(state.sessionId).filter((e) => e.type === 'recovery-record-failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].level).toBe('warn');
  });

  it('returns null instead of throwing when reading sessionId itself throws', () => {
    // The failure path reads state.sessionId to emit telemetry. An accessor
    // that throws there used to escape the recorder entirely — the never-throw
    // contract broken on the one path that exists to uphold it. Pinned by a
    // direct call: through recordPhaseResult, saveSession hits the same getter
    // first, so that route measures session-store, not this module.
    const state = makeState('sessionid-throws', { verifyResult: { ok: false } });
    Object.defineProperty(state, 'crossCheck', {
      get() { throw new Error('injected crossCheck read failure'); },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(state, 'sessionId', {
      get() { throw new Error('injected sessionId read failure'); },
      enumerable: false,
      configurable: true,
    });

    let result;
    expect(() => {
      result = recordRecoveryDecision(state, { phase: 'VERIFY', status: 'failed' });
    }).not.toThrow();
    expect(result).toBeNull();
    expect(state.recoveryJournal[0]).toMatchObject({ phase: 'VERIFY', recordFailed: true });
  });

  it('degrades to a placeholder when the thrown value has a throwing message', () => {
    const state = makeState('message-throws', { verifyResult: { ok: false } });
    Object.defineProperty(state, 'crossCheck', {
      get() { throw { get message() { throw new Error('injected message failure'); } }; },
      enumerable: false,
      configurable: true,
    });

    expect(() => recordRecoveryDecision(state, { phase: 'VERIFY', status: 'failed' }))
      .not.toThrow();
    expect(state.recoveryJournal[0]).toMatchObject({ recordFailed: true, error: 'unknown' });
  });

  it('survives a payload whose phase accessor throws', () => {
    const state = makeState('payload-throws', { verifyResult: { ok: false } });
    const payload = { status: 'failed' };
    Object.defineProperty(payload, 'phase', {
      get() { throw new Error('injected payload failure'); },
      enumerable: true,
    });
    expect(() => recordRecoveryDecision(state, payload)).not.toThrow();
  });
});

describe('recordRecoveryDecision — determinism', () => {
  it('produces an identical row for an identical state, timestamp aside', () => {
    const base = makeState('deterministic', {
      crossCheck: { verdict: 'fail' },
      verifyResult: { status: 'FAIL' },
      counters: { buildFailures: 1, testFailures: 0 },
    });
    const first = structuredClone(base);
    const second = structuredClone(base);

    const rowA = recordRecoveryDecision(first, verifyPayload('failed'));
    const rowB = recordRecoveryDecision(second, verifyPayload('failed'));

    const strip = ({ at: _at, ...rest }) => rest;
    expect(strip(rowA)).toEqual(strip(rowB));
    expect(typeof rowA.at).toBe('string');
    expect(Number.isNaN(Date.parse(rowA.at))).toBe(false);
  });
});

describe('behavior invariance — the fixed transition is untouched', () => {
  it('leaves phase, pendingPhase and nextTarget identical across a recording', () => {
    const state = makeState('invariant', {
      phase: 'VERIFY',
      pendingPhase: null,
      crossCheck: { verdict: 'fail' },
      verifyResult: { status: 'FAIL' },
    });
    const before = { phase: state.phase, pendingPhase: state.pendingPhase, next: nextTarget(state) };

    recordRecoveryDecision(state, verifyPayload('failed'));

    expect({ phase: state.phase, pendingPhase: state.pendingPhase, next: nextTarget(state) })
      .toEqual(before);
    expect(nextTarget(state)).toBe('IMPROVE');
    expect(state.recoveryJournal).toHaveLength(1);
    // The journal records the recommendation; the transition ignores it.
    expect(state.recoveryJournal[0].fixedNext).toBe('IMPROVE');
  });

  it('does not touch the instruction-facing slots', () => {
    const state = makeState('slots', {
      verifyResult: { status: 'FAIL' },
      phases: [{ name: 'VERIFY', status: 'failed' }],
    });
    const phasesSnapshot = JSON.stringify(state.phases);
    recordRecoveryDecision(state, verifyPayload('failed'));
    expect(JSON.stringify(state.phases)).toBe(phasesSnapshot);
  });

  it('records through recordPhaseResult without moving the runner target', () => {
    const state = makeState('wired', {
      phase: 'VERIFY',
      pendingPhase: null,
      verifyResult: { status: 'FAIL' },
    });
    recordPhaseResult(state, { phase: 'VERIFY', status: 'failed' });
    expect(state.phase).toBe('VERIFY');
    expect(state.pendingPhase).toBeNull();
    expect(nextTarget(state)).toBe('IMPROVE');
    expect(state.recoveryJournal).toHaveLength(1);
    expect(state.recoveryJournal[0].fixedNext).toBe('IMPROVE');
  });

  it('records nothing for a phase other than VERIFY', () => {
    const state = makeState('other-phase', {
      phase: 'EXECUTE',
      verifyResult: { status: 'FAIL' },
      crossCheck: { verdict: 'fail' },
    });
    recordPhaseResult(state, { phase: 'EXECUTE', status: 'failed' });
    expect(state.recoveryJournal).toBeUndefined();
  });
});

describe('recordRecoveryDecision — journal initialization', () => {
  it('lazily creates the journal without session-store involvement', () => {
    const state = makeState('lazy', { verifyResult: { status: 'FAIL' } });
    expect(state.recoveryJournal).toBeUndefined();
    recordRecoveryDecision(state, verifyPayload('failed'));
    expect(Array.isArray(state.recoveryJournal)).toBe(true);
  });

  it('replaces a non-array journal rather than throwing on push', () => {
    const state = makeState('bad-journal', {
      verifyResult: { status: 'FAIL' },
      recoveryJournal: 'corrupt',
    });
    const row = recordRecoveryDecision(state, verifyPayload('failed'));
    expect(state.recoveryJournal).toEqual([row]);
  });

  it('defaults fixedNext to null when the caller supplies none', () => {
    const state = makeState('no-fixednext', { verifyResult: { status: 'FAIL' } });
    const row = recordRecoveryDecision(state, { phase: 'VERIFY', status: 'failed' });
    expect(row.fixedNext).toBeNull();
  });
});
