import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  uploadWeights,
  downloadLatestWeights,
  reportTelemetry,
  checkHealth,
  getContributionStats,
  flushOfflineQueue,
  computeChecksum,
  verifyChecksum,
  validateUrl,
  ALLOWED_HOSTS,
} from '../../lib/swarm/swarm-client.js';

// Mock file module
vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const { readJsonFile, writeJsonFile, ensureDir } = await import('../../lib/core/file.js');

function makeOkResponse(data) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

function makeErrorResponse(status, body = '') {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(body),
  };
}

describe('computeChecksum', () => {
  it('returns a hex string for object input', () => {
    const result = computeChecksum({ a: 1 });
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns a hex string for string input', () => {
    const result = computeChecksum('hello');
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for same input', () => {
    const a = computeChecksum({ key: 'val' });
    const b = computeChecksum({ key: 'val' });
    expect(a).toBe(b);
  });

  it('returns different values for different inputs', () => {
    const a = computeChecksum({ key: 'val1' });
    const b = computeChecksum({ key: 'val2' });
    expect(a).not.toBe(b);
  });
});

describe('verifyChecksum', () => {
  it('returns true for matching checksum', () => {
    const data = { key: 'value' };
    const checksum = computeChecksum(data);
    expect(verifyChecksum(data, checksum)).toBe(true);
  });

  it('returns false for mismatched checksum', () => {
    const data = { key: 'value' };
    expect(verifyChecksum(data, 'wrong-checksum')).toBe(false);
  });
});

describe('uploadWeights()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(makeOkResponse({ version: 'v2', timestamp: '2024-01-01T00:00:00Z' }));
  });

  it('returns error for invalid (null) weights', async () => {
    const result = await uploadWeights(null);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid/);
  });

  it('returns error for non-object weights', async () => {
    const result = await uploadWeights('string');
    expect(result.success).toBe(false);
  });

  it('returns success with version on 200 response', async () => {
    const result = await uploadWeights({ tools: {} }, {});
    expect(result.success).toBe(true);
    expect(result.version).toBe('v2');
  });

  it('calls scrubPii if provided', async () => {
    const scrubPii = vi.fn((w) => ({ ...w, scrubbed: true }));
    await uploadWeights({ tools: {} }, {}, { scrubPii });
    expect(scrubPii).toHaveBeenCalledTimes(1);
  });

  it('calls addNoise if provided', async () => {
    const addNoise = vi.fn((w) => w);
    await uploadWeights({ tools: {} }, {}, { addNoise });
    expect(addNoise).toHaveBeenCalledTimes(1);
  });

  it('returns error for payload exceeding size limit', async () => {
    const largeData = { big: 'x'.repeat(6 * 1024 * 1024) };
    const result = await uploadWeights(largeData);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/MB limit/);
  });

  it('queues upload on network failure (fetch failure)', async () => {
    vi.useFakeTimers();
    const fetchError = new Error('fetch failed');
    fetchError.name = 'TypeError';
    fetchError.message = 'fetch failed: network error';
    mockFetch.mockRejectedValue(fetchError);
    readJsonFile.mockResolvedValue([]);
    const promise = uploadWeights({ tools: {} }, {});
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.queued).toBe(true);
    vi.useRealTimers();
  });

  it('returns error for 4xx response without retry', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(400, 'Bad request'));
    const result = await uploadWeights({ tools: {} }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/HTTP 400/);
  });

  it('uses ARTIBOT_SWARM_SERVER env var when set', async () => {
    // Use the default allowed host to test env var override
    process.env.ARTIBOT_SWARM_SERVER = 'https://artibot-swarm-249539591811.asia-northeast3.run.app';
    await uploadWeights({ tools: {} }, {});
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('artibot-swarm-249539591811.asia-northeast3.run.app'),
      expect.anything(),
    );
    delete process.env.ARTIBOT_SWARM_SERVER;
  });

  it('uses config.serverUrl when env not set', async () => {
    delete process.env.ARTIBOT_SWARM_SERVER;
    // Use an allowed host to test config override
    await uploadWeights({ tools: {} }, {}, { config: { serverUrl: 'https://localhost:9090' } });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('localhost'),
      expect.anything(),
    );
  });

  it('rejects config.serverUrl pointing to non-allowed host', async () => {
    delete process.env.ARTIBOT_SWARM_SERVER;
    const result = await uploadWeights({ tools: {} }, {}, { config: { serverUrl: 'https://evil.example.com' } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF blocked/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('downloadLatestWeights()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success with weights on 200 response', async () => {
    const weights = { tools: { read: { successRate: 0.9 } } };
    const checksum = computeChecksum(weights);
    mockFetch.mockResolvedValue(makeOkResponse({ weights, version: 'v1', checksum }));
    const result = await downloadLatestWeights();
    expect(result.success).toBe(true);
    expect(result.weights).toEqual(weights);
    expect(result.version).toBe('v1');
  });

  it('fails checksum verification on tampered data', async () => {
    const weights = { tools: { read: { successRate: 0.9 } } };
    mockFetch.mockResolvedValue(makeOkResponse({ weights, version: 'v1', checksum: 'bad-checksum' }));
    const result = await downloadLatestWeights();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Checksum/);
  });

  it('returns diff field when server provides it', async () => {
    const weights = { tools: {} };
    const checksum = computeChecksum(weights);
    mockFetch.mockResolvedValue(makeOkResponse({ weights, version: 'v2', checksum, diff: { added: 1 } }));
    const result = await downloadLatestWeights('v1');
    expect(result.diff).toEqual({ added: 1 });
  });

  it('includes since param when currentVersion provided', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ weights: null, version: 'v1' }));
    await downloadLatestWeights('v0');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('since=v0'),
      expect.anything(),
    );
  });

  it('returns error on network failure', async () => {
    vi.useFakeTimers();
    mockFetch.mockRejectedValue(new Error('Network error'));
    const promise = downloadLatestWeights();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    vi.useRealTimers();
  });
});

