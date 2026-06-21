/**
 * Tests for the genesis file-tree generator (renderFileTree / writeFileTree).
 * @module tests/genesis/tree-gen
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderFileTree, writeFileTree } from '../../lib/genesis/tree-gen.js';

const FIXED = new Date(2026, 5, 21, 9, 5); // 2026-06-21 09:05 local
const fixedNow = () => FIXED;

// Korean-path-safe temp root (contains a non-ASCII segment to mirror prod).
function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), '제네시스-tree-'));
}

const TREE = {
  name: 'app',
  children: [
    { name: 'src', note: '소스 코드', children: [
      { name: 'index.js', note: '진입점' },
      { name: 'lib', children: [{ name: 'util.js' }] },
    ] },
    { name: 'README.md' },
  ],
};

describe('tree-gen / renderFileTree', () => {
  it('renders a code-fenced ASCII tree with branch glyphs', () => {
    const md = renderFileTree(TREE);
    expect(md).toContain('```text');
    expect(md).toContain('app/');
    expect(md).toContain('├── src/');
    expect(md).toContain('└── README.md');
    expect(md).toContain('│   ├── index.js');
    expect(md).toContain('# 진입점'); // inline note
  });

  it('renders a directory-responsibility table for noted dirs only', () => {
    const md = renderFileTree(TREE);
    expect(md).toContain('| 디렉터리 | 책임 |');
    expect(md).toContain('| `src/` | 소스 코드 |');
    // lib/ has no note → not a table row
    expect(md).not.toContain('| `src/lib/` |');
  });

  it('accepts an array of top-level entries', () => {
    const md = renderFileTree([{ name: 'a.txt' }, { name: 'b', children: [] }]);
    expect(md).toContain('├── a.txt');
    expect(md).toContain('└── b/');
  });

  it('tolerates empty / missing input', () => {
    expect(renderFileTree(undefined)).toContain('# FILE-TREE');
    expect(renderFileTree([])).toContain('## 파일트리');
  });

  it('falls back to (unnamed) and . root labels, and (없음) table', () => {
    const md = renderFileTree({ children: [{ children: [] }] });
    // root node has no name → "./" ; nested dir has no name → "(unnamed)/"
    expect(md).toContain('./');
    expect(md).toContain('└── (unnamed)/');
    // no noted dirs → empty-table placeholder
    expect(md).toContain('_(없음)_');
  });

  it('treats a bare primitive root as no entries', () => {
    const md = renderFileTree('nope');
    expect(md).toContain('# FILE-TREE');
  });
});

describe('tree-gen / writeFileTree', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes docs/FILE-TREE.md with the rendered tree + stamp', async () => {
    const res = await writeFileTree({ projectRoot: root, tree: TREE, now: fixedNow });
    expect(res.ok).toBe(true);
    expect(res.treePath).toBe(path.join(root, 'docs', 'FILE-TREE.md'));
    expect(existsSync(res.treePath)).toBe(true);

    const body = readFileSync(res.treePath, 'utf-8');
    expect(body).toContain('app/');
    expect(body).toContain('| `src/` | 소스 코드 |');
    expect(body).toContain('생성: 2026-06-21 09:05');
  });

  it('non-collision: second write gets a -2 suffix (prior survives)', async () => {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'FILE-TREE.md'), 'pre-existing', 'utf-8');

    const res = await writeFileTree({ projectRoot: root, tree: TREE, now: fixedNow });
    expect(res.ok).toBe(true);
    expect(res.treePath).toBe(path.join(root, 'docs', 'FILE-TREE-2.md'));

    // original untouched
    expect(readFileSync(path.join(root, 'docs', 'FILE-TREE.md'), 'utf-8')).toBe('pre-existing');
    const files = readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(['FILE-TREE-2.md', 'FILE-TREE.md']);
  });

  it('returns {ok:false} when projectRoot missing', async () => {
    const res = await writeFileTree({ tree: TREE });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/projectRoot/);
  });
});
