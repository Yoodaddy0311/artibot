/**
 * Firewall gate — the ledger's event vocabulary has exactly one home, and it
 * is an allowlist.
 *
 * TWO FAILURES THIS GATE EXISTS TO CATCH.
 *
 *  1. A FORKED VOCABULARY. `schemas/ledger-events.allowlist.json` is the single
 *     source of truth (Hardening §46 "canonical 1개"). The moment the writer
 *     grows its own list of event names, the two drift and the file stops being
 *     the answer. This suite reads the writer's SOURCE and requires that the
 *     36 names appear nowhere in it.
 *
 *  2. A DENYLIST BY ACCIDENT. A negative list is fail-open for every name
 *     invented after it was written (verification-discipline §8). The direction
 *     is asserted behaviorally: a well-formed but unregistered name is refused,
 *     and the refusal is recorded.
 *
 * It also holds the vocabulary's internal references closed — every `sources`
 * value, `enum_ref`, and `data_schema` must resolve — because a dangling
 * reference silently disables the check that depends on it, which is a gate
 * that passes while measuring nothing.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ────────────────────────────────────
 *   - WHETHER THE 36 NAMES ARE THE RIGHT 36. Membership is a design decision
 *     (lane 6 §5-②). This checks internal consistency, never adequacy.
 *   - WHETHER ANY EVENT IS EVER EMITTED. Phase 0 has zero callers, so a
 *     registered event with no writer looks identical here to one in daily use.
 *     Emission counts are the Existence Audit's measurement, not this file's.
 *   - WHETHER ajv STAYS AVAILABLE. The oracle below is `require('ajv')`, which
 *     resolves in this checkout only as a transitive of eslint and is declared
 *     in no package.json. If eslint drops it, this file goes RED with a module
 *     error rather than quietly skipping — a loud failure is the correct
 *     outcome, but the fix is to declare ajv in devDependencies, not here.
 *   - RECEIPTS AT RUNTIME. The oracle runs in the test process. The WRITER uses
 *     a dependency-free subset validator, and what is asserted below is that
 *     the two agree on these fixtures — not that they agree on every possible
 *     document.
 *
 * @module tests/firewall/ledger-vocab-allowlist
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SOURCES } from '../../lib/supervisor/event-types.js';
import {
  EVENT_RE,
  getAllowlist,
  MISSION_ID_RE,
  OPTIONAL_ENVELOPE_KEYS,
  REJECTED_EVENT,
  REQUIRED_ENVELOPE_KEYS,
  TS_RE,
  UNCHECKED_SCHEMA_KEYWORDS,
  validateAgainstSchema,
  writeEvent,
} from '../../lib/runtime/event-writer.js';
import { readAllEvents } from '../../lib/runtime/ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, '..', '..');
const SCHEMA_DIR = path.join(PLUGIN_ROOT, 'schemas');
const WRITER_SRC = path.join(PLUGIN_ROOT, 'lib', 'runtime', 'event-writer.js');
const LEDGER_SRC = path.join(PLUGIN_ROOT, 'lib', 'runtime', 'ledger.js');

/** The event-name pattern from schemas/ledger-envelope.schema.json. */
const EVENT_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;

/**
 * Load a schema file from schemas/.
 * @param {string} file
 * @returns {object}
 */
