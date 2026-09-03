/**
 * Receipt schemas — Route / Attempt / Context.
 *
 * Guards the three §8.2 envelope-data contracts:
 *   schemas/route-receipt.schema.json    -> ledger event `route.selected`.data
 *   schemas/attempt-receipt.schema.json  -> ledger event `usage.receipt`.data
 *   schemas/context-receipt.schema.json  -> ledger event `context.compiled`.data
 *
 * Two layers:
 *  (a) structural assertions read the JSON directly, so the field-alignment
 *      contract (lane 2 §4.5) is asserted even when ajv is absent;
 *  (b) behavioural assertions compile the schemas with ajv and check that a
 *      valid example passes and each prescribed violation FAILS.
 *
 * THE ORACLE IS REQUIRED, NOT OPTIONAL. ajv is the only thing here that can
 * read a schema; without it layer (b) is not weaker, it is ABSENT. An earlier
 * revision of this file wrapped layer (b) in `describe.skipIf(!Ajv)`, so a run
 * with NO schema validation at all reported the same green as a run with the
 * full set. It now goes RED instead: every behavioural test runs
 * unconditionally, and a missing oracle surfaces as {@link AJV_MISSING}.
 * Pattern adopted from tests/firewall/usage-receipt-schema-guard.test.js
 * (T-32), which names this file's old skip as the same hole.
 *
 * ajv reaches us only as a TRANSITIVE dependency (`eslint -> ajv`, measured
 * 2026-09-03: package.json declares no `ajv`; package-lock pins 6.15.0 under
 * eslint@10.2.1 while the installed tree on disk is 6.12.6), so an eslint bump
 * can remove the oracle with nothing else changing. The fix when that happens
 * is to DECLARE ajv as a devDependency — never to restore the skip.
 *
 * WHAT THIS GATE DOES NOT COVER (do not read a green run as more than this):
 *  - No writer exists yet. Nothing here proves a receipt is ever produced, or
 *    that a produced receipt is appended to the ledger.
 *  - It cannot tell a measured value from an invented one: `measured: false`
 *    is required to be PRESENT, and its truthfulness is the writer's problem.
 *  - The examples are synthetic, hand-written to satisfy the schema. They say
 *    the contract is SATISFIABLE, not that any real producer satisfies it.
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
const SCHEMA_DIR = path.resolve(__dirname, '../../schemas');

async function loadSchema(file) {
  return JSON.parse(await readFile(path.join(SCHEMA_DIR, file), 'utf-8'));
}

const routeSchema = await loadSchema('route-receipt.schema.json');
const attemptSchema = await loadSchema('attempt-receipt.schema.json');
const contextSchema = await loadSchema('context-receipt.schema.json');

const DECISION_TYPES = ['route', 'pin', 'switch', 'escalate', 'downgrade'];
const COST_TERMS = [
  'contextSerialization',
  'contextRebuild',
  'cacheLoss',
  'handoffTokens',
  'handoffLatency',
  'reorientationRisk',
  'expectedRetry',
];
const ACTION_CLASSES = [
  'classify',
  'status',
  'explore',
  'edit-routine',
  'implement',
  'complex-debug',
  'architecture',
  'review',
];
const MODEL_IDENTITY_FIELDS = [
  'provider',
  'family',
  'tier',
  'model_id',
  'version',
  'catalog_version',
];

/** Deep clone so a mutation in one case cannot leak into another. */
const clone = (value) => JSON.parse(JSON.stringify(value));

const modelIdentity = () => ({
  provider: 'anthropic',
  family: 'claude',
  tier: 'opus',
  model_id: 'claude-opus-5',
  version: '2026-05-01',
  catalog_version: '2026-09-02',
});

const term = (value, measured) => ({ value, measured });

/** Valid Route Receipt: a Phase 0 (Observe) `pin`, estimates unmeasured. */
const routeExample = () => ({
  schema_version: 1,
  route_receipt_id: 'rr-0001',
  mission_id: 'm-0001',
  session_id: 's-0001',
  execution_profile_version: 3,
  routing_epoch_id: 'run-0001',
  action: { type: 'implement', phase: 'build', complexity: 0.62 },
  models: {
    current: null,
    recommended: { ...modelIdentity(), tier: 'fable', model_id: 'claude-fable-5-1' },
    selected: modelIdentity(),
  },
  decision: { type: 'pin' },
  predicted: { success: 0.8, cost: 0.12, latency: 4200, retry_probability: 0.1 },
  transition: {
    context_rebuild_tokens: 0,
    cache_loss_estimate: 0,
    handoff_tokens: 0,
    predicted_time_ms: 0,
    predicted_cost: 0,
  },
  terms: {
    contextSerialization: term(120, true),
    contextRebuild: term(2400, true),
    cacheLoss: term(0, true),
    handoffTokens: term(1800, true),
    handoffLatency: term(0, false),
    reorientationRisk: term(0.2, false),
    expectedRetry: term(0.05, false),
  },
  actionsSinceSwitch: 3,
  reason: ['policy_pin', 'profile_change'],
  timestamp: '2026-09-02T06:29:36.000Z',
});

