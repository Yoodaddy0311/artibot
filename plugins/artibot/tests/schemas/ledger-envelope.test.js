/**
 * ledger-envelope.schema.json + ledger-events.allowlist.json — contract tests.
 *
 * The central run ledger (<projectRoot>/.artibot/runtime/ledger.jsonl) is
 * governed by TWO files that do different jobs, and most of what this suite
 * pins is the boundary between them:
 *
 *   - the ENVELOPE schema validates the line's frame (v, ts, event, mission_id,
 *     session_id, source, pid, seq, plus optional correlation ids). `data` is
 *     free-form there on purpose.
 *   - the ALLOWLIST decides which `event` names exist at all and what each
 *     one's `data` must carry. It is the single source of truth for the
 *     vocabulary, so the envelope schema must NOT carry a copy of that enum.
 *
 * Two things are deliberately NOT tested here because they are not schema
 * behaviour, and asserting them here would give false confidence that the
 * schemas cover them:
 *
 *   (a) the 4096-byte per-line cap. JSON Schema cannot measure the serialized
 *       byte length of the document being validated. T-20's writer measures
 *       Buffer.byteLength(line, 'utf8') before append and routes the overflow
 *       into data.evidence_refs. Its gate is
 *       tests/firewall/ledger-append-survival.test.js, not this file.
 *   (b) concurrent-append survival. Same owner, same gate.
 *
 * Zero-dependency policy: ajv is a transitive dependency, not declared in
 * package.json, so it is imported defensively and the ajv blocks are SKIPPED —
 * never failed — when it cannot be resolved. The structural assertions below
 * run with no runtime deps either way.
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
const SCHEMAS_DIR = path.resolve(__dirname, '../../schemas');
const ENVELOPE_PATH = path.join(SCHEMAS_DIR, 'ledger-envelope.schema.json');
const ALLOWLIST_PATH = path.join(SCHEMAS_DIR, 'ledger-events.allowlist.json');
const EVENT_TYPES_PATH = path.resolve(
  __dirname,
  '../../lib/supervisor/event-types.js',
);

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

const envelopeSchema = await loadJson(ENVELOPE_PATH);
const allowlist = await loadJson(ALLOWLIST_PATH);

/**
 * Schemas named by an event's `data_schema`. Design section 8.2 makes the
 * receipt and the event's `data` the same object, so for those three events
 * the receipt file (owned by T-16) is the canonical data contract and this
 * allowlist does not restate its keys.
 */
const dataSchemas = new Map();
for (const spec of Object.values(allowlist.events)) {
  if (!spec.data_schema || dataSchemas.has(spec.data_schema)) continue;
  dataSchemas.set(
    spec.data_schema,
    await loadJson(path.join(SCHEMAS_DIR, spec.data_schema)),
  );
}

/** Compile any schema under ajv v6, which cannot resolve the draft-07 meta $id. */
function compileSchema(schema) {
  if (!Ajv) return null;
  const clone = JSON.parse(JSON.stringify(schema));
  delete clone.$schema;
  return new Ajv({ allErrors: true }).compile(clone);
}

function makeValidator() {
  // ajv v6's bundled default meta-schema does not register the draft-07 $id
  // URI; compileSchema drops $schema to avoid a meta-ref lookup miss. Same
  // treatment as tests/schemas/review-output.schema.test.js, and the schema
  // file keeps the same $schema string as its two sibling schemas.
  return compileSchema(envelopeSchema);
}

/** A minimal well-formed envelope; individual tests mutate one thing. */
function baseEnvelope(overrides = {}) {
  return {
    v: 1,
    ts: '2026-09-02T15:30:00+09:00',
    event: 'mission.created',
    mission_id: 'M-20260902-001',
    session_id: 'ap-20260902-062936-tyc5j4',
    source: 'hook',
    pid: 4242,
    seq: 0,
    data: { title: 'T-15 ledger envelope', intent_revision: 1 },
    ...overrides,
  };
}

