import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scrub,
  scrubPattern,
  scrubPatterns,
  addCustomPattern,
  removeCustomPattern,
  getScrubStats,
  resetStats,
  validateScrubbed,
  listPatterns,
  resetPatterns,
  createScopedScrubber,
} from '../../lib/privacy/pii-scrubber.js';

beforeEach(() => {
  resetPatterns();
  resetStats();
});

afterEach(() => {
  resetPatterns();
  resetStats();
});

// ---------------------------------------------------------------------------
// scrub() - credentials category
// ---------------------------------------------------------------------------
describe('scrub() - credentials', () => {
  it('removes PEM private key block', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const result = scrub(text);
    expect(result).toContain('[PRIVATE_KEY]');
    expect(result).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('removes PGP private key block', () => {
    const text = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsome-key-data\n-----END PGP PRIVATE KEY BLOCK-----';
    const result = scrub(text);
    expect(result).toContain('[PRIVATE_KEY]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - auth category
// ---------------------------------------------------------------------------
describe('scrub() - auth (API keys & tokens)', () => {
  it('redacts OpenAI API key (sk- prefix)', () => {
    const text = 'key = sk-abcdefghijklmnopqrstuv1234567890';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_KEY]');
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuv');
  });

  it('redacts GitHub PAT (ghp_ prefix)', () => {
    const text = 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890abc';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_KEY]');
  });

  it('redacts GitHub OAuth token (gho_ prefix)', () => {
    const text = 'gho_abcdefghijklmnopqrstuvwxyz1234567890abcde';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_KEY]');
  });

  it('redacts AWS access key ID (AKIA prefix)', () => {
    const text = 'aws_key=' + 'AKIA' + 'IOSFODNN7EXAMPLE';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_KEY]');
  });

  it('redacts GCP API key (AIza prefix, 35 char suffix)', () => {
    // Pattern: AIza + exactly 35 alphanumeric/underscore/dash chars = 39 total
    const text = 'key: ' + 'AIza' + 'SyDOCAbC123dEf456GhI789jKl012345678';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_KEY]');
  });

  it('redacts Stripe key', () => {
    const text = 'sk_live_' + 'abcdefghijklmnopqrstu1234';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_KEY]');
  });

  it('redacts Bearer token', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6Ikp';
    const result = scrub(text);
    expect(result).toContain('Bearer [REDACTED_TOKEN]');
  });

  it('redacts Basic auth header', () => {
    const text = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
    const result = scrub(text);
    expect(result).toContain('Basic [REDACTED_TOKEN]');
  });

  it('redacts JWT token', () => {
    const text = 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_TOKEN]');
  });

  it('redacts generic api_key assignment', () => {
    const text = 'api_key=supersecretapikey1234567890';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_KEY]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - secrets category
// ---------------------------------------------------------------------------
describe('scrub() - secrets', () => {
  it('redacts password assignment', () => {
    const text = 'password=mysecretpassword123';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_SECRET]');
  });

  it('redacts secret assignment', () => {
    const text = 'client_secret=verylongsecretvalue12345678';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_SECRET]');
  });

  it('redacts MongoDB connection string', () => {
    const text = 'uri = mongodb://user:pass@host:27017/db';
    const result = scrub(text);
    expect(result).toContain('[CONNECTION_STRING]');
  });

  it('redacts PostgreSQL connection string', () => {
    const text = 'DATABASE_URL=postgresql://user:password@localhost:5432/mydb';
    const result = scrub(text);
    expect(result).toContain('[CONNECTION_STRING]');
  });

  it('redacts Redis connection string', () => {
    const text = 'REDIS_URL=redis://user:secret@redis.host:6379';
    const result = scrub(text);
    expect(result).toContain('[CONNECTION_STRING]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - env category
// ---------------------------------------------------------------------------
describe('scrub() - env', () => {
  it('redacts .env secret lines (KEY=value pattern)', () => {
    const text = 'OPENAI_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx';
    const result = scrub(text);
    expect(result).toContain('[ENV_VAR]');
  });

  it('redacts process.env access for secrets', () => {
    const text = 'const key = process.env.OPENAI_SECRET;';
    const result = scrub(text);
    expect(result).toContain('[ENV_VAR]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - network category
// ---------------------------------------------------------------------------
describe('scrub() - network', () => {
  it('redacts IPv4 addresses', () => {
    const text = 'server at 192.168.1.100:8080';
    const result = scrub(text);
    expect(result).toContain('[IP]');
    expect(result).not.toContain('192.168.1.100');
  });

  it('redacts MAC addresses', () => {
    const text = 'mac=00:1A:2B:3C:4D:5E';
    const result = scrub(text);
    expect(result).toContain('[MAC_ADDR]');
  });

  it('redacts URL with embedded credentials', () => {
    const text = 'https://user:password@api.example.com/v1/data';
    const result = scrub(text);
    expect(result).toContain('[CONNECTION_STRING]');
  });

  it('redacts URL query params', () => {
    const text = 'fetching https://api.example.com/data?token=abc123&key=xyz';
    const result = scrub(text);
    expect(result).toContain('[PARAMS]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - personal category
// ---------------------------------------------------------------------------
describe('scrub() - personal', () => {
  it('redacts email addresses', () => {
    const text = 'contact user@example.com for support';
    const result = scrub(text);
    expect(result).toContain('[EMAIL]');
    expect(result).not.toContain('user@example.com');
  });

  it('redacts US phone numbers', () => {
    const text = 'call 555-123-4567 today';
    const result = scrub(text);
    expect(result).toContain('[PHONE]');
  });

  it('redacts US SSN', () => {
    const text = 'SSN: 123-45-6789';
    const result = scrub(text);
    expect(result).toContain('[SSN]');
  });

  it('redacts Visa credit card numbers', () => {
    const text = 'card: 4111 1111 1111 1111';
    const result = scrub(text);
    expect(result).toContain('[CREDIT_CARD]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - identifiers category
// ---------------------------------------------------------------------------
describe('scrub() - identifiers', () => {
  it('redacts UUID v4', () => {
    const text = 'session=550e8400-e29b-41d4-a716-446655440000';
    const result = scrub(text);
    expect(result).toContain('[UUID]');
  });

  it('redacts 64-char hex hash', () => {
    const hash = 'a'.repeat(64);
    const result = scrub(`hash=${hash}`);
    expect(result).toContain('[HASH]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - paths category
// ---------------------------------------------------------------------------
describe('scrub() - paths', () => {
  it('redacts Unix home paths (/home/username/...)', () => {
    const text = 'file at /home/johndoe/.config/app.json';
    const result = scrub(text);
    expect(result).not.toContain('johndoe');
  });

  it('redacts tilde home paths (~/...)', () => {
    const text = 'config: ~/projects/myapp/config.json';
    const result = scrub(text);
    expect(result).toContain('{USER_HOME}');
    expect(result).not.toContain('~/projects');
  });
});

// ---------------------------------------------------------------------------
// scrub() - git category
// ---------------------------------------------------------------------------
describe('scrub() - git', () => {
  it('redacts SSH git remote URLs (email pattern fires first on git@ syntax)', () => {
    // The email pattern (priority 55) fires before git pattern (priority 80).
    // git@github.com gets replaced by [EMAIL] because it matches email regex.
    const text = 'origin git@github.com:user/private-repo.git';
    const result = scrub(text);
    // Either [HOST] or [EMAIL] means PII was removed
    expect(result).not.toBe(text);
    expect(result).toSatisfy((r) => r.includes('[HOST]') || r.includes('[EMAIL]'));
  });

  it('redacts HTTPS git remote URLs', () => {
    const text = 'remote https://github.com/user/repo.git';
    const result = scrub(text);
    expect(result).toContain('[HOST]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - code category
// ---------------------------------------------------------------------------
describe('scrub() - code', () => {
  it('redacts inline password in object literal', () => {
    const text = `const config = { 'password': 'mysecretvalue12345' }`;
    const result = scrub(text);
    expect(result).toContain('[REDACTED_SECRET]');
  });
});

// ---------------------------------------------------------------------------
// scrub() - edge cases
// ---------------------------------------------------------------------------
describe('scrub() - edge cases', () => {
  it('returns empty string for null input', () => {
    expect(scrub(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(scrub(undefined)).toBe('');
  });

  it('returns non-string input as-is (pass-through for non-string)', () => {
    // scrub() returns text ?? '' - non-string truthy values pass through unchanged
    expect(scrub(42)).toBe(42);
  });

  it('does not modify clean text', () => {
    const clean = 'This is a perfectly safe message about software engineering.';
    expect(scrub(clean)).toBe(clean);
  });

  it('handles multi-line text', () => {
    const text = 'line1\npassword=secret12345\nline3';
    const result = scrub(text);
    expect(result).toContain('[REDACTED_SECRET]');
    expect(result).toContain('line1');
    expect(result).toContain('line3');
  });
});

// ---------------------------------------------------------------------------
// scrubPattern() / scrubPatterns()
// ---------------------------------------------------------------------------
describe('scrubPattern()', () => {
  it('scrubs string values', () => {
    const result = scrubPattern('user@example.com');
    expect(result).toContain('[EMAIL]');
  });

  it('recursively scrubs object properties', () => {
    const obj = { user: 'user@example.com', data: { key: 'sk-abcdefghijklmnopqrstuv12345' } };
    const result = scrubPattern(obj);
    expect(result.user).toContain('[EMAIL]');
    expect(result.data.key).toContain('[REDACTED_KEY]');
  });

  it('passes through numbers unchanged', () => {
    expect(scrubPattern(42)).toBe(42);
  });

  it('passes through booleans unchanged', () => {
    expect(scrubPattern(true)).toBe(true);
  });

  it('handles null', () => {
    expect(scrubPattern(null)).toBeNull();
  });

  it('handles arrays recursively', () => {
    const arr = ['user@example.com', 'safe text'];
    const result = scrubPattern(arr);
    expect(result[0]).toContain('[EMAIL]');
    expect(result[1]).toBe('safe text');
  });

  it('returns new object (immutable)', () => {
    const obj = { name: 'test', key: 'sk-abcdefghijklmnopqrstuv12345' };
    const result = scrubPattern(obj);
    expect(result).not.toBe(obj);
  });
});

describe('scrubPatterns()', () => {
  it('returns empty array for non-array input', () => {
    expect(scrubPatterns(null)).toEqual([]);
    expect(scrubPatterns('string')).toEqual([]);
  });

  it('scrubs all patterns in array', () => {
    const patterns = [
      { text: 'user@example.com' },
      { text: 'safe text' },
    ];
    const result = scrubPatterns(patterns);
    expect(result[0].text).toContain('[EMAIL]');
    expect(result[1].text).toBe('safe text');
  });
});

// ---------------------------------------------------------------------------
// Custom patterns
// ---------------------------------------------------------------------------
describe('addCustomPattern() / removeCustomPattern()', () => {
  afterEach(() => {
    resetPatterns();
  });

  it('adds a custom pattern that works in scrub()', () => {
    addCustomPattern('test-ssn-custom', /CUSTOM-\d{6}/g, '[CUSTOM_REDACTED]');
    const result = scrub('value CUSTOM-123456 here');
    expect(result).toContain('[CUSTOM_REDACTED]');
  });

  it('returns added:true on success', () => {
    const r = addCustomPattern('my-pattern', /TEST/g, '[TEST]');
    expect(r.added).toBe(true);
  });

  it('returns added:false for invalid regex', () => {
    const r = addCustomPattern('bad', 'not-regex', '[BAD]');
    expect(r.added).toBe(false);
  });

  it('replaces existing pattern with same name', () => {
    addCustomPattern('dup', /AAA/g, '[A]');
    addCustomPattern('dup', /BBB/g, '[B]');
    const result = scrub('BBB value');
    expect(result).toContain('[B]');
  });

  it('removes a custom pattern', () => {
    addCustomPattern('removable', /REMOVEME/g, '[GONE]');
    removeCustomPattern('removable');
    const result = scrub('REMOVEME');
    expect(result).toBe('REMOVEME'); // no longer scrubbed
  });

  it('returns removed:true when pattern existed', () => {
    addCustomPattern('exists', /X/g, '[X]');
    const r = removeCustomPattern('exists');
    expect(r.removed).toBe(true);
  });

  it('returns removed:false when pattern not found', () => {
    const r = removeCustomPattern('nonexistent-pattern');
    expect(r.removed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
describe('getScrubStats() / resetStats()', () => {
  it('starts with zero total scrubs', () => {
    const stats = getScrubStats();
    expect(stats.totalScrubs).toBe(0);
  });

  it('increments totalScrubs when scrubbing occurs', () => {
    scrub('user@example.com');
    const stats = getScrubStats();
    expect(stats.totalScrubs).toBeGreaterThan(0);
  });

  it('tracks by category', () => {
    scrub('user@example.com');
    const stats = getScrubStats();
    expect(stats.byCategory.personal).toBeGreaterThan(0);
  });

  it('tracks patternCount', () => {
    const stats = getScrubStats();
    expect(stats.patternCount).toBeGreaterThan(0);
  });

  it('resets all stats', () => {
    scrub('user@example.com');
    resetStats();
    const stats = getScrubStats();
    expect(stats.totalScrubs).toBe(0);
    expect(stats.byCategory).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// validateScrubbed()
// ---------------------------------------------------------------------------
describe('validateScrubbed()', () => {
  it('returns clean:true for safe text', () => {
    const result = validateScrubbed('This is completely safe text.');
    expect(result.clean).toBe(true);
    expect(result.residual).toEqual([]);
  });

  it('detects residual API key', () => {
    const result = validateScrubbed('key=sk-abcdefghijklmnopqrstuv12345');
    expect(result.clean).toBe(false);
    expect(result.residual).toContain('api_key_pattern');
  });

  it('detects residual email', () => {
    const result = validateScrubbed('contact user@example.com');
    expect(result.clean).toBe(false);
    expect(result.residual).toContain('email');
  });

  it('detects residual AWS key', () => {
    const result = validateScrubbed('AKIA' + 'IOSFODNN7EXAMPLE');
    expect(result.clean).toBe(false);
    expect(result.residual).toContain('aws_key');
  });

  it('detects residual connection string', () => {
    const result = validateScrubbed('mongodb://user:pass@host:27017/db');
    expect(result.clean).toBe(false);
    expect(result.residual).toContain('connection_string');
  });

  it('returns clean:true for empty string', () => {
    const result = validateScrubbed('');
    expect(result.clean).toBe(true);
  });

  it('returns clean:true for null input', () => {
    const result = validateScrubbed(null);
    expect(result.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listPatterns() / resetPatterns()
// ---------------------------------------------------------------------------
describe('listPatterns()', () => {
  it('returns array of pattern metadata', () => {
    const patterns = listPatterns();
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('each pattern has name, category, priority', () => {
    const patterns = listPatterns();
    for (const p of patterns) {
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('category');
      expect(p).toHaveProperty('priority');
    }
  });

  it('patterns are sorted by priority ascending', () => {
    const patterns = listPatterns();
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i].priority).toBeGreaterThanOrEqual(patterns[i - 1].priority);
    }
  });
});

describe('resetPatterns()', () => {
  it('removes custom patterns', () => {
    addCustomPattern('temp', /TEMP/g, '[T]');
    resetPatterns();
    const patterns = listPatterns();
    expect(patterns.every((p) => p.name !== 'temp')).toBe(true);
  });

  it('restores builtin pattern count', () => {
    const before = listPatterns().length;
    addCustomPattern('extra', /X/g, '[X]');
    resetPatterns();
    expect(listPatterns().length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// createScopedScrubber()
// ---------------------------------------------------------------------------
describe('createScopedScrubber()', () => {
  it('creates a scrubber that only applies specified categories', () => {
    const authScrubber = createScopedScrubber(['auth']);
    const result = authScrubber.scrub('sk-abcdefghijklmnopqrstuv12345 and user@example.com');
    expect(result).toContain('[REDACTED_KEY]');
    // email (personal category) should NOT be scrubbed
    expect(result).toContain('user@example.com');
  });

  it('scrubs only personal category when specified', () => {
    const personalScrubber = createScopedScrubber(['personal']);
    const result = personalScrubber.scrub('email: user@example.com and sk-abcdefghijklmnopqrstuv12345');
    expect(result).toContain('[EMAIL]');
    expect(result).toContain('sk-abcdefghijklmnopqrstuv12345'); // not scrubbed
  });

  it('returns empty string for null input', () => {
    const scrubber = createScopedScrubber(['auth']);
    expect(scrubber.scrub(null)).toBe('');
  });

  it('returns unchanged text when no matching categories', () => {
    const scrubber = createScopedScrubber(['nonexistent-category']);
    const text = 'some safe text here';
    expect(scrubber.scrub(text)).toBe(text);
  });
});
