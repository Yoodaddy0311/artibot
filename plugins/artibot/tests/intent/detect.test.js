import { describe, expect, it } from 'vitest';
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
    const result = detectIntent('\uBC84\uADF8 \uC218\uC815\uD574\uC918');
    expect(result.intents).toContain('action:fix');
    expect(result.best).not.toBeNull();
  });

  it('handles Japanese input', () => {
    const result = detectIntent('\u30C6\u30B9\u30C8\u3092\u5B9F\u884C');
    expect(result.intents).toContain('action:test');
  });

  it('handles Chinese input', () => {
    const result = detectIntent('\u4FEE\u590D\u8FD9\u4E2A\u9519\u8BEF');
    expect(result.intents).toContain('action:fix');
    expect(result.best).not.toBeNull();
  });

  it('accepts custom languages option', () => {
    const result = detectIntent('build', { languages: ['en'] });
    expect(result.matches.every((m) => m.lang === 'en')).toBe(true);
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

  it('works with no options argument (uses defaults)', () => {
    const result = detectIntent('implement a feature');
    expect(result).toHaveProperty('intents');
    expect(result).toHaveProperty('matches');
    expect(result).toHaveProperty('recommendations');
    expect(result).toHaveProperty('best');
    expect(result).toHaveProperty('ambiguity');
    expect(result.intents.length).toBeGreaterThan(0);
  });

  it('works with empty options object', () => {
    const result = detectIntent('test the code', {});
    expect(result.intents).toContain('action:test');
    expect(result.ambiguity).toHaveProperty('ambiguous');
  });

  it('works with only languages option set', () => {
    const result = detectIntent('deploy it', { languages: ['en'] });
    expect(result).toHaveProperty('ambiguity');
    expect(result.ambiguity).toHaveProperty('score');
  });
});
