/**
 * T-37 — the two recorders added to decision-events.js and the pure parser that
 * feeds one of them.
 *
 * WHAT THIS SUITE CANNOT SEE (stated next to the gate, so the gate cannot
 * become the next false assurance):
 *
 *  1. It never runs the hook. That the recorders are actually CALLED on a live
 *     prompt, and that calling them changes stdout by zero bytes, is
 *     `tests/hooks/runtime-prompt-decision-wiring.test.js`. Everything here
 *     would stay green if the hook stopped calling them entirely.
 *  2. The parser cases use SYNTHETIC `prepared` envelopes. They pin the parsing
 *     contract against `memory.js:116`'s format; they do not prove the
 *     middleware still emits that format. If `memory.js` changes its marker,
 *     these stay green while the instrumentation silently reports
 *     `injected:false` forever. `MEMORY_BLOCK_HEAD` is the coupling and nothing
 *     here detects drift in it.
 *  3. `approx_tokens_chars_div4` is chars/4. It is NOT a tokenizer count and no
 *     assertion compares it to one. Its error against a real tokenizer is
 *     unmeasured.
 *  4. The block-boundary case proves memory's bytes are not confused with a
 *     block appended AFTER it. It does not cover a memory line whose own body
 *     contains a blank line — `collectWorkingLines` slices an entry body raw
 *     (memory.js:33-37), so such a body would truncate the measurement early.
 *     That input has not been observed; it is a known hole, not a handled case.
 *  5. Privacy here is checked as a SHAPE (types, lengths, named fields), not as
 *     a proof that upstream never puts prompt text in those fields. The
 *     substantive property lives in `topology-router.js`, which returns pattern
 *     ids from a fixed table.
 *  6. Every write goes to a `storeDir` under `os.tmpdir()`. Nothing here
 *     exercises the real `<pluginRoot>/runtime/decisions/` path resolution.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushRecorderStats,
  getDecisionRecorderStats,
  measureMemoryInjection,
  MEMORY_BLOCK_HEAD,
  MEMORY_INJECTION_MEASURED,
  readDecisionEvents,
  RECORDER_STATS,
  recordMemoryInjection,
  recordTopologyRecommended,
  resetDecisionRecorderStats,
  TOPOLOGY_RECOMMENDED,
  UNATTRIBUTED_RUN_ID,
} from '../../lib/observability/decision-events.js';

let storeDir = '';
const RUN_ID = 'sess-t37-observability';

beforeEach(() => {
  // storeDir override (decision-events.js#getDecisionStoreDir) — the real store
  // is never touched. An earlier draft of a sibling suite wrote fixture lines
  // into it, which is the exact failure this module's header warns about.
  storeDir = mkdtempSync(path.join(tmpdir(), 'artibot-t37-store-'));
  resetDecisionRecorderStats();
});

afterEach(() => {
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  resetDecisionRecorderStats();
});

/** @returns {object[]} events written for RUN_ID in the sandbox store. */
function written() {
  return readDecisionEvents(RUN_ID, { storeDir });
}

/** A `routeTopology`-shaped observation. */
function observation(overrides = {}) {
  return {
    mode: 'split',
    exception: 'split',
    confidence: 0.62,
    reason: ['runner:inline', 'recommendation:none', 'subs:3', 'nl-match:nl-split-per-file'],
    parallelGain: {
      work: 3, coordination: 1.5, contextDup: 0, mergeRisk: 0, startup: 0, tokenDup: 0, net: 1.5,
      measured: {
        work: true, coordination: true, contextDup: false,
        mergeRisk: false, startup: false, tokenDup: false,
      },
    },
    humanGateHits: ['bash-rm-rf'],
    ...overrides,
  };
}

