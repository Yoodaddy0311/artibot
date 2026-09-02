/**
 * Checkpoint persistence must not lose entries under cross-process concurrency.
 *
 * `persistCheckpoint` used to read the whole store, append one entry, and write
 * the whole store back. Two processes interleaving that sequence both start
 * from the same snapshot, so the second write erases the first one's entry.
 * This middleware sits in the DEFAULT pipeline, so every prompt in every window
 * runs it — the collision is routine, not exotic.
 *
 * The race is between PROCESSES, not between promises: a single-process async
 * loop cannot reproduce it, because `persistCheckpoint` awaits to completion
 * before the next call starts. So this file forks real `node` children.
 *
 * FIXTURE MUST REACH THE FAILURE REGION:
 *   - `maxEntries` is far above the write count, so a short count means writes
 *     were LOST, never that the cap trimmed them.
 *   - children are started together and each writes repeatedly, so their
 *     read-modify-write windows actually overlap. The barrier assertion below
 *     fails the suite if the children did not in fact run concurrently.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCheckpoints } from '../../../lib/runtime/middleware/checkpoint.js';

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROCESSES = 6;
const WRITES_PER_PROCESS = 10;
const EXPECTED = PROCESSES * WRITES_PER_PROCESS;

let dir = '';
let filePath = '';

/**
 * Source for one child: run the real middleware `WRITES_PER_PROCESS` times
 * against the shared file. No sleeps — the children are already interleaved by
 * the scheduler, and a sleep would only widen a window that is already open.
 *
 * @param {string} target - shared checkpoints file
 * @returns {string} ESM source
 */
function childSource(target) {
  return `
    import { createCheckpointMiddleware } from ${JSON.stringify(
    // Must be a file:// URL: a bare Windows path is rejected by the ESM loader
    // (ERR_UNSUPPORTED_ESM_URL_SCHEME), and this repo's path contains
    // non-ASCII characters that only survive proper URL encoding.
    pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'runtime', 'middleware', 'checkpoint.js')).href,
  )};
    const mw = createCheckpointMiddleware({
      filePath: ${JSON.stringify(target)},
      maxEntries: 10000,
    });
    const state = () => ({
      messageParts: [],
      context: {
        routing: { system: 'system1', score: 0.1 },
        intent: { best: 'action:test' },
        tasks: { mode: 'subAgent', id: 'rt-conc' },
        subagents: { contract: { mode: 'subAgent' } },
      },
    });
    for (let i = 0; i < ${WRITES_PER_PROCESS}; i++) await mw(state());
  `;
}

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-ckpt-conc-'));
  filePath = path.join(dir, 'checkpoints.json');
});

afterEach(() => {
  try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('checkpoint persistence under cross-process concurrency', () => {
  it(`keeps all ${EXPECTED} entries when ${PROCESSES} processes write at once`, async () => {
    const children = Array.from({ length: PROCESSES }, () =>
      execFileAsync(process.execPath, ['--input-type=module', '-e', childSource(filePath)], {
        cwd: PLUGIN_ROOT,
        windowsHide: true,
      }));

    const settled = await Promise.allSettled(children);
    const failed = settled.filter((r) => r.status === 'rejected');
    // A child that crashed would under-count for the wrong reason — that would
    // look identical to a lost update. Fail loudly instead.
    expect(failed.map((f) => String(f.reason).slice(0, 300))).toEqual([]);

    const entries = readCheckpoints(filePath);
    expect(entries).toHaveLength(EXPECTED);

    // Every entry must be intact and distinct: a torn or interleaved write
    // would show up as a duplicate id or an unparseable record.
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.size).toBe(EXPECTED);
    for (const e of entries) {
      expect(e.id).toMatch(/^ckpt-/);
      expect(e.taskId).toBe('rt-conc');
    }
  }, 60_000);

  it('applies the entry cap at read time without discarding on write', async () => {
    await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', childSource(filePath)],
      { cwd: PLUGIN_ROOT, windowsHide: true },
    );

    // All 10 are on disk...
    expect(readCheckpoints(filePath)).toHaveLength(WRITES_PER_PROCESS);
    // ...and the cap is a read-side view, newest-last.
    const capped = readCheckpoints(filePath, { tail: 3 });
    expect(capped).toHaveLength(3);
    expect(capped).toEqual(readCheckpoints(filePath).slice(-3));
  }, 60_000);
});
