/**
 * execution-profile.schema.json — allowed-value and subset contract tests.
 *
 * Guards the three claims T-18 makes about the schema:
 *  (a) the ADDENDUM section-2 eight-key profile validates verbatim,
 *  (b) an unknown `performance` value (and an unknown `performance` sub-key)
 *      is schema-INVALID — the enum is fail-closed, not advisory,
 *  (c) the v1.1 three-key subset {planning, performance, topology} validates,
 *      so adopting the eight-key form does not break existing intent.md files.
 *
 * Every enum here is transcribed from a design document. The per-value source
 * table lives in schemas/execution-profile.README.md; the assertions below are
 * the drift gate for it — changing an enum without changing the README and this
 * file turns the test red.
 *
 * Two layers on purpose. The structural layer reads the schema as TEXT and so
 * needs no runtime dependency; the ajv layer proves real validator behaviour,
 * which a file read cannot show. THE ORACLE IS REQUIRED, NOT OPTIONAL: an
 * earlier revision guarded the ajv layer with `describe.skip`, so a run with
 * no validator behaviour measured at all reported the same green as a full one.
 * It now goes RED instead — every ajv test runs unconditionally and a missing
 * oracle surfaces as {@link AJV_MISSING}. Pattern adopted from
 * tests/schemas/receipts.test.js (T-16).
 *
 * WHAT THIS FILE CANNOT SEE (write it next to the gate, per repo rule):
 *  - WHICH ajv enforces the behaviour layer. ajv reaches this file only as a
 *    TRANSITIVE dependency (eslint -> ajv; package.json declares no `ajv`,
 *    package-lock pins 6.15.0 while the installed tree resolves 6.12.6, both
 *    measured 2026-09-03), so an eslint bump can remove the oracle with nothing
 *    else changing. These assertions were written against a draft-07-only 6.x;
 *    a future ajv 8 would read `$defs` and `format` differently. The fix when
 *    that happens is to DECLARE ajv as a devDependency, never to skip.
 *  - Whether any producer actually emits one of these profiles. The examples
 *    are transcribed from design documents, so a green run says the contract is
 *    SATISFIABLE, not that anything satisfies it at runtime.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../schemas/execution-profile.schema.json',
);
const SCHEMA_ID = 'https://artibot.dev/schemas/execution-profile.schema.json';

async function loadSchema() {
  const raw = await readFile(SCHEMA_PATH, 'utf-8');
  return { raw, schema: JSON.parse(raw) };
}

/** ADDENDUM-HARDENING.md:117-143 verbatim, plus section-20 version fields (:709-712). */
const ADDENDUM_EIGHT_KEY_PROFILE = Object.freeze({
  version: 1,
  derived_from: { intent_revision: 3 },
  reasoning: { depth: 'deep' },
  autonomy: { level: 'full' },
  performance: { priority: 'speed_accuracy', budget: 'generous' },
  parallelism: { strategy: 'aggressive' },
  planning: { mode: 'ultraplan' },
  context: { strategy: 'sufficient' },
  review: { independent: true, strictness: 'high', model: 'fable-5.1' },
  completion: { verified_outcome_required: true },
});

/** package-v1.1/04_INTENT_MD_SPEC.md:33-36 verbatim. */
const V11_THREE_KEY_PROFILE = Object.freeze({
  planning: { mode: 'ultraplan' },
  performance: { priority: 'maximum' },
  topology: 'split',
});

/** The eight keys F2 adopted — ARTIBOT-5.0-DESIGN.md §7.2 Addendum §2 스키마. */
const EIGHT_KEYS = [
  'reasoning',
  'autonomy',
  'performance',
  'parallelism',
  'planning',
  'context',
  'review',
  'completion',
];

const EXPECTED_ENUMS = {
  'reasoning.depth': ['direct', 'plan', 'deep-plan', 'deep', 'ultraplan'],
  'performance.priority': [
    'balanced',
    'maximum',
    'split',
    'economy',
    'quality',
    'fast',
    'maximum_performance',
    'speed_accuracy',
  ],
  'performance.budget': ['generous'],
  'parallelism.strategy': ['auto', 'aggressive', 'net_gain'],
  'planning.mode': ['auto', 'direct', 'plan', 'ultraplan'],
  'context.strategy': ['minimal_sufficient', 'sufficient'],
  'review.strictness': ['high'],
};

const AUTONOMY_VALUES = ['guided', 'agent_led', 'autonomous', 'full', 'auto'];

const TOPOLOGY_VALUES = [
  'auto',
  'solo',
  'subagent',
  'team',
  'autopilot',
  'autopilot_fast',
  'split',
];

function enumAt(schema, dotted) {
  const [group, leaf] = dotted.split('.');
  return schema.properties[group].properties[leaf].enum;
}

