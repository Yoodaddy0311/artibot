/**
 * Purpose: the one-line script CHAINS in the command docs, the node RESOLVERS in five
 * of them, and `install.md`'s snippet all find the installed plugin from ANY working
 * directory, and a stale `~/.claude/artibot` copy never beats the plugin cache.
 * (The shared finder BLOCK is gated in `plugin-root-finder.test.js`.)
 *
 * -- What broke (measured 2026-09-30) -------------------------------------------
 * 1. Order. The chains in verify / team / autopilot / split / theme / watch / scorecard
 *    / update / learning tried `$HOME/.claude/artibot/<script>` BEFORE the plugin. On
 *    this machine that global copy (made by `install.sh`) was still 4.67.0 while the
 *    installed plugin was 4.70.x (memory note of the lead, not re-measured here), so a
 *    command ran a stale script ahead of the installed one.
 * 2. Reach. The resolvers in autopilot / autopilot-queue / go / plan scanned only
 *    `~/.claude/plugins/marketplaces/*`. A marketplace added from a DIRECTORY source
 *    has no such mirror, and the plugin then lives only in the cache, so they threw
 *    "engine not found" on a working install. The host-written token was not a
 *    candidate either.
 * 3. Quoting. `install.md` embedded the host-written path in single quotes, so a path
 *    with an apostrophe (C:/Users/O'Brien/...) was a syntax error.
 *
 * -- The order every chain now tries ---------------------------------------------
 *   1. the verified source: `plugins/artibot/<file>`, accepted only when
 *      `plugins/artibot/.claude-plugin/plugin.json` names `artibot`;
 *   2. the host-written plugin path (the exact braced token; the host replaces it
 *      inline, measured 2026-09-30);
 *   3. the newest plugin-cache version (numeric sort, skipping a version that lacks
 *      the file);
 *   4. `$HOME/.claude/artibot/<file>` (the legacy `install.sh` layout; it can lag the
 *      plugin by releases, so it comes after the cache);
 *   5. the marketplace copy.
 * `update.md` has NO source step, on purpose: `scripts/update.js` picks "native" or
 * "legacy" install from ITS OWN location (`lib/core/install-mode.js#detectInstallMode`
 * looks for the plugin cache in the script's path), so a working-tree copy would turn a
 * marketplace install into the legacy git-pull + `install.sh` flow.
 *
 * -- What this file gates --------------------------------------------------------
 *  1. Every chain in the docs is byte-identical to the template for its shape, the set
 *     of chains per file is exact, every script a chain names exists in the plugin
 *     tree, and no other line puts `$HOME/.claude/artibot` in an `[ -f ]` chain.
 *  2. The chains RUN, from ONE batched driver, against fake homes, taken from the docs
 *     themselves: with the token substituted and with it empty, a fake HOME that holds
 *     BOTH a stale `~/.claude/artibot` copy and a cache picks the cache (every chain);
 *     the legacy copy is still used when it is all there is; and, for one chain of each
 *     shape, source-first, decoys, token over cache, legacy over marketplace, numeric
 *     version order.
 *  3. The five node resolvers, cut from their docs and run as real modules: cache-only
 *     layout, token over cache, unsubstituted token skipped, cache over marketplace,
 *     the environment first, and "the legacy copy is not a candidate" (it has no `lib/`).
 *  4. `install.md`'s snippet reads its root from the environment and works from a
 *     foreign cwd with a path that holds an apostrophe and a space.
 *
 * -- What this gate cannot see (rules 9: written next to the gate) ---------------
 *  - Whether a model runs a chain, or copies it without changing a byte.
 *  - The real host. Its inline substitution is MODELLED (the token is replaced with a
 *    literal path before the script is written).
 *  - The CONTENT of a stale copy. It is modelled by presence; nothing here shows a
 *    real 4.67.0 script misbehaving.
 *  - A script that exists ONLY in the legacy copy. None exists today (gate 1 pins
 *    that every chain script is in the plugin tree); if one appears, its chain must
 *    keep the legacy copy for that file and say why in a comment next to it.
 *  - The optional `render-progress.js` mentions in team.md and autopilot.md. They are
 *    single paths with a documented inline fallback, not chains; the ratchet in
 *    `plugin-root-finder.test.js` still counts the one that names the source spelling.
 *  - The working-directory source step is an ACCIDENT guard, not a security boundary
 *    (see the finder test's header).
 *  - zsh, `CLAUDE_CONFIG_DIR`, and POSIX tools other than the ones Git Bash / Linux ship
 *    (`ls`, `sort`, `grep`, `dirname`, `basename`).
 *  - The executable halves skip, with a printed reason, where `bash` cannot open native
 *    paths; the static halves, the resolvers and `install.md` always run.
 *
 * @module tests/commands/plugin-root-chains
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { announceBashSkip, probeBash } from '../../scripts/utils/bash-compat.js';
import {
  cacheDir, fencesOf, globalDir, mirrorDir, NAME_CHECK, PLUGIN_ROOT, posix, read, runBatch, same, TOKEN, touch, writeManifest,
} from '../helpers/plugin-root-harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const SORT = 'sort -t. -k1,1nr -k2,2nr -k3,3nr';
const SOURCE_CHECK = `${NAME_CHECK} plugins/artibot/.claude-plugin/plugin.json 2>/dev/null`;

/** The template of a chain that resolves a FILE path into variable `V` (REC, USG, ENGINE). */
const fileChain = (V, rel) => [
  `F="${rel}"; ${V}=""; ${SOURCE_CHECK} && ${V}="plugins/artibot/$F";`,
  `[ -f "$${V}" ] || ${V}="${TOKEN}/$F";`,
  `P="$HOME/.claude/plugins"; for v in $(ls -1 "$P/cache/artibot/artibot" 2>/dev/null | ${SORT}); do [ -f "$${V}" ] || ${V}="$P/cache/artibot/artibot/$v/$F"; done;`,
  `[ -f "$${V}" ] || ${V}="$HOME/.claude/artibot/$F";`,
  `for m in $(ls -1 "$P/marketplaces" 2>/dev/null); do [ -f "$${V}" ] || ${V}="$P/marketplaces/$m/plugins/artibot/$F"; done`,
].join(' ');

