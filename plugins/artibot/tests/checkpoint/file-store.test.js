/**
 * Behaviour pins for the checkpoint file adapter — JSONL framing, torn-line
 * tolerance, and survival under concurrent append by real processes.
 *
 * WHY A CONCURRENCY CASE LIVES HERE. `lib/core/decision-trail.js` reads the
 * whole file, mutates it and writes it back; measured 2026-08-28 across
 * processes that loses 21 of 60 records. The answer this adapter copies from
 * `lib/runtime/event-writer.js` and `lib/learning/ledger/spawn-ledger.js` is
 * structural rather than a lock: one record is ONE `appendFileSync` with the
 * `'a'` flag and nothing ever reads before it writes. The shape below is the
 * original 3 x 20 = 60 experiment run against the checkpoint adapter, using the
 * harness form of `tests/firewall/ledger-append-survival.test.js` (real
 * `spawn(process.execPath, ...)`, child source written to a temp file, module
 * reached through `pathToFileURL`). That file is READ-ONLY here; it is cited as
 * the precedent, not modified.
 *
 * Every fixture lives in an `mkdtempSync` directory. The real store location is
 * `<git-common-dir>/artibot/` and a test that wrote there would pollute the
 * repository's own store.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - CONCURRENCY BEYOND N=3. Three processes is the shape measured. The
 *     observed `/split` maximum is 12 windows, so everything between 3 and 12
 *     is UNMEASURED here. `tests/firewall/ledger-append-survival.test.js`
 *     measures 8 for a DIFFERENT file and writer; that is not a result about
 *     this adapter.
 *   - WINDOWS `'a'` ATOMICITY IN GENERAL. One record as written below measured
 *     236 bytes including its newline (2026-09-12, this fixture shape), and the
 *     `it` titled "records stay small" re-measures it every run so the number is
 *     never a claim from memory. That `FILE_APPEND_DATA` stays atomic for a
 *     checkpoint record of several KB, or on a network share, is INFERRED from
 *     the same reasoning the ledger uses, NOT measured. Do not read a green run
 *     here as raising that inference to a measurement.
 *   - A LOSS THAT LEAVES NO TRACE. 60/60 says nothing was lost in THIS run at
 *     THIS concurrency. A rarer interleaving is not excluded.
 *   - CRASH DURABILITY. `appendFileSync` returning is not fsync. Whether a
 *     record survives a power loss is not measured anywhere in this file.
 *
 * @module tests/checkpoint/file-store
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFileStoreAdapter } from '../../lib/checkpoint/adapters/file-store.js';
import { createCheckpointStore } from '../../lib/checkpoint/checkpoint-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', '..', 'lib', 'checkpoint');
const STORE_MODULE = pathToFileURL(path.join(LIB, 'checkpoint-store.js')).href;
const ADAPTER_MODULE = pathToFileURL(path.join(LIB, 'adapters', 'file-store.js')).href;

/** Records each child appends — the depth of the 2026-08-28 experiment. */
const LINES_PER_PROCESS = 20;
/** Concurrent writers. See the header for why 3 is a floor, not a ceiling. */
const PROCESSES = 3;

/** @type {string} */
let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'artibot-checkpoint-file-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A checkpoint body.
 * @param {object} extra - Fields merged over the base.
 * @returns {object} Checkpoint.
 */
function checkpoint(extra = {}) {
  return { mission_id: 'M-20260912-001', phase: 'build', tasks: [{ id: 'T-1' }], ...extra };
}

/** @returns {string} The adapter's file path under the fixture directory. */
function filePath(name = 'checkpoints.jsonl') {
  return path.join(dir, name);
}

/** @returns {string[]} Every non-empty raw line currently on disk. */
function rawLines(name) {
  return readFileSync(filePath(name), 'utf-8').split('\n').filter((l) => l.length > 0);
}

