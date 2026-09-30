/**
 * Real-process contract for `scripts/ledger/usage-cost-table.mjs` — the CLI that
 * prints the per-model usage and cost table a leader attaches to a completion
 * report.
 *
 * WHY THE CASES SPAWN A PROCESS AND SEED A REAL LEDGER. The arithmetic lives in
 * `lib/economics/usage-table.js` and has its own pure suite, which proves the
 * fold counts a given ARRAY. It proves nothing about whether rows of that shape
 * survive the ledger writer's allowlist, envelope and byte cap on the way in: a
 * `data` shape the writer refuses lands as `ledger.rejected` and is excluded
 * from every read, so a green fold suite and an empty table are compatible. The
 * seeded cases therefore write through the real writer (receipts built by the
 * real receipt builder with injected transcript ports) and spawn the real script
 * against the file, and the first seeded case asserts ZERO `ledger.rejected`.
 *
 * THE TWO READ PATHS. The table reads (1) the central ledger, which holds only
 * what SessionEnd wrote, and (2) with `--live-session`, the current session's
 * own transcript, which SessionEnd has NOT written yet. Path 2 exists because
 * the ledger cannot describe the session that is producing the report — the
 * live ledger held 0 `usage.receipt` rows for the running session while it had
 * 342 rows of other events (2026-09-30T02:17Z). The cases below pin that a
 * session read live REPLACES its own ledger rows and never adds to them — and
 * that a live read which could not open every transcript file replaces NOTHING
 * (measured on a copy of the real ledger, 2026-09-30: a 21-of-22-file read
 * replaced 22 ledger rows and printed $84.07 where the ledger said $87.28).
 *
 * READ-ONLY IS ASSERTED, NOT ASSUMED: an empty root must still have no ledger
 * file afterwards, a seeded root's ledger must have the same byte length before
 * and after, and the source text must not import the ledger's append function.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *  Every case builds its own `mkdtempSync` root and uses it as BOTH the child
 *  cwd and `--cwd`. The child env blanks BOTH session-id spellings: this CLI
 *  reads no environment variable, but a future env fallback would otherwise
 *  bind the host's live session id into a case (the leak that
 *  `tests/ledger/record-verify.test.js` records).
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - THE LIVE LEDGER. Rows here are seeded; nothing says what a real ledger of
 *    50,000 lines prints or how long it takes.
 *  - A REAL CLAUDE CODE TRANSCRIPT. The `--live-session` cases read transcripts
 *    written by this file in the shape measured 2026-09-02; a host that changes
 *    the layout is `usage-receipt.js`'s to detect (`meta.parseFailures`).
 *  - WHETHER THE HOST'S SESSION ID EQUALS THE TRANSCRIPT STEM. The locator
 *    matches `<projects>/*` + `/<id>.jsonl`; the mapping is measured, not
 *    guaranteed.
 *  - HOW A REAL HOST MAKES A TRANSCRIPT FILE UNREADABLE. The partial-read cases
 *    put a DIRECTORY where a `.jsonl` file should be: same counter
 *    (`meta.unreadableFiles`), same catch, but no sharing violation or torn write
 *    — and a torn LINE inside a readable file is skipped with no counter at all.
 *
 * @module tests/ledger/usage-cost-table-cli
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPricing, MODELS } from '../../lib/core/model-catalog.js';
import { buildUsageReceipts } from '../../lib/economics/usage-receipt.js';
import { toUsageReceiptEnvelopes } from '../../lib/economics/receipt-envelope.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { ledgerFilePath, sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';

// This file spawns child processes; the budget buys headroom for load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'usage-cost-table.mjs');

const OPUS = MODELS.opus.id;
const OPUS_OLD = MODELS.opus.legacyIds[0];
const SONNET = MODELS.sonnet.id;
const HAIKU = MODELS.haiku.id;

/** The exact key set, IN ORDER, that `--json` promises a caller can parse blind. */
const JSON_KEYS = [
  'event', 'measured_at', 'ledger_path', 'filter', 'live',
  'receipts', 'rows', 'total', 'by_kind', 'pricing', 'census',
];

