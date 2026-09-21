/**
 * Unit tests for the usage receipt writer.
 *
 * Every fixture is SYNTHESIZED here. No test in this file (or its firewall
 * sibling) touches `~/.claude/projects`: reading a real transcript would make
 * the suite depend on whatever the developer's machine happened to have run,
 * and would leak session content into CI output.
 *
 * WHAT THESE TESTS CANNOT PROVE (do not read a green run as more than this):
 *  - That the real transcript format matches the fixtures. The format is
 *    internal to Claude Code and undocumented; the fixtures encode the shape
 *    measured on 2026-09-02 and nothing enforces that it stays that way. The
 *    downgrade path exists precisely because it will drift.
 *  - That any receipt is ever produced in production. Nothing calls this
 *    module yet.
 *  - That the token counts are the ones the provider billed. The transcript
 *    carries no cost field and the numbers are never cross-checked against an
 *    invoice.
 */

import { describe, expect, it } from 'vitest';

import { PRICING_VERSION } from '../../lib/core/model-catalog.js';
import {
  buildUsageReceipts,
  classifyEmptyReceipts,
  emptyResult,
  priceUsage,
  PRICING_VERSION_UNRESOLVED,
  resolveModelIdentity,
  SCHEMA_VERSION,
} from '../../lib/economics/usage-receipt.js';

const MAIN = '/fake/projects/slug/sess-1.jsonl';
const SUB = '/fake/projects/slug/sess-1/subagents/agent-abc123.jsonl';

/**
 * One assistant transcript entry in the shape measured 2026-09-02.
 * `usage` overrides are shallow-merged so a test can delete a required key.
 * Pass `requestId: null` or `effort: null` to omit that field — `undefined`
 * would silently fall back to the default and test nothing.
 */
function assistantEntry({
  model = 'claude-opus-5',
  requestId = 'req-1',
  timestamp = '2026-09-02T06:00:00.000Z',
  effort = 'high',
  usage = {},
  omitUsage = false,
} = {}) {
  const entry = {
    type: 'assistant',
    requestId,
    timestamp,
    effort,
    message: {
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
    },
  };
  if (!omitUsage) {
    entry.message.usage = {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
      output_tokens: 20,
      output_tokens_details: { thinking_tokens: 7 },
      ...usage,
    };
  }
  return entry;
}

/** Serialize entries as a JSONL string. */
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n');

/**
 * Build the two injected ports over an in-memory {path: jsonl-string} map.
 * An absent path throws, exercising the unreadable-file path.
 */
function ports(files, subagents = []) {
  return {
    readTranscript: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    listSubagentTranscripts: () => subagents,
  };
}

const run = (files, subagents = [], extra = {}) =>
  buildUsageReceipts({
    transcriptPath: MAIN,
    missionId: 'm-0001',
    ...ports(files, subagents),
    ...extra,
  });

describe('resolveModelIdentity', () => {
  it('resolves a bare catalog id and repeats it as the version pointer', () => {
    expect(resolveModelIdentity('claude-fable-5-1')).toEqual({
      provider: 'anthropic',
      family: 'claude',
      tier: 'fable',
      model_id: 'claude-fable-5-1',
      version: 'claude-fable-5-1',
      catalog_version: '2026-09-02',
    });
  });

  it('strips a dated snapshot suffix and keeps it as the version', () => {
    const identity = resolveModelIdentity('claude-haiku-4-5-20251001');
    expect(identity.tier).toBe('haiku');
    expect(identity.model_id).toBe('claude-haiku-4-5');
    expect(identity.version).toBe('20251001');
  });

  it('strips a bracketed context variant and keeps it as the version', () => {
    const identity = resolveModelIdentity('claude-opus-5[1m]');
    expect(identity.tier).toBe('opus');
    expect(identity.model_id).toBe('claude-opus-5');
    expect(identity.version).toBe('1m');
  });

  it('joins a snapshot and a variant in observation order', () => {
    expect(resolveModelIdentity('claude-haiku-4-5-20251001[1m]').version).toBe(
      '20251001+1m',
    );
  });

  it('returns null for a model the catalog does not know, never a guess', () => {
    expect(resolveModelIdentity('claude-opus-4-1')).toBeNull();
    expect(resolveModelIdentity('gpt-9')).toBeNull();
    expect(resolveModelIdentity('')).toBeNull();
    expect(resolveModelIdentity(undefined)).toBeNull();
  });
});

