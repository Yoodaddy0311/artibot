/**
 * Tests for lib/handoff/handoff-store.js
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _internals,
  listHandoffs,
  pruneHandoffs,
  readLatestHandoff,
  writeHandoff,
} from '../../lib/handoff/handoff-store.js';

const { POINTER_REL, ARCHIVE_DIR } = _internals;

function makeTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'handoff-store-'));
}

describe('handoff-store / writeHandoff', () => {
  let root;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates both HANDOFF.md pointer and an archive copy', async () => {
    const md = '# HANDOFF\n\nbody\n';
    const res = await writeHandoff(md, { projectRoot: root, now: () => new Date(2026, 4, 19, 12, 30) });

    expect(existsSync(path.join(root, POINTER_REL))).toBe(true);
    expect(existsSync(res.archivePath)).toBe(true);
    expect(readFileSync(res.latestPath, 'utf8')).toBe(md);
    expect(readFileSync(res.archivePath, 'utf8')).toBe(md);
  });

  it('rotates older archives when keep is exceeded', async () => {
    // Write 4 archives with distinct timestamps (minute apart). throttleMs=0
    // disables the v4.13.0 throttle so each write produces a fresh archive.
    for (let i = 0; i < 4; i += 1) {
      await writeHandoff(`# H${i}\n`, {
        projectRoot: root,
        keep: 99,
        throttleMs: 0,
        now: () => new Date(2026, 4, 19, 12, i, 0),
      });
    }
    let list = await listHandoffs(root);
    expect(list.length).toBe(4);

    // Now write one more with keep=2 → should prune down to 2 newest
    await writeHandoff('# H4\n', {
      projectRoot: root,
      keep: 2,
      throttleMs: 0,
      now: () => new Date(2026, 4, 19, 12, 4, 0),
    });
    list = await listHandoffs(root);
    expect(list.length).toBe(2);
    // Pointer is untouched
    expect(existsSync(path.join(root, POINTER_REL))).toBe(true);
  });

  it('appends -2 suffix on filename collision within the same minute', async () => {
    const stamp = () => new Date(2026, 4, 19, 12, 30, 0);
    const r1 = await writeHandoff('# A\n', { projectRoot: root, throttleMs: 0, now: stamp });
    const r2 = await writeHandoff('# B\n', { projectRoot: root, throttleMs: 0, now: stamp });

    expect(r1.archivePath).not.toBe(r2.archivePath);
    expect(path.basename(r2.archivePath)).toMatch(/-2\.md$/);
  });
});

describe('handoff-store / readLatestHandoff', () => {
  let root;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns null when pointer file is missing', async () => {
    const out = await readLatestHandoff(root);
    expect(out).toBeNull();
  });

  it('returns { path, content, mtime } when pointer exists', async () => {
    await writeHandoff('# X\n', { projectRoot: root, now: () => new Date(2026, 4, 19, 13, 0) });
    const out = await readLatestHandoff(root);
    expect(out).not.toBeNull();
    expect(out.content).toBe('# X\n');
    expect(out.path).toBe(path.join(root, POINTER_REL));
    expect(typeof out.mtime).toBe('number');
  });
});

describe('handoff-store / throttle (Safety #4)', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
    delete process.env.ARTIBOT_HANDOFF_THROTTLE_MS;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.ARTIBOT_HANDOFF_THROTTLE_MS;
  });

  it('throttle window: in-place overwrite when previous archive is within window', async () => {
    // 1st write at T+0
    const first = await writeHandoff('# v1\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000, // 10m
      now: () => new Date(2026, 4, 19, 12, 0, 0),
    });
    const listAfterFirst = await listHandoffs(root);
    expect(listAfterFirst.length).toBe(1);

    // 2nd write at T+5m → still inside the 10m window → throttle
    const second = await writeHandoff('# v2\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 5, 0),
    });
    expect(second.throttled).toBe(true);
    expect(second.pruned).toBe(0);
    expect(second.archivePath).toBe(first.archivePath);

    // Archive directory size unchanged; archive content matches latest
    const listAfterSecond = await listHandoffs(root);
    expect(listAfterSecond.length).toBe(1);
    expect(readFileSync(second.archivePath, 'utf8')).toBe('# v2\n');
    // Pointer always refreshed
    expect(readFileSync(second.latestPath, 'utf8')).toBe('# v2\n');
  });

  it('throttleMs=0 disables throttling — every call creates a fresh archive', async () => {
    const r1 = await writeHandoff('# a\n', {
      projectRoot: root,
      throttleMs: 0,
      now: () => new Date(2026, 4, 19, 12, 0, 0),
    });
    const r2 = await writeHandoff('# b\n', {
      projectRoot: root,
      throttleMs: 0,
      now: () => new Date(2026, 4, 19, 12, 1, 0),
    });
    expect(r1.throttled).toBe(false);
    expect(r2.throttled).toBe(false);
    expect(r1.archivePath).not.toBe(r2.archivePath);
    const list = await listHandoffs(root);
    expect(list.length).toBe(2);
  });

  it('empty archive dir: throttle has nothing to fold into → normal new-file path', async () => {
    const res = await writeHandoff('# fresh\n', {
      projectRoot: root,
      throttleMs: 10 * 60_000,
      now: () => new Date(2026, 4, 19, 12, 0, 0),
    });
    expect(res.throttled).toBe(false);
    expect(existsSync(res.archivePath)).toBe(true);
    const list = await listHandoffs(root);
    expect(list.length).toBe(1);
  });
});

describe('handoff-store / pruneHandoffs', () => {
  let root;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('keep=0 removes all archives but preserves pointer', async () => {
    for (let i = 0; i < 3; i += 1) {
      await writeHandoff(`# H${i}\n`, {
        projectRoot: root,
        keep: 99,
        throttleMs: 0,
        now: () => new Date(2026, 4, 19, 12, i, 0),
      });
    }
    const before = await listHandoffs(root);
    expect(before.length).toBe(3);
    expect(existsSync(path.join(root, POINTER_REL))).toBe(true);

    const result = await pruneHandoffs(root, { keep: 0 });
    expect(result.removed).toBe(3);

    const after = await listHandoffs(root);
    expect(after.length).toBe(0);
    // Pointer preserved
    expect(existsSync(path.join(root, POINTER_REL))).toBe(true);
    // Archive dir may still exist
    expect(existsSync(path.join(root, ARCHIVE_DIR))).toBe(true);
  });
});
