import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

/**
 * session-start.js initializes the Artibot plugin on every Claude Code session.
 * The `home` variable is defined at function scope (line 36), so the script
 * completes successfully and calls writeStdout with a welcome message.
 */

// ---------------------------------------------------------------------------
// Shared mock state container — survives vi.resetModules()
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  writeStdoutCalls: [],
  writeFileSyncCalls: [],
  mkdirSyncCalls: [],
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  existsSyncResult: false,
  /** Args of every stubbed `child_process.spawn` call — see the mock below. */
  spawnCalls: [],
  // Per-path existsSync override map (string → boolean). When set, takes
  // precedence over `existsSyncResult` so a test can mark only `.artibot/HANDOFF.md`
  // as present while keeping all other paths absent.
  existsSyncByPath: null,
  // Every path existsSync was asked about, in call order. Lets a test assert
  // WHICH handoff path the hook looked at, not merely that it found one.
  existsSyncPaths: [],
  // Optional stub for fs.statSync — when set, called for any path containing
  // `.artibot/HANDOFF.md`. Return shape: { mtimeMs, size }.
  statSyncImpl: null,
  // Optional stub for fs.openSync/readSync — handoff banner reads the head
  // of the file via these APIs. We return a captured string + fd handle.
  handoffHeadContent: null,
  // checkForUpdateFactory is called on each invocation, returning a fresh Promise.
  // Using a factory (thunk) avoids storing a rejected Promise in state, which would
  // trigger vitest's unhandled-rejection detection before the module's catch block runs.
  checkForUpdateFactory: () => Promise.resolve({ hasUpdate: false }),
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  writeStdout: vi.fn((...args) => { mockState.writeStdoutCalls.push(args); }),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
  resolveConfigPath: vi.fn((...segs) => `/fake/plugin/root/${segs.join('/')}`),
  toFileUrl: vi.fn((p) => `file://${p}`),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((...args) => mockState.readFileSyncImpl(...args)),
    existsSync: vi.fn((p) => {
      mockState.existsSyncPaths.push(String(p));
      if (mockState.existsSyncByPath) {
        const k = String(p);
        for (const [key, val] of Object.entries(mockState.existsSyncByPath)) {
          if (k.includes(key)) return val;
        }
      }
      return mockState.existsSyncResult;
    }),
    writeFileSync: vi.fn((...args) => { mockState.writeFileSyncCalls.push(args); }),
    mkdirSync: vi.fn((...args) => { mockState.mkdirSyncCalls.push(args); }),
    statSync: vi.fn((p) => {
      if (mockState.statSyncImpl) return mockState.statSyncImpl(p);
      return { mtimeMs: 0, size: 0 };
    }),
    // openSync/readSync/closeSync — minimal stubs so appendHandoffBanner's
    // readHeadSync path returns mockState.handoffHeadContent.
    openSync: vi.fn(() => 999), // synthetic fd
    readSync: vi.fn((_fd, buf) => {
      const content = mockState.handoffHeadContent || '';
      const bytes = Buffer.from(content, 'utf8');
      bytes.copy(buf, 0, 0, Math.min(bytes.length, buf.length));
      return Math.min(bytes.length, buf.length);
    }),
    closeSync: vi.fn(() => {}),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    platform: vi.fn(() => 'win32'),
    arch: vi.fn(() => 'x64'),
  };
});