/** The template of a chain that resolves a ROOT directory into PLUGIN_ROOT (update, learning). */
const rootChain = (rel, withSource) => [
  withSource
    ? `F="${rel}"; PLUGIN_ROOT=""; ${SOURCE_CHECK} && PLUGIN_ROOT="plugins/artibot"; [ -f "$PLUGIN_ROOT/$F" ] || PLUGIN_ROOT="${TOKEN}";`
    : `F="${rel}"; PLUGIN_ROOT="${TOKEN}";`,
  `P="$HOME/.claude/plugins"; for v in $(ls -1 "$P/cache/artibot/artibot" 2>/dev/null | ${SORT}); do [ -f "$PLUGIN_ROOT/$F" ] || PLUGIN_ROOT="$P/cache/artibot/artibot/$v"; done;`,
  '[ -f "$PLUGIN_ROOT/$F" ] || PLUGIN_ROOT="$HOME/.claude/artibot";',
  'for m in $(ls -1 "$P/marketplaces" 2>/dev/null); do [ -f "$PLUGIN_ROOT/$F" ] || PLUGIN_ROOT="$P/marketplaces/$m/plugins/artibot"; done',
].join(' ');

/** Exact chain counts per file (a chain that changes spelling cannot silently drop out). */
const FILE_SITES = {
  'commands/verify.md': 1, 'commands/team.md': 2, 'commands/autopilot.md': 2, 'commands/split.md': 1,
  'commands/theme.md': 3, 'commands/watch.md': 1, 'commands/scorecard.md': 3,
};
const ROOT_SITES = { 'commands/update.md': 2, 'commands/learning.md': 2 };
/** update.md deliberately has no source step (see the header); learning.md does. */
const hasSource = (file) => file !== 'commands/update.md';

const FILE_CHAIN_RE = /F="([^"]+)"; (REC|USG|ENGINE)=""; grep -q .*?\$m\/plugins\/artibot\/\$F"; done/g;
const ROOT_CHAIN_RE = /F="([^"]+)"; PLUGIN_ROOT=.*?\$m\/plugins\/artibot"; done/g;

