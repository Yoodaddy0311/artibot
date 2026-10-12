import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  _internals,
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

  it('accepts a projectDir with a ledger and completes (F-08 D3 signal wiring)', async () => {
    // projectDir carries .artibot/ledger → collector gathers ledger signals and
    // forwards them to distill. Until D2 consumes them this is inert plumbing, so
    // candidate generation must be unaffected (no crash, still produces merges).
    const projDir = path.join(tmpDir, 'proj');
    await fs.mkdir(path.join(projDir, '.artibot', 'ledger'), { recursive: true });
    const line = (role, text) => JSON.stringify({
      type: role, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    });
    await fs.writeFile(
      path.join(projDir, '.artibot', 'ledger', 's1.jsonl'),
      `${line('user', 'nightly trainer schedule')}\n`, 'utf-8',
    );

    const res = await runNightlyDream({
      memoryDir: memDir, pluginRoot, projectDir: projDir, logger: silent(),
    });
    expect(res.status).toBe('completed');
    expect(res.candidates).toBeGreaterThanOrEqual(1);
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

/**
 * WHICH CONFIG KEY GATES THE NIGHTLY SLOT. Only `learning.dream.nightly.enabled === false`
 * stops it; `learning.dream.enabled` is not read here. The shipped config pairs
 * `dream.enabled: false` (its comment says that flag is informational and that
 * `nightly.enabled` gates the 05:00 slot) with `dream.nightly.enabled: true`, and the
 * 05:00 job is opt-in at the OS level (README "Optional: Background Learning Schedules"), so a
 * user who registered it gets candidates tonight. Making the hook honour `dream.enabled`
 * (fail-closed or not) would turn it into a silent no-op for every default config. That is a
 * product decision, not a cleanup: whoever makes it changes this block and the shipped config
 * together, on purpose. Absent config runs too, which is what the tests above rely on.
 */
describe('nightly gate — dream.nightly.enabled decides, dream.enabled is not read', () => {
  const dream = (block) => ({ learning: { dream: block } });
  const SHIPPED_PAIRING = 'dream.enabled=false + nightly.enabled=true (the shipped pairing)';
  const readShipped = async () => JSON.parse(
    await fs.readFile(path.join(resolveDefaultPluginRoot(), 'artibot.config.json'), 'utf-8'),
  );

  const GATE_CASES = [
    { what: 'no config at all', config: undefined, runs: true },
    { what: 'an empty config', config: {}, runs: true },
    { what: 'an empty dream block', config: dream({}), runs: true },
    { what: 'nightly.enabled=true', config: dream({ nightly: { enabled: true } }), runs: true },
    { what: 'nightly.enabled=false', config: dream({ nightly: { enabled: false } }), runs: false },
    { what: 'dream.enabled=false alone', config: dream({ enabled: false }), runs: true },
    { what: SHIPPED_PAIRING, config: dream({ enabled: false, nightly: { enabled: true } }), runs: true },
    { what: 'dream.enabled=true + nightly.enabled=false', config: dream({ enabled: true, nightly: { enabled: false } }), runs: false },
  ];

  it.each(GATE_CASES)('allows the run: $runs for $what', ({ config, runs }) => {
    expect(_internals.dreamEnabled(config)).toBe(runs);
  });

  // NEGATIVE CONTROL. A gate that also consults dream.enabled must fail these pins, or they could
  // not tell it from the real one. Each stub is the real gate plus one extra dream.enabled check;
  // it has to disagree with the matrix on the shipped pairing and with the real gate on the real
  // shipped file (the rows and the end-to-end run in this block are what turn red for it).
  it.each([
    { stub: 'fail-closed: dream.enabled must be true', extra: (c) => c?.learning?.dream?.enabled === true },
    { stub: 'honours an explicit dream.enabled=false', extra: (c) => c?.learning?.dream?.enabled !== false },
  ])('catches a stub gate that also checks dream.enabled: $stub', async ({ extra }) => {
    const stub = (c) => extra(c) && _internals.dreamEnabled(c);
    const wrongRows = GATE_CASES.filter(({ config, runs }) => stub(config) !== runs).map(({ what }) => what);
    expect(wrongRows).toContain(SHIPPED_PAIRING);
    const shipped = await readShipped();
    expect(stub(shipped)).toBe(false);
    expect(_internals.dreamEnabled(shipped)).toBe(true);
  });

  it('completes with dream.enabled=false and nightly.enabled=true, reaching candidates.json', async () => {
    const res = await runNightlyDream({
      memoryDir: memDir, pluginRoot, logger: silent(),
      config: { learning: { dream: { enabled: false, nightly: { enabled: true } } } },
    });
    expect(res.status).toBe('completed');
    expect(res.candidates).toBeGreaterThanOrEqual(1);
    await expect(fs.access(path.join(memDir, '.dream-staging', 'candidates.json'))).resolves.toBeUndefined();
  });

  it('skips on nightly.enabled=false even when dream.enabled=true', async () => {
    const res = await runNightlyDream({
      memoryDir: memDir, pluginRoot, logger: silent(),
      config: { learning: { dream: { enabled: true, nightly: { enabled: false } } } },
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('dream-nightly-disabled');
    await expect(fs.access(path.join(memDir, '.dream-staging', 'candidates.json'))).rejects.toThrow();
  });

  // What users get today. The synthetic cases above hold whatever the file says; this one reads
  // the real shipped file, and says so loudly if it no longer has the OFF flag it is about.
  it('completes with the real shipped artibot.config.json', async () => {
    const shipped = await readShipped();
    expect(shipped.learning.dream.enabled, 'shipped dream.enabled changed: re-read this block').toBe(false);
    expect(shipped.learning.dream.nightly.enabled).toBe(true);
    const res = await runNightlyDream({ memoryDir: memDir, pluginRoot, config: shipped, logger: silent() });
    expect(res.status).toBe('completed');
    expect(res.candidates).toBeGreaterThanOrEqual(1);
  });
});

function silent() {
  return { info() {}, warn() {}, error() {} };
}
