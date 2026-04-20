import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  _internals,
  installFromRegistry,
  installFromUrl,
  listInstalled,
  uninstall,
} from '../../lib/core/marketplace-installer.js';

function manifestJson(overrides = {}) {
  return JSON.stringify({
    name: 'sample-pack',
    version: '1.0.0',
    artibotVersion: '>=2.8.0',
    dataPolicy: 'local',
    ...overrides,
  });
}

async function mkTmp(prefix = 'artibot-mp') {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Build a source extension directory with a manifest + optional extra file. */
async function makeSourceExt(root, overrides = {}, files = {}) {
  await fs.writeFile(path.join(root, 'artibot.ext.json'), manifestJson(overrides), 'utf-8');
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf-8');
  }
}

describe('marketplace-installer', () => {
  let srcRoot;
  let installRoot;

  beforeEach(async () => {
    srcRoot = await mkTmp('artibot-mp-src');
    installRoot = await mkTmp('artibot-mp-dst');
  });

  afterEach(async () => {
    await fs.rm(srcRoot, { recursive: true, force: true });
    await fs.rm(installRoot, { recursive: true, force: true });
  });

  describe('installFromRegistry', () => {
    it('throws — registry not yet available', async () => {
      await expect(installFromRegistry('anything')).rejects.toThrow(/not yet available/i);
    });
  });

  describe('installFromUrl allow-list', () => {
    it('rejects non-allowlisted https URLs', async () => {
      await expect(installFromUrl('https://evil.com/ext.tgz')).rejects.toThrow(/allowlist/);
    });

    it('throws placeholder for Artibot-owned GitHub URL', async () => {
      await expect(
        installFromUrl('https://github.com/Yoodaddy0311/artibot-ext-foo/archive/v1.tar.gz')
      ).rejects.toThrow(/pending zero-deps tar/i);
    });

    it('rejects empty input', async () => {
      await expect(installFromUrl('')).rejects.toThrow(/non-empty/);
    });

    it('rejects garbled URL', async () => {
      await expect(installFromUrl('::not a url::')).rejects.toThrow(/invalid URL/);
    });
  });

  describe('installFromUrl file://', () => {
    it('installs a valid extension via recursive copy', async () => {
      await makeSourceExt(srcRoot, { name: 'copy-test' }, {
        'agents/a.md': '# agent',
        'skills/foo/SKILL.md': '---\nname: foo\n---',
      });
      const url = pathToFileURL(srcRoot).href;
      const result = await installFromUrl(url, { installRoot });
      expect(result.installed).toBe(true);
      expect(result.manifest.name).toBe('copy-test');
      const copied = await fs.readFile(
        path.join(installRoot, 'artibot-ext-copy-test', 'agents', 'a.md'),
        'utf-8'
      );
      expect(copied).toBe('# agent');
    });

    it('rejects when destination exists and force=false', async () => {
      await makeSourceExt(srcRoot, { name: 'dup-test' });
      const url = pathToFileURL(srcRoot).href;
      await installFromUrl(url, { installRoot });
      await expect(installFromUrl(url, { installRoot })).rejects.toThrow(/already exists/);
    });

    it('overwrites when force=true', async () => {
      await makeSourceExt(srcRoot, { name: 'force-test' }, { 'v.txt': 'v1' });
      const url = pathToFileURL(srcRoot).href;
      await installFromUrl(url, { installRoot });
      // change source
      await fs.writeFile(path.join(srcRoot, 'v.txt'), 'v2', 'utf-8');
      await installFromUrl(url, { installRoot, force: true });
      const after = await fs.readFile(
        path.join(installRoot, 'artibot-ext-force-test', 'v.txt'),
        'utf-8'
      );
      expect(after).toBe('v2');
    });

    it('rejects manifest with forbidden dataPolicy and does NOT leave artifacts', async () => {
      await makeSourceExt(srcRoot, { name: 'bad-policy', dataPolicy: 'external' });
      const url = pathToFileURL(srcRoot).href;
      await expect(installFromUrl(url, { installRoot })).rejects.toThrow(/manifest invalid/);
      const dest = path.join(installRoot, 'artibot-ext-bad-policy');
      await expect(fs.stat(dest)).rejects.toThrow();
    });

    it('rejects when artibot.ext.json is missing at source', async () => {
      // no manifest written
      const url = pathToFileURL(srcRoot).href;
      await expect(installFromUrl(url, { installRoot })).rejects.toThrow(/not found/);
    });

    it('rejects when source is not a directory', async () => {
      const filePath = path.join(srcRoot, 'lonely.txt');
      await fs.writeFile(filePath, 'hi', 'utf-8');
      const url = pathToFileURL(filePath).href;
      await expect(installFromUrl(url, { installRoot })).rejects.toThrow(/must be a directory/);
    });
  });

  describe('uninstall', () => {
    it('removes an installed extension directory', async () => {
      await makeSourceExt(srcRoot, { name: 'rm-test' });
      const url = pathToFileURL(srcRoot).href;
      await installFromUrl(url, { installRoot });
      const before = path.join(installRoot, 'artibot-ext-rm-test');
      await fs.stat(before); // sanity
      const result = await uninstall('rm-test', { installRoot });
      expect(result.removed).toBe(true);
      await expect(fs.stat(before)).rejects.toThrow();
    });

    it('is idempotent when target not present', async () => {
      const result = await uninstall('nonexistent', { installRoot });
      expect(result.removed).toBe(false);
    });

    it('validates pkgName', async () => {
      await expect(uninstall('')).rejects.toThrow(/non-empty/);
    });
  });

  describe('listInstalled', () => {
    it('returns an array of installed extensions', async () => {
      await makeSourceExt(srcRoot, { name: 'list-a' });
      const urlA = pathToFileURL(srcRoot).href;
      await installFromUrl(urlA, { installRoot });

      const srcB = await mkTmp('artibot-mp-src-b');
      await makeSourceExt(srcB, { name: 'list-b', dataPolicy: 'artibot-swarm' });
      await installFromUrl(pathToFileURL(srcB).href, { installRoot });
      await fs.rm(srcB, { recursive: true, force: true });

      const result = await listInstalled({ installRoot });
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['list-a', 'list-b']);
      const b = result.find((r) => r.name === 'list-b');
      expect(b.dataPolicy).toBe('artibot-swarm');
    });

    it('returns [] when install root missing', async () => {
      const result = await listInstalled({ installRoot: path.join(installRoot, 'nope') });
      expect(result).toEqual([]);
    });

    it('silently skips non-extension directories', async () => {
      await fs.mkdir(path.join(installRoot, 'unrelated-dir'), { recursive: true });
      const result = await listInstalled({ installRoot });
      expect(result).toEqual([]);
    });
  });

  describe('_internals', () => {
    it('exposes expected constants', () => {
      expect(_internals.ARTIBOT_GH_PREFIX).toBe('https://github.com/Yoodaddy0311/');
      expect(_internals.EXT_PREFIX).toBe('artibot-ext-');
    });
  });
});
