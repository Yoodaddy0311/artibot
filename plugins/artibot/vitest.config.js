import { defineConfig } from 'vitest/config';

/** Strip shebang lines so CLI scripts can be imported in tests on Windows. */
function stripShebangPlugin() {
  return {
    name: 'strip-shebang',
    enforce: 'pre',
    transform(code) {
      if (typeof code === 'string' && code.startsWith('#!')) {
        return { code: code.replace(/^#![^\n]*\n?/, ''), map: null };
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [stripShebangPlugin()],
  test: {
    root: '.',
    // `include` is intentionally left to per-project config below. Setting
    // it here also creates an implicit "default" project that runs in
    // parallel with the explicit `projects[]` entries, which double-counts
    // every test (observed: 15168 tests / 585 files instead of 7674 / 300).
    // Windows-friendly default. Many tests spawn child processes
    // (`execFileSync`/`execFile`) where Node cold-start alone can exceed
    // vitest's 5s default on Windows, causing flaky timeouts unrelated to
    // the code under test. 30s gives spawning + heavy IO suites room
    // without masking real regressions.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Redirects `resolveArtibotDir()` away from the developer's real
    // `~/.claude/artibot`. Declared here rather than per project because both
    // entries below use `extends: true`; verified 2026-08-30 that the env
    // actually reaches workers in BOTH projects rather than assuming it.
    // Default-on by design: an opt-in guard fails open for the next test
    // someone writes. See the file for what it does not cover.
    setupFiles: ['./tests/setup/state-dir.js'],
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      reporter: ['text', 'json', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['lib/**/*.js'],
      exclude: [
        'lib/**/index.js',
        'lib/core/tui.js',
        'lib/core/skill-exporter.js',
        'scripts/hooks/**',
        'tests/**',
        'node_modules/**',
        'templates/**',
        '_reports/**',
        '_benchmarks/**',
      ],
      // Thresholds: aligned with CLAUDE.md's official "80%+ coverage target".
      // CI on Linux measures ~5-10% lower than Windows local due to v8 coverage
      // instrumentation differences across platforms. Windows local typically
      // shows 90+/84+/89+/92+; CI on the same commits has measured 77.3% for
      // branches even with the same test suite.
      //
      thresholds: {
        statements: 80,
        branches: 76,
        functions: 80,
        lines: 80,
      },
    },
    // Multi-project workspace: runs `tests/autopilot/**` ONE FILE AT A TIME.
    // Those tests perform real `git worktree add/remove`
    // against the shared `.git/worktrees/` namespace, and running them
    // across parallel workers races on the index lock — symptom seen in
    // v4.5.8 was `engine.execute-worktree.test.js` case 3 flaking with
    // `expected true to be false` only in full-suite parallel runs.
    // Other tests retain full file-level parallelism for speed.
    // Replaces vitest's removed `poolMatchGlobs` (vitest 3+ canonical
    // pattern).
    projects: [
      {
        extends: true,
        test: {
          name: 'autopilot',
          // Serial FILES, not one long-lived process: `fileParallelism: false`
          // forces this project's `maxWorkers` to 1, and each file still gets
          // a fresh fork. The older `poolOptions.forks.singleFork` spelling
          // promised a single process and delivered neither.
          //
          // Position is load-bearing. A TEST-LEVEL option parked BESIDE
          // `test:` in a project entry is dropped by vitest 4 without warning.
          // (Vite-level keys such as `plugins` or `resolve` are a different
          // case and belong there legitimately: `UserWorkspaceConfig extends
          // UserConfig$1`.) `pool: 'forks'` and `poolOptions: { forks: {
          // singleFork: true } }` are test-level, sat in that dead position
          // from the vitest 4 upgrade until 2026-09-21, and did nothing:
          // measured that day on vitest 4.0.18 across the 71 autopilot files,
          // 71 distinct worker pids and up to 31 files in flight at once
          // (a single run also counted 1333 overlapping file pairs; pair
          // counts move run to run, the concurrency ceiling does not).
          // `fileParallelism` is declared on
          // `InlineConfig` and absent from `NonProjectOptions`, so
          // `ProjectConfig` keeps it and `test:` is its live home.
          // Pinned by `tests/firewall/vitest-autopilot-serial.test.js`.
          //
          // `isolate` is deliberately left at its default (true). vitest's
          // `groupSpecs` gives a spec its own trailing sequential group only
          // when `isolate === true && sequence.groupOrder === 0 &&
          // maxWorkers === 1`. A spec that misses that branch joins the shared
          // group, where two projects with different `maxWorkers` at the same
          // `groupOrder` make vitest throw — so `isolate: false` here would
          // put every run that also includes `main` at risk.
          fileParallelism: false,
          // Explicit rather than implied. `forks` is already vitest 4's
          // default, but the git-worktree rationale above depends on process
          // isolation, so the intent is spelled out where it is actually read.
          pool: 'forks',
          include: ['tests/autopilot/**/*.test.{js,mjs}'],
          // Benchmarks are owned by the `main` project below. Without this,
          // vitest's default benchmark glob
          // (`**/*.{bench,benchmark}.?(c|m)[jt]s?(x)`) matches in EVERY
          // project, so `vitest bench --run` executed both `.bench.js` files
          // twice — measured 2026-09-11: 10 suite runs (5 suites x 2
          // projects), 160s wall, with `hook-latency.bench.js` alone spending
          // 43s + 45s on the same work. Scoping this to `tests/autopilot/**`
          // (where no `.bench.js` exists today) rather than `[]` keeps the
          // project's ownership rule readable and still admits a future
          // autopilot-specific benchmark without another config edit.
          //
          // `benchmark` belongs under `test:`: vitest
          // 4.0.18 declares `benchmark?: BenchmarkUserOptions` on
          // `InlineConfig`, and `ProjectConfig = Omit<InlineConfig,
          // NonProjectOptions | 'sequencer' | 'deps'>` does not strip it
          // (`NonProjectOptions` has no `benchmark` member). Verified against
          // the shipped `.d.ts` rather than assumed.
          benchmark: {
            include: ['tests/autopilot/**/*.bench.{js,mjs}'],
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'main',
          include: ['tests/**/*.test.{js,mjs}'],
          exclude: ['tests/autopilot/**/*.test.{js,mjs}'],
          // Explicit rather than relying on vitest's default benchmark glob,
          // which also reaches outside `tests/`.
          benchmark: {
            include: ['tests/bench/**/*.bench.{js,mjs}'],
          },
        },
      },
    ],
  },
});
