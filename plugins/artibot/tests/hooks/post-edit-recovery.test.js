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
}));

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');

// ---------------------------------------------------------------------------
// Import pure functions for unit testing
// ---------------------------------------------------------------------------
const { matchFailurePattern, buildRecoveryMessage } = await import(
  '../../scripts/hooks/post-edit-recovery.js'
);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeHookData(toolName, toolOutput, overrides = {}) {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: '/project/src/app.js', old_string: 'foo', new_string: 'bar' },
    tool_output: toolOutput,
    ...overrides,
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
  const mod = await import('../../scripts/hooks/post-edit-recovery.js');
  await mod.main();
}

// ---------------------------------------------------------------------------
// Unit tests for matchFailurePattern
// ---------------------------------------------------------------------------
describe('matchFailurePattern', () => {
  it('detects "old_string not found"', () => {
    const result = matchFailurePattern('Error: old_string not found in file');
    expect(result).not.toBeNull();
    expect(result.hint).toContain('not found');
  });

  it('detects "oldString not found" (camelCase variant)', () => {
    const result = matchFailurePattern('oldString not found in the target file');
    expect(result).not.toBeNull();
    expect(result.hint).toContain('not found');
  });

  it('detects "found multiple times"', () => {
    const result = matchFailurePattern('old_string found multiple times in file');
    expect(result).not.toBeNull();
    expect(result.hint).toContain('multiple locations');
  });

  it('detects "not unique"', () => {
    const result = matchFailurePattern('The match is not unique, provide more context');
    expect(result).not.toBeNull();
    expect(result.hint).toContain('multiple locations');
  });

  it('detects "file not found"', () => {
    const result = matchFailurePattern('Error: file not found at /path/to/missing.js');
    expect(result).not.toBeNull();
    expect(result.hint).toContain('does not exist');
  });

  it('detects "does not exist"', () => {
    const result = matchFailurePattern('The file /src/foo.js does not exist');
    expect(result).not.toBeNull();
    expect(result.hint).toContain('does not exist');
  });

  it('is case-insensitive', () => {
    const result = matchFailurePattern('OLD_STRING NOT FOUND');
    expect(result).not.toBeNull();
  });

  it('returns null for successful output', () => {
    const result = matchFailurePattern('File updated successfully');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(matchFailurePattern('')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(matchFailurePattern(null)).toBeNull();
    expect(matchFailurePattern(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for buildRecoveryMessage
// ---------------------------------------------------------------------------
describe('buildRecoveryMessage', () => {
  it('includes tool name', () => {
    const msg = buildRecoveryMessage('Edit', 'some hint');
    expect(msg).toContain('Edit failed');
  });

  it('includes the hint', () => {
    const msg = buildRecoveryMessage('Write', 'file does not exist');
    expect(msg).toContain('file does not exist');
  });

  it('includes recovery instructions', () => {
    const msg = buildRecoveryMessage('Edit', 'test');
    expect(msg).toContain('Read the file');
    expect(msg).toContain('Retry');
  });
});

// ---------------------------------------------------------------------------
// Integration tests via hook main()
// ---------------------------------------------------------------------------
describe('post-edit-recovery hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('outputs recovery message when Edit fails with old_string not found', async () => {
    readStdin.mockResolvedValue(
      makeHookData('Edit', 'Error: old_string not found in file')
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const call = writeStdout.mock.calls[0][0];
    expect(call.message).toContain('Edit failed');
    expect(call.message).toContain('Read the file');
  });

  it('outputs recovery message when Edit fails with found multiple times', async () => {
    readStdin.mockResolvedValue(
      makeHookData('Edit', 'old_string found multiple times in file')
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const call = writeStdout.mock.calls[0][0];
    expect(call.message).toContain('multiple locations');
  });

  it('outputs recovery message when Write fails with file not found', async () => {
    readStdin.mockResolvedValue(
      makeHookData('Write', 'Error: file not found at /missing/path.js')
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const call = writeStdout.mock.calls[0][0];
    expect(call.message).toContain('Write failed');
  });

  it('passes through silently on successful Edit', async () => {
    readStdin.mockResolvedValue(
      makeHookData('Edit', 'File updated successfully')
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('ignores non-Edit/Write tools', async () => {
    readStdin.mockResolvedValue(
      makeHookData('Bash', 'old_string not found')
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('ignores Read tool even with matching output', async () => {
    readStdin.mockResolvedValue(
      makeHookData('Read', 'file not found')
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('reads from tool_response (canonical Claude Code field) — DEAD-hook regression guard', async () => {
    // Before the fix, tool_response was absent from the resolver chain, so the
    // hook silently no-op'd in production (the legacy keys are never populated).
    readStdin.mockResolvedValue(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/project/app.js' },
        tool_response: 'Error: old_string not found in file',
      })
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const call = writeStdout.mock.calls[0][0];
    expect(call.message).toContain('Edit failed');
  });

  it('prefers tool_response over legacy tool_output when both present', async () => {
    readStdin.mockResolvedValue(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/project/app.js' },
        tool_response: 'old_string not found',
        tool_output: 'File updated successfully',
      })
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    // tool_response (failure) wins → recovery message emitted.
    expect(writeStdout).toHaveBeenCalledTimes(1);
  });

  it('handles tool_result field as fallback for output', async () => {
    readStdin.mockResolvedValue(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/project/app.js' },
        tool_result: 'old_string not found',
      })
    );

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).toHaveBeenCalledTimes(1);
  });

  it('handles null/missing hook data gracefully', async () => {
    readStdin.mockResolvedValue('invalid json {{{');

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    expect(writeStdout).not.toHaveBeenCalled();
  });
});
