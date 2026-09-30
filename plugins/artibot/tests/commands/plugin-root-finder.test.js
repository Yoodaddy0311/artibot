/**
 * Purpose: the command/skill markdown that tells Claude to run a plugin script
 * must still work when the working directory is ANOTHER project.
 *
 * -- What broke (measured 2026-09-30, installed 4.70.0, foreign cwd) ------------
 * `commands/squash.md` said `node plugins/artibot/scripts/squash-wip.mjs`, and
 * `commands/resume.md` said `node scripts/checkpoint/resume-report.mjs`. Both
 * resolve only inside the Artibot source repo; anywhere else they exit with
 * MODULE_NOT_FOUND. `node -e "import('./lib/...')"` snippets fail the same way,
 * and on Windows a bare absolute path in `import()` fails with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME, so the fix has to hand `import()` a file URL.
 *
 * -- The fix, and why it is a copied block --------------------------------------
 * `CLAUDE_PLUGIN_ROOT` is empty in the Bash tool (measured), and a slash command
 * cannot include another file, so each carrier holds its own copy of one small
 * finder block, in this order:
 *   1. `plugins/artibot` and `.` (the Artibot source repo, in both cwd layouts),
 *      accepted ONLY when `<cand>/.claude-plugin/plugin.json` names `artibot`;
 *   2. the host-written plugin path;
 *   3. the newest plugin-cache version (numeric sort);
 *   4. the marketplace copy.
 * Every step tests for the SPECIFIC file the carrier needs, so a stale or
 * half-installed directory is skipped. Checking the working directory FIRST keeps
 * the source repo dogfooding its own tree (the host-written path is always the
 * INSTALLED copy, so putting it first made /squash, /ship and /export run the
 * cache inside the repo). The manifest check exists because "a folder named
 * plugins/artibot holds that file" is not proof of being this plugin.
 *
 * Two spellings of the host-written candidate exist, on purpose:
 *  - COMMAND carriers (`commands/*.md`) use the exact braced token. Measured
 *    2026-09-30 by loading `artibot:spec` and `artibot:verify`: the host replaces
 *    that exact token inline in command text, anywhere (fences and prose alike),
 *    and does NOT replace the `:-` spelling (verify.md:56 arrived unchanged).
 *  - REFERENCE carriers (`skills/**` reference files) are opened with `Read`, so
 *    nothing is substituted; they use `${CLAUDE_PLUGIN_ROOT:-}`, which is also
 *    safe under `set -u`.
 *
 * -- What this file gates --------------------------------------------------------
 *  1. Every carrier's block is byte-identical to the canonical text for its kind
 *     (only `F` differs), sits in a fence, probes a file that exists, and its
 *     `<pluginRoot>` uses are present. 11 carriers; the set is exact.
 *  2. A ratchet: no command, skill or agent may tell Claude to run a cwd-relative
 *     `node scripts/...`, `bash plugins/artibot/scripts/...`, `require('./lib/...')`,
 *     `import('./lib/...')`, or a `Glob` under `plugins/artibot/`. Known exceptions
 *     carry an exact count and a reason. The `:-` spelling is banned in commands.
 *  3. The block really runs, from ONE batched driver (see the harness): host
 *     substitution is MODELLED by replacing the token with a literal path (valid,
 *     stale, with a space, an apostrophe, a `$`), the source layouts, a space and
 *     non-ASCII characters in HOME, two versions that sort differently as text and
 *     as numbers, marketplace only, nothing installed, and the DECOYS the manifest
 *     check exists for (no manifest, `artibot-cowork`, a manifest without the file).
 *  4. The REAL manifest passes the check (the real plugin directory is run as the
 *     working directory) and the sibling cowork manifest does not.
 *  The script CHAINS (`REC=`, `USG=`, `ENGINE=`, `PLUGIN_ROOT=`), the node resolvers
 *  and `install.md` are gated in `plugin-root-chains.test.js`.
 *
 * -- What this gate cannot see (rules 9: written next to the gate) ---------------
 *  - Whether a model follows the instruction. Nothing here runs a model.
 *  - The real host. The substitution was measured by hand once, on one host
 *    version, for COMMAND text. SKILL.md content is inferred from the plugin docs,
 *    not measured. A host that stops substituting still passes (the block falls
 *    through to the other candidates); a host that changes the substituted form
 *    (for example a trailing backslash) is not observed here.
 *  - A host-written path that contains a `$` is expanded inside the double quotes
 *    and fails its `-f` test, so the block falls through to the cache. Single quotes
 *    would keep the `$` but turn an apostrophe (O'Brien) into a syntax error that
 *    kills the whole block, so the quotes stay double. Both are pinned below.
 *  - The manifest check is an ACCIDENT guard, not a security boundary. A project
 *    that deliberately plants `plugins/artibot/<file>` AND a manifest naming
 *    `artibot` is still preferred over the installed copy; the literal path the old
 *    text ran had exactly that trust, so this is not new exposure. What it stops is
 *    a project that merely has a folder of that name (and `artibot-cowork`).
 *  - zsh (the block uses no bash-only syntax and no unmatched glob, but only bash
 *    is exercised), and `CLAUDE_CONFIG_DIR` (a relocated `~/.claude` is not searched).
 *  - Native installs (`install.sh`): their global copy `~/.claude/artibot` is NOT a
 *    candidate of the block (it has no `agents/`, so a script that reads them would
 *    fail worse than "not found"). The script chains keep it, after the cache.
 *  - The executable half skips, with a printed reason, where `bash` cannot open
 *    native paths (for example WSL bash launched from PowerShell); the static
 *    halves always run.
 *
 * Shape (rules 10): a `tests/` vitest, not a script gate, with scanner
 * self-checks and an exact-count exception table that goes RED when it goes stale.
 *
 * @module tests/commands/plugin-root-finder
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { announceBashSkip, probeBash } from '../../scripts/utils/bash-compat.js';
import {
  cacheDir, lf, mirrorDir, NAME_CHECK, NOT_FOUND, PLUGIN_ROOT, posix, read, runBatch, same, TOKEN, TOKEN_ENV, touch, writeManifest,
} from '../helpers/plugin-root-harness.js';

// One batched driver runs every executable scenario; the budgets buy headroom for load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

/**
 * The finder, one line per element. `__FILE__` is the only free part; the host-written
 * candidate is the exact token in a command and the `:-` spelling in a reference file.
 */
