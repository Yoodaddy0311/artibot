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
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');
const { readFileSync, existsSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Helper to build hook data for Edit/Write tools
// ---------------------------------------------------------------------------
function makeHookData(toolName, filePath, overrides = {}) {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: filePath },
    tool_result: {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('quality-gate hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    existsSync.mockReturnValue(true);
  });

  describe('tool filtering', () => {
    it('skips non-Edit/Write tools', async () => {
      readStdin.mockResolvedValue(makeHookData('Read', '/project/src/app.js'));
      readFileSync.mockReturnValue('const x = 1;');

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('processes Edit tool', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/app.js'));
      readFileSync.mockReturnValue('console.log("test");');

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalled();
    });

    it('processes Write tool', async () => {
      readStdin.mockResolvedValue(makeHookData('Write', '/project/src/app.js'));
      readFileSync.mockReturnValue('console.log("test");');

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalled();
    });
  });

  describe('file extension filtering', () => {
    it('skips non-inspectable extensions like .md', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/docs/readme.md'));
      readFileSync.mockReturnValue('console.log("test");');

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('skips node_modules paths', async () => {
      readStdin.mockResolvedValue(
        makeHookData('Edit', '/project/node_modules/pkg/index.js'),
      );
      readFileSync.mockReturnValue('const secret_key = "sk-12345678abcdefgh";');

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('console.log detection', () => {
    it('warns when console.log is found', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/app.js'));
      readFileSync.mockReturnValue('function run() {\n  console.log("debug");\n}');

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('console.log'),
        }),
      );
    });

    it('counts multiple console.* occurrences', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/app.ts'));
      readFileSync.mockReturnValue(
        'console.log("a");\nconsole.error("b");\nconsole.debug("c");',
      );

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('3 occurrence'),
        }),
      );
    });

    it('does not warn for clean code without console.*', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/clean.js'));
      readFileSync.mockReturnValue(
        'function add(a, b) {\n  return a + b;\n}\n',
      );

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('hardcoded secret detection', () => {
    it('blocks when hardcoded API key is found', async () => {
      readStdin.mockResolvedValue(makeHookData('Write', '/project/src/config.js'));
      readFileSync.mockReturnValue(
        'const api_key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";\n',
      );

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'block',
          message: expect.stringContaining('secret'),
        }),
      );
    });

    it('blocks when AWS access key pattern is found', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/aws.js'));
      readFileSync.mockReturnValue(
        'const accessKey = "' + 'AKIA' + 'IOSFODNN7EXAMPLE";\n',
      );

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'block',
          message: expect.stringContaining('secret'),
        }),
      );
    });

    it('blocks when GitHub personal access token is found', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/gh.js'));
      readFileSync.mockReturnValue(
        'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";\n',
      );

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'block',
        }),
      );
    });

    it('ignores secret-like patterns in comments', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/commented.js'));
      readFileSync.mockReturnValue(
        '// const api_key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";\nconst x = 1;\n',
      );

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      // writeStdout either not called or called without 'block' decision
      if (writeStdout.mock.calls.length > 0) {
        expect(writeStdout.mock.calls[0][0].decision).not.toBe('block');
      }
    });
  });

  describe('file size check', () => {
    it('warns when file exceeds 800 lines', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/big.js'));
      const bigFile = Array.from({ length: 850 }, (_, i) => `const line${i} = ${i};`).join('\n');
      readFileSync.mockReturnValue(bigFile);

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('800 lines'),
        }),
      );
    });

    it('does not warn for files under 800 lines', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/small.js'));
      const smallFile = Array.from({ length: 50 }, (_, i) => `const line${i} = ${i};`).join('\n');
      readFileSync.mockReturnValue(smallFile);

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('does nothing when hookData is null', async () => {
      readStdin.mockResolvedValue('not valid json {{');

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does nothing when file_path is empty', async () => {
      readStdin.mockResolvedValue(
        JSON.stringify({ tool_name: 'Edit', tool_input: {} }),
      );

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does nothing when file does not exist on disk', async () => {
      existsSync.mockReturnValue(false);
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/ghost.js'));

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does nothing when file is unreadable', async () => {
      readStdin.mockResolvedValue(makeHookData('Edit', '/project/src/locked.js'));
      readFileSync.mockImplementation(() => { throw new Error('EACCES'); });

      await import('../../scripts/hooks/quality-gate.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });
});
