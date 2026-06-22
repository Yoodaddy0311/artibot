/**
 * Tests for the genesis docs-index generator (renderDocsIndex / writeDocsIndex).
 * @module tests/genesis/index-gen
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

import { renderDocsIndex, writeDocsIndex } from '../../lib/genesis/index-gen.js';

const FIXED = new Date(2026, 5, 21, 9, 5); // 2026-06-21 09:05 local
const fixedNow = () => FIXED;

// Korean-path-safe temp root (contains a non-ASCII segment to mirror prod).
function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), '제네시스-index-'));
}

const DOCS = [
  { name: 'PRD', path: 'docs/PRD/my-app.md', status: 'generated', description: '제품 요구사항' },
  { name: 'ARCHITECTURE', path: 'docs/ARCHITECTURE.md', status: 'stub', description: '구조 골격' },
  { name: 'API-SPEC', path: 'docs/API-SPEC.md', status: 'pending', description: 'API 명세 (예정)' },
];

describe('index-gen / renderDocsIndex', () => {
  it('renders a status legend with all three labels', () => {
    const md = renderDocsIndex(DOCS);
    expect(md).toContain('## 상태 범례');
    expect(md).toContain('🟢 **generated**');
    expect(md).toContain('🟡 **stub**');
    expect(md).toContain('⚫ **pending**');
  });

  it('renders one tracking-table row per doc with the right status emoji', () => {
    const md = renderDocsIndex(DOCS);
    expect(md).toContain('| 상태 | 문서 | 경로 | 설명 |');
    expect(md).toContain('| 🟢 generated | PRD | `docs/PRD/my-app.md` | 제품 요구사항 |');
    expect(md).toContain('| 🟡 stub | ARCHITECTURE | `docs/ARCHITECTURE.md` | 구조 골격 |');
    expect(md).toContain('| ⚫ pending | API-SPEC | `docs/API-SPEC.md` | API 명세 (예정) |');
  });

  it('defaults unknown/missing status to pending (⚫)', () => {
    const md = renderDocsIndex([
      { name: 'X', path: 'docs/x.md' }, // no status
      { name: 'Y', path: 'docs/y.md', status: 'bogus' }, // unrecognized
    ]);
    expect(md).toContain('| ⚫ pending | X | `docs/x.md` |');
    expect(md).toContain('| ⚫ pending | Y | `docs/y.md` |');
  });

  it('is case-insensitive and trims the status token', () => {
    const md = renderDocsIndex([{ name: 'Z', path: 'docs/z.md', status: '  GENERATED ' }]);
    expect(md).toContain('| 🟢 generated | Z | `docs/z.md` |');
  });

  it('escapes pipes in free text so the table stays well-formed', () => {
    const md = renderDocsIndex([
      { name: 'P', path: 'docs/p.md', status: 'generated', description: 'a | b | c' },
    ]);
    expect(md).toContain('a \\| b \\| c');
  });

  it('renders an empty-table placeholder when no docs are provided', () => {
    const md = renderDocsIndex([]);
    expect(md).toContain('# DOCS-INDEX');
    expect(md).toContain('| ⚫ pending | _(없음)_ | _(없음)_ |');
  });

  it('tolerates missing / non-array input', () => {
    expect(renderDocsIndex(undefined)).toContain('# DOCS-INDEX');
    expect(renderDocsIndex('nope')).toContain('## 상태 범례');
  });

  it('falls back to (unnamed) name and (없음) path on a malformed entry', () => {
    const md = renderDocsIndex([{ status: 'generated' }]); // no name, no path
    expect(md).toContain('| 🟢 generated | (unnamed) | _(없음)_ |');
  });
});

describe('index-gen / writeDocsIndex', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes docs/DOCS-INDEX.md with the rendered index + stamp', async () => {
    const res = await writeDocsIndex({ projectRoot: root, docs: DOCS, now: fixedNow });
    expect(res.ok).toBe(true);
    expect(res.indexPath).toBe(path.join(root, 'docs', 'DOCS-INDEX.md'));
    expect(existsSync(res.indexPath)).toBe(true);

    const body = readFileSync(res.indexPath, 'utf-8');
    expect(body).toContain('# DOCS-INDEX');
    expect(body).toContain('| 🟢 generated | PRD | `docs/PRD/my-app.md` | 제품 요구사항 |');
    expect(body).toContain('생성: 2026-06-21 09:05');
  });

  it('non-collision: second write gets a -2 suffix (prior survives)', async () => {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'DOCS-INDEX.md'), 'pre-existing', 'utf-8');

    const res = await writeDocsIndex({ projectRoot: root, docs: DOCS, now: fixedNow });
    expect(res.ok).toBe(true);
    expect(res.indexPath).toBe(path.join(root, 'docs', 'DOCS-INDEX-2.md'));

    // original untouched
    expect(readFileSync(path.join(root, 'docs', 'DOCS-INDEX.md'), 'utf-8')).toBe('pre-existing');
    const files = readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(['DOCS-INDEX-2.md', 'DOCS-INDEX.md']);
  });

  it('returns {ok:false} when projectRoot missing', async () => {
    const res = await writeDocsIndex({ docs: DOCS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/projectRoot/);
  });

  it('writes an empty-state index when docs is omitted', async () => {
    const res = await writeDocsIndex({ projectRoot: root, now: fixedNow });
    expect(res.ok).toBe(true);
    const body = readFileSync(res.indexPath, 'utf-8');
    expect(body).toContain('문서 항목이 제공되지 않음');
  });
});
