import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const { readFileSync, existsSync, writeFileSync, mkdirSync } = await import('node:fs');
const { execSync } = await import('node:child_process');

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

  it('writes a runtime/state/pre-compact-<ts>.md file with frontmatter', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));
    execSync.mockImplementationOnce(() => 'feature/x\n').mockImplementationOnce(() => ' M file.txt\n');

    await import('../../scripts/hooks/pre-compact.js');
    await new Promise((r) => setTimeout(r, 50));

    // The hook makes 2 writes: artibot-pre-compact.json + runtime/state/pre-compact-*.md
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

  it('captures branch via git rev-parse and status via git status --short', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));
    execSync.mockImplementationOnce(() => 'artibot/master\n').mockImplementationOnce(() => '');

    await import('../../scripts/hooks/pre-compact.js');
    await new Promise((r) => setTimeout(r, 50));

    const calls = execSync.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('rev-parse'))).toBe(true);
    expect(calls.some((c) => c.includes('status'))).toBe(true);
  });

  it('does NOT throw when git commands fail', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));
    execSync.mockImplementation(() => { throw new Error('not a git repository'); });

    await import('../../scripts/hooks/pre-compact.js');
    await new Promise((r) => setTimeout(r, 50));

    // The compact json snapshot still gets written; the markdown state file
    // is best-effort and should not crash the hook.
    const allWrites = writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(allWrites.some((p) => p.includes('artibot-pre-compact.json'))).toBe(true);
  });

  it('snapshot JSON includes a gitState block with cwd + branch', async () => {
    readStdin.mockResolvedValue(JSON.stringify({}));
    execSync.mockImplementationOnce(() => 'main\n').mockImplementationOnce(() => 'M  file.txt\n');

    await import('../../scripts/hooks/pre-compact.js');
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
  it('source must not import HTTP/fetch APIs', async () => {
    // Use vi.importActual to bypass the vi.mock('node:fs') in this file.
    const realFs = await vi.importActual('node:fs');
    const direct = realFs.readFileSync(path.join(HOOKS_DIR, 'pre-compact.js'), 'utf-8');
    expect(direct).not.toMatch(/\bfetch\s*\(/);
    expect(direct).not.toMatch(/from\s+['"]node:https?['"]/);
    expect(direct).not.toMatch(/from\s+['"]axios['"]/);
  });
});