/** Valid Attempt Receipt: transcript-sourced, unverified pricing (cost null). */
const attemptExample = () => ({
  schema_version: 1,
  run_id: 'run-0001',
  mission_id: 'm-0001',
  model_identity: modelIdentity(),
  usage: {
    source: 'transcript',
    fresh_input_tokens: 12000,
    cached_input_tokens: 88000,
    cache_creation_tokens: 4000,
    output_tokens: 2600,
    thinking_tokens: 900,
    requests: 7,
  },
  timing: {
    started_at: '2026-09-02T06:29:36.000Z',
    completed_at: '2026-09-02T06:31:02.000Z',
    latency_ms: 86000,
  },
  outcome: { status: 'completed', verifier_result: 'pass', accepted: null },
  cost: { total: null, pricing_version: 'catalog-2026-09-02' },
});

/** Valid Context Receipt. */
const contextExample = () => ({
  schema_version: 1,
  context_receipt_id: 'cr-0001',
  mission_id: 'm-0001',
  based_on: { intent_revision: 2, plan_revision: 5 },
  input_tokens: 104000,
  transforms: {
    dedup: -3200,
    tool_compression: -8100,
    history_trim: -12000,
    memory_add: 1400,
    project_knowledge_add: 900,
  },
  protected_sections: ['constitution', 'active-plan'],
  output_tokens: 83000,
  cache: { provider: 'anthropic', hit_tokens: 88000, created_tokens: 4000 },
  strategy_version: 1,
});