/**
 * The hook must not launch real child processes from a test.
 *
 * `main()` ends with `maybeSwarmAutodetect(env.pluginRoot)`, which spawns
 * `scripts/swarm-autodetect.js --auto` against the REAL plugin root and
 * `unref()`s it. That child spawns `scripts/swarm-init.js`, which WRITES the
 * tracked `artibot.config.json` (`swarm.enabled` true, `backend` git,
 * `gitRepoUrl` set) and rewrites `.claude-plugin/swarm-profile.json`.
 *
 * Measured 2026-08-30 with a probe on both scripts: one full-suite run produced
 * 26 spawns from this file — every parent stack was
 * `maybeSwarmAutodetect (session-start.js) <- main (session-start.js)` and no
 * other test file appeared — of which 3 reached `swarm-init` and flipped the
 * shipped defaults. It reproduces only in a long run because the child is
 * detached: run this file alone and the suite exits before the child gets there.
 *
 * The run-once guard cannot stop it here. That guard is a marker file under
 * `ARTIBOT_STATE_DIR`, which the global setup redirects to a fresh temp dir per
 * worker, while the profile it acts on is read from the real
 * `CLAUDE_PLUGIN_ROOT` — the guard state and its target live in different
 * places, so every worker looks like a first run.
 *
 * Stubbing `spawn` is the whole fix and costs no production surface: this hook
 * uses exactly one symbol from the module (`session-start.js`, the lone
 * `await import('node:child_process')`). Calls are recorded so a test can still
 * assert that a spawn was attempted.
 */
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((...args) => {
      mockState.spawnCalls.push(args);
      return { unref: () => {}, on: () => {}, kill: () => {} };
    }),
  };
});

