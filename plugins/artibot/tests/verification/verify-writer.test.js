/**
 * `lib/verification/verify-writer.js` — the `verify.completed` ledger writer:
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
 * The reader is measured, not assumed: the last describe block feeds the lines
 * this writer actually wrote through the REAL
 * `lib/runtime/artifact-lifecycle-gates.js#foldGateState` and asserts its output
 * — a per-layer tally of three buckets plus `unspecified` for the overall line.
 * That assertion has teeth because the same block strips `data.layer` from the
 * same lines and shows the fold then collapses all four into one bucket, which
 * is the exact failure a shape-only check could not see.
 *
 * The 4096-byte line cap IS exercised, and that is new. Review round 1 found the
 * earlier version of this file proving nothing about it: every fixture used
 * `output:'ok'`, so the cap was never approached — the §9 false-green shape
 * exactly. The cap block now drives 5 KB and 40 KB of captured output through
 * the REAL `appendLedgerEvent` and asserts 0 `ledger.rejected` lines and
 * `folded === false`, plus a 400-entry case for the other axis.
 *
 * What it still cannot prove (rules §9):
 *  1. That a line survives REDACTION growth. `redactDeep` runs downstream of
 *     this module and `[REDACTED_KEY]` is longer than the short secret it
 *     replaces, so output dense with secrets can grow after the writer sized it.
 *     `LINE_RESERVE_BYTES` is slack for that, not a proof, and no fixture here
 *     contains a secret.
 *  2. That a real ledger holds under concurrency. Every case here is one
 *     process appending to a fresh temp file.
 *  3. That the bound is right for evidence shapes other than long `output` /
 *     `note` — a verdict whose bulk sits in `command` or `file` strings is
 *     bounded only by the entry-dropping stage, which is measured at 400
 *     entries and nowhere near the thousands a pathological caller could send.
 *  4. That any production caller wires this at all. Nothing in `lib/` or
 *     `scripts/` calls `recordVerification` yet.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendLedgerEvent, readAllEvents } from '../../lib/runtime/ledger.js';
import { resetSeq } from '../../lib/runtime/event-writer.js';
import {
  buildFindings,
  foldGateState,
  LAYER_UNSPECIFIED,
} from '../../lib/runtime/artifact-lifecycle-gates.js';
import { LAYERS, verify } from '../../lib/verification/unified-verifier.js';
import {
  evidenceRegistryPath,
  readEvidenceIds,
  registerEvidence,
} from '../../lib/verification/evidence-registry.js';
import {
  buildVerifyCompletedEvents,
  EVIDENCE_TRUNCATION_MARK,
  LEDGER_LINE_MAX_BYTES,
  LINE_RESERVE_BYTES,
  recordVerification,
  toVerifyResult,
  VERIFY_COMPLETED_EVENT,
  VERIFY_LEDGER_SOURCE,
  verifyCompletedIdempotencyKey,
} from '../../lib/verification/verify-writer.js';

const AT = () => new Date('2026-09-12T00:15:30.000Z');
const SID = 'sess-verify-writer-01';
const MISSION = 'M-20260912-001';
/** Relative — `getLedgerSettings` joins it onto the injected projectRoot. */
const LEDGER_REL = path.join('.artibot', 'runtime', 'ledger.jsonl');
const ALLOWLIST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../schemas/ledger-events.allowlist.json',
);

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

  it('rejects every line when existingKeys returns something it cannot iterate', () => {
    // A non-iterable return is a wiring defect, and the only safe reading of it
    // is "I do not know which keys exist". Guessing "none" would append a
    // second copy of every line and inflate the reader's per-layer tally — the
    // same double count the throwing case above refuses, reached by a different
    // route, so it gets the same `port-threw:existingKeys` reason.
    for (const bad of [42, { keys: [] }, true]) {
      resetSeq();
      let out;
      expect(() => {
        out = recordVerification(passVerdict(), { sessionId: SID }, { append, existingKeys: () => bad });
      }).not.toThrow();
      expect(out).toMatchObject({ appended: 0, deduped: 0, rejected: 4, skipped: 0 });
      expect(out.lines.every((l) => l.reason === 'port-threw:existingKeys')).toBe(true);
      expect(rawLines()).toEqual([]);
    }
  });
});