describe('recordTopologyRecommended()', () => {
  it('writes one observe-only event carrying the router result', () => {
    const persisted = recordTopologyRecommended(RUN_ID, observation(), { storeDir });
    expect(persisted).not.toBeNull();

    const events = written();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(TOPOLOGY_RECOMMENDED);
    expect(events[0].phase).toBe('ROUTE');
    expect(events[0].level).toBe('info');
    expect(events[0].data.mode).toBe('split');
    expect(events[0].data.exception).toBe('split');
    expect(events[0].data.confidence).toBe(0.62);
    expect(events[0].data.observe_only).toBe(true);
  });

  it('marks humanGateHits advisory so they cannot be read as a verdict', () => {
    // The hook-layer gate verdict belongs to lib/security/human-gates.js#classify.
    // The router's hits are a text match; recording them without this flag would
    // invite a reader to treat a match as a decision.
    recordTopologyRecommended(RUN_ID, observation(), { storeDir });
    expect(written()[0].data.humanGateHits).toEqual({ advisory: true, hits: ['bash-rm-rf'] });
  });

  it('splits parallelGain into scalars and its measured flags', () => {
    recordTopologyRecommended(RUN_ID, observation(), { storeDir });
    const { parallelGain, parallelGainMeasured } = written()[0].data;
    expect(parallelGain.net).toBe(1.5);
    // `measured` is an object, so the scalar filter must have dropped it from the
    // numeric view rather than serializing it as a value.
    expect(parallelGain.measured).toBeUndefined();
    expect(parallelGainMeasured.work).toBe(true);
    expect(parallelGainMeasured.contextDup).toBe(false);
  });

  it('drops non-scalar and non-finite gain terms instead of coercing them', () => {
    // An unmeasured term must never reach disk looking like a measured number.
    recordTopologyRecommended(RUN_ID, observation({
      parallelGain: { work: Number.NaN, note: 'a string', nested: {}, ok: 2 },
    }), { storeDir });
    const { parallelGain } = written()[0].data;
    expect(parallelGain).toEqual({ ok: 2 });
  });

  it('keeps reasons up to 120 chars and drops longer or non-string entries', () => {
    // 120, not the 64 used for trigger reasons: topology reasons carry
    // JSON.stringify'd CONFIG values, which are legitimately longer.
    const ok = 'p'.repeat(120);
    const tooLong = 'p'.repeat(121);
    recordTopologyRecommended(RUN_ID, observation({
      reason: ['runner:inline', ok, tooLong, 42, null, ''],
    }), { storeDir });
    expect(written()[0].data.reason).toEqual(['runner:inline', ok]);
  });

  it('is total on a missing or malformed observation', () => {
    for (const bad of [null, undefined, {}, 'not-an-object']) {
      resetDecisionRecorderStats();
      rmSync(storeDir, { recursive: true, force: true });
      storeDir = mkdtempSync(path.join(tmpdir(), 'artibot-t37-store-'));
      expect(() => recordTopologyRecommended(RUN_ID, bad, { storeDir })).not.toThrow();
      const [e] = written();
      expect(e.data.mode).toBeNull();
      expect(e.data.reason).toEqual([]);
      expect(e.data.observe_only).toBe(true);
    }
  });

  it('counts a missing run id as skipped rather than writing anything', () => {
    // No date-bucket fallback: an absent session must be visible as an absence,
    // not bucketed into a file that makes the store look alive.
    expect(recordTopologyRecommended(null, observation(), { storeDir })).toBeNull();
    expect(recordTopologyRecommended('', observation(), { storeDir })).toBeNull();
    expect(getDecisionRecorderStats().skipped).toBe(2);
    expect(getDecisionRecorderStats().recorded).toBe(0);
  });
});

