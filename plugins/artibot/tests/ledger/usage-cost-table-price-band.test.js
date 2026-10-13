/**
 * Real-process contract for the PRICE-BAND line of `scripts/ledger/usage-cost-table.mjs`.
 *
 * One catalog model is priced by prompt length (Claude Haiku 5.5: a request whose
 * prompt is over `maxPromptTokens` pays a second, higher list), the catalog stores
 * only the lower list, and `buildUsageReceipts` COUNTS the requests over the boundary
 * in `meta.overPriceBandRequests` without re-pricing them. Before this line existed
 * no table printed that count (`git grep -F overPriceBandRequests` matched only `lib/`
 * and `tests/`, measured 2026-10-12), so a haiku cost that could be up to 5x too low
 * read like any other figure.
 *
 * WHAT IS PINNED
 *  - A `--live-session` read prints how many of the CURRENT session's requests were
 *    over a model's price band: `N건` in the markdown under the table, a measured
 *    `0건` when there were none, and `live.over_price_band_requests` in the JSON. Only
 *    a model whose catalog row has a band is counted: a sonnet request with a longer
 *    prompt is not.
 *  - The table is NOT re-priced: the haiku row still costs what the lower list says.
 *  - A table that read no transcript prints NO such line, and a live read that never
 *    reached a transcript says `null` in the JSON. The count is not in a ledger
 *    receipt, so a `0` there would be a claim nobody measured.
 *  - A live read that came back partial adds nothing to the table, so it adds no line.
 *
 * WHY A FILE OF ITS OWN. `tests/ledger/usage-cost-table-cli.test.js` is at the repo's
 * 800-line standard (799 lines when this file was written). The helpers below are
 * copies of that file's, trimmed to what these cases need.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. THAT A COUNTED REQUEST WAS BILLED AT THE HIGHER LIST. The boundary and the 5x
 *     factor come from the official pricing page as read on 2026-10-12 (see
 *     `tests/core/model-catalog-price-band.test.js`); the transcripts here are
 *     synthesized and carry no cost field to compare with.
 *  2. A REAL HOST TRANSCRIPT. Same limit as `usage-cost-table-cli.test.js`.
 *  3. LEDGER ROWS. They carry no count, so the ledger-only case pins that nothing is
 *     printed, not that anything is right. When a receipt starts to carry the count,
 *     that case is the one that should go red.
 *
 * @module tests/ledger/usage-cost-table-price-band
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPricing, MODELS } from '../../lib/core/model-catalog.js';
import { buildUsageReceipts } from '../../lib/economics/usage-receipt.js';
import { toUsageReceiptEnvelopes } from '../../lib/economics/receipt-envelope.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';

// This file spawns child processes; the budget buys headroom for load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'usage-cost-table.mjs');

const OPUS = MODELS.opus.id;
const SONNET = MODELS.sonnet.id;
const HAIKU = MODELS.haiku.id;

/** The hooks blank BOTH spellings; so does every child here. */
const NO_SESSION_ENV = { CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };

const T0 = '2026-10-13T06:00:00.000Z';
const LIVE_SESSION = 'sessBandLive01';
const LEDGER_SESSION = 'sessBandLedger01';

/**
 * The fixture's request sizes. One fixture request carries `120 n` fresh input,
 * `4000 n` cache-read and `800 n` cache-write tokens, and the prompt of a request is
 * those three together (the pricing page's definition), so `4920 n`.
 */
const BAND = getPricing(HAIKU).maxPromptTokens;
const promptOf = (n) => (120 + 4000 + 800) * n;
const OVER_N = 21; // 103,320 tokens: over the haiku band
const INSIDE_N = 20; //  98,400 tokens: inside it
const BIG_N = 30; // 147,600 tokens: longer than the haiku band, on a model that has none

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-band-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

/** A project root the Artibot guards will actually run inside. */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** Run the CLI inside a project root, with both host session spellings blanked. */
function runCli(args, root) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env, ...NO_SESSION_ENV },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** `--json` output: one line, parsed, with the stream discipline checked first. */
function parseJson(out) {
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  expect(out.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(out.stdout);
}

/** Per-run tokens for a run of scale `n` (two transcript entries per run). */
const perRun = (n) => ({ fresh: 240 * n, cached: 8000 * n, write: 1600 * n, output: 90 * n });

const sumUsage = (...runs) => runs.reduce((acc, r) => ({
  fresh: acc.fresh + r.fresh, cached: acc.cached + r.cached, write: acc.write + r.write, output: acc.output + r.output,
}), { fresh: 0, cached: 0, write: 0, output: 0 });

/** The formula, spelled out - an oracle independent of the code under test. */
function oracleUsd(model, u) {
  const p = getPricing(model);
  return (u.fresh * p.input) / 1e6 + (u.cached * p.cacheRead) / 1e6
    + (u.write * p.cacheWrite5m) / 1e6 + (u.output * p.output) / 1e6;
}

const rowOf = (printed, model) => printed.rows.find((r) => r.model_id === model);

/** One assistant transcript entry. */
function entry(requestId, timestamp, model, n) {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp,
    effort: 'high',
    message: {
      model,
      role: 'assistant',
      usage: {
        input_tokens: 120 * n,
        cache_read_input_tokens: 4000 * n,
        cache_creation_input_tokens: 800 * n,
        output_tokens: 45 * n,
        output_tokens_details: { thinking_tokens: 12 },
      },
    },
  });
}