const NEW_T0 = '2026-09-28T06:00:00.000Z';
const OLD_T0 = '2026-09-13T06:00:00.000Z';
const SINCE_MID = '2026-09-20T00:00:00.000Z';

/** The hooks blank BOTH spellings; so does every child here. */
const NO_SESSION_ENV = { CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-usg-')));
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

/** Per-run tokens for a seeded run of scale `n` (two transcript entries per run). */
const perRun = (n) => ({ fresh: 240 * n, cached: 8000 * n, write: 1600 * n, output: 90 * n });

/** One assistant transcript entry in the shape measured 2026-09-02. */
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

/** Two entries for one run, 60 seconds apart, both billed to `model`. */
function transcriptBody(stem, model, t0, n) {
  const t1 = new Date(Date.parse(t0) + 60_000).toISOString();
  return [entry(`${stem}-a`, t0, model, n), entry(`${stem}-b`, t1, model, n)].join('\n');
}

/**
 * Build the receipts of one session through the REAL builder with injected
 * transcript ports (no file is read), so they are exactly what SessionEnd would
 * hand the writer.
 */
async function buildSession(sessionId, { main, agents = {}, t0 }) {
  const dir = '/fixture/projects/slug';
  const transcriptPath = `${dir}/${sessionId}.jsonl`;
  const fileFor = (id) => `${dir}/${sessionId}/subagents/agent-${id}.jsonl`;
  const bodies = new Map([[transcriptPath, transcriptBody(sessionId, main.model, t0, main.n)]]);
  for (const [id, spec] of Object.entries(agents)) {
    bodies.set(fileFor(id), transcriptBody(id, spec.model, t0, spec.n));
  }
  const { receipts } = await buildUsageReceipts({
    transcriptPath,
    missionId: sessionFallbackMissionId(sessionId, '2026-09-13T00:00:00.000Z'),
    readTranscript: (p) => {
      const body = bodies.get(p);
      if (body === undefined) throw new Error(`ENOENT ${p}`);
      return body;
    },
    listSubagentTranscripts: () => Object.keys(agents).map(fileFor),
  });
  return receipts;
}

/** Append one session's receipts to a project's ledger through the real writer. */
async function seedSession(root, sessionId, spec) {
  const receipts = await buildSession(sessionId, spec);
  const expected = 1 + Object.keys(spec.agents ?? {}).length;
  expect(receipts).toHaveLength(expected);
  for (const envelope of toUsageReceiptEnvelopes(receipts, { sessionId })) {
    expect(appendLedgerEvent(root, envelope).ok).toBe(true);
  }
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

const NEW_SESSION = 'sessTableNew01';
const OLD_SESSION = 'sessTableOld01';

/**
 * Two sessions, arranged so no column is non-zero by accident:
 *   NEW  main  opus (n=1) · sp1 sonnet (n=2) · sp2 sonnet (n=3) · sp3 haiku (n=1)
 *   OLD  main  legacy opus (n=1) · sp4 sonnet (n=1)                    [15 days earlier]
 */
async function seedLedger(root) {
  await seedSession(root, NEW_SESSION, {
    main: { model: OPUS, n: 1 },
    agents: { sp1: { model: SONNET, n: 2 }, sp2: { model: SONNET, n: 3 }, sp3: { model: HAIKU, n: 1 } },
    t0: NEW_T0,
  });
  await seedSession(root, OLD_SESSION, {
    main: { model: OPUS_OLD, n: 1 },
    agents: { sp4: { model: SONNET, n: 1 } },
    t0: OLD_T0,
  });
}

/** The formula, spelled out — an oracle independent of the code under test. */
function oracleUsd(model, u) {
  const p = getPricing(model);
  return (u.fresh * p.input) / 1e6 + (u.cached * p.cacheRead) / 1e6
    + (u.write * p.cacheWrite5m) / 1e6 + (u.output * p.output) / 1e6;
}

const sumUsage = (...runs) => runs.reduce((acc, r) => ({
  fresh: acc.fresh + r.fresh, cached: acc.cached + r.cached, write: acc.write + r.write, output: acc.output + r.output,
}), { fresh: 0, cached: 0, write: 0, output: 0 });

const rowOf = (printed, model) => printed.rows.find((r) => r.model_id === model);

describe('usage-cost-table: a project with no ledger', () => {
  it('prints 영수증 0행 — not a table of zeros — and creates no file', () => {
    const root = makeRoot('A');
    const file = ledgerFilePath(root);
    expect(existsSync(file)).toBe(false);

    const out = runCli(['--cwd', root], root);

    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('영수증 0행');
    expect(out.stdout).toContain('원장 파일이 없다');
    expect(out.stdout).toContain(file);
    expect(out.stdout).not.toContain('| 모델 |');
    expect(out.stdout).not.toContain('$0');
    expect(out.stdout).toMatch(/한계: .*SessionEnd/);
    // READ-ONLY: reading a table must not create the thing it reads.
    expect(existsSync(file)).toBe(false);
  });

  it('prints the same finding as JSON: rows [], total null — never 0', () => {
    const root = makeRoot('A');
    const printed = parseJson(runCli(['--cwd', root, '--json'], root));

    expect(Object.keys(printed)).toEqual(JSON_KEYS);
    expect(printed.event).toBe('usage.receipt');
    expect(printed.rows).toEqual([]);
    expect(printed.total).toBeNull();
    expect(printed.total).not.toBe(0);
    expect(printed.receipts.counted).toBe(0);
    expect(printed.census.file.present).toBe(false);
    expect(printed.census.file.readable).toBe(false);
    expect(printed.ledger_path).toBe(ledgerFilePath(root));
    expect(printed.live).toBeNull();
    expect(printed.by_kind.main.usd).toBeNull();
  });
});

describe('usage-cost-table: a seeded ledger', () => {
  it('seeds through the real writer with zero rejections', async () => {
    const root = makeRoot('B');
    await seedLedger(root);
    const lines = ledgerLines(root);
    expect(lines.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
    expect(lines.filter((e) => e.event === 'usage.receipt')).toHaveLength(6);
  });

  it('folds one row per serving model, with legacy ids kept apart', async () => {
    const root = makeRoot('B');
    await seedLedger(root);

    const printed = parseJson(runCli(['--cwd', root, '--json'], root));

    expect(printed.receipts.seen).toBe(6);
    expect(printed.receipts.counted).toBe(6);
    expect(printed.rows.map((r) => r.model_id)).toEqual([HAIKU, OPUS_OLD, OPUS, SONNET]);

    const sonnet = rowOf(printed, SONNET);
    const sonnetUsage = sumUsage(perRun(2), perRun(3), perRun(1));
    expect(sonnet.usage.fresh_input_tokens).toBe(sonnetUsage.fresh);
    expect(sonnet.usage.cached_input_tokens).toBe(sonnetUsage.cached);
    expect(sonnet.usage.cache_creation_tokens).toBe(sonnetUsage.write);
    expect(sonnet.usage.output_tokens).toBe(sonnetUsage.output);
    expect(sonnet.sessions).toBe(2);
    expect(sonnet.spawns).toBe(3);
    expect(sonnet.cost.usd).toBeCloseTo(oracleUsd(SONNET, sonnetUsage), 9);

    const old = rowOf(printed, OPUS_OLD);
    expect(old.id_status).toBe('legacy');
    expect(old.tier).toBe('opus');
    expect(old.main_receipts).toBe(1);
    expect(old.cost.usd).toBeCloseTo(oracleUsd(OPUS_OLD, perRun(1)), 9);

    expect(printed.total.sessions).toBe(2);
    expect(printed.total.spawns).toBe(4);
    expect(printed.total.receipts).toBe(6);
    expect(printed.total.cost.price_status).toBe('verified');
    expect(printed.pricing.source).toBe('platform.claude.com/docs/en/about-claude/pricing');
  });

  it('prints the markdown table a leader pastes, with the source, the unit prices and the limit', async () => {
    const root = makeRoot('B');
    await seedLedger(root);

    const out = runCli(['--cwd', root], root);

    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(out.stdout.endsWith('\n')).toBe(true);
    expect(out.stdout).toContain('영수증 6행');
    expect(out.stdout).toContain('| 모델 | 세션 | 스폰 | 입력 | 출력 | 캐시 읽기 | 캐시 쓰기 | 비용(USD) |');
    for (const model of [HAIKU, OPUS, SONNET]) expect(out.stdout).toContain(model);
    expect(out.stdout).toContain(`${OPUS_OLD} [legacy]`);
    expect(out.stdout).toContain('**합계**');
    expect(out.stdout).toContain('platform.claude.com/docs/en/about-claude/pricing');
    expect(out.stdout).toMatch(/카탈로그 기준일 \d{4}-\d{2}-\d{2}/);
    expect(out.stdout).toMatch(/한계: .*SessionEnd/);
    expect(out.stdout).toContain(ledgerFilePath(root));
  });

  it('does not change the ledger it reads', async () => {
    const root = makeRoot('B');
    await seedLedger(root);
    const file = ledgerFilePath(root);
    const before = statSync(file).size;

    runCli(['--cwd', root], root);
    runCli(['--cwd', root, '--json'], root);

    expect(statSync(file).size).toBe(before);
  });

  it('agrees with a ledger that is read from a copy, named by --ledger, from an unrelated cwd', async () => {
    const root = makeRoot('B');
    await seedLedger(root);
    const copyDir = path.join(tmp, 'copy');
    mkdirSync(copyDir, { recursive: true });
    const copy = path.join(copyDir, 'ledger-copy.jsonl');
    copyFileSync(ledgerFilePath(root), copy);

    const elsewhere = makeRoot('elsewhere');
    const viaCwd = parseJson(runCli(['--cwd', root, '--json'], root));
    const viaFile = parseJson(runCli(['--ledger', copy, '--json'], elsewhere));

    expect(viaFile.ledger_path).toBe(copy);
    expect(viaFile.rows).toEqual(viaCwd.rows);
    expect(viaFile.total).toEqual(viaCwd.total);
    // The unrelated cwd got no ledger of its own from this.
    expect(existsSync(ledgerFilePath(elsewhere))).toBe(false);
  });

  it('reports a ledger path it cannot read as a finding, exit 0', () => {
    const root = makeRoot('B');
    const dir = path.join(tmp, 'a-directory');
    mkdirSync(dir, { recursive: true });

    const out = runCli(['--ledger', dir], root);

    expect(out.status).toBe(0);
    expect(out.stdout).toContain('영수증 0행');
    expect(out.stdout).toContain('원장을 읽지 못했다');
  });
});

describe('usage-cost-table: ledger lines that cannot be read', () => {
  /**
   * Two lines the reader cannot parse, appended after the seeded rows. The second
   * is what a torn write looks like: it names `usage.receipt` and stops mid-object,
   * so nothing can say whether it was a receipt.
   */
  function appendUnreadableLines(root) {
    appendFileSync(ledgerFilePath(root), 'this is not json\n{"event":"usage.receipt","session_id":"TORN-WRITE",\n', 'utf-8');
  }

  it('says how many lines were unreadable — markdown and the JSON census agree, and the table is unchanged', async () => {
    const root = makeRoot('K');
    await seedLedger(root);
    const clean = parseJson(runCli(['--cwd', root, '--json'], root));
    appendUnreadableLines(root);

    const printed = parseJson(runCli(['--cwd', root, '--json'], root));
    const md = runCli(['--cwd', root], root).stdout;

    expect(printed.census.dropped.loss.corrupt).toBe(2);
    expect(md).toContain('- 원장 깨진 줄 2 (usage.receipt 여부 판별 불가 — 비용 과소 가능)');
    // The unreadable lines are not counted as anything else: the table is what it was.
    expect(printed.rows).toEqual(clean.rows);
    expect(printed.total).toEqual(clean.total);
    // ... and the limit line still closes the block.
    expect(md.trimEnd().split('\n').at(-1)).toMatch(/^- 한계:/);
  });

  it('says it on a zero-row report, where an empty table beside unreadable lines is not a clean ledger', () => {
    const root = makeRoot('K');
    mkdirSync(path.dirname(ledgerFilePath(root)), { recursive: true });
    writeFileSync(ledgerFilePath(root), 'garbage\nmore garbage\nand more\n', 'utf-8');

    const out = runCli(['--cwd', root], root);

    expect(out.status).toBe(0);
    expect(out.stdout).toContain('영수증 0행');
    expect(out.stdout).toContain('- 원장 깨진 줄 3 (usage.receipt 여부 판별 불가 — 비용 과소 가능)');
  });

  it('prints no such line for a clean ledger', async () => {
    const root = makeRoot('K');
    await seedLedger(root);

    const out = runCli(['--cwd', root], root);

    expect(out.stdout).not.toContain('깨진 줄');
    expect(out.stdout).not.toContain('출처 미기재');
  });
});

describe('usage-cost-table: filters', () => {
  it('--since keeps runs that STARTED at or after the cutoff', async () => {
    const root = makeRoot('F');
    await seedLedger(root);

    const printed = parseJson(runCli(['--cwd', root, '--since', SINCE_MID, '--json'], root));

    expect(printed.filter.since).toBe(SINCE_MID);
    expect(printed.receipts.counted).toBe(4);
    expect(printed.receipts.filtered.before_since).toBe(2);
    expect(printed.rows.map((r) => r.model_id)).toEqual([HAIKU, OPUS, SONNET]);
    expect(rowOf(printed, SONNET).spawns).toBe(2);
  });

  it('reads an all-digit --since as epoch milliseconds, never as a year', async () => {
    const root = makeRoot('F');
    await seedLedger(root);
    const ms = String(Date.parse(SINCE_MID));

    const printed = parseJson(runCli(['--cwd', root, '--since', ms, '--json'], root));
    expect(printed.filter.since).toBe(SINCE_MID);
    expect(printed.receipts.counted).toBe(4);
  });

  it('--session takes a comma list and repeats, and matches only those sessions', async () => {
    const root = makeRoot('F');
    await seedLedger(root);

    const one = parseJson(runCli(['--cwd', root, '--session', OLD_SESSION, '--json'], root));
    expect(one.receipts.counted).toBe(2);
    expect(one.filter.session_ids).toEqual([OLD_SESSION]);

    const both = parseJson(runCli(['--cwd', root, '--session', `${OLD_SESSION},${NEW_SESSION}`, '--json'], root));
    const repeated = parseJson(runCli(['--cwd', root, '--session', OLD_SESSION, '--session', NEW_SESSION, '--json'], root));
    expect(both.receipts.counted).toBe(6);
    expect(repeated.rows).toEqual(both.rows);
  });

  it('--run matches a spawn by its bare agent id', async () => {
    const root = makeRoot('F');
    await seedLedger(root);

    const printed = parseJson(runCli(['--cwd', root, '--run', 'sp3', '--json'], root));

    expect(printed.receipts.counted).toBe(1);
    expect(printed.rows.map((r) => r.model_id)).toEqual([HAIKU]);
  });

  it('a filter that matches nothing prints 0행 with the reason, not an empty table', async () => {
    const root = makeRoot('F');
    await seedLedger(root);

    const out = runCli(['--cwd', root, '--session', 'no-such-session'], root);

    expect(out.status).toBe(0);
    expect(out.stdout).toContain('영수증 0행');
    expect(out.stdout).toMatch(/6행 중 조건 통과 0행/);
    expect(out.stdout).not.toContain('| 모델 |');
  });
});

/** Write a fake projects tree holding one live session and its subagents. */
function writeLiveSession(sessionId, { main, agents = {}, t0 }) {
  const projects = path.join(tmp, 'projects');
  const slug = path.join(projects, 'C--fake-slug');
  mkdirSync(path.join(slug, sessionId, 'subagents'), { recursive: true });
  writeFileSync(path.join(slug, `${sessionId}.jsonl`), `${transcriptBody(sessionId, main.model, t0, main.n)}\n`, 'utf-8');
  for (const [id, spec] of Object.entries(agents)) {
    writeFileSync(
      path.join(slug, sessionId, 'subagents', `agent-${id}.jsonl`),
      `${transcriptBody(id, spec.model, t0, spec.n)}\n`,
      'utf-8',
    );
  }
  return projects;
}

/**
 * Make one subagent transcript of a written live session unreadable: a DIRECTORY
 * where the `.jsonl` file should be. The builder lists it by name, fails to read
 * it and counts it in `meta.unreadableFiles`; the other files still fold.
 */
function breakSubagentTranscript(projects, sessionId, agentId = 'unreadable') {
  mkdirSync(path.join(projects, 'C--fake-slug', sessionId, 'subagents', `agent-${agentId}.jsonl`), { recursive: true });
}

const LIVE_SESSION = 'sessTableLive01';

describe('usage-cost-table: --live-session (the session that has not ended yet)', () => {
  it('folds the current session straight from its transcript, spawns included', () => {
    const root = makeRoot('L');
    const projects = writeLiveSession(LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 2 }, lv2: { model: SONNET, n: 1 } },
      t0: NEW_T0,
    });

    const printed = parseJson(runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION, '--json',
    ], root));

    expect(printed.live.status).toBe('ok');
    expect(printed.live.session_id).toBe(LIVE_SESSION);
    expect(printed.live.files).toBe(3);
    expect(printed.live.receipts).toBe(3);
    expect(printed.live.unreadable_files).toBe(0);
    expect(printed.live.warning).toBeNull();
    expect(printed.live.replaced_ledger_receipts).toBe(0);
    expect(printed.rows.map((r) => r.model_id)).toEqual([OPUS, SONNET]);
    expect(rowOf(printed, SONNET).spawns).toBe(2);
    expect(rowOf(printed, SONNET).usage.output_tokens).toBe(sumUsage(perRun(2), perRun(1)).output);
    // The ledger stayed empty: this path measures, it does not record.
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  });

  it('REPLACES the ledger rows of the same session instead of adding to them', async () => {
    const root = makeRoot('L');
    // The ledger already holds an EARLIER snapshot of this very session ...
    await seedSession(root, LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 1 } },
      t0: NEW_T0,
    });
    // ... and the transcript has grown since (a second spawn, bigger totals).
    const projects = writeLiveSession(LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 5 }, lv2: { model: SONNET, n: 1 } },
      t0: NEW_T0,
    });
    // Another, ended session stays exactly as the ledger has it.
    await seedSession(root, NEW_SESSION, { main: { model: HAIKU, n: 1 }, agents: {}, t0: NEW_T0 });

    const printed = parseJson(runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION, '--json',
    ], root));

    expect(printed.live.replaced_ledger_receipts).toBe(2);
    expect(printed.live.receipts).toBe(3);
    expect(printed.receipts.counted).toBe(4); // 3 live + 1 other ended session
    // Not 1 + 5: the live copy wins, the stale ledger copy is gone.
    expect(rowOf(printed, SONNET).usage.output_tokens).toBe(sumUsage(perRun(5), perRun(1)).output);
    expect(rowOf(printed, SONNET).spawns).toBe(2);
    expect(rowOf(printed, HAIKU).sessions).toBe(1);
  });

  it('does NOT replace a session whose transcript was only partly readable: the ledger rows stay, and both outputs say so', async () => {
    const root = makeRoot('L');
    // The ledger holds an earlier snapshot of the session (n=1 for the spawn) ...
    await seedSession(root, LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 1 } },
      t0: NEW_T0,
    });
    // ... the transcript has a bigger copy (n=5), but one subagent file cannot be read.
    const projects = writeLiveSession(LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 5 } },
      t0: NEW_T0,
    });
    breakSubagentTranscript(projects, LIVE_SESSION);
    const args = ['--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION];

    const printed = parseJson(runCli([...args, '--json'], root));

    expect(printed.live.status).toBe('incomplete');
    expect(printed.live.unreadable_files).toBe(1);
    expect(printed.live.files).toBe(3); // main + lv1 + the unreadable one
    expect(printed.live.receipts).toBe(2); // what the readable part yielded — and was NOT used
    expect(printed.live.replaced_ledger_receipts).toBe(0);
    expect(printed.live.kept_ledger_receipts).toBe(2);
    expect(printed.live.warning).toBe('live 판독 불완전: 읽지 못한 파일 1 — 원장 행 유지');
    // The ledger copy (n=1) is what the table holds; the partial live copy (n=5) is not in it.
    expect(printed.receipts.counted).toBe(2);
    expect(rowOf(printed, SONNET).usage.output_tokens).toBe(perRun(1).output);
    expect(rowOf(printed, SONNET).spawns).toBe(1);

    const md = runCli(args, root).stdout;
    expect(md).toContain('live 판독 불완전: 읽지 못한 파일 1 — 원장 행 유지');
    expect(md).toContain('원장 행 2건');
    expect(md).not.toContain('transcript 직접 집계');
  });

  it('leaves the session out of the table, and says so, when a partial read has no ledger rows to fall back on', () => {
    const root = makeRoot('L');
    const projects = writeLiveSession(LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 2 } },
      t0: NEW_T0,
    });
    breakSubagentTranscript(projects, LIVE_SESSION);
    const args = ['--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION];

    const printed = parseJson(runCli([...args, '--json'], root));

    expect(printed.live.status).toBe('incomplete');
    expect(printed.live.receipts).toBe(2);
    expect(printed.live.kept_ledger_receipts).toBe(0);
    // A partial figure is not printed as if it were the session's spend.
    expect(printed.rows).toEqual([]);
    expect(printed.total).toBeNull();

    const md = runCli(args, root).stdout;
    expect(md).toContain('영수증 0행');
    expect(md).toContain('live 판독 불완전: 읽지 못한 파일 1 — 원장 행 유지');
    expect(md).toContain('이 세션은 표에 없다');
    expect(md).not.toContain('| 모델 |');
  });

  it('keeps the ledger rows when nothing at all could be read from the transcript', async () => {
    const root = makeRoot('L');
    await seedSession(root, LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 1 } },
      t0: NEW_T0,
    });
    // The main transcript "file" is a directory: found by name, unreadable as a file.
    const projects = path.join(tmp, 'projects');
    mkdirSync(path.join(projects, 'C--fake-slug', `${LIVE_SESSION}.jsonl`), { recursive: true });

    const printed = parseJson(runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION, '--json',
    ], root));

    expect(printed.live.status).toBe('read-failed');
    expect(printed.live.unreadable_files).toBe(1);
    expect(printed.live.replaced_ledger_receipts).toBe(0);
    expect(printed.receipts.counted).toBe(2);
    expect(rowOf(printed, SONNET).usage.output_tokens).toBe(perRun(1).output);
  });

  it('does not blame the missing ledger when the current session was read live and the filters removed it', () => {
    const root = makeRoot('L'); // no ledger file at all
    const projects = writeLiveSession(LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 1 } },
      t0: NEW_T0,
    });

    const md = runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION, '--session', 'someone-else',
    ], root).stdout;
    const finding = md.split('\n').find((l) => l.startsWith('조건에 맞는 usage.receipt 가 없다'));

    expect(finding).toMatch(/2행 중 조건 통과 0행/);
    expect(finding).toContain('현재 세션 직접 집계');
    expect(finding).toContain('원장 파일이 없다'); // still said, as a fact about where the receipts came from
    expect(finding).not.toMatch(/없다 — 원장 파일이 없다\./);
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  });

  it('says so — and reads nothing outside the projects dir — when the transcript is not there', () => {
    const root = makeRoot('L');
    const projects = writeLiveSession(LIVE_SESSION, { main: { model: OPUS, n: 1 }, t0: NEW_T0 });

    const printed = parseJson(runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', 'sessTableMissing', '--json',
    ], root));

    expect(printed.live.status).toBe('not-found');
    expect(printed.live.searched).toBe(projects);
    expect(printed.rows).toEqual([]);
    const md = runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', 'sessTableMissing',
    ], root).stdout;
    expect(md).toMatch(/sessTabl.*찾지 못했다/);
    expect(md).toContain('영수증 0행');
  });

  it('skips a blank session id with a note instead of failing (an empty env expansion)', () => {
    const root = makeRoot('L');
    const printed = parseJson(runCli(['--cwd', root, '--live-session', '', '--json'], root));
    expect(printed.live.status).toBe('blank-session-id');
    expect(printed.rows).toEqual([]);
  });

  it('refuses a session id that could walk out of the projects dir', () => {
    const root = makeRoot('L');
    const projects = writeLiveSession(LIVE_SESSION, { main: { model: OPUS, n: 1 }, t0: NEW_T0 });
    for (const bad of ['../evil', 'a/b', 'a\\b', '..', 'x y']) {
      const printed = parseJson(runCli([
        '--cwd', root, '--projects-dir', projects, '--live-session', bad, '--json',
      ], root));
      expect(printed.live.status, bad).toBe('invalid-session-id');
      expect(printed.rows).toEqual([]);
    }
  });

  it('names a model the catalog rejected instead of dropping its usage silently', () => {
    const root = makeRoot('L');
    const projects = writeLiveSession(LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: 'claude-future-9', n: 1 } },
      t0: NEW_T0,
    });

    const printed = parseJson(runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION, '--json',
    ], root));

    expect(printed.live.status).toBe('ok');
    expect(printed.live.unresolved_models).toEqual(['claude-future-9']);
    expect(printed.rows.map((r) => r.model_id)).toEqual([OPUS]);
    const md = runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION,
    ], root).stdout;
    expect(md).toContain('claude-future-9');
  });

  it('honours --since on a live session by the run start, like any ledger row', () => {
    const root = makeRoot('L');
    const projects = writeLiveSession(LIVE_SESSION, {
      main: { model: OPUS, n: 1 },
      agents: { lv1: { model: SONNET, n: 1 } },
      t0: NEW_T0,
    });
    // Both runs start at NEW_T0; a cutoff a minute later leaves neither started at/after it,
    // and each spans 60 s, so each STRADDLES the cutoff and is reported, not counted.
    const cutoff = new Date(Date.parse(NEW_T0) + 30_000).toISOString();
    const printed = parseJson(runCli([
      '--cwd', root, '--projects-dir', projects, '--live-session', LIVE_SESSION, '--since', cutoff, '--json',
    ], root));
    expect(printed.receipts.counted).toBe(0);
    expect(printed.receipts.filtered.straddling_since).toBe(2);
  });
});

