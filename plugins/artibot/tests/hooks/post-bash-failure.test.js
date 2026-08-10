import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  getPluginRoot: vi.fn(() => '/plugin-root'),
}));

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------
const {
  extractExitCode,
  extractCommand,
  classifyCommand,
  buildSuggestionMessage,
} = await import('../../scripts/hooks/post-bash-failure.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeBashHookData({ command, exit_code }) {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { exit_code },
  });
}

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/post-bash-failure.js');
  await mod.main();
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
describe('extractExitCode', () => {
  it('reads tool_response.exit_code', () => {
    expect(extractExitCode({ tool_response: { exit_code: 2 } })).toBe(2);
  });

  it('falls back to tool_response.exitCode (camelCase)', () => {
    expect(extractExitCode({ tool_response: { exitCode: 5 } })).toBe(5);
  });

  it('falls back to tool_response.returncode', () => {
    expect(extractExitCode({ tool_response: { returncode: 1 } })).toBe(1);
  });

  it('falls back to tool_result.exit_code', () => {
    expect(extractExitCode({ tool_result: { exit_code: 3 } })).toBe(3);
  });

  it('falls back to top-level exit_code', () => {
    expect(extractExitCode({ exit_code: 7 })).toBe(7);
  });

  it('returns null when no exit code is present', () => {
    expect(extractExitCode({})).toBeNull();
  });

  it('returns 0 for successful command (not null)', () => {
    expect(extractExitCode({ tool_response: { exit_code: 0 } })).toBe(0);
  });
});

describe('extractCommand', () => {
  it('reads tool_input.command', () => {
    expect(extractCommand({ tool_input: { command: 'npm test' } })).toBe('npm test');
  });

  it('reads tool_input.script (PowerShell tool shape)', () => {
    expect(extractCommand({ tool_input: { script: 'npm test' } })).toBe('npm test');
  });

  it('returns empty string when missing', () => {
    expect(extractCommand({})).toBe('');
  });
});

describe('classifyCommand', () => {
  it('classifies `npm run build` as build', () => {
    expect(classifyCommand('npm run build')).toBe('build');
  });

  it('classifies `npx tsc` as build', () => {
    expect(classifyCommand('npx tsc --project .')).toBe('build');
  });

  it('classifies `npm test` as test', () => {
    expect(classifyCommand('npm test')).toBe('test');
  });

  it('classifies `npx vitest run` as test', () => {
    expect(classifyCommand('npx vitest run')).toBe('test');
  });

  it('classifies `npm run lint` as lint', () => {
    expect(classifyCommand('npm run lint')).toBe('lint');
  });

  it('classifies `eslint .` as lint', () => {
    expect(classifyCommand('eslint .')).toBe('lint');
  });

  it('classifies `tsc --noemit` as typecheck', () => {
    expect(classifyCommand('tsc --noemit')).toBe('typecheck');
  });

  it('is case-insensitive', () => {
    expect(classifyCommand('NPM RUN BUILD')).toBe('build');
  });

  it('returns null for unrelated commands', () => {
    expect(classifyCommand('git status')).toBeNull();
    expect(classifyCommand('ls -la')).toBeNull();
    expect(classifyCommand('curl example.com')).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(classifyCommand('')).toBeNull();
    expect(classifyCommand(null)).toBeNull();
    expect(classifyCommand(undefined)).toBeNull();
  });
});

describe('buildSuggestionMessage', () => {
  it('produces the canonical auto-recover token', () => {
    expect(buildSuggestionMessage('build')).toBe(
      '[artibot:auto-recover suggest=build-error-resolver reason=build]',
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests via hook main()
// ---------------------------------------------------------------------------
describe('post-bash-failure hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('emits no output when exit_code is 0', async () => {
    readStdin.mockResolvedValue(
      makeBashHookData({ command: 'npm run build', exit_code: 0 }),
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('emits suggestion when `npm run build` fails', async () => {
    readStdin.mockResolvedValue(
      makeBashHookData({ command: 'npm run build', exit_code: 1 }),
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const out = writeStdout.mock.calls[0][0];
    expect(out.message).toContain('[artibot:auto-recover');
    expect(out.message).toContain('reason=build');
  });

  it('emits suggestion when `npx vitest run` fails', async () => {
    readStdin.mockResolvedValue(
      makeBashHookData({ command: 'npx vitest run', exit_code: 1 }),
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const out = writeStdout.mock.calls[0][0];
    expect(out.message).toContain('reason=test');
  });

  it('emits no suggestion for unrelated failing commands', async () => {
    readStdin.mockResolvedValue(
      makeBashHookData({ command: 'git push origin main', exit_code: 128 }),
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('ignores non-Bash tool invocations', async () => {
    readStdin.mockResolvedValue(JSON.stringify({
      tool_name: 'Edit',
      tool_input: { command: 'npm run build' },
      tool_response: { exit_code: 1 },
    }));

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('emits suggestion when PowerShell `npm test` fails', async () => {
    readStdin.mockResolvedValue(JSON.stringify({
      tool_name: 'PowerShell',
      tool_input: { script: 'npm test' },
      tool_response: { exit_code: 1 },
    }));

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const out = writeStdout.mock.calls[0][0];
    expect(out.message).toContain('reason=test');
  });

  it('emits no output when PowerShell command exits 0', async () => {
    readStdin.mockResolvedValue(JSON.stringify({
      tool_name: 'PowerShell',
      tool_input: { script: 'npm test' },
      tool_response: { exit_code: 0 },
    }));

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('is a no-op when exit_code field is absent', async () => {
    readStdin.mockResolvedValue(JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_response: {},
    }));

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('handles null hook data gracefully', async () => {
    readStdin.mockResolvedValue('not json {{{');

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });
});
