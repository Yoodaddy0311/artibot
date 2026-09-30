/**
 * Real-process contract for `scripts/ledger/v51-census.mjs` — the one command that
 * turns a project's central ledger into the measurement set MEASUREMENT-RUNBOOK
 * asks for (v5.1 track: Shadow/Canary judged on a live ledger).
 *
 * WHY THE CASES SPAWN A PROCESS AND SEED A REAL LEDGER. The census is a shell over
 * eight existing readers, each with its own suite. What only a real run can show
 * is what the shell adds: that it finds the ledger of the project it was POINTED
 * AT (not of the directory it was started in), that every reader really read the
 * one snapshot it was handed, that each headline number carries its denominator
 * and a time, and that nothing is written into the project it measures. Every
 * seed goes through the real `appendLedgerEvent`; the first seeded assertion is
 * that the writer rejected nothing, because a rejected seed reads as a wrong
 * count rather than as a missing row.
 *
 * FOREIGN CWD IS THE POINT. The owner runs this from other repositories. Two
 * projects are built here — the TARGET and a DECOY with a different ledger — and
 * the census is started with the decoy as its process cwd and `--cwd` naming the
 * target. The numbers must be the target's. The POSITIVE CONTROL is the same run
 * WITHOUT `--cwd`: it must report the decoy's numbers, so the two projects are
 * shown to be distinguishable and the first assertion is not vacuous.
 *
 * MISSING IS NOT EMPTY. A project with no ledger file gets a clear message, exit
 * 0 and an empty census (no reader runs). An EMPTY ledger file is a different
 * finding — "a ledger exists and nothing is in it" — so the readers DO run and
 * report null ratios. That contrast is the positive control for the skip.
 *
 * A FAILING READER DEGRADES, IT DOES NOT CRASH. `--exclude-sessions <missing
 * file>` makes the REAL session-coverage reader exit 2. The census must still
 * exit 0, keep every other reader's numbers, mark the failed reader's metrics as
 * errors with null numbers (a reader that threw prints empty folds, and an empty
 * fold must never read as a measured zero), and carry the reason.
 *
 * READ-ONLY IS ASSERTED ON BYTES AND LISTINGS. The live ledger's sha256, size and
 * mtime, and a recursive listing of the project, are taken before and after.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - THE LIVE LEDGER'S SIZE. Seeds are a handful of rows; the owner's ledger is
 *    tens of megabytes. Timing, memory and output size at that scale are
 *    measured by a run against a copy of a real ledger, not here.
 *  - THE INSTALLED COPY. The script runs from this worktree.
 *  - WHETHER THE NUMBERS ARE RIGHT. Each reader's arithmetic has its own suite;
 *    these cases pin that the census carries them through unchanged.
 *  - A REAL AUTOPILOT SESSION STORE. The recovery-journal reader is pointed at a
 *    fixture directory via `--autopilot-dir`.
 *
 * @module tests/ledger/v51-census-cli
 */

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll, beforeAll, describe, expect, it, vi,
} from 'vitest';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { ledgerFilePath, sessionFallbackMissionId } from '../../lib/runtime/event-writer.js';
import { buildUsageReceipts } from '../../lib/economics/usage-receipt.js';
import { toUsageReceiptEnvelopes } from '../../lib/economics/receipt-envelope.js';
import { spawnSyncRetryDllInit } from '../helpers/spawn-retry.js';

// Each census spawns one process per reader per scope; the budget is headroom for
// load (other suites run in parallel), nothing here waits on a timer.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'v51-census.mjs');

/** Top-level keys the JSON document promises, in any order. */
const DOC_KEYS = [
  'schema', 'status', 'message', 'measuredAt', 'finishedAt', 'durationMs', 'project', 'plugin',
  'ledger', 'snapshot', 'runs', 'notRun', 'metrics', 'consistency', 'limitations', 'errors',
  'unverified',
];

/** The readers the census runs against the snapshot, plus the one store reader. */
const SNAPSHOT_READERS = [
  'session-coverage', 'verify-rate', 'verify-call-rate', 'route-compare', 'existence-audit',
  'usage-cost-table', 'model-routing-live',
];
const STORE_READERS = ['recovery-journal-census'];

/** @type {string} */
let tmp;

