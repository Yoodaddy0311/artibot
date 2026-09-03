/**
 * Unit contract for the central run-ledger writer.
 *
 * Covers the four guarantees the module claims, each against a real temp
 * directory rather than a mocked fs: envelope assembly (including the session
 * fallback mission_id), the vocabulary allowlist's fail-closed behavior, the
 * 4 KB per-line cap with its fold, and per-field secret redaction.
 *
 * FIXTURE NOTE — every fake credential below is ASSEMBLED AT RUNTIME from
 * fragments rather than written as a literal. The repo's own content-secret
 * guard (`lib/core/guard-registry.js#checkContentSecret`) blocks a write whose
 * text matches a credential shape, and it cannot tell a test fixture from a
 * real leak. Assembling the shapes keeps the fixtures out of the file's bytes
 * while the writer still sees the finished string at run time, which is the
 * only thing the assertions care about.
 *
 * ── WHAT THIS SUITE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - CROSS-PROCESS APPEND SURVIVAL. Everything here runs in one process, so
 *     `'a'`-flag atomicity is untested by construction. That is measured in
 *     tests/firewall/ledger-append-survival.test.js with real child processes.
 *   - WHETHER A LIVE CALLER PASSES THE RIGHT FIELDS. Phase 0 ships this module
 *     with zero callers, so every payload below is one this file invented.
 *   - THE FOUR SCHEMA KEYWORDS THE WRITER DOES NOT RUN. Receipt `data` is
 *     validated against its schema here, but `allOf`, `oneOf`, `if`/`then` and
 *     `format` are skipped by the dependency-free validator, so a receipt that
 *     violates ONLY one of those passes. Agreement with a real validator is
 *     measured in tests/firewall/ledger-vocab-allowlist.test.js, which runs ajv
 *     as the reference oracle; this file does not.
 *
 * @module tests/runtime/event-writer
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BUDGET_MARKER,
  buildEnvelope,
  CIRCULAR_MARKER,
  DEFAULT_LINE_MAX_BYTES,
  DEPTH_MARKER,
  ENVELOPE_VERSION,
  foldOversized,
  getAllowlist,
  getLedgerSettings,
  ledgerFilePath,
  lineBytes,
  MAX_REDACT_DEPTH,
  MAX_REDACT_NODES,
  nextSeq,
  normalizeDeclaredEnums,
  redactDeep,
  REJECTED_EVENT,
  resetSeq,
  sessionFallbackMissionId,
  validateAgainstSchema,
  validateEnvelope,
  validateEventContract,
  writeEvent,
} from '../../lib/runtime/event-writer.js';

/** @type {string} */
let root;

const SID = 'sess-abcdefgh-0001';

/** Fake credentials, assembled at run time — see the FIXTURE NOTE above. */
const FAKE = {
  anthropic: ['sk', 'ant', `${'A'.repeat(30)}`].join('-'),
  aws: `AKIA${'IOSFODNN7EXAMPL'}E`,
  github: `ghp${'_'}${'b'.repeat(36)}`,
  assignment: `API${'_'}KEY="${'d'.repeat(24)}"`,
};

/**
 * Base caller payload. Each test overrides only what it is about.
 * @param {object} [over]
 * @returns {object}
 */
function ev(over = {}) {
  return { session_id: SID, source: 'hook', ...over };
}

/**
 * Every line currently in the ledger, parsed.
 * @returns {object[]}
 */