describe('receipt schemas — structural contract', () => {
  const cases = [
    ['route-receipt.schema.json', routeSchema, 'RouteReceipt', 'route.selected'],
    ['attempt-receipt.schema.json', attemptSchema, 'AttemptReceipt', 'usage.receipt'],
    ['context-receipt.schema.json', contextSchema, 'ContextReceipt', 'context.compiled'],
  ];

  it.each(cases)('%s is a draft-07 schema with a matching $id', (file, schema, title) => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$id).toBe(file);
    expect(schema.title).toBe(title);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(cases)(
    '%s pins schema_version to 1 and names its envelope event',
    (file, schema, title, event) => {
      expect(schema.properties.schema_version.const).toBe(1);
      expect(schema.required).toContain('schema_version');
      // §8.2: these are envelope `data` schemas, not standalone artifacts.
      expect(schema.description).toContain(event);
      expect(schema.description).toContain('NOT a standalone file');
    },
  );

  it('route receipt fixes the five §40 decision types as an allowlist', () => {
    expect(routeSchema.properties.decision.properties.type.enum).toEqual(DECISION_TYPES);
    expect(routeSchema.properties.decision.required).toContain('type');
  });

  it('route receipt closes action.type to the eight behaviour aliases', () => {
    const actionType = routeSchema.properties.action.properties.type;
    expect(actionType.enum).toEqual(ACTION_CLASSES);
    // Tier mapping is policy (T-27 action-classifier), not schema.
    expect(actionType.description).toContain('policy decision');
    expect(actionType.description).not.toContain('haiku');
  });

  it('route receipt carries the seven §28 cost terms, each requiring measured', () => {
    const terms = routeSchema.properties.terms;
    expect(Object.keys(terms.properties)).toEqual(COST_TERMS);
    expect(terms.required).toEqual(COST_TERMS);
    expect(terms.additionalProperties).toBe(false);
    for (const name of COST_TERMS) {
      expect(terms.properties[name].$ref).toBe('#/definitions/cost_term');
    }
    expect(routeSchema.definitions.cost_term.required).toEqual(['value', 'measured']);
    expect(routeSchema.definitions.cost_term.properties.measured.type).toBe('boolean');
  });

  it('route receipt admits the shadow line and conditions shadow_of on it', () => {
    // design §3.6 / ARTIBOT-5.0-DESIGN.md §3.6 — the learner appends
    // route.selected{source:'shadow', shadow_of} beside the production line.
    expect(routeSchema.properties.source.enum).toEqual(['production', 'shadow']);
    expect(routeSchema.properties.source.default).toBe('production');
    expect(routeSchema.required).not.toContain('source');
    expect(routeSchema.required).not.toContain('shadow_of');
    expect(routeSchema.allOf).toEqual([
      {
        if: { properties: { source: { const: 'shadow' } }, required: ['source'] },
        then: { required: ['shadow_of'] },
      },
    ]);
  });

  it('route receipt counts handoff in tokens, never bytes', () => {
    const transition = routeSchema.properties.transition;
    expect(transition.required).toContain('handoff_tokens');
    expect(Object.keys(transition.properties)).not.toContain('handoff_bytes');
    expect(transition.additionalProperties).toBe(false);
  });

  it('route receipt requires the four predicted terms, the epoch id and the residency counter', () => {
    expect(routeSchema.properties.predicted.required).toEqual([
      'success',
      'cost',
      'latency',
      'retry_probability',
    ]);
    expect(routeSchema.required).toEqual(
      expect.arrayContaining([
        'routing_epoch_id',
        'execution_profile_version',
        'actionsSinceSwitch',
        'predicted',
        'terms',
      ]),
    );
  });

  it.each([
    ['route-receipt.schema.json', routeSchema],
    ['attempt-receipt.schema.json', attemptSchema],
  ])('%s defines the six-field model identity', (_file, schema) => {
    const identity = schema.definitions.model_identity;
    expect(identity.required).toEqual(MODEL_IDENTITY_FIELDS);
    expect(identity.additionalProperties).toBe(false);
    // Tier allowlist mirrors lib/core/model-catalog.js MODELS keys.
    expect(identity.properties.tier.enum).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
  });

  it('attempt receipt requires usage.source and cost.pricing_version', () => {
    expect(attemptSchema.properties.usage.required).toContain('source');
    expect(attemptSchema.properties.usage.properties.source.enum).toEqual([
      'transcript',
      'otlp',
      'estimate',
    ]);
    expect(attemptSchema.properties.cost.required).toEqual(['total', 'pricing_version']);
    // A null total must stay expressible while pricing is unverified.
    expect(attemptSchema.properties.cost.properties.total.type).toEqual(['number', 'null']);
    expect(attemptSchema.properties.outcome.properties.accepted.type).toEqual([
      'boolean',
      'null',
    ]);
  });

  it('context receipt requires the five §41 transforms and the cache block', () => {
    expect(contextSchema.properties.transforms.required).toEqual([
      'dedup',
      'tool_compression',
      'history_trim',
      'memory_add',
      'project_knowledge_add',
    ]);
    expect(contextSchema.properties.transforms.additionalProperties).toBe(false);
    expect(contextSchema.properties.cache.required).toEqual([
      'provider',
      'hit_tokens',
      'created_tokens',
    ]);
    expect(contextSchema.properties.based_on.required).toEqual([
      'intent_revision',
      'plan_revision',
    ]);
  });
});

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to declare the dependency, and
 * the wrong one (skipping or deleting the assertions) is the response that
 * looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so the three receipt schemas cannot be enforced',
  'and this gate proves nothing. ajv is only a TRANSITIVE dependency here',
  "(eslint -> ajv); package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

