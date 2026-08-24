import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainEntry } from '../../scripts/hooks/_main-entry.js';

/**
 * scripts/hooks/_main-entry.js — the one direct-run guard every hook gates on.
 *
 * Two separate obligations are pinned here, and they fail for different reasons:
 *
 *   1. The helper is correct under hostile install paths. A false negative is
 *      not a wrong boolean — it is every hook silently doing nothing when
 *      Claude Code spawns it. This is the v4.43.0 regression: the old code
 *      compared `new URL(url).pathname` (percent-ENCODED) against
 *      `process.argv[1]` (a raw filesystem path), so it broke on any path
 *      holding a space, a non-ASCII character, `~` (Windows 8.3 short names
 *      such as HEECHA~1) or `#`.
 *
 *   2. The hooks actually call it. Correctness of the helper is worthless if a
 *      hook re-inlines its own copy — which is exactly the state this module
 *      replaced: 41 `isDirectRun` consts and 11 `isMain` IIFEs, each a place
 *      the fix would have to be repeated. Obligation 1 cannot detect that
 *      drift, so it gets its own scan below.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(HERE, '..', '..', 'scripts', 'hooks');
const BIN_DIR = path.resolve(HERE, '..', '..', 'bin');
const MAIN_ENTRY = pathToFileURL(path.join(HOOKS_DIR, '_main-entry.js')).href;

// ---------------------------------------------------------------------------
// 1. Path encoding
// ---------------------------------------------------------------------------
describe('isMainEntry (path encoding)', () => {
  // A long-form base: the OS temp dir is `…\HEECHA~1\…` on Windows, whose tilde
  // would itself trigger the bug and mask which case is under test.
  const BASE = path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'artibot-main-entry-test');

  const PROBE = [
    `import { isMainEntry } from ${JSON.stringify(MAIN_ENTRY)};`,
    'process.stdout.write(JSON.stringify({ main: isMainEntry(import.meta.url) }));',
  ].join('\n');

  afterAll(() => rmSync(BASE, { recursive: true, force: true }));

  /**
   * Run the probe as its own process from a directory of the given shape.
   * A real spawn is the only way argv[1] and import.meta.url are produced the
   * way production produces them; building both strings by hand would test the
   * test rather than the helper.
   */
  function runProbeIn(dirName) {
    const dir = path.join(BASE, dirName);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'probe.mjs');
    writeFileSync(file, PROBE, 'utf8');
    return JSON.parse(execFileSync(process.execPath, [file], { encoding: 'utf8' })).main;
  }

  it.each([
    ['plain', 'plain'],
    ['a space', 'with space'],
    ['non-ASCII (Korean)', '바탕 화면'],
    ['a tilde (8.3 short name)', 'tilde~name'],
    ['a hash (URL fragment)', 'hash#tag'],
    ['parentheses', 'paren(1)'],
  ])('resolves true when the path contains %s', (_label, dirName) => {
    expect(runProbeIn(dirName)).toBe(true);
  });

  it('stays false when argv[1] is a different file in the same directory', () => {
    // Identity is still the contract — the encoding fix must not degrade into
    // "same folder" matching, which would let an importer fire the hook.
    const dir = path.join(BASE, 'with space');
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, 'other-entry.mjs');
    writeFileSync(probe, PROBE, 'utf8');
    const sibling = path.join(dir, 'sibling.mjs');
    writeFileSync(sibling, `await import(${JSON.stringify(pathToFileURL(probe).href)});`, 'utf8');

    const out = execFileSync(process.execPath, [sibling], { encoding: 'utf8' });
    expect(JSON.parse(out).main).toBe(false);
  });

  it('returns false rather than throwing on a malformed url', () => {
    expect(isMainEntry('not-a-url')).toBe(false);
    expect(isMainEntry(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Convergence — the hooks use the helper instead of re-inlining it
//
// What this gate does NOT see (stated here so its green is not mistaken for a
// stronger claim than it makes):
//
//   - Whether the guard returns TRUE when the hook is actually spawned. This
//     file and import-safety.test.js both only prove inertness on import, so a
//     guard stuck at `false` would satisfy both while silently disabling every
//     hook. That is the v4.43.0 failure mode; detecting it needs a spawn probe
//     (stdin held open: guard true => blocks, guard false => exits at once).
//     Measured by hand on 2026-08-11 — 55/55 stdin-reading hooks ran — but not
//     automated, because a suite that spawns every hook for real is a poor
//     trade at this cost.
//   - Side effects of an import that finishes cleanly. A module that writes a
//     file at module scope passes both gates.
//   - Whether a bin/ entry has ANY direct-run guard. The scan below rejects a
//     re-inlined one, but a bin/ file that simply calls main() at top level is
//     not flagged — see the scope note on the runnable-main() assertion. That
//     is today true of bin/artibot.js, which nothing imports.
//   - The 35 files outside scripts/hooks/ and bin/ that still carry an inline
//     guard (census 2026-08-15: 37 repo-wide, 1 in scripts/hooks/ which is the
//     legitimate home, 2 in bin/). scripts/ci/ holds the worst shapes — a
//     `file://${process.argv[1]}` concat and two `path.basename(argv[1]) ===`
//     compares that match ANY file of that name. Widening to them was left out
//     of this change on purpose: it is 35 files of edits, not a scan change.
// ---------------------------------------------------------------------------
describe('hooks route their direct-run guard through _main-entry.js', () => {
  // `.js` and `.mjs` — the `.mjs` hooks were guarded on 2026-08-11 and are
  // held to the same rule; excluding them is what let four of them run main()
  // unguarded for as long as they did.
  const files = readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .sort();

  // bin/ runs through the SAME assertions rather than a parallel copy: two
  // copies of a rule drift, which is the defect this file exists to prevent.
  // Until 2026-08-15 the scan read scripts/hooks/ alone. A census that day
  // found 37 files repo-wide carrying an inline argv[1] guard and exactly ONE
  // inside the scanned directory — _main-entry.js, the legitimate home. The
  // gate was watching the only place the problem was already solved, while
  // bin/artibot-mcp.mjs had re-inlined the comparison unseen.
  const binFiles = readdirSync(BIN_DIR)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .sort();

  /**
   * Source with comments blanked out. Every scan below looks for code shapes,
   * and these files document the shapes they must not contain — without this,
   * `_dispatcher-utils.js` fails its own gate over the JSDoc on
   * `createFatalHandler`, which names `main().catch(...)` in prose.
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // Hook files keep their bare name; bin/ files are prefixed so a failure names
  // the tree the offender is in.
  const sources = new Map([
    ...files.map((f) => [f, stripComments(readFileSync(path.join(HOOKS_DIR, f), 'utf8'))]),
    ...binFiles.map((f) => [
      'bin/' + f, stripComments(readFileSync(path.join(BIN_DIR, f), 'utf8')),
    ]),
  ]);

  // Pre-existing offenders not yet routed through the helper. NOT a way to
  // pass: the staleness test below fails the moment one is fixed, so an entry
  // cannot outlive the debt it records. Emptied 2026-08-24 when the repo-wide
  // sweep moved every remaining inline guard onto isMainEntry() — its last
  // entry, bin/artibot-dashboard.mjs, is now scanned like everything else.
  const KNOWN_INLINE_GUARD_GAPS = [];

  it('discovers the hook directory (guards against a vacuous pass)', () => {
    // Without this, a moved directory would make every scan below iterate
    // nothing and report success.
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('_main-entry.js');
    expect(files).toContain('_posttooluse-dispatcher.js');
  });

  it('discovers the bin directory (guards against a vacuous pass)', () => {
    expect(binFiles.length).toBeGreaterThan(2);
    expect(binFiles).toContain('artibot-mcp.mjs');
  });

  it('known-gap list has not gone stale', () => {
    // A temporary exemption that outlives its defect becomes permanent silently.
    // Fixing a listed file turns this red, which is the only reliable way the
    // entry gets deleted.
    for (const f of KNOWN_INLINE_GUARD_GAPS) {
      expect(sources.has(f), `${f} is listed as a known gap but is not scanned`)
        .toBe(true);
      expect(sources.get(f).includes('process.argv[1]'),
        `${f} no longer inlines the guard — delete it from KNOWN_INLINE_GUARD_GAPS`)
        .toBe(true);
    }
  });

  it('has no hook resolving process.argv[1] for itself', () => {
    // Name-independent on purpose. An earlier version of this scan matched only
    // `isDirectRun` and `isMain`, and so missed the two nightly-*.mjs hooks,
    // whose identical guard was simply called `invokedDirect` — a gate that
    // greps for the names it happens to know about is a gate that any new name
    // walks straight past. What actually defines the duplication is comparing
    // a resolved argv[1] against this module's own path, so match THAT.
    const offenders = [];
    for (const [file, src] of sources) {
      if (file === '_main-entry.js') continue; // the one legitimate home
      if (KNOWN_INLINE_GUARD_GAPS.includes(file)) continue;
      if (/path\.resolve\(\s*process\.argv\[1\]\s*\)/.test(src)
        || /fileURLToPath\(\s*import\.meta\.url\s*\)\s*===/.test(src)
        || /===\s*path\.resolve\(\s*process\.argv\[1\]\s*\)/.test(src)) {
        offenders.push(`${file} — resolves argv[1] itself instead of calling isMainEntry`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no hook comparing a percent-encoded URL pathname', () => {
    // The precise v4.43.0 defect. Cheap to state, and it is the one shape that
    // looks correct while silently disabling the hook on non-ASCII paths.
    const offenders = [];
    for (const [file, src] of sources) {
      if (/new URL\(\s*import\.meta\.url\s*\)\s*\.pathname/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('imports isMainEntry from a canonical module wherever it is called', () => {
    // _dispatcher-utils.js re-exports the helper, so both specifiers are
    // canonical; a locally defined copy is not.
    const offenders = [];
    for (const [file, src] of sources) {
      if (!src.includes('isMainEntry(import.meta.url)')) continue;
      const imported = /import \{[^}]*\bisMainEntry\b[^}]*\} from '(\.\/_(main-entry|dispatcher-utils)|\.\.\/scripts\/hooks\/_main-entry)\.js'/s.test(src);
      if (!imported) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('gates every hook that has a runnable main() (no unguarded top-level run)', () => {
    // Complements tests/hooks/import-safety.test.js: that harness proves a hook
    // is inert on import, this one names the mechanism, so a hook that becomes
    // inert by accident (e.g. main() quietly deleted) still reads as a failure.
    const offenders = [];
    for (const [file, src] of sources) {
      if (!/\bmain\(\)\.catch\(/.test(src)) continue;
      // Hooks only, deliberately. This assertion protects IMPORT INERTNESS —
      // hooks are imported by tests, so an ungated main() blocks the suite on
      // stdin. bin/ entries are not held to it: nothing imports bin/artibot.js
      // (checked repo-wide 2026-08-15 — only docs reference it), so requiring a
      // guard there would be a NEW policy invented by a scan, not the existing
      // one enforced in a new place. The no-re-inlining rule above does apply
      // to bin/, because that one is about duplication, not import safety.
      if (file.startsWith('bin/')) continue;
      if (!src.includes('isMainEntry(import.meta.url)')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