function schema(file) {
  return JSON.parse(readFileSync(path.join(SCHEMA_DIR, file), 'utf-8'));
}

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-ledger-vocab-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('one canonical vocabulary', () => {
  it('registers a non-empty event set (scanner self-check)', () => {
    // Without this, every "for each event" assertion below would pass
    // vacuously on an empty or unreadable allowlist.
    const names = Object.keys(getAllowlist().events);
    expect(names.length).toBeGreaterThanOrEqual(30);
  });

  it('does not repeat any event name inside the writer source', () => {
    const src = readFileSync(WRITER_SRC, 'utf-8');
    const names = Object.keys(getAllowlist().events);
    const hardcoded = names.filter((n) => src.includes(`'${n}'`) || src.includes(`"${n}"`));
    // `ledger.rejected` is the one exception and it is exported as
    // REJECTED_EVENT: the writer must name the event it writes when it refuses
    // another, and that line is the only one it originates itself.
    expect(hardcoded).toEqual([REJECTED_EVENT]);
  });

  it('states the line cap identically in the allowlist and in config', () => {
    const cfg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));
    expect(getAllowlist().limits.line_max_bytes).toBe(4096);
    expect(cfg.ledger.maxLineBytes).toBe(getAllowlist().limits.line_max_bytes);
  });

  it('keeps both ledger schemas parseable', () => {
    // A schema that does not parse cannot constrain anything, and the failure
    // is silent to every reader that wraps its load in a try/catch.
    expect(() => schema('ledger-envelope.schema.json')).not.toThrow();
    expect(() => schema('ledger-events.allowlist.json')).not.toThrow();
  });
});

describe('every copy of the vocabulary is checked against the allowlist', () => {
  /**
   * Quoted dotted-event literals in a source file. The quotes anchor the match,
   * so an import specifier like './event-writer.js' cannot look like an event.
   *
   * @param {string} file
   * @returns {string[]} unique names, in first-appearance order
   */
  function hardcodedEventNames(file) {
    const src = readFileSync(file, 'utf-8');
    const found = src.match(/'[a-z][a-z0-9]*\.[a-z][a-z0-9_]*'/g) ?? [];
    return [...new Set(found.map((q) => q.slice(1, -1)))];
  }

  it('registers every event name hardcoded in ledger.js', () => {
    // The fold has to branch on specific events, so hardcoding is legitimate
    // HERE — unlike in the writer, where any name is a forked vocabulary. What
    // must hold is that each branch names an event that actually exists: a typo
    // or a renamed event produces a branch that silently never fires, and a
    // fold that quietly returns zeros looks exactly like a quiet mission.
    const names = hardcodedEventNames(LEDGER_SRC);
    const registered = Object.keys(getAllowlist().events);
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      expect(registered, `ledger.js hardcodes '${name}'`).toContain(name);
    }
  });

  it('scans both runtime files, not just the writer', () => {
    // T-50's finding: the scanner above this one reads event-writer.js alone,
    // so ledger.js could drift without any gate noticing. Asserted so the
    // coverage cannot quietly narrow again.
    for (const file of [WRITER_SRC, LEDGER_SRC]) {
      expect(readFileSync(file, 'utf-8').length).toBeGreaterThan(0);
    }
    expect(hardcodedEventNames(LEDGER_SRC).length).toBeGreaterThan(0);
  });

  it('matches the envelope schema on which keys are required', () => {
    // REQUIRED_ENVELOPE_KEYS is a second copy of the schema's `required`. The
    // writer rejects any line missing one of these, so a schema that gained or
    // dropped a required key while this list stood still would make the writer
    // and the schema disagree about what a valid line is.
    const required = schema('ledger-envelope.schema.json').required;
    expect([...REQUIRED_ENVELOPE_KEYS]).toEqual(required);
  });

  it('keeps the optional keys exactly complementary to the schema', () => {
    // Together the two lists are the closed key set the writer enforces
    // against `additionalProperties:false`. If the schema adds a property and
    // neither list gains it, the writer rejects a line the schema allows.
    const props = Object.keys(schema('ledger-envelope.schema.json').properties);
    const declared = [...REQUIRED_ENVELOPE_KEYS, ...OPTIONAL_ENVELOPE_KEYS];
    expect([...declared].sort()).toEqual([...props].sort());
  });
});

describe('the writer regex copies match the schema they copy', () => {
  it('carries the envelope pattern strings byte for byte', () => {
    // The writer validates without a JSON Schema engine, so these three
    // patterns exist twice. A schema widened on its own would make the writer
    // reject lines the schema now allows — silently, and only in production.
    const props = schema('ledger-envelope.schema.json').properties;
    expect(MISSION_ID_RE.source).toBe(props.mission_id.pattern);
    expect(EVENT_RE.source).toBe(props.event.pattern);
    expect(TS_RE.source).toBe(props.ts.pattern);
  });

  it('reads real patterns, not undefined on both sides', () => {
    // Scanner self-check: if the schema lost these keys, the assertions above
    // would compare undefined to undefined and pass while measuring nothing.
    const props = schema('ledger-envelope.schema.json').properties;
    for (const key of ['mission_id', 'event', 'ts']) {
      expect(typeof props[key].pattern, key).toBe('string');
      expect(props[key].pattern.length).toBeGreaterThan(10);
    }
  });
});

