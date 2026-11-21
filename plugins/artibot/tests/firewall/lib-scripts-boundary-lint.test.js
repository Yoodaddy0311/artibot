/**
 * lib/ must not import scripts/ — enforced by eslint, proven by linting probes
 * (2026-11-21 review M7).
 *
 * WHY: scripts/ is the hook/CLI layer that sits ON TOP of lib/. A lib module importing
 * scripts/ inverts that (and drags a hook helper's contract into lib: the `atomicWriteSync`
 * two lib/core modules imported swallowed failures). Measured 2026-11-21 at HEAD 3f4336c3:
 * 4 static edges — lib/core/rotation.js and lib/core/skill-hash-cache.js
 * (`scripts/utils/index.js`, now removed) and lib/planning/scorecard.js,
 * lib/runtime/task-budget.js (`scripts/hooks/_main-entry.js#isMainEntry`, kept).
 *
 * THE ONE EXCEPTION: `scripts/hooks/_main-entry.js`, whose job is "is this file the process
 * entry point". Its STATIC imports are node: builtins only (see its header); its one
 * non-builtin dependency is a deferred `import('./_hook-seen-marker.js')` (plus injected
 * lib/project-state loaders) inside `tapDirectFiring` — a path the lib importers never take,
 * since they call `isMainEntry` only. So a lib module with a CLI mode can use it without
 * loading any hook graph. The lint rule exempts that module; the census below additionally
 * pins WHICH lib files use it, so a third importer is a visible decision rather than a
 * silent spread.
 *
 * HOW THE RULE IS WRITTEN: a `regex` pattern with a negative lookahead in every lib layer
 * block of eslint.config.js (L1-L5; the L5 runtime block exists for this rule alone). A
 * gitignore-style `group` was measured first and rejected: `['**\/scripts/**',
 * '!**\/scripts/hooks/_main-entry.js']` still matches the exempt file, because gitignore
 * cannot re-include a file whose parent directory is excluded (probe with the `ignore`
 * package eslint uses, 2026-11-21: `../../scripts/hooks/_main-entry.js` -> ignored=true).
 *
 * SEPARATORS: both the lint regex and the census accept `/` or `\` — Node 22.19 on Windows
 * resolves `'../../scripts\\utils\\index.js'` and `'../..\\scripts/utils/index.js'` to the real
 * module (probed 2026-11-21; a slash-only pattern caught neither).
 *
 * WHAT THIS FILE CANNOT SEE (L = the eslint rule, C = the census)
 *  1. Computed dynamic imports (`import(path.join(root, 'scripts', ...))`) — L and C both miss
 *     them; each reads only literal specifiers.
 *  2. LITERAL dynamic imports (`import('../../scripts/x.js')`) — L misses them
 *     (no-restricted-imports reads import/export declarations only); C catches them.
 *  3. `createRequire(import.meta.url)('../../scripts/x.js')` — L and C both miss it.
 *  4. Absolute paths and `file:` URLs — L misses them (its regex is anchored on `./`/`../`);
 *     C, unanchored, flags them.
 *  5. lib files that eslint does not lint (outside every `files[]`). The layer-registration
 *     test (tests/firewall/layer-registration-coverage.test.js) is what keeps every lib/*
 *     directory inside a block.
 *  6. Whether a FUTURE exempt-module importer is legitimate — the census only makes it red.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LIB_DIR = path.join(PLUGIN_ROOT, 'lib');

/** One probe file per layer block (L1..L5). The files need not exist: lintText takes the path. */
const LAYER_PROBES = [
  ['L1', 'lib/core/__probe__.js'],
  ['L2', 'lib/planning/__probe__.js'],
  ['L3', 'lib/learning/__probe__.js'],
  ['L4', 'lib/cognitive/__probe__.js'],
  ['L5', 'lib/runtime/__probe__.js'],
];

const eslint = new ESLint({ cwd: PLUGIN_ROOT });

/**
 * no-restricted-imports messages eslint reports for `code` linted as `relPath`.
 * @param {string} code
 * @param {string} relPath
 * @returns {Promise<string[]>}
 */
