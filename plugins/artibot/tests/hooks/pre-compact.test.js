import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    // PR-CX02: the hook now stats `transcript_path`. Default = absent, so the
    // pre-existing cases below keep the exact behaviour they pinned.
    statSync: vi.fn(() => { throw new Error('ENOENT'); }),
  };
});

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');
const { createErrorHandler } = await import('../../lib/core/hook-utils.js');
const { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } = await import('node:fs');

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/pre-compact.js');
  // The `.catch` mirrors the module's direct-run tail so the error-handling
  // test still reaches the real handler. Keep in sync with pre-compact.js.
  await mod.main().catch(createErrorHandler('pre-compact'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('pre-compact hook', () => {
  let stderrSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    existsSync.mockReturnValue(false);
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    writeFileSync.mockImplementation(() => {});
    mkdirSync.mockImplementation(() => {});
    statSync.mockImplementation(() => { throw new Error('ENOENT'); });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe('snapshot creation', () => {
    it('creates a snapshot backup file before compaction', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ reason: 'context full' }));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.claude'),
        { recursive: true },
      );
      expect(writeFileSync).toHaveBeenCalledTimes(1);
      const writePath = writeFileSync.mock.calls[0][0];
      expect(writePath).toContain('artibot-pre-compact.json');
    });

    it('snapshot contains savedAt, reason, state, and hookData', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ context_size: 95000 }));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot).toHaveProperty('savedAt');
      expect(snapshot.reason).toBe('pre-compact');
      expect(snapshot).toHaveProperty('state');
      expect(snapshot).toHaveProperty('summary');
      expect(snapshot).toHaveProperty('tokenEstimate');
    });

    it('includes current state in snapshot when state file exists', async () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({
        agents: { 'builder-01': { active: true } },
        tasks: ['task1'],
      }));
      readStdin.mockResolvedValue(JSON.stringify({}));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.state.agents).toBeDefined();
      expect(snapshot.state.agents['builder-01'].active).toBe(true);
      expect(snapshot.state.tasks).toEqual(['task1']);
    });

    it('uses empty state when state file does not exist', async () => {
      existsSync.mockReturnValue(false);
      readStdin.mockResolvedValue(JSON.stringify({}));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.state).toEqual({});
    });

    it('uses empty state when state file has corrupt JSON', async () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('{{invalid json}}');
      readStdin.mockResolvedValue(JSON.stringify({}));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.state).toEqual({});
    });
  });

  describe('decision context extraction', () => {
    it('captures decision keywords from assistant messages', async () => {
      readStdin.mockResolvedValue(JSON.stringify({
        messages: [
          { role: 'assistant', content: 'I decided to use TypeScript for this module.' },
          { role: 'assistant', content: 'We chose ESM over CommonJS for consistency.' },
          { role: 'user', content: 'Sounds good' },
        ],
      }));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.summary.decisions).toBeDefined();
      expect(snapshot.summary.decisions.length).toBe(2);
      expect(snapshot.summary.decisions[0]).toContain('decided');
      expect(snapshot.summary.decisions[1]).toContain('chose');
    });

    it('returns empty array when no decision keywords found', async () => {
      readStdin.mockResolvedValue(JSON.stringify({
        messages: [
          { role: 'assistant', content: 'Here is the code you requested.' },
          { role: 'user', content: 'Thanks' },
        ],
      }));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.summary.decisions).toEqual([]);
    });

    it('ignores decision keywords in user messages', async () => {
      readStdin.mockResolvedValue(JSON.stringify({
        messages: [
          { role: 'user', content: 'I decided to use Python instead.' },
          { role: 'assistant', content: 'OK, switching to Python.' },
        ],
      }));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.summary.decisions).toEqual([]);
    });
  });

  describe('writeStdout confirmation', () => {
    it('writes a confirmation message on success', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      const msg = output.systemMessage || output.message || '';
      expect(msg).toContain('[compact]');
    });
  });

  describe('hookData handling', () => {
    it('stores hookData from stdin in the snapshot', async () => {
      readStdin.mockResolvedValue(JSON.stringify({
        session_id: 'abc-123',
        compaction_reason: 'context limit reached',
      }));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot).toHaveProperty('summary');
      expect(snapshot).toHaveProperty('savedAt');
    });

    it('stores empty hookData when parseJSON returns null', async () => {
      readStdin.mockResolvedValue('not valid json');

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.reason).toBe('pre-compact');
    });
  });

  describe('file system operations', () => {
    it('creates the .claude directory recursively', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it('writes the snapshot as formatted JSON with utf-8 encoding', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const encoding = writeFileSync.mock.calls[0][2];
      expect(encoding).toBe('utf-8');
      // Verify it's formatted (indented)
      const content = writeFileSync.mock.calls[0][1];
      expect(content).toContain('\n');
    });
  });

  describe('error handling', () => {
    it('logs to stderr when writeFileSync fails', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));
      writeFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:pre-compact]');
      expect(stderrOutput).toContain('EACCES');
      // Should NOT crash (no process.exit)
      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('logs to stderr when mkdirSync fails', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));
      mkdirSync.mockImplementation(() => { throw new Error('EPERM'); });

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:pre-compact]');
    });

    it('handles readStdin rejection gracefully', async () => {
      readStdin.mockRejectedValue(new Error('stdin failed'));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:pre-compact]');
    });
  });

  // ── PR-CX02 ────────────────────────────────────────────────────────────────
  // The snapshot is the only thing PostCompact can read, so what it does and
  // does not carry is a contract. `writePreCompactState` never reaches its
  // own `writeFileSync` here (the mocked `scripts/utils/index.js` leaves
  // `getPluginRoot` undefined, so it throws into its own try/catch), which is
  // why call 0 is the snapshot for every case below.
  describe('pressure inputs carried in the snapshot', () => {
    /**
     * @returns {Promise<object>} the parsed snapshot JSON
     */
    async function snapshotAfter(hookData) {
      readStdin.mockResolvedValue(JSON.stringify(hookData));
      await runHook();
      await new Promise((r) => setTimeout(r, 50));
      return JSON.parse(writeFileSync.mock.calls[0][1]);
    }

    it('pins tokenEstimate at chars/4 + 1 for a known message fixture', async () => {
      const snap = await snapshotAfter({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] });
      expect(snap.tokenEstimate).toBe(1001);
    });

    it('reports tokenEstimate 1 when the payload carries no messages (the live case)', async () => {
      // Measured against the live snapshot `~/.claude/artibot-pre-compact.json`
      // (savedAt 2026-09-11T14:40:09Z): tokenEstimate 1, summary.scope all 0.
      // The host's PreCompact payload does NOT include the transcript, so this
      // number says nothing about context size — hence transcriptBytes below.
      const snap = await snapshotAfter({ session_id: 'sess-live' });
      expect(snap.tokenEstimate).toBe(1);
      expect(snap.summary.scope).toEqual({ user: 0, assistant: 0, tool: 0 });
    });

    it('records transcriptBytes from transcript_path when the file can be stat-ed', async () => {
      statSync.mockReturnValue({ size: 4_194_304 });
      const snap = await snapshotAfter({ transcript_path: '/tmp/sess.jsonl' });
      expect(statSync).toHaveBeenCalledWith('/tmp/sess.jsonl');
      expect(snap.transcriptBytes).toBe(4_194_304);
    });

    it('records transcriptBytes null when transcript_path is absent or not a string', async () => {
      statSync.mockReturnValue({ size: 10 });
      expect((await snapshotAfter({})).transcriptBytes).toBe(null);
      vi.clearAllMocks();
      statSync.mockReturnValue({ size: 10 });
      writeFileSync.mockImplementation(() => {});
      expect((await snapshotAfter({ transcript_path: 42 })).transcriptBytes).toBe(null);
    });

    it('records transcriptBytes null when statSync throws, and does not crash the hook', async () => {
      statSync.mockImplementation(() => { throw new Error('EACCES'); });
      const snap = await snapshotAfter({ transcript_path: '/tmp/locked.jsonl' });
      expect(snap.transcriptBytes).toBe(null);
      expect(snap.reason).toBe('pre-compact');
    });

    it('records context_window verbatim when it is an object, null otherwise', async () => {
      const withWindow = await snapshotAfter({ context_window: { current_tokens: 150_000, max_tokens: 200_000 } });
      expect(withWindow.contextWindow).toEqual({ current_tokens: 150_000, max_tokens: 200_000 });
      vi.clearAllMocks();
      writeFileSync.mockImplementation(() => {});
      statSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect((await snapshotAfter({ context_window: 'big' })).contextWindow).toBe(null);
      vi.clearAllMocks();
      writeFileSync.mockImplementation(() => {});
      statSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect((await snapshotAfter({})).contextWindow).toBe(null);
    });
  });
});
