/**
 * Tests for http-notify.js — HTTP webhook notification hook.
 *
 * @module tests/hooks/http-notify
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before import
vi.mock('../../scripts/utils/index.js', () => ({
  parseJSON: vi.fn((str) => { try { return JSON.parse(str); } catch { return null; } }),
  readStdin: vi.fn(() => Promise.resolve('{}')),
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
  resolveConfigPath: vi.fn(() => '/fake/config/artibot.config.json'),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
  logHookError: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('not found'); }),
}));

import {
  buildEventData,
  buildPayload,
  detectFormat,
  loadWebhookConfig,
  resolveEventType,
  sendWebhook,
} from '../../scripts/hooks/http-notify.js';

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// detectFormat()
// ---------------------------------------------------------------------------
describe('detectFormat()', () => {
  it('detects slack format from hooks.slack.com URL', () => {
    expect(detectFormat('https://hooks.slack.com/services/T123/B456/abc'))
      .toBe('slack');
  });

  it('detects discord format from discord.com webhook URL', () => {
    expect(detectFormat('https://discord.com/api/webhooks/123/abc'))
      .toBe('discord');
  });

  it('returns generic for other URLs', () => {
    expect(detectFormat('https://example.com/webhook')).toBe('generic');
  });

  it('returns generic for empty/null URL', () => {
    expect(detectFormat('')).toBe('generic');
    expect(detectFormat(null)).toBe('generic');
    expect(detectFormat(undefined)).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// buildPayload()
// ---------------------------------------------------------------------------
describe('buildPayload()', () => {
  const eventData = { sessionId: 'test-123' };

  it('builds slack payload with text field', () => {
    const payload = buildPayload('slack', 'session-complete', eventData);
    expect(payload).toHaveProperty('text');
    expect(payload.text).toContain('session-complete');
    expect(payload.text).toContain('test-123');
  });

  it('builds discord payload with content field', () => {
    const payload = buildPayload('discord', 'session-error', eventData);
    expect(payload).toHaveProperty('content');
    expect(payload.content).toContain('session-error');
  });

  it('builds generic payload with event, timestamp, and data', () => {
    const payload = buildPayload('generic', 'task-complete', eventData);
    expect(payload.event).toBe('task-complete');
    expect(payload.timestamp).toBeDefined();
    expect(payload.data).toEqual(eventData);
  });

  it('generic payload data is a copy (not mutated)', () => {
    const data = { sessionId: 'abc' };
    const payload = buildPayload('generic', 'test', data);
    payload.data.sessionId = 'changed';
    expect(data.sessionId).toBe('abc');
  });

  it('uses "unknown" for missing sessionId', () => {
    const payload = buildPayload('slack', 'session-complete', {});
    expect(payload.text).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// resolveEventType()
// ---------------------------------------------------------------------------
describe('resolveEventType()', () => {
  it('returns session-error when errors present', () => {
    expect(resolveEventType({ errors: ['err1'] })).toBe('session-error');
  });

  it('returns team-complete when team_config present', () => {
    expect(resolveEventType({ team_config: { agents: [] } })).toBe('team-complete');
  });

  it('returns task-complete when completed_tasks present', () => {
    expect(resolveEventType({ completed_tasks: ['t1'] })).toBe('task-complete');
  });

  it('returns session-complete as default', () => {
    expect(resolveEventType({})).toBe('session-complete');
  });

  it('handles null hook data', () => {
    expect(resolveEventType(null)).toBe('session-complete');
  });

  it('prioritizes errors over other fields', () => {
    expect(resolveEventType({
      errors: ['err'],
      team_config: {},
      completed_tasks: ['t1'],
    })).toBe('session-error');
  });

  it('returns session-complete for empty errors array', () => {
    expect(resolveEventType({ errors: [] })).toBe('session-complete');
  });
});

// ---------------------------------------------------------------------------
// buildEventData()
// ---------------------------------------------------------------------------
describe('buildEventData()', () => {
  it('extracts session data from hook input', () => {
    const data = buildEventData({
      session_id: 'sess-abc',
      completed_tasks: ['a', 'b'],
      errors: ['e1'],
      team_config: { agents: [] },
    });
    expect(data.sessionId).toBe('sess-abc');
    expect(data.completedTasks).toBe(2);
    expect(data.errors).toBe(1);
    expect(data.hasTeam).toBe(true);
    expect(data.endedAt).toBeDefined();
  });

  it('provides defaults for missing fields', () => {
    const data = buildEventData({});
    expect(data.sessionId).toContain('session-');
    expect(data.completedTasks).toBe(0);
    expect(data.errors).toBe(0);
    expect(data.hasTeam).toBe(false);
  });

  it('handles null hook data', () => {
    const data = buildEventData(null);
    expect(data.sessionId).toContain('session-');
    expect(data.completedTasks).toBe(0);
    expect(data.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadWebhookConfig()
// ---------------------------------------------------------------------------
describe('loadWebhookConfig()', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns config from env var', () => {
    process.env.ARTIBOT_WEBHOOK_URL = 'https://hooks.slack.com/test';
    delete process.env.ARTIBOT_WEBHOOK_FORMAT;
    const config = loadWebhookConfig();
    expect(config).not.toBeNull();
    expect(config.url).toBe('https://hooks.slack.com/test');
    expect(config.format).toBe('slack');
    expect(config.timeoutMs).toBe(5000);
  });

  it('uses explicit format from env', () => {
    process.env.ARTIBOT_WEBHOOK_URL = 'https://example.com/hook';
    process.env.ARTIBOT_WEBHOOK_FORMAT = 'discord';
    const config = loadWebhookConfig();
    expect(config.format).toBe('discord');
  });

  it('returns null when no env var and no config file', () => {
    delete process.env.ARTIBOT_WEBHOOK_URL;
    delete process.env.ARTIBOT_WEBHOOK_FORMAT;
    const config = loadWebhookConfig();
    expect(config).toBeNull();
  });

  it('falls back to config file when env var not set', () => {
    delete process.env.ARTIBOT_WEBHOOK_URL;
    delete process.env.ARTIBOT_WEBHOOK_FORMAT;
    readFileSync.mockReturnValueOnce(JSON.stringify({
      hooks: {
        webhook: {
          url: 'https://example.com/config-hook',
          format: 'generic',
          timeoutMs: 3000,
        },
      },
    }));
    const config = loadWebhookConfig();
    expect(config).not.toBeNull();
    expect(config.url).toBe('https://example.com/config-hook');
    expect(config.timeoutMs).toBe(3000);
  });

  it('returns null for config file without webhook section', () => {
    delete process.env.ARTIBOT_WEBHOOK_URL;
    readFileSync.mockReturnValueOnce(JSON.stringify({ hooks: {} }));
    const config = loadWebhookConfig();
    expect(config).toBeNull();
  });

  it('preserves timeoutMs: 0 from config (nullish coalescing)', () => {
    delete process.env.ARTIBOT_WEBHOOK_URL;
    delete process.env.ARTIBOT_WEBHOOK_FORMAT;
    readFileSync.mockReturnValueOnce(JSON.stringify({
      hooks: {
        webhook: {
          url: 'https://example.com/hook',
          timeoutMs: 0,
        },
      },
    }));
    const config = loadWebhookConfig();
    expect(config).not.toBeNull();
    expect(config.timeoutMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sendWebhook()
// ---------------------------------------------------------------------------
describe('sendWebhook()', () => {
  let stderrSpy;
  const originalAllowEgress = process.env.ARTIBOT_ALLOW_EGRESS;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // The DATA POLICY egress guard requires the destination host to be
    // allowlisted. Tests opt in explicitly via env var so the fetch path runs.
    process.env.ARTIBOT_ALLOW_EGRESS = 'example.com';
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (originalAllowEgress === undefined) {
      delete process.env.ARTIBOT_ALLOW_EGRESS;
    } else {
      process.env.ARTIBOT_ALLOW_EGRESS = originalAllowEgress;
    }
    vi.restoreAllMocks();
  });

  it('returns true on successful fetch', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await sendWebhook(
      { url: 'https://example.com/hook', timeoutMs: 5000 },
      { event: 'test' },
    );
    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('returns false on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await sendWebhook(
      { url: 'https://example.com/hook', timeoutMs: 5000 },
      { event: 'test' },
    );
    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('returns false on network error', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('network failure'));
    const result = await sendWebhook(
      { url: 'https://example.com/hook', timeoutMs: 5000 },
      { event: 'test' },
    );
    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('returns false on abort (timeout)', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    global.fetch = vi.fn().mockRejectedValueOnce(abortError);
    const result = await sendWebhook(
      { url: 'https://example.com/hook', timeoutMs: 100 },
      { event: 'test' },
    );
    expect(result).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('timeout'),
    );
  });

  it('uses default timeoutMs when not specified', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });
    await sendWebhook({ url: 'https://example.com' }, { event: 'test' });
    expect(global.fetch).toHaveBeenCalled();
  });

  it('refuses (returns false) when DATA POLICY blocks the URL', async () => {
    // Override allowlist so example.com is NOT permitted
    delete process.env.ARTIBOT_ALLOW_EGRESS;
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });
    const result = await sendWebhook(
      { url: 'https://unallowed.example.com/hook', timeoutMs: 5000 },
      { event: 'test' },
    );
    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('blocked by DATA POLICY'),
    );
  });
});
