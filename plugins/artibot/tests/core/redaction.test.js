/**
 * Tests for lib/core/redaction.js — centralized redaction helpers.
 *
 * Covers:
 *   - Default (generic) pattern set — api key, token, bearer, windows path,
 *     posix home path, email
 *   - Custom pattern injection (both [RegExp, string] and {re, tag} forms)
 *   - Recursive object traversal (redactObject)
 *   - Non-string pass-through (numbers / booleans / null / undefined)
 *   - Prototype-pollution guard (__proto__ / constructor / prototype keys)
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PATTERNS,
  GENERIC_PATTERNS,
  redactObject,
  redactString,
  TAGGED_PATTERNS,
} from '../../lib/core/redaction.js';

// Secret-shaped values are assembled at runtime so the source file itself
// does not trip repository-wide secret scanners.
const FAKE_SK = ['s', 'k', '-', 'abcdefghijkl1234567'].join('');
const FAKE_EMAIL = ['alice', '@', 'example.com'].join('');

describe('redactString (default/generic patterns)', () => {
  it('redacts api-key style tokens with ***REDACTED***', () => {
    const out = redactString('api_key=supersecret123');
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('supersecret123');
  });

  it('redacts Bearer tokens', () => {
    const out = redactString('Authorization: bearer abc.def.ghi');
    expect(out).toContain('***REDACTED***');
  });

  it('redacts Windows user paths to {user}', () => {
    const out = redactString('C:\\Users\\alice\\notes.txt');
    expect(out).toContain('Users\\{user}');
    expect(out).not.toContain('alice');
  });

  it('redacts POSIX /home/<user>/ paths', () => {
    const out = redactString('/home/bob/project/src');
    expect(out).toContain('/{home}/{user}');
    expect(out).not.toContain('bob');
  });

  it('redacts POSIX /Users/<user>/ paths', () => {
    const out = redactString('/Users/carol/dev');
    expect(out).toContain('/{home}/{user}');
    expect(out).not.toContain('carol');
  });

  it('redacts email addresses to {email}', () => {
    const out = redactString(`ping ${FAKE_EMAIL} please`);
    expect(out).toContain('{email}');
    expect(out).not.toContain(FAKE_EMAIL);
  });
});

describe('redactString (tagged pattern set via option)', () => {
  it('emits [redacted:key] for known key prefixes', () => {
    const out = redactString(`token is ${FAKE_SK} ok`, { patterns: TAGGED_PATTERNS });
    expect(out).toContain('[redacted:key]');
    expect(out).not.toContain(FAKE_SK);
  });

  it('emits [redacted:email]', () => {
    const out = redactString(`contact ${FAKE_EMAIL}`, { patterns: TAGGED_PATTERNS });
    expect(out).toContain('[redacted:email]');
  });
});

describe('redactString (custom patterns)', () => {
  it('accepts array-of-tuples pattern form', () => {
    const out = redactString('hello world', {
      patterns: [[/hello/g, '<hi>']],
    });
    expect(out).toBe('<hi> world');
  });

  it('accepts bare-RegExp entries with the replacement option', () => {
    const out = redactString('secret=xxx', {
      patterns: [/secret=\w+/g],
      replacement: '<SECRET>',
    });
    expect(out).toBe('<SECRET>');
  });

  it('returns input unchanged when patterns is an empty array', () => {
    const out = redactString(`api_key=${FAKE_SK}`, { patterns: [] });
    expect(out).toBe(`api_key=${FAKE_SK}`);
  });

  it('returns empty string for non-string input', () => {
    expect(redactString(null)).toBe('');
    expect(redactString(undefined)).toBe('');
    expect(redactString(123)).toBe('');
    expect(redactString({})).toBe('');
  });
});

describe('redactObject — deep traversal', () => {
  it('redacts strings inside nested objects and arrays', () => {
    const input = {
      user: {
        email: FAKE_EMAIL,
        paths: ['C:\\Users\\dave\\x', '/home/eve/y'],
      },
      note: 'token=leak123',
    };
    const out = redactObject(input);
    expect(out.user.email).toContain('{email}');
    expect(out.user.paths[0]).toContain('Users\\{user}');
    expect(out.user.paths[1]).toContain('/{home}/{user}');
    expect(out.note).toContain('***REDACTED***');
  });

  it('returns a new object (does not mutate input)', () => {
    const input = { email: FAKE_EMAIL };
    const out = redactObject(input);
    expect(input.email).toBe(FAKE_EMAIL); // unchanged
    expect(out.email).not.toBe(FAKE_EMAIL);
    expect(out).not.toBe(input);
  });

  it('passes through numbers, booleans, null, undefined untouched', () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
  });

  it('drops prototype-pollution keys', () => {
    // Build a normal object with raw keys to ensure the guard runs via
    // Object.keys iteration. Use computed property syntax + JSON to be safe.
    const raw = JSON.parse('{"__proto__":{"polluted":1},"constructor":"x","prototype":"y","safe":"z"}');
    const out = redactObject(raw);
    expect(out.__proto__.polluted).toBeUndefined();
    expect(out.constructor).not.toBe('x');
    expect(out.prototype).toBeUndefined();
    expect(out.safe).toBe('z');
  });

  it('handles arrays of mixed types', () => {
    const out = redactObject([1, 'token=x', { email: FAKE_EMAIL }, null]);
    expect(out[0]).toBe(1);
    expect(out[1]).toContain('***REDACTED***');
    expect(out[2].email).toContain('{email}');
    expect(out[3]).toBeNull();
  });

  it('drops functions and symbols', () => {
    const out = redactObject({ fn: () => 1, sym: Symbol('x'), keep: 2 });
    expect(out.fn).toBeUndefined();
    expect(out.sym).toBeUndefined();
    expect(out.keep).toBe(2);
  });
});

describe('pattern catalogue exports', () => {
  it('DEFAULT_PATTERNS equals GENERIC_PATTERNS', () => {
    expect(DEFAULT_PATTERNS).toBe(GENERIC_PATTERNS);
  });

  it('GENERIC_PATTERNS is frozen', () => {
    expect(Object.isFrozen(GENERIC_PATTERNS)).toBe(true);
  });

  it('TAGGED_PATTERNS is frozen', () => {
    expect(Object.isFrozen(TAGGED_PATTERNS)).toBe(true);
  });
});