function canonicalLines(kind) {
  const hostCandidate = kind === 'command' ? TOKEN : TOKEN_ENV;
  return [
    `F="__FILE__"; R=""; P="$HOME/.claude/plugins"; T="${hostCandidate}"`,
    `for d in plugins/artibot .; do [ -f "$d/$F" ] && ${NAME_CHECK} "$d/.claude-plugin/plugin.json" 2>/dev/null && R="$d" && break; done`,
    '[ -z "$R" ] && [ -n "$T" ] && [ -f "$T/$F" ] && R="$T"',
    '[ -z "$R" ] && for v in $(ls -1 "$P/cache/artibot/artibot" 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr); do [ -f "$P/cache/artibot/artibot/$v/$F" ] && R="$P/cache/artibot/artibot/$v" && break; done',
    '[ -z "$R" ] && for m in $(ls -1 "$P/marketplaces" 2>/dev/null); do [ -f "$P/marketplaces/$m/plugins/artibot/$F" ] && R="$P/marketplaces/$m/plugins/artibot" && break; done',
    '[ -n "$R" ] && (cd "$R" && { pwd -W 2>/dev/null || pwd; }) || echo "artibot plugin root not found - run /update"',
  ];
}
const BLOCK_LINES = canonicalLines('command').length;
const kindOf = (rel) => (rel.startsWith('commands/') ? 'command' : 'reference');
const finderFor = (file, kind = 'command') => canonicalLines(kind).join('\n').replace('__FILE__', file);

/**
 * Every file that carries a finder block. `probe` is the `F` the block tests
 * for; `uses` are substrings that must all appear in `useFile` (the document
 * that actually runs the script, which is not always the one holding the block).
 */
