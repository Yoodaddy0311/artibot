/**
 * `lib/verification/unified-verifier.js` — the `verify.completed` ledger writer:
 * pure envelope builders plus one port-driven recorder.
 *
 * What this proves: that a verdict becomes one overall line plus one line per
 * entry of `LAYERS` in canonical order; that `UNMEASURED` reaches the ledger as
 * `result:'unmeasured'` and never as a pass; that an unmappable status produces
 * ZERO inputs rather than a partial set; that the lines the builder emits are
 * accepted by the REAL writer (`lib/runtime/ledger.js#appendLedgerEvent`) with
 * no `ledger.rejected` line; that a second `recordVerification` with the same
 * verdict appends nothing; and that a throwing port becomes a `rejected` line
 * instead of an exception.
 *
 * What it cannot prove (rules §9): that the reader
 * `lib/runtime/artifact-lifecycle-gates.js#foldGateState` folds these lines the
 * way its own tests say it does — that module is not imported here, and the
 * alignment asserted below is the SHAPE its `tallyLayer` reads (`data.layer`,
 * `data.result`, `data.verification_id`), not its output. Nothing here measures
 * a real ledger under concurrency, and the 4096-byte line cap is not exercised:
 * the evidence entries used are a few hundred bytes, so a green run here says
 * nothing about the writer's fold path for oversized verdicts (the exact
 * false-confidence shape rules §9 names).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import { resetSeq } from '../../lib/runtime/event-writer.js';
import {
  buildVerifyCompletedEvents,
  LAYERS,
  recordVerification,
  toVerifyResult,
  verify,
  VERIFY_COMPLETED_EVENT,
  VERIFY_LEDGER_SOURCE,
  verifyCompletedIdempotencyKey,
} from '../../lib/verification/unified-verifier.js';

const AT = () => new Date('2026-09-12T00:15:30.000Z');
const SID = 'sess-verify-writer-01';
const MISSION = 'M-20260912-001';
/** Relative — `getLedgerSettings` joins it onto the injected projectRoot. */
const LEDGER_REL = path.join('.artibot', 'runtime', 'ledger.jsonl');

/** Exit-0 result in `lib/autopilot/goal-evaluator.js#evaluateGoal`'s shape. */
const detPass = {
  met: true,
  confidence: 1,
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  reason: 'validationCommand exit code 0',
  evidence: [{ kind: 'command', command: 'npx vitest run x', output: 'ok' }],
};

/**
 * A verdict whose deterministic layer passed and whose other two layers nobody
 * ran. Built through the real `verify()` so the statuses are the fold's, not a
 * transcription of what the fold is assumed to say.
 */
function passVerdict() {
  return verify({ layers: { deterministic: detPass }, now: AT });
}

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-verify-writer-'));
  resetSeq();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Append through the real writer, into this test's temp ledger only. */
function append(input) {
  return appendLedgerEvent(root, input, { ledgerPath: LEDGER_REL });
}

/** Raw lines of the temp ledger, including `ledger.rejected` ones. */
function rawLines() {
  const file = path.join(root, LEDGER_REL);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

/** The keys already in the ledger — the `session-end.js#existingReceiptKeys` shape. */
function existingKeys() {
  return readAllEvents(root, { session_id: SID, ledgerPath: LEDGER_REL })
    .filter((e) => e.event === VERIFY_COMPLETED_EVENT)
    .map((e) => e.idempotency_key)
    .filter((k) => typeof k === 'string' && k.length > 0);
}

describe('toVerifyResult', () => {
  it('maps the three verdict statuses to their lowercase ledger spelling', () => {
    expect(toVerifyResult('PASS')).toBe('pass');
    expect(toVerifyResult('FAIL')).toBe('fail');
    expect(toVerifyResult('UNMEASURED')).toBe('unmeasured');
  });

  it('refuses an already-lowercase status instead of passing it through', () => {
    // Only the three UPPERCASE statuses this module produces map. A lowercase
    // 'pass' is not a `verify()` status, it is a ledger value that has already
    // been converted, and accepting it would make this function a silent
    // identity for its own output — so a double conversion would look fine.
    // `ledger-schema.js#ENUM_CASE_FOLD` folds the enum on the writer side; that
    // is the writer's tolerance, not a reason for this mapper to guess.
    expect(toVerifyResult('pass')).toBeNull();
    expect(toVerifyResult('Pass')).toBeNull();
  });

  it('returns null for every non-status rather than guessing one', () => {
    for (const bad of ['MAYBE', '', 'SKIP', 'unmeasured ', undefined, null, 0, 1, {}, [], true]) {
      expect(toVerifyResult(bad)).toBeNull();
    }
  });

  it('does not resolve inherited Object keys as statuses', () => {
    // A plain-object lookup table would answer `toVerifyResult('constructor')`
    // with a function, and any truthiness check downstream would read that as a
    // successful mapping.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(toVerifyResult(key)).toBeNull();
    }
  });
});

