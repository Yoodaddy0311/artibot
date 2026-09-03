/**
 * Eval fixture FORMAT gate — `tests/evals/fixtures/**` (T-47).
 *
 * What this file proves
 * ---------------------
 *  1. `nl-activation.cases.jsonl` parses line by line, every case carries the
 *     required `prompt` / `expect` / `why` / `source` fields, and the first line
 *     is the constitutional `/split` upgrade case (design v1.0 01 §4). Its
 *     expected signals are the leader's 2026-09-02 correction, NOT the design
 *     §3.1 example text — that example listed S3 and S5, which its own
 *     definitions rule out for this prompt. Correcting the design document is
 *     tracked separately; this file pins the corrected reading.
 *  2. Every `expect` key is in a closed vocabulary, and every vocabulary entry
 *     is actually used — an allowlist, not a deny list, because a deny list
 *     fails OPEN for the next assertion someone invents.
 *  3. `substantive_signals` is a subset of the substantive allowlist, read from
 *     `artibot.config.json#/missions/substantiveSignals` rather than hardcoded,
 *     so there is one source of truth for S1..S6. A second assertion pins that
 *     allowlist to exactly S1..S6 today, so widening it is a deliberate red
 *     rather than a silent widening of what fixtures may claim.
 *  4. `command_activation` keys are a subset of the keys declared by
 *     `schemas/mission-contract.schema.json`, read from the schema for the same
 *     single-source reason.
 *  5. `fixtures/routebench/scenarios.schema.json` carries the vocabulary the
 *     design fixes (13 task classes, baselines B0..B6, 17 metrics) and both
 *     example scenarios validate against it.
 *
 * What this file does NOT see
 * ---------------------------
 *  - **NL activation accuracy.** The last block DOES run every case through
 *    `compileMission` (`lib/mission/compiler.js#compileMission`), but it records
 *    agreement as a divergence ledger, not a score. Measured 2026-09-03 at
 *    `stage: 'prompt'`, `system: 'system1'`: 7 of the 10 cases agree on the
 *    `substantive` axis. One case is exempt by name in `UNSCORED_CASES`, so the
 *    scorable denominator is 9 → 7/9; the exempt set is asserted, not inferred
 *    from a missing field. It was 5/10 until T-22 fixed the Korean clause
 *    connective on 2026-09-03, then 6/9; the `substantive_stage` qualifier added
 *    the same day resolved the last non-call-shape entry. The ledger below caught
 *    both landings by going red, which is what it is for. **n=10 gives 10 percentage points of resolution
 *    per case, so this number is NOT a basis for the §3.7 ≥90% exit criterion.**
 *    That bar is Shadow work against real user choices; this file is regression
 *    protection only.
 *  - **The two remaining divergences are recorded, not resolved.** Their causes
 *    are written beside the ledger below. BOTH are an artifact of the
 *    three-argument call shape (S4 needs `intentConfidence`, S6 needs
 *    `activeMission` + `followUp` — neither is derivable from prompt text), so
 *    neither is a compiler defect. Two earlier entries are gone: a Korean
 *    clause-connective gap the extractor fix (T-22) closed, and a stage mismatch
 *    in the fixture's own `substantive` field, closed by the `substantive_stage`
 *    qualifier. Neither was fixed by editing an expectation to match output —
 *    T-47 does not own the compiler and did not touch it.
 *  - **Whether the expected values are correct.** `expect` blocks are
 *    transcriptions of design clauses. This gate cannot tell a faithful
 *    transcription from a wrong one; `source` exists so a human can re-judge.
 *  - **Prompt-time vs execution-time signals.** Cases assert what is decidable
 *    at prompt time. Signals S1 (repository write expected) and S2 (commit /
 *    PR / deploy expected) are only confirmed at `PreToolUse` per design §3.3,
 *    so a case that omits them is not asserting their absence.
 *  - **RouteBench behaviour.** `fixtures/routebench/` is DEFINITION ONLY.
 *    Nothing here runs a benchmark, and run results live outside the repo under
 *    `_benchmarks/routing/` (gitignored) by design ARTIBOT-5.0-DESIGN.md §8.2 §11·§12·§44·§45.
 *  - **Real-world prompts.** These are prompts a person wrote, not usage logs.
 *    Design §3.7: this set is regression protection, and reaching the >=90% NL
 *    activation bar with this file alone is explicitly not a route to GA.
 *
 * The structural validator below is deliberately dependency-free, and the last
 * describe block feeds it broken scenarios so that it is proven to REJECT
 * things — a validator nobody tested is the next false green.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileMission } from '../../lib/mission/compiler.js';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const FIXTURES = path.join(HERE, 'fixtures');
const CASES_PATH = path.join(FIXTURES, 'nl-activation.cases.jsonl');
const SCENARIO_SCHEMA_PATH = path.join(FIXTURES, 'routebench', 'scenarios.schema.json');
const SCENARIO_EXAMPLES_PATH = path.join(FIXTURES, 'routebench', 'scenarios.example.jsonl');
const CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');
const MISSION_CONTRACT_PATH = path.join(PLUGIN_ROOT, 'schemas', 'mission-contract.schema.json');

/** Design §3.7 requires at least this many cases before the set has resolution. */
const MIN_CASES = 8;

