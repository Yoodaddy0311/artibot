/**
 * M8 (2026-11-21): `lib/genesis/_shared.js#atomicWriteText` was a copy of the
 * planning layer's private writer — one `fs.rename`, no retry — while the
 * canonical `lib/core/file.js#atomicWriteText` retries a transient Windows
 * destination lock (EPERM/EBUSY/EACCES). Every genesis renderer
 * (tree/flow/dataset/index/scaffold) writes through `_shared`, so a single
 * antivirus/indexer handle on the target failed the whole blueprint write.
 *
 * @module tests/genesis/_shared-atomic-retry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWriteText } from '../../lib/genesis/_shared.js';
import { atomicWriteText as coreAtomicWriteText } from '../../lib/core/file.js';

function flakyAsyncRename(failures, code) {
  const real = fs.rename.bind(fs);
  let calls = 0;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    calls += 1;
    if (calls <= failures) {
      const err = new Error(`${code}: injected rename failure`);
      err.code = code;
      throw err;
    }
    return real(from, to);
  });
  return { count: () => calls };
}

describe('genesis _shared.atomicWriteText retries like the core writer', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), '제네시스 retry-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('is the core writer, not a second copy', () => {
    expect(atomicWriteText).toBe(coreAtomicWriteText);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('survives one transient %s on rename', async (code) => {
    const { count } = flakyAsyncRename(1, code);
    const target = path.join(root, 'docs', 'out.md');
    await atomicWriteText(target, '청사진 body');
    expect(count()).toBe(2);
    expect(readFileSync(target, 'utf-8')).toBe('청사진 body');
    expect(readdirSync(path.dirname(target)).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});
