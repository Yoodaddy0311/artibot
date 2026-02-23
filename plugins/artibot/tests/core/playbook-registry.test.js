import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  getPlaybook,
  listPlaybooks,
  loadSystemPlaybooks,
  loadUserPlaybooks,
  saveUserPlaybook,
} from '../../lib/core/playbook-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to the real plugin config */
const REAL_CONFIG = path.resolve(
  new URL('../../artibot.config.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'),
);

/** Write a temporary config and return its path */
async function writeTempConfig(data, dir) {
  const p = path.join(dir, 'artibot.config.json');
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf-8');
  return p;
}

// ---------------------------------------------------------------------------
// Setup: temp dirs for user playbooks
// ---------------------------------------------------------------------------

let tempDir;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artibot-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// loadSystemPlaybooks()
// ---------------------------------------------------------------------------

describe('loadSystemPlaybooks()', () => {
  it('loads all 8 playbooks from real config', async () => {
    const map = await loadSystemPlaybooks(REAL_CONFIG);
    expect(map.size).toBe(8);
    expect(map.has('feature')).toBe(true);
    expect(map.has('bugfix')).toBe(true);
    expect(map.has('refactor')).toBe(true);
    expect(map.has('security')).toBe(true);
    expect(map.has('marketing-campaign')).toBe(true);
    expect(map.has('marketing-audit')).toBe(true);
    expect(map.has('content-launch')).toBe(true);
    expect(map.has('competitive-analysis')).toBe(true);
  });

  it('returns correct PlaybookInfo shape for feature', async () => {
    const map = await loadSystemPlaybooks(REAL_CONFIG);
    const feature = map.get('feature');
    expect(feature).toBeDefined();
    expect(feature.name).toBe('feature');
    expect(feature.source).toBe('system');
    expect(Array.isArray(feature.phases)).toBe(true);
    expect(feature.phases).toHaveLength(5);
    expect(feature.phaseCount).toBe(5);
    expect(feature.patterns).toContain('leader');
    expect(feature.patterns).toContain('council');
    expect(feature.patterns).toContain('swarm');
    expect(typeof feature.domain).toBe('string');
    expect(Array.isArray(feature.tags)).toBe(true);
  });

  it('picks up playbookMeta description and domain', async () => {
    const map = await loadSystemPlaybooks(REAL_CONFIG);
    const feature = map.get('feature');
    expect(feature.description).toBe('End-to-end feature implementation');
    expect(feature.domain).toBe('development');
    expect(feature.tags).toContain('feature');
  });

  it('returns empty Map for non-existent config', async () => {
    const map = await loadSystemPlaybooks('/nonexistent/path/artibot.config.json');
    expect(map.size).toBe(0);
  });

  it('returns empty Map when playbooks section is missing', async () => {
    const cfg = await writeTempConfig({ version: '1.0.0', team: {} }, tempDir);
    const map = await loadSystemPlaybooks(cfg);
    expect(map.size).toBe(0);
  });

  it('handles config without playbookMeta gracefully', async () => {
    const cfg = await writeTempConfig({
      team: {
        playbooks: {
          simple: '[leader] plan -> [swarm] implement',
        },
      },
    }, tempDir);
    const map = await loadSystemPlaybooks(cfg);
    expect(map.size).toBe(1);
    const simple = map.get('simple');
    expect(simple.description).toBe('');
    expect(simple.domain).toBe('general');
  });

  it('parses phases correctly for security playbook', async () => {
    const map = await loadSystemPlaybooks(REAL_CONFIG);
    const sec = map.get('security');
    expect(sec.phases[0]).toEqual({ order: 0, pattern: 'leader', action: 'scan', label: 'scan' });
    expect(sec.domain).toBe('security');
  });
});

// ---------------------------------------------------------------------------
// loadUserPlaybooks()
// ---------------------------------------------------------------------------

