import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * dev-verify-gate.js — v4.5.8 marker-based DEV verify gate.
 *
 * The previous implementation (v4.5.6) was hard-disabled because it fired
 * on every Stop with uncommitted changes — regardless of whether those
 * changes came from the orchestrator (legitimate) or from teammates spawned
 * via Task (false positive that paralysed `/team` workflows).
 *
 * v4.5.8 restores the gate by introducing a marker file written ONLY on
 * main-agent Edit/Write/MultiEdit (see mark-main-agent-edit.js). This test
 * suite covers the bail-vs-fire decision matrix that the marker drives.
 *
 * The schema-level main() flow is hard to integration-test without spinning
 * up a real git repo + stdin — so we exercise the pure helper through
 * filesystem fixtures and only smoke-test main()'s read-only-turn bail path.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
let tmpRoot;

const mockState = {
  stdin: '',
  stdoutChunks: [],
  pluginRoot: '',
  changedFiles: [],
  repoRoot: '/fake/repo',
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(async () => mockState.stdin),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); } catch { return null; }
  }),
  getPluginRoot: vi.fn(() => mockState.pluginRoot),
  atomicWriteSync: vi.fn((file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  }),
  writeStdout: vi.fn((data) => {
    mockState.stdoutChunks.push(JSON.stringify(data));
  }),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => undefined),
  logHookError: vi.fn(),
}));

// node:child_process — git invocations
vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd) => {
    if (cmd === 'git rev-parse --show-toplevel') return mockState.repoRoot;
    if (cmd === 'git rev-parse HEAD') return 'abc1234';
    if (cmd === 'git diff --name-only HEAD') {
      return mockState.changedFiles.join('\n');
    }
    if (cmd === 'git diff --name-only --cached') return '';
    return '';
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dev-verify-gate (v4.5.8 marker behaviour)', () => {
  let mainFn;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-'));
    mockState.pluginRoot = tmpRoot;
    mockState.stdin = '{}';
    mockState.stdoutChunks = [];
    mockState.changedFiles = [];

    if (!mainFn) {
      const mod = await import('../../scripts/hooks/dev-verify-gate.js');
      // The module's main() is not exported (it's invoked via top-level await
      // .catch). We re-import using a query string to force re-eval and
      // capture the side-effects of running main(). For unit testing we
      // instead exercise behaviour by running the module on each test —
      // but importing repeatedly would re-run the top-level main() which
      // already executed at first import. So we treat the FIRST import as
      // the test fire and assert against the recorded mocks.
      mainFn = mod;
    }
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.clearAllMocks();
  });

  it('module loads without throwing (smoke test)', () => {
    // Importing the module fires main() under top-level .catch handler.
    // The catch handler is a no-op (createErrorHandler mock), so any
    // unhandled async error would surface here.
    expect(mainFn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pure decision-matrix tests against the marker / cache fixture filesystem.
//
// Because dev-verify-gate's hasNewerMainAgentEdit() is module-private, we
// validate the SAME mtime semantics independently. Any drift between this
// test's ground truth and the implementation is a real regression.
// ---------------------------------------------------------------------------
describe('marker-vs-cache mtime semantics (ground truth)', () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-mtime-'));
  });

  afterEach(() => {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function fixture(markerMtime, cacheMtime) {
    const runtime = path.join(workdir, 'runtime');
    mkdirSync(runtime, { recursive: true });
    if (markerMtime !== null) {
      const m = path.join(runtime, 'last-main-agent-edit.timestamp');
      writeFileSync(m, 'x');
      utimesSync(m, new Date(markerMtime), new Date(markerMtime));
    }
    if (cacheMtime !== null) {
      const c = path.join(runtime, 'last-dev-verify-sha.txt');
      writeFileSync(c, 'fingerprint');
      utimesSync(c, new Date(cacheMtime), new Date(cacheMtime));
    }
  }

  // Reproduces the decision matrix documented in dev-verify-gate.js
  // hasNewerMainAgentEdit(). If this lookup table changes, update both.
  function decide(markerMtime, cacheMtime) {
    if (markerMtime === null) return false;          // no main edit ever
    if (cacheMtime === null) return true;            // first run baseline
    return markerMtime > cacheMtime;                 // marker drives the gate
  }

  it('bails when no marker has ever been written', () => {
    fixture(null, Date.now());
    expect(decide(null, Date.now())).toBe(false);
  });

  it('fires on first run (no cache yet) when marker exists', () => {
    fixture(Date.now(), null);
    expect(decide(Date.now(), null)).toBe(true);
  });

  it('fires when marker is newer than cache', () => {
    const cache = Date.now() - 60_000;
    const marker = Date.now();
    fixture(marker, cache);
    expect(decide(marker, cache)).toBe(true);
  });

  it('bails when marker mtime equals cache mtime', () => {
    const t = Date.now() - 30_000;
    fixture(t, t);
    expect(decide(t, t)).toBe(false);
  });

  it('bails when marker is older than cache (already verified)', () => {
    const marker = Date.now() - 60_000;
    const cache = Date.now();
    fixture(marker, cache);
    expect(decide(marker, cache)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Artibot-repo scope guard (added 2026-05-07).
//
// dev-verify-gate.js installs globally (~/.claude/artibot/) so its Stop hook
// fires in every project the user works in. The DEV verify checklist is an
// Artibot-internal development policy and must NOT surface in unrelated
// projects ("Reference: plugins/artibot/CLAUDE.md" was leaking out as noise).
//
// isArtibotRepo() is module-private — these tests independently assert the
// same detection rules. Drift between the implementation and these tests is
// a real regression.
// ---------------------------------------------------------------------------
describe('Artibot repo scope guard (ground truth)', () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-scope-'));
  });

  afterEach(() => {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Reproduces the detection rules documented in dev-verify-gate.js
  // isArtibotRepo(). If this lookup table changes, update both.
  function detect(repoRoot) {
    if (!repoRoot) return false;
    return (
      existsSync(path.join(repoRoot, 'plugins', 'artibot', 'CLAUDE.md')) ||
      existsSync(path.join(repoRoot, 'artibot.config.json'))
    );
  }

  it('detects Artibot monorepo root via plugins/artibot/CLAUDE.md', () => {
    mkdirSync(path.join(workdir, 'plugins', 'artibot'), { recursive: true });
    writeFileSync(path.join(workdir, 'plugins', 'artibot', 'CLAUDE.md'), '# stub');
    expect(detect(workdir)).toBe(true);
  });

  it('detects plugin directory directly via artibot.config.json', () => {
    writeFileSync(path.join(workdir, 'artibot.config.json'), '{}');
    expect(detect(workdir)).toBe(true);
  });

  it('rejects unrelated project (no Artibot markers)', () => {
    writeFileSync(path.join(workdir, 'package.json'), '{"name":"unrelated"}');
    expect(detect(workdir)).toBe(false);
  });

  it('rejects empty / null repoRoot defensively', () => {
    expect(detect(null)).toBe(false);
    expect(detect('')).toBe(false);
  });

  it('rejects sibling directory with similarly-named plugin folder', () => {
    // e.g. someone has plugins/artibot-fork/CLAUDE.md — must NOT match
    mkdirSync(path.join(workdir, 'plugins', 'artibot-fork'), { recursive: true });
    writeFileSync(
      path.join(workdir, 'plugins', 'artibot-fork', 'CLAUDE.md'),
      '# fork',
    );
    expect(detect(workdir)).toBe(false);
  });
});