const CARRIERS = [
  { file: 'commands/export.md', probe: 'scripts/export-to-tool.mjs', uses: ['<pluginRoot>/scripts/export-to-tool.mjs'] },
  { file: 'commands/ship.md', probe: 'scripts/build-pr-description.mjs', uses: ['<pluginRoot>/scripts/build-pr-description.mjs'] },
  { file: 'commands/squash.md', probe: 'scripts/squash-wip.mjs', uses: ['<pluginRoot>/scripts/squash-wip.mjs'] },
  {
    file: 'commands/resume.md',
    probe: 'scripts/checkpoint/resume-report.mjs',
    uses: ['<pluginRoot>/scripts/checkpoint/resume-report.mjs', '<pluginRoot>/scripts/checkpoint/read-order-guard.mjs'],
  },
  {
    file: 'commands/doctor.md',
    probe: 'scripts/ledger/topology-agreement.mjs',
    uses: ['<pluginRoot>/scripts/ledger/topology-agreement.mjs', '<pluginRoot>/artibot.config.json'],
  },
  {
    file: 'commands/dreaming.md',
    probe: 'lib/learning/memory/dream/collector.js',
    uses: ['"<pluginRoot>" "<memory-dir>"', "load('lib/learning/memory/dream/collector.js')", "load('lib/learning/memory/dream/distiller.js')"],
  },
  { file: 'commands/repo.md', probe: 'lib/git/repo-acquire.js', uses: ['"<pluginRoot>" "https://github.com/owner/repo"', "'lib/git/repo-acquire.js'"] },
  {
    file: 'commands/scorecard.md',
    probe: 'lib/scorecard/index.js',
    uses: ['-- "<pluginRoot>" $ARGUMENTS'],
  },
  {
    file: 'commands/install.md',
    probe: 'lib/core/preset-packs.js',
    uses: ['ARTIBOT_PLUGIN_ROOT="<pluginRoot>"', 'process.env.ARTIBOT_PLUGIN_ROOT', "'lib', 'core', 'preset-packs.js'"],
  },
  {
    file: 'skills/split/references/operations.md',
    probe: 'scripts/split/lane-state.mjs',
    useFile: 'commands/split.md',
    uses: ['"<pluginRoot>/scripts/split/lane-state.mjs"', '"<pluginRoot>" <runId>', "load('lib/git/batch-landing.js')"],
  },
  {
    file: 'skills/git-unified/references/worktree.md',
    probe: 'lib/git/merge-preflight.js',
    uses: ["'lib/git/merge-preflight.js'", '"<pluginRoot>" $(git worktree list'],
  },
];

/**
 * Extract finder blocks: a line that opens with `F="..."; R=""; P="$HOME/.claude/plugins"; T="..."`
 * plus the lines after it, requiring a fence line before and after.
 *
 * @param {string} text - Newline-normalised markdown.
 * @returns {Array<{ probe: string, text: string, fenced: boolean, line: number }>}
 */
export function extractFinderBlocks(text) {
  const lines = lf(text).split('\n');
  const opener = /^F="([^"]+)"; R=""; P="\$HOME\/\.claude\/plugins"; T="[^"]*"$/;
  const blocks = [];
  lines.forEach((raw, i) => {
    const m = raw.trim().match(opener);
    if (m === null) return;
    const body = lines.slice(i, i + BLOCK_LINES).map((l) => l.trim());
    const before = (lines[i - 1] ?? '').trim();
    const after = (lines[i + BLOCK_LINES] ?? '').trim();
    blocks.push({ probe: m[1], text: body.join('\n'), fenced: before.startsWith('```') && after === '```', line: i + 1 });
  });
  return blocks;
}

/** Recursively list `.md` files under a plugin-relative directory. */
function listMarkdown(relDir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.name.endsWith('.md')) out.push(childRel);
    }
  };
  walk(path.join(PLUGIN_ROOT, relDir), relDir);
  return out.sort();
}

const SCANNED = [...listMarkdown('commands'), ...listMarkdown('skills'), ...listMarkdown('agents')];

