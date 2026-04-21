import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Decision trail is a no-op for tests (avoids writing to real runtime/).
vi.mock('../../lib/core/decision-trail.js', () => ({
  recordDecision: vi.fn(async () => ({ id: 'x', timestamp: new Date().toISOString() })),
}));

import {
  analyzeLifecycle,
  checkGates,
  deprecateSkill,
  finalizeDeprecation,
  listSkills,
  MIN_GRACE_DAYS,
  promoteSkill,
  PROTECTED_SKILLS,
  splitFrontmatter,
  sweepLifecycle,
  upsertFrontmatterKey,
} from '../../lib/learning/skill-lifecycle-autopilot.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-20T00:00:00Z');
const nowFn = () => NOW;

function baseConfig(overrides = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled: true,
        autoLifecycle: {
          enabled: true,
          graceDays: 14,
          deprecateThreshold: 0,
          promoteThreshold: 5,
          ...overrides,
        },
      },
    },
  };
}

async function makeTmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-lifecycle-'));
  await fs.mkdir(path.join(root, 'skills'), { recursive: true });
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
  return root;
}

async function writeSkill(root, name, frontmatterExtras = '') {
  const dir = path.join(root, 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    'description: |',
    `  ${name} skill description.`,
    'platforms: [claude-code]',
    'level: 1',
    frontmatterExtras,
    '---',
    '',
    `# ${name}`,
    '',
    'Body content.',
  ]
    .filter((l) => l !== '')
    .join('\n');
  await fs.writeFile(path.join(dir, 'SKILL.md'), `${fm}\n`, 'utf-8');
}