describe('measureMemoryInjection()', () => {
  it('reports not-injected for a prompt with no memory block', () => {
    const m = measureMemoryInjection({ userPrompt: 'plain prompt', context: {} });
    expect(m.injected).toBe(false);
    expect(m.items).toBe(0);
    expect(m.bytes).toBe(0);
    expect(m.approx_tokens_chars_div4).toBe(0);
  });

  it('is total on a missing, empty, or malformed envelope', () => {
    for (const input of [null, undefined, {}, { userPrompt: '' }, { userPrompt: 42 }]) {
      expect(measureMemoryInjection(input).injected).toBe(false);
    }
  });

  it('counts one item and measures its bytes', () => {
    const block = `${MEMORY_BLOCK_HEAD}Preference hint: {"a":1}`;
    const m = measureMemoryInjection({ userPrompt: `do the thing${block}`, context: {} });
    expect(m.injected).toBe(true);
    expect(m.items).toBe(1);
    expect(m.bytes).toBe(Buffer.byteLength(block, 'utf-8'));
    expect(m.approx_tokens_chars_div4).toBe(Math.ceil(block.length / 4));
  });

  it('counts every item in a multi-line block', () => {
    const block = `${MEMORY_BLOCK_HEAD}one\n- two\n- three`;
    expect(measureMemoryInjection({ userPrompt: `base${block}`, context: {} }).items).toBe(3);
  });

  it('stops at the next block instead of swallowing it', () => {
    // guardrail.js, subagents.js and tasks.js each append their own '\n\n' block
    // after memory.js in the same pipeline. Taking the tail would attribute
    // their bytes to memory.
    const mem = `${MEMORY_BLOCK_HEAD}one\n- two`;
    const after = '\n\n⚠️ Guardrail: tools denied by policy — Agent';
    const m = measureMemoryInjection({ userPrompt: `base${mem}${after}`, context: {} });
    expect(m.items).toBe(2);
    expect(m.bytes).toBe(Buffer.byteLength(mem, 'utf-8'));
    expect(m.bytes).toBeLessThan(Buffer.byteLength(mem + after, 'utf-8'));
  });

  it('measures bytes, not characters, for multi-byte content', () => {
    const block = `${MEMORY_BLOCK_HEAD}프로젝트 컨텍스트`;
    const m = measureMemoryInjection({ userPrompt: `base${block}`, context: {} });
    expect(m.bytes).toBe(Buffer.byteLength(block, 'utf-8'));
    expect(m.bytes).toBeGreaterThan(block.length);
  });

  it('passes through the middleware counters without recomputing them', () => {
    const m = measureMemoryInjection({
      userPrompt: `base${MEMORY_BLOCK_HEAD}one`,
      context: { memory: { enabled: true, hitCount: 4, workingHits: 2 } },
    });
    expect(m.hit_count).toBe(4);
    expect(m.working_hits).toBe(2);
    expect(m.enabled).toBe(true);
    // hitCount is the middleware's count of RELEVANT records; items is the count
    // of lines actually injected. Different questions, never conflated.
    expect(m.items).toBe(1);
  });

  it('reports nulls, not zeros, when the middleware left no counters', () => {
    // A missing counter and a measured zero are different diagnoses.
    const m = measureMemoryInjection({ userPrompt: 'plain', context: {} });
    expect(m.hit_count).toBeNull();
    expect(m.working_hits).toBeNull();
    expect(m.enabled).toBeNull();
  });

  it('names its approximation in the field name', () => {
    const m = measureMemoryInjection({ userPrompt: 'plain', context: {} });
    expect(Object.keys(m)).toContain('approx_tokens_chars_div4');
    expect(m.measured_by).toBe('prompt-marker-extraction');
  });
});

describe('recordMemoryInjection()', () => {
  it('writes one event carrying the measurement', () => {
    const m = measureMemoryInjection({
      userPrompt: `base${MEMORY_BLOCK_HEAD}one\n- two`,
      context: { memory: { enabled: true, hitCount: 2, workingHits: 0 } },
    });
    recordMemoryInjection(RUN_ID, m, { storeDir });

    const [e] = written();
    expect(e.type).toBe(MEMORY_INJECTION_MEASURED);
    expect(e.phase).toBe('CONTEXT');
    expect(e.data.injected).toBe(true);
    expect(e.data.items).toBe(2);
    expect(e.data.bytes).toBe(m.bytes);
    expect(e.data.hit_count).toBe(2);
    expect(e.message).toContain('chars/4');
  });

  it('records the not-injected case too', () => {
    // "No memory" is a question an operator asks as often as "how much memory?",
    // and a record that exists on only one branch cannot answer the other.
    recordMemoryInjection(RUN_ID, measureMemoryInjection({ userPrompt: 'plain' }), { storeDir });
    const [e] = written();
    expect(e.data.injected).toBe(false);
    expect(e.message).toBe('memory not injected');
  });

  it('copies named fields only, so an added upstream field cannot ride along', () => {
    recordMemoryInjection(RUN_ID, {
      injected: true, items: 1, bytes: 10, approx_tokens_chars_div4: 3,
      hit_count: 1, working_hits: 0, enabled: true, measured_by: 'x',
      rawPromptText: 'SECRET-CANARY-should-not-be-written',
    }, { storeDir });

    const [e] = written();
    expect(JSON.stringify(e)).not.toContain('SECRET-CANARY');
    expect(e.data.rawPromptText).toBeUndefined();
  });

  it('substitutes null for absent fields instead of omitting them', () => {
    recordMemoryInjection(RUN_ID, {}, { storeDir });
    const [e] = written();
    // A field that is present-and-null is readable as "not measured"; a missing
    // key is indistinguishable from a schema change.
    expect(e.data).toHaveProperty('injected', null);
    expect(e.data).toHaveProperty('bytes', null);
    expect(e.data).toHaveProperty('measured_by', null);
  });

  it('counts a missing run id as skipped rather than writing anything', () => {
    expect(recordMemoryInjection(null, { injected: false }, { storeDir })).toBeNull();
    expect(getDecisionRecorderStats().skipped).toBe(1);
    expect(getDecisionRecorderStats().recorded).toBe(0);
  });
});