describe('recordVerification with a registerEvidence port', () => {
  /** The port bound to a REAL registry under this test's temp root. */
  const registerPort = (entries, source) => registerEvidence(entries, { projectRoot: root, source, now: AT });
  const ports = () => ({ append, existingKeys, registerEvidence: registerPort });

  it('one verdict with one evidence entry becomes exactly one registry row', () => {
    // The overall line and the deterministic line both carry the SAME entry
    // (the overall evidence is the flattened layer evidence), so the second
    // registration reuses the first id instead of minting another.
    const out = recordVerification(passVerdict(), { sessionId: SID }, ports());
    expect(out).toMatchObject({ appended: 4, deduped: 0, rejected: 0, skipped: 0 });
    expect(readEvidenceIds(root)).toEqual(['E-001']);
    expect(out.evidence).toEqual({ ids: ['E-001'], appended: 1, reused: 1 });
  });

  it('points each row at the ledger line that carried it', () => {
    const out = recordVerification(passVerdict(), { sessionId: SID }, ports());
    const registry = readFileSync(evidenceRegistryPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(registry).toHaveLength(1);
    expect(registry[0].source).toBe(out.lines[0].key);
    expect(existingKeys()).toContain(registry[0].source);
  });

  it('adds no row for a deduped verify line', () => {
    const verdict = passVerdict();
    recordVerification(verdict, { sessionId: SID }, ports());
    const second = recordVerification(verdict, { sessionId: SID }, ports());
    expect(second).toMatchObject({ appended: 0, deduped: 4 });
    expect(second.evidence).toEqual({ ids: [], appended: 0, reused: 0 });
    expect(readEvidenceIds(root)).toEqual(['E-001']);
  });

  it('calls the port only for appended lines that carry evidence, with the line key as source', () => {
    const calls = [];
    const spy = (entries, source) => { calls.push({ n: entries.length, source }); return { ids: [], appended: 0, reused: 0 }; };
    const out = recordVerification(passVerdict(), { sessionId: SID }, { append, existingKeys, registerEvidence: spy });
    // overall + deterministic carry the entry; the two unrun layers carry none.
    expect(calls).toEqual([
      { n: 1, source: out.lines[0].key },
      { n: 1, source: out.lines[1].key },
    ]);
  });

  it('attempts every ledger append before the first registration', () => {
    // A held or stranded registry lock can stall a registration for up to the
    // registry lock's 6 s timeout (5 s stale window). Registering in a second
    // pass keeps that stall from delaying the remaining ledger lines.
    const order = [];
    const logAppend = (input) => { order.push(`append:${input.idempotency_key}`); return append(input); };
    const logRegister = (entries, source) => { order.push(`register:${source}`); return registerPort(entries, source); };
    const out = recordVerification(passVerdict(), { sessionId: SID }, {
      append: logAppend, existingKeys, registerEvidence: logRegister,
    });
    const firstRegister = order.findIndex((s) => s.startsWith('register:'));
    expect(order.slice(0, firstRegister)).toEqual(out.lines.map((l) => `append:${l.key}`));
    expect(order.slice(firstRegister)).toEqual([
      `register:${out.lines[0].key}`,
      `register:${out.lines[1].key}`,
    ]);
    expect(out.evidence).toEqual({ ids: ['E-001'], appended: 1, reused: 1 });
  });

  it('stops registering after the first lock-timeout, so one held lock costs one timeout', () => {
    // Two lines carry evidence here (overall + deterministic). Without the
    // short-circuit each would wait out its own timeout, up to 2 x 6 s on the
    // hook path against an 8 s Stop budget.
    const lock = `${evidenceRegistryPath(root)}.lock`;
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ token: 'held-elsewhere', pid: 1, timestamp: Date.now() }));
    let calls = 0;
    const held = (entries, source) => {
      calls += 1;
      return registerEvidence(entries, { projectRoot: root, source, now: AT, lock: { timeoutMs: 100 } });
    };
    const out = recordVerification(passVerdict(), { sessionId: SID }, { append, existingKeys, registerEvidence: held });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ appended: 4, deduped: 0, rejected: 0, skipped: 0 });
    expect(out.evidence).toEqual({ ids: [], appended: 0, reused: 0, reason: 'lock-timeout' });
    expect(rawLines()).toHaveLength(4);
  });

  it('never calls the port for a rejected line', () => {
    let called = 0;
    const spy = () => { called += 1; return { ids: [], appended: 0, reused: 0 }; };
    const refuse = () => ({ ok: false, reason: 'unregistered-event' });
    const out = recordVerification(passVerdict(), { sessionId: SID }, { append: refuse, registerEvidence: spy });
    expect(out.rejected).toBe(4);
    expect(called).toBe(0);
  });

  it('turns a throwing or malformed port into a reason without touching the tally', () => {
    const boom = () => { throw new Error('registry gone'); };
    for (const [port, reason] of [
      [boom, 'port-threw:registerEvidence'],
      [() => 42, 'port-invalid:registerEvidence'],
      [() => ({ ids: [], appended: 0, reused: 0, reason: 'disk full' }), 'disk full'],
      ['not-a-function', 'port-missing:registerEvidence'],
    ]) {
      rmSync(root, { recursive: true, force: true });
      resetSeq();
      let out;
      expect(() => {
        out = recordVerification(passVerdict(), { sessionId: SID }, { append, existingKeys, registerEvidence: port });
      }).not.toThrow();
      expect(out).toMatchObject({ appended: 4, deduped: 0, rejected: 0, skipped: 0 });
      expect(out.lines.every((l) => l.status === 'appended')).toBe(true);
      expect(out.evidence.reason).toBe(reason);
      expect(out.evidence.ids).toEqual([]);
    }
  });

  it('leaves the result shape unchanged when no port is supplied', () => {
    const out = recordVerification(passVerdict(), { sessionId: SID }, { append, existingKeys });
    expect(Object.keys(out).sort()).toEqual(['appended', 'deduped', 'lines', 'rejected', 'skipped']);
  });

  it('does not put evidence ids on the ledger line', () => {
    recordVerification(passVerdict(), { sessionId: SID }, ports());
    for (const line of rawLines()) {
      expect(Object.keys(line.data).sort()).toEqual(
        line.data.layer === undefined
          ? ['evidence', 'result', 'verification_id']
          : ['evidence', 'layer', 'result', 'verification_id'],
      );
    }
  });
});

