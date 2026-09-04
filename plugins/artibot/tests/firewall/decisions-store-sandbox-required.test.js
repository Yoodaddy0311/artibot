/**
 * Firewall — a test that reaches a DECISIONS-STORE writer must isolate the store.
 *
 * The store is `<projectRoot>/.artibot/runtime/decisions/*.events.ndjson`,
 * resolved by `lib/observability/decision-events.js:187` (`getDecisionStoreDir`):
 * an explicit `storeDir` wins, else an injected `projectRoot`, else
 * `lib/git/project-root.js#resolveProjectRoot(opts.cwd ?? process.cwd())`, which
 * walks UP from the starting directory to the nearest `.git`. A writer called
 * with none of those three pointing into a temp directory therefore appends to
 * the developer's live repo store.
 *
 * CLAUDE_PLUGIN_ROOT AND `useTrailSandbox` DO NOT ISOLATE THIS STORE. Verified
 * 2026-09-04 by grepping `process.env` in both `lib/git/project-root.js` and
 * `lib/git/repo-root-cache.js`: neither reads any environment variable. The
 * trail gate's mechanisms are therefore deliberately absent from `MECHANISMS`
 * below — registering them would fail open for every file that carries one.
 *
 * WHY. On 2026-09-04 the live repo store held
 * `.artibot/runtime/decisions/_unattributed.events.ndjson` (215B, mtime
 * 2026-09-03 18:23) alongside two real session files — the leader session's own
 * tests writing into the store they were auditing ("후속 12 리더 자기 오염
 * 실측"). Plan B (2026-09-04) is the production half: stop `flushRecorderStats`
 * from writing unattributed stats at all. This gate is the test-side half
 * (plan D): keep a test from reaching any writer without pinning the store
 * somewhere disposable.
 *
 * MEASURED FIRST RUN 2026-09-04 12:24 — 619 test files scanned, 11 reached a
 * writer, 1 violation:
 *   tests/firewall/trail-sandbox-required.test.js (tier2:hook-any-prompt)
 * That file never calls the hook. Its positive controls are SOURCE STRINGS that
 * contain both the call and the import path, and it carries none of the four
 * mechanisms because it isolates a different store. A scanner artifact, not a
 * polluter.
 *
 * MEASURED AFTER TIGHTENING 2026-09-04 12:46 — 619 scanned, 10 reached a
 * writer, 0 violations. The fix was on the `from` side: require a real import
 * statement (see `importOf`) instead of the module path appearing anywhere. It
 * dropped the trail gate's file and no real test file.
 *
 * MEASURED AFTER THE ALIAS FIX 2026-09-04 13:15 — 619 scanned, 12 reached a
 * writer, 0 violations. Cross-check found that an aliased import escaped both
 * tiers, so naming a writer in an import clause now counts as reach on its own
 * (see `importNaming`). Two files entered, both already isolated:
 *   tests/e2e/runtime-flow.test.js — aliased tier-2 hook import, clears via
 *     cwd-sandboxed;
 *   tests/runtime/tasks-compile-mission.test.js — multi-line import of
 *     recordWorkflowPlanDecision that it only asserts on as a spy, clears via
 *     module-neutralized.
 * Of the twelve, seven rest on `cwd-sandboxed` alone.
 *
 * One of the twelve is THIS FILE. The dynamic-import alternative in `importOf`
 * is not line-anchored — it cannot be, since `await import(…)` never starts a
 * line — so the control string below that pins dynamic reach also self-matches.
 * It clears the gate on its own sample mechanisms, which is exactly the
 * mechanism-side artifact noted under "WHAT THIS GATE CANNOT SEE". Left as is:
 * anchoring the dynamic form would fail open for every lazily imported writer,
 * which is the more expensive mistake.
 *
 * The rule is an ALLOWLIST: a matched file must carry one of the mechanisms in
 * `MECHANISMS`. An unregistered mechanism is red until someone registers it,
 * deliberately. There is no denylist — a list of bad patterns fails open for
 * every future variant.
 *
 * D9 (2026-09-05) ADDED TWO WRITERS. The decision trail froze and its unique
 * writers moved here: `recordSelfControlDecision` (the four `scripts/cron/`
 * runners) and `recordSkillLevelChanged` (bound by the hook and handed to
 * `lib/core/user-profile.js#recordSignal` as a `recordChange` PORT). Both are
 * tier 1 below. `recordSignal` itself is deliberately NOT a tier: it cannot
 * reach the store without a port, and the only writer a port can carry is a
 * recorder from this module — so a test that binds one must import it and is
 * caught on that name. Scanning for `recordSignal` would flag every profile
 * test that passes no port, which is the false positive the `importOf`
 * tightening was built to avoid. The module ratchet also widened: it now keys
 * on the recorder names as well as the two primitives, so the cron runners and
 * the hook's port-binding site are listed rather than invisible.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - **Indirect reach.** Only the test file's own source is read. A test that
 *     drives `lib/runtime/middleware/router.js#route` or the middleware chain
 *     reaches `recordRoutingDecision` through another module and looks clean.
 *   - **Subprocess spawns.** `execFile`/`spawn` of the hook writes the store
 *     from a child process; nothing in the parent's source shows the call.
 *     `tests/hooks/userprompt-dispatcher.test.js` works this way.
 *   - **Whether the mechanism actually works.** This checks that a marker is
 *     present, not that it is wired to the writer. `cwd-sandboxed` is the
 *     weakest: a `cwd:` key may belong to an `execFile` options object rather
 *     than a recorder option, and the file still passes.
 *   - **Source-string artifacts, on the MECHANISM side only.** The import side
 *     is now hardened (`importOf`), so a quoted import inside a fixture no
 *     longer counts as a reach. The mechanism side is NOT hardened: a file that
 *     merely mentions `storeDir` next to an unrelated `mkdtempSync` satisfies
 *     the allowlist. That is why this file, whose own samples match all four
 *     mechanisms, would pass on markers alone if it ever did reach a writer.
 *   - **Aliased DYNAMIC destructures.** `const { X: y } = await import('…')`
 *     escapes both the call regex and the aliased-import rule, which is static
 *     only. Measured 2026-09-04: zero occurrences repo-wide, so this is a known
 *     hole rather than a live miss. The static alias form IS covered.
 *   - **A port-less `recordSignal`.** `lib/core/user-profile.js#recordSignal`
 *     is not a tier: without a `recordChange` port it never reaches this
 *     store, and a port can only carry a recorder from `decision-events.js`,
 *     which IS scanned for by name. A profile test that passes no port
 *     therefore reads as clean here, correctly.
 *   - **Non-test writers.** Scripts, benchmarks and `tests/**\/*.bench.js` are
 *     out of scope; only `*.test.js` under `tests/` is scanned.
 *   - **Sibling stores.** `lib/autopilot/telemetry.js` and
 *     `lib/observability/split-telemetry.js` anchor their OWN stores under
 *     `<pluginRoot>/runtime/`. They are in the ratchet only because they import
 *     the shared primitive; polluting them is a different bug and this gate
 *     does not protect them.
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS_DIR = path.join(PLUGIN_ROOT, 'tests');

/**
 * Modules referencing `appendRunEvent` or `getDecisionStoreDir`. A ratchet, not
 * documentation: a brand-new store writer would otherwise never be scanned for,
 * so the writer axis would fail open. Measured 2026-09-04.
 *
 * `lib/autopilot/telemetry.js` and `lib/observability/split-telemetry.js` anchor
 * their own stores under `<pluginRoot>/runtime/` and appear here only because
 * they import the shared append primitive.
 */