/** Two requests for one run, 60 seconds apart, both billed to `model` at scale `n`. */
function transcriptBody(stem, model, t0, n) {
  const t1 = new Date(Date.parse(t0) + 60_000).toISOString();
  return [entry(`${stem}-a`, t0, model, n), entry(`${stem}-b`, t1, model, n)].join('\n');
}

/** Write a fake projects tree holding one live session and its subagents. */
function writeLiveSession(sessionId, { main, agents = {} }) {
  const projects = path.join(tmp, 'projects');
  const slug = path.join(projects, 'C--fake-slug');
  mkdirSync(path.join(slug, sessionId, 'subagents'), { recursive: true });
  writeFileSync(path.join(slug, `${sessionId}.jsonl`), `${transcriptBody(sessionId, main.model, T0, main.n)}\n`, 'utf-8');
  for (const [id, spec] of Object.entries(agents)) {
    writeFileSync(
      path.join(slug, sessionId, 'subagents', `agent-${id}.jsonl`),
      `${transcriptBody(id, spec.model, T0, spec.n)}\n`,
      'utf-8',
    );
  }
  return projects;
}

/** A DIRECTORY where a subagent `.jsonl` should be: found by name, unreadable as a file. */
function breakSubagentTranscript(projects, sessionId) {
  mkdirSync(path.join(projects, 'C--fake-slug', sessionId, 'subagents', 'agent-unreadable.jsonl'), { recursive: true });
}

/**
 * The live session with TWO requests over the haiku band (one haiku run at
 * `OVER_N`, two requests), one haiku run inside it, and a long-prompt sonnet run
 * that has no band to be over.
 */
const overBandSession = () => writeLiveSession(LIVE_SESSION, {
  main: { model: OPUS, n: 1 },
  agents: {
    hkOver: { model: HAIKU, n: OVER_N },
    hkInside: { model: HAIKU, n: INSIDE_N },
    soBig: { model: SONNET, n: BIG_N },
  },
});

/** The same session without the over-band run: nothing in it is over a band. */
const inBandSession = () => writeLiveSession(LIVE_SESSION, {
  main: { model: OPUS, n: 1 },
  agents: {
    hkInside: { model: HAIKU, n: INSIDE_N },
    soBig: { model: SONNET, n: BIG_N },
  },
});

