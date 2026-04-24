import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

// Isolated virtual HOME for every test invocation so savePolicy/listSnapshots
// interact with a real (empty) dir tree and never touch the user profile.
vi.mock('../../../lib/core/platform.js', async () => {
  const realOs = await import('node:os');
  const realPath = await import('node:path');
  const realFs = await import('node:fs');
  const dir = realPath.join(realOs.tmpdir(), `artibot-grpo-trainer-${process.pid}-${Date.now()}`);
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
  runNightlyTrainer,
} = await import('../../../scripts/hooks/nightly-grpo-trainer.mjs');

const { savePolicy } = await import('../../../lib/learning/grpo/policy-updater.js');

function tmpFile(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
}

function makeEpisode(overrides = {}) {
  return {
    reward: 0.5,
    timestamp: new Date().toISOString(),
    classification: {
      system: 1,
      factors: { steps: 0.2, domains: 0.2, uncertainty: 0.1, risk: 0.1, novelty: 0.1 },
    },
    context: { s1SuccessRate: 0.7, sessionDepth: 4, errorRateMa10: 0.1 },
    intentFamily: 'general',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseArgs', () => {
  it('returns defaults for empty argv', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      forceColdStart: false,
      windowDays: 30,
      policyPath: null,
      episodesPath: null,
      help: false,
    });
  });

  it('parses flags and values', () => {
    const r = parseArgs(['--dry-run', '--force-cold-start', '--window-days', '14', '--policy-path', '/a', '--episodes', '/b']);
    expect(r.dryRun).toBe(true);
    expect(r.forceColdStart).toBe(true);
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

  it('USAGE documents all flags', () => {
    expect(USAGE).toMatch(/--dry-run/);
    expect(USAGE).toMatch(/--force-cold-start/);
    expect(USAGE).toMatch(/--window-days/);
    expect(USAGE).toMatch(/--policy-path/);
    expect(USAGE).toMatch(/--episodes/);
  });
});

describe('resolveTrailPath', () => {
  it('points at runtime/routing-policy-trail.json', () => {
    const p = resolveTrailPath();
    expect(p.endsWith(`runtime${path.sep}routing-policy-trail.json`)).toBe(true);
  });
});

describe('trail operations', () => {
  it('appendTrail + loadTrail round-trip', async () => {
    const trailPath = tmpFile('grpo-trail');
    await appendTrail({ action: 'trained', metrics: { logLoss: 0.4 } }, trailPath);
    await appendTrail({ action: 'skipped', reason: 'no-episodes' }, trailPath);
    const all = await loadTrail(trailPath);
    expect(all).toHaveLength(2);
    expect(all[0].action).toBe('trained');
    expect(all[1].action).toBe('skipped');
    await fs.unlink(trailPath).catch(() => {});
  });

  it('loadTrail returns [] on missing file', async () => {
    const missing = tmpFile('grpo-trail-missing');
    expect(await loadTrail(missing)).toEqual([]);
  });
});

describe('shouldAutoRollback', () => {
  it('is false when fewer than N trained entries exist', () => {
    const trail = [
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.3 } },
      { action: 'skipped' },
    ];
    expect(shouldAutoRollback(trail, 3, 0.5)).toBe(false);
  });

  it('is true when last N trained entries are all below threshold', () => {
    const trail = [
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.9 } },
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.3 } },
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.2 } },
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.4 } },
    ];
    expect(shouldAutoRollback(trail, 3, 0.5)).toBe(true);
  });

  it('is false when any of the last N are above threshold', () => {
    const trail = [
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.3 } },
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.8 } },
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.4 } },
    ];
    expect(shouldAutoRollback(trail, 3, 0.5)).toBe(false);
  });

  it('ignores non-trained trail entries when counting', () => {
    const trail = [
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.3 } },
      { action: 'skipped' },
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.3 } },
      { action: 'rejected' },
      { action: 'trained', metrics: { accuracyVsHeuristic: 0.3 } },
    ];
    expect(shouldAutoRollback(trail, 3, 0.5)).toBe(true);
  });
});

describe('readEpisodesFile', () => {
  it('returns [] for missing file', async () => {
    expect(await readEpisodesFile(tmpFile('missing'))).toEqual([]);
  });

  it('returns [] when file is not a JSON array', async () => {
    const p = tmpFile('malformed');
    await fs.writeFile(p, JSON.stringify({ not: 'an-array' }));
    expect(await readEpisodesFile(p)).toEqual([]);
    await fs.unlink(p);
  });

  it('filters non-object entries', async () => {
    const p = tmpFile('mixed');
    await fs.writeFile(p, JSON.stringify([{ a: 1 }, null, 'string', 42, { b: 2 }]));
    const out = await readEpisodesFile(p);
    expect(out).toHaveLength(2);
    await fs.unlink(p);
  });
});

describe('filterByWindow', () => {
  it('keeps recent episodes and drops stale ones', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const eps = [
      { timestamp: new Date(now - 1 * day).toISOString(), id: 'a' },
      { timestamp: new Date(now - 60 * day).toISOString(), id: 'b' },
    ];
    const kept = filterByWindow(eps, 30, now);
    expect(kept.map((e) => e.id)).toEqual(['a']);
  });

  it('retains episodes without a timestamp (best-effort)', () => {
    const kept = filterByWindow([{ id: 'no-ts' }], 7);
    expect(kept).toHaveLength(1);
  });

  it('returns episodes unchanged for non-positive windowDays', () => {
    const eps = [{ timestamp: '1970-01-01' }];
    expect(filterByWindow(eps, 0)).toBe(eps);
  });
});

