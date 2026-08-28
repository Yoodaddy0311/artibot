/**
 * Firewall — a test that reaches an autopilot artifact writer must redirect the
 * artifact root.
 *
 * `generatePRD` and `generateReport` fall back to the resolved project root when
 * the caller omits `projectRoot` (`lib/autopilot/prd-generator.js:220`,
 * `lib/autopilot/report-generator.js:394-396`), so a test that runs the engine
 * without pinning a root writes real files into the developer's `docs/PRD/` and
 * `reports/AUTOPILOT/`. This is not hypothetical: until 5d30cf6b the three
 * crash-recovery smoke cases wrote three PRDs into the repo on every run, and
 * `docs/PRD/` had accumulated 5,840 untracked files by the time it was noticed.
 *
 * Measured 2026-08-28: zero test files violate this. The gate exists to keep it
 * that way. It costs zero production surface — the redirect already exists as a
 * supported option, and this only checks that tests use it.
 *
 * The rule is an ALLOWLIST: a matched file must carry one of the mechanisms in
 * `MECHANISMS`. A new mechanism is red until someone registers it here,
 * deliberately — a denylist of "bad patterns" would fail open for every future
 * variant.
 *
 * Reach detection is two-stage (call symbol AND a matching import), because the
 * bare call names are not unique. Measured: `tests/evals/skill-effectiveness.
 * test.js` and `tests/learning/skill-freshness.test.js` both call a
 * `generateReport()` that belongs to an unrelated module, and neither may be
 * swept in. Both import paths accept the barrel `lib/autopilot/index.js` as well
 * as the concrete module: it re-exports all seven entry points (`index.js:9-13`,
 * `:20`, `:87`, `:119`), and keying only on `engine.js` silently missed
 * `engine.execute-worktree.test.js` and `engine.runner.test.js` in a first pass.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - **Whether the redirect is wired correctly.** This checks that a temp root
 *     and a `projectRoot` binding are both present in the file, not that the
 *     binding reaches every call. A file that pins one call and forgets a second
 *     still passes. Only an actual before/after listing of `docs/PRD/` proves
 *     isolation, which is how 5d30cf6b was verified.
 *   - **Indirect reach.** A test importing some other module that itself calls
 *     the engine looks clean here; only the test file's own source is read.
 *   - **Subprocess spawns of scripts.** A test that `execFile`s a hook or CLI
 *     which runs the engine shows nothing in its own source. The crash smoke is
 *     caught only because the child program is a string literal in the parent.
 *   - **Non-`projectRoot` artifact writers.** `lib/planning/artifacts.js:368`
 *     (`writePRD`) also writes `docs/PRD/`, but is fail-closed — it returns
 *     `{ok:false,'projectRoot required'}` with no fallback, so it cannot leak
 *     and is deliberately out of scope. The ratchet below still watches it, so
 *     that if the fallback is ever added someone has to revisit this decision.
 *   - **Non-test writers.** Scripts, benchmarks, and `tests/**\/*.bench.js` are
 *     out of scope; only `*.test.js` under `tests/` is scanned.
 *   - **Itself.** This file matches its own scan (the positive-control fixtures
 *     are real call/import strings) and passes only because the mechanism
 *     samples below are also real strings. So a future positive control that
 *     deliberately carries NO mechanism — added to a file that has no mechanism
 *     sample either — would make the gate report itself as a violation. If that
 *     happens the fix is to keep the mechanism samples, not to weaken the rule.
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS_DIR = path.join(PLUGIN_ROOT, 'tests');

/**
 * Modules whose artifact path is resolved from a FALLBACK root — the leak
 * shape. A ratchet, not documentation: if a third module starts falling back,
 * the set stops matching and whoever added it must decide how tests reach it.
 */
const KNOWN_FALLBACK_ROOT_WRITERS = [
  'lib/autopilot/prd-generator.js',
  'lib/autopilot/report-generator.js',
];

/**
 * Modules that assemble a repo artifact path at all. Broader than the set
 * above on purpose: keying the ratchet only on the fallback helper name would
 * miss a future writer that resolves its root some other way. The extra entry
 * is `lib/planning/artifacts.js`, which is fail-closed today (see header).
 */