describe('internal references all resolve', () => {
  it('gives every event a name the envelope schema would accept', () => {
    for (const name of Object.keys(getAllowlist().events)) {
      expect(name, name).toMatch(EVENT_PATTERN);
    }
  });

  it('draws every sources value from the one source enum', () => {
    const envelopeSources = schema('ledger-envelope.schema.json').properties.source.enum;
    // The envelope enum is the supervisor enum verbatim — do not fork this list.
    expect(envelopeSources).toEqual([...SOURCES]);
    for (const [name, spec] of Object.entries(getAllowlist().events)) {
      for (const s of spec.sources ?? []) {
        expect(envelopeSources, `${name} -> ${s}`).toContain(s);
      }
    }
  });

  it('resolves every enum_ref to a declared enum', () => {
    const { events, enums } = getAllowlist();
    for (const [name, spec] of Object.entries(events)) {
      for (const [field, decl] of Object.entries(spec.fields ?? {})) {
        if (typeof decl?.enum_ref !== 'string') continue;
        expect(Array.isArray(enums[decl.enum_ref]), `${name}.${field}`).toBe(true);
        expect(enums[decl.enum_ref].length).toBeGreaterThan(0);
      }
    }
  });

  it('resolves every data_schema to a schema file that declares required keys', () => {
    const withSchema = Object.entries(getAllowlist().events)
      .filter(([, spec]) => typeof spec.data_schema === 'string');
    // Three receipt events carry their contract in a sibling schema.
    expect(withSchema.map(([n]) => n).sort())
      .toEqual(['context.compiled', 'route.selected', 'usage.receipt']);
    for (const [name, spec] of withSchema) {
      const file = path.join(SCHEMA_DIR, spec.data_schema);
      expect(existsSync(file), `${name} -> ${spec.data_schema}`).toBe(true);
      expect(Array.isArray(schema(spec.data_schema).required)).toBe(true);
      // A data_schema event must not ALSO restate keys in `required`, or the
      // contract would have two homes.
      expect(spec.required, name).toBeUndefined();
    }
  });

  it('registers its own rejection event, so a refusal is never silent', () => {
    const spec = getAllowlist().events[REJECTED_EVENT];
    expect(spec).toBeDefined();
    expect(spec.required).toEqual(['raw_event', 'reason']);
  });

  it('marks an unspecified required list as a known gap, not as zero', () => {
    // `unspecified_required` tells a reader "no source states these fields"
    // apart from "this event deliberately requires nothing".
    for (const [name, spec] of Object.entries(getAllowlist().events)) {
      if (spec.unspecified_required !== true) continue;
      expect((spec.required ?? []), name).toHaveLength(0);
    }
  });
});

describe('the writer treats it as an allowlist, not a denylist', () => {
  /**
   * @param {object} over
   * @returns {object}
   */
  function attempt(over) {
    return writeEvent(root, {
      session_id: 'sess-vocab-0001',
      source: 'hook',
      mission_id: 'M-20260902-001',
      ...over,
    });
  }

  it('refuses a well-formed name that is not registered', () => {
    // The name satisfies the envelope pattern; only membership stops it. That
    // is the whole difference between an allowlist and a shape check.
    const res = attempt({ event: 'future.invention', data: { anything: 1 } });
    expect(EVENT_PATTERN.test('future.invention')).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unregistered-event');
  });

  it('records every refusal as a ledger.rejected line', () => {
    attempt({ event: 'future.invention', data: {} });
    attempt({ event: 'another.invention', data: {} });
    const written = readAllEvents(root, { includeRejected: true });
    expect(written).toHaveLength(2);
    expect(written.map((e) => e.event)).toEqual([REJECTED_EVENT, REJECTED_EVENT]);
    expect(written.map((e) => e.data.raw_event))
      .toEqual(['future.invention', 'another.invention']);
    // The refused events themselves are absent from the mission history.
    expect(readAllEvents(root)).toHaveLength(0);
  });

  it('accepts a registered event with a conforming payload', () => {
    const res = attempt({ event: 'tool.used', data: { tool: 'Bash', ok: true, duration_ms: 1 } });
    expect(res.ok).toBe(true);
    expect(readAllEvents(root).map((e) => e.event)).toEqual(['tool.used']);
  });
});