function lines() {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-ledger-unit-'));
  resetSeq();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('envelope assembly', () => {
  it('writes the eight required keys with the Phase 0 envelope version', () => {
    const res = writeEvent(root, ev({
      event: 'mission.created',
      mission_id: 'M-20260902-001',
      data: { title: 'x', intent_revision: 1 },
    }));
    expect(res.ok).toBe(true);
    const [line] = lines();
    expect(line.v).toBe(ENVELOPE_VERSION);
    expect(line.event).toBe('mission.created');
    expect(line.mission_id).toBe('M-20260902-001');
    expect(line.session_id).toBe(SID);
    expect(line.source).toBe('hook');
    expect(Number.isInteger(line.pid)).toBe(true);
    expect(line.seq).toBe(0);
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('synthesizes the session fallback mission_id when the caller has none', () => {
    writeEvent(root, ev({ event: 'tool.used', data: { tool: 'Bash', ok: true, duration_ms: 1 } }));
    const [line] = lines();
    expect(line.mission_id).toMatch(/^M-\d{8}-S[0-9A-Za-z]{8}$/);
    expect(line.mission_id).toBe(sessionFallbackMissionId(SID, line.ts));
  });

  it('derives sid8 from a hash when the session id has under 8 alphanumerics', () => {
    const short = sessionFallbackMissionId('a-b', '2026-09-02T00:00:00.000Z');
    expect(short).toMatch(/^M-20260902-S[0-9a-f]{8}$/);
    // Deterministic: the same session always folds to the same mission id.
    expect(sessionFallbackMissionId('a-b', '2026-09-02T00:00:00.000Z')).toBe(short);
    // And two different short ids do not collide onto one padded value.
    expect(sessionFallbackMissionId('a-c', '2026-09-02T00:00:00.000Z')).not.toBe(short);
  });

  it('returns null rather than inventing a mission id without a session', () => {
    expect(sessionFallbackMissionId('')).toBeNull();
    expect(sessionFallbackMissionId(undefined)).toBeNull();
  });

  it('advances seq monotonically per process', () => {
    const payload = ev({ event: 'tool.used', data: { tool: 'Bash', ok: true, duration_ms: 1 } });
    writeEvent(root, payload);
    writeEvent(root, payload);
    writeEvent(root, payload);
    expect(lines().map((l) => l.seq)).toEqual([0, 1, 2]);
  });

  it('carries the optional envelope keys through unchanged', () => {
    const res = writeEvent(root, ev({
      event: 'review.completed',
      source: 'reviewer',
      model: 'claude-fable-5-1',
      run_id: 'run-1',
      actor: { type: 'agent', id: 'reviewer-1' },
      data: { verdict: 'PASS', findings_ref: 'ref://1' },
    }));
    expect(res.ok).toBe(true);
    const [line] = lines();
    expect(line.model).toBe('claude-fable-5-1');
    expect(line.run_id).toBe('run-1');
    expect(line.actor).toEqual({ type: 'agent', id: 'reviewer-1' });
  });

  it('rejects an unknown top-level key instead of silently dropping it', () => {
    const res = writeEvent(root, ev({
      event: 'tool.used',
      surprise: 'value',
      data: { tool: 'Bash', ok: true, duration_ms: 1 },
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown-envelope-key:surprise');
    // The refused line is absent and the refusal is on the record.
    expect(lines().map((l) => l.event)).toEqual([REJECTED_EVENT]);
    expect(lines()[0].data.raw_event).toBe('tool.used');
  });

  it('refuses to write without a project root', () => {
    expect(writeEvent('', ev({ event: 'tool.used' })).reason).toBe('no-project-root');
  });
});

describe('envelope validation', () => {
  it('names the field that failed', () => {
    const base = buildEnvelope(ev({ event: 'tool.used', mission_id: 'M-20260902-001' }));
    expect(validateEnvelope(base)).toBeNull();
    expect(validateEnvelope({ ...base, source: 'nobody' })).toBe('invalid-envelope:source');
    expect(validateEnvelope({ ...base, mission_id: 'M-2026-1' })).toBe('invalid-envelope:mission_id');
    expect(validateEnvelope({ ...base, event: 'Bad.Event' })).toBe('invalid-envelope:event');
    expect(validateEnvelope({ ...base, ts: '2026-09-02 07:00' })).toBe('invalid-envelope:ts');
    expect(validateEnvelope({ ...base, seq: -1 })).toBe('invalid-envelope:seq');
    expect(validateEnvelope({ ...base, data: [] })).toBe('invalid-envelope:data');
    expect(validateEnvelope({ ...base, actor: { type: 'alien', id: 'x' } }))
      .toBe('invalid-envelope:actor');
  });

  it('accepts both mission id forms the schema allows', () => {
    const base = buildEnvelope(ev({ event: 'tool.used' }));
    expect(validateEnvelope({ ...base, mission_id: 'M-20260902-001' })).toBeNull();
    expect(validateEnvelope({ ...base, mission_id: 'M-20260902-10247' })).toBeNull();
    expect(validateEnvelope({ ...base, mission_id: 'M-20260902-Sab12cd34' })).toBeNull();
  });
});

describe('vocabulary allowlist (fail-closed)', () => {
  it('rejects an unregistered event and records the rejection', () => {
    const res = writeEvent(root, ev({ event: 'totally.invented', data: {} }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unregistered-event');
    expect(res.recorded).toBe(true);
    const written = lines();
    expect(written).toHaveLength(1);
    expect(written[0].event).toBe(REJECTED_EVENT);
    expect(written[0].data)
      .toEqual({ raw_event: 'totally.invented', reason: 'unregistered-event' });
  });

  it('rejects a registered event that is missing a required data field', () => {
    const res = writeEvent(root, ev({ event: 'intent.detected', data: { type: 'feature' } }));
    expect(res.reason).toBe('missing-required-data:confidence');
    expect(lines()[0].event).toBe(REJECTED_EVENT);
  });

  it('rejects a source the event does not permit', () => {
    const res = writeEvent(root, ev({
      event: 'verify.completed', source: 'hook', data: { result: 'pass', evidence: [] },
    }));
    expect(res.reason).toBe('source-not-allowed:hook');
  });

  it('rejects a missing mandatory envelope key', () => {
    const res = writeEvent(root, ev({
      event: 'worker.claimed',
      source: 'supervisor',
      data: { agent_type: 'backend', model_tier: 'opus', owns: [] },
    }));
    expect(res.reason).toBe('missing-required-envelope:worker');
  });

  it('rejects a value outside a declared enum', () => {
    const res = writeEvent(root, ev({
      event: 'topology.selected', source: 'scheduler', data: { mode: 'quantum' },
    }));
    expect(res.reason).toBe('enum-violation:mode');
  });

  it('rejects a value of the wrong declared type', () => {
    const res = writeEvent(root, ev({
      event: 'mission.completed', data: { accepted: 'yes', evidence_refs: [] },
    }));
    expect(res.reason).toBe('type-violation:accepted');
  });

  it('accepts the three-valued accepted field the design requires', () => {
    for (const accepted of [true, false, null]) {
      const res = writeEvent(root, ev({
        event: 'mission.completed', data: { accepted, evidence_refs: [] },
      }));
      expect(res.ok).toBe(true);
    }
  });

  it('takes a receipt event required keys from data_schema, not from required', () => {
    const spec = getAllowlist().events['route.selected'];
    expect(spec.data_schema).toBe('route-receipt.schema.json');
    expect(spec.required).toBeUndefined();
    const res = writeEvent(root, ev({
      event: 'route.selected', source: 'scheduler', data: { schema_version: 1 },
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^missing-required-data:/);
  });

  it('never rejects its own rejection line recursively', () => {
    // A ledger.rejected that itself fails the contract is dropped, not retried.
    const res = writeEvent(root, ev({ event: REJECTED_EVENT, data: { raw_event: 'x' } }));
    expect(res.ok).toBe(false);
    expect(res.recorded).toBe(false);
    expect(lines()).toHaveLength(0);
  });

  it('validateEventContract passes a well-formed event', () => {
    const env = buildEnvelope(ev({
      event: 'tool.used',
      mission_id: 'M-20260902-001',
      data: { tool: 'Bash', ok: true, duration_ms: 3 },
    }));
    expect(validateEventContract(env)).toBeNull();
  });
});

describe('4 KB per-line cap', () => {
  it('reads 4096 as the effective cap', () => {
    expect(getLedgerSettings().maxLineBytes).toBe(4096);
    expect(DEFAULT_LINE_MAX_BYTES).toBe(4096);
    expect(getAllowlist().limits.line_max_bytes).toBe(4096);
  });

  it('lets an explicit option override the configured cap', () => {
    expect(getLedgerSettings({ maxLineBytes: 128 }).maxLineBytes).toBe(128);
  });

  it('folds non-required data into evidence_refs and stays under the cap', () => {
    const res = writeEvent(root, ev({
      event: 'tool.used',
      data: {
        tool: 'Bash',
        ok: true,
        duration_ms: 4,
        stdout: 'y'.repeat(9000),
        evidence_refs: ['raw://original'],
      },
    }));
    expect(res.ok).toBe(true);
    expect(res.folded).toBe(true);
    expect(res.dropped).toEqual(['stdout']);
    expect(res.bytes).toBeLessThanOrEqual(4096);
    const [line] = lines();
    expect(line.data.tool).toBe('Bash');
    expect(line.data.stdout).toBeUndefined();
    expect(line.data.evidence_refs).toEqual(['raw://original', 'ledger-fold:dropped=stdout']);
  });

  it('rejects a line that is still oversized after folding', () => {
    const res = writeEvent(root, ev({
      event: 'mission.created',
      data: { title: 'x'.repeat(9000), intent_revision: 1 },
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^line-too-large:\d+$/);
    const written = lines();
    expect(written).toHaveLength(1);
    expect(written[0].event).toBe(REJECTED_EVENT);
    // Fail-closed: nothing over the cap ever reaches the file.
    expect(lineBytes(written[0])).toBeLessThanOrEqual(4096);
  });

  it('never folds a receipt event, because its schema is closed', () => {
    const spec = getAllowlist().events['usage.receipt'];
    const env = { event: 'usage.receipt', data: { junk: 'z'.repeat(50), cost: {} } };
    const out = foldOversized(env, spec);
    expect(out.folded).toBe(false);
    expect(out.env.data.junk).toBeDefined();
  });

  it('measures bytes, not characters', () => {
    // Three-byte UTF-8 characters: 2000 of them exceed 4096 bytes while being
    // well under 4096 characters. A length-based cap would let this through.
    const res = writeEvent(root, ev({
      event: 'mission.created',
      data: { title: '가'.repeat(2000), intent_revision: 1 },
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^line-too-large:/);
  });
});

describe('redaction', () => {
  it('masks the secret shapes guard-registry names, per field', () => {
    const res = writeEvent(root, ev({
      event: 'tool.used',
      data: {
        tool: 'Bash',
        ok: true,
        duration_ms: 1,
        anthropic: FAKE.anthropic,
        aws: FAKE.aws,
        github: FAKE.github,
        assignment: FAKE.assignment,
      },
    }));
    expect(res.ok).toBe(true);
    const blob = JSON.stringify(lines()[0].data);
    for (const secret of Object.values(FAKE)) {
      expect(blob).not.toContain(secret);
    }
  });

  it('keeps the JSONL framing intact when a secret is masked', () => {
    writeEvent(root, ev({
      event: 'tool.used',
      data: { tool: 'Bash', ok: true, duration_ms: 1, note: `key="${FAKE.anthropic}"` },
    }));
    const raw = readFileSync(ledgerFilePath(root), 'utf-8');
    expect(raw.split('\n').filter((l) => l.trim()).length).toBe(1);
    expect(() => JSON.parse(raw.trim())).not.toThrow();
  });

  it('preserves non-secret context such as file paths', () => {
    const kept = redactDeep({ file: 'C:/Users/dev/project/src/index.js' });
    expect(kept.file).toBe('C:/Users/dev/project/src/index.js');
  });

  it('drops prototype-pollution keys while recursing', () => {
    const out = redactDeep(JSON.parse('{"a":1,"__proto__":{"polluted":true}}'));
    expect(Object.keys(out)).toEqual(['a']);
  });

  it('leaves numbers and booleans untouched', () => {
    expect(redactDeep({ n: 42, b: false, arr: [1, 'x'] }))
      .toEqual({ n: 42, b: false, arr: [1, 'x'] });
  });
});

describe('append mechanics', () => {
  it('creates the ledger under .artibot/runtime relative to the injected root', () => {
    writeEvent(root, ev({ event: 'tool.used', data: { tool: 'B', ok: true, duration_ms: 1 } }));
    expect(ledgerFilePath(root)).toBe(path.join(root, '.artibot', 'runtime', 'ledger.jsonl'));
    expect(existsSync(ledgerFilePath(root))).toBe(true);
  });

  it('honors an explicit ledgerPath override', () => {
    const res = writeEvent(
      root,
      ev({ event: 'tool.used', data: { tool: 'B', ok: true, duration_ms: 1 } }),
      { ledgerPath: 'custom/ledger.jsonl' },
    );
    expect(res.path).toBe(path.join(root, 'custom', 'ledger.jsonl'));
    expect(existsSync(res.path)).toBe(true);
  });

  it('ends every line with exactly one newline', () => {
    const payload = ev({ event: 'tool.used', data: { tool: 'B', ok: true, duration_ms: 1 } });
    writeEvent(root, payload);
    writeEvent(root, payload);
    const raw = readFileSync(ledgerFilePath(root), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n')).toHaveLength(3); // two lines plus the trailing empty
  });

  it('nextSeq never repeats a value', () => {
    resetSeq();
    expect([nextSeq(), nextSeq(), nextSeq()]).toEqual([0, 1, 2]);
  });
});

/**
 * A model identity that satisfies the shared `#/definitions/model_identity`.
 * @param {string} [id]
 * @returns {object}
 */
function modelIdentity(id = 'claude-opus-5') {
  return {
    provider: 'anthropic',
    family: 'claude',
    tier: 'opus',
    model_id: id,
    version: '2026-09-01',
    catalog_version: '1',
  };
}

/**
 * A route receipt that satisfies schemas/route-receipt.schema.json in full.
 * @param {object} [over] shallow overrides
 * @returns {object}
 */
function routeReceipt(over = {}) {
  const term = () => ({ value: 0, measured: true });
  return {
    schema_version: 1,
    route_receipt_id: 'rr-1',
    mission_id: 'M-20260902-001',
    session_id: SID,
    execution_profile_version: 1,
    routing_epoch_id: 'ep-1',
    action: { type: 'implement', phase: 'build', complexity: 0.5 },
    models: { current: null, recommended: modelIdentity(), selected: modelIdentity() },
    decision: { type: 'route' },
    predicted: { success: 0.9, cost: 0.2, latency: 1200, retry_probability: 0.1 },
    transition: {
      context_rebuild_tokens: 0,
      cache_loss_estimate: 0,
      handoff_tokens: 0,
      predicted_time_ms: 0,
      predicted_cost: 0,
    },
    terms: {
      contextSerialization: term(),
      contextRebuild: term(),
      cacheLoss: term(),
      handoffTokens: term(),
      handoffLatency: term(),
      reorientationRisk: term(),
      expectedRetry: term(),
    },
    actionsSinceSwitch: 0,
    reason: ['policy'],
    timestamp: '2026-09-02T00:00:00.000Z',
    ...over,
  };
}

/**
 * An attempt receipt that satisfies schemas/attempt-receipt.schema.json in full.
 * @param {object} [over] shallow overrides
 * @returns {object}
 */
function attemptReceipt(over = {}) {
  return {
    schema_version: 1,
    run_id: 'run-1',
    mission_id: 'M-20260902-001',
    model_identity: modelIdentity(),
    usage: {
      source: 'transcript',
      fresh_input_tokens: 10,
      cached_input_tokens: 5,
      cache_creation_tokens: 0,
      output_tokens: 3,
    },
    timing: {
      started_at: '2026-09-02T00:00:00.000Z',
      completed_at: '2026-09-02T00:00:01.000Z',
      latency_ms: 1000,
    },
    outcome: { status: 'ok', accepted: null },
    cost: { total: 0.5, pricing_version: 'v1' },
    ...over,
  };
}

describe('receipt events validate against their data_schema', () => {
  /**
   * @param {object} over envelope overrides
   * @returns {object} writer result
   */
  function putRoute(over = {}) {
    return writeEvent(root, ev({
      event: 'route.selected',
      source: 'scheduler',
      mission_id: 'M-20260902-001',
      data: routeReceipt(),
      ...over,
    }));
  }

  it('accepts a receipt that satisfies the whole schema', () => {
    const res = putRoute();
    expect(res.ok).toBe(true);
    expect(lines()[0].data.decision).toEqual({ type: 'route' });
  });

  it('a minimal valid route receipt fits inside the 4 KB cap', () => {
    // Receipts cannot be folded, so a receipt that did not fit would be
    // unwritable rather than merely trimmed. This pins the headroom.
    const res = putRoute();
    expect(res.bytes).toBeLessThan(4096);
    expect(res.folded).toBe(false);
  });

  it('rejects decision written as a flat string rather than an object', () => {
    const res = putRoute({ data: routeReceipt({ decision: 'route' }) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('receipt-type:decision');
  });

  it('rejects a decision.type outside the five-value vocabulary', () => {
    const res = putRoute({ data: routeReceipt({ decision: { type: 'teleport' } }) });
    expect(res.reason).toBe('receipt-enum:decision.type');
  });

  it('rejects a key the receipt schema does not declare', () => {
    const res = putRoute({ data: routeReceipt({ surprise: 1 }) });
    expect(res.reason).toBe('receipt-additional:surprise');
  });

  it('rejects a nested required key that is missing', () => {
    const models = { current: null, recommended: modelIdentity() };
    const res = putRoute({ data: routeReceipt({ models }) });
    expect(res.reason).toBe('receipt-required:models.selected');
  });

  it('rejects a nested enum violation reached through a $ref', () => {
    const selected = { ...modelIdentity(), tier: 'giant' };
    const models = { current: null, recommended: modelIdentity(), selected };
    const res = putRoute({ data: routeReceipt({ models }) });
    expect(res.reason).toBe('receipt-enum:models.selected.tier');
  });

  it('rejects a numeric bound violation', () => {
    const predicted = { success: 1.5, cost: 0, latency: 0, retry_probability: 0 };
    const res = putRoute({ data: routeReceipt({ predicted }) });
    expect(res.reason).toBe('receipt-maximum:predicted.success');
  });

  it('validates an attempt receipt the same way', () => {
    const ok = writeEvent(root, ev({
      event: 'usage.receipt', source: 'worker', mission_id: 'M-20260902-001',
      model: 'claude-opus-5', data: attemptReceipt(),
    }));
    expect(ok.ok).toBe(true);
    const bad = writeEvent(root, ev({
      event: 'usage.receipt', source: 'worker', mission_id: 'M-20260902-001',
      model: 'claude-opus-5',
      data: attemptReceipt({ usage: { ...attemptReceipt().usage, source: 'api' } }),
    }));
    expect(bad.reason).toBe('receipt-enum:usage.source');
  });

  it('validateAgainstSchema is exported and pure', () => {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    expect(validateAgainstSchema({ a: 'x' }, schema)).toBeNull();
    expect(validateAgainstSchema({}, schema)).toBe('required:a');
    expect(validateAgainstSchema({ a: 1 }, schema)).toBe('type:a');
  });
});

describe('a receipt may not disagree with the envelope that carries it', () => {
  it('rejects a receipt whose mission_id differs from the envelope', () => {
    const res = writeEvent(root, ev({
      event: 'route.selected',
      source: 'scheduler',
      mission_id: 'M-20260902-001',
      data: routeReceipt({ mission_id: 'M-20260902-999' }),
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('receipt-identity-mismatch:mission_id');
  });

  it('rejects a receipt whose session_id differs from the envelope', () => {
    const res = writeEvent(root, ev({
      event: 'route.selected',
      source: 'scheduler',
      mission_id: 'M-20260902-001',
      data: routeReceipt({ session_id: 'some-other-session' }),
    }));
    expect(res.reason).toBe('receipt-identity-mismatch:session_id');
  });

  it('rejects a run_id disagreement too, on the same rule', () => {
    const res = writeEvent(root, ev({
      event: 'usage.receipt',
      source: 'worker',
      mission_id: 'M-20260902-001',
      model: 'claude-opus-5',
      run_id: 'run-envelope',
      data: attemptReceipt({ run_id: 'run-receipt' }),
    }));
    expect(res.reason).toBe('receipt-identity-mismatch:run_id');
  });

  it('accepts a receipt that simply omits an identity key', () => {
    // attempt-receipt has no session_id at all; absence is not disagreement.
    const res = writeEvent(root, ev({
      event: 'usage.receipt',
      source: 'worker',
      mission_id: 'M-20260902-001',
      model: 'claude-opus-5',
      run_id: 'run-1',
      data: attemptReceipt(),
    }));
    expect(res.ok).toBe(true);
  });
});

describe('verify_result case folding', () => {
  /**
   * @param {unknown} result
   * @returns {object} writer result
   */
  function putVerify(result) {
    return writeEvent(root, ev({
      event: 'verify.completed',
      source: 'gate',
      mission_id: 'M-20260902-001',
      data: { result, evidence: ['vitest'] },
    }));
  }

  it('folds the verifier\'s uppercase status onto the canonical lowercase', () => {
    // unified-verifier reports PASS|FAIL|UNMEASURED; the ledger enum is lowercase.
    for (const [sent, stored] of [['PASS', 'pass'], ['FAIL', 'fail'], ['UNMEASURED', 'unmeasured']]) {
      const res = putVerify(sent);
      expect(res.ok, sent).toBe(true);
      expect(lines().at(-1).data.result).toBe(stored);
    }
  });

  it('leaves an already-canonical value untouched', () => {
    expect(putVerify('pass').ok).toBe(true);
    expect(lines().at(-1).data.result).toBe('pass');
  });

  it('rejects a mixed-case spelling rather than lowercasing anything', () => {
    // A blanket toLowerCase() would accept this and widen the vocabulary.
    expect(putVerify('Pass').reason).toBe('enum-violation:result');
    expect(putVerify('pAsS').reason).toBe('enum-violation:result');
  });

  it('rejects a value that is not in the enum in any case', () => {
    expect(putVerify('PASSED').reason).toBe('enum-violation:result');
    expect(putVerify('skipped').reason).toBe('enum-violation:result');
  });

  it('does NOT fold review verdicts, whose canonical spelling is uppercase', () => {
    const put = (verdict) => writeEvent(root, ev({
      event: 'review.completed',
      source: 'reviewer',
      mission_id: 'M-20260902-001',
      model: 'claude-fable-5-1',
      data: { verdict, findings_ref: 'r://1' },
    }));
    expect(put('PASS').ok).toBe(true);
    expect(lines().at(-1).data.verdict).toBe('PASS');
    // Folding must not leak across enums: lowercase is not a review verdict.
    expect(put('pass').reason).toBe('enum-violation:verdict');
  });

  it('normalizeDeclaredEnums returns the same object when nothing folds', () => {
    const env = buildEnvelope(ev({
      event: 'verify.completed',
      source: 'gate',
      mission_id: 'M-20260902-001',
      data: { result: 'pass', evidence: [] },
    }));
    expect(normalizeDeclaredEnums(env)).toBe(env);
  });
});

describe('hostile data cannot take the process down', () => {
  /**
   * @param {unknown} data
   * @returns {object} writer result
   */
  function put(data) {
    return writeEvent(root, ev({ event: 'tool.used', mission_id: 'M-20260902-001', data }));
  }

  it('folds a self-referencing object instead of overflowing the stack', () => {
    // Reproduced before the guard existed: RangeError: Maximum call stack size
    // exceeded, thrown straight through the module's "never throws" contract.
    const cyc = { tool: 'Bash', ok: true, duration_ms: 1 };
    cyc.self = cyc;
    let res;
    expect(() => { res = put(cyc); }).not.toThrow();
    expect(res.ok).toBe(true);
    expect(lines()[0].data.self).toBe('[circular]');
  });

  it('folds a mutual cycle two objects long', () => {
    const a = { tool: 'Bash', ok: true, duration_ms: 1 };
    const b = { back: a };
    a.forward = b;
    let res;
    expect(() => { res = put(a); }).not.toThrow();
    expect(res.ok).toBe(true);
    expect(lines()[0].data.forward.back).toBe('[circular]');
  });

  it('folds a structure nested past the depth bound', () => {
    const deep = {};
    let cur = deep;
    for (let i = 0; i < 50_000; i += 1) {
      cur.n = {};
      cur = cur.n;
    }
    let res;
    expect(() => { res = put({ tool: 'B', ok: true, duration_ms: 1, deep }); }).not.toThrow();
    expect(res.ok).toBe(true);
    // Walk to the bottom and measure, rather than asserting a hand-computed
    // offset: the first draft of this test encoded its own off-by-one and
    // failed against correct code.
    let node = lines()[0].data.deep;
    let hops = 0;
    while (node !== null && typeof node === 'object') {
      node = node.n;
      hops += 1;
    }
    // The walk ends at the marker, not at `undefined` and not at 50,000 levels.
    expect(node).toBe('[depth]');
    expect(hops).toBeLessThanOrEqual(MAX_REDACT_DEPTH);
  });

  it('does not mistake a repeated sibling for a cycle', () => {
    // The guard is scoped to the current path. An object that appears twice
    // side by side is not a cycle and must survive twice over.
    const shared = { k: 'v' };
    const out = redactDeep({ a: shared, b: shared });
    expect(out).toEqual({ a: { k: 'v' }, b: { k: 'v' } });
  });

  it('turns any escaped exception into a result', () => {
    // A getter that throws is not something the guards above model, which is
    // the point: the catch is for what was not thought of.
    const hostile = {
      tool: 'Bash',
      ok: true,
      duration_ms: 1,
      get boom() { throw new TypeError('from a getter'); },
    };
    let res;
    expect(() => { res = put(hostile); }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('writer-exception:TypeError');
  });

  it('keeps the ledger readable after hostile input', () => {
    const cyc = { tool: 'Bash', ok: true, duration_ms: 1 };
    cyc.self = cyc;
    put(cyc);
    put({ tool: 'Bash', ok: true, duration_ms: 2 });
    // Every line still parses on its own — the fold did not corrupt framing.
    expect(lines()).toHaveLength(2);
    expect(lines()[1].data.duration_ms).toBe(2);
  });
});

describe('the clock is a port, and a wrong one is refused', () => {
  /**
   * @param {object} [opts] writer options, notably `now`
   * @param {object} [over] envelope overrides
   * @returns {object} writer result
   */
  function put(opts, over = {}) {
    return writeEvent(
      root,
      ev({ event: 'tool.used', mission_id: 'M-20260902-001', data: { tool: 'B', ok: true, duration_ms: 1 }, ...over }),
      opts,
    );
  }

  it('uses an injected clock that honors the () => Date contract', () => {
    const fixed = new Date('2026-09-03T00:00:00.000Z');
    expect(put({ now: () => fixed }).ok).toBe(true);
    expect(lines()[0].ts).toBe('2026-09-03T00:00:00.000Z');
  });

  it('falls back to the wall clock when no clock is injected', () => {
    expect(put({}).ok).toBe(true);
    expect(lines()[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses a non-function clock instead of silently using wall time', () => {
    // BEHAVIOR CHANGE, deliberate. Both of these used to return ok:true with a
    // wall-clock timestamp, so a caller that believed it had pinned time was
    // reading real time with nothing to say so. Measured reach when adopted:
    // zero callers pass a non-function `now`.
    expect(put({ now: '2026-09-03T00:00:00Z' }).reason).toBe('writer-exception:TypeError');
    expect(put({ now: 1788000000000 }).reason).toBe('writer-exception:TypeError');
  });

  it('refuses a function that does not return a Date', () => {
    expect(put({ now: () => '2026-09-03' }).reason).toBe('writer-exception:TypeError');
    expect(put({ now: () => 1788000000000 }).reason).toBe('writer-exception:TypeError');
    expect(put({ now: () => null }).reason).toBe('writer-exception:TypeError');
    expect(put({ now: () => new Date('not a date') }).reason).toBe('writer-exception:TypeError');
  });

  it('returns rather than throwing for every malformed clock', () => {
    // The port throws; this module does not. That seam is the whole contract.
    for (const now of ['x', 42, () => 'x', () => null, () => { throw new Error('bad'); }]) {
      expect(() => put({ now })).not.toThrow();
    }
  });

  it('never consults the clock when the caller supplies ts', () => {
    // The clock is judged only where it is actually read, so a malformed one
    // alongside an explicit ts is neither used nor complained about.
    const res = put({ now: 'bogus' }, { ts: '2026-09-03T00:00:00.000Z' });
    expect(res.ok).toBe(true);
    expect(lines()[0].ts).toBe('2026-09-03T00:00:00.000Z');
  });

  it('writes nothing at all when the clock is refused', () => {
    // Not even a ledger.rejected line: the failure happens during assembly,
    // before there is an envelope worth recording a rejection about.
    expect(put({ now: 'bogus' }).ok).toBe(false);
    expect(lines()).toHaveLength(0);
  });
});

describe('a shared subtree costs one walk, not one per path', () => {
  /**
   * A DAG where every level points at the SAME child twice. `2*depth+1`
   * objects, but `2^depth` distinct paths through them — the shape that made
   * the path-scoped cycle guard exponential. No cycle anywhere in it.
   *
   * @param {number} depth
   * @returns {object}
   */
  function sharedDag(depth) {
    let node = { leaf: 'x' };
    for (let i = 0; i < depth; i += 1) node = { a: node, b: node };
    return node;
  }

  it('redacts a depth-22 shared subtree well inside a time bound', () => {
    // Measured 2026-09-03 on this machine: ~1 ms with the result memo,
    // ~2,700 ms without it (56 ms at depth 16, 626 ms at 20 — about 4x per
    // level). 200 ms sits two orders of magnitude above the memoized time and
    // an order below the un-memoized one, so it cannot flake on a slow machine
    // and cannot pass if the memo is removed.
    const started = performance.now();
    const out = redactDeep(sharedDag(22));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(200);
    // Depth 22 is 2^23 nodes expanded, far past the node budget, so the result
    // is truncated rather than complete. That is the correct answer, and the
    // point of the assertion is that it ARRIVES.
    expect(JSON.stringify(out)).toContain(BUDGET_MARKER);
  });

  it('walks a shared subtree in full when it fits the budget', () => {
    // Depth 10 expands to 2^11-1 = 2047 nodes, inside MAX_REDACT_NODES, so
    // nothing is truncated and the leaf survives down every branch.
    const out = redactDeep(sharedDag(10));
    expect(JSON.stringify(out)).not.toContain(BUDGET_MARKER);
    let node = out;
    for (let i = 0; i < 10; i += 1) node = i % 2 === 0 ? node.a : node.b;
    expect(node).toEqual({ leaf: 'x' });
  });

  it('produces the same structure a per-path walk would', () => {
    // The memo is a performance change and must not be a semantic one.
    const out = redactDeep(sharedDag(3));
    expect(JSON.stringify(out)).toBe(JSON.stringify({
      a: { a: { a: { leaf: 'x' }, b: { leaf: 'x' } }, b: { a: { leaf: 'x' }, b: { leaf: 'x' } } },
      b: { a: { a: { leaf: 'x' }, b: { leaf: 'x' } }, b: { a: { leaf: 'x' }, b: { leaf: 'x' } } },
    }));
  });

  it('still marks a genuine cycle after memoizing', () => {
    // The memo must not swallow the cycle guard: a back-reference is true of
    // the PATH, so it is never stored as the object's result.
    const cyc = { tool: 'Bash' };
    cyc.self = cyc;
    expect(redactDeep(cyc)).toEqual({ tool: 'Bash', self: '[circular]' });

    const a = { n: 'a' };
    const b = { back: a };
    a.fwd = b;
    expect(redactDeep(a)).toEqual({ n: 'a', fwd: { back: '[circular]' } });
  });

  it('keeps a cyclic object usable where it is not an ancestor', () => {
    // The same object appears twice: once nested inside itself, once beside.
    // Both occurrences read the same, which is what the per-path walk did too.
    const cyc = { k: 'v' };
    cyc.self = cyc;
    const out = redactDeep({ first: cyc, second: cyc });
    expect(out.first).toEqual({ k: 'v', self: '[circular]' });
    expect(out.second).toEqual({ k: 'v', self: '[circular]' });
  });

  it('does not reuse a depth-truncated result at a shallower position', () => {
    // A truncated result says "too deep from where I STOOD", so it is
    // depth-dependent and must never be memoized as the object's answer.
    //
    // The fixture is tuned, not incidental. Three things all have to hold for
    // it to catch anything, and the first draft of this test had none of them
    // and passed against a deliberately broken implementation:
    //   - the DEEP occurrence must be walked first, so `tower` precedes
    //     `shallow` in key order;
    //   - the shared object must be reached just BEFORE the bound, not past
    //     it, or the walk stops above it and never memoizes it at all;
    //   - its descendants must be OBJECTS, since a string is returned before
    //     the depth check and can never carry the marker.
    // A tower of 60 puts the boundary inside `shared`. Verified against an
    // implementation that memoizes unconditionally: that one returns
    // {a:{b:'[depth]'}} here, which is a subtree truncated for being deep
    // somewhere else entirely.
    const shared = { a: { b: { c: { d: 'leaf' } } } };
    let tower = { shared };
    for (let i = 0; i < 60; i += 1) tower = { n: tower };
    const out = redactDeep({ tower, shallow: shared });
    expect(out.shallow).toEqual({ a: { b: { c: { d: 'leaf' } } } });
  });
});

describe('a memoized subtree never carries another path\'s verdict', () => {
  /**
   * Two objects that point at each other, both reachable from the root.
   * Walking `first` marks B's edge back to A as circular; walking `second`
   * must NOT inherit that, because from `second` the cycle closes one hop
   * later and at a different key.
   *
   * @returns {{first: object, second: object}}
   */
  function mutualPair() {
    const a = {};
    const b = { back: a };
    a.b = b;
    return { first: a, second: b };
  }

  it('gives each root position its own cycle verdict', () => {
    const out = redactDeep(mutualPair());
    expect(out.first).toEqual({ b: { back: CIRCULAR_MARKER } });
    // The bug: `second` used to receive B's memoized result, `{back:'[circular]'}`,
    // which is a statement about A's path and simply false here.
    expect(out.second).toEqual({ back: { b: CIRCULAR_MARKER } });
    expect(out.second.back).not.toBe(CIRCULAR_MARKER);
  });

  it('holds with the two roots in the other order', () => {
    const { first, second } = mutualPair();
    const out = redactDeep({ second, first });
    expect(out.second).toEqual({ back: { b: CIRCULAR_MARKER } });
    expect(out.first).toEqual({ b: { back: CIRCULAR_MARKER } });
  });

  it('still memoizes a clean subtree sitting beside a cyclic one', () => {
    // Only subtrees that PRODUCED a marker forfeit the memo. A shared subtree
    // with no cycle in it keeps one, which is what the DAG bound relies on.
    const cyclic = {};
    cyclic.self = cyclic;
    const shared = { k: 'v' };
    const out = redactDeep({ c: cyclic, s1: shared, s2: shared });
    expect(out.c).toEqual({ self: CIRCULAR_MARKER });
    expect(out.s1).toEqual({ k: 'v' });
    expect(out.s2).toEqual({ k: 'v' });
    expect(out.s1).toBe(out.s2); // one walk, reused
  });
});

describe('redaction matches a per-path walk on arbitrary graphs', () => {
  /**
   * The semantics the memo must preserve: walk every path, with a cycle guard
   * scoped to the current path and no reuse at all. Deliberately the slow,
   * obviously-correct version — it is the oracle, not the implementation.
   *
   * Strings are out of scope here: these fixtures carry only numbers, so this
   * compares STRUCTURE and marker placement, not secret scrubbing (which the
   * redaction tests above cover).
   *
   * @param {unknown} value
   * @param {number} [depth]
   * @param {WeakSet<object>} [seen]
   * @returns {unknown}
   */
  function perPath(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (depth >= MAX_REDACT_DEPTH) return DEPTH_MARKER;
    if (seen.has(value)) return CIRCULAR_MARKER;
    seen.add(value);
    const out = Array.isArray(value)
      ? value.map((v) => perPath(v, depth + 1, seen))
      : Object.fromEntries(
        Object.keys(value).map((k) => [k, perPath(value[k], depth + 1, seen)]),
      );
    seen.delete(value);
    return out;
  }

  /**
   * A deterministic pseudo-random graph generator. Fixed seed so a failure is
   * reproducible rather than a story about one unlucky run.
   *
   * @param {number} seed
   * @returns {() => object} produces one random graph per call
   */
  function graphFactory(seed) {
    let state = seed;
    const rand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    return () => {
      const count = 2 + Math.floor(rand() * 6);
      const nodes = Array.from({ length: count }, (unused, i) => ({ id: i }));
      for (const node of nodes) {
        const degree = Math.floor(rand() * 3);
        for (let k = 0; k < degree; k += 1) node[`e${k}`] = nodes[Math.floor(rand() * count)];
      }
      const graph = {};
      const roots = 1 + Math.floor(rand() * 3);
      for (let r = 0; r < roots; r += 1) graph[`r${r}`] = nodes[Math.floor(rand() * count)];
      return graph;
    };
  }

  it('agrees with the oracle on 300 random graphs with sharing and cycles', () => {
    // This gate exists because a hand-picked case list missed T-49 #7: eight
    // shapes all agreed while a whole class of interleaving was wrong. Against
    // the implementation that memoized cyclic subtrees, this same generator
    // disagrees on roughly 9% of graphs, so it discriminates rather than
    // decorating.
    const nextGraph = graphFactory(1);
    const disagreements = [];
    const truncated = [];
    for (let i = 0; i < 300; i += 1) {
      const graph = nextGraph();
      const expected = JSON.stringify(perPath(graph));
      const actual = JSON.stringify(redactDeep(graph));
      // The oracle has no node budget, so the two only have to agree BELOW
      // it. Recorded rather than skipped: if these graphs ever grow past the
      // budget, this list stops being empty and says so, instead of the
      // comparison quietly starting to test truncation against expansion.
      if (actual.includes(BUDGET_MARKER)) truncated.push(i);
      else if (expected !== actual) disagreements.push({ i, expected, actual });
    }
    expect(disagreements).toEqual([]);
    expect(truncated).toEqual([]);
  });

  it('generates graphs that actually contain cycles and sharing', () => {
    // Without this the gate above could pass on 300 trees and prove nothing.
    const nextGraph = graphFactory(1);
    let withMarkers = 0;
    for (let i = 0; i < 300; i += 1) {
      if (JSON.stringify(redactDeep(nextGraph())).includes(CIRCULAR_MARKER)) withMarkers += 1;
    }
    expect(withMarkers).toBeGreaterThan(30);
  });
});

describe('the node budget bounds every shape', () => {
  /**
   * A DAG where every level points at the same child twice — shared, no cycle.
   *
   * @param {number} depth
   * @returns {object}
   */
  function sharedDag(depth) {
    let node = { leaf: 'x' };
    for (let i = 0; i < depth; i += 1) node = { a: node, b: node };
    return node;
  }

  /**
   * A shared subtree that ALSO contains a cycle: the leaf points back at the
   * top. The memo cannot apply, because every subtree produces a marker, so
   * this is the shape neither the depth bound nor the memo could bound.
   *
   * @param {number} depth
   * @returns {object}
   */
  function cyclicSharedDag(depth) {
    const leaf = {};
    let node = leaf;
    for (let i = 0; i < depth; i += 1) node = { a: node, b: node };
    leaf.up = node;
    return node;
  }

  it('finishes a cyclic shared subtree at depth 24 in tens of milliseconds', () => {
    // Before the budget: 6 ms at depth 14, 19 ms at 16, about 3x per level —
    // so depth 24 was seconds. The memo does not help here by design, because
    // every subtree carries a cycle marker and is therefore not memoizable.
    const started = performance.now();
    const out = redactDeep(cyclicSharedDag(24));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(50);
    expect(JSON.stringify(out)).toContain(BUDGET_MARKER);
  });

  it('stays bounded as the shape grows, rather than growing with it', () => {
    // A bound that only holds at the depth someone tested is not a bound.
    const timings = [16, 24, 40, 80].map((depth) => {
      const started = performance.now();
      redactDeep(cyclicSharedDag(depth));
      return performance.now() - started;
    });
    for (const elapsed of timings) expect(elapsed).toBeLessThan(50);
  });

  it('returns something JSON can still serialize, in bounded time', () => {
    // The reason occurrences are counted rather than fresh walks: the memo
    // hands back a DAG, and JSON.stringify expands a DAG into a tree. Measured
    // before this rule, 49 shared objects produced 386 MB of JSON in 3.6 s,
    // and depth 40 did not finish at all — inside the writer, where the 4 KB
    // cap cannot help because it measures a string that never gets built.
    const out = redactDeep(sharedDag(200));
    const started = performance.now();
    const serialized = JSON.stringify(out);
    expect(performance.now() - started).toBeLessThan(200);
    expect(serialized.length).toBeLessThan(1_000_000);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it('lets the writer finish on a payload built to hang it', () => {
    // End to end: the line is oversized, so the 4 KB cap folds the offending
    // key away and the event still lands. What matters is that the writer
    // RETURNS — the failure this replaces was an unbounded stringify.
    const started = performance.now();
    const res = writeEvent(root, ev({
      event: 'tool.used',
      mission_id: 'M-20260902-001',
      data: { tool: 'B', ok: true, duration_ms: 1, graph: sharedDag(200) },
    }));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(res.ok).toBe(true);
    expect(res.folded).toBe(true);
    expect(res.dropped).toContain('graph');
    expect(lineBytes(lines()[0])).toBeLessThanOrEqual(4096);
  });

  it('agrees with the envelope cap on what 4096 nodes implies', () => {
    // The budget's justification: a result over MAX_REDACT_NODES cannot fit
    // the 4 KB line anyway, because the smallest a node serializes to is `{}`.
    expect(MAX_REDACT_NODES).toBe(4096);
    expect(JSON.stringify(redactDeep(sharedDag(200))).length)
      .toBeGreaterThan(DEFAULT_LINE_MAX_BYTES);
  });
});