/**
 * Closed vocabulary of `expect` keys. Allowlist on purpose: a deny list would
 * let a typo-ed assertion key sit in the file asserting nothing at all.
 */
const EXPECT_VOCAB = Object.freeze([
  'explicit_requests_contains',
  'explicit_requests_min',
  'command_activation',
  'requested_target_not_empty',
  'substantive',
  'substantive_stage',
  'substantive_signals',
  'activation_suppressed_by',
  'prompt_time_verdict',
]);

/**
 * Prompt-time verdict vocabulary, from the two-stage issuance in design 3.3.
 * `substantive` = a prompt-time signal (S3..S6) fired, so a mission id can be
 * issued now. `deferred` = none did, so only a candidate is recorded and the
 * ledger gets `mission-candidate-deferred`. Two values on purpose: a third one
 * needs a design clause first, and until then it is schema-invalid here.
 */
const PROMPT_TIME_VERDICTS = Object.freeze(['substantive', 'deferred']);

/** Signals design 3.2 marks as decidable only at tool-call time. */
const EXECUTION_TIME_SIGNALS = Object.freeze(['S1', 'S2']);

/**
 * Which stage a case's `substantive` field is stating a verdict FOR.
 *
 * Not a new vocabulary: these are the two values `compileMission` itself takes
 * (`lib/mission/compiler.js:508` — `@param {'prompt'|'execution'} [input.stage]`).
 * Absent means `'prompt'`, which is what nine of the ten cases mean today, so
 * adding the key changed no existing case.
 *
 * Why the key had to exist. Design 3.3 issues in two stages, so ONE prompt has
 * TWO substantive verdicts, and a field named `substantive` alone cannot say
 * which one it holds. `split-upgrade-fidelity` states the execution-time
 * verdict (true, via S1) while its own `prompt_time_verdict` says `deferred` —
 * both correct, about different stages. The agreement ledger compares against
 * the prompt stage, so without the qualifier it read the execution-time verdict
 * as a prompt-time claim and booked a divergence that was nobody's defect. The
 * fixture and the predicate now name the same stage; the compiler is unchanged.
 */
const SUBSTANTIVE_STAGES = Object.freeze(['prompt', 'execution']);

/**
 * What a case expects `compileMission(..., stage: 'prompt')` to return.
 *
 * For an execution-staged case that is `prompt_time_verdict`, not `substantive`
 * — which is exactly what design 3.3 stage 1 decides.
 */
function expectedSubstantiveAtPromptStage(entry) {
  if (entry.expect.substantive_stage === 'execution') {
    return entry.expect.prompt_time_verdict === 'substantive';
  }
  return entry.expect.substantive;
}

/** Design §3.7 fixes this case verbatim; it is the first line by contract. */
const CONSTITUTIONAL_CASE_ID = 'split-upgrade-fidelity';

const SLUG = /^[a-z0-9][a-z0-9.-]*$/;

async function readJsonl(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const records = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      records.push({ lineNumber: index + 1, value: JSON.parse(line) });
    } catch (error) {
      throw new Error(
        `${path.basename(filePath)}:${index + 1} is not valid JSON — ${error.message}`,
        { cause: error },
      );
    }
  });
  return records;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Minimal draft-07 subset validator.
//
// ajv resolves transitively here (6.12.6) but is NOT a declared dependency, so
// a gate that needed it would be one dependency prune away from failing open.
// This covers the keywords the scenario schema actually uses and nothing else,
// which is why that schema is deliberately kept inside this subset.
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number';
  return typeOf(value) === expected;
}