describe('reportTelemetry()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(makeOkResponse({}));
  });

  it('does not throw on null stats', async () => {
    await expect(reportTelemetry(null)).resolves.toBeUndefined();
  });

  it('does not throw on non-object stats', async () => {
    await expect(reportTelemetry('string')).resolves.toBeUndefined();
  });

  it('calls fetch with telemetry endpoint', async () => {
    await reportTelemetry({ sessionsCompleted: 5 });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/telemetry'),
      expect.anything(),
    );
  });

  it('silently ignores network failures', async () => {
    vi.useFakeTimers();
    mockFetch.mockRejectedValue(new Error('Network error'));
    const promise = reportTelemetry({ sessionsCompleted: 1 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe('checkHealth()', () => {
  it('returns healthy status on 200 response', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const result = await checkHealth();
    expect(result.status).toBe('healthy');
    expect(result.latency).toBeGreaterThanOrEqual(0);
  });

  it('returns degraded status on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });
    const result = await checkHealth();
    expect(result.status).toBe('degraded');
  });

  it('returns unreachable on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    const result = await checkHealth();
    expect(result.status).toBe('unreachable');
    expect(result.latency).toBeGreaterThanOrEqual(0);
  });
});

describe('getContributionStats()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when clientId missing', async () => {
    const result = await getContributionStats();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Client ID/);
  });

  it('returns stats on success', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ uploads: 10, downloads: 5, rank: 3 }));
    const result = await getContributionStats('client-123');
    expect(result.success).toBe(true);
    expect(result.uploads).toBe(10);
    expect(result.downloads).toBe(5);
    expect(result.rank).toBe(3);
  });

  it('returns error on request failure', async () => {
    vi.useFakeTimers();
    mockFetch.mockRejectedValue(new Error('Server error'));
    const promise = getContributionStats('client-123');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    vi.useRealTimers();
  });
});

