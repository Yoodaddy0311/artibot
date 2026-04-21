/**
 * Auto Skill Registrar tests — AGO Self-Control Track 3.
 *
 * Covers the triple gate, staging/promotion lifecycle, cool-down, DATA POLICY
 * blocking, and collision refusal.
 *
 * @module tests/sdk/auto-skill-registrar
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  listStaging,
  promoteRipened,
  rejectStaging,
  stageSkill,
} from '../../lib/sdk/auto-skill-registrar.js';

/** @type {string} */
let pluginRoot;

function enableGate() {
  process.env.ARTIBOT_SELF_CONTROL = '1';
}
function disableGate() {
  delete process.env.ARTIBOT_SELF_CONTROL;
}

function makeConfig(overrides = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled: true,
        autoSkillRegister: {
          enabled: true,
          stagingDays: 1,
          stagingPath: 'runtime/skills-staging/',
          minConfidence: 0.85,
          ...overrides,
        },
      },
    },
  };
}

function validSpec(extra = {}) {
  return {
    name: 'auto-demo',
    description: 'Auto-researched demo skill',
    category: 'engineering',
    body: '# Auto Demo\n\nSafe body.',
    confidence: 0.9,
    ...extra,
  };
}

beforeEach(() => {
  pluginRoot = mkdtempSync(path.join(tmpdir(), 'artibot-auto-skill-'));
  mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
  writeFileSync(
    path.join(pluginRoot, 'artibot.config.json'),
    JSON.stringify({ version: '0.0.0' }, null, 2),
    'utf-8',
  );
  enableGate();
});