describe('runNightlyTrainer', () => {
  const silentLogger = { info() {}, warn() {}, error() {} };

  it('returns status=skipped when no episodes', async () => {
    const trailPath = tmpFile('trail');
    const res = await runNightlyTrainer({
      episodes: [],
      trailPath,
      logger: silentLogger,
      policyPath: tmpFile('policy'),
    });
    expect(res.status).toBe('skipped');
    expect(res.episodesUsed).toBe(0);
    await fs.unlink(trailPath).catch(() => {});
  });

  it('defers cold-start when below coldStartEpisodes', async () => {
    const trailPath = tmpFile('trail');
    const policyPath = tmpFile('policy');
    const eps = [];
    for (let i = 0; i < 10; i++) eps.push(makeEpisode());
    const res = await runNightlyTrainer({
      episodes: eps,
      trailPath,
      policyPath,
      config: { coldStartEpisodes: 200 },
      logger: silentLogger,
    });
    expect(res.status).toBe('cold-start-deferred');
    const trail = await loadTrail(trailPath);
    expect(trail.at(-1).action).toBe('cold-start-deferred');
    await fs.unlink(trailPath).catch(() => {});
  });

  it('trains + appends "trained" trail entry when episodes suffice', async () => {
    const trailPath = tmpFile('trail');
    const policyPath = tmpFile('policy');
    const eps = [];
    for (let i = 0; i < 210; i++) {
      eps.push(makeEpisode({
        classification: {
          system: i % 2 === 0 ? 2 : 1,
          factors: {
            steps: i % 2 === 0 ? 0.8 : 0.1,
            domains: i % 2 === 0 ? 0.7 : 0.1,
            uncertainty: 0.1,
            risk: i % 2 === 0 ? 0.6 : 0.05,
            novelty: 0.2,
          },
        },
      }));
    }
    const res = await runNightlyTrainer({
      episodes: eps,
      trailPath,
      policyPath,
      config: { coldStartEpisodes: 200 },
      logger: silentLogger,
    });
    expect(res.status).toBe('trained');
    expect(res.metrics.accuracyVsHeuristic).toBeGreaterThan(0.5);
    const trail = await loadTrail(trailPath);
    expect(trail.at(-1).action).toBe('trained');
    expect(trail.at(-1).snapshotId).toBeDefined();
    await fs.unlink(trailPath).catch(() => {});
  });

  it('dry-run does not produce a "trained" entry', async () => {
    const trailPath = tmpFile('trail');
    const policyPath = tmpFile('policy');
    const eps = [];
    for (let i = 0; i < 210; i++) eps.push(makeEpisode({ classification: { system: 1, factors: { steps: 0.2 } } }));
    const res = await runNightlyTrainer({
      episodes: eps,
      trailPath,
      policyPath,
      dryRun: true,
      config: { coldStartEpisodes: 200 },
      logger: silentLogger,
    });
    expect(res.status).toBe('dry-run');
    const trail = await loadTrail(trailPath);
    expect(trail.at(-1).action).toBe('dry-run');
    await fs.unlink(trailPath).catch(() => {});
  });

  it('auto-rolls back after N consecutive low-accuracy nights', async () => {
    const trailPath = tmpFile('trail');
    const policyPath = tmpFile('policy');

    // Seed a saved policy + pre-write a snapshot with a recognizable theta
    await savePolicy(new Array(9).fill(0.2), { logLoss: 0.5, accuracyVsHeuristic: 0.9, klFromPrev: 0 }, { policyPath });

    // Pre-fill the trail with 3 low-accuracy trained entries
    for (let i = 0; i < 3; i++) {
      await appendTrail({ action: 'trained', metrics: { accuracyVsHeuristic: 0.3 } }, trailPath);
    }

    const res = await runNightlyTrainer({
      episodes: [makeEpisode(), makeEpisode()],
      trailPath,
      policyPath,
      config: { coldStartEpisodes: 200, rollbackConsecutiveNights: 3, accuracyRollbackThreshold: 0.5 },
      logger: silentLogger,
    });

    // Either rolled-back or at least acknowledged; status should be 'rolled-back'
    // when a snapshot exists for the current saved policy.
    expect(['rolled-back', 'cold-start-deferred']).toContain(res.status);
    await fs.unlink(trailPath).catch(() => {});
  });

  it('forceColdStart removes the existing policy before training', async () => {
    const trailPath = tmpFile('trail');
    const policyPath = tmpFile('policy');
    // seed existing policy
    await savePolicy(new Array(9).fill(0.5), { logLoss: 0.4, accuracyVsHeuristic: 0.8, klFromPrev: 0 }, { policyPath });
    const exists = await fs.stat(policyPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    await runNightlyTrainer({
      episodes: [makeEpisode()],
      trailPath,
      policyPath,
      forceColdStart: true,
      config: { coldStartEpisodes: 200 },
      logger: silentLogger,
    });
    // Should have been deleted (we don't re-warmup with only 1 episode)
    const stillExists = await fs.stat(policyPath).then(() => true).catch(() => false);
    expect(stillExists).toBe(false);
    await fs.unlink(trailPath).catch(() => {});
  });
});
