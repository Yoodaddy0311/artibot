/**
 * Real-process contract for `scripts/ledger/route-compare.mjs` — the CLI that
 * prints, per spawned agent, the model the router RECOMMENDED beside the model
 * that was actually SERVED.
 *
 * WHY THE CASES SPAWN A PROCESS AND SEED A REAL LEDGER. The arithmetic lives in
 * `lib/replay/spawn-outcome.js` and has its own pure unit suite, which proves
 * the fold counts a given ARRAY correctly and proves nothing about whether rows
 * of that shape survive the ledger's allowlist, envelope validation and byte
 * cap on the way in. A `data` shape the writer refuses lands as
 * `ledger.rejected` and is excluded from every read — a green fold suite and an
 * empty comparison report are perfectly compatible. So every seeded case here
 * writes through the real ledger writer and spawns the real script against it;
 * the FIRST seeded case asserts the file holds ZERO `ledger.rejected` lines,
 * and the later cases reuse the same deterministic seed, so that one assertion
 * covers the shape they all depend on.
 *
 * THE TWO SIDES ARRIVE FROM DIFFERENT EVENTS AND NEITHER ANSWERS ALONE.
 * `route.bound` carries the recommendation and the agent id; `usage.receipt`
 * carries the model that actually billed. A count of receipts cannot separate
 * "the router was obeyed" from "few agents spawned", which is why this file
 * seeds both sides in one ledger and pins the JOIN rather than either count.
 *
 * READ-ONLY IS ASSERTED, NOT ASSUMED. "It does not import the writer" is a
 * claim about the source rather than about the run, so two cases measure the
 * filesystem instead: an empty root must still have no ledger file after the
 * script has run, and a seeded root's ledger must have the same byte length
 * before and after. A measuring tool that appends to the stream it measures is
 * its own next data point, and that regression is invisible in every other
 * assertion here. A third case pins the source text, because an import added
 * behind a branch that these seeds never take would pass the byte-length case.
 *
 * `agreement_rate` IS `null`, NEVER `0`, WHEN NOTHING WAS COMPARED — asserted
 * with BOTH `toBeNull()` and `not.toBe(0)`. The two are different findings
 * ("no comparable pair yet" vs "every pair diverged") and `toBeFalsy()` would
 * pass for either. An empty ledger is the likely live answer, so this is the
 * assertion most likely to be read as noise and loosened.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *  Every case builds its own `mkdtempSync` root and uses it as BOTH the child
 *  process cwd and `--cwd`, so nothing here can reach the repository's own
 *  ledger. The one case that omits `--cwd` still runs with the child cwd inside
 *  the temp root, which is the defaulting behaviour it measures.
 *
 * ── WHY EVERY TMP ROOT CARRIES `artibot.config.json` ────────────────────────
 *  Inherited from `tests/ledger/session-coverage-cli.test.js`: Artibot guards
 *  drop out entirely when the cwd is outside an Artibot repo, and a bare `.git/`
 *  directory is not enough to make a temp directory look like one. Nothing here
 *  depends on a guard firing; the roots keep the precedent's shape rather than
 *  being load-bearing.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - WHETHER ANY LIVE SPAWN EVER WRITES A `route.bound` ROW. The rows here are
 *    seeded by the test. This file says nothing about the live rate.
 *  - WHETHER `recommended_model` IS THE ROUTER'S REAL ANSWER. It is a
 *    self-report copied onto the bind by the SubagentStart hook; the seeds here
 *    assert the CLI carries the claim through, not that the claim is true.
 *  - THE FOLD'S CLASSIFICATION RULES beyond the totals asserted below.
 *    `divergence` is pinned only by its own internal invariant (its values sum
 *    to `by_agreement.diverged`), so this file stays green if the fold refines
 *    how it labels a divergence bucket. The bucket keys belong to the fold's
 *    own suite.
 *  - THE INSTALLED COPY, and any ledger larger than a handful of rows.
 *
 * @module tests/ledger/route-compare-cli
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { ledgerFilePath, sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';
import { buildUsageReceipts } from '../../lib/economics/usage-receipt.js';
import { toUsageReceiptEnvelopes } from '../../lib/economics/receipt-envelope.js';
import { joinSpawnOutcomes } from '../../lib/replay/index.js';

// This file spawns child processes. The budget buys headroom for load; nothing
// here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'route-compare.mjs');

/**
 * The exact key set, IN ORDER, that the module header promises a caller can
 * parse blind. Order is pinned as well as membership: the promise is a fixed
 * line shape, and a reader diffing two runs of this tool reads the diff by eye.
 */