describe('buildUsageReceipts — argument contract', () => {
  it('throws on a missing mission id rather than inventing one', async () => {
    await expect(
      buildUsageReceipts({ transcriptPath: MAIN, ...ports({}) }),
    ).rejects.toThrow(TypeError);
  });

  it('throws on a missing transcript path', async () => {
    await expect(
      buildUsageReceipts({ missionId: 'm-1', ...ports({}) }),
    ).rejects.toThrow(TypeError);
  });

  it('does not throw on an unreadable transcript, and says so in meta', async () => {
    const result = await run({});
    expect(result.receipts).toEqual([]);
    expect(result.meta.unreadableFiles).toBe(1);
    expect(result.meta.coverage).toBeNull();
  });
});

describe('buildUsageReceipts — clean fold', () => {
  it('sums the four counters and emits one transcript-grade receipt', async () => {
    const result = await run({
      [MAIN]: jsonl([
        assistantEntry({ requestId: 'req-1' }),
        assistantEntry({
          requestId: 'req-2',
          timestamp: '2026-09-02T06:00:02.500Z',
          usage: { input_tokens: 200, output_tokens: 30 },
        }),
      ]),
    });

    expect(result.receipts).toHaveLength(1);
    const receipt = result.receipts[0];
    expect(receipt.schema_version).toBe(SCHEMA_VERSION);
    expect(receipt.run_id).toBe('sess-1');
    expect(receipt.mission_id).toBe('m-0001');
    expect(receipt.usage).toEqual({
      source: 'transcript',
      fresh_input_tokens: 300,
      cached_input_tokens: 1800,
      cache_creation_tokens: 100,
      output_tokens: 50,
      thinking_tokens: 14,
      requests: 2,
    });
    expect(receipt.timing).toEqual({
      started_at: '2026-09-02T06:00:00.000Z',
      completed_at: '2026-09-02T06:00:02.500Z',
      latency_ms: 2500,
    });
    expect(result.meta.coverage).toBe(1);
    expect(result.meta.parseFailures).toBe(0);
  });

  it('omits action_id entirely rather than guessing an attribution', async () => {
    const result = await run({ [MAIN]: jsonl([assistantEntry()]) });
    expect(Object.keys(result.receipts[0])).not.toContain('action_id');
  });

  it('prices cost from the catalog by default and stamps the table version', async () => {
    const result = await run({ [MAIN]: jsonl([assistantEntry()]) });
    const receipt = result.receipts[0];
    expect(receipt.cost).toEqual({
      total: priceUsage(receipt.usage, receipt.model_identity.tier).total,
      pricing_version: PRICING_VERSION,
    });
    expect(Number.isFinite(receipt.cost.total)).toBe(true);
  });

  it('defaults the outcome to unlabelled, with accepted null not false', async () => {
    const result = await run({ [MAIN]: jsonl([assistantEntry()]) });
    expect(result.receipts[0].outcome).toEqual({ status: 'unknown', accepted: null });
  });

  it('accepts caller-supplied outcomes keyed by run id', async () => {
    const result = await run({ [MAIN]: jsonl([assistantEntry()]) }, [], {
      outcomes: {
        'sess-1': { status: 'completed', verifier_result: 'PASS', accepted: true },
      },
    });
    expect(result.receipts[0].outcome).toEqual({
      status: 'completed',
      verifier_result: 'PASS',
      accepted: true,
    });
  });

  it('ignores a non-boolean accepted rather than coercing it to false', async () => {
    const result = await run({ [MAIN]: jsonl([assistantEntry()]) }, [], {
      outcomes: { 'sess-1': { accepted: 'yes' } },
    });
    expect(result.receipts[0].outcome.accepted).toBeNull();
  });

  it('omits thinking_tokens when no entry reported it', async () => {
    const line = assistantEntry();
    delete line.message.usage.output_tokens_details;
    const result = await run({ [MAIN]: jsonl([line]) });
    expect(result.receipts[0].usage).not.toHaveProperty('thinking_tokens');
  });

  it('normalises an absent optional counter to 0 without downgrading', async () => {
    const line = assistantEntry();
    delete line.message.usage.cache_read_input_tokens;
    delete line.message.usage.cache_creation_input_tokens;
    const result = await run({ [MAIN]: jsonl([line]) });
    expect(result.receipts[0].usage.source).toBe('transcript');
    expect(result.receipts[0].usage.cached_input_tokens).toBe(0);
    expect(result.receipts[0].usage.cache_creation_tokens).toBe(0);
  });

  it('skips malformed lines and blank lines without losing the rest', async () => {
    const result = await run({
      [MAIN]: [
        '',
        '{ not json',
        JSON.stringify(assistantEntry()),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      ].join('\n'),
    });
    expect(result.receipts).toHaveLength(1);
    expect(result.meta.entries).toBe(1);
  });
});

