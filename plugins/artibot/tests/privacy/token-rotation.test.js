import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateToken,
  rotateToken,
  isTokenValid,
  revokeToken,
  getTokenInfo,
  listTokens,
  cleanup,
  getTokenStats,
  configure,
  restoreFromPersistence,
  resetTokenStore,
  DEFAULT_ROTATION_MS,
  MIN_ROTATION_MS,
  MAX_TOKENS,
  TOKEN_PREFIX,
} from '../../lib/privacy/token-rotation.js';

beforeEach(() => {
  resetTokenStore();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe('constants', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_ROTATION_MS).toBe(24 * 60 * 60 * 1000);
    expect(MIN_ROTATION_MS).toBe(60 * 1000);
    expect(MAX_TOKENS).toBe(10_000);
    expect(TOKEN_PREFIX).toBe('abt_');
  });
});

// ---------------------------------------------------------------------------
// generateToken()
// ---------------------------------------------------------------------------
describe('generateToken()', () => {
  it('generates a token with required fields', () => {
    const result = generateToken('api-access');

    expect(result.id).toBeDefined();
    expect(result.token).toBeDefined();
    expect(result.purpose).toBe('api-access');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('generates tokens with the abt_ prefix', () => {
    const result = generateToken('session');
    expect(result.id.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(result.token.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  it('generates unique tokens', () => {
    const t1 = generateToken('test');
    const t2 = generateToken('test');

    expect(t1.id).not.toBe(t2.id);
    expect(t1.token).not.toBe(t2.token);
  });

  it('throws on empty purpose', () => {
    expect(() => generateToken('')).toThrow();
    expect(() => generateToken(null)).toThrow();
    expect(() => generateToken(undefined)).toThrow();
  });

  it('respects custom expiration', () => {
    const before = Date.now();
    const result = generateToken('short-lived', { expiresInMs: 5000 });

    // Should expire within ~5 seconds
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 5000);
    expect(result.expiresAt).toBeLessThanOrEqual(before + 6000);
  });

  it('defaults expiration to rotation period', () => {
    const before = Date.now();
    const result = generateToken('default-exp');

    expect(result.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_ROTATION_MS - 100);
    expect(result.expiresAt).toBeLessThanOrEqual(before + DEFAULT_ROTATION_MS + 100);
  });

  it('token values are sufficiently random (64 hex chars + prefix)', () => {
    const result = generateToken('random-test');
    const tokenBody = result.token.slice(TOKEN_PREFIX.length);
    // 32 bytes = 64 hex chars
    expect(tokenBody).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// isTokenValid()
// ---------------------------------------------------------------------------
describe('isTokenValid()', () => {
  it('validates a freshly generated token', () => {
    const { token } = generateToken('test');
    const result = isTokenValid(token);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects unknown token', () => {
    const result = isTokenValid('abt_nonexistent');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('rejects empty/null input', () => {
    expect(isTokenValid('').valid).toBe(false);
    expect(isTokenValid('').reason).toBe('invalid_input');

    expect(isTokenValid(null).valid).toBe(false);
    expect(isTokenValid(undefined).valid).toBe(false);
  });

  it('rejects revoked token', () => {
    const { id, token } = generateToken('test');
    revokeToken(id);

    const result = isTokenValid(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('revoked');
  });

  it('rejects expired token', () => {
    // Generate token that expires immediately
    const { token } = generateToken('test', { expiresInMs: -1 });

    const result = isTokenValid(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// rotateToken()
// ---------------------------------------------------------------------------
describe('rotateToken()', () => {
  it('rotates a token successfully', () => {
    const original = generateToken('api-key');
    const result = rotateToken(original.id);

    expect(result).not.toBeNull();
    expect(result.oldId).toBe(original.id);
    expect(result.newId).not.toBe(original.id);
    expect(result.newToken).not.toBe(original.token);
    expect(result.purpose).toBe('api-key');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('invalidates the old token after rotation', () => {
    const original = generateToken('rotate-test');
    rotateToken(original.id);

    const oldValid = isTokenValid(original.token);
    expect(oldValid.valid).toBe(false);
    expect(oldValid.reason).toBe('revoked');
  });

  it('new token is valid after rotation', () => {
    const original = generateToken('rotate-test');
    const result = rotateToken(original.id);

    const newValid = isTokenValid(result.newToken);
    expect(newValid.valid).toBe(true);
  });

  it('returns null for unknown token ID', () => {
    const result = rotateToken('abt_nonexistent');
    expect(result).toBeNull();
  });

  it('preserves the purpose across rotation', () => {
    const original = generateToken('webhook-auth');
    const result = rotateToken(original.id);
    expect(result.purpose).toBe('webhook-auth');
  });
});

// ---------------------------------------------------------------------------
// revokeToken()
// ---------------------------------------------------------------------------
describe('revokeToken()', () => {
  it('revokes a valid token', () => {
    const { id } = generateToken('test');
    const result = revokeToken(id);

    expect(result.revoked).toBe(true);
    expect(result.id).toBe(id);
  });

  it('returns false for unknown token', () => {
    const result = revokeToken('abt_ghost');
    expect(result.revoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTokenInfo()
// ---------------------------------------------------------------------------
describe('getTokenInfo()', () => {
  it('returns token metadata', () => {
    const { id } = generateToken('info-test');
    const info = getTokenInfo(id);

    expect(info).not.toBeNull();
    expect(info.id).toBe(id);
    expect(info.purpose).toBe('info-test');
    expect(info.createdAt).toBeGreaterThan(0);
    expect(info.expiresAt).toBeGreaterThan(info.createdAt);
    expect(info.revoked).toBe(false);
    expect(info.expired).toBe(false);
  });

  it('does NOT expose the token value', () => {
    const { id } = generateToken('secret');
    const info = getTokenInfo(id);
    expect(info).not.toHaveProperty('token');
  });

  it('returns null for unknown ID', () => {
    expect(getTokenInfo('abt_missing')).toBeNull();
  });

  it('reflects expired state', () => {
    const { id } = generateToken('expires-now', { expiresInMs: -1 });
    const info = getTokenInfo(id);
    expect(info.expired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listTokens()
// ---------------------------------------------------------------------------
describe('listTokens()', () => {
  it('lists all tokens', () => {
    generateToken('a');
    generateToken('b');
    generateToken('a');

    const all = listTokens();
    expect(all).toHaveLength(3);
  });

  it('filters by purpose', () => {
    generateToken('api');
    generateToken('session');
    generateToken('api');

    const apiTokens = listTokens('api');
    expect(apiTokens).toHaveLength(2);
    expect(apiTokens.every((t) => t.purpose === 'api')).toBe(true);
  });

  it('returns empty array when no tokens', () => {
    expect(listTokens()).toEqual([]);
  });

  it('does not expose token values', () => {
    generateToken('list-test');
    const tokens = listTokens();
    expect(tokens[0]).not.toHaveProperty('token');
  });
});

// ---------------------------------------------------------------------------
// cleanup()
// ---------------------------------------------------------------------------
describe('cleanup()', () => {
  it('removes expired tokens', () => {
    generateToken('live');
    generateToken('dead', { expiresInMs: -1 });

    const result = cleanup();
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it('removes revoked tokens', () => {
    const { id } = generateToken('to-revoke');
    generateToken('keep');
    revokeToken(id);

    const result = cleanup();
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it('returns zero when nothing to clean', () => {
    generateToken('fresh');
    const result = cleanup();
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it('handles empty store', () => {
    const result = cleanup();
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getTokenStats()
// ---------------------------------------------------------------------------
describe('getTokenStats()', () => {
  it('returns accurate statistics', () => {
    generateToken('api');
    generateToken('api');
    generateToken('session');

    const stats = getTokenStats();
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(3);
    expect(stats.expired).toBe(0);
    expect(stats.revoked).toBe(0);
    expect(stats.byPurpose).toEqual({ api: 2, session: 1 });
  });

  it('counts revoked tokens', () => {
    const { id } = generateToken('test');
    revokeToken(id);

    const stats = getTokenStats();
    expect(stats.revoked).toBe(1);
    expect(stats.active).toBe(0);
  });

  it('counts expired tokens', () => {
    generateToken('expired', { expiresInMs: -1 });
    generateToken('active');

    const stats = getTokenStats();
    expect(stats.expired).toBe(1);
    expect(stats.active).toBe(1);
  });

  it('returns empty stats when store is empty', () => {
    const stats = getTokenStats();
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.byPurpose).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// configure()
// ---------------------------------------------------------------------------
describe('configure()', () => {
  it('configures custom rotation period', () => {
    configure({ rotationPeriodMs: 2 * 60 * 60 * 1000 }); // 2 hours

    const before = Date.now();
    const result = generateToken('configured');
    const twoHours = 2 * 60 * 60 * 1000;

    expect(result.expiresAt).toBeGreaterThanOrEqual(before + twoHours - 100);
    expect(result.expiresAt).toBeLessThanOrEqual(before + twoHours + 100);
  });

  it('enforces minimum rotation period', () => {
    configure({ rotationPeriodMs: 1000 }); // 1 second (below minimum)

    const before = Date.now();
    const result = generateToken('min-period');

    // Should use MIN_ROTATION_MS (60 seconds) instead of 1 second
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + MIN_ROTATION_MS - 100);
  });

  it('configures max tokens', () => {
    configure({ maxTokens: 3 });

    generateToken('a');
    generateToken('b');
    generateToken('c');
    generateToken('d'); // should evict oldest

    const all = listTokens();
    expect(all.length).toBeLessThanOrEqual(3);
  });

  it('configures persistence callback', () => {
    const persisted = [];
    configure({
      onPersist: (data) => persisted.push(data),
    });

    generateToken('persist-test');
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted[0].tokens).toBeDefined();
    expect(persisted[0].savedAt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// restoreFromPersistence()
// ---------------------------------------------------------------------------
describe('restoreFromPersistence()', () => {
  it('restores tokens from callback', () => {
    const savedData = {
      tokens: [
        {
          id: 'abt_restored-1',
          token: 'abt_abc123',
          purpose: 'restored',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000,
          revoked: false,
        },
        {
          id: 'abt_restored-2',
          token: 'abt_def456',
          purpose: 'restored',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000,
          revoked: false,
        },
      ],
    };

    configure({ onRestore: () => savedData });
    const result = restoreFromPersistence();

    expect(result.restored).toBe(2);
    expect(getTokenInfo('abt_restored-1')).not.toBeNull();
    expect(getTokenInfo('abt_restored-2')).not.toBeNull();
  });

  it('returns 0 when no restore callback', () => {
    const result = restoreFromPersistence();
    expect(result.restored).toBe(0);
  });

  it('handles null return from callback', () => {
    configure({ onRestore: () => null });
    const result = restoreFromPersistence();
    expect(result.restored).toBe(0);
  });

  it('handles invalid data from callback', () => {
    configure({ onRestore: () => ({ tokens: 'not an array' }) });
    const result = restoreFromPersistence();
    expect(result.restored).toBe(0);
  });

  it('skips entries missing required fields', () => {
    configure({
      onRestore: () => ({
        tokens: [
          { id: 'abt_1', token: 'abt_t1', purpose: 'valid' },
          { id: 'abt_2' }, // missing token and purpose
          { token: 'abt_t3', purpose: 'no-id' }, // missing id
        ],
      }),
    });

    const result = restoreFromPersistence();
    expect(result.restored).toBe(1);
  });

  it('restored tokens are validatable', () => {
    const tokenValue = 'abt_' + 'a'.repeat(64);
    configure({
      onRestore: () => ({
        tokens: [
          {
            id: 'abt_valid',
            token: tokenValue,
            purpose: 'validate-test',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60000,
            revoked: false,
          },
        ],
      }),
    });

    restoreFromPersistence();
    const result = isTokenValid(tokenValue);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resetTokenStore()
// ---------------------------------------------------------------------------
describe('resetTokenStore()', () => {
  it('clears all tokens', () => {
    generateToken('a');
    generateToken('b');
    resetTokenStore();

    expect(listTokens()).toEqual([]);
  });

  it('resets configuration to defaults', () => {
    configure({ rotationPeriodMs: 1000 });
    resetTokenStore();

    const before = Date.now();
    const result = generateToken('after-reset');

    // Should use DEFAULT_ROTATION_MS again
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_ROTATION_MS - 100);
  });
});

// ---------------------------------------------------------------------------
// Max tokens enforcement
// ---------------------------------------------------------------------------
describe('max tokens enforcement', () => {
  it('evicts oldest tokens when at capacity', () => {
    configure({ maxTokens: 5 });

    const tokens = [];
    for (let i = 0; i < 7; i++) {
      tokens.push(generateToken(`token-${i}`));
    }

    const all = listTokens();
    expect(all.length).toBeLessThanOrEqual(5);
  });

  it('prefers evicting expired tokens first', () => {
    configure({ maxTokens: 3 });

    generateToken('active-1');
    generateToken('expired', { expiresInMs: -1 });
    generateToken('active-2');
    generateToken('active-3'); // triggers eviction

    const all = listTokens();
    const purposes = all.map((t) => t.purpose);
    expect(purposes).not.toContain('expired');
  });
});

// ---------------------------------------------------------------------------
// Persistence integration
// ---------------------------------------------------------------------------
describe('persistence integration', () => {
  it('persist callback fires on generate, rotate, revoke, cleanup', () => {
    const calls = [];
    configure({ onPersist: (data) => calls.push(data) });

    generateToken('persist-1');
    expect(calls.length).toBe(1);

    const { id } = generateToken('persist-2');
    expect(calls.length).toBe(2);

    rotateToken(id);
    expect(calls.length).toBe(4); // revoke old + generate new

    const revokeId = generateToken('persist-3').id;
    revokeToken(revokeId);
    expect(calls.length).toBe(6); // generate + revoke

    generateToken('expired', { expiresInMs: -1 });
    cleanup();
    // cleanup fires persist when it removes items
    expect(calls.length).toBeGreaterThanOrEqual(7);
  });
});
