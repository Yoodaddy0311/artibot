/**
 * common-meta.schema.json — contract tests for the shared metadata fragments
 * (PRD T-19; ADDENDUM-HARDENING.md §5 §11 §20 §22 §23 §24 §29 §41).
 *
 * Three layers, deliberately separated:
 *
 *  1. STRUCTURAL — plain file reads. Always run. These pin the parts other
 *     schemas (T-12..T-18) are about to `$ref`: the $defs name set, the actor
 *     enum, the required lists, and the fact that the root is fragment-only.
 *  2. REGEX — `new RegExp` against the pattern strings lifted out of the JSON.
 *     Always run, zero dependency. The two patterns the T-19 brief calls out
 *     (idempotency_key, evidence_refs) are covered HERE rather than only under
 *     ajv, so that they stay fail-closed even on a machine with no ajv.
 *  3. AJV — composition behaviour that a file read cannot show ($ref
 *     resolution, allOf, additionalProperties, format). THE ORACLE IS
 *     REQUIRED, NOT OPTIONAL: ajv is the only thing here that can prove a
 *     `$ref` actually resolves, or that the `allOf` in derived_from actually
 *     adds a constraint. An earlier revision of this file wrapped this layer
 *     in `describe.skipIf(!Ajv)`, which reports the same green whether the
 *     contract holds or the oracle merely vanished. It now runs
 *     unconditionally and a missing oracle surfaces as {@link AJV_MISSING}.
 *     Resolved the same way as receipts.test.js (T-16).
 *
 * WHAT THESE TESTS DO NOT COVER (per verification-discipline §9 — write down
 * what the gate cannot see, next to the gate):
 *  - That any OTHER schema actually $refs these fragments. T-19 owns the
 *    fragment file only; the wiring is T-12..T-18's and T-40's to do and to
 *    test. A green run here says the pieces are well formed, NOT that they are
 *    in use anywhere.
 *  - Staleness propagation (§5: intent 2 -> 3 makes plan STALE). That is a
 *    runtime judgement, not a schema constraint; the schema only records the
 *    revisions the judgement will read.
 *  - The real value space of catalog_version. The constant is T-11's and did
 *    not exist when this was written, so the fragment only requires a
 *    non-empty string.
 *  - Which ajv version enforces layer 3. ajv reaches this file only as a
 *    TRANSITIVE dependency: package.json declares neither a dependency nor a
 *    devDependency on it, package-lock.json pins 6.15.0 (line 1299) and the
 *    installed tree actually resolves 6.12.6 (both measured 2026-09-03). A
 *    draft-07-only ajv is what these assertions were written against; a future
 *    ajv 8 would treat `$defs` and format differently.
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

/**
 * Why a missing ajv must fail rather than skip: the structural and regex
 * layers above read the schema as TEXT, so they can confirm that a `$ref`
 * string is spelled correctly but never that it RESOLVES, and they can confirm
 * that derived_from is written with `allOf` but never that the allOf actually
 * imposes `required`. Only ajv closes that gap. A skip here reports the same
 * green as a pass, and of the two responses to a red build at 2am, deleting
 * the assertions is the one that looks easiest.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so the common-meta fragments cannot be enforced',
  'and this gate proves nothing. ajv is only a TRANSITIVE dependency here',
  "(eslint -> ajv); package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../schemas/common-meta.schema.json',
);
const SCHEMA_ID = 'common-meta.schema.json';

/** Every fragment this file is contracted to provide. */
const EXPECTED_DEFS = [
  'schema_version',
  'revision',
  'actor',
  'based_on',
  'derived_from',
  'execution_profile_meta',
  'catalog_version',
  'idempotency_key',
  'evidence_ref',
  'evidence_refs',
  'provenance',
];

async function loadSchema() {
  const raw = await readFile(SCHEMA_PATH, 'utf-8');
  return { raw, schema: JSON.parse(raw) };
}

