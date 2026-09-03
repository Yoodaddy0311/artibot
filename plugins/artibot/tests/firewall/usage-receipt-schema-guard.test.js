/**
 * Firewall: every receipt the single writer emits must satisfy the T-16
 * Attempt Receipt schema.
 *
 * The unit suite (`tests/economics/usage-receipt.test.js`) pins the writer's
 * behaviour against its own expectations. That is not the same statement as
 * "the output is a valid receipt": the writer and its unit tests could drift
 * together and stay green. This gate closes that by running the writer's real
 * output through `schemas/attempt-receipt.schema.json` — the contract T-16
 * owns and this module does not — plus the three structural invariants the
 * task fixes:
 *
 *   1. a clean transcript yields a schema-valid `source: 'transcript'` receipt
 *   2. a missing REQUIRED usage key downgrades to `source: 'estimate'` AND
 *      increments `parseFailures` (the >=95% coverage ratio's numerator)
 *   3. a repeated requestId is folded exactly once (no double counting)
 *
 * THE ORACLE IS REQUIRED, NOT OPTIONAL. ajv is the only thing here that can
 * read the schema; without it the four conformance assertions below are not
 * weaker, they are ABSENT. An earlier revision skipped them when ajv was
 * missing and paired that with a test asserting
 * `typeof (Ajv === null ? 'skipped' : 'validated') === 'string'` — a
 * tautology that passes either way, so a run with NO schema validation at all
 * reported the same green as a run with four. This block now goes RED instead:
 * every conformance test runs unconditionally, and a missing oracle surfaces
 * as {@link AJV_MISSING} rather than as a skip nobody reads.
 *
 * ajv reaches us only as a TRANSITIVE dependency (`eslint -> ajv`, measured
 * 2026-09-03: eslint@10.2.1 pulls it, package.json declares no `ajv`), so an
 * eslint bump can remove the oracle with nothing else changing. The fix when
 * that happens is to DECLARE ajv as a devDependency — never to restore the
 * skip. Note `tests/schemas/receipts.test.js` still carries the older
 * skip-on-missing pattern; it has the same hole and is out of this file's
 * ownership.
 *
 * WHAT THIS GATE DOES NOT COVER (do not read a green run as more than this):
 *  - The fixtures are synthetic. Nothing here proves the real Claude Code
 *    transcript still has this shape; the format is internal and undocumented,
 *    and this suite is forbidden from reading `~/.claude/projects` to check.
 *  - No production caller exists. A green run says the writer CAN produce a
 *    valid receipt, not that one is ever produced or appended to the ledger.
 *  - `cost.total` is null by design, so nothing here exercises pricing at all.
 *  - Coverage arithmetic is checked on fixtures of 1-3 entries. A ratio
 *    measured on three entries says nothing about the live >=95% target.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildUsageReceipts } from '../../lib/economics/usage-receipt.js';

let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../schemas/attempt-receipt.schema.json',
);
const attemptSchema = JSON.parse(await readFile(SCHEMA_PATH, 'utf-8'));

const MAIN = '/fixture/projects/slug/sess-guard.jsonl';
const SUB = '/fixture/projects/slug/sess-guard/subagents/agent-7f3a.jsonl';

/** One assistant entry in the shape measured 2026-09-02. */
function entry({ model, requestId, timestamp, usage, dropUsageKey }) {
  const built = {
    type: 'assistant',
    requestId,
    timestamp,
    effort: 'high',
    message: {
      model,
      role: 'assistant',
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 800,
        output_tokens: 45,
        output_tokens_details: { thinking_tokens: 12 },
        ...usage,
      },
    },
  };
  if (dropUsageKey) delete built.message.usage[dropUsageKey];
  return JSON.stringify(built);
}

/**
 * The three fixtures the task names: a clean main thread, a main thread with a
 * key-missing entry, and a subagent file. Kept as one map so every case runs
 * through the same injected ports and no test can reach the filesystem.
 */