const STDOUT_KEYS = [
  'events', 'measured_at', 'ledger_path', 'since',
  'binds', 'duplicate_binds', 'malformed_binds',
  'receipts', 'main_thread_receipts', 'subagent_receipts', 'malformed_receipts',
  'model_mismatch', 'duplicate_receipts',
  'pairs', 'compared', 'excluded_fifo', 'excluded_no_recommendation',
  'by_agreement', 'agreement_rate', 'by_confidence',
  'agreed_by_model', 'divergence', 'multi_model_runs',
  'cost', 'usage_totals', 'latency',
  'unjoined_binds', 'unjoined_receipts', 'score', 'census',
];

/** The two transcript entry stamps every seeded run uses, 5,250 ms apart. */
const T0 = '2026-09-13T06:29:36.000Z';
const T1 = '2026-09-13T06:29:41.250Z';
const LATENCY_MS = Date.parse(T1) - Date.parse(T0);

/**
 * The token totals `runs` seeded runs are worth, per usage field.
 *
 * Derived from the fixture entry below times the two entries each run carries,
 * so the expectation moves with the fixture instead of being a magic number
 * that outlives the seed it was copied from.
 *
 * @param {number} runs
 * @returns {Record<string, number>}
 */
function usageOf(runs) {
  const perRun = {
    fresh_input_tokens: 120,
    cached_input_tokens: 4000,
    cache_creation_tokens: 800,
    output_tokens: 45,
    thinking_tokens: 12,
    requests: 1,
  };
  return Object.fromEntries(
    Object.entries(perRun).map(([k, v]) => [k, v * 2 * runs]),
  );
}

/**
 * A value's KEY STRUCTURE, with leaf values discarded.
 *
 * Objects become an ordered list of `[key, shape]` entries, so a deep equality
 * over two of these compares key ORDER as well as membership — which `toEqual`
 * on the objects themselves does not. Arrays stay arrays so an array and an
 * object with numeric keys cannot compare equal.
 *
 * @param {unknown} v
 * @returns {unknown}
 */
function keyShape(v) {
  if (Array.isArray(v)) return v.map(keyShape);
  if (v !== null && typeof v === 'object') {
    return Object.entries(v).map(([k, val]) => [k, keyShape(val)]);
  }
  return null;
}

/** @type {string} */
let tmp;