describe('plugin-root finder: the copies in the carriers', () => {
  it('scans a plausible number of documents (0 violations is not 0 documents)', () => {
    expect(SCANNED.length).toBeGreaterThan(180);
    expect(SCANNED.filter((rel) => rel.startsWith('agents/')).length).toBeGreaterThanOrEqual(30);
    expect(CARRIERS.length).toBe(11);
  });

  it.each(CARRIERS.map((c) => [c.file, c]))('%s holds exactly one fenced block, identical to the canonical text for its kind', (_file, carrier) => {
    const blocks = extractFinderBlocks(read(carrier.file));
    expect(blocks.length, `${carrier.file}: finder blocks found`).toBe(1);
    expect(blocks[0].fenced, `${carrier.file}: block is not inside a fenced code block`).toBe(true);
    expect(blocks[0].probe).toBe(carrier.probe);
    expect(blocks[0].text).toBe(finderFor(carrier.probe, kindOf(carrier.file)));
  });

  it.each(CARRIERS.map((c) => [c.file, c]))('%s probes a file that exists under the plugin root', (_file, carrier) => {
    expect(existsSync(path.join(PLUGIN_ROOT, carrier.probe)), `${carrier.probe} is missing`).toBe(true);
  });

  it.each(CARRIERS.map((c) => [c.file, c]))('%s actually runs the script through <pluginRoot>', (_file, carrier) => {
    const doc = read(carrier.useFile ?? carrier.file);
    for (const needle of carrier.uses) {
      expect(doc, `${carrier.useFile ?? carrier.file} must contain: ${needle}`).toContain(needle);
    }
  });

  it('no document holds a finder block that is not registered (and every registered one exists)', () => {
    const holders = SCANNED.filter((rel) => extractFinderBlocks(read(rel)).length > 0);
    expect(holders).toEqual(CARRIERS.map((c) => c.file).sort());
  });

  it('the steps come in order: working directory, host-written path, newest cache, marketplace', () => {
    for (const kind of ['command', 'reference']) {
      const [opener, cwdLoop, hostStep, cacheStep, mirrorStep] = canonicalLines(kind);
      expect(opener).toContain('T="');
      expect(cwdLoop.indexOf('plugins/artibot')).toBeGreaterThan(-1);
      expect(cwdLoop.indexOf('plugins/artibot')).toBeLessThan(cwdLoop.indexOf(' .;'));
      expect(hostStep).toContain('"$T/$F"');
      expect(cacheStep).toContain('cache/artibot/artibot');
      expect(mirrorStep).toContain('marketplaces');
    }
  });

  it('every working-directory candidate is gated by the manifest name check (review N-c)', () => {
    for (const kind of ['command', 'reference']) {
      const cwdLoop = canonicalLines(kind)[1];
      expect(cwdLoop).toContain(`${NAME_CHECK} "$d/.claude-plugin/plugin.json"`);
      // The probe of the file comes first and the manifest second, both before `R=` is set.
      expect(cwdLoop.indexOf('[ -f "$d/$F" ]')).toBeLessThan(cwdLoop.indexOf('grep -q'));
      expect(cwdLoop.indexOf('grep -q')).toBeLessThan(cwdLoop.indexOf('R="$d"'));
    }
  });

  it('the block extractor is not blind (self-check)', () => {
    const doc = ['```bash', finderFor('a/b.js'), '```'].join('\n');
    const [only] = extractFinderBlocks(doc);
    expect(only).toEqual({ probe: 'a/b.js', text: finderFor('a/b.js'), fenced: true, line: 2 });
    expect(extractFinderBlocks(finderFor('a/b.js'))[0].fenced).toBe(false);
    expect(extractFinderBlocks('nothing here')).toEqual([]);
    expect(finderFor('a/b.js', 'command')).not.toBe(finderFor('a/b.js', 'reference'));
    // An old five-line block (no T, no manifest check) is no longer recognised as a carrier.
    expect(extractFinderBlocks('F="a/b.js"; R=""; P="$HOME/.claude/plugins"')).toEqual([]);
  });
});

describe('plugin-root finder: the manifest name check', () => {
  const COWORK = path.resolve(PLUGIN_ROOT, '..', 'artibot-cowork', '.claude-plugin', 'plugin.json');
  /** The JS twin of the grep the block runs. */
  const GREP_TWIN = /"name"\s*:\s*"artibot"/;

  it('the real plugin manifest passes it, so the source repo keeps dogfooding', () => {
    const text = read('.claude-plugin/plugin.json');
    expect(GREP_TWIN.test(text)).toBe(true);
    expect(JSON.parse(text).name).toBe('artibot');
  });

  it.skipIf(!existsSync(COWORK))('the sibling cowork plugin manifest does not pass it', () => {
    expect(GREP_TWIN.test(lf(readFileSync(COWORK, 'utf-8')))).toBe(false);
  });

  it('the twin discriminates (self-check)', () => {
    expect(GREP_TWIN.test('{"name":"artibot"}')).toBe(true);
    expect(GREP_TWIN.test('{ "name"  :  "artibot" }')).toBe(true);
    expect(GREP_TWIN.test('{"name":"artibot-cowork"}')).toBe(false);
    expect(GREP_TWIN.test('{"name":"my-artibot"}')).toBe(false);
  });
});