describe('flushOfflineQueue()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result for empty queue', async () => {
    readJsonFile.mockResolvedValue([]);
    const result = await flushOfflineQueue();
    expect(result.flushed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('returns empty for null queue data', async () => {
    readJsonFile.mockResolvedValue(null);
    const result = await flushOfflineQueue();
    expect(result.flushed).toBe(0);
  });

  it('counts flushed items on successful upload', async () => {
    readJsonFile.mockResolvedValue([
      { type: 'upload', weights: { tools: {} }, metadata: {} },
    ]);
    mockFetch.mockResolvedValue(makeOkResponse({ version: 'v1' }));
    const result = await flushOfflineQueue();
    expect(result.flushed).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it('keeps items in remaining when still offline', async () => {
    vi.useFakeTimers();
    readJsonFile.mockResolvedValueOnce([
      { type: 'upload', weights: { tools: {} }, metadata: {} },
    ]).mockResolvedValue([]);
    const fetchError = new Error('fetch failed: network error');
    fetchError.name = 'TypeError';
    mockFetch.mockRejectedValue(fetchError);
    const promise = flushOfflineQueue();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.flushed).toBe(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// SSRF Protection Tests
// ---------------------------------------------------------------------------

describe('SSRF Protection - validateUrl()', () => {
  it('allows localhost URLs', () => {
    const url = validateUrl('https://localhost/api/v1/health');
    expect(url.hostname).toBe('localhost');
  });

  it('allows 127.0.0.1 URLs', () => {
    const url = validateUrl('http://127.0.0.1:8080/api/v1/health');
    expect(url.hostname).toBe('127.0.0.1');
  });

  it('allows ::1 URLs', () => {
    const url = validateUrl('http://[::1]:8080/api/v1/health');
    // URL parser stores IPv6 as [::1] in hostname
    expect(url.hostname).toBe('[::1]');
  });

  it('allows the default swarm server host', () => {
    const url = validateUrl('https://artibot-swarm-249539591811.asia-northeast3.run.app/api/v1/weights');
    expect(url.hostname).toBe('artibot-swarm-249539591811.asia-northeast3.run.app');
  });

  it('blocks hosts not in the allowlist', () => {
    expect(() => validateUrl('https://evil.example.com/steal-data')).toThrow('SSRF blocked');
    expect(() => validateUrl('https://evil.example.com/steal-data')).toThrow('not in allowlist');
  });

  it('blocks file:// protocol', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow('SSRF blocked');
    expect(() => validateUrl('file:///etc/passwd')).toThrow('not allowed');
  });

  it('blocks ftp:// protocol', () => {
    expect(() => validateUrl('ftp://localhost/data')).toThrow('SSRF blocked');
  });

  it('throws on completely invalid URLs', () => {
    expect(() => validateUrl('not-a-url')).toThrow('Invalid URL');
  });

  it('throws on empty string', () => {
    expect(() => validateUrl('')).toThrow('Invalid URL');
  });

  it('ALLOWED_HOSTS contains expected entries', () => {
    expect(ALLOWED_HOSTS.has('localhost')).toBe(true);
    expect(ALLOWED_HOSTS.has('127.0.0.1')).toBe(true);
    expect(ALLOWED_HOSTS.has('::1')).toBe(true);
    expect(ALLOWED_HOSTS.has('artibot-swarm-249539591811.asia-northeast3.run.app')).toBe(true);
  });
});

describe('SSRF Protection - integration with API functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(makeOkResponse({ version: 'v1' }));
  });

  it('uploadWeights rejects SSRF attempts via config.serverUrl', async () => {
    const result = await uploadWeights(
      { tools: {} },
      {},
      { config: { serverUrl: 'https://evil.example.com' } },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF blocked/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('downloadLatestWeights rejects SSRF attempts via config.serverUrl', async () => {
    const result = await downloadLatestWeights(null, {
      config: { serverUrl: 'https://internal.corp.net' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF blocked/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('checkHealth rejects SSRF attempts via config.serverUrl', async () => {
    const result = await checkHealth({
      config: { serverUrl: 'file:///etc/passwd' },
    });
    expect(result.status).toBe('unreachable');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('getContributionStats rejects SSRF attempts via config.serverUrl', async () => {
    const result = await getContributionStats('client-1', {
      config: { serverUrl: 'https://malicious.attacker.io' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF blocked/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