async function restrictedMessages(code, relPath) {
  const [result] = await eslint.lintText(code, { filePath: path.join(PLUGIN_ROOT, relPath) });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('eslint: lib/* -> scripts/* is a lint error in every layer block', () => {
  it.each(LAYER_PROBES)('%s (%s): importing scripts/utils is reported', async (_layer, rel) => {
    const code = "import { parseJSON } from '../../scripts/utils/index.js';\nexport { parseJSON };\n";
    const msgs = await restrictedMessages(code, rel);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/scripts\//);
  });

  it.each(LAYER_PROBES)('%s (%s): re-export and deeper relative forms are reported too', async (_layer, rel) => {
    const nested = rel.replace('__probe__.js', 'sub/__probe__.js');
    const code = "export { writeStdout } from '../../../scripts/utils/index.js';\n";
    expect(await restrictedMessages(code, nested)).toHaveLength(1);
  });

  it.each(LAYER_PROBES)('%s (%s): the _main-entry.js exception is allowed', async (_layer, rel) => {
    const code = "import { isMainEntry } from '../../scripts/hooks/_main-entry.js';\nexport { isMainEntry };\n";
    expect(await restrictedMessages(code, rel)).toEqual([]);
  });

  it('the exception is exact: a sibling of _main-entry.js is still reported', async () => {
    const code = "import { x } from '../../scripts/hooks/_main-entry.js.bak';\nimport { y } from '../../scripts/hooks/_dispatcher-utils.js';\nexport { x, y };\n";
    expect(await restrictedMessages(code, 'lib/core/__probe__.js')).toHaveLength(2);
  });

  // Backslash separators (xcA LOW, 2026-11-21): Node 22.19 on Windows resolves
  // `'../../scripts\\utils\\index.js'` and `'../..\\scripts/utils/index.js'` to the
  // real module (the import URL parser treats `\` as `/` for file: URLs), so the
  // rule has to treat either character as a separator. Probed: both forms ran
  // and printed the imported value, and the slash-only regex reported neither.
  const BACKSLASH_FORMS = [
    ['all backslashes after scripts', String.raw`import { a } from '../../scripts\\utils\\index.js';` + '\nexport { a };\n'],
    ['backslash before scripts', String.raw`import { a } from '../..\\scripts/utils/index.js';` + '\nexport { a };\n'],
    ['backslashes throughout', String.raw`import { a } from '..\\..\\scripts\\utils\\index.js';` + '\nexport { a };\n'],
  ];

  it.each(LAYER_PROBES)('%s (%s): backslash-separated forms are reported', async (_layer, rel) => {
    for (const [label, code] of BACKSLASH_FORMS) {
      expect(await restrictedMessages(code, rel), label).toHaveLength(1);
    }
  });

  it('the exception holds with backslash separators too (same module)', async () => {
    const code = String.raw`import { isMainEntry } from '..\\..\\scripts\\hooks\\_main-entry.js';` + '\nexport { isMainEntry };\n';
    expect(await restrictedMessages(code, 'lib/core/__probe__.js')).toEqual([]);
  });

  it('positive control: a lib -> lib/core import in L2 is not reported', async () => {
    const code = "import { atomicWriteJsonSync } from '../core/file.js';\nexport { atomicWriteJsonSync };\n";
    expect(await restrictedMessages(code, 'lib/planning/__probe__.js')).toEqual([]);
  });

  it('the layer rule still fires beside the scripts rule (no flat-config override lost it)', async () => {
    const code = "import { x } from '../learning/x.js';\nexport { x };\n";
    const msgs = await restrictedMessages(code, 'lib/core/__probe__.js');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/Layer violation/);
  });
});

/** Every .js/.mjs file under lib/, as plugin-relative POSIX paths. */
function listLibFiles(dir = LIB_DIR, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) listLibFiles(full, out);
    else if (/\.m?js$/.test(name)) out.push(path.relative(PLUGIN_ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

const SPEC_RE = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** Literal import specifiers in `text` (static, re-export, side-effect, literal dynamic). */
function specifiers(text) {
  const out = [];
  for (let m = SPEC_RE.exec(text); m; m = SPEC_RE.exec(text)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * A `scripts` path segment, with `/` or `\` on either side. Unanchored on purpose, so
 * absolute paths and `file:` URLs are flagged too. Read against SOURCE TEXT, where an
 * escaped backslash is two characters — `[/\\]` matches the first of them.
 */
const SCRIPTS_SPEC = /(?:^|[/\\])scripts[/\\]/;

describe('census: lib -> scripts edges (independent of eslint)', () => {
  /** The whole allowlist. Adding a line here is a decision someone has to defend in review. */
  const ALLOWED = [
    'lib/planning/scorecard.js -> ../../scripts/hooks/_main-entry.js',
    'lib/runtime/task-budget.js -> ../../scripts/hooks/_main-entry.js',
  ];

  it('scans a non-empty lib tree (fail-closed denominator)', () => {
    expect(listLibFiles().length).toBeGreaterThan(300);
  });

  it('the only lib -> scripts edges are the allowlisted _main-entry imports', () => {
    const edges = [];
    for (const rel of listLibFiles()) {
      const text = readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');
      for (const spec of specifiers(text)) if (SCRIPTS_SPEC.test(spec)) edges.push(`${rel} -> ${spec}`);
    }
    expect(edges.sort()).toEqual([...ALLOWED].sort());
  });

  it('scanner self-check: each specifier form is extracted', () => {
    const sample = [
      "import { a } from '../../scripts/utils/index.js';",
      "export { b } from '../../scripts/x.js';",
      "import '../../scripts/side.js';",
      "  const m = await import('../../scripts/dyn.js');",
      " * import { c } from '../../scripts/in-jsdoc.js';",
    ].join('\n');
    expect(specifiers(sample)).toEqual([
      '../../scripts/utils/index.js', '../../scripts/x.js', '../../scripts/side.js', '../../scripts/dyn.js',
    ]);
  });

  it('scanner self-check: SCRIPTS_SPEC flags every separator form and no look-alike', () => {
    // Specifiers as they appear in SOURCE TEXT (the census reads raw files, so an
    // escaped backslash is two characters here).
    const flagged = [
      '../../scripts/utils/index.js',
      String.raw`../../scripts\\utils\\index.js`,
      String.raw`../..\\scripts/utils/index.js`,
      String.raw`..\\..\\scripts\\utils\\index.js`,
      '/abs/repo/plugins/artibot/scripts/utils/index.js',
      'file:///C:/repo/plugins/artibot/scripts/utils/index.js',
    ];
    const notFlagged = ['../core/file.js', '../manuscripts/x.js', '../../scriptsx/y.js', 'scripts-helper'];
    expect(flagged.filter((s) => !SCRIPTS_SPEC.test(s))).toEqual([]);
    expect(notFlagged.filter((s) => SCRIPTS_SPEC.test(s))).toEqual([]);
  });

  it('scanner self-check: a backslash import in a lib file would be extracted AND flagged', () => {
    const text = String.raw`import { a } from '../../scripts\\utils\\index.js';`;
    const specs = specifiers(text);
    expect(specs).toHaveLength(1);
    expect(SCRIPTS_SPEC.test(specs[0])).toBe(true);
  });
});
