/**
 * Firewall gate — each event's writer emits exactly the data keys its allowlist entry DECLARES:
 * `mission.checkpointed`, `adr.question_gate_evaluated`, and the optional keys of `route.bound`
 * and `review.completed` (with the ledger-fold behaviour that depends on declaring them).
 *
 * Split out of `ledger-vocab-allowlist.test.js` for the 800-line standard (V5-BACKLOG section 3);
 * the cases moved verbatim. The prelude they use (the per-test temp root) is repeated below
 * instead of shared. "above" and "below" in a moved comment refer to the original single file:
 * the generic `attempt` helper the first block mentions is the one in
 * `ledger-vocab-allowlist.test.js`. What this gate cannot see (rules §9) is in that file's header.
 *
 * @module tests/firewall/ledger-vocab-allowlist-declared-keys
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAllowlist, lineBytes, writeEvent } from '../../lib/runtime/event-writer.js';
import { shrinkToFit } from '../../lib/runtime/ledger-fold.js';
import { readAllEvents } from '../../lib/runtime/ledger.js';
import {
  buildQuestionGateData,
  INTERPRETATION_STATUS_KEY,
  QUESTION_GATE_EVENT,
} from '../../lib/runtime/question-gate-record.js';
import {
  INTENT_BINDING_STATUSES,
  parseReviewVerdict,
} from '../../lib/review/independent-reviewer.js';
import { buildReviewCompletedEvent } from '../../lib/review/verdict-writer.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-ledger-vocab-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('mission.checkpointed declares the data keys its writer emits', () => {
  /**
   * `mission.checkpointed` lists `supervisor` and `scheduler` as its only
   * `sources`, so the generic `attempt` helper above (source `hook`) would be
   * refused with `source-not-allowed` before any field check ran.
   *
   * @param {object} data
   * @returns {object}
   */
  function checkpoint(data) {
    return writeEvent(root, {
      event: 'mission.checkpointed',
      session_id: 'sess-vocab-0001',
      source: 'supervisor',
      mission_id: 'M-20260902-001',
      data,
    });
  }

  it('declares exactly checkpoint_id, trigger and resumable', () => {
    // `lib/checkpoint/save-checkpoint.js#announce` puts all three on `data`;
    // a key the allowlist does not declare is a key nothing type-checks.
    const spec = getAllowlist().events['mission.checkpointed'];
    expect(Object.keys(spec.fields).sort())
      .toEqual(['checkpoint_id', 'resumable', 'trigger']);
    expect(spec.fields.resumable.type).toEqual(['boolean', 'null']);
    // `checkpoint-service.js#announce` emits the same event WITHOUT
    // `resumable`, so declaring it must not make it mandatory.
    expect(spec.required).toEqual([]);
  });

  it('accepts resumable true, false and null, and refuses a string or a number', () => {
    // The three accepted shapes are the ones the reporter can produce:
    // `save-checkpoint.js` returns `resumable: null` when the report is
    // missing or threw, and a boolean otherwise.
    for (const resumable of [true, false, null]) {
      const res = checkpoint({ checkpoint_id: 'ckpt-1', trigger: '/save', resumable });
      expect(res.ok).toBe(true);
    }
    // `1` and `'yes'` are the truthy look-alikes a loose writer would coerce.
    for (const resumable of ['yes', 1]) {
      const bad = checkpoint({ checkpoint_id: 'ckpt-2', trigger: '/save', resumable });
      expect(bad.ok, String(resumable)).toBe(false);
      expect(bad.reason, String(resumable)).toBe('type-violation:resumable');
    }
  });

  it('lets an UNDECLARED data key through untouched', () => {
    // A RECORD OF CURRENT BEHAVIOUR, NOT A CLAIM THAT IT IS DESIRABLE.
    // `lib/runtime/event-writer.js#validateDeclaredFields` iterates
    // `Object.entries(fields)` — the DECLARED keys — so a key absent from the
    // allowlist is never type-checked and is written verbatim. Pinning it
    // means a future switch to a closed object fails here first, loudly,
    // instead of silently dropping payloads in production.
    const res = checkpoint({
      checkpoint_id: 'ckpt-3',
      trigger: '/save',
      resumable: true,
      undeclared_probe: 1,
    });
    expect(res.ok).toBe(true);
    const written = readAllEvents(root);
    expect(written).toHaveLength(1);
    expect(written[0].data.undeclared_probe).toBe(1);
  });
});

