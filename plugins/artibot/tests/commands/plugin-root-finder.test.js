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
 * finder block: `plugins/artibot` and `.` (the Artibot source repo, in both cwd
 * layouts), then the host-written plugin path, then the newest plugin-cache
 * version (numeric sort), then the marketplace copy. It tests for the SPECIFIC
 * file the carrier needs, so a stale or half-installed directory is skipped.
 * Checking the working directory FIRST keeps the source repo dogfooding its own
 * tree: the host-written path is always the INSTALLED copy, so putting it first
 * made /squash, /ship and /export run the cache inside the repo (review finding).
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
 * The same measurement is why the `REC=`/`USG=`/`ENGINE=` chains in verify, team,
 * autopilot, split, theme and watch now spell their middle candidate as the exact
 * token: with `:-` it was never replaced, so on a marketplace-only install (no
 * `~/.claude/artibot` global copy, empty env) those steps silently found nothing.
 *
 * -- What this file gates --------------------------------------------------------
 *  1. Every carrier's block is byte-identical to the canonical text for its kind
 *     (only `F` differs), sits in a fence, probes a file that exists, and its
 *     `<pluginRoot>` uses are present.
 *  2. The set of files holding a block equals CARRIERS exactly.
 *  3. A ratchet: no command, skill or agent may tell Claude to run a cwd-relative
 *     `node scripts/...`, `bash plugins/artibot/scripts/...`, `require('./lib/...')`,
 *     `import('./lib/...')`, or a `Glob` under `plugins/artibot/`. Known exceptions
 *     carry an exact count and a reason. The `:-` spelling is banned in commands.
 *  4. The block really runs: host substitution is MODELLED by replacing the token
 *     with a literal path (valid, stale, with a space, with a `$`), with the source
 *     layouts, a space and non-ASCII characters in HOME, two versions that sort
 *     differently as text and as numbers, marketplace only, and nothing installed.
 *  5. The existing chains resolve on a simulated marketplace-only install.
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
 *  - zsh (the block uses no bash-only syntax and no unmatched glob, but only bash
 *    is exercised), and `CLAUDE_CONFIG_DIR` (a relocated `~/.claude` is not searched).
 *  - Trust: the working-directory candidates come first, so a project that plants
 *    `plugins/artibot/<file>` is preferred over the installed copy. The literal path
 *    the old text ran had exactly that trust, so this is not new exposure.
 *  - Native installs (`install.sh`): their global copy `~/.claude/artibot` is NOT a
 *    candidate of the block (it has no `agents/`, so a script that reads them would
 *    fail worse than "not found"). The chains keep it as their first candidate.
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announceBashSkip, probeBash } from '../../scripts/utils/bash-compat.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lf = (s) => s.replace(/\r\n/g, '\n');
const read = (rel) => lf(readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8'));
const posix = (p) => p.replaceAll('\\', '/');

/** The literal tokens, written so a linter does not read them as template placeholders. */
const TOKEN = '$' + '{CLAUDE_PLUGIN_ROOT}';
const TOKEN_ENV = '$' + '{CLAUDE_PLUGIN_ROOT:-}';
const NOT_FOUND = 'artibot plugin root not found - run /update';

/**
 * The finder, one line per element. `__FILE__` is the only free part; the host-written
 * candidate is the exact token in a command and the `:-` spelling in a reference file.
 */
function canonicalLines(kind) {
  const hostCandidate = kind === 'command' ? TOKEN : TOKEN_ENV;
  return [
    'F="__FILE__"; R=""; P="$HOME/.claude/plugins"',
    `for d in plugins/artibot . "${hostCandidate}"; do [ -n "$d" ] && [ -f "$d/$F" ] && R="$d" && break; done`,
    '[ -z "$R" ] && for v in $(ls -1 "$P/cache/artibot/artibot" 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr); do [ -f "$P/cache/artibot/artibot/$v/$F" ] && R="$P/cache/artibot/artibot/$v" && break; done',
    '[ -z "$R" ] && for m in $(ls -1 "$P/marketplaces" 2>/dev/null); do [ -f "$P/marketplaces/$m/plugins/artibot/$F" ] && R="$P/marketplaces/$m/plugins/artibot" && break; done',
    '[ -n "$R" ] && (cd "$R" && { pwd -W 2>/dev/null || pwd; }) || echo "artibot plugin root not found - run /update"',
  ];
}
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
    uses: ['-- "<pluginRoot>" $ARGUMENTS', '<pluginRoot>/lib/planning/scorecard.js'],
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
 * Extract finder blocks: a line that opens with `F="..."; R=""; P="$HOME/.claude/plugins"`
 * plus the four lines after it, requiring a fence line before and after.
 *
 * @param {string} text - Newline-normalised markdown.
 * @returns {Array<{ probe: string, text: string, fenced: boolean, line: number }>}
 */
export function extractFinderBlocks(text) {
  const lines = lf(text).split('\n');
  const opener = /^F="([^"]+)"; R=""; P="\$HOME\/\.claude\/plugins"$/;
  const blocks = [];
  lines.forEach((raw, i) => {
    const m = raw.trim().match(opener);
    if (m === null) return;
    const body = lines.slice(i, i + 5).map((l) => l.trim());
    const before = (lines[i - 1] ?? '').trim();
    const after = (lines[i + 5] ?? '').trim();
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
    expect(CARRIERS.length).toBe(10);
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

  it('the working-directory candidates come BEFORE the host-written path (source repo keeps dogfooding)', () => {
    for (const kind of ['command', 'reference']) {
      const loop = canonicalLines(kind)[1];
      expect(loop.indexOf('plugins/artibot')).toBeGreaterThan(-1);
      expect(loop.indexOf('plugins/artibot')).toBeLessThan(loop.indexOf(' . '));
      expect(loop.indexOf(' . ')).toBeLessThan(loop.indexOf('CLAUDE_PLUGIN_ROOT'));
    }
  });

  it('the block extractor is not blind (self-check)', () => {
    const doc = ['```bash', finderFor('a/b.js'), '```'].join('\n');
    const [only] = extractFinderBlocks(doc);
    expect(only).toEqual({ probe: 'a/b.js', text: finderFor('a/b.js'), fenced: true, line: 2 });
    expect(extractFinderBlocks(finderFor('a/b.js'))[0].fenced).toBe(false);
    expect(extractFinderBlocks('nothing here')).toEqual([]);
    expect(finderFor('a/b.js', 'command')).not.toBe(finderFor('a/b.js', 'reference'));
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

const bash = probeBash();
if (!bash.ok) announceBashSkip('plugin-root-finder/executable');

describe.skipIf(!bash.ok)('plugin-root finder: the block runs', () => {
  let base = '';
  let foreign = '';
  let emptyHome = '';
  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'artibot-finder-'));
    foreign = path.join(base, 'project');
    emptyHome = path.join(base, 'empty-home');
    mkdirSync(foreign, { recursive: true });
    mkdirSync(emptyHome, { recursive: true });
  });
  afterAll(() => {
    if (base !== '') rmSync(base, { recursive: true, force: true });
  });

  const touch = (p) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '// probe\n');
  };
  const F = 'scripts/squash-wip.mjs';

  /**
   * Run a block. `substitute` models the HOST: it replaces the exact token in the text with a
   * literal path before bash sees it. `kind` picks the command or reference spelling.
   */
  const run = ({ home, cwd = foreign, env = {}, file = F, kind = 'command', substitute, nounset = false }) => {
    let script = finderFor(file, kind);
    if (substitute !== undefined) script = script.replaceAll(TOKEN, substitute);
    const child = { ...process.env, HOME: home, USERPROFILE: home, ...env };
    if (env.CLAUDE_PLUGIN_ROOT === undefined) delete child.CLAUDE_PLUGIN_ROOT;
    const args = nounset ? ['-u', '-c', script] : ['-c', script];
    const r = spawnSync('bash', args, { cwd, env: child, encoding: 'utf-8' });
    return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  // Compare real paths: bash prints the canonical long form (`pwd -W`), while
  // os.tmpdir() can be an 8.3 short name (C:\Users\NAME~1) on the same directory.
  const canon = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const same = (a, b) => {
    const norm = (p) => canon(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
  };
  const cacheDir = (home, version) => path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', version);

  it('picks the highest version by NUMBER, and skips a directory that lacks the file', () => {
    const home = path.join(base, 'home-numeric');
    for (const v of ['3.0.0', '4.9.0', '4.10.0']) touch(path.join(cacheDir(home, v), F));
    mkdirSync(cacheDir(home, '4.11.0'), { recursive: true });
    const r = run({ home });
    expect(r.status).toBe(0);
    expect(same(r.out, cacheDir(home, '4.10.0')), r.out).toBe(true);
  });

  it('works when HOME contains a space', () => {
    const home = path.join(base, 'home with space');
    touch(path.join(cacheDir(home, '4.70.0'), F));
    expect(same(run({ home }).out, cacheDir(home, '4.70.0'))).toBe(true);
  });

  it('works when HOME contains non-ASCII characters', () => {
    const home = path.join(base, '\uD64D\uAE38\uB3D9');
    touch(path.join(cacheDir(home, '4.70.0'), F));
    expect(same(run({ home }).out, cacheDir(home, '4.70.0'))).toBe(true);
  });

  it('falls back to the marketplace copy when the cache has nothing', () => {
    const home = path.join(base, 'home-marketplace');
    const mp = path.join(home, '.claude', 'plugins', 'marketplaces', 'artibot', 'plugins', 'artibot');
    touch(path.join(mp, F));
    expect(same(run({ home }).out, mp)).toBe(true);
  });

  it('prints the not-found line and exits 0 when nothing is installed', () => {
    expect(run({ home: emptyHome })).toEqual({ status: 0, out: NOT_FOUND, err: '' });
  });

  describe('host substitution (the token is replaced by a literal path before bash runs)', () => {
    it('uses the host-written path when the working directory offers nothing', () => {
      const installed = path.join(base, 'installed-plugin');
      touch(path.join(installed, F));
      expect(same(run({ home: emptyHome, substitute: posix(installed) }).out, installed)).toBe(true);
    });

    it('prefers the working-directory source tree over the host-written installed copy (review S1)', () => {
      const installed = path.join(cacheDir(path.join(base, 'home-s1'), '4.70.0'));
      touch(path.join(installed, F));
      const repo = path.join(base, 'source-repo-s1');
      const plugin = path.join(repo, 'plugins', 'artibot');
      touch(path.join(plugin, F));
      const fromRepoRoot = run({ home: emptyHome, cwd: repo, substitute: posix(installed) });
      expect(same(fromRepoRoot.out, plugin), `repo root: ${fromRepoRoot.out}`).toBe(true);
      const fromPluginDir = run({ home: emptyHome, cwd: plugin, substitute: posix(installed) });
      expect(same(fromPluginDir.out, plugin), `plugin dir: ${fromPluginDir.out}`).toBe(true);
    });

    it('works when the host-written path contains a space', () => {
      const installed = path.join(base, 'Program Files (x86)', 'artibot 4.70');
      touch(path.join(installed, F));
      expect(same(run({ home: emptyHome, substitute: posix(installed) }).out, installed)).toBe(true);
    });

    it('works when the host-written path contains an apostrophe (why the quotes are double)', () => {
      const installed = path.join(base, "O'Brien", 'artibot');
      touch(path.join(installed, F));
      const r = run({ home: emptyHome, substitute: posix(installed) });
      expect(r.err).toBe('');
      expect(same(r.out, installed), r.out).toBe(true);
    });

    it('falls through, without a syntax error, when the host-written path holds a dollar sign', () => {
      const home = path.join(base, 'home-dollar');
      touch(path.join(cacheDir(home, '4.70.0'), F));
      const r = run({ home, substitute: posix(path.join(base, 'dollar$x', 'artibot')) });
      expect(r.status).toBe(0);
      expect(r.err).toBe('');
      expect(same(r.out, cacheDir(home, '4.70.0')), r.out).toBe(true);
    });

    it('falls through to the cache when the host-written path went stale (plugin updated mid-session)', () => {
      const home = path.join(base, 'home-stale');
      touch(path.join(cacheDir(home, '4.71.0'), F));
      const r = run({ home, substitute: posix(cacheDir(home, '4.70.0')) });
      expect(same(r.out, cacheDir(home, '4.71.0')), r.out).toBe(true);
    });
  });

  describe('no substitution (a host that does not replace the token, or a reference file)', () => {
    it('reads CLAUDE_PLUGIN_ROOT from the environment when it holds the file, and falls through when it does not', () => {
      const home = path.join(base, 'home-env');
      touch(path.join(cacheDir(home, '4.70.0'), F));
      const envRoot = path.join(base, 'env-root');
      touch(path.join(envRoot, F));
      for (const kind of ['command', 'reference']) {
        expect(same(run({ home, kind, env: { CLAUDE_PLUGIN_ROOT: envRoot } }).out, envRoot), kind).toBe(true);
        expect(same(run({ home, kind, env: { CLAUDE_PLUGIN_ROOT: path.join(base, 'nope') } }).out, cacheDir(home, '4.70.0')), kind).toBe(true);
      }
    });

    it('the reference spelling survives `set -u` with the variable unset', () => {
      const home = path.join(base, 'home-nounset');
      touch(path.join(cacheDir(home, '4.70.0'), F));
      const r = run({ home, kind: 'reference', nounset: true });
      expect(r.err).toBe('');
      expect(same(r.out, cacheDir(home, '4.70.0')), r.out).toBe(true);
    });

    it('keeps the source-repo behaviour: plugins/artibot from the repo root, . from the plugin root', () => {
      const repo = path.join(base, 'source-repo');
      const plugin = path.join(repo, 'plugins', 'artibot');
      touch(path.join(plugin, F));
      expect(same(run({ home: emptyHome, cwd: repo }).out, plugin)).toBe(true);
      expect(same(run({ home: emptyHome, cwd: plugin }).out, plugin)).toBe(true);
    });
  });

  it('prints a path that a child node process can import by file URL (the contract the commands rely on)', () => {
    const real = run({ home: emptyHome, cwd: PLUGIN_ROOT, file: 'lib/core/skill-hash.js' });
    expect(same(real.out, PLUGIN_ROOT), real.out).toBe(true);
    const code = [
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const m = await import(pathToFileURL(path.join(process.argv[1], 'lib/core/skill-hash.js')).href);",
      'process.stdout.write(typeof m.computeHash);',
    ].join('');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, real.out], { cwd: foreign, encoding: 'utf-8' });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('function');
  });

  describe('the REC/USG/ENGINE/PLUGIN_ROOT chains on a marketplace-only install', () => {
    /** `$HOME/.claude/artibot/<a>` then the exact token `<b>`, for REC, USG or ENGINE. */
    const ASSIGN_CHAIN = /((REC|USG|ENGINE)="\$HOME\/\.claude\/artibot\/([^"]+)"; \[ -f "\$\2" \] \|\| \2="\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)")/g;
    /** update.md and learning.md: the token first, the native-install default second. */
    const ROOT_CHAIN = /(PLUGIN_ROOT="\$\{CLAUDE_PLUGIN_ROOT\}"; \[ -f "\$PLUGIN_ROOT\/([^"]+)" \] \|\| PLUGIN_ROOT="\$HOME\/\.claude\/artibot")/g;

    /** Exact counts, so a chain that changes spelling cannot silently drop out of this test. */
    const ASSIGN_FILES = {
      'commands/verify.md': 1, 'commands/team.md': 2, 'commands/autopilot.md': 2, 'commands/split.md': 1,
      'commands/theme.md': 3, 'commands/watch.md': 1,
    };
    const ROOT_FILES = { 'commands/update.md': 2, 'commands/learning.md': 2 };

    const matchesIn = (rel, re) => [...read(rel).matchAll(re)];
    /** Print PLUGIN_ROOT the way the finder prints a root (`pwd -W` on Git Bash), so Node can compare it. */
    const PRINT_ROOT = '(cd "$PLUGIN_ROOT" && { pwd -W 2>/dev/null || pwd; })';

    it('finds exactly the chains it is meant to exercise', () => {
      for (const [rel, count] of Object.entries(ASSIGN_FILES)) expect(matchesIn(rel, ASSIGN_CHAIN).length, rel).toBe(count);
      for (const [rel, count] of Object.entries(ROOT_FILES)) expect(matchesIn(rel, ROOT_CHAIN).length, rel).toBe(count);
    });

    it('every token chain resolves to the cache copy when the host substitutes the token', () => {
      const home = path.join(base, 'pure-marketplace-home');
      const cache = cacheDir(home, '4.70.0');
      const failures = [];
      for (const rel of Object.keys(ASSIGN_FILES)) {
        for (const m of matchesIn(rel, ASSIGN_CHAIN)) {
          touch(path.join(cache, m[4]));
          const script = `${m[1].replaceAll(TOKEN, posix(cache))}; echo "$${m[2]}"`;
          const r = spawnSync('bash', ['-c', script], { cwd: foreign, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf-8' });
          if (!same(r.stdout.trim(), path.join(cache, m[4]))) failures.push(`${rel} ${m[2]}: ${r.stdout.trim()}`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });

    it('control: the same chains do NOT reach the cache when nothing is substituted (what the :- spelling did)', () => {
      const home = path.join(base, 'pure-marketplace-home');
      const cache = cacheDir(home, '4.70.0');
      const m = matchesIn('commands/verify.md', ASSIGN_CHAIN)[0];
      touch(path.join(cache, m[4]));
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.CLAUDE_PLUGIN_ROOT;
      const r = spawnSync('bash', ['-c', `${m[1]}; echo "$${m[2]}"`], { cwd: foreign, env, encoding: 'utf-8' });
      expect(same(r.stdout.trim(), path.join(cache, m[4]))).toBe(false);
    });

    it('update.md and learning.md use the substituted root, and keep the native-install default', () => {
      const home = path.join(base, 'pure-marketplace-home');
      const cache = cacheDir(home, '4.70.0');
      const nativeHome = path.join(base, 'native-home');
      for (const rel of Object.keys(ROOT_FILES)) {
        for (const m of matchesIn(rel, ROOT_CHAIN)) {
          touch(path.join(cache, m[2]));
          touch(path.join(nativeHome, '.claude', 'artibot', m[2]));
          const viaHost = spawnSync('bash', ['-c', `${m[1].replaceAll(TOKEN, posix(cache))}; ${PRINT_ROOT}`], {
            cwd: foreign, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf-8',
          });
          expect(same(viaHost.stdout.trim(), cache), `${rel} ${m[2]} via host: ${viaHost.stdout.trim()}`).toBe(true);
          const env = { ...process.env, HOME: nativeHome, USERPROFILE: nativeHome };
          delete env.CLAUDE_PLUGIN_ROOT;
          const native = spawnSync('bash', ['-c', `${m[1]}; ${PRINT_ROOT}`], { cwd: foreign, env, encoding: 'utf-8' });
          expect(same(native.stdout.trim(), path.join(nativeHome, '.claude', 'artibot')), `${rel} ${m[2]} native: ${native.stdout.trim()}`).toBe(true);
        }
      }
    });
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
