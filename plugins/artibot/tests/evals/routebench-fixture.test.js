/**
 * RouteBench BASELINE DEFINITION gate - `tests/evals/fixtures/routebench/`.
 *
 * What this file proves
 * ---------------------
 *  1. `baselines.schema.json` is a draft-07 document that a real validator
 *     (ajv 6) can compile, and `baselines.json` validates against it. Draft-07
 *     is not a style choice: ajv resolves here at 6.x, which cannot compile
 *     2020-12 - the same constraint `scenarios.schema.json:5` records.
 *  2. The mandatory/optional split of MODEL-SWITCHING-SCORECARD.md section 11
 *     is encoded as data. The scorecard lists B0..B4 under "반드시 비교"
 *     (must compare) and B5..B6 under "선택" (optional). A JSON Schema `enum`
 *     can say WHICH ids exist but not WHICH are mandatory, so the split lives
 *     in a per-item `required` boolean and is asserted here.
 *  3. The schema REJECTS the shapes it is supposed to reject. Six negative
 *     controls run through the same compiled validator, because a validator
 *     nobody fed bad input to is the next false green.
 *  4. B2's resolver still points at `lib/core/model-policy.js#resolveModel`.
 *     Design ARTIBOT-5.0-DESIGN.md:513 G4 adopts "resolveModel 2티어 그대로"
 *     as B2, so B2 is a CALL into the live policy, never a transcription of
 *     it. A copy would drift and stop being the Shadow control group.
 *  5. Every `module` resolver names a file that exists under the plugin root
 *     AND an export that is actually a function there - checked by really
 *     importing the module. "The file exists" and "the export works" are two
 *     different statements; this block makes both.
 *  6. `scenarios.schema.json` admits an optional `agentType`, and all six lines
 *     of `scenarios.example.jsonl` validate. The two ORIGINAL examples still
 *     declare no `agentType`, which is what keeps the property optional rather
 *     than a breaking change; the four live rows each declare one and it
 *     matches every row of the corpus they point at.
 *  7. The baseline id vocabulary is single-sourced: the ids in `baselines.json`
 *     equal `scenarios.schema.json#/properties/baselines/items/enum`. Two files
 *     naming baselines independently is exactly how B5 ends up meaning two
 *     different things.
 *  8. Owner decision 3 (2026-09-14) - B4 feeds `scenario.agentType` to
 *     `routeModel` as `input.agentType` - is recorded as REQUIRED data at
 *     `agent_type_supply.b4_input`, not only as prose in a note, so a later
 *     registry edit cannot drop the decision and still validate.
 *
 * What this file does NOT see
 * ---------------------------
 *  - **Whether any baseline produces good routing.** This directory is
 *    DEFINITION ONLY - nothing here runs a benchmark, and run results live
 *    outside the repo under `_benchmarks/routing/` (gitignored) by design
 *    ARTIBOT-5.0-DESIGN.md §8.2. A green run here says the definitions are
 *    well-formed and reachable, not that B4 beats B2 on anything.
 *  - **Whether B3 and B4 are the baselines the scorecard MEANT.** Section 11
 *    (:730-748) names them and stops; it gives no algorithm. Their resolvers
 *    are marked `definition_confidence: "inferred"` for that reason, and the
 *    inference is written out in each `resolver.note` so a human can re-judge
 *    it. B0, B1, B2, B5 and B6 are `"exact"` - transcribed, not inferred.
 *  - **Whether calling a resolver returns a sensible tier.** Block 5 proves the
 *    export is a function; it does not invoke it. Resolver EXECUTION belongs to
 *    the runner, which does not exist yet.
 *  - **B6.** The Hindsight Oracle needs a recorded OUTCOME per (scenario,
 *    candidate tier). Four scenarios now ship a present corpus, so the old
 *    reason ("no corpus exists") is retired - but a `route.selected` row
 *    records the decision only, `usage.receipt outcome.status` was `unknown`
 *    for 72 of 72 receipts at extraction (2026-09-14T06:15:53Z), and no
 *    receipt is joined to a corpus row. The refusal therefore stands on a NEW
 *    premise, "rows without hindsight", which the B6 test asserts directly so
 *    it cannot go stale again unnoticed. It stays `status: "unimplemented"`
 *    with a written reason so a runner refuses to score it rather than
 *    emitting a placeholder that would look like a measurement.
 *  - **Scenario coverage.** Nothing here asserts that any scenario actually
 *    lists B3 or B4, nor that a corpus is large enough to support any
 *    conclusion - the doc-updater corpus is 6 rows out of `route.selected`
 *    N=185. Row counts are one repository's four-day traffic, not a sample.
 *  - **Whether the runner actually passes `input.agentType`.** Item 8 pins the
 *    DECLARATION in the registry; whether executing code honours it is
 *    `routebench-runner.test.js`. A registry that says `b4_input.agentType:
 *    true` and a runner that omits the field would both be green here.
 *
 * Why ajv rather than the hand-rolled subset validator in
 * `nl-activation-fixture.test.js:176-266`: that validator covers no
 * `if`/`then`/`else`, and the conditional `status` -> `resolver`/`reason`
 * requirement is the single most important thing this schema encodes. Extending
 * the subset would mean hand-writing the one keyword whose correctness the gate
 * depends on. ajv is also no longer transitive-only - `package.json`
 * devDependencies declares `"ajv": "^6.15.0"`, which is what that file's :179
 * comment predates. A missing ajv is therefore a hard RED below, never a skip.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

// Imported defensively at module scope so a missing ajv produces the explicit
// AJV_MISSING failure below instead of an unresolved-import crash whose message
// says nothing about what to do. Same treatment as
// tests/firewall/review-verdict-adapter.test.js:66.
let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const ROUTEBENCH = path.join(HERE, 'fixtures', 'routebench');
const BASELINE_SCHEMA_PATH = path.join(ROUTEBENCH, 'baselines.schema.json');
const BASELINES_PATH = path.join(ROUTEBENCH, 'baselines.json');
const SCENARIO_SCHEMA_PATH = path.join(ROUTEBENCH, 'scenarios.schema.json');
const SCENARIO_EXAMPLES_PATH = path.join(ROUTEBENCH, 'scenarios.example.jsonl');

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/**
 * MODEL-SWITCHING-SCORECARD.md section 11 (:730-748), transcribed.
 *
 * Pinned as literals rather than derived from the fixture, so that flipping a
 * `required` flag in `baselines.json` is red here and has to be argued against
 * the scorecard rather than silently accepted.
 */
