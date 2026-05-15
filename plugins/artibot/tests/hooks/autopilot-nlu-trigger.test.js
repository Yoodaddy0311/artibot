import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * autopilot-nlu-trigger.js — UserPromptSubmit hook that suggests /autopilot
 * when long-running autonomous-work signals are present in the user prompt.
 *
 * Phase 2c P0 C-2 fix: malformed config -> isEnabled() returns false (fail-closed)
 * with a WARN line to stderr.  Hook MUST silently no-op (no writeStdout call).
 *
 * IMPL-T2-EXEC: tests now invoke the named export `handleUserPromptSubmit`
 * directly. The legacy stdin/main() path is gated behind isMain so importing
 * the module no longer fires side effects.
 */

const mockState = {
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  classifyResult: { score: 0, matched: [], suggestion: null },
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  writeStdout: vi.fn(),
  getPluginRoot: vi.fn(() => '/plugin/root'),
  // Return the relative module specifier so vitest can resolve it via vi.mock.
  toFileUrl: vi.fn(() => '../../lib/autopilot/nlu.js'),
}));

vi.mock('../../lib/autopilot/nlu.js', () => ({
  classifyAutopilotIntent: vi.fn(() => mockState.classifyResult),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
  logHookError: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p) => {
      for (const [key, val] of Object.entries(mockState.existsSyncResults)) {
        if (String(p).includes(key)) return val;
      }
      return false;
    }),
    readFileSync: vi.fn((...args) => mockState.readFileSyncImpl(...args)),
  };
});

let stderrSpy;
let handleUserPromptSubmit;

beforeEach(async () => {
  vi.resetModules();
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.classifyResult = { score: 0, matched: [], suggestion: null };
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  ({ handleUserPromptSubmit } = await import('../../scripts/hooks/autopilot-nlu-trigger.js'));
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.clearAllMocks();
});

describe('autopilot-nlu-trigger — fail-closed on malformed config (C-2)', () => {
  it('disables (returns null) and emits WARN when artibot.config.json is malformed', async () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) return '{ "team": { invalid';
      throw new Error('ENOENT');
    };

    const result = await handleUserPromptSubmit({
      user_prompt: '자고 올 동안 전체 시스템을 마이그레이션해줘',
    });

    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).toMatch(/WARN: malformed config/);
  });

  it('is enabled and runs classifier when config is missing entirely (default-on path)', async () => {
    mockState.existsSyncResults = { 'artibot.config.json': false };
    mockState.classifyResult = {
      score: 0.92,
      matched: ['자고 올 동안'],
      suggestion: 'default',
    };

    const result = await handleUserPromptSubmit({
      user_prompt: '자고 올 동안 전체 시스템 리팩토링',
    });

    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });

  it('is disabled (returns null, no WARN) when team.autoApply=false in well-formed config', async () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return JSON.stringify({ team: { autoApply: false } });
      }
      throw new Error('ENOENT');
    };

    const result = await handleUserPromptSubmit({
      user_prompt: '자고 올 동안 마이그레이션',
    });

    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });

  it('is disabled (returns null, no WARN) when autopilot.enabled=false even with team.autoApply=true', async () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return JSON.stringify({
          team: { autoApply: true, enabled: true },
          autopilot: { enabled: false },
        });
      }
      throw new Error('ENOENT');
    };
    mockState.classifyResult = {
      score: 0.95,
      matched: ['자고 올 동안'],
      suggestion: 'default',
    };

    const result = await handleUserPromptSubmit({
      user_prompt: '자고 올 동안 전체 시스템 리팩토링',
    });

    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });
});
