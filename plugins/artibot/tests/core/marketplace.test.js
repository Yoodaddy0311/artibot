import { describe, expect, it } from 'vitest';
import {
  _INSTALL_PROFILES,
  checkUpdate,
  computeUpdateDiff,
  createInstallPlan,
  createManifest,
  detectConflicts,
  parseSemver,
} from '../../lib/core/marketplace.js';

describe('marketplace', () => {
  describe('createManifest', () => {
    it('creates manifest with checksums for all files', () => {
      const manifest = createManifest({
        name: 'artibot',
        version: '1.15.0',
        fileContents: { 'a.js': 'hello', 'b.js': 'world' },
        profile: 'full',
      });

      expect(manifest.name).toBe('artibot');
      expect(manifest.version).toBe('1.15.0');
      expect(manifest.files).toEqual(['a.js', 'b.js']);
      expect(manifest.checksums['a.js']).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.checksums['b.js']).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.profile).toBe('full');
      expect(manifest.installedAt).toBeTruthy();
    });

    it('different content produces different checksums', () => {
      const m1 = createManifest({ name: 'a', version: '1.0.0', fileContents: { 'x.js': 'aaa' }, profile: 'full' });
      const m2 = createManifest({ name: 'a', version: '1.0.0', fileContents: { 'x.js': 'bbb' }, profile: 'full' });
      expect(m1.checksums['x.js']).not.toBe(m2.checksums['x.js']);
    });
  });

  describe('computeUpdateDiff', () => {
    const installed = {
      files: ['a.js', 'b.js', 'c.js'],
      checksums: { 'a.js': 'aaa', 'b.js': 'bbb', 'c.js': 'ccc' },
    };
    const incoming = {
      files: ['a.js', 'b.js', 'd.js'],
      checksums: { 'a.js': 'aaa', 'b.js': 'BBB', 'd.js': 'ddd' },
    };

    it('detects added, modified, removed, and unchanged files', () => {
      const diff = computeUpdateDiff(installed, incoming);
      expect(diff.added).toEqual(['d.js']);
      expect(diff.modified).toEqual(['b.js']);
      expect(diff.removed).toEqual(['c.js']);
      expect(diff.unchanged).toEqual(['a.js']);
    });

    it('returns all unchanged when manifests are identical', () => {
      const diff = computeUpdateDiff(installed, installed);
      expect(diff.added).toEqual([]);
      expect(diff.modified).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.unchanged).toEqual(['a.js', 'b.js', 'c.js']);
    });
  });

  describe('detectConflicts', () => {
    it('detects file ownership conflicts', () => {
      const existing = [{ name: 'other-plugin', files: ['shared.js'], checksums: {} }];
      const incoming = { name: 'artibot', files: ['shared.js', 'unique.js'], checksums: {} };

      const report = detectConflicts(incoming, existing);
      expect(report.hasConflicts).toBe(true);
      expect(report.conflicts).toHaveLength(1);
      expect(report.conflicts[0].file).toBe('shared.js');
      expect(report.conflicts[0].ownedBy).toBe('other-plugin');
    });

    it('no conflicts when files are unique', () => {
      const existing = [{ name: 'other', files: ['x.js'], checksums: {} }];
      const incoming = { name: 'artibot', files: ['y.js'], checksums: {} };

      expect(detectConflicts(incoming, existing).hasConflicts).toBe(false);
    });

    it('same package name does not conflict with itself', () => {
      const existing = [{ name: 'artibot', files: ['a.js'], checksums: {} }];
      const incoming = { name: 'artibot', files: ['a.js'], checksums: {} };

      expect(detectConflicts(incoming, existing).hasConflicts).toBe(false);
    });
  });

  describe('createInstallPlan', () => {
    it('returns components for a valid profile', () => {
      const plan = createInstallPlan('engineering');
      expect(plan.profile).toBe('engineering');
      expect(plan.components.length).toBeGreaterThan(0);
      expect(plan.fileCount).toBe(plan.components.length);
    });

    it('returns empty for unknown profile', () => {
      const plan = createInstallPlan('nonexistent');
      expect(plan.components).toEqual([]);
      expect(plan.fileCount).toBe(0);
    });

    it('full profile aggregates all domain profiles', () => {
      const plan = createInstallPlan('full');
      expect(plan.components.length).toBeGreaterThan(10);
    });
  });

  describe('parseSemver', () => {
    it('parses standard semver', () => {
      expect(parseSemver('1.15.0')).toEqual({ major: 1, minor: 15, patch: 0 });
    });

    it('strips v prefix', () => {
      expect(parseSemver('v2.3.4')).toEqual({ major: 2, minor: 3, patch: 4 });
    });

    it('strips prerelease suffix', () => {
      expect(parseSemver('1.0.0-beta.1')).toEqual({ major: 1, minor: 0, patch: 0 });
    });

    it('handles missing parts', () => {
      expect(parseSemver('1')).toEqual({ major: 1, minor: 0, patch: 0 });
    });
  });

  describe('checkUpdate', () => {
    it('detects major update', () => {
      expect(checkUpdate('1.15.0', '2.0.0')).toEqual({ available: true, type: 'major' });
    });

    it('detects minor update', () => {
      expect(checkUpdate('1.15.0', '1.16.0')).toEqual({ available: true, type: 'minor' });
    });

    it('detects patch update', () => {
      expect(checkUpdate('1.15.0', '1.15.1')).toEqual({ available: true, type: 'patch' });
    });

    it('no update when same version', () => {
      expect(checkUpdate('1.15.0', '1.15.0')).toEqual({ available: false, type: 'none' });
    });

    it('no update when current is newer', () => {
      expect(checkUpdate('2.0.0', '1.15.0')).toEqual({ available: false, type: 'none' });
    });
  });

  describe('INSTALL_PROFILES', () => {
    it('has at least 5 profiles', () => {
      expect(Object.keys(_INSTALL_PROFILES).length).toBeGreaterThanOrEqual(5);
    });

    it('each profile has name and description', () => {
      for (const [, profile] of Object.entries(_INSTALL_PROFILES)) {
        expect(profile.name).toBeTruthy();
        expect(profile.description).toBeTruthy();
      }
    });
  });
});