function checkScalar(schema, value, at) {
  const errors = [];
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${at}: expected type ${schema.type}, got ${typeOf(value)}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not in enum`);
  }
  if (
    typeof schema.minLength === 'number'
    && typeof value === 'string'
    && value.length < schema.minLength
  ) {
    errors.push(`${at}: shorter than minLength ${schema.minLength}`);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${at}: does not match ${schema.pattern}`);
  }
  return errors;
}

function checkArray(schema, value, at) {
  const errors = [];
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push(`${at}: fewer than minItems ${schema.minItems}`);
  }
  const seen = new Set(value.map((item) => JSON.stringify(item)));
  if (schema.uniqueItems === true && seen.size !== value.length) {
    errors.push(`${at}: items are not unique`);
  }
  if (schema.items) {
    value.forEach((item, index) => {
      errors.push(...validate(schema.items, item, `${at}[${index}]`));
    });
  }
  return errors;
}

function checkObject(schema, value, at) {
  const errors = [];
  const props = schema.properties || {};
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${at}: missing required property "${key}"`);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      errors.push(...validate(props[key], child, `${at}.${key}`));
    } else if (schema.additionalProperties === false) {
      errors.push(`${at}: unexpected property "${key}"`);
    }
  }
  return errors;
}

/** Returns an array of human-readable errors; empty means valid. */
function validate(schema, value, at = '$') {
  const errors = checkScalar(schema, value, at);
  if (errors.length > 0) return errors;
  if (schema.type === 'array' && Array.isArray(value)) {
    return checkArray(schema, value, at);
  }
  if (schema.type === 'object' && typeOf(value) === 'object') {
    return checkObject(schema, value, at);
  }
  return errors;
}

// ---------------------------------------------------------------------------

const caseRecords = await readJsonl(CASES_PATH);
const cases = caseRecords.map((record) => record.value);
const scenarioRecords = await readJsonl(SCENARIO_EXAMPLES_PATH);
const scenarioSchema = await readJson(SCENARIO_SCHEMA_PATH);
const artibotConfig = await readJson(CONFIG_PATH);
const missionContract = await readJson(MISSION_CONTRACT_PATH);

const SUBSTANTIVE_ALLOWLIST = artibotConfig.missions.substantiveSignals;
const ACTIVATION_KEYS = Object.keys(missionContract.properties.command_activation.properties);

describe('nl-activation.cases.jsonl — file shape', () => {
  it('parses every non-empty line as one case and has enough of them', () => {
    expect(caseRecords.length).toBeGreaterThanOrEqual(MIN_CASES);
    expect(cases.every((entry) => typeOf(entry) === 'object')).toBe(true);
  });

  it('gives every case a unique id', () => {
    const ids = cases.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires prompt, expect, why and source on every case', () => {
    for (const record of caseRecords) {
      const where = `line ${record.lineNumber}`;
      const entry = record.value;
      expect(typeof entry.id, where).toBe('string');
      expect(entry.id, where).toMatch(SLUG);
      expect(typeof entry.prompt, where).toBe('string');
      expect(entry.prompt.trim().length, where).toBeGreaterThan(0);
      expect(typeOf(entry.expect), where).toBe('object');
      expect(Object.keys(entry.expect).length, where).toBeGreaterThan(0);
      expect(typeof entry.why, where).toBe('string');
      expect(entry.why.trim().length, where).toBeGreaterThan(0);
      // `source` is the whole reason a later reader can re-judge a changed
      // expectation instead of guessing (design §3.7).
      expect(typeof entry.source, where).toBe('string');
      expect(entry.source, where).toMatch(SLUG);
    }
  });

  it('carries no fields outside the case vocabulary', () => {
    const allowed = new Set(['id', 'prompt', 'expect', 'why', 'source']);
    for (const record of caseRecords) {
      for (const key of Object.keys(record.value)) {
        expect(allowed.has(key), `line ${record.lineNumber} key "${key}"`).toBe(true);
      }
    }
  });
});

describe('nl-activation.cases.jsonl — the constitutional first case', () => {
  it('is the /split upgrade case on line 1, as corrected 2026-09-02', () => {
    const first = caseRecords[0];
    expect(first.lineNumber).toBe(1);
    expect(first.value.id).toBe(CONSTITUTIONAL_CASE_ID);
    expect(first.value.prompt).toBe('split 을 업그레이드해줘');
    expect(first.value.source).toBe('design-v1.0-01');
    // The design text listed S3 and S5 here, which contradicts its own
    // definitions: this prompt carries one explicit request (so S3, "two or
    // more", cannot fire) and is not a slash command (so S5 cannot fire). The
    // leader corrected the fixture on 2026-09-02 and owns fixing the design
    // document; the corrected reading is S1 confirmed at tool-call time, with
    // the prompt-time verdict deferred per the two-stage issuance in 3.3.
    expect(first.value.expect).toEqual({
      explicit_requests_contains: 'split',
      command_activation: { plan: true, ultraplan: false, split: false },
      requested_target_not_empty: true,
      substantive: true,
      substantive_stage: 'execution',
      substantive_signals: ['S1'],
      prompt_time_verdict: 'deferred',
    });
  });
});

describe('nl-activation.cases.jsonl — assertion vocabulary', () => {
  it('uses only allowlisted expect keys', () => {
    const allowed = new Set(EXPECT_VOCAB);
    for (const record of caseRecords) {
      for (const key of Object.keys(record.value.expect)) {
        expect(allowed.has(key), `line ${record.lineNumber} expect key "${key}"`).toBe(true);
      }
    }
  });

  it('leaves no vocabulary entry unused', () => {
    const used = new Set();
    for (const entry of cases) {
      for (const key of Object.keys(entry.expect)) used.add(key);
    }
    expect(EXPECT_VOCAB.filter((key) => !used.has(key))).toEqual([]);
  });
});

describe('nl-activation.cases.jsonl — substantive signals', () => {
  it('reads its allowlist from artibot.config.json, which is still S1..S6', () => {
    // Pinned so widening the runtime allowlist is a deliberate red here rather
    // than a silent widening of what a fixture may claim.
    expect(SUBSTANTIVE_ALLOWLIST).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  });

  it('keeps every asserted signal inside that allowlist', () => {
    const allowed = new Set(SUBSTANTIVE_ALLOWLIST);
    for (const record of caseRecords) {
      const signals = record.value.expect.substantive_signals;
      if (signals === undefined) continue;
      expect(Array.isArray(signals), `line ${record.lineNumber}`).toBe(true);
      for (const signal of signals) {
        expect(allowed.has(signal), `line ${record.lineNumber} signal "${signal}"`).toBe(true);
      }
      expect(new Set(signals).size, `line ${record.lineNumber}`).toBe(signals.length);
    }
  });

  it('keeps substantive and substantive_signals consistent in both directions', () => {
    for (const record of caseRecords) {
      const substantive = record.value.expect.substantive;
      const signals = record.value.expect.substantive_signals;
      if (substantive === false && signals !== undefined) {
        expect(signals, `line ${record.lineNumber}`).toEqual([]);
      }
      if (Array.isArray(signals) && signals.length > 0) {
        expect(substantive, `line ${record.lineNumber}`).toBe(true);
      }
    }
  });

  it('keeps substantive_stage inside the two-value vocabulary the compiler itself takes', () => {
    for (const record of caseRecords) {
      const stage = record.value.expect.substantive_stage;
      if (stage === undefined) continue;
      expect(SUBSTANTIVE_STAGES, `line ${record.lineNumber}`).toContain(stage);
    }
  });

  it('makes an execution-staged case state its prompt-stage verdict too', () => {
    // The qualifier only pays for itself if the OTHER stage is also on record.
    // Without `prompt_time_verdict` the case would say "this is not the prompt
    // verdict" and then never say what the prompt verdict is — which leaves the
    // agreement ledger with nothing to compare and would silently drop the case
    // out of scoring. And an execution-staged verdict has to rest on a signal
    // that is only decidable at execution time, or the qualifier is misapplied.
    const executionOnly = new Set(EXECUTION_TIME_SIGNALS);
    for (const record of caseRecords) {
      if (record.value.expect.substantive_stage !== 'execution') continue;
      const where = `line ${record.lineNumber}`;
      expect(record.value.expect.prompt_time_verdict, where).toBeTypeOf('string');
      const signals = record.value.expect.substantive_signals || [];
      expect(signals.some((s) => executionOnly.has(s)), where).toBe(true);
    }
  });

  it('keeps prompt_time_verdict inside its two-value vocabulary', () => {
    for (const record of caseRecords) {
      const verdict = record.value.expect.prompt_time_verdict;
      if (verdict === undefined) continue;
      expect(PROMPT_TIME_VERDICTS, `line ${record.lineNumber}`).toContain(verdict);
    }
  });

  it('lets a deferred verdict carry only execution-time signals', () => {
    // If any prompt-time signal (S3..S6) had fired, the verdict could not be
    // deferred — that is what deferred MEANS in design 3.3. So a deferred case
    // may list S1 or S2 (confirmed later at PreToolUse) and nothing else.
    const executionOnly = new Set(EXECUTION_TIME_SIGNALS);
    for (const record of caseRecords) {
      if (record.value.expect.prompt_time_verdict !== 'deferred') continue;
      for (const signal of record.value.expect.substantive_signals || []) {
        expect(executionOnly.has(signal), `line ${record.lineNumber} signal "${signal}"`).toBe(true);
      }
    }
  });

  it('includes non-substantive cases, so the set is not one-sided', () => {
    const negatives = cases.filter((entry) => entry.expect.substantive === false);
    expect(negatives.length).toBeGreaterThanOrEqual(2);
  });
});

describe('nl-activation.cases.jsonl — command_activation', () => {
  it('reads its key set from mission-contract.schema.json', () => {
    // Design ARTIBOT-5.0-DESIGN.md §7.2 Addendum §2 calls this "7 booleans"; the schema and
    // package/03_INTENT_MISSION_COMPILER.md:75 both show 6 booleans plus a
    // `skills` string array. The schema is the source of truth here.
    expect(ACTIVATION_KEYS).toHaveLength(7);
    expect(ACTIVATION_KEYS).toContain('skills');
  });

  it('keeps fixture keys inside that set and their values boolean', () => {
    const allowed = new Set(ACTIVATION_KEYS);
    for (const record of caseRecords) {
      const activation = record.value.expect.command_activation;
      if (activation === undefined) continue;
      expect(typeOf(activation), `line ${record.lineNumber}`).toBe('object');
      for (const [key, value] of Object.entries(activation)) {
        expect(allowed.has(key), `line ${record.lineNumber} activation key "${key}"`).toBe(true);
        expect(typeof value, `line ${record.lineNumber} activation "${key}"`).toBe('boolean');
      }
    }
  });
});

describe('routebench/scenarios.schema.json — vocabulary the design fixes', () => {
  it('is draft-07 and self-identifies', () => {
    expect(scenarioSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(typeof scenarioSchema.$id).toBe('string');
  });

  it('carries the 13 task classes verbatim', () => {
    expect(scenarioSchema.properties.task_class.enum).toEqual([
      'simple_edit',
      'repo_exploration',
      'routine_implementation',
      'complex_implementation',
      'debugging',
      'repeated_failure',
      'architecture',
      'long_context',
      'memory_dependent',
      'intent_revision',
      'high_risk_review',
      'autopilot_fast',
      'split',
    ]);
  });

  it('carries baselines B0..B6 and 17 metrics', () => {
    expect(scenarioSchema.properties.baselines.items.enum).toEqual([
      'B0',
      'B1',
      'B2',
      'B3',
      'B4',
      'B5',
      'B6',
    ]);
    expect(scenarioSchema.properties.metrics.items.enum).toHaveLength(17);
    expect(scenarioSchema.properties.metrics.items.enum).toContain('cost_per_accepted_outcome');
    expect(scenarioSchema.properties.metrics.items.enum).toContain('context_churn');
  });

  it('has no composite score property, per scoring section 45', () => {
    expect(Object.keys(scenarioSchema.properties)).not.toContain('score');
    expect(scenarioSchema.additionalProperties).toBe(false);
  });
});

describe('routebench/scenarios.example.jsonl', () => {
  it('defines exactly the two example scenarios and validates them', () => {
    expect(scenarioRecords).toHaveLength(2);
    for (const record of scenarioRecords) {
      expect(validate(scenarioSchema, record.value), `line ${record.lineNumber}`).toEqual([]);
    }
  });

  it('reserves a high_risk_review seat whose fixture is declared pending', () => {
    const seeded = scenarioRecords
      .map((record) => record.value)
      .find((scenario) => scenario.task_class === 'high_risk_review');
    expect(seeded).toBeDefined();
    // Lane 4 owns the seeded-defect corpus. A pending fixture is declared, not
    // faked: an empty fixture file would let a runner score it as zero cases.
    expect(seeded.fixture.status).toBe('pending');
    expect(seeded.fixture.owner.length).toBeGreaterThan(0);
  });

  it('compares every scenario against the B2 current-policy control group', () => {
    for (const record of scenarioRecords) {
      expect(record.value.baselines, `line ${record.lineNumber}`).toContain('B2');
    }
  });
});

describe('the structural validator itself rejects broken scenarios', () => {
  const good = Object.freeze({
    id: 'probe-scenario',
    task_class: 'debugging',
    baselines: ['B2'],
    metrics: ['attempts'],
    source: 'design-v5-8.2',
  });

  it('accepts the probe unchanged', () => {
    expect(validate(scenarioSchema, good)).toEqual([]);
  });

  it('rejects an unknown task class', () => {
    expect(validate(scenarioSchema, { ...good, task_class: 'vibes' }).length).toBeGreaterThan(0);
  });

  it('rejects an unknown metric', () => {
    expect(validate(scenarioSchema, { ...good, metrics: ['vibes'] }).length).toBeGreaterThan(0);
  });

  it('rejects a missing source', () => {
    const withoutSource = { ...good };
    delete withoutSource.source;
    expect(validate(scenarioSchema, withoutSource).length).toBeGreaterThan(0);
  });

  it('rejects an unexpected property', () => {
    expect(validate(scenarioSchema, { ...good, score: 0.9 }).length).toBeGreaterThan(0);
  });

  it('rejects an empty baselines array and a duplicated metric', () => {
    expect(validate(scenarioSchema, { ...good, baselines: [] }).length).toBeGreaterThan(0);
    expect(
      validate(scenarioSchema, { ...good, metrics: ['attempts', 'attempts'] }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a fixture entry with an unknown status', () => {
    expect(validate(scenarioSchema, { ...good, fixture: { status: 'maybe' } }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Live compile — every case through the real classifier.
//
// This block answers "does the compiler agree with the fixture", and today the
// answer is: on 7 of 10. That number is deliberately NOT asserted as a
// threshold. A frozen score ratchets the wrong way, because improving the
// compiler would turn it red. Instead the divergences are listed by id with
// their cause, so BOTH directions are fail-closed: fixing one, or adding a new
// one, breaks the ledger assertion and forces a human to re-judge.
//
// That is not hypothetical. The ledger held four entries until 2026-09-03, when
// T-22 taught the extractor the Korean clause connective. The ledger went red on
// the next run, the entry was removed, and the case it covered is now asserted
// as AGREEING below — a resolved divergence becomes a regression guard rather
// than quietly disappearing. It happened a second time the same day: adding the
// `substantive_stage` qualifier made `split-upgrade-fidelity` agree, so that
// entry came out too. Note what did NOT happen either time — no expectation was
// relaxed to match output. T-22 changed the extractor; the qualifier made the
// fixture state which of design 3.3's two stages its verdict belongs to.
//
// Call shape is the one T-50 section 8 specified: {prompt, stage: 'prompt',
// system: 'system1'}. That shape cannot supply `intentConfidence` (S4) or
// `activeMission` + `followUp` (S6), which is why the two remaining divergences
// exist and are nobody's defect — proven below by re-running those two prompts
// WITH those inputs, where both signals fire correctly.
//
// Because every case is compiled at `stage: 'prompt'`, the comparison target is
// each case's PROMPT-stage expectation, not a bare `substantive` field —
// see `expectedSubstantiveAtPromptStage`.
// ---------------------------------------------------------------------------

/** Signals design 3.2 marks as decidable at prompt time. */
const PROMPT_STAGE_SIGNALS = Object.freeze(['S3', 'S4', 'S5', 'S6']);

/**
 * Cases where the compiler prompt-stage verdict differs from the fixture's
 * prompt-stage expectation, with why. Measured 2026-09-03.
 */
const KNOWN_DIVERGENCES = Object.freeze({
  // Removed 2026-09-03: 'split-upgrade-fidelity'. It was never a compiler
  // defect — the fixture stated the execution-time verdict while the ledger
  // compared against the prompt stage. The `substantive_stage` qualifier makes
  // the fixture say which stage it means, so the two now agree and the case is
  // scored as AGREEING (a resolved divergence becomes a regression guard, the
  // same treatment T-22's connective fix got). The compiler was not touched.
  'product-decision-required-s4':
    'Call-shape artifact, not a defect. S4 reads intentConfidence.'
    + 'product_decision_required, which question-gate supplies and prompt text '
    + 'cannot. Supplying it makes the compiler return signals ["S4"].',
  'intent-revision-followup-s6':
    'Call-shape artifact, not a defect. S6 reads followUp plus activeMission, which '
    + 'a state.yaml lookup supplies and prompt text cannot. Supplying both makes the '
    + 'compiler return signals ["S6"].',
});

/**
 * Cases deliberately excluded from the agreement score: id -> why.
 *
 * Same id-to-reason shape as `KNOWN_DIVERGENCES`, and for the same reason. An
 * exemption has to be NAMED and ARGUED. Skipping on `expect.substantive ===
 * undefined` alone was fail-OPEN: a new case that simply forgot the field
 * slipped out of both the divergence set and the agreement loop and was scored
 * by nothing, silently shrinking the denominator.
 *
 * Adding an entry here is deliberately expensive. It takes three edits that all
 * have to agree: the id, a reason long enough to be a real sentence, and
 * `SCORABLE_CASE_COUNT` below. Miss any one and the suite is red.
 */
const UNSCORED_CASES = Object.freeze({
  'split-upgrade-systemic-substitution':
    'Partial-assertion case, which design 3.7 explicitly allows. It asserts Intent '
    + 'Fidelity only — that the explicit request and the requested target survive a '
    + 'systemic finding — and deliberately claims nothing about the substantive '
    + 'verdict. Scoring it would mean inventing an expectation the fixture never '
    + 'made, which is the opposite of what a source-backed case set is for.',
});

/**
 * The scoring denominator, pinned as a literal rather than derived.
 *
 * `cases.length - exempt.length` would follow an exemption automatically, so
 * adding one would silently shrink the denominator and every reported ratio
 * with it. Written out, the arithmetic assertion below forces the person adding
 * an exemption to change this number too, in the same diff a reviewer reads.
 */
const SCORABLE_CASE_COUNT = 9;

const isUnscored = (id) => Object.prototype.hasOwnProperty.call(UNSCORED_CASES, id);

const compiled = cases.map((entry) => ({
  entry,
  result: compileMission({ prompt: entry.prompt, stage: 'prompt', system: 'system1' }),
}));

describe('compileMission — prompt-stage invariants on every case', () => {
  it('compiles all ten without throwing', () => {
    expect(compiled).toHaveLength(cases.length);
    for (const { entry, result } of compiled) {
      expect(typeof result.substantive, entry.id).toBe('boolean');
      expect(Array.isArray(result.signals), entry.id).toBe(true);
    }
  });

  it('keeps deferred the exact negation of substantive', () => {
    for (const { entry, result } of compiled) {
      expect(result.deferred, entry.id).toBe(!result.substantive);
    }
  });

  it('never emits an execution-time signal at prompt stage', () => {
    // Design 3.3 stage 1: no tool has run, so S1 and S2 are not measurable.
    const promptOnly = new Set(PROMPT_STAGE_SIGNALS);
    for (const { entry, result } of compiled) {
      for (const signal of result.signals) {
        expect(promptOnly.has(signal), `${entry.id} signal "${signal}"`).toBe(true);
      }
      const skipped = result.meta.substantiveJudgment.skipped.map((s) => s.signal);
      expect(skipped, entry.id).toEqual(['S1', 'S2']);
    }
  });
});

describe('compileMission — fixture agreement ledger', () => {
  it('exempts exactly the named cases from scoring, and no others', () => {
    // Both directions are red: a case that omits `substantive` without being
    // listed (the fail-open this closes), and a listed case that has since
    // gained the field (a stale exemption quietly shrinking the denominator).
    const missingField = cases
      .filter((entry) => entry.expect.substantive === undefined)
      .map((entry) => entry.id)
      .sort();
    expect(missingField).toEqual(Object.keys(UNSCORED_CASES).sort());
  });

  it('scores exactly SCORABLE_CASE_COUNT cases', () => {
    // The denominator is a literal, not a subtraction that would follow an
    // exemption around. Adding one without bumping the constant is red here.
    const scorable = cases.filter((entry) => !isUnscored(entry.id));
    expect(scorable).toHaveLength(SCORABLE_CASE_COUNT);
    expect(cases.length - Object.keys(UNSCORED_CASES).length).toBe(SCORABLE_CASE_COUNT);
    for (const entry of scorable) {
      expect(entry.expect.substantive, entry.id).toBeTypeOf('boolean');
    }
  });

  it('gives every exemption a written reason and a real case', () => {
    // Same bar as a recorded divergence: an id with no argument behind it is
    // how an exemption list rots into a list of cases nobody wanted to fix.
    for (const [id, reason] of Object.entries(UNSCORED_CASES)) {
      expect(cases.some((entry) => entry.id === id), id).toBe(true);
      expect(reason.length, id).toBeGreaterThan(80);
    }
  });

  it('diverges on exactly the two recorded cases, and no others', () => {
    const diverged = compiled
      .filter(({ entry }) => !isUnscored(entry.id))
      // Compared against the PROMPT-stage expectation, because that is the stage
      // `compiled` was produced at. Reading a bare `substantive` here was the
      // stage mismatch that put split-upgrade-fidelity in the ledger.
      .filter(({ entry, result }) => result.substantive !== expectedSubstantiveAtPromptStage(entry))
      .map(({ entry }) => entry.id)
      .sort();
    // Red in BOTH directions on purpose: a fixed divergence and a new one both
    // land here, and both need a human to decide which side moved.
    expect(diverged).toEqual(Object.keys(KNOWN_DIVERGENCES).sort());
  });

  it('agrees on every case not in the ledger', () => {
    for (const { entry, result } of compiled) {
      if (isUnscored(entry.id)) continue;
      if (Object.prototype.hasOwnProperty.call(KNOWN_DIVERGENCES, entry.id)) continue;
      expect(result.substantive, entry.id).toBe(expectedSubstantiveAtPromptStage(entry));
      const expectedPromptSignals = (entry.expect.substantive_signals || [])
        .filter((signal) => PROMPT_STAGE_SIGNALS.includes(signal));
      expect(result.signals, entry.id).toEqual(expectedPromptSignals);
    }
  });

  it('gives every recorded divergence a written cause and a real case', () => {
    for (const [id, cause] of Object.entries(KNOWN_DIVERGENCES)) {
      expect(cases.some((entry) => entry.id === id), id).toBe(true);
      // An id cannot be both exempt from scoring and a scored divergence.
      expect(isUnscored(id), id).toBe(false);
      expect(cause.length, id).toBeGreaterThan(80);
    }
  });
});

describe('compileMission — the resolved connective gap stays fixed', () => {
  it('splits the two-request prompt into two explicit requests and fires S3', () => {
    // Regression guard for T-22. Before that fix this prompt collapsed into ONE
    // explicit request, so S3 (two or more) could not fire and this case sat in
    // the divergence ledger. Asserted here so a revert is loud.
    const entry = cases.find((c) => c.id === 'two-explicit-requests-s3');
    const result = compileMission({
      prompt: entry.prompt,
      stage: 'prompt',
      system: 'system1',
    });
    expect(result.contract.explicit_requests).toHaveLength(2);
    expect(result.signals).toEqual(['S3']);
    expect(result.substantive).toBe(true);
    expect(result.deferred).toBe(false);
  });
});

describe('compileMission — the two call-shape divergences are not defects', () => {
  it('fires S4 once product_decision_required is supplied', () => {
    const entry = cases.find((c) => c.id === 'product-decision-required-s4');
    const result = compileMission({
      prompt: entry.prompt,
      stage: 'prompt',
      system: 'system1',
      intentConfidence: { product_decision_required: true },
    });
    expect(result.signals).toEqual(['S4']);
    expect(result.substantive).toBe(true);
  });

  it('fires S6 once followUp and activeMission are supplied', () => {
    const entry = cases.find((c) => c.id === 'intent-revision-followup-s6');
    const result = compileMission({
      prompt: entry.prompt,
      stage: 'prompt',
      system: 'system1',
      followUp: true,
      activeMission: { mission_id: 'M-20260902-001', intent_revision: 2 },
    });
    expect(result.signals).toEqual(['S6']);
    expect(result.substantive).toBe(true);
  });

  it('fires S1 for the constitutional case at execution stage', () => {
    // The fixture ["S1"] expectation is reachable — just not at prompt stage.
    const result = compileMission({
      prompt: 'split 을 업그레이드해줘',
      stage: 'execution',
      system: 'system1',
      completion: { expected_actions: ['implement'] },
    });
    expect(result.signals).toEqual(['S1']);
    expect(result.substantive).toBe(true);
  });
});
