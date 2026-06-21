/**
 * Tests for the genesis dataset generator (renderDatasets / writeDatasets),
 * including the SCHEMA-ONLY data-leakage gate (DATA POLICY).
 * @module tests/genesis/dataset-gen
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

import { renderDatasets, writeDatasets } from '../../lib/genesis/dataset-gen.js';

const FIXED = new Date(2026, 5, 21, 9, 5);
const fixedNow = () => FIXED;

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), '제네시스-data-'));
}

const SCHEMAS = [
  {
    entity: 'User',
    fields: [
      { name: 'id', type: 'uuid', constraints: ['PK', 'NOT NULL'], desc: '식별자' },
      { name: 'email', type: 'string', constraints: 'UNIQUE', desc: '이메일' },
    ],
    relations: [{ type: '1:N', target: 'Order', via: 'user_id', desc: '주문 보유' }],
  },
  {
    entity: 'Order',
    fields: [{ name: 'id', type: 'uuid', constraints: 'PK' }],
  },
];

// A unique sentinel string that only appears inside fake "real data" payloads.
// If the renderer ever leaks a data value, this token shows up in output.
const DATA_SENTINEL = ['data', 'leak', 'sentinel', 'zzx91'].join('-');

describe('dataset-gen / renderDatasets', () => {
  it('renders entity summary + field tables + relations', () => {
    const md = renderDatasets(SCHEMAS);
    expect(md).toContain('| 엔티티 | 필드 수 | 관계 수 |');
    expect(md).toContain('| `User` | 2 | 1 |');
    expect(md).toContain('### `User`');
    expect(md).toContain('| 필드 | 타입 | 제약 | 설명 |');
    expect(md).toContain('| id | uuid | PK, NOT NULL | 식별자 |');
    expect(md).toContain('| email | string | UNIQUE | 이메일 |');
    expect(md).toContain('**1:N** → `Order` (via `user_id`) — 주문 보유');
  });

  it('declares schema-only intent in the header', () => {
    const md = renderDatasets(SCHEMAS);
    expect(md).toContain('실데이터 0건');
  });

  it('tolerates empty / missing input', () => {
    expect(renderDatasets(undefined)).toContain('# DATASETS');
    expect(renderDatasets([])).toContain('스키마가 제공되지 않음');
  });

  it('renders string relations, no-field and no-relation entities', () => {
    const md = renderDatasets([
      { entity: 'Bare' }, // no fields, no relations
      { entity: 'Note', fields: [], relations: ['User 1:N (자유 서술)'] },
    ]);
    // empty-field placeholder
    expect(md).toContain('필드 정의가 제공되지 않음');
    // no-relation placeholder for Bare
    expect(md).toContain('관계 없음');
    // string relation rendered verbatim as a bullet
    expect(md).toContain('- User 1:N (자유 서술)');
  });

  // ---- SCHEMA-ONLY GATE (DATA POLICY, code-enforced) ----
  it('NEVER emits actual data values even when rows/sample data are present', () => {
    const polluted = [
      {
        entity: 'User',
        fields: [{ name: 'email', type: 'string', constraints: 'UNIQUE', desc: '이메일' }],
        // Deliberately smuggle fake "real data" — must be ignored entirely.
        rows: [
          { email: DATA_SENTINEL, note: `${DATA_SENTINEL}-row1` },
          { email: `${DATA_SENTINEL}-row2` },
        ],
        sample: { email: DATA_SENTINEL },
        data: [DATA_SENTINEL],
      },
    ];
    const md = renderDatasets(polluted);
    // Schema metadata still present...
    expect(md).toContain('| email | string | UNIQUE | 이메일 |');
    // ...but ZERO data values leak.
    expect(md).not.toContain(DATA_SENTINEL);
  });
});

describe('dataset-gen / writeDatasets', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes docs/DATASETS.md with rendered schema + stamp', async () => {
    const res = await writeDatasets({ projectRoot: root, schemas: SCHEMAS, now: fixedNow });
    expect(res.ok).toBe(true);
    expect(res.datasetsPath).toBe(path.join(root, 'docs', 'DATASETS.md'));
    expect(existsSync(res.datasetsPath)).toBe(true);
    const body = readFileSync(res.datasetsPath, 'utf-8');
    expect(body).toContain('### `User`');
    expect(body).toContain('생성: 2026-06-21 09:05');
  });

  it('schema-only gate holds through the write path (no data on disk)', async () => {
    const res = await writeDatasets({
      projectRoot: root,
      schemas: [{
        entity: 'Token',
        fields: [{ name: 'value', type: 'string', desc: '토큰' }],
        rows: [{ value: DATA_SENTINEL }],
      }],
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    const body = readFileSync(res.datasetsPath, 'utf-8');
    expect(body).toContain('| value | string |  | 토큰 |');
    expect(body).not.toContain(DATA_SENTINEL);
  });

  it('non-collision: second write gets a -2 suffix (prior survives)', async () => {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'DATASETS.md'), 'pre-existing', 'utf-8');

    const res = await writeDatasets({ projectRoot: root, schemas: SCHEMAS, now: fixedNow });
    expect(res.datasetsPath).toBe(path.join(root, 'docs', 'DATASETS-2.md'));
    expect(readFileSync(path.join(root, 'docs', 'DATASETS.md'), 'utf-8')).toBe('pre-existing');
    const files = readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(['DATASETS-2.md', 'DATASETS.md']);
  });

  it('returns {ok:false} when projectRoot missing', async () => {
    const res = await writeDatasets({ schemas: SCHEMAS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/projectRoot/);
  });
});