/** A project root the Artibot guards will actually run inside. */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** Run the CLI inside a project root. */
function runCli(args, root) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** The one JSON line, parsed, with the stream discipline checked first. */
function parseOne(out) {
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  expect(out.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(out.stdout);
}

/** Every well-formed line in a project's ledger, rejections included. */
function ledgerLines(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * The seeded rows, with the rejected count checked FIRST.
 *
 * A rejected line means the seed violated the writer's contract and was
 * silently replaced — every count below would then be measured over a file that
 * does not contain what this test thinks it seeded.
 */
function seededLines(root) {
  const lines = ledgerLines(root);
  expect(lines.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
  return lines;
}

/** One assistant transcript entry in the shape measured 2026-09-02. */
function entry(requestId, timestamp, model) {
  return JSON.stringify({
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
      },
    },
  });
}

/** Two entries for one run, both billed to `model`. */
function transcriptBody(stem, model) {
  return [entry(`${stem}-a`, T0, model), entry(`${stem}-b`, T1, model)].join('\n');
}

/**
 * Append one schema-valid `usage.receipt` per run — the main thread plus one
 * per subagent.
 *
 * Built through the real receipt builder with injected ports rather than
 * hand-typed: the writer validates this event's whole `data` object against
 * `schemas/attempt-receipt.schema.json`, so an invented shape lands as
 * `ledger.rejected` and the rows this test needs are never in the file.
 *
 * THE RUN ID IS THE TRANSCRIPT STEM, and the join key is that stem WITHOUT its
 * `agent-` prefix. A subagent file is named `agent-<agentId>.jsonl`, so the
 * bind's bare `agent_id` and the receipt's prefixed `run_id` are two spellings
 * of one spawn (`spawn-outcome.js#AGENT_RUN_PREFIX`); the main thread is not a
 * spawn and stands in its session id, which carries no prefix and is how the
 * fold tells the two populations apart (`usage-receipt.js#runIdForFile`).
 * Seeding an agent id that ALREADY begins with `agent-` double-prefixes the
 * file name and every pair silently vanishes, which is how this helper was
 * wrong on its first run.
 *
 * THE MISSION ID IS SYNTHESIZED BY THE PRODUCTION HELPER, not spelled by hand:
 * `event-writer.js#MISSION_ID_RE` accepts only `M-<YYYYMMDD>-<seq|Ssid8>`, and
 * a readable id like `mission-spawn` is rejected as `invalid-envelope:mission_id`.
 *
 * @param {string} root
 * @param {string} sessionId also the main-thread transcript stem
 * @param {Record<string,string>} agentModels agent id -> model actually served
 * @param {string} mainModel model the main thread was served
 * @param {{priced?: boolean}} [o] `priced: false` uses the builder's own
 *   pricing opt-out, so the rows are unpriced the way production makes them
 *   rather than hand-broken into a shape the schema would refuse.
 * @returns {Promise<void>}
 */
async function seedReceipts(root, sessionId, agentModels, mainModel, o = {}) {
  const dir = '/fixture/projects/slug';
  const transcriptPath = `${dir}/${sessionId}.jsonl`;
  const fileFor = (id) => `${dir}/${sessionId}/subagents/agent-${id}.jsonl`;
  const subagentPaths = Object.keys(agentModels).map(fileFor);
  const bodies = new Map([[transcriptPath, transcriptBody(sessionId, mainModel)]]);
  for (const [id, model] of Object.entries(agentModels)) {
    bodies.set(fileFor(id), transcriptBody(id, model));
  }
  const { receipts } = await buildUsageReceipts({
    transcriptPath,
    missionId: sessionFallbackMissionId(sessionId, '2026-09-13T00:00:00.000Z'),
    ...(o.priced === false ? { priceReceipts: false } : {}),
    readTranscript: (p) => {
      const body = bodies.get(p);
      if (body === undefined) throw new Error(`ENOENT ${p}`);
      return body;
    },
    listSubagentTranscripts: () => subagentPaths,
  });
  expect(receipts).toHaveLength(subagentPaths.length + 1);
  const envelopes = toUsageReceiptEnvelopes(receipts, { sessionId });
  for (const envelope of envelopes) {
    const res = appendLedgerEvent(root, envelope);
    expect(res.ok).toBe(true);
  }
}

/**
 * Append one `route.bound` row in the shape the SubagentStart hook writes.
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {string} agentId
 * @param {{confidence: string, method: string, recommended?: string|null,
 *          selected?: string, now?: () => Date}} o
 * @returns {void}
 */
function seedBind(root, sessionId, agentId, o) {
  // KEY ORDER MIRRORS THE WRITER, `subagent-handler.js#bindRoute`: the four
  // required keys, then agent_type, matched_on, selected_model,
  // recommended_model, action_class in that order. Nothing validates key order,
  // so this buys no assertion — it is fixture honesty. A fixture that does not
  // look like the row it stands in for is the thing a reader trusts and should
  // not, and the two optional model keys are conditional in the writer too.
  const data = {
    tool_use_id: `toolu_${agentId}`,
    agent_id: agentId,
    confidence: o.confidence,
    method: o.method,
    agent_type: 'tdd-guide',
    matched_on: 'name',
  };
  if (typeof o.selected === 'string') data.selected_model = o.selected;
  if (typeof o.recommended === 'string') data.recommended_model = o.recommended;
  data.action_class = 'implement';
  const res = appendLedgerEvent(root, {
    event: 'route.bound',
    session_id: sessionId,
    source: 'hook',
    idempotency_key: `route.bound:${agentId}`,
    data,
  }, o.now === undefined ? {} : { now: o.now });
  // The seed is the premise of every count below; a silent write failure would
  // read as "the CLI counted wrong".
  expect(res.ok).toBe(true);
}

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';
const SESSION = 'sessSpawn0001';

/**
 * One ledger holding every population the stdout line names, arranged so no
 * field is non-zero by accident:
 *   sp1        recommended opus, served opus,  exact -> same
 *   sp2        recommended opus, served opus,  exact -> same
 *   sp3        recommended opus, served FABLE, name  -> diverged
 *   sp4        recommended opus, served opus,  FIFO  -> a pair, excluded
 *   sp5        recommended opus, NO receipt,   exact -> an unjoined bind
 *   <session>  the main thread's receipt, which is not a spawn at all
 */
async function seedLedger(root) {
  await seedReceipts(root, SESSION, {
    sp1: OPUS, sp2: OPUS, sp3: FABLE, sp4: OPUS,
  }, OPUS);
  seedBind(root, SESSION, 'sp1', { confidence: 'exact', method: 'prompt_id+name', recommended: OPUS, selected: OPUS });
  seedBind(root, SESSION, 'sp2', { confidence: 'exact', method: 'prompt_id+name', recommended: OPUS, selected: OPUS });
  seedBind(root, SESSION, 'sp3', { confidence: 'name', method: 'name-only', recommended: OPUS, selected: OPUS });
  seedBind(root, SESSION, 'sp4', { confidence: 'fifo', method: 'fifo-only', recommended: OPUS, selected: OPUS });
  seedBind(root, SESSION, 'sp5', { confidence: 'exact', method: 'prompt_id+name', recommended: OPUS, selected: OPUS });
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-rcmp-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('route-compare: a project with no ledger', () => {
  it('reports agreement_rate null — not 0 — and creates no file', () => {
    const root = makeRoot('A');
    const file = ledgerFilePath(root);
    expect(existsSync(file)).toBe(false);

    const printed = parseOne(runCli(['--cwd', root], root));

    expect(printed.events).toEqual({ bind: 'route.bound', receipt: 'usage.receipt' });
    expect(printed.binds).toBe(0);
    expect(printed.receipts).toBe(0);
    expect(printed.compared).toBe(0);
    // "Nothing comparable yet" and "every pair diverged" are different findings.
    expect(printed.agreement_rate).toBeNull();
    expect(printed.agreement_rate).not.toBe(0);
    expect(printed.by_agreement).toEqual({ same: 0, diverged: 0 });
    expect(printed.pairs).toEqual([]);
    expect(printed.score).toEqual({
      source: null, value: null, reason: 'no-spawn-keyed-score-writer',
    });
    expect(printed.census.file.present).toBe(false);
    expect(printed.census.file.readable).toBe(false);
    expect(printed.ledger_path).toBe(file);
    expect(printed.since).toBeNull();
    // READ-ONLY: reading a comparison must not create the thing it reads.
    expect(existsSync(file)).toBe(false);
  });
});

describe('route-compare: a seeded ledger', () => {
  it('names both sides of every spawn and counts the agreements', async () => {
    const root = makeRoot('B');
    await seedLedger(root);
    const lines = seededLines(root);
    expect(lines.filter((e) => e.event === 'route.bound')).toHaveLength(5);
    expect(lines.filter((e) => e.event === 'usage.receipt')).toHaveLength(5);

    const printed = parseOne(runCli(['--cwd', root], root));

    expect(printed.binds).toBe(5);
    expect(printed.duplicate_binds).toBe(0);
    // A dropped bind shrinks the denominator and leaves the agreements alone,
    // so a non-zero value here means `agreement_rate` reads too HIGH or too LOW
    // over a population nobody can see.
    expect(printed.malformed_binds).toBe(0);
    expect(printed.receipts).toBe(5);
    // The main thread is not a spawn. Counting its receipt as a subagent's
    // would invent a pair with no bind on the other side.
    expect(printed.main_thread_receipts).toBe(1);
    expect(printed.subagent_receipts).toBe(4);
    expect(printed.malformed_receipts).toBe(0);
    // Both are premises of every count below, not incidental zeroes. A
    // `model_mismatch` means a row's two model spellings disagree, so "which
    // model served" would be a coin flip; a `duplicate_receipts` means a run
    // carried more receipts than distinct models, so its tokens are
    // double-counted. Either one non-zero and this seed is not what it claims.
    expect(printed.model_mismatch).toBe(0);
    expect(printed.duplicate_receipts).toBe(0);

    expect(printed.pairs).toHaveLength(4);
    // Every bind is either paired or unpaired — there is no third place for one
    // to go, and a fold that loses one would otherwise look like a clean run.
    expect(printed.pairs.length + printed.unjoined_binds).toBe(printed.binds);
    expect(printed.unjoined_binds).toBe(1);
    expect(printed.unjoined_receipts).toBe(0);

    expect(printed.compared).toBe(3);
    // A fifo bind is a GUESS about which receipt belongs to which spawn.
    // Comparing on a guess reports a divergence that may never have happened.
    expect(printed.excluded_fifo).toBe(1);
    expect(printed.excluded_no_recommendation).toBe(0);
    expect(printed.by_agreement).toEqual({ same: 2, diverged: 1 });
    expect(printed.agreement_rate).toBeCloseTo(2 / 3, 10);
    expect(printed.agreed_by_model).toEqual({ [OPUS]: 2 });
    expect(printed.multi_model_runs).toBe(0);
    expect(printed.score.source).toBeNull();
    expect(printed.score.value).toBeNull();

    expect(printed.census.file.present).toBe(true);
    expect(printed.census.survivors).toBe(10);
  });

  it('reports the divergence rather than averaging it away', async () => {
    const root = makeRoot('C');
    await seedLedger(root);

    const printed = parseOne(runCli(['--cwd', root], root));

    // The bucket KEYS belong to the fold's own suite; what this file pins is
    // that the buckets are the evidence for the headline count. A `divergence`
    // block that drifts from `by_agreement.diverged` is the number that would
    // be quoted to a human, and it would be wrong.
    //
    // EQUALITY HOLDS ONLY BECAUSE THIS SEED HAS NO MULTI-MODEL RUN. A run that
    // served two models emits one divergence entry per differing model, so the
    // general relation is `>=`, not `===`. The multi-model count is asserted
    // FIRST rather than the assertion being loosened to `>=`: a loose
    // assertion would stay green if the fold started double-counting a
    // single-model run, which is the failure this case exists to catch.
    expect(printed.multi_model_runs).toBe(0);
    const total = Object.values(printed.divergence).reduce((a, b) => a + b, 0);
    expect(total).toBe(printed.by_agreement.diverged);
    expect(total).toBe(1);
  });

  it('counts each pair once under the confidence its bind claimed', async () => {
    const root = makeRoot('L');
    await seedLedger(root);

    const printed = parseOne(runCli(['--cwd', root], root));

    // `by_confidence` describes the PAIRED population, not every bind: the
    // unjoined `sp5` bind is `exact` and is deliberately absent here, so
    // this case fails if the two populations are ever conflated.
    expect(printed.by_confidence).toEqual({
      exact: 2, name: 1, fifo: 1, other: 0,
    });
    const total = Object.values(printed.by_confidence).reduce((a, b) => a + b, 0);
    expect(total).toBe(printed.pairs.length);
  });

  it('attributes cost, tokens and latency to the side that earned them', async () => {
    const root = makeRoot('M');
    await seedLedger(root);

    const printed = parseOne(runCli(['--cwd', root], root));

    // `cost.compared` counts the PRICED compared pairs, which is why it is a
    // usable denominator for the totals beside it. It is not the top-level
    // `compared`; the two differ by `cost.unpriced`.
    expect(printed.cost.compared).toBe(3);
    // An unpriced row is indistinguishable downstream from a free attempt, so
    // a non-zero count here means the totals beside it are understated.
    expect(printed.cost.unpriced).toBe(0);
    expect(printed.cost.same.priced).toBe(2);
    expect(printed.cost.diverged.priced).toBe(1);
    expect(printed.cost.same.total).toBeGreaterThan(0);
    expect(printed.cost.diverged.total).toBeGreaterThan(0);
    // Token totals are kept PER FIELD, not summed into one number: cached
    // input and fresh input are priced differently, so a single "tokens" total
    // cannot be turned back into a bill by any reader.
    expect(printed.usage_totals.same).toEqual(usageOf(2));
    expect(printed.usage_totals.diverged).toEqual(usageOf(1));
    // A non-numeric token field is dropped from the totals; unseen, it reads as
    // a smaller bill rather than as a missing measurement.
    expect(printed.usage_totals.non_numeric).toBe(0);
    expect(printed.latency.same.count).toBe(2);
    expect(printed.latency.same.total_ms).toBe(2 * LATENCY_MS);
    expect(printed.latency.diverged.count).toBe(1);
    expect(printed.latency.diverged.total_ms).toBe(LATENCY_MS);
  });

  /**
   * The empty side of both sums, driven through the real writer.
   *
   * A SUM OVER ZERO ROWS IS UNMEASURED, AND `0` READS AS A MEASURED FLOOR.
   * Measured on the live run at 2026-09-21T01:31:59Z, an earlier shape printed
   * a diverged cost total of 0 while every diverged pair was UNPRICED — the
   * line said "these divergences were free" when it meant "nobody priced
   * them". The case above can never catch that: every one of its pairs is
   * priced and both sides are populated, so the null branch is only reachable
   * from a ledger shaped like this one.
   */
  it('nulls a total it has no rows to sum, on both cost and latency', async () => {
    const root = makeRoot('N');
    // One diverged pair and nothing else: the agreeing side is empty, and the
    // one pair is UNPRICED, so the diverged side has no priced row to sum
    // either. `priceReceipts: false` is the writer's own opt-out, so the row
    // still passes the receipt schema — this is an unpriced receipt as the
    // production builder makes one, not a hand-broken fixture.
    await seedReceipts(root, SESSION, { sp9: FABLE }, OPUS, { priced: false });
    seedBind(root, SESSION, 'sp9', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
    });
    expect(seededLines(root)).toHaveLength(3);

    const printed = parseOne(runCli(['--cwd', root], root));

    expect(printed.compared).toBe(1);
    expect(printed.by_agreement).toEqual({ same: 0, diverged: 1 });
    // The divergence HAPPENED and is counted; only its price is unknown.
    expect(printed.cost.unpriced).toBe(1);
    expect(printed.cost.compared).toBe(0);
    expect(printed.cost.diverged.priced).toBe(0);
    expect(printed.cost.diverged.total).toBeNull();
    expect(printed.cost.diverged.total).not.toBe(0);
    expect(printed.cost.same.priced).toBe(0);
    expect(printed.cost.same.total).toBeNull();
    expect(printed.cost.same.total).not.toBe(0);
    // The same rule on latency: no agreeing pair means no elapsed time to
    // report, which is not the same statement as an instantaneous run.
    expect(printed.latency.same.count).toBe(0);
    expect(printed.latency.same.total_ms).toBeNull();
    expect(printed.latency.same.total_ms).not.toBe(0);
    expect(printed.latency.diverged.count).toBe(1);
    expect(printed.latency.diverged.total_ms).toBe(LATENCY_MS);
    expect(Object.keys(printed)).toEqual(STDOUT_KEYS);
  });

  it('leaves the ledger byte-for-byte the same length', async () => {
    const root = makeRoot('D');
    await seedLedger(root);
    const file = ledgerFilePath(root);
    const before = statSync(file).size;

    runCli(['--cwd', root], root);

    // The read-only contract, measured on the filesystem rather than inferred
    // from which modules the script imports.
    expect(statSync(file).size).toBe(before);
  });

  it('prints one line of JSON with the fixed key set in order', async () => {
    const root = makeRoot('E');
    await seedLedger(root);

    const out = runCli(['--cwd', root], root);

    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    // Not pretty-printed: a newline inside the object would make the "one line"
    // promise false for every downstream parser.
    expect(out.stdout.trimEnd()).not.toContain('\n');
    const printed = JSON.parse(out.stdout);
    expect(Object.keys(printed)).toEqual(STDOUT_KEYS);
    expect(Number.isFinite(Date.parse(printed.measured_at))).toBe(true);
  });

  it('defaults --cwd to the process cwd', async () => {
    const root = makeRoot('F');
    await seedLedger(root);

    // No --cwd: the child's own cwd is the root. This is the global-install
    // trap from the module header, exercised in its intended direction.
    const printed = parseOne(runCli([], root));

    expect(printed.binds).toBe(5);
    expect(printed.ledger_path).toBe(ledgerFilePath(root));
  });
});

describe('route-compare: --since', () => {
  it('excludes rows written before the cutoff and says so in the census', () => {
    const root = makeRoot('G');
    seedBind(root, SESSION, 'old1', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
      now: () => new Date('2026-09-01T00:00:00Z'),
    });
    seedBind(root, SESSION, 'new2', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
      now: () => new Date('2026-09-13T00:00:00Z'),
    });

    const all = parseOne(runCli(['--cwd', root], root));
    const recent = parseOne(runCli(['--cwd', root, '--since', '2026-09-10T00:00:00Z'], root));

    expect(all.binds).toBe(2);
    expect(all.since).toBeNull();
    expect(recent.binds).toBe(1);
    // The cutoff is echoed as the RESOLVED instant, so a reader never has to
    // re-parse the argument to know what was actually cut at.
    expect(recent.since).toBe('2026-09-10T00:00:00.000Z');
    // A filtered row is SELECTION, not loss: a rate built from survivors alone
    // cannot tell the two apart.
    expect(recent.census.dropped.selection.filtered_out).toBe(1);
    expect(recent.census.dropped_total.loss).toBe(0);
  });

  it('accepts epoch milliseconds and cuts at the same instant as the ISO form', () => {
    const root = makeRoot('H');
    seedBind(root, SESSION, 'old1', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
      now: () => new Date('2026-09-01T00:00:00Z'),
    });
    seedBind(root, SESSION, 'new2', {
      confidence: 'exact', method: 'prompt_id+name', recommended: OPUS,
      now: () => new Date('2026-09-13T00:00:00Z'),
    });

    const iso = parseOne(runCli(['--cwd', root, '--since', '2026-09-10T00:00:00Z'], root));
    const epoch = parseOne(runCli([
      '--cwd', root, '--since', String(Date.parse('2026-09-10T00:00:00Z')),
    ], root));

    // Date.parse reads an all-digit string as something other than a stamp, so
    // this case is the one that catches a regression to a bare Date.parse.
    expect(epoch.since).toBe(iso.since);
    expect(epoch.since).toBe('2026-09-10T00:00:00.000Z');
    expect(epoch.binds).toBe(1);
    expect(epoch.binds).toBe(iso.binds);
  });
});