// ---------------------------------------------------------------------------
// ajv as the reference oracle for the writer's subset validator
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/**
 * Compile a receipt schema with a real validator.
 *
 * ajv is deliberately NOT imported by `lib/`: it resolves here only because
 * eslint depends on it, and `lib/` imports nothing outside `node:` builtins.
 * It is legitimate in a test — where node_modules exists by definition — and
 * illegitimate in a hook process, which is why the writer hand-rolls a subset
 * and this file measures the distance between the two.
 *
 * @param {object} doc the schema document to compile
 * @returns {(data: unknown) => boolean}
 */
function compileWithAjv(doc) {
  const Ajv = require('ajv');
  return new Ajv({ allErrors: false, strict: false }).compile(doc);
}

/**
 * A model identity satisfying the shared `#/definitions/model_identity`.
 * @param {object} [over]
 * @returns {object}
 */
function modelIdentity(over = {}) {
  return {
    provider: 'anthropic',
    family: 'claude',
    tier: 'opus',
    model_id: 'claude-opus-5',
    version: '2026-09-01',
    catalog_version: '1',
    ...over,
  };
}

/**
 * A route receipt that satisfies its schema in full.
 * @param {object} [over]
 * @returns {object}
 */
function routeReceipt(over = {}) {
  const term = () => ({ value: 0, measured: true });
  return {
    schema_version: 1,
    route_receipt_id: 'rr-1',
    mission_id: 'M-20260902-001',
    session_id: 'sess-vocab-0001',
    execution_profile_version: 1,
    routing_epoch_id: 'ep-1',
    action: { type: 'implement', phase: 'build', complexity: 0.5 },
    models: { current: null, recommended: modelIdentity(), selected: modelIdentity() },
    decision: { type: 'route' },
    predicted: { success: 0.9, cost: 0.2, latency: 1200, retry_probability: 0.1 },
    transition: {
      context_rebuild_tokens: 0,
      cache_loss_estimate: 0,
      handoff_tokens: 0,
      predicted_time_ms: 0,
      predicted_cost: 0,
    },
    terms: {
      contextSerialization: term(),
      contextRebuild: term(),
      cacheLoss: term(),
      handoffTokens: term(),
      handoffLatency: term(),
      reorientationRisk: term(),
      expectedRetry: term(),
    },
    actionsSinceSwitch: 0,
    reason: ['policy'],
    timestamp: '2026-09-02T00:00:00.000Z',
    ...over,
  };
}

/**
 * Drop one key, returning a new object.
 * @param {object} o
 * @param {string} k
 * @returns {object}
 */
function without(o, k) {
  const copy = { ...o };
  delete copy[k];
  return copy;
}

