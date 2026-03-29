import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track written files for atomicWriteSync mock
let writtenFiles = {};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  atomicWriteSync: vi.fn((filePath, data) => {
    writtenFiles[filePath] = data;
  }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path');
  return { ...actual, default: actual };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    default: { ...actual, tmpdir: () => '/tmp' },
    tmpdir: () => '/tmp',
  };
});

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');
const { existsSync, readFileSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePreWriteData(filePath, toolName = 'Write', sessionId = 'test-session') {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
    session_id: sessionId,
  });
}

function makePostReadData(filePath, sessionId = 'test-session') {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    session_id: sessionId,
  });
}

function trackingPath(sessionId = 'test-session') {
  return path.join('/tmp', `artibot-read-tracking-${sessionId}.json`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pre-write-guard hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    writtenFiles = {};
    existsSync.mockReturnValue(false);
    readFileSync.mockReturnValue('[]');
  });

  describe('Read tracking (PostToolUse Read)', () => {
    it('records a read file path to tracking file', async () => {
      readStdin.mockResolvedValue(makePostReadData('/project/src/app.js'));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      const tp = trackingPath();
      expect(writtenFiles[tp]).toBeDefined();
      const recorded = JSON.parse(writtenFiles[tp]);
      expect(recorded).toContain('/project/src/app.js');
    });

    it('does not duplicate paths on repeated reads', async () => {
      // Simulate existing tracking with the same path already recorded
      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return false;
      });
      readFileSync.mockReturnValue(JSON.stringify(['/project/src/app.js']));

      readStdin.mockResolvedValue(makePostReadData('/project/src/app.js'));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      // Should not write since path already exists
      const tp = trackingPath();
      expect(writtenFiles[tp]).toBeUndefined();
    });
  });

  describe('Write guard - Read then Write (approve)', () => {
    it('approves Write to a file that was previously Read', async () => {
      const filePath = '/project/src/app.js';

      // File exists on disk
      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      // Tracking file contains this path
      readFileSync.mockReturnValue(JSON.stringify(['/project/src/app.js']));

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('approves Edit to a file that was previously Read', async () => {
      const filePath = '/project/src/utils.js';

      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      readFileSync.mockReturnValue(JSON.stringify(['/project/src/utils.js']));

      readStdin.mockResolvedValue(makePreWriteData(filePath, 'Edit'));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });

  describe('Write guard - Write without Read (block)', () => {
    it('blocks Write to existing file not Read in session', async () => {
      const filePath = '/project/src/app.js';

      // File exists on disk but tracking file is empty
      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      readFileSync.mockReturnValue('[]');

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
      const call = writeStdout.mock.calls[0][0];
      expect(call.reason).toContain('WRITE-BEFORE-READ');
      expect(call.reason).toContain(filePath);
    });

    it('blocks Edit to existing file not Read in session', async () => {
      const filePath = '/project/src/config.js';

      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      readFileSync.mockReturnValue('[]');

      readStdin.mockResolvedValue(makePreWriteData(filePath, 'Edit'));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
      const call = writeStdout.mock.calls[0][0];
      expect(call.reason).toContain('WRITE-BEFORE-READ');
    });
  });

  describe('Write guard - new file creation (approve)', () => {
    it('approves Write to a file that does not exist yet', async () => {
      const filePath = '/project/src/new-file.js';

      // File does not exist on disk
      existsSync.mockReturnValue(false);

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('approves Write when no tracking file exists (new file)', async () => {
      const filePath = '/project/src/brand-new.ts';

      existsSync.mockReturnValue(false);

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });

  describe('edge cases', () => {
    it('approves when file_path is empty', async () => {
      readStdin.mockResolvedValue(JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {},
        session_id: 'test-session',
      }));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('handles null hookData gracefully', async () => {
      readStdin.mockResolvedValue('invalid json');

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      // Should not call writeStdout (early return)
      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('handles corrupted tracking file gracefully', async () => {
      const filePath = '/project/src/app.js';

      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('not valid json');

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      // Corrupted tracking = empty read list = block existing file
      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('normalizes backslashes in file paths for cross-platform tracking', async () => {
      const filePath = '/project/src/app.js';

      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      // Path stored with forward slashes
      readFileSync.mockReturnValue(JSON.stringify(['/project/src/app.js']));

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });

  describe('error handling', () => {
    it('blocks by default when hook errors', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });
  });
});
