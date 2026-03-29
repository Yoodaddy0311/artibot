import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock('node:crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}));

let FileCheckpoint;

describe('FileCheckpoint', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockImplementation(() => {});
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(unlinkSync).mockImplementation(() => {});
    vi.mocked(writeFileSync).mockImplementation(() => {});
    ({ FileCheckpoint } = await import('../../lib/core/file-checkpoint.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Constructor ─────────────────────────────────────────────────

  it('creates checkpoint directory on construction', () => {
    const _cp = new FileCheckpoint('sess-1');

    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('artibot-file-checkpoints-sess-1'),
      { recursive: true },
    );
  });

  it('auto-generates sessionId when omitted', () => {
    const cp = new FileCheckpoint();

    expect(cp.dir).toContain('artibot-file-checkpoints-test-uuid-1234');
  });

  // ─── snapshot() ──────────────────────────────────────────────────

  it('returns null when filePath is falsy', () => {
    const cp = new FileCheckpoint('s1');

    expect(cp.snapshot(null)).toBeNull();
    expect(cp.snapshot('')).toBeNull();
  });

  it('returns null when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const cp = new FileCheckpoint('s1');

    expect(cp.snapshot('/no/such/file.js')).toBeNull();
  });

  it('snapshots existing file and writes JSON to checkpoint dir', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('const x = 1;');
    vi.mocked(readdirSync).mockReturnValue([]);

    const cp = new FileCheckpoint('s1');
    const result = cp.snapshot('/app/file.js');

    expect(result).not.toBeNull();
    expect(result.filePath).toBe('/app/file.js');
    expect(result.content).toBe('const x = 1;');
    expect(result.size).toBe(Buffer.byteLength('const x = 1;', 'utf-8'));
    expect(result.timestamp).toBeGreaterThan(0);
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.json'),
      expect.stringContaining('"filePath"'),
      'utf-8',
    );
  });

  it('returns a frozen snapshot record', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('data');
    vi.mocked(readdirSync).mockReturnValue([]);

    const cp = new FileCheckpoint('s1');
    const record = cp.snapshot('/app/file.js');

    expect(Object.isFrozen(record)).toBe(true);
  });

  // ─── FIFO eviction ──────────────────────────────────────────────

  it('evicts oldest snapshot when at max capacity', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('data');
    vi.mocked(readdirSync).mockReturnValue([
      '001-a.json', '002-b.json', '003-c.json',
    ]);

    const cp = new FileCheckpoint('s1', { maxSnapshots: 3 });
    cp.snapshot('/app/new.js');

    expect(unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('001-a.json'),
    );
  });

  // ─── restore() ──────────────────────────────────────────────────

  it('returns false when no snapshots exist for file', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const cp = new FileCheckpoint('s1');

    expect(cp.restore('/app/missing.js')).toBe(false);
  });

  it('restores file from most recent snapshot', () => {
    const snap1 = JSON.stringify({ filePath: '/app/f.js', content: 'old', timestamp: 100, size: 3 });
    const snap2 = JSON.stringify({ filePath: '/app/f.js', content: 'new', timestamp: 200, size: 3 });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['100-f.json', '200-f.json']);
    vi.mocked(readFileSync)
      .mockReturnValueOnce(snap1)
      .mockReturnValueOnce(snap2);

    const cp = new FileCheckpoint('s1');
    const result = cp.restore('/app/f.js');

    expect(result).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith('/app/f.js', 'new', 'utf-8');
  });

  // ─── list() ──────────────────────────────────────────────────────

  it('returns empty array when dir does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const cp = new FileCheckpoint('s1');

    expect(cp.list()).toEqual([]);
  });

  it('returns snapshots sorted by timestamp', () => {
    const snap1 = JSON.stringify({ filePath: '/a', content: '1', timestamp: 200, size: 1 });
    const snap2 = JSON.stringify({ filePath: '/b', content: '2', timestamp: 100, size: 1 });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['200-a.json', '100-b.json']);
    vi.mocked(readFileSync)
      .mockReturnValueOnce(snap1)
      .mockReturnValueOnce(snap2);

    const cp = new FileCheckpoint('s1');
    const list = cp.list();

    expect(list).toHaveLength(2);
    expect(list[0].timestamp).toBe(100);
    expect(list[1].timestamp).toBe(200);
  });

  it('skips non-json files in listing', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['readme.txt', '100-a.json']);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ filePath: '/a', content: 'x', timestamp: 100, size: 1 }),
    );

    const cp = new FileCheckpoint('s1');
    const list = cp.list();

    expect(list).toHaveLength(1);
  });

  it('skips corrupt JSON files gracefully', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['100-a.json']);
    vi.mocked(readFileSync).mockReturnValue('not-json');

    const cp = new FileCheckpoint('s1');
    const list = cp.list();

    expect(list).toHaveLength(0);
  });

  // ─── getHistory() ───────────────────────────────────────────────

  it('filters snapshots by filePath', () => {
    const snap1 = JSON.stringify({ filePath: '/a', content: '1', timestamp: 100, size: 1 });
    const snap2 = JSON.stringify({ filePath: '/b', content: '2', timestamp: 200, size: 1 });

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['100-a.json', '200-b.json']);
    vi.mocked(readFileSync)
      .mockReturnValueOnce(snap1)
      .mockReturnValueOnce(snap2);

    const cp = new FileCheckpoint('s1');
    const history = cp.getHistory('/a');

    expect(history).toHaveLength(1);
    expect(history[0].filePath).toBe('/a');
  });

  // ─── clear() ─────────────────────────────────────────────────────

  it('removes all json files from checkpoint dir', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['100-a.json', '200-b.json']);

    const cp = new FileCheckpoint('s1');
    vi.mocked(unlinkSync).mockClear();
    cp.clear();

    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('does nothing when dir does not exist', () => {
    // existsSync returns false for everything including the dir check in clear()
    const cp = new FileCheckpoint('s1');
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(unlinkSync).mockClear();
    cp.clear();

    expect(unlinkSync).not.toHaveBeenCalled();
  });
});