describe('buildUsageReceipts — degradation guards', () => {
  it('downgrades to estimate and counts a parse failure on a missing required key', async () => {
    const bad = assistantEntry({ requestId: 'req-2' });
    delete bad.message.usage.output_tokens;

    const result = await run({
      [MAIN]: jsonl([assistantEntry({ requestId: 'req-1' }), bad]),
    });

    expect(result.meta.parseFailures).toBe(1);
    expect(result.receipts[0].usage.source).toBe('estimate');
    expect(result.meta.sources).toEqual({ transcript: 0, estimate: 1 });
  });

  it('drops requests from an estimate-graded receipt, as the schema requires', async () => {
    const bad = assistantEntry({ omitUsage: true });
    const result = await run({ [MAIN]: jsonl([bad]) });
    expect(result.receipts[0].usage.source).toBe('estimate');
    expect(result.receipts[0].usage).not.toHaveProperty('requests');
  });

  it('never mixes a degraded entry into a transcript-graded aggregate', async () => {
    const bad = assistantEntry({ requestId: 'req-2', omitUsage: true });
    const result = await run({
      [MAIN]: jsonl([assistantEntry({ requestId: 'req-1' }), bad]),
    });
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0].usage.source).toBe('estimate');
    expect(result.meta.coverage).toBe(0);
  });

  it('counts an entry with no model as a parse failure and emits nothing for it', async () => {
    const nameless = assistantEntry();
    delete nameless.message.model;
    const result = await run({ [MAIN]: jsonl([nameless]) });
    expect(result.meta.entriesWithoutModel).toBe(1);
    expect(result.meta.parseFailures).toBe(1);
    expect(result.receipts).toEqual([]);
    expect(result.meta.coverage).toBe(0);
  });

  it('itemises an unknown model instead of guessing a tier', async () => {
    const result = await run({
      [MAIN]: jsonl([assistantEntry({ model: 'claude-opus-4-1' })]),
    });
    expect(result.receipts).toEqual([]);
    expect(result.meta.unresolvedModels).toEqual({ 'claude-opus-4-1': 1 });
    expect(result.meta.coverage).toBe(0);
  });

  it('counts synthetic entries separately and keeps them out of the denominator', async () => {
    const result = await run({
      [MAIN]: jsonl([
        assistantEntry({ model: '<synthetic>' }),
        assistantEntry({ requestId: 'req-2' }),
      ]),
    });
    expect(result.meta.syntheticEntries).toBe(1);
    expect(result.meta.entries).toBe(1);
    expect(result.meta.coverage).toBe(1);
  });

  it('skips a group with no parseable timestamp rather than inventing a time', async () => {
    const result = await run({
      [MAIN]: jsonl([assistantEntry({ timestamp: 'not-a-date' })]),
    });
    expect(result.receipts).toEqual([]);
    expect(result.meta.skipped).toEqual([
      { run_id: 'sess-1', model_id: 'claude-opus-5', reason: 'no-timestamp', entries: 1 },
    ]);
  });
});