const KNOWN_ARTIFACT_PATH_MODULES = [
  'lib/autopilot/prd-generator.js',
  'lib/autopilot/report-generator.js',
  'lib/planning/artifacts.js',
];

/** Imports that make an autopilot call symbol the real one. */
const WRITER_IMPORT = /autopilot\/(prd-generator|report-generator|index)\.js/;
const ENGINE_IMPORT = /autopilot\/(engine|index)\.js/;

/** Tier 1 — the artifact writers, called directly. */
const TIER1_WRITERS = [
  { id: 'generatePRD', call: /\bgeneratePRD\s*\(/, from: WRITER_IMPORT },
  { id: 'generateReport', call: /\bgenerateReport\s*\(/, from: WRITER_IMPORT },
];

/**
 * Tier 2 — engine entry points that reach a writer transitively.
 * `runPhase0Intake` calls `generatePRD` (`engine.js:127`); `runPhase6Report`
 * and `abortAutopilot` call `generateReport` (`engine.js:561`, `:955`);
 * `startAutopilot` and `resumeAutopilot` drive those phases.
 */
const TIER2_ENGINE_ENTRIES = /\b(startAutopilot|resumeAutopilot|abortAutopilot|runPhase0Intake|runPhase6Report)\s*\(/;

/**
 * ALLOWLIST of recognized redirect mechanisms. A matched file must show at
 * least one. Anything else is red — including a mechanism that works but is not
 * listed, which is the point: registering it here is a deliberate act.
 */
const MECHANISMS = [
  {
    id: 'tmpdir-project-root',
    why: 'the file makes a throwaway directory and binds it to projectRoot, so '
      + 'both writers resolve into it instead of the repo',
    test: (src) => /\bmkdtemp(Sync)?\s*\(/.test(src) && /projectRoot\s*[:=]/.test(src),
  },
  {
    id: 'writer-module-mocked',
    why: 'vi.mock replaces the generator module wholesale, so no write reaches disk',
    test: (src) => /vi\.mock\(\s*(['"`])[^'"`]*autopilot\/(prd-generator|report-generator)\.js\1/
      .test(src),
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
 * Why this source reaches an artifact writer, or null if it does not.
 *
 * @param {string} src - File contents.
 * @returns {string|null} Short reason, e.g. 'tier1:generatePRD'.
 */
function reachesWriter(src) {
  for (const { id, call, from } of TIER1_WRITERS) {
    if (call.test(src) && from.test(src)) return `tier1:${id}`;
  }
  if (TIER2_ENGINE_ENTRIES.test(src) && ENGINE_IMPORT.test(src)) return 'tier2:engine-entry';
  return null;
}

/** Ids of every recognized mechanism present in this source. */
function mechanismsIn(src) {
  return MECHANISMS.filter((m) => m.test(src)).map((m) => m.id);
}

function readTest(rel) {
  return fsSync.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');
}

/** Repo-relative POSIX paths under `roots` whose source matches `re`. */
function modulesMatching(re, roots = ['lib', 'scripts']) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && re.test(fsSync.readFileSync(full, 'utf-8'))) {
        found.push(path.relative(PLUGIN_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  for (const r of roots) walk(path.join(PLUGIN_ROOT, r));
  return found.sort();
}

describe('tests reaching an autopilot artifact writer must redirect the root', () => {
  const files = testFiles();

  it('scans a non-empty set of test files (self-check)', () => {
    // A scanner that silently found nothing to scan would pass forever.
    expect(files.length).toBeGreaterThan(400);
  });

  it('still finds files that reach a writer (self-check)', () => {
    // If the detection regexes rot, every file looks clean and the gate becomes
    // decorative. Measured 2026-08-28: 9 files match — the 8 real ones plus this
    // gate itself, whose fixture strings match the scan (see the header note).
    const matched = files.filter((f) => reachesWriter(readTest(f)) !== null);
    expect(matched.length).toBeGreaterThanOrEqual(6);
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

  it('knows every module whose artifact root is a fallback (leak-shape ratchet)', () => {
    // A new fallback writer must not slip in unscanned. If this fails, add the
    // module above AND decide how tests are expected to reach it.
    expect(modulesMatching(/\bgetProjectRoot\s*\(\s*\)/)).toEqual(
      [...KNOWN_FALLBACK_ROOT_WRITERS].sort(),
    );
  });

  it('knows every module that writes a repo artifact path (harm-site ratchet)', () => {
    // Broader net than the leak-shape ratchet: catches a future writer that
    // resolves its root under a different helper name.
    const re = /'docs',\s*'PRD'|'reports',\s*'AUTOPILOT'/;
    expect(modulesMatching(re)).toEqual([...KNOWN_ARTIFACT_PATH_MODULES].sort());
  });
});

describe('scanner self-verification (positive controls)', () => {
  // Without these the gate could pass because its matchers are broken rather
  // than because the repo is clean. Each control is a source string, so nothing
  // touches disk and no fixture can be left behind.

  /** The exact shape of engine-crash-recovery-smoke.test.js BEFORE 5d30cf6b. */
  const PRE_FIX_SMOKE = [
    "const child = runChild(`",
    "  const { startAutopilot } = await import('./lib/autopilot/engine.js');",
    "  await startAutopilot({",
    "    task: 'crash recovery smoke',",
    "    mode: 'default',",
    "    options: { keepAwake: false, tui: false },",
    "    sessionId: 'crash-smoke-1',",
    "  });",
    "`);",
  ].join('\n');

  it('flags the real pre-fix crash-smoke shape (regression this gate was built for)', () => {
    expect(reachesWriter(PRE_FIX_SMOKE)).toBe('tier2:engine-entry');
    expect(mechanismsIn(PRE_FIX_SMOKE)).toEqual([]);
  });

  it('clears the same file once the tmpdir root is injected', () => {
    const fixed = [
      'const ARTIFACT_ROOT = mkdtempSync(path.join(tmpdir(), "artibot-crash-smoke-"));',
      PRE_FIX_SMOKE.replace(
        'options: { keepAwake: false, tui: false },',
        'options: { keepAwake: false, tui: false, projectRoot: ${JSON.stringify(ARTIFACT_ROOT)} },',
      ),
    ].join('\n');
    expect(reachesWriter(fixed)).toBe('tier2:engine-entry');
    expect(mechanismsIn(fixed)).toContain('tmpdir-project-root');
  });

  it('flags an unisolated direct writer call', () => {
    const bad = [
      "import { generatePRD } from '../../lib/autopilot/prd-generator.js';",
      "it('x', () => { generatePRD({ task: 't', sessionId: 's' }); });",
    ].join('\n');
    expect(reachesWriter(bad)).toBe('tier1:generatePRD');
    expect(mechanismsIn(bad)).toEqual([]);
  });

  it('flags an engine entry reached through the barrel, not just engine.js', () => {
    // Keying only on engine.js missed two real files; this locks the barrel in.
    const bad = [
      "import { abortAutopilot } from '../../lib/autopilot/index.js';",
      "it('x', async () => { await abortAutopilot('s'); });",
    ].join('\n');
    expect(reachesWriter(bad)).toBe('tier2:engine-entry');
  });

  it('does not flag an unrelated generateReport() from another module', () => {
    // Guards the two-stage rule against tests/evals/skill-effectiveness.test.js
    // and tests/learning/skill-freshness.test.js, which must never be swept in.
    const ok = [
      "import { createSkillEvalHarness } from '../../scripts/evals/skill-effectiveness.js';",
      "it('x', () => { expect(harness.generateReport([])).toBeTruthy(); });",
    ].join('\n');
    expect(reachesWriter(ok)).toBeNull();
  });

  it('recognizes each allowlisted mechanism individually', () => {
    const writer = "import { generatePRD } from '../../lib/autopilot/prd-generator.js';\n"
      + 'generatePRD({});\n';
    const samples = {
      'tmpdir-project-root': 'const r = mkdtempSync(p);\nconst o = { projectRoot: r };',
      'writer-module-mocked': "vi.mock('../../lib/autopilot/prd-generator.js', () => ({}));",
    };
    // Every registered mechanism must have a sample here, or the control is
    // silently narrower than the allowlist it claims to cover.
    expect(Object.keys(samples).sort()).toEqual(MECHANISMS.map((m) => m.id).sort());
    for (const [id, snippet] of Object.entries(samples)) {
      expect(mechanismsIn(writer + snippet)).toContain(id);
    }
  });
});