/** Collect every `$ref` string anywhere in the document. */
function collectRefs(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

describe('common-meta.schema.json — structure', () => {
  it('is valid JSON with the draft-07 dialect and a stable $id', async () => {
    const { schema } = await loadSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$id).toBe(SCHEMA_ID);
    expect(schema.title).toBe('ArtibotCommonMeta');
  });

  it('is fragment-only: the root declares no type, properties or required', async () => {
    const { schema } = await loadSchema();
    // A root that constrained instances would make every consumer that
    // $refs the FILE (rather than a $defs member) accidentally inherit it.
    expect(schema.type).toBeUndefined();
    expect(schema.properties).toBeUndefined();
    expect(schema.required).toBeUndefined();
  });

  it('exposes exactly the expected $defs fragments', async () => {
    const { schema } = await loadSchema();
    expect(Object.keys(schema.$defs).sort()).toEqual([...EXPECTED_DEFS].sort());
  });

  it('every $ref resolves to a $defs member that exists', async () => {
    const { schema } = await loadSchema();
    const refs = collectRefs(schema);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/$defs/')).toBe(true);
      const name = ref.slice('#/$defs/'.length);
      expect(Object.keys(schema.$defs)).toContain(name);
    }
  });

  it('gives every fragment a description (these are the consumer docs)', async () => {
    const { schema } = await loadSchema();
    for (const name of EXPECTED_DEFS) {
      expect(typeof schema.$defs[name].description).toBe('string');
      expect(schema.$defs[name].description.length).toBeGreaterThan(0);
    }
  });
});

describe('common-meta.schema.json — §41 actor', () => {
  it('closes the actor type as an allowlist of exactly human|agent|runtime', async () => {
    const { schema } = await loadSchema();
    // Allowlist, not denylist: a denylist would fail open for a fourth actor
    // kind added later (verification-discipline §8).
    expect(schema.$defs.actor.properties.type.enum).toEqual([
      'human',
      'agent',
      'runtime',
    ]);
    expect(schema.$defs.actor.additionalProperties).toBe(false);
  });

  it('requires both members of actor', async () => {
    const { schema } = await loadSchema();
    expect(schema.$defs.actor.required.sort()).toEqual(['id', 'type']);
  });
});

describe('common-meta.schema.json — §5/§22 based_on and §20 derived_from', () => {
  it('based_on carries exactly the three revision members, all optional', async () => {
    const { schema } = await loadSchema();
    const basedOn = schema.$defs.based_on;
    expect(Object.keys(basedOn.properties).sort()).toEqual([
      'intent_revision',
      'plan_revision',
      'review_revision',
    ]);
    expect(basedOn.required).toBeUndefined();
    expect(basedOn.additionalProperties).toBe(false);
    // A present-but-empty based_on reads as "a dependency was recorded" while
    // asserting nothing, so it is rejected.
    expect(basedOn.minProperties).toBe(1);
  });

  it('derived_from adds its extra required through allOf, not as a $ref sibling', async () => {
    const { schema } = await loadSchema();
    const derived = schema.$defs.derived_from;
    // Draft-07 IGNORES keywords sibling to `$ref`. Writing
    // { $ref: ..., required: [...] } would silently drop the required.
    expect(derived.$ref).toBeUndefined();
    expect(Array.isArray(derived.allOf)).toBe(true);
    expect(derived.allOf[0].$ref).toBe('#/$defs/based_on');
    expect(derived.allOf[1].required).toEqual(['intent_revision']);
  });

  it('execution_profile_meta pairs version with derived_from', async () => {
    const { schema } = await loadSchema();
    const meta = schema.$defs.execution_profile_meta;
    expect(meta.required.sort()).toEqual(['derived_from', 'version']);
    expect(meta.properties.derived_from.$ref).toBe('#/$defs/derived_from');
    expect(meta.additionalProperties).toBe(false);
  });
});

describe('common-meta.schema.json — §29 schema_version and §24 provenance', () => {
  it('schema_version and revision are integers starting at 1', async () => {
    const { schema } = await loadSchema();
    for (const name of ['schema_version', 'revision']) {
      expect(schema.$defs[name].type).toBe('integer');
      expect(schema.$defs[name].minimum).toBe(1);
    }
  });

  it('provenance requires the five always-defined members', async () => {
    const { schema } = await loadSchema();
    expect(schema.$defs.provenance.required.sort()).toEqual([
      'created_at',
      'created_by',
      'revision',
      'updated_at',
      'updated_by',
    ]);
  });

  it('provenance declares based_on and evidence_refs but leaves them optional', async () => {
    const { schema } = await loadSchema();
    const props = schema.$defs.provenance.properties;
    // Root artifacts are structurally missing both: an intent is based on
    // nothing (§5 shows based_on only from plan downward) and an artifact that
    // cites no evidence has no refs (§23).
    expect(props.based_on.$ref).toBe('#/$defs/based_on');
    expect(props.evidence_refs.$ref).toBe('#/$defs/evidence_refs');
    expect(schema.$defs.provenance.required).not.toContain('based_on');
    expect(schema.$defs.provenance.required).not.toContain('evidence_refs');
  });

  it('provenance timestamps are date-time strings, matching lease.schema.json', async () => {
    const { schema } = await loadSchema();
    for (const name of ['created_at', 'updated_at']) {
      expect(schema.$defs.provenance.properties[name].type).toBe('string');
      expect(schema.$defs.provenance.properties[name].format).toBe('date-time');
    }
  });
});

