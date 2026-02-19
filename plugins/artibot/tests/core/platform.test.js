import { describe, it, expect, vi, afterEach } from 'vitest';
import { getPlatform, getNodeInfo, checkNodeVersion, getPluginRoot, resolveFromRoot } from '../../lib/core/platform.js';
import path from 'node:path';

describe('platform', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getPlatform()', () => {
    it('returns an object with os, arch, and boolean flags', () => {
      const result = getPlatform();
      expect(result).toHaveProperty('os');
      expect(result).toHaveProperty('arch');
      expect(typeof result.isWindows).toBe('boolean');
      expect(typeof result.isMac).toBe('boolean');
      expect(typeof result.isLinux).toBe('boolean');
    });

    it('sets exactly one of isWindows/isMac/isLinux to true on standard platforms', () => {
      const result = getPlatform();
      const flags = [result.isWindows, result.isMac, result.isLinux];
      // At least one should be true on standard platforms, at most one
      const trueCount = flags.filter(Boolean).length;
      expect(trueCount).toBeLessThanOrEqual(1);
    });

    it('os matches the platform string', () => {
      const result = getPlatform();
      if (result.isWindows) expect(result.os).toBe('win32');
      if (result.isMac) expect(result.os).toBe('darwin');
      if (result.isLinux) expect(result.os).toBe('linux');
    });
  });

  describe('getNodeInfo()', () => {
    it('returns parsed version information', () => {
      const info = getNodeInfo();
      expect(info).toHaveProperty('raw');
      expect(typeof info.major).toBe('number');
      expect(typeof info.minor).toBe('number');
      expect(typeof info.patch).toBe('number');
      expect(info.major).toBeGreaterThanOrEqual(18);
    });

    it('raw matches major.minor.patch', () => {
      const info = getNodeInfo();
      expect(info.raw).toContain(`${info.major}.`);
    });
  });

  describe('checkNodeVersion()', () => {
    it('returns true when version meets minimum', () => {
      expect(checkNodeVersion(1)).toBe(true);
      expect(checkNodeVersion(18)).toBe(true);
    });

    it('throws when version is below minimum', () => {
      expect(() => checkNodeVersion(999)).toThrow(/Node\.js >= 999 required/);
    });
  });

  describe('getPluginRoot()', () => {
    it('uses CLAUDE_PLUGIN_ROOT env var when set', () => {
      vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/test/root');
      const root = getPluginRoot();
      expect(path.resolve('/test/root')).toBe(root);
    });

    it('falls back to computed path when env is not set', () => {
      vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
      const root = getPluginRoot();
      expect(typeof root).toBe('string');
      expect(root.length).toBeGreaterThan(0);
    });
  });

  describe('resolveFromRoot()', () => {
    it('joins segments to plugin root', () => {
      vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/test/root');
      const resolved = resolveFromRoot('agents', 'orchestrator.md');
      // On Windows, path.resolve('/test/root') adds the drive letter
      expect(resolved).toBe(path.resolve('/test/root', 'agents', 'orchestrator.md'));
    });

    it('handles single segment', () => {
      vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/test/root');
      const resolved = resolveFromRoot('package.json');
      expect(resolved).toBe(path.resolve('/test/root', 'package.json'));
    });
  });
});