const liveArgs = (root, projects) => ['--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION];

/** The price-band line of a markdown table, or undefined. */
const bandLine = (md) => md.split('\n').find((l) => l.startsWith('- 가격 구간 초과 요청:'));

describe('usage-cost-table price band: the fixture', () => {
  it('straddles the haiku band, and the model that has no band has no band', () => {
    // If the catalog moves the boundary, resize the fixture rather than the assertions.
    expect(Number.isInteger(BAND)).toBe(true);
    expect(promptOf(OVER_N)).toBeGreaterThan(BAND);
    expect(promptOf(INSIDE_N)).toBeLessThanOrEqual(BAND);
    expect(getPricing(SONNET).maxPromptTokens).toBeNull();
    expect(promptOf(BIG_N)).toBeGreaterThan(BAND);
  });
});

describe('usage-cost-table price band: a live read counts the current session', () => {
  it('prints the over-band count in the JSON, and does not re-price the haiku row', () => {
    const root = makeRoot('B');
    const printed = parseJson(runCli([...liveArgs(root, overBandSession()), '--json'], root));

    expect(printed.live.status).toBe('ok');
    // Two requests of the one over-band run; nothing else is over a band.
    expect(printed.live.over_price_band_requests).toBe(2);
    // Priced at the lower list throughout: the count is a warning, not a correction.
    const haiku = rowOf(printed, HAIKU);
    expect(haiku.spawns).toBe(2);
    expect(haiku.cost.usd).toBeCloseTo(oracleUsd(HAIKU, sumUsage(perRun(OVER_N), perRun(INSIDE_N))), 9);
  });

  it('prints the count under the table, says what it covers and that the model cost is a floor', () => {
    const root = makeRoot('B');
    const md = runCli(liveArgs(root, overBandSession()), root).stdout;
    const all = md.trimEnd().split('\n');
    const line = bandLine(md);

    expect(line).toBeDefined();
    expect(line).toContain('2건');
    expect(line).toContain('현재 세션 transcript');
    expect(line).toContain('저장하지 않는다');
    expect(line).toContain('하한');
    // After the table, before the limit line that always closes the block.
    expect(all.indexOf(line)).toBeGreaterThan(all.findIndex((l) => l.includes('**합계**')));
    expect(all.at(-1)).toMatch(/^- 한계:/);
  });

  it('prints a measured zero as 0건, without claiming a floor', () => {
    const root = makeRoot('B');
    const projects = inBandSession();

    const printed = parseJson(runCli([...liveArgs(root, projects), '--json'], root));
    expect(printed.live.status).toBe('ok');
    expect(printed.live.over_price_band_requests).toBe(0);
    expect(printed.live.over_price_band_requests).not.toBeNull();

    const line = bandLine(runCli(liveArgs(root, projects), root).stdout);
    expect(line).toBeDefined();
    expect(line).toContain('0건');
    expect(line).toContain('현재 세션 transcript');
    expect(line).not.toContain('하한');
  });
});

describe('usage-cost-table price band: what is not counted is not printed as zero', () => {
  /** A ledger that DOES hold a would-be over-band haiku run, written through the real writer. */
  async function seedOverBandLedger(root) {
    const dir = '/fixture/projects/slug';
    const transcriptPath = `${dir}/${LEDGER_SESSION}.jsonl`;
    const body = transcriptBody(LEDGER_SESSION, HAIKU, T0, OVER_N);
    const { receipts, meta } = await buildUsageReceipts({
      transcriptPath,
      missionId: sessionFallbackMissionId(LEDGER_SESSION, '2026-10-13T00:00:00.000Z'),
      readTranscript: (p) => {
        if (p !== transcriptPath) throw new Error(`ENOENT ${p}`);
        return body;
      },
      listSubagentTranscripts: () => [],
    });
    // The builder saw them - and the receipt it hands the writer has nowhere to keep them.
    expect(meta.overPriceBandRequests).toBe(2);
    expect(receipts).toHaveLength(1);
    for (const envelope of toUsageReceiptEnvelopes(receipts, { sessionId: LEDGER_SESSION })) {
      expect(appendLedgerEvent(root, envelope).ok).toBe(true);
    }
  }

  it('prints no price-band line for a ledger-only table, even when the ledger holds an over-band run', async () => {
    const root = makeRoot('L');
    await seedOverBandLedger(root);

    const printed = parseJson(runCli(['--cwd', root, '--json'], root));
    expect(printed.live).toBeNull();
    expect(rowOf(printed, HAIKU)).toBeDefined(); // the over-band run IS in the table

    const md = runCli(['--cwd', root], root).stdout;
    expect(md).toContain(HAIKU);
    expect(md).not.toContain('가격 구간 초과');
  });

  it('says null - not 0 - when the live read never reached a transcript, and prints no line', () => {
    const root = makeRoot('N');
    const projects = overBandSession();
    const args = ['--cwd', root, '--projects-dir', projects, '--live-session', 'sessBandMissing'];

    const printed = parseJson(runCli([...args, '--json'], root));
    expect(printed.live.status).toBe('not-found');
    expect(printed.live.over_price_band_requests).toBeNull();
    expect(bandLine(runCli(args, root).stdout)).toBeUndefined();
  });

  it('prints no line for a partial live read, whose receipts are not in the table', () => {
    const root = makeRoot('P');
    const projects = overBandSession();
    breakSubagentTranscript(projects, LIVE_SESSION);
    const args = liveArgs(root, projects);

    const printed = parseJson(runCli([...args, '--json'], root));
    expect(printed.live.status).toBe('incomplete');
    // Like `live.receipts`: what the readable part yielded, and was NOT used.
    expect(printed.live.over_price_band_requests).toBe(2);
    expect(printed.rows).toEqual([]);

    const md = runCli(args, root).stdout;
    expect(md).toContain('live 판독 불완전');
    expect(md).not.toContain('가격 구간 초과');
  });

  it('keeps the JSON top-level key set: the count lives inside `live`', () => {
    const root = makeRoot('K');
    const printed = parseJson(runCli([...liveArgs(root, overBandSession()), '--json'], root));

    expect(Object.keys(printed)).toEqual([
      'event', 'measured_at', 'ledger_path', 'filter', 'live',
      'receipts', 'rows', 'total', 'by_kind', 'pricing', 'census',
    ]);
    expect(Object.keys(printed.live)).toContain('over_price_band_requests');
  });
});