const KNOWN_DECISION_STORE_MODULES = [
  'lib/autopilot/telemetry.js',
  // D9: the frozen trail's header cites both successors by `file#symbol`. A
  // doc reference, not a reach — listed so the citation can stay.
  'lib/core/decision-trail.js',
  // D9 port site: names `recordSkillLevelChanged` in its JSDoc and reaches it
  // only through the injected `recordChange` port (L1 may not import L2).
  'lib/core/user-profile.js',
  'lib/observability/decision-events.js',
  'lib/observability/run-events.js',
  'lib/observability/split-telemetry.js',
  'lib/runtime/middleware/checkpoint.js',
  'lib/runtime/middleware/router.js',
  // D9: the four self-control runners write `self-control-decided`.
  'scripts/cron/auto-cleanup-runner.js',
  'scripts/cron/auto-commit-runner.js',
  'scripts/cron/auto-macro-register-runner.js',
  'scripts/cron/auto-pr-creator.js',
  // D9: binds `recordSkillLevelChanged` to the session and hands it to the port.
  'scripts/hooks/runtime-prompt.js',
];

/**
 * Source pattern the ratchet walk looks for: the two store primitives plus the
 * two D9 recorders, which reach the store through `record` without naming
 * either primitive. Without the recorder names the four cron runners would be
 * store writers this ratchet never listed.
 */