describe('execution-profile.schema.json — structure', () => {
  it('is valid JSON and declares draft-07 (ajv 6 cannot compile 2020-12)', async () => {
    const { schema } = await loadSchema();
    expect(typeof schema).toBe('object');
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$id).toBe(SCHEMA_ID);
  });

  it('declares all eight F2 keys', async () => {
    const { schema } = await loadSchema();
    for (const key of EIGHT_KEYS) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
  });

  it('declares the version fields Hardening section 20 requires', async () => {
    const { schema } = await loadSchema();
    expect(schema.properties.derived_from.required).toEqual(['intent_revision']);
  });

  // Cross-schema alignment, not a style preference. T-16 types every revision
  // counter as integer/minimum 1 (route-receipt.schema.json:59-61 and :64-66,
  // context-receipt.schema.json:50-58) and T-19 does the same
  // (common-meta.schema.json#/$defs/revision). A string revision here would
  // make a receipt and the profile it cites uncomparable, so the types are
  // pinned rather than merely documented.
  it('types every version counter as integer with minimum 1', async () => {
    const { schema } = await loadSchema();
    const counters = [
      ['version', schema.properties.version],
      ['schema_version', schema.properties.schema_version],
      [
        'derived_from.intent_revision',
        schema.properties.derived_from.properties.intent_revision,
      ],
    ];
    for (const [name, field] of counters) {
      expect(field.type, `${name} must be integer`).toBe('integer');
      expect(field.minimum, `${name} must start at 1`).toBe(1);
    }
  });

  it('accepts the v1.1 topology alias with the run-ledger vocabulary', async () => {
    const { schema } = await loadSchema();
    expect(schema.properties.topology.enum).toEqual(TOPOLOGY_VALUES);
  });

  it('is fail-closed at every level (additionalProperties false)', async () => {
    const { schema } = await loadSchema();
    expect(schema.additionalProperties).toBe(false);
    for (const key of [...EIGHT_KEYS, 'derived_from']) {
      const sub = schema.properties[key];
      if (sub.type === 'object') {
        expect(
          sub.additionalProperties,
          `${key} must reject unknown sub-keys`,
        ).toBe(false);
      }
    }
  });

  it('pins every enum to the documented allowed-value union', async () => {
    const { schema } = await loadSchema();
    for (const [dotted, expected] of Object.entries(EXPECTED_ENUMS)) {
      expect(enumAt(schema, dotted), dotted).toEqual(expected);
    }
    expect(schema.definitions.autonomyValue.enum).toEqual(AUTONOMY_VALUES);
  });

  it('leaves review.model a free string (model ids live in the catalog, not here)', async () => {
    const { schema } = await loadSchema();
    const model = schema.properties.review.properties.model;
    expect(model.type).toBe('string');
    expect(model.enum).toBeUndefined();
  });

  it('cites a source for every enum ($comment present)', async () => {
    const { schema } = await loadSchema();
    for (const dotted of Object.keys(EXPECTED_ENUMS)) {
      const [group, leaf] = dotted.split('.');
      expect(
        schema.properties[group].properties[leaf].$comment,
        `${dotted} needs a source citation`,
      ).toBeTruthy();
    }
    expect(schema.properties.topology.$comment).toBeTruthy();
    expect(schema.definitions.autonomyValue.$comment).toBeTruthy();
  });

  it('keeps command_activation out of the profile (derived projection only)', async () => {
    const { raw, schema } = await loadSchema();
    // ARTIBOT-5.0-DESIGN.md §7.2 Addendum §2 demotes command_activation to a projection of
    // the profile, so it must not reappear here as a first-class key.
    expect(Object.keys(schema.properties)).not.toContain('command_activation');
    expect(raw).not.toContain('"command_activation"');
  });

  describe('structural stand-in for the ajv assertions (runs with no deps)', () => {
    it('excludes the values the ajv block probes as invalid', async () => {
      const { schema } = await loadSchema();
      expect(enumAt(schema, 'performance.priority')).not.toContain('turbo');
      // Hyphenated prose forms from package/02:58 are intentionally not accepted.
      expect(enumAt(schema, 'performance.priority')).not.toContain(
        'maximum-performance',
      );
      expect(enumAt(schema, 'performance.priority')).not.toContain(
        'high-quality',
      );
      // token_policy is the policy-YAML spelling, not a profile sub-key.
      expect(Object.keys(schema.properties.performance.properties)).toEqual([
        'priority',
        'budget',
      ]);
    });

    it('covers every value used by the two reference profiles', async () => {
      const { schema } = await loadSchema();
      expect(enumAt(schema, 'reasoning.depth')).toContain('deep');
      expect(schema.definitions.autonomyValue.enum).toContain('full');
      expect(enumAt(schema, 'performance.priority')).toContain('speed_accuracy');
      expect(enumAt(schema, 'performance.priority')).toContain('maximum');
      expect(enumAt(schema, 'performance.budget')).toContain('generous');
      expect(enumAt(schema, 'parallelism.strategy')).toContain('aggressive');
      expect(enumAt(schema, 'planning.mode')).toContain('ultraplan');
      expect(enumAt(schema, 'context.strategy')).toContain('sufficient');
      expect(enumAt(schema, 'review.strictness')).toContain('high');
      expect(schema.properties.topology.enum).toContain('split');
    });
  });
});

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to DECLARE the dependency, and
 * the wrong one — restoring the skip — is the one that looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so schemas/execution-profile.schema.json cannot be enforced and this gate',
  'proves nothing. ajv is only a TRANSITIVE dependency here (eslint -> ajv);',
  "package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