describe('buildUsageReceipts — double counting', () => {
  it('folds a repeated requestId once', async () => {
    const entry = assistantEntry({ requestId: 'req-dup' });
    const result = await run({ [MAIN]: jsonl([entry, entry]) });

    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0].usage.fresh_input_tokens).toBe(100);
    expect(result.receipts[0].usage.requests).toBe(1);
    expect(result.meta.duplicateRequestIds).toBe(1);
    expect(result.meta.entries).toBe(1);
  });

  it('dedups across model groups within one run', async () => {
    const result = await run({
      [MAIN]: jsonl([
        assistantEntry({ requestId: 'req-dup', model: 'claude-opus-5' }),
        assistantEntry({ requestId: 'req-dup', model: 'claude-fable-5-1' }),
      ]),
    });
    expect(result.receipts).toHaveLength(1);
    expect(result.meta.duplicateRequestIds).toBe(1);
  });

  it('does not dedup the same requestId across different runs', async () => {
    const result = await run(
      {
        [MAIN]: jsonl([assistantEntry({ requestId: 'req-1' })]),
        [SUB]: jsonl([assistantEntry({ requestId: 'req-1' })]),
      },
      [SUB],
    );
    expect(result.receipts).toHaveLength(2);
    expect(result.meta.duplicateRequestIds).toBe(0);
  });

  it('folds an entry with no requestId but reports the dedup blind spot', async () => {
    const result = await run({
      [MAIN]: jsonl([assistantEntry({ requestId: null })]),
    });
    expect(result.meta.entriesWithoutRequestId).toBe(1);
    expect(result.receipts[0].usage.requests).toBe(0);
    expect(result.receipts[0].usage.fresh_input_tokens).toBe(100);
  });
});

describe('buildUsageReceipts — subagent files', () => {
  it('names the run after the subagent file stem, which is the spawn id', async () => {
    const result = await run(
      {
        [MAIN]: jsonl([assistantEntry({ requestId: 'req-main' })]),
        [SUB]: jsonl([
          assistantEntry({ requestId: 'req-sub', model: 'claude-haiku-4-5' }),
        ]),
      },
      [SUB],
    );

    const ids = result.receipts.map((r) => r.run_id).sort();
    expect(ids).toEqual(['agent-abc123', 'sess-1']);
    const sub = result.receipts.find((r) => r.run_id === 'agent-abc123');
    expect(sub.model_identity.tier).toBe('haiku');
    expect(result.meta.files).toBe(2);
  });

  it('keeps the main receipt when one subagent file is unreadable', async () => {
    const result = await run(
      { [MAIN]: jsonl([assistantEntry()]) },
      [SUB],
    );
    expect(result.receipts).toHaveLength(1);
    expect(result.meta.unreadableFiles).toBe(1);
  });

  it('splits a run that served two models and flags it', async () => {
    const result = await run({
      [MAIN]: jsonl([
        assistantEntry({ requestId: 'req-1', model: 'claude-opus-5' }),
        assistantEntry({ requestId: 'req-2', model: 'claude-fable-5-1' }),
      ]),
    });
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts.every((r) => r.run_id === 'sess-1')).toBe(true);
    expect(result.meta.multiModelRuns).toEqual(['sess-1']);
  });

  it('records the effort mix per run outside the receipt', async () => {
    const result = await run({
      [MAIN]: jsonl([
        assistantEntry({ requestId: 'req-1', effort: 'high' }),
        assistantEntry({ requestId: 'req-2', effort: 'xhigh' }),
        assistantEntry({ requestId: 'req-3', effort: null }),
      ]),
    });
    expect(result.meta.effortMixByRun['sess-1']).toEqual({
      high: 1,
      xhigh: 1,
      unspecified: 1,
    });
    expect(result.receipts[0]).not.toHaveProperty('effort');
  });
});

describe('buildUsageReceipts — port shapes', () => {
  it('accepts an array of lines from the reader port', async () => {
    const result = await buildUsageReceipts({
      transcriptPath: MAIN,
      missionId: 'm-1',
      readTranscript: () => [JSON.stringify(assistantEntry())],
      listSubagentTranscripts: () => [],
    });
    expect(result.receipts).toHaveLength(1);
  });

  it('accepts an async iterable from the reader port', async () => {
    async function* lines() {
      yield JSON.stringify(assistantEntry());
    }
    const result = await buildUsageReceipts({
      transcriptPath: MAIN,
      missionId: 'm-1',
      readTranscript: () => lines(),
      listSubagentTranscripts: () => [],
    });
    expect(result.receipts).toHaveLength(1);
  });

  it('survives a lister port that throws', async () => {
    const result = await buildUsageReceipts({
      transcriptPath: MAIN,
      missionId: 'm-1',
      readTranscript: () => jsonl([assistantEntry()]),
      listSubagentTranscripts: () => {
        throw new Error('boom');
      },
    });
    expect(result.receipts).toHaveLength(1);
  });
});

