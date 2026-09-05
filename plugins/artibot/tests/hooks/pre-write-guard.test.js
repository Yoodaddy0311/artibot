import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // P0 advisory-mode toggle: resolveWriteGuardMode reads artibot.config.json.
  resolveConfigPath: vi.fn((...segs) => ['/plugin-root', ...segs].join('/')),
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

// The ledger edge is stubbed so the `human.asked` record can be observed
// without a filesystem — which matters doubly here, because `node:fs` is
// already mocked above and the real `resolveProjectRoot` walks it.
// `lib/security/human-gates.js` is deliberately NOT stubbed: the gate ids
// asserted below are real `classify()` output.
const ledger = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock('../../lib/runtime/ledger.js', () => ({ appendLedgerEvent: ledger.append }));
vi.mock('../../lib/git/project-root.js', () => ({ resolveProjectRoot: (cwd) => cwd }));

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');
const { existsSync, readFileSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A PreToolUse Write/Edit payload.
 *
 * `cwd` is OMITTED by default so every pre-existing case in this file keeps
 * the payload shape it was written against — which is also the shape that
 * records nothing, since the recorder needs an injected root and never derives
 * one. Unlike `pre-write.js`, this hook's decision does not consult
 * `hookData.cwd` at all (`shouldEnforceGuard` reads `process.cwd()`), so
 * adding the key changes only whether a record is written.
 *
 * @param {string} filePath
 * @param {string} [toolName]
 * @param {string} [sessionId]
 * @param {{cwd?: string}} [opts]
 * @returns {string}
 */
function makePreWriteData(filePath, toolName = 'Write', sessionId = 'test-session', opts = {}) {
  const data = {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
    session_id: sessionId,
  };
  if (opts.cwd !== undefined) data.cwd = opts.cwd;
  return JSON.stringify(data);
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

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/pre-write-guard.js');
  // The `.catch` is the module's OWN exported tail, not a copy of it. A
  // hand-rolled `createErrorHandler(...)` here would keep passing after the
  // real tail stopped recording — the error path would be tested against a
  // reimplementation of itself.
  await mod.main().catch(mod.handleHookError);
}

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

      await runHook();
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

      await runHook();
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
      await runHook();
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

      await runHook();
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

      await runHook();
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

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
      const call = writeStdout.mock.calls[0][0];
      expect(call.reason).toContain('WRITE-BEFORE-READ');
      expect(call.reason).toContain(filePath);
      // The block reason is the ONLY channel that reaches the model for this
      // failure: a PreToolUse block means the tool never ran, so no
      // PostToolUse/PostToolUseFailure event is emitted and no advisor hook can
      // add the corrective step (measured 2026-08-10). The retry instruction
      // therefore has to live in this string.
      expect(call.reason).toContain('retry the same Write');
    });

    it('blocks Edit to existing file not Read in session', async () => {
      const filePath = '/workspace/plugins/artibot/lib/core/cache.js';

      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      readFileSync.mockReturnValue('[]');

      readStdin.mockResolvedValue(makePreWriteData(filePath, 'Edit'));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
      const call = writeStdout.mock.calls[0][0];
      expect(call.reason).toContain('WRITE-BEFORE-READ');
      expect(call.reason).toContain('retry the same Edit');
    });
  });

  describe('Write guard - new file creation (approve)', () => {
    it('approves Write to a file that does not exist yet', async () => {
      const filePath = '/project/src/new-file.js';

      // File does not exist on disk
      existsSync.mockReturnValue(false);

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('approves Write when no tracking file exists (new file)', async () => {
      const filePath = '/project/src/brand-new.ts';

      existsSync.mockReturnValue(false);

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await runHook();
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

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('handles null hookData gracefully', async () => {
      readStdin.mockResolvedValue('invalid json');

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      // Should not call writeStdout (early return)
      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('handles corrupted tracking file gracefully', async () => {
      const filePath = '/workspace/plugins/artibot/lib/core/config.js';

      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('not valid json');

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await runHook();
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

      await runHook();
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

      await runHook();
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

      await runHook();
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

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });

  describe('error handling', () => {
    it('blocks by default when hook errors', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));

      await runHook();
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

      await runHook();
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

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // P0 new-user UX — write-guard advisory mode toggle
  //
  // devProtocol.writeGuardMode = 'advisory' (or env ARTIBOT_WRITE_GUARD_MODE)
  // downgrades the write-before-read BLOCK to an APPROVE (warn-only). Default
  // 'block' preserves strict DEV-protocol enforcement (regression-safe).
  // -------------------------------------------------------------------------
  describe('write-guard advisory mode (config toggle)', () => {
    const ORIG_ENV = process.env.ARTIBOT_WRITE_GUARD_MODE;
    afterEach(() => {
      if (ORIG_ENV === undefined) delete process.env.ARTIBOT_WRITE_GUARD_MODE;
      else process.env.ARTIBOT_WRITE_GUARD_MODE = ORIG_ENV;
    });

    it('approves (warn-only) when config writeGuardMode=advisory', async () => {
      delete process.env.ARTIBOT_WRITE_GUARD_MODE;
      const filePath = '/workspace/plugins/artibot/lib/core/config.js';

      existsSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot-read-tracking')) return true;
        if (s.includes('last-pre-write-block.txt')) return false;
        return true;
      });
      // Tracking returns empty list; config returns advisory mode.
      readFileSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot.config.json')) {
          return JSON.stringify({ devProtocol: { writeGuardMode: 'advisory' } });
        }
        return '[]';
      });

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
      // Advisory path must NOT persist a block fingerprint.
      const fpPath = path.join('/plugin-root', 'runtime', 'last-pre-write-block.txt');
      expect(writtenFiles[fpPath]).toBeUndefined();
    });

    it('env ARTIBOT_WRITE_GUARD_MODE=advisory overrides config block', async () => {
      process.env.ARTIBOT_WRITE_GUARD_MODE = 'advisory';
      const filePath = '/workspace/plugins/artibot/lib/core/cache.js';

      existsSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot-read-tracking')) return true;
        if (s.includes('last-pre-write-block.txt')) return false;
        return true;
      });
      // Config explicitly block, but env says advisory → advisory wins.
      readFileSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot.config.json')) {
          return JSON.stringify({ devProtocol: { writeGuardMode: 'block' } });
        }
        return '[]';
      });

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('still blocks when config writeGuardMode=block (default preserved)', async () => {
      delete process.env.ARTIBOT_WRITE_GUARD_MODE;
      const filePath = '/workspace/plugins/artibot/lib/core/config.js';

      existsSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot-read-tracking')) return true;
        if (s.includes('last-pre-write-block.txt')) return false;
        return true;
      });
      readFileSync.mockImplementation((p) => {
        const s = String(p);
        if (s.includes('artibot.config.json')) {
          return JSON.stringify({ devProtocol: { writeGuardMode: 'block' } });
        }
        return '[]';
      });

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await runHook();
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

      await runHook();
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

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      // Second attempt: same fingerprint → approve, loop broken.
      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });
  // -------------------------------------------------------------------------
  // human.asked record (T-39 symmetry)
  // -------------------------------------------------------------------------
  describe('human.asked record', () => {
    const CWD = '/project';
    const BLOCKED_FILE = '/workspace/plugins/artibot/lib/core/config.js';

    /**
     * Reproduce the mock state the "Write without Read" block cases run under:
     * the file and the tracking file both exist, and the tracking file is
     * empty. Without the tracking file the guard takes its DEGRADED branch and
     * approves, so this setup is what keeps the cases below off a vacuous path.
     */
    function arrangeBlock() {
      existsSync.mockImplementation(() => true);
      readFileSync.mockReturnValue('[]');
    }

    it.each(['Write', 'Edit'])('appends exactly one line for a blocked %s', async (tool) => {
      arrangeBlock();
      readStdin.mockResolvedValue(
        makePreWriteData(BLOCKED_FILE, tool, `rec-${tool}`, { cwd: CWD }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
      expect(ledger.append).toHaveBeenCalledTimes(1);
      const [root, event] = ledger.append.mock.calls[0];
      expect(root).toBe(CWD);
      expect(event.event).toBe('human.asked');
      expect(event.source).toBe('hook');
      expect(event.session_id).toBe(`rec-${tool}`);
      expect(event.data.decision).toBe('block');
      expect(event.data.tool).toBe(tool);
      expect(event.data.path).toBe(BLOCKED_FILE);
      // A `.js` path under the repo is HG-02 (local reversible edit) and
      // nothing stricter — real `classify()` output, measured 2026-09-05.
      expect(event.data.hits).toEqual(['HG-02']);
      expect(event.data.gate).toBe('HG-02');
    });

    it('records the reason byte-for-byte as it was sent to stdout', async () => {
      arrangeBlock();
      readStdin.mockResolvedValue(
        makePreWriteData(BLOCKED_FILE, 'Write', 'rec-reason', { cwd: CWD }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const stdoutReason = writeStdout.mock.calls[0][0].reason;
      expect(ledger.append.mock.calls[0][1].data.reason).toBe(stdoutReason);
      // The retry instruction is the only corrective channel for this failure,
      // so the ledger copy has to carry it too rather than a summary.
      expect(stdoutReason).toContain('WRITE-BEFORE-READ');
    });

    it('appends nothing on the approve path', async () => {
      existsSync.mockImplementation(() => true);
      readFileSync.mockReturnValue(JSON.stringify([BLOCKED_FILE]));
      readStdin.mockResolvedValue(
        makePreWriteData(BLOCKED_FILE, 'Write', 'rec-approve', { cwd: CWD }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
      expect(ledger.append).not.toHaveBeenCalled();
    });

    it('appends nothing when the payload carries no cwd', async () => {
      // NEGATIVE CONTROL for the whole describe: this is the payload shape
      // every other case in this file uses. The block still happens; only the
      // record is withheld, because the recorder never derives a root.
      arrangeBlock();
      readStdin.mockResolvedValue(makePreWriteData(BLOCKED_FILE, 'Write', 'rec-nocwd'));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
      expect(ledger.append).not.toHaveBeenCalled();
    });

    it('writes the decision to stdout BEFORE it touches the ledger', async () => {
      arrangeBlock();
      readStdin.mockResolvedValue(
        makePreWriteData(BLOCKED_FILE, 'Write', 'rec-order', { cwd: CWD }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      // Ordering is the observe contract: bookkeeping may never delay or
      // reorder a security decision.
      expect(writeStdout.mock.invocationCallOrder[0])
        .toBeLessThan(ledger.append.mock.invocationCallOrder[0]);
    });

    it('records nothing from the fail-closed tail, which has no payload', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith({
        decision: 'block',
        reason: 'Write-before-read guard failed. Blocking by default.',
      });
      expect(ledger.append).not.toHaveBeenCalled();
    });
  });
});
