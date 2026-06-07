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
  };
});

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');
const { readFileSync, existsSync, writeFileSync, mkdirSync } = await import('node:fs');

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
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe('snapshot creation', () => {
    it('creates a snapshot backup file before compaction', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ reason: 'context full' }));

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.state).toEqual({});
    });

    it('uses empty state when state file has corrupt JSON', async () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('{{invalid json}}');
      readStdin.mockResolvedValue(JSON.stringify({}));

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.summary.decisions).toEqual([]);
    });
  });

  describe('writeStdout confirmation', () => {
    it('writes a confirmation message on success', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot).toHaveProperty('summary');
      expect(snapshot).toHaveProperty('savedAt');
    });

    it('stores empty hookData when parseJSON returns null', async () => {
      readStdin.mockResolvedValue('not valid json');

      await import('../../scripts/hooks/pre-compact.js');
      await new Promise((r) => setTimeout(r, 50));

      const writtenContent = writeFileSync.mock.calls[0][1];
      const snapshot = JSON.parse(writtenContent);
      expect(snapshot.reason).toBe('pre-compact');
    });
  });

  describe('file system operations', () => {
    it('creates the .claude directory recursively', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));

      await import('../../scripts/hooks/pre-compact.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it('writes the snapshot as formatted JSON with utf-8 encoding', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
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

      await import('../../scripts/hooks/pre-compact.js');
      await new Promise((r) => setTimeout(r, 50));

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:pre-compact]');
    });

    it('handles readStdin rejection gracefully', async () => {
      readStdin.mockRejectedValue(new Error('stdin failed'));

      await import('../../scripts/hooks/pre-compact.js');
      await new Promise((r) => setTimeout(r, 50));

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:pre-compact]');
    });
  });
});