async function writeClaudePatterns(claudeDir, entries) {
  const dir = path.join(claudeDir, 'patterns');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'agent-patterns.json'),
    JSON.stringify({ entries }),
    'utf-8',
  );
  await fs.writeFile(
    path.join(dir, 'tool-patterns.json'),
    JSON.stringify({ entries: [] }),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// checkGates
// ---------------------------------------------------------------------------

describe('skill-lifecycle-autopilot/checkGates', () => {
  it('closes when masterEnabled is false', () => {
    const cfg = baseConfig();
    cfg.ago.selfControl.masterEnabled = false;
    expect(checkGates(cfg, { ARTIBOT_SELF_CONTROL: '1' }).open).toBe(false);
  });

  it('closes when autoLifecycle.enabled is false', () => {
    const cfg = baseConfig();
    cfg.ago.selfControl.autoLifecycle.enabled = false;
    expect(checkGates(cfg, { ARTIBOT_SELF_CONTROL: '1' }).open).toBe(false);
  });

  it('closes without env var', () => {
    expect(checkGates(baseConfig(), {}).open).toBe(false);
  });

  it('opens on full green light', () => {
    expect(checkGates(baseConfig(), { ARTIBOT_SELF_CONTROL: '1' }).open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

describe('skill-lifecycle-autopilot/frontmatter', () => {
  it('splits frontmatter from body', () => {
    const src = '---\nname: foo\n---\nHello';
    const r = splitFrontmatter(src);
    expect(r.frontmatter).toContain('name: foo');
    expect(r.body).toBe('Hello');
  });

  it('returns null if no frontmatter', () => {
    expect(splitFrontmatter('# No front')).toBeNull();
  });

  it('upserts a new key', () => {
    const fm = 'name: foo';
    const next = upsertFrontmatterKey(fm, 'priority', 'high');
    expect(next).toContain('priority: high');
  });

  it('replaces an existing key', () => {
    const fm = 'name: foo\npriority: low';
    const next = upsertFrontmatterKey(fm, 'priority', 'high');
    expect(next).toContain('priority: high');
    expect(next).not.toContain('priority: low');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('skill-lifecycle-autopilot/constants', () => {
  it('MIN_GRACE_DAYS is 14 and immutable', () => {
    expect(MIN_GRACE_DAYS).toBe(14);
  });

  it('PROTECTED_SKILLS includes core skills', () => {
    expect(PROTECTED_SKILLS).toContain('principles');
    expect(PROTECTED_SKILLS).toContain('dev-protocol');
    expect(PROTECTED_SKILLS).toContain('yes-md');
    expect(Object.isFrozen(PROTECTED_SKILLS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

describe('skill-lifecycle-autopilot/listSkills', () => {
  let root;
  beforeEach(async () => { root = await makeTmpRoot(); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('lists skill directories', async () => {
    await writeSkill(root, 'alpha');
    await writeSkill(root, 'beta');
    const skills = await listSkills(root);
    expect(skills).toEqual(['alpha', 'beta']);
  });

  it('returns [] when skills dir missing', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-'));
    expect(await listSkills(empty)).toEqual([]);
    await fs.rm(empty, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// analyzeLifecycle
// ---------------------------------------------------------------------------

describe('skill-lifecycle-autopilot/analyzeLifecycle', () => {
  let root;
  let claudeDir;
  beforeEach(async () => {
    root = await makeTmpRoot();
    claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(claudeDir, { recursive: true, force: true });
  });

  it('flags unused skill for deprecation', async () => {
    await writeSkill(root, 'stale-skill');
    await writeClaudePatterns(claudeDir, []);
    const plan = await analyzeLifecycle({
      pluginRoot: root,
      claudeDir,
      config: baseConfig(),
      now: nowFn,
    });
    expect(plan.toDeprecate.map((e) => e.name)).toContain('stale-skill');
  });

  it('never deprecates protected skills', async () => {
    await writeSkill(root, 'principles');
    await writeSkill(root, 'dev-protocol');
    await writeClaudePatterns(claudeDir, []);
    const plan = await analyzeLifecycle({
      pluginRoot: root,
      claudeDir,
      config: baseConfig(),
      now: nowFn,
    });
    const names = plan.toDeprecate.map((e) => e.name);
    expect(names).not.toContain('principles');
    expect(names).not.toContain('dev-protocol');
  });

  it('flags heavy-use skills for promotion', async () => {
    await writeSkill(root, 'hot-skill');
    const recentTs = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
    await writeClaudePatterns(claudeDir, [
      { skill: 'hot-skill', count: 10, lastSeen: recentTs },
    ]);
    const plan = await analyzeLifecycle({
      pluginRoot: root,
      claudeDir,
      config: baseConfig(),
      now: nowFn,
    });
    expect(plan.toPromote.map((e) => e.name)).toContain('hot-skill');
  });

  it('puts already-deprecated skills in grace list', async () => {
    const deprecatedAt = '2026-04-10';
    await writeSkill(
      root,
      'ghost',
      `deprecated: true\ndeprecatedAt: "${deprecatedAt}"`,
    );
    await writeClaudePatterns(claudeDir, []);
    const plan = await analyzeLifecycle({
      pluginRoot: root,
      claudeDir,
      config: baseConfig(),
      now: nowFn,
    });
    expect(plan.grace.map((e) => e.name)).toContain('ghost');
    expect(plan.toDeprecate.map((e) => e.name)).not.toContain('ghost');
  });

  it('is deterministic for identical inputs', async () => {
    await writeSkill(root, 'alpha');
    await writeSkill(root, 'beta');
    await writeClaudePatterns(claudeDir, []);
    const r1 = await analyzeLifecycle({ pluginRoot: root, claudeDir, config: baseConfig(), now: nowFn });
    const r2 = await analyzeLifecycle({ pluginRoot: root, claudeDir, config: baseConfig(), now: nowFn });
    expect(r1.toDeprecate).toEqual(r2.toDeprecate);
    expect(r1.toPromote).toEqual(r2.toPromote);
  });
});

// ---------------------------------------------------------------------------
// deprecateSkill + promoteSkill
// ---------------------------------------------------------------------------

describe('skill-lifecycle-autopilot/mutations', () => {
  let root;
  beforeEach(async () => { root = await makeTmpRoot(); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('refuses to deprecate without gate pass', async () => {
    await writeSkill(root, 'victim');
    const cfg = baseConfig();
    cfg.ago.selfControl.masterEnabled = false;
    const res = await deprecateSkill('victim', {
      pluginRoot: root,
      config: cfg,
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn,
    });
    expect(res.applied).toBe(false);
  });

  it('refuses to deprecate a protected skill', async () => {
    await writeSkill(root, 'principles');
    const res = await deprecateSkill('principles', {
      pluginRoot: root,
      config: baseConfig(),
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn,
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('protected-skill');
  });

  it('deprecates by writing frontmatter, not deleting', async () => {
    await writeSkill(root, 'candidate');
    const res = await deprecateSkill('candidate', {
      pluginRoot: root,
      config: baseConfig(),
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn,
    });
    expect(res.applied).toBe(true);
    const after = await fs.readFile(path.join(root, 'skills', 'candidate', 'SKILL.md'), 'utf-8');
    expect(after).toContain('deprecated: true');
    expect(after).toMatch(/deprecatedAt:\s*"2026-04-20"/);
    // directory still exists
    const stat = await fs.stat(path.join(root, 'skills', 'candidate'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('promotes by adding priority: high', async () => {
    await writeSkill(root, 'rising');
    const res = await promoteSkill('rising', {
      pluginRoot: root,
      config: baseConfig(),
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn,
    });
    expect(res.applied).toBe(true);
    const after = await fs.readFile(path.join(root, 'skills', 'rising', 'SKILL.md'), 'utf-8');
    expect(after).toContain('priority: high');
  });
});

// ---------------------------------------------------------------------------
// finalizeDeprecation — grace period enforcement
// ---------------------------------------------------------------------------

describe('skill-lifecycle-autopilot/finalizeDeprecation', () => {
  let root;
  beforeEach(async () => { root = await makeTmpRoot(); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('refuses to delete before grace period', async () => {
    await writeSkill(root, 'young', 'deprecated: true\ndeprecatedAt: "2026-04-15"');
    const res = await finalizeDeprecation('young', '2026-04-15', {
      pluginRoot: root,
      config: baseConfig(),
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn, // NOW = 2026-04-20, diff = 5 days
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/grace-period/);
    // File still present
    const stat = await fs.stat(path.join(root, 'skills', 'young', 'SKILL.md'));
    expect(stat.isFile()).toBe(true);
  });

  it('deletes only after MIN_GRACE_DAYS elapsed', async () => {
    await writeSkill(root, 'old', 'deprecated: true\ndeprecatedAt: "2026-04-01"');
    const res = await finalizeDeprecation('old', '2026-04-01', {
      pluginRoot: root,
      config: baseConfig(),
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn, // 2026-04-20 - 2026-04-01 = 19 days >= 14
    });
    expect(res.applied).toBe(true);
    await expect(fs.stat(path.join(root, 'skills', 'old'))).rejects.toThrow();
  });

  it('refuses to finalize protected skill even if deprecatedAt is ancient', async () => {
    await writeSkill(root, 'principles');
    const res = await finalizeDeprecation('principles', '2020-01-01', {
      pluginRoot: root,
      config: baseConfig(),
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn,
    });
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('protected-skill');
  });
});

// ---------------------------------------------------------------------------
// sweepLifecycle (end-to-end)
// ---------------------------------------------------------------------------

describe('skill-lifecycle-autopilot/sweepLifecycle', () => {
  let root;
  let claudeDir;
  beforeEach(async () => {
    root = await makeTmpRoot();
    claudeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(claudeDir, { recursive: true, force: true });
  });

  it('no-ops when gate is closed', async () => {
    await writeSkill(root, 'x');
    await writeClaudePatterns(claudeDir, []);
    const cfg = baseConfig();
    cfg.ago.selfControl.masterEnabled = false;
    const res = await sweepLifecycle({
      pluginRoot: root,
      claudeDir,
      config: cfg,
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn,
    });
    expect(res.deprecated).toEqual([]);
    expect(res.skipped.length).toBeGreaterThan(0);
  });

  it('deprecates unused skills in a single pass', async () => {
    await writeSkill(root, 'alpha');
    await writeClaudePatterns(claudeDir, []);
    const res = await sweepLifecycle({
      pluginRoot: root,
      claudeDir,
      config: baseConfig(),
      env: { ARTIBOT_SELF_CONTROL: '1' },
      now: nowFn,
    });
    expect(res.deprecated).toContain('alpha');
  });
});
