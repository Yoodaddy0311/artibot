/**
 * `lib/verification/unified-verifier.js` — the three-layer fold, driven with
 * injected ports only (no process, no file, no clock of its own).
 *
 * What this proves: every cell of the fold table (any FAIL → FAIL, a required
 * layer UNMEASURED → UNMEASURED, all-unmeasured floor, otherwise PASS), that an
 * unmeasured layer is never called a pass on any of its paths (absent, port
 * throws, non-numeric exitCode, unbounded readings, behavioral shell), that a
 * missing baseline leaves the regression axis UNMEASURED rather than clean, and
 * that `verification_id` is a deterministic function of the returned verdict.
 * Also that the `now` port accepts `() => Date` and nothing else (T-51 review
 * #6) — epoch ms and ISO text, which earlier versions accepted, now throw.
 *
 * What it cannot prove (rules §9): that the deterministic layer's exit codes
 * came from a real command — `evaluateGoal` is never called here, its result
 * shape is replayed from `lib/autopilot/goal-evaluator.js:107-130`. Nothing
 * here exercises a real behavioral runner, because none exists; the shell's
 * UNMEASURED is asserted as the contract, not measured against a runner. The
 * 12-hex-character hash prefix is not tested for collision resistance at any
 * corpus size — no collision budget was measured.
 */

import { describe, expect, it } from 'vitest';

import {
  behavioralShell,
  buildVerificationId,
  DEFAULT_REQUIRED_LAYERS,
  LAYERS,
  normalizeDeterministic,
  normalizeOperational,
  readClock,
  sanitizeEvidence,
  VERIFICATION_ID_VERSION,
  verify,
} from '../../lib/verification/unified-verifier.js';

const AT = () => new Date('2026-09-02T07:15:30.000Z');

/** Deterministic layer input shaped like `evaluateGoal`'s exit-0 return. */
const detPass = { met: true, confidence: 1, exitCode: 0, stdout: 'ok', stderr: '', reason: 'validationCommand exit code 0' };
const detFail = { met: false, confidence: 1, exitCode: 1, stdout: '', stderr: 'boom', reason: 'validationCommand exit code 1' };
/** The shape `evaluateGoal` returns when there is nothing to run at all. */
const detUnrun = { met: false, confidence: 0, exitCode: null, stdout: '', stderr: '', reason: 'no validationCommand — manual evaluation required' };

const opsPass = { readings: [{ metric: 'lane_stall_pct', value: 2, max: 10 }] };
const opsFail = { readings: [{ metric: 'lane_stall_pct', value: 42, max: 10 }] };
/** Numbers with no threshold: observations, not a verdict. */
const opsUnbounded = { readings: [{ metric: 'spawns', value: 63 }, { metric: 'tokens', value: 12000 }] };

const baselineAllPass = () => ({
  verification_id: 'v1-000000000000-20260901T000000Z',
  measured_at: '2026-09-01T00:00:00.000Z',
  layers: LAYERS.map((layer) => ({ layer, status: 'PASS' })),
});

function statusOf(result, layer) {
  return result.layers.find((r) => r.layer === layer).status;
}

