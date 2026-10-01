/**
 * The census snapshot must never make the live ledger lose a row.
 *
 * THE DEFECT THIS PINS (found by review, 2026-09-30). The first version took the
 * snapshot with the platform's single-call file copy. On Windows that call opens the
 * source without write sharing, so for as long as it runs every hook that appends to
 * the live ledger gets EBUSY — and the writer (`event-writer.js`, one
 * `appendFileSync` per line) does not retry, so the row is gone. The reviewer measured
 * 4,793 of 8,820 appends failing during one copy of a 25 MB ledger, and 0 of 5,926
 * during a read followed by a write (a read shares the file). A measuring tool that
 * drops the rows it measures is worse than no tool, and nothing in the census output
 * could have told anyone: the snapshot itself was perfect.
 *
 * FOUR PIECES, EACH COVERING WHAT THE OTHERS CANNOT.
 *  1. SPY. The snapshot reads the live file and writes the SAME buffer to the
 *     snapshot path, and never calls the copy. A spy on a builtin is blind to a
 *     named import unless the ESM exports are re-synced after patching, and a blind
 *     spy that sees no copy call proves nothing — so the spy is re-synced
 *     (`syncBuiltinESMExports`) AND carries its own positive control: it must see the
 *     read of the live path, or its zero for the copy is not evidence.
 *  2. STATIC SCAN. The source spells no copy call at all (`copyFile*`, `cp`, `cpSync`),
 *     so a later "tidy-up" to the one-liner is red before anyone runs it on Windows. The
 *     scanner is shown to go red.
 *  3. A REAL APPENDER. A second PROCESS appends to the live ledger in a tight loop
 *     (the writer's own primitive) while the census takes its snapshot; not one append
 *     may fail. Several snapshots are taken in a row, so a starved appender on a loaded
 *     machine still overlaps at least one.
 *  4. POSITIVE CONTROL (Windows only). The same appender against the single-call copy
 *     DOES fail, and the loop keeps copying until it does. Without it, the zero in (3)
 *     would be indistinguishable from an appender that never overlapped anything. On
 *     other platforms the call does not lock, so there is nothing to show.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - ANTIVIRUS OR INDEXER LOCKS on the live file, which are not the census's and which
 *    no code here controls; a machine that fails appends by itself fails (3) too.
 *  - A TORN LINE: a read that lands between the two halves of one append.
 *  - LEDGERS LARGER THAN THE 32 MB USED HERE, and the installed copy.
 *
 * @module tests/ledger/v51-census-snapshot
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { census } from '../../scripts/ledger/v51-census.mjs';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'v51-census.mjs');
const REGISTRY = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'v51-census-readers.mjs');

/** @type {string} */
let tmp;
/** @type {Array<{kill: () => void}>} */
let appenders;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-census-snap-')));
  appenders = [];
});
afterEach(() => {
  for (const a of appenders) a.kill();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

/** A project root with a `.git` directory, so its ledger resolves by the shared common-dir rule. */
function makeProject(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

/** One real `session.ended` row through the real writer. */
function seedEnded(root, sessionId) {
  const res = appendLedgerEvent(root, {
    event: 'session.ended',
    session_id: sessionId,
    source: 'hook',
    idempotency_key: `session.ended:${sessionId}`,
    data: {
      receipt_status: 'skipped',
      receipts: 0,
      appended: 0,
      rejected: 0,
      deduped: 0,
      coverage: null,
      reason: 'no-transcript',
      unresolved_models: [],
      transcript_present: true,
      session_fallback: false,
    },
  });
  expect(res.ok).toBe(true);
}

/**
 * A project whose live ledger holds `mb` megabytes of filler rows: big enough that
 * reading or copying it takes tens of milliseconds, which is the window an appender
 * can fall into. The census with no readers never parses a row, so filler is enough.
 */
function bigProject(name, mb) {
  const root = makeProject(name);
  const live = ledgerFilePath(root);
  mkdirSync(path.dirname(live), { recursive: true });
  const row = `${JSON.stringify({ v: 1, event: 'test.filler', pad: 'x'.repeat(150) })}\n`;
  writeFileSync(live, row.repeat(Math.ceil((mb * 1024 * 1024) / row.length)), 'utf-8');
  return { root, live };
}

describe('v51-census snapshot: a read and a write, never the copy call', () => {
  it('reads the live ledger and writes that same buffer to the snapshot path, with no copy call (spy, re-synced, with a positive control)', () => {
    const root = makeProject('spy');
    seedEnded(root, 'sessSpy00000001');
    const live = ledgerFilePath(root);
    const calls = { copy: [], read: [], write: [] };
    const real = { copy: fs.copyFileSync, read: fs.readFileSync, write: fs.writeFileSync };
    fs.copyFileSync = (...a) => { calls.copy.push(String(a[0])); return real.copy(...a); };
    fs.readFileSync = (...a) => { calls.read.push(String(a[0])); return real.read(...a); };
    fs.writeFileSync = (...a) => { calls.write.push({ file: String(a[0]), buffer: Buffer.isBuffer(a[1]) }); return real.write(...a); };
    // Without this the patched functions are invisible to `import { x } from 'node:fs'`.
    syncBuiltinESMExports();
    let doc;
    try {
      doc = census({ cwd: root, since: null }, { readers: [], tmpRoot: tmp });
    } finally {
      fs.copyFileSync = real.copy;
      fs.readFileSync = real.read;
      fs.writeFileSync = real.write;
      syncBuiltinESMExports();
    }

    // The finding first, so a regression reads as what it is: a single-call copy.
    expect(calls.copy, 'the snapshot must not copy the live ledger in one call').toEqual([]);
    // POSITIVE CONTROL: the spy saw the read of the live path, so it can see named-import
    // calls at all. Only then is "no copy call" above a finding rather than blindness.
    expect(calls.read, 'the spy must see the read of the live ledger, or its zero copies proves nothing').toContain(live);
    const written = calls.write.find((w) => w.file === doc.snapshot.file);
    expect(written, 'the snapshot file is written').toBeDefined();
    // The very Buffer that was read, not a string: bytes in, the same bytes out.
    expect(written.buffer).toBe(true);
    expect(doc.snapshot.bytes).toBe(fs.statSync(live).size);
  });

  it('hashes what it read: the snapshot sha256 is the live file\'s, byte for byte', () => {
    const root = makeProject('hash');
    seedEnded(root, 'sessHash0000001');
    seedEnded(root, 'sessHash0000002');
    const live = ledgerFilePath(root);

    const doc = census({ cwd: root, since: null }, { readers: [], tmpRoot: tmp });

    // An independent hash of the same live bytes (nothing appends to this file during the run).
    const expected = readFileSync(live);
    expect(doc.snapshot.bytes).toBe(expected.length);
    expect(doc.snapshot.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
  });
});

/**
 * Spellings of the platform's single-call file copy, in any API flavor: `copyFile`,
 * `copyFileSync`, `fs.promises.copyFile`, and `cp` / `cpSync`, which copy a lone file
 * through the same call. Measured (2026-10-01): a snapshot taken with `cpSync` slipped
 * past the first version of this scan and was caught only by the appender test below,
 * on Windows; the scan is what reds on every platform.
 */
const COPY_CALL = /copyFile|\bcp(?:Sync)?\s*\(/i;

/**
 * The no-copy property as one function, so the self-test can aim at it.
 *
 * @param {string} source
 * @returns {string[]} findings; empty means clean
 */
function copyFindings(source) {
  return COPY_CALL.test(source) ? ['spells a single-call file copy'] : [];
}

describe('v51-census snapshot: the source spells no copy call', () => {
  it('neither the shell nor the registry module mentions one, in code or in a comment', () => {
    for (const file of [CLI, REGISTRY]) expect(copyFindings(readFileSync(file, 'utf-8')), file).toEqual([]);
  });

  it('SELF-TEST: the same scanner reds on every flavor of the call', () => {
    for (const bad of [
      "import { copyFileSync } from 'node:fs';\ncopyFileSync(a, b);",
      "import fs from 'node:fs';\nfs.copyFile(a, b, cb);",
      "await fs.promises.copyFile(a, b);",
      'fs.CopyFileSync(a, b)',
      'fs.cpSync(a, b);',
      "import { cp } from 'node:fs/promises';\nawait cp(a, b);",
    ]) {
      expect(copyFindings(bad), bad).not.toEqual([]);
    }
    // And it stays green on the read-then-write the code does use, and on look-alikes.
    for (const good of [
      'const buf = readFileSync(live); writeFileSync(file, buf);',
      'const n = os.cpus().length; const scp = 1; const cpu = cpus(2);',
    ]) {
      expect(copyFindings(good), good).toEqual([]);
    }
  });
});

/**
 * Source of the appender: a second process that appends to `argv[2]` the way
 * `event-writer.js#appendLine` does (one `appendFileSync`, flag `a`), counts every
 * failure by error code, and reports on request. It yields between batches so it can
 * hear the stop message while this process blocks on the snapshot.
 */
const APPENDER = [
  "import { appendFileSync } from 'node:fs';",
  'const file = process.argv[2];',
  'const stats = { attempts: 0, ok: 0, errors: {} };',
  'let stopping = false;',
  'let announced = false;',
  'let batches = 0;',
  "process.on('message', (m) => { if (m === 'stop') stopping = true; });",
  'const failed = () => Object.values(stats.errors).reduce((a, b) => a + b, 0);',
  'function batch() {',
  '  for (let i = 0; i < 50; i += 1) {',
  '    stats.attempts += 1;',
  '    try {',
  "      appendFileSync(file, JSON.stringify({ v: 1, event: 'test.row', n: stats.attempts }) + '\\n', { encoding: 'utf-8', flag: 'a' });",
  '      stats.ok += 1;',
  '    } catch (err) {',
  "      const code = err && err.code ? err.code : 'ERR';",
  '      stats.errors[code] = (stats.errors[code] || 0) + 1;',
  '    }',
  '  }',
  '  batches += 1;',
  "  if (!announced && stats.ok > 0) { announced = true; process.send({ type: 'ready' }); }",
  "  if (batches % 10 === 0) process.send({ type: 'tick', failed: failed(), ok: stats.ok });",
  "  if (stopping) { process.send({ type: 'stats', stats }, () => process.exit(0)); return; }",
  '  setImmediate(batch);',
  '}',
  'batch();',
].join('\n');

/**
 * Start the appender against `file`. `ready` resolves once it has appended at least
 * once; `failed()` is its latest failure count; `stop()` resolves with its final stats.
 *
 * @param {string} file
 * @returns {{ready: Promise<void>, failed: () => number, stop: () => Promise<object>, kill: () => void}}
 */
function startAppender(file) {
  const script = path.join(tmp, 'appender.mjs');
  writeFileSync(script, APPENDER, 'utf-8');
  const child = spawn(process.execPath, [script, file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
  let latestFailed = 0;
  const ready = new Promise((resolve, reject) => {
    child.on('message', (m) => { if (m?.type === 'ready') resolve(); });
    child.once('error', reject);
  });
  const finished = new Promise((resolve, reject) => {
    child.on('message', (m) => {
      if (m?.type === 'tick') latestFailed = m.failed;
      if (m?.type === 'stats') resolve(m.stats);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`the appender exited (${code}) without reporting`)));
  });
  // A rejection nobody awaits must not surface as an unhandled one after the test ends.
  finished.catch(() => {});
  const handle = {
    ready,
    failed: () => latestFailed,
    stop: () => { child.send('stop'); return finished; },
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
  appenders.push(handle);
  return handle;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const total = (errors) => Object.values(errors).reduce((a, b) => a + b, 0);

describe('v51-census snapshot: an appender running during it loses nothing', () => {
  it('lets a concurrent process append through five snapshots of a 32 MB ledger with zero failures', async () => {
    const { root, live } = bigProject('appender', 32);
    const appender = startAppender(live);
    await appender.ready;

    // Each census blocks THIS thread while it reads and writes; the appender is another process.
    const docs = [];
    for (let i = 0; i < 5; i += 1) docs.push(census({ cwd: root, since: null }, { readers: [], tmpRoot: tmp }));
    const stats = await appender.stop();

    for (const doc of docs) expect(doc.snapshot.bytes).toBeGreaterThan(30 * 1024 * 1024);
    // The appender really was appending around the snapshots (else a zero proves nothing).
    expect(docs.some((d) => d.ledger.grewDuringRun === true)).toBe(true);
    expect(stats.ok).toBeGreaterThan(0);
    // Not one append failed: no EBUSY, no EPERM, no other code.
    expect(stats.errors).toEqual({});
    // And every snapshot directory was removed.
    for (const doc of docs) expect(existsSync(doc.snapshot.path)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('POSITIVE CONTROL: the single-call copy makes the same appender fail on Windows, so the zero above is a finding', async () => {
    const { live } = bigProject('appender-control', 32);
    const appender = startAppender(live);
    await appender.ready;

    // Copy until the appender reports a failure (or give up): the loop yields between
    // rounds so its report can arrive, and a starved appender gets more chances.
    let rounds = 0;
    while (rounds < 40 && appender.failed() === 0) {
      copyFileSync(live, path.join(tmp, `control-copy-${rounds}.jsonl`));
      rounds += 1;
      await delay(25);
    }
    const stats = await appender.stop();

    expect(total(stats.errors), `after ${rounds} copies`).toBeGreaterThan(0);
  });
});
