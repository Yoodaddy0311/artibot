import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
  };
});

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');
const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memory-tracker hook', () => {
  let originalEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalEnv = { ...process.env };
    process.env.USERPROFILE = 'C:\\Users\\TestUser';
    process.env.HOME = '/home/testuser';
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('SessionStart event', () => {
    it('outputs "no previous memories" when memory dir does not exist', async () => {
      existsSync.mockReturnValue(false);
      readStdin.mockResolvedValue(
        JSON.stringify({ event_type: 'SessionStart' }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('no previous memories'),
        }),
      );
    });

    it('outputs "initialized" when memory dir exists but is empty', async () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({ event_type: 'SessionStart' }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('initialized'),
        }),
      );
    });

    it('reports loaded preferences count', async () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation((filePath) => {
        const fp = String(filePath);
        if (fp.includes('user-preferences')) {
          return JSON.stringify({
            entries: [
              { id: 'p1', expiresAt: new Date(Date.now() + 86400000).toISOString() },
              { id: 'p2', expiresAt: new Date(Date.now() + 86400000).toISOString() },
            ],
            metadata: {},
          });
        }
        if (fp.includes('project-contexts')) {
          return JSON.stringify({ entries: [], metadata: {} });
        }
        return JSON.stringify({ entries: [], metadata: {} });
      });
      readStdin.mockResolvedValue(
        JSON.stringify({ event_type: 'SessionStart' }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('2 preferences'),
        }),
      );
    });

    it('handles session_start event type (lowercase)', async () => {
      existsSync.mockReturnValue(false);
      readStdin.mockResolvedValue(
        JSON.stringify({ event_type: 'session_start' }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('no previous memories'),
        }),
      );
    });

    it('filters out expired entries', async () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation((filePath) => {
        const fp = String(filePath);
        if (fp.includes('user-preferences')) {
          return JSON.stringify({
            entries: [
              { id: 'p1', expiresAt: new Date(Date.now() - 86400000).toISOString() }, // expired
              { id: 'p2', expiresAt: new Date(Date.now() + 86400000).toISOString() }, // valid
            ],
            metadata: {},
          });
        }
        return JSON.stringify({ entries: [], metadata: {} });
      });
      readStdin.mockResolvedValue(
        JSON.stringify({ event_type: 'SessionStart' }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('1 preferences'),
        }),
      );
    });
  });

  describe('SessionEnd event', () => {
    it('saves session summary to project contexts store', async () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({
          event_type: 'SessionEnd',
          session_id: 'sess-123',
          project: 'artibot',
        }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('memory'),
        { recursive: true },
      );
      expect(writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(writtenData.entries.length).toBeGreaterThanOrEqual(1);
      const lastEntry = writtenData.entries[writtenData.entries.length - 1];
      expect(lastEntry.type).toBe('context');
      expect(lastEntry.data.sessionId).toBe('sess-123');
    });

    it('handles session_end event type (lowercase)', async () => {
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({ event_type: 'session_end', session_id: 'sess-456' }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeFileSync).toHaveBeenCalled();
    });
  });

  describe('Error event', () => {
    it('saves error pattern to error-patterns store', async () => {
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({
          event_type: 'error',
          error: {
            message: 'Cannot read property of undefined',
            command: '/build',
            file: 'src/app.js',
          },
        }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(writeFileSync.mock.calls[0][1]);
      const lastEntry = writtenData.entries[writtenData.entries.length - 1];
      expect(lastEntry.type).toBe('error');
      expect(lastEntry.data.message).toContain('Cannot read property');
      expect(lastEntry.tags).toContain('error');
    });

    it('handles Error event type (capitalized)', async () => {
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({
          event_type: 'Error',
          error: { message: 'Something failed' },
        }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeFileSync).toHaveBeenCalled();
    });

    it('handles unknown event with error field present', async () => {
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({
          event_type: 'unknown_event',
          error: { message: 'Unexpected error occurred' },
        }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      // Default case: if hookData.error exists, handleError is called
      expect(writeFileSync).toHaveBeenCalled();
    });
  });

  describe('Command event', () => {
    it('saves command to command-history store', async () => {
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({
          event_type: 'command',
          command: { name: '/build', args: '--api' },
        }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(writeFileSync.mock.calls[0][1]);
      const lastEntry = writtenData.entries[writtenData.entries.length - 1];
      expect(lastEntry.type).toBe('command');
      expect(lastEntry.data.command).toBe('/build');
    });

    it('handles string command data', async () => {
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({
          event_type: 'Command',
          command: '/analyze src/',
        }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(writeFileSync.mock.calls[0][1]);
      const lastEntry = writtenData.entries[writtenData.entries.length - 1];
      expect(lastEntry.data.command).toBe('/analyze src/');
    });
  });

  describe('store management', () => {
    it('enforces MAX_ERROR_PATTERNS limit', async () => {
      const existingEntries = Array.from({ length: 250 }, (_, i) => ({
        id: `error_${i}`,
        type: 'error',
        data: { message: `Error ${i}` },
        tags: ['error'],
        source: 'memory-tracker',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }));

      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: existingEntries, metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({
          event_type: 'error',
          error: { message: 'New error' },
        }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(writeFileSync.mock.calls[0][1]);
      // MAX_ERROR_PATTERNS = 200, so kept = slice(-(200-1)) = slice(-199) + 1 new = 200
      expect(writtenData.entries.length).toBeLessThanOrEqual(200);
    });

    it('creates memory directory if not exists', async () => {
      readFileSync.mockImplementation(() =>
        JSON.stringify({ entries: [], metadata: {} }),
      );
      readStdin.mockResolvedValue(
        JSON.stringify({
          event_type: 'session_end',
          session_id: 'sess-new',
        }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('memory'),
        { recursive: true },
      );
    });
  });

  describe('null/empty input', () => {
    it('does nothing for invalid JSON input', async () => {
      readStdin.mockResolvedValue('not json');

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('does nothing for unknown event type without error', async () => {
      readStdin.mockResolvedValue(
        JSON.stringify({ event_type: 'unknown', data: 'something' }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('error resilience', () => {
    it('writes to stderr but does not crash when store file is corrupted', async () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() => 'corrupted json data');
      readStdin.mockResolvedValue(
        JSON.stringify({ event_type: 'SessionStart' }),
      );

      await import('../../scripts/hooks/memory-tracker.js');
      await new Promise((r) => setTimeout(r, 50));

      // loadStoreSync catches JSON.parse errors and returns default
      expect(writeStdout).toHaveBeenCalled();
    });
  });
});
