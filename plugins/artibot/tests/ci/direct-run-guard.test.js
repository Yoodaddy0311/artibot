/**
 * Regression pins for the "run main() only when invoked directly" guards.
 *
 * Why this file exists: a direct-run guard that answers FALSE on a real direct
 * run is fail-OPEN in the quietest possible way — the script prints nothing and
 * exits 0, so every caller (CI step, npm script, cron) reads it as a pass. The
 * hook fleet already hit this twice and routed through
 * `scripts/hooks/_main-entry.js#isMainEntry`; the standalone scripts under
 * `scripts/` never did, and one of them still compared a percent-ENCODED
 * `import.meta.url` against a RAW `process.argv[1]`.
 *
 * There are two independent ways for the two spellings to disagree. Both are
 * pinned here, each by a probe that must demonstrate the failure — a detector
 * that cannot show a red proves nothing when it is green.
 *
 * AXIS 1 — encoding. Measured 2026-08-24 on node v24.15.0 (Windows) by running
 * one probe per guard shape out of a directory literally named
 * `한글 경로 테스트`:
 *
 * The `pin` column says whether a test in THIS file re-runs that row. `pin`
 * rows fail CI the day they change; `1x` rows are a dated observation from the
 * session below and nothing re-checks them — do not read a green run as
 * re-confirming them. 5 of the 13 rows across both tables are pinned.
 *
 *   shape                                            ASCII    Korean   pin
 *   path.resolve(argv1) === fileURLToPath(meta.url)  FIRED    FIRED    1x
 *   path.basename(argv1) === '<name>'                FIRED    FIRED    1x
 *   meta.url === `file://${argv1}` || endsWith(name) FIRED    FIRED    1x
 *   meta.url === pathToFileURL(argv1).href           FIRED    FIRED    1x
 *   meta.url.endsWith(argv1.replace(/\\/g,'/'))      FIRED    SILENT   pin  <-- bug
 *   isMainEntry(import.meta.url)                     FIRED    FIRED    pin
 *
 * Only the `endsWith` shape breaks, because it is the only one that compares the
 * two spellings without decoding either side. Note the bug is NOT dodged by
 * invoking the script with a relative path: node absolutises `process.argv[1]`
 * before the script sees it, so `node harness-ablation.js` from the repo root
 * still lands on the raw absolute Korean path.
 *
 * AXIS 2 — links. Node resolves the MAIN module to its realpath before handing
 * it to `import.meta.url`, while `process.argv[1]` stays exactly as the command
 * spelled it, so every guard that compares the two by *path identity* goes
 * silent when the script is reached through a symlink or a Windows junction.
 * Measured 2026-08-24 on node v24.15.0 (Windows 11) with one junction
 * (`link` -> `real`) over one probe file:
 *
 *   shape                                            direct   junction pin
 *   path.resolve(argv1) === fileURLToPath(meta.url)  FIRED    SILENT   pin  <-- bug
 *   meta.url === pathToFileURL(argv1).href           FIRED    SILENT   pin  <-- bug
 *   path.resolve(argv1) === path.resolve(__filename) FIRED    SILENT   1x   <-- bug
 *   path.basename(argv1) === '<name>'                FIRED    FIRED    1x
 *   argv1.endsWith('<name>')                         FIRED    FIRED    1x
 *   meta.url === `file://${argv1}`                   SILENT   SILENT   1x
 *   isMainEntry(import.meta.url)                     FIRED    FIRED    pin
 *
 * The two axes are orthogonal and hit disjoint shape sets: `basename`/`endsWith`
 * survive links precisely because they throw the directory away, and the
 * `file://` concat is dead on Windows either way (argv[1] uses backslashes and
 * the URL needs a `file:///` triple slash). Only `isMainEntry` clears both, by
 * decoding with `fileURLToPath` and falling back to a realpath compare.
 *
 * WHY THE SCAN IS AN ALLOWLIST. The scan below does not enumerate broken
 * shapes. A deny-list of known-bad spellings is fail-open against the next
 * spelling somebody invents — and the table above already shows six of them.
 * It asserts the inverse: no file under `scripts/`, `bin/` or `lib/` may derive
 * an entry-point decision from `process.argv[1]` at all. One spelling is
 * allowed, `isMainEntry(import.meta.url)`, and it neither binds argv nor reads
 * slot 1, so a migrated file scans clean by construction. Exactly one file is
 * exempt — `scripts/hooks/_main-entry.js`, which *is* the canonical
 * implementation — and that exemption is itself pinned so it cannot quietly
 * grow.
 *
 * That "by construction" was FALSE until 2026-08-24: the rule was a presence
 * check on the literal spelling `process.argv[1]`, so an UNMIGRATED file scanned
 * clean too as soon as it aliased — `scripts/media/watch-ingest.js` did exactly
 * that with `import { argv } from 'node:process'`. An allowlist naming one
 * spelling is a deny-list of every other one wearing the wrong label. See
 * `derivesEntryFromRawArgv` for the property that replaced it.
 *
 * WHAT THIS FILE STILL DOES NOT COVER (do not read a green here as more than
 * it is):
 *   - A file with no guard at all. A module that just calls `main()` at top
 *     level never mentions `argv[1]`, so it scans clean while being wrong in
 *     the opposite direction (fires on a plain import). Nothing here sees it.
 *   - Whether `isMainEntry` is used *correctly*. Passing something other than
 *     `import.meta.url`, or computing the guard and then ignoring it, scans
 *     clean.
 *   - The runtime fallback inside `isMainEntry`: when `realpathSync` throws
 *     (deleted file, permission denied) it returns the path as given, so the
 *     link case degrades back to the string compare. Not exercised here.
 *   - `.ts`/`.cjs` sources, and anything outside `scripts/`, `bin/`, `lib/`.
 *   - Comment handling is deliberately coarse: a comment is only stripped when
 *     it OPENS its line, whether `//` or `/*`. An `argv[1]` mentioned in an
 *     inline or trailing comment is still flagged. That is the fail-closed
 *     direction (a visible false positive, never a silent miss), but it means a
 *     red here can be a prose hit — read the offender before editing it. The
 *     opposite direction, blanking real code, is what `never blanks a line of
 *     real code` pins against the live tree.
 *   - Non-Windows link behaviour is UNVERIFIED by measurement. `symlinkSync`
 *     ignores the `'junction'` type off Windows and makes a plain symlink;
 *     the junction tests assert their own precondition (that the link really
 *     does make `argv[1]` and `import.meta.url` disagree) and fail loudly
 *     rather than skipping if a platform behaves differently.
 *
 * @module tests/ci/direct-run-guard
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');
const MAIN_ENTRY = path.join(SCRIPTS_DIR, 'hooks', '_main-entry.js');

/** Source trees that may hold a direct-run guard. */
const SOURCE_ROOTS = ['scripts', 'bin', 'lib'];

