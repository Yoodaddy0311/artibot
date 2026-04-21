import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mocks — decision-trail must no-op (writes to real runtime/ otherwise)
// ---------------------------------------------------------------------------

vi.mock('../../lib/core/decision-trail.js', () => ({
  recordDecision: vi.fn(async () => ({ id: 'x', timestamp: new Date().toISOString() })),
}));

import {
  _constants,
  assertSafeCommand,
  buildFixPlan,
  checkCooldown,
  checkGates,
  createAutoPR,
  isCategoryAllowed,
  recordAttempt,
  sourceHasMergeCall,
  validateBranch,
} from '../../scripts/cron/auto-pr-creator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-20T10:00:00Z');

function baseConfig(overrides = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled: true,
        autoPR: {
          enabled: true,
          autoMerge: false,
          branchPrefix: 'artibot/auto/',
          categories: ['drift', 'security-fix', 'test-flake'],
          ...overrides,
        },
        // Disable first-run observe mode so tests exercise the full path.
        firstRunMode: { enabled: false },
      },
    },
  };
}

async function makeTmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'auto-pr-'));
}

// ---------------------------------------------------------------------------
// checkGates
// ---------------------------------------------------------------------------

describe('auto-pr-creator/checkGates (default-on)', () => {
  it('closes when masterEnabled is false (user opt-out)', () => {
    const cfg = baseConfig();
    cfg.ago.selfControl.masterEnabled = false;
    expect(checkGates(cfg).open).toBe(false);
  });

  it('closes when autoPR.enabled is false (feature opt-out)', () => {
    const cfg = baseConfig();
    cfg.ago.selfControl.autoPR.enabled = false;
    expect(checkGates(cfg).open).toBe(false);
  });

  it('opens by default without env var', () => {
    // Default-on: absence of env var must not close the gate.
    const cfg = baseConfig();
    expect(checkGates(cfg, {}).open).toBe(true);
  });

  it('closes when autoMerge would be true (hard security invariant)', () => {
    const cfg = baseConfig({ autoMerge: true });
    const res = checkGates(cfg);
    expect(res.open).toBe(false);
    expect(res.reason).toMatch(/autoMerge/);
  });

  it('opens with default config', () => {
    const cfg = baseConfig();
    expect(checkGates(cfg).open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCategoryAllowed
// ---------------------------------------------------------------------------

describe('auto-pr-creator/isCategoryAllowed', () => {
  it('rejects unknown category', () => {
    expect(isCategoryAllowed(baseConfig(), 'feature-work')).toBe(false);
  });

  it('rejects category not in config list', () => {
    const cfg = baseConfig({ categories: ['drift'] });
    expect(isCategoryAllowed(cfg, 'security-fix')).toBe(false);
  });

  it('accepts whitelisted category', () => {
    expect(isCategoryAllowed(baseConfig(), 'drift')).toBe(true);
    expect(isCategoryAllowed(baseConfig(), 'security-fix')).toBe(true);
    expect(isCategoryAllowed(baseConfig(), 'test-flake')).toBe(true);
  });

  it('rejects when categories list is empty', () => {
    const cfg = baseConfig({ categories: [] });
    expect(isCategoryAllowed(cfg, 'drift')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateBranch
// ---------------------------------------------------------------------------

describe('auto-pr-creator/validateBranch', () => {
  it('rejects main/master', () => {
    expect(validateBranch('main').ok).toBe(false);
    expect(validateBranch('master').ok).toBe(false);
  });

  it('rejects branches without artibot/auto/ prefix', () => {
    expect(validateBranch('feature/x').ok).toBe(false);
    expect(validateBranch('artibot/master').ok).toBe(false);
  });

  it('accepts proper auto-prefixed branch', () => {
    expect(validateBranch('artibot/auto/drift-20260420').ok).toBe(true);
  });

  it('rejects whitespace in branch name', () => {
    expect(validateBranch('artibot/auto/bad name').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertSafeCommand
// ---------------------------------------------------------------------------

describe('auto-pr-creator/assertSafeCommand', () => {
  it('blocks gh pr merge', () => {
    const res = assertSafeCommand('gh', ['pr', 'merge', '123']);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('gh-pr-merge-forbidden');
  });

  it('blocks push to main', () => {
    const res = assertSafeCommand('git', ['push', 'origin', 'main']);
    expect(res.ok).toBe(false);
  });

  it('blocks push to master', () => {
    const res = assertSafeCommand('git', ['push', 'origin', 'master']);
    expect(res.ok).toBe(false);
  });

  it('allows push to auto branch', () => {
    const res = assertSafeCommand('git', ['push', '-u', 'origin', 'artibot/auto/drift-123']);
    expect(res.ok).toBe(true);
  });

  it('allows gh pr create', () => {
    const res = assertSafeCommand('gh', ['pr', 'create', '--draft']);
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

describe('auto-pr-creator/checkCooldown', () => {
  let root;
  beforeEach(async () => { root = await makeTmpRoot(); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('allows first attempt (no prior history)', async () => {
    const res = await checkCooldown(root, NOW);
    expect(res.allowed).toBe(true);
    expect(res.history).toEqual([]);
  });

  it('blocks second attempt within the same hour', async () => {
    await recordAttempt(root, NOW, []);
    const later = new Date(NOW.getTime() + 60_000); // 1 min later
    const res = await checkCooldown(root, later);
    expect(res.allowed).toBe(false);
  });

  it('allows attempt after 1 hour has elapsed', async () => {
    await recordAttempt(root, NOW, []);
    const later = new Date(NOW.getTime() + 3_600_001);
    const res = await checkCooldown(root, later);
    expect(res.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFixPlan
// ---------------------------------------------------------------------------

describe('auto-pr-creator/buildFixPlan', () => {
  it('builds a valid branch + title + body', () => {
    const plan = buildFixPlan('drift', NOW);
    expect(plan.branch.startsWith('artibot/auto/drift-')).toBe(true);
    expect(plan.title).toContain('auto(drift)');
    expect(plan.body).toContain('autoMerge is disabled by policy');
  });

  it('includes the ISO timestamp in the body', () => {
    const plan = buildFixPlan('security-fix', NOW);
    expect(plan.body).toContain(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// createAutoPR end-to-end (mocked spawn)
// ---------------------------------------------------------------------------

describe('auto-pr-creator/createAutoPR', () => {
  let root;
  beforeEach(async () => {
    root = await makeTmpRoot();
    // Pre-seed first-run state so tests exercise the full path by default.
    await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'runtime', 'first-run-state.json'),
      JSON.stringify({ globalRuns: 999, features: {}, transitions: [] }),
      'utf-8',
    );
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('rejects when user opts out (masterEnabled=false)', async () => {
    const cfg = baseConfig();
    cfg.ago.selfControl.masterEnabled = false;
    const res = await createAutoPR({
      config: cfg,
      pluginRoot: root,
      category: 'drift',
      now: NOW,
    });
    expect(res.status).toBe('rejected');
  });

  it('rejects when kill-switch is tripped', async () => {
    await fs.writeFile(
      path.join(root, 'runtime', 'kill-switch.json'),
      JSON.stringify({
        features: {
          'auto-pr': {
            failures: [{ at: Date.now(), error: 'seed' }],
            trippedAt: new Date().toISOString(),
          },
        },
      }),
      'utf-8',
    );
    const res = await createAutoPR({
      config: baseConfig(),
      pluginRoot: root,
      category: 'drift',
      now: NOW,
    });
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('kill-switch-tripped');
  });

  it('rejects when category not allowed', async () => {
    const cfg = baseConfig({ categories: ['drift'] });
    const res = await createAutoPR({
      config: cfg,
      pluginRoot: root,
      category: 'security-fix',
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: NOW,
    });
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('category-not-allowed');
  });

  it('rejects when hourly limit exceeded', async () => {
    await recordAttempt(root, NOW, []);
    const res = await createAutoPR({
      config: baseConfig(),
      pluginRoot: root,
      category: 'drift',
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('cooldown');
  });

  it('dry-run returns planned branch without invoking shell', async () => {
    const runImpl = vi.fn();
    const res = await createAutoPR({
      config: baseConfig(),
      pluginRoot: root,
      category: 'drift',
      dryRun: true,
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: NOW,
      runImpl,
    });
    expect(res.status).toBe('dry-run');
    expect(res.branch.startsWith('artibot/auto/drift-')).toBe(true);
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('invokes git + gh in correct sequence, never gh pr merge', async () => {
    const calls = [];
    const runImpl = vi.fn(async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh') {
        return { code: 0, stdout: 'https://github.com/owner/repo/pull/42\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const res = await createAutoPR({
      config: baseConfig(),
      pluginRoot: root,
      category: 'drift',
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: NOW,
      runImpl,
    });
    expect(res.status).toBe('created');
    expect(res.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(calls[0][0]).toBe('git');
    expect(calls[0][1]).toBe('checkout');
    const ghCall = calls.find((c) => c[0] === 'gh');
    expect(ghCall).toBeDefined();
    expect(ghCall.includes('--draft')).toBe(true);
    expect(ghCall.includes('merge')).toBe(false);
    // hard invariant: nothing in the call graph touched pr merge
    for (const c of calls) {
      expect(c.join(' ')).not.toMatch(/pr\s+merge/);
    }
  });

  it('records cooldown attempt after a successful PR', async () => {
    const runImpl = vi.fn(async (cmd) => {
      if (cmd === 'gh') return { code: 0, stdout: 'https://x/1', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    await createAutoPR({
      config: baseConfig(),
      pluginRoot: root,
      category: 'drift',
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: NOW,
      runImpl,
    });
    const cooldownFile = path.join(root, _constants.COOLDOWN_PATH);
    const contents = JSON.parse(await fs.readFile(cooldownFile, 'utf-8'));
    expect(contents.history.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Static source analysis — enforces "no gh pr merge" invariant on the file
// ---------------------------------------------------------------------------

describe('auto-pr-creator source invariants', () => {
  it('detects merge calls when present', () => {
    expect(sourceHasMergeCall("runCommand('gh', ['pr', 'merge'])")).toBe(true);
    expect(sourceHasMergeCall('spawn("gh","pr","merge")')).toBe(true);
  });

  it('reports false for benign code', () => {
    expect(sourceHasMergeCall('runCommand("gh", ["pr", "create", "--draft"])')).toBe(false);
  });

  it('auto-pr-creator.js source never invokes gh pr merge', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const target = path.resolve(here, '../../scripts/cron/auto-pr-creator.js');
    const source = await fs.readFile(target, 'utf-8');
    // the only permitted mention is inside the static guard / docs (comments
    // or regex). We ensure there is no *live* invocation like runCommand('gh', ['pr', 'merge', ...])
    const liveInvocation = /\brun(?:Command|Impl)\s*\(\s*['"`]gh['"`]\s*,\s*\[[^\]]*['"`]pr['"`]\s*,\s*['"`]merge['"`]/.test(source);
    expect(liveInvocation).toBe(false);
  });
});