describe('usage-cost-table: arguments', () => {
  const cases = [
    ['an unknown flag', ['--nope'], /unknown argument: --nope/],
    ['a value flag with no value', ['--since'], /--since requires a value/],
    ['a --since that is not a time', ['--since', 'yesterday'], /--since must be an ISO timestamp or epoch ms/],
    ['a blank --session', ['--session', ''], /--session is blank/],
    ['a --session of only commas', ['--session', ',,'], /--session is blank/],
    ['a blank --run', ['--run', ' '], /--run is blank/],
    ['a blank --ledger', ['--ledger', ''], /--ledger is blank/],
    ['a blank --cwd', ['--cwd', ''], /--cwd is blank/],
  ];

  it.each(cases)('refuses %s with exit 2, one stderr line and nothing on stdout', (_label, args, message) => {
    const root = makeRoot('E');
    const out = runCli(args, root);

    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr).toMatch(/^usage-cost-table: /);
    expect(out.stderr).toMatch(message);
    expect(out.stderr).toContain('usage:');
  });
});

describe('usage-cost-table: source contract', () => {
  const source = readFileSync(CLI, 'utf-8');

  it('is read-only by what it does not import', () => {
    expect(source).not.toMatch(/appendLedgerEvent|writeEvent|appendFileSync|writeFileSync|mkdirSync/);
    expect(source).toMatch(/readLedgerCensus/);
  });

  it('reads no environment variable, so a host session id cannot reach a table', () => {
    expect(source).not.toMatch(/process\.env/);
  });

  it('opens no network connection', () => {
    expect(source).not.toMatch(/\bfetch\s*\(|node:https?|axios|undici/);
  });
});
