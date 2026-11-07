/**
 * Tests for the `now` option of lib/handoff/handoff-store.js#writeHandoff.
 *
 * `/save` (commands/save.md Phase B and C) hands the SAME `now` to
 * collectHandoffData and writeHandoff. collectHandoffData has accepted
 * function | number | Date since the asClock fix; writeHandoff only accepted a
 * function and threw `TypeError: now is not a function` on a Date (observed
 * 2026-11-08 02:39 by the leader, before any write). Each case asserts the
 * value is HONORED — the archive name carries the caller's minute and the
 * archive mtime is the caller's instant — not merely that nothing throws,
 * because a silent fallback to the wall clock would not throw either.
 *
 * Kept apart from handoff-store.test.js only to hold that file under the
 * 800-line ceiling.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeHandoff } from '../../lib/handoff/handoff-store.js';

/** exec stub that behaves like a host with no git binary — keeps the suite hermetic. */
function noGitExec() {
  throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
}

describe('handoff-store / writeHandoff now normalization', () => {
  let root;
  const AT = new Date(2026, 4, 19, 12, 30, 0);

  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'handoff-now-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const write = (now) => writeHandoff('# now\n', { projectRoot: root, exec: noGitExec, now });

  it('honors a Date instance for the archive stamp and mtime', async () => {
    const res = await write(new Date(AT.getTime()));
    expect(path.basename(res.archivePath)).toBe('2026-05-19-1230.md');
    expect(Math.abs(statSync(res.archivePath).mtimeMs - AT.getTime())).toBeLessThan(1000);
  });

  it('honors an epoch-ms number for the archive stamp and mtime', async () => {
    const res = await write(AT.getTime());
    expect(path.basename(res.archivePath)).toBe('2026-05-19-1230.md');
    expect(Math.abs(statSync(res.archivePath).mtimeMs - AT.getTime())).toBeLessThan(1000);
  });

  it('still honors a clock function (existing contract)', async () => {
    const res = await write(() => new Date(AT.getTime()));
    expect(path.basename(res.archivePath)).toBe('2026-05-19-1230.md');
  });

  // Before the shared asClock, an invalid Date threw `now is not a function`.
  // Once Dates were accepted it slipped through and the store silently wrote
  // `.artibot/handoffs/NaN-NaN-NaN-NaNNaN.md` (inspector, 2026-11-08 03:20).
  // An unusable Date must take the same exit as a non-finite number: the wall
  // clock, so the archive keeps an orderable stamp name.
  it('falls back to the wall clock for an invalid Date (no NaN archive name)', async () => {
    const before = Date.now();
    const res = await write(new Date('not a date'));
    const after = Date.now();
    const name = path.basename(res.archivePath);
    expect(name).not.toMatch(/NaN/);
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.md$/);
    const mtime = statSync(res.archivePath).mtimeMs;
    expect(mtime).toBeGreaterThanOrEqual(before - 1000);
    expect(mtime).toBeLessThanOrEqual(after + 1000);
  });

  it('falls back to the wall clock when now is omitted', async () => {
    const before = Date.now();
    const res = await write(undefined);
    const after = Date.now();
    const mtime = statSync(res.archivePath).mtimeMs;
    expect(mtime).toBeGreaterThanOrEqual(before - 1000);
    expect(mtime).toBeLessThanOrEqual(after + 1000);
  });
});
