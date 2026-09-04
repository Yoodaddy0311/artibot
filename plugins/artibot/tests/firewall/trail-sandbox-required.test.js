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
 * D9 (2026-09-05) SHRANK THE WRITER AXIS. The trail is frozen
 * (`lib/core/decision-trail.js` header): `recordDecision` is a no-op unless the
 * config says `enabled: true`, and every production caller moved to the
 * decisions store or was deleted. So `router.route()` and
 * `user-profile.recordSignal()` are no longer trail writers and are no longer
 * tiers here, the hook entry point no longer writes the trail on a slash
 * command and tier 2 is gone, and `KNOWN_TRAIL_WRITER_MODULES` is down to the
 * module itself plus its barrel. The ratchet is what makes that a fact rather
 * than a claim: a module that starts calling `recordDecision` again turns this
 * gate red. The decisions store has its own gate
 * (`tests/firewall/decisions-store-sandbox-required.test.js`); the two do not
 * overlap and neither covers the other's store.
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
 *   - **The opt-in path only.** Since D9 a test can only reach a trail WRITE by
 *     calling `recordDecision` directly under a root whose config says
 *     `enabled: true`. That is exactly the set this scan keys on; a test that
 *     flips the config on the REAL root and then calls a frozen production path
 *     would write nothing anyway, because no production path calls it.
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
 *
 * D9 (2026-09-05) took this list from nine entries to two. The seven that left
 * — `lib/cognitive/router.js`, `lib/core/user-profile.js`, the four
 * `scripts/cron/` runners and `scripts/hooks/runtime-prompt.js` — either
 * deleted their call or moved to `lib/observability/decision-events.js`. A
 * module re-appearing here is a regression of the freeze, not a new feature.
 */
const KNOWN_TRAIL_WRITER_MODULES = [
  'lib/core/decision-trail.js',
  'lib/core/index.js',
];

/**
 * Tier 1 — the one library-level writer a test can invoke directly. It pairs
 * the call symbol with an import the file must also carry, so an unrelated
 * local helper of the same name cannot trip the scan.
 *
 * `recordSignal` and `route()` were tiers until D9; they no longer write the
 * trail (the former reports through a port, the latter writes nothing), so
 * scanning for them here would be a denylist of yesterday's writers.
 */
const TIER1_WRITERS = [
  { id: 'recordDecision', call: /\brecordDecision\s*\(/, from: /decision-trail\.js|core\/index\.js/ },
];

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
      + 'trail instead. REGISTERED BUT UNUSED as of 2026-08-30: its only holder '
      + 'was tests/hooks/runtime-prompt-effort-order.test.js, which moved to a '
      + 'self-pinned root once the claim behind it ("a temp root cannot resolve '
      + 'lib/cognitive/router.js") was retested and found to hold only for a BARE '
      + 'temp root — linking lib/ in, as runtime-prompt-effort-inject.test.js '
      + 'already did, resolves it. Restoring is also strictly weaker than '
      + 'sandboxing: rewriting the original bytes still stamps a fresh mtime, '
      + 'which produced a months-long mtime/updatedAt contradiction that cost an '
      + 'investigation on 2026-08-29. Prefer a sandbox. Retiring this entry '
      + 'entirely is the tighter option and is left as a deliberate decision for '
      + 'the gate owner — note that it matches on a COMMENT string, so while it '
      + 'stays registered any file can claim it without actually restoring.',
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
    // Measured 2026-09-05 after D9: 4 files (the three decision-trail suites
    // and this file's own control strings). The floor is 3 so a single suite
    // being retired does not read as "the scanner broke".
    const matched = files.filter((f) => reachesWriter(readTest(f)) !== null);
    expect(matched.length).toBeGreaterThanOrEqual(3);
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

  it('does not flag the hook entry point any more (D9: it no longer writes the trail)', () => {
    // Tier 2 used to key on a slash-command prompt. The hook's trail write is
    // gone, so BOTH prompt shapes must read as "no reach" here — the decisions
    // store gate is where the hook is scanned now.
    for (const prompt of ['/implement go', 'hello there']) {
      const src = [
        "import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';",
        `it('x', async () => { await handleUserPromptSubmit({ user_prompt: '${prompt}' }); });`,
      ].join('\n');
      expect(reachesWriter(src)).toBeNull();
    }
  });

  it('does not flag route() or recordSignal() any more (D9: neither writes the trail)', () => {
    const routeCall = [
      "import { route } from '../../lib/cognitive/router.js';",
      "it('x', () => { route('analyze auth'); });",
    ].join('\n');
    expect(reachesWriter(routeCall)).toBeNull();
    const signalCall = [
      "import { recordSignal } from '../../lib/core/user-profile.js';",
      "it('x', async () => { await recordSignal({ type: 'slash-command', value: 'x' }); });",
    ].join('\n');
    expect(reachesWriter(signalCall)).toBeNull();
  });

  it('does not flag a call without the import (two-stage rule)', () => {
    const ok = "const recordDecision = (d) => d;\nit('x', () => { expect(recordDecision(1)).toBe(1); });";
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