describe('layer fold — three states, no layer silently promoted', () => {
  it('every declared layer green → PASS', () => {
    const r = verify({
      layers: { deterministic: detPass, operational: opsPass },
      required: ['deterministic', 'operational'],
      now: AT,
    });
    expect(statusOf(r, 'deterministic')).toBe('PASS');
    expect(statusOf(r, 'operational')).toBe('PASS');
    // behavioral is still unmeasured and still reported; it is simply not required here.
    expect(statusOf(r, 'behavioral')).toBe('UNMEASURED');
    expect(r.status).toBe('PASS');
  });

  it('one layer FAIL → FAIL, whatever the other layers say', () => {
    for (const layers of [
      { deterministic: detFail, operational: opsPass },
      { deterministic: detPass, operational: opsFail },
      { deterministic: detFail, operational: opsFail },
    ]) {
      expect(verify({ layers, now: AT }).status).toBe('FAIL');
    }
  });

  it('FAIL outranks a required layer being UNMEASURED', () => {
    const r = verify({
      layers: { deterministic: detUnrun, operational: opsFail },
      required: ['deterministic'],
      now: AT,
    });
    expect(r.status).toBe('FAIL');
  });

  it('required layer UNMEASURED → UNMEASURED, never PASS', () => {
    const r = verify({ layers: { deterministic: detUnrun, operational: opsPass }, now: AT });
    expect(statusOf(r, 'deterministic')).toBe('UNMEASURED');
    expect(r.status).toBe('UNMEASURED');
    const row = r.unmeasured.find((u) => u.layer === 'deterministic');
    expect(row.required).toBe(true);
    expect(row.reason).toContain('no validationCommand');
    expect(row.reason).toContain('nothing was run');
  });

  it('a non-required layer being UNMEASURED leaves PASS but is still reported', () => {
    const r = verify({ layers: { deterministic: detPass }, now: AT });
    expect(r.status).toBe('PASS');
    expect(r.unmeasured.map((u) => u.layer)).toEqual(['behavioral', 'operational']);
    expect(r.unmeasured.every((u) => u.required === false)).toBe(true);
  });

  it('all layers unmeasured → UNMEASURED even when required is empty', () => {
    const r = verify({ layers: {}, required: [], now: AT });
    expect(r.required).toEqual([]);
    expect(r.status).toBe('UNMEASURED');
    expect(r.unmeasured).toHaveLength(3);
  });

  it('a malformed required option falls back to the default rather than widening PASS', () => {
    const r = verify({ layers: { deterministic: detUnrun }, required: 'deterministic', now: AT });
    expect(r.required).toEqual([...DEFAULT_REQUIRED_LAYERS]);
    expect(r.status).toBe('UNMEASURED');
  });

  it('required entries are canonically ordered and unknown names dropped', () => {
    const r = verify({
      layers: { deterministic: detPass, operational: opsPass },
      required: ['operational', 'nonsense', 'deterministic', 'deterministic'],
      now: AT,
    });
    expect(r.required).toEqual(['deterministic', 'operational']);
  });

  it('layers[] always carries all three layers in canonical order', () => {
    const r = verify({ now: AT });
    expect(r.layers.map((l) => l.layer)).toEqual([...LAYERS]);
  });
});

describe('ports — an adapter that cannot answer is UNMEASURED, never a pass', () => {
  it('a layer supplied as a function is called once and its result folded', () => {
    let calls = 0;
    const port = () => {
      calls += 1;
      return detPass;
    };
    const r = verify({ layers: { deterministic: port }, now: AT });
    expect(calls).toBe(1);
    expect(r.status).toBe('PASS');
  });

  it('a port that throws is UNMEASURED and does not escape', () => {
    const port = () => {
      throw new Error('adapter exploded');
    };
    const r = verify({ layers: { deterministic: port, operational: opsPass }, now: AT });
    expect(statusOf(r, 'deterministic')).toBe('UNMEASURED');
    expect(r.layers[0].reason).toContain('adapter exploded');
    expect(r.status).toBe('UNMEASURED');
  });

  it('unusable input never throws and never passes', () => {
    for (const bad of [undefined, null, 42, 'PASS', []]) {
      const r = verify(bad);
      expect(r.status).toBe('UNMEASURED');
      expect(r.verification_id.startsWith(`${VERIFICATION_ID_VERSION}-`)).toBe(true);
    }
    expect(verify({ layers: { deterministic: 'PASS' }, now: AT }).status).toBe('UNMEASURED');
  });
});

describe('deterministic adapter — exit code decides, a missing one does not', () => {
  it('exit 0 is PASS, non-zero is FAIL, non-numeric is UNMEASURED', () => {
    expect(normalizeDeterministic(detPass).status).toBe('PASS');
    expect(normalizeDeterministic(detFail).status).toBe('FAIL');
    expect(normalizeDeterministic(detUnrun).status).toBe('UNMEASURED');
    expect(normalizeDeterministic({ met: true, exitCode: undefined }).status).toBe('UNMEASURED');
    expect(normalizeDeterministic({ met: true }).status).toBe('UNMEASURED');
  });

  it('`met: true` without an exit code does not create a pass', () => {
    // The failure mode this guards: trusting the adapter's own summary field
    // when the thing that would have produced it never ran.
    expect(normalizeDeterministic({ met: true, confidence: 1, exitCode: null }).status).toBe('UNMEASURED');
  });

  it('a supplied command becomes command evidence with both streams', () => {
    const row = normalizeDeterministic({ ...detFail, command: '  npx vitest run tests/verification  ' });
    expect(row.evidence).toHaveLength(1);
    expect(row.evidence[0]).toMatchObject({ kind: 'command', command: 'npx vitest run tests/verification', output: 'boom' });
  });

  it('no command string means no invented evidence', () => {
    expect(normalizeDeterministic(detPass).evidence).toEqual([]);
  });
});