describe('emptyResult', () => {
  it('says "measured nothing" with a null coverage, not a zero ratio', () => {
    expect(emptyResult().meta.coverage).toBeNull();
    expect(emptyResult().receipts).toEqual([]);
  });

  it('returns a fresh object each call so callers cannot share state', () => {
    const a = emptyResult();
    a.meta.entries = 5;
    expect(emptyResult().meta.entries).toBe(0);
  });
});

/**
 * One million of every counter, so each expected total reads as the per-MTok
 * price itself. A smaller fixture would pass just as well against a formula
 * that swapped two rate columns, because the products would all be tiny.
 */
const ONE_MTOK_EACH = Object.freeze({
  fresh_input_tokens: 1_000_000,
  cached_input_tokens: 1_000_000,
  cache_creation_tokens: 1_000_000,
  output_tokens: 1_000_000,
});

describe('priceUsage', () => {
  // Expected = input + cacheRead + cacheWrite5m + output, one MTok of each.
  // Sourced from the catalog's own table, NOT restated from a price page here:
  // a second hand-typed copy of the rates is the two-table problem again.
  it.each([
    ['fable', 10 + 0.25 + 12.5 + 50],
    ['opus', 5 + 0.5 + 6.25 + 25],
    ['haiku', 1 + 0.1 + 1.25 + 5],
    ['sonnet', 3 + 0.3 + 3.75 + 15],
  ])('prices one MTok of each counter for %s', (tier, expected) => {
    const priced = priceUsage(ONE_MTOK_EACH, tier);
    expect(priced.total).toBeCloseTo(expected, 9);
    expect(priced.pricing_version).toBe(PRICING_VERSION);
  });

  it('charges cache reads at the cache-read rate, not the fresh input rate', () => {
    // fable: cacheRead 0.25 vs input 10 — a 40x over-count if the columns are
    // swapped. This is the single arithmetic error the formula exists to avoid.
    const cacheOnly = priceUsage({ cached_input_tokens: 1_000_000 }, 'fable');
    expect(cacheOnly.total).toBeCloseTo(0.25, 9);
  });

  it('never adds thinking_tokens again, because output_tokens already contains them', () => {
    const withThinking = priceUsage(
      { ...ONE_MTOK_EACH, thinking_tokens: 1_000_000 },
      'opus',
    );
    const without = priceUsage(ONE_MTOK_EACH, 'opus');
    expect(withThinking.total).toBe(without.total);
  });

  it.each([['mythos'], [null], [undefined], [''], [42]])(
    'returns an unresolved null total for tier %p',
    (tier) => {
      expect(priceUsage(ONE_MTOK_EACH, tier)).toEqual({
        total: null,
        pricing_version: PRICING_VERSION_UNRESOLVED,
      });
    },
  );

  it('reports the unresolved sentinel, never the real version, when it did not price', () => {
    expect(priceUsage(ONE_MTOK_EACH, 'mythos').pricing_version)
      .not.toBe(PRICING_VERSION);
  });

  // `measured: false` has no live instance in the catalog today, and the
  // catalog is deep-frozen so a test cannot synthesize one. The guard is read
  // from `getPricing(tier)?.measured` in the source; the unknown-tier cases
  // above cover the same null-returning branch. Stated rather than faked: a
  // test that stubbed the frozen catalog would prove only that the stub works.
  it('treats a missing usage block as zero, not as NaN', () => {
    for (const usage of [undefined, null, {}, 'nope', 7]) {
      const priced = priceUsage(usage, 'opus');
      expect(priced.total).toBe(0);
      expect(Number.isNaN(priced.total)).toBe(false);
    }
  });

  it('counts negative and non-finite counters as zero rather than crediting them', () => {
    const priced = priceUsage(
      {
        fresh_input_tokens: -1_000_000,
        cached_input_tokens: Number.NaN,
        cache_creation_tokens: Number.POSITIVE_INFINITY,
        output_tokens: 1_000_000,
      },
      'opus',
    );
    // Only the one valid counter contributes: 1 MTok output at 25/MTok.
    expect(priced.total).toBeCloseTo(25, 9);
  });

  it('never throws on any input shape', () => {
    expect(() => priceUsage(Symbol('x'), Symbol('y'))).not.toThrow();
    expect(() => priceUsage([], [])).not.toThrow();
  });
});

