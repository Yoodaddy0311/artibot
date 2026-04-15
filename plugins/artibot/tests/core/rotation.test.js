import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pruneByMaxEntries,
  rotateJsonArray,
  rotatePatternFiles,
} from '../../lib/core/rotation.js';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-rot-'));
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function write(p, data) {
  writeFileSync(p, JSON.stringify(data));
}

describe('rotateJsonArray/safety', () => {
  it('파일 없음 → no-op (rotated:false)', () => {
    const r = rotateJsonArray(path.join(tmpDir, 'missing.json'), { maxEntries: 5 });
    expect(r.rotated).toBe(false);
    expect(r.before).toBe(0);
    expect(r.after).toBe(0);
  });

  it('지원하지 않는 shape → unsupported-shape error', () => {
    const p = path.join(tmpDir, 'weird.json');
    write(p, { foo: 'not-array', no_entries: true });
    const r = rotateJsonArray(p, { maxEntries: 3 });
    expect(r.rotated).toBe(false);
    expect(r.error).toBe('unsupported-shape');
  });
});

describe('rotateJsonArray/maxEntries', () => {
  it('maxEntries보다 적으면 no-op', () => {
    const p = path.join(tmpDir, 'a.json');
    write(p, [{ id: 1 }, { id: 2 }]);
    const r = rotateJsonArray(p, { maxEntries: 5 });
    expect(r.rotated).toBe(false);
    expect(r.before).toBe(2);
    expect(r.after).toBe(2);
  });

  it('초과분 잘라내고 마지막 N개 유지', () => {
    const p = path.join(tmpDir, 'a.json');
    write(p, [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id })));
    const r = rotateJsonArray(p, { maxEntries: 3 });
    expect(r.rotated).toBe(true);
    expect(r.before).toBe(7);
    expect(r.after).toBe(3);
    expect(r.removed).toBe(4);
    const after = JSON.parse(readFileSync(p, 'utf-8'));
    expect(after.map((e) => e.id)).toEqual([5, 6, 7]);
  });

  it('object shape with entries 배열 지원', () => {
    const p = path.join(tmpDir, 'log.json');
    write(p, { entries: [1, 2, 3, 4].map((id) => ({ id })) });
    const r = rotateJsonArray(p, { maxEntries: 2 });
    expect(r.after).toBe(2);
    const after = JSON.parse(readFileSync(p, 'utf-8'));
    expect(after.entries).toHaveLength(2);
  });
});

describe('rotateJsonArray/maxAgeDays', () => {
  it('나이 초과 entry 제거', () => {
    const p = path.join(tmpDir, 'log.json');
    const now = Date.now();
    const day = 86400000;
    write(p, [
      { id: 1, timestamp: now - 60 * day },
      { id: 2, timestamp: now - 5 * day },
      { id: 3, timestamp: now - 1 * day },
    ]);
    const r = rotateJsonArray(p, { maxAgeDays: 30 });
    expect(r.removed).toBe(1);
    const after = JSON.parse(readFileSync(p, 'utf-8'));
    expect(after.map((e) => e.id)).toEqual([2, 3]);
  });

  it('ISO string timestamp도 지원', () => {
    const p = path.join(tmpDir, 'log.json');
    const oldIso = new Date(Date.now() - 60 * 86400000).toISOString();
    const newIso = new Date().toISOString();
    write(p, [{ timestamp: oldIso }, { timestamp: newIso }]);
    const r = rotateJsonArray(p, { maxAgeDays: 30 });
    expect(r.removed).toBe(1);
  });

  it('timestampField 지정', () => {
    const p = path.join(tmpDir, 'log.json');
    const now = Date.now();
    write(p, [
      { id: 1, injectedAt: now - 100 * 86400000 },
      { id: 2, injectedAt: now },
    ]);
    const r = rotateJsonArray(p, { maxAgeDays: 90, timestampField: 'injectedAt' });
    expect(r.removed).toBe(1);
  });

  it('timestamp 없는 entry는 보존 (안전 기본값)', () => {
    const p = path.join(tmpDir, 'log.json');
    write(p, [{ id: 1 }, { id: 2 }]);
    const r = rotateJsonArray(p, { maxAgeDays: 30 });
    expect(r.removed).toBe(0);
  });
});

describe('rotatePatternFiles', () => {
  it('디렉토리 없음 → no-op', () => {
    const r = rotatePatternFiles(path.join(tmpDir, 'nonexist'));
    expect(r.scanned).toBe(0);
    expect(r.deleted).toEqual([]);
  });

  it('패턴 매칭 안 되는 파일은 무시', () => {
    writeFileSync(path.join(tmpDir, 'random.json'), '{}');
    writeFileSync(path.join(tmpDir, 'auto-learn-2026-04-15.json'), '{}');
    const r = rotatePatternFiles(tmpDir, { maxAgeDays: 0 });
    expect(r.scanned).toBe(1);
  });

  it('namePattern 커스터마이징', () => {
    writeFileSync(path.join(tmpDir, 'session-2026-04-15.json'), '{}');
    const r = rotatePatternFiles(tmpDir, {
      maxAgeDays: 0,
      namePattern: /^session-\d{4}-\d{2}-\d{2}\.json$/,
    });
    expect(r.scanned).toBe(1);
  });
});

describe('pruneByMaxEntries', () => {
  it('편의 wrapper 동작', () => {
    const p = path.join(tmpDir, 'a.json');
    write(p, [1, 2, 3, 4].map((id) => ({ id })));
    const r = pruneByMaxEntries(p, 2);
    expect(r.after).toBe(2);
  });
});