describe('common-meta.schema.json — catalog_version is deliberately loose', () => {
  it('constrains only to a non-empty string, with no format guess', async () => {
    const { schema } = await loadSchema();
    const cv = schema.$defs.catalog_version;
    expect(cv.type).toBe('string');
    expect(cv.minLength).toBe(1);
    // The constant is T-11's and did not exist at authoring time. A
    // YYYY-MM-DD pattern here would fail closed if T-11 lands a semver.
    expect(cv.pattern).toBeUndefined();
    expect(cv.enum).toBeUndefined();
  });
});

describe('common-meta.schema.json — §11 idempotency_key pattern (zero-dep)', () => {
  /** Build the matcher from the schema itself, so drift fails the test. */
  async function keyRe() {
    const { schema } = await loadSchema();
    return new RegExp(schema.$defs.idempotency_key.pattern);
  }

  it('accepts the literal from the design and the one from the T-19 brief', async () => {
    const re = await keyRe();
    // ADDENDUM-HARDENING.md §11 literal.
    expect(re.test('mission:M-001:review:rev-2')).toBe(true);
    // The brief's shorthand of the same shape.
    expect(re.test('mission:M:review:rev-2')).toBe(true);
  });

  it('accepts keys for the other four operations §11 names', async () => {
    const re = await keyRe();
    for (const key of [
      'mission:M-001:created',
      'mission:M-001:task:T-03:claimed',
      'artifact:plan:M-001:updated:rev-5',
      'ledger:M-001:append:0001',
    ]) {
      expect(re.test(key), key).toBe(true);
    }
  });

  it('rejects malformed keys', async () => {
    const re = await keyRe();
    for (const key of [
      '', // empty
      'nocolon', // single segment carries no scope
      'mission:', // trailing colon, empty segment
      ':review:rev-2', // leading colon, empty scope
      'mission::rev-2', // empty inner segment
      'Mission:M-001', // uppercase scope
      '1mission:M-001', // digit-leading scope
      'mission M-001:review', // whitespace
      'mission:M-001:review:rev 2', // whitespace in a segment
    ]) {
      expect(re.test(key), key).toBe(false);
    }
  });
});

describe('common-meta.schema.json — §23 evidence_refs pattern (zero-dep)', () => {
  async function refRe() {
    const { schema } = await loadSchema();
    return new RegExp(schema.$defs.evidence_ref.pattern);
  }

  it('accepts the §23 literals and stays open past E-999', async () => {
    const re = await refRe();
    for (const id of ['E-001', 'E-008', 'E-999', 'E-1000', 'E-12345']) {
      expect(re.test(id), id).toBe(true);
    }
  });

  it('rejects ids that are not zero-padded three-digit-or-more E-ids', async () => {
    const re = await refRe();
    for (const id of [
      '',
      'E-1', // under-padded
      'E-01', // under-padded
      'E-', // no number
      'e-001', // lowercase prefix
      'EE-001', // wrong prefix
      'E001', // missing hyphen
      ' E-001', // leading space
      'E-001 ', // trailing space
      'E-00a', // non-digit
    ]) {
      expect(re.test(id), id).toBe(false);
    }
  });

  it('declares evidence_refs as a unique-item array of evidence_ref', async () => {
    const { schema } = await loadSchema();
    const refs = schema.$defs.evidence_refs;
    expect(refs.type).toBe('array');
    expect(refs.uniqueItems).toBe(true);
    expect(refs.items.$ref).toBe('#/$defs/evidence_ref');
  });
});

