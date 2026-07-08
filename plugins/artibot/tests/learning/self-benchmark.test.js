import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'scripts',
  'cron',
  'self-benchmark-runner.js',
);
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Run the self-benchmark cron runner in a child process with a custom
 * ARTIBOT_PLUGIN_ROOT so it reads our fixture config. We use --dry-run
 * to guarantee no disk mutations inside PLUGIN_ROOT.
 *
 * @param {string} root  pluginRoot fixture
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runRunner(root) {
  const result = spawnSync(
    process.execPath,
    [RUNNER_PATH, '--dry-run'],
    {
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
      encoding: 'utf8',
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

import {
  clamp10,
  computeDimensionScores,
  DIMENSIONS,
  gatherRepoStats,
  renderMarkdownReport,
  runSelfBenchmark,
} from '../../lib/learning/self-benchmark.js';
import { configureProfilePath, resolveProfilePath } from '../../lib/core/user-profile.js';

// ---------------------------------------------------------------------------
// Fixture builder — creates a minimal artibot-like tree in a tmp dir
// ---------------------------------------------------------------------------

async function buildFixture(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artibot-selfbench-'));

  const config = {
    team: { autoApply: overrides.autoApply ?? true },
    dashboard: { enabled: overrides.dashboardEnabled ?? false },
    ago: {
      selfBenchmark: {
        enabled: true,
        schedule: '0 4 * * 1',
        reportPath: '_reports/self-benchmark.md',
        dimensions: DIMENSIONS,
      },
    },
  };
  await writeFile(path.join(dir, 'artibot.config.json'), JSON.stringify(config, null, 2));

  // commands/
  await mkdir(path.join(dir, 'commands'), { recursive: true });
  const cmdCount = overrides.cmdCount ?? 3;
  const cmdWithPolicy = overrides.cmdWithPolicy ?? 2;
  for (let i = 0; i < cmdCount; i += 1) {
    const body = i < cmdWithPolicy ? 'EFFORT_POLICY: high\n# cmd' : '# cmd\n';
    await writeFile(path.join(dir, 'commands', `cmd${i}.md`), body);
  }

  // lib/ with one js file optionally containing setNativeEffortHint
  await mkdir(path.join(dir, 'lib', 'runtime'), { recursive: true });
  if (overrides.nativeEffort !== false) {
    await writeFile(path.join(dir, 'lib', 'runtime', 'effort.js'), 'export function x(){ setNativeEffortHint("high"); }\n');
  } else {
    await writeFile(path.join(dir, 'lib', 'runtime', 'effort.js'), 'export function x(){}\n');
  }

  // lib/core/ — holds plain-language.js and (per real repo layout) extension-loader.js
  await mkdir(path.join(dir, 'lib', 'core'), { recursive: true });
  if (overrides.extensionLoader !== false) {
    await writeFile(path.join(dir, 'lib', 'core', 'extension-loader.js'), 'export const loader = 1;\n');
  }

  // lib/sdk/artibot-sdk.js with .commit()
  await mkdir(path.join(dir, 'lib', 'sdk'), { recursive: true });
  const sdkBody = overrides.sdkCommit === false
    ? 'export const sdk = {};\n'
    : 'export const sdk = { commit(){ return 1; } };\n// sdk.commit( usage\n';
  await writeFile(path.join(dir, 'lib', 'sdk', 'artibot-sdk.js'), sdkBody);
  const plainBody = (overrides.plainEntries ?? 4) > 0
    ? Array.from({ length: overrides.plainEntries ?? 4 })
        .map((_, i) => `export function p${i}(){}`)
        .join('\n')
    : '';
  await writeFile(path.join(dir, 'lib', 'core', 'plain-language.js'), plainBody);

  // hooks/hooks.json
  await mkdir(path.join(dir, 'hooks'), { recursive: true });
  const hooks = {
    PreToolUse: [
      { hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] },
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: 'lifelong-learner trigger' }] },
    ],
  };
  await writeFile(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify(hooks, null, 2));

  // scripts/hooks/post-bash-failure.js
  await mkdir(path.join(dir, 'scripts', 'hooks'), { recursive: true });
  if (overrides.postBashFailure !== false) {
    await writeFile(path.join(dir, 'scripts', 'hooks', 'post-bash-failure.js'), '// stub\n');
  }

  // runtime/user-profile.json
  await mkdir(path.join(dir, 'runtime'), { recursive: true });
  await writeFile(
    path.join(dir, 'runtime', 'user-profile.json'),
    JSON.stringify({ skill: 'auto', locale: 'ko', signals: {} }),
  );

  // _reports pre-existing test summary
  await mkdir(path.join(dir, '_reports'), { recursive: true });
  await writeFile(
    path.join(dir, '_reports', 'test-summary.json'),
    JSON.stringify({ passed: overrides.testsPassed ?? 90, total: overrides.testsTotal ?? 100 }),
  );

  return { dir, config };
}

