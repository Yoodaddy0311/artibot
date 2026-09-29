import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { isClaudeConfigPath, PROTECTED_CONFIG_BASENAMES } from '../../lib/security/human-gate-enforce.js';
import { getGateRow } from '../../lib/security/human-gates.js';

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
    // Pass-through spies for the exemption's junction check (CA-04 L4): the real
    // filesystem answers unless a case makes one call fail on purpose.
    lstatSync: vi.fn(actual.lstatSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
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
// Everything here except the four spied functions is the real `node:fs`.
const {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} = await import('node:fs');

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

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('approves Write when no tracking file exists (new file)', async () => {
      const filePath = '/project/src/brand-new.ts';

      existsSync.mockReturnValue(false);

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('approves Write to .claude/rules files without prior Read', async () => {
      // Under cwd, so the guard is IN SCOPE (Tier 2) and the approve can only come
      // from the exemption. The old case used /home/user/.claude/settings.json,
      // which sits outside cwd and was approved by the Tier 2 skip whatever
      // isWhitelisted said, so it proved nothing. CA-04 L4 narrowed this rule from
      // "any path containing .claude/" to an allowlist; settings.json moved to the
      // 'isWhitelisted allowlist' table below.
      const filePath = path.join(process.cwd(), '.claude', 'rules', 'x.md');

      existsSync.mockImplementation((p) => {
        if (typeof p === 'string' && p.includes('artibot-read-tracking')) return true;
        return true;
      });
      readFileSync.mockReturnValue('[]');

      readStdin.mockResolvedValue(makePreWriteData(filePath));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
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

      // Second attempt: same fingerprint → pass, loop broken.
      expect(writeStdout).not.toHaveBeenCalled();
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

      expect(writeStdout).not.toHaveBeenCalled();
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

  // =========================================================================
  // CA-04 L4 — `isWhitelisted` is an ALLOWLIST of write-before-read exemptions
  //
  // Before: any path containing the substring `.claude/` was exempt. That put
  // `.claude/settings*.json`, hooks.json, dispatch-table.json and
  // artibot.config.json (HG-12/HG-13 material) on a "needs no prior Read" list,
  // and `not.claude/` matched as well. After: four families are exempt and
  // everything else falls through to the guard.
  //
  // THE HARD INVARIANT is the split worktree. A limb window edits files inside
  // `<repo>/.claude/worktrees/<name>/` and /split depends on that staying
  // exempt, so "unchanged" is measured against a FROZEN COPY of the old rule
  // (`legacyIsWhitelisted`) rather than against a restatement of the new one.
  // =========================================================================
  describe('isWhitelisted allowlist (CA-04 L4)', () => {
    /** Frozen copy of the rule as of eae2cf09. The reference, not the subject. */
    function legacyIsWhitelisted(filePath) {
      if (!filePath) return false;
      if (['CLAUDE.md', 'CLAUDE.local.md'].includes(path.basename(filePath))) return true;
      return filePath.replace(/\\/g, '/').includes('.claude/');
    }

    const toBackslashes = (p) => p.replace(/\//g, '\\');

    // Windows-style fixtures interpolate the drive letter: the landing gate
    // (lib/git/limb-landing-check.js) refuses a literal drive-letter Users path in
    // added lines, and a fixture is not a reason to tempt it. Any letter works
    // here because the filesystem is stubbed (see the beforeEach below).
    const DRIVE = 'C:';
    const drive = 'c:';

    /** Paths that MUST stay exempt: [path, why]. */
    const EXEMPT = [
      ['/project/CLAUDE.md', 'context file, any directory'],
      ['/project/CLAUDE.local.md', 'context file, any directory'],
      ['/repo/.claude/CLAUDE.md', 'a context file wins even under .claude/'],
      ['/repo/.claude/worktrees/x/src/a.js', 'split worktree interior'],
      ['/repo/.claude/worktrees/x/plugins/artibot/lib/a.js', 'split worktree interior, plugin source'],
      ['/repo/.claude/worktrees/x/plugins/artibot/hooks/hooks.json', 'a worktree SOURCE copy of hooks.json is not the running config'],
      ['/repo/.claude/worktrees/x/plugins/artibot/artibot.config.json', 'a worktree SOURCE copy of the config'],
      [`${DRIVE}\\Users\\me\\repo\\.claude\\worktrees\\agent-1\\src\\a.js`, 'Windows backslashes'],
      [`${DRIVE}/Users/me/repo/.claude/worktrees/agent-1/src/a.js`, 'Windows drive, forward slashes'],
      [`${drive}\\users\\me\\repo\\.claude\\worktrees\\agent-1\\src\\a.js`, 'lower-case drive'],
      [`${DRIVE}\\Users\\HEECHA~1\\repo\\.claude\\worktrees\\x\\src\\a.js`, '8.3 user directory above the marker'],
      [`${DRIVE}\\Users/me\\repo/.claude\\worktrees/x\\src/a.js`, 'mixed separators'],
      ['/repo//.claude/./worktrees/x//src/./a.js', 'duplicate separators and dot segments'],
      ['/repo/.claude/worktrees/x/src/../lib/a.js', '.. that stays inside the worktree'],
      ['/repo/.claude/worktrees/a/.claude/worktrees/b/src/a.js', 'nested worktree interior'],
      ['/repo/.claude/worktrees/x/.claude/rules/r.md', "a worktree's own prose directory"],
      ['/home/u/.claude/projects/-home-u-proj/memory/MEMORY.md', 'auto memory index'],
      ['/home/u/.claude/projects/-home-u-proj/memory/feedback-x.md', 'auto memory note'],
      ['/home/u/.claude/rules/artibot/agent-coordination.md', 'global rules'],
      ['/repo/.claude/rules/x.md', 'rules'],
      ['/repo/.claude/agents/planner.md', 'agents'],
      ['/repo/.claude/commands/go.md', 'commands'],
      ['/repo/.claude/skills/tdd/SKILL.md', 'skills'],
      ['/repo/.claude/skills/tdd/scripts/run.js', 'skills, nested'],
      [`${DRIVE}\\Users\\me\\.claude\\rules\\artibot\\dev-protocol.md`, 'global rules, Windows'],
      [`${DRIVE}\\Users\\me\\.claude\\projects\\C--Users-me-Desktop-AI-Artibot\\memory\\MEMORY.md`, 'auto memory, the real slug shape'],
      [`${DRIVE}\\Users\\me\\Desktop\\AI\\Artibot\\.claude\\worktrees\\agent-aea30c7a065bd19ab\\plugins\\artibot\\scripts\\hooks\\pre-write-guard.js`, 'the path shape a limb window edits this very hook at'],
    ];

    /** Paths that must NOT be exempt: [path, why]. */
    const NOT_EXEMPT = [
      // The narrowing itself: config files under .claude/.
      ['/home/user/.claude/settings.json', 'host settings'],
      ['/repo/.claude/settings.local.json', 'project-local settings'],
      ['/repo/.claude/hooks.json', 'hooks config'],
      ['/repo/.claude/dispatch-table.json', 'dispatch table'],
      ['/repo/.claude/artibot.config.json', 'plugin config'],
      ['/repo/.claude/worktrees/x/.claude/settings.local.json', "a worktree's OWN settings are still settings"],
      ['/repo/.claude/worktrees/x/plugins/artibot/.claude/settings.json', 'settings nested in a worktree source tree'],
      ['C:\\repo\\.claude\\worktrees\\x\\.claude\\settings.local.json', 'same, Windows separators'],
      // The real host settings paths.
      [`${DRIVE}\\Users\\me\\.claude\\settings.json`, 'host settings, Windows'],
      [`${DRIVE}/Users/me/.claude/settings.local.json`, 'host local settings, forward slashes'],
      [`${DRIVE}\\Users\\me\\.claude.json`, 'host global config: a name that merely starts with .claude'],
      // Under .claude/ but outside the allowlist.
      ['/repo/.claude/plans/p.md', 'not on the allowlist'],
      ['/repo/.claude/foo/bar.txt', 'not on the allowlist'],
      ['/home/u/.claude/plugins/cache/artibot/artibot/4.68.0/scripts/hooks/pre-write-guard.js', 'installed plugin copy'],
      ['/home/u/.claude/projects/slug/session.jsonl', 'project state that is not a memory note'],
      ['/home/u/.claude/projects/slug/memory/sub/deep.md', 'memory notes are one level deep'],
      ['/home/u/.claude/projects/slug/memory/notes.txt', 'memory notes are markdown'],
      ['/repo/.claude/worktrees/x', 'the worktree directory itself, nothing inside it'],
      ['/repo/.claude/worktrees', 'no worktree name'],
      ['/repo/.claude/rules', 'the prose directory itself'],
      // A protected basename never rides in on a prose directory. `.mcp.json` is not
      // in the gate core's list; it defines MCP servers (code that runs), so this
      // exemption protects it as well.
      ...[...PROTECTED_CONFIG_BASENAMES, '.mcp.json'].flatMap((name) => [
        [`/repo/.claude/rules/${name}`, 'protected basename in rules'],
        [`/repo/.claude/skills/s/${name}`, 'protected basename in skills'],
        [`/repo/.claude/agents/${name.toUpperCase()}`, 'protected basename, other case'],
      ]),
      // Windows reads a trailing dot or space away, so these ARE the protected names.
      ['/repo/.claude/rules/settings.json.', 'trailing dot on a protected basename'],
      ['/repo/.claude/rules/settings.json ', 'trailing space on a protected basename'],
      // A segment, not a substring.
      ['/repo/not.claude/settings.json', 'substring match was the old bug'],
      ['/repo/x.claude/rules/y.md', 'substring match was the old bug'],
      ['/repo/.claudeish/rules/y.md', 'prefix match'],
      // No .claude at all.
      ['/repo/src/a.js', 'ordinary file'],
      ['/repo/plugins/artibot/hooks/hooks.json', 'repo source copy outside a worktree'],
      ['/repo/worktrees/x/src/a.js', 'looks like a worktree but is not under .claude/'],
      // Traversal is resolved BEFORE anything is granted.
      ['/repo/.claude/worktrees/x/../../settings.json', 'climbs out of the worktree into .claude/'],
      ['/repo/.claude/worktrees/x/src/../../../settings.local.json', 'climbs out of the worktree into .claude/'],
      ['/repo/.claude/rules/../settings.json', 'climbs out of rules'],
      ['/repo/.claude/worktrees/x/../../rules/../settings.json', 'zig-zag'],
      // Exact-case grants: other spellings are never granted.
      ['/repo/.CLAUDE/rules/x.md', 'case variant of .claude'],
      ['/repo/.Claude/worktrees/x/src/a.js', 'case variant of .claude'],
      ['/repo/.claude/Rules/x.md', 'case variant of rules'],
      ['/repo/.claude/worktrees/x/.CLAUDE/settings.local.json', 'case variant inside a worktree'],
      ['/repo/.claude/Worktrees/x/src/a.js', 'case variant of worktrees'],
      // Windows drops trailing dots and spaces from a name.
      ['C:\\repo\\.claude\\worktrees\\x\\.claude.\\settings.local.json', 'trailing dot inside a worktree'],
      ['C:\\repo\\.claude\\worktrees\\x\\.claude \\settings.local.json', 'trailing space inside a worktree'],
      ['C:\\repo\\.claude\\worktrees\\x\\.claude...\\settings.local.json', 'trailing dots inside a worktree'],
      ['C:\\repo\\.claude.\\rules\\x.md', 'trailing dot on the .claude directory'],
      ['C:\\repo\\.claude\\worktrees.\\x\\src\\a.js', 'trailing dot on worktrees'],
      // Odd shapes around the marker.
      ['/repo/.claude/worktrees/.claude/settings.json', 'the worktree "name" is itself .claude'],
      ['/repo/.claude/worktrees/x/.claude/worktrees/y/.claude/settings.json', 'settings below two worktrees'],
      ['/repo/.claude/rules/.claude/settings.json', 'a second .claude below a prose directory'],
      ['/repo/.claude/rules/.claude/x.md', 'the same, with a name that is not a config name'],
      ['/repo/.claude/skills/s/.CLAUDE/y.md', 'the same, other case'],
    ];

    /** Inputs no exemption can be derived from: [input, why]. */
    const UNPARSEABLE = [
      ['/repo/.claude/rules/x.md\u0000', 'NUL byte'],
      ['/repo/.claude/rules/x\n.md', 'newline'],
      ['/repo/.claude/rules/x\t.md', 'tab'],
      ['/repo/.claude/rules/x\u007f.md', 'DEL'],
      ['\\\\?\\C:\\repo\\.claude\\worktrees\\x\\src\\a.js', 'extended-length prefix'],
      ['\\\\.\\C:\\repo\\.claude\\rules\\x.md', 'device prefix'],
      ['//?/C:/repo/.claude/rules/x.md', 'forward-slash spelling of the extended prefix'],
      ['\\\\server\\share\\repo\\.claude\\rules\\x.md', 'UNC: cannot be verified without network I/O'],
      ['C:\\repo\\.claude\\rules\\x.md:stream', 'alternate data stream'],
      ['C:\\repo\\.claude\\rules\\x.md::$DATA', 'alternate data stream, default'],
      ['C:\\repo\\.claude:$INDEX_ALLOCATION\\rules\\x.md', 'directory stream spelling'],
      ['../.claude/rules/x.md', 'relative path that climbs out'],
      ['../../CLAUDE.md', 'a context file name does not rescue an unresolvable path'],
      ['/../.claude/rules/x.md', 'climbs above the root'],
      ['/repo/.claude/worktrees/x/.../a.js', 'a name of only dots'],
      ['/repo/.claude/worktrees/x/. /a.js', 'a dot and a space: Windows trims it to nothing'],
      ['/repo/.claude/worktrees/x/.. /a.js', 'two dots and a space: Windows trims it to nothing'],
      [`/${DRIVE}/repo/.claude/rules/x.md`, 'URL-style drive: a colon in a name'],
    ];

    /**
     * Not absolute on ANY host, so there is nothing to grant and no cwd-independent
     * place to resolve a landing against: no exemption. The host's Write/Edit take
     * an absolute file_path, and every Write/Edit block record in this repo's
     * central ledger (47 of 47, measured 2026-09-29) is an absolute drive path. A
     * relative one would have to be resolved against a working directory this
     * function cannot vouch for; the drive-relative form (`C:foo`) depends on a
     * per-drive current directory besides.
     */
    const NOT_ABSOLUTE = [
      ['CLAUDE.md', 'a bare context-file name'],
      ['./CLAUDE.md', 'a dotted context-file name'],
      ['.claude/rules/x.md', 'relative rules path'],
      ['src/a.js', 'an ordinary relative path'],
      ['.claude/worktrees/wt/jPC/settings.local.json', 'relative, through a worktree marker (a junction inside it can lead anywhere)'],
      ['.claude\\worktrees\\wt\\jPC\\settings.local.json', 'the same with backslashes'],
      [`${DRIVE}.claude\\worktrees\\wt\\jPC\\settings.local.json`, 'drive-relative: the current directory of a drive, not a fixed place'],
      [`${DRIVE}CLAUDE.md`, 'drive-relative context file'],
      ['../repo/.claude/rules/x.md', 'relative, climbing out first'],
      ['~/.claude/rules/x.md', 'home shorthand, which the host does not expand'],
    ];

    // A path spelled the Windows way (a drive letter or a backslash) is absolute
    // only on a Windows host. On POSIX it is a relative filename, and gets no
    // exemption; the rows that say so run on both kinds of host below.
    const windowsSpelled = (p) => typeof p === 'string' && (p.includes('\\') || /^[A-Za-z]:/.test(p));
    const onThisHost = (rows) => rows.filter(([p]) => process.platform === 'win32' || !windowsSpelled(p));

    let isWhitelisted;
    beforeEach(async () => {
      // A filesystem with no links, no aliases and nothing missing: every path is
      // its own landing place. The verdicts below then depend on the STRING alone,
      // not on which directories this machine happens to have, and a lexical rule
      // cannot be propped up by the filesystem check that runs after it. (Measured:
      // with the real filesystem here, dropping the ".." resolution or the NUL
      // check changed nothing, because realpath refused those paths anyway.)
      // Real-filesystem behaviour has its own describe further down.
      realpathSync.native.mockImplementation((p) => p);
      ({ isWhitelisted } = await import('../../scripts/hooks/pre-write-guard.js'));
    });
    afterEach(() => {
      realpathSync.native.mockReset();
    });

    it.each(onThisHost(EXEMPT))('exempts %j (%s)', (p) => {
      expect(isWhitelisted(p)).toBe(true);
    });

    it.each(onThisHost(NOT_EXEMPT))('does not exempt %j (%s)', (p) => {
      expect(isWhitelisted(p)).toBe(false);
    });

    it.each(onThisHost(UNPARSEABLE))('fails closed on %j (%s)', (p) => {
      expect(isWhitelisted(p)).toBe(false);
    });

    it.each(NOT_ABSOLUTE)('grants no exemption to the non-absolute %j (%s)', (p) => {
      expect(isWhitelisted(p)).toBe(false);
    });

    it('resolves a non-absolute path against nothing: no filesystem lookup for any of them', () => {
      realpathSync.native.mockClear();
      lstatSync.mockClear();
      for (const [p] of NOT_ABSOLUTE) isWhitelisted(p);
      expect(realpathSync.native).not.toHaveBeenCalled();
      expect(lstatSync).not.toHaveBeenCalled();
    });

    it('the non-absolute table is not vacuous: the old rule exempted most of it', () => {
      expect(NOT_ABSOLUTE.filter(([p]) => legacyIsWhitelisted(p)).length).toBeGreaterThanOrEqual(6);
    });

    it('a Windows-spelled path is exempt only on a host that can resolve it', () => {
      const windowsRows = EXEMPT.filter(([p]) => windowsSpelled(p));
      expect(windowsRows.length).toBeGreaterThan(5);
      for (const [p] of windowsRows) {
        expect(isWhitelisted(p), p).toBe(process.platform === 'win32');
      }
    });

    // One-element rows: it.each would otherwise spread the array value into arguments.
    it.each([[''], [undefined], [null], [0], [123], [true], [{}], [['/repo/.claude/rules/x.md']], [() => '/repo/CLAUDE.md']])(
      'fails closed on the non-path value %j',
      (value) => {
        expect(isWhitelisted(value)).toBe(false);
      },
    );

    it('NEVER exempts anything the old rule did not (the allowlist only narrows)', () => {
      const everything = [...EXEMPT, ...NOT_EXEMPT, ...UNPARSEABLE, ...NOT_ABSOLUTE].map(([p]) => p);
      const widened = everything.filter((p) => isWhitelisted(p) && !legacyIsWhitelisted(p));
      expect(widened).toEqual([]);
    });

    it('really removes exemptions the old rule granted (the table is not vacuous)', () => {
      const removed = NOT_EXEMPT.filter(([p]) => legacyIsWhitelisted(p));
      // Every kind of removal listed above was an exemption before this change.
      expect(removed.length).toBeGreaterThan(30);
      expect(legacyIsWhitelisted('/repo/.claude/settings.local.json')).toBe(true);
      expect(legacyIsWhitelisted('/repo/not.claude/settings.json')).toBe(true);
      expect(legacyIsWhitelisted('/repo/.claude/worktrees/x/.claude/settings.local.json')).toBe(true);
    });

    it('stays exempt for EVERY ordinary path inside a split worktree, exactly like the old rule', () => {
      const prefixes = [
        '/repo',
        '/home/u/projects/Artibot',
        `${DRIVE}/Users/me/Desktop/AI/Artibot`,
        `${drive}/users/me/repo`,
        `${DRIVE}/Users/HEECHA~1/Desktop/Artibot`,
        `${DRIVE}/work/a b/Artibot`,
      ];
      const names = ['x', 'agent-aea30c7a065bd19ab', 'ca04-c3-whitelist', 'w.1', 'name with space', 'Ünï-名'];
      const files = [
        'src/a.js', 'plugins/artibot/lib/security/human-gates.js', 'plugins/artibot/hooks/hooks.json',
        'plugins/artibot/artibot.config.json', 'docs/x y.md', 'a/b/c/d/e/f.mjs',
        'plugins/artibot/node_modules/pkg/index.js', '.gitignore', '.github/workflows/ci.yml',
        'tests/x.test.js', 'docs/한글 문서.md', 'CLAUDE.md', '.artibot/project.md',
      ];
      const everySpelling = [];
      for (const prefix of prefixes) {
        for (const name of names) {
          for (const file of files) {
            const p = `${prefix}/.claude/worktrees/${name}/${file}`;
            everySpelling.push(p, toBackslashes(p));
          }
        }
      }
      // A Windows spelling (drive letter or backslash) is absolute only on a Windows
      // host; there the whole corpus applies, elsewhere the two POSIX prefixes do.
      const windowsHost = process.platform === 'win32';
      const corpus = everySpelling.filter((p) => windowsHost || !windowsSpelled(p));
      // Non-vacuity: the corpus is large, and the OLD rule exempted all of it.
      expect(everySpelling.length).toBe(6 * 6 * 13 * 2);
      expect(corpus.length).toBe(windowsHost ? 6 * 6 * 13 * 2 : 2 * 6 * 13);
      expect(corpus.filter((p) => !legacyIsWhitelisted(p))).toEqual([]);
      expect(corpus.filter((p) => !isWhitelisted(p))).toEqual([]);
    });

    it('never exempts what the gate core protects (one path definition, two consumers)', () => {
      const prefixes = [
        '/home/u/', `${DRIVE}\\Users\\u\\`, '/repo/', '/repo/.claude/worktrees/w/',
        `${DRIVE}\\r\\.claude\\worktrees\\w\\`, '/repo/plugins/artibot/', 'plugins/artibot/',
      ];
      const areas = [
        '', 'src/', '.claude/', '.claude/rules/', '.claude/agents/', '.claude/commands/',
        '.claude/skills/x/', '.claude/projects/s/memory/', '.claude/worktrees/w2/',
        '.claude/worktrees/w2/.claude/', 'plugins/artibot/.claude/', '.CLAUDE/', '.claude./',
      ];
      const names = [...PROTECTED_CONFIG_BASENAMES, 'settings.JSON', 'Hooks.json', 'a.md', 'a.js', 'CLAUDE.md'];
      let exempt = 0;
      let protectedByGate = 0;
      let generated = 0;
      const disagreements = [];
      const widened = [];
      for (const prefix of prefixes) {
        for (const area of areas) {
          for (const name of names) {
            const p = `${prefix}${area}${name}`;
            const gate = isClaudeConfigPath(p);
            const skip = isWhitelisted(p);
            generated += 1;
            if (gate) protectedByGate += 1;
            if (skip) exempt += 1;
            if (gate && skip) disagreements.push(p);
            // The allowlist only narrows: nothing here is exempt that the old rule refused.
            if (skip && !legacyIsWhitelisted(p)) widened.push(p);
          }
        }
      }
      expect(generated).toBe(prefixes.length * areas.length * names.length);
      expect(widened).toEqual([]);
      expect(disagreements).toEqual([]);
      // Both sides of the implication were actually exercised.
      expect(exempt).toBeGreaterThan(50);
      expect(protectedByGate).toBeGreaterThan(50);
    });

    it('refuses a path longer than any real filesystem takes, without scanning it or touching the disk', () => {
      const tooLong = `/repo/.claude/worktrees/x/${'a/'.repeat(3000)}f.js`;
      expect(tooLong.length).toBeGreaterThan(4096);
      // The old rule exempted it. Refusing is the safe direction for a cap:
      // it can only remove an exemption, never grant one.
      expect(legacyIsWhitelisted(tooLong)).toBe(true);
      realpathSync.native.mockClear();
      expect(isWhitelisted(tooLong)).toBe(false);
      expect(isWhitelisted('/'.repeat(300_000))).toBe(false);
      expect(isWhitelisted(`/repo/.claude/rules/${'a/'.repeat(300_000)}x.md`)).toBe(false);
      // "Refused before the filesystem" is what the cap is FOR: without it these
      // would still come out false, but only after up to 65 failed lookups.
      expect(realpathSync.native).not.toHaveBeenCalled();
    });

    it('never throws: an unexpected failure means not exempt, and says so on stderr', () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      // The one lookup answers with something that is not a path at all, which
      // makes the landing check throw from inside (not from a caught fs error).
      realpathSync.native.mockImplementationOnce(() => 42);
      try {
        expect(isWhitelisted('/repo/.claude/rules/x.md')).toBe(false);
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(stderr.mock.calls[0][0]).toContain('exemption check failed');
      } finally {
        stderr.mockRestore();
      }
      // Control: with the odd answer spent, the same path is exempt again.
      expect(isWhitelisted('/repo/.claude/rules/x.md')).toBe(true);
    });

    it('stays linear on degenerate shapes just under the cap', () => {
      const shapes = [
        '/'.repeat(4000),
        '/.claude'.repeat(500),
        `/repo/${'.claude/worktrees/a/'.repeat(190)}src/a.js`,
        `/repo/.claude/rules/${'a/'.repeat(1900)}x.md`,
        '..'.padEnd(4000, '/..'),
        `/repo/.claude/${'. '.repeat(1900)}/x`,
        `/repo/${'.'.repeat(4000)}`,
      ];
      for (const p of shapes) {
        expect(p.length).toBeLessThanOrEqual(4096);
        expect(typeof isWhitelisted(p), p.slice(0, 40)).toBe('boolean');
      }
    });

    it('describes the narrowed exemption in the HG-12 matrix note instead of an unconditional approval', () => {
      const note = getGateRow('HG-12').enforcementNote;
      expect(note).not.toContain('무조건 승인');
      expect(note).toContain('isWhitelisted');
      expect(note).toContain('WBR');
      // The scope clause has to match shouldEnforceGuard's Tier 2, which also
      // takes any path containing `plugins/artibot/` (not only cwd / plugin root).
      expect(note).toContain('plugins/artibot/');
    });
  });

  // -------------------------------------------------------------------------
  // The same decisions, taken through main() with the host mocked.
  //
  // `CLAUDE_PLUGIN_ROOT=/workspace` puts every /workspace path in scope of the
  // guard (Tier 2), and an existing file with an EMPTY tracking file is the
  // situation the guard exists for. Approve therefore means "exempt" and block
  // means "not exempt" — the control row shows the setup is live.
  // -------------------------------------------------------------------------
  describe('exemption decisions through main() (CA-04 L4)', () => {
    const ENV_KEYS = ['CLAUDE_PLUGIN_ROOT', 'ARTIBOT_WRITE_GUARD_MODE'];
    let savedEnv;
    beforeEach(() => {
      savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
      process.env.CLAUDE_PLUGIN_ROOT = '/workspace';
      process.env.ARTIBOT_WRITE_GUARD_MODE = 'block';
      existsSync.mockImplementation(() => true);
      readFileSync.mockReturnValue('[]');
      // /workspace does not exist: let every path be its own landing place (the
      // real-filesystem cases are in the describe below).
      realpathSync.native.mockImplementation((p) => p);
    });
    afterEach(() => {
      realpathSync.native.mockReset();
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    /** Every value the hook wrote to stdout for one payload. */
    async function stdoutFor(filePath, toolName = 'Write') {
      readStdin.mockResolvedValue(makePreWriteData(filePath, toolName, 'ca04-l4'));
      await runHook();
      return writeStdout.mock.calls.map(([arg]) => arg);
    }

    it.each([
      '/workspace/.claude/worktrees/limb/plugins/artibot/lib/a.js',
      '/workspace/.claude/worktrees/limb/src/a.js',
      '/workspace/.claude/rules/x.md',
      '/workspace/CLAUDE.md',
      '/workspace/.claude/projects/slug/memory/MEMORY.md',
    ])('passes an existing, unread %s through with no stdout at all', async (filePath) => {
      expect(await stdoutFor(filePath)).toEqual([]);
      expect(writeStdout).not.toHaveBeenCalled();
    });

    it.each([
      ['/workspace/.claude/settings.local.json', 'Write'],
      ['/workspace/.claude/settings.json', 'Edit'],
      ['/workspace/.claude/worktrees/limb/.claude/settings.local.json', 'Write'],
      ['/workspace/plugins/artibot/.claude/hooks.json', 'Edit'],
      // CONTROL: an ordinary file outside any exemption. If this stopped
      // blocking, every approve above would be meaningless.
      ['/workspace/plugins/artibot/lib/core/config.js', 'Write'],
    ])('blocks an existing, unread %s (%s) with the guard reason', async (filePath, toolName) => {
      const out = await stdoutFor(filePath, toolName);
      expect(out).toHaveLength(1);
      expect(Object.keys(out[0])).toEqual(['decision', 'reason']);
      expect(out[0].decision).toBe('block');
      expect(out[0].reason).toContain('[WRITE-BEFORE-READ]');
      expect(out[0].reason).toContain(`${toolName} blocked for "${filePath}"`);
      expect(out[0].reason).toContain(`retry the same ${toolName}`);
    });

    it('lets the retry of a blocked settings edit through (loop guard is untouched)', async () => {
      const filePath = '/workspace/.claude/settings.local.json';
      const first = await stdoutFor(filePath);
      expect(first[0].decision).toBe('block');
      const fingerprint = Object.values(writtenFiles).find((data) => /^[0-9a-f]{16}\n$/.test(data));
      expect(fingerprint).toBeDefined();
      readFileSync.mockImplementation((file) => (
        String(file).includes('last-pre-write-block.txt') ? fingerprint : '[]'
      ));
      writeStdout.mockClear();
      expect(await stdoutFor(filePath)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The filesystem half: junctions, dangling links, aliases.
  //
  // The lexical rules cannot see through a junction (worktree-setup.mjs makes
  // one for node_modules; a junction can equally point INTO .claude). So a
  // lexical grant is re-checked against the resolved path, and the only thing
  // that revokes it is a resolved target inside a `.claude` area that is not on
  // the allowlist. `realpathSync.native` and `lstatSync` are pass-through spies
  // here; everything else in this block is the real filesystem.
  // -------------------------------------------------------------------------
  describe('isWhitelisted against a real filesystem (CA-04 L4)', () => {
    let isWhitelisted;
    let box;
    let wt;
    let shared;
    const fsError = (code) => Object.assign(new Error(`${code}: injected`), { code });

    beforeEach(async () => {
      const realOs = await vi.importActual('node:os');
      box = mkdtempSync(path.join(realOs.tmpdir(), 'artibot-wbr-fs-'));
      wt = path.join(box, 'repo', '.claude', 'worktrees', 'x');
      shared = path.join(box, 'shared');
      mkdirSync(path.join(wt, 'src'), { recursive: true });
      mkdirSync(path.join(shared, '.claude'), { recursive: true });
      writeFileSync(path.join(shared, '.claude', 'settings.local.json'), '{}\n');
      ({ isWhitelisted } = await import('../../scripts/hooks/pre-write-guard.js'));
    });
    afterEach(() => {
      // mockReset() puts the pass-through implementation back AND drops any
      // unconsumed mockImplementationOnce, so a case that stops reaching the
      // call it armed cannot leak its failure into the next case.
      realpathSync.native.mockReset();
      lstatSync.mockReset();
      // Retries: a scanner or indexer can hold a freshly written file for a moment
      // on Windows, and a cleanup failure must not read as a test failure.
      rmSync(box, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    it('control: an ordinary worktree path is exempt, existing or not', () => {
      writeFileSync(path.join(wt, 'src', 'a.js'), '//\n');
      expect(isWhitelisted(path.join(wt, 'src', 'a.js'))).toBe(true);
      expect(isWhitelisted(path.join(wt, 'src', 'not', 'yet', 'here.js'))).toBe(true);
    });

    it('revokes the exemption when a junction inside the worktree leads into .claude config', () => {
      const link = path.join(wt, 'lnk');
      symlinkSync(path.join(shared, '.claude'), link, 'junction');
      // Lexically this is indistinguishable from src/a.js — the old rule exempted it.
      expect(isWhitelisted(path.join(wt, 'src', 'a.js'))).toBe(true);
      expect(isWhitelisted(path.join(link, 'settings.local.json'))).toBe(false);
      // Creating a new file through the junction lands in .claude too.
      expect(isWhitelisted(path.join(link, 'brand-new.json'))).toBe(false);
    });

    it('keeps the exemption for a junction that leaves the worktree without entering .claude', () => {
      // The worktree-setup.mjs shape: <wt>/plugins/artibot/node_modules -> shared node_modules.
      mkdirSync(path.join(shared, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(path.join(shared, 'node_modules', 'pkg', 'index.js'), '//\n');
      mkdirSync(path.join(wt, 'plugins', 'artibot'), { recursive: true });
      symlinkSync(
        path.join(shared, 'node_modules'),
        path.join(wt, 'plugins', 'artibot', 'node_modules'),
        'junction',
      );
      const viaJunction = path.join(wt, 'plugins', 'artibot', 'node_modules', 'pkg', 'index.js');
      expect(isWhitelisted(viaJunction)).toBe(true);
      expect(isWhitelisted(path.join(path.dirname(viaJunction), 'new-file.js'))).toBe(true);
    });

    it('does not exempt through a dangling junction: the target cannot be verified', () => {
      symlinkSync(path.join(box, 'nowhere', '.claude'), path.join(wt, 'dangling'), 'junction');
      expect(isWhitelisted(path.join(wt, 'dangling', 'x.json'))).toBe(false);
    });

    it('resolves the nearest existing ancestor of a path that does not exist yet', () => {
      const target = path.join(wt, 'src', 'deep', 'er', 'new.js');
      realpathSync.native.mockClear();
      expect(isWhitelisted(target)).toBe(true);
      // The original spelling is asked first, then one parent at a time until
      // `wt/src` (the first directory that exists) answers.
      expect(realpathSync.native.mock.calls.map(([p]) => p)).toEqual([
        target,
        path.dirname(target),
        path.dirname(path.dirname(target)),
        path.join(wt, 'src'),
      ]);
    });

    it('gives up, not exempt, when too many trailing components are missing', () => {
      const missing = (levels) => path.join(wt, 'src', ...Array(levels).fill('d'), 'f.js');
      expect(isWhitelisted(missing(10))).toBe(true);
      // 70 missing directories is not a file anyone is about to create. The cost
      // of finding out is bounded, and the answer for "cannot verify" is no.
      expect(isWhitelisted(missing(70))).toBe(false);
    });

    it('fails closed when the filesystem answers with anything but "not there"', () => {
      const target = path.join(wt, 'src', 'a.js');
      for (const code of ['EACCES', 'EPERM', 'ELOOP', 'EIO', 'ENAMETOOLONG']) {
        realpathSync.native.mockImplementationOnce(() => { throw fsError(code); });
        expect(isWhitelisted(target), code).toBe(false);
      }
      // A throw that is not even an Error object.
      realpathSync.native.mockImplementationOnce(() => { throw 'boom'; });
      expect(isWhitelisted(target)).toBe(false);
      // Control: the same call succeeds once the injected failures are spent.
      expect(isWhitelisted(target)).toBe(true);
    });

    it('treats "missing, but lstat finds an entry" as a dangling link, and an lstat failure as unverifiable', () => {
      const target = path.join(wt, 'src', 'a.js');
      realpathSync.native.mockImplementationOnce(() => { throw fsError('ENOENT'); });
      lstatSync.mockImplementationOnce(() => ({ isSymbolicLink: () => true }));
      expect(isWhitelisted(target)).toBe(false);

      realpathSync.native.mockImplementationOnce(() => { throw fsError('ENOENT'); });
      lstatSync.mockImplementationOnce(() => { throw fsError('EACCES'); });
      expect(isWhitelisted(target)).toBe(false);

      // ENOTDIR from lstat means the parent is a file: not a link, keep walking up.
      realpathSync.native.mockImplementationOnce(() => { throw fsError('ENOENT'); });
      lstatSync.mockImplementationOnce(() => { throw fsError('ENOTDIR'); });
      expect(isWhitelisted(target)).toBe(true);
    });

    it('does not exempt when where the write would land cannot be parsed (a network target)', () => {
      const target = path.join(wt, 'src', 'a.js');
      realpathSync.native.mockImplementationOnce(() => '\\\\server\\share\\repo\\x.md');
      expect(isWhitelisted(target)).toBe(false);
      // Control: the same path with an ordinary answer.
      expect(isWhitelisted(target)).toBe(true);
    });

    it('does not consult the filesystem for a path the lexical rules already refuse', () => {
      // Identity, not the real call: if a regression let the UNC path through, the
      // real lookup would go out to the network. The spy still records the attempt.
      realpathSync.native.mockClear();
      realpathSync.native.mockImplementation((p) => p);
      lstatSync.mockClear();
      expect(isWhitelisted(path.join(box, 'repo', '.claude', 'settings.local.json'))).toBe(false);
      expect(isWhitelisted('\\\\server\\share\\repo\\.claude\\rules\\x.md')).toBe(false);
      expect(realpathSync.native).not.toHaveBeenCalled();
      expect(lstatSync).not.toHaveBeenCalled();
    });

    it('grants a non-absolute path no exemption, and does not resolve it against the hook cwd', () => {
      realpathSync.native.mockClear();
      expect(isWhitelisted('.claude/rules/x.md')).toBe(false);
      expect(isWhitelisted('CLAUDE.md')).toBe(false);
      expect(realpathSync.native).not.toHaveBeenCalled();
    });

    it('review m1: a relative and a drive-relative spelling of a junction into .claude config are not exempt either', () => {
      const link = path.join(wt, 'jPC');
      symlinkSync(path.join(shared, '.claude'), link, 'junction');
      const repo = path.join(box, 'repo');
      const relative = path.join('.claude', 'worktrees', 'x', 'jPC', 'settings.local.json');
      const before = process.cwd();
      process.chdir(repo);
      try {
        // The repro is real: from this cwd the relative spelling lands in the config file.
        expect(realpathSync.native(relative))
          .toBe(realpathSync.native(path.join(shared, '.claude', 'settings.local.json')));
        // One file, three spellings, one answer.
        expect(isWhitelisted(path.join(link, 'settings.local.json'))).toBe(false);
        expect(isWhitelisted(relative)).toBe(false);
        if (process.platform === 'win32') {
          expect(isWhitelisted(`${path.parse(repo).root.slice(0, 2)}${relative}`)).toBe(false);
        }
      } finally {
        process.chdir(before);
      }
    });

    // A junction that leaves the worktree WITHOUT entering `.claude` keeps the old
    // exemption (the node_modules case above). Except when it lands on a name the
    // allowlist protects: a junction to the project root puts the real .mcp.json,
    // artibot.config.json or hooks.json under a path that looks like worktree source.
    describe('review m2: a junction out of the worktree that lands on a protected name', () => {
      const PROTECTED = [...PROTECTED_CONFIG_BASENAMES, '.mcp.json'];
      let jump;

      beforeEach(() => {
        const projectRoot = path.join(box, 'project');
        mkdirSync(path.join(projectRoot, 'plugins', 'artibot', 'hooks'), { recursive: true });
        mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
        writeFileSync(path.join(projectRoot, 'src', 'a.js'), '//\n');
        writeFileSync(path.join(projectRoot, 'plugins', 'artibot', 'hooks', 'hooks.json'), '{}\n');
        for (const name of PROTECTED) writeFileSync(path.join(projectRoot, name), '{}\n');
        jump = path.join(wt, 'jP');
        symlinkSync(projectRoot, jump, 'junction');
      });

      it.each(PROTECTED)('does not exempt %s behind a junction to the project root', (name) => {
        expect(isWhitelisted(path.join(jump, name))).toBe(false);
        // Created through the junction later: the landing name is the same.
        expect(isWhitelisted(path.join(jump, 'made', 'later', name))).toBe(false);
      });

      it('does not exempt plugins/artibot/hooks/hooks.json behind the junction', () => {
        expect(isWhitelisted(path.join(jump, 'plugins', 'artibot', 'hooks', 'hooks.json'))).toBe(false);
      });

      it('control: an ordinary file behind the same junction keeps the exemption', () => {
        expect(isWhitelisted(path.join(jump, 'src', 'a.js'))).toBe(true);
        expect(isWhitelisted(path.join(jump, 'src', 'not', 'yet.js'))).toBe(true);
      });

      it("control: a worktree's OWN copy of the same names is source and stays exempt", () => {
        mkdirSync(path.join(wt, 'plugins', 'artibot', 'hooks'), { recursive: true });
        writeFileSync(path.join(wt, 'plugins', 'artibot', 'hooks', 'hooks.json'), '{}\n');
        for (const name of PROTECTED) {
          writeFileSync(path.join(wt, name), '{}\n');
          expect(isWhitelisted(path.join(wt, name)), name).toBe(true);
        }
        expect(isWhitelisted(path.join(wt, 'plugins', 'artibot', 'hooks', 'hooks.json'))).toBe(true);
      });

      it('a landing with no name at all (the root) is not exempt', () => {
        realpathSync.native.mockImplementationOnce(() => path.parse(wt).root);
        expect(isWhitelisted(path.join(wt, 'src', 'a.js'))).toBe(false);
      });
    });

    describe.runIf(process.platform === 'win32')('Windows aliases (NTFS is case-insensitive; 8.3 names)', () => {
      it('does not exempt a case-aliased .claude directory inside the worktree', () => {
        mkdirSync(path.join(wt, '.claude', 'rules'), { recursive: true });
        writeFileSync(path.join(wt, '.claude', 'settings.local.json'), '{}\n');
        // The same directory as far as NTFS is concerned:
        expect(isWhitelisted(path.join(wt, '.CLAUDE', 'settings.local.json'))).toBe(false);
        // ...and refusing the alias is deliberate even for a prose directory:
        expect(isWhitelisted(path.join(wt, '.CLAUDE', 'rules', 'r.md'))).toBe(false);
        // Control: the canonical spelling of the prose directory is exempt.
        expect(isWhitelisted(path.join(wt, '.claude', 'rules', 'r.md'))).toBe(true);
        expect(isWhitelisted(path.join(wt, '.claude', 'settings.local.json'))).toBe(false);
      });

      it('does not exempt an 8.3 short-name alias of the .claude directory', async (ctx) => {
        const { execSync } = await vi.importActual('node:child_process');
        mkdirSync(path.join(wt, '.claude'), { recursive: true });
        writeFileSync(path.join(wt, '.claude', 'settings.local.json'), '{}\n');
        // `%~snxI` is the SHORT name of the last component only (cmd.exe expands it).
        const shortName = execSync(
          `for %I in ("${path.join(wt, '.claude')}") do @echo %~snxI`,
          { encoding: 'utf-8', windowsHide: true, shell: 'cmd.exe' },
        ).trim();
        if (shortName === '' || shortName.toLowerCase() === '.claude') {
          ctx.skip('8.3 short names are disabled on this volume, so the alias does not exist');
          return;
        }
        expect(shortName).toMatch(/~\d/);
        expect(isWhitelisted(path.join(wt, shortName, 'settings.local.json'))).toBe(false);
        expect(isWhitelisted(path.join(wt, shortName, 'brand-new.json'))).toBe(false);
      });
    });
  });
});