describe('reading', () => {
  it('returns an empty list when the file does not exist', async () => {
    const adapter = createFileStoreAdapter({ dir });
    expect(await adapter.readAll()).toEqual([]);
    expect(existsSync(filePath())).toBe(false);
  });

  it('reports a zero census on a missing file', async () => {
    const adapter = createFileStoreAdapter({ dir });
    const census = await adapter.census();
    expect(census.file.exists).toBe(false);
    expect(census.survivors).toBe(0);
    expect(census.dropped.torn).toBe(0);
  });

  it('reads back what it appended, in append order', async () => {
    const adapter = createFileStoreAdapter({ dir });
    await adapter.append({ v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: {} });
    await adapter.append({ v: 1, checkpoint_id: 'b', mission_id: 'M', ts: 't', checkpoint: {} });
    expect((await adapter.readAll()).map((r) => r.checkpoint_id)).toEqual(['a', 'b']);
  });
});

describe('framing', () => {
  it('writes exactly one JSON object per line, newline-terminated', async () => {
    const adapter = createFileStoreAdapter({ dir });
    await adapter.append({ v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: { n: 1 } });
    await adapter.append({ v: 1, checkpoint_id: 'b', mission_id: 'M', ts: 't', checkpoint: { n: 2 } });
    const raw = readFileSync(filePath(), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    // No embedded newline can split one record into two lines.
    expect(lines.map((l) => JSON.parse(l).checkpoint.n)).toEqual([1, 2]);
  });

  it('keeps a record on one line even when its content contains newlines', async () => {
    const adapter = createFileStoreAdapter({ dir });
    await adapter.append({
      v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: { note: 'one\ntwo\nthree' },
    });
    expect(rawLines()).toHaveLength(1);
    expect((await adapter.readAll())[0].checkpoint.note).toBe('one\ntwo\nthree');
  });

  it('honours an injected fileName', async () => {
    const adapter = createFileStoreAdapter({ dir, fileName: 'other.jsonl' });
    await adapter.append({ v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: {} });
    expect(existsSync(filePath('other.jsonl'))).toBe(true);
    expect(existsSync(filePath())).toBe(false);
  });

  it('creates the directory when it does not exist yet', async () => {
    const nested = path.join(dir, 'deep', 'artibot');
    const adapter = createFileStoreAdapter({ dir: nested });
    await adapter.append({ v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: {} });
    expect(existsSync(path.join(nested, 'checkpoints.jsonl'))).toBe(true);
  });

  it('refuses construction without a dir, because the location is injected, never guessed', () => {
    expect(() => createFileStoreAdapter({})).toThrow(/dir/);
    expect(() => createFileStoreAdapter({ dir: '' })).toThrow(/dir/);
  });
});

describe('torn lines', () => {
  it('skips a torn last line and keeps every line before it', async () => {
    const adapter = createFileStoreAdapter({ dir });
    await adapter.append({ v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: {} });
    await adapter.append({ v: 1, checkpoint_id: 'b', mission_id: 'M', ts: 't', checkpoint: {} });
    // The shape a crash mid-append leaves behind: a half-written tail.
    appendFileSync(filePath(), '{"v":1,"checkpoint_id":"c","mis', { flag: 'a' });

    const records = await adapter.readAll();
    expect(records.map((r) => r.checkpoint_id)).toEqual(['a', 'b']);
    const census = await adapter.census();
    expect(census.dropped.torn).toBe(1);
    expect(census.survivors).toBe(2);
  });

  it('skips a torn line in the middle without losing the line after it', async () => {
    writeFileSync(
      filePath(),
      `${JSON.stringify({ v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: {} })}\n`
      + '{"broken"\n'
      + `${JSON.stringify({ v: 1, checkpoint_id: 'c', mission_id: 'M', ts: 't', checkpoint: {} })}\n`,
      'utf-8',
    );
    const adapter = createFileStoreAdapter({ dir });
    expect((await adapter.readAll()).map((r) => r.checkpoint_id)).toEqual(['a', 'c']);
    expect((await adapter.census()).dropped.torn).toBe(1);
  });

  it('drops a line that parses but is not an object, so the fold never sees a scalar', async () => {
    writeFileSync(filePath(), '42\n"a string"\nnull\n', 'utf-8');
    const adapter = createFileStoreAdapter({ dir });
    expect(await adapter.readAll()).toEqual([]);
    expect((await adapter.census()).dropped.torn).toBe(3);
  });

  it('ignores blank lines without counting them as torn', async () => {
    writeFileSync(
      filePath(),
      `\n${JSON.stringify({ v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: {} })}\n\n`,
      'utf-8',
    );
    const adapter = createFileStoreAdapter({ dir });
    expect(await adapter.readAll()).toHaveLength(1);
    expect((await adapter.census()).dropped.torn).toBe(0);
  });

  it('reports the path it counted, so a census over some other file cannot satisfy this', async () => {
    const adapter = createFileStoreAdapter({ dir });
    await adapter.append({ v: 1, checkpoint_id: 'a', mission_id: 'M', ts: 't', checkpoint: {} });
    expect((await adapter.census()).file.path).toBe(filePath());
  });
});

/**
 * The child program. Saves `LINES_PER_PROCESS` checkpoints through the real
 * store as fast as it can, so the copies overlap rather than take turns.
 * @type {string}
 */
const CHILD_SOURCE = `
import { createCheckpointStore } from ${JSON.stringify(STORE_MODULE)};
import { createFileStoreAdapter } from ${JSON.stringify(ADAPTER_MODULE)};

const [dir, label] = process.argv.slice(2);
const store = createCheckpointStore({ adapter: createFileStoreAdapter({ dir }) });
let written = 0;
for (let i = 0; i < ${LINES_PER_PROCESS}; i += 1) {
  await store.save({
    mission_id: 'M-20260912-001',
    phase: 'build',
    label,
    seq: i,
    tasks: [{ id: 'T-' + i, status: 'done' }],
  });
  written += 1;
}
process.stdout.write(String(written));
`;

/**
 * Run one child to completion.
 * @param {string} script - Absolute path to the child program.
 * @param {string} label - Child identity, embedded in every record it writes.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Child result.
 */
function runChild(script, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, dir, label], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('concurrent append across real processes', () => {
  const expected = PROCESSES * LINES_PER_PROCESS;

  it(`keeps ${expected} of ${expected} records written by ${PROCESSES} processes`, async () => {
    const script = path.join(dir, 'append-child.mjs');
    writeFileSync(script, CHILD_SOURCE, 'utf-8');

    const results = await Promise.all(
      Array.from({ length: PROCESSES }, (unused, i) => runChild(script, `p${i}`)),
    );
    for (const r of results) {
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(String(LINES_PER_PROCESS));
    }

    // (1) Nothing was lost.
    const lines = rawLines();
    expect(lines).toHaveLength(expected);

    // (2) Nothing was torn: every line parses on its own.
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(expected);

    // (3) Every checkpoint_id is distinct across processes.
    expect(new Set(parsed.map((r) => r.checkpoint_id)).size).toBe(expected);

    // (4) Each process contributed a complete, gapless 0..19 run.
    const byLabel = new Map();
    for (const r of parsed) {
      const label = r.checkpoint.label;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(r.checkpoint.seq);
    }
    expect(byLabel.size).toBe(PROCESSES);
    for (const seqs of byLabel.values()) {
      expect([...seqs].sort((a, b) => a - b))
        .toEqual(Array.from({ length: LINES_PER_PROCESS }, (unused, i) => i));
    }

    // (5) The adapter's own reader agrees with the raw file and reports no loss.
    const adapter = createFileStoreAdapter({ dir });
    expect(await adapter.readAll()).toHaveLength(expected);
    const census = await adapter.census();
    expect(census.dropped.torn).toBe(0);
    expect(census.survivors).toBe(expected);
  });

  it('records stay small, which is the only size the atomicity claim covers', async () => {
    const store = createCheckpointStore({ adapter: createFileStoreAdapter({ dir }) });
    await store.save(checkpoint({ label: 'p0', seq: 0, tasks: [{ id: 'T-0', status: 'done' }] }));
    const bytes = Buffer.byteLength(`${rawLines()[0]}\n`, 'utf8');
    // Pinned, not remembered: the header's "small records" claim is this number.
    // Well under the 4 KB line cap the ledger uses for the same reason.
    expect(bytes).toBeGreaterThan(100);
    expect(bytes).toBeLessThan(400);
  });
});
