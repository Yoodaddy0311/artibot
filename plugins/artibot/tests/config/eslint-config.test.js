import { describe, expect, it } from 'vitest';
import eslintConfig from '../../eslint.config.js';

describe('eslint.config.js', () => {
  it('exports an array of config blocks', () => {
    expect(Array.isArray(eslintConfig)).toBe(true);
    expect(eslintConfig.length).toBeGreaterThan(0);
  });

  it('every block is an object', () => {
    for (const block of eslintConfig) {
      expect(typeof block).toBe('object');
      expect(block).not.toBeNull();
    }
  });

  it('has at least one block with project-wide `files` glob', () => {
    const hasProjectBlock = eslintConfig.some(
      (b) => Array.isArray(b.files) && b.files.some((g) => typeof g === 'string' && g.length > 0),
    );
    expect(hasProjectBlock).toBe(true);
  });

  it('project block covers .js and .mjs', () => {
    const projectBlock = eslintConfig.find(
      (b) => Array.isArray(b.files) && b.files.some((g) => g.includes('{js,mjs}')),
    );
    expect(projectBlock).toBeDefined();
  });

  it('at least one block declares rules', () => {
    const hasRules = eslintConfig.some(
      (b) => b.rules && typeof b.rules === 'object' && Object.keys(b.rules).length > 0,
    );
    expect(hasRules).toBe(true);
  });

  it('eqeqeq rule enforced as error', () => {
    const rulesBlock = eslintConfig.find((b) => b.rules && b.rules.eqeqeq);
    expect(rulesBlock).toBeDefined();
    expect(rulesBlock.rules.eqeqeq).toBe('error');
  });
});
