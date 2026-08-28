/**
 * Firewall — a test that reaches a decision-trail writer must isolate the trail.
 *
 * `getPluginRoot()` falls back to the real plugin directory when
 * `CLAUDE_PLUGIN_ROOT` is unset (`lib/core/platform.js:117-119`), so a test that
 * calls a trail writer without pinning a root appends fixtures to the
 * developer's live `runtime/decision-trail.json`. That is not cosmetic noise:
 * before 7175e251 a sandboxed read followed by a real-root write *replaced* the
 * real trail with fixture data.
 *
 * Measured 2026-08-28: zero test files violate this. The gate exists to keep it
 * that way — the alternative was a suite-wide default-deny, which needed a
 * test-only kill switch in production code. This costs zero production surface.
 *
 * The rule is an ALLOWLIST: a matched file must carry one of the isolation
 * mechanisms enumerated in `MECHANISMS` below. A new mechanism is red until
 * someone registers it here, deliberately — a denylist of "bad patterns" would
 * fail open for every future variant.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - **Indirect reach.** A test that imports some other module which in turn
 *     calls a writer looks clean here. Only the test file's own source is read.
 *   - **Subprocess spawns.** `execFile`/`spawn` of a hook or cron script writes
 *     the real trail from a child process; nothing in the parent test file's
 *     source shows it. `tests/cron/` and much of `tests/hooks/` work this way.
 *   - **Whether the mechanism actually works.** This checks that a recognized
 *     marker is present, not that it is wired correctly or that it covers every
 *     call in the file (a write before `beforeAll` runs would still escape).
 *     Only the entry-delta measurement and
 *     `tests/core/decision-trail-path-isolation.test.js` prove real isolation.
 *   - **Tier-2 precision.** The hook entry point writes only when a slash
 *     command matches EFFORT_POLICY (`scripts/hooks/runtime-prompt.js:544-546`),
 *     so Tier 2 keys on a literal slash-command prompt. A prompt built from a
 *     variable or a template literal slips through.
 *   - **Non-test writers.** Scripts, benchmarks, and `tests/**\/*.bench.js` are
 *     out of scope; only `*.test.js` under `tests/` is scanned.
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS_DIR = path.join(PLUGIN_ROOT, 'tests');

/**
 * Modules that reference `recordDecision`. This is a ratchet, not documentation:
 * if a new module starts writing the trail, the set below stops matching and the
 * gate goes red, forcing whoever added it to decide how tests reach it. Without
 * this the writer axis would fail open — a brand-new writer would simply not be
 * scanned for.
 */
const KNOWN_TRAIL_WRITER_MODULES = [
  'lib/cognitive/router.js',
  'lib/core/decision-trail.js',
  'lib/core/index.js',
  'lib/core/user-profile.js',
  'scripts/cron/auto-cleanup-runner.js',
  'scripts/cron/auto-commit-runner.js',
  'scripts/cron/auto-macro-register-runner.js',
  'scripts/cron/auto-pr-creator.js',
  'scripts/hooks/runtime-prompt.js',
];

/**
 * Tier 1 — library-level writers a test invokes directly and unconditionally.
 * Each entry pairs a call symbol with an import the file must also carry, so an
 * unrelated local helper named `route()` cannot trip the scan (measured:
 * `tests/utils/spawn-mock.test.js` defines exactly such a helper).
 */