describe('behavioral shell — declared is not measured', () => {
  it('is UNMEASURED for an empty spec, an array, and an object', () => {
    expect(behavioralShell(undefined).status).toBe('UNMEASURED');
    expect(behavioralShell(['a', 'b']).reason).toContain('2 scenario(s) declared, 0 executed');
    expect(behavioralShell({ scenarios: [{ id: 's1' }] }).reason).toContain('1 scenario(s) declared, 0 executed');
  });

  it('never emits evidence, because nothing was run', () => {
    expect(behavioralShell({ scenarios: [{ id: 's1' }] }).evidence).toEqual([]);
  });
});

describe('operational adapter — a number without a bound is not a verdict', () => {
  it('readings with no bound are UNMEASURED however many there are', () => {
    const row = normalizeOperational(opsUnbounded);
    expect(row.status).toBe('UNMEASURED');
    expect(row.reason).toContain('2 reading(s), 0 comparable to a bound');
  });

  it('bounds decide when present', () => {
    expect(normalizeOperational(opsPass).status).toBe('PASS');
    expect(normalizeOperational(opsFail).status).toBe('FAIL');
    expect(normalizeOperational(opsFail).reason).toContain('lane_stall_pct=42 > max 10');
    expect(normalizeOperational({ readings: [{ metric: 'uptime', value: 0.5, min: 0.9 }] }).status).toBe('FAIL');
  });

  it('a bounded reading with a non-numeric value does not vote', () => {
    const row = normalizeOperational({ readings: [{ metric: 'x', value: 'n/a', max: 10 }] });
    expect(row.status).toBe('UNMEASURED');
  });
});

describe('evidence — passed through in schema shape or dropped, never reshaped', () => {
  const good = [
    { kind: 'file', file: 'lib/verification/unified-verifier.js', line: 1 },
    { kind: 'command', command: 'npx eslint lib/verification', output: '' },
  ];

  it('keeps schema-valid entries and counts the rest', () => {
    const { kept, dropped } = sanitizeEvidence([
      ...good,
      { kind: 'file', file: 'a.js' },
      { kind: 'file', file: 'a.js', line: 0 },
      { kind: 'command', command: 'x' },
      { kind: 'metric', metric: 'p95', value: 3 },
      null,
      'nope',
    ]);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(6);
  });

  it('rebuilds entries in a fixed key order so caller order cannot change the id', () => {
    const a = verify({ layers: { deterministic: { ...detPass, evidence: [{ kind: 'file', file: 'a.js', line: 3 }] } }, now: AT });
    const b = verify({ layers: { deterministic: { ...detPass, evidence: [{ line: 3, file: 'a.js', kind: 'file' }] } }, now: AT });
    expect(Object.keys(a.evidence[0])).toEqual(['kind', 'file', 'line']);
    expect(a.verification_id).toBe(b.verification_id);
  });

  it('names dropped entries in the layer reason rather than hiding them', () => {
    const row = normalizeDeterministic({ ...detPass, evidence: [{ kind: 'metric', value: 3 }] });
    expect(row.reason).toContain('1 evidence entry dropped');
  });

  it('top-level evidence[] is the union of the layer rows', () => {
    const r = verify({
      layers: {
        deterministic: { ...detPass, command: 'npx tsc --noEmit' },
        operational: { ...opsPass, evidence: good },
      },
      now: AT,
    });
    expect(r.evidence).toHaveLength(3);
    expect(r.evidence.map((e) => e.kind)).toEqual(['command', 'file', 'command']);
  });
});