const STORE_WRITER_REF = /\b(appendRunEvent|getDecisionStoreDir|recordSelfControlDecision|recordSkillLevelChanged)\b/;

/** A module file name as a regex fragment — only `.` needs escaping here. */
function escapeMod(mod) {
  return mod.replace(/\./g, '\\.');
}

/**
 * Patterns that recognize a REAL import of `mod`, as opposed to the module path
 * merely appearing somewhere in the file.
 *
 * The static form anchors at line start with the `m` flag, and `[^;]*?` cannot
 * cross a statement terminator, so a multi-line import list still matches while
 * two unrelated statements cannot be stitched together. This is what keeps a
 * sibling firewall scanner out of the results: its sample imports live inside
 * INDENTED string literals, so `^import` never matches them. Measured
 * 2026-09-04 — tightening this dropped exactly one file, the sibling trail
 * scanner (11 → 10 reaches), and no real test; this file stays in via the
 * dynamic form below. The alias rule then took the count to 12.
 *
 * The dynamic form is listed too because `await import('…')` is a real reach; a
 * line-start-only rule would fail open for every lazily imported writer.
 *
 * @param {string} mod - Module file name, e.g. 'decision-events.js'.
 * @returns {RegExp[]} Alternatives; a file matching any one of them imports it.
 */
function importOf(mod) {
  const esc = escapeMod(mod);
  return [
    new RegExp(`^import\\b[^;]*?from\\s*['"][^'"]*${esc}['"]`, 'm'),
    new RegExp(`import\\(\\s*['"][^'"]*${esc}['"]\\s*\\)`),
  ];
}

/**
 * An import clause of `mod` that NAMES `id`, whether or not it is aliased.
 *
 * WHY THIS EXISTS. An alias renames the local binding, so the call site is
 * spelled with a name the call regex has never heard of and the file reads as
 * "no reach". That is not hypothetical: `tests/e2e/runtime-flow.test.js:7`
 * imports `handleUserPromptSubmit as handleRuntimePrompt` and calls it at :39,
 * and this gate missed it entirely until 2026-09-04. Naming a writer in an
 * import clause IS reach — a file does not import a writer it has no intention
 * of invoking.
 *
 * Static form only. A plain dynamic destructure (`const { X } = await
 * import(…)`) keeps the original spelling and so is caught at its later `X(`
 * call site, which is how `tests/hooks/silent-fail-stderr.test.js:131,151`
 * matches. An ALIASED dynamic destructure (`const { X: y } = await import(…)`)
 * escapes both rules; see "WHAT THIS GATE CANNOT SEE". Measured 2026-09-04:
 * zero occurrences repo-wide, so this is a known hole, not a live miss.
 *
 * @param {string} mod - Module file name.
 * @param {string} id - Exported writer symbol.
 * @returns {RegExp}
 */
function importNaming(mod, id) {
  return new RegExp(
    `^import\\b[^;]*?\\b${id}\\b[^;]*?from\\s*['"][^'"]*${escapeMod(mod)}['"]`,
    'm',
  );
}

/** One tier-1 entry: call spelling, module import, and the aliased-import rule. */
function tier1Writer(id, call, mod) {
  return {
    id, call, from: importOf(mod), named: importNaming(mod, id),
  };
}

/**
 * Tier 1 — writers a test invokes directly. Each pairs a call symbol with an
 * import the file must also carry, so an unrelated local `record()` helper
 * cannot trip the scan.
 */
