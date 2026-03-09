import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHookData(files, key = 'changed_files') {
  return JSON.stringify({ [key]: files });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('clean-state-check hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('TaskCompleted with JS/TS file changes', () => {
    it('warns when .js files were changed', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/app.js']));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('Clean State check');
      expect(call.message).toContain('app.js');
      expect(call.message).toContain('npm run lint');
      expect(call.message).toContain('npm test');
      expect(call.result).toEqual({
        cleanState: false,
        lint: 'pending',
        tests: 'pending',
        codeFiles: ['/project/src/app.js'],
      });
    });

    it('warns when .ts files were changed', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/utils.ts']));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('utils.ts');
    });

    it('lists multiple changed code files', async () => {
      const files = ['/src/a.js', '/src/b.tsx', '/src/c.mjs'];
      readStdin.mockResolvedValue(makeHookData(files));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('a.js');
      expect(call.message).toContain('b.tsx');
      expect(call.message).toContain('c.mjs');
      expect(call.result.codeFiles).toHaveLength(3);
    });

    it.each([
      ['.js'], ['.jsx'], ['.ts'], ['.tsx'], ['.mjs'], ['.cjs'],
    ])('detects %s files as code', async (ext) => {
      readStdin.mockResolvedValue(makeHookData([`/project/file${ext}`]));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('Clean State check');
    });
  });

  describe('non-code file changes only', () => {
    it('skips when only .md files changed', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/README.md']));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('no JS/TS files changed');
    });

    it.each([
      ['.css'], ['.json'], ['.yml'], ['.md'], ['.png'],
    ])('skips %s files', async (ext) => {
      readStdin.mockResolvedValue(makeHookData([`/project/file${ext}`]));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('no JS/TS files changed');
    });
  });

  describe('mixed file changes', () => {
    it('only lists code files in the warning', async () => {
      const files = ['/src/app.js', '/docs/README.md', '/src/style.css'];
      readStdin.mockResolvedValue(makeHookData(files));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('app.js');
      expect(call.message).not.toContain('README.md');
      expect(call.message).not.toContain('style.css');
      expect(call.result.codeFiles).toEqual(['/src/app.js']);
    });
  });

  describe('edge cases', () => {
    it('handles empty file list', async () => {
      readStdin.mockResolvedValue(makeHookData([]));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('no files changed');
    });

    it('handles null hookData gracefully', async () => {
      readStdin.mockResolvedValue('invalid json');

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('handles missing files field (defaults to empty array)', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ task: 'done' }));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('no files changed');
    });

    it('handles non-array files field', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ changed_files: 'not-array' }));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('no files changed');
    });

    it('reads from modified_files field as fallback', async () => {
      readStdin.mockResolvedValue(makeHookData(['/src/app.js'], 'modified_files'));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('app.js');
    });

    it('reads from files field as fallback', async () => {
      readStdin.mockResolvedValue(makeHookData(['/src/utils.ts'], 'files'));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('utils.ts');
    });
  });

  describe('result object structure', () => {
    it('returns cleanState true with skip when no code files', async () => {
      readStdin.mockResolvedValue(makeHookData(['/docs/guide.md']));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      // Non-code files get the skip message, no result object
      expect(writeStdout).toHaveBeenCalledTimes(1);
      const call = writeStdout.mock.calls[0][0];
      expect(call.message).toContain('skipping');
    });

    it('returns pending lint/tests when code files exist', async () => {
      readStdin.mockResolvedValue(makeHookData(['/src/index.js']));

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      const call = writeStdout.mock.calls[0][0];
      expect(call.result.cleanState).toBe(false);
      expect(call.result.lint).toBe('pending');
      expect(call.result.tests).toBe('pending');
      expect(call.result.codeFiles).toEqual(['/src/index.js']);
    });
  });

  describe('error handling', () => {
    it('exits gracefully when readStdin rejects', async () => {
      readStdin.mockRejectedValue(new Error('stdin failed'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

      await import('../../scripts/hooks/clean-state-check.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(exitSpy).toHaveBeenCalledWith(0);
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:clean-state-check]');

      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