/** Every chain in the docs, as text plus the variable and file it resolves. */
function findSites() {
  const out = [];
  for (const file of Object.keys(FILE_SITES)) {
    for (const m of read(file).matchAll(FILE_CHAIN_RE)) out.push({ file, kind: 'file', text: m[0], rel: m[1], V: m[2] });
  }
  for (const file of Object.keys(ROOT_SITES)) {
    for (const m of read(file).matchAll(ROOT_CHAIN_RE)) out.push({ file, kind: 'root', text: m[0], rel: m[1], V: 'PLUGIN_ROOT' });
  }
  return out;
}
const expectedText = (s) => (s.kind === 'file' ? fileChain(s.V, s.rel) : rootChain(s.rel, hasSource(s.file)));
const SITES = findSites();
const siteId = (s, i) => `${i}:${path.basename(s.file, '.md')}:${s.V}`;

describe('plugin-root chains: the script chains in the command docs', () => {
  it('finds exactly the chains it is meant to exercise', () => {
    const counts = {};
    for (const s of SITES) counts[s.file] = (counts[s.file] ?? 0) + 1;
    expect(counts).toEqual({ ...FILE_SITES, ...ROOT_SITES });
    expect(SITES.length).toBe(17);
  });

  it('every chain is byte-identical to the template for its shape', () => {
    const problems = SITES.filter((s) => s.text !== expectedText(s)).map((s) => `${s.file} (${s.V}=${s.rel}) differs from its template`);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('every script a chain names exists in the plugin tree', () => {
    const missing = SITES.filter((s) => !existsSync(path.join(PLUGIN_ROOT, s.rel))).map((s) => `${s.file}: ${s.rel}`);
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('the steps come in order: source, host-written path, newest cache, legacy copy, marketplace', () => {
    const problems = [];
    for (const s of SITES) {
      const marks = [
        hasSource(s.file) ? (s.kind === 'file' ? 'plugins/artibot/$F"' : 'PLUGIN_ROOT="plugins/artibot"') : null,
        TOKEN,
        'cache/artibot/artibot/$v',
        '$HOME/.claude/artibot',
        'marketplaces/$m',
      ].filter((m) => m !== null);
      const at = marks.map((m) => s.text.indexOf(m));
      const inOrder = at.every((i) => i > -1) && [...at].sort((a, b) => a - b).every((v, k) => v === at[k]);
      if (!inOrder) problems.push(`${s.file} (${s.V}): positions ${JSON.stringify(at)}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('update.md has no source step and every other chain has one (the recorded decision)', () => {
    expect(SITES.filter((s) => s.file === 'commands/update.md').every((s) => !s.text.includes(SOURCE_CHECK))).toBe(true);
    expect(SITES.filter((s) => s.file !== 'commands/update.md').every((s) => s.text.includes(SOURCE_CHECK))).toBe(true);
    const doc = read('commands/update.md');
    expect(doc).toContain('deliberately NOT a candidate');
    expect(doc).toContain('lib/core/install-mode.js');
  });

  it('no other line puts the legacy copy in an [ -f ] chain (a new chain must use the template)', () => {
    const problems = [];
    for (const rel of ['commands', 'skills', 'agents'].flatMap((d) => listMarkdown(d))) {
      read(rel).split('\n').forEach((line, i) => {
        if (!line.includes('[ -f "$') || !line.includes('$HOME/.claude/artibot')) return;
        const rest = SITES.reduce((acc, s) => acc.replaceAll(s.text, ''), line);
        if (rest.includes('$HOME/.claude/artibot')) problems.push(`${rel}:${i + 1}`);
      });
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('the template self-check: a chain with the legacy copy BEFORE the cache is not the template', () => {
    const good = fileChain('REC', 'scripts/ledger/record-verify.mjs');
    const swapped = good.replace(
      '[ -f "$REC" ] || REC="$HOME/.claude/artibot/$F";',
      '',
    ).replace('P="$HOME/.claude/plugins";', '[ -f "$REC" ] || REC="$HOME/.claude/artibot/$F"; P="$HOME/.claude/plugins";');
    expect(swapped).not.toBe(good);
    expect(SITES.some((s) => s.text === swapped)).toBe(false);
    expect(rootChain('scripts/update.js', false)).not.toBe(rootChain('scripts/update.js', true));
  });
});

/** Recursively list `.md` files under a plugin-relative directory. */
function listMarkdown(relDir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(abs, entry.name), `${rel}/${entry.name}`);
      else if (entry.name.endsWith('.md')) out.push(`${rel}/${entry.name}`);
    }
  };
  walk(path.join(PLUGIN_ROOT, relDir), relDir);
  return out.sort();
}

describe('plugin-root chains: the other finders accept a working directory only with the manifest check', () => {
  it('index.md (a Glob finder) names the manifest check in its source step', () => {
    const doc = read('commands/index.md');
    expect(doc).toContain('`"name"\\s*:\\s*"artibot"`');
    expect(doc).toContain('plugins/artibot/.claude-plugin/plugin.json');
    expect(doc).toContain('Both must hit');
  });

  it.each(['skills/persona-distill/SKILL.md', 'skills/using-agent-skills/SKILL.md'])('%s gates its source-repo test on the manifest', (rel) => {
    expect(read(rel)).toContain('plugins/artibot/.claude-plugin/plugin.json');
  });
});

/** Resolver carriers: the node snippet that finds the plugin root by itself. */
const RESOLVERS = [
  { file: 'commands/autopilot.md', needed: ['lib/autopilot/index.js'], throwLine: 'if (!pluginRoot) throw', out: 'pluginRoot', error: /engine not found/ },
  { file: 'commands/autopilot-queue.md', needed: ['lib/autopilot/index.js'], throwLine: 'if (!pluginRoot) throw', out: 'pluginRoot', error: /engine not found/ },
  { file: 'commands/go.md', needed: ['lib/genesis/tree-gen.js'], throwLine: 'if (!pluginRoot) throw', out: 'pluginRoot', error: /genesis layer not found/ },
  { file: 'commands/plan.md', needed: ['lib/planning/artifacts.js'], throwLine: 'if (!pluginRoot) throw', out: 'pluginRoot', error: /planning layer not found/ },
  { file: 'commands/split.md', needed: ['lib/git/split-dispatch.js'], throwLine: 'if (!root) throw', out: 'root', error: /not loadable/ },
];

/** The resolver's fence, cut after its not-found throw, or throws when it cannot be isolated. */
function resolverCode(r) {
  const fences = fencesOf(read(r.file), 'js').filter((f) => f.split('\n').some((l) => l.startsWith(r.throwLine)));
  if (fences.length !== 1) throw new Error(`${r.file}: expected exactly one resolver fence, found ${fences.length}`);
  const lines = fences[0].split('\n');
  return lines.slice(0, lines.findIndex((l) => l.startsWith(r.throwLine)) + 1).join('\n');
}

describe('plugin-root chains: the node resolvers (static)', () => {
  it.each(RESOLVERS.map((r) => [r.file, r]))('%s holds one resolver that tries the host-written path, then the cache by number, then the mirror', (_file, r) => {
    const code = resolverCode(r);
    expect(code, 'the host-written candidate').toContain(`const hostRoot = "${TOKEN}"`);
    expect(code, 'an unsubstituted token is skipped').toContain("hostRoot.startsWith('$') ? '' : hostRoot");
    expect(code, 'the env var stays a candidate').toContain('process.env.CLAUDE_PLUGIN_ROOT');
    expect(code, 'the plugin cache').toContain("'cache', 'artibot', 'artibot'");
    expect(code, 'numeric version order').toContain('{ numeric: true }');
    expect(code, 'the marketplace copy').toContain("'marketplaces'");
    expect(code.indexOf('hostRoot')).toBeLessThan(code.indexOf("'cache', 'artibot', 'artibot'"));
    expect(code.indexOf("'cache', 'artibot', 'artibot'")).toBeLessThan(code.indexOf("'marketplaces'"));
    for (const n of r.needed) expect(code, `${r.file} probes ${n}`).toContain(n);
  });

  it('the resolvers never name the legacy copy as a candidate (it has no lib/)', () => {
    for (const r of RESOLVERS) expect(resolverCode(r), r.file).not.toMatch(/\.claude['"],\s*['"]artibot['"]/);
  });
});

const bash = probeBash();
if (!bash.ok) announceBashSkip('plugin-root-chains/executable');

/**
 * The script that follows a chain: prints the resolved path (files) or root (directories) as an
 * absolute path. Parameter expansion, not `dirname`/`basename`: every external command is a process
 * spawn, and this matrix is the slow part of the suite on Windows.
 */
const printOf = (s) => (s.kind === 'file'
  ? `; printf '%s/%s\\n' "$(cd "\${${s.V}%/*}" 2>/dev/null && { pwd -W 2>/dev/null || pwd; })" "\${${s.V}##*/}"`
  : '; (cd "$PLUGIN_ROOT" 2>/dev/null && { pwd -W 2>/dev/null || pwd; })');
/** The path a chain resolves to when it lands in `root`. */
const landing = (s, root) => (s.kind === 'file' ? path.join(root, s.rel) : root);
/** The chain text as the host hands it to bash: the token replaced by a literal, or left for the empty env var. */
const scriptOf = (s, substitute) => `${substitute === undefined ? s.text : s.text.replaceAll(TOKEN, substitute)}${printOf(s)}`;

/**
 * Every executable chain scenario. `want[id]` is the path it must print.
 *
 * @param {string} base - Temp directory that owns the fixtures.
 */
function buildChainCases(base) {
  const foreign = path.join(base, 'project');
  mkdirSync(foreign, { recursive: true });
  const cases = [];
  const want = {};
  const add = (id, s, { substitute, home, cwd = foreign }, expected) => {
    cases.push({ id, script: scriptOf(s, substitute), cwd, home });
    want[id] = expected;
  };
  /** A fake source repo for chain `s`: `plugins/artibot/<rel>` plus (optionally) a manifest. */
  const repo = (dir, s, manifest) => {
    const plugin = path.join(dir, 'plugins', 'artibot');
    touch(path.join(plugin, s.rel));
    if (manifest !== null) writeManifest(plugin, manifest);
    return plugin;
  };

  SITES.forEach((s, i) => {
    const id = siteId(s, i);
    // The regression: a fake HOME holding BOTH a stale global copy and a cache.
    const both = path.join(base, `both-${i}`);
    touch(path.join(globalDir(both), s.rel), '// stale 4.67.0\n');
    touch(path.join(cacheDir(both, '4.70.0'), s.rel));
    add(`${id}:token-vs-stale-global`, s, { home: both, substitute: posix(cacheDir(both, '4.70.0')) }, landing(s, cacheDir(both, '4.70.0')));
    add(`${id}:cache-vs-stale-global`, s, { home: both }, landing(s, cacheDir(both, '4.70.0')));
  });

  // One chain of each shape gets the full matrix: verify (file, source), learning (root, source), update (root, no source).
  const reps = [
    SITES.findIndex((s) => s.file === 'commands/verify.md'),
    SITES.findIndex((s) => s.file === 'commands/learning.md'),
    SITES.findIndex((s) => s.file === 'commands/update.md'),
  ];
  for (const i of reps) {
    const s = SITES[i];
    const id = siteId(s, i);
    const r = `${base}${path.sep}rep-${i}`;

    // The legacy copy is still the answer when it is all there is (an install.sh-only user).
    const legacy = path.join(r, 'legacy-only');
    touch(path.join(globalDir(legacy), s.rel));
    add(`${id}:legacy-only`, s, { home: legacy }, landing(s, globalDir(legacy)));
    const gm = path.join(r, 'global-and-mirror');
    touch(path.join(globalDir(gm), s.rel));
    touch(path.join(mirrorDir(gm), s.rel));
    add(`${id}:legacy-beats-marketplace`, s, { home: gm }, landing(s, globalDir(gm)));
    const mo = path.join(r, 'mirror-only');
    touch(path.join(mirrorDir(mo), s.rel));
    add(`${id}:marketplace-only`, s, { home: mo }, landing(s, mirrorDir(mo)));

    const inst = path.join(r, 'installed-copy');
    touch(path.join(inst, s.rel));
    const tc = path.join(r, 'token-and-cache');
    touch(path.join(cacheDir(tc, '4.70.0'), s.rel));
    add(`${id}:token-beats-cache`, s, { home: tc, substitute: posix(inst) }, landing(s, inst));

    const num = path.join(r, 'numeric');
    for (const v of ['3.0.0', '4.9.0', '4.10.0']) touch(path.join(cacheDir(num, v), s.rel));
    mkdirSync(cacheDir(num, '4.11.0'), { recursive: true });
    add(`${id}:newest-by-number`, s, { home: num }, landing(s, cacheDir(num, '4.10.0')));

    // Source step: taken when the manifest names artibot (except update.md), ignored for decoys.
    const srcHome = path.join(r, 'src-home');
    touch(path.join(cacheDir(srcHome, '4.70.0'), s.rel));
    touch(path.join(globalDir(srcHome), s.rel));
    const plugin = repo(path.join(r, 'source-repo'), s, 'artibot');
    const cacheRoot = cacheDir(srcHome, '4.70.0');
    add(`${id}:source-step`, s, { home: srcHome, cwd: path.join(r, 'source-repo'), substitute: posix(cacheRoot) },
      landing(s, hasSource(s.file) ? plugin : cacheRoot));
    repo(path.join(r, 'decoy-no-manifest'), s, null);
    add(`${id}:decoy-no-manifest`, s, { home: srcHome, cwd: path.join(r, 'decoy-no-manifest') }, landing(s, cacheRoot));
    repo(path.join(r, 'decoy-cowork'), s, 'artibot-cowork');
    add(`${id}:decoy-cowork`, s, { home: srcHome, cwd: path.join(r, 'decoy-cowork') }, landing(s, cacheRoot));
  }
  return { cases, want };
}

describe.skipIf(!bash.ok)('plugin-root chains: the chains run (taken from the docs, token substituted or empty)', () => {
  let base = '';
  let run;
  let want;
  let total = 0;
  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'artibot-chains-'));
    const built = buildChainCases(base);
    want = built.want;
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
  /** Ids ending in `:suffix`, over every site. */
  const all = (suffix) => SITES.map((s, i) => `${siteId(s, i)}:${suffix}`);
  /** Every listed scenario printed the path it was built to find, without stderr noise. */
  const allPrint = (ids) => {
    const problems = ids.flatMap((id) => {
      const r = res(id);
      const ok = r.status === 0 && r.err === '' && same(r.out, want[id]);
      return ok ? [] : [`${id}: printed ${JSON.stringify(r.out)} (status ${r.status}, stderr ${JSON.stringify(r.err)}), wanted ${want[id]}`];
    });
    expect(problems, problems.join('\n')).toEqual([]);
  };

  it('the batch driver ran every scenario to completion', () => {
    expect(run.driver.timedOut, 'driver timed out').toBe(false);
    expect([...run.results].filter(([, r]) => r.status === null).map(([id]) => id)).toEqual([]);
    expect(run.results.size).toBe(total);
    // 17 chains x 2 scenarios, plus 3 representatives x 8.
    expect(total).toBe(17 * 2 + 3 * 8);
  });

  it('a fake HOME holding both a stale ~/.claude/artibot and a cache picks the cache when the host wrote the path (every chain)', () => {
    allPrint(all('token-vs-stale-global'));
  });

  it('... and picks the cache when the token is empty, so the newest-cache step beats the legacy copy (every chain)', () => {
    allPrint(all('cache-vs-stale-global'));
  });

  describe.each([['verify.md', 'commands/verify.md'], ['learning.md', 'commands/learning.md'], ['update.md', 'commands/update.md']])('one chain of each shape, %s', (_name, file) => {
    const idx = SITES.findIndex((s) => s.file === file);
    const idOf = (suffix) => `${siteId(SITES[idx], idx)}:${suffix}`;

    it('the legacy ~/.claude/artibot copy is still used when it is all there is (an install.sh-only user)', () => allPrint([idOf('legacy-only')]));
    it('the host-written path beats the cache', () => allPrint([idOf('token-beats-cache')]));
    it('the newest cache version wins by NUMBER (4.10.0 over 4.9.0), skipping a version that lacks the file', () => allPrint([idOf('newest-by-number')]));
    it('the legacy copy beats the marketplace copy, and the marketplace copy is used when it is all there is', () => {
      allPrint([idOf('legacy-beats-marketplace'), idOf('marketplace-only')]);
    });
    it(file === 'commands/update.md'
      ? 'a source tree with a valid manifest is NOT used (update.js decides its install mode from its own location)'
      : 'the source tree is used when its manifest names artibot', () => allPrint([idOf('source-step')]));
    it('a folder with the file but no manifest, or the cowork manifest, is ignored', () => {
      allPrint([idOf('decoy-no-manifest'), idOf('decoy-cowork')]);
    });
  });
});

/** The driver for the resolver modules: one process, env set per case, result written as JSON. */
const RESOLVER_DRIVER = [
  "import fs from 'node:fs';",
  "import { pathToFileURL } from 'node:url';",
  "const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
  'const out = {};',
  'for (const c of cases) {',
  '  process.env.HOME = c.home;',
  '  process.env.USERPROFILE = c.home;',
  '  if (c.envRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = c.envRoot;',
  '  try {',
  '    const m = await import(pathToFileURL(c.module).href);',
  '    out[c.id] = { ok: true, resolved: m.resolved };',
  '  } catch (e) {',
  "    out[c.id] = { ok: false, error: String((e && e.message) || e).split('\\n')[0] };",
  '  }',
  '}',
  "fs.writeFileSync(process.argv[3], JSON.stringify(out));",
].join('\n');

/**
 * Build one module per resolver per scenario and run them all in one node process.
 *
 * @param {string} base - Temp directory that owns the fixtures.
 */
function runResolvers(base) {
  const mods = path.join(base, 'mods');
  mkdirSync(mods, { recursive: true });
  const cases = [];
  const want = {};
  RESOLVERS.forEach((r, k) => {
    const code = resolverCode(r);
    /** A fake plugin root: an ESM package holding the file(s) the resolver probes. */
    const plant = (root) => {
      touch(path.join(root, 'package.json'), '{"type":"module"}\n');
      for (const n of r.needed) touch(path.join(root, n), 'export {};\n');
    };
    const mk = (name, { substitute, home, envRoot }, expected) => {
      const id = `${r.file}#${name}`;
      const file = path.join(mods, `${k}-${name}.mjs`);
      const body = substitute === undefined ? code : code.replaceAll(TOKEN, substitute);
      writeFileSync(file, `${body}\nexport const resolved = ${r.out};\n`, 'utf-8');
      cases.push({ id, module: file, home, envRoot });
      want[id] = expected;
    };
    const home = (name) => path.join(base, `r${k}-${name}`);

    const cacheOnly = home('cache-only');
    for (const v of ['4.9.0', '4.10.0']) plant(cacheDir(cacheOnly, v));
    mkdirSync(cacheDir(cacheOnly, '4.11.0'), { recursive: true });
    mk('cache-only', { home: cacheOnly }, cacheDir(cacheOnly, '4.10.0'));

    const installed = path.join(base, `r${k}-installed`);
    plant(installed);
    const tokenHome = home('token');
    plant(cacheDir(tokenHome, '4.70.0'));
    mk('token', { home: tokenHome, substitute: posix(installed) }, installed);
    mk('token-unsubstituted', { home: tokenHome }, cacheDir(tokenHome, '4.70.0'));

    const both = home('cache-and-mirror');
    plant(cacheDir(both, '4.70.0'));
    plant(mirrorDir(both));
    mk('cache-beats-mirror', { home: both }, cacheDir(both, '4.70.0'));
    const mirror = home('mirror-only');
    plant(mirrorDir(mirror));
    mk('mirror-only', { home: mirror }, mirrorDir(mirror));

    const envRoot = path.join(base, `r${k}-env-root`);
    plant(envRoot);
    mk('env-first', { home: tokenHome, envRoot, substitute: posix(installed) }, envRoot);

    const legacy = home('legacy-only');
    plant(globalDir(legacy));
    mk('legacy-is-not-a-candidate', { home: legacy }, null);
    mk('nothing', { home: home('empty') }, null);
  });

  const driver = path.join(base, 'resolver-driver.mjs');
  const casesFile = path.join(base, 'resolver-cases.json');
  const outFile = path.join(base, 'resolver-out.json');
  writeFileSync(driver, `${RESOLVER_DRIVER}\n`, 'utf-8');
  writeFileSync(casesFile, JSON.stringify(cases), 'utf-8');
  const child = spawnSync(process.execPath, [driver, casesFile, outFile], { cwd: base, encoding: 'utf-8', timeout: 120_000 });
  const out = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf-8')) : {};
  return { out, want, child, total: cases.length };
}

describe('plugin-root chains: the node resolvers run (cut from their docs, run as real modules)', () => {
  let base = '';
  let run;
  beforeAll(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'artibot-resolvers-'));
    run = runResolvers(base);
  }, 240_000);
  afterAll(() => {
    if (base !== '') rmSync(base, { recursive: true, force: true });
  });

  it('the driver ran every module', () => {
    expect(run.child.status, run.child.stderr).toBe(0);
    expect(Object.keys(run.out).length).toBe(run.total);
    // 8 scenarios per resolver.
    expect(run.total).toBe(RESOLVERS.length * 8);
  });

  /** Every resolver reached `name`'s answer. */
  const eachResolver = (name) => {
    const problems = RESOLVERS.flatMap((r) => {
      const id = `${r.file}#${name}`;
      const got = run.out[id];
      const expected = run.want[id];
      if (expected === null) return got?.ok === false && r.error.test(got.error) ? [] : [`${id}: expected the not-found error, got ${JSON.stringify(got)}`];
      return got?.ok === true && same(got.resolved, expected) ? [] : [`${id}: expected ${expected}, got ${JSON.stringify(got)}`];
    });
    expect(problems, problems.join('\n')).toEqual([]);
  };

  it('a cache-only layout resolves (no marketplace mirror), newest version by number', () => eachResolver('cache-only'));
  it('the host-written path beats the cache', () => eachResolver('token'));
  it('an unsubstituted token is skipped, not used as a path', () => eachResolver('token-unsubstituted'));
  it('the cache beats the marketplace copy, and the marketplace copy is used when it is all there is', () => {
    eachResolver('cache-beats-mirror');
    eachResolver('mirror-only');
  });
  it('the CLAUDE_PLUGIN_ROOT environment variable stays first', () => eachResolver('env-first'));
  it('the legacy ~/.claude/artibot copy is not a candidate (it has no lib/), and an empty home fails loudly', () => {
    eachResolver('legacy-is-not-a-candidate');
    eachResolver('nothing');
  });
});

describe('install.md: the preset-pack snippet takes its root from outside the code (review N-d)', () => {
  const doc = read('commands/install.md');
  const snippets = fencesOf(doc, 'js').filter((f) => f.includes('preset-packs.js'));

  it('holds one snippet, and it never embeds the host-written path in a quoted literal', () => {
    expect(snippets).toHaveLength(1);
    expect(doc).not.toContain(`'${TOKEN}'`);
    expect(snippets[0]).not.toContain(TOKEN);
    expect(snippets[0]).toContain('const root = process.env.ARTIBOT_PLUGIN_ROOT;');
    expect(snippets[0]).toContain('ARTIBOT_PLUGIN_ROOT is empty');
  });

  describe('running it', () => {
    let base = '';
    let file = '';
    let link = '';
    let foreign = '';
    beforeAll(() => {
      base = mkdtempSync(path.join(os.tmpdir(), 'artibot-install-'));
      foreign = path.join(base, 'project');
      mkdirSync(foreign, { recursive: true });
      file = path.join(base, 'install-snippet.mjs');
      writeFileSync(file, `${snippets[0]}\n`, 'utf-8');
      // A directory whose path holds an apostrophe and a space, pointing at the real plugin.
      try {
        link = path.join(base, "O'Brien x", 'artibot-link');
        mkdirSync(path.dirname(link), { recursive: true });
        symlinkSync(PLUGIN_ROOT, link, 'junction');
      } catch {
        link = '';
      }
    });
    afterAll(() => {
      if (base !== '') rmSync(base, { recursive: true, force: true });
    });

    const runSnippet = (env) => spawnSync(process.execPath, [file], {
      cwd: foreign, encoding: 'utf-8', timeout: 90_000, env: { ...process.env, CLAUDE_PLUGIN_ROOT: '', ...env },
    });

    it('lists the packs from a foreign cwd when the root holds an apostrophe and a space', (ctx) => {
      if (link === '') ctx.skip();
      const r = runSnippet({ ARTIBOT_PLUGIN_ROOT: link });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('vibe');
    });

    it('fails with a clear message, not a path error, when no root is passed', () => {
      const r = runSnippet({ ARTIBOT_PLUGIN_ROOT: '' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('ARTIBOT_PLUGIN_ROOT is empty');
    });
  });
});
