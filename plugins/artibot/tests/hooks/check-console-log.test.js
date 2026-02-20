import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    readFileSync: vi.fn(() => ''),
    existsSync: vi.fn(() => true),
  };
});

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');
const { readFileSync, existsSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHookData(files, key = 'modified_files') {
  return JSON.stringify({ [key]: files });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('check-console-log hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('');
  });

  describe('detects console.log statements', () => {
    it('warns when console.log is found in a .js file', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/app.js']));
      readFileSync.mockReturnValue('const x = 1;\nconsole.log("debug");\nconst y = 2;');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('[audit]');
      expect(output.message).toContain('console.log');
      expect(output.message).toContain('app.js');
      expect(output.message).toContain('line(s) 2');
    });

    it('detects console.debug statements', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/utils.ts']));
      readFileSync.mockReturnValue('console.debug("info");');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('utils.ts');
    });

    it('detects console.info statements', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/helper.jsx']));
      readFileSync.mockReturnValue('console.info("status");');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('helper.jsx');
    });

    it('reports multiple lines with console statements', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/app.js']));
      readFileSync.mockReturnValue(
        'line 1\nconsole.log("a");\nline 3\nconsole.log("b");\nline 5',
      );

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('2');
      expect(output.message).toContain('4');
    });

    it('reports warnings across multiple files', async () => {
      readStdin.mockResolvedValue(makeHookData([
        '/project/src/a.js',
        '/project/src/b.ts',
      ]));
      readFileSync.mockImplementation((filePath) => {
        if (String(filePath).includes('a.js')) return 'console.log("a");';
        if (String(filePath).includes('b.ts')) return 'console.log("b");';
        return '';
      });

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('a.js');
      expect(output.message).toContain('b.ts');
    });
  });

  describe('scannable file extensions', () => {
    it.each([
      ['/project/src/app.js', '.js'],
      ['/project/src/app.jsx', '.jsx'],
      ['/project/src/app.ts', '.ts'],
      ['/project/src/app.tsx', '.tsx'],
      ['/project/src/app.mjs', '.mjs'],
      ['/project/src/app.cjs', '.cjs'],
    ])('scans %s (%s)', async (filePath, _ext) => {
      readStdin.mockResolvedValue(makeHookData([filePath]));
      readFileSync.mockReturnValue('console.log("test");');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['/project/src/styles.css', '.css'],
      ['/project/README.md', '.md'],
      ['/project/data.json', '.json'],
      ['/project/config.yml', '.yml'],
      ['/project/image.png', '.png'],
    ])('skips non-scannable file: %s (%s)', async (filePath, _ext) => {
      readStdin.mockResolvedValue(makeHookData([filePath]));
      readFileSync.mockReturnValue('console.log("should not scan");');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('no console statements', () => {
    it('does not warn when files have no console statements', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/clean.js']));
      readFileSync.mockReturnValue('const x = 1;\nconst y = 2;\nexport { x, y };');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does not match console.error or console.warn', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/app.js']));
      readFileSync.mockReturnValue('console.error("err");\nconsole.warn("warn");');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('does not call writeStdout when modified_files is empty', async () => {
      readStdin.mockResolvedValue(makeHookData([]));

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does not call writeStdout when modified_files is not an array', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ modified_files: 'not-an-array' }));

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('reads files from the "files" field as fallback', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/app.js'], 'files'));
      readFileSync.mockReturnValue('console.log("test");');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
    });

    it('skips files that do not exist', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/missing.js']));
      existsSync.mockReturnValue(false);

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('skips files that cannot be read', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/locked.js']));
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() => { throw new Error('EACCES'); });

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('includes "Consider removing before commit" in warning message', async () => {
      readStdin.mockResolvedValue(makeHookData(['/project/src/app.js']));
      readFileSync.mockReturnValue('console.log("test");');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('Consider removing before commit');
    });
  });

  describe('error handling', () => {
    it('exits gracefully when readStdin rejects', async () => {
      readStdin.mockRejectedValue(new Error('stdin failed'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(exitSpy).toHaveBeenCalledWith(0);
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:check-console-log]');

      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('handles null hookData gracefully', async () => {
      readStdin.mockResolvedValue('invalid json');

      await import('../../scripts/hooks/check-console-log.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });
});