afterEach(() => {
  disableGate();
  rmSync(pluginRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('triple safety gate', () => {
  it('refuses staging when masterEnabled is false', async () => {
    const cfg = makeConfig();
    cfg.ago.selfControl.masterEnabled = false;
    const r = await stageSkill(validSpec(), { pluginRoot, config: cfg });
    expect(r.staged).toBe(false);
    expect(r.reason).toBe('master-disabled');
  });

  it('refuses staging when module is disabled', async () => {
    const cfg = makeConfig({ enabled: false });
    const r = await stageSkill(validSpec(), { pluginRoot, config: cfg });
    expect(r.staged).toBe(false);
    expect(r.reason).toBe('module-disabled');
  });

  it('refuses staging when env var is missing', async () => {
    disableGate();
    const r = await stageSkill(validSpec(), { pluginRoot, config: makeConfig() });
    expect(r.staged).toBe(false);
    expect(r.reason).toBe('env-not-set');
  });
});

// ---------------------------------------------------------------------------
// stageSkill
// ---------------------------------------------------------------------------

describe('stageSkill', () => {
  it('creates SKILL.md and metadata under runtime/skills-staging/<name>/', async () => {
    const result = await stageSkill(validSpec(), { pluginRoot, config: makeConfig() });
    expect(result.staged).toBe(true);
    expect(existsSync(result.stagingPath)).toBe(true);
    const md = readFileSync(path.join(result.stagingPath, 'SKILL.md'), 'utf-8');
    expect(md).toContain('name: auto-demo');
    const meta = JSON.parse(readFileSync(path.join(result.stagingPath, '.staging.json'), 'utf-8'));
    expect(meta.confidence).toBe(0.9);
    expect(meta.rejected).toBe(false);
    expect(meta.stagedAt).toMatch(/T/);
  });

  it('refuses low-confidence specs', async () => {
    const r = await stageSkill(validSpec({ confidence: 0.1 }), {
      pluginRoot,
      config: makeConfig(),
    });
    expect(r.staged).toBe(false);
    expect(r.reason).toBe('low-confidence');
  });

  it('refuses invalid specs (missing required fields)', async () => {
    const r = await stageSkill(
      { name: 'bad', description: '', category: '', body: 'x', confidence: 0.9 },
      { pluginRoot, config: makeConfig() },
    );
    expect(r.staged).toBe(false);
    expect(r.reason).toBe('invalid-spec');
    expect(Array.isArray(r.errors)).toBe(true);
  });

  it('blocks DATA POLICY violations (network fetch in body)', async () => {
    const bad = validSpec({ body: 'uses await fetch("https://evil")' });
    const r = await stageSkill(bad, { pluginRoot, config: makeConfig() });
    expect(r.staged).toBe(false);
    expect(r.reason).toBe('data-policy-violation');
  });

  it('refuses duplicate staging for same skill name', async () => {
    const first = await stageSkill(validSpec(), { pluginRoot, config: makeConfig() });
    expect(first.staged).toBe(true);
    const second = await stageSkill(validSpec(), { pluginRoot, config: makeConfig() });
    expect(second.staged).toBe(false);
    expect(second.reason).toBe('already-staged');
  });
});

// ---------------------------------------------------------------------------
// listStaging
// ---------------------------------------------------------------------------

describe('listStaging', () => {
  it('returns empty when directory does not exist', async () => {
    const entries = await listStaging(pluginRoot, makeConfig());
    expect(entries).toEqual([]);
  });

  it('lists staged skills with metadata', async () => {
    await stageSkill(validSpec(), { pluginRoot, config: makeConfig() });
    const entries = await listStaging(pluginRoot, makeConfig());
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('auto-demo');
    expect(entries[0].metadata?.confidence).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// rejectStaging
// ---------------------------------------------------------------------------

describe('rejectStaging', () => {
  it('marks metadata rejected=true without removing files', async () => {
    const stage = await stageSkill(validSpec(), { pluginRoot, config: makeConfig() });
    expect(stage.staged).toBe(true);
    const r = await rejectStaging('auto-demo', 'not relevant', { pluginRoot, config: makeConfig() });
    expect(r.rejected).toBe(true);
    const meta = JSON.parse(readFileSync(path.join(stage.stagingPath, '.staging.json'), 'utf-8'));
    expect(meta.rejected).toBe(true);
    expect(meta.rejectReason).toBe('not relevant');
  });

  it('returns not-found for missing skillId', async () => {
    const r = await rejectStaging('nonexistent', 'x', { pluginRoot, config: makeConfig() });
    expect(r.rejected).toBe(false);
    expect(r.reason).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// promoteRipened
// ---------------------------------------------------------------------------

describe('promoteRipened', () => {
  it('keeps skill pending when cool-down has not elapsed', async () => {
    const t0 = Date.parse('2026-04-20T00:00:00Z');
    await stageSkill(validSpec(), { pluginRoot, config: makeConfig(), now: t0 });
    const r = await promoteRipened({
      pluginRoot,
      config: makeConfig(),
      now: t0 + 3 * 60 * 60 * 1000, // +3h, still < 1 day
    });
    expect(r.pending).toContain('auto-demo');
    expect(r.promoted).toHaveLength(0);
  });

  it('promotes after cool-down elapses and official skill does not exist', async () => {
    const t0 = Date.parse('2026-04-20T00:00:00Z');
    await stageSkill(validSpec(), { pluginRoot, config: makeConfig(), now: t0 });
    const r = await promoteRipened({
      pluginRoot,
      config: makeConfig(),
      now: t0 + 2 * 24 * 60 * 60 * 1000, // +2 days
    });
    expect(r.promoted).toContain('auto-demo');
    const officialDir = path.join(pluginRoot, 'skills', 'auto-demo');
    expect(existsSync(path.join(officialDir, 'SKILL.md'))).toBe(true);
    // staging metadata should not leak into official skills dir
    expect(existsSync(path.join(officialDir, '.staging.json'))).toBe(false);
  });

  it('refuses promotion when an official skill with the same name exists', async () => {
    const t0 = Date.parse('2026-04-20T00:00:00Z');
    await stageSkill(validSpec(), { pluginRoot, config: makeConfig(), now: t0 });
    // Seed an existing official skill that would conflict.
    const conflictDir = path.join(pluginRoot, 'skills', 'auto-demo');
    mkdirSync(conflictDir, { recursive: true });
    writeFileSync(path.join(conflictDir, 'SKILL.md'), 'existing', 'utf-8');
    const r = await promoteRipened({
      pluginRoot,
      config: makeConfig(),
      now: t0 + 2 * 24 * 60 * 60 * 1000,
    });
    expect(r.promoted).toHaveLength(0);
    expect(r.rejected).toContain('auto-demo');
    // Staging dir should still be intact (not renamed).
    expect(existsSync(path.join(pluginRoot, 'runtime', 'skills-staging', 'auto-demo'))).toBe(true);
  });

  it('skips rejected entries', async () => {
    const t0 = Date.parse('2026-04-20T00:00:00Z');
    await stageSkill(validSpec(), { pluginRoot, config: makeConfig(), now: t0 });
    await rejectStaging('auto-demo', 'irrelevant', { pluginRoot, config: makeConfig() });
    const r = await promoteRipened({
      pluginRoot,
      config: makeConfig(),
      now: t0 + 5 * 24 * 60 * 60 * 1000,
    });
    expect(r.promoted).toHaveLength(0);
    expect(r.rejected).toContain('auto-demo');
  });

  it('returns reason when gate is closed', async () => {
    disableGate();
    const r = await promoteRipened({ pluginRoot, config: makeConfig() });
    expect(r.promoted).toHaveLength(0);
    expect(r.reason).toBe('env-not-set');
  });
});
