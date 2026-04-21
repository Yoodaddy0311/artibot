import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(__dirname, '..', '..', 'scripts', 'cron', 'self-benchmark-runner.js');

function makeTmpRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'artibot-sb-runner-'));
  // minimal plugin root layout so readJsonFile + runSelfBenchmark can run
  mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  mkdirSync(path.join(dir, '_reports'), { recursive: true });
  return dir;
}

function writeConfig(root, cfg) {
  writeFileSync(path.join(root, 'artibot.config.json'), JSON.stringify(cfg, null, 2));
}

function runRunner(root, extraArgs = []) {
  return spawnSync('node', [RUNNER, ...extraArgs], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    encoding: 'utf-8',
  });
}

describe('self-benchmark-runner (cron)', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpRoot();
  });

  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('exits cleanly when masterEnabled is false', () => {
    writeConfig(tmp, {
      ago: { selfControl: { masterEnabled: false }, selfBenchmark: { enabled: true } },
    });
    const r = runRunner(tmp, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/masterEnabled=false/);
  });

  it('exits cleanly when selfBenchmark.enabled is false', () => {
    writeConfig(tmp, {
      ago: { selfControl: { masterEnabled: true }, selfBenchmark: { enabled: false } },
    });
    const r = runRunner(tmp, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/selfBenchmark\.enabled=false/);
  });

  it('runs in dry-run mode when all gates allow (default-ON)', () => {
    // omit config entirely — defaults should be ON
    writeConfig(tmp, { ago: { selfControl: { masterEnabled: true } } });
    const r = runRunner(tmp, ['--dry-run']);
    expect(r.status).toBe(0);
    // dry-run marker appears in report path line
    expect(r.stdout).toMatch(/dry-run/);
  });

  it('produces a score report with 5 dimensions', () => {
    writeConfig(tmp, { ago: { selfControl: { masterEnabled: true } } });
    const r = runRunner(tmp, ['--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Total score:/);
    // all 5 dimensions should appear in the summary lines
    for (const dim of ['evolved', 'extensible', 'productive', 'universal', 'quality']) {
      expect(r.stdout).toMatch(new RegExp(dim));
    }
  });

  it('is idempotent on repeated dry-run calls (no state pollution)', () => {
    writeConfig(tmp, { ago: { selfControl: { masterEnabled: true } } });
    const a = runRunner(tmp, ['--dry-run']);
    const b = runRunner(tmp, ['--dry-run']);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
  });
});
