import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * auto-team-trigger.js — UserPromptSubmit hook that suggests parallel-team
 * delegation for multi-subtask / multi-domain prompts.
 *
 * Phase 2c P0 C-3 fix: malformed artibot.config.json returns
 * `{ enabled: false, ...defaults }` and emits a stderr WARN.  Hook MUST NOT
 * write to stdout in that path, regardless of how complex the prompt is.
 *
 * IMPL-T2-EXEC: tests now invoke the named export `handleUserPromptSubmit`
 * directly. The legacy stdin/main() path is gated behind isMain so importing
 * the module no longer fires side effects.
 */

const mockState = {
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  writeStdout: vi.fn(),
  getPluginRoot: vi.fn(() => '/plugin/root'),
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
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  ({ handleUserPromptSubmit } = await import('../../scripts/hooks/auto-team-trigger.js'));
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.clearAllMocks();
});

describe('auto-team-trigger — fail-closed on malformed config (C-3)', () => {
  it('returns null (no emit) and warns on malformed JSON', () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) return '{ "team": { broken';
      throw new Error('ENOENT');
    };

    const result = handleUserPromptSubmit({
      user_prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘',
    });

    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).toMatch(/WARN: malformed config/);
  });

  it('emits suggestion when config is missing (default enabled=true)', () => {
    mockState.existsSyncResults = { 'artibot.config.json': false };

    const result = handleUserPromptSubmit({
      user_prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘',
    });

    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(result.hookSpecificOutput.additionalContext).toContain('[auto-team-suggested]');
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });

  it('honors team.autoApply=false in well-formed config (no emit, no WARN)', () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return JSON.stringify({ team: { autoApply: false } });
      }
      throw new Error('ENOENT');
    };

    const result = handleUserPromptSubmit({
      user_prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트 추가',
    });

    expect(result).toBeNull();
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });
});

describe('auto-team-trigger — thresholds unified with workflow-plan defaults (FIX-4)', () => {
  it('missing-config defaults are 3/3/high (matches workflow-plan), not 2/2/medium', () => {
    // A 2-domain, single-verb prompt that the OLD 2/2 defaults would have
    // fired on but the unified 3/3 defaults must NOT.
    mockState.existsSyncResults = { 'artibot.config.json': false };
    const result = handleUserPromptSubmit({
      user_prompt: 'update the server endpoint and the react component styling here',
    });
    // 2 domains (backend + frontend), 1 conjunction → subtasks 2, no complexity
    // keyword → below the unified 3/3/high bar → no suggestion.
    expect(result).toBeNull();
  });

  it('config thresholds are the single source — a config of 2/2 fires the same 2-domain prompt', () => {
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return JSON.stringify({
          team: { autoApply: true, autoApplyTriggers: { minSubtasks: 2, minFiles: 2 } },
        });
      }
      throw new Error('ENOENT');
    };
    const result = handleUserPromptSubmit({
      user_prompt: 'update the server endpoint and the react component styling here',
    });
    // With explicit 2/2 from config, the SAME prompt now fires — proving config
    // overrides the (3/3) defaults rather than a hard-coded 2/2 default.
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.additionalContext).toContain('[auto-team-suggested]');
  });

  it('still fires for a genuine 3-domain multi-verb prompt under the unified defaults', () => {
    mockState.existsSyncResults = { 'artibot.config.json': false };
    const result = handleUserPromptSubmit({
      user_prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘',
    });
    expect(result).not.toBeNull();
    expect(result.hookSpecificOutput.additionalContext).toContain('[auto-team-suggested]');
  });
});
