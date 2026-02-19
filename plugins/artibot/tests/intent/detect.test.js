import { describe, it, expect } from 'vitest';
import { detectIntent } from '../../lib/intent/index.js';

describe('detectIntent() - integration', () => {
  it('returns full analysis for a simple build request', () => {
    const result = detectIntent('build the project');
    expect(result.intents).toContain('action:build');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.best).not.toBeNull();
    expect(result.best.intent).toBe('action:build');
    expect(result.ambiguity.ambiguous).toBe(false);
  });

  it('handles multi-intent input with ambiguity', () => {
    const result = detectIntent('build and deploy the feature');
    expect(result.intents).toContain('action:build');
    expect(result.intents).toContain('action:deploy');
    expect(result.ambiguity.score).toBeGreaterThan(0);
  });

  it('prioritizes team intent', () => {
    const result = detectIntent('summon team to build');
    expect(result.best.intent).toBe('team:summon');
  });

  it('handles Korean input', () => {
    const result = detectIntent('버그 수정해줘');
    expect(result.intents).toContain('action:fix');
    expect(result.best).not.toBeNull();
  });

  it('handles Japanese input', () => {
    const result = detectIntent('テストを実行');
    expect(result.intents).toContain('action:test');
  });

  it('accepts custom languages option', () => {
    const result = detectIntent('build', { languages: ['en'] });
    expect(result.matches.every(m => m.lang === 'en')).toBe(true);
  });

  it('accepts custom ambiguityThreshold', () => {
    const result = detectIntent('build and test', { ambiguityThreshold: 100 });
    expect(result.ambiguity.ambiguous).toBe(false);
  });

  it('returns empty results for gibberish', () => {
    const result = detectIntent('xyzzy foobar baz');
    expect(result.intents).toEqual([]);
    expect(result.best).toBeNull();
    expect(result.ambiguity.ambiguous).toBe(false);
  });
});
