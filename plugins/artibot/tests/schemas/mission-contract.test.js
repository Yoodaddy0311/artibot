/**
 * mission-contract.schema.json — structural contract + behavioural validation.
 *
 * The schema is the in-memory validator for the intent.md parser's output
 * (design v1 §3.1). It is never written to disk, so what these tests guard is
 * the *contract shape*: the v1.0 13 fields survive, the reverse additions are
 * present with the canonical vocabularies, and the first eval case from
 * §3.1 behaves — a "split 을 업그레이드해줘" contract validates, and a contract
 * whose `scope.requested_target` is empty does NOT.
 *
 * WHY A HAND-ROLLED VALIDATOR, WITH ajv AS A CROSS-CHECK
 * -----------------------------------------------------
 * ajv IS resolvable from `plugins/artibot` (ajv 6.12.6, measured 2026-09-02),
 * but only as an undeclared TRANSITIVE dependency — `package.json` does not
 * list it. So the pattern `tests/schemas/review-output.schema.test.js` uses
 * (import defensively, skip the block when ajv is absent) is one
 * dependency-tree change away from silently skipping the two assertions this
 * task exists to make, and a skipped assertion reads as green while proving
 * nothing.
 *
 * The primary validator here is therefore a small draft-07 *subset*
 * implementation that always runs, with ajv as a corroborating second opinion:
 * a cross-check block asserts the two agree on every fixture. That block now
 * FAILS rather than skips when ajv cannot be resolved — the skip was the exact
 * hole this file's own header warned about, and it reported the same green
 * whether the two validators agreed or the second opinion merely vanished.
 * The hand-rolled validator is never the only thing behind a verdict, and a
 * missing oracle surfaces as {@link AJV_MISSING} instead of as silence.
 *
 * WHAT THAT VALIDATOR CANNOT SEE (write it next to the gate, per repo rule)
 * ------------------------------------------------------------------------
 *  - It implements only the keywords this schema actually uses. A
 *    keyword-coverage test walks the schema and FAILS if any keyword appears
 *    that the validator does not implement, so the gate cannot silently
 *    degrade into a pass when the schema grows a construct it ignores.
 *  - `$ref` is NOT resolved. The one external ref (`execution_profile` →
 *    T-18's schema, which does not exist yet) is reported as an unvalidated
 *    path rather than silently accepted; a test asserts it is the only one.
 *  - It is not a conformance-complete draft-07 implementation and must not be
 *    reused as one. It proves this schema's assertions, nothing wider.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ajv is a transitive dependency, not declared in package.json. Imported
// defensively so the cross-check block skips — never fails — when it is gone.
let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../schemas/mission-contract.schema.json',
);

async function loadSchema() {
  const raw = await readFile(SCHEMA_PATH, 'utf-8');
  return { raw, schema: JSON.parse(raw) };
}

/**
 * Collect every `mission_id` pattern anywhere in a schema document.
 * Path-independent on purpose: the sibling schemas nest mission_id at
 * different depths, and a hardcoded path would silently find nothing (and so
 * compare nothing) if either lane moved it.
 */
function collectMissionIdPatterns(node, out = []) {
  if (typeof node !== 'object' || node === null) return out;
  if (Array.isArray(node)) {
    for (const entry of node) collectMissionIdPatterns(entry, out);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'mission_id' && typeof value?.pattern === 'string') {
      out.push(value.pattern);
    }
    collectMissionIdPatterns(value, out);
  }
  return out;
}

/** T-18's schema, or null when that lane has not landed it yet. */
async function loadExecutionProfileSchema() {
  try {
    const raw = await readFile(
      path.resolve(__dirname, '../../schemas/execution-profile.schema.json'),
      'utf-8',
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal draft-07 subset validator
// ---------------------------------------------------------------------------

/** Keywords the validator actually enforces. */
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'minLength',
  'minimum',
  'maximum',
  'pattern',
]);

/** Keywords that carry no constraint (annotation only) — safe to ignore. */
const ANNOTATION_KEYWORDS = new Set([
  '$schema',
  'title',
  'description',
  'examples',
  'default',
]);

/** Deliberately unresolved: reported, never silently accepted. */
const DEFERRED_KEYWORDS = new Set(['$ref']);

function typeMatches(type, value) {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      throw new Error(`validator: unsupported type "${type}"`);
  }
}

