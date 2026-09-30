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
 * finder block (CANONICAL below): `CLAUDE_PLUGIN_ROOT`, then `plugins/artibot`,
 * then `.`, then the newest plugin-cache version (numeric sort), then the
 * marketplace copy. It tests for the SPECIFIC file the carrier needs, so a stale
 * or half-installed directory is skipped instead of chosen.
 *
 * The first candidate is the exact braced token. Measured 2026-09-30 by loading
 * `artibot:spec` and `artibot:verify`: the host substitutes that exact token
 * inline in command text (spec.md:43 arrived as an absolute cache path) and does
 * NOT substitute the `:-` form (verify.md:56 arrived unchanged). So in a command
 * the first candidate is already the running plugin's own root.
 *
 * -- What this file gates --------------------------------------------------------
 *  1. Every carrier's block is byte-identical to CANONICAL (only `F` differs),
 *     sits in a fence, probes a file that exists, and its `<pluginRoot>` uses are
 *     present. Copies that drift apart are the failure this prevents.
 *  2. The set of files holding a block equals CARRIERS exactly (no unregistered
 *     copy, no stale entry).
 *  3. A ratchet: no command or skill may tell Claude to run a cwd-relative
 *     `node scripts/...`, `node plugins/artibot/...`, a cwd-relative
 *     `import('./lib/...')`, or a `Glob` under `plugins/artibot/`. Known
 *     exceptions are registered with an exact count and a reason.
 *  4. The block really runs: in a fake HOME, with a foreign cwd, with a space and
 *     with non-ASCII characters in HOME, with two versions that sort differently
 *     as text and as numbers, with only the marketplace copy, and with nothing.
 *
 * -- What this gate cannot see (rules 9: written next to the gate) ---------------
 *  - Whether a model follows the instruction. Nothing here runs a model.
 *  - The real host. The braced-token substitution was measured by hand once, on
 *    one host version; a host that stops substituting still passes (the block
 *    falls through to the other candidates), and one that changes the substituted
 *    form is not observed here.
 *  - zsh: the block is exercised under bash only. It uses no bash-only syntax and
 *    no unmatched glob (marketplace ids come from `ls`, not a glob).
 *  - `CLAUDE_CONFIG_DIR`: a relocated `~/.claude` is not searched.
 *  - Trust: candidates 2-3 (`plugins/artibot`, `.`) are taken from the working
 *    directory, so a project that plants that file layout is preferred over the
 *    installed copy. The literal path the old text ran had exactly that trust.
 *  - Skills: `${CLAUDE_PLUGIN_ROOT}` substitution in SKILL.md content is inferred
 *    from the plugin docs, not measured (only commands were loaded above).
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

/** The finder, one line per array element. `__FILE__` is the only free part. */
const CANONICAL_LINES = [
  'F="__FILE__"; R=""; P="$HOME/.claude/plugins"',
  'for d in "$' + '{CLAUDE_PLUGIN_ROOT}" plugins/artibot .; do [ -n "$d" ] && [ -f "$d/$F" ] && R="$d" && break; done',
  '[ -z "$R" ] && for v in $(ls -1 "$P/cache/artibot/artibot" 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr); do [ -f "$P/cache/artibot/artibot/$v/$F" ] && R="$P/cache/artibot/artibot/$v" && break; done',
  '[ -z "$R" ] && for m in $(ls -1 "$P/marketplaces" 2>/dev/null); do [ -f "$P/marketplaces/$m/plugins/artibot/$F" ] && R="$P/marketplaces/$m/plugins/artibot" && break; done',
  '[ -n "$R" ] && (cd "$R" && { pwd -W 2>/dev/null || pwd; }) || echo "artibot plugin root not found - run /update"',
];
const NOT_FOUND = 'artibot plugin root not found - run /update';
const finderFor = (file) => CANONICAL_LINES.join('\n').replace('__FILE__', file);

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
    file: 'skills/split/references/operations.md',
    probe: 'scripts/split/lane-state.mjs',
    useFile: 'commands/split.md',
    uses: ['<pluginRoot>/scripts/split/lane-state.mjs', '"<pluginRoot>" <runId>', "load('lib/git/batch-landing.js')"],
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
    const body = lines.slice(i, i + CANONICAL_LINES.length).map((l) => l.trim());
    const before = (lines[i - 1] ?? '').trim();
    const after = (lines[i + CANONICAL_LINES.length] ?? '').trim();
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

