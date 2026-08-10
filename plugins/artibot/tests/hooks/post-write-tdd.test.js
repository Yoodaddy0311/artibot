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
  // The hook calls getPluginRoot() to resolve the expected test file on disk.
  // Point it at a temporary directory we control in each test.
  getPluginRoot: vi.fn(() => '/nonexistent-plugin-root'),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

// v4.7.4: post-write-tdd now bails out outside the Artibot plugin repo.
// Tests assume the gate is open by default; the in-Artibot=false case has
// its own dedicated test below that overrides this mock.
let isArtibotRepoMock = vi.fn(() => true);
vi.mock('../../lib/core/hook-utils.js', async () => {
  const actual = await vi.importActual('../../lib/core/hook-utils.js');
  return {
    ...actual,
    isArtibotRepo: (...args) => isArtibotRepoMock(...args),
  };
});

vi.mock('../../lib/git/repo-root-cache.js', () => ({
  getRepoRoot: vi.fn(() => '/fake/repo'),
}));

const { readStdin, writeStdout, getPluginRoot } = await import('../../scripts/utils/index.js');
const { existsSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
const {
  isLibSourceFile,
  extractLibRelative,
  expectedTestPath,
  buildTddMessage,
} = await import('../../scripts/hooks/post-write-tdd.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHookData(toolName, filePath) {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: filePath },
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
  const mod = await import('../../scripts/hooks/post-write-tdd.js');
  await mod.main();
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
describe('isLibSourceFile', () => {
  it('accepts `lib/foo.js`', () => {
    expect(isLibSourceFile('lib/foo.js')).toBe(true);
  });

  it('accepts nested `lib/core/config.js`', () => {
    expect(isLibSourceFile('lib/core/config.js')).toBe(true);
  });

  it('accepts absolute path containing /lib/', () => {
    expect(isLibSourceFile('/project/plugins/artibot/lib/foo.js')).toBe(true);
  });

  it('rejects test files under lib/', () => {
    expect(isLibSourceFile('lib/foo.test.js')).toBe(false);
  });

  it('rejects spec files under lib/', () => {
    expect(isLibSourceFile('lib/foo.spec.js')).toBe(false);
  });

  it('rejects non-js files', () => {
    expect(isLibSourceFile('lib/foo.md')).toBe(false);
    expect(isLibSourceFile('lib/foo.ts')).toBe(false);
  });

  it('rejects files outside lib/', () => {
    expect(isLibSourceFile('docs/README.md')).toBe(false);
    expect(isLibSourceFile('scripts/hooks/foo.js')).toBe(false);
    expect(isLibSourceFile('src/foo.js')).toBe(false);
  });

  it('does not match `/mylib/` (must be exact `/lib/` segment)', () => {
    expect(isLibSourceFile('mylib/foo.js')).toBe(false);
    expect(isLibSourceFile('sublib/foo.js')).toBe(false);
  });

  it('returns false for empty/null', () => {
    expect(isLibSourceFile('')).toBe(false);
    expect(isLibSourceFile(null)).toBe(false);
    expect(isLibSourceFile(undefined)).toBe(false);
  });
});

describe('extractLibRelative', () => {
  it('extracts lib/... from absolute path', () => {
    expect(extractLibRelative('/a/b/lib/core/foo.js')).toBe('lib/core/foo.js');
  });

  it('returns the same when path already starts with lib/', () => {
    expect(extractLibRelative('lib/foo.js')).toBe('lib/foo.js');
  });

  it('returns null when path has no lib/ segment', () => {
    expect(extractLibRelative('scripts/foo.js')).toBeNull();
  });
});

describe('expectedTestPath', () => {
  it('maps lib/foo.js -> tests/foo.test.js', () => {
    expect(expectedTestPath('lib/foo.js')).toBe('tests/foo.test.js');
  });

  it('preserves nested directory structure', () => {
    expect(expectedTestPath('lib/core/config.js')).toBe('tests/core/config.test.js');
  });

  it('handles deep nesting', () => {
    expect(expectedTestPath('lib/a/b/c/d.js')).toBe('tests/a/b/c/d.test.js');
  });
});

describe('buildTddMessage', () => {
  it('formats the advisory token', () => {
    expect(buildTddMessage('lib/foo.js', 'tests/foo.test.js')).toBe(
      '[artibot:suggest-tdd target=lib/foo.js test=tests/foo.test.js]',
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests via hook main()
// ---------------------------------------------------------------------------
describe('post-write-tdd hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getPluginRoot.mockReturnValue('/nonexistent-plugin-root');
    existsSync.mockReturnValue(false);
    // Default: assume we're inside the Artibot repo so the gate proceeds.
    isArtibotRepoMock = vi.fn(() => true);
  });

  it('silently skips when not running inside an Artibot repo', async () => {
    isArtibotRepoMock = vi.fn(() => false);
    readStdin.mockResolvedValue(makeHookData('Write', '/user-project/lib/foo.js'));
    existsSync.mockReturnValue(false);

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // No advisory token emitted in user projects — the lib/ → tests/ mirror
    // convention is Artibot-internal and would be noise elsewhere.
    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('suggests TDD when lib file has no test mirror', async () => {
    readStdin.mockResolvedValue(makeHookData('Write', '/project/lib/foo/bar.js'));
    existsSync.mockReturnValue(false);

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const out = writeStdout.mock.calls[0][0];
    expect(out.message).toContain('[artibot:suggest-tdd');
    expect(out.message).toContain('target=lib/foo/bar.js');
    expect(out.message).toContain('test=tests/foo/bar.test.js');
  });

  it('does not suggest when test mirror already exists', async () => {
    readStdin.mockResolvedValue(makeHookData('Edit', '/project/lib/foo.js'));
    existsSync.mockReturnValue(true);

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('ignores non-lib files', async () => {
    readStdin.mockResolvedValue(makeHookData('Write', '/project/docs/README.md'));

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('ignores edits to test files themselves (recursion guard)', async () => {
    readStdin.mockResolvedValue(makeHookData('Edit', '/project/lib/foo.test.js'));

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('ignores non-Write/Edit tools', async () => {
    readStdin.mockResolvedValue(JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/project/lib/foo.js' },
    }));

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('is a no-op when file_path missing', async () => {
    readStdin.mockResolvedValue(JSON.stringify({ tool_name: 'Write', tool_input: {} }));

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('handles invalid JSON gracefully', async () => {
    readStdin.mockResolvedValue('not json {{{');

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(writeStdout).not.toHaveBeenCalled();
  });
});
