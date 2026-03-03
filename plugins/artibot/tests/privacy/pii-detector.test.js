/**
 * Tests for pii-detector.js — PII detection patterns and hint-matching logic.
 *
 * @module tests/privacy/pii-detector
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PATTERNS,
  TOKENS,
  VALIDATION_CHECKS,
  hintMatches,
} from '../../lib/privacy/pii-detector.js';

// ---------------------------------------------------------------------------
// TOKENS
// ---------------------------------------------------------------------------
describe('TOKENS', () => {
  it('contains all expected replacement tokens', () => {
    const expected = [
      'USER_HOME', 'PROJECT', 'REDACTED_KEY', 'REDACTED_SECRET',
      'REDACTED_TOKEN', 'IP', 'HOST', 'PARAMS', 'EMAIL', 'PHONE',
      'ENV_VAR', 'STRING', 'PATH', 'UUID', 'CREDIT_CARD', 'SSN',
      'MAC_ADDR', 'PRIVATE_KEY', 'CONNECTION_STRING', 'HASH',
    ];
    for (const key of expected) {
      expect(TOKENS).toHaveProperty(key);
    }
  });

  it('each token value is a non-empty string', () => {
    for (const [key, value] of Object.entries(TOKENS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('token values use bracket notation', () => {
    for (const value of Object.values(TOKENS)) {
      expect(value).toMatch(/^\[.+\]$|^\{.+\}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// BUILTIN_PATTERNS
// ---------------------------------------------------------------------------
describe('BUILTIN_PATTERNS', () => {
  it('is a non-empty array of pattern objects', () => {
    expect(Array.isArray(BUILTIN_PATTERNS)).toBe(true);
    expect(BUILTIN_PATTERNS.length).toBeGreaterThan(30);
  });

  it('every pattern has required fields', () => {
    for (const pattern of BUILTIN_PATTERNS) {
      expect(pattern).toHaveProperty('name');
      expect(pattern).toHaveProperty('category');
      expect(pattern).toHaveProperty('regex');
      expect(pattern).toHaveProperty('replacement');
      expect(pattern).toHaveProperty('priority');
      expect(typeof pattern.name).toBe('string');
      expect(typeof pattern.category).toBe('string');
      expect(pattern.regex).toBeInstanceOf(RegExp);
      expect(typeof pattern.replacement).toBe('string');
      expect(typeof pattern.priority).toBe('number');
    }
  });

  it('patterns have unique names', () => {
    const names = BUILTIN_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('patterns are sorted by ascending priority', () => {
    for (let i = 1; i < BUILTIN_PATTERNS.length; i++) {
      expect(BUILTIN_PATTERNS[i].priority).toBeGreaterThanOrEqual(
        BUILTIN_PATTERNS[i - 1].priority,
      );
    }
  });

  it('hint field is null, string, or array of strings', () => {
    for (const pattern of BUILTIN_PATTERNS) {
      const { hint } = pattern;
      if (hint === null || hint === undefined) continue;
      if (typeof hint === 'string') continue;
      expect(Array.isArray(hint)).toBe(true);
      for (const h of hint) {
        expect(typeof h).toBe('string');
      }
    }
  });

  it('contains credential category patterns', () => {
    const creds = BUILTIN_PATTERNS.filter((p) => p.category === 'credentials');
    expect(creds.length).toBeGreaterThanOrEqual(2);
  });

  it('contains auth category patterns for API keys', () => {
    const auth = BUILTIN_PATTERNS.filter((p) => p.category === 'auth');
    expect(auth.length).toBeGreaterThan(5);
  });

  it('contains personal information patterns', () => {
    const personal = BUILTIN_PATTERNS.filter((p) => p.category === 'personal');
    expect(personal.length).toBeGreaterThan(0);
    const names = personal.map((p) => p.name);
    expect(names).toContain('email_address');
  });

  it('contains network category patterns', () => {
    const network = BUILTIN_PATTERNS.filter((p) => p.category === 'network');
    expect(network.length).toBeGreaterThan(3);
  });

  it('PEM private key regex matches various key types', () => {
    const pemPattern = BUILTIN_PATTERNS.find((p) => p.name === 'pem_private_key');
    expect(pemPattern).toBeDefined();
    const rsaKey = '-----BEGIN RSA PRIVATE KEY-----\ndata\n-----END RSA PRIVATE KEY-----';
    const ecKey = '-----BEGIN EC PRIVATE KEY-----\ndata\n-----END EC PRIVATE KEY-----';
    expect(rsaKey).toMatch(pemPattern.regex);
    pemPattern.regex.lastIndex = 0;
    expect(ecKey).toMatch(pemPattern.regex);
  });

  it('openai_key regex matches sk- prefixed keys', () => {
    const pattern = BUILTIN_PATTERNS.find((p) => p.name === 'openai_key');
    const key = 'sk-abcdefghijklmnopqrstuvwxyz1234';
    pattern.regex.lastIndex = 0;
    expect(key).toMatch(pattern.regex);
  });

  it('email_address regex matches valid emails', () => {
    const pattern = BUILTIN_PATTERNS.find((p) => p.name === 'email_address');
    pattern.regex.lastIndex = 0;
    expect('user@example.com').toMatch(pattern.regex);
  });

  it('uuid_v4 regex matches valid v4 UUIDs', () => {
    const pattern = BUILTIN_PATTERNS.find((p) => p.name === 'uuid_v4');
    pattern.regex.lastIndex = 0;
    expect('550e8400-e29b-41d4-a716-446655440000').toMatch(pattern.regex);
  });

  it('jwt_token regex matches JWT format', () => {
    const pattern = BUILTIN_PATTERNS.find((p) => p.name === 'jwt_token');
    pattern.regex.lastIndex = 0;
    const jwt = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q';
    expect(jwt).toMatch(pattern.regex);
  });
});

// ---------------------------------------------------------------------------
// VALIDATION_CHECKS
// ---------------------------------------------------------------------------
describe('VALIDATION_CHECKS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(VALIDATION_CHECKS)).toBe(true);
    expect(VALIDATION_CHECKS.length).toBeGreaterThan(5);
  });

  it('each check has name and regex fields', () => {
    for (const check of VALIDATION_CHECKS) {
      expect(typeof check.name).toBe('string');
      expect(check.regex).toBeInstanceOf(RegExp);
    }
  });

  it('api_key_pattern check matches sk- keys', () => {
    const check = VALIDATION_CHECKS.find((c) => c.name === 'api_key_pattern');
    check.regex.lastIndex = 0;
    expect('sk-abcdefghijklmnopqrstuv1234567890').toMatch(check.regex);
  });

  it('email check matches email addresses', () => {
    const check = VALIDATION_CHECKS.find((c) => c.name === 'email');
    check.regex.lastIndex = 0;
    expect('test@example.com').toMatch(check.regex);
  });

  it('pem_key check matches private key headers', () => {
    const check = VALIDATION_CHECKS.find((c) => c.name === 'pem_key');
    check.regex.lastIndex = 0;
    expect('-----BEGIN RSA PRIVATE KEY-----').toMatch(check.regex);
  });
});

// ---------------------------------------------------------------------------
// hintMatches()
// ---------------------------------------------------------------------------
describe('hintMatches()', () => {
  it('returns true when hint is null', () => {
    expect(hintMatches(null, 'any text', 'any text', false)).toBe(true);
  });

  it('returns true when hint is undefined', () => {
    expect(hintMatches(undefined, 'any text', 'any text', false)).toBe(true);
  });

  it('returns true when string hint is found in text (case-sensitive)', () => {
    expect(hintMatches('sk-', 'key=sk-abc', 'key=sk-abc', false)).toBe(true);
  });

  it('returns false when string hint is not found (case-sensitive)', () => {
    expect(hintMatches('SK-', 'key=sk-abc', 'key=sk-abc', false)).toBe(false);
  });

  it('uses lowercase haystack for case-insensitive search', () => {
    expect(hintMatches('secret', 'SECRET=val', 'secret=val', true)).toBe(true);
  });

  it('returns false when case-insensitive hint not found in lower text', () => {
    expect(hintMatches('missing', 'TEXT', 'text', true)).toBe(false);
  });

  it('returns true when any hint in array matches', () => {
    const hints = ['_test_', '_live_'];
    expect(hintMatches(hints, 'sk_test_abc', 'sk_test_abc', false)).toBe(true);
  });

  it('returns true when second hint in array matches', () => {
    const hints = ['_test_', '_live_'];
    expect(hintMatches(hints, 'sk_live_abc', 'sk_live_abc', false)).toBe(true);
  });

  it('returns false when no hints in array match', () => {
    const hints = ['_test_', '_live_'];
    expect(hintMatches(hints, 'sk_dev_abc', 'sk_dev_abc', false)).toBe(false);
  });

  it('handles empty array hint gracefully', () => {
    expect(hintMatches([], 'any text', 'any text', false)).toBe(false);
  });

  it('handles empty text', () => {
    expect(hintMatches('hint', '', '', false)).toBe(false);
  });

  it('handles case-insensitive array hints', () => {
    const hints = ['.internal', '.local'];
    expect(hintMatches(hints, 'host.LOCAL', 'host.local', true)).toBe(true);
  });
});