const SCANNED = [...listMarkdown('commands'), ...listMarkdown('skills')];

describe('plugin-root finder: the copies in the carriers', () => {
  it('scans a plausible number of documents (0 violations is not 0 documents)', () => {
    expect(SCANNED.length).toBeGreaterThan(150);
    expect(CARRIERS.length).toBe(9);
  });

  it.each(CARRIERS.map((c) => [c.file, c]))('%s holds exactly one fenced block, identical to the canonical text', (_file, carrier) => {
    const blocks = extractFinderBlocks(read(carrier.file));
    expect(blocks.length, `${carrier.file}: finder blocks found`).toBe(1);
    expect(blocks[0].fenced, `${carrier.file}: block is not inside a fenced code block`).toBe(true);
    expect(blocks[0].probe).toBe(carrier.probe);
    expect(blocks[0].text).toBe(finderFor(carrier.probe));
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

  it('the block extractor is not blind (self-check)', () => {
    const doc = ['```bash', finderFor('a/b.js'), '```'].join('\n');
    const [only] = extractFinderBlocks(doc);
    expect(only).toEqual({ probe: 'a/b.js', text: finderFor('a/b.js'), fenced: true, line: 2 });
    expect(extractFinderBlocks(finderFor('a/b.js'))[0].fenced).toBe(false);
    expect(extractFinderBlocks('nothing here')).toEqual([]);
  });
});

/** A line that tells Claude to run a script by a cwd-relative path. */
const RUN_RELATIVE = /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*(?:-e\s+)?["'`]?(?:\.\/)?(?:plugins\/artibot\/)?(?:scripts|lib|bin|server)\//;
/** A dynamic import resolved against the working directory. */
const IMPORT_RELATIVE = /\bimport\(\s*['"]\.{1,2}\/(?:lib|scripts|tests)\//;
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
  return RUN_RELATIVE.test(line) || IMPORT_RELATIVE.test(line) || PLUGIN_GLOB.test(line);
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

/** @returns {Map<string, number[]>} file to the 1-based lines that trip the scanner */
function scanTree(files = SCANNED) {
  const hits = new Map();
  for (const rel of files) {
    const found = read(rel).split('\n').flatMap((line, i) => (isRepoRelativeInstruction(line) ? [i + 1] : []));
    if (found.length > 0) hits.set(rel, found);
  }
  return hits;
}

describe('plugin-root finder: no new cwd-relative run instruction (ratchet)', () => {
  const hits = scanTree();

  it('every hit is a registered exception with the exact count', () => {
    const unregistered = [];
    for (const [rel, lines] of hits) {
      const entry = EXCEPTIONS.get(rel);
      if (entry === undefined) unregistered.push(`${rel}:${lines.join(',')} is a cwd-relative run/read instruction`);
      else if (entry.count !== lines.length) unregistered.push(`${rel}: ${lines.length} hits, registered ${entry.count} (lines ${lines.join(',')})`);
    }
    expect(unregistered, unregistered.join('\n')).toEqual([]);
  });

  it('no exception is stale (a fixed file must leave the table)', () => {
    const stale = [...EXCEPTIONS.keys()].filter((rel) => !hits.has(rel));
    expect(stale, `stale exceptions: ${stale.join(', ')}`).toEqual([]);
  });

  it('every exception carries a real reason', () => {
    for (const [rel, entry] of EXCEPTIONS) {
      expect(entry.why.length, `${rel}: reason too short`).toBeGreaterThanOrEqual(40);
      expect(Number.isInteger(entry.count) && entry.count >= 1, `${rel}: count`).toBe(true);
    }
  });

  it('the scanner flags the broken forms (positive control)', () => {
    for (const bad of [
      'Execute `node plugins/artibot/scripts/export-to-tool.mjs` with the parsed arguments',
      'Bash: `node scripts/checkpoint/resume-report.mjs --all`',
      '   node ./scripts/x.mjs --flag',
      `node -e "import('./lib/learning/memory/dream/collector.js').then(x)"`,
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
      'node "$HOME/.claude/artibot/scripts/render-progress.js" 1 2',
      'node "$' + '{CLAUDE_PLUGIN_ROOT}/scripts/route-lifecycle.mjs" ship "$ARGUMENTS"',
      'node --check {script}',
      'node app.js',
      "load('lib/git/repo-acquire.js')",
      'import(pathToFileURL(path.join(process.argv[1], p)).href)',
      'Glob `skills/*/SKILL.md` under the plugin root',
    ]) {
      expect(isRepoRelativeInstruction(ok), ok).toBe(false);
    }
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

  /** Run the block with a chosen HOME, cwd and optional CLAUDE_PLUGIN_ROOT. */
  const run = ({ home, cwd = foreign, env = {}, file = F }) => {
    const child = { ...process.env, HOME: home, USERPROFILE: home, ...env };
    if (env.CLAUDE_PLUGIN_ROOT === undefined) delete child.CLAUDE_PLUGIN_ROOT;
    const r = spawnSync('bash', ['-c', finderFor(file)], { cwd, env: child, encoding: 'utf-8' });
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
    const r = run({ home });
    expect(same(r.out, cacheDir(home, '4.70.0')), r.out).toBe(true);
  });

  it('works when HOME contains non-ASCII characters', () => {
    const home = path.join(base, '홍길동');
    touch(path.join(cacheDir(home, '4.70.0'), F));
    const r = run({ home });
    expect(same(r.out, cacheDir(home, '4.70.0')), r.out).toBe(true);
  });

  it('falls back to the marketplace copy when the cache has nothing', () => {
    const home = path.join(base, 'home-marketplace');
    const mp = path.join(home, '.claude', 'plugins', 'marketplaces', 'artibot', 'plugins', 'artibot');
    touch(path.join(mp, F));
    expect(same(run({ home }).out, mp)).toBe(true);
  });

  it('prints the not-found line and exits 0 when nothing is installed', () => {
    const r = run({ home: emptyHome });
    expect(r).toEqual({ status: 0, out: NOT_FOUND, err: '' });
  });

  it('prefers CLAUDE_PLUGIN_ROOT when it holds the file, and falls through when it does not', () => {
    const home = path.join(base, 'home-env');
    touch(path.join(cacheDir(home, '4.70.0'), F));
    const envRoot = path.join(base, 'env-root');
    touch(path.join(envRoot, F));
    expect(same(run({ home, env: { CLAUDE_PLUGIN_ROOT: envRoot } }).out, envRoot)).toBe(true);
    expect(same(run({ home, env: { CLAUDE_PLUGIN_ROOT: path.join(base, 'nope') } }).out, cacheDir(home, '4.70.0'))).toBe(true);
  });

  it('keeps the source-repo behaviour: plugins/artibot from the repo root, . from the plugin root', () => {
    const repo = path.join(base, 'source-repo');
    const plugin = path.join(repo, 'plugins', 'artibot');
    touch(path.join(plugin, F));
    expect(same(run({ home: emptyHome, cwd: repo }).out, plugin)).toBe(true);
    expect(same(run({ home: emptyHome, cwd: plugin }).out, plugin)).toBe(true);
  });

  it('prints a path that a child node process can import by file URL (the contract the commands rely on)', () => {
    const real = run({ home: emptyHome, cwd: PLUGIN_ROOT, file: 'lib/core/skill-hash.js' });
    expect(same(real.out, PLUGIN_ROOT), real.out).toBe(true);
    const code = [
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const m = await import(pathToFileURL(path.join(process.argv[1], 'lib/core/skill-hash.js')).href);",
      "process.stdout.write(typeof m.computeHash);",
    ].join('');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, real.out], { cwd: foreign, encoding: 'utf-8' });
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('function');
  });
});