describe('adr.question_gate_evaluated declares every key its recorder emits', () => {
  /**
   * The recorder is `lib/runtime/question-gate-record.js`. Its data keys are
   * the question gate's own condition names (`GATE_CONDITIONS`) plus
   * `required` and `interpretation_present`, all booleans, and (CA-15 follow-up
   * b) `interpretation_status`, the one closed-vocabulary string.
   */
  const EVENT = QUESTION_GATE_EVENT;

  /**
   * @param {object} data
   * @param {string} [source]
   * @returns {object}
   */
  function record(data, source = 'hook') {
    return writeEvent(root, {
      event: EVENT,
      session_id: 'sess-vocab-0001',
      source,
      mission_id: 'M-20260902-001',
      data,
    });
  }

  it('is registered hook-only, with every emitted key typed boolean (the status: a closed enum) and required', () => {
    const spec = getAllowlist().events[EVENT];
    expect(spec).toBeDefined();
    expect(spec.sources).toEqual(['hook']);
    const emitted = Object.keys(buildQuestionGateData({ prompt: 'x' })).sort();
    expect(Object.keys(spec.fields).sort()).toEqual(emitted);
    // Required, not merely declared: foldOversized keeps only required keys.
    expect([...spec.required].sort()).toEqual(emitted);
    // Still exact for every key: a boolean, except the status, which must be
    // declared as the closed enum (its vocabulary is pinned in
    // tests/runtime/question-gate-record.test.js).
    for (const key of emitted) {
      if (key === INTERPRETATION_STATUS_KEY) {
        expect(spec.fields[key], key).toEqual({ enum_ref: 'interpretation_status' });
      } else {
        expect(spec.fields[key].type, key).toBe('boolean');
      }
    }
    // Not a v1.1 example and not a known gap — the six-example pin lives in
    // tests/schemas/ledger-envelope.test.js.
    expect(spec.v1_1_example).toBeUndefined();
    expect(spec.unspecified_required).toBeUndefined();
  });

  it('accepts a payload the recorder built, and only from a hook', () => {
    const data = buildQuestionGateData({ prompt: 'which one should we pick for the schema?' });
    expect(record(data).ok).toBe(true);
    const refused = record(data, 'worker');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('source-not-allowed:worker');
    expect(readAllEvents(root).map((e) => e.event)).toEqual([EVENT]);
  });

  it('refuses a truthy look-alike where a boolean belongs', () => {
    const data = buildQuestionGateData({ prompt: 'x' });
    const res = record({ ...data, valueJudgmentRequired: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('type-violation:valueJudgmentRequired');
  });

  it('refuses a payload missing the interpretation marker', () => {
    const data = { ...buildQuestionGateData({ prompt: 'x' }) };
    delete data.interpretation_present;
    const res = record(data);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing-required-data:interpretation_present');
  });
});

describe('route.bound and review.completed declare every optional key their writers emit', () => {
  // WHAT DECLARING BUYS, AND WHAT IT DOES NOT. A declared key is type- and
  // enum-checked, and fold stage 1 (`ledger-fold.js#shrinkToFit`) keeps it
  // while it drops undeclared ones. That is ALL. Neither event has an overflow
  // array, so stage 2 has nothing to cut; and once every key these writers
  // emit is declared, stage 1 has nothing to drop either. An oversized line of
  // either event therefore ends in `event-writer.js#foldOversized`, which keeps
  // REQUIRED keys only — declared or not. End-to-end preservation holds only
  // when dropping the undeclared keys alone brings the line under the cap;
  // if declared keys are large too, all non-required keys go (pinned both ways).
  const BINDING = 'review_intent_binding';

  /**
   * A route.bound input shaped like `subagent-handler.js#bindRoute`'s output.
   * @param {object} [data] data overrides
   * @returns {object}
   */
  function routeBound(data = {}) {
    return {
      event: 'route.bound',
      session_id: 'sess-vocab-0001',
      mission_id: 'M-20260902-001',
      routing_epoch_id: 'agent-abc123',
      run_id: 'agent-abc123',
      action_id: 'toolu_01',
      source: 'hook',
      data: {
        tool_use_id: 'toolu_01',
        agent_id: 'agent-abc123',
        confidence: 'exact',
        method: 'prompt_id+name',
        agent_type: 'implB',
        subagent_type: 'artibot:tdd-guide',
        matched_on: 'name',
        selected_model: 'opus',
        action_class: 'implement',
        ...data,
      },
    };
  }

  /**
   * A review.completed input from the REAL builder.
   * @param {object} [over] v2 document overrides
   * @param {string} [intentBinding]
   * @returns {object}
   */
  function reviewCompleted(over = {}, intentBinding = undefined) {
    const doc = {
      schema_version: 2,
      verdict: 'PASS',
      findings: [],
      evidence: [{ kind: 'file', file: 'lib/review/independent-reviewer.js', line: 1 }],
      recommended_action: 'proceed',
      mission_id: 'M-20260902-001',
      intent_revision: 3,
      plan_revision: 1,
      diff_ref: 'HEAD~1..HEAD',
      test_evidence: [{ kind: 'command', command: 'npx vitest run', output: 'ok' }],
      regression_evidence: [{ kind: 'command', command: 'npx vitest run', output: 'ok' }],
      verification_id: 'v1-abc',
      next_steps: [],
      ...over,
    };
    const built = buildReviewCompletedEvent({
      parsed: parseReviewVerdict(doc),
      sessionId: 'sess-vocab-0001',
      missionId: 'M-20260902-001',
      model: 'claude-opus-5-5',
      findingsRef: 'review.md',
      intentBinding,
    });
    expect(built.ok).toBe(true);
    return built.input;
  }

  /** @param {object} input @param {object} data @returns {object} */
  const withData = (input, data) => ({ ...input, data: { ...input.data, ...data } });

  /** @param {object} spec @param {string} key @returns {object} spec minus one field */
  function undeclare(spec, key) {
    const fields = { ...spec.fields };
    delete fields[key];
    return { ...spec, fields };
  }

  it('keeps the review_intent_binding enum equal to the reviewer vocabulary', () => {
    expect(getAllowlist().enums[BINDING]).toEqual([...INTENT_BINDING_STATUSES]);
    expect(INTENT_BINDING_STATUSES.length).toBeGreaterThan(0);
  });

  it.each(INTENT_BINDING_STATUSES)('accepts a real review.completed built with intent_binding %s', (s) => {
    const input = reviewCompleted({}, s);
    expect(input.data).toMatchObject({ intent_revision: 3, plan_revision: 1, intent_binding: s });
    expect(writeEvent(root, input).ok).toBe(true);
    expect(readAllEvents(root)[0].data.intent_binding).toBe(s);
  });

  it('accepts revision 0, which is a real revision', () => {
    const input = reviewCompleted({ intent_revision: 0, plan_revision: 0 });
    expect(input.data).toMatchObject({ intent_revision: 0, plan_revision: 0 });
    expect(writeEvent(root, input).ok).toBe(true);
  });

  it('accepts a route.bound shaped like bindRoute output, subagent_type included', () => {
    expect(writeEvent(root, routeBound()).ok).toBe(true);
    expect(readAllEvents(root)[0].data.subagent_type).toBe('artibot:tdd-guide');
  });

  it.each([
    ['intent_binding outside the vocabulary', () => withData(reviewCompleted(), { intent_binding: 'bogus' }),
      'enum-violation:intent_binding'],
    ['intent_revision as a string', () => withData(reviewCompleted(), { intent_revision: '3' }),
      'type-violation:intent_revision'],
    ['plan_revision as a fraction', () => withData(reviewCompleted(), { plan_revision: 1.5 }),
      'type-violation:plan_revision'],
    ['subagent_type as a number', () => routeBound({ subagent_type: 5 }),
      'type-violation:subagent_type'],
  ])('refuses %s, and records the refusal', (_label, make, reason) => {
    const res = writeEvent(root, make());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(reason);
    const rejected = readAllEvents(root, { includeRejected: true });
    expect(rejected.map((e) => e.data.reason)).toEqual([reason]);
    expect(readAllEvents(root)).toHaveLength(0);
  });

  it('negative control: a raw out-of-vocabulary intent_binding is refused, not appended', () => {
    const res = writeEvent(root, withData(reviewCompleted(), { intent_binding: 'unknown' }));
    expect(res).toMatchObject({ ok: false, reason: 'enum-violation:intent_binding' });
    expect(readAllEvents(root)).toHaveLength(0);
  });

  it('the CA-17 builder demotes an unknown raw binding to error, and the line is accepted', () => {
    // `verdict-writer.js#intentBindingValue` maps anything outside the
    // vocabulary to 'error'. Without that demotion the enum above would turn a
    // failed binding into a refused, unrecorded verdict.
    const input = reviewCompleted({}, 'unknown');
    expect(input.data.intent_binding).toBe('error');
    expect(writeEvent(root, input).ok).toBe(true);
    const lines = readAllEvents(root, { includeRejected: true });
    expect(lines.map((e) => e.event)).toEqual(['review.completed']);
    expect(lines[0].data.intent_binding).toBe('error');
  });

  describe('fold stage 1 keeps the declared keys and drops an undeclared filler', () => {
    const CASES = [
      ['review.completed', () => reviewCompleted({}, 'mismatch'),
        ['intent_revision', 'plan_revision', 'intent_binding']],
      ['route.bound', () => routeBound(), ['subagent_type']],
    ];
    const opts = { maxLineBytes: 4096, overflowField: 'evidence_refs', measure: lineBytes };

    it.each(CASES)('%s: declared keys survive, the filler goes', (event, make, keys) => {
      const input = withData(make(), { filler_undeclared: 'x'.repeat(5000) });
      const res = shrinkToFit(input, getAllowlist().events[event], opts);
      expect(res.folded).toBe(true);
      expect(res.dropped).toEqual(['filler_undeclared']);
      for (const k of keys) expect(res.env.data[k], k).toEqual(input.data[k]);
    });

    it.each(CASES)('%s positive control: each key is dropped once undeclared', (event, make, keys) => {
      const input = withData(make(), { filler_undeclared: 'x'.repeat(5000) });
      for (const k of keys) {
        const res = shrinkToFit(input, undeclare(getAllowlist().events[event], k), opts);
        expect(res.dropped, k).toEqual([k, 'filler_undeclared']);
        expect(Object.hasOwn(res.env.data, k), k).toBe(false);
      }
    });

    it.each(CASES)('%s end to end: the real writer keeps them past a long filler', (event, make, keys) => {
      const input = withData(make(), { filler_undeclared: 'x'.repeat(5000) });
      const res = writeEvent(root, input);
      expect(res).toMatchObject({ ok: true, folded: true, dropped: ['filler_undeclared'] });
      const [line] = readAllEvents(root);
      for (const k of keys) expect(line.data[k], k).toEqual(input.data[k]);
    });
  });

  it('does NOT keep them when a declared key is what overflows (foldOversized)', () => {
    // A RECORD OF CURRENT BEHAVIOUR: nothing to drop in stage 1, nothing to cut
    // in stage 2, so the last-resort fold keeps `verdict` and `findings_ref`.
    const input = withData(reviewCompleted({}, 'match'), { verification_id: 'v'.repeat(5000) });
    const res = writeEvent(root, input);
    expect(res.ok).toBe(true);
    expect(res.dropped).toEqual(['intent_revision', 'plan_revision', 'intent_binding', 'verification_id']);
    expect(Object.keys(readAllEvents(root)[0].data).sort())
      .toEqual(['evidence_refs', 'findings_ref', 'verdict']);
  });
});