describe('verifyCompletedIdempotencyKey', () => {
  it('keys an overall line on event, session and verification id', () => {
    expect(verifyCompletedIdempotencyKey(SID, 'v1-abc123abc123-20260912T001530Z'))
      .toBe('verify.completed:sess-verify-writer-01:v1-abc123abc123-20260912T001530Z');
  });

  it('appends the layer so per-layer lines do not collide with the overall one', () => {
    const overall = verifyCompletedIdempotencyKey(SID, 'v1-x-Z');
    const layer = verifyCompletedIdempotencyKey(SID, 'v1-x-Z', 'behavioral');
    expect(layer).toBe(`${overall}:behavioral`);
    expect(layer).not.toBe(overall);
  });

  it('treats an absent, empty or non-string layer as no layer at all', () => {
    const overall = verifyCompletedIdempotencyKey(SID, 'v1-x-Z');
    for (const layer of [undefined, null, '', '   ', 7, {}]) {
      expect(verifyCompletedIdempotencyKey(SID, 'v1-x-Z', layer)).toBe(overall);
    }
  });
});

describe('buildVerifyCompletedEvents', () => {
  it('yields the overall line plus one per layer in canonical order', () => {
    const verdict = passVerdict();
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    expect(built.ok).toBe(true);
    expect(built.inputs).toHaveLength(LAYERS.length + 1);
    expect(built.inputs.slice(1).map((i) => i.data.layer)).toEqual([...LAYERS]);
  });

  it('carries the fold\'s own statuses, not an assumed set', () => {
    const verdict = passVerdict();
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    const [overall, ...layers] = built.inputs;
    // Measured against the verdict rather than hard-coded: with only
    // `deterministic` required and it passing, the fold returns PASS while two
    // layers stay unmeasured.
    expect(overall.data.result).toBe(toVerifyResult(verdict.status));
    for (const input of layers) {
      const row = verdict.layers.find((r) => r.layer === input.data.layer);
      expect(input.data.result).toBe(toVerifyResult(row.status));
    }
  });

  it('writes an unmeasured layer as unmeasured and never as a pass', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID });
    const byLayer = new Map(built.inputs.slice(1).map((i) => [i.data.layer, i.data.result]));
    expect(byLayer.get('deterministic')).toBe('pass');
    expect(byLayer.get('behavioral')).toBe('unmeasured');
    expect(byLayer.get('operational')).toBe('unmeasured');
  });

  it('omits `layer` from the overall line instead of naming a layer it did not measure', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID });
    expect(Object.prototype.hasOwnProperty.call(built.inputs[0].data, 'layer')).toBe(false);
  });

  it('gives every line the verdict\'s verification_id as the join key', () => {
    const verdict = passVerdict();
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    for (const input of built.inputs) {
      expect(input.data.verification_id).toBe(verdict.verification_id);
    }
  });

  it('stamps the fixed event name and source on every line', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID });
    for (const input of built.inputs) {
      expect(input.event).toBe(VERIFY_COMPLETED_EVENT);
      expect(input.source).toBe(VERIFY_LEDGER_SOURCE);
      expect(input.session_id).toBe(SID);
    }
  });

  it('gives each line a distinct idempotency key', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID });
    const keys = built.inputs.map((i) => i.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps data to the four contract keys — no envelope key leaks in', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID, missionId: MISSION });
    for (const input of built.inputs) {
      const extra = Object.keys(input.data)
        .filter((k) => !['result', 'evidence', 'verification_id', 'layer'].includes(k));
      expect(extra).toEqual([]);
      for (const envelopeKey of ['event', 'session_id', 'source', 'mission_id', 'idempotency_key', 'ts', 'seq', 'pid', 'v']) {
        expect(Object.prototype.hasOwnProperty.call(input.data, envelopeKey)).toBe(false);
      }
    }
  });

  it('passes the layer evidence through per line, not the whole flattened list', () => {
    const verdict = passVerdict();
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    expect(built.inputs[0].data.evidence).toEqual([...verdict.evidence]);
    const det = built.inputs.find((i) => i.data.layer === 'deterministic');
    const row = verdict.layers.find((r) => r.layer === 'deterministic');
    expect(det.data.evidence).toEqual([...row.evidence]);
    const beh = built.inputs.find((i) => i.data.layer === 'behavioral');
    expect(beh.data.evidence).toEqual([]);
  });

  it('drops includeOverall:false down to one line per layer', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID, includeOverall: false });
    expect(built.ok).toBe(true);
    expect(built.inputs).toHaveLength(LAYERS.length);
    for (const input of built.inputs) {
      expect(typeof input.data.layer).toBe('string');
    }
  });

  it('carries a well-formed mission_id through', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID, missionId: MISSION });
    for (const input of built.inputs) expect(input.mission_id).toBe(MISSION);
  });

  it('omits a malformed mission_id rather than shipping a line the writer will refuse', () => {
    // `event-writer.js#MISSION_ID_RE` (:157, measured 2026-09-12 09:5x KST) is
    // the authority; an id it rejects would take the whole line down, whereas
    // omitting it lets `sessionFallbackMissionId` supply a valid one.
    for (const bad of ['M-2026-001', 'mission-1', '', 'M-20260912-SsHORT', null, 42]) {
      const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID, missionId: bad });
      expect(built.ok).toBe(true);
      for (const input of built.inputs) {
        expect(Object.prototype.hasOwnProperty.call(input, 'mission_id')).toBe(false);
      }
    }
  });

  it('builds ZERO inputs when any status is unmappable — never a partial set', () => {
    const verdict = { ...passVerdict(), status: 'MAYBE' };
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    expect(built.ok).toBe(false);
    expect(built.reason).toContain('MAYBE');
    expect(built.inputs ?? []).toEqual([]);
  });

  it('refuses the whole set when ONE layer status is unmappable', () => {
    const base = passVerdict();
    const verdict = {
      ...base,
      layers: base.layers.map((r) => (r.layer === 'operational' ? { ...r, status: 'SKIPPED' } : r)),
    };
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    expect(built.ok).toBe(false);
    expect(built.reason).toContain('operational');
    expect(built.inputs ?? []).toEqual([]);
  });

  it('refuses a verdict missing a layer row rather than inventing its status', () => {
    const base = passVerdict();
    const verdict = { ...base, layers: base.layers.filter((r) => r.layer !== 'behavioral') };
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    expect(built.ok).toBe(false);
    expect(built.reason).toContain('behavioral');
  });

  it('refuses a missing or unusable verification_id', () => {
    for (const bad of [undefined, null, '', '   ', 7, {}]) {
      const built = buildVerifyCompletedEvents({ ...passVerdict(), verification_id: bad }, { sessionId: SID });
      expect(built.ok).toBe(false);
      expect(built.reason).toContain('verification_id');
    }
  });

  it('refuses an empty or non-string sessionId', () => {
    for (const bad of [undefined, null, '', '  ', 7, {}]) {
      const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: bad });
      expect(built.ok).toBe(false);
      expect(built.reason).toContain('session');
    }
  });

  it('refuses a non-verdict without throwing', () => {
    for (const bad of [undefined, null, 'verdict', 42, []]) {
      let built;
      expect(() => { built = buildVerifyCompletedEvents(bad, { sessionId: SID }); }).not.toThrow();
      expect(built.ok).toBe(false);
    }
  });

  it('treats a missing ctx as a missing sessionId, not a crash', () => {
    let built;
    expect(() => { built = buildVerifyCompletedEvents(passVerdict()); }).not.toThrow();
    expect(built.ok).toBe(false);
  });
});