vi.mock('../../lib/core/version-checker.js', () => ({
  checkForUpdate: vi.fn(() => mockState.checkForUpdateFactory()),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const POLL_MS = 25;
// session-start.js#main() is fire-and-forget (invoked at module import) and its
// terminal writeStdout lands only after a long chain of UNMOCKED dynamic imports
// (session-memory, collective-hub, kill-switch, skill-hash-cache, …). Under the
// full-suite parallel run these re-transform/re-evaluate per vi.resetModules(),
// so a single main() can take multiple seconds. The old 3000ms ceiling was
// routinely exceeded → the in-test wait gave up (empty writeStdoutCalls → `[0][0]`
// TypeError) AND the straggler main() then bled its write into the NEXT test's
// freshly-reset shared array (wrong-message assertion failure). 15s sits well
// under the 30s vitest testTimeout while absorbing heavy cold-start saturation.
const SETTLE_TIMEOUT_MS = 15_000;

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/session-start.js');
  await mod.main();
}

describe('session-start hook', () => {
  let stderrSpy;
  let exitSpy;

  beforeEach(() => {
    vi.resetModules();
    mockState.readStdinResult = Promise.resolve('{}');
    mockState.writeStdoutCalls = [];
    mockState.spawnCalls = [];
    mockState.writeFileSyncCalls = [];
    mockState.mkdirSyncCalls = [];
    mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
    mockState.existsSyncResult = false;
    mockState.existsSyncByPath = null;
    mockState.existsSyncPaths = [];
    mockState.statSyncImpl = null;
    mockState.handoffHeadContent = null;
    mockState.checkForUpdateFactory = () => Promise.resolve({ hasUpdate: false });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Isolation drain: if this test's fire-and-forget main() has not yet
    // flushed its single terminal writeStdout, wait for it HERE so its late
    // write is consumed in THIS test rather than bleeding into the next test's
    // freshly-reset mockState.writeStdoutCalls. Returns immediately once the
    // write already happened (the common case). `waitForStdout` is a hoisted
    // function declaration in this describe scope, so it is in scope here.
    await waitForStdout(SETTLE_TIMEOUT_MS);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete process.env.ANTHROPIC_BETA;
  });

  async function waitForStdout(timeoutMs = SETTLE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (mockState.writeStdoutCalls.length > 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  async function importAndWait(options = {}) {
    await runHook();
    if (options.waitForStdout === false) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      return;
    }
    await waitForStdout(options.timeoutMs);
  }

  describe('successful initialization', () => {
    it('calls writeStdout with a welcome message', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      expect(mockState.writeStdoutCalls.length).toBeGreaterThan(0);
      const output = mockState.writeStdoutCalls[0][0];
      expect(output).toHaveProperty('message');
      expect(output.message).toContain('Artibot');
    });

    it('does not call process.exit on success', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('does not write to stderr on success when agent teams is active', async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      // Filter out informational skill-hash cache messages (Phase 1 Quick Win).
      // These are advisory only, not errors, and may appear in test environments
      // where the cache module's dynamic import target is mocked.
      const stderrOutput = stderrSpy.mock.calls
        .map((c) => c[0])
        .filter((line) => !String(line).includes('skill-hash'))
        .join('');
      expect(stderrOutput).toBe('');
    });
  });

  describe('environment variables', () => {
    it('reports the env var as set when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1', async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('agent-teams (env set)');
    });

    it('shows advisory message when agent teams is not configured', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('team env unset (tools unchecked)');
      // Should write advisory to stderr instead of modifying settings.json
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('Agent Teams env var not set');
    });

    // Regression guard for the label's honesty, not its wording. A
    // SessionStart hook cannot see the session's tools (main() discards the
    // stdin payload), and toggling this env var was measured to add/remove no
    // tool at all on CLI 2.1.220 headless. So the banner must never state the
    // session's capability from the env var alone — asserting `agent-teams
    // (full)` or `sub-agent (fallback)` off a config read is the exact claim
    // that was wrong. Rewording the labels keeps this green; re-asserting
    // capability turns it red.
    it('never claims a capability it cannot observe, in either direction', async () => {
      for (const envValue of ['1', undefined]) {
        if (envValue === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
        else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = envValue;
        mockState.writeStdoutCalls.length = 0;
        mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

        await importAndWait();

        const { message } = mockState.writeStdoutCalls[0][0];
        expect(message).not.toContain('agent-teams (full)');
        expect(message).not.toContain('sub-agent (fallback)');
      }
    });

    it('does not modify settings.json (advisory only)', async () => {
      const { writeFileSync } = await import('node:fs');
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      // Verify writeFileSync was never called with a settings.json path
      const settingsWrites = vi.mocked(writeFileSync).mock.calls
        .filter((c) => String(c[0]).includes('settings.json'));
      expect(settingsWrites).toHaveLength(0);
    });
  });

  describe('stdin handling', () => {
    it('handles empty stdin gracefully and still writes output', async () => {
      mockState.readStdinResult = Promise.resolve('');

      await importAndWait();

      // parseJSON returns null for empty string; the script falls back to defaults
      expect(mockState.writeStdoutCalls.length).toBeGreaterThan(0);
    });
  });

  describe('config loading', () => {
    it('reads artibot.config.json and uses the version from it', async () => {
      mockState.readFileSyncImpl = (filePath) => {
        if (String(filePath).includes('artibot.config.json')) {
          return JSON.stringify({ version: '2.0.0' });
        }
        throw new Error('ENOENT');
      };
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('v2.0.0');
    });

    it('falls back to version 1.0.0 when config is missing', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('v1.0.0');
    });
  });

  describe('update notification', () => {
    it('appends update notice to message when a newer version is available', async () => {
      mockState.checkForUpdateFactory = () =>
        Promise.resolve({ hasUpdate: true, latestVersion: '9.9.9' });
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('9.9.9');
      expect(output.message).toContain('/update --force');
    });

    it('does not append update notice when already on the latest version', async () => {
      mockState.checkForUpdateFactory = () =>
        Promise.resolve({ hasUpdate: false });
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).not.toContain('/update --force');
    });

    it('still writes output when checkForUpdate rejects', async () => {
      // Factory returns a fresh rejected Promise on each call.
      // session-start.js catches it in its try/catch and continues to writeStdout.
      mockState.checkForUpdateFactory = () =>
        Promise.reject(new Error('network error'));
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      // The try/catch in session-start.js swallows the error
      expect(mockState.writeStdoutCalls.length).toBeGreaterThan(0);
    });

    it('still writes output when checkForUpdate times out', async () => {
      // Factory returns a Promise that never resolves, so the 2000ms
      // Promise.race timeout in session-start.js fires. The catch block
      // swallows it and writeStdout is called.
      mockState.checkForUpdateFactory = () => new Promise(() => {});
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      // Source uses Promise.race({ timeout: 2000ms }). Polling margin
      // relaxed from 2600→6000ms to absorb full-suite worker saturation
      // — under heavy cold-start (import phase ~7min) the 600ms slack
      // beyond the 2s race timeout was insufficient for the catch block
      // microtask to flush its stdout write.
      await importAndWait({ timeoutMs: 6000 });

      expect(mockState.writeStdoutCalls.length).toBeGreaterThan(0);
    }, 12000);
  });

  describe('P3-3: long-context opt-in', () => {
    it('persists runtime/long-context-active.json when enabled=true', async () => {
      mockState.readFileSyncImpl = (filePath) => {
        if (String(filePath).includes('artibot.config.json')) {
          return JSON.stringify({
            version: '2.8.0',
            runtime: {
              longContext: {
                enabled: true,
                betaHeader: 'context-1m-2025-08-01',
                activationThreshold: 180000,
              },
            },
          });
        }
        throw new Error('ENOENT');
      };
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const longContextWrites = mockState.writeFileSyncCalls.filter((args) =>
        String(args[0]).includes('long-context-active.json'),
      );
      expect(longContextWrites.length).toBeGreaterThan(0);

      const payload = JSON.parse(longContextWrites[0][1]);
      expect(payload.enabled).toBe(true);
      expect(payload.betaHeader).toBe('context-1m-2025-08-01');
      expect(typeof payload.activatedAt).toBe('string');
    });

    it('appends betaHeader to ANTHROPIC_BETA env when enabled', async () => {
      mockState.readFileSyncImpl = (filePath) => {
        if (String(filePath).includes('artibot.config.json')) {
          return JSON.stringify({
            runtime: {
              longContext: {
                enabled: true,
                betaHeader: 'context-1m-2025-08-01',
              },
            },
          });
        }
        throw new Error('ENOENT');
      };
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      expect(process.env.ANTHROPIC_BETA).toContain('context-1m-2025-08-01');
    });

    it('does NOT write long-context file when enabled=false (default)', async () => {
      mockState.readFileSyncImpl = (filePath) => {
        if (String(filePath).includes('artibot.config.json')) {
          return JSON.stringify({
            runtime: {
              longContext: { enabled: false, betaHeader: 'context-1m-2025-08-01' },
            },
          });
        }
        throw new Error('ENOENT');
      };
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const longContextWrites = mockState.writeFileSyncCalls.filter((args) =>
        String(args[0]).includes('long-context-active.json'),
      );
      expect(longContextWrites).toHaveLength(0);
    });
  });

  describe('handoff banner (Track B2 /save integration)', () => {
    it('pushes [artibot:handoff] line when .artibot/HANDOFF.md exists and is older than session start', async () => {
      mockState.existsSyncByPath = { 'HANDOFF.md': true };
      mockState.statSyncImpl = () => ({
        // 5 minutes before module load — guarantees mtimeMs < SESSION_START_MS
        mtimeMs: Date.now() - 5 * 60_000,
        size: 1024,
      });
      mockState.handoffHeadContent = [
        '# HANDOFF — 2026-05-19 11:30',
        '',
        '> 다음 P0: Ship the release notes',
        '',
        '## 1. 지금 상태',
        'WIP: 4',
        '',
        '## 5. 미해결 결정/질문',
        '- item one',
        '- item two',
      ].join('\n');
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('[artibot:handoff]');
      expect(output.message).toContain('Ship the release notes');
      expect(output.message).toContain('/resume');
    });

    it('looks for HANDOFF.md at the project root, not at the cwd', async () => {
      // `/save` writes the handoff at the repo root, and every handoff on disk
      // lives there. Vitest runs with cwd = plugins/artibot — a SUBDIRECTORY of
      // the repo root — so a cwd-relative lookup and a root-relative lookup
      // resolve to visibly different paths right here.
      mockState.existsSyncByPath = { 'HANDOFF.md': true };
      mockState.statSyncImpl = () => ({ mtimeMs: Date.now() - 5 * 60_000, size: 1024 });
      mockState.handoffHeadContent = '> 다음 P0: anything\n';
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const probed = mockState.existsSyncPaths.filter((p) => p.includes('HANDOFF.md'));
      expect(probed.length).toBeGreaterThan(0);
      const cwdRelative = path.join(process.cwd(), '.artibot', 'HANDOFF.md');
      expect(probed).not.toContain(cwdRelative);
      // Every handoff probe sits above cwd — i.e. at the resolved project root.
      for (const p of probed) {
        expect(path.dirname(path.dirname(p)).length).toBeLessThan(process.cwd().length);
      }
    });

    it('omits handoff banner when .artibot/HANDOFF.md is absent (legacy behavior preserved)', async () => {
      // existsSyncByPath unset → existsSyncResult=false applies → handoff bail-out.
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).not.toContain('[artibot:handoff]');
    });

    it('parses banner fields correctly when HANDOFF.md begins with a YAML frontmatter block', async () => {
      // Safety #2: v4.13.0 prepends YAML frontmatter to every /save handoff.
      // The banner parser must skip it before scanning `## N.` headings.
      mockState.existsSyncByPath = { 'HANDOFF.md': true };
      mockState.statSyncImpl = () => ({
        mtimeMs: Date.now() - 5 * 60_000,
        size: 1024,
      });
      mockState.handoffHeadContent = [
        '---',
        'machineId: host_user',
        "createdAt: '2026-05-19T11:30:00.000Z'",
        'branch: feat/handoff',
        'generator: artibot-handoff',
        'schemaVersion: 1',
        '---',
        '',
        '# HANDOFF — 2026-05-19 11:30',
        '',
        '> 다음 P0: Frontmatter parsing works',
        '',
        '## 1. 지금 상태',
        'WIP: 2',
        '',
        '## 5. 미해결 결정/질문',
        '- item one',
      ].join('\n');
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('[artibot:handoff]');
      expect(output.message).toContain('Frontmatter parsing works');
      // Unresolved count from § 5 must be 1, NOT 0 — proves the parser
      // correctly skipped past frontmatter and located § 5.
      expect(output.message).toContain('미해결 1');
      expect(output.message).toContain('미커밋 2');
    });

    it('suppresses [artibot:pending-suggestions] line when handoff banner is pushed (dedup)', async () => {
      // Arrange: HANDOFF.md exists AND pending suggestions also exist → without
      // dedup the user would see two redundant lines surfacing the same info.
      mockState.existsSyncByPath = { 'HANDOFF.md': true, 'next-session-suggestions.json': true };
      mockState.statSyncImpl = () => ({ mtimeMs: Date.now() - 5 * 60_000, size: 1024 });
      mockState.handoffHeadContent = [
        '# HANDOFF — 2026-05-19 11:30',
        '',
        '> 다음 P0: Wire up the deduplication test',
        '',
        '## 1. 지금 상태',
        'WIP: 1',
        '',
        '## 5. 미해결 결정/질문',
        '- pending advisor item',
      ].join('\n');
      // surfaceAdvisoryMessages reads next-session-suggestions.json via
      // readFileSyncImpl — return a payload with 1 unresolved suggestion so
      // the [artibot:pending-suggestions] line would normally be pushed.
      const previousImpl = mockState.readFileSyncImpl;
      mockState.readFileSyncImpl = (filePath) => {
        if (String(filePath).includes('next-session-suggestions.json')) {
          return JSON.stringify({
            suggestions: [
              { id: 'a', resolved: false, consumed: false, summary: 'x' },
            ],
          });
        }
        return previousImpl(filePath);
      };
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('[artibot:handoff]');
      expect(output.message).not.toContain('[artibot:pending-suggestions');
    });
  });

  describe('자식 프로세스 격리 (추적 config 오염 차단)', () => {
    it('swarm autodetect 스폰이 스텁을 통과한다 — 실제 프로세스가 아니다', async () => {
      // `maybeSwarmAutodetect` returns early unless the autodetect script
      // "exists", so let it through to the spawn it guards.
      mockState.existsSyncResult = true;

      await runHook();

      // FAIL-CLOSED GATE. Delete the `node:child_process` mock and this goes
      // red: a real `spawn` never touches `mockState.spawnCalls`. The mock is
      // what stops the detached child from rewriting the tracked
      // `artibot.config.json` — see the mock's own comment for the measurement.
      const swarmSpawns = mockState.spawnCalls
        .filter(([, args]) => Array.isArray(args)
          && args.some((a) => String(a).includes('swarm-autodetect')));
      expect(swarmSpawns.length).toBeGreaterThanOrEqual(1);
      expect(swarmSpawns[0][1]).toContain('--auto');
    });
  });
});