const FIXTURES = {
  clean: [
    entry({
      model: 'claude-opus-5',
      requestId: 'req-a',
      timestamp: '2026-09-02T06:29:36.000Z',
    }),
    entry({
      model: 'claude-opus-5',
      requestId: 'req-b',
      timestamp: '2026-09-02T06:29:41.250Z',
      usage: { input_tokens: 80, output_tokens: 900 },
    }),
  ].join('\n'),

  degraded: [
    entry({
      model: 'claude-fable-5-1',
      requestId: 'req-c',
      timestamp: '2026-09-02T06:30:00.000Z',
    }),
    entry({
      model: 'claude-fable-5-1',
      requestId: 'req-d',
      timestamp: '2026-09-02T06:30:04.000Z',
      dropUsageKey: 'output_tokens',
    }),
  ].join('\n'),

  duplicate: (() => {
    const line = entry({
      model: 'claude-opus-5',
      requestId: 'req-same',
      timestamp: '2026-09-02T06:31:00.000Z',
    });
    return [line, line].join('\n');
  })(),

  subagent: [
    entry({
      model: 'claude-haiku-4-5-20251001',
      requestId: 'req-s1',
      timestamp: '2026-09-02T06:32:00.000Z',
    }),
    entry({
      model: 'claude-haiku-4-5-20251001',
      requestId: 'req-s2',
      timestamp: '2026-09-02T06:32:09.000Z',
    }),
  ].join('\n'),
};

/**
 * Run the writer over an in-memory file map. Both ports are injected, so this
 * gate never reads a real home directory — asserted below.
 */
function build(mainBody, { subagentBody = null } = {}) {
  const files = { [MAIN]: mainBody };
  if (subagentBody !== null) files[SUB] = subagentBody;
  return buildUsageReceipts({
    transcriptPath: MAIN,
    missionId: 'mission-guard-1',
    readTranscript: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    listSubagentTranscripts: () => (subagentBody === null ? [] : [SUB]),
  });
}

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to declare the dependency, and
 * the wrong one (deleting or skipping the assertions) is the response that
 * looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so schemas/attempt-receipt.schema.json cannot be',
  'enforced and this gate proves nothing. ajv is only a TRANSITIVE dependency',
  "here (eslint -> ajv); package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

describe('usage receipt — schema conformance', () => {
  // Not `null` when ajv is absent: a null validator turns every assertion
  // below into "Cannot read properties of null", which buries the real cause.
  // A throwing stub makes all four fail with the instruction instead.
  const validate = Ajv === null
    ? () => {
      throw new Error(AJV_MISSING);
    }
    : new Ajv({ allErrors: true }).compile(attemptSchema);

  it('a clean transcript yields a schema-valid receipt', async () => {
    const { receipts } = await build(FIXTURES.clean);
    expect(receipts).toHaveLength(1);
    expect(validate(receipts[0])).toBe(true);
    expect(receipts[0].usage.source).toBe('transcript');
  });

  it('a degraded transcript still yields a schema-valid receipt', async () => {
    const { receipts } = await build(FIXTURES.degraded);
    expect(receipts).toHaveLength(1);
    expect(validate(receipts[0])).toBe(true);
    expect(receipts[0].usage.source).toBe('estimate');
  });

  it('a subagent file yields a schema-valid receipt of its own', async () => {
    const { receipts } = await build(FIXTURES.clean, {
      subagentBody: FIXTURES.subagent,
    });
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(validate(receipt)).toBe(true);
    }
    expect(receipts.map((r) => r.run_id).sort()).toEqual([
      'agent-7f3a',
      'sess-guard',
    ]);
  });

  it('every receipt in every fixture validates', async () => {
    for (const body of Object.values(FIXTURES)) {
      const { receipts } = await build(body, { subagentBody: FIXTURES.subagent });
      for (const receipt of receipts) {
        if (!validate(receipt)) {
          throw new Error(
            `receipt failed schema: ${JSON.stringify(validate.errors)}`,
          );
        }
      }
    }
  });

  it('has its schema oracle, and goes red rather than skipping without one', () => {
    // The assertion IS the fail-closed statement: when ajv is gone this test
    // fails and prints the fix, instead of the suite quietly running four
    // fewer assertions. The compared value carries the guidance so the
    // failure diff is the instruction.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');
  });

  it('has an oracle with teeth — it rejects a receipt that violates the schema', async () => {
    // Without this, every `validate(x) === true` above would also pass against
    // a vacuous or mis-compiled validator. Proving the oracle can say NO is
    // what makes its YES worth anything.
    const { receipts } = await build(FIXTURES.clean);
    const broken = JSON.parse(JSON.stringify(receipts[0]));
    delete broken.usage.source;
    expect(validate(broken)).toBe(false);

    const alsoBroken = JSON.parse(JSON.stringify(receipts[0]));
    alsoBroken.model_identity.tier = 'not-a-tier';
    expect(validate(alsoBroken)).toBe(false);
  });
});

