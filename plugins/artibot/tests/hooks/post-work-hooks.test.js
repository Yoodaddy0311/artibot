import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * blindspot-check.js + teach-back.js — advisory-only post-work Stop passes.
 *
 * Both are siblings of dev-verify-gate.js and share lib/core/post-work-pass.js.
 * These integration tests drive each hook's main() through the mock harness:
 * git output + repo-root are mocked; config load and fingerprint state files
 * use REAL fs against a fresh per-test tmp dir (getPluginRoot / resolveConfigPath
 * point there) so fingerprint dedup is exercised end-to-end without leaking
 * state across tests.
 */

let tmpRoot;

const mockState = {
  stdin: '{}',
  stdoutChunks: [],
  changedFiles: ['src/foo.js'],
  repoRoot: '/fake/repo',
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(async () => mockState.stdin),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); } catch { return null; }
  }),
  writeStdout: vi.fn((data) => {
    mockState.stdoutChunks.push(data);
  }),
  getPluginRoot: vi.fn(() => tmpRoot),
  resolveConfigPath: vi.fn((...segs) => path.join(tmpRoot, ...segs)),
  atomicWriteSync: vi.fn((file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  }),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => undefined),
  logHookError: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd) => {
    if (cmd === 'git rev-parse --show-toplevel') return mockState.repoRoot;
    if (cmd === 'git rev-parse HEAD') return 'abc1234';
    if (cmd === 'git diff --name-only HEAD') return mockState.changedFiles.join('\n');
    if (cmd === 'git diff --name-only --cached') return '';
    return '';
  }),
}));

/** Write (or clear) the tmp artibot.config.json that loadArtibotConfig reads. */
function setConfig(config) {
  const p = path.join(tmpRoot, 'artibot.config.json');
  if (config === null) return; // leave absent → loadArtibotConfig returns {}
  writeFileSync(p, JSON.stringify(config));
}

async function runHook(script) {
  vi.resetModules();
  await import(`../../scripts/hooks/${script}.js`);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-postwork-'));
  mockState.stdin = '{}';
  mockState.stdoutChunks = [];
  mockState.changedFiles = ['src/foo.js'];
  mockState.repoRoot = '/fake/repo';
  delete process.env.ARTIBOT_DISABLE_BLINDSPOT;
  delete process.env.ARTIBOT_DISABLE_TEACHBACK;
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.ARTIBOT_DISABLE_BLINDSPOT;
  delete process.env.ARTIBOT_DISABLE_TEACHBACK;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// blindspot-check.js
// ---------------------------------------------------------------------------
describe('blindspot-check', () => {
  it('is disabled by default → no output', async () => {
    setConfig({ version: '4.29.0' }); // no postWork section
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('is disabled when postWork.blindspot.enabled is false → no output', async () => {
    setConfig({ postWork: { blindspot: { enabled: false } } });
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('enabled + changed files → injects advisory additionalContext with the marker', async () => {
    setConfig({ postWork: { blindspot: { enabled: true } } });
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks).toHaveLength(1);
    const out = mockState.stdoutChunks[0];
    expect(out.decision).toBeUndefined(); // advisory only, never block
    expect(out.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(out.hookSpecificOutput.additionalContext).toContain('사각지대 점검');
    expect(out.hookSpecificOutput.additionalContext).toContain('recommend-only');
  });

  it('bails when stop_hook_active=true (loop guard)', async () => {
    setConfig({ postWork: { blindspot: { enabled: true } } });
    mockState.stdin = JSON.stringify({ stop_hook_active: true });
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('bails when there are no changed files', async () => {
    setConfig({ postWork: { blindspot: { enabled: true } } });
    mockState.changedFiles = [];
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('dedups: second run with identical state produces no output', async () => {
    setConfig({ postWork: { blindspot: { enabled: true } } });
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks).toHaveLength(1);
    mockState.stdoutChunks = [];
    await runHook('blindspot-check'); // same repo/sha/files → fingerprint hit
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('env kill-switch ARTIBOT_DISABLE_BLINDSPOT=1 wins over enabled config', async () => {
    setConfig({ postWork: { blindspot: { enabled: true } } });
    process.env.ARTIBOT_DISABLE_BLINDSPOT = '1';
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('echoes SubagentStop as the hookEventName when the payload is a SubagentStop', async () => {
    setConfig({ postWork: { blindspot: { enabled: true } } });
    mockState.stdin = JSON.stringify({ hook_event_name: 'SubagentStop' });
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks[0].hookSpecificOutput.hookEventName).toBe('SubagentStop');
  });
});

// ---------------------------------------------------------------------------
// teach-back.js
// ---------------------------------------------------------------------------
describe('teach-back', () => {
  it('is disabled by default → no output', async () => {
    setConfig({ version: '4.29.0' });
    await runHook('teach-back');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('enabled + changed files → injects advisory additionalContext with the marker', async () => {
    setConfig({ postWork: { teachBack: { enabled: true } } });
    await runHook('teach-back');
    expect(mockState.stdoutChunks).toHaveLength(1);
    const out = mockState.stdoutChunks[0];
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('학습 코너');
    expect(out.hookSpecificOutput.additionalContext).toContain('만점 게이트 금지');
  });

  it('interpolates the configured question count (default 3)', async () => {
    setConfig({ postWork: { teachBack: { enabled: true } } });
    await runHook('teach-back');
    expect(mockState.stdoutChunks[0].hookSpecificOutput.additionalContext).toContain('퀴즈 3문항');
  });

  it('interpolates a custom question count from config', async () => {
    setConfig({ postWork: { teachBack: { enabled: true, questions: 5 } } });
    await runHook('teach-back');
    expect(mockState.stdoutChunks[0].hookSpecificOutput.additionalContext).toContain('퀴즈 5문항');
  });

  it('bails when stop_hook_active=true (loop guard)', async () => {
    setConfig({ postWork: { teachBack: { enabled: true } } });
    mockState.stdin = JSON.stringify({ stop_hook_active: true });
    await runHook('teach-back');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('dedups: second run with identical state produces no output', async () => {
    setConfig({ postWork: { teachBack: { enabled: true } } });
    await runHook('teach-back');
    expect(mockState.stdoutChunks).toHaveLength(1);
    mockState.stdoutChunks = [];
    await runHook('teach-back');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('uses an independent fingerprint file from blindspot (no cross-suppression)', async () => {
    setConfig({ postWork: { blindspot: { enabled: true }, teachBack: { enabled: true } } });
    await runHook('blindspot-check');
    expect(mockState.stdoutChunks).toHaveLength(1);
    mockState.stdoutChunks = [];
    // teach-back must still fire despite blindspot having saved its own fingerprint.
    await runHook('teach-back');
    expect(mockState.stdoutChunks).toHaveLength(1);
  });

  it('env kill-switch ARTIBOT_DISABLE_TEACHBACK=1 wins over enabled config', async () => {
    setConfig({ postWork: { teachBack: { enabled: true } } });
    process.env.ARTIBOT_DISABLE_TEACHBACK = '1';
    await runHook('teach-back');
    expect(mockState.stdoutChunks).toHaveLength(0);
  });
});