// ---------------------------------------------------------------------------
// Layer 3: composition behaviour. Runs UNCONDITIONALLY — a missing ajv fails
// with AJV_MISSING rather than skipping. See the AJV_MISSING doc comment.
// ---------------------------------------------------------------------------
describe('common-meta.schema.json — ajv validation behaviour', () => {
  /**
   * Compile once and hand back a `get(fragmentName)` validator factory.
   *
   * When ajv is absent this returns THROWING STUBS rather than nulls: a null
   * validator turns every assertion below into "validate is not a function",
   * which buries the real cause. A stub makes each test fail with the fix
   * instruction instead.
   */
  async function validators() {
    if (Ajv === null) {
      const stub = () => {
        throw new Error(AJV_MISSING);
      };
      return { root: stub, get: () => stub };
    }
    const { schema } = await loadSchema();
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(schema);
    return {
      root: ajv.getSchema(SCHEMA_ID),
      get: (name) => ajv.getSchema(`${SCHEMA_ID}#/$defs/${name}`),
    };
  }

  it('has a real oracle that both accepts and rejects', async () => {
    // Oracle presence: a missing ajv is a FAILURE here, never a skip.
    expect(Ajv, AJV_MISSING).not.toBeNull();
    const { get } = await validators();
    const actor = get('actor');
    const evidenceRefs = get('evidence_refs');
    // Rejection capability: a validator that returned true for everything
    // would make every other assertion in this block vacuous.
    expect(actor({ type: 'bot', id: 'x' })).toBe(false);
    expect(evidenceRefs(['E-1'])).toBe(false);
    // ...and it is not simply rejecting everything.
    expect(actor({ type: 'agent', id: 'artibot:backend-developer' })).toBe(true);
    expect(evidenceRefs(['E-001', 'E-008'])).toBe(true);
  });

  it('compiles, and every fragment is reachable by JSON pointer', async () => {
    // Guarded explicitly: a throwing stub is still `typeof === 'function'`, so
    // without this line the loop below would pass vacuously with no ajv.
    expect(Ajv, AJV_MISSING).not.toBeNull();
    const { get } = await validators();
    for (const name of EXPECTED_DEFS) {
      expect(typeof get(name), name).toBe('function');
    }
  });

  it('root accepts any instance, confirming it constrains nothing', async () => {
    const { root } = await validators();
    expect(root({ anything: true })).toBe(true);
    expect(root(42)).toBe(true);
  });

  it('actor: valid examples pass, invalid ones fail', async () => {
    const { get } = await validators();
    const actor = get('actor');
    expect(actor({ type: 'human', id: 'ad-display@artience.com' })).toBe(true);
    expect(actor({ type: 'agent', id: 'artibot:backend-developer' })).toBe(true);
    expect(actor({ type: 'runtime', id: 'event-writer' })).toBe(true);

    expect(actor({ type: 'bot', id: 'x' })).toBe(false); // outside the allowlist
    expect(actor({ type: 'human' })).toBe(false); // no id
    expect(actor({ id: 'x' })).toBe(false); // no type
    expect(actor({ type: 'human', id: '' })).toBe(false); // empty id
    expect(actor({ type: 'human', id: 'x', role: 'lead' })).toBe(false); // extra key
  });

  it('based_on: the §5 examples pass, degenerate forms fail', async () => {
    const { get } = await validators();
    const basedOn = get('based_on');
    expect(basedOn({ intent_revision: 2 })).toBe(true); // §5 plan
    expect(basedOn({ intent_revision: 2, plan_revision: 5 })).toBe(true); // §5 review
    expect(
      basedOn({ intent_revision: 2, plan_revision: 5, review_revision: 1 }),
    ).toBe(true); // §5 outcome
    expect(basedOn({ intent_revision: 3, plan_revision: 7 })).toBe(true); // §22 context

    expect(basedOn({})).toBe(false); // asserts nothing
    expect(basedOn({ task_revision: 1 })).toBe(false); // unknown member
    expect(basedOn({ intent_revision: 0 })).toBe(false); // revisions start at 1
    expect(basedOn({ intent_revision: 1.5 })).toBe(false); // not an integer
    expect(basedOn({ intent_revision: '2' })).toBe(false); // string, not integer
  });

  it('derived_from: the allOf actually enforces intent_revision', async () => {
    const { get } = await validators();
    const derived = get('derived_from');
    expect(derived({ intent_revision: 3 })).toBe(true); // §20 literal
    expect(derived({ plan_revision: 1 })).toBe(false); // intent_revision missing
    expect(derived({})).toBe(false);
  });

  it('execution_profile_meta: the §20 example passes', async () => {
    const { get } = await validators();
    const meta = get('execution_profile_meta');
    expect(meta({ version: 1, derived_from: { intent_revision: 3 } })).toBe(true);
    expect(meta({ version: 1 })).toBe(false); // no derivation
    expect(meta({ derived_from: { intent_revision: 3 } })).toBe(false); // no version
    expect(meta({ version: 0, derived_from: { intent_revision: 3 } })).toBe(false);
  });

  it('schema_version: the §29 literal passes, non-integers fail', async () => {
    const { get } = await validators();
    const sv = get('schema_version');
    expect(sv(1)).toBe(true);
    expect(sv(2)).toBe(true);
    expect(sv(0)).toBe(false);
    expect(sv('1')).toBe(false); // integer, not a semver string
    expect(sv(1.1)).toBe(false);
  });

  it('catalog_version: any non-empty string passes, empty fails', async () => {
    const { get } = await validators();
    const cv = get('catalog_version');
    expect(cv('2026-09-02')).toBe(true); // the design literal
    expect(cv('1.4.0')).toBe(true); // deliberately still allowed
    expect(cv('')).toBe(false);
    expect(cv(20260902)).toBe(false); // string, not a number
  });

  it('idempotency_key: pattern is enforced through the schema, not only the regex', async () => {
    const { get } = await validators();
    const key = get('idempotency_key');
    expect(key('mission:M-001:review:rev-2')).toBe(true);
    expect(key('nocolon')).toBe(false);
    expect(key('')).toBe(false);
    expect(key(123)).toBe(false);
  });

  it('evidence_refs: unique E-ids pass, duplicates and bad ids fail', async () => {
    const { get } = await validators();
    const refs = get('evidence_refs');
    expect(refs(['E-001', 'E-008'])).toBe(true); // §23 literal list
    expect(refs([])).toBe(true); // no evidence cited
    expect(refs(['E-001', 'E-001'])).toBe(false); // duplicate
    expect(refs(['E-1'])).toBe(false); // under-padded
    expect(refs('E-001')).toBe(false); // not an array
  });

  it('provenance: the §24 minimum passes and each omission fails', async () => {
    const { get } = await validators();
    const provenance = get('provenance');
    const human = { type: 'human', id: 'ad-display@artience.com' };
    const minimal = {
      created_by: human,
      updated_by: human,
      created_at: '2026-09-02T06:29:36Z',
      updated_at: '2026-09-02T06:29:36Z',
      revision: 1,
    };
    expect(provenance(minimal)).toBe(true);

    // Full §24 shape, with the two optional members present.
    expect(
      provenance({
        ...minimal,
        updated_by: { type: 'agent', id: 'artibot:backend-developer' },
        updated_at: '2026-09-02T07:00:00Z',
        revision: 2,
        based_on: { intent_revision: 2, plan_revision: 5 },
        evidence_refs: ['E-001', 'E-008'],
      }),
    ).toBe(true);

    for (const missing of [
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
      'revision',
    ]) {
      const instance = { ...minimal };
      delete instance[missing];
      expect(provenance(instance), `missing ${missing}`).toBe(false);
    }
  });

  it('provenance: rejects a bad timestamp, a bad actor and an unknown key', async () => {
    const { get } = await validators();
    const provenance = get('provenance');
    const human = { type: 'human', id: 'u' };
    const minimal = {
      created_by: human,
      updated_by: human,
      created_at: '2026-09-02T06:29:36Z',
      updated_at: '2026-09-02T06:29:36Z',
      revision: 1,
    };
    expect(provenance({ ...minimal, created_at: 'not-a-date' })).toBe(false);
    expect(provenance({ ...minimal, created_by: { type: 'bot', id: 'x' } })).toBe(
      false,
    );
    expect(provenance({ ...minimal, author: 'someone' })).toBe(false);
    // The nested $ref is live: an empty based_on is rejected here too.
    expect(provenance({ ...minimal, based_on: {} })).toBe(false);
  });
});
