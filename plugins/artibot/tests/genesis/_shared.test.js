/**
 * Tests for genesis shared fs/string helpers.
 * @module tests/genesis/_shared
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  atomicWriteText,
  cell,
  humanStamp,
  nonCollidingPath,
  resolveNow,
  slugify,
} from '../../lib/genesis/_shared.js';

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), '제네시스-shared-'));
}

describe('_shared / resolveNow', () => {
  it('accepts a function clock', () => {
    const d = new Date(2026, 0, 2, 3, 4);
    expect(resolveNow(() => d)).toBe(d);
  });
  it('accepts a Date directly', () => {
    const d = new Date(2026, 0, 2);
    expect(resolveNow(d)).toBe(d);
  });
  it('defaults to now() when omitted', () => {
    expect(resolveNow()).toBeInstanceOf(Date);
    expect(resolveNow('not-a-date')).toBeInstanceOf(Date);
  });
});

describe('_shared / humanStamp', () => {
  it('formats YYYY-MM-DD HH:MM with zero padding', () => {
    expect(humanStamp(new Date(2026, 5, 21, 9, 5))).toBe('2026-06-21 09:05');
    expect(humanStamp(new Date(2026, 11, 1, 0, 0))).toBe('2026-12-01 00:00');
  });
});

describe('_shared / slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });
  it('keeps unicode letters (Korean)', () => {
    expect(slugify('로그인 플로우')).toBe('로그인-플로우');
  });
  it('falls back to untitled for empty/garbage', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
    expect(slugify(null)).toBe('untitled');
  });
});

describe('_shared / cell', () => {
  it('escapes pipes and collapses newlines', () => {
    expect(cell('a|b')).toBe('a\\|b');
    expect(cell('line1\nline2')).toBe('line1 line2');
    expect(cell('  trim  ')).toBe('trim');
  });
  it('renders nullish as empty', () => {
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
    expect(cell(0)).toBe('0');
  });
});

describe('_shared / nonCollidingPath', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns base path when nothing exists', async () => {
    const p = await nonCollidingPath(root, 'FILE', '.md');
    expect(p).toBe(path.join(root, 'FILE.md'));
  });

  it('appends -2, then -3 as collisions accumulate', async () => {
    writeFileSync(path.join(root, 'FILE.md'), 'x', 'utf-8');
    const p2 = await nonCollidingPath(root, 'FILE', '.md');
    expect(p2).toBe(path.join(root, 'FILE-2.md'));

    writeFileSync(path.join(root, 'FILE-2.md'), 'x', 'utf-8');
    const p3 = await nonCollidingPath(root, 'FILE', '.md');
    expect(p3).toBe(path.join(root, 'FILE-3.md'));
  });
});

describe('_shared / atomicWriteText', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates parent dirs and writes content (no tmp left behind)', async () => {
    const target = path.join(root, 'a', 'b', 'out.md');
    await atomicWriteText(target, 'hello 한글');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('hello 한글');
    // no leftover *.tmp.* sibling
    const sib = path.join(root, 'a', 'b');
    const tmps = readdirSync(sib).filter((f) => f.includes('.tmp.'));
    expect(tmps).toHaveLength(0);
  });
});