describe('route-compare: what it refuses to answer', () => {
  it.each([
    ['an unknown flag is passed', ['--oops']],
    ['a flag has no value', ['--cwd']],
    ['--since has no value', ['--since']],
    ['--since does not parse to a time', ['--since', 'nonsense']],
    ['--since is empty', ['--since', '   ']],
  ])('exits 2 with an empty stdout when %s', (_label, args) => {
    const root = makeRoot('I');

    const out = runCli(args, root);

    // A malformed request is not an observation. Exiting 0 here would report a
    // measurement that was never taken, so a typo could read as success.
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.startsWith('route-compare:')).toBe(true);
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  });

  it('still exits 0 when the ledger path is not a readable file', () => {
    const root = makeRoot('J');
    // A DIRECTORY where the ledger file belongs: present, not readable as text.
    mkdirSync(ledgerFilePath(root), { recursive: true });

    const printed = parseOne(runCli(['--cwd', root], root));

    // "The ledger cannot be read" is a finding about the project, not a failure
    // of this script — and the JSON is what says which of the two it was.
    expect(printed.census.file.present).toBe(true);
    expect(printed.census.file.readable).toBe(false);
    expect(printed.binds).toBe(0);
    expect(printed.receipts).toBe(0);
    expect(printed.agreement_rate).toBeNull();
    // The reader swallows an unreadable path and reports it in the census, so
    // this branch is NOT the `error` branch: `error` is reserved for a throw
    // that escaped the reader. A test that expected `error` here would be
    // asserting a shape this repo's reader never produces.
    expect(printed.error).toBeUndefined();
    expect(Object.keys(printed)).toEqual(STDOUT_KEYS);
  });
});

