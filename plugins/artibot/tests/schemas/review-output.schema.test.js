/**
 * review-output.schema.json — structural + conditional-required contract tests.
 *
 * Guards the review-discipline hardening:
 *  (a) the duplicate `description` key was removed and the richer one survives,
 *  (b) a critical/high finding without `suggestion` is schema-INVALID,
 *  (c) a medium/low/info finding without `suggestion` stays schema-VALID
 *      (non-breaking for existing consumers).
 *
 * Two layers. Structural assertions are pure file reads (no runtime deps,
 * matching the plugin's zero-dependency policy). The if/then behaviour — the
 * whole point of (b) and (c) — can only be shown by a real validator, so the
 * ajv layer runs UNCONDITIONALLY. THE ORACLE IS REQUIRED, NOT OPTIONAL: an
 * earlier revision guarded it with `Ajv ? it : it.skip`, and a run that
 * measured no conditional-required behaviour at all reported the same green as
 * a run that measured all of it. It now goes RED, and a missing oracle
 * surfaces as {@link AJV_MISSING}. Pattern adopted from
 * tests/schemas/receipts.test.js (T-16).
 *
 * WHAT THIS FILE CANNOT SEE (write it next to the gate, per repo rule):
 *  - WHICH ajv enforces layer 2. ajv reaches this file only as a TRANSITIVE
 *    dependency (eslint -> ajv; package.json declares no `ajv`, package-lock
 *    pins 6.15.0 while the installed tree resolves 6.12.6, both measured
 *    2026-09-03), so an eslint bump can remove the oracle with nothing else
 *    changing. The fix then is to DECLARE ajv as a devDependency, never to
 *    restore the skip.
 *  - Whether any reviewer actually emits documents against this schema. A green
 *    run says the contract is satisfiable, not that it is satisfied at runtime.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Imported defensively at module scope only so that a missing ajv produces the
// explicit AJV_MISSING failure below instead of an unresolved-import crash
// whose message says nothing about what to do. Absence is still a FAILURE.
let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../schemas/review-output.schema.json',
);

async function loadSchema() {
  const raw = await readFile(SCHEMA_PATH, 'utf-8');
  return { raw, schema: JSON.parse(raw) };
}

describe('review-output.schema.json — structure', () => {
  it('is valid JSON', async () => {
    const { schema } = await loadSchema();
    expect(typeof schema).toBe('object');
    expect(schema).not.toBeNull();
  });

  it('has exactly one top-level description (no duplicate key)', async () => {
    const { raw } = await loadSchema();
    // The bug was two `"description":` keys at the top level; JSON.parse silently
    // keeps the last, so we count raw occurrences at depth 1 instead.
    const topLevelDescriptions = raw
      .split('\n')
      .filter((line) => /^\s{2}"description":/.test(line));
    expect(topLevelDescriptions).toHaveLength(1);
  });

  it('keeps the richer description mentioning the verdict tiers', async () => {
    const { schema } = await loadSchema();
    expect(schema.description).toContain('Critical/Important/Suggestion tiers');
  });

  it('keeps findings base required as severity/file/description', async () => {
    const { schema } = await loadSchema();
    expect(schema.properties.findings.items.required).toEqual([
      'severity',
      'file',
      'description',
    ]);
  });

  it('conditionally requires suggestion for critical/high severity', async () => {
    const { schema } = await loadSchema();
    const allOf = schema.properties.findings.items.allOf;
    expect(Array.isArray(allOf)).toBe(true);
    const rule = allOf.find(
      (r) => r.then && Array.isArray(r.then.required) && r.then.required.includes('suggestion'),
    );
    expect(rule).toBeTruthy();
    expect(rule.if.properties.severity.enum).toEqual(['critical', 'high']);
    // `if` must also require severity so a finding missing severity does not
    // vacuously satisfy the conditional (json-schema if/then pitfall).
    expect(rule.if.required).toEqual(['severity']);
  });

  it('leaves suggestion optional at the base property level', async () => {
    const { schema } = await loadSchema();
    const props = schema.properties.findings.items.properties;
    expect(props.suggestion).toBeTruthy();
    // base `required` must NOT list suggestion (only conditionally required)
    expect(schema.properties.findings.items.required).not.toContain('suggestion');
  });
});

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to DECLARE the dependency, and
 * the wrong one — restoring the skip — is the one that looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so schemas/review-output.schema.json cannot be enforced and this gate',
  'proves nothing. ajv is only a TRANSITIVE dependency here (eslint -> ajv);',
  "package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

describe('review-output.schema.json — ajv conditional behaviour (red, never skipped, without ajv)', () => {
  const base = { verdict: 'fail', next_steps: ['fix it'] };
  const mk = (finding) => ({ ...base, findings: [finding] });

  // Throws rather than returning null: a null validator would turn every
  // assertion below into "validate is not a function", which buries the real
  // cause. Throwing makes each test fail with the fix instruction instead.
  async function compile() {
    if (Ajv === null) throw new Error(AJV_MISSING);
    const { schema } = await loadSchema();
    // ajv v6's bundled default meta-schema does not register the draft-07 $id
    // URI; drop $schema to avoid a meta-ref lookup miss. The if/then semantics
    // under test are draft-07 native and unaffected.
    const clone = JSON.parse(JSON.stringify(schema));
    delete clone.$schema;
    const ajv = new Ajv({ allErrors: true });
    return ajv.compile(clone);
  }

  it('rejects a critical finding with no suggestion', async () => {
    const validate = await compile();
    const ok = validate(
      mk({ severity: 'critical', file: 'a.ts', description: 'sqli' }),
    );
    expect(ok).toBe(false);
  });

  it('accepts a critical finding that carries a suggestion', async () => {
    const validate = await compile();
    const ok = validate(
      mk({
        severity: 'critical',
        file: 'a.ts',
        description: 'sqli',
        suggestion: 'use parameterized query',
      }),
    );
    expect(ok).toBe(true);
  });

  it('rejects a high finding with no suggestion', async () => {
    const validate = await compile();
    const ok = validate(
      mk({ severity: 'high', file: 'a.ts', description: 'xss' }),
    );
    expect(ok).toBe(false);
  });

  it('accepts medium/low/info findings with no suggestion', async () => {
    const validate = await compile();
    for (const severity of ['medium', 'low', 'info']) {
      const ok = validate(
        mk({ severity, file: 'a.ts', description: 'minor issue' }),
      );
      expect(ok, `${severity} without suggestion should be valid`).toBe(true);
    }
  });

  it('has a real oracle — present, and able to say NO as well as YES', async () => {
    // The assertion IS the fail-closed statement: when ajv is gone this block
    // goes red and prints the fix, instead of the suite quietly running four
    // fewer assertions. The compared value carries the guidance so the failure
    // diff is the instruction.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');

    // A validator that accepts everything would satisfy every `toBe(true)`
    // above, and one that rejects everything would satisfy every `toBe(false)`.
    // Demanding both directions is what makes either worth reading.
    const validate = await compile();
    expect(
      validate(mk({
        severity: 'critical',
        file: 'a.ts',
        description: 'sqli',
        suggestion: 'parameterize',
      })),
    ).toBe(true);
    expect(validate({ ...base, verdict: 'not-a-verdict', findings: [] })).toBe(false);
  });
});