// ---------------------------------------------------------------------------
// Top-level fixture shared across most tests
// ---------------------------------------------------------------------------

let fx;

beforeAll(async () => {
  fx = await buildFixture();
});

afterAll(async () => {
  if (fx?.dir) {
    await rm(fx.dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// clamp10
// ---------------------------------------------------------------------------

describe('self-benchmark/clamp10', () => {
  it('clamps values below 0 to 0', () => {
    expect(clamp10(-5)).toBe(0);
  });

  it('clamps values above 10 to 10', () => {
    expect(clamp10(12.5)).toBe(10);
  });

  it('keeps in-range values with 2-decimal rounding', () => {
    expect(clamp10(7.456)).toBe(7.46);
  });

  it('returns 0 for non-finite input', () => {
    expect(clamp10(Number.NaN)).toBe(0);
    expect(clamp10(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gatherRepoStats
// ---------------------------------------------------------------------------

describe('self-benchmark/gatherRepoStats', () => {
  it('returns all required fields', async () => {
    const s = await gatherRepoStats(fx.dir);
    expect(s).toHaveProperty('timestamp');
    expect(s).toHaveProperty('commands.total');
    expect(s).toHaveProperty('commands.withEffortPolicy');
    expect(s).toHaveProperty('nativeEffortHits');
    expect(s).toHaveProperty('sdkHasCommit');
    expect(s).toHaveProperty('extensionLoaderExists');
    expect(s).toHaveProperty('autoApply');
    expect(s).toHaveProperty('hookCount');
    expect(s).toHaveProperty('plainLangEntries');
    expect(s).toHaveProperty('tests.passed');
  });

  it('counts commands and EFFORT_POLICY coverage', async () => {
    const s = await gatherRepoStats(fx.dir);
    expect(s.commands.total).toBe(3);
    expect(s.commands.withEffortPolicy).toBe(2);
  });

  it('detects sdk .commit() usage', async () => {
    const s = await gatherRepoStats(fx.dir);
    expect(s.sdkHasCommit).toBe(true);
  });

  it('counts plain-language exports', async () => {
    const s = await gatherRepoStats(fx.dir);
    expect(s.plainLangEntries).toBe(4);
  });

  it('counts hook entries across events', async () => {
    const s = await gatherRepoStats(fx.dir);
    // 2 + 1 = 3 hook commands
    expect(s.hookCount).toBe(3);
  });

  it('detects extension-loader at lib/core/extension-loader.js', async () => {
    const s = await gatherRepoStats(fx.dir);
    expect(s.extensionLoaderExists).toBe(true);
  });

  it('flags extension-loader missing when absent from lib/core/', async () => {
    const { dir } = await buildFixture({ extensionLoader: false });
    try {
      const s = await gatherRepoStats(dir);
      expect(s.extensionLoaderExists).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('extensibility dimension gains +3 when loader present vs absent', async () => {
    const present = await gatherRepoStats(fx.dir);
    const { dir: absentDir } = await buildFixture({ extensionLoader: false });
    try {
      const absent = await gatherRepoStats(absentDir);
      const presentScore = computeDimensionScores(present).extensible.score;
      const absentScore = computeDimensionScores(absent).extensible.score;
      // scoreExtensible adds 3 for loader; score is clamped to [0, 10]
      expect(presentScore - absentScore).toBeCloseTo(3, 2);
    } finally {
      await rm(absentDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// userProfileSignals — read path must match the writer's path (regression)
// ---------------------------------------------------------------------------

describe('self-benchmark/userProfileSignals path agreement', () => {
  afterAll(() => {
    configureProfilePath(null);
  });

  it('counts the profile written to resolveProfilePath() (writer/reader share one resolver)', async () => {
    // Point the shared resolver at a temp profile, then write a JSON with a
    // known key count to the *exact* path resolveProfilePath() returns. If the
    // benchmark reader ever drifts back to a hardcoded <root>/runtime path,
    // this count would fall to 0 and the test fails.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'artibot-profile-'));
    const profilePath = path.join(tmp, 'user-profile.json');
    configureProfilePath(profilePath);
    expect(resolveProfilePath()).toBe(profilePath);

    await writeFile(profilePath, JSON.stringify({ skill: 'pro', locale: 'ko', signals: [] }));
    try {
      const s = await gatherRepoStats(fx.dir);
      expect(s.userProfileSignals).toBe(3);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// computeDimensionScores — determinism
// ---------------------------------------------------------------------------

describe('self-benchmark/computeDimensionScores', () => {
  const stats = {
    commands: { total: 50, withEffortPolicy: 40 },
    nativeEffortHits: 3,
    lifelongHookRegistered: true,
    sdkHasCommit: true,
    extensionLoaderExists: true,
    hookCount: 25,
    autoApply: true,
    postBashFailureHookExists: true,
    plainLangEntries: 20,
    userProfileSignals: 9,
    dashboardEnabled: true,
    tests: { passed: 95, total: 100, ratio: 0.95 },
    lintErrors: 0,
    skillCheckErrors: 0,
  };

  it('produces all 5 dimensions', () => {
    const scores = computeDimensionScores(stats);
    for (const d of DIMENSIONS) {
      expect(scores[d]).toHaveProperty('score');
      expect(scores[d]).toHaveProperty('evidence');
      expect(Array.isArray(scores[d].evidence)).toBe(true);
    }
  });

  it('is deterministic for identical input', () => {
    const a = computeDimensionScores(stats);
    const b = computeDimensionScores(stats);
    for (const d of DIMENSIONS) {
      expect(a[d].score).toBe(b[d].score);
    }
  });

  it('bounds every score to [0, 10]', () => {
    const scores = computeDimensionScores(stats);
    for (const d of DIMENSIONS) {
      expect(scores[d].score).toBeGreaterThanOrEqual(0);
      expect(scores[d].score).toBeLessThanOrEqual(10);
    }
  });

  it('returns 0 scores when signals absent', () => {
    const empty = computeDimensionScores({});
    for (const d of DIMENSIONS) {
      expect(empty[d].score).toBeGreaterThanOrEqual(0);
      expect(empty[d].score).toBeLessThanOrEqual(10);
    }
    // Quality should be 0 when tests absent and lint counted as 0 → 3 points from no-errors
    expect(empty.quality.score).toBeLessThanOrEqual(3);
  });

  it('penalizes missing EFFORT_POLICY coverage', () => {
    const low = computeDimensionScores({ ...stats, commands: { total: 50, withEffortPolicy: 0 } });
    const high = computeDimensionScores(stats);
    expect(low.evolved.score).toBeLessThan(high.evolved.score);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdownReport
// ---------------------------------------------------------------------------

describe('self-benchmark/renderMarkdownReport', () => {
  it('produces GFM table with all 5 dimensions', () => {
    const scores = computeDimensionScores({
      commands: { total: 10, withEffortPolicy: 5 },
      tests: { passed: 10, total: 10, ratio: 1 },
    });
    const md = renderMarkdownReport({
      scores,
      totalScore: 42,
      timestamp: '2026-04-21T04:00:00Z',
      previous: null,
    });
    expect(md).toContain('| 차원 | 점수 | 이전 주 | Δ |');
    expect(md).toContain('|---|---|---|---|');
    for (const d of DIMENSIONS) {
      expect(md).toContain(`| ${d} |`);
    }
  });

  it('includes previous-week delta when history present', () => {
    const scores = computeDimensionScores({});
    const md = renderMarkdownReport({
      scores,
      totalScore: 30,
      timestamp: '2026-04-21T04:00:00Z',
      previous: {
        scores: Object.fromEntries(DIMENSIONS.map((d) => [d, { score: 1 }])),
      },
    });
    // Δ should NOT be 'n/a' when previous is present
    expect(md).not.toContain('| evolved | 0.00 | n/a | n/a |');
  });
});

// ---------------------------------------------------------------------------
// runSelfBenchmark — dryRun
// ---------------------------------------------------------------------------

describe('self-benchmark/runSelfBenchmark', () => {
  it('dryRun=true writes no files', async () => {
    const { dir } = await buildFixture();
    try {
      const result = await runSelfBenchmark({
        pluginRoot: dir,
        config: { ago: { selfBenchmark: { enabled: true, schedule: '0 4 * * 1' } } },
        dryRun: true,
      });
      expect(result.written).toBe(false);
      expect(result.report).toContain('# Artibot Self-Benchmark Report');
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
      expect(result.totalScore).toBeLessThanOrEqual(100);
      // history should not be created
      const fs = await import('node:fs/promises');
      await expect(
        fs.access(path.join(dir, '_reports', 'self-benchmark-history.json')),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('dryRun=true is deterministic w.r.t. scores for same stats', async () => {
    const a = await runSelfBenchmark({ pluginRoot: fx.dir, dryRun: true });
    const b = await runSelfBenchmark({ pluginRoot: fx.dir, dryRun: true });
    for (const d of DIMENSIONS) {
      expect(a.scores[d].score).toBe(b.scores[d].score);
    }
  });

  it('totalScore within [0, 100]', async () => {
    const { totalScore } = await runSelfBenchmark({ pluginRoot: fx.dir, dryRun: true });
    expect(totalScore).toBeGreaterThanOrEqual(0);
    expect(totalScore).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Wave-2 cron runner gates (default-ON + kill-switch integration)
// ---------------------------------------------------------------------------

describe('self-benchmark-runner / Wave-2 gates', () => {
  /**
   * Write a minimal config fixture into `root/artibot.config.json` then run
   * the cron runner in a child process using PLUGIN_ROOT's actual lib/
   * (we avoid rebuilding the whole plugin tree — only the config is needed
   * for the gate short-circuits we exercise here).
   *
   * @param {object} config
   * @param {object} [ksState] optional kill-switch JSON
   */
  async function prepFixture(config, ksState) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sb-runner-'));
    await writeFile(path.join(root, 'artibot.config.json'), JSON.stringify(config));
    if (ksState) {
      await mkdir(path.join(root, 'runtime'), { recursive: true });
      await writeFile(
        path.join(root, 'runtime', 'kill-switch.json'),
        JSON.stringify(ksState),
      );
    }
    return root;
  }

  it('default enabled=true: runner reaches benchmark (no "disabled" short-circuit) with empty config', async () => {
    const root = await prepFixture({});
    try {
      const { stdout } = runRunner(root);
      // With empty config we hit Wave-2 defaults (all ON). Runner may fail
      // later because fixture does not have full plugin tree — we only assert
      // it did NOT short-circuit on the gates.
      expect(stdout).not.toContain('ago.selfBenchmark.enabled=false');
      expect(stdout).not.toContain('masterEnabled=false');
      expect(stdout).not.toContain('kill-switch tripped');
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('masterEnabled=false short-circuits immediately', async () => {
    const root = await prepFixture({
      ago: { selfControl: { masterEnabled: false } },
    });
    try {
      const { stdout, code } = runRunner(root);
      expect(code).toBe(0);
      expect(stdout).toContain('masterEnabled=false');
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('selfBenchmark.enabled=false short-circuits', async () => {
    const root = await prepFixture({
      ago: {
        selfControl: { masterEnabled: true },
        selfBenchmark: { enabled: false },
      },
    });
    try {
      const { stdout, code } = runRunner(root);
      expect(code).toBe(0);
      expect(stdout).toContain('ago.selfBenchmark.enabled=false');
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('tripped kill-switch for self-benchmark short-circuits', async () => {
    const root = await prepFixture(
      {}, // empty config → wave-2 defaults ON
      {
        features: {
          'self-benchmark': {
            failures: [],
            trippedAt: new Date().toISOString(),
          },
        },
      },
    );
    try {
      const { stdout, code } = runRunner(root);
      expect(code).toBe(0);
      expect(stdout).toContain('kill-switch tripped for self-benchmark');
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// Re-export PLUGIN_ROOT ensures the top-level constant is not tree-shaken
// away and surfaces if someone deletes the reference above.
export const _PLUGIN_ROOT_REF = PLUGIN_ROOT;
