import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _internals,
  discoverExtensions,
  loadExtension,
  validateManifest,
} from '../../lib/core/extension-loader.js';

function validManifest(overrides = {}) {
  return {
    name: 'sample-pack',
    version: '1.0.0',
    artibotVersion: '>=2.8.0',
    dataPolicy: 'local',
    description: 'sample',
    ...overrides,
  };
}

async function mkTmp() {
  const dir = path.join(
    os.tmpdir(),
    `artibot-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('extension-loader', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkTmp();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('validateManifest', () => {
    it('accepts a well-formed manifest', () => {
      const result = validateManifest(validManifest());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects dataPolicy="external" with dataPolicy-specific error', () => {
      const result = validateManifest(validManifest({ dataPolicy: 'external' }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /dataPolicy/.test(e))).toBe(true);
    });

    it('rejects invalid name pattern', () => {
      const result = validateManifest(validManifest({ name: 'Bad_Name' }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /name/i.test(e))).toBe(true);
    });

    it('rejects a name that is only one character', () => {
      const result = validateManifest(validManifest({ name: 'a' }));
      expect(result.valid).toBe(false);
    });

    it('rejects invalid semver version', () => {
      const result = validateManifest(validManifest({ version: '1.0' }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /version/i.test(e))).toBe(true);
    });

    it('rejects invalid artibotVersion range', () => {
      const result = validateManifest(validManifest({ artibotVersion: 'latest' }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /artibotVersion/.test(e))).toBe(true);
    });

    it('flags missing required fields', () => {
      const result = validateManifest({ name: 'ok-name' });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('accepts dataPolicy="artibot-swarm"', () => {
      const result = validateManifest(validManifest({ dataPolicy: 'artibot-swarm' }));
      expect(result.valid).toBe(true);
    });

    it('warns on unknown fields but stays valid', () => {
      const result = validateManifest(validManifest({ nonsense: true }));
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => /nonsense/.test(w))).toBe(true);
    });

    it('rejects non-array for agents/skills fields', () => {
      const result = validateManifest(validManifest({ agents: 'oops' }));
      expect(result.valid).toBe(false);
    });

    it('rejects null manifest', () => {
      const result = validateManifest(null);
      expect(result.valid).toBe(false);
    });
  });

  describe('loadExtension', () => {
    it('reads and parses a valid manifest from disk', async () => {
      const manifest = validManifest({ agents: ['agents/a.md'] });
      await fs.writeFile(
        path.join(tmpDir, 'artibot.ext.json'),
        JSON.stringify(manifest),
        'utf-8'
      );
      const result = await loadExtension(tmpDir);
      expect(result.errors).toEqual([]);
      expect(result.manifest?.name).toBe('sample-pack');
      expect(result.agents).toEqual(['agents/a.md']);
      expect(result.path).toBe(tmpDir);
    });

    it('reports error when manifest is missing', async () => {
      const result = await loadExtension(tmpDir);
      expect(result.manifest).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('reports JSON parse errors', async () => {
      await fs.writeFile(path.join(tmpDir, 'artibot.ext.json'), '{ not json }', 'utf-8');
      const result = await loadExtension(tmpDir);
      expect(result.manifest).toBeNull();
      expect(result.errors.some((e) => /invalid JSON/i.test(e))).toBe(true);
    });

    it('rejects manifest with forbidden dataPolicy', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'artibot.ext.json'),
        JSON.stringify(validManifest({ dataPolicy: 'external' })),
        'utf-8'
      );
      const result = await loadExtension(tmpDir);
      expect(result.manifest).toBeNull();
      expect(result.errors.some((e) => /dataPolicy/.test(e))).toBe(true);
    });
  });

  describe('discoverExtensions', () => {
    it('finds all artibot-ext-* directories under searchPaths', async () => {
      const a = path.join(tmpDir, 'artibot-ext-one');
      const b = path.join(tmpDir, 'artibot-ext-two');
      const nope = path.join(tmpDir, 'unrelated');
      await fs.mkdir(a, { recursive: true });
      await fs.mkdir(b, { recursive: true });
      await fs.mkdir(nope, { recursive: true });
      await fs.writeFile(
        path.join(a, 'artibot.ext.json'),
        JSON.stringify(validManifest({ name: 'one' })),
        'utf-8'
      );
      await fs.writeFile(
        path.join(b, 'artibot.ext.json'),
        JSON.stringify(validManifest({ name: 'two', dataPolicy: 'artibot-swarm' })),
        'utf-8'
      );

      const result = await discoverExtensions({
        extensions: {
          enabled: true,
          searchPaths: [tmpDir],
          allowedDataPolicies: ['local', 'artibot-swarm'],
        },
      });
      const names = result
        .filter((r) => r.manifest)
        .map((r) => r.manifest.name)
        .sort();
      expect(names).toEqual(['one', 'two']);
    });

    it('returns [] when extensions disabled', async () => {
      const result = await discoverExtensions({
        extensions: { enabled: false, searchPaths: [tmpDir] },
      });
      expect(result).toEqual([]);
    });

    it('enforces config.extensions.allowedDataPolicies narrower than default', async () => {
      const dir = path.join(tmpDir, 'artibot-ext-swarmy');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'artibot.ext.json'),
        JSON.stringify(validManifest({ name: 'swarmy', dataPolicy: 'artibot-swarm' })),
        'utf-8'
      );
      const result = await discoverExtensions({
        extensions: {
          enabled: true,
          searchPaths: [tmpDir],
          allowedDataPolicies: ['local'],
        },
      });
      expect(result).toHaveLength(1);
      expect(result[0].manifest).toBeNull();
      expect(result[0].errors.some((e) => /allowedDataPolicies/.test(e))).toBe(true);
    });

    it('silently skips missing search paths', async () => {
      const result = await discoverExtensions({
        extensions: {
          enabled: true,
          searchPaths: [path.join(tmpDir, 'does-not-exist')],
        },
      });
      expect(result).toEqual([]);
    });
  });

  describe('_internals.expandHome', () => {
    it('expands ~ to homedir', () => {
      const out = _internals.expandHome('~/foo');
      expect(out.endsWith(path.join('foo'))).toBe(true);
      expect(out).not.toMatch(/^~/);
    });

    it('returns non-tilde paths unchanged', () => {
      expect(_internals.expandHome('/abs/path')).toBe('/abs/path');
    });
  });
});