/**
 * The allowlist layer, expressed as a pure local function so this suite does
 * not import lib/runtime/event-writer.js (T-20 owns that module and it does
 * not exist yet). This mirrors the contract the writer must implement; it is
 * not a second implementation of it.
 */
function checkAgainstAllowlist(line) {
  const spec = allowlist.events[line.event];
  if (!spec) return { ok: false, reason: 'unregistered_event' };
  const data = line.data ?? {};
  if (spec.data_schema) {
    // The referenced receipt schema IS the data contract; nothing local to add.
    const validate = compileSchema(dataSchemas.get(spec.data_schema));
    if (!validate) return { ok: 'unchecked', reason: 'ajv_absent' };
    return validate(data)
      ? { ok: true }
      : { ok: false, reason: 'data_schema_invalid', schema: spec.data_schema };
  }
  const missingEnvelope = (spec.required_envelope ?? []).filter((key) => !(key in line));
  if (missingEnvelope.length > 0) {
    return { ok: false, reason: 'missing_envelope', missing: missingEnvelope };
  }
  const missing = spec.required.filter((key) => !(key in data));
  if (missing.length > 0) return { ok: false, reason: 'missing_data', missing };
  for (const [key, fieldSpec] of Object.entries(spec.fields ?? {})) {
    if (!fieldSpec.enum_ref || !(key in data)) continue;
    const values = allowlist.enums[fieldSpec.enum_ref];
    if (!values.includes(data[key])) {
      return { ok: false, reason: 'bad_enum_value', key };
    }
  }
  return { ok: true };
}

describe('ledger-envelope.schema.json — required envelope fields', () => {
  const REQUIRED = [
    'v',
    'ts',
    'event',
    'mission_id',
    'session_id',
    'source',
    'pid',
    'seq',
  ];

  it('requires exactly the 8 common fields from lane 6 §5-②', () => {
    expect([...envelopeSchema.required].sort()).toEqual([...REQUIRED].sort());
  });

  it('does not require `data`, because the per-event data contract is the allowlist layer', () => {
    expect(envelopeSchema.required).not.toContain('data');
  });

  it.runIf(Ajv)('accepts a well-formed envelope', () => {
    const validate = makeValidator();
    expect(validate(baseEnvelope())).toBe(true);
  });

  it.runIf(Ajv).each(REQUIRED)('rejects an envelope missing `%s`', (field) => {
    const validate = makeValidator();
    const line = baseEnvelope();
    delete line[field];
    expect(validate(line)).toBe(false);
  });

  it.runIf(Ajv)('rejects an unknown envelope key (allowlist, not denylist)', () => {
    const validate = makeValidator();
    expect(validate(baseEnvelope({ mission: 'M-20260902-001' }))).toBe(false);
  });

  it.runIf(Ajv)('rejects a source outside the 8-value enum', () => {
    const validate = makeValidator();
    expect(validate(baseEnvelope({ source: 'orchestrator' }))).toBe(false);
  });

  it.runIf(Ajv)('accepts every one of the 8 source values', () => {
    const validate = makeValidator();
    for (const source of envelopeSchema.properties.source.enum) {
      expect(validate(baseEnvelope({ source }))).toBe(true);
    }
  });

  it.runIf(Ajv)('accepts both mission_id forms and rejects a bare session id', () => {
    const validate = makeValidator();
    expect(validate(baseEnvelope({ mission_id: 'M-20260902-001' }))).toBe(true);
    // session fallback, lane 6 §2.5
    expect(validate(baseEnvelope({ mission_id: 'M-20260902-S04c7da6b' }))).toBe(
      true,
    );
    // NNN may run past three digits, so a day with more than 999 missions
    // cannot overflow the id space.
    expect(validate(baseEnvelope({ mission_id: 'M-20260902-1000' }))).toBe(true);
    expect(validate(baseEnvelope({ mission_id: 'tyc5j4' }))).toBe(false);
    expect(validate(baseEnvelope({ mission_id: 'M-20260902-01' }))).toBe(false);
  });

  it('uses byte-identical mission_id patterns with review-output.schema.json', async () => {
    // A mission_id accepted in a review must be accepted in the ledger; two
    // hand-maintained regexes for one id format would drift apart silently.
    // Compare PARSED values -- the raw JSON text double-escapes each backslash.
    const review = await loadJson(path.join(SCHEMAS_DIR, 'review-output.schema.json'));
    const found = [];
    const walk = (node) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') {
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'pattern' && typeof value === 'string' && value.startsWith('^M-')) {
          found.push(value);
        }
        walk(value);
      }
    };
    walk(review);
    expect(found.length, 'no mission_id pattern in review-output.schema.json').toBeGreaterThan(0);
    for (const pattern of found) {
      expect(pattern).toBe(envelopeSchema.properties.mission_id.pattern);
    }
  });

  it.runIf(Ajv)('rejects a timestamp with no offset', () => {
    const validate = makeValidator();
    expect(validate(baseEnvelope({ ts: '2026-09-02T15:30:00' }))).toBe(false);
  });

  it.runIf(Ajv)('accepts the optional correlation ids added by Hardening §3·§11·§29', () => {
    const validate = makeValidator();
    const line = baseEnvelope({
      action_id: 'A-7',
      task_id: 'T-15',
      run_id: 'run-abc',
      routing_epoch_id: 'epoch-3',
      idempotency_key: 'mission:M-20260902-001:review:rev-2',
      worker: 'ledger',
      model: 'claude-opus-5',
      actor: { type: 'agent', id: 'autopilot-tyc5j4-T15' },
    });
    expect(validate(line)).toBe(true);
  });
});

