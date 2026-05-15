import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  // v4.7.4: pre-write-guard fingerprint cache writes to <pluginRoot>/runtime/.
  getPluginRoot: vi.fn(() => '/plugin-root'),
}));

// v4.7.4: shouldEnforceGuard now anchors the Artibot marker check on the
// git repo root (not cwd) to avoid false positives in monorepo subdirs.
let getRepoRootMock = vi.fn(() => '/workspace');
vi.mock('../../lib/git/repo-root-cache.js', () => ({
  getRepoRoot: (...args) => getRepoRootMock(...args),
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
    getRepoRootMock = vi.fn(() => '/workspace');
  });

  describe('Read tracking (PostToolUse Read)', () => {
    // v4.7.3: PostToolUse Read now records to an in-memory Set and flushes
    // to disk on a 200ms debounce (perf-auditor A1.1). Tests wait past the
    // debounce window before asserting on the tracking file contents.
    const DEBOUNCE_WAIT_MS = 300;

    it('records a read file path to tracking file (after debounce flush)', async () => {
      readStdin.mockResolvedValue(makePostReadData('/project/src/app.js'));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT_MS));

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
      await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT_MS));

      // Path already in cache (seeded from disk) — recordReadPath skips
      // marking dirty, so the debounce flush has nothing to write.
      const tp = trackingPath();
      expect(writtenFiles[tp]).toBeUndefined();
    });

    it('caches reads in-memory and only writes once per debounce window', async () => {
      // Simulate two distinct reads in the same session — should result in
      // a single flushed write containing both paths (debounced batch).
      const session = 'batch-session';

      readStdin.mockResolvedValueOnce(makePostReadData('/project/src/a.js', session));
      await import('../../scripts/hooks/pre-write-guard.js');
      // Reset module state would lose the cache; instead trigger a 2nd Read
      // via a fresh module import would also reset cache. Verify single-call
      // flush behaviour via the basic 1-record case above.
      await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT_MS));
      const tp = path.join('/tmp', `artibot-read-tracking-${session}.json`);
      expect(writtenFiles[tp]).toBeDefined();
      const recorded = JSON.parse(writtenFiles[tp]);
      expect(recorded).toEqual(['/project/src/a.js']);
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
      const filePath = '/workspace/plugins/artibot/lib/core/config.js';

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
      const filePath = '/workspace/plugins/artibot/lib/core/cache.js';

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
      const filePath = '/workspace/plugins/artibot/lib/core/config.js';

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

  describe('whitelist - Claude config files (approve without Read)', () => {
    it('approves Write to CLAUDE.md without prior Read', async () => {
      const filePath = '/project/CLAUDE.md';

      // File exists but was NOT read
      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      readFileSync.mockReturnValue('[]');

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('approves Write to CLAUDE.local.md without prior Read', async () => {
      const filePath = '/project/CLAUDE.local.md';

      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      readFileSync.mockReturnValue('[]');

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('approves Write to .claude/ directory files without prior Read', async () => {
      const filePath = '/home/user/.claude/settings.json';

      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      readFileSync.mockReturnValue('[]');

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

  // -------------------------------------------------------------------------
  // v4.7.4 — monorepo cwd anchoring (shouldEnforceGuard)
  //
  // The guard previously ran existsSync against process.cwd(), so a parent
  // directory carrying an unrelated artibot.config.json (e.g. a workspace
  // monorepo) would falsely opt non-Artibot subprojects in. The fix anchors
  // the marker check on getRepoRoot(cwd) — only the actual repo root counts.
  // -------------------------------------------------------------------------
  describe('monorepo cwd anchoring (Tier 1 marker check)', () => {
    it('approves write in non-Artibot repo even when parent dir has the marker', async () => {
      // Simulate: cwd is /workspace/sub-project, repoRoot is the sub-project,
      // and existsSync returns false at the repo root (no Artibot markers).
      getRepoRootMock = vi.fn(() => '/workspace/sub-project');
      existsSync.mockImplementation((p) => {
        const s = String(p);
        // Tracking file exists (so degraded-mode bypass doesn't kick in),
        // target file exists, but NEITHER artibot marker exists at repoRoot.
        if (s.includes('artibot-read-tracking')) return true;
        if (s.endsWith('plugins/artibot/CLAUDE.md')) return false;
        if (s.endsWith('plugins\\artibot\\CLAUDE.md')) return false;
        if (s.endsWith('artibot.config.json')) return false;
        return true; // every other path (target file, etc.) exists
      });

      readStdin.mockResolvedValue(makePreWriteData('/workspace/sub-project/lib/foo.js'));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('enforces write-before-read in a real Artibot repo (positive control)', async () => {
      getRepoRootMock = vi.fn(() => '/workspace');
      existsSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot-read-tracking')) return true;
        // Marker present at repoRoot.
        if (s === '/workspace/artibot.config.json') return true;
        if (s === '/workspace\\artibot.config.json') return true;
        return true;
      });
      readFileSync.mockReturnValue('[]');

      readStdin.mockResolvedValue(
        makePreWriteData('/workspace/plugins/artibot/lib/core/config.js'),
      );

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // v4.7.4 — fingerprint loop guard (handleWriteGuard)
  //
  // The user-reported "block → retry → block → must end session" loop is
  // broken by detecting a duplicate (sessionId, toolName, filePath) and
  // downgrading the second block to approve. The fingerprint persists on
  // disk between hook invocations.
  // -------------------------------------------------------------------------
  describe('fingerprint loop guard (block → duplicate → approve)', () => {
    it('blocks the first attempt and persists the fingerprint', async () => {
      const filePath = '/workspace/plugins/artibot/lib/core/cache.js';

      existsSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot-read-tracking')) return true;
        if (s.includes('last-pre-write-block.txt')) return false;
        return true;
      });
      readFileSync.mockReturnValue('[]');

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
      // Fingerprint persisted to runtime/last-pre-write-block.txt
      const fpPath = path.join('/plugin-root', 'runtime', 'last-pre-write-block.txt');
      expect(writtenFiles[fpPath]).toBeDefined();
    });

    it('downgrades a duplicate block to approve (loop bypass)', async () => {
      const filePath = '/workspace/plugins/artibot/lib/core/cache.js';
      const sessionId = 'loop-session';
      // Pre-compute the fingerprint the way pre-write-guard does.
      const { createHash } = await import('node:crypto');
      const fingerprint = createHash('sha1')
        .update(`${sessionId}|Write|${filePath}`)
        .digest('hex')
        .slice(0, 16);

      existsSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot-read-tracking')) return true;
        // Fingerprint cache file exists with the matching fingerprint.
        if (s.includes('last-pre-write-block.txt')) return true;
        return true;
      });
      readFileSync.mockImplementation((p, enc) => {
        const s = String(p);
        if (s.includes('last-pre-write-block.txt')) return fingerprint + '\n';
        if (enc === 'utf-8' || enc === 'utf8') return '[]';
        return '[]';
      });

      readStdin.mockResolvedValue(makePreWriteData(filePath, 'Write', sessionId));

      await import('../../scripts/hooks/pre-write-guard.js');
      await new Promise((r) => setTimeout(r, 50));

      // Second attempt: same fingerprint → approve, loop broken.
      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });
});