/**
 * The only file allowed to compare `process.argv[1]` by hand: the canonical
 * helper itself. Kept as a list so the exemption count is a pinned number
 * rather than a special case buried in a filter.
 *
 * This is a PERMANENT structural exemption, not a debt ledger. The helper has
 * to compare `argv[1]` — that is what it is for — so the entry will never be
 * "paid off" and must not be put under a staleness check that exists to force
 * its deletion.
 *
 * The debt ledger is a different list living in
 * `tests/hooks/main-entry.test.js#KNOWN_INLINE_GUARD_GAPS` (empty as of
 * 2026-08-24). This scan deliberately does NOT read it: adding an entry there
 * silences that test but leaves this one red, so deferring a guard fix stays an
 * explicit decision someone has to make twice rather than a quiet pass. If a
 * future deferral is genuinely warranted, widen this exemption on purpose and
 * say why — do not teach this scan to honour the other list.
 */
const SCAN_EXEMPT = ['scripts/hooks/_main-entry.js'];

/** A directory name with both non-ASCII characters and a space — the shape that broke. */
const KOREAN_DIR_NAME = '한글 경로 테스트';

/**
 * The guard shape that fails on encoding: percent-encoded URL suffix-matched
 * against a raw filesystem path. Kept verbatim so the probe proves the bug still
 * reproduces — a detector that cannot demonstrate a failure proves nothing when
 * it is green.
 */
const BROKEN_SHAPE =
  "const fired = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\\\/g, '/'));";

/** The guard shape that fails on links: path identity, correctly decoded. */
const RESOLVE_SHAPE = [
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  'const fired = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);',
].join('\n');

/** The other link-fragile shape: URL identity, built from the raw argv spelling. */
const PATH_TO_FILE_URL_SHAPE = [
  "import { pathToFileURL } from 'node:url';",
  'const fired = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;',
].join('\n');

/** The canonical shape, exercising the REAL helper rather than a copy of it. */
const CANONICAL_SHAPE = [
  `import { isMainEntry } from ${JSON.stringify(pathToFileURL(MAIN_ENTRY).href)};`,
  'const fired = isMainEntry(import.meta.url);',
].join('\n');

const EMIT = "\nprocess.stdout.write(fired ? 'FIRED' : 'SILENT');\n";

let sandbox;

