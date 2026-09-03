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

import {
  buildUsageReceipts,
  emptyResult,
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

  it('leaves cost unpriced with the unresolved marker', async () => {
    const result = await run({ [MAIN]: jsonl([assistantEntry()]) });
    expect(result.receipts[0].cost).toEqual({
      total: null,
      pricing_version: PRICING_VERSION_UNRESOLVED,
    });
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
