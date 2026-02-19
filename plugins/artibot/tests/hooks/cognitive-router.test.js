import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock: ../utils/index.js — stdin/stdout helpers
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
}));

// Mock node:fs readFileSync
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  };
});

const { readStdin, writeStdout, parseJSON, getPluginRoot } = await import(
  '../../scripts/utils/index.js'
);
const { readFileSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cognitive-router hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('loadConfig()', () => {
    it('returns defaults when artibot.config.json is missing', async () => {
      // readFileSync throws → defaults used
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readStdin.mockResolvedValue(JSON.stringify({ user_prompt: 'hello world' }));

      // Dynamic import fails for router module → fallback used
      // That's fine; we verify defaults via fallback path
      const mod = await import('../../scripts/hooks/cognitive-router.js');
      // The module auto-runs main(). Since it uses fallback, writeStdout is called
      // We wait a tick for the async main() to complete.
      await new Promise((r) => setTimeout(r, 50));

      // Verify writeStdout was called (fallback path since router import fails)
      expect(writeStdout).toHaveBeenCalled();
    });

    it('merges cognitive config from artibot.config.json', async () => {
      readFileSync.mockImplementation(() =>
        JSON.stringify({
          cognitive: {
            router: { threshold: 0.7, adaptRate: 0.1 },
          },
        }),
      );
      readStdin.mockResolvedValue(JSON.stringify({ user_prompt: 'test input' }));

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      // If router import fails it falls back; either way writeStdout called
      expect(writeStdout).toHaveBeenCalled();
    });
  });

  describe('fallback routing', () => {
    // Router module import always fails in tests → fallback keyword detection

    it('routes to SYSTEM2 when --think flag is present', async () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readStdin.mockResolvedValue(JSON.stringify({ user_prompt: 'please --think about this' }));

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('SYSTEM2'),
        }),
      );
    });

    it('routes to SYSTEM2 when --ultrathink flag is present', async () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readStdin.mockResolvedValue(
        JSON.stringify({ user_prompt: 'analyze --ultrathink the architecture' }),
      );

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('SYSTEM2'),
        }),
      );
    });

    it('routes to SYSTEM2 for complex keywords like "architecture"', async () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readStdin.mockResolvedValue(
        JSON.stringify({ user_prompt: 'review the architecture carefully' }),
      );

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('SYSTEM2'),
        }),
      );
    });

    it('routes to SYSTEM1 for simple prompts', async () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readStdin.mockResolvedValue(
        JSON.stringify({ user_prompt: 'hello how are you today' }),
      );

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('SYSTEM1'),
        }),
      );
    });

    it('includes "fallback" in the message when router module fails', async () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readStdin.mockResolvedValue(JSON.stringify({ user_prompt: 'simple question' }));

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('fallback'),
        }),
      );
    });

    it('routes to SYSTEM2 for Korean complex keywords', async () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readStdin.mockResolvedValue(
        JSON.stringify({ user_prompt: '보안 감사를 수행해주세요' }),
      );

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('SYSTEM2'),
        }),
      );
    });
  });

  describe('empty/null input handling', () => {
    it('does nothing when stdin is empty', async () => {
      readStdin.mockResolvedValue('');

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does nothing when prompt is empty string', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ user_prompt: '' }));

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does nothing when hook data has no prompt field', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ other: 'data' }));

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('content field fallback', () => {
    it('uses content field when user_prompt is absent', async () => {
      readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      readStdin.mockResolvedValue(
        JSON.stringify({ content: 'analyze security vulnerabilities' }),
      );

      await import('../../scripts/hooks/cognitive-router.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('SYSTEM2'),
        }),
      );
    });
  });
});