const MANDATORY_IDS = Object.freeze(['B0', 'B1', 'B2', 'B3', 'B4']);
const OPTIONAL_IDS = Object.freeze(['B5', 'B6']);

const AJV_MISSING = [
  'ajv could not be resolved, so baselines.schema.json cannot be compiled and',
  'this gate proves nothing. package.json devDependencies declares "ajv":',
  '"^6.15.0" - a missing module means the install is broken.',
  'FIX: restore node_modules. Do NOT skip or delete these assertions.',
].join(' ');

/**
 * Read and parse a JSON file.
 *
 * @param {string} filePath absolute path
 * @returns {Promise<object>} parsed document
 */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

/**
 * Read a JSONL file into `{lineNumber, value}` records, skipping blank lines.
 *
 * @param {string} filePath absolute path
 * @returns {Promise<Array<{lineNumber: number, value: object}>>} records
 */
async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  const records = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    records.push({ lineNumber: index + 1, value: JSON.parse(line) });
  });
  return records;
}

/**
 * Compile a draft-07 document with ajv 6.
 *
 * @param {object} doc schema document
 * @returns {(data: unknown) => boolean} validator
 */
function compile(doc) {
  if (Ajv === null) throw new Error(AJV_MISSING);
  return new Ajv({ allErrors: true }).compile(doc);
}

/** @returns {object} a structural clone safe to mutate in a negative control */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const baselineSchema = await readJson(BASELINE_SCHEMA_PATH);
const baselines = await readJson(BASELINES_PATH);
const scenarioSchema = await readJson(SCENARIO_SCHEMA_PATH);
const scenarioRecords = await readJsonl(SCENARIO_EXAMPLES_PATH);

const byId = new Map(baselines.baselines.map((entry) => [entry.id, entry]));