describe('regression axis — no baseline is unmeasured, not clean', () => {
  it('no readLastPass port → every layer UNMEASURED with the reason said out loud', () => {
    const r = verify({ layers: { deterministic: detPass }, now: AT });
    expect(r.regressions).toHaveLength(3);
    expect(r.regressions.every((g) => g.status === 'UNMEASURED')).toBe(true);
    expect(r.regressions.every((g) => g.from === null)).toBe(true);
    expect(r.regressions[0].detail).toContain('no readLastPass port supplied');
  });

  it('a port returning null, a non-record, or throwing is equally UNMEASURED', () => {
    const cases = [
      [() => null, 'no previous PASS recorded'],
      [() => ({ verification_id: 'x' }), 'carries no layers[]'],
      [() => { throw new Error('ledger unreadable'); }, 'readLastPass threw: ledger unreadable'],
    ];
    for (const [port, fragment] of cases) {
      const r = verify({ layers: { deterministic: detPass }, readLastPass: port, now: AT });
      expect(r.regressions.every((g) => g.status === 'UNMEASURED')).toBe(true);
      expect(r.regressions[0].detail).toContain(fragment);
    }
  });

  it('baseline PASS + now FAIL is a regression', () => {
    const r = verify({ layers: { deterministic: detFail }, readLastPass: baselineAllPass, now: AT });
    const det = r.regressions.find((g) => g.layer === 'deterministic');
    expect(det).toMatchObject({ from: 'PASS', to: 'FAIL', status: 'FAIL', detail: 'was PASS, now FAIL' });
  });

  it('baseline PASS + still PASS is no regression', () => {
    const r = verify({ layers: { deterministic: detPass }, readLastPass: baselineAllPass, now: AT });
    expect(r.regressions.find((g) => g.layer === 'deterministic').status).toBe('PASS');
  });

  it('baseline PASS + now unmeasured is UNMEASURED, not a regression and not clean', () => {
    const r = verify({ layers: { deterministic: detUnrun }, readLastPass: baselineAllPass, now: AT });
    const det = r.regressions.find((g) => g.layer === 'deterministic');
    expect(det.status).toBe('UNMEASURED');
    expect(det.detail).toContain('regression not decidable');
  });

  it('a baseline layer that was not PASS gives nothing to regress from', () => {
    const port = () => ({ layers: [{ layer: 'deterministic', status: 'FAIL' }] });
    const r = verify({ layers: { deterministic: detPass }, readLastPass: port, now: AT });
    expect(r.regressions.find((g) => g.layer === 'deterministic')).toMatchObject({
      from: 'FAIL', status: 'UNMEASURED',
    });
    expect(r.regressions.find((g) => g.layer === 'behavioral').detail).toBe('baseline has no row for this layer');
  });

  it('a detected regression does not by itself move status', () => {
    // The layer FAIL is what moves it; the regression row is a second axis the
    // completion gate reads separately.
    const clean = verify({ layers: { deterministic: detPass }, readLastPass: baselineAllPass, now: AT });
    expect(clean.status).toBe('PASS');
    expect(clean.regressions.some((g) => g.status === 'UNMEASURED')).toBe(true);
  });
});