describe('the real ledger accepts every line the builder emits', () => {
  it('lands 4 verify.completed lines and 0 ledger.rejected lines', () => {
    const verdict = passVerdict();
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID, missionId: MISSION });
    const results = built.inputs.map((input) => append(input));
    for (const res of results) expect(res).toMatchObject({ ok: true });

    const lines = rawLines();
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toHaveLength(0);
    expect(lines.every((l) => l.event === VERIFY_COMPLETED_EVENT)).toBe(true);
    expect(lines.every((l) => l.source === VERIFY_LEDGER_SOURCE)).toBe(true);
    expect(lines.every((l) => l.data.verification_id === verdict.verification_id)).toBe(true);
    expect(lines[0].data.layer).toBeUndefined();
    expect(lines.slice(1).map((l) => l.data.layer)).toEqual([...LAYERS]);
    expect(lines.map((l) => l.data.result)).toEqual(['pass', 'pass', 'unmeasured', 'unmeasured']);
  });

  it('keeps the result values inside the allowlist enum after the writer folds them', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID });
    for (const input of built.inputs) append(input);
    for (const line of rawLines()) {
      expect(['pass', 'fail', 'unmeasured']).toContain(line.data.result);
    }
  });

  it('survives the writer with a layer name the reader will echo rather than bucket', () => {
    // `artifact-lifecycle-gates.js#LAYER_NAME_PATTERN` (:134, measured
    // 2026-09-12 09:4x KST) echoes a plain lowercase identifier and buckets
    // anything else as 'unrecognised'. Every name in `LAYERS` must pass it, or
    // the tally silently collapses three layers into one bucket.
    const pattern = /^[a-z][a-z0-9_-]{0,31}$/;
    for (const layer of LAYERS) expect(pattern.test(layer)).toBe(true);
  });

  it('accepts includeOverall:false as exactly three lines', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID, includeOverall: false });
    for (const input of built.inputs) append(input);
    const lines = rawLines();
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toHaveLength(0);
  });
});

