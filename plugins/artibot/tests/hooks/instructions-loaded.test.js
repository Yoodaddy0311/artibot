import { describe, expect, it } from 'vitest';
import path from 'node:path';

/**
 * instructions-loaded.js auto-executes main() and uses dynamic imports.
 * We test the pure internal logic by re-implementing the validation functions.
 */

// ---------------------------------------------------------------------------
// Re-implemented pure functions from instructions-loaded.js
// ---------------------------------------------------------------------------

function validatePluginStructure(pluginRoot, existsFn) {
  const requiredPaths = [
    'hooks/hooks.json',
    'lib/core/hook-utils.js',
    'lib/learning/tool-learner.js',
    'agents',
    'commands',
    'skills',
  ];

  const missing = requiredPaths.filter(
    (rel) => !existsFn(path.join(pluginRoot, rel))
  );

  return { valid: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('instructions-loaded hook (pure function tests)', () => {
  describe('validatePluginStructure()', () => {
    it('returns valid when all paths exist', () => {
      const { valid, missing } = validatePluginStructure('/plugin', () => true);
      expect(valid).toBe(true);
      expect(missing).toEqual([]);
    });

    it('returns invalid when some paths are missing', () => {
      const existingPaths = new Set([
        path.join('/plugin', 'hooks/hooks.json'),
        path.join('/plugin', 'agents'),
        path.join('/plugin', 'commands'),
        path.join('/plugin', 'skills'),
      ]);
      const { valid, missing } = validatePluginStructure(
        '/plugin',
        (p) => existingPaths.has(p)
      );
      expect(valid).toBe(false);
      expect(missing).toContain('lib/core/hook-utils.js');
      expect(missing).toContain('lib/learning/tool-learner.js');
    });

    it('returns all paths missing when nothing exists', () => {
      const { valid, missing } = validatePluginStructure('/plugin', () => false);
      expect(valid).toBe(false);
      expect(missing).toHaveLength(6);
    });

    it('checks hooks/hooks.json specifically', () => {
      const existingPaths = new Set([
        path.join('/plugin', 'lib/core/hook-utils.js'),
        path.join('/plugin', 'lib/learning/tool-learner.js'),
        path.join('/plugin', 'agents'),
        path.join('/plugin', 'commands'),
        path.join('/plugin', 'skills'),
      ]);
      const { valid, missing } = validatePluginStructure(
        '/plugin',
        (p) => existingPaths.has(p)
      );
      expect(valid).toBe(false);
      expect(missing).toEqual(['hooks/hooks.json']);
    });
  });

  describe('instruction source extraction', () => {
    it('extracts source from hookData.source', () => {
      const hookData = { source: '/path/to/CLAUDE.md' };
      const source = hookData.source || hookData.file || 'unknown';
      expect(source).toBe('/path/to/CLAUDE.md');
    });

    it('falls back to hookData.file', () => {
      const hookData = { file: '/path/to/rules/dev.md' };
      const source = hookData.source || hookData.file || 'unknown';
      expect(source).toBe('/path/to/rules/dev.md');
    });

    it('defaults to unknown when neither present', () => {
      const hookData = {};
      const source = hookData.source || hookData.file || 'unknown';
      expect(source).toBe('unknown');
    });

    it('extracts basename from source path', () => {
      const source = '/home/user/.claude/rules/dev-protocol.md';
      const basename = path.basename(source);
      expect(basename).toBe('dev-protocol.md');
    });
  });

  describe('instruction type extraction', () => {
    it('extracts type from hookData', () => {
      const hookData = { type: 'claude_md' };
      const instructionType = hookData.type || 'instructions';
      expect(instructionType).toBe('claude_md');
    });

    it('defaults to instructions', () => {
      const hookData = {};
      const instructionType = hookData.type || 'instructions';
      expect(instructionType).toBe('instructions');
    });
  });
});
