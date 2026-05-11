import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * autopilot-nlu-trigger.js — UserPromptSubmit hook that suggests /autopilot
 * when long-running autonomous-work signals are present in the user prompt.
 *
 * Phase 2c P0 C-2 fix: malformed config -> isEnabled() returns false (fail-closed)
 * with a WARN line to stderr.  Hook MUST silently no-op (no writeStdout call).
 */

const mockState = {
  readStdinResult: Promise.resolve('{}'),
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  writeStdoutCalls: [],
  classifyResult: { score: 0, matched: [], suggestion: null },
};

// We intercept `loadNlu()` by mocking the lib module via its relative path.
// (The hook does `import(toFileUrl(nluPath))` -- but our toFileUrl mock will
// return a sentinel string; vi.mock the real lib module so when something
// resolves it via vitest's resolver, it returns our stub.)

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
  // Return the relative module specifier so vitest can resolve it via vi.mock.
  toFileUrl: vi.fn(() => '../../lib/autopilot/nlu.js'),
}));

// Mock the relative lib module — this stub answers any import() that resolves
// to lib/autopilot/nlu.js.
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

beforeEach(() => {
  vi.resetModules();
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.writeStdoutCalls = [];
  mockState.classifyResult = { score: 0, matched: [], suggestion: null };
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  // Drain any in-flight fire-and-forget microtasks from the hook's
  // top-level `main().catch(...)` so they cannot leak writeStdout
  // calls into the NEXT test's mockState. Without this, two tests
  // with opposite expectations (e.g. "expect length 1" vs
  // "expect length 0") can simultaneously fail at ~1/11 rate under
  // full-suite worker saturation. v4.5.11 isolation fix.
  await new Promise((resolve) => setTimeout(resolve, 100));
  stderrSpy.mockRestore();
  vi.clearAllMocks();
});

describe('autopilot-nlu-trigger — fail-closed on malformed config (C-2)', () => {
  it('disables (no writeStdout) and emits WARN when artibot.config.json is malformed', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      user_prompt: '자고 올 동안 전체 시스템을 마이그레이션해줘',
    }));
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) return '{ "team": { invalid';
      throw new Error('ENOENT');
    };

    await import('../../scripts/hooks/autopilot-nlu-trigger.js');
    // Even though the prompt would otherwise score high, the hook must NOT emit.
    expect(mockState.writeStdoutCalls).toHaveLength(0);
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).toMatch(/WARN: malformed config/);
  });

  it('is enabled and runs classifier when config is missing entirely (default-on path)', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      user_prompt: '자고 올 동안 전체 시스템 리팩토링',
    }));
    // No config file at all -> isEnabled defaults to true.
    mockState.existsSyncResults = { 'artibot.config.json': false };
    // Make the classifier suggest above threshold.
    mockState.classifyResult = {
      score: 0.92,
      matched: ['자고 올 동안'],
      suggestion: 'default',
    };

    await import('../../scripts/hooks/autopilot-nlu-trigger.js');
    // The hook fires `main().catch(...)` at module-top with a dynamic import()
    // chain inside loadConfig. Under full-suite load the microtask queue can
    // take longer than 1-2 turns to flush, so poll until the stdout call lands
    // or we hit a generous timeout. v4.5.11 hotfix raised 1000→3000ms after
    // 2/11 reproduction in the v4.5.10 verification matrix.
    const deadline = Date.now() + 3000;
    while (mockState.writeStdoutCalls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    expect(mockState.writeStdoutCalls[0].hookSpecificOutput.hookEventName)
      .toBe('UserPromptSubmit');
  });

  it('is disabled (no emit, no WARN) when team.autoApply=false in well-formed config', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      user_prompt: '자고 올 동안 마이그레이션',
    }));
    mockState.existsSyncResults = { 'artibot.config.json': true };
    mockState.readFileSyncImpl = (p) => {
      if (String(p).includes('artibot.config.json')) {
        return JSON.stringify({ team: { autoApply: false } });
      }
      throw new Error('ENOENT');
    };

    await import('../../scripts/hooks/autopilot-nlu-trigger.js');
    expect(mockState.writeStdoutCalls).toHaveLength(0);
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    // No WARN expected — config was valid, just opt-out.
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });

  it('is disabled (no emit, no WARN) when autopilot.enabled=false even with team.autoApply=true', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      user_prompt: '자고 올 동안 전체 시스템 리팩토링',
    }));
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
    // Even if classifier would score above threshold, hook must not emit.
    mockState.classifyResult = {
      score: 0.95,
      matched: ['자고 올 동안'],
      suggestion: 'default',
    };

    await import('../../scripts/hooks/autopilot-nlu-trigger.js');
    // Allow ample time for the hook's fire-and-forget async chain to
    // complete; with autopilot.enabled=false the hook should exit
    // without writing stdout, so we DRAIN (not poll for length>0).
    // v4.5.11 hotfix raised 200→1500ms to fully cover full-suite
    // microtask queue saturation (2/11 reproduction).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(mockState.writeStdoutCalls).toHaveLength(0);
    const stderr = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(stderr).not.toMatch(/WARN: malformed config/);
  });
});
