import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  parseArgs,
  resolveDefaultPluginRoot,
  runNightlyDream,
  USAGE,
} from '../../scripts/hooks/nightly-dream-consolidate.mjs';

let tmpDir;
let memDir;
let pluginRoot;

function doc({ name, type = 'project', body, session = 's1' }) {
  return `---
name: ${name}
description: hook
metadata:
  node_type: memory
  type: ${type}
  originSessionId: ${session}
---

# ${name}

${body}
`;
}

async function hashAll(dir) {
  const out = {};
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile()) {
      const raw = await fs.readFile(path.join(dir, e.name), 'utf-8');
      out[e.name] = createHash('sha256').update(raw).digest('hex');
    }
  }
  return out;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-nightly-'));
  memDir = path.join(tmpDir, 'memory');
  pluginRoot = path.join(tmpDir, 'plugin');
  await fs.mkdir(memDir, { recursive: true });
  await fs.mkdir(path.join(pluginRoot, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(memDir, 'dup-a.md'),
    doc({ name: 'dup-a', body: 'nightly trainer schedule cron registration', session: 's1' }), 'utf-8');
  await fs.writeFile(path.join(memDir, 'dup-b.md'),
    doc({ name: 'dup-b', body: 'nightly trainer schedule cron registration', session: 's2' }), 'utf-8');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults are conservative', () => {
    const o = parseArgs([]);
    expect(o.dryRun).toBe(false);
    expect(o.memoryDir).toBeNull();
  });
  it('parses flags', () => {
    const o = parseArgs(['--dry-run', '--memory-dir', '/m', '--plugin-root', '/p']);
    expect(o).toMatchObject({ dryRun: true, memoryDir: '/m', pluginRoot: '/p' });
  });
  it('--help sets help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('USAGE / resolveDefaultPluginRoot', () => {
  it('USAGE is a non-trivial string', () => {
    expect(USAGE.length).toBeGreaterThan(20);
  });
  it('resolveDefaultPluginRoot returns a path', () => {
    expect(typeof resolveDefaultPluginRoot()).toBe('string');
  });
});

describe('runNightlyDream — Phase-1 only (ADR-3 invariants)', () => {
  it('skips when no memory dir is resolvable', async () => {
    const res = await runNightlyDream({ pluginRoot, logger: silent() });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no-memory-dir');
  });

  it('produces candidates.json + wakeup marker, ZERO LLM/MD writes', async () => {
    const before = await hashAll(memDir);
    const res = await runNightlyDream({ memoryDir: memDir, pluginRoot, logger: silent() });

    expect(res.status).toBe('completed');
    expect(res.llmCalls).toBe(0);
    expect(res.proposalsGenerated).toBe(0);
    expect(res.mdWrites).toBe(0);
    expect(res.candidates).toBeGreaterThanOrEqual(1);

    // candidates.json written to staging only.
    const candPath = path.join(memDir, '.dream-staging', 'candidates.json');
    const parsed = JSON.parse(await fs.readFile(candPath, 'utf-8'));
    expect(parsed.mergeCandidates.length).toBeGreaterThanOrEqual(1);

    // wakeup marker written under plugin runtime.
    const marker = path.join(pluginRoot, 'runtime', 'wakeup-requests.json');
    const markerData = JSON.parse(await fs.readFile(marker, 'utf-8'));
    expect(markerData.entries.some((e) => e.category === 'dream-consolidate')).toBe(true);

    // Source memory MD untouched, no .proposed.md, no .dream-archive.
    const after = await hashAll(memDir);
    expect(after['dup-a.md']).toBe(before['dup-a.md']);
    expect(after['dup-b.md']).toBe(before['dup-b.md']);
    const top = await fs.readdir(memDir);
    expect(top.filter((f) => f.endsWith('.md')).sort()).toEqual(['dup-a.md', 'dup-b.md']);
    const stagingFiles = await fs.readdir(path.join(memDir, '.dream-staging'));
    expect(stagingFiles).toEqual(['candidates.json']); // no proposals, no proposed.md
  });

  it('--dry-run computes but writes NO candidates.json and NO marker', async () => {
    const res = await runNightlyDream({ memoryDir: memDir, pluginRoot, dryRun: true, logger: silent() });
    expect(res.status).toBe('dry-run');
    expect(res.candidates).toBeGreaterThanOrEqual(1);
    await expect(fs.access(path.join(memDir, '.dream-staging', 'candidates.json'))).rejects.toThrow();
    await expect(fs.access(path.join(pluginRoot, 'runtime', 'wakeup-requests.json'))).rejects.toThrow();
  });

  it('respects dream.nightly.enabled=false', async () => {
    const res = await runNightlyDream({
      memoryDir: memDir, pluginRoot, logger: silent(),
      config: { learning: { dream: { nightly: { enabled: false } } } },
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('dream-nightly-disabled');
  });

  it('honours a tripped per-feature kill-switch (skips, writes nothing)', async () => {
    // Seed a tripped kill-switch for the dream feature.
    await fs.writeFile(
      path.join(pluginRoot, 'runtime', 'kill-switch.json'),
      JSON.stringify({
        features: { 'dream-consolidate': { failures: [], trippedAt: new Date().toISOString() } },
      }),
      'utf-8',
    );
    const res = await runNightlyDream({ memoryDir: memDir, pluginRoot, logger: silent() });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('kill-switch-tripped');
    expect(res.candidates).toBe(0);
    await expect(fs.access(path.join(memDir, '.dream-staging', 'candidates.json'))).rejects.toThrow();
  });

  it('never throws — returns a structured status even on an empty memory dir', async () => {
    const emptyMem = path.join(tmpDir, 'empty-memory');
    await fs.mkdir(emptyMem, { recursive: true });
    const res = await runNightlyDream({ memoryDir: emptyMem, pluginRoot, logger: silent() });
    expect(res.status).toBe('completed');
    expect(res.candidates).toBe(0);
    expect(res.llmCalls).toBe(0);
    expect(res.mdWrites).toBe(0);
  });
});

function silent() {
  return { info() {}, warn() {}, error() {} };
}
