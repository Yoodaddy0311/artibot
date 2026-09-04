/**
 * Drift gate — the tables embedded in `lib/review/independent-reviewer.js` must
 * equal the schema files they mirror.
 *
 * ── Why a mirror exists at all ─────────────────────────────────────────────
 * `lib/review/independent-reviewer.js` is an L2 module that performs no I/O, so
 * it cannot read `schemas/*.json` at run time, and this package declares zero
 * runtime dependencies, so it cannot `import ... with { type: 'json' }` behind a
 * bundler either. The tables are therefore embedded — and a second copy that
 * nobody compares is exactly the shape of rot this repo has been bitten by
 * before. This file is the comparison. The JSON files stay the originals; the
 * embedded tables are the copies, and the copies lose.
 *
 * ── What this gate does NOT see ────────────────────────────────────────────
 *  1. It does not check that the SCHEMA is right, only that the code agrees
 *     with it. Both being wrong together is still green here.
 *  2. It compares the fields the module actually mirrors: the v2 `required`
 *     array, the verdict enum, the `mission_id` pattern, and the adapter rows.
 *     Everything else in either file (evidence `kind` conditionals, finding
 *     severities, `additionalProperties`) is out of scope and is why
 *     `parseReviewVerdict` takes a `validateSchema` port.
 *  3. It does not run ESLint, vitest, or the module against a real mission
 *     folder.
 *  4. `verdict-adapter-map.json#sources[].cited_line` is not verified here —
 *     those line numbers point into concurrently-edited agent files.
 *
 * The `gate self-verification` block at the end feeds deliberately corrupted
 * inputs to the SAME comparison helpers, so a comparison that silently stopped
 * comparing shows up as red rather than as a green tautology.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ADAPTER_ROWS,
  CANONICAL_VERDICTS,
  CLAIM_NATURES,
  MISSION_ID_PATTERN,
  V2_REQUIRED_FIELDS,
} from '../../lib/review/independent-reviewer.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {string} rel path relative to the plugin root
 * @returns {object} parsed JSON
 */
