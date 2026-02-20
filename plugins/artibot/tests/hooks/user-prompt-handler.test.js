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
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  };
});

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');
const { readFileSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHookData(prompt, key = 'user_prompt') {
  return JSON.stringify({ [key]: prompt });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('user-prompt-handler hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Default: config not found
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  });

  describe('intent detection - English keywords', () => {
    it.each([
      ['build a new feature', 'action:build'],
      ['create a component', 'action:build'],
      ['implement the login page', 'action:implement'],
      ['review the PR', 'action:review'],
      ['audit the codebase', 'action:review'],
      ['test the module', 'action:test'],
      ['fix the bug', 'action:fix'],
      ['debug the issue', 'action:fix'],
      ['refactor the service', 'action:refactor'],
      ['deploy to production', 'action:deploy'],
      ['document the API', 'action:document'],
      ['analyze performance', 'action:analyze'],
      ['plan the sprint', 'action:plan'],
      ['design the system', 'action:design'],
    ])('detects intent from: "%s" -> %s', async (prompt, expectedIntent) => {
      readStdin.mockResolvedValue(makeHookData(prompt));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('[intent]');
      expect(output.message).toContain(expectedIntent);
    });
  });

  describe('intent detection - Korean keywords', () => {
    it.each([
      ['\uD300 \uC18C\uD658\uD574\uC918', 'team:summon'],
      ['\uBE4C\uB4DC \uC2DC\uC791', 'action:build'],
      ['\uAD6C\uD604\uD574\uC918', 'action:implement'],
      ['\uB9AC\uBDF0 \uBD80\uD0C1\uD574', 'action:review'],
      ['\uD14C\uC2A4\uD2B8 \uC791\uC131', 'action:test'],
      ['\uC218\uC815\uD574\uC918', 'action:fix'],
      ['\uB9AC\uD329\uD130\uB9C1', 'action:refactor'],
      ['\uBC30\uD3EC\uD574\uC918', 'action:deploy'],
      ['\uBB38\uC11C \uC791\uC131', 'action:document'],
      ['\uBD84\uC11D\uD574\uC918', 'action:analyze'],
      ['\uACC4\uD68D \uC218\uB9BD', 'action:plan'],
      ['\uC124\uACC4\uD574\uC918', 'action:design'],
    ])('detects Korean keyword: "%s" -> %s', async (prompt, expectedIntent) => {
      readStdin.mockResolvedValue(makeHookData(prompt));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain(expectedIntent);
    });
  });

  describe('team summon keywords', () => {
    it.each([
      'team assemble',
      'summon the crew',
      'spawn agents',
    ])('detects team:summon from: "%s"', async (prompt) => {
      readStdin.mockResolvedValue(makeHookData(prompt));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('team:summon');
    });
  });

  describe('multiple intents', () => {
    it('detects multiple intents from a single prompt', async () => {
      readStdin.mockResolvedValue(makeHookData('build and test the feature'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('action:build');
      expect(output.message).toContain('action:test');
    });

    it('deduplicates intents (team + summon both map to team:summon)', async () => {
      readStdin.mockResolvedValue(makeHookData('team summon the agents'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      // team:summon should appear once, not twice
      const matches = output.message.match(/team:summon/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('no intent detected', () => {
    it('does not call writeStdout when no keywords match', async () => {
      readStdin.mockResolvedValue(makeHookData('hello world'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does not call writeStdout when prompt is empty', async () => {
      readStdin.mockResolvedValue(makeHookData(''));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does not call writeStdout when hookData has no prompt fields', async () => {
      readStdin.mockResolvedValue(JSON.stringify({ some_field: 'value' }));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('alternative hook data formats', () => {
    it('reads prompt from content field when user_prompt is absent', async () => {
      readStdin.mockResolvedValue(makeHookData('build something', 'content'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('action:build');
    });
  });

  describe('case insensitivity', () => {
    it('detects intent regardless of case', async () => {
      readStdin.mockResolvedValue(makeHookData('BUILD the feature'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('action:build');
    });
  });

  describe('agent mapping from config', () => {
    it('includes suggested agents when config has taskBased mapping', async () => {
      readFileSync.mockImplementation((filePath) => {
        if (String(filePath).includes('artibot.config.json')) {
          return JSON.stringify({
            agents: {
              taskBased: {
                build: 'builder-agent',
                test: 'qa-agent',
              },
            },
          });
        }
        throw new Error('ENOENT');
      });

      readStdin.mockResolvedValue(makeHookData('build the feature'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('Suggested agents');
      expect(output.message).toContain('builder-agent');
    });

    it('works without suggested agents when config is missing', async () => {
      readStdin.mockResolvedValue(makeHookData('build something'));

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('action:build');
      expect(output.message).not.toContain('Suggested agents');
    });
  });

  describe('error handling', () => {
    it('exits gracefully when readStdin rejects', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(exitSpy).toHaveBeenCalledWith(0);
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('handles null parseJSON result gracefully', async () => {
      readStdin.mockResolvedValue('not valid json');

      await import('../../scripts/hooks/user-prompt-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      // No crash, no output for null hookData with no prompt
      expect(writeStdout).not.toHaveBeenCalled();
    });
  });
});
