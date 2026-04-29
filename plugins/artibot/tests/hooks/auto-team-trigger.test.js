import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * auto-team-trigger.js — UserPromptSubmit hook that suggests parallel-team
 * delegation for multi-subtask / multi-domain prompts.
 *
 * Phase 2c P0 C-3 fix: malformed artibot.config.json returns
 * `{ enabled: false, ...defaults }` and emits a stderr WARN.  Hook MUST NOT
 * write to stdout in that path, regardless of how complex the prompt is.
 */

const mockState = {
  readStdinResult: Promise.resolve('{}'),
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  writeStdoutCalls: [],
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  writeStdout: vi.fn((payload) => {
    mockState.writeStdoutCalls.push(payload);
  }),
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

beforeEach(() => {
  vi.resetModules();
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.writeStdoutCalls = [];
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.clearAllMocks();
});

async function flushTicks() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setImmediate(r));
}

describe('auto-team-trigger — fail-closed on malformed config (C-3)', () => {
  it('returns enabled=false (no writeStdout) and warns on malformed JSON', async () => {
    // High-complexity prompt that WOULD trigger the team suggestion.
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      user_prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘',
    }));
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return '{ "team": { broken';
      }
      throw new Error('ENOENT');
    };

    await import('../../scripts/hooks/auto-team-trigger.js');
    await flushTicks();

    expect(mockState.writeStdoutCalls).toHaveLength(0);
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).toMatch(/WARN: malformed config/);
  });

  it('emits suggestion when config is missing (default enabled=true)', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      user_prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트도 추가해줘',
    }));
    mockState.existsSyncResults = { 'artibot.config.json': false };

    await import('../../scripts/hooks/auto-team-trigger.js');
    await flushTicks();

    expect(mockState.writeStdoutCalls).toHaveLength(1);
    const ctx = mockState.writeStdoutCalls[0].hookSpecificOutput;
    expect(ctx.hookEventName).toBe('UserPromptSubmit');
    expect(ctx.additionalContext).toContain('[auto-team-suggested]');
    // No malformed-config WARN should have been emitted.
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });

  it('honors team.autoApply=false in well-formed config (no emit, no WARN)', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      user_prompt: '프론트와 백엔드 시스템을 마이그레이션하고 테스트 추가',
    }));
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return JSON.stringify({ team: { autoApply: false } });
      }
      throw new Error('ENOENT');
    };

    await import('../../scripts/hooks/auto-team-trigger.js');
    await flushTicks();

    expect(mockState.writeStdoutCalls).toHaveLength(0);
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });
});