describe('verification_id — deterministic, recomputable, time-stamped', () => {
  it('has the documented shape', () => {
    const r = verify({ layers: { deterministic: detPass }, now: AT });
    expect(r.verification_id).toMatch(/^v1-[0-9a-f]{12}-\d{8}T\d{6}Z$/);
    expect(r.measured_at).toBe('2026-09-02T07:15:30.000Z');
    expect(r.verification_id.endsWith('-20260902T071530Z')).toBe(true);
  });

  it('is identical for identical input and clock', () => {
    const a = verify({ layers: { deterministic: detPass, operational: opsPass }, now: AT });
    const b = verify({ layers: { deterministic: detPass, operational: opsPass }, now: AT });
    expect(a.verification_id).toBe(b.verification_id);
  });

  it('changes when any part of the verdict changes', () => {
    const base = verify({ layers: { deterministic: detPass }, now: AT }).verification_id;
    const ids = new Set([
      base,
      verify({ layers: { deterministic: detFail }, now: AT }).verification_id,
      verify({ layers: { deterministic: detPass, operational: opsPass }, now: AT }).verification_id,
      verify({ layers: { deterministic: detPass }, required: ['deterministic', 'operational'], now: AT }).verification_id,
      verify({ layers: { deterministic: detPass }, readLastPass: baselineAllPass, now: AT }).verification_id,
    ]);
    expect(ids.size).toBe(5);
  });

  it('same content at a different time shares the hash and differs as an id', () => {
    const a = verify({ layers: { deterministic: detPass }, now: AT });
    const b = verify({ layers: { deterministic: detPass }, now: () => new Date('2026-09-03T09:00:00.000Z') });
    expect(a.verification_id).not.toBe(b.verification_id);
    expect(a.verification_id.split('-')[1]).toBe(b.verification_id.split('-')[1]);
    expect(b.verification_id.endsWith('-20260903T090000Z')).toBe(true);
  });

  it('is recomputable from the returned verdict alone', () => {
    const r = verify({ layers: { deterministic: detPass, operational: opsFail }, readLastPass: baselineAllPass, now: AT });
    expect(buildVerificationId(r, r.measured_at)).toBe(r.verification_id);
  });

  it('survives circular evidence — no throw, id still issued, warning recorded', () => {
    // T-50 #3: `note` is copied out of caller evidence unchecked, so a cycle
    // reached JSON.stringify and threw out of a function documented as pure.
    const circular = { a: 1 };
    circular.self = circular;
    const layers = {
      deterministic: { ...detPass, evidence: [{ kind: 'file', file: 'a.js', line: 3, note: circular }] },
    };
    let r;
    expect(() => { r = verify({ layers, now: AT }); }).not.toThrow();
    expect(r.status).toBe('PASS');
    expect(r.verification_id).toMatch(/^v1-[0-9a-f]{12}-\d{8}T\d{6}Z$/);
    expect(r.warnings).toEqual([
      { code: 'unserializable_evidence', detail: 'evidence[0].note could not be serialized — hashed as "[unserializable]"' },
    ]);
    // The whole verdict is on its way to the ledger and to outcome.md, so it
    // must survive serialization — including through layers[].evidence, which
    // is a second carrier of the same entries.
    expect(() => JSON.stringify(r)).not.toThrow();
    expect(r.evidence[0].note).toBe('[unserializable]');
    expect(r.layers[0].evidence[0].note).toBe('[unserializable]');
    expect(r.evidence[0]).toMatchObject({ kind: 'file', file: 'a.js', line: 3 });
    // The offending field is replaced, not the whole entry: file and line still
    // reach the hash, so two entries differing only in those do not collide.
    const other = { ...layers.deterministic, evidence: [{ kind: 'file', file: 'b.js', line: 9, note: circular }] };
    expect(verify({ layers: { deterministic: other }, now: AT }).verification_id).not.toBe(r.verification_id);
    // And the id remains recomputable from what came back.
    expect(buildVerificationId(r, r.measured_at)).toBe(r.verification_id);
  });

  it('warnings[] is empty and present on an ordinary verdict', () => {
    expect(verify({ layers: { deterministic: detPass }, now: AT }).warnings).toEqual([]);
  });

  it('buildVerificationId stamps `unknown` for a null timestamp rather than a fabricated time', () => {
    // Unreachable through verify() now that the clock contract is `() => Date`,
    // but buildVerificationId is exported and must not invent a time.
    const r = verify({ layers: { deterministic: detPass }, now: AT });
    expect(buildVerificationId(r, null).endsWith('-unknown')).toBe(true);
  });
});

describe('now port — the contract is `() => Date` and nothing else', () => {
  it('accepts a function returning a Date and converts it internally', () => {
    const r = verify({ layers: { deterministic: detPass }, now: () => new Date(1788333330000) });
    expect(r.measured_at).toBe('2026-09-02T07:15:30.000Z');
    expect(r.verification_id.endsWith('-20260902T071530Z')).toBe(true);
  });

  it('omitting it falls back to the real clock and still produces a timestamp', () => {
    const r = verify({ layers: { deterministic: detPass } });
    expect(typeof r.measured_at).toBe('string');
    expect(r.verification_id).toMatch(/^v1-[0-9a-f]{12}-\d{8}T\d{6}Z$/);
  });

  it('rejects the shapes it used to accept — epoch ms and ISO text', () => {
    // T-51 #6: state-manager passes `() => Date`, split-state passes a string.
    // Accepting both let the two diverge with nothing to notice it.
    expect(() => verify({ now: () => 1756797330000 })).toThrow(TypeError);
    expect(() => verify({ now: () => '2026-09-02T07:15:30.000Z' })).toThrow(TypeError);
    expect(() => verify({ now: () => '2026-09-02T07:15:30.000Z' })).toThrow(/must return a Date, received string/);
  });

  it('rejects a non-function clock, null included', () => {
    expect(() => verify({ now: new Date() })).toThrow(/now must be a function returning a Date, received object/);
    expect(() => verify({ now: null })).toThrow(/received null/);
    expect(() => verify({ now: '2026-09-02' })).toThrow(TypeError);
  });

  it('rejects an Invalid Date rather than stamping it', () => {
    expect(() => verify({ now: () => new Date('nonsense') })).toThrow(/Invalid Date/);
  });

  it('lets a broken clock surface its own error unrewrapped', () => {
    expect(() => verify({ now: () => { throw new RangeError('clock skew'); } })).toThrow(RangeError);
    expect(() => verify({ now: () => { throw new RangeError('clock skew'); } })).toThrow('clock skew');
  });

  it('a bad clock is the only throw — bad layer input still returns UNMEASURED', () => {
    expect(verify({ layers: { deterministic: 'PASS', operational: 42 }, now: AT }).status).toBe('UNMEASURED');
    expect(() => verify({ layers: { deterministic: () => { throw new Error('x'); } }, now: AT })).not.toThrow();
  });
});

