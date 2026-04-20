import { describe, expect, it } from 'vitest';
import * as sdk from '../../lib/sdk/index.js';

describe('sdk barrel (index.js)', () => {
  it('exports createSkill function', () => {
    expect(typeof sdk.createSkill).toBe('function');
  });

  it('exports createAgent function', () => {
    expect(typeof sdk.createAgent).toBe('function');
  });

  it('exports createHook function', () => {
    expect(typeof sdk.createHook).toBe('function');
  });

  it('exports createMiddleware function', () => {
    expect(typeof sdk.createMiddleware).toBe('function');
  });

  it('exports validatePackage function', () => {
    expect(typeof sdk.validatePackage).toBe('function');
  });

  it('exports exactly 5 public functions', () => {
    const exports = Object.keys(sdk);
    expect(exports).toHaveLength(5);
    expect(exports).toContain('createSkill');
    expect(exports).toContain('createAgent');
    expect(exports).toContain('createHook');
    expect(exports).toContain('createMiddleware');
    expect(exports).toContain('validatePackage');
  });
});
