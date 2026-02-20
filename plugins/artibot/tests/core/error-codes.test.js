import { describe, it, expect } from 'vitest';
import {
  ErrorCodes,
  getErrorMessage,
  isError,
  getErrorCategory,
  getErrorsByCategory,
  listAllErrors,
} from '../../lib/core/error-codes.js';

// ---------------------------------------------------------------------------
// ErrorCodes enum
// ---------------------------------------------------------------------------
describe('ErrorCodes', () => {
  it('is a frozen object', () => {
    expect(Object.isFrozen(ErrorCodes)).toBe(true);
  });

  it('contains config error codes (E1xx)', () => {
    expect(ErrorCodes.CONFIG_NOT_FOUND).toBe('E101');
    expect(ErrorCodes.CONFIG_PARSE_ERROR).toBe('E102');
    expect(ErrorCodes.CONFIG_VALIDATION).toBe('E103');
  });

  it('contains hook error codes (E2xx)', () => {
    expect(ErrorCodes.HOOK_LOAD_FAILED).toBe('E201');
    expect(ErrorCodes.HOOK_EXECUTION_ERROR).toBe('E202');
    expect(ErrorCodes.HOOK_TIMEOUT).toBe('E203');
    expect(ErrorCodes.HOOK_BLOCKED).toBe('E207');
  });

  it('contains agent error codes (E3xx)', () => {
    expect(ErrorCodes.AGENT_NOT_FOUND).toBe('E301');
    expect(ErrorCodes.AGENT_SPAWN_FAILED).toBe('E302');
    expect(ErrorCodes.TEAM_CREATE_FAILED).toBe('E304');
    expect(ErrorCodes.TEAM_LIMIT_EXCEEDED).toBe('E308');
  });

  it('contains privacy error codes (E4xx)', () => {
    expect(ErrorCodes.PII_SCRUB_FAILED).toBe('E401');
    expect(ErrorCodes.HOMOGLYPH_DETECTED).toBe('E404');
    expect(ErrorCodes.PII_RESIDUAL_FOUND).toBe('E405');
  });

  it('contains cache error codes (E5xx)', () => {
    expect(ErrorCodes.CACHE_INIT_FAILED).toBe('E501');
    expect(ErrorCodes.CACHE_READ_ERROR).toBe('E502');
    expect(ErrorCodes.CACHE_CAPACITY_EXCEEDED).toBe('E505');
  });

  it('contains intent error codes (E6xx)', () => {
    expect(ErrorCodes.INTENT_PARSE_FAILED).toBe('E601');
    expect(ErrorCodes.INTENT_AMBIGUOUS).toBe('E602');
  });

  it('contains cognitive error codes (E7xx)', () => {
    expect(ErrorCodes.COGNITIVE_ROUTE_FAILED).toBe('E701');
    expect(ErrorCodes.SYSTEM1_FAILURE).toBe('E702');
    expect(ErrorCodes.SYSTEM2_TIMEOUT).toBe('E703');
  });

  it('contains learning error codes (E8xx)', () => {
    expect(ErrorCodes.LEARNING_COLLECT_FAILED).toBe('E801');
    expect(ErrorCodes.GRPO_OPTIMIZE_ERROR).toBe('E802');
    expect(ErrorCodes.MEMORY_PERSIST_FAILED).toBe('E806');
  });

  it('contains swarm error codes (E9xx)', () => {
    expect(ErrorCodes.SWARM_CONNECTION_FAILED).toBe('E901');
    expect(ErrorCodes.SWARM_UPLOAD_ERROR).toBe('E902');
    expect(ErrorCodes.SWARM_PAYLOAD_TOO_LARGE).toBe('E905');
  });

  it('all codes follow Exxx format', () => {
    for (const code of Object.values(ErrorCodes)) {
      expect(code).toMatch(/^E\d{3}$/);
    }
  });

  it('has no duplicate codes', () => {
    const codes = Object.values(ErrorCodes);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ---------------------------------------------------------------------------
// getErrorMessage()
// ---------------------------------------------------------------------------
describe('getErrorMessage()', () => {
  it('returns message for valid config error code', () => {
    const msg = getErrorMessage('E101');
    expect(msg).toContain('Configuration file not found');
  });

  it('returns message for valid hook error code', () => {
    const msg = getErrorMessage('E203');
    expect(msg).toContain('timeout');
  });

  it('returns message for valid agent error code', () => {
    const msg = getErrorMessage('E301');
    expect(msg).toContain('Agent definition not found');
  });

  it('returns message for valid privacy error code', () => {
    const msg = getErrorMessage('E404');
    expect(msg).toContain('homoglyph');
  });

  it('returns message for valid cache error code', () => {
    const msg = getErrorMessage('E501');
    expect(msg).toContain('Cache initialization');
  });

  it('returns message for valid swarm error code', () => {
    const msg = getErrorMessage('E905');
    expect(msg).toContain('5MB');
  });

  it('returns unknown message for unregistered code', () => {
    const msg = getErrorMessage('E999');
    expect(msg).toContain('Unknown error code');
    expect(msg).toContain('E999');
  });

  it('handles null input', () => {
    const msg = getErrorMessage(null);
    expect(msg).toContain('Unknown');
  });

  it('handles undefined input', () => {
    const msg = getErrorMessage(undefined);
    expect(msg).toContain('Unknown');
  });

  it('handles non-string input', () => {
    const msg = getErrorMessage(101);
    expect(msg).toContain('Unknown');
  });

  it('handles empty string', () => {
    const msg = getErrorMessage('');
    expect(msg).toContain('Unknown');
  });

  it('returns different messages for each config code', () => {
    const m1 = getErrorMessage('E101');
    const m2 = getErrorMessage('E102');
    const m3 = getErrorMessage('E103');
    expect(m1).not.toBe(m2);
    expect(m2).not.toBe(m3);
  });
});

// ---------------------------------------------------------------------------
// isError()
// ---------------------------------------------------------------------------
describe('isError()', () => {
  it('returns true for valid error codes', () => {
    expect(isError('E101')).toBe(true);
    expect(isError('E201')).toBe(true);
    expect(isError('E301')).toBe(true);
    expect(isError('E401')).toBe(true);
    expect(isError('E501')).toBe(true);
    expect(isError('E601')).toBe(true);
    expect(isError('E701')).toBe(true);
    expect(isError('E801')).toBe(true);
    expect(isError('E901')).toBe(true);
  });

  it('returns false for unregistered codes', () => {
    expect(isError('E999')).toBe(false);
    expect(isError('E000')).toBe(false);
    expect(isError('E150')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isError(undefined)).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(isError(101)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isError('')).toBe(false);
  });

  it('returns false for arbitrary strings', () => {
    expect(isError('hello')).toBe(false);
    expect(isError('ERROR')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getErrorCategory()
// ---------------------------------------------------------------------------
describe('getErrorCategory()', () => {
  it('returns "config" for E1xx codes', () => {
    expect(getErrorCategory('E101')).toBe('config');
    expect(getErrorCategory('E106')).toBe('config');
  });

  it('returns "hook" for E2xx codes', () => {
    expect(getErrorCategory('E201')).toBe('hook');
    expect(getErrorCategory('E207')).toBe('hook');
  });

  it('returns "agent" for E3xx codes', () => {
    expect(getErrorCategory('E301')).toBe('agent');
    expect(getErrorCategory('E308')).toBe('agent');
  });

  it('returns "privacy" for E4xx codes', () => {
    expect(getErrorCategory('E401')).toBe('privacy');
    expect(getErrorCategory('E405')).toBe('privacy');
  });

  it('returns "cache" for E5xx codes', () => {
    expect(getErrorCategory('E501')).toBe('cache');
  });

  it('returns "intent" for E6xx codes', () => {
    expect(getErrorCategory('E601')).toBe('intent');
  });

  it('returns "cognitive" for E7xx codes', () => {
    expect(getErrorCategory('E701')).toBe('cognitive');
  });

  it('returns "learning" for E8xx codes', () => {
    expect(getErrorCategory('E801')).toBe('learning');
  });

  it('returns "swarm" for E9xx codes', () => {
    expect(getErrorCategory('E901')).toBe('swarm');
  });

  it('returns "unknown" for invalid codes', () => {
    expect(getErrorCategory('X101')).toBe('unknown');
    expect(getErrorCategory('')).toBe('unknown');
    expect(getErrorCategory(null)).toBe('unknown');
    expect(getErrorCategory('E0')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// getErrorsByCategory()
// ---------------------------------------------------------------------------
describe('getErrorsByCategory()', () => {
  it('returns config errors', () => {
    const errors = getErrorsByCategory('config');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code.startsWith('E1'))).toBe(true);
  });

  it('returns hook errors', () => {
    const errors = getErrorsByCategory('hook');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code.startsWith('E2'))).toBe(true);
  });

  it('returns agent errors', () => {
    const errors = getErrorsByCategory('agent');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code.startsWith('E3'))).toBe(true);
  });

  it('returns privacy errors', () => {
    const errors = getErrorsByCategory('privacy');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.code.startsWith('E4'))).toBe(true);
  });

  it('returns cache errors', () => {
    const errors = getErrorsByCategory('cache');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('each entry has code and message', () => {
    const errors = getErrorsByCategory('config');
    for (const e of errors) {
      expect(e).toHaveProperty('code');
      expect(e).toHaveProperty('message');
      expect(typeof e.code).toBe('string');
      expect(typeof e.message).toBe('string');
    }
  });

  it('returns empty array for unknown category', () => {
    expect(getErrorsByCategory('invalid')).toEqual([]);
    expect(getErrorsByCategory('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listAllErrors()
// ---------------------------------------------------------------------------
describe('listAllErrors()', () => {
  it('returns all registered errors', () => {
    const all = listAllErrors();
    expect(all.length).toBeGreaterThan(0);
  });

  it('each entry has code, message, and category', () => {
    const all = listAllErrors();
    for (const e of all) {
      expect(e).toHaveProperty('code');
      expect(e).toHaveProperty('message');
      expect(e).toHaveProperty('category');
    }
  });

  it('is sorted by code ascending', () => {
    const all = listAllErrors();
    for (let i = 1; i < all.length; i++) {
      expect(all[i].code >= all[i - 1].code).toBe(true);
    }
  });

  it('covers all 9 categories', () => {
    const all = listAllErrors();
    const categories = new Set(all.map((e) => e.category));
    expect(categories.has('config')).toBe(true);
    expect(categories.has('hook')).toBe(true);
    expect(categories.has('agent')).toBe(true);
    expect(categories.has('privacy')).toBe(true);
    expect(categories.has('cache')).toBe(true);
    expect(categories.has('intent')).toBe(true);
    expect(categories.has('cognitive')).toBe(true);
    expect(categories.has('learning')).toBe(true);
    expect(categories.has('swarm')).toBe(true);
  });

  it('every ErrorCodes value has a corresponding message', () => {
    for (const code of Object.values(ErrorCodes)) {
      expect(isError(code)).toBe(true);
      const msg = getErrorMessage(code);
      expect(msg).not.toContain('Unknown');
    }
  });
});