describe('baselines.schema.json - the schema itself', () => {
  it('declares draft-07 and an $id', () => {
    // Not cosmetic: ajv 6 cannot compile 2020-12, so a schema that drifted to a
    // newer draft would fail to compile rather than validate loosely.
    expect(baselineSchema.$schema).toBe(DRAFT_07);
    expect(typeof baselineSchema.$id).toBe('string');
  });

  it('compiles with ajv', () => {
    expect(Ajv, AJV_MISSING).not.toBeNull();
    expect(typeof compile(baselineSchema)).toBe('function');
  });

  it('closes every object it defines to additional properties', () => {
    // An open object would let a typo-ed key sit in the fixture asserting
    // nothing, which is the fail-open this schema exists to prevent. Checked on
    // the definitions rather than through `items`, because `items` is a bare
    // `$ref` and draft-07 ignores every sibling keyword of a `$ref` - reading
    // `items.additionalProperties` would be asserting a keyword that has no
    // effect, which is a false green about a false green.
    expect(baselineSchema.additionalProperties).toBe(false);
    expect(baselineSchema.properties.baselines.items.$ref).toBe('#/definitions/baseline');
    expect(baselineSchema.definitions.baseline.additionalProperties).toBe(false);
    expect(baselineSchema.properties.agent_type_supply.additionalProperties).toBe(false);
    expect(
      baselineSchema.properties.agent_type_supply.properties.b4_input.additionalProperties,
    ).toBe(false);
    for (const branch of baselineSchema.definitions.resolver.oneOf) {
      expect(branch.additionalProperties, branch.properties.type.const).toBe(false);
    }
  });

  it('explains the mandatory/optional split the enum cannot encode', () => {
    // The reasoning has to travel with the schema; a reader who only opens the
    // JSON must be able to see why `required` is a field and not an enum.
    expect(baselineSchema.description.length).toBeGreaterThan(120);
    expect(baselineSchema.properties.baselines.description.length).toBeGreaterThan(120);
  });
});