describe('the real reader folds the lines this writer wrote', () => {
  /**
   * The one cross-module claim worth measuring rather than asserting by shape:
   * `foldGateState` is imported and run over the ledger this test filled, so a
   * change to either side that broke the join would fail here.
   */
  it('tallies one bucket per layer plus `unspecified` for the overall line', () => {
    const verdict = passVerdict();
    const out = recordVerification(verdict, { sessionId: SID, missionId: MISSION }, { append, existingKeys });
    expect(out.appended).toBe(4);

    const gate = foldGateState(rawLines());
    expect(gate.verifierVerificationId).toBe(verdict.verification_id);
    expect(gate.sawUnmeasured).toBe(true);
    expect([...gate.layers.keys()]).toEqual([LAYER_UNSPECIFIED, ...LAYERS]);
    expect(gate.layers.get(LAYER_UNSPECIFIED)).toMatchObject({ pass: 1, fail: 0, unmeasured: 0, other: 0 });
    expect(gate.layers.get('deterministic')).toMatchObject({ pass: 1, unmeasured: 0, other: 0 });
    expect(gate.layers.get('behavioral')).toMatchObject({ pass: 0, unmeasured: 1, other: 0 });
    expect(gate.layers.get('operational')).toMatchObject({ pass: 0, unmeasured: 1, other: 0 });
    // Nothing landed in the `other` bucket, i.e. every `result` this writer
    // emits is inside the reader's own enum.
    for (const counts of gate.layers.values()) expect(counts.other).toBe(0);
  });

  it('collapses to one bucket once `data.layer` is stripped — so the tally above has teeth', () => {
    // The mutation check for the assertion above. If this writer ever stopped
    // setting `data.layer`, the reader would still fold happily and report a
    // single `unspecified` bucket of four; the previous test is only meaningful
    // because that outcome is distinguishable, and this pins the difference.
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID });
    const stripped = built.inputs.map((i) => {
      const { layer: _layer, ...data } = i.data;
      return { event: i.event, data };
    });
    const gate = foldGateState(stripped);
    expect([...gate.layers.keys()]).toEqual([LAYER_UNSPECIFIED]);
    expect(gate.layers.get(LAYER_UNSPECIFIED).pass + gate.layers.get(LAYER_UNSPECIFIED).unmeasured).toBe(4);
  });

  it('renders the tally as four per-layer findings', () => {
    recordVerification(passVerdict(), { sessionId: SID }, { append, existingKeys });
    const findings = buildFindings(foldGateState(rawLines()), (s) => s);
    expect(findings).toHaveLength(4);
    expect(findings.every((f) => f.code === 'VERIFICATION_LAYER')).toBe(true);
    expect(findings.every((f) => f.total === 1)).toBe(true);
    expect(findings.map((f) => f.layer)).toEqual([LAYER_UNSPECIFIED, ...LAYERS]);
  });
});

