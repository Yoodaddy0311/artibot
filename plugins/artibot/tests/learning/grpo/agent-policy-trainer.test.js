/**
 * Unit tests for scripts/hooks/nightly-agent-policy-trainer.mjs.
 *
 * Uses isolated virtual HOME per worker so savePolicy / listSnapshots
 * interact with a real (empty) tmp directory and never touch the user profile.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

vi.mock('../../../lib/core/platform.js', async () => {
  const realOs = await import('node:os');
  const realPath = await import('node:path');
  const realFs = await import('node:fs');
  const dir = realPath.join(
    realOs.tmpdir(),
    `artibot-agent-trainer-${process.pid}-${Date.now()}`,
  );
  realFs.mkdirSync(dir, { recursive: true });
  return { getHomeDir: () => dir };
});

const {
  parseArgs,
  USAGE,
  resolveTrailPath,
  appendTrail,
  loadTrail,
  shouldAutoRollback,
  readEpisodesFile,
  filterByWindow,
  runNightlyAgentTrainer,
} = await import('../../../scripts/hooks/nightly-agent-policy-trainer.mjs');

function tmpFile(prefix) {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

const BASE_CONFIG = {
  agents: {
    taskBased: {
      refactor: 'refactor-cleaner',
      plan: 'planner',
    },
  },
};

function makeEpisode(overrides = {}) {
  return {
    reward: 0.5,
    timestamp: new Date().toISOString(),
    taskFamily: 'refactor',
    selectedAgent: 'refactor-cleaner',
    candidates: ['refactor-cleaner', 'backend-developer'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NODE_ENV = 'test';
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('returns defaults for empty argv', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      windowDays: 30,
      policyPath: null,
      episodesPath: null,
      help: false,
    });
  });

  it('parses flags and values', () => {
    const r = parseArgs(['--dry-run', '--window-days', '14', '--policy-path', '/a', '--episodes', '/b']);
    expect(r.dryRun).toBe(true);
    expect(r.windowDays).toBe(14);
    expect(r.policyPath).toBe('/a');
    expect(r.episodesPath).toBe('/b');
  });

  it('ignores non-positive window-days', () => {
    expect(parseArgs(['--window-days', '-5']).windowDays).toBe(30);
    expect(parseArgs(['--window-days', 'abc']).windowDays).toBe(30);
  });

  it('handles --help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('has a USAGE banner', () => {
    expect(USAGE).toContain('nightly-agent-policy-trainer');
  });
});

// ---------------------------------------------------------------------------
// Trail helpers
// ---------------------------------------------------------------------------

describe('trail helpers', () => {
  it('resolveTrailPath points to runtime/agent-policy-trail.json', () => {
    expect(resolveTrailPath().endsWith(path.join('runtime', 'agent-policy-trail.json'))).toBe(true);
  });

  it('appendTrail creates an array with a timestamp entry', async () => {
    const tf = tmpFile('agent-trail');
    await appendTrail({ action: 'test' }, tf);
    const loaded = await loadTrail(tf);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ action: 'test' });
    expect(typeof loaded[0].ts).toBe('string');
    await fs.unlink(tf).catch(() => {});
  });

  it('shouldAutoRollback returns false with insufficient entries', () => {
    expect(shouldAutoRollback([], 3, 0.5)).toBe(false);
  });

  it('shouldAutoRollback returns true on 3 consecutive low-accuracy entries', () => {
    const trail = [
      { action: 'trained', metrics: { accuracyVsBaseline: 0.4 } },
      { action: 'trained', metrics: { accuracyVsBaseline: 0.3 } },
      { action: 'trained', metrics: { accuracyVsBaseline: 0.45 } },
    ];
    expect(shouldAutoRollback(trail, 3, 0.5)).toBe(true);
  });

  it('shouldAutoRollback returns false when any entry meets threshold', () => {
    const trail = [
      { action: 'trained', metrics: { accuracyVsBaseline: 0.4 } },
      { action: 'trained', metrics: { accuracyVsBaseline: 0.7 } },
      { action: 'trained', metrics: { accuracyVsBaseline: 0.45 } },
    ];
    expect(shouldAutoRollback(trail, 3, 0.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readEpisodesFile + filterByWindow
// ---------------------------------------------------------------------------

describe('readEpisodesFile', () => {
  it('returns [] on missing file', async () => {
    expect(await readEpisodesFile(tmpFile('missing'))).toEqual([]);
  });

  it('loads valid JSON array', async () => {
    const tf = tmpFile('eps');
    await fs.writeFile(tf, JSON.stringify([makeEpisode()]), 'utf8');
    const loaded = await readEpisodesFile(tf);
    expect(loaded).toHaveLength(1);
    await fs.unlink(tf).catch(() => {});
  });

  it('filters out non-object entries', async () => {
    const tf = tmpFile('eps-mixed');
    await fs.writeFile(tf, JSON.stringify([makeEpisode(), null, 1, 'x']), 'utf8');
    const loaded = await readEpisodesFile(tf);
    expect(loaded).toHaveLength(1);
    await fs.unlink(tf).catch(() => {});
  });
});

describe('filterByWindow', () => {
  it('keeps entries inside the window', () => {
    const now = Date.parse('2026-04-23T00:00:00Z');
    const recent = makeEpisode({ timestamp: '2026-04-20T00:00:00Z' });
    const old = makeEpisode({ timestamp: '2026-01-01T00:00:00Z' });
    const out = filterByWindow([recent, old], 30, now);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(recent);
  });

  it('retains entries with missing timestamps (best-effort)', () => {
    const eps = [makeEpisode({ timestamp: undefined }), makeEpisode({ ts: 'bad' })];
    const out = filterByWindow(eps, 7);
    expect(out).toHaveLength(2);
  });

  it('bypasses window when windowDays <= 0', () => {
    const eps = [makeEpisode({ timestamp: '2020-01-01T00:00:00Z' })];
    expect(filterByWindow(eps, 0)).toEqual(eps);
  });
});

// ---------------------------------------------------------------------------
// runNightlyAgentTrainer
// ---------------------------------------------------------------------------

describe('runNightlyAgentTrainer', () => {
  const policyPath = () => path.join(os.tmpdir(), `agent-policy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  const trailPath = () => tmpFile('agent-trail');
  const silentLogger = { info() {}, warn() {}, error() {} };

  it('skips when no episodes are available', async () => {
    const tf = trailPath();
    const res = await runNightlyAgentTrainer({
      episodes: [],
      trailPath: tf,
      logger: silentLogger,
      policyPath: policyPath(),
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no-episodes');
    const trail = await loadTrail(tf);
    expect(trail[0].action).toBe('skipped');
    await fs.unlink(tf).catch(() => {});
  });

  it('dry-run returns metrics without persisting a policy', async () => {
    const pp = policyPath();
    const tf = trailPath();
    const eps = [];
    for (let i = 0; i < 10; i++) eps.push(makeEpisode({ reward: 1 }));
    for (let i = 0; i < 10; i++) {
      eps.push(makeEpisode({ reward: -1, selectedAgent: 'backend-developer' }));
    }
    const res = await runNightlyAgentTrainer({
      episodes: eps,
      dryRun: true,
      trailPath: tf,
      policyPath: pp,
      baseConfig: BASE_CONFIG,
      logger: silentLogger,
    });
    expect(res.status).toBe('dry-run');
    expect(res.metrics.samples).toBeGreaterThan(0);
    // policy file should not exist
    let existed = false;
    try {
      await fs.access(pp);
      existed = true;
    } catch {
      existed = false;
    }
    expect(existed).toBe(false);
    await fs.unlink(tf).catch(() => {});
  });

  it('trains and appends a "trained" ledger entry', async () => {
    const pp = policyPath();
    const tf = trailPath();
    const eps = [];
    for (let i = 0; i < 10; i++) eps.push(makeEpisode({ reward: 1 }));
    for (let i = 0; i < 10; i++) {
      eps.push(makeEpisode({ reward: -1, selectedAgent: 'backend-developer' }));
    }
    const res = await runNightlyAgentTrainer({
      episodes: eps,
      policyPath: pp,
      trailPath: tf,
      baseConfig: BASE_CONFIG,
      config: { learningRate: 0.5, klPenalty: 0 },
      logger: silentLogger,
    });
    expect(res.status).toBe('trained');
    expect(res.policy.weights.refactor).toBeDefined();
    const trail = await loadTrail(tf);
    expect(trail.at(-1).action).toBe('trained');
    await fs.unlink(pp).catch(() => {});
    await fs.unlink(tf).catch(() => {});
  });

  it('rejects updates when KL exceeds threshold and logs "rejected"', async () => {
    const pp = policyPath();
    const tf = trailPath();

    // Seed a baseline policy via savePolicy (writes to the mocked home dir).
    const mod = await import('../../../lib/learning/grpo/agent-policy.js');
    await mod.savePolicy(
      { refactor: { 'refactor-cleaner': 0, 'backend-developer': 0, __count__: 10 } },
      { logLoss: 0.5, accuracyVsBaseline: 0.7, klFromPrev: 0 },
      { policyPath: pp },
    );

    const eps = [];
    for (let i = 0; i < 20; i++) eps.push(makeEpisode({ reward: 1 }));
    for (let i = 0; i < 20; i++) {
      eps.push(makeEpisode({ reward: -1, selectedAgent: 'backend-developer' }));
    }

    const res = await runNightlyAgentTrainer({
      episodes: eps,
      policyPath: pp,
      trailPath: tf,
      baseConfig: BASE_CONFIG,
      config: { learningRate: 10, klPenalty: 0, klRejectThreshold: 0.0001 },
      logger: silentLogger,
    });
    expect(res.status).toBe('rejected');
    const trail = await loadTrail(tf);
    expect(trail.at(-1).action).toBe('rejected');
    await fs.unlink(pp).catch(() => {});
    await fs.unlink(tf).catch(() => {});
  });

  it('records "no-trainable" when all episodes are exploration', async () => {
    const pp = policyPath();
    const tf = trailPath();
    const eps = [makeEpisode({ isExploration: true }), makeEpisode({ isExploration: true })];
    const res = await runNightlyAgentTrainer({
      episodes: eps,
      policyPath: pp,
      trailPath: tf,
      logger: silentLogger,
    });
    expect(res.status).toBe('no-trainable');
    const trail = await loadTrail(tf);
    expect(trail.at(-1).action).toBe('no-trainable');
    await fs.unlink(tf).catch(() => {});
  });

  it('respects --window-days filter via nowMs', async () => {
    const pp = policyPath();
    const tf = trailPath();
    const now = Date.parse('2026-04-23T00:00:00Z');
    const eps = [
      makeEpisode({ timestamp: '2020-01-01T00:00:00Z', reward: 1 }),
    ];
    const res = await runNightlyAgentTrainer({
      episodes: eps,
      windowDays: 30,
      nowMs: now,
      policyPath: pp,
      trailPath: tf,
      logger: silentLogger,
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no-episodes');
    await fs.unlink(tf).catch(() => {});
  });
});