describe('route-compare: the read-only contract, in the source', () => {
  it('reaches the ledger through the census reader and nothing else', () => {
    const src = readFileSync(CLI, 'utf-8');

    // Enforced by what is NOT imported: a measuring tool that appends to the
    // stream it measures is its own next data point. The byte-length case above
    // only covers the paths these seeds take; this covers every path.
    expect(src).not.toContain('appendLedger' + 'Event');
    expect(src).not.toContain('write' + 'Event');
    expect(src).toContain("from '../../lib/runtime/ledger.js'");
    expect(src.match(/from '\.\.\/\.\.\/lib\/runtime\/ledger\.js'/g)).toHaveLength(1);
    expect(src).toContain('readLedgerCensus');
    // The direct-run guard is the one entry-point spelling the repo allows
    // (tests/ci/direct-run-guard.test.js); a raw argv[1] compare goes silent
    // under a junction or a non-ASCII path, which is fail-open in the quietest
    // possible way.
    expect(src).toContain('isMainEntry(import.meta.url)');
  });

  /**
   * The error branch's shape, checked against the real thing.
   *
   * `emptyJoin()` DUPLICATES the join's empty result instead of calling it,
   * and that is deliberate: a failure to load the join module is one of the
   * things that reaches the error branch, so the branch may not depend on it.
   * Duplication that nothing checks is drift waiting to happen — a field added
   * to the fold would appear on every successful line and be missing from every
   * error line, which is precisely the "branch on which keys exist" failure the
   * fixed key set exists to prevent. This case is the outside check that makes
   * the duplication safe.
   *
   * Order is compared at EVERY level, not just membership: the stdout promise
   * is a fixed line shape, and two objects with the same keys in a different
   * order serialize to different lines.
   */
  it('builds its error-branch shape identically to the real empty join', async () => {
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);
    const real = joinSpawnOutcomes([]);

    // Values first: every empty value must match too, so a 0 where the fold
    // says null (the misreading this whole tool guards against) fails here.
    expect(mod.emptyJoin()).toEqual(real);
    // Then key order, recursively, which toEqual does not check.
    expect(keyShape(mod.emptyJoin())).toEqual(keyShape(real));
    // Named explicitly because an array and an object with numeric keys have
    // the same shape under a careless walk.
    expect(Array.isArray(mod.emptyJoin().pairs)).toBe(true);
    expect(mod.emptyJoin().pairs).toEqual([]);
    expect(real.pairs).toEqual([]);
  });

  it('exposes main and writes nothing when imported rather than run', async () => {
    const root = makeRoot('K');
    const file = ledgerFilePath(root);

    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);

    expect(typeof mod.main).toBe('function');
    expect(existsSync(file)).toBe(false);
  });
});