/**
 * Write `body` into `dir/probe.mjs` and run it as a real child process, from
 * `runFrom/probe.mjs` when that differs — which is how the link axis is
 * exercised: the file lives under the real directory, the command names it
 * through the junction.
 *
 * Any spawn failure throws rather than returning a falsy value; a probe that
 * silently reported SILENT on a crash would turn this whole file into a rubber
 * stamp.
 *
 * @param {string} dir directory to host the probe
 * @param {string} body probe source
 * @param {{ runFrom?: string }} [opts]
 * @returns {string} trimmed stdout
 */
function spawnProbe(dir, body, { runFrom = dir } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'probe.mjs'), body, 'utf8');
  return execFileSync(process.execPath, [path.join(runFrom, 'probe.mjs')], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Run a guard probe and return its verdict.
 *
 * @param {string} dir directory to host the probe
 * @param {string} body guard source, must assign `fired`
 * @param {{ runFrom?: string }} [opts]
 * @returns {'FIRED'|'SILENT'}
 */
function probe(dir, body, opts) {
  const out = spawnProbe(dir, body + EMIT, opts);
  if (out !== 'FIRED' && out !== 'SILENT') {
    throw new Error(`probe emitted unexpected output: ${JSON.stringify(out)}`);
  }
  return out;
}

/**
 * Create `linkDir` as a junction (Windows) or symlink (elsewhere) pointing at
 * `realDir`, then PROVE it resolves there.
 *
 * Fail-closed on purpose. If the link cannot be created — no privilege, a
 * filesystem without link support — this throws with the underlying cause
 * rather than skipping, because a skipped link test is indistinguishable from a
 * passing one in CI output and would leave the axis unguarded while looking
 * green. Verifying the resolution too means a link that silently landed
 * somewhere else cannot make the assertions vacuous.
 *
 * @param {string} realDir link target, created if absent
 * @param {string} linkDir path of the link to create
 */
function makeJunction(realDir, linkDir) {
  mkdirSync(realDir, { recursive: true });
  try {
    symlinkSync(realDir, linkDir, 'junction');
  } catch (err) {
    throw new Error(
      `could not create a junction/symlink ${linkDir} -> ${realDir} ` +
        `(${err?.code ?? 'no code'}: ${err?.message ?? err}). The link axis must not go ` +
        'unexercised: fix the environment or the test, do not skip this.',
      { cause: err },
    );
  }
  const viaLink = path.resolve(realpathSync(linkDir));
  const viaReal = path.resolve(realpathSync(realDir));
  if (viaLink !== viaReal) {
    throw new Error(`link ${linkDir} resolves to ${viaLink}, expected ${viaReal}`);
  }
}

/**
 * Every `.js`/`.mjs` under `dir`, walked recursively.
 *
 * Whether this actually reached the whole tree is asserted by the caller, not
 * promised here — see the coverage assertion in the scan tests below.
 *
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function collectScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectScripts(full));
    else if (/\.(js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every scannable source file across all three roots.
 *
 * @returns {string[]} absolute file paths
 */
function collectSources() {
  return SOURCE_ROOTS.flatMap((root) => collectScripts(path.join(PLUGIN_ROOT, root)));
}

/**
 * Plugin-root-relative path with forward slashes, so assertion output reads the
 * same on both CI platforms.
 *
 * @param {string} file absolute path
 * @returns {string}
 */
function relPosix(file) {
  return path.relative(PLUGIN_ROOT, file).split(path.sep).join('/');
}

/**
 * Blank out comments so prose ABOUT the bug does not read as the bug.
 * `bin/artibot-mcp.mjs` documents its own migration in a comment block that
 * names both `process.argv[1]` and `import.meta.url`; without this it would be
 * a permanent false positive.
 *
 * Deliberately not a lexer. A hand-rolled string/regex state machine desyncs on
 * one unbalanced quote and then blanks out real code — a scanner that quietly
 * stops seeing its own subject matter is the worst possible failure here, since
 * it reports green.
 *
 * BOTH rules are line-anchored, and that anchor is the whole point. An earlier
 * revision matched `/\*[\s\S]*?\*\/` anywhere, so a STRING holding `/*` opened a
 * comment that ran to the next `*\/` and erased every line between — measured
 * 2026-08-24 across `scripts/`+`bin/`+`lib/`: 7 files, 170 lines, worst
 * `scripts/export-to-tool.mjs` at 96. `lib/genesis/scaffold-gen.js:252` is the
 * clean example: it emits a JSDoc header as string literals, so `'/**',` opened
 * and `' *\/',` closed. Requiring the opener to start its line fixes it, because
 * in every such case the quote comes first.
 *
 * What this trades away, on purpose: an INLINE or TRAILING block comment
 * (`foo(); /* note *\/`) is not stripped, and neither is a `//` that does not
 * open its line. Those only leave comment text in view, which can over-report —
 * a visible false positive. That is the safe direction. Blanking real code
 * under-reports in silence, and `never blanks a line of real code` below
 * asserts against the actual tree that it does not happen.
 *
 * @param {string} source
 * @returns {string} source with comments replaced by blanks (newlines kept)
 */
function stripComments(source) {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

/**
 * Slot 1 of an argv-shaped array, however it is reached: `[1]`, `?.[1]`,
 * `.at(1)`, `?.at(1)`. Index 1 is the entry-point idiom specifically —
 * `slice(2)` and friends are deliberately not matched.
 */
const SLOT_ONE = String.raw`\s*(?:(?:\?\s*\.)?\s*\[\s*1\s*\]|\??\s*\.\s*at\s*\(\s*1\s*\))`;

/** Slot 1 read straight off `process.argv`, including the bracket-property spelling. */
const DIRECT_ARGV1 = new RegExp(
  String.raw`process\s*\??\s*(?:\.\s*argv|\[\s*(['"])argv\1\s*\])` + SLOT_ONE,
);

/**
 * Bindings that hand the WHOLE `process.argv` array to a local name. The alias
 * name is capture 1 where the syntax can rename, and plain `argv` otherwise.
 *
 * `.slice(...)` is excluded by the lookahead on the assignment form: a
 * slice-derived local is a list of USER arguments, where index 1 is the second
 * flag and carries none of the entry-point meaning this scan is about. Flagging
 * those is a false positive against real code — three live files take an `argv`
 * parameter of exactly that kind.
 */
const ARGV_ALIAS_BINDINGS = [
  // import { argv } from 'node:process'   /   import { argv as a } from 'process'
  /import\s*\{[^}]*\bargv\b(?:\s+as\s+([A-Za-z_$][\w$]*))?[^}]*\}\s*from\s*['"](?:node:)?process['"]/g,
  // const a = process.argv;
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\s*\.\s*argv\b(?!\s*\.)/g,
  // const { argv } = process;   /   const { argv: a } = process;
  /(?:const|let|var)\s*\{[^}]*\bargv\b(?:\s*:\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=\s*process\b/g,
];

/** Every `<identifier>`-rooted slot-1 read, captured by the base identifier. */
const INDEX_ONE_ACCESS = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)` + SLOT_ONE, 'g');

/**
 * Local names this file has bound to the whole `process.argv` array.
 *
 * @param {string} code comment-stripped source
 * @returns {Set<string>}
 */
function argvAliases(code) {
  const names = new Set();
  for (const re of ARGV_ALIAS_BINDINGS) {
    for (const m of code.matchAll(re)) names.add(m[1] ?? 'argv');
  }
  return names;
}

/**
 * Does this file decide "am I the entry point?" from a raw `process.argv[1]`
 * instead of the canonical helper?
 *
 * Allowlist by construction: `isMainEntry(import.meta.url)` neither binds argv
 * nor reads slot 1, so this returns false for a migrated file no matter how the
 * rest of it is written, and true for every hand-rolled comparison — including
 * spellings that do not exist yet.
 *
 * WHY THIS IS NOT ONE REGEX. It used to be `/process\s*\.\s*argv\s*\[\s*1\s*\]/`,
 * a presence rule on ONE spelling — a string, not a property. Measured
 * 2026-08-24 it answered `false` on `scripts/media/watch-ingest.js`, which
 * aliased via `import { argv } from 'node:process'` and so never wrote that
 * text while its guard was still hand-rolled: the scan was green on its own
 * subject matter. The rule is now "reach argv slot 1 through ANY binding" —
 * read it directly, or bind it and read the binding.
 *
 * Note it flags the link-SAFE shapes (`basename`, `endsWith`) too. That is not
 * a claim that they break through a junction — measured, they do not. They are
 * flagged because they match on filename alone, so any same-named file in the
 * process tree fires them, and because one canonical spelling is cheaper to
 * keep correct than five conditionally-correct ones.
 *
 * What it still cannot see, so a green is not read as more than it is: an alias
 * laundered through a parameter or return (`f(process.argv)` then `a[1]` inside
 * `f`), argv passed across a module boundary, and a computed index (`argv[n]`
 * where `n` is 1 at runtime). All three need a real binder to see; none appears
 * in the live tree as of 2026-08-24.
 *
 * @param {string} source
 * @returns {boolean}
 */
function derivesEntryFromRawArgv(source) {
  const code = stripComments(source);
  if (DIRECT_ARGV1.test(code)) return true;
  const aliases = argvAliases(code);
  if (aliases.size === 0) return false;
  for (const m of code.matchAll(INDEX_ONE_ACCESS)) {
    if (aliases.has(m[1])) return true;
  }
  return false;
}

/**
 * Flag the one unambiguously broken encoding shape:
 * `import.meta.url.endsWith(...)` applied to something derived from
 * `process.argv[1]`.
 *
 * Narrower than `derivesEntryFromRawArgv` on purpose, and kept alongside it:
 * this one names the specific defect that shipped, so the axis-1 pin stays
 * legible even if the broad scan is ever relaxed.
 *
 * @param {string} source
 * @returns {boolean}
 */
function hasEncodedVsRawCompare(source) {
  return /import\.meta\.url\s*\.endsWith\s*\([^;]*process\.argv\[1\]/.test(source);
}

beforeAll(() => {
  // Canonicalise: on Windows `tmpdir()` frequently reports an 8.3 short name
  // (`C:\Users\HEECHA~1\...`). Node resolves the main module to its realpath for
  // `import.meta.url` but leaves `process.argv[1]` short, so a short-name temp
  // dir makes even a pure-ASCII probe go SILENT — which would let the Korean
  // case "pass" for the wrong reason and prove nothing about encoding.
  // `.native` is not guaranteed on every platform, so fall back the same way
  // scripts/hooks/_main-entry.js does rather than diverging from it.
  const canonicalise = realpathSync.native || realpathSync;
  sandbox = canonicalise(mkdtempSync(path.join(tmpdir(), 'artibot-direct-run-')));
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('direct-run guard behaviour under a non-ASCII path', () => {
  it('reproduces the fail-open: the encoded-vs-raw shape goes silent on a Korean path', () => {
    const asciiDir = path.join(sandbox, 'plain');
    const koreanDir = path.join(sandbox, KOREAN_DIR_NAME);

    // Both halves matter. ASCII FIRED proves the probe is wired up at all;
    // Korean SILENT proves the defect is real and not an artifact of the probe.
    expect(probe(asciiDir, BROKEN_SHAPE)).toBe('FIRED');
    expect(probe(koreanDir, BROKEN_SHAPE)).toBe('SILENT');
  });

  it('isMainEntry fires on a Korean path with a space', () => {
    const koreanDir = path.join(sandbox, `${KOREAN_DIR_NAME} 2`);
    expect(probe(koreanDir, CANONICAL_SHAPE)).toBe('FIRED');
  });

  it('isMainEntry still refuses to fire for a module that is not the entry point', () => {
    // The direction that must never regress: a false positive would run main()
    // on a plain import, which is the hazard the guard exists to prevent.
    const koreanDir = path.join(sandbox, `${KOREAN_DIR_NAME} 3`);
    mkdirSync(koreanDir, { recursive: true });
    const other = path.join(koreanDir, 'other.mjs');
    writeFileSync(
      other,
      `import { isMainEntry } from ${JSON.stringify(pathToFileURL(MAIN_ENTRY).href)};\n` +
        'export const fired = isMainEntry(import.meta.url);\n',
      'utf8',
    );
    const body =
      `import { fired as otherFired } from ${JSON.stringify(pathToFileURL(other).href)};\n` +
      'const fired = otherFired;';
    expect(probe(koreanDir, body)).toBe('SILENT');
  });
});

describe('direct-run guard behaviour through a junction/symlink', () => {
  /** @type {{ real: string, link: string }} */
  let dirs;

  beforeAll(() => {
    dirs = { real: path.join(sandbox, 'link-axis', 'real'), link: path.join(sandbox, 'link-axis', 'link') };
    mkdirSync(path.dirname(dirs.real), { recursive: true });
    makeJunction(dirs.real, dirs.link);
  });

  it('the link really does split argv[1] from import.meta.url (precondition)', () => {
    // Everything below is meaningless if node hands both sides the same
    // spelling — the bug reproductions would "pass" by not existing and the
    // canonical case would prove nothing. Assert the split rather than assume
    // it, and fail loudly on a platform that behaves differently instead of
    // skipping into a false green.
    const body =
      'process.stdout.write(JSON.stringify({ argv1: process.argv[1], meta: import.meta.url }));';
    const direct = JSON.parse(spawnProbe(dirs.real, body));
    const viaLink = JSON.parse(spawnProbe(dirs.real, body, { runFrom: dirs.link }));

    expect(path.resolve(direct.argv1)).toBe(path.resolve(path.join(dirs.real, 'probe.mjs')));
    expect(path.resolve(viaLink.argv1)).toBe(path.resolve(path.join(dirs.link, 'probe.mjs')));
    // node realpaths the MAIN module, so both runs report the real location.
    expect(viaLink.meta).toBe(direct.meta);
    expect(path.resolve(viaLink.argv1)).not.toBe(path.resolve(fileURLToPath(viaLink.meta)));
  });

  it('reproduces the fail-open: the path-identity shape goes silent through the link', () => {
    expect(probe(dirs.real, RESOLVE_SHAPE)).toBe('FIRED');
    expect(probe(dirs.real, RESOLVE_SHAPE, { runFrom: dirs.link })).toBe('SILENT');
  });

  it('the pathToFileURL shape goes silent through the link too', () => {
    // Measured, not assumed. It decodes correctly, so it survives axis 1 — but
    // it is still a path-identity compare, so it dies on axis 2 exactly like
    // the resolve shape.
    expect(probe(dirs.real, PATH_TO_FILE_URL_SHAPE)).toBe('FIRED');
    expect(probe(dirs.real, PATH_TO_FILE_URL_SHAPE, { runFrom: dirs.link })).toBe('SILENT');
  });

  it('isMainEntry fires through the link', () => {
    expect(probe(dirs.real, CANONICAL_SHAPE)).toBe('FIRED');
    expect(probe(dirs.real, CANONICAL_SHAPE, { runFrom: dirs.link })).toBe('FIRED');
  });

  it('isMainEntry still refuses to fire for a non-entry module reached through the link', () => {
    // The realpath fallback widens what counts as "me". Confirm it did not
    // widen far enough to match a DIFFERENT file living in the same directory.
    const other = path.join(dirs.real, 'other-link.mjs');
    writeFileSync(
      other,
      `import { isMainEntry } from ${JSON.stringify(pathToFileURL(MAIN_ENTRY).href)};\n` +
        'export const fired = isMainEntry(import.meta.url);\n',
      'utf8',
    );
    const body =
      `import { fired as otherFired } from ${JSON.stringify(pathToFileURL(other).href)};\n` +
      'const fired = otherFired;';
    expect(probe(dirs.real, body, { runFrom: dirs.link })).toBe('SILENT');
  });
});

describe('no encoded-vs-raw direct-run guards remain under scripts/', () => {
  it('detects the broken shape when it is present (detector self-check)', () => {
    expect(hasEncodedVsRawCompare(BROKEN_SHAPE)).toBe(true);
    expect(
      hasEncodedVsRawCompare('const ok = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);'),
    ).toBe(false);
  });

  it('scans every part of scripts/ that holds a direct-run guard', () => {
    const files = collectScripts(SCRIPTS_DIR);
    const buckets = new Set(
      files.map((f) => {
        const rel = path.relative(SCRIPTS_DIR, f);
        const seg = rel.split(path.sep);
        return seg.length === 1 ? '(root)' : seg[0];
      }),
    );

    // Named, not counted. A bare file-count floor cannot express this: measured
    // 2026-08-24 the tree holds 139 files but scripts/hooks/ alone holds 68, so
    // a walk that regressed to hooks-only would still clear any floor below 68
    // while seeing none of the guards in ci/, cron/, evals/ or the root.
    // These six are every location that currently contains a direct-run guard.
    // media/ was added 2026-08-24: the note below claimed it held none, which
    // was simply wrong — scripts/media/watch-ingest.js has had one all along,
    // and its unmigrated form is what walked past this scan. That directory
    // holds exactly that one file, so a walk that loses it loses the whole
    // bucket silently.
    for (const required of ['(root)', 'hooks', 'ci', 'cron', 'evals', 'media']) {
      expect(buckets, `scan missed scripts/${required}`).toContain(required);
    }

    // theme/, git-hooks/ and utils/ are deliberately NOT required: 1-3 files
    // each and no direct-run guard among them (verified 2026-08-24 — theme/
    // and utils/ never mention import.meta.url as an entry test, and
    // git-hooks/install.js uses it only for __dirname), so pinning them would
    // turn a routine reorganisation into a failure here for no detection gain.

    // Secondary floor, set against the measured 139 with ~19 of headroom. This
    // catches a walk that keeps reaching every directory but stops matching most
    // files. A legitimate bulk deletion under scripts/ would trip it — that is a
    // deliberate prompt to re-measure, not a bug.
    expect(files.length).toBeGreaterThan(120);
  });

  it('finds no offending guard in any script', () => {
    const files = collectScripts(SCRIPTS_DIR);
    const offenders = files
      .filter((f) => hasEncodedVsRawCompare(readFileSync(f, 'utf8')))
      .map((f) => relPosix(f));

    expect(offenders).toEqual([]);
  });
});

describe('every direct-run guard routes through the canonical helper', () => {
  it('flags each hand-rolled shape and clears the canonical one (detector self-check)', () => {
    // Link-fragile shapes.
    expect(derivesEntryFromRawArgv(RESOLVE_SHAPE)).toBe(true);
    expect(derivesEntryFromRawArgv(PATH_TO_FILE_URL_SHAPE)).toBe(true);
    expect(
      derivesEntryFromRawArgv('const d = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);'),
    ).toBe(true);
    // Link-safe but filename-only shapes: flagged for convergence, not because
    // a junction breaks them.
    expect(derivesEntryFromRawArgv("const d = path.basename(process.argv[1]) === 'x.js';")).toBe(true);
    expect(derivesEntryFromRawArgv("const d = process.argv[1]?.endsWith('x.js');")).toBe(true);
    // Encoding shape — the broad scan subsumes the narrow axis-1 detector.
    expect(derivesEntryFromRawArgv(BROKEN_SHAPE)).toBe(true);
    // Indirection through a local. The comparison statement never names
    // argv[1]; a shape-matching regex misses this, a presence rule does not.
    expect(
      derivesEntryFromRawArgv(
        ['const invoked = process.argv[1] ? path.resolve(process.argv[1]) : \'\';', 'if (invoked === thisPath) main();'].join('\n'),
      ),
    ).toBe(true);
    // Whitespace between the tokens must not evade it.
    expect(derivesEntryFromRawArgv('const d = process . argv [ 1 ] === __filename;')).toBe(true);

    // The one allowed spelling.
    expect(derivesEntryFromRawArgv(CANONICAL_SHAPE)).toBe(false);
    // Ordinary CLI argument reading is not an entry-point guard.
    expect(derivesEntryFromRawArgv('const args = process.argv.slice(2);')).toBe(false);
  });

  it('sees slot 1 reached through an alias, not just the literal spelling (detector self-check)', () => {
    // Regression pin for a real escape, not a hypothetical one. Until
    // 2026-08-24 this scan matched the TEXT `process.argv[1]`, so
    // scripts/media/watch-ingest.js — which imported `argv` from `node:process`
    // and never wrote that text — was reported clean while its guard was still
    // hand-rolled. Measured that day: the old pattern answered false on it.
    // Every shape below rebinds argv and then reads slot 1; each one is an
    // unmigrated guard the scan must not walk past.
    expect(
      derivesEntryFromRawArgv(
        ["import { argv } from 'node:process';", 'const d = path.resolve(argv[1]) === __filename;'].join('\n'),
      ),
    ).toBe(true);
    expect(
      derivesEntryFromRawArgv(
        ["import { argv as raw } from 'node:process';", 'const d = raw[1] === __filename;'].join('\n'),
      ),
    ).toBe(true);
    expect(
      derivesEntryFromRawArgv(['const { argv } = process;', 'const d = argv[1] === __filename;'].join('\n')),
    ).toBe(true);
    // The alias need not be CALLED argv — a name-based rule would miss this.
    expect(
      derivesEntryFromRawArgv(['const a = process.argv;', 'const d = a[1] === __filename;'].join('\n')),
    ).toBe(true);
    // Spellings of the slot itself, on the direct object and on an alias.
    expect(derivesEntryFromRawArgv("const d = process.argv.at(1) === __filename;")).toBe(true);
    expect(derivesEntryFromRawArgv("const d = process.argv?.[1] === __filename;")).toBe(true);
    expect(derivesEntryFromRawArgv("const d = process['argv'][1] === __filename;")).toBe(true);
    expect(
      derivesEntryFromRawArgv(['const a = process.argv;', 'const d = a.at(1) === __filename;'].join('\n')),
    ).toBe(true);

    // The precision half. Widening to a bare /argv\[1\]/ would have closed the
    // hole too, at the cost of flagging a slice(2)-derived list — where index 1
    // is the second USER argument and means nothing about entry points. Three
    // files in the live tree take an `argv` parameter of exactly that shape
    // (scripts/backfill-grpo-categories.js, scripts/hierarchical-memory-migrate.mjs,
    // scripts/route-lifecycle.mjs, measured 2026-08-24), so this is a live
    // false positive, not a hypothetical one.
    expect(derivesEntryFromRawArgv('export function parseArgs(argv) { return argv[1]; }')).toBe(false);
    expect(
      derivesEntryFromRawArgv('async function main(argv = process.argv.slice(2)) { return argv[1]; }'),
    ).toBe(false);
    // Importing argv without ever reading slot 1 is not a guard either — this
    // is watch-ingest.js post-migration, and it must scan clean.
    expect(
      derivesEntryFromRawArgv(
        ["import { argv } from 'node:process';", 'const r = parseArgs(argv);'].join('\n'),
      ),
    ).toBe(false);
  });

  it('does not read prose about the bug as the bug (detector self-check)', () => {
    // This is not hypothetical: bin/artibot-mcp.mjs carries a comment block
    // naming both sides of the comparison it removed.
    expect(derivesEntryFromRawArgv('// compared a RAW process.argv[1] against import.meta.url\nmain();')).toBe(
      false,
    );
    expect(
      derivesEntryFromRawArgv('/**\n * was: path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)\n */\nmain();'),
    ).toBe(false);
    // ...but a URL inside a string must NOT take the rest of the line with it.
    // This is the exact way a naive line-comment strip goes fail-open.
    expect(
      derivesEntryFromRawArgv("const u = 'https://x/y'; const d = process.argv[1] === __filename;"),
    ).toBe(true);
  });

  it('a `/*` inside a string literal does not open a comment (detector self-check)', () => {
    // Regression pin for the second fail-open this stripper shipped. An
    // unanchored block rule let a STRING containing `/*` open a comment that
    // ran until the next `*/` — real code in between was blanked and the scan
    // went blind over it. Measured 2026-08-24 on the live tree: 7 files, 170
    // lines of code erased, `scripts/export-to-tool.mjs` worst at 96.
    //
    // The three lines matter. A one-liner cannot express this: with no closing
    // `*/` anywhere the buggy rule never matched, so it answered true for the
    // right answer by accident and could never go red.
    expect(
      derivesEntryFromRawArgv(
        ["const g = '/**';", 'const d = process.argv[1] === __filename;', "const h = ' */';"].join('\n'),
      ),
    ).toBe(true);
  });

  it('never blanks a line of real code (stripper self-verification)', () => {
    // The gate on the gate. Both fail-opens this file has shipped were the same
    // shape: the stripper quietly ate source, so the scan reported clean on
    // code it could no longer see. No amount of hand-picked example strings
    // catches that — the property has to be asserted against the real tree.
    //
    // Direction matters. Leaving a comment un-stripped only over-reports (a
    // visible false positive). Blanking real code UNDER-reports, silently, and
    // that is the one this must never allow again.
    const damaged = [];
    for (const file of collectSources()) {
      const before = readFileSync(file, 'utf8').split('\n');
      const after = stripComments(before.join('\n')).split('\n');
      let lost = 0;
      for (let i = 0; i < before.length; i += 1) {
        const wasCode = before[i].trim() !== '' && !/^\s*(?:\/\/|\/\*|\*)/.test(before[i]);
        if (wasCode && (after[i] ?? '').trim() === '') lost += 1;
      }
      if (lost) damaged.push(`${relPosix(file)} (${lost} lines)`);
    }

    expect(damaged).toEqual([]);
  });

  it('scans all three source roots, by name and by floor', () => {
    const files = collectSources().map((f) => relPosix(f));

    // Named sentinels: one real file per root that carried a guard before the
    // migration. A walk that lost a root fails here with the root named,
    // instead of quietly shrinking the denominator.
    for (const sentinel of [
      'scripts/hooks/_main-entry.js',
      'bin/artibot-dashboard.mjs',
      'lib/planning/scorecard.js',
    ]) {
      expect(files, `scan missed ${sentinel}`).toContain(sentinel);
    }

    for (const root of SOURCE_ROOTS) {
      expect(
        files.some((f) => f.startsWith(`${root}/`)),
        `scan reached no file under ${root}/`,
      ).toBe(true);
    }

    // Measured 2026-08-24: scripts 139 + bin 3 + lib 286 = 428. Floor set with
    // ~48 of headroom; tripping it means re-measure, not relax.
    expect(files.length).toBeGreaterThan(380);
  });

  it('exempts exactly one file, and that exemption is still load-bearing', () => {
    expect(SCAN_EXEMPT).toEqual(['scripts/hooks/_main-entry.js']);
    // If the helper ever stops comparing argv[1] itself, this exemption is dead
    // and should be deleted rather than left as a standing hole.
    expect(derivesEntryFromRawArgv(readFileSync(MAIN_ENTRY, 'utf8'))).toBe(true);
  });

  it('finds no file deriving its entry decision from a raw process.argv[1]', () => {
    const offenders = collectSources()
      .map((f) => relPosix(f))
      .filter((rel) => !SCAN_EXEMPT.includes(rel))
      .filter((rel) => derivesEntryFromRawArgv(readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8')))
      .sort();

    expect(offenders).toEqual([]);
  });
});