describe('the 4096-byte line cap', () => {
  /**
   * A deterministic layer input whose CAPTURED OUTPUT is `bytes` long, taken
   * through the synthesizing path in `normalizeDeterministic` (:311-319 on
   * 2026-09-12) — `command` present, so `stdout` + `stderr` become
   * `evidence[0].output` with no truncation anywhere in the verifier. This is
   * the real shape a vitest run produces, and the reason the cap matters.
   */
  function verdictWithOutput(bytes) {
    return verify({
      layers: {
        deterministic: {
          exitCode: 0,
          command: 'npx vitest run tests/verification',
          stdout: 'x'.repeat(bytes),
          stderr: '',
          reason: 'validationCommand exit code 0',
          evidence: [],
        },
      },
      now: AT,
    });
  }

  /** Bytes of the ledger line an input becomes, newline included — the cap's unit. */
  function inputBytes(input) {
    return Buffer.byteLength(`${JSON.stringify(input)}\n`, 'utf8');
  }

  /** The entry the bounded line carries for the deterministic layer. */
  function detEvidence(built) {
    return built.inputs.find((i) => i.data.layer === 'deterministic').data.evidence[0];
  }

  it('copies `limits.line_max_bytes` from the allowlist without drift', () => {
    // The module cannot import the allowlist (L5 data, and this is L2), so the
    // number is copied. This is the assertion that keeps the copy honest: if the
    // ledger ever raises or lowers its cap, this fails rather than letting the
    // writer size lines against a number nobody maintains.
    const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    expect(allowlist.limits.line_max_bytes).toBe(LEDGER_LINE_MAX_BYTES);
  });

  it('reserves more than the envelope keys the ledger adds downstream', () => {
    // The reserve exists because this module sizes an INPUT while the cap is
    // measured on the assembled ENVELOPE. Measured here rather than asserted
    // from the comment: append one line and compare what came back with what
    // went in, so the reserve is checked against the real overhead.
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID });
    const sent = built.inputs[0];
    append(sent);
    const landed = rawLines()[0];
    const overhead = inputBytes(landed) - inputBytes(sent);
    expect(overhead).toBeGreaterThan(0);
    expect(overhead).toBeLessThan(LINE_RESERVE_BYTES);
  });

  it('keeps every line under the cap for ~5 KB of captured output', () => {
    const built = buildVerifyCompletedEvents(verdictWithOutput(5 * 1024), { sessionId: SID, missionId: MISSION });
    expect(built.ok).toBe(true);
    expect(built.inputs).toHaveLength(4);
    for (const input of built.inputs) {
      expect(inputBytes(input)).toBeLessThanOrEqual(LEDGER_LINE_MAX_BYTES - LINE_RESERVE_BYTES);
    }
  });

  it('keeps every line under the cap for ~40 KB of captured output', () => {
    const built = buildVerifyCompletedEvents(verdictWithOutput(40 * 1024), { sessionId: SID, missionId: MISSION });
    expect(built.ok).toBe(true);
    for (const input of built.inputs) {
      expect(inputBytes(input)).toBeLessThanOrEqual(LEDGER_LINE_MAX_BYTES - LINE_RESERVE_BYTES);
    }
  });

  it('lands all four lines through the REAL writer, unfolded and unrejected', () => {
    // The measurement that the blocking defect is actually closed. Before the
    // bound, the overall and deterministic lines came back `line-too-large` and
    // only the two empty-evidence layers landed, so the reader saw pass 0.
    for (const bytes of [5 * 1024, 40 * 1024]) {
      rmSync(path.join(root, LEDGER_REL), { force: true });
      const built = buildVerifyCompletedEvents(verdictWithOutput(bytes), { sessionId: SID, missionId: MISSION });
      const results = built.inputs.map((input) => append(input));
      expect(results.every((r) => r.ok === true)).toBe(true);
      expect(results.every((r) => r.folded === false)).toBe(true);
      const lines = rawLines();
      expect(lines.filter((l) => l.event === 'ledger.rejected')).toHaveLength(0);
      expect(lines.filter((l) => l.event === VERIFY_COMPLETED_EVENT)).toHaveLength(4);
      for (const line of lines) expect(inputBytes(line)).toBeLessThanOrEqual(LEDGER_LINE_MAX_BYTES);
    }
  });

  it('folds through `recordVerification` with the full four-line tally', () => {
    const out = recordVerification(
      verdictWithOutput(40 * 1024), { sessionId: SID, missionId: MISSION }, { append, existingKeys },
    );
    expect(out).toMatchObject({ appended: 4, deduped: 0, rejected: 0, skipped: 0 });
    const gate = foldGateState(rawLines());
    expect(gate.layers.get('deterministic')).toMatchObject({ pass: 1, unmeasured: 0, other: 0 });
    expect(gate.layers.get(LAYER_UNSPECIFIED)).toMatchObject({ pass: 1, unmeasured: 0, other: 0 });
  });

  it('says how much it removed, in the entry it shortened', () => {
    const built = buildVerifyCompletedEvents(verdictWithOutput(5 * 1024), { sessionId: SID });
    const entry = detEvidence(built);
    expect(entry.output).toContain(EVIDENCE_TRUNCATION_MARK);
    expect(entry.output).toMatch(/\[truncated \d+ of 5120 bytes\]$/);
    // The head is kept, not a placeholder: the first bytes of a failing command's
    // output are the part a reader needs.
    expect(entry.output.startsWith('xxxx')).toBe(true);
    // Identity fields survive — a shortened entry is still the same evidence.
    expect(entry.kind).toBe('command');
    expect(entry.command).toBe('npx vitest run tests/verification');
  });

  it('leaves the verdict it was handed byte-identical', () => {
    // The writer must not mutate its input. `verification_id` is hashed from the
    // FULL evidence, so a writer that shortened the verdict in place would move
    // the join key and make the same verdict hash two ways.
    const verdict = verdictWithOutput(5 * 1024);
    const before = JSON.stringify(verdict);
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID });
    expect(JSON.stringify(verdict)).toBe(before);
    expect(verdict.layers[0].evidence[0].output).toHaveLength(5 * 1024);
    expect(built.inputs[0].data.verification_id).toBe(verdict.verification_id);
  });

  it('does not touch evidence that already fits', () => {
    const built = buildVerifyCompletedEvents(passVerdict(), { sessionId: SID });
    for (const input of built.inputs) {
      for (const entry of input.data.evidence) {
        expect(JSON.stringify(entry)).not.toContain(EVIDENCE_TRUNCATION_MARK);
      }
    }
    expect(detEvidence(built).output).toBe('ok');
  });

  it('bounds many entries as well as one big one', () => {
    // The single-entry case is the one the adapter produces today; a verdict
    // assembled by hand can carry hundreds. Both must fit, and the line must
    // still name the layer it measured.
    const evidence = Array.from({ length: 400 }, (_unused, i) => ({
      kind: 'command', command: `step ${i}`, output: 'y'.repeat(512),
    }));
    const verdict = verify({
      layers: { deterministic: { exitCode: 0, evidence } },
      now: AT,
    });
    const built = buildVerifyCompletedEvents(verdict, { sessionId: SID, missionId: MISSION });
    expect(built.ok).toBe(true);
    for (const input of built.inputs) {
      expect(inputBytes(input)).toBeLessThanOrEqual(LEDGER_LINE_MAX_BYTES - LINE_RESERVE_BYTES);
    }
    const det = built.inputs.find((i) => i.data.layer === 'deterministic');
    expect(det.data.result).toBe('pass');
    expect(det.data.verification_id).toBe(verdict.verification_id);
    // Entries that were dropped whole are counted, never silently absent.
    expect(JSON.stringify(det.data.evidence)).toContain('dropped');
    const results = det.data.evidence.length;
    expect(results).toBeGreaterThan(0);
  });

  it('never throws on evidence JSON cannot serialize', () => {
    // `buildVerifyCompletedEvents` is reachable with a hand-built verdict, so the
    // bound has to survive a circular `output` rather than take the module down.
    const circular = { kind: 'command', command: 'c', output: 'z'.repeat(9000) };
    circular.self = circular;
    const verdict = { ...passVerdict(), evidence: [circular] };
    let built;
    expect(() => { built = buildVerifyCompletedEvents(verdict, { sessionId: SID }); }).not.toThrow();
    expect(built.ok).toBe(true);
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