describe('event vocabulary — the allowlist is the single source of truth', () => {
  it('the envelope schema does not carry a copy of the event enum', () => {
    // Two enums would be two sources of truth and would drift. `event` is
    // pattern-constrained in the envelope; membership belongs to the allowlist.
    expect(envelopeSchema.properties.event.enum).toBeUndefined();
    expect(envelopeSchema.properties.event.pattern).toBeTypeOf('string');
  });

  it('every registered event name matches the dotted vocabulary pattern', () => {
    const pattern = new RegExp(envelopeSchema.properties.event.pattern);
    for (const name of Object.keys(allowlist.events)) {
      expect(name, `${name} is not a dotted event name`).toMatch(pattern);
    }
  });

  it('rejects an unregistered event even when the envelope is well-formed', () => {
    const line = baseEnvelope({ event: 'mission.exploded' });
    const validate = makeValidator();
    if (validate) {
      // The envelope layer alone cannot catch this — that is why there are two.
      expect(validate(line)).toBe(true);
    }
    expect(checkAgainstAllowlist(line)).toEqual({
      ok: false,
      reason: 'unregistered_event',
    });
  });

  it('registers ledger.rejected, so the rejection path cannot itself be rejected', () => {
    expect(allowlist.events['ledger.rejected']).toBeDefined();
    expect(allowlist.events['ledger.rejected'].required).toEqual([
      'raw_event',
      'reason',
    ]);
    const rejection = baseEnvelope({
      event: 'ledger.rejected',
      data: { raw_event: '{"event":"mission.exploded"}', reason: 'unregistered_event' },
    });
    expect(checkAgainstAllowlist(rejection).ok).toBe(true);
  });

  it('every event declares required data fields, or marks the gap explicitly', () => {
    // An empty `required` must be a stated gap, never an unexplained zero —
    // otherwise absence of a rule reads as a rule of absence.
    for (const [name, spec] of Object.entries(allowlist.events)) {
      expect(spec.spec, `${name} has no source citation`).toBeTypeOf('string');
      if (spec.data_schema) {
        // Constrained in full by the referenced receipt schema. Restating any
        // of its keys here would recreate the two-sources-of-truth problem the
        // T-15/T-16 ruling removed, so `required` must be absent, not empty.
        expect(spec.required, `${name} has data_schema AND required`).toBeUndefined();
        expect(spec.fields, `${name} has data_schema AND fields`).toBeUndefined();
        continue;
      }
      expect(Array.isArray(spec.required), `${name}.required`).toBe(true);
      const constrained =
        spec.required.length + (spec.required_envelope ?? []).length;
      if (constrained === 0) {
        expect(
          spec.unspecified_required,
          `${name} constrains no field and carries no gap marker`,
        ).toBe(true);
      }
    }
  });

  it('every enum_ref resolves to a declared enum', () => {
    for (const [name, spec] of Object.entries(allowlist.events)) {
      for (const [key, fieldSpec] of Object.entries(spec.fields ?? {})) {
        if (!fieldSpec.enum_ref) continue;
        expect(
          allowlist.enums[fieldSpec.enum_ref],
          `${name}.data.${key} -> enums.${fieldSpec.enum_ref}`,
        ).toBeDefined();
      }
    }
    for (const key of Object.keys(allowlist.enums)) {
      expect(allowlist.enum_sources[key], `enums.${key} has no cited source`).toBeTypeOf('string');
    }
  });

  it('rejects a data value outside its enum', () => {
    const bad = baseEnvelope({
      event: 'topology.selected',
      source: 'scheduler',
      data: { mode: 'hivemind' },
    });
    expect(checkAgainstAllowlist(bad)).toEqual({
      ok: false,
      reason: 'bad_enum_value',
      key: 'mode',
    });
    bad.data.mode = 'autopilot_fast';
    expect(checkAgainstAllowlist(bad).ok).toBe(true);
  });

  it('leaves the route decision vocabulary to route-receipt.schema.json', () => {
    // Design section 8.2 fixes five values (route|pin|switch|escalate|downgrade),
    // and T-16's route-receipt owns them. Keeping a copy here would be a second
    // source of truth, so the allowlist must NOT declare a route_decision enum.
    expect(allowlist.enums.route_decision).toBeUndefined();
    expect(allowlist.events['route.selected'].data_schema).toBe(
      'route-receipt.schema.json',
    );
    const receipt = dataSchemas.get('route-receipt.schema.json');
    expect(receipt.properties.decision.properties.type.enum).toEqual([
      'route',
      'pin',
      'switch',
      'escalate',
      'downgrade',
    ]);
  });

  it('keeps verify.completed.result able to express UNMEASURED', () => {
    // design §3.4: "UNMEASURED 가 1급 상태 — 재지 못한 층을 PASS 라 부르지 않는다".
    // Without this value an unmeasured layer would have to be written as a
    // false pass or dropped, which is the exact failure the design guards.
    expect(allowlist.enums.verify_result).toContain('unmeasured');
  });

  it('declares verify.completed.layer as an optional untyped-vocabulary string', () => {
    // T-51 review #5. The layer vocabulary belongs to
    // lib/verification/unified-verifier.js (exported LAYERS), so this field
    // carries no enum_ref on purpose: that module can add a layer without an
    // allowlist edit, and a copied enum here would drift from it silently.
    const spec = allowlist.events['verify.completed'];
    expect(spec.fields.layer).toBeDefined();
    expect(spec.fields.layer.type).toBe('string');
    expect(spec.fields.layer.enum_ref).toBeUndefined();
    // Optional: declaring it must not reject a line that was valid before.
    expect(spec.required).toEqual(['result', 'evidence']);
  });

  it('declares question_id identically on human.asked and human.resolved', () => {
    // T-40 measured the gap: human.asked required question_id while
    // human.resolved did not declare it at all, so an asked line could never be
    // joined to the resolution that answered it. The pairing is load-bearing --
    // an asked with no resolved is the signature of "guessed instead of asking"
    // and blocks outcome.md generation (design section 3.4, OD-5).
    const asked = allowlist.events['human.asked'].fields.question_id;
    const resolved = allowlist.events['human.resolved'].fields.question_id;
    expect(asked).toBeDefined();
    expect(resolved).toBeDefined();
    expect(resolved).toEqual(asked);
    expect(asked.type).toBe('string');
  });

  it('keeps question_id required on human.asked and optional on human.resolved', () => {
    // Declaring the field must not widen or narrow either side: the hook that
    // writes human.asked cannot omit it, and human.resolved -- which T-40 found
    // has zero producers today -- gains a join key without gaining a new way to
    // be rejected.
    expect(allowlist.events['human.asked'].required).toContain('question_id');
    expect(allowlist.events['human.resolved'].required).not.toContain('question_id');
    expect(allowlist.events['human.resolved'].required).toEqual(['decision']);
  });

  it('allows mission.completed.accepted to be null for a deferred verdict', () => {
    const deferred = baseEnvelope({
      event: 'mission.completed',
      data: { accepted: null, evidence_refs: [] },
    });
    expect(checkAgainstAllowlist(deferred).ok).toBe(true);
    const settled = baseEnvelope({
      event: 'mission.completed',
      data: { accepted: true, evidence_refs: ['E-001'], supersedes: 'evt-1' },
    });
    expect(checkAgainstAllowlist(settled).ok).toBe(true);
  });
});