describe('receipt schemas — ajv validation', () => {
  // Not `null` when ajv is absent: a null validator turns every assertion
  // below into "validateRoute is not a function", which buries the real cause.
  // Throwing stubs make each test fail with the instruction instead.
  const compile = (schema) => (Ajv === null
    ? () => {
      throw new Error(AJV_MISSING);
    }
    : new Ajv({ allErrors: true }).compile(schema));
  const validateRoute = compile(routeSchema);
  const validateAttempt = compile(attemptSchema);
  const validateContext = compile(contextSchema);

  it('has a real oracle that both accepts and rejects', () => {
    // Oracle presence: a missing ajv is a FAILURE here, never a skip.
    expect(Ajv, AJV_MISSING).not.toBeNull();
    // Rejection capability: a validator that returns true for everything
    // would make every other assertion in this block vacuous.
    expect(validateRoute({})).toBe(false);
    expect(validateAttempt({ schema_version: 1 })).toBe(false);
    expect(validateContext({ schema_version: 99 })).toBe(false);
    // ...and it is not simply rejecting everything.
    expect(validateRoute(routeExample())).toBe(true);
    expect(validateAttempt(attemptExample())).toBe(true);
    expect(validateContext(contextExample())).toBe(true);
  });

  const expectValid = (validate, doc) => {
    const ok = validate(doc);
    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(ok).toBe(true);
  };

  it('accepts the three canonical examples', () => {
    expectValid(validateRoute, routeExample());
    expectValid(validateAttempt, attemptExample());
    expectValid(validateContext, contextExample());
  });

  it('rejects an attempt receipt with no usage.source', () => {
    const doc = attemptExample();
    delete doc.usage.source;
    expect(validateAttempt(doc)).toBe(false);
  });

  it('rejects an unknown usage.source grade', () => {
    const doc = attemptExample();
    doc.usage.source = 'guess';
    expect(validateAttempt(doc)).toBe(false);
  });

  it('rejects an attempt receipt with no cost.pricing_version', () => {
    const doc = attemptExample();
    delete doc.cost.pricing_version;
    expect(validateAttempt(doc)).toBe(false);
  });

  it('rejects a model identity missing catalog_version, and an unknown tier', () => {
    const missing = attemptExample();
    delete missing.model_identity.catalog_version;
    expect(validateAttempt(missing)).toBe(false);

    const badTier = attemptExample();
    badTier.model_identity.tier = 'gpt';
    expect(validateAttempt(badTier)).toBe(false);
  });

  it.each(DECISION_TYPES)('accepts decision.type %s', (type) => {
    const doc = routeExample();
    doc.decision.type = type;
    expectValid(validateRoute, doc);
  });

  it.each(ACTION_CLASSES)('accepts action.type %s', (actionClass) => {
    const doc = routeExample();
    doc.action.type = actionClass;
    expectValid(validateRoute, doc);
  });

  it('rejects an action class outside the eight-value allowlist', () => {
    const doc = routeExample();
    // A plausible-looking near-miss: the repo config spells this
    // `complex-debugging` (artibot.config.json:61) while the receipt
    // vocabulary is `complex-debug`.
    doc.action.type = 'complex-debugging';
    expect(validateRoute(doc)).toBe(false);
  });

  it('accepts a shadow line only when it names the production line it mirrors', () => {
    // Production writers keep working with no source field at all.
    expectValid(validateRoute, routeExample());

    const production = routeExample();
    production.source = 'production';
    expectValid(validateRoute, production);

    const shadow = routeExample();
    shadow.source = 'shadow';
    shadow.shadow_of = '1487';
    expectValid(validateRoute, shadow);

    const orphan = routeExample();
    orphan.source = 'shadow';
    expect(validateRoute(orphan)).toBe(false);
  });

  it('rejects a decision.type outside the five-value allowlist', () => {
    const doc = routeExample();
    doc.decision.type = 'fallback';
    expect(validateRoute(doc)).toBe(false);
  });

  it('rejects a cost term without its measured flag', () => {
    const doc = routeExample();
    delete doc.terms.cacheLoss.measured;
    expect(validateRoute(doc)).toBe(false);
  });

  it('rejects a receipt missing one of the seven cost terms', () => {
    const doc = routeExample();
    delete doc.terms.expectedRetry;
    expect(validateRoute(doc)).toBe(false);
  });

  it('rejects handoff measured in bytes instead of tokens', () => {
    const doc = routeExample();
    delete doc.transition.handoff_tokens;
    doc.transition.handoff_bytes = 7400;
    expect(validateRoute(doc)).toBe(false);
  });

  it('rejects a route receipt with no residency counter or epoch id', () => {
    const noCounter = routeExample();
    delete noCounter.actionsSinceSwitch;
    expect(validateRoute(noCounter)).toBe(false);

    const noEpoch = routeExample();
    delete noEpoch.routing_epoch_id;
    expect(validateRoute(noEpoch)).toBe(false);
  });

  it('keeps an absent incumbent expressible as null but not omittable', () => {
    const withCurrent = routeExample();
    withCurrent.models.current = modelIdentity();
    expectValid(validateRoute, withCurrent);

    const omitted = routeExample();
    delete omitted.models.current;
    expect(validateRoute(omitted)).toBe(false);
  });

  it('accepts a null accepted label and a null cost total', () => {
    const doc = attemptExample();
    doc.outcome.accepted = null;
    doc.cost.total = null;
    expectValid(validateAttempt, doc);

    const labelled = clone(doc);
    labelled.outcome.accepted = true;
    labelled.cost.total = 1.42;
    expectValid(validateAttempt, labelled);
  });

  it('rejects a context receipt missing a transform or a based_on revision', () => {
    const noTransform = contextExample();
    delete noTransform.transforms.history_trim;
    expect(validateContext(noTransform)).toBe(false);

    const noRevision = contextExample();
    delete noRevision.based_on.plan_revision;
    expect(validateContext(noRevision)).toBe(false);
  });

  it('rejects an unknown top-level field on every receipt', () => {
    const route = routeExample();
    route.handoffBytes = 10;
    expect(validateRoute(route)).toBe(false);

    const attempt = attemptExample();
    attempt.total_cost = 1;
    expect(validateAttempt(attempt)).toBe(false);

    const context = contextExample();
    context.tokens = 1;
    expect(validateContext(context)).toBe(false);
  });
});