/** A project root the Artibot guards would accept: a `.git` directory and a config. */
function makeProject(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** A directory that is NOT a project: the neutral cwd a census is launched from. */
function makeNeutral(name) {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run the census inside `cwd`. Through the loader-flake retry the sibling suites use. */
function runCli(args, cwd) {
  const res = spawnSyncRetryDllInit(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd, env: { ...process.env }, maxBuffer: 256 * 1024 * 1024,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** `--json` output: exactly one line, clean stderr, exit 0. */
function parseDoc(out) {
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  expect(out.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(out.stdout);
}

/** One metric row by id and scope. */
function metric(doc, id, scope = 'history') {
  return doc.metrics.find((m) => m.id === id && m.scope === scope);
}

/** One reader run by id and scope. */
function run(doc, reader, scope = 'history') {
  return doc.runs.find((r) => r.reader === reader && r.scope === scope);
}

/** Recursive listing with sizes: what "nothing was created" is measured against. */
function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full)}:${statSync(full).size}`);
    }
  };
  walk(root);
  return out.sort();
}

/** sha256, size and mtime of a file. */
function fingerprint(file) {
  const bytes = readFileSync(file);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: statSync(file).size,
    mtimeMs: statSync(file).mtimeMs,
  };
}

/** One assistant transcript entry in the shape the receipt builder reads. */
function entry(requestId, timestamp) {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp,
    effort: 'high',
    message: {
      model: 'claude-opus-5',
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

/**
 * Append a schema-valid `usage.receipt` for one session, built through the real
 * writer with injected ports (an invented shape would land as `ledger.rejected`).
 */
async function seedReceipt(root, sessionId, stem) {
  const transcriptPath = `/fixture/projects/slug/${stem}.jsonl`;
  const body = [entry(`${stem}-a`, '2026-09-13T06:29:36.000Z'), entry(`${stem}-b`, '2026-09-13T06:29:41.250Z')].join('\n');
  const { receipts } = await buildUsageReceipts({
    transcriptPath,
    missionId: sessionFallbackMissionId(sessionId, '2026-09-13T00:00:00.000Z'),
    readTranscript: (p) => {
      if (p !== transcriptPath) throw new Error(`ENOENT ${p}`);
      return body;
    },
    listSubagentTranscripts: () => [],
  });
  for (const envelope of toUsageReceiptEnvelopes(receipts, { sessionId })) appendLedgerEvent(root, envelope);
}

/** Append one `session.ended` row in the shape `session-end.js` writes. */
function seedEnded(root, sessionId, o) {
  const res = appendLedgerEvent(root, {
    event: 'session.ended',
    session_id: sessionId,
    source: 'hook',
    idempotency_key: `session.ended:${sessionId}`,
    data: {
      receipt_status: o.status,
      receipts: 0,
      appended: 0,
      rejected: 0,
      deduped: 0,
      coverage: null,
      reason: o.reason ?? null,
      unresolved_models: [],
      transcript_present: true,
      session_fallback: o.fallback === true,
    },
  }, o.now === undefined ? {} : { now: o.now });
  expect(res.ok).toBe(true);
}

/**
 * Three ended sessions and four receipt sessions:
 *   A ended `appended`, receipt      B ended `skipped`, receipt
 *   C ended `failed`, no receipt     D never ended, receipt only
 * so session coverage is 2 of 3 and every count is non-zero by design.
 */
async function seedThree(root) {
  seedEnded(root, 'sessCenA0001', { status: 'appended' });
  seedEnded(root, 'sessCenB0002', { status: 'skipped', reason: 'no-transcript' });
  seedEnded(root, 'sessCenC0003', { status: 'failed', reason: 'write-failed', fallback: true });
  await seedReceipt(root, 'sessCenA0001', 'runA');
  await seedReceipt(root, 'sessCenB0002', 'runB');
  await seedReceipt(root, 'sessCenD0004', 'runD');
}

/** The seeded rows, with the rejected count checked FIRST. */
function expectNoRejections(root) {
  const lines = readFileSync(ledgerFilePath(root), 'utf-8').split('\n').filter((l) => l.trim() !== '');
  expect(lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'ledger.rejected')).toEqual([]);
}

/** A session-store directory the recovery-journal reader can read: one journal row. */
function makeStore(name) {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'sess-one.json'), `${JSON.stringify({ recoveryJournal: [{ divergent: true }] })}\n`, 'utf-8');
  return dir;
}

/** Shared fixtures, built once: three projects and the runs over them. */
const shared = {};

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-census-cli-')));
  shared.target = makeProject('target');
  shared.decoy = makeProject('decoy');
  shared.neutral = makeNeutral('neutral');
  shared.store = makeStore('store');
  await seedThree(shared.target);
  seedEnded(shared.decoy, 'sessDecoyZ001', { status: 'skipped', reason: 'no-transcript' });
  expectNoRejections(shared.target);
  expectNoRejections(shared.decoy);

  shared.targetLedger = ledgerFilePath(shared.target);
  shared.before = { ledger: fingerprint(shared.targetLedger), tree: listTree(shared.target) };
  shared.outMd = path.join(tmp, 'evidence', 'target-census.md');
  shared.out = runCli(
    ['--cwd', shared.target, '--json', '--out', shared.outMd, '--autopilot-dir', shared.store],
    shared.neutral,
  );
  shared.after = { ledger: fingerprint(shared.targetLedger), tree: listTree(shared.target) };
  shared.doc = JSON.parse(shared.out.stdout);
});

afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('v51-census: a foreign project with a seeded ledger', () => {
  it('exits 0 and prints exactly one JSON document with the promised keys', () => {
    expect(shared.out.stderr).toBe('');
    expect(shared.out.status).toBe(0);
    expect(shared.out.stdout.trim().split('\n')).toHaveLength(1);
    expect(Object.keys(shared.doc).sort()).toEqual([...DOC_KEYS].sort());
    expect(shared.doc.schema).toBe('v51-census/1');
  });

  it('finds the ledger of the project it was pointed at, not of the cwd it started in', () => {
    expect(shared.doc.project.cwd).toBe(shared.target);
    expect(shared.doc.ledger.livePath).toBe(shared.targetLedger);
    expect(shared.doc.ledger.present).toBe(true);
    // The census started in `neutral`, which has no ledger at all.
    expect(existsSync(ledgerFilePath(shared.neutral))).toBe(false);
    expect(metric(shared.doc, 'observe4.receipt-coverage').denominator).toBe(3);
  });

  it('carries the seeded numerator and denominator for receipt coverage, with a time', () => {
    const coverage = metric(shared.doc, 'observe4.receipt-coverage');
    expect(coverage.numerator).toBe(2);
    expect(coverage.denominator).toBe(3);
    expect(coverage.ratio).toBeCloseTo(2 / 3, 10);
    expect(coverage.status).toBe('measured');
    expect(Number.isFinite(Date.parse(coverage.measuredAt))).toBe(true);
    expect(coverage.scope).toBe('history');
  });

  it('gives EVERY metric row a denominator and a time, or says why it has none', () => {
    expect(shared.doc.metrics.length).toBeGreaterThan(10);
    for (const row of shared.doc.metrics) {
      expect(Number.isFinite(Date.parse(row.measuredAt))).toBe(true);
      if (row.status === 'measured') {
        expect(Number.isFinite(row.numerator)).toBe(true);
        expect(Number.isFinite(row.denominator)).toBe(true);
        expect(row.denominator).toBeGreaterThan(0);
      } else {
        expect(typeof row.reason).toBe('string');
        expect(row.ratio).toBeNull();
      }
    }
  });

  it('reads a zero denominator as unmeasured with a null ratio — never as a measured 0', () => {
    // No `/verify` ran in the seeded project, so the answered-sessions rate has no denominator.
    const row = metric(shared.doc, 'observe3.verify-answered-sessions');
    expect(row.denominator).toBe(0);
    expect(row.status).toBe('unmeasured');
    expect(row.ratio).toBeNull();
    expect(row.ratio).not.toBe(0);
  });

  it('runs every snapshot-fed reader once and the store reader once', () => {
    for (const id of SNAPSHOT_READERS) {
      const r = run(shared.doc, id);
      expect(r, id).toBeDefined();
      expect(r.input).toBe('snapshot');
      expect(['ok', 'unmeasured']).toContain(r.status);
    }
    for (const id of STORE_READERS) {
      const r = shared.doc.runs.find((x) => x.reader === id);
      expect(r, id).toBeDefined();
      expect(r.input).toBe('live-store');
      expect(r.scope).toBe('all');
    }
  });

  it('points the store reader at the directory it was given and counts its journal row', () => {
    const r = shared.doc.runs.find((x) => x.reader === 'recovery-journal-census');
    expect(r.status).toBe('ok');
    expect(path.resolve(r.inputPath)).toBe(path.resolve(shared.store));
    const row = shared.doc.metrics.find((m) => m.id === 'ca03.recovery-journal-divergent');
    expect(row.numerator).toBe(1);
    expect(row.denominator).toBe(1);
  });

  it('made every snapshot-fed reader read the snapshot, byte for byte', () => {
    expect(shared.doc.snapshot.bytes).toBe(shared.before.ledger.size);
    expect(shared.doc.snapshot.sha256).toBe(shared.before.ledger.sha256);
    expect(shared.doc.consistency.ok).toBe(true);
    for (const id of SNAPSHOT_READERS) {
      const r = run(shared.doc, id);
      expect(r.inputIsSnapshot, id).toBe(true);
      // The reader's own path is the snapshot's, NOT the live file's.
      expect(path.resolve(r.inputPath)).not.toBe(path.resolve(shared.targetLedger));
    }
    const checks = shared.doc.consistency.checks.filter((c) => c.id === 'reader-bytes-equal-snapshot');
    expect(checks.length).toBeGreaterThanOrEqual(SNAPSHOT_READERS.length);
    expect(checks.every((c) => c.holds === true)).toBe(true);
  });

  it('leaves the live ledger byte-identical and creates nothing in the project', () => {
    expect(shared.after.ledger).toEqual(shared.before.ledger);
    expect(shared.after.tree).toEqual(shared.before.tree);
  });

  it('removes its snapshot directory when it is done', () => {
    expect(shared.doc.snapshot.removed).toBe(true);
    expect(existsSync(shared.doc.snapshot.path)).toBe(false);
  });

  it('writes the evidence markdown to --out with the runbook skeleton and the numbers', () => {
    const md = readFileSync(shared.outMd, 'utf-8');
    for (const heading of ['## 0. ', '## 1. ', '## 2. ', '## 3. ', '## 4. ', '## 5. ', '## 6. ']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('observe4.receipt-coverage');
    expect(md).toContain(shared.doc.snapshot.sha256.slice(0, 12));
    expect(md).toContain(shared.target);
    // The reproduction command is the one that was run: its flags, its --out path.
    const command = md.split('```text')[1].split('```')[0];
    expect(command).toContain(`--cwd "${shared.target}"`);
    expect(command).toContain('--json');
    expect(command).toContain(`--out "${shared.outMd}"`);
    // The evidence file says it issues no verdict and may not change a status.
    expect(md).toContain('상태 전환 권한이 없다');
  });

  it('separates every markdown table from the text above it, so it renders as a table', () => {
    const lines = readFileSync(shared.outMd, 'utf-8').split('\n');
    let tables = 0;
    lines.forEach((line, i) => {
      const startsTable = line.startsWith('| ') && i > 0 && !lines[i - 1].startsWith('|');
      if (!startsTable) return;
      tables += 1;
      expect(lines[i - 1], `line ${i + 1}`).toBe('');
    });
    expect(tables).toBeGreaterThanOrEqual(5);
    // §3 holds the snapshot checks and §4 the readers' own identities, not one mixed table.
    const md = lines.join('\n');
    const sec3 = md.slice(md.indexOf('## 3. '), md.indexOf('## 4. '));
    const sec4 = md.slice(md.indexOf('## 4. '), md.indexOf('## 5. '));
    expect(sec3).toContain('reader-bytes-equal-snapshot');
    expect(sec3).not.toContain('coverage-ended-is-covered-plus-skipped');
    expect(sec4).toContain('coverage-ended-is-covered-plus-skipped');
  });

  it('reports what it did NOT run, with a reason and a command to run it separately', () => {
    const ids = shared.doc.notRun.map((n) => n.id);
    for (const id of ['outcome-census', 'nl-activation-report', 'topology-agreement', 'question-rate']) {
      expect(ids).toContain(id);
    }
    for (const n of shared.doc.notRun) {
      expect(n.why.length).toBeGreaterThan(20);
      expect(n.runSeparately).toContain(n.script.split('/').pop());
    }
  });
});

describe('v51-census: the project is the one named by --cwd', () => {
  it('reports the target numbers when started inside a DIFFERENT project', () => {
    const doc = parseDoc(runCli(['--cwd', shared.target, '--json'], shared.decoy));
    expect(doc.project.cwd).toBe(shared.target);
    expect(metric(doc, 'observe4.receipt-coverage').denominator).toBe(3);
  });

  it('POSITIVE CONTROL: without --cwd it measures the project it was started in', () => {
    const doc = parseDoc(runCli(['--json'], shared.decoy));
    expect(doc.project.cwd).toBe(shared.decoy);
    // The decoy holds ONE ended session and no receipt, so the two answers differ.
    expect(metric(doc, 'observe4.receipt-coverage').denominator).toBe(1);
    expect(metric(doc, 'observe4.receipt-coverage').numerator).toBe(0);
  });
});

describe('v51-census: --since adds the window beside the whole history', () => {
  it('reports both scopes, the normalized cutoff, and a smaller window', () => {
    const root = makeProject('windowed');
    const at = (iso) => () => new Date(iso);
    seedEnded(root, 'sessWinOld001', { status: 'skipped', reason: 'no-transcript', now: at('2026-09-10T00:00:00.000Z') });
    seedEnded(root, 'sessWinMid002', { status: 'skipped', reason: 'no-transcript', now: at('2026-09-20T00:00:00.000Z') });
    seedEnded(root, 'sessWinNew003', { status: 'skipped', reason: 'no-transcript', now: at('2026-09-25T00:00:00.000Z') });
    expectNoRejections(root);

    const doc = parseDoc(runCli(['--cwd', root, '--json', '--since', '2026-09-15T00:00:00Z'], shared.neutral));

    expect(doc.project.since).toBe('2026-09-15T00:00:00.000Z');
    expect(doc.project.scopes).toEqual(['history', 'window']);
    expect(metric(doc, 'observe4.receipt-coverage', 'history').denominator).toBe(3);
    expect(metric(doc, 'observe4.receipt-coverage', 'window').denominator).toBe(2);
    // Every snapshot-fed reader ran once per scope, all on the same snapshot.
    expect(doc.runs.filter((r) => r.reader === 'session-coverage').map((r) => r.scope)).toEqual(['history', 'window']);
    expect(doc.consistency.ok).toBe(true);
    // The store reader takes no --since: it is run once and says so.
    expect(doc.runs.filter((r) => r.reader === 'recovery-journal-census')).toHaveLength(1);
    expect(doc.limitations.map((l) => l.id)).toContain('store-readers-not-windowed');
  });
});

describe('v51-census: pass-through flags reach the reader that owns them', () => {
  it('resolves a RELATIVE --exclude-sessions file against the census cwd, not the snapshot root', () => {
    // The readers run with the snapshot root as their cwd, so a relative path handed on as-is would break.
    const cwd = makeNeutral('excl-cwd');
    writeFileSync(path.join(cwd, 'exclude.txt'), 'sessCenC0003\n', 'utf-8');

    const doc = parseDoc(runCli(['--cwd', shared.target, '--json', '--exclude-sessions', 'exclude.txt'], cwd));

    // The raw view is always printed beside the excluded one: 3 ended, 2 covered; without C, 2 ended, 2 covered.
    expect(metric(doc, 'observe4.receipt-coverage')).toMatchObject({ numerator: 2, denominator: 3 });
    expect(metric(doc, 'observe4.receipt-coverage.excluded')).toMatchObject({ numerator: 2, denominator: 2 });
    const args = run(doc, 'session-coverage').args;
    expect(path.isAbsolute(args[args.indexOf('--exclude-sessions') + 1])).toBe(true);
    expect(doc.limitations.map((l) => l.id)).toContain('exclusion-scope');
  });

  it('gives --plugin-root to the inventory reader and stamps that root and its version', () => {
    const pluginRoot = path.join(tmp, 'fixture-plugin');
    mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
    writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'artibot', version: '9.9.9' })}\n`, 'utf-8');
    writeFileSync(path.join(pluginRoot, 'commands', 'alpha.md'), '# alpha\n', 'utf-8');

    const doc = parseDoc(runCli(['--cwd', shared.target, '--json', '--plugin-root', pluginRoot], shared.neutral));

    expect(doc.plugin.root).toBe(pluginRoot);
    expect(doc.plugin.version).toBe('9.9.9');
    // No config in that root: said so, not guessed.
    expect(doc.plugin.switches.status).toBe('unreadable');
    const audit = run(doc, 'existence-audit');
    expect(audit.result.pluginRoot).toBe(pluginRoot);
    expect(audit.result.kinds.commands.entries.map((e) => e.name)).toEqual(['alpha']);
    // The ledger it was judged against is still the snapshot of the target.
    expect(audit.inputIsSnapshot).toBe(true);
  });
});