describe('execution-profile.schema.json — ajv validation behaviour', () => {
  // Throws AJV_MISSING rather than returning nulls: null validators would turn
  // every assertion below into "validate is not a function", which buries the
  // real cause. Throwing here makes each test fail with the fix instead.
  async function compile() {
    if (Ajv === null) throw new Error(AJV_MISSING);
    const { schema } = await loadSchema();
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(schema);
    return {
      validate: ajv.getSchema(SCHEMA_ID),
      validateVersioned: ajv.getSchema(
        `${SCHEMA_ID}#/definitions/versionedProfile`,
      ),
    };
  }

  it('has a real oracle — present, and able to say NO as well as YES', async () => {
    // The assertion IS the fail-closed statement: when ajv is gone this block
    // goes red and prints the fix, instead of the suite quietly running a dozen
    // fewer assertions. The compared value carries the guidance so the failure
    // diff is the instruction.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');

    // A validator that accepts everything would make every `toBe(true)` below
    // vacuous. Proving it can say NO is what makes its YES worth anything.
    const { validate } = await compile();
    expect(validate(V11_THREE_KEY_PROFILE)).toBe(true);
    expect(validate({ performance: { priority: 'turbo' } })).toBe(false);
  });

  it('compiles under the resolved ajv', async () => {
    const { validate, validateVersioned } = await compile();
    expect(typeof validate).toBe('function');
    expect(typeof validateVersioned).toBe('function');
  });

  it('accepts the ADDENDUM eight-key profile verbatim', async () => {
    const { validate } = await compile();
    expect(validate(ADDENDUM_EIGHT_KEY_PROFILE), JSON.stringify(validate.errors))
      .toBe(true);
  });

  it('accepts the v1.1 three-key subset', async () => {
    const { validate } = await compile();
    expect(validate(V11_THREE_KEY_PROFILE), JSON.stringify(validate.errors))
      .toBe(true);
  });

  it('rejects an unknown performance priority', async () => {
    const { validate } = await compile();
    expect(validate({ performance: { priority: 'turbo' } })).toBe(false);
    expect(validate({ performance: { priority: 'maximum-performance' } })).toBe(
      false,
    );
  });

  it('rejects an unknown performance budget', async () => {
    const { validate } = await compile();
    expect(validate({ performance: { budget: 'standard' } })).toBe(false);
  });

  it('rejects an unknown performance sub-key', async () => {
    const { validate } = await compile();
    expect(validate({ performance: { token_policy: 'generous' } })).toBe(false);
  });

  it('rejects an unknown top-level key', async () => {
    const { validate } = await compile();
    expect(validate({ command_activation: { plan: true } })).toBe(false);
  });

  it('accepts autonomy under either spelling (level and mode alias)', async () => {
    const { validate } = await compile();
    expect(validate({ autonomy: { level: 'agent_led' } })).toBe(true);
    expect(validate({ autonomy: { mode: 'guided' } })).toBe(true);
    expect(validate({ autonomy: { mode: 'auto', human_gates: ['budget'] } }))
      .toBe(true);
    expect(validate({ autonomy: { level: 'semi' } })).toBe(false);
  });

  it('requires version and derived_from only at the versioned conformance level', async () => {
    const { validate, validateVersioned } = await compile();
    expect(validate(V11_THREE_KEY_PROFILE)).toBe(true);
    expect(validateVersioned(V11_THREE_KEY_PROFILE)).toBe(false);
    expect(validateVersioned(ADDENDUM_EIGHT_KEY_PROFILE)).toBe(true);
  });

  it('rejects a derived_from without intent_revision', async () => {
    const { validate } = await compile();
    expect(validate({ version: 1, derived_from: {} })).toBe(false);
  });

  it('rejects non-integer and out-of-range version counters', async () => {
    const { validate } = await compile();
    expect(validate({ version: '1' })).toBe(false);
    expect(validate({ version: 0 })).toBe(false);
    expect(validate({ version: 1.5 })).toBe(false);
    expect(validate({ schema_version: '1' })).toBe(false);
    expect(validate({ derived_from: { intent_revision: '3' } })).toBe(false);
    expect(validate({ derived_from: { intent_revision: 0 } })).toBe(false);
    expect(validate({ derived_from: { intent_revision: 1 } })).toBe(true);
  });
});
