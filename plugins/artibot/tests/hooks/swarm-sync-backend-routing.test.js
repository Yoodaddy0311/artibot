import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '../../scripts/hooks/swarm-sync.js');

/**
 * Regression lock for the swarm-sync git-egress-skip introduced in v4.19.2
 * (commit af89006). swarm-sync.js wraps the HTTP DATA POLICY egress gate in an
 * inline `if (swarmCfg?.backend !== 'git')` guard, so:
 *   - backend === 'git'  -> the HTTP egress allowlist gate is SKIPPED and the
 *                           sync routes straight through to the resolver, even
 *                           when the configured serverUrl is NOT on the
 *                           allowlist (a real git remote would be blocked by
 *                           the HTTP gate otherwise).
 *   - backend !== 'git'  -> the gate still fires; an off-allowlist serverUrl is
 *                           refused with a "Skipped by DATA POLICY" stderr line.
 * swarm-download.js extracted this into checkHttpEgressAllowed() (covered by
 * swarm-download.test.js); swarm-sync.js keeps it inline and runs main()
 * unconditionally, so we drive the real hook as a subprocess (matching the
 * sibling swarm-sync-egress.test.js pattern) and assert on the stderr contract.
 *
 * The hook resolves its dependency modules (config, swarm-config, egress guard,
 * sync-scheduler, swarm-client) relative to the plugin root, so the test stands
 * up a self-contained fixture plugin root and points every known plugin-root
 * override env var at it. A sentinel file written by the fixture config.js
 * proves the subprocess actually used the fixture (guarding against a silent
 * fallback to the real plugin root that would make the assertions vacuous).
 */

let fixtureRoot;
const SENTINEL = 'config-loaded.marker';
// A serverUrl deliberately NOT on the fixture allowlist, so the HTTP egress
// gate is guaranteed to BLOCK when it runs. Under the git backend the gate is
// skipped, so this URL must NOT produce a DATA POLICY skip.
const OFF_ALLOWLIST_URL = 'https://evil.example.invalid';

function writeFixture(root) {
  const libCore = path.join(root, 'lib', 'core');
  const libSwarm = path.join(root, 'lib', 'swarm');
  const libPrivacy = path.join(root, 'lib', 'privacy');
  mkdirSync(libCore, { recursive: true });
  mkdirSync(libSwarm, { recursive: true });
  mkdirSync(libPrivacy, { recursive: true });

  // config.js — loadConfig writes a sentinel so we can prove the fixture root
  // was the one actually used by the spawned hook.
  writeFileSync(
    path.join(libCore, 'config.js'),
    [
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      'export async function loadConfig() {',
      '  const here = path.dirname(fileURLToPath(import.meta.url));',
      "  const root = path.resolve(here, '..', '..');",
      `  writeFileSync(path.join(root, '${SENTINEL}'), 'ok');`,
      '  return {};',
      '}',
      '',
    ].join('\n'),
  );

  // swarm-config.js — swarm is always active; backend is driven by an env var
  // so each test case selects git vs http without rewriting the fixture.
  writeFileSync(
    path.join(libSwarm, 'swarm-config.js'),
    [
      'export async function isSwarmActive() {',
      '  return true;',
      '}',
      'export function getSwarmConfig() {',
      '  return {',
      '    backend: process.env.__TEST_BACKEND,',
      `    serverUrl: '${OFF_ALLOWLIST_URL}',`,
      '  };',
      '}',
      '',
    ].join('\n'),
  );

  // data-egress-guard.js — a faithful stub: assertEgressAllowed throws an
  // EgressBlockedError for anything not on the (empty) allowlist. This is what
  // the git branch must SKIP and the http branch must HIT. The guard now lives
  // in lib/core (Layer 1), so the stub is written there.
  writeFileSync(
    path.join(libCore, 'data-egress-guard.js'),
    [
      'export class EgressBlockedError extends Error {',
      '  constructor(message) {',
      '    super(message);',
      "    this.name = 'EgressBlockedError';",
      '  }',
      '}',
      'export function loadAllowlist() {',
      '  return [];',
      '}',
      'export function assertEgressAllowed(url) {',
      '  process.stderr.write(`[fixture] egress-gate-ran:${url}\\n`);',
      "  throw new EgressBlockedError(`host not on allowlist: ${url}`);",
      '}',
      '',
    ].join('\n'),
  );

  // differential-privacy.js — present but unused (DP disabled in config).
  writeFileSync(
    path.join(libSwarm, '..', 'privacy', 'differential-privacy.js'),
    'export function createNoiseFunction() { return (x) => x; }\n',
  );

  // sync-scheduler.js — onSessionEnd is the resolver-routed sync step. It marks
  // that control reached past the egress gate. cancelSync is a no-op.
  writeFileSync(
    path.join(libSwarm, 'sync-scheduler.js'),
    [
      'export async function onSessionEnd() {',
      '  process.stderr.write(`[fixture] resolver-sync-ran:${process.env.__TEST_BACKEND}\\n`);',
      '  return { uploaded: false, downloaded: false };',
      '}',
      'export function cancelSync() {}',
      '',
    ].join('\n'),
  );

  // swarm-client.js — telemetry is best-effort; keep it a no-op.
  writeFileSync(
    path.join(libSwarm, 'swarm-client.js'),
    'export async function reportTelemetry() {}\n',
  );
}

