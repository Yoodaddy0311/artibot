/**
 * Contract tests for the usage-receipt envelope builder.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM usage-receipt.test.js
 * ----------------------------------------------------------
 * `usage-receipt.js` produces receipt DATA and deliberately stops there. The
 * step that turns that data into a ledger LINE is where the two failure modes
 * that matter live: an envelope the writer's gates reject (nothing is
 * recorded, silently) and an envelope that is accepted twice (the same spend
 * counted twice by `lib/runtime/ledger.js#foldMissions`). Neither is visible
 * from the receipt alone, so they are tested here against the REAL gates.
 *
 * WHAT A GREEN RUN HERE DOES NOT PROVE
 * ------------------------------------
 *  - That anything is written in production. Appending is the hook's job and
 *    is covered in `tests/hooks/session-end.test.js`, not here.
 *  - That the transcript format still matches. Every fixture is synthesized
 *    from the shape measured 2026-09-02 (`usage-receipt.test.js#assistantEntry`);
 *    nothing enforces that Claude Code keeps writing it.
 *  - That the receipt numbers are the ones the provider billed. No invoice is
 *    ever consulted.
 *
 * THE FIXTURE IS SIZED ON PURPOSE. A few-hundred-byte fixture cannot reach the
 * 4096-byte line cap or the duplicate-requestId path, so it would go green
 * while measuring neither. Sizes are asserted below so a later shrink is a
 * failing test rather than a quiet loss of coverage.
 */

import { describe, expect, it } from 'vitest';

import {
  toUsageReceiptEnvelopes,
  USAGE_RECEIPT_EVENT,
  USAGE_RECEIPT_SOURCE,
  usageReceiptIdempotencyKey,
} from '../../lib/economics/receipt-envelope.js';
import { buildUsageReceipts } from '../../lib/economics/usage-receipt.js';
import {
  buildEnvelope,
  DEFAULT_LINE_MAX_BYTES,
  lineBytes,
  validateEnvelope,
  validateEventContract,
} from '../../lib/runtime/event-writer.js';

const SESSION_ID = 'sess-abcdef01';
const MISSION_ID = 'M-20260905-001';
const MAIN = `/fake/projects/slug/${SESSION_ID}.jsonl`;

