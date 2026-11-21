/**
 * M8 (2026-11-21): `lib/planning/artifacts.js` carried its own
 * `atomicWriteText` — tmp sibling + ONE `fs.rename`, no retry. The canonical
 * `lib/core/file.js#atomicWriteText` retries a transient Windows destination
 * lock (EPERM/EBUSY/EACCES). A PRD/ADR/INDEX write that met an antivirus or
 * indexer handle on the target therefore failed outright in the planning
 * layer while every other writer in the plugin rode it out.
 *
 * The rename spy injects exactly one transient failure; the write must land.
 *
 * @module tests/planning/artifacts-atomic-retry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writePRD } from '../../lib/planning/artifacts.js';

const FIXED = new Date(2026, 10, 21, 9, 0);

function flakyAsyncRename(failures, code) {
  const real = fs.rename.bind(fs);
  let calls = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    calls += 1;
    if (calls <= failures) {
      const err = new Error(`${code}: injected rename failure`);
      err.code = code;
      throw err;
    }
    return real(from, to);
  });
  return { spy, count: () => calls };
}

describe('artifacts atomic write uses the retrying core writer', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'artifacts-retry-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'writePRD survives one transient %s on rename',
    async (code) => {
      const { count } = flakyAsyncRename(1, code);
      const res = await writePRD({
        projectRoot: root,
        slug: 'retry-probe',
        title: 'Retry probe',
        sections: { 배경: 'b' },
        now: () => FIXED,
      });
      expect(res.error).toBeUndefined();
      expect(res.ok).toBe(true);
      // Denominator: the spy actually ran — 1 injected failure + 1 real rename.
      expect(count()).toBe(2);
      expect(readFileSync(res.prdPath, 'utf-8')).toContain('# PRD: Retry probe');
      const leftovers = readdirSync(path.dirname(res.prdPath)).filter((f) => f.includes('.tmp'));
      expect(leftovers).toEqual([]);
    }
  );

  it('a non-transient rename error still fails closed with no tmp dropping', async () => {
    flakyAsyncRename(Number.POSITIVE_INFINITY, 'ENOSPC');
    const res = await writePRD({
      projectRoot: root,
      slug: 'nospace',
      title: 'No space',
      sections: {},
      now: () => FIXED,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ENOSPC/);
    const dir = path.join(root, 'docs', 'PRD');
    const leftovers = existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('.tmp')) : [];
    expect(leftovers).toEqual([]);
  });
});
