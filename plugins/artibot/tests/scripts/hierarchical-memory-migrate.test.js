import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  defaultMemoryDir,
  main,
  parseArgs,
  runApply,
  runDryRun,
  runRollback,
  runStatus,
  summarizeStore,
  timestamp,
} from '../../scripts/hierarchical-memory-migrate.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEGACY_FILES = [
  'user-preferences.json',
  'project-contexts.json',
  'command-history.json',
  'error-patterns.json',
];

async function mkTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-migrate-'));
  return dir;
}

function makeStore(entries, metadata = {}) {
  return { entries, metadata };
}

async function seedLegacy(dir, store = null) {
  await fs.mkdir(dir, { recursive: true });
  const payload = store ?? makeStore([
    { id: 'p1', type: 'preference', value: 'ko', occurrences: 4 },
    { id: 'c1', type: 'context', cwd: '/proj', lastUsedAt: new Date().toISOString() },
    { id: 'e1', type: 'error', pattern: 'ENOENT', occurrences: 2 },
    { id: 'cmd1', type: 'command', cmd: 'npm test' },
  ]);
  for (const name of LEGACY_FILES) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(payload, null, 2));
  }
}

function collector() {
  const lines = [];
  return { log: (msg) => lines.push(String(msg)), lines };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('picks a single mode', () => {
    expect(parseArgs(['--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--apply']).mode).toBe('apply');
    expect(parseArgs(['--status']).mode).toBe('status');
    expect(parseArgs(['--rollback']).mode).toBe('rollback');
  });

  it('rejects conflicting mode flags', () => {
    expect(() => parseArgs(['--dry-run', '--apply'])).toThrow(/conflicting/);
  });

  it('captures --memory-dir override', () => {
    const args = parseArgs(['--status', '--memory-dir', '/tmp/x']);
    expect(args.memoryDir).toBe('/tmp/x');
    expect(args.mode).toBe('status');
  });

  it('unknown flag throws', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/);
  });

  it('--help sets help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultMemoryDir + timestamp
// ---------------------------------------------------------------------------

describe('defaultMemoryDir / timestamp', () => {
  it('defaultMemoryDir ends with memory', () => {
    expect(defaultMemoryDir().endsWith(path.join('artibot', 'memory'))).toBe(true);
  });

  it('timestamp is filesystem-safe', () => {
    const ts = timestamp(0);
    expect(ts).not.toMatch(/[:.]/);
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// summarizeStore
// ---------------------------------------------------------------------------

describe('summarizeStore', () => {
  it('handles empty / null', () => {
    expect(summarizeStore(null).total).toBe(0);
    expect(summarizeStore({}).total).toBe(0);
    expect(summarizeStore({ entries: [] }).total).toBe(0);
  });

  it('counts layers and candidates', () => {
    const store = makeStore([
      { id: 'p1', type: 'preference', occurrences: 5 }, // promotion candidate
      { id: 'p2', type: 'preference', layer: 'semantic', lastUsedAt: '2025-01-01T00:00:00Z' }, // demotion
      { id: 'c1', type: 'context' },
    ]);
    const s = summarizeStore(store);
    expect(s.total).toBe(3);
    expect(s.byLayer.semantic).toBeGreaterThanOrEqual(1);
    expect(s.byLayer.episodic).toBeGreaterThanOrEqual(1);
    expect(s.promotionCandidates).toBe(1);
    expect(s.demotionCandidates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runDryRun — MUST NOT WRITE
// ---------------------------------------------------------------------------

describe('runDryRun', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkTempDir();
    await seedLegacy(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('produces reports without writing', async () => {
    const before = await fs.readdir(dir);
    const beforeContent = await fs.readFile(path.join(dir, LEGACY_FILES[0]), 'utf-8');
    const { log, lines } = collector();

    const out = await runDryRun({ memoryDir: dir, log });

    expect(out.ok).toBe(true);
    expect(out.reports.length).toBe(LEGACY_FILES.length);
    expect(lines.some((l) => l.includes('[dry-run]'))).toBe(true);
    expect(lines.some((l) => l.includes('no writes performed'))).toBe(true);

    // No new files appeared
    const after = await fs.readdir(dir);
    expect(after.sort()).toEqual(before.sort());
    // Content unchanged
    const afterContent = await fs.readFile(path.join(dir, LEGACY_FILES[0]), 'utf-8');
    expect(afterContent).toBe(beforeContent);
  });

  it('handles missing memory dir gracefully', async () => {
    const missing = path.join(dir, 'nope');
    const { log } = collector();
    const out = await runDryRun({ memoryDir: missing, log });
    expect(out.ok).toBe(true);
    expect(out.missing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runApply — idempotency + backup
// ---------------------------------------------------------------------------

describe('runApply', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkTempDir();
    await seedLegacy(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a backup and delegates to migrator', async () => {
    const { log } = collector();
    let calls = 0;
    const migrator = async ({ memoryDir }) => {
      calls += 1;
      return {
        totalTagged: 3,
        reports: [
          { file: path.join(memoryDir, LEGACY_FILES[0]), status: 'migrated', tagged: 3, total: 3 },
        ],
      };
    };

    const first = await runApply({ memoryDir: dir, log, migrator });
    expect(first.ok).toBe(true);
    expect(calls).toBe(1);
    expect(first.backup).toMatch(/backup-/);
    expect(await fs.stat(first.backup).then((s) => s.isDirectory())).toBe(true);
  });

  it('is idempotent — second apply produces 0 tagged', async () => {
    const { log } = collector();
    let tagged = 3;
    const migrator = async () => {
      const out = { totalTagged: tagged, reports: [] };
      tagged = 0; // second run returns 0 — idempotency
      return out;
    };

    const first = await runApply({ memoryDir: dir, log, migrator });
    const second = await runApply({ memoryDir: dir, log, migrator });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.result.totalTagged).toBe(3);
    expect(second.result.totalTagged).toBe(0);
  });

  it('aborts when migrator throws', async () => {
    const { log } = collector();
    const migrator = async () => {
      throw new Error('simulated failure');
    };
    const out = await runApply({ memoryDir: dir, log, migrator });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('migration-failed');
    // Backup still exists so we can recover
    expect(out.backup).toMatch(/backup-/);
  });
});

// ---------------------------------------------------------------------------
// runStatus — reports migratedAt + layer distribution
// ---------------------------------------------------------------------------

describe('runStatus', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkTempDir();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports migratedAt + layer counts', async () => {
    await seedLegacy(dir, makeStore(
      [
        { id: 'p1', type: 'preference', layer: 'semantic', migratedAt: '2026-04-24T02:00:00Z' },
        { id: 'c1', type: 'context', layer: 'episodic', migratedAt: '2026-04-24T02:00:00Z' },
      ],
      { migratedAt: '2026-04-24T02:00:00Z' }
    ));

    const { log, lines } = collector();
    const out = await runStatus({ memoryDir: dir, log });

    expect(out.ok).toBe(true);
    expect(out.reports.length).toBe(LEGACY_FILES.length);
    expect(out.reports[0].migratedAt).toBe('2026-04-24T02:00:00Z');
    expect(out.reports[0].byLayer.semantic).toBe(1);
    expect(out.reports[0].byLayer.episodic).toBe(1);
    expect(lines.some((l) => l.includes('migratedAt=2026-04-24T02:00:00Z'))).toBe(true);
  });

  it('gracefully handles missing dir', async () => {
    const missing = path.join(dir, 'nope');
    const { log } = collector();
    const out = await runStatus({ memoryDir: missing, log });
    expect(out.ok).toBe(true);
    expect(out.missing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runRollback — restores backup
// ---------------------------------------------------------------------------

describe('runRollback', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkTempDir();
    await seedLegacy(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('restores the latest backup', async () => {
    const { log } = collector();
    const migrator = async () => ({ totalTagged: 0, reports: [] });

    // 1) Snapshot original content.
    const originalPrefs = await fs.readFile(path.join(dir, 'user-preferences.json'), 'utf-8');

    // 2) Apply (creates backup).
    const applyOut = await runApply({ memoryDir: dir, log, migrator });
    expect(applyOut.ok).toBe(true);

    // 3) Simulate post-migration mutation.
    await fs.writeFile(
      path.join(dir, 'user-preferences.json'),
      JSON.stringify({ entries: [], metadata: { mutated: true } })
    );

    // 4) Rollback.
    const out = await runRollback({ memoryDir: dir, log });
    expect(out.ok).toBe(true);
    expect(out.backup).toMatch(/backup-/);

    // 5) Content restored.
    const after = await fs.readFile(path.join(dir, 'user-preferences.json'), 'utf-8');
    expect(after).toBe(originalPrefs);

    // 6) Pre-rollback snapshot kept for one-step undo.
    const preRollback = await fs.readdir(dir);
    expect(preRollback.some((n) => n.startsWith('pre-rollback-'))).toBe(true);
  });

  it('errors when no backups exist', async () => {
    const { log } = collector();
    const out = await runRollback({ memoryDir: dir, log });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no-backups');
  });

  it('errors when memory dir missing', async () => {
    const missing = path.join(dir, 'nope');
    const { log } = collector();
    const out = await runRollback({ memoryDir: missing, log });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('memory-dir-missing');
  });
});

// ---------------------------------------------------------------------------
// main — entrypoint behavior
// ---------------------------------------------------------------------------

describe('main', () => {
  it('prints help and returns 2 when no mode given', async () => {
    const { log, lines } = collector();
    const errBuf = { log: () => {} };
    const code = await main([], { log, err: errBuf.log });
    expect(code).toBe(2);
    expect(lines.some((l) => l.includes('hierarchical-memory-migrate.mjs'))).toBe(true);
  });

  it('returns 2 on unknown flag', async () => {
    const errs = [];
    const code = await main(['--bogus'], { log: () => {}, err: (m) => errs.push(m) });
    expect(code).toBe(2);
    expect(errs.join('\n')).toMatch(/unknown flag/);
  });

  it('runs --status against a temp dir', async () => {
    const dir = await mkTempDir();
    try {
      await seedLegacy(dir);
      const { log } = collector();
      const code = await main(['--status', '--memory-dir', dir], { log, err: () => {} });
      expect(code).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