describe('v51-census: a project with no ledger', () => {
  it('says so in words, exits 0 and runs no reader', () => {
    const root = makeProject('noledger');
    const before = listTree(root);

    const out = runCli(['--cwd', root], shared.neutral);

    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('no ledger at');
    expect(out.stdout).toContain(ledgerFilePath(root));
    expect(listTree(root)).toEqual(before);
    // No --json and no --out were given, so the reproduction command must not claim them.
    const command = out.stdout.split('```text')[1].split('```')[0];
    expect(command).toContain(`--cwd "${root}"`);
    expect(command).not.toContain('--json');
    expect(command).not.toContain('--out');
  });

  it('prints an EMPTY census in --json: status no-ledger, every reader skipped, no metrics', () => {
    const root = makeProject('noledger-json');
    const doc = parseDoc(runCli(['--cwd', root, '--json'], shared.neutral));

    expect(doc.status).toBe('no-ledger');
    expect(doc.ledger.present).toBe(false);
    expect(doc.snapshot).toBeNull();
    expect(doc.metrics).toEqual([]);
    expect(doc.runs.length).toBeGreaterThan(0);
    expect(doc.runs.every((r) => r.status === 'skipped' && r.reason === 'no-ledger')).toBe(true);
    expect(doc.message).toContain('no ledger at');
    expect(doc.message).toContain('repository root');
    expect(doc.consistency.ok).toBeNull();
    // Reading a number must not create the thing it reads.
    expect(existsSync(ledgerFilePath(root))).toBe(false);
  });

  it('treats a --cwd that does not exist the same way, not as a crash', () => {
    const doc = parseDoc(runCli(['--cwd', path.join(tmp, 'does-not-exist'), '--json'], shared.neutral));
    expect(doc.status).toBe('no-ledger');
    expect(doc.metrics).toEqual([]);
  });

  it('POSITIVE CONTROL: an EMPTY ledger file is not "missing" — the readers run and report null', () => {
    const root = makeProject('emptyledger');
    mkdirSync(path.dirname(ledgerFilePath(root)), { recursive: true });
    writeFileSync(ledgerFilePath(root), '', 'utf-8');

    const doc = parseDoc(runCli(['--cwd', root, '--json'], shared.neutral));

    expect(doc.status).not.toBe('no-ledger');
    expect(doc.ledger.present).toBe(true);
    expect(doc.snapshot.bytes).toBe(0);
    const coverage = metric(doc, 'observe4.receipt-coverage');
    expect(coverage.denominator).toBe(0);
    expect(coverage.ratio).toBeNull();
    expect(coverage.status).toBe('unmeasured');
    expect(doc.runs.some((r) => r.status === 'skipped')).toBe(false);
  });
});