describe('data_schema — the receipt schema validates the event data', () => {
  // T-15 <-> T-16 leader ruling: for route.selected, usage.receipt and
  // context.compiled the receipt schema IS the data contract (design section
  // 8.2, "receipt = event data"), and lane 6 section 5-2's flat keys are a
  // pre-section-8 draft that is now retired.
  const REFS = [
    ['route.selected', 'route-receipt.schema.json'],
    ['usage.receipt', 'attempt-receipt.schema.json'],
    ['context.compiled', 'context-receipt.schema.json'],
  ];

  it.each(REFS)('%s delegates its data contract to %s', (event, file) => {
    const spec = allowlist.events[event];
    expect(spec.data_schema).toBe(file);
    expect(spec.required).toBeUndefined();
    expect(dataSchemas.get(file)).toBeDefined();
  });

  it('every data_schema names a file that exists and declares required keys', () => {
    for (const [file, schema] of dataSchemas) {
      expect(schema.type, `${file} is not an object schema`).toBe('object');
      expect(
        Array.isArray(schema.required) && schema.required.length > 0,
        `${file} constrains nothing, so delegating to it would be fail-open`,
      ).toBe(true);
    }
  });

  it.runIf(Ajv)('validates data against the referenced schema, fail-closed', () => {
    // The point of the ruling: an empty or wrong `data` must be REJECTED by the
    // receipt schema, not waved through because this allowlist lists no keys.
    for (const [event, file] of REFS) {
      const empty = baseEnvelope({ event, data: {} });
      expect(checkAgainstAllowlist(empty), `${event} accepted empty data`).toEqual({
        ok: false,
        reason: 'data_schema_invalid',
        schema: file,
      });
    }
  });

  it.runIf(Ajv)('rejects data carrying a key the receipt schema does not define', () => {
    const validate = compileSchema(dataSchemas.get('attempt-receipt.schema.json'));
    expect(validate({ not_a_receipt_field: 1 })).toBe(false);
  });

  it('lets route.selected be emitted by the hook that actually writes it', () => {
    // The Observe-phase writer is the SubagentStart hook (T-31), which had been
    // setting source:'scheduler' only because this list allowed nothing else.
    // Labelling an emitter as something it is not, to satisfy a schema, is the
    // defect rather than the fix -- so the vocabulary follows the fact.
    // `scheduler` stays for the cognitive-router path from Canary onward.
    expect(allowlist.events['route.selected'].sources).toContain('hook');
    expect(allowlist.events['route.selected'].sources).toContain('scheduler');
  });

  it('does not copy any enum the receipt schema owns', () => {
    // route-receipt owns decision.type; a duplicate here would drift.
    expect(allowlist.enums.route_decision).toBeUndefined();
  });
});

