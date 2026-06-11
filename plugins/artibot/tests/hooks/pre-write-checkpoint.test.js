import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSessionId } from '../../scripts/hooks/pre-write-checkpoint.js';

describe('pre-write-checkpoint resolveSessionId', () => {
  const original = process.env.CLAUDE_SESSION_ID;

  beforeEach(() => {
    delete process.env.CLAUDE_SESSION_ID;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = original;
    }
  });

  it('reads session_id from the parsed hook payload', () => {
    expect(resolveSessionId({ session_id: 'sess-abc' })).toBe('sess-abc');
  });

  it('prefers payload session_id over the env fallback', () => {
    process.env.CLAUDE_SESSION_ID = 'env-fallback';
    expect(resolveSessionId({ session_id: 'sess-xyz' })).toBe('sess-xyz');
  });

  it('falls back to CLAUDE_SESSION_ID env when payload lacks session_id', () => {
    process.env.CLAUDE_SESSION_ID = 'env-fallback';
    expect(resolveSessionId({})).toBe('env-fallback');
  });

  it("collapses to 'default' only when neither payload nor env provide an id", () => {
    expect(resolveSessionId({})).toBe('default');
    expect(resolveSessionId(null)).toBe('default');
  });

  it('does not collide distinct payload sessions under default', () => {
    const a = resolveSessionId({ session_id: 'A' });
    const b = resolveSessionId({ session_id: 'B' });
    expect(a).not.toBe(b);
    expect(a).not.toBe('default');
    expect(b).not.toBe('default');
  });
});