describe('v51-census: a reader that fails', () => {
  it('keeps the other readers, marks the failed reader as an error, and still exits 0', () => {
    const missingList = path.join(tmp, 'no-such-exclusion-list.txt');
    const out = runCli(['--cwd', shared.target, '--json', '--exclude-sessions', missingList], shared.neutral);

    // Exit 0 and one JSON line: the failure is data, not a crash.
    const doc = parseDoc(out);
    expect(doc.status).toBe('partial');
    const failed = run(doc, 'session-coverage');
    expect(failed.status).toBe('error');
    expect(failed.error.kind).toBe('exit');
    expect(failed.error.exitCode).toBe(2);
    expect(failed.error.message).toContain('session-coverage');
    expect(doc.errors.map((e) => e.reader)).toContain('session-coverage');

    // A reader that died printed nothing to read: its metrics are errors with NULL numbers.
    const coverage = metric(doc, 'observe4.receipt-coverage');
    expect(coverage.status).toBe('error');
    expect(coverage.numerator).toBeNull();
    expect(coverage.denominator).toBeNull();

    // The others are untouched, and still measured from the snapshot.
    expect(run(doc, 'usage-cost-table').status).toBe('ok');
    expect(metric(doc, 'usage.receipts-counted').status).toBe('measured');
    expect(doc.consistency.ok).toBe(true);
  });
});

describe('v51-census: the command line', () => {
  it.each([
    [['--nonsense'], 'unknown argument'],
    [['--since', 'not-a-time'], '--since'],
    [['--cwd', ''], '--cwd'],
    [['--out', 'evidence.txt'], '--out'],
    [['--json', 'extra'], 'unknown argument'],
  ])('refuses %j with exit 2, one stderr line and an empty stdout', (args, needle) => {
    const out = runCli(args, shared.neutral);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.startsWith('v51-census:')).toBe(true);
    expect(out.stderr).toContain(needle);
  });

  it('refuses an --out that would overwrite the ledger, and leaves the ledger untouched', () => {
    const before = fingerprint(shared.targetLedger);
    const out = runCli(['--cwd', shared.target, '--out', shared.targetLedger], shared.neutral);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(fingerprint(shared.targetLedger)).toEqual(before);
  });
});