const TIER1_WRITERS = [
  tier1Writer('appendRunEvent', /\bappendRunEvent\s*\(/, 'run-events.js'),
  tier1Writer('recordRoutingDecision', /\brecordRoutingDecision\s*\(/, 'decision-events.js'),
  tier1Writer('recordWorkflowPlanDecision', /\brecordWorkflowPlanDecision\s*\(/, 'decision-events.js'),
  tier1Writer('recordTopologyRecommended', /\brecordTopologyRecommended\s*\(/, 'decision-events.js'),
  tier1Writer('recordMemoryInjection', /\brecordMemoryInjection\s*\(/, 'decision-events.js'),
  tier1Writer('flushRecorderStats', /\bflushRecorderStats\s*\(/, 'decision-events.js'),
  // D9 (2026-09-05): the trail's unique writers, now store writers.
  tier1Writer('recordSelfControlDecision', /\brecordSelfControlDecision\s*\(/, 'decision-events.js'),
  tier1Writer('recordSkillLevelChanged', /\brecordSkillLevelChanged\s*\(/, 'decision-events.js'),
];

/**
 * Tier 2 — the hook entry point. Unlike the trail gate there is NO
 * slash-command condition: `scripts/hooks/runtime-prompt.js:603`
 * (`recordObserveOnlyDecisions`, called at :785) calls
 * `recordTopologyRecommended` on EVERY prompt, so any prompt writes the store.
 */
const TIER2_HOOK_CALL = /\bhandleUserPromptSubmit\s*\(/;
const TIER2_HOOK_FROM = importOf('runtime-prompt.js');
const TIER2_HOOK_NAMED = importNaming('runtime-prompt.js', 'handleUserPromptSubmit');

/** True when `src` creates a throwaway directory of its own. */
const HAS_MKDTEMP = /\bmkdtemp(Sync)?\s*\(/;

/**
 * ALLOWLIST of recognized store-isolation mechanisms. A matched file must show
 * at least one; anything else is red, including a mechanism that works but is
 * not listed. Registering one here is the decision.
 */
const MECHANISMS = [
  {
    id: 'storeDir-injected',
    why: 'the strongest form — an explicit storeDir short-circuits resolution '
      + 'before project-root is ever consulted (decision-events.js:189). Matched '
      + 'as a bare word because the shorthand `{ storeDir }` has no colon.',
    test: (src) => /\bstoreDir\b/.test(src) && HAS_MKDTEMP.test(src),
  },
  {
    id: 'projectRoot-injected',
    why: 'an injected projectRoot pins the store one level lower than storeDir, '
      + 'still without touching the real repo (decision-events.js:190-192).',
    test: (src) => /\bprojectRoot\b/.test(src) && HAS_MKDTEMP.test(src),
  },
  {
    id: 'cwd-sandboxed',
    why: 'a payload cwd only pins the store when the temp directory also holds a '
      + '.git marker: resolveProjectRoot walks UP to the nearest .git, so a BARE '
      + 'temp cwd climbs straight out of tmpdir and lands on a real repo root. '
      + 'The planted marker is what makes the claim true, so it is required here. '
      + 'This is how tests/hooks/runtime-prompt-decision-wiring.test.js:100-113 '
      + '(makeSandbox) and tests/hooks/silent-fail-stderr.test.js:34-41 work.',
    test: (src) => /\bcwd\s*:/.test(src) && HAS_MKDTEMP.test(src)
      && /['"`]\.git['"`]/.test(src),
  },
  {
    id: 'module-neutralized',
    why: 'vi.mock replaces the append primitive or the recorder wholesale, so no '
      + 'write reaches disk regardless of how the root resolves',
    test: (src) => /vi\.mock\(\s*(['"`])[^'"`]*run-events\.js\1/.test(src)
      || /vi\.mock\(\s*(['"`])[^'"`]*decision-events\.js\1/.test(src),
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
 * Why this source reaches a decisions-store writer, or null if it does not.
 *
 * @param {string} src - File contents.
 * @returns {string|null} Short reason, e.g. 'tier1:recordRoutingDecision'.
 */
function reachesWriter(src) {
  // Two stages: the file must import the module AND either call the writer or
  // name it in the import clause. The second disjunct is what catches an alias.
  for (const {
    id, call, from, named,
  } of TIER1_WRITERS) {
    if (!from.some((re) => re.test(src))) continue;
    if (call.test(src) || named.test(src)) return `tier1:${id}`;
  }
  if (TIER2_HOOK_FROM.some((re) => re.test(src))
    && (TIER2_HOOK_CALL.test(src) || TIER2_HOOK_NAMED.test(src))) {
    return 'tier2:hook-any-prompt';
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

/** Repo-relative `.js` files under `lib/` and `scripts/` whose source matches. */
function modulesMatching(pattern) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && pattern.test(fsSync.readFileSync(full, 'utf-8'))) {
        found.push(path.relative(PLUGIN_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  for (const root of ['lib', 'scripts']) walk(path.join(PLUGIN_ROOT, root));
  return found.sort();
}

describe('tests reaching a decisions-store writer must isolate the store', () => {
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
      if (mechanismsIn(src).length === 0) violations.push(`${rel} (${why})`);
    }
    expect(violations).toEqual([]);
  });

  it('knows every module that touches the decisions store (writer-axis ratchet)', () => {
    // A new store writer must not slip in unscanned. If this fails, add the
    // module above AND decide how tests are expected to reach it.
    expect(modulesMatching(STORE_WRITER_REF))
      .toEqual([...KNOWN_DECISION_STORE_MODULES].sort());
  });
});

describe('scanner self-verification (positive controls)', () => {
  // Without these the gate could pass because its matchers are broken rather
  // than because the repo is clean. Each control is a source string, so nothing
  // touches disk and no fixture can be left behind.

  it('flags an unisolated recorder call', () => {
    const bad = [
      "import { recordTopologyRecommended } from '../../lib/observability/decision-events.js';",
      "it('x', () => { recordTopologyRecommended('run-1', {}); });",
    ].join('\n');
    expect(reachesWriter(bad)).toBe('tier1:recordTopologyRecommended');
    expect(mechanismsIn(bad)).toEqual([]);
  });

  it('flags the two D9 recorders like any other tier-1 writer', () => {
    const selfControl = [
      "import { recordSelfControlDecision } from '../../lib/observability/decision-events.js';",
      "it('x', () => { recordSelfControlDecision('cron-x', { subsystem: 'auto-commit', action: 'refused' }); });",
    ].join('\n');
    expect(reachesWriter(selfControl)).toBe('tier1:recordSelfControlDecision');
    expect(mechanismsIn(selfControl)).toEqual([]);

    const skill = [
      "import { recordSkillLevelChanged } from '../../lib/observability/decision-events.js';",
      "it('x', () => { recordSkillLevelChanged('sess-1', { from: 'novice', to: 'pro' }); });",
    ].join('\n');
    expect(reachesWriter(skill)).toBe('tier1:recordSkillLevelChanged');
    expect(mechanismsIn(skill)).toEqual([]);

    // A port-less recordSignal call reaches no store and must stay clean.
    const portless = [
      "import { recordSignal } from '../../lib/core/user-profile.js';",
      "it('x', async () => { await recordSignal({ type: 'slash-command', value: 'x' }); });",
    ].join('\n');
    expect(reachesWriter(portless)).toBeNull();
  });

  it('flags an unisolated hook call on a plain prompt (tier 2)', () => {
    // The trail gate lets a plain prompt through; this one must not, because
    // recordObserveOnlyDecisions fires on every prompt regardless of content.
    const bad = [
      "import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';",
      "it('x', async () => { await handleUserPromptSubmit({ user_prompt: 'hello' }); });",
    ].join('\n');
    expect(reachesWriter(bad)).toBe('tier2:hook-any-prompt');
    expect(mechanismsIn(bad)).toEqual([]);
  });

  it('does not flag unrelated local helpers', () => {
    // Guards the two-stage rule: the call symbol alone must never be enough.
    const localRecord = "const record = (e) => e;\nit('x', () => { expect(record(1)).toBe(1); });";
    expect(reachesWriter(localRecord)).toBeNull();

    const localAppend = 'const appendEvent = (e) => e;\nappendEvent({});';
    expect(reachesWriter(localAppend)).toBeNull();

    const callWithoutImport = "it('x', () => { appendRunEvent(dir, 'r', {}); });";
    expect(reachesWriter(callWithoutImport)).toBeNull();

    // A quoted import inside a fixture is a mention, not a reach. This is the
    // exact shape that made the sibling firewall scanner a false positive.
    const quoted = [
      'const sample = [',
      '      "import { recordRoutingDecision } from \'../../lib/observability/decision-events.js\';",',
      '      "recordRoutingDecision(id, {});",',
      "].join('\\n');",
    ].join('\n');
    expect(reachesWriter(quoted)).toBeNull();

    // But a dynamic import IS a reach — the tightening must not fail open here.
    const dynamic = "const m = await import('../../lib/observability/decision-events.js');\n"
      + 'm.recordRoutingDecision(id, {});';
    expect(reachesWriter(dynamic)).toBe('tier1:recordRoutingDecision');
  });

  it('flags aliased and multi-line imports of a writer', () => {
    // An alias renames the binding, so the call site is spelled with a name the
    // call regex never sees. Modelled on tests/e2e/runtime-flow.test.js:7,39,
    // which this gate missed until 2026-09-04.
    const aliasedTier1 = [
      "import { recordTopologyRecommended as rec } from '../../lib/observability/decision-events.js';",
      "it('x', () => { rec('run-1', {}); });",
    ].join('\n');
    expect(reachesWriter(aliasedTier1)).toBe('tier1:recordTopologyRecommended');
    expect(mechanismsIn(aliasedTier1)).toEqual([]);

    const aliasedTier2 = [
      "import { handleUserPromptSubmit as handleRuntimePrompt } from '../../scripts/hooks/runtime-prompt.js';",
      "it('x', async () => { await handleRuntimePrompt({ user_prompt: 'hi' }); });",
    ].join('\n');
    expect(reachesWriter(aliasedTier2)).toBe('tier2:hook-any-prompt');

    // Most real reaching files write the import across several lines. If a
    // future tightening swaps `[^;]` for `[^;\n]`, this goes red instead of
    // silently dropping them from the scan.
    const multiline = [
      'import {',
      '  recordRoutingDecision,',
      '  resolveDecisionRunId,',
      "} from '../../lib/observability/decision-events.js';",
      "it('x', () => { recordRoutingDecision('run-1', {}); });",
    ].join('\n');
    expect(reachesWriter(multiline)).toBe('tier1:recordRoutingDecision');
  });

  it('recognizes each allowlisted mechanism individually', () => {
    const writer = "import { recordRoutingDecision } from '../../lib/observability/decision-events.js';\n"
      + "recordRoutingDecision('run-1', {});\n";
    const samples = {
      'storeDir-injected': 'const d = mkdtempSync(p);\nrecordRoutingDecision(id, c, { storeDir: d });',
      'projectRoot-injected': 'const r = mkdtempSync(p);\nrecordRoutingDecision(id, c, { projectRoot: r });',
      'cwd-sandboxed': "const r = mkdtempSync(p);\nmkdirSync(path.join(r, '.git'));\nrunHook({ cwd: r });",
      'module-neutralized': "vi.mock('../../lib/observability/run-events.js', () => ({}));",
    };
    // Every registered mechanism must have a sample here, or the control is
    // silently narrower than the allowlist it claims to cover.
    expect(Object.keys(samples).sort()).toEqual(MECHANISMS.map((m) => m.id).sort());
    for (const [id, snippet] of Object.entries(samples)) {
      expect(mechanismsIn(writer + snippet)).toContain(id);
    }
  });

  it('does not accept a bare temp cwd without a planted .git marker', () => {
    // The distinguishing claim of cwd-sandboxed: without the marker
    // resolveProjectRoot climbs out of tmpdir to a real repo root.
    const bare = 'const r = mkdtempSync(p);\nrunHook({ cwd: r });';
    expect(mechanismsIn(bare)).not.toContain('cwd-sandboxed');
  });
});
