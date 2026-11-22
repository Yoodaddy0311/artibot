import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callLiterals, findEgress, globalNetNames, importSpecifiers, lexBlank } from '../helpers/no-egress.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(TEST_DIR, '..', '..', 'scripts', 'hooks');

// ---------------------------------------------------------------------------
// Mocks — keep parity with the existing pre-compact.test.js style so the
// AD-40 state-write extension is exercised without spawning a real process.
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  getPluginRoot: vi.fn(() => path.resolve('plugins/artibot')),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    existsSync: vi.fn(() => false),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execSync: vi.fn(() => 'master\n'),
  };
});

const { readStdin } = await import('../../scripts/utils/index.js');
const { resolveArtibotDir } = await import('../../lib/core/config.js');
const { readFileSync, existsSync, writeFileSync, mkdirSync } = await import('node:fs');
const { execSync } = await import('node:child_process');

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/pre-compact.js');
  await mod.main();
}

// ---------------------------------------------------------------------------
// Tests — only the AD-40-specific extension. Existing snapshot tests live
// in pre-compact.test.js.
// ---------------------------------------------------------------------------
describe('pre-compact state-save extension (AD-40)', () => {
  let stderrSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    existsSync.mockReturnValue(false);
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    writeFileSync.mockImplementation(() => {});
    mkdirSync.mockImplementation(() => {});
    execSync.mockReturnValue('master\n');
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('writes a pre-compact-<ts>.md state file with frontmatter', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));
    execSync.mockImplementationOnce(() => 'feature/x\n').mockImplementationOnce(() => ' M file.txt\n');

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    // The hook makes 2 writes: artibot-pre-compact.json + pre-compact-*.md
    expect(writeFileSync).toHaveBeenCalled();
    const stateWrites = writeFileSync.mock.calls.filter((call) =>
      String(call[0]).includes('pre-compact-') && String(call[0]).endsWith('.md'),
    );
    expect(stateWrites.length).toBeGreaterThanOrEqual(1);
    const body = stateWrites[0][1];
    expect(body).toContain('---');
    expect(body).toContain('cwd:');
    expect(body).toContain('branch:');
    expect(body).toContain('event: pre-compact');
    expect(body).toContain('```');
  });

  it('writes the state file flat in <state dir>/runtime when the payload has no session id', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    const snapshotWrite = writeFileSync.mock.calls.find((c) => String(c[0]).endsWith('artibot-pre-compact.json'));
    const { stateFilePath } = JSON.parse(snapshotWrite[1]);
    expect(path.dirname(stateFilePath)).toBe(path.join(resolveArtibotDir(), 'runtime'));
    expect(path.basename(stateFilePath)).toMatch(/^pre-compact-.+\.md$/);
  });

  it('captures branch via git rev-parse and status via git status --short', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));
    execSync.mockImplementationOnce(() => 'artibot/master\n').mockImplementationOnce(() => '');

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    const calls = execSync.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('rev-parse'))).toBe(true);
    expect(calls.some((c) => c.includes('status'))).toBe(true);
  });

  it('does NOT throw when git commands fail', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));
    execSync.mockImplementation(() => { throw new Error('not a git repository'); });

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    // The compact json snapshot still gets written; the markdown state file
    // is best-effort and should not crash the hook.
    const allWrites = writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(allWrites.some((p) => p.includes('artibot-pre-compact.json'))).toBe(true);
  });

  it('snapshot JSON includes a gitState block with cwd + branch', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));
    execSync.mockImplementationOnce(() => 'main\n').mockImplementationOnce(() => 'M  file.txt\n');

    await runHook();
    await new Promise((r) => setTimeout(r, 50));

    const jsonWrite = writeFileSync.mock.calls.find((c) =>
      String(c[0]).endsWith('artibot-pre-compact.json'),
    );
    expect(jsonWrite).toBeDefined();
    const snap = JSON.parse(jsonWrite[1]);
    expect(snap.gitState).toBeDefined();
    expect(snap.gitState.branch).toBe('main');
    expect(snap.gitState.cwd).toBeTruthy();
    expect(snap.gitState.hasStatus).toBe(true);
  });
});

describe('pre-compact no-egress invariant', () => {
  /** Use vi.importActual to bypass the vi.mock('node:fs') in this file. */
  async function hookSource() {
    const realFs = await vi.importActual('node:fs');
    return realFs.readFileSync(path.join(HOOKS_DIR, 'pre-compact.js'), 'utf-8');
  }

  // Layer 1, fail-closed: the modules this hook uses today (measured 2026-11-22). Any new
  // import — node:dns, ws, an HTTP client — is outside the set and goes red.
  const ALLOWED_IMPORTS = ['../utils/index.js', 'node:path', 'node:child_process', 'node:fs',
    '../../lib/core/hook-utils.js', '../../lib/core/runtime-state.js',
    '../../lib/context/context-pressure.js', './_main-entry.js'];

  it('imports only allow-listed modules and uses no network global', async () => {
    const src = await hookSource();
    const imports = importSpecifiers(src);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((s) => !ALLOWED_IMPORTS.includes(s))).toEqual([]);
    expect(globalNetNames(src)).toEqual([]);
  });

  it('matches none of the deny-list patterns except child_process (allowed: local git)', async () => {
    // ALLOWED: child_process — captureGitState runs `git rev-parse` / `git status --short` in the
    // session cwd (execSync, local only). Every other egress pattern stays forbidden.
    expect(findEgress(await hookSource(), { allow: ['child_process'] })).toEqual([]);
  });

  // The child_process allowance is file-wide, so `execSync('curl …')` would pass it (lane D,
  // 2026-11-22). The calls themselves are pinned: one binding (`execSync`), only these literal
  // commands, and no alias — every `execSync` in code is the import or one of the calls.
  const GIT_COMMANDS = ['git rev-parse --abbrev-ref HEAD', 'git rev-parse --short=12 HEAD', 'git status --short'];

  it('runs only the three local git commands through child_process', async () => {
    const src = await hookSource();
    const { noComments, codeOnly } = lexBlank(src);
    expect(importSpecifiers(src).filter((s) => /^(?:node:)?child_process$/.test(s))).toEqual(['node:child_process']);
    const binding = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])node:child_process\2/.exec(noComments);
    expect(binding?.[1].split(',').map((b) => b.trim()).filter(Boolean)).toEqual(['execSync']);

    const calls = callLiterals(src, 'execSync');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !GIT_COMMANDS.includes(c))).toEqual([]);
    expect((codeOnly.match(/\bexecSync\b/g) ?? []).length).toBe(1 + calls.length);
  });
});