describe('the writer subset validator agrees with a real validator', () => {
  /**
   * Fixtures spanning every keyword the subset claims to enforce, each paired
   * with the verdict ajv gives it.
   * @returns {Array<[string, object]>}
   */
  function fixtures() {
    return [
      ['valid receipt', routeReceipt()],
      ['decision as a flat string', routeReceipt({ decision: 'route' })],
      ['decision.type outside the enum', routeReceipt({ decision: { type: 'teleport' } })],
      ['undeclared top-level key', routeReceipt({ surprise: 1 })],
      ['missing required key', without(routeReceipt(), 'decision')],
      ['const violation', routeReceipt({ schema_version: 2 })],
      ['enum violation behind a $ref', routeReceipt({
        models: {
          current: null,
          recommended: modelIdentity(),
          selected: modelIdentity({ tier: 'giant' }),
        },
      })],
      ['maximum violation', routeReceipt({
        predicted: { success: 1.5, cost: 0, latency: 0, retry_probability: 0 },
      })],
      ['empty array is allowed', routeReceipt({ reason: [] })],
      ['array item type violation', routeReceipt({ reason: [3] })],
      ['nested required key missing', routeReceipt({
        models: { current: null, recommended: modelIdentity() },
      })],
      ['minLength violation', routeReceipt({ route_receipt_id: '' })],
      ['integer where a string belongs', routeReceipt({ routing_epoch_id: 7 })],
    ];
  }

  it('reaches the same verdict as ajv on every fixture', () => {
    const schemaDoc = schema('route-receipt.schema.json');
    const ajvValidate = compileWithAjv(schemaDoc);
    const disagreements = [];
    for (const [name, data] of fixtures()) {
      const ajvOk = ajvValidate(data);
      const mine = validateAgainstSchema(data, schemaDoc);
      if (ajvOk !== (mine === null)) {
        disagreements.push(`${name}: ajv=${ajvOk ? 'valid' : 'invalid'} writer=${mine ?? 'valid'}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('exercises both verdicts, so agreement is not vacuous', () => {
    // Without this, a validator that called everything valid would agree with
    // ajv on a fixture set that happened to be all-valid.
    const schemaDoc = schema('route-receipt.schema.json');
    const verdicts = fixtures().map(([, data]) => validateAgainstSchema(data, schemaDoc) === null);
    expect(verdicts.filter(Boolean).length).toBeGreaterThan(0);
    expect(verdicts.filter((v) => !v).length).toBeGreaterThan(5);
  });

  it('agrees with ajv on a valid attempt receipt and on a broken one', () => {
    const attemptSchema = schema('attempt-receipt.schema.json');
    const ajvValidate = compileWithAjv(attemptSchema);
    const good = {
      schema_version: 1,
      run_id: 'run-1',
      mission_id: 'M-20260902-001',
      model_identity: modelIdentity(),
      usage: {
        source: 'transcript',
        fresh_input_tokens: 10,
        cached_input_tokens: 5,
        cache_creation_tokens: 0,
        output_tokens: 3,
      },
      timing: {
        started_at: '2026-09-02T00:00:00.000Z',
        completed_at: '2026-09-02T00:00:01.000Z',
        latency_ms: 1000,
      },
      outcome: { status: 'ok', accepted: null },
      cost: { total: 0.5, pricing_version: 'v1' },
    };
    expect(ajvValidate(good)).toBe(true);
    expect(validateAgainstSchema(good, attemptSchema)).toBeNull();

    const bad = { ...good, usage: { ...good.usage, source: 'api' } };
    expect(ajvValidate(bad)).toBe(false);
    expect(validateAgainstSchema(bad, attemptSchema)).toBe('enum:usage.source');
  });

  it('names the keywords it does not run, so the gap is declared', () => {
    // These are the four the route receipt actually uses and the writer skips.
    for (const kw of ['allOf', 'oneOf', 'if', 'format']) {
      expect(UNCHECKED_SCHEMA_KEYWORDS).toContain(kw);
    }
    // The shadow_of conditional is one of them, and this is the cost of
    // skipping it, measured rather than asserted: ajv rejects the document,
    // the writer lets it through.
    const schemaDoc = schema('route-receipt.schema.json');
    // Asserted, not branched on: a guard that silently skips its own
    // assertions is a gate that goes green while measuring nothing.
    expect(Object.keys(schemaDoc.properties)).toEqual(
      expect.arrayContaining(['source', 'shadow_of']),
    );
    const shadowWithoutRef = routeReceipt({ source: 'shadow' });
    expect(compileWithAjv(schemaDoc)(shadowWithoutRef)).toBe(false);
    expect(validateAgainstSchema(shadowWithoutRef, schemaDoc)).toBeNull();
  });
});
