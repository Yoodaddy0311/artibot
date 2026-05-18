/**
 * Unit tests for lib/autopilot/_engine-helpers-v4.11.js
 *
 * Covers:
 *   - buildAutoWireBlock: happy path, empty input, missing instruction, non-string
 *   - mergeAutoWireIntoState: appends, strips instruction, immutable, multi
 *   - mergeAutoWireIntoState: rejects bad state, skips bad entries
 */
import { describe, expect, it } from 'vitest';
import {
  buildAutoWireBlock,
  mergeAutoWireIntoState,
} from '../../lib/autopilot/_engine-helpers-v4.11.js';

describe('buildAutoWireBlock', () => {
  it('renders the instruction wrapped in hr delimiters', () => {
    const out = buildAutoWireBlock({ instruction: 'Hello world' });
    expect(out).toContain('Hello world');
    expect(out.startsWith('---')).toBe(true);
    expect(out.endsWith('---')).toBe(true);
  });

  it('returns empty string for null', () => {
    expect(buildAutoWireBlock(null)).toBe('');
  });

  it('returns empty string for non-object', () => {
    expect(buildAutoWireBlock('not an object')).toBe('');
    expect(buildAutoWireBlock(42)).toBe('');
  });

  it('returns empty string when instruction is missing', () => {
    expect(buildAutoWireBlock({ costEstimate: { estimatedTokens: 1 } })).toBe('');
  });

  it('returns empty string when instruction is empty/whitespace', () => {
    expect(buildAutoWireBlock({ instruction: '   ' })).toBe('');
    expect(buildAutoWireBlock({ instruction: '' })).toBe('');
  });

  it('trims instruction whitespace', () => {
    const out = buildAutoWireBlock({ instruction: '  body  \n' });
    expect(out).toContain('body');
    expect(out).not.toContain('  body');
  });

  it('ignores non-string instruction', () => {
    expect(buildAutoWireBlock({ instruction: 123 })).toBe('');
  });
});

describe('mergeAutoWireIntoState', () => {
  it('appends a single result to a fresh state', () => {
    const state = { sessionId: 'ap-1', task: 't' };
    const next = mergeAutoWireIntoState(state, {
      instruction: 'foo',
      driftPct: 12,
    });
    expect(Array.isArray(next.autoWireData)).toBe(true);
    expect(next.autoWireData).toHaveLength(1);
    expect(next.autoWireData[0].driftPct).toBe(12);
  });

  it('strips the `instruction` field from the persisted entry', () => {
    const state = { sessionId: 'ap-2' };
    const next = mergeAutoWireIntoState(state, {
      instruction: 'rendered markdown',
      complexity: { level: 'medium' },
    });
    expect(next.autoWireData[0].instruction).toBeUndefined();
    expect(next.autoWireData[0].complexity).toEqual({ level: 'medium' });
  });

  it('preserves prior autoWireData entries', () => {
    const state = {
      sessionId: 'ap-3',
      autoWireData: [{ ts: '2020-01-01T00:00:00Z', driftPct: 0 }],
    };
    const next = mergeAutoWireIntoState(state, { instruction: 'new', driftPct: 50 });
    expect(next.autoWireData).toHaveLength(2);
    expect(next.autoWireData[0].driftPct).toBe(0);
    expect(next.autoWireData[1].driftPct).toBe(50);
  });

  it('does NOT mutate the input state', () => {
    const state = { sessionId: 'ap-4', autoWireData: [] };
    const before = state.autoWireData;
    const next = mergeAutoWireIntoState(state, { instruction: 'x' });
    expect(state.autoWireData).toBe(before);
    expect(state.autoWireData).toHaveLength(0);
    expect(next.autoWireData).toHaveLength(1);
    expect(next).not.toBe(state);
  });

  it('accepts an array of results', () => {
    const state = { sessionId: 'ap-5' };
    const next = mergeAutoWireIntoState(state, [
      { instruction: 'a', driftPct: 1 },
      { instruction: 'b', driftPct: 2 },
    ]);
    expect(next.autoWireData).toHaveLength(2);
  });

  it('skips null/non-object entries in an array', () => {
    const state = { sessionId: 'ap-6' };
    const next = mergeAutoWireIntoState(state, [
      null,
      { instruction: 'good', driftPct: 3 },
      'bad string',
      undefined,
    ]);
    expect(next.autoWireData).toHaveLength(1);
    expect(next.autoWireData[0].driftPct).toBe(3);
  });

  it('stamps a ts on every appended entry', () => {
    const state = { sessionId: 'ap-7' };
    const next = mergeAutoWireIntoState(state, { instruction: 'x' });
    expect(typeof next.autoWireData[0].ts).toBe('string');
    expect(next.autoWireData[0].ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('throws TypeError on non-object state', () => {
    expect(() => mergeAutoWireIntoState(null, { instruction: 'x' })).toThrow(TypeError);
    expect(() => mergeAutoWireIntoState('bad', { instruction: 'x' })).toThrow(TypeError);
  });

  it('treats non-array prior autoWireData as a fresh list', () => {
    const state = { sessionId: 'ap-8', autoWireData: 'corrupted' };
    const next = mergeAutoWireIntoState(state, { instruction: 'x', driftPct: 9 });
    expect(next.autoWireData).toHaveLength(1);
    expect(next.autoWireData[0].driftPct).toBe(9);
  });

  it('handles a single null result without throwing', () => {
    const state = { sessionId: 'ap-9' };
    const next = mergeAutoWireIntoState(state, null);
    expect(next.autoWireData).toHaveLength(0);
  });
});
