/**
 * lib/mission/contract.js — vocabulary parity with the schema, the structural
 * fallback validator, and the two fidelity checks.
 *
 * WHAT THESE TESTS CANNOT SEE
 * ---------------------------
 *  - They do not prove the structural checker agrees with a real draft-07
 *    validator on inputs not written here. `tests/schemas/mission-contract.test.js`
 *    owns schema conformance; this file owns the module's own behaviour.
 *  - Vocabulary parity is checked against the schema FILE. If the schema and the
 *    ledger/review schemas ever diverge from each other, that is invisible here.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AUTONOMY_MODES,
  checkIntentFidelity,
  FINDING_CLASSES,
  MISSION_CONTRACT_FIELDS,
  MISSION_ID_PATTERN,
  MISSION_STATUS,
  PERFORMANCE_PRIORITIES,
  PLANNING_MODES,
  REDUCED_ALLOWED_FIELDS,
  REQUIRED_FIELDS_FULL,
  tokenizeForFidelity,
  TOPOLOGY_MODES,
  validateMissionContract,
  verifyExplicitRequestSpans,
} from '../../lib/mission/contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../schemas/mission-contract.schema.json');

const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));

/** A minimal contract that satisfies the full schema's `required`. */
function validContract(overrides = {}) {
  return {
    goal: 'split 을 업그레이드',
    explicit_requests: [
      { text: 'split 을 업그레이드', span: { start: 0, end: 13 } },
    ],
    success: { functional: [], behavioral: [], regression: [], evidence: [] },
    scope: { requested_target: ['split'] },
    ...overrides,
  };
}

describe('vocabulary parity with schemas/mission-contract.schema.json', () => {
  it('exports exactly the schema top-level property names, in schema order', () => {
    expect(MISSION_CONTRACT_FIELDS).toEqual(Object.keys(schema.properties));
  });

  it('exports the schema required list', () => {
    expect(REQUIRED_FIELDS_FULL).toEqual(schema.required);
  });

  it('mirrors every enum the schema declares', () => {
    expect(MISSION_STATUS).toEqual(schema.properties.status.enum);
    expect(AUTONOMY_MODES).toEqual(schema.properties.autonomy.properties.mode.enum);
    expect(PERFORMANCE_PRIORITIES)
      .toEqual(schema.properties.performance.properties.priority.enum);
    expect(PLANNING_MODES).toEqual(schema.properties.planning.properties.mode.enum);
    expect(TOPOLOGY_MODES).toEqual(schema.properties.topology.properties.mode.enum);
    expect(FINDING_CLASSES).toEqual(Object.keys(schema.properties.findings.properties));
  });

  it('mission_id pattern is byte-identical to the schema pattern', () => {
    expect(MISSION_ID_PATTERN.source).toBe(schema.properties.mission_id.pattern);
  });

  it('accepts both issued and session-fallback ids, and every schema example', () => {
    expect(MISSION_ID_PATTERN.test('M-20260902-001')).toBe(true);
    expect(MISSION_ID_PATTERN.test('M-20260902-Styc5j4aa')).toBe(true);
    for (const example of schema.properties.mission_id.examples) {
      expect(MISSION_ID_PATTERN.test(example)).toBe(true);
    }
    expect(MISSION_ID_PATTERN.test('M-20260902-01')).toBe(false);
    expect(MISSION_ID_PATTERN.test('M-2026902-001')).toBe(false);
    expect(MISSION_ID_PATTERN.test('M-20260902-Sabc')).toBe(false);
  });
});

