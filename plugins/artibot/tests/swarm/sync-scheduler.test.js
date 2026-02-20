import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  scheduleSync,
  cancelSync,
  forceSync,
  onSessionStart,
  onSessionEnd,
  getSyncStatus,
} from '../../lib/swarm/sync-scheduler.js';

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/swarm/swarm-client.js', () => ({
  uploadWeights: vi.fn(() => Promise.resolve({ success: true, version: 'v2' })),
  downloadLatestWeights: vi.fn(() => Promise.resolve({ success: true, weights: { tools: {}, errors: {}, commands: {}, teams: {} }, version: 'v2' })),
  flushOfflineQueue: vi.fn(() => Promise.resolve({ flushed: 0, remaining: 0, errors: [] })),
}));

vi.mock('../../lib/swarm/pattern-packager.js', () => ({
  packagePatterns: vi.fn(() => Promise.resolve({
    weights: { tools: {}, errors: {}, commands: {}, teams: {} },
    metadata: { packagedCount: 1, patternCount: 5 },
    checksum: 'abc123',
  })),
  unpackWeights: vi.fn(() => [{ key: 'tool::Read', type: 'tool', category: 'Read' }]),
  mergeWeights: vi.fn((local, global_) => ({ ...local, ...global_ })),
}));

const { readJsonFile, writeJsonFile } = await import('../../lib/core/file.js');
const { uploadWeights, downloadLatestWeights, flushOfflineQueue } = await import('../../lib/swarm/swarm-client.js');
const { packagePatterns, unpackWeights, mergeWeights } = await import('../../lib/swarm/pattern-packager.js');

beforeEach(() => {
  vi.clearAllMocks();
  readJsonFile.mockResolvedValue(null);
  cancelSync(); // clean up any timers
});

afterEach(() => {
  cancelSync();
});

describe('getSyncStatus()', () => {
  it('returns default state when no state file exists', async () => {
    const state = await getSyncStatus();
    expect(state.lastUpload).toBeNull();
    expect(state.lastDownload).toBeNull();
    expect(state.interval).toBe('session');
    expect(state.totalUploads).toBe(0);
    expect(state.totalDownloads).toBe(0);
  });

  it('returns persisted state from disk', async () => {
    readJsonFile.mockResolvedValue({
      lastUpload: '2024-01-01T00:00:00Z',
      lastDownload: '2024-01-01T00:01:00Z',
      interval: 'daily',
      totalUploads: 5,
      totalDownloads: 3,
    });
    const state = await getSyncStatus();
    expect(state.lastUpload).toBe('2024-01-01T00:00:00Z');
    expect(state.interval).toBe('daily');
    expect(state.totalUploads).toBe(5);
  });
});

describe('scheduleSync()', () => {
  it('returns scheduled=false for session interval (no timer)', async () => {
    const result = await scheduleSync({ interval: 'session' });
    expect(result.scheduled).toBe(false);
    expect(result.interval).toBe('session');
    expect(result.nextSync).toBeNull();
  });

  it('returns scheduled=true for hourly interval', async () => {
    const result = await scheduleSync({ interval: 'hourly' });
    expect(result.scheduled).toBe(true);
    expect(result.nextSync).toBeTruthy();
    cancelSync();
  });

  it('returns scheduled=true for daily interval', async () => {
    const result = await scheduleSync({ interval: 'daily' });
    expect(result.scheduled).toBe(true);
    cancelSync();
  });

  it('saves updated state to disk', async () => {
    await scheduleSync({ interval: 'session' });
    expect(writeJsonFile).toHaveBeenCalled();
  });
});

describe('cancelSync()', () => {
  it('does not throw when no timer is running', () => {
    expect(() => cancelSync()).not.toThrow();
  });

  it('cancels an active timer', async () => {
    await scheduleSync({ interval: 'hourly' });
    expect(() => cancelSync()).not.toThrow();
  });
});