function loadJson(rel) {
  return JSON.parse(readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8'));
}

const reviewSchema = loadJson('schemas/review-output.schema.json');
const adapterMap = loadJson('schemas/verdict-adapter-map.json');
const ledgerAllowlist = loadJson('schemas/ledger-events.allowlist.json');
const v2 = reviewSchema.definitions.reviewOutputV2;

/**
 * Normalize an adapter row to the fields the module mirrors, so the comparison
 * is order-independent and ignores prose-only columns (`note`).
 *
 * Extracted as a helper because the self-verification block below feeds it
 * mutated input; asserting inline would make that check a tautology.
 *
 * @param {Array<object>} rows adapter rows from either side
 * @returns {string[]} sorted comparable keys
 */
export function comparableRows(rows) {
  return rows
    .map((r) => JSON.stringify({
      source: r.source,
      token: r.token,
      verdict: r.verdict ?? null,
      ambiguous: r.ambiguous === true,
      candidates: [...(r.candidates ?? [])].sort(),
    }))
    .sort();
}

describe('review-output.schema.json#definitions.reviewOutputV2 mirror', () => {
  it('the v2 definition exists and is the one the module targets', () => {
    expect(v2).toBeTruthy();
    expect(v2.properties.schema_version.const).toBe(2);
  });

  it('V2_REQUIRED_FIELDS equals the schema required array, in order', () => {
    expect([...V2_REQUIRED_FIELDS]).toEqual(v2.required);
  });

  it('the required list is the 13 fields the six mandatory references imply', () => {
    // Denominator guard: if the schema ever shrinks, the module must not keep
    // enforcing a stale longer list, and vice versa.
    expect(v2.required).toHaveLength(13);
    for (const ref of [
      'mission_id', 'intent_revision', 'plan_revision',
      'diff_ref', 'test_evidence', 'regression_evidence',
    ]) {
      expect(v2.required).toContain(ref);
    }
  });

  it('CANONICAL_VERDICTS equals the schema verdict enum, in order', () => {
    expect([...CANONICAL_VERDICTS]).toEqual(v2.properties.verdict.enum);
    expect(v2.properties.verdict.enum).toHaveLength(5);
  });

  it('MISSION_ID_PATTERN equals the schema mission_id pattern', () => {
    expect(MISSION_ID_PATTERN.source).toBe(v2.properties.mission_id.pattern);
  });

  it('the arrays the module treats as minItems:1 really are minItems:1', () => {
    for (const field of ['evidence', 'test_evidence', 'regression_evidence']) {
      expect(v2.properties[field].minItems).toBe(1);
    }
  });
});

describe('verdict-adapter-map.json mirror', () => {
  it('ADAPTER_ROWS equals the map rows', () => {
    expect(comparableRows([...ADAPTER_ROWS])).toEqual(comparableRows(adapterMap.rows));
  });

  it('the row count matches the measured 15', () => {
    expect(adapterMap.rows).toHaveLength(15);
    expect(ADAPTER_ROWS).toHaveLength(15);
  });

  it('target_verdicts equals the canonical five', () => {
    expect(adapterMap.target_verdicts).toEqual([...CANONICAL_VERDICTS]);
  });

  it('SPEC_FAIL is the only ambiguous row, with two candidates', () => {
    const ambiguous = ADAPTER_ROWS.filter((r) => r.ambiguous);
    expect(ambiguous.map((r) => r.token)).toEqual(['SPEC_FAIL']);
    expect(ambiguous[0].candidates).toHaveLength(2);
    expect(adapterMap.rules.ambiguous_token).toBe('escalate_to_human');
  });

  it('an unmapped token is rejected by policy, not downgraded', () => {
    expect(adapterMap.rules.unmapped_token).toBe('reject');
  });

  it('no token spells two different verdicts across sources', () => {
    const byToken = new Map();
    for (const row of ADAPTER_ROWS) {
      const key = row.token.toLowerCase();
      if (!byToken.has(key)) byToken.set(key, new Set());
      byToken.get(key).add(row.ambiguous ? 'AMBIGUOUS' : row.verdict);
    }
    for (const [token, verdicts] of byToken) {
      expect(`${token}:${verdicts.size}`).toBe(`${token}:1`);
    }
  });

  it('every non-ambiguous row targets one of the canonical five', () => {
    for (const row of ADAPTER_ROWS) {
      if (row.ambiguous) continue;
      expect(CANONICAL_VERDICTS).toContain(row.verdict);
    }
  });
});

describe('ledger-events.allowlist.json#enums.claim_nature mirror', () => {
  it('CLAIM_NATURES equals the allowlist enum, in order', () => {
    expect([...CLAIM_NATURES]).toEqual(ledgerAllowlist.enums.claim_nature);
  });

  it('the enum is the two values 부록 0-2 후속(3) MP-1 fixed', () => {
    // Denominator guard: an enum that silently grew a third value would make
    // the equality above pass while the stratification changed underneath it.
    expect(ledgerAllowlist.enums.claim_nature).toHaveLength(2);
    expect(CLAIM_NATURES).toHaveLength(2);
  });

  it('the enum carries a stated source, like every other enum in the file', () => {
    expect(typeof ledgerAllowlist.enum_sources.claim_nature).toBe('string');
    expect(ledgerAllowlist.enum_sources.claim_nature.length).toBeGreaterThan(20);
  });

  it('review.claim_audit is registered and points at that enum', () => {
    const spec = ledgerAllowlist.events['review.claim_audit'];
    expect(spec).toBeDefined();
    expect(spec.required).toEqual([
      'subject_agent_type', 'claims_total', 'claims_refuted',
    ]);
    expect(spec.fields.nature.enum_ref).toBe('claim_nature');
  });

  it('the event does not require the two fields that may legitimately be absent', () => {
    // `nature` is dropped from the denominator when untagged (설계 §4.4 #4) and
    // `subject_model` cannot be filled before the L2 D1 bind. Requiring either
    // would make the writer refuse every line the Observe phase can produce.
    const spec = ledgerAllowlist.events['review.claim_audit'];
    expect(spec.required).not.toContain('nature');
    expect(spec.required).not.toContain('subject_model');
  });
});

describe('gate self-verification — the comparison actually compares', () => {
  it('a dropped row makes the adapter comparison red', () => {
    const missing = [...ADAPTER_ROWS].slice(0, -1);
    expect(comparableRows(missing)).not.toEqual(comparableRows(adapterMap.rows));
  });

  it('a changed verdict makes the adapter comparison red', () => {
    const flipped = [...ADAPTER_ROWS].map((r, i) => (i === 0 ? { ...r, verdict: 'BLOCK' } : r));
    expect(comparableRows(flipped)).not.toEqual(comparableRows(adapterMap.rows));
  });

  it('a row that loses its ambiguity makes the comparison red', () => {
    const resolved = [...ADAPTER_ROWS].map((r) => (
      r.ambiguous ? { ...r, ambiguous: false, verdict: 'REPAIR_REQUIRED', candidates: [] } : r
    ));
    expect(comparableRows(resolved)).not.toEqual(comparableRows(adapterMap.rows));
  });

  it('a dropped required field makes the required comparison red', () => {
    expect([...V2_REQUIRED_FIELDS].filter((f) => f !== 'verification_id')).not.toEqual(v2.required);
  });

  it('a reordered claim_nature makes the enum comparison red', () => {
    // The mirror above compares IN ORDER. Feeding the same comparison a
    // permuted copy proves the order is really part of what is checked, so a
    // future `toEqual` on sorted arrays cannot quietly weaken it.
    expect([...CLAIM_NATURES].reverse()).not.toEqual(ledgerAllowlist.enums.claim_nature);
  });

  it('an added claim_nature makes the enum comparison red', () => {
    expect([...CLAIM_NATURES, 'explore']).not.toEqual(ledgerAllowlist.enums.claim_nature);
  });
});