function runHook(env) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's1', duration: 1, tool_count: 1 }),
    encoding: 'utf8',
    env: {
      ...process.env,
      // Point every known plugin-root override at the fixture. The sentinel
      // assertion guards against the real root being used instead.
      ARTIBOT_PLUGIN_ROOT: fixtureRoot,
      CLAUDE_PLUGIN_ROOT: fixtureRoot,
      ARTIBOT_PLUGIN_DIR: fixtureRoot,
      ...env,
    },
  });
}

function usedFixture(root) {
  try {
    return readFileSync(path.join(root, SENTINEL), 'utf8') === 'ok';
  } catch {
    return false;
  }
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'swsync-routing-'));
  writeFixture(fixtureRoot);
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear any stale sentinel between cases so usedFixture() is meaningful.
  rmSync(path.join(fixtureRoot, SENTINEL), { force: true });
});

describe('swarm-sync backend routing (git egress skip)', () => {
  it('runs without crashing on empty stdin (smoke, real plugin root)', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env },
    });
    expect(res.status).toBe(0);
  });

  it('git backend SKIPS the HTTP egress gate and routes via the resolver', () => {
    const res = runHook({ __TEST_BACKEND: 'git', ARTIBOT_SWARM_SERVER: '' });

    // Sanity: the spawned hook must have used our fixture, else the assertions
    // below would be vacuous against the real (unknown) config.
    expect(usedFixture(fixtureRoot)).toBe(true);
    expect(res.status).toBe(0);

    // The egress gate must NOT have run (git skips it)...
    expect(res.stderr).not.toContain('egress-gate-ran');
    expect(res.stderr).not.toContain('Skipped by DATA POLICY');
    // ...and control must have reached the resolver-routed sync step.
    expect(res.stderr).toContain('resolver-sync-ran:git');
  });

  it('non-git (http) backend STILL hits the egress gate and is blocked', () => {
    const res = runHook({ __TEST_BACKEND: 'http', ARTIBOT_SWARM_SERVER: '' });

    expect(usedFixture(fixtureRoot)).toBe(true);
    expect(res.status).toBe(0);

    // The egress gate ran against the off-allowlist URL and blocked the sync.
    // NOTE: swarm-sync.js imports the egress guard STATICALLY (relative to the
    // hook file, not the plugin root), so unlike config/swarm-config/scheduler
    // the fixture's data-egress-guard.js stub is never loaded — the real guard
    // runs. The real guard does not emit an `egress-gate-ran` sentinel; its
    // observable contract is the DATA POLICY skip line below. (The sentinel
    // approach only works for hooks that dynamic-import the guard, e.g.
    // swarm-download.) So we assert on the real, stable stderr contract:
    expect(res.stderr).toContain('[swarm-sync] Skipped by DATA POLICY');
    // ...so the resolver-routed sync step must NOT have been reached.
    expect(res.stderr).not.toContain('resolver-sync-ran');
  });

  it('git backend skip holds even with an off-allowlist ARTIBOT_SWARM_SERVER override', () => {
    // The egress block resolves serverUrl from ARTIBOT_SWARM_SERVER first; under
    // git the whole gate (and thus this resolution) is bypassed. This mirrors
    // the download-side "health/egress skip under git" guarantee for the sync
    // hook: a never-allowlisted remote must not stop the git sync path.
    const res = runHook({ __TEST_BACKEND: 'git', ARTIBOT_SWARM_SERVER: OFF_ALLOWLIST_URL });

    expect(usedFixture(fixtureRoot)).toBe(true);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('egress-gate-ran');
    expect(res.stderr).not.toContain('Skipped by DATA POLICY');
    expect(res.stderr).toContain('resolver-sync-ran:git');
  });
});