describe('recordVerification', () => {
  const ports = () => ({ append, existingKeys });

  it('appends every line once and reports the tally', () => {
    const out = recordVerification(passVerdict(), { sessionId: SID, missionId: MISSION }, ports());
    expect(out).toMatchObject({ appended: 4, deduped: 0, rejected: 0, skipped: 0 });
    expect(out.lines).toHaveLength(4);
    expect(out.lines.every((l) => l.status === 'appended')).toBe(true);
    expect(out.lines[0].layer).toBeNull();
    expect(out.lines.slice(1).map((l) => l.layer)).toEqual([...LAYERS]);
    expect(rawLines()).toHaveLength(4);
  });

  it('dedupes the second identical run to zero appends', () => {
    const verdict = passVerdict();
    recordVerification(verdict, { sessionId: SID }, ports());
    const second = recordVerification(verdict, { sessionId: SID }, ports());
    expect(second).toMatchObject({ appended: 0, deduped: 4, rejected: 0, skipped: 0 });
    expect(second.lines.every((l) => l.status === 'deduped')).toBe(true);
    expect(rawLines()).toHaveLength(4);
  });

  it('still records a verdict whose id differs, so dedupe is not a mute', () => {
    recordVerification(passVerdict(), { sessionId: SID }, ports());
    const other = verify({ layers: { deterministic: { ...detPass, exitCode: 1 } }, now: AT });
    const out = recordVerification(other, { sessionId: SID }, ports());
    expect(out.appended).toBe(4);
    expect(rawLines()).toHaveLength(8);
  });

  it('writes nothing and says so when nothing could be built', () => {
    const out = recordVerification({ ...passVerdict(), status: 'MAYBE' }, { sessionId: SID }, ports());
    expect(out).toMatchObject({ appended: 0, deduped: 0, rejected: 0, skipped: 1 });
    expect(out.lines).toEqual([]);
    expect(typeof out.reason).toBe('string');
    expect(rawLines()).toEqual([]);
  });

  it('writes nothing for a missing verification_id or an empty sessionId', () => {
    const a = recordVerification({ ...passVerdict(), verification_id: '' }, { sessionId: SID }, ports());
    const b = recordVerification(passVerdict(), { sessionId: '' }, ports());
    expect(a.skipped).toBe(1);
    expect(b.skipped).toBe(1);
    expect(rawLines()).toEqual([]);
  });

  it('turns a throwing append port into rejected lines, never an exception', () => {
    const boom = () => { throw new Error('disk gone'); };
    let out;
    expect(() => {
      out = recordVerification(passVerdict(), { sessionId: SID }, { append: boom, existingKeys: () => [] });
    }).not.toThrow();
    expect(out).toMatchObject({ appended: 0, deduped: 0, rejected: 4, skipped: 0 });
    for (const line of out.lines) {
      expect(line.status).toBe('rejected');
      expect(line.reason).toBe('port-threw:append');
    }
  });

  it('rejects every line when existingKeys throws, rather than risking a double count', () => {
    // Fail-closed on purpose, and DIFFERENT from
    // `scripts/hooks/session-end.js#existingReceiptKeys` (:576, measured
    // 2026-09-12 09:5x KST), which swallows the throw and appends anyway. A
    // duplicated `verify.completed` inflates the reader's per-layer tally into a
    // false measurement; a missing line is a visible absence. This module exists
    // to prefer the visible absence.
    const boom = () => { throw new Error('ledger unreadable'); };
    let out;
    expect(() => {
      out = recordVerification(passVerdict(), { sessionId: SID }, { append, existingKeys: boom });
    }).not.toThrow();
    expect(out).toMatchObject({ appended: 0, rejected: 4, skipped: 0 });
    expect(out.lines.every((l) => l.reason === 'port-threw:existingKeys')).toBe(true);
    expect(rawLines()).toEqual([]);
  });

  it('carries a writer refusal through as the line\'s reason', () => {
    const refuse = () => ({ ok: false, reason: 'unregistered-event' });
    const out = recordVerification(passVerdict(), { sessionId: SID }, { append: refuse, existingKeys: () => [] });
    expect(out.rejected).toBe(4);
    expect(out.lines.every((l) => l.reason === 'unregistered-event')).toBe(true);
  });

  it('rejects rather than appends when the append port is missing', () => {
    let out;
    expect(() => { out = recordVerification(passVerdict(), { sessionId: SID }, {}); }).not.toThrow();
    expect(out).toMatchObject({ appended: 0, rejected: 4 });
    expect(out.lines.every((l) => l.reason === 'port-missing:append')).toBe(true);
  });

  it('treats an absent existingKeys port as no keys known and appends', () => {
    // Mirrors this module's own `readLastPass` handling: an optional port that
    // was not supplied is an absence of information, not a wiring defect.
    const out = recordVerification(passVerdict(), { sessionId: SID }, { append });
    expect(out).toMatchObject({ appended: 4, deduped: 0 });
  });

  it('never throws on a missing ports object', () => {
    let out;
    expect(() => { out = recordVerification(passVerdict(), { sessionId: SID }); }).not.toThrow();
    expect(out.appended).toBe(0);
  });

  it('records the keys it used so a caller can re-check them', () => {
    const out = recordVerification(passVerdict(), { sessionId: SID }, ports());
    const written = existingKeys();
    expect(out.lines.map((l) => l.key).sort()).toEqual(written.sort());
  });
});

describe('the shape the deterministic adapter actually reads', () => {
  it('treats a `{status:PASS}` layer input as UNMEASURED, not a pass', () => {
    // Pinned because it is an easy and dangerous misreading of the layer port:
    // `normalizeDeterministic` reads `exitCode`, never `status`. A caller who
    // hands it `{status:'PASS'}` has measured nothing, and the writer must carry
    // that to the ledger as `unmeasured` — the one substitution this whole
    // module exists to prevent.
    const verdict = verify({ layers: { deterministic: { status: 'PASS' } }, now: AT });
    expect(verdict.status).toBe('UNMEASURED');
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    expect(built.inputs[0].data.result).toBe('unmeasured');
    const det = built.inputs.find((i) => i.data.layer === 'deterministic');
    expect(det.data.result).toBe('unmeasured');
  });
});