describe('source enum — no fork from the vNext supervisor vocabulary', () => {
  it('matches lib/supervisor/event-types.js SOURCES verbatim and in order', async () => {
    const raw = await readFile(EVENT_TYPES_PATH, 'utf-8');
    const block = raw.match(/export const SOURCES = Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(block, 'SOURCES block not found in lib/supervisor/event-types.js').not.toBeNull();
    const measured = [...block[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(envelopeSchema.properties.source.enum).toEqual(measured);
  });

  it('every required_envelope key is a real envelope property', () => {
    // A field must have exactly one home. lane 6 §5-② lists `model` and
    // `worker` among some events' required fields; they live at the envelope
    // level, so they are declared here as required_envelope rather than being
    // duplicated into `data`.
    const props = new Set(Object.keys(envelopeSchema.properties));
    for (const [name, spec] of Object.entries(allowlist.events)) {
      for (const key of spec.required_envelope ?? []) {
        expect(props.has(key), `${name} requires envelope key "${key}"`).toBe(true);
        expect(envelopeSchema.required, `${key} is already always-required`).not.toContain(key);
        expect(spec.required, `${name} duplicates "${key}" into data`).not.toContain(key);
      }
    }
  });

  it("every event's declared sources are a subset of the envelope enum", () => {
    const allowed = new Set(envelopeSchema.properties.source.enum);
    for (const [name, spec] of Object.entries(allowlist.events)) {
      if (!spec.sources) continue; // omitted = any of the 8
      for (const source of spec.sources) {
        expect(allowed.has(source), `${name} declares source "${source}"`).toBe(true);
      }
    }
  });
});

/**
 * The six "Recommended event examples" in package-v1.1/11_REVIEW_OUTCOME_LEDGER.md:60-65,
 * verbatim. The design's promise about them (§3.6, lane 6 §2.2) is
 * "v1.1 예시 6줄은 그대로 유효 — 봉투 필드는 추가만, 삭제 없음": the NAMES stay in
 * the vocabulary and the payload keys survive. It is not, and cannot be, a
 * promise that the raw lines validate — lane 6 §2.2 says so itself, noting that
 * model.switched and review.completed carry no mission_id while the central
 * ledger requires one. The tests below pin both halves of that.
 */
const V1_1_EXAMPLES = [
  { event: 'mission.created', mission_id: 'M-001' },
  { event: 'worker.claimed', mission_id: 'M-001', worker: 'routing' },
  { event: 'plan.revised', mission_id: 'M-001', revision: 3 },
  { event: 'model.switched', from: 'sonnet', to: 'opus', reason: 'complex_failure' },
  { event: 'review.completed', model: 'fable-5.1', verdict: 'pass' },
  { event: 'mission.completed', mission_id: 'M-001', accepted: true },
];

/** Lift a flat v1.1 example into the envelope: envelope-level keys stay at the
 *  top, everything else becomes `data`, and a missing mission_id takes the
 *  session fallback (lane 6 §2.5). */
function wrapExample(example) {
  const ENVELOPE_KEYS = new Set(['event', 'mission_id', 'worker', 'model']);
  const data = {};
  const top = {};
  for (const [key, value] of Object.entries(example)) {
    if (ENVELOPE_KEYS.has(key)) top[key] = value;
    else data[key] = value;
  }
  return {
    v: 1,
    ts: '2026-09-02T15:30:00+09:00',
    session_id: 'ap-20260902-062936-tyc5j4',
    source: 'hook',
    pid: 4242,
    seq: 0,
    ...top,
    mission_id: top.mission_id ? 'M-20260902-001' : 'M-20260902-S04c7da6b',
    data,
  };
}

describe('v1.1 §11 example lines', () => {
  it('all six event names are registered', () => {
    for (const example of V1_1_EXAMPLES) {
      expect(allowlist.events[example.event], example.event).toBeDefined();
      expect(allowlist.events[example.event].v1_1_example).toBe(true);
    }
  });

  it('marks exactly those six as v1_1_example', () => {
    const marked = Object.entries(allowlist.events)
      .filter(([, spec]) => spec.v1_1_example)
      .map(([name]) => name);
    expect(marked.sort()).toEqual(V1_1_EXAMPLES.map((e) => e.event).sort());
  });

  it('keeps every payload key of every example — fields are added, never deleted', () => {
    for (const example of V1_1_EXAMPLES) {
      const wrapped = wrapExample(example);
      const survivors = new Set([...Object.keys(wrapped), ...Object.keys(wrapped.data)]);
      for (const key of Object.keys(example)) {
        expect(survivors.has(key), `${example.event} lost key "${key}"`).toBe(true);
      }
    }
  });

  it.runIf(Ajv)('every example passes the envelope schema once wrapped', () => {
    const validate = makeValidator();
    for (const example of V1_1_EXAMPLES) {
      const wrapped = wrapExample(example);
      expect(validate(wrapped), `${example.event}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it.runIf(Ajv)('none of the raw lines pass — the central ledger is stricter than v1.1', () => {
    // Pinned so nobody later "fixes" a failing example by loosening the
    // envelope. The raw lines carry no v/ts/session_id/source/pid/seq, and two
    // of the six carry no mission_id at all (lane 6 §2.2).
    const validate = makeValidator();
    for (const example of V1_1_EXAMPLES) {
      expect(validate(example), `${example.event} unexpectedly validated raw`).toBe(false);
    }
  });

  it('two of the six carry no mission_id, which the central ledger requires', () => {
    const withoutMission = V1_1_EXAMPLES.filter((e) => !e.mission_id).map((e) => e.event);
    expect(withoutMission).toEqual(['model.switched', 'review.completed']);
  });

  it('the examples satisfy the envelope but not yet the per-event data contract', () => {
    // plan.revised{revision:3} has no `mode`; review.completed has no
    // findings_ref and a legacy lowercase verdict that T-17's adapter folds
    // into the v2 vocabulary. This is the two layers doing different jobs.
    const planRevised = wrapExample(V1_1_EXAMPLES[2]);
    expect(checkAgainstAllowlist(planRevised)).toEqual({
      ok: false,
      reason: 'missing_data',
      missing: ['mode'],
    });

    const reviewCompleted = wrapExample(V1_1_EXAMPLES[4]);
    expect(checkAgainstAllowlist(reviewCompleted)).toEqual({
      ok: false,
      reason: 'missing_data',
      missing: ['findings_ref'],
    });
    expect(allowlist.enums.review_verdict).not.toContain('pass');
  });
});

describe('the 4KB line cap belongs to the writer, not to these schemas', () => {
  it('states the cap once, as data, without pretending to enforce it', () => {
    expect(allowlist.limits.line_max_bytes).toBe(4096);
    expect(allowlist.limits.overflow_field).toBe('evidence_refs');
  });

  it.runIf(Ajv)('a 5KB line still passes the envelope schema — by design', () => {
    // Not a gap being papered over: JSON Schema cannot measure the serialized
    // byte length of the document validating against it. T-20's writer checks
    // Buffer.byteLength before append; its gate is
    // tests/firewall/ledger-append-survival.test.js.
    const validate = makeValidator();
    const fat = baseEnvelope({
      data: { title: 'x'.repeat(5 * 1024), intent_revision: 1 },
    });
    expect(Buffer.byteLength(JSON.stringify(fat), 'utf8')).toBeGreaterThan(4096);
    expect(validate(fat)).toBe(true);
  });
});