describe('priceReceipts option', () => {
  // There is no ajv schema oracle in THIS file (the firewall sibling owns it),
  // so nothing below asserts schema conformance — only the emitted shape.
  it('prices by default, byte-for-byte the explicitly opted-in output', async () => {
    const files = {
      [MAIN]: jsonl([
        assistantEntry({ requestId: 'req-1' }),
        assistantEntry({ requestId: 'req-2', model: 'claude-fable-5-1' }),
      ]),
    };
    const byDefault = await run(files);
    const optedIn = await run(files, [], { priceReceipts: true });

    expect(byDefault.receipts).toHaveLength(2);
    // Byte-for-byte: the default is not "similar to" the opted-in path, it IS
    // that path. Comparing only cost.total would miss a divergence elsewhere.
    expect(byDefault.receipts).toEqual(optedIn.receipts);
    for (const receipt of byDefault.receipts) {
      expect(receipt.cost.pricing_version).toBe(PRICING_VERSION);
      expect(Number.isFinite(receipt.cost.total)).toBe(true);
    }
  });

  it('prices every receipt from its own tier, with no option passed', async () => {
    // Deliberately no `priceReceipts`: this is the per-tier pin ON THE DEFAULT.
    const result = await run({
      [MAIN]: jsonl([
        assistantEntry({ requestId: 'req-1', model: 'claude-opus-5' }),
        assistantEntry({ requestId: 'req-2', model: 'claude-fable-5-1' }),
      ]),
    });

    expect(result.receipts).toHaveLength(2);
    for (const receipt of result.receipts) {
      const expected = priceUsage(receipt.usage, receipt.model_identity.tier);
      expect(receipt.cost.pricing_version).toBe(PRICING_VERSION);
      expect(Number.isFinite(receipt.cost.total)).toBe(true);
      expect(receipt.cost.total).toBeGreaterThanOrEqual(0);
      expect(receipt.cost.total).toBe(expected.total);
    }
    // Different tiers must not collapse to the same number.
    const totals = result.receipts.map((r) => r.cost.total);
    expect(new Set(totals).size).toBe(2);
  });

  it('prices a subagent receipt independently of the main thread', async () => {
    const result = await run(
      {
        [MAIN]: jsonl([assistantEntry({ model: 'claude-opus-5' })]),
        [SUB]: jsonl([
          assistantEntry({ requestId: 'req-s1', model: 'claude-haiku-4-5' }),
        ]),
      },
      [SUB],
      { priceReceipts: true },
    );

    const sub = result.receipts.find((r) => r.run_id === 'agent-abc123');
    expect(sub.model_identity.tier).toBe('haiku');
    expect(sub.cost.total).toBe(priceUsage(sub.usage, 'haiku').total);
  });

  it('prices an estimate-graded receipt too, and says so via the source field', async () => {
    // A degraded receipt is still a real spend. Refusing to price it would
    // understate the total; the honesty marker is `usage.source`, not a null.
    const result = await run(
      {
        [MAIN]: jsonl([
          assistantEntry({ requestId: 'req-1', usage: { output_tokens: null } }),
        ]),
      },
      [],
      { priceReceipts: true },
    );
    expect(result.receipts[0].usage.source).toBe('estimate');
    expect(Number.isFinite(result.receipts[0].cost.total)).toBe(true);
  });

  it('only the literal false opts out', async () => {
    const result = await run(
      { [MAIN]: jsonl([assistantEntry()]) },
      [],
      { priceReceipts: false },
    );
    expect(result.receipts[0].cost).toEqual({
      total: null,
      pricing_version: PRICING_VERSION_UNRESOLVED,
    });
  });

  it.each([['false'], [0], [undefined], [null], [1], [{}]])(
    'still prices for priceReceipts %p — the opt-out is an allowlist of one',
    async (value) => {
      // The string 'false' is the surprising member and is spelled out on
      // purpose: it reads like an opt-out and is NOT one. The alternative — a
      // falsy check — would let `0`, `''` and `null` unprice a row silently,
      // and downstream an unpriced row is indistinguishable from a free
      // attempt. Refusing all but `false` makes the miss loud at the call site
      // instead of quiet in the ledger.
      const result = await run(
        { [MAIN]: jsonl([assistantEntry()]) },
        [],
        { priceReceipts: value },
      );
      expect(result.receipts[0].cost.pricing_version).toBe(PRICING_VERSION);
      expect(Number.isFinite(result.receipts[0].cost.total)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// classifyEmptyReceipts
//
// The counters in `meta` are this module's vocabulary, so the reading of them
// lives here rather than in the hook that prints the reason. Every positive
// case below is built by the REAL fold, not by a hand-written meta: a
// classifier tested only against metas the test author invented proves the
// author and the classifier agree, not that either matches what the module
// emits.
// ---------------------------------------------------------------------------
describe('classifyEmptyReceipts', () => {
  /** The meta the real fold produces for a transcript, asserted to be empty. */
  async function emptyMetaFor(files, subagents = []) {
    const result = await run(files, subagents);
    // Guard the premise: the classifier only ever sees a zero-receipt fold, so
    // a fixture that accidentally produced one would test the wrong branch.
    expect(result.receipts).toHaveLength(0);
    return result.meta;
  }

  it('reads an empty transcript as no-entries', async () => {
    const meta = await emptyMetaFor({ [MAIN]: '' });
    expect(meta.entries).toBe(0);
    expect(meta.syntheticEntries).toBe(0);
    expect(classifyEmptyReceipts(meta)).toBe('no-entries');
  });

  it('separates a transcript of synthetic entries as all-synthetic', async () => {
    // Synthetic entries never reach `entries`, so without this branch a
    // transcript full of them is indistinguishable from an empty file — and
    // the two call for opposite follow-ups.
    const meta = await emptyMetaFor({
      [MAIN]: jsonl([
        assistantEntry({ model: '<synthetic>', requestId: 'req-a' }),
        assistantEntry({ model: '<synthetic>', requestId: 'req-b' }),
      ]),
    });
    expect(meta.entries).toBe(0);
    expect(meta.syntheticEntries).toBe(2);
    expect(classifyEmptyReceipts(meta)).toBe('all-synthetic');
  });

  it('reads a transcript whose every entry named an unknown model as all-unresolved', async () => {
    const meta = await emptyMetaFor({
      [MAIN]: jsonl([
        assistantEntry({ model: 'gpt-9-turbo', requestId: 'req-a' }),
        assistantEntry({ model: 'gpt-9-turbo', requestId: 'req-b' }),
      ]),
    });
    expect(meta.entries).toBe(2);
    expect(meta.unresolvedModels).toEqual({ 'gpt-9-turbo': 2 });
    expect(classifyEmptyReceipts(meta)).toBe('all-unresolved');
  });

  it('reads entries dropped for a missing model as no-usage', async () => {
    const meta = await emptyMetaFor({
      [MAIN]: jsonl([
        assistantEntry({ model: null, requestId: 'req-a' }),
        assistantEntry({ model: null, requestId: 'req-b' }),
      ]),
    });
    expect(meta.entries).toBe(2);
    expect(meta.entriesWithoutModel).toBe(2);
    expect(classifyEmptyReceipts(meta)).toBe('no-usage');
  });

  it('reads a group skipped for want of a timestamp as no-usage', async () => {
    const meta = await emptyMetaFor({
      [MAIN]: jsonl([assistantEntry({ timestamp: null, requestId: 'req-a' })]),
    });
    expect(meta.entries).toBe(1);
    expect(meta.skipped).toHaveLength(1);
    expect(meta.skipped[0].reason).toBe('no-timestamp');
    expect(classifyEmptyReceipts(meta)).toBe('no-usage');
  });

  it('reads a mixed unresolved-plus-skipped fold as no-usage, not all-unresolved', async () => {
    // `all-unresolved` is a claim about EVERY entry. One entry that reached a
    // group and was skipped for another reason makes that claim false, so the
    // exact-accounting branch has to take it.
    const meta = await emptyMetaFor({
      [MAIN]: jsonl([
        assistantEntry({ model: 'gpt-9-turbo', requestId: 'req-a' }),
        assistantEntry({ timestamp: null, requestId: 'req-b' }),
      ]),
    });
    expect(meta.entries).toBe(2);
    expect(classifyEmptyReceipts(meta)).toBe('no-usage');
  });

  // -- An unread file is unaccounted input ----------------------------------

  it('refuses to classify a fold whose transcript could not be read', async () => {
    // THE FAILURE THIS GUARDS. A missing or unreadable file folds nothing, so
    // `entries` and `syntheticEntries` are both 0 and the shape is identical
    // to a genuinely empty transcript. Calling that `no-entries` asserts "no
    // assistant entry was folded" about a file NOBODY READ — a guess that
    // reads as a measurement once it is in the ledger. It matters live:
    // `session.ended`'s `transcript_present` is only a check that the payload
    // carried a path string, so an unreadable transcript reaches here looking
    // present.
    const meta = await emptyMetaFor({});
    expect(meta.files).toBe(1);
    expect(meta.unreadableFiles).toBe(1);
    expect(meta.entries).toBe(0);
    expect(classifyEmptyReceipts(meta)).toBeNull();
  });

  it('refuses to classify when only one of several files was unreadable', async () => {
    // The guard is top-level, not a rider on the zero-entry branches. These
    // entries WOULD account exactly as `all-unresolved`, but that claim is
    // about every entry in the session, and one file's entries were never
    // seen. A partial read cannot support a total claim.
    const meta = await emptyMetaFor(
      {
        [MAIN]: jsonl([
          assistantEntry({ model: 'gpt-9-turbo', requestId: 'req-a' }),
          assistantEntry({ model: 'gpt-9-turbo', requestId: 'req-b' }),
        ]),
      },
      [SUB],
    );
    expect(meta.files).toBe(2);
    expect(meta.unreadableFiles).toBe(1);
    expect(meta.entries).toBe(2);
    expect(meta.unresolvedModels).toEqual({ 'gpt-9-turbo': 2 });
    expect(classifyEmptyReceipts(meta)).toBeNull();
  });

  it.each([
    ['absent', {}],
    ['not a number', { unreadableFiles: 'one' }],
    ['negative', { unreadableFiles: -1 }],
  ])('returns null when the unreadable-file count is %s', (_label, patch) => {
    // Strict for the same reason the other counters are: a count that cannot
    // be read is not evidence that nothing went unread.
    const base = emptyResult().meta;
    delete base.unreadableFiles;
    expect(classifyEmptyReceipts({ ...base, ...patch })).toBeNull();
  });

  // -- Unclassifiable is reported, never guessed ----------------------------

  it.each([
    ['a meta with no counters at all', { coverage: null }],
    ['a null meta', null],
    ['an undefined meta', undefined],
    ['a non-object meta', 'no-receipts'],
  ])('returns null for %s', (_label, meta) => {
    expect(classifyEmptyReceipts(meta)).toBeNull();
  });

  it('returns null when the entries counter is not a number', () => {
    const meta = { ...emptyResult().meta, entries: '2' };
    expect(classifyEmptyReceipts(meta)).toBeNull();
  });

  it('returns null when an unresolved-model tally is not a number', () => {
    const meta = { ...emptyResult().meta, entries: 2, unresolvedModels: { 'gpt-9': 'two' } };
    expect(classifyEmptyReceipts(meta)).toBeNull();
  });

  it('returns null when a skipped group carries no entry count', () => {
    const meta = {
      ...emptyResult().meta,
      entries: 2,
      skipped: [{ run_id: 'r', model_id: 'm', reason: 'no-timestamp' }],
    };
    expect(classifyEmptyReceipts(meta)).toBeNull();
  });

  it('returns null when the misses do not add up to the entries seen', () => {
    // Three entries, one accounted for. The other two are unexplained, and a
    // residual bucket would file them under whichever token came last.
    const meta = { ...emptyResult().meta, entries: 3, entriesWithoutModel: 1 };
    expect(classifyEmptyReceipts(meta)).toBeNull();
  });

  it('returns null for a fold that actually produced receipts', async () => {
    const result = await run({ [MAIN]: jsonl([assistantEntry()]) });
    expect(result.receipts).toHaveLength(1);
    expect(classifyEmptyReceipts(result.meta)).toBeNull();
  });
});