describe('validateMissionContract() — full mode', () => {
  it('accepts a minimal valid contract', () => {
    const result = validateMissionContract(validContract());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checkedBy).toBe('structural');
    expect(result.mode).toBe('full');
  });

  it('rejects a missing required field', () => {
    const c = validContract();
    delete c.scope;
    const result = validateMissionContract(c);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.path)).toContain('scope');
  });

  it('rejects an EMPTY scope.requested_target — the context-substitution guard', () => {
    const result = validateMissionContract(
      validContract({ scope: { requested_target: [] } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'scope.requested_target')).toBe(true);
  });

  it('rejects an empty explicit_requests array', () => {
    const result = validateMissionContract(validContract({ explicit_requests: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'explicit_requests')).toBe(true);
  });

  it('rejects an explicit request without a span', () => {
    const result = validateMissionContract(validContract({
      explicit_requests: [{ text: 'split 을 업그레이드' }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'explicit_requests[0].span')).toBe(true);
  });

  it('rejects unknown top-level properties (additionalProperties: false)', () => {
    const result = validateMissionContract(validContract({ surprise: 1 }));
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/unknown top-level/);
  });

  it('rejects out-of-vocabulary enum values', () => {
    expect(validateMissionContract(validContract({ status: 'done' })).valid).toBe(false);
    expect(validateMissionContract(validContract({ planning: { mode: 'yolo' } })).valid)
      .toBe(false);
    expect(validateMissionContract(validContract({ autonomy: { mode: 'auto' } })).valid)
      .toBe(false);
  });

  it('rejects a malformed mission_id and accepts a well-formed one', () => {
    expect(validateMissionContract(validContract({ mission_id: 'M-2026-1' })).valid)
      .toBe(false);
    expect(validateMissionContract(validContract({ mission_id: 'M-20260902-007' })).valid)
      .toBe(true);
  });

  it('reports execution_profile as UNCHECKED rather than valid', () => {
    const result = validateMissionContract(validContract({
      execution_profile: { anything: 'at all' },
    }));
    expect(result.valid).toBe(true);
    expect(result.unchecked.map((u) => u.path)).toContain('execution_profile');
  });

  it('warns, but does not error, on an inverted span (the schema permits it)', () => {
    const result = validateMissionContract(validContract({
      explicit_requests: [{ text: 'x', span: { start: 9, end: 2 } }],
    }));
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBe(1);
  });

  it('rejects a non-object contract', () => {
    expect(validateMissionContract(null).valid).toBe(false);
    expect(validateMissionContract([]).valid).toBe(false);
  });
});

describe('validateMissionContract() — injected validator port', () => {
  it('delegates in full mode and reports checkedBy: schema-port', () => {
    const result = validateMissionContract(validContract(), {
      validate: () => ({ valid: false, errors: [{ path: 'goal', message: 'port says no' }] }),
    });
    expect(result.checkedBy).toBe('schema-port');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toBe('port says no');
  });

  it('SKIPS the port in reduced mode and says so in unchecked', () => {
    const result = validateMissionContract(
      { goal: 'g', explicit_requests: [{ text: 'g', span: { start: 0, end: 1 } }] },
      { mode: 'reduced', validate: () => ({ valid: false, errors: [{ path: '', message: 'x' }] }) },
    );
    expect(result.checkedBy).toBe('structural');
    expect(result.valid).toBe(true);
    expect(result.unchecked[0].reason).toMatch(/skipped/);
  });

  it('throws on an unknown mode (fail-closed)', () => {
    expect(() => validateMissionContract(validContract(), { mode: 'partial' }))
      .toThrow(TypeError);
  });
});

describe('validateMissionContract() — reduced (system1) mode', () => {
  const reduced = {
    goal: 'split 을 업그레이드',
    explicit_requests: [{ text: 'split 을 업그레이드', span: { start: 0, end: 13 } }],
    intent_confidence: { goal: 0.9, product_decision_required: false },
  };

  it('accepts a reduced contract that carries no success or scope', () => {
    const result = validateMissionContract(reduced, { mode: 'reduced' });
    expect(result.valid).toBe(true);
    expect(result.mode).toBe('reduced');
  });

  it('the same reduced contract FAILS full validation', () => {
    const result = validateMissionContract(reduced, { mode: 'full' });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['success', 'scope']),
    );
  });

  it('rejects a field outside the reduced allowlist', () => {
    const result = validateMissionContract(
      { ...reduced, scope: { requested_target: ['split'] } },
      { mode: 'reduced' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/reduced contract may only carry/);
  });

  it('still enforces explicit_requests shape', () => {
    const result = validateMissionContract(
      { goal: 'g', explicit_requests: [] },
      { mode: 'reduced' },
    );
    expect(result.valid).toBe(false);
  });

  it('the reduced allowlist is exactly the design triple plus the two meta fields', () => {
    expect([...REDUCED_ALLOWED_FIELDS].sort()).toEqual(
      ['explicit_requests', 'goal', 'intent_confidence', 'mission_id', 'schema_version'],
    );
  });
});

describe('checkIntentFidelity()', () => {
  it('passes when the requested target covers the explicit request', () => {
    const result = checkIntentFidelity(validContract());
    expect(result.ok).toBe(true);
    expect(result.matched[0].coveredBy).toBe('split');
  });

  it('FAILS when the target is swapped for a "root cause" — the substitution RED', () => {
    const swapped = validContract({
      scope: { requested_target: ['lib/context/rehydration.js'], upstream: ['lib/context/'] },
    });
    const result = checkIntentFidelity(swapped);
    expect(result.ok).toBe(false);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0].text).toBe('split 을 업그레이드');
  });

  it('counts scope.direct and scope.upstream as covering', () => {
    const c = validContract({
      scope: { requested_target: ['unrelated-thing'], upstream: ['plugins/artibot/commands/split.md'] },
    });
    expect(checkIntentFidelity(c).ok).toBe(true);
  });

  it('is not ok for a contract with no explicit requests at all', () => {
    expect(checkIntentFidelity({ explicit_requests: [], scope: {} }).ok).toBe(false);
  });

  it('tokenizer drops Korean particles so "split 을" matches "split"', () => {
    expect(tokenizeForFidelity('split 을 업그레이드')).toEqual(['split', '업그레이드']);
  });
});

describe('verifyExplicitRequestSpans()', () => {
  const original = 'split 을 업그레이드해줘';

  it('passes when every span slices back to its own text', () => {
    const c = validContract({
      explicit_requests: [{ text: 'split 을 업그레이드', span: { start: 0, end: 13 } }],
    });
    expect(verifyExplicitRequestSpans(c, original).ok).toBe(true);
  });

  it('FAILS when the text was summarized away from its span', () => {
    const c = validContract({
      explicit_requests: [{ text: 'upgrade the splitter', span: { start: 0, end: 13 } }],
    });
    const result = verifyExplicitRequestSpans(c, original);
    expect(result.ok).toBe(false);
    expect(result.mismatches[0].actual).toBe('split 을 업그레이드');
  });

  it('FAILS on a non-integer span', () => {
    const c = validContract({
      explicit_requests: [{ text: 'x', span: { start: null, end: 3 } }],
    });
    expect(verifyExplicitRequestSpans(c, original).ok).toBe(false);
  });
});