describe('both recorders share the module stats counter', () => {
  it('counts each successful write once', () => {
    recordTopologyRecommended(RUN_ID, observation(), { storeDir });
    recordMemoryInjection(RUN_ID, { injected: false }, { storeDir });
    expect(getDecisionRecorderStats().recorded).toBe(2);
    expect(getDecisionRecorderStats().failed).toBe(0);
    // Both land in the same per-run file, in call order.
    const events = written();
    expect(events.map((e) => e.type)).toEqual([TOPOLOGY_RECOMMENDED, MEMORY_INJECTION_MEASURED]);
  });

  it('counts a failed write instead of swallowing it silently', () => {
    // An error nobody can count is indistinguishable from "nothing to record" —
    // the ambiguity that hid the decision-trail outage.
    const bogus = path.join(storeDir, 'nested\0invalid');
    recordTopologyRecommended(RUN_ID, observation(), { storeDir: bogus });
    const stats = getDecisionRecorderStats();
    expect(stats.recorded).toBe(0);
    expect(stats.failed).toBe(1);
    expect(stats.lastError).toBeTruthy();
  });
});

describe('flushRecorderStats()', () => {
  /** @returns {object[]} stats lines filed under the unattributed run id. */
  function unattributed() {
    return readDecisionEvents(UNATTRIBUTED_RUN_ID, { storeDir });
  }

  it('writes nothing when both counters are clean', () => {
    // The healthy case must stay SILENT. A line on every prompt would make the
    // signal worthless — the store has to be quiet for a line to mean anything.
    recordTopologyRecommended(RUN_ID, observation(), { storeDir });
    expect(getDecisionRecorderStats().skipped).toBe(0);
    expect(getDecisionRecorderStats().failed).toBe(0);

    expect(flushRecorderStats(RUN_ID, { storeDir })).toBeNull();
    expect(written().some((e) => e.type === RECORDER_STATS)).toBe(false);
    expect(unattributed()).toHaveLength(0);
  });

  it('files the stats under _unattributed when there is no run id', () => {
    // The case the counters exist for: the drop was CAUSED by a missing session
    // id, so there is no session to file it under. It must still be readable.
    recordTopologyRecommended(null, observation(), { storeDir });
    recordMemoryInjection(null, { injected: false }, { storeDir });
    expect(getDecisionRecorderStats().skipped).toBe(2);

    const persisted = flushRecorderStats(null, { storeDir });
    expect(persisted).not.toBeNull();

    const lines = unattributed();
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe(RECORDER_STATS);
    expect(lines[0].data.skipped).toBe(2);
    expect(lines[0].data.failed).toBe(0);
    // Nothing to attribute it to, so the field is absent rather than guessed.
    expect(lines[0].data.runId).toBeUndefined();
    // `skipped` alone is routine — a prompt with no session id is normal.
    expect(lines[0].level).toBe('info');
  });

  it('attributes the stats to the run id when one is known', () => {
    recordTopologyRecommended(null, observation(), { storeDir });
    flushRecorderStats(RUN_ID, { storeDir });

    const lines = written().filter((e) => e.type === RECORDER_STATS);
    expect(lines).toHaveLength(1);
    expect(lines[0].data.runId).toBe(RUN_ID);
    expect(unattributed()).toHaveLength(0);
  });

  it('raises the level to warn when a write actually broke', () => {
    // `failed` and `skipped` are different diagnoses; the level keeps them apart
    // so a broken write is findable by `readDecisionEvents(id, {level:'warn'})`.
    recordTopologyRecommended(RUN_ID, observation(), {
      storeDir: path.join(storeDir, 'nested\0invalid'),
    });
    flushRecorderStats(RUN_ID, { storeDir });

    const [line] = written().filter((e) => e.type === RECORDER_STATS);
    expect(line.level).toBe('warn');
    expect(line.data.failed).toBe(1);
    expect(line.data.lastError).toBeTruthy();
  });

  it('reports the state before its own write, never counting itself', () => {
    recordTopologyRecommended(null, observation(), { storeDir });
    const before = getDecisionRecorderStats().recorded;
    flushRecorderStats(null, { storeDir });

    // The line reports the pre-write snapshot...
    expect(unattributed()[0].data.skipped).toBe(1);
    // ...while its own success still increments the live counter, so a second
    // flush would report cumulative state. The hook flushes once per process.
    expect(getDecisionRecorderStats().recorded).toBe(before + 1);
  });
});
