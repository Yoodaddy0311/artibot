import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { backfillFile, backfillRecord } from '../../../lib/learning/grpo/backfill.js';

describe('backfillRecord (pure)', () => {
  it('returns null for non-object input', () => {
    expect(backfillRecord(null)).toBeNull();
    expect(backfillRecord(undefined)).toBeNull();
    expect(backfillRecord('str')).toBeNull();
    expect(backfillRecord(42)).toBeNull();
  });

  it('produces a finite reward and frozen-compatible components for a legacy episode', () => {
    const legacy = {
      id: 'ep-1',
      toolCalls: [{ exitCode: 0 }, { exitCode: 0 }],
      errors: 0,
      testPassRatio: 1,
      typecheckClean: true,
      userCorrections: 0,
      importanceScore: 0.8,
    };
    const scored = backfillRecord(legacy);
    expect(scored).not.toBeNull();
    expect(Number.isFinite(scored.reward)).toBe(true);
    expect(scored.reward).toBeGreaterThan(0);
    expect(scored).toHaveProperty('rewardComponents');
    expect(typeof scored.rewardComponents).toBe('object');
  });

  it('returns null when computeReward would throw on malformed data', () => {
    // Passing a value that trips schema validation should degrade to null, not throw.
    expect(() => backfillRecord({ toolCalls: 'not-an-array' })).not.toThrow();
  });
});

describe('backfillFile (disk)', () => {
  let dir;
  let filePath;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artibot-backfill-'));
    filePath = path.join(dir, 'episodes.json');
  });

  afterEach(async () => {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
  });

  it('returns zeroed report when the file does not exist', async () => {
    const report = await backfillFile({ filePath });
    expect(report.path).toBe(filePath);
    expect(report.total).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.corrupted).toBe(false);
    expect(report.dryRun).toBe(true);
  });

  it('flags corrupted JSON and writes a .corrupted.json backup', async () => {
    await fs.writeFile(filePath, '{not json', 'utf-8');
    const report = await backfillFile({ filePath, apply: true });
    expect(report.corrupted).toBe(true);
    expect(report.backupPath).toBe(`${filePath}.corrupted.json`);
    const backupExists = await fs.stat(report.backupPath).then(() => true, () => false);
    expect(backupExists).toBe(true);
    // Original is untouched when corrupted
    const original = await fs.readFile(filePath, 'utf-8');
    expect(original).toBe('{not json');
  });

  it('dry-run does not mutate the file even when records need backfill', async () => {
    const payload = {
      episodes: [
        { id: 'a', toolCalls: [{ exitCode: 0 }], errors: 0, testPassRatio: 1, typecheckClean: true, userCorrections: 0, importanceScore: 0.5 },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(payload), 'utf-8');
    const before = await fs.readFile(filePath, 'utf-8');
    const report = await backfillFile({ filePath, apply: false });
    expect(report.dryRun).toBe(true);
    expect(report.total).toBe(1);
    expect(report.updated).toBe(1);
    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(before);
  });

  it('apply persists rewards and is idempotent on a second run', async () => {
    const payload = {
      episodes: [
        { id: 'a', toolCalls: [{ exitCode: 0 }], errors: 0, testPassRatio: 1, typecheckClean: true, userCorrections: 0, importanceScore: 0.5 },
        { id: 'b', toolCalls: [{ exitCode: 0 }, { exitCode: 0 }], errors: 0, testPassRatio: 1, typecheckClean: true, userCorrections: 0, importanceScore: 0.7 },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(payload), 'utf-8');

    const first = await backfillFile({ filePath, apply: true });
    expect(first.updated).toBe(2);
    expect(first.skipped).toBe(0);

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    for (const ep of persisted.episodes) {
      expect(typeof ep.reward).toBe('number');
      expect(Number.isFinite(ep.reward)).toBe(true);
    }
    expect(typeof persisted.backfilledAt).toBe('string');

    const second = await backfillFile({ filePath, apply: true });
    expect(second.skipped).toBe(2);
    expect(second.updated).toBe(0);
  });

  it('preserves records whose reward is already a finite number', async () => {
    const payload = {
      episodes: [
        { id: 'x', reward: 0.42, rewardComponents: {}, toolCalls: [] },
        { id: 'y', toolCalls: [{ exitCode: 0 }], errors: 0, testPassRatio: 1, typecheckClean: true, userCorrections: 0, importanceScore: 0.5 },
      ],
    };
    await fs.writeFile(filePath, JSON.stringify(payload), 'utf-8');
    const report = await backfillFile({ filePath, apply: true });
    expect(report.skipped).toBe(1);
    expect(report.updated).toBe(1);
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(persisted.episodes[0].reward).toBe(0.42);
  });
});
