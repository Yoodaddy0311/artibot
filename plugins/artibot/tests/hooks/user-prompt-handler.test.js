import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync as _realReadFileSync } from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, readFileSync: vi.fn(mod.readFileSync) };
});

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  getPluginRoot: vi.fn(() => '/mock/plugin'),
  toFileUrl: vi.fn((p) => `file:///${p.replace(/\\/g, '/')}`),
  parseJSON: vi.fn((str) => {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }),
}));

let readStdin;
let writeStdout;

const KOREAN_REVERIFY_TRIGGER = '!\uC7AC\uAC80\uC99D';
const KOREAN_REVERIFY_CONTEXT = 'auth \uBAA8\uB4C8 \uB2E4\uC2DC \uD655\uC778';

function makeHookData(prompt, key = 'user_prompt') {
  return JSON.stringify({ [key]: prompt });
}

describe('user-prompt-handler hook', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ readStdin, writeStdout } = await import('../../scripts/utils/index.js'));
    vi.clearAllMocks();
  });

  describe('normal prompts', () => {
    it('does not emit output for regular prompts', async () => {
      readStdin.mockResolvedValue(makeHookData('build a dashboard component'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does not emit output when !rv appears mid-prompt', async () => {
      readStdin.mockResolvedValue(makeHookData('please review !rv the code'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does not emit output for empty or missing prompt payloads', async () => {
      readStdin.mockResolvedValue(makeHookData(''));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('reads prompt from content field when provided', async () => {
      readStdin.mockResolvedValue(makeHookData('plain content prompt', 'content'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('!rv re-verification trigger', () => {
    it('activates re-verification mode for "!rv"', async () => {
      readStdin.mockResolvedValue(makeHookData('!rv'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('[trigger] !rv re-verification mode activated');
      expect(output.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
      expect(output.user_prompt).toContain('CLAIM AUDIT');
      expect(output.user_prompt).toContain('EVIDENCE CHECK');
    });

    it('includes additional context after the trigger', async () => {
      readStdin.mockResolvedValue(makeHookData('!rv check the auth module'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.user_prompt).toContain('Additional context from user: check the auth module');
    });

    it('is case-insensitive for !rv', async () => {
      readStdin.mockResolvedValue(makeHookData('!RV'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      expect(writeStdout.mock.calls[0][0].message).toContain('!rv re-verification');
    });

    it('supports the Korean trigger "!재검증"', async () => {
      readStdin.mockResolvedValue(makeHookData(`${KOREAN_REVERIFY_TRIGGER} ${KOREAN_REVERIFY_CONTEXT}`));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('!rv re-verification');
      expect(output.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
      expect(output.user_prompt).toContain(`Additional context from user: ${KOREAN_REVERIFY_CONTEXT}`);
    });

    it('takes priority over words that might otherwise look like normal requests', async () => {
      readStdin.mockResolvedValue(makeHookData('!rv build test'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('!rv re-verification');
      expect(output.user_prompt).toContain('build test');
    });
  });

  describe('--no-team flag', () => {
    it('strips --no-team and signals opt-out', async () => {
      readStdin.mockResolvedValue(makeHookData('implement feature --no-team'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.user_prompt).toBe('implement feature');
      expect(output.message).toContain('--no-team flag detected');
    });

    it('is case-insensitive for --no-team', async () => {
      readStdin.mockResolvedValue(makeHookData('task --NO-TEAM'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      expect(writeStdout.mock.calls[0][0].message).toContain('--no-team flag detected');
    });
  });

  describe('auto-team detection', () => {
    it('does not trigger when config is unreadable (graceful fallback)', async () => {
      // Config file doesn't exist at /mock/plugin path — checkAutoTeam catches and returns null
      readStdin.mockResolvedValue(makeHookData('implement complex feature across frontend and backend'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Without readable config, auto-team silently skips
      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('exits gracefully when readStdin rejects', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(exitSpy).toHaveBeenCalledWith(0);
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('handles invalid JSON payloads without crashing', async () => {
      readStdin.mockResolvedValue('not valid json');

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });
});