describe('baselines.json - validates and matches the scorecard', () => {
  it('validates against its own schema', () => {
    const validator = compile(baselineSchema);
    const ok = validator(baselines);
    expect(JSON.stringify(validator.errors ?? [])).toBe('[]');
    expect(ok).toBe(true);
  });

  it('points $schema at the sibling schema file', () => {
    expect(baselines.$schema).toBe('./baselines.schema.json');
    // Bumped 1 -> 2 when `agent_type_supply.b4_input` became a REQUIRED
    // sub-object. The schema's own `schema_version` description says the
    // number moves when the SHAPE changes, and adding a required property is
    // a shape change - a registry written against v1 is no longer valid.
    expect(baselines.schema_version).toBe(2);
  });

  it('carries exactly B0..B6, each once', () => {
    const ids = baselines.baselines.map((entry) => entry.id);
    expect(ids).toEqual([...MANDATORY_IDS, ...OPTIONAL_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks B0..B4 required and B5..B6 optional, per scorecard section 11', () => {
    // Scorecard section 11 (:730-748): B0..B4 sit under "반드시 비교", B5..B6
    // under "선택". Both directions asserted so widening OR narrowing is red.
    for (const id of MANDATORY_IDS) {
      expect(byId.get(id)?.required, id).toBe(true);
    }
    for (const id of OPTIONAL_IDS) {
      expect(byId.get(id)?.required, id).toBe(false);
    }
  });

  it('names its sources and its agentType decision', () => {
    // Same discipline as `source` on an nl-activation case: an expectation with
    // no stated origin cannot be re-judged later.
    expect(baselines.source).toContain('MODEL-SWITCHING-SCORECARD.md');
    expect(baselines.agent_type_supply.decision).toBe('scenario.agentType');
    expect(baselines.agent_type_supply.why.length).toBeGreaterThan(80);
  });

  it('records the B4 input decision as data, not only as prose', () => {
    // Owner decision 3 (2026-09-14) settled a question the earlier note left
    // open: B4 supplies `scenario.agentType` to `routeModel` as
    // `input.agentType`. It lives in a REQUIRED sub-object rather than only
    // inside `why`, so a later registry edit cannot drop the decision while
    // still validating - which is exactly how a settled question reopens
    // itself silently.
    const b4Input = baselines.agent_type_supply.b4_input;
    expect(b4Input.agentType).toBe(true);
    expect(typeof b4Input.decision).toBe('string');
    expect(b4Input.decision.length).toBeGreaterThan(0);
    expect(b4Input.why.length).toBeGreaterThan(80);
  });

  it('feeds agentType into B4 as input.agentType and still reads models.recommended', () => {
    // Two claims, both needed. The first is the decision: the agent name now
    // reaches the classifier, so the action class comes from
    // AGENT_ACTION_CLASS instead of the implement default. The second is that
    // only the INPUT moved - B4 is still `models.recommended`, not
    // `models.selected` (that is B2).
    const call = byId.get('B4').resolver.call;
    expect(call).toContain('input: { agentType: scenario.agentType }');
    expect(call).toContain('models.recommended');
  });

  it('keeps B4 inferred and says the decision fixed the input, not the algorithm', () => {
    // `exact` means transcribed from the source document. Owner decision 3
    // named the input; it did not write B4's algorithm into the scorecard, so
    // `routeModel(...).models.recommended` remains this repo's reading and
    // the confidence field must not be upgraded on the strength of a decision
    // about something else.
    const b4 = byId.get('B4');
    expect(b4.definition_confidence).toBe('inferred');
    expect(b4.resolver.note).toContain('decision 3');
    expect(b4.resolver.note).toContain('2026-09-14');
    expect(b4.resolver.note).toContain('not the algorithm');
    expect(b4.resolver.note).toContain('inferred');
  });

  it('labels B3 and B4 as inferred and the rest as exact', () => {
    // Section 11 names B3/B4 without defining them algorithmically, so their
    // resolvers are a reading of the repo, not a transcription of the doc.
    // Recording that distinction is the whole point of the field.
    const inferred = baselines.baselines
      .filter((entry) => entry.definition_confidence === 'inferred')
      .map((entry) => entry.id);
    expect(inferred).toEqual(['B3', 'B4']);
    for (const id of inferred) {
      expect(byId.get(id).resolver.note.length, id).toBeGreaterThan(80);
    }
  });

  it('refuses to implement B6 and says why instead of faking it', async () => {
    const b6 = byId.get('B6');
    expect(b6.status).toBe('unimplemented');
    expect(b6.resolver).toBeUndefined();
    expect(b6.reason.length).toBeGreaterThan(80);
    // The premise of that refusal, measured rather than asserted from memory.
    //
    // It USED to be "no scenario has a present fixture". That is no longer
    // true: four live scenarios ship scrubbed corpora extracted from the run
    // ledger. The refusal survives anyway, and the reason is worth being exact
    // about — B6 needs an OUTCOME per (scenario, candidate tier), and a
    // `route.selected` row records the decision only. So the premise moved
    // from "no rows" to "rows without hindsight" and the verdict did not.
    // Loosening this test to stop checking the premise would have hidden that.
    const present = scenarioRecords
      .filter((r) => r.value.fixture?.status === 'present')
      .map((r) => r.value.id)
      .sort();
    expect(present).toEqual([
      'live-code-reviewer-review',
      'live-doc-updater-edit-routine',
      'live-investigator-explore',
      'live-tdd-guide-implement',
    ]);
    // A present fixture must be a file that exists and holds at least one row,
    // otherwise `status: "present"` is the empty-fixture lie the schema's
    // `pending` value exists to prevent.
    for (const record of scenarioRecords.filter((r) => r.value.fixture?.status === 'present')) {
      const corpusPath = path.join(PLUGIN_ROOT, record.value.fixture.path);
      expect(existsSync(corpusPath), record.value.id).toBe(true);
       
      const rows = (await readFile(corpusPath, 'utf-8')).split('\n').filter((l) => l.trim());
      expect(rows.length, record.value.id).toBeGreaterThan(0);
    }
    // And no corpus row may carry an outcome — that is the whole reason B6
    // still refuses. A row that grew one must turn this red so someone
    // revisits the refusal instead of leaving it stale.
    const investigator = path.join(
      PLUGIN_ROOT, 'tests/evals/fixtures/routebench/corpus/live-investigator-explore.jsonl',
    );
    const firstRow = JSON.parse((await readFile(investigator, 'utf-8')).split('\n')[0]);
    expect(Object.keys(firstRow)).not.toContain('outcome');
    expect(firstRow.decision.type).toBe('route');
  });

  it('keeps B2 pinned to the live policy module, per design G4', () => {
    // ARTIBOT-5.0-DESIGN.md:513 G4 adopts "resolveModel 2티어 그대로" as B2.
    // B2 is the Shadow control group, so it must CALL the policy. A copied
    // reimplementation would drift and stop being a control for anything.
    const b2 = byId.get('B2');
    expect(b2.resolver.type).toBe('module');
    expect(b2.resolver.module).toBe('lib/core/model-policy.js');
    expect(b2.resolver.export).toBe('resolveModel');
    expect(b2.resolver.call).toContain('scenario.agentType');
  });

  it('gives every fixed baseline a constant tier in the model vocabulary', () => {
    const tiers = new Set(['haiku', 'sonnet', 'opus', 'fable']);
    for (const entry of baselines.baselines.filter((e) => e.kind === 'fixed')) {
      expect(entry.resolver.type, entry.id).toBe('constant');
      expect(tiers.has(entry.resolver.tier), `${entry.id} tier`).toBe(true);
    }
  });
});

describe('baselines.schema.json - negative controls', () => {
  // Each control mutates a clone of the real fixture, so a control that stops
  // being a control (because the schema loosened) goes red here rather than
  // passing quietly on a straw-man document.
  const validator = compile(baselineSchema);

  it('accepts the unmutated fixture', () => {
    expect(validator(clone(baselines))).toBe(true);
  });

  it('rejects a document missing B2', () => {
    // Required-membership is NOT expressible with `enum` alone; the schema has
    // to pin the length and `contains`-style presence, and this proves it does.
    const doc = clone(baselines);
    doc.baselines = doc.baselines.filter((entry) => entry.id !== 'B2');
    expect(validator(doc)).toBe(false);
  });

  it('rejects a full-length document that swaps B2 for a second B5', () => {
    // Isolates the `contains` clauses from `minItems`. The control above loses
    // an item, so a schema with NO membership check would still reject it on
    // length and the control would prove nothing about completeness. Here the
    // array keeps all seven entries and stays unique, so only a real
    // per-id membership assertion can catch the missing B2.
    const doc = clone(baselines);
    const at = doc.baselines.findIndex((entry) => entry.id === 'B2');
    doc.baselines[at] = { ...clone(byId.get('B5')), name: 'Fixed Fable (impostor)' };
    expect(doc.baselines).toHaveLength(7);
    expect(new Set(doc.baselines.map((e) => JSON.stringify(e))).size).toBe(7);
    expect(validator(doc)).toBe(false);
  });

  it('rejects an id outside B0..B6', () => {
    const doc = clone(baselines);
    doc.baselines[0].id = 'B7';
    expect(validator(doc)).toBe(false);
  });

  it('rejects a duplicated baseline entry on uniqueItems, not on length', () => {
    // The earlier version of this control PUSHED a copy, giving 8 items, so
    // `maxItems: 7` alone rejected it and `uniqueItems` was never exercised.
    // Here B1 is OVERWRITTEN with a second B0: the array stays at exactly seven
    // items, so length cannot be the reason, and the error list is inspected
    // rather than just the boolean.
    //
    // What this control CANNOT do is isolate `uniqueItems` completely. With
    // exactly seven items and a `contains` clause per id, a duplicate forces
    // some id out of the document, so `contains` fires too - that is a property
    // of the schema, not a weakness here. Both keywords are asserted present.
    const doc = clone(baselines);
    doc.baselines[1] = clone(doc.baselines[0]);
    expect(doc.baselines).toHaveLength(7);
    expect(validator(doc)).toBe(false);
    const keywords = (validator.errors ?? []).map((e) => e.keyword);
    expect(keywords).toContain('uniqueItems');
    expect(keywords).toContain('contains');
  });

  it('rejects status:implemented with no resolver', () => {
    const doc = clone(baselines);
    delete doc.baselines[0].resolver;
    expect(validator(doc)).toBe(false);
  });

  it('rejects status:unimplemented with no reason', () => {
    const doc = clone(baselines);
    const b6 = doc.baselines.find((entry) => entry.id === 'B6');
    delete b6.reason;
    expect(validator(doc)).toBe(false);
  });

  it('rejects an implemented baseline that also carries a reason', () => {
    // Both fields present means the document says "implemented" and "here is
    // why it is not" at once. Fail closed rather than let a runner pick one.
    const doc = clone(baselines);
    doc.baselines[0].reason = 'not really';
    expect(validator(doc)).toBe(false);
  });

  it('rejects a constant resolver with a tier outside the model vocabulary', () => {
    const doc = clone(baselines);
    doc.baselines[0].resolver.tier = 'gpt';
    expect(validator(doc)).toBe(false);
  });

  it('rejects a module resolver missing its export', () => {
    const doc = clone(baselines);
    const b2 = doc.baselines.find((entry) => entry.id === 'B2');
    delete b2.resolver.export;
    expect(validator(doc)).toBe(false);
  });

  it('rejects an unexpected top-level property', () => {
    const doc = clone(baselines);
    doc.score = 0.9;
    expect(validator(doc)).toBe(false);
  });

  it('rejects agent_type_supply with b4_input removed', () => {
    // `b4_input` is in `agent_type_supply.required` for this control alone: a
    // decision that a document may simply omit is a convention, and a future
    // registry would drop it without anything going red.
    const doc = clone(baselines);
    delete doc.agent_type_supply.b4_input;
    expect(validator(doc)).toBe(false);
  });

  it('rejects b4_input.agentType flipped to false', () => {
    // The field is `const: true`, not `type: boolean`. Flipping it would mean
    // B4 stopped being fed the agent name - a reversal of owner decision 3,
    // which is an argument to be had in the note, not a boolean edit. This
    // control also proves draft-07 `const` actually compiles under ajv 6,
    // which is the only validator this gate runs.
    const doc = clone(baselines);
    doc.agent_type_supply.b4_input.agentType = false;
    expect(validator(doc)).toBe(false);
  });

  it('rejects an unknown key inside b4_input', () => {
    // The sub-object is closed for the same reason the rest of the schema is:
    // a typo-ed key would sit in the fixture asserting nothing. `role` is the
    // realistic typo - it is a routeModel input that a scenario deliberately
    // does NOT carry.
    const doc = clone(baselines);
    doc.agent_type_supply.b4_input.role = 'crosscheck';
    expect(validator(doc)).toBe(false);
  });
});

describe('baselines.json - module resolvers point at code that exists and exports', () => {
  const moduleBaselines = baselines.baselines.filter(
    (entry) => entry.resolver?.type === 'module',
  );

  it('has at least the three module-backed baselines B2, B3, B4', () => {
    expect(moduleBaselines.map((entry) => entry.id)).toEqual(['B2', 'B3', 'B4']);
  });

  it('resolves every module path to a file on disk', () => {
    for (const entry of moduleBaselines) {
      const abs = path.join(PLUGIN_ROOT, entry.resolver.module);
      expect(existsSync(abs), `${entry.id} -> ${entry.resolver.module}`).toBe(true);
    }
  });

  it.each(['B2', 'B3', 'B4'])('really imports %s and finds its export callable', async (id) => {
    // "The file exists" and "the export works" are different statements. This
    // one imports for real, so a rename inside lib/ is red here on the next run
    // rather than at first benchmark execution.
    const entry = byId.get(id);
    const abs = path.join(PLUGIN_ROOT, entry.resolver.module);
    const mod = await import(pathToFileURL(abs).href);
    expect(typeof mod[entry.resolver.export], `${id} ${entry.resolver.export}`).toBe('function');
  });

  it('names ACTION_CLASS_TIERS as a real frozen table for B3', () => {
    // B3's inferred mapping is only meaningful if the table it reads is the
    // static class -> tier table the note claims. Checked, not assumed.
    expect(byId.get('B3').resolver.call).toContain('ACTION_CLASS_TIERS');
  });
});

describe('scenarios.schema.json - agentType is admitted without breaking the examples', () => {
  const probe = Object.freeze({
    id: 'probe-scenario',
    task_class: 'debugging',
    baselines: ['B2'],
    metrics: ['attempts'],
    source: 'design-v5-8.2',
  });

  it('still compiles as draft-07 after the edit', () => {
    expect(scenarioSchema.$schema).toBe(DRAFT_07);
    expect(typeof compile(scenarioSchema)).toBe('function');
  });

  it('declares agentType as an optional string property', () => {
    expect(scenarioSchema.properties.agentType.type).toBe('string');
    expect(scenarioSchema.required).not.toContain('agentType');
    expect(scenarioSchema.properties.agentType.description.length).toBeGreaterThan(80);
  });

  it('accepts a scenario carrying agentType', () => {
    const validator = compile(scenarioSchema);
    expect(validator({ ...probe, agentType: 'planner' })).toBe(true);
  });

  it('still rejects a misspelled agentTyp', () => {
    // additionalProperties:false is what makes the schema edit necessary at
    // all; this proves the edit widened the schema by exactly one key.
    const validator = compile(scenarioSchema);
    expect(validator({ ...probe, agentTyp: 'planner' })).toBe(false);
  });

  it('keeps every scenario valid and splits them by whether agentType is declared', () => {
    const validator = compile(scenarioSchema);
    expect(scenarioRecords).toHaveLength(6);
    for (const record of scenarioRecords) {
      const ok = validator(record.value);
      expect(JSON.stringify(validator.errors ?? []), `line ${record.lineNumber}`).toBe('[]');
      expect(ok, `line ${record.lineNumber}`).toBe(true);
    }
    // The two ORIGINAL examples still declare no agentType. That is what keeps
    // the property optional rather than a breaking change, and it is the half
    // of this claim that would rot silently if the four live rows had simply
    // been counted in — so the two groups are asserted separately, by id.
    const withoutAgent = scenarioRecords
      .filter((r) => r.value.agentType === undefined).map((r) => r.value.id).sort();
    expect(withoutAgent).toEqual(['seeded-defect-seven-axis-review', 'split-four-window-fanout']);
    // The four live rows each carry the agent name their corpus was extracted
    // for. Asserted as an exact map, not a presence check: a row pointing at
    // another agent's corpus would still "have an agentType".
    const withAgent = Object.fromEntries(
      scenarioRecords
        .filter((r) => r.value.agentType !== undefined)
        .map((r) => [r.value.id, r.value.agentType]),
    );
    expect(withAgent).toEqual({
      'live-investigator-explore': 'investigator',
      'live-tdd-guide-implement': 'tdd-guide',
      'live-code-reviewer-review': 'code-reviewer',
      'live-doc-updater-edit-routine': 'doc-updater',
    });
  });

  it('matches each live scenario agentType to every row of its own corpus', async () => {
    // The cross-file agreement the map above cannot make on its own: the
    // scenario says "investigator", so every row of the file it points at must
    // say "investigator" too. A corpus regenerated for the wrong agent, or a
    // path copy-pasted between two rows, is invisible to any check that reads
    // only one of the two files.
    const live = scenarioRecords
      .map((r) => r.value)
      .filter((s) => s.agentType !== undefined);
    expect(live).toHaveLength(4);
    for (const scenario of live) {
       
      const text = await readFile(path.join(PLUGIN_ROOT, scenario.fixture.path), 'utf-8');
      const rows = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      expect(rows.length, scenario.id).toBeGreaterThan(0);
      const agents = [...new Set(rows.map((row) => row.agentType))];
      expect(agents, scenario.id).toEqual([scenario.agentType]);
      const ids = [...new Set(rows.map((row) => row.scenario_id))];
      expect(ids, scenario.id).toEqual([scenario.id]);
    }
  });
});

describe('one baseline vocabulary across both fixtures', () => {
  it('matches baselines.json ids to the scenario schema enum exactly', () => {
    // Two files naming baselines independently is how B5 ends up meaning two
    // different things in two places. Asserted as an equality, not a subset.
    const declared = baselines.baselines.map((entry) => entry.id).sort();
    const vocabulary = [...scenarioSchema.properties.baselines.items.enum].sort();
    expect(declared).toEqual(vocabulary);
  });
});
