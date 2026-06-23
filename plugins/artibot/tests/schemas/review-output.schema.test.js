/**
 * review-output.schema.json — structural + conditional-required contract tests.
 *
 * Guards the review-discipline hardening:
 *  (a) the duplicate `description` key was removed and the richer one survives,
 *  (b) a critical/high finding without `suggestion` is schema-INVALID,
 *  (c) a medium/low/info finding without `suggestion` stays schema-VALID
 *      (non-breaking for existing consumers).
 *
 * Pure file-read structural assertions (no runtime deps, matching the plugin's
 * zero-dependency policy). The if/then behaviour is additionally verified with
 * ajv ONLY when it is resolvable as a transitive dependency — that block is
 * skipped (never failed) when ajv is absent, so the suite never depends on a
 * package that is not declared in package.json.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ajv is a transitive dependency (not declared in package.json), so import it
// defensively at module scope: the ajv behaviour block is skipped — never
// failed — when ajv cannot be resolved, keeping the suite zero-dep-safe.
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

describe('review-output.schema.json — ajv conditional behaviour (skipped if ajv absent)', () => {
  const maybeIt = Ajv ? it : it.skip;

  const base = { verdict: 'fail', next_steps: ['fix it'] };
  const mk = (finding) => ({ ...base, findings: [finding] });

  async function compile() {
    const { schema } = await loadSchema();
    // ajv v6's bundled default meta-schema does not register the draft-07 $id
    // URI; drop $schema to avoid a meta-ref lookup miss. The if/then semantics
    // under test are draft-07 native and unaffected.
    const clone = JSON.parse(JSON.stringify(schema));
    delete clone.$schema;
    const ajv = new Ajv({ allErrors: true });
    return ajv.compile(clone);
  }

  maybeIt('rejects a critical finding with no suggestion', async () => {
    const validate = await compile();
    const ok = validate(
      mk({ severity: 'critical', file: 'a.ts', description: 'sqli' }),
    );
    expect(ok).toBe(false);
  });

  maybeIt('accepts a critical finding that carries a suggestion', async () => {
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

  maybeIt('rejects a high finding with no suggestion', async () => {
    const validate = await compile();
    const ok = validate(
      mk({ severity: 'high', file: 'a.ts', description: 'xss' }),
    );
    expect(ok).toBe(false);
  });

  maybeIt('accepts medium/low/info findings with no suggestion', async () => {
    const validate = await compile();
    for (const severity of ['medium', 'low', 'info']) {
      const ok = validate(
        mk({ severity, file: 'a.ts', description: 'minor issue' }),
      );
      expect(ok, `${severity} without suggestion should be valid`).toBe(true);
    }
  });
});