/** A minimal well-formed receipt, only the fields the envelope reads. */
function receipt({
  runId = 'agent-abc123',
  missionId = MISSION_ID,
  modelId = 'claude-opus-5',
} = {}) {
  return {
    schema_version: 1,
    run_id: runId,
    mission_id: missionId,
    model_identity: { provider: 'anthropic', family: 'claude', model_id: modelId },
    usage: { source: 'transcript' },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('receipt-envelope constants', () => {
  it('names the allowlisted event exactly', () => {
    expect(USAGE_RECEIPT_EVENT).toBe('usage.receipt');
  });

  it('declares `hook` as the source, because a hook is what writes the line', () => {
    // The envelope `source` names WHO WROTE THE ENVELOPE, not who spent the
    // tokens. The SessionEnd hook writes these lines, so `hook` is the true
    // statement and `worker` would make the ledger say something false. The
    // spender is not lost: it is `data.run_id`, which is the spawn id.
    //
    // MEASURED 2026-09-04T23:41:27Z in
    // schemas/ledger-events.allowlist.json — `usage.receipt.sources` is
    // ["worker","hook"], and 13 of the 38 registered events already permit
    // `hook` (`human.asked` and `mission.created` are ["hook"];
    // `route.selected` is ["scheduler","hook"]). The former ["worker"]-only
    // spelling was the outlier: `context.compiled` is now the ONLY event
    // restricted to ["worker"].
    expect(USAGE_RECEIPT_SOURCE).toBe('hook');
  });
});

// ---------------------------------------------------------------------------
// usageReceiptIdempotencyKey
// ---------------------------------------------------------------------------

describe('usageReceiptIdempotencyKey()', () => {
  it('joins event, session, run and model in that order', () => {
    expect(usageReceiptIdempotencyKey(SESSION_ID, receipt())).toBe(
      'usage.receipt:sess-abcdef01:agent-abc123:claude-opus-5',
    );
  });

  it('separates two models of the same run into distinct keys', () => {
    // A multi-model run yields one receipt per model (usage-receipt.js#finalise).
    // If the key collapsed them, the second receipt would be dropped as a
    // duplicate and its tokens would never be recorded.
    const a = usageReceiptIdempotencyKey(SESSION_ID, receipt({ modelId: 'claude-opus-5' }));
    const b = usageReceiptIdempotencyKey(SESSION_ID, receipt({ modelId: 'claude-haiku-4-5' }));
    expect(a).not.toBe(b);
  });

  it('separates two runs of the same session into distinct keys', () => {
    const a = usageReceiptIdempotencyKey(SESSION_ID, receipt({ runId: 'agent-1' }));
    const b = usageReceiptIdempotencyKey(SESSION_ID, receipt({ runId: 'agent-2' }));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// toUsageReceiptEnvelopes — shape
// ---------------------------------------------------------------------------

describe('toUsageReceiptEnvelopes()', () => {
  it('produces one envelope per receipt with the full contract shape', () => {
    const r = receipt();
    const [env] = toUsageReceiptEnvelopes([r], { sessionId: SESSION_ID });

    expect(env).toEqual({
      event: 'usage.receipt',
      session_id: SESSION_ID,
      mission_id: MISSION_ID,
      run_id: 'agent-abc123',
      model: 'claude-opus-5',
      idempotency_key: 'usage.receipt:sess-abcdef01:agent-abc123:claude-opus-5',
      source: 'hook',
      data: r,
    });
  });

  it('carries the receipt through by reference, unmodified', () => {
    // The receipt IS the data contract (attempt-receipt.schema.json is
    // additionalProperties:false), so anything injected here is a rejection.
    const r = receipt();
    const [env] = toUsageReceiptEnvelopes([r], { sessionId: SESSION_ID });
    expect(env.data).toBe(r);
  });

  it('returns an empty array for an empty receipt list', () => {
    expect(toUsageReceiptEnvelopes([], { sessionId: SESSION_ID })).toEqual([]);
  });

  it('preserves input order', () => {
    const list = [receipt({ runId: 'r1' }), receipt({ runId: 'r2' }), receipt({ runId: 'r3' })];
    const envs = toUsageReceiptEnvelopes(list, { sessionId: SESSION_ID });
    expect(envs.map((e) => e.run_id)).toEqual(['r1', 'r2', 'r3']);
  });
});

// ---------------------------------------------------------------------------
// toUsageReceiptEnvelopes — argument validation
// ---------------------------------------------------------------------------

describe('toUsageReceiptEnvelopes() argument validation', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['a number', 42],
    ['an object', { id: 'x' }],
  ])('throws TypeError when sessionId is %s', (_label, sessionId) => {
    expect(() => toUsageReceiptEnvelopes([receipt()], { sessionId }))
      .toThrow(TypeError);
  });

  it('throws TypeError when the options bag is missing entirely', () => {
    expect(() => toUsageReceiptEnvelopes([receipt()])).toThrow(TypeError);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'receipts'],
    ['an object', { 0: receipt() }],
  ])('throws TypeError when receipts is %s', (_label, receipts) => {
    expect(() => toUsageReceiptEnvelopes(receipts, { sessionId: SESSION_ID }))
      .toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// toUsageReceiptEnvelopes — malformed receipts are skipped, not thrown on
// ---------------------------------------------------------------------------

describe('toUsageReceiptEnvelopes() malformed receipts', () => {
  /**
   * A bad receipt is a DATA problem (the transcript drifted); a bad sessionId
   * is a WIRING problem (the caller is broken). Only the second is worth
   * failing the whole session for, which is why one throws and the other does
   * not.
   */
  const bad = {
    'run_id missing': { ...receipt(), run_id: undefined },
    'run_id empty': { ...receipt(), run_id: '' },
    'run_id not a string': { ...receipt(), run_id: 7 },
    'mission_id missing': { ...receipt(), mission_id: undefined },
    'mission_id empty': { ...receipt(), mission_id: '' },
    'model_identity missing': { ...receipt(), model_identity: undefined },
    'model_identity null': { ...receipt(), model_identity: null },
    'model_id missing': { ...receipt(), model_identity: { provider: 'anthropic' } },
    'model_id empty': { ...receipt(), model_identity: { model_id: '' } },
    'receipt is null': null,
    'receipt is a string': 'nope',
  };

  it.each(Object.entries(bad))('skips a receipt with %s without throwing', (_label, r) => {
    expect(() => toUsageReceiptEnvelopes([r], { sessionId: SESSION_ID })).not.toThrow();
    expect(toUsageReceiptEnvelopes([r], { sessionId: SESSION_ID })).toEqual([]);
  });

  it('keeps the good receipts when only some are malformed', () => {
    const good = receipt({ runId: 'ok-run' });
    const envs = toUsageReceiptEnvelopes(
      [null, good, { ...receipt(), run_id: '' }],
      { sessionId: SESSION_ID },
    );
    expect(envs).toHaveLength(1);
    expect(envs[0].run_id).toBe('ok-run');
  });
});

// ---------------------------------------------------------------------------
// Gate conformance at realistic size
// ---------------------------------------------------------------------------

/**
 * One assistant transcript entry, same shape as
 * `tests/economics/usage-receipt.test.js#assistantEntry` (measured 2026-09-02).
 * Kept as a local copy rather than exported across test files so a change to
 * one suite cannot silently retune the other.
 */
function assistantEntry({ model = 'claude-opus-5', requestId, minute = 0 }) {
  return {
    type: 'assistant',
    requestId,
    timestamp: `2026-09-02T06:${String(minute % 60).padStart(2, '0')}:00.000Z`,
    effort: 'high',
    message: {
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(64) }],
      usage: {
        input_tokens: 1200,
        cache_read_input_tokens: 90000,
        cache_creation_input_tokens: 4500,
        output_tokens: 800,
        output_tokens_details: { thinking_tokens: 250 },
      },
    },
  };
}

/**
 * Build a transcript whose every entry is written TWICE with the same
 * requestId. That is not decoration: it is the shape the leader measured on
 * real sessions 2026-09-05 (`duplicateRequestIds` in the same order of
 * magnitude as `entries`), and it is the path that would double every counter
 * if the dedupe in `usage-receipt.js#foldEntry` regressed.
 *
 * @param {string} prefix requestId namespace, unique per file
 * @param {number} count distinct entries
 * @param {number} unregistered how many trailing entries use a model the
 *   catalog does not know — the coverage-below-1 path measured on old sessions
 * @returns {string} JSONL
 */
function transcript(prefix, count, unregistered = 0) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const model = i >= count - unregistered ? 'claude-fable-5' : 'claude-opus-5';
    const entry = assistantEntry({ model, requestId: `${prefix}-req-${i}`, minute: i });
    const line = JSON.stringify(entry);
    lines.push(line);
    lines.push(line); // verbatim repeat — one response, two transcript rows
  }
  return lines.join('\n');
}

const SUB_DIR = `/fake/projects/slug/${SESSION_ID}/subagents`;
const SUBS = [
  `${SUB_DIR}/agent-aaa11111.jsonl`,
  `${SUB_DIR}/agent-bbb22222.jsonl`,
  `${SUB_DIR}/agent-ccc33333.jsonl`,
];

/** The whole in-memory corpus: main 700 + 20 unregistered, 3 subagents x 120. */
const CORPUS = {
  [MAIN]: transcript('main', 720, 20),
  [SUBS[0]]: transcript('sub0', 120),
  [SUBS[1]]: transcript('sub1', 120),
  [SUBS[2]]: transcript('sub2', 120),
};

const CORPUS_BYTES = Object.values(CORPUS)
  .reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0);

describe('envelope conformance against the real ledger gates', () => {
  /** Receipts from the full-size corpus, built once. */
  async function buildCorpusReceipts() {
    return buildUsageReceipts({
      transcriptPath: MAIN,
      missionId: MISSION_ID,
      readTranscript: (p) => {
        if (!(p in CORPUS)) throw new Error(`ENOENT ${p}`);
        return CORPUS[p];
      },
      listSubagentTranscripts: () => SUBS,
    });
  }

  /** Wrap one envelope input through the real assembler with a fixed clock. */
  function assemble(input, seq) {
    return buildEnvelope(input, {
      seq,
      pid: 4242,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
    });
  }

  it('uses a fixture large enough to reach the paths under test', () => {
    // NEGATIVE CONTROL ON THE FIXTURE ITSELF. A fixture that shrank below
    // these floors would keep every assertion below green while testing
    // neither the duplicate path nor a realistic line size.
    const mainLines = CORPUS[MAIN].split('\n');
    expect(mainLines.length).toBe(1440); // 720 distinct x 2 rows each
    expect(mainLines.length / 2).toBeGreaterThanOrEqual(700);
    expect(SUBS).toHaveLength(3);
    for (const sub of SUBS) {
      expect(CORPUS[sub].split('\n').length / 2).toBeGreaterThanOrEqual(100);
    }
    // 917,156 bytes measured 2026-09-05. The floor is below the measured
    // value so a harmless fixture tweak does not fail, but a collapse back to
    // a toy fixture does.
    expect(CORPUS_BYTES).toBeGreaterThan(800_000);
  });

  it('exercises the duplicate-requestId and unregistered-model paths', async () => {
    const { receipts, meta } = await buildCorpusReceipts();

    // 700 resolvable main entries + 360 subagent entries were each written
    // twice, so the second row of each is dropped as a duplicate.
    expect(meta.duplicateRequestIds).toBe(700 + 120 * 3);
    // main + 3 subagents, one resolved model each.
    expect(receipts).toHaveLength(4);
    expect(meta.sources).toEqual({ transcript: 4, estimate: 0 });
    expect(meta.parseFailures).toBe(0);
  });

  it('counts BOTH rows of an unregistered-model response in the denominator', async () => {
    // MEASURED 2026-09-05, and this pins current behavior rather than
    // endorsing it. `usage-receipt.js#foldEntry` claims a requestId only after
    // the model resolves, so for the 20 distinct `claude-fable-5` responses
    // the verbatim repeat is never recognised as a duplicate and lands as a
    // second entry: 40 unresolved rows from 20 responses.
    //
    // The consequence is that `coverage` reads LOWER than the true miss rate
    // (1060/1100 = 0.964 rather than 1060/1080 = 0.981) on exactly the old
    // sessions where unregistered models appear. Recorded here so a later fix
    // is a deliberate, visible change to this expectation.
    const { meta } = await buildCorpusReceipts();

    expect(meta.unresolvedModels['claude-fable-5']).toBe(40);
    expect(meta.entries).toBe(1100);
    expect(meta.measuredEntries).toBe(1060);
    expect(meta.coverage).toBeCloseTo(1060 / 1100, 10);
    expect(meta.coverage).toBeLessThan(1);
  });

  it('passes validateEnvelope, validateEventContract and the byte cap', async () => {
    const { receipts } = await buildCorpusReceipts();
    const envelopes = toUsageReceiptEnvelopes(receipts, { sessionId: SESSION_ID });
    expect(envelopes).toHaveLength(receipts.length);

    for (const [i, input] of envelopes.entries()) {
      const env = assemble(input, i);
      expect(validateEnvelope(env)).toBeNull();
      expect(validateEventContract(env)).toBeNull();
      expect(lineBytes(env)).toBeLessThan(DEFAULT_LINE_MAX_BYTES);
    }
  });

  it('emits distinct idempotency keys for every envelope in one session', async () => {
    const { receipts } = await buildCorpusReceipts();
    const envelopes = toUsageReceiptEnvelopes(receipts, { sessionId: SESSION_ID });
    const keys = new Set(envelopes.map((e) => e.idempotency_key));
    expect(keys.size).toBe(envelopes.length);
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROLS — proof the gates above are actually looking
  // -------------------------------------------------------------------------

  it('NEGATIVE CONTROL: a source outside this event\'s list is rejected', async () => {
    // `reviewer` is deliberately chosen over a nonsense string. It IS a member
    // of the global envelope enum
    // (schemas/ledger-envelope.schema.json#/properties/source/enum =
    // [human, supervisor, worker, reviewer, hook, git, gate, scheduler],
    // measured 2026-09-04T23:41Z), so `validateEnvelope` accepts it and only
    // the PER-EVENT list can reject it. A garbage string would be caught by
    // the global enum instead, and would prove nothing about whether
    // `usage.receipt.sources` is consulted at all.
    //
    // MEASURED 2026-09-04T23:41:27Z: usage.receipt.sources = ["worker","hook"]
    // — `reviewer` is not in it.
    const { receipts } = await buildCorpusReceipts();
    const [input] = toUsageReceiptEnvelopes(receipts, { sessionId: SESSION_ID });
    const env = assemble({ ...input, source: 'reviewer' }, 0);

    // The envelope layer must PASS it, or this would not isolate the
    // vocabulary layer.
    expect(validateEnvelope(env)).toBeNull();
    // Without this, "validateEventContract returned null" would be consistent
    // with a gate that inspects nothing.
    expect(validateEventContract(env)).toBe('source-not-allowed:reviewer');
  });

  it('NEGATIVE CONTROL: `worker` is still accepted alongside `hook`', async () => {
    // The allowlist permits both. This pins that the widening ADDED a source
    // rather than swapping one for another — a later edit that drops `worker`
    // would silently break any other writer of this event.
    const { receipts } = await buildCorpusReceipts();
    const [input] = toUsageReceiptEnvelopes(receipts, { sessionId: SESSION_ID });
    const env = assemble({ ...input, source: 'worker' }, 0);
    expect(validateEventContract(env)).toBeNull();
  });

  it('NEGATIVE CONTROL: a receipt disagreeing with its envelope is rejected', async () => {
    const { receipts } = await buildCorpusReceipts();
    const [input] = toUsageReceiptEnvelopes(receipts, { sessionId: SESSION_ID });
    const env = assemble(
      { ...input, data: { ...input.data, mission_id: 'M-20260905-999' } },
      0,
    );
    expect(validateEventContract(env)).toBe('receipt-identity-mismatch:mission_id');
  });

  it('NEGATIVE CONTROL: an unknown envelope key is rejected', async () => {
    const { receipts } = await buildCorpusReceipts();
    const [input] = toUsageReceiptEnvelopes(receipts, { sessionId: SESSION_ID });
    const env = assemble(input, 0);
    expect(validateEnvelope({ ...env, cost_usd: 1.23 })).toBe('unknown-envelope-key:cost_usd');
  });
});