/**
 * Validate `value` against `schema`.
 * @returns {{ errors: string[], unvalidated: string[] }}
 */
function validate(schema, value, pointer = '', acc = { errors: [], unvalidated: [] }) {
  const here = pointer || '(root)';

  if (typeof schema.$ref === 'string') {
    // No external resolution. Record and stop descending so an unresolved ref
    // is visible as a hole rather than reading as a pass.
    acc.unvalidated.push(here);
    return acc;
  }

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    acc.errors.push(`${here}: expected type ${schema.type}`);
    return acc; // further keywords assume the type held
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    acc.errors.push(`${here}: value ${JSON.stringify(value)} not in enum`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      acc.errors.push(`${here}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      acc.errors.push(`${here}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      acc.errors.push(`${here}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      acc.errors.push(`${here}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      acc.errors.push(`${here}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((entry, i) => validate(schema.items, entry, `${here}[${i}]`, acc));
    }
  }

  if (typeMatches('object', value)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        acc.errors.push(`${here}: missing required property "${key}"`);
      }
    }
    const props = schema.properties ?? {};
    for (const [key, entry] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        validate(props[key], entry, `${here}.${key}`, acc);
      } else if (schema.additionalProperties === false) {
        acc.errors.push(`${here}: unexpected property "${key}"`);
      }
    }
  }

  return acc;
}

const isValid = (schema, value) => validate(schema, value).errors.length === 0;

/** Walk every schema position and collect the keywords used. */
function collectKeywords(schema, out = new Set()) {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return out;
  for (const key of Object.keys(schema)) out.add(key);
  for (const sub of Object.values(schema.properties ?? {})) collectKeywords(sub, out);
  if (schema.items) collectKeywords(schema.items, out);
  if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
    collectKeywords(schema.additionalProperties, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Design §3.1 first eval case: "split 을 업그레이드해줘".
 * `explicit_requests` keeps the user's words with a span back into the raw
 * request, and `requested_target` names the split paths. Substituting context
 * for either is the failure this fixture exists to detect.
 */
const SPLIT_UPGRADE_CONTRACT = {
  schema_version: 1,
  mission_id: 'M-20260902-001',
  intent_revision: 1,
  status: 'planning',
  goal: '/split 명령의 실행 구조를 업그레이드한다',
  explicit_requests: [{ text: 'split 을 업그레이드', span: { start: 0, end: 11 } }],
  inferred_outcomes: ['worker orchestration 안정화'],
  success: {
    functional: ['/split plan 이 새 계약을 출력'],
    behavioral: ['창 4개까지 병렬 유지'],
    regression: ['기존 트레일러 판독 유지'],
    evidence: ['npx vitest run tests/schemas/mission-contract.test.js'],
  },
  scope: {
    requested_target: ['plugins/artibot/skills/split/**'],
    direct: ['plugins/artibot/lib/topology/**'],
    upstream: [],
    downstream: [],
    bounded_blindspots: [],
    excluded: ['plugins/artibot/lib/routing/**'],
  },
  constraints: ['기존 UX 호환 유지'],
  findings: { mission_blockers: [], bounded_blindspots: [], future_opportunities: [] },
  autonomy: { mode: 'agent_led', human_gates: ['HG-01'] },
  performance: { priority: 'quality', fast_mode: false },
  planning: { mode: 'ultraplan' },
  completion: { expected_actions: ['plan 갱신'] },
  intent_confidence: {
    goal: 0.97,
    scope: 0.81,
    completion_expectation: 0.93,
    product_decision_required: false,
  },
  command_activation: {
    plan: true,
    ultraplan: true,
    review: true,
    autopilot: false,
    autopilot_fast: false,
    split: true,
    skills: ['repo-analysis'],
  },
  topology: { mode: 'split' },
  review: { required: true, model: 'fable-5.1', status: 'pending' },
  user_decisions: [{ question: '창 몇 개?', answer: '4' }],
};

/** Same contract with the user's target erased — must fail. */
function contractWithEmptyRequestedTarget() {
  const clone = structuredClone(SPLIT_UPGRADE_CONTRACT);
  clone.scope.requested_target = [];
  return clone;
}

// ---------------------------------------------------------------------------
// Validator self-verification (a gate that cannot check itself is not a gate)
// ---------------------------------------------------------------------------

describe('subset validator — self-verification', () => {
  it('enforces type', () => {
    expect(isValid({ type: 'string' }, 'a')).toBe(true);
    expect(isValid({ type: 'string' }, 1)).toBe(false);
    expect(isValid({ type: 'integer' }, 1.5)).toBe(false);
    expect(isValid({ type: 'array' }, {})).toBe(false);
    expect(isValid({ type: 'object' }, [])).toBe(false);
  });

  it('enforces required, enum, pattern, minLength', () => {
    expect(isValid({ type: 'object', required: ['a'] }, {})).toBe(false);
    expect(isValid({ type: 'object', required: ['a'] }, { a: 1 })).toBe(true);
    expect(isValid({ enum: ['x'] }, 'y')).toBe(false);
    expect(isValid({ type: 'string', pattern: '^a$' }, 'b')).toBe(false);
    expect(isValid({ type: 'string', minLength: 1 }, '')).toBe(false);
  });

  it('enforces minItems, minimum, maximum and item schemas', () => {
    expect(isValid({ type: 'array', minItems: 1 }, [])).toBe(false);
    expect(isValid({ type: 'number', minimum: 0, maximum: 1 }, 1.2)).toBe(false);
    expect(isValid({ type: 'number', minimum: 0, maximum: 1 }, -0.1)).toBe(false);
    expect(isValid({ type: 'array', items: { type: 'string' } }, ['a', 2])).toBe(false);
  });

  it('enforces additionalProperties:false and recurses into properties', () => {
    const s = {
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'object', properties: { b: { type: 'string' } } } },
    };
    expect(isValid(s, { a: { b: 'ok' } })).toBe(true);
    expect(isValid(s, { a: { b: 1 } })).toBe(false);
    expect(isValid(s, { zzz: 1 })).toBe(false);
  });

  it('reports an unresolved $ref as unvalidated rather than as a pass', () => {
    const result = validate(
      { type: 'object', properties: { p: { $ref: './nope.json' } } },
      { p: { anything: true } },
    );
    expect(result.errors).toEqual([]);
    expect(result.unvalidated).toEqual(['(root).p']);
  });
});

describe('mission-contract.schema.json — validator keyword coverage', () => {
  it('uses no keyword the validator silently ignores', async () => {
    const { schema } = await loadSchema();
    const used = collectKeywords(schema);
    const unknown = [...used].filter(
      (k) =>
        !SUPPORTED_KEYWORDS.has(k) &&
        !ANNOTATION_KEYWORDS.has(k) &&
        !DEFERRED_KEYWORDS.has(k),
    );
    expect(unknown, `unimplemented keywords: ${unknown.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('mission-contract.schema.json — structure', () => {
  it('is valid JSON on draft-07, matching the repo convention', async () => {
    const { schema } = await loadSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.title).toBe('ArtibotMissionContract');
    expect(schema.type).toBe('object');
  });

  it('states in its description that it is an in-memory validator, not a disk artifact', async () => {
    const { schema } = await loadSchema();
    expect(schema.description).toMatch(/in-memory validator/i);
    expect(schema.description).toMatch(/NOT a disk artifact/i);
  });

  it('keeps the v1.0 required set', async () => {
    const { schema } = await loadSchema();
    expect(schema.required).toEqual(['goal', 'explicit_requests', 'success', 'scope']);
  });

  it('is an allowlist at the top level (additionalProperties:false)', async () => {
    const { schema } = await loadSchema();
    expect(schema.additionalProperties).toBe(false);
  });

  it('carries the v1.0 13 contract fields', async () => {
    const { schema } = await loadSchema();
    // package/03_INTENT_MISSION_COMPILER.md — the mission block (10) plus
    // intent_confidence, command_activation and findings.
    const v10 = [
      'goal',
      'explicit_requests',
      'inferred_outcomes',
      'success',
      'scope',
      'constraints',
      'autonomy',
      'performance',
      'planning',
      'completion',
      'intent_confidence',
      'command_activation',
      'findings',
    ];
    expect(v10).toHaveLength(13);
    for (const field of v10) {
      expect(schema.properties, `v1.0 field ${field}`).toHaveProperty(field);
    }
  });

  it('carries the six reverse additions plus execution_profile and schema_version', async () => {
    const { schema } = await loadSchema();
    const added = [
      'mission_id',
      'intent_revision',
      'status',
      'topology',
      'review',
      'user_decisions',
    ];
    for (const field of added) {
      expect(schema.properties, `reverse addition ${field}`).toHaveProperty(field);
    }
    expect(schema.properties).toHaveProperty('execution_profile');
    expect(schema.properties).toHaveProperty('schema_version');
  });

  it('leaves schema_version optional (T-19 reserves it; enforcement is P2)', async () => {
    const { schema } = await loadSchema();
    expect(schema.required).not.toContain('schema_version');
    expect(schema.properties.schema_version.description).toMatch(/P2/);
  });

  it('declares schema_version identically to T-19 common-meta (integer, not semver)', async () => {
    const { schema } = await loadSchema();
    expect(schema.properties.schema_version.type).toBe('integer');
    expect(schema.properties.schema_version.minimum).toBe(1);
    expect(schema.properties.schema_version.pattern).toBeUndefined();

    // Cross-lane consistency: if T-19's fragment is present, the two shapes
    // must not have drifted. Skipped only when that file does not exist yet.
    const commonMetaPath = path.resolve(
      __dirname,
      '../../schemas/common-meta.schema.json',
    );
    let commonMeta = null;
    try {
      commonMeta = JSON.parse(await readFile(commonMetaPath, 'utf-8'));
    } catch {
      // T-19's fragment has not landed yet — nothing to cross-check against.
    }
    if (commonMeta?.$defs?.schema_version) {
      const canonical = commonMeta.$defs.schema_version;
      expect(schema.properties.schema_version.type).toBe(canonical.type);
      expect(schema.properties.schema_version.minimum).toBe(canonical.minimum);
    }
  });

  it('defers execution_profile to T-18 by $ref only, using that schema\'s own $id', async () => {
    const { schema } = await loadSchema();
    const ref = schema.properties.execution_profile.$ref;
    // No inline shape here — T-18 owns the 8 keys.
    expect(schema.properties.execution_profile.properties).toBeUndefined();
    expect(schema.properties.execution_profile.description).toMatch(/never as 'well-formed'/);

    // The ref must name the identity execution-profile.schema.json declares
    // for itself. A relative path would silently stop resolving the moment
    // either file moves, and would not match that $id under ajv.
    const t18 = await loadExecutionProfileSchema();
    if (t18) {
      expect(ref).toBe(t18.$id);
    } else {
      expect(ref).toBe('https://artibot.dev/schemas/execution-profile.schema.json');
    }
  });

  it('marks command_activation as a derived projection, not a first-class field', async () => {
    const { schema } = await loadSchema();
    const desc = schema.properties.command_activation.description;
    expect(desc).toMatch(/NOT a first-class field/);
    expect(desc).toMatch(/DERIVED PROJECTION/);
  });
});

describe('mission-contract.schema.json — vocabularies', () => {
  it('uses the v1.1 7-state mission status enum', async () => {
    const { schema } = await loadSchema();
    expect(schema.properties.status.enum).toEqual([
      'queued',
      'planning',
      'executing',
      'blocked',
      'reviewing',
      'completed',
      'failed',
    ]);
  });

  it('uses the run-ledger 6-value topology.mode enum and omits performance_profile', async () => {
    const { schema } = await loadSchema();
    expect(schema.properties.topology.properties.mode.enum).toEqual([
      'solo',
      'subagent',
      'team',
      'autopilot',
      'autopilot_fast',
      'split',
    ]);
    // Decision F2 moved this dimension to execution_profile.performance.
    expect(schema.properties.topology.properties).not.toHaveProperty(
      'performance_profile',
    );
  });

  it('keeps the v1.0 autonomy, performance and planning enums', async () => {
    const { schema } = await loadSchema();
    expect(schema.properties.autonomy.properties.mode.enum).toEqual([
      'guided',
      'agent_led',
      'autonomous',
    ]);
    expect(schema.properties.performance.properties.priority.enum).toEqual([
      'economy',
      'balanced',
      'quality',
      'fast',
      'maximum_performance',
    ]);
    expect(schema.properties.planning.properties.mode.enum).toEqual([
      'auto',
      'direct',
      'plan',
      'ultraplan',
    ]);
  });

  it('keeps the four intent_confidence keys with product_decision_required as S4', async () => {
    const { schema } = await loadSchema();
    expect(Object.keys(schema.properties.intent_confidence.properties)).toEqual([
      'goal',
      'scope',
      'completion_expectation',
      'product_decision_required',
    ]);
    expect(schema.properties.intent_confidence.properties.product_decision_required.type).toBe(
      'boolean',
    );
  });

  it('leaves review.status unconstrained so it does not fork the T-20 verdict vocabulary', async () => {
    const { schema } = await loadSchema();
    expect(schema.properties.review.properties.status.type).toBe('string');
    expect(schema.properties.review.properties.status.enum).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Behaviour — design §3.1 eval case 1
// ---------------------------------------------------------------------------

describe('mission-contract.schema.json — behaviour', () => {
  it('accepts the "split 을 업그레이드해줘" contract', async () => {
    const { schema } = await loadSchema();
    const result = validate(schema, SPLIT_UPGRADE_CONTRACT);
    expect(result.errors).toEqual([]);
  });

  it('rejects a contract whose scope.requested_target is empty', async () => {
    const { schema } = await loadSchema();
    const result = validate(schema, contractWithEmptyRequestedTarget());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join('\n')).toMatch(/requested_target.*minItems/);
  });

  it('rejects a contract with scope but no requested_target key at all', async () => {
    const { schema } = await loadSchema();
    const clone = structuredClone(SPLIT_UPGRADE_CONTRACT);
    delete clone.scope.requested_target;
    const result = validate(schema, clone);
    expect(result.errors.join('\n')).toMatch(/missing required property "requested_target"/);
  });

  it('rejects each missing top-level required field', async () => {
    const { schema } = await loadSchema();
    for (const field of ['goal', 'explicit_requests', 'success', 'scope']) {
      const clone = structuredClone(SPLIT_UPGRADE_CONTRACT);
      delete clone[field];
      const result = validate(schema, clone);
      expect(result.errors.join('\n'), `missing ${field}`).toMatch(
        new RegExp(`missing required property "${field}"`),
      );
    }
  });

  it('rejects an empty explicit_requests list', async () => {
    const { schema } = await loadSchema();
    const clone = structuredClone(SPLIT_UPGRADE_CONTRACT);
    clone.explicit_requests = [];
    expect(validate(schema, clone).errors.join('\n')).toMatch(
      /explicit_requests.*minItems/,
    );
  });

  it('rejects the v1.0 string form of explicit_requests (span is mandatory now)', async () => {
    const { schema } = await loadSchema();
    const clone = structuredClone(SPLIT_UPGRADE_CONTRACT);
    clone.explicit_requests = ['split 을 업그레이드'];
    expect(validate(schema, clone).errors.length).toBeGreaterThan(0);

    const noSpan = structuredClone(SPLIT_UPGRADE_CONTRACT);
    delete noSpan.explicit_requests[0].span;
    expect(validate(schema, noSpan).errors.join('\n')).toMatch(
      /missing required property "span"/,
    );
  });

  it('accepts both mission_id forms and rejects anything else', async () => {
    const { schema } = await loadSchema();
    const withId = (mission_id) => ({ ...SPLIT_UPGRADE_CONTRACT, mission_id });
    // Issued form, the same form past three digits, and the session fallback
    // that keeps ledger envelopes whole.
    expect(validate(schema, withId('M-20260902-001')).errors).toEqual([]);
    expect(validate(schema, withId('M-20260902-1001')).errors).toEqual([]);
    expect(validate(schema, withId('M-20260902-Styc5j4aa')).errors).toEqual([]);
    for (const bad of ['M-2026-001', 'M-20260902-1', 'X-20260902-001', 'M-20260902-S123']) {
      expect(validate(schema, withId(bad)).errors.length, bad).toBeGreaterThan(0);
    }
  });

  it('accepts a sequence past three digits, so a busy day cannot overflow the id space', async () => {
    const { schema } = await loadSchema();
    // Regression guard: a fixed {3} quantifier rejected M-20260902-1001 and
    // silently broke the join to the ledger, whose pattern allows {3,}.
    for (const id of ['M-20260902-001', 'M-20260902-1001', 'M-20260902-99999']) {
      expect(validate(schema, { ...SPLIT_UPGRADE_CONTRACT, mission_id: id }).errors, id).toEqual([]);
    }
  });

  it('keeps mission_id byte-identical to the ledger envelope and review schemas', async () => {
    const { schema } = await loadSchema();
    const mine = schema.properties.mission_id.pattern;

    // The three schemas must agree exactly. Comparing the parsed string (not a
    // hardcoded literal) means a change to any one of them fails here, rather
    // than drifting until a real mission_id fails to join across them.
    let compared = 0;
    for (const file of ['ledger-envelope.schema.json', 'review-output.schema.json']) {
      let sibling;
      try {
        sibling = JSON.parse(
          await readFile(path.resolve(__dirname, `../../schemas/${file}`), 'utf-8'),
        );
      } catch {
        continue; // that lane has not landed the file yet
      }
      for (const theirs of collectMissionIdPatterns(sibling)) {
        expect(mine, `mission_id pattern must match ${file}`).toBe(theirs);
        compared += 1;
      }
    }

    // Guard the guard: if neither sibling could be read, this test would pass
    // while comparing nothing. Assert the canonical literal in that case.
    if (compared === 0) {
      expect(mine).toBe('^M-\\d{8}-(?:\\d{3,}|S[0-9A-Za-z]{8})$');
    }
  });

  it('rejects out-of-vocabulary status and topology.mode', async () => {
    const { schema } = await loadSchema();
    const badStatus = { ...SPLIT_UPGRADE_CONTRACT, status: 'done' };
    expect(validate(schema, badStatus).errors.length).toBeGreaterThan(0);
    const badTopology = { ...SPLIT_UPGRADE_CONTRACT, topology: { mode: 'swarm' } };
    expect(validate(schema, badTopology).errors.length).toBeGreaterThan(0);
  });

  it('rejects intent_confidence values outside 0..1', async () => {
    const { schema } = await loadSchema();
    const clone = structuredClone(SPLIT_UPGRADE_CONTRACT);
    clone.intent_confidence.goal = 1.4;
    expect(validate(schema, clone).errors.join('\n')).toMatch(/above maximum/);
  });

  it('rejects an unknown top-level field', async () => {
    const { schema } = await loadSchema();
    const clone = { ...SPLIT_UPGRADE_CONTRACT, invented_field: true };
    expect(validate(schema, clone).errors.join('\n')).toMatch(
      /unexpected property "invented_field"/,
    );
  });

  it('reports execution_profile as the only unvalidated subtree', async () => {
    const { schema } = await loadSchema();
    const clone = {
      ...SPLIT_UPGRADE_CONTRACT,
      execution_profile: { anything: 'unchecked until T-18' },
    };
    const result = validate(schema, clone);
    expect(result.errors).toEqual([]);
    expect(result.unvalidated).toEqual(['(root).execution_profile']);
  });
});

// ---------------------------------------------------------------------------
// ajv cross-check — corroborates the subset validator, skipped if ajv is gone
// ---------------------------------------------------------------------------

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to DECLARE the dependency, and
 * the wrong one — restoring the skip — is the one that looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so agreement between the subset validator and a real draft-07 validator cannot be enforced and this gate',
  'proves nothing. ajv is only a TRANSITIVE dependency here (eslint -> ajv);',
  "package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

describe('mission-contract.schema.json — ajv agrees with the subset validator', () => {
  /**
   * @param {boolean} withT18 register T-18's schema so the execution_profile
   *   $ref actually resolves. When false (or T-18 absent) the ref is ignored,
   *   matching the subset validator's deferral.
   */
  async function compile({ withT18 = false } = {}) {
    // Throws rather than returning null: a null validator would turn every
    // assertion below into "ajvValidate is not a function", which buries the
    // real cause. Throwing makes each test fail with the fix instruction.
    if (Ajv === null) throw new Error(AJV_MISSING);
    const { schema } = await loadSchema();
    // ajv 6's bundled meta-schema does not register the draft-07 $id URI, so
    // drop $schema to avoid a meta-ref miss.
    const clone = JSON.parse(JSON.stringify(schema));
    delete clone.$schema;
    // `logger: false` only suppresses ajv's stderr notice about an ignored
    // ref, which would otherwise print on every full-suite run.
    const ajv = new Ajv({ allErrors: true, missingRefs: 'ignore', logger: false });
    if (withT18) {
      const t18 = await loadExecutionProfileSchema();
      if (!t18) return null;
      const t18Clone = JSON.parse(JSON.stringify(t18));
      delete t18Clone.$schema;
      ajv.addSchema(t18Clone); // registered under its own $id
    }
    return ajv.compile(clone);
  }

  /** Every fixture this file asserts on, with the verdict it expects. */
  function cases() {
    const noTarget = contractWithEmptyRequestedTarget();
    const stringRequests = structuredClone(SPLIT_UPGRADE_CONTRACT);
    stringRequests.explicit_requests = ['split 을 업그레이드'];
    const noSpan = structuredClone(SPLIT_UPGRADE_CONTRACT);
    delete noSpan.explicit_requests[0].span;
    const badConfidence = structuredClone(SPLIT_UPGRADE_CONTRACT);
    badConfidence.intent_confidence.goal = 1.4;

    return [
      ['split upgrade contract', SPLIT_UPGRADE_CONTRACT, true],
      ['empty requested_target', noTarget, false],
      ['v1.0 string explicit_requests', stringRequests, false],
      ['explicit_request without span', noSpan, false],
      ['confidence above 1', badConfidence, false],
      ['unknown top-level field', { ...SPLIT_UPGRADE_CONTRACT, nope: 1 }, false],
      ['bad status', { ...SPLIT_UPGRADE_CONTRACT, status: 'done' }, false],
      ['bad topology mode', { ...SPLIT_UPGRADE_CONTRACT, topology: { mode: 'swarm' } }, false],
      ['session fallback mission_id', { ...SPLIT_UPGRADE_CONTRACT, mission_id: 'M-20260902-Styc5j4aa' }, true],
      ['malformed mission_id', { ...SPLIT_UPGRADE_CONTRACT, mission_id: 'M-2026-001' }, false],
      ['semver schema_version (T-19 says integer)', { ...SPLIT_UPGRADE_CONTRACT, schema_version: '1.0.0' }, false],
    ];
  }

  it('has a real oracle — present, and able to say NO as well as YES', async () => {
    // The assertion IS the fail-closed statement: when ajv is gone this block
    // goes red and prints the fix, instead of the suite quietly dropping the
    // corroboration this file's own header says it must never be without.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');

    // A second opinion that agrees with everything is not a second opinion:
    // every agreement below would hold against a vacuous validator. Demanding
    // both directions is what makes the agreement worth reading.
    const ajvValidate = await compile();
    expect(ajvValidate(SPLIT_UPGRADE_CONTRACT)).toBe(true);
    expect(ajvValidate({ ...SPLIT_UPGRADE_CONTRACT, nope: 1 })).toBe(false);
  });

  it('reaches the same verdict as the subset validator on every fixture', async () => {
    const { schema } = await loadSchema();
    const ajvValidate = await compile();
    // Every fixture here is execution_profile-free, so the one subtree the
    // subset validator defers on cannot mask a disagreement.
    for (const [name, instance, expected] of cases()) {
      expect(instance.execution_profile, `${name}: fixture must be profile-free`).toBeUndefined();
      const mine = isValid(schema, instance);
      const theirs = ajvValidate(instance);
      expect(mine, `${name}: subset validator`).toBe(expected);
      expect(theirs, `${name}: ajv`).toBe(expected);
    }
  });

  it('resolves the execution_profile $ref once T-18 is registered', async () => {
    const { schema } = await loadSchema();
    const ajvValidate = await compile({ withT18: true });
    if (!ajvValidate) return; // T-18 has not landed; nothing to resolve against

    const withProfile = (execution_profile) => ({
      ...SPLIT_UPGRADE_CONTRACT,
      execution_profile,
    });

    // Resolution is real: T-18's own constraints now bite through the $ref.
    expect(ajvValidate(withProfile({}))).toBe(true);
    expect(ajvValidate(withProfile('not-an-object'))).toBe(false);
    expect(ajvValidate(withProfile({ not_a_profile_key: 1 }))).toBe(false);

    // And this is precisely the hole the subset validator has: it reports the
    // subtree as unchecked instead of judging it. Asserted, not glossed over.
    const deferred = validate(schema, withProfile({ not_a_profile_key: 1 }));
    expect(deferred.errors).toEqual([]);
    expect(deferred.unvalidated).toEqual(['(root).execution_profile']);
  });
});