describe('usage receipt — degradation is recorded, not hidden', () => {
  it('a missing required usage key downgrades the source AND counts a failure', async () => {
    const { receipts, meta } = await build(FIXTURES.degraded);

    expect(receipts[0].usage.source).toBe('estimate');
    expect(meta.parseFailures).toBe(1);
    expect(meta.sources).toEqual({ transcript: 0, estimate: 1 });
  });

  it('a clean transcript raises no failure counter', async () => {
    const { meta } = await build(FIXTURES.clean);
    expect(meta.parseFailures).toBe(0);
    expect(meta.coverage).toBe(1);
  });

  it('coverage falls when an entry is not measured', async () => {
    const { meta } = await build(FIXTURES.degraded);
    // Both entries sit in one estimate-graded group, so none of them count as
    // measured. A degraded entry must never be laundered into a measured
    // aggregate by averaging it with a good one.
    expect(meta.entries).toBe(2);
    expect(meta.measuredEntries).toBe(0);
    expect(meta.coverage).toBe(0);
  });

  it('an estimate-graded receipt carries no requests count', async () => {
    const { receipts } = await build(FIXTURES.degraded);
    expect(receipts[0].usage).not.toHaveProperty('requests');
  });
});

describe('usage receipt — no double counting', () => {
  it('the same requestId twice folds to one attempt', async () => {
    const { receipts, meta } = await build(FIXTURES.duplicate);

    expect(receipts).toHaveLength(1);
    expect(receipts[0].usage.requests).toBe(1);
    expect(receipts[0].usage.fresh_input_tokens).toBe(120);
    expect(receipts[0].usage.output_tokens).toBe(45);
    expect(meta.duplicateRequestIds).toBe(1);
    expect(meta.entries).toBe(1);
  });

  it('one run yields one receipt when it served one model', async () => {
    const { receipts, meta } = await build(FIXTURES.clean, {
      subagentBody: FIXTURES.subagent,
    });
    const runIds = receipts.map((r) => r.run_id);
    expect(new Set(runIds).size).toBe(runIds.length);
    expect(meta.multiModelRuns).toEqual([]);
  });

  it('the main and subagent totals stay separate, never summed into one', async () => {
    const { receipts } = await build(FIXTURES.clean, {
      subagentBody: FIXTURES.subagent,
    });
    const main = receipts.find((r) => r.run_id === 'sess-guard');
    const sub = receipts.find((r) => r.run_id === 'agent-7f3a');

    expect(main.model_identity.tier).toBe('opus');
    expect(sub.model_identity.tier).toBe('haiku');
    expect(main.usage.output_tokens).toBe(945);
    expect(sub.usage.output_tokens).toBe(90);
  });
});

describe('usage receipt — the fields T-16 requires the writer to be honest about', () => {
  it('never prices a receipt while the price table is unresolved', async () => {
    const { receipts } = await build(FIXTURES.clean, {
      subagentBody: FIXTURES.subagent,
    });
    for (const receipt of receipts) {
      expect(receipt.cost.total).toBeNull();
      expect(typeof receipt.cost.pricing_version).toBe('string');
      expect(receipt.cost.pricing_version.length).toBeGreaterThan(0);
    }
  });

  it('stamps the catalog version the identity was resolved against', async () => {
    const { receipts } = await build(FIXTURES.clean);
    expect(receipts[0].model_identity.catalog_version).toBe('2026-09-02');
  });

  it('leaves accepted null, because no acceptance signal is recorded anywhere', async () => {
    const { receipts } = await build(FIXTURES.clean);
    expect(receipts[0].outcome.accepted).toBeNull();
  });

  it('omits action_id, because the transcript carries no action attribution', async () => {
    const { receipts } = await build(FIXTURES.clean);
    expect(receipts[0]).not.toHaveProperty('action_id');
  });
});

describe('usage receipt — isolation', () => {
  it('reads nothing when both ports are injected', async () => {
    const seen = [];
    const result = await buildUsageReceipts({
      transcriptPath: MAIN,
      missionId: 'mission-guard-1',
      readTranscript: (p) => {
        seen.push(p);
        return FIXTURES.clean;
      },
      listSubagentTranscripts: () => [],
    });

    expect(seen).toEqual([MAIN]);
    expect(seen.every((p) => !p.includes('.claude'))).toBe(true);
    expect(result.receipts).toHaveLength(1);
  });

  it('the source file requests no network module', async () => {
    const source = await readFile(
      path.resolve(__dirname, '../../lib/economics/usage-receipt.js'),
      'utf-8',
    );
    for (const forbidden of ['node:http', 'node:https', 'node:net', 'fetch(']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