describe('loadUserPlaybooks()', () => {
  it('returns empty Map for empty directory', async () => {
    const map = await loadUserPlaybooks(tempDir);
    expect(map.size).toBe(0);
  });

  it('returns empty Map for non-existent directory', async () => {
    const map = await loadUserPlaybooks(path.join(tempDir, 'nonexistent'));
    expect(map.size).toBe(0);
  });

  it('loads a valid user playbook JSON file', async () => {
    const data = {
      name: 'my-flow',
      description: 'My custom flow',
      phases: [
        { order: 0, pattern: 'leader', action: 'plan', label: 'plan' },
        { order: 1, pattern: 'swarm', action: 'implement', label: 'implement' },
      ],
    };
    await fs.writeFile(path.join(tempDir, 'my-flow.json'), JSON.stringify(data), 'utf-8');

    const map = await loadUserPlaybooks(tempDir);
    expect(map.size).toBe(1);
    expect(map.has('my-flow')).toBe(true);

    const pb = map.get('my-flow');
    expect(pb.source).toBe('user');
    expect(pb.description).toBe('My custom flow');
    expect(pb.phaseCount).toBe(2);
  });

  it('skips invalid JSON files', async () => {
    await fs.writeFile(path.join(tempDir, 'bad.json'), 'not json', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'good.json'), JSON.stringify({
      name: 'good',
      phases: [{ order: 0, pattern: 'leader', action: 'plan', label: 'plan' }],
    }), 'utf-8');

    const map = await loadUserPlaybooks(tempDir);
    expect(map.has('good')).toBe(true);
    expect(map.has('bad')).toBe(false);
  });

  it('ignores non-.json files', async () => {
    await fs.writeFile(path.join(tempDir, 'readme.md'), '# hello', 'utf-8');
    const map = await loadUserPlaybooks(tempDir);
    expect(map.size).toBe(0);
  });

  it('uses filename as name when name field absent', async () => {
    await fs.writeFile(path.join(tempDir, 'unnamed-flow.json'), JSON.stringify({
      phases: [{ order: 0, pattern: 'leader', action: 'plan', label: 'plan' }],
    }), 'utf-8');

    const map = await loadUserPlaybooks(tempDir);
    expect(map.has('unnamed-flow')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveUserPlaybook()
// ---------------------------------------------------------------------------

describe('saveUserPlaybook()', () => {
  it('saves a playbook from string', async () => {
    const result = await saveUserPlaybook('new-flow', '[leader] plan -> [swarm] implement', tempDir);
    expect(result.saved).toBe(true);

    const files = await fs.readdir(tempDir);
    expect(files).toContain('new-flow.json');
  });

  it('saves a playbook from object', async () => {
    const pb = { phases: [{ order: 0, pattern: 'council', action: 'review', label: 'review' }] };
    const result = await saveUserPlaybook('obj-flow', pb, tempDir);
    expect(result.saved).toBe(true);
  });

  it('creates directory if not exists', async () => {
    const nested = path.join(tempDir, 'deep', 'nested');
    const result = await saveUserPlaybook('deep-flow', '[leader] plan', nested);
    expect(result.saved).toBe(true);
  });

  it('rejects empty name', async () => {
    const result = await saveUserPlaybook('', '[leader] plan', tempDir);
    expect(result.saved).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects null name', async () => {
    const result = await saveUserPlaybook(null, '[leader] plan', tempDir);
    expect(result.saved).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects invalid playbook (empty string)', async () => {
    const result = await saveUserPlaybook('invalid-flow', '', tempDir);
    expect(result.saved).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects invalid playbook (unknown pattern)', async () => {
    const result = await saveUserPlaybook('bad-pattern', '[alien] plan', tempDir);
    expect(result.saved).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('sanitizes special characters in name for filename', async () => {
    const result = await saveUserPlaybook('my flow!@#', '[leader] plan', tempDir);
    expect(result.saved).toBe(true);

    const files = await fs.readdir(tempDir);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
  });

  it('saved file can be re-loaded by loadUserPlaybooks', async () => {
    await saveUserPlaybook('round-trip', '[leader] plan -> [swarm] implement', tempDir);
    const map = await loadUserPlaybooks(tempDir);
    expect(map.has('round-trip')).toBe(true);
    const pb = map.get('round-trip');
    expect(pb.phaseCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// listPlaybooks()
// ---------------------------------------------------------------------------

describe('listPlaybooks()', () => {
  it('lists all system playbooks from real config', async () => {
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir });
    expect(list.length).toBeGreaterThanOrEqual(8);
    const names = list.map((p) => p.name);
    expect(names).toContain('feature');
    expect(names).toContain('security');
    expect(names).toContain('marketing-campaign');
  });

  it('returns sorted results', async () => {
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir });
    const names = list.map((p) => p.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('filters by domain=development', async () => {
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir, domain: 'development' });
    expect(list.length).toBeGreaterThan(0);
    for (const pb of list) {
      expect(pb.domain).toBe('development');
    }
  });

  it('filters by domain=marketing', async () => {
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir, domain: 'marketing' });
    expect(list.length).toBeGreaterThan(0);
    for (const pb of list) {
      expect(pb.domain).toBe('marketing');
    }
  });

  it('filters by domain=security', async () => {
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir, domain: 'security' });
    expect(list.length).toBeGreaterThan(0);
    for (const pb of list) {
      expect(pb.domain).toBe('security');
    }
  });

  it('returns empty list for unknown domain', async () => {
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir, domain: 'nonexistent' });
    expect(list).toEqual([]);
  });

  it('includes user playbooks', async () => {
    await saveUserPlaybook('user-test', '[leader] plan -> [swarm] implement', tempDir);
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir });
    expect(list.some((p) => p.name === 'user-test' && p.source === 'user')).toBe(true);
  });

  it('filters by source=system only', async () => {
    await saveUserPlaybook('user-only', '[leader] plan', tempDir);
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir, source: 'system' });
    expect(list.every((p) => p.source === 'system')).toBe(true);
    expect(list.some((p) => p.name === 'user-only')).toBe(false);
  });

  it('filters by source=user only', async () => {
    await saveUserPlaybook('user-check', '[leader] plan', tempDir);
    const list = await listPlaybooks({ configPath: REAL_CONFIG, userDir: tempDir, source: 'user' });
    expect(list.every((p) => p.source === 'user')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPlaybook()
// ---------------------------------------------------------------------------

describe('getPlaybook()', () => {
  it('returns the feature playbook', async () => {
    const pb = await getPlaybook('feature', { configPath: REAL_CONFIG, userDir: tempDir });
    expect(pb).toBeDefined();
    expect(pb.name).toBe('feature');
    expect(pb.phases).toHaveLength(5);
  });

  it('returns the security playbook', async () => {
    const pb = await getPlaybook('security', { configPath: REAL_CONFIG, userDir: tempDir });
    expect(pb).toBeDefined();
    expect(pb.domain).toBe('security');
  });

  it('returns null for non-existent name', async () => {
    const pb = await getPlaybook('does-not-exist', { configPath: REAL_CONFIG, userDir: tempDir });
    expect(pb).toBeNull();
  });

  it('returns null for null/empty name', async () => {
    expect(await getPlaybook(null, { configPath: REAL_CONFIG, userDir: tempDir })).toBeNull();
    expect(await getPlaybook('', { configPath: REAL_CONFIG, userDir: tempDir })).toBeNull();
  });

  it('finds a user-saved playbook', async () => {
    await saveUserPlaybook('user-find-me', '[council] plan -> [swarm] implement', tempDir);
    const pb = await getPlaybook('user-find-me', { configPath: REAL_CONFIG, userDir: tempDir });
    expect(pb).toBeDefined();
    expect(pb.source).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Domain detection
// ---------------------------------------------------------------------------

describe('Domain detection', () => {
  it('detects development domain from name', async () => {
    const cfg = await writeTempConfig({
      team: { playbooks: { 'my-feature': '[leader] plan -> [swarm] implement' } },
    }, tempDir);
    const map = await loadSystemPlaybooks(cfg);
    expect(map.get('my-feature').domain).toBe('development');
  });

  it('detects marketing domain from name', async () => {
    const cfg = await writeTempConfig({
      team: { playbooks: { 'marketing-flow': '[leader] plan -> [swarm] create' } },
    }, tempDir);
    const map = await loadSystemPlaybooks(cfg);
    expect(map.get('marketing-flow').domain).toBe('marketing');
  });

  it('detects security domain from name', async () => {
    const cfg = await writeTempConfig({
      team: { playbooks: { 'security-scan': '[leader] scan -> [council] verify' } },
    }, tempDir);
    const map = await loadSystemPlaybooks(cfg);
    expect(map.get('security-scan').domain).toBe('security');
  });

  it('falls back to general for unrecognized names', async () => {
    const cfg = await writeTempConfig({
      team: { playbooks: { 'xyz-workflow': '[leader] plan -> [swarm] execute' } },
    }, tempDir);
    const map = await loadSystemPlaybooks(cfg);
    expect(map.get('xyz-workflow').domain).toBe('general');
  });
});