describe('forceSync() / performSync()', () => {
  it('returns success:true on successful upload and download', async () => {
    const result = await forceSync();
    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(true);
    expect(result.downloaded).toBe(true);
  });

  it('returns merged:true when global patterns available', async () => {
    const result = await forceSync();
    expect(result.merged).toBe(true);
  });

  it('calls flushOfflineQueue as first step', async () => {
    await forceSync();
    expect(flushOfflineQueue).toHaveBeenCalledTimes(1);
  });

  it('calls packagePatterns for upload', async () => {
    await forceSync();
    expect(packagePatterns).toHaveBeenCalled();
  });

  it('calls downloadLatestWeights', async () => {
    await forceSync();
    expect(downloadLatestWeights).toHaveBeenCalled();
  });

  it('updates totalUploads and totalDownloads in state', async () => {
    readJsonFile.mockResolvedValue({ totalUploads: 3, totalDownloads: 2 });
    await forceSync();
    const written = writeJsonFile.mock.calls.find(([, data]) => 'totalUploads' in data);
    expect(written).toBeDefined();
    expect(written[1].totalUploads).toBe(4);
  });

  it('returns error string on exception', async () => {
    packagePatterns.mockRejectedValueOnce(new Error('Packaging failed'));
    const result = await forceSync();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Packaging failed/);
  });

  it('prevents concurrent syncs', async () => {
    // First call starts, second call should return immediately with error
    const [first, second] = await Promise.all([forceSync(), forceSync()]);
    const concurrentError = [first, second].find((r) => !r.success && r.error?.includes('in progress'));
    expect(concurrentError).toBeDefined();
  });
});

describe('onSessionStart()', () => {
  it('returns downloaded:true when weights available', async () => {
    const result = await onSessionStart();
    expect(result.downloaded).toBe(true);
    expect(result.version).toBe('v2');
  });

  it('returns downloaded:false when no weights returned', async () => {
    downloadLatestWeights.mockResolvedValueOnce({ success: true, weights: null, version: null });
    const result = await onSessionStart();
    expect(result.downloaded).toBe(false);
  });

  it('returns downloaded:false on download failure', async () => {
    downloadLatestWeights.mockResolvedValueOnce({ success: false, error: 'Server down' });
    const result = await onSessionStart();
    expect(result.downloaded).toBe(false);
  });

  it('merges downloaded weights into local', async () => {
    await onSessionStart();
    expect(mergeWeights).toHaveBeenCalled();
  });

  it('writes merged weights file on success', async () => {
    await onSessionStart();
    expect(writeJsonFile).toHaveBeenCalled();
  });
});

describe('onSessionEnd()', () => {
  it('returns uploaded:true when patterns available and upload succeeds', async () => {
    const result = await onSessionEnd();
    expect(result.uploaded).toBe(true);
    expect(result.queued).toBe(false);
  });

  it('returns uploaded:false when no packaged patterns', async () => {
    packagePatterns.mockResolvedValueOnce({
      weights: { tools: {}, errors: {}, commands: {}, teams: {} },
      metadata: { packagedCount: 0, patternCount: 0 },
      checksum: 'empty',
    });
    const result = await onSessionEnd();
    expect(result.uploaded).toBe(false);
    expect(result.queued).toBe(false);
  });

  it('returns queued:true when upload queued', async () => {
    uploadWeights.mockResolvedValueOnce({ success: false, queued: true });
    const result = await onSessionEnd();
    expect(result.queued).toBe(true);
    expect(result.uploaded).toBe(false);
  });

  it('calls flushOfflineQueue before upload', async () => {
    await onSessionEnd();
    expect(flushOfflineQueue).toHaveBeenCalled();
  });

  it('returns uploaded:false and queued:false when upload fails without queuing', async () => {
    uploadWeights.mockResolvedValueOnce({ success: false, queued: false });
    const result = await onSessionEnd();
    expect(result.uploaded).toBe(false);
    expect(result.queued).toBe(false);
    expect(result.version).toBeDefined();
  });

  it('saves state with version when upload succeeds with version', async () => {
    uploadWeights.mockResolvedValueOnce({ success: true, version: 'v3' });
    const result = await onSessionEnd();
    expect(result.uploaded).toBe(true);
    expect(result.version).toBe('v3');
  });

  it('saves state when upload succeeds without version field', async () => {
    uploadWeights.mockResolvedValueOnce({ success: true });
    const result = await onSessionEnd();
    expect(result.uploaded).toBe(true);
    expect(result.version).toBeNull();
  });
});