describe('readClock is exported as the one judge of the contract', () => {
  // T-46 held a copy of these nine lines at split-state.js:618, which made two
  // judges of the same rule. L4 may import L2, so the copy goes and this stays.
  it('is exported and callable directly', () => {
    expect(typeof readClock).toBe('function');
  });

  it('branch 1 — omitted clock returns a real ISO timestamp', () => {
    const iso = readClock(undefined);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });

  it('branch 2 — a function returning a Date converts to ISO', () => {
    expect(readClock(AT)).toBe('2026-09-02T07:15:30.000Z');
  });

  it('branch 3 — a non-function is a TypeError', () => {
    expect(() => readClock(new Date())).toThrow(/must be a function returning a Date, received object/);
    expect(() => readClock(null)).toThrow(/received null/);
    expect(() => readClock(1788333330000)).toThrow(/received number/);
  });

  it('branch 4 — a wrong return type or Invalid Date is a TypeError', () => {
    expect(() => readClock(() => 1788333330000)).toThrow(/must return a Date, received number/);
    expect(() => readClock(() => '2026-09-02T07:15:30.000Z')).toThrow(/must return a Date, received string/);
    expect(() => readClock(() => new Date('nonsense'))).toThrow(/Invalid Date/);
  });

  it('label rides the message prefix so the diagnostic names the real caller', () => {
    // T-46 imports this and passes 'writeWorkerState'. Without the label, a
    // developer debugging split-state gets an error naming a module they never
    // called. The unlabelled default is `clock`, the module that owns the rule.
    expect(() => readClock(null, 'writeWorkerState')).toThrow(/^writeWorkerState: now must be a function/);
    expect(() => readClock(() => 42, 'writeWorkerState')).toThrow(/^writeWorkerState: now\(\) must return a Date/);
    expect(() => readClock(() => new Date('nonsense'), 'writeWorkerState')).toThrow(/^writeWorkerState: now\(\) returned an Invalid Date$/);
    expect(() => readClock(null)).toThrow(/^clock: /);
  });

  it('verify() passes its own label, so its clock errors name it', () => {
    // The default moved to `clock`; this pins that verify still identifies
    // itself rather than inheriting whatever the core default happens to be.
    expect(() => verify({ now: null })).toThrow(/^unified-verifier: now must be a function/);
    expect(() => verify({ now: () => 42 })).toThrow(/^unified-verifier: now\(\) must return a Date/);
  });

  it('is the same judge verify() uses, not a parallel one', () => {
    // If verify ever stops routing through readClock, these two diverge.
    expect(verify({ layers: { deterministic: detPass }, now: AT }).measured_at).toBe(readClock(AT));
  });
});

describe('purity', () => {
  it('the result is frozen through its arrays and rows', () => {
    const r = verify({ layers: { deterministic: { ...detPass, command: 'npx tsc --noEmit' } }, now: AT });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.layers)).toBe(true);
    expect(Object.isFrozen(r.layers[0])).toBe(true);
    expect(Object.isFrozen(r.evidence[0])).toBe(true);
    expect(Object.isFrozen(r.regressions[0])).toBe(true);
  });

  it('does not mutate the inputs it is handed', () => {
    const layers = { deterministic: { ...detPass }, operational: { readings: [{ metric: 'm', value: 1, max: 2 }] } };
    const snapshot = JSON.stringify(layers);
    verify({ layers, required: ['deterministic'], now: AT });
    expect(JSON.stringify(layers)).toBe(snapshot);
  });
});