const TIER1_WRITERS = [
  { id: 'recordDecision', call: /\brecordDecision\s*\(/, from: /decision-trail\.js|core\/index\.js/ },
  { id: 'recordSignal', call: /\brecordSignal\s*\(/, from: /user-profile\.js|core\/index\.js/ },
  { id: 'route', call: /\broute\s*\(/, from: /cognitive\/router\.js/ },
];

/** Tier 2 — the hook entry point, which writes only on a slash-command prompt. */
const TIER2_HOOK_CALL = /\bhandleUserPromptSubmit\s*\(/;
const TIER2_SLASH_PROMPT = /user_prompt\s*:\s*(['"`])\//;

/**
 * ALLOWLIST of recognized trail-isolation mechanisms. A matched file must show
 * at least one. Anything else is red — including a mechanism that works but is
 * not listed, which is the point: registering it here is a deliberate act.
 */
const MECHANISMS = [
  {
    id: 'useTrailSandbox',
    why: 'the shared helper pins CLAUDE_PLUGIN_ROOT to a throwaway root for the file',
    test: (src) => /\buseTrailSandbox\s*\(/.test(src),
  },
  {
    id: 'self-pinned-root',
    why: 'the file makes its own temp root and assigns CLAUDE_PLUGIN_ROOT to it',
    test: (src) => /\bmkdtemp(Sync)?\s*\(/.test(src)
      && /process\.env\.CLAUDE_PLUGIN_ROOT\s*=/.test(src),
  },
  {
    id: 'module-neutralized',
    why: 'vi.mock replaces decision-trail.js wholesale, so no write reaches disk',
    test: (src) => /vi\.mock\(\s*(['"`])[^'"`]*decision-trail\.js\1/.test(src),
  },
  {
    id: 'state-restore-contract',
    why: 'the file must run against the real root, so it saves and restores the '
      + 'trail instead — see tests/hooks/runtime-prompt-effort-order.test.js:27-42, '
      + 'whose module header explains why a temp root cannot work there '
      + '(lib/cognitive/router.js stops resolving). Verified 2026-08-28: running '
      + 'that suite leaves the live trail md5 unchanged.',
    test: (src) => /STATE-RESTORE/.test(src) && /decision-trail\.json/.test(src),
  },
];

/** Every `*.test.js` under `tests/`, as repo-relative POSIX paths. */
function testFiles(dir = TESTS_DIR, acc = []) {
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, acc);
    else if (entry.name.endsWith('.test.js')) {
      acc.push(path.relative(PLUGIN_ROOT, full).split(path.sep).join('/'));
    }
  }
  return acc;
}

/**
 * Why this source reaches a trail writer, or null if it does not.
 *
 * @param {string} src - File contents.
 * @returns {string|null} Short reason, e.g. 'tier1:recordDecision'.
 */
function reachesWriter(src) {
  for (const { id, call, from } of TIER1_WRITERS) {
    if (call.test(src) && from.test(src)) return `tier1:${id}`;
  }
  if (TIER2_HOOK_CALL.test(src) && TIER2_SLASH_PROMPT.test(src)) return 'tier2:hook-slash-command';
  return null;
}

/** Ids of every recognized mechanism present in this source. */
function mechanismsIn(src) {
  return MECHANISMS.filter((m) => m.test(src)).map((m) => m.id);
}

function readTest(rel) {
  return fsSync.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');
}

describe('tests reaching a decision-trail writer must isolate the trail', () => {
  const files = testFiles();

  it('scans a non-empty set of test files (self-check)', () => {
    // A scanner that silently found nothing to scan would pass forever.
    expect(files.length).toBeGreaterThan(400);
  });

  it('still finds files that reach a writer (self-check)', () => {
    // If the detection regexes rot, every file looks clean and the gate becomes
    // decorative. This asserts the scan is still finding real matches.
    const matched = files.filter((f) => reachesWriter(readTest(f)) !== null);
    expect(matched.length).toBeGreaterThanOrEqual(5);
  });

  it('every file reaching a writer carries an allowlisted mechanism', () => {
    const violations = [];
    for (const rel of files) {
      const src = readTest(rel);
      const why = reachesWriter(src);
      if (!why) continue;
      const found = mechanismsIn(src);
      if (found.length === 0) violations.push(`${rel} (${why})`);
    }
    expect(violations).toEqual([]);
  });

  it('knows every module that references recordDecision (writer-axis ratchet)', () => {
    // A new trail writer must not slip in unscanned. If this fails, add the
    // module above AND decide how tests are expected to reach it.
    const roots = ['lib', 'scripts'];
    const found = [];
    const walk = (dir) => {
      for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')
          && /\brecordDecision\b/.test(fsSync.readFileSync(full, 'utf-8'))) {
          found.push(path.relative(PLUGIN_ROOT, full).split(path.sep).join('/'));
        }
      }
    };
    for (const r of roots) walk(path.join(PLUGIN_ROOT, r));
    expect(found.sort()).toEqual([...KNOWN_TRAIL_WRITER_MODULES].sort());
  });
});

describe('scanner self-verification (positive controls)', () => {
  // Without these the gate could pass because its matchers are broken rather
  // than because the repo is clean. Each control is a source string, so nothing
  // touches disk and no fixture can be left behind.

  it('flags an unisolated writer call', () => {
    const bad = [
      "import { recordDecision } from '../../lib/core/decision-trail.js';",
      "it('x', async () => { await recordDecision({ subsystem: 'a', action: 'b' }); });",
    ].join('\n');
    expect(reachesWriter(bad)).toBe('tier1:recordDecision');
    expect(mechanismsIn(bad)).toEqual([]);
  });

  it('flags an unisolated slash-command hook call (tier 2)', () => {
    const bad = [
      "import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';",
      "it('x', async () => { await handleUserPromptSubmit({ user_prompt: '/implement go' }); });",
    ].join('\n');
    expect(reachesWriter(bad)).toBe('tier2:hook-slash-command');
    expect(mechanismsIn(bad)).toEqual([]);
  });

  it('does not flag a plain-prompt hook call (tier 2 stays off the safe branch)', () => {
    const ok = [
      "import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';",
      "it('x', async () => { await handleUserPromptSubmit({ user_prompt: 'hello there' }); });",
    ].join('\n');
    expect(reachesWriter(ok)).toBeNull();
  });

  it('does not flag an unrelated local route() helper', () => {
    // Guards the two-stage rule. Measured against tests/utils/spawn-mock.test.js,
    // which defines its own `route()` and must never be swept in.
    const ok = "const route = (cmd) => cmd;\nit('x', () => { expect(route('git')).toBe('git'); });";
    expect(reachesWriter(ok)).toBeNull();
  });

  it('recognizes each allowlisted mechanism individually', () => {
    const writer = "import { recordDecision } from '../../lib/core/decision-trail.js';\n"
      + 'await recordDecision({});\n';
    const samples = {
      useTrailSandbox: "useTrailSandbox('x');",
      'self-pinned-root': 'const r = fsSync.mkdtempSync(p);\nprocess.env.CLAUDE_PLUGIN_ROOT = r;',
      'module-neutralized': "vi.mock('../../lib/core/decision-trail.js', () => ({}));",
      'state-restore-contract': '// STATE-RESTORE CONTRACT\nconst f = "decision-trail.json";',
    };
    // Every registered mechanism must have a sample here, or the control is
    // silently narrower than the allowlist it claims to cover.
    expect(Object.keys(samples).sort()).toEqual(MECHANISMS.map((m) => m.id).sort());
    for (const [id, snippet] of Object.entries(samples)) {
      expect(mechanismsIn(writer + snippet)).toContain(id);
    }
  });
});