/** A line that tells Claude to run a script by a cwd-relative path. */
const RUN_RELATIVE = /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*(?:-e\s+)?["'`]?(?:\.\/)?(?:plugins\/artibot\/)?(?:scripts|lib|bin|server|hooks)\//;
/** The same through a shell interpreter. */
const SHELL_RELATIVE = /\b(?:bash|sh)\s+["'`]?(?:\.\/)?(?:plugins\/artibot\/)?(?:scripts|hooks|bin)\//;
/** A dynamic import or require resolved against the working directory. */
const IMPORT_RELATIVE = /\b(?:import|require)\(\s*['"]\.{1,2}\/(?:lib|scripts|tests)\//;
/**
 * A Glob/Read pattern anchored at the Artibot source layout: a backticked or
 * double-quoted span that starts at `plugins/artibot/<dir>/` and contains a star.
 */
const PLUGIN_GLOB = /(?:`|")plugins\/artibot\/(?:commands|agents|skills|hooks)\/[^`"\n]*\*[^`"\n]*(?:`|")/;

/**
 * @param {string} line
 * @returns {boolean} true when the line is a cwd-relative run/read instruction
 */
export function isRepoRelativeInstruction(line) {
  return [RUN_RELATIVE, SHELL_RELATIVE, IMPORT_RELATIVE, PLUGIN_GLOB].some((re) => re.test(line));
}

/**
 * Known, deliberate exceptions. Exact counts: more or fewer is RED, so the table
 * cannot rot into a blanket allowance.
 */
const EXCEPTIONS = new Map([
  [
    'commands/team.md',
    {
      count: 1,
      why: 'A parenthetical that names the source-repo spelling of render-progress.js beside the portable form; the paragraph already says to fall back to inline output.',
    },
  ],
  [
    'commands/repo.md',
    {
      count: 1,
      why: 'The citation pre-pass imports tests/firewall/citation-resolution.js and resolves the repo root two levels above the plugin root; it is a maintainer check that needs the Artibot source checkout and is documented as run alongside the manual sample.',
    },
  ],
  [
    'skills/skill-authoring/SKILL.md',
    {
      count: 2,
      why: 'Authoring-time commands for people editing skills inside the Artibot repo (scripts/ci/lint-skill-descriptions.js); they run from the plugin directory of a source checkout by definition.',
    },
  ],
]);

/** The `:-` spelling is never substituted by the host, so a command must not use it. */
const COLON_DASH_EXCEPTIONS = new Map([
  [
    'commands/model-routing.md',
    {
      count: 1,
      why: 'Its own resolver tests the env var explicitly and then searches the plugin cache and the marketplace copy, so it does not depend on the host substitution (works on a marketplace-only install).',
    },
  ],
]);

/** @returns {Map<string, number[]>} file to the 1-based lines that trip a matcher */
function scanTree(matches, files = SCANNED) {
  const hits = new Map();
  for (const rel of files) {
    const found = read(rel).split('\n').flatMap((line, i) => (matches(line) ? [i + 1] : []));
    if (found.length > 0) hits.set(rel, found);
  }
  return hits;
}

/** Compare a scan against an exception table; returns human-readable problems. */
function compareToTable(hits, table, what) {
  const problems = [];
  for (const [rel, lines] of hits) {
    const entry = table.get(rel);
    if (entry === undefined) problems.push(`${rel}:${lines.join(',')} ${what}`);
    else if (entry.count !== lines.length) problems.push(`${rel}: ${lines.length} hits, registered ${entry.count} (lines ${lines.join(',')})`);
  }
  return problems;
}

describe('plugin-root finder: no new cwd-relative run instruction (ratchet)', () => {
  const hits = scanTree(isRepoRelativeInstruction);

  it('every hit is a registered exception with the exact count', () => {
    const problems = compareToTable(hits, EXCEPTIONS, 'is a cwd-relative run/read instruction');
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('no exception is stale (a fixed file must leave the table)', () => {
    const stale = [...EXCEPTIONS.keys()].filter((rel) => !hits.has(rel));
    expect(stale, `stale exceptions: ${stale.join(', ')}`).toEqual([]);
  });

  it('every exception carries a real reason', () => {
    for (const [rel, entry] of [...EXCEPTIONS, ...COLON_DASH_EXCEPTIONS]) {
      expect(entry.why.length, `${rel}: reason too short`).toBeGreaterThanOrEqual(40);
      expect(Number.isInteger(entry.count) && entry.count >= 1, `${rel}: count`).toBe(true);
    }
  });

  it('the scanner flags the broken forms (positive control)', () => {
    for (const bad of [
      'Execute `node plugins/artibot/scripts/export-to-tool.mjs` with the parsed arguments',
      'Bash: `node scripts/checkpoint/resume-report.mjs --all`',
      '   node ./scripts/x.mjs --flag',
      'node plugins/artibot/hooks/pre-write.js',
      'run `bash plugins/artibot/scripts/sync-local.sh` first',
      '  sh ./scripts/install.sh',
      `node -e "import('./lib/learning/memory/dream/collector.js').then(x)"`,
      `node -e "const m = require('./lib/core/config.js');"`,
      `node --input-type=module -e "const m=await import('./lib/git/merge-preflight.js');"`,
      'Enumerate with `Glob "plugins/artibot/skills/*/SKILL.md"` now',
      '   - Skills: `plugins/artibot/skills/*/SKILL.md` frontmatter',
    ]) {
      expect(isRepoRelativeInstruction(bad), bad).toBe(true);
    }
  });

  it('the scanner leaves the fixed forms alone (negative control)', () => {
    for (const ok of [
      'node "<pluginRoot>/scripts/squash-wip.mjs" --dry-run',
      'node <pluginRoot>/scripts/split/dispatch.mjs <limb>',
      'node "$R/scripts/x.mjs"',
      'bash "$R/scripts/x.sh"',
      'node "$HOME/.claude/artibot/scripts/render-progress.js" 1 2',
      'node "' + TOKEN + '/scripts/route-lifecycle.mjs" ship "$ARGUMENTS"',
      'node --check {script}',
      'node app.js',
      'git push scripts/ now',
      "load('lib/git/repo-acquire.js')",
      'import(pathToFileURL(path.join(process.argv[1], p)).href)',
      'Glob `skills/*/SKILL.md` under the plugin root',
      '//   ARTIBOT_PLUGIN_ROOT="<pluginRoot>" node --input-type=module <this code, from a file or stdin>',
    ]) {
      expect(isRepoRelativeInstruction(ok), ok).toBe(false);
    }
  });
});

describe('plugin-root finder: commands never use the :- spelling the host does not substitute', () => {
  const colonDash = scanTree((line) => line.includes('CLAUDE_PLUGIN_ROOT:-'), SCANNED.filter((rel) => rel.startsWith('commands/')));

  it('every occurrence is registered with its exact count', () => {
    const problems = compareToTable(colonDash, COLON_DASH_EXCEPTIONS, 'uses the :- spelling, which the host never substitutes');
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('no registered exception is stale', () => {
    const stale = [...COLON_DASH_EXCEPTIONS.keys()].filter((rel) => !colonDash.has(rel));
    expect(stale).toEqual([]);
  });
});

/** The probe file of the executable scenarios (any file the carriers probe would do). */
const F = 'scripts/squash-wip.mjs';

/**
 * Build every executable scenario. Fixtures are created here (before the batch starts),
 * `want[id]` is the path the scenario must print, and a scenario without an entry has its
 * own assertion. `substitute` models the HOST: it replaces the exact token in the text with
 * a literal path before bash sees it. `kind` picks the command or reference spelling.
 *
 * @param {string} base - Temp directory that owns every fixture.
 */
function buildCases(base) {
  const foreign = path.join(base, 'project');
  const emptyHome = path.join(base, 'empty-home');
  mkdirSync(foreign, { recursive: true });
  mkdirSync(emptyHome, { recursive: true });
  const cases = [];
  const want = {};
  const add = (id, o, expected) => {
    const { file = F, kind = 'command', substitute, home = emptyHome, cwd = foreign, envRoot, nounset = false } = o;
    let script = finderFor(file, kind);
    if (substitute !== undefined) script = script.replaceAll(TOKEN, substitute);
    cases.push({ id, script, cwd, home, envRoot, nounset });
    if (expected !== undefined) want[id] = expected;
  };
  /** A fake Artibot source repo: `<dir>/plugins/artibot` with the probe file and (optionally) a manifest. */
  const repo = (dir, { manifest = 'artibot', withFile = true, raw } = {}) => {
    const plugin = path.join(dir, 'plugins', 'artibot');
    if (withFile) touch(path.join(plugin, F));
    if (manifest !== null) writeManifest(plugin, manifest, raw);
    return plugin;
  };
  /** A home holding one installed cache copy, the place every decoy scenario must fall through to. */
  const cacheHome = (name) => {
    const home = path.join(base, name);
    touch(path.join(cacheDir(home, '4.70.0'), F));
    return home;
  };

  // -- install layouts --------------------------------------------------------------
  const numeric = path.join(base, 'home-numeric');
  for (const v of ['3.0.0', '4.9.0', '4.10.0']) touch(path.join(cacheDir(numeric, v), F));
  mkdirSync(cacheDir(numeric, '4.11.0'), { recursive: true });
  add('numeric', { home: numeric }, cacheDir(numeric, '4.10.0'));

  const spaced = cacheHome('home with space');
  add('home-space', { home: spaced }, cacheDir(spaced, '4.70.0'));
  const unicode = cacheHome('홍길동');
  add('home-nonascii', { home: unicode }, cacheDir(unicode, '4.70.0'));

  const market = path.join(base, 'home-marketplace');
  touch(path.join(mirrorDir(market), F));
  add('marketplace', { home: market }, mirrorDir(market));
  add('not-found', {});

  // -- host substitution (the token is replaced by a literal path before bash runs) ----
  const installed = path.join(base, 'installed-plugin');
  touch(path.join(installed, F));
  add('host-valid', { substitute: posix(installed) }, installed);

  const s1Cache = cacheDir(path.join(base, 'home-s1'), '4.70.0');
  touch(path.join(s1Cache, F));
  const s1Plugin = repo(path.join(base, 'source-repo-s1'));
  add('host-vs-source-root', { cwd: path.dirname(path.dirname(s1Plugin)), substitute: posix(s1Cache) }, s1Plugin);
  add('host-vs-source-plugin', { cwd: s1Plugin, substitute: posix(s1Cache) }, s1Plugin);

  const programFiles = path.join(base, 'Program Files (x86)', 'artibot 4.70');
  touch(path.join(programFiles, F));
  add('host-space', { substitute: posix(programFiles) }, programFiles);
  const obrien = path.join(base, "O'Brien", 'artibot');
  touch(path.join(obrien, F));
  add('host-apostrophe', { substitute: posix(obrien) }, obrien);

  const dollarHome = cacheHome('home-dollar');
  add('host-dollar', { home: dollarHome, substitute: posix(path.join(base, 'dollar$x', 'artibot')) }, cacheDir(dollarHome, '4.70.0'));
  const staleHome = path.join(base, 'home-stale');
  touch(path.join(cacheDir(staleHome, '4.71.0'), F));
  add('host-stale', { home: staleHome, substitute: posix(cacheDir(staleHome, '4.70.0')) }, cacheDir(staleHome, '4.71.0'));

  // -- no substitution (a host that does not replace the token, or a reference file) ----
  const envHome = cacheHome('home-env');
  const envRoot = path.join(base, 'env-root');
  touch(path.join(envRoot, F));
  for (const kind of ['command', 'reference']) {
    add(`env-hit-${kind}`, { home: envHome, kind, envRoot }, envRoot);
    add(`env-miss-${kind}`, { home: envHome, kind, envRoot: path.join(base, 'nope') }, cacheDir(envHome, '4.70.0'));
  }
  const nounsetHome = cacheHome('home-nounset');
  add('nounset-reference', { home: nounsetHome, kind: 'reference', nounset: true }, cacheDir(nounsetHome, '4.70.0'));

  const srcPlugin = repo(path.join(base, 'source-repo'));
  add('source-from-repo-root', { cwd: path.dirname(path.dirname(srcPlugin)) }, srcPlugin);
  add('source-from-plugin-dir', { cwd: srcPlugin }, srcPlugin);

  // -- decoys: a folder that holds the file but is not this plugin (review N-c) --------
  const d1Home = cacheHome('home-d1');
  repo(path.join(base, 'decoy-no-manifest'), { manifest: null });
  add('decoy-no-manifest', { home: d1Home, cwd: path.join(base, 'decoy-no-manifest') }, cacheDir(d1Home, '4.70.0'));
  const d2Home = cacheHome('home-d2');
  repo(path.join(base, 'decoy-cowork'), { manifest: 'artibot-cowork' });
  add('decoy-other-name', { home: d2Home, cwd: path.join(base, 'decoy-cowork') }, cacheDir(d2Home, '4.70.0'));
  const d3Home = cacheHome('home-d3');
  touch(path.join(base, 'decoy-dot', F));
  add('decoy-dot-no-manifest', { home: d3Home, cwd: path.join(base, 'decoy-dot') }, cacheDir(d3Home, '4.70.0'));
  const d4Home = cacheHome('home-d4');
  repo(path.join(base, 'decoy-no-file'), { withFile: false });
  add('decoy-manifest-without-file', { home: d4Home, cwd: path.join(base, 'decoy-no-file') }, cacheDir(d4Home, '4.70.0'));
  const spacing = repo(path.join(base, 'manifest-spacing'), { raw: '{"name"  :"artibot"}\n' });
  add('manifest-spacing', { cwd: path.dirname(path.dirname(spacing)) }, spacing);

  // -- the REAL plugin directory, with its real manifest, as the working directory -----
  add('real-plugin', { cwd: PLUGIN_ROOT, file: 'lib/core/skill-hash.js' }, PLUGIN_ROOT);
  return { cases, want, foreign };
}

const bash = probeBash();
if (!bash.ok) announceBashSkip('plugin-root-finder/executable');

describe.skipIf(!bash.ok)('plugin-root finder: the block runs', () => {
  let base = '';
  let run;
  let want;
  let foreign;
  let total = 0;
  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'artibot-finder-'));
    const built = buildCases(base);
    ({ want, foreign } = built);
    total = built.cases.length;
    run = runBatch(path.join(base, 'batch'), built.cases);
  }, 240_000);
  afterAll(() => {
    if (base !== '') rmSync(base, { recursive: true, force: true });
  });

  const res = (id) => {
    const r = run.results.get(id);
    if (r === undefined) throw new Error(`no such case: ${id}`);
    return r;
  };
  /** The scenario printed exactly the path it was built to find, and nothing went to stderr. */
  const prints = (id) => {
    const r = res(id);
    expect(r.status, `${id} status (stderr: ${r.err})`).toBe(0);
    expect(r.err, `${id} stderr`).toBe('');
    expect(same(r.out, want[id]), `${id}: printed ${r.out}, wanted ${want[id]}`).toBe(true);
  };

  it('the batch driver ran every scenario to completion', () => {
    expect(run.driver.timedOut, 'driver timed out').toBe(false);
    expect([...run.results].filter(([, r]) => r.status === null).map(([id]) => id)).toEqual([]);
    // CARDINALITY ANCHOR: a driver that ran nothing would leave every `prints` below to fail one
    // by one; this says so once, and pins that the scenario list did not quietly shrink.
    expect(run.results.size).toBe(total);
    expect(total).toBeGreaterThanOrEqual(25);
  });

  it('picks the highest version by NUMBER, and skips a directory that lacks the file', () => prints('numeric'));
  it('works when HOME contains a space', () => prints('home-space'));
  it('works when HOME contains non-ASCII characters', () => prints('home-nonascii'));
  it('falls back to the marketplace copy when the cache has nothing', () => prints('marketplace'));
  it('prints the not-found line and exits 0 when nothing is installed', () => {
    expect(res('not-found')).toEqual({ status: 0, out: NOT_FOUND, err: '' });
  });

  describe('host substitution (the token is replaced by a literal path before bash runs)', () => {
    it('uses the host-written path when the working directory offers nothing', () => prints('host-valid'));
    it('prefers the working-directory source tree over the host-written installed copy (review S1)', () => {
      prints('host-vs-source-root');
      prints('host-vs-source-plugin');
    });
    it('works when the host-written path contains a space', () => prints('host-space'));
    it('works when the host-written path contains an apostrophe (why the quotes are double)', () => prints('host-apostrophe'));
    it('falls through, without a syntax error, when the host-written path holds a dollar sign', () => prints('host-dollar'));
    it('falls through to the cache when the host-written path went stale (plugin updated mid-session)', () => prints('host-stale'));
  });

  describe('no substitution (a host that does not replace the token, or a reference file)', () => {
    it('reads CLAUDE_PLUGIN_ROOT from the environment when it holds the file, and falls through when it does not', () => {
      for (const kind of ['command', 'reference']) {
        prints(`env-hit-${kind}`);
        prints(`env-miss-${kind}`);
      }
    });
    it('the reference spelling survives `set -u` with the variable unset', () => prints('nounset-reference'));
    it('keeps the source-repo behaviour: plugins/artibot from the repo root, . from the plugin root', () => {
      prints('source-from-repo-root');
      prints('source-from-plugin-dir');
    });
  });

  describe('decoys: a working directory that holds the file but is not this plugin (review N-c)', () => {
    it('ignores plugins/artibot/<file> when there is no manifest', () => prints('decoy-no-manifest'));
    it('ignores it when the manifest names artibot-cowork (the closing quote matters)', () => prints('decoy-other-name'));
    it('ignores the working directory itself when it holds the file but no manifest', () => prints('decoy-dot-no-manifest'));
    it('still needs the file: a manifest without the probe file is skipped', () => prints('decoy-manifest-without-file'));
    it('accepts a manifest whose JSON is spaced differently (the check is a pattern, not a formatter match)', () => prints('manifest-spacing'));
  });

  it('prints a path that a child node process can import by file URL (the contract the commands rely on)', () => {
    prints('real-plugin');
    const code = [
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const m = await import(pathToFileURL(path.join(process.argv[1], 'lib/core/skill-hash.js')).href);",
      'process.stdout.write(typeof m.computeHash);',
    ].join('');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, res('real-plugin').out], {
      cwd: foreign, encoding: 'utf-8', timeout: 60_000,
    });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('function');
  });
});

describe('repo.md: the deep flag in the doc and in the snippet agree (review N6)', () => {
  const doc = read('commands/repo.md');
  it('the snippet accepts both spellings and the doc names both', () => {
    expect(doc).toContain("deep:['deep','--deep'].includes(process.argv[3])");
    expect(doc).toContain('Pass `deep` (or `--deep`) as the third argument');
    expect(doc).not.toContain("process.argv[3]==='deep'");
  });
});