describe('forceSync() upload queued branch', () => {
  it('increments pendingUploads when upload is queued (not success)', async () => {
    uploadWeights.mockResolvedValueOnce({ success: false, queued: true });
    const result = await forceSync();
    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(false);
    // State should have been saved with incremented pendingUploads
    const stateWrites = writeJsonFile.mock.calls.filter(([, data]) => 'pendingUploads' in data);
    expect(stateWrites.length).toBeGreaterThan(0);
  });

  it('handles upload success without version field', async () => {
    uploadWeights.mockResolvedValueOnce({ success: true });
    const result = await forceSync();
    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(true);
  });

  it('skips upload when packagedCount is 0', async () => {
    packagePatterns.mockResolvedValueOnce({
      weights: { tools: {}, errors: {}, commands: {}, teams: {} },
      metadata: { packagedCount: 0, patternCount: 0 },
      checksum: 'empty',
    });
    const result = await forceSync();
    expect(result.success).toBe(true);
    expect(result.uploaded).toBe(false);
    expect(uploadWeights).not.toHaveBeenCalled();
  });
});

describe('forceSync() download branches', () => {
  it('handles download failure (success:false)', async () => {
    downloadLatestWeights.mockResolvedValueOnce({ success: false, error: 'Server unreachable' });
    const result = await forceSync();
    expect(result.success).toBe(true);
    expect(result.downloaded).toBe(false);
    expect(result.merged).toBe(false);
  });

  it('handles download success with no weights (null)', async () => {
    downloadLatestWeights.mockResolvedValueOnce({ success: true, weights: null, version: 'v3' });
    const result = await forceSync();
    expect(result.success).toBe(true);
    expect(result.downloaded).toBe(false);
    expect(result.merged).toBe(false);
  });

  it('handles download success with empty unpackWeights result', async () => {
    unpackWeights.mockReturnValueOnce([]);
    const result = await forceSync();
    expect(result.success).toBe(true);
    expect(result.downloaded).toBe(true);
    // merged should be false because globalPatterns.length === 0
    expect(result.merged).toBe(false);
  });

  it('updates version from download when available', async () => {
    downloadLatestWeights.mockResolvedValueOnce({
      success: true,
      weights: { tools: {}, errors: {}, commands: {}, teams: {} },
      version: 'v5',
    });
    const result = await forceSync();
    expect(result.version).toBe('v5');
  });
});

describe('onSessionStart() additional branches', () => {
  it('preserves currentVersion when download has no version field', async () => {
    readJsonFile.mockResolvedValue({ currentVersion: 'v1-existing' });
    downloadLatestWeights.mockResolvedValueOnce({
      success: true,
      weights: { tools: {}, errors: {}, commands: {}, teams: {} },
    });
    const result = await onSessionStart();
    expect(result.downloaded).toBe(true);
    expect(result.version).toBeNull();
  });
});

describe('scheduleSync() timer re-schedule branch', () => {
  it('clears existing timer when scheduling new sync', async () => {
    await scheduleSync({ interval: 'hourly' });
    // Schedule again - should clear old timer without error
    const result = await scheduleSync({ interval: 'daily' });
    expect(result.scheduled).toBe(true);
    cancelSync();
  });

  it('uses default session interval when no options provided', async () => {
    const result = await scheduleSync();
    expect(result.scheduled).toBe(false);
    expect(result.interval).toBe('session');
  });
});
