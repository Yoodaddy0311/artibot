/**
 * Firewall — the canonical `/split` state paths take their mission from the
 * run's BINDING, never from the dispatching session (SH-11, invariant I3).
 *
 * WHY THIS GATE EXISTS. Before SH-11 the join between a `/split` run and a
 * StateStore mission was per SESSION: `task-feed.mjs#feedLimb` asked
 * `post-compact-rehydrate.js#selectMissionForSession` which mission the
 * dispatching session owned. One run therefore seeded two leader missions
 * (23 + 25 tasks with contradictory states, measured 2026-09-28) and a session
 * tail matching two dated missions resolved to none. The join is now a record
 * the run carries (`plan.json.missionBinding`), and flipping the StateStore to
 * canonical on the OLD join would have been worse than not flipping. The way
 * that regresses is a single import: someone routes a canonical read or write
 * back through the selector "just for the fallback". This gate makes that
 * import red.
 *
 * WHAT IT PINS (allowlist, not deny-list):
 *  - the canonical-path sources — the reader/writer adapter, its pure core, and
 *    the three scripts that call it — import or call `selectMissionForSession`
 *    ZERO times, and must EXIST (a missing file is red, not skipped);
 *  - every OTHER file in `lib/topology/` and `scripts/split/` is held to the same
 *    zero, so a new file cannot slip in — `task-feed.mjs` is the one named
 *    exception, and only for the legacy rule (an unbound run), through the single
 *    function `selectLegacyMission`;
 *  - the env carrier is derived FROM the binding, never the other way: no
 *    canonical source reads `ARTIBOT_MISSION_ID` from `process.env`;
 *  - THE CANARY SWITCH (`artibot.config.json#split.missionBinding.enabled`):
 *    the production call sites of `writeWorkerState` / `readWorkerState` /
 *    `resolveRunMission` are pinned BY LIST and each passes an `honorBinding`
 *    port, no script hardcodes the switch on (`honorBinding: true`, `bind: true`),
 *    `dispatch.mjs` derives `bind` from the shared reader, no script reads the key
 *    by hand, and the two SH-11 library modules never read config (L4 receives
 *    the answer, it does not fetch it). The SHIPPED value of the key is pinned in
 *    `split-config-firewall.test.js`, next to the config allowlist it belongs to.
 *
 * THE SCANNER IS TESTED (rules §10). A gate that reads "0 hits" is only worth
 * something if it can say "1 hit": the last blocks mutate real sources —
 * an import, an aliased import, a dynamic import, a call, a re-export, a call
 * without the port, a hardcoded switch, a config read in the library — and
 * demand each go red, check the comment stripper on the inputs it is most
 * likely to get wrong, and demand the real legacy site be FOUND.
 *
 * WHAT THIS GATE CANNOT SEE (written next to the gate, so the gate does not
 * become the next illusion):
 *  - BEHAVIOUR. It reads text. A bound branch that reaches the selector through
 *    a helper in a module this list does not name, or that rebuilds the
 *    session rule by hand (`-S<sid8>` string surgery), passes here. The
 *    behavioural proof is `tests/scripts/task-feed.test.js` (T1/T2: two
 *    sessions and two dated missions must still resolve through the binding),
 *    which a session-based mutation turns red.
 *  - DYNAMIC NAMES. `mod['select' + 'MissionForSession']` is invisible to a
 *    text scan. Nothing in these files builds names that way (measured by
 *    reading them); the day one does, this gate does not know.
 *  - MODULES OUTSIDE THE TWO DIRECTORIES. `lib/checkpoint/` and
 *    `scripts/checkpoint/` read StateStore missions too, for `/resume`; they
 *    are not `/split` write paths and are not scanned here.
 *  - THE COMMENT STRIPPER IS A SCANNER, NOT A PARSER. It understands strings,
 *    template literals and both comment forms; it does not understand regex
 *    literals that contain a quote character. None of the scanned files has one.
 *  - WHAT THE SWITCH DOES. The switch block reads text: that a call site PASSES a
 *    port says nothing about what the port answers, and a call built by name
 *    (`mod[name](...)`) is invisible. That `false` really reverts a bound run, that
 *    only a literal `true` turns it on, and that a stale lane is refused are
 *    measured by `tests/topology/split-state{,-sources}.test.js` and
 *    `tests/scripts/{lane-state,lane-lease,task-feed,split-tools}.test.js`.
 *  - CALL SITES OUTSIDE `lib/` AND `scripts/` (hooks live under `scripts/`, so they
 *    are covered; a test, a doc or `commands/*.md` is not code and is not scanned).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SELECTOR = 'selectMissionForSession';

/** The canonical (binding) path sources. Pinned by list: an addition is a decision. */
const CANONICAL = Object.freeze([
  'lib/topology/split-state.js',
  'lib/topology/split-state-sources.js',
  'scripts/split/lane-state.mjs',
  'scripts/split/lane-lease.mjs',
  'scripts/split/dispatch.mjs',
]);

/** The ONE legacy site: the per-session rule for a run with no binding. */
const LEGACY_SITE = 'scripts/split/task-feed.mjs';

/** Directories whose every source file is held to the zero (except the legacy site). */
const SCANNED_DIRS = Object.freeze([
  { dir: 'lib/topology', ext: /\.js$/ },
  { dir: 'scripts/split', ext: /\.mjs$/ },
]);

const read = (rel) => fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');

/**
 * Source with comments blanked (newlines kept, so line numbers survive) and
 * strings left verbatim. Strings stay because `import('…/post-compact-…')` and
 * `mod['selectMissionForSession']` are code, however they are spelled.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Every place the source refers to the per-session selector: the identifier
 * (import, alias, call, re-export, property access) or the module that exports
 * it (a dynamic import names it as a string).
 *
 * @param {string} src
 * @returns {Array<{ line: number, text: string }>}
 */
function selectorReferences(src) {
  const hits = [];
  stripComments(src).split('\n').forEach((text, at) => {
    if (new RegExp(`\\b${SELECTOR}\\b`).test(text) || /post-compact-rehydrate/.test(text)) hits.push({ line: at + 1, text: text.trim() });
  });
  return hits;
}

/** @param {string} src @returns {Array<{ line: number, text: string }>} */
function envReads(src) {
  const hits = [];
  stripComments(src).split('\n').forEach((text, at) => {
    if (/process\.env(?:\.ARTIBOT_MISSION_ID|\s*\[\s*['"`]ARTIBOT_MISSION_ID)/.test(text)) hits.push({ line: at + 1, text: text.trim() });
  });
  return hits;
}

/**
 * The body of `function <name>(…) { … }` by brace matching on comment-stripped
 * text, or `null` when there is no such function.
 *
 * @param {string} src
 * @param {string} name
 * @returns {string|null}
 */
function functionBody(src, name) {
  const code = stripComments(src);
  const at = code.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at === -1) return null;
  const open = code.indexOf('{', code.indexOf(')', at));
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

/** Source files of a scanned directory, repo-relative, sorted. */
function filesOf({ dir, ext }) {
  return fs.readdirSync(path.join(PLUGIN_ROOT, dir)).filter((f) => ext.test(f)).sort().map((f) => `${dir}/${f}`);
}

describe('SH-11 I3 — canonical /split state paths never select a mission by session', () => {
  it('every canonical-path source exists and refers to the per-session selector 0 times', () => {
    for (const rel of CANONICAL) {
      expect(fs.existsSync(path.join(PLUGIN_ROOT, rel)), `${rel} must exist (a missing file is red, not skipped)`).toBe(true);
      expect(selectorReferences(read(rel)), rel).toEqual([]);
    }
  });

  it('holds every OTHER file in lib/topology and scripts/split to the same zero — task-feed.mjs is the one named exception', () => {
    const scanned = SCANNED_DIRS.flatMap(filesOf);
    // The canonical list must be a subset of what the directory scan sees, or a rename
    // would leave the pinned list guarding a path nobody reads.
    for (const rel of CANONICAL) expect(scanned, rel).toContain(rel);
    expect(scanned).toContain(LEGACY_SITE);
    const offenders = scanned.filter((rel) => rel !== LEGACY_SITE && selectorReferences(read(rel)).length > 0);
    expect(offenders).toEqual([]);
  });

  it('the legacy site is found by the scanner (positive control) and calls the selector from ONE function', () => {
    const src = read(LEGACY_SITE);
    const refs = selectorReferences(src);
    expect(refs.length, 'the scanner must be able to see the real legacy site').toBeGreaterThanOrEqual(2);
    const calls = refs.filter((r) => new RegExp(`\\b${SELECTOR}\\s*\\(`).test(r.text));
    expect(calls, `exactly one call site of ${SELECTOR}`).toHaveLength(1);
    const body = functionBody(src, 'selectLegacyMission');
    expect(body, 'selectLegacyMission must exist').not.toBeNull();
    expect(body).toMatch(new RegExp(`\\b${SELECTOR}\\s*\\(`));
  });

  it('the env carrier is derived FROM the binding: no canonical source reads ARTIBOT_MISSION_ID from process.env', () => {
    for (const rel of [...CANONICAL, LEGACY_SITE]) expect(envReads(read(rel)), rel).toEqual([]);
  });
});

describe('SH-11 I3 gate — the scanner can say "1 hit" (a mutated copy goes RED)', () => {
  const clean = () => read('lib/topology/split-state.js');

  it('the unmutated canonical sources are clean, so every case below turns red BECAUSE of its mutation', () => {
    for (const rel of CANONICAL) expect(selectorReferences(read(rel)), rel).toEqual([]);
  });

  const MUTATIONS = {
    'a named import': (s) => `import { ${SELECTOR} } from '../../scripts/hooks/post-compact-rehydrate.js';\n${s}`,
    'an aliased import': (s) => `import { ${SELECTOR} as pick } from '../hooks/post-compact-rehydrate.js';\n${s}`,
    'a namespace import (the module specifier alone)': (s) => `import * as rehydrate from '../hooks/post-compact-rehydrate.js';\n${s}`,
    'a dynamic import': (s) => `${s}\nexport const later = () => import('../hooks/post-compact-rehydrate.js');\n`,
    'a call': (s) => `${s}\nexport const pick = (state, sid) => ${SELECTOR}(state, sid);\n`,
    'a re-export': (s) => `${s}\nexport { ${SELECTOR} } from './elsewhere.js';\n`,
    'a property access': (s) => `${s}\nexport const p = (m) => m['${SELECTOR}'];\n`,
  };

  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    it(`goes RED on ${name}`, () => {
      const mutated = mutate(clean());
      expect(mutated).not.toBe(clean());
      expect(selectorReferences(mutated).length).toBeGreaterThan(0);
    });
  }

  it('the same mutation applied to each canonical source is caught in that source', () => {
    for (const rel of CANONICAL) {
      const mutated = `import { ${SELECTOR} } from '../hooks/post-compact-rehydrate.js';\n${read(rel)}`;
      expect(selectorReferences(mutated).length, rel).toBeGreaterThan(0);
    }
  });

  it('does not go red on a mention in a comment, and does on the same text in code', () => {
    const inComment = `${clean()}\n// legacy: ${SELECTOR}(state, sid) from post-compact-rehydrate.js\n/* ${SELECTOR} */\n`;
    expect(selectorReferences(inComment)).toEqual([]);
    expect(selectorReferences(`${inComment}\nconst x = ${SELECTOR}(a, b);\n`)).toHaveLength(1);
  });

  it('the comment stripper survives the inputs it is most likely to get wrong', () => {
    // `//` inside a string is not a comment; a quote inside a comment does not open a string.
    expect(selectorReferences(`const u = 'http://x/${SELECTOR}'; // ok\n`)).toHaveLength(1);
    expect(selectorReferences(`// it's ${SELECTOR}\nconst y = 1;\n`)).toEqual([]);
    // A block comment spanning lines keeps line numbers for what follows.
    const spanned = `/*\n${SELECTOR}\n*/\nconst z = ${SELECTOR}();\n`;
    expect(selectorReferences(spanned)).toEqual([{ line: 4, text: `const z = ${SELECTOR}();` }]);
    // An unterminated block comment swallows the rest instead of throwing.
    expect(selectorReferences(`/* never closed ${SELECTOR}`)).toEqual([]);
    // Escaped quotes stay inside their string.
    expect(selectorReferences(`const s = 'a\\'b'; ${SELECTOR}();\n`)).toHaveLength(1);
    // Template literals are copied verbatim.
    expect(selectorReferences(`const t = \`// not a comment ${SELECTOR}\`;\n`)).toHaveLength(1);
  });

  it('the env-read scanner catches the dotted and the bracketed spelling, and ignores prose', () => {
    expect(envReads('const a = process.env.ARTIBOT_MISSION_ID;')).toHaveLength(1);
    expect(envReads('const a = process.env["ARTIBOT_MISSION_ID"];')).toHaveLength(1);
    expect(envReads("const a = process.env[ 'ARTIBOT_MISSION_ID' ];")).toHaveLength(1);
    expect(envReads('// process.env.ARTIBOT_MISSION_ID is derived, never read\nconst ok = 1;')).toEqual([]);
    expect(envReads("const name = 'ARTIBOT_MISSION_ID'; const env = {};")).toEqual([]);
  });

  it('functionBody brace-matches and reports absence as null', () => {
    const src = 'function a() { if (x) { return 1; } return 2; }\nfunction b() { return 3; }\n';
    expect(functionBody(src, 'a')).toBe('{ if (x) { return 1; } return 2; }');
    expect(functionBody(src, 'b')).toBe('{ return 3; }');
    expect(functionBody(src, 'c')).toBeNull();
  });
});

/* ══════════ SH-11 canary switch — every path that honours a binding asks the key ══════════
 *
 * `artibot.config.json#split.missionBinding.enabled` ships `false`. This block
 * pins the WIRING, by text: who may call the three entry points, that each call
 * passes the port, that nothing hardcodes the switch on, and that the library
 * fetches nothing. The shipped value is pinned in `split-config-firewall.test.js`;
 * what the switch DOES is measured by the behavioural suites (see the header).
 */

/** Directories holding production code that could call the SH-11 entry points. `commands/*.md`, docs and tests are not code. */
const PRODUCTION_ROOTS = Object.freeze(['lib', 'scripts']);

/**
 * The entry points that honour (or ignore) a binding, and the ONLY production
 * files that call each. Pinned BY LIST (allowlist): a new caller is a decision,
 * and it must pass the switch — a caller that forgets the port would be OFF
 * (fail-closed) and never canonical, which is silent.
 */
const SWITCHED_CALLS = Object.freeze({
  writeWorkerState: Object.freeze(['scripts/split/lane-state.mjs']),
  readWorkerState: Object.freeze([]),
  resolveRunMission: Object.freeze(['scripts/split/lane-lease.mjs', 'scripts/split/task-feed.mjs']),
});

/** The two library modules of the SH-11 adapter: they RECEIVE the switch, they never fetch it (L4). */
const SWITCH_LIBRARY = Object.freeze(['lib/topology/split-state.js', 'lib/topology/split-state-sources.js']);

/** Every source file under a directory (recursive), repo-relative and sorted; `node_modules` is skipped. */
function sourcesUnder(rel) {
  const out = [];
  const visit = (dirRel) => {
    for (const entry of fs.readdirSync(path.join(PLUGIN_ROOT, dirRel), { withFileTypes: true })) {
      const child = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(child);
      } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(child);
    }
  };
  visit(rel);
  return out.sort();
}

/**
 * Call sites of `name(...)` on comment-stripped code. A declaration
 * (`function name(`) is not a call; a namespace call (`ns.name(`) is. `args` is
 * the text between the parentheses, matched by depth — a parenthesis inside a
 * string among the arguments would confuse it (none of the real call sites has
 * one).
 *
 * @param {string} src
 * @param {string} name
 * @returns {Array<{ line: number, args: string }>}
 */
function callSites(src, name) {
  const code = stripComments(src);
  const sites = [];
  const re = new RegExp(`(?<![\\w$])${name}\\s*\\(`, 'g');
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const before = code.slice(0, m.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = code.length - 1;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    sites.push({ line: before.split('\n').length, args: code.slice(open + 1, close) });
  }
  return sites;
}

/** Production files that call `name(`, with their sites. The raw text is pre-filtered so only candidates are comment-stripped. */
function productionCallers(name) {
  const found = {};
  for (const rel of PRODUCTION_ROOTS.flatMap(sourcesUnder)) {
    const raw = read(rel);
    if (!raw.includes(name)) continue;
    const sites = callSites(raw, name);
    if (sites.length > 0) found[rel] = sites;
  }
  return found;
}

/** `honorBinding: true` / `bind: true` written into code — the switch hardcoded ON. */
function hardcodedSwitches(src) {
  const hits = [];
  stripComments(src).split('\n').forEach((text, at) => {
    if (/\b(?:honorBinding|bind)\s*:\s*true\b/.test(text)) hits.push({ line: at + 1, text: text.trim() });
  });
  return hits;
}

/** The library fetching config itself, instead of receiving the answer. */
function configReads(src) {
  const hits = [];
  stripComments(src).split('\n').forEach((text, at) => {
    if (/\b(?:loadConfig|getConfig|getPluginRoot|readJsonFileSync)\b|artibot\.config/.test(text)) hits.push({ line: at + 1, text: text.trim() });
  });
  return hits;
}

/**
 * Comment-stripped source with the CONTENT of every string and template literal
 * blanked (quotes and newlines kept). A message that names the key — a `--help`
 * text, an error — is prose, not a read of it. Template `${…}` expressions are
 * blanked with the rest (a scanner, not a parser).
 *
 * @param {string} src
 * @returns {string}
 */
function codeOnly(src) {
  const code = stripComments(src);
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
      out += c + code.slice(i + 1, Math.min(j, n)).replace(/[^\n]/g, ' ') + (j < n ? c : '');
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * A hand-rolled read of the key — a property chain ending in `.enabled`, or a
 * string-indexed access on `missionBinding` — instead of the shared reader.
 * Only CODE counts: the prose of a help text is blanked first. WHAT IT MISSES: a
 * second copy of the path as a string handed to a generic getter.
 */
function handRolledKeyReads(src) {
  const hits = [];
  codeOnly(src).split('\n').forEach((text, at) => {
    if (/missionBinding\s*(?:\?\.|\.)\s*enabled|missionBinding\s*\[\s*['"`]/.test(text)) hits.push({ line: at + 1, text: text.trim() });
  });
  return hits;
}

describe('SH-11 switch — the wiring is pinned by list and every call passes the port', () => {
  for (const [name, allowed] of Object.entries(SWITCHED_CALLS)) {
    it(`${name}( has ${allowed.length === 0 ? 'no production caller' : `exactly ${allowed.join(' + ')} as callers`}, and every call passes honorBinding`, () => {
      const found = productionCallers(name);
      expect(Object.keys(found).sort(), `a new caller of ${name} is a decision: register it in SWITCHED_CALLS, with its port`).toEqual([...allowed].sort());
      for (const [rel, sites] of Object.entries(found)) {
        for (const site of sites) expect(site.args, `${rel}:${site.line} calls ${name}( without honorBinding`).toMatch(/\bhonorBinding\b/);
      }
    });
  }

  it('no script or library hardcodes the switch on (honorBinding: true, bind: true)', () => {
    for (const rel of SCANNED_DIRS.flatMap(filesOf)) expect(hardcodedSwitches(read(rel)), rel).toEqual([]);
  });

  it('dispatch.mjs derives `bind` from the shared reader, never from a literal', () => {
    const code = stripComments(read('scripts/split/dispatch.mjs'));
    expect(code).toMatch(/\bconst\s+bindingOn\s*=\s*readMissionBindingEnabled\(\s*config\s*\)/);
    expect(code).toMatch(/\bbind\s*:\s*bindingOn\b/);
    expect(code).not.toMatch(/\bbind\s*:\s*(?:true|false)\b/);
  });

  it('the CLIs hand the key on as a LAZY port; the feeder also gates tryBind on it', () => {
    expect(stripComments(read('scripts/split/lane-state.mjs'))).toMatch(/honorBinding\s*:\s*\(\)\s*=>\s*missionBindingEnabled\(\s*opts\s*\)/);
    expect(stripComments(read('scripts/split/lane-lease.mjs'))).toMatch(/honorBinding\s*:\s*\(\)\s*=>\s*missionBindingEnabled\(\s*ports\s*\)/);
    const feed = stripComments(read('scripts/split/task-feed.mjs'));
    expect(feed).toMatch(/const\s+honorBinding\s*=\s*\(\)\s*=>/);
    expect(feed).toMatch(/enabled\s*=\s*missionBindingEnabled\(\s*ports\s*\)/);
    expect(feed).toMatch(/\bbind\s*&&\s*honorBinding\(\)/);
  });

  it('no script reads the key by hand: it goes through readMissionBindingEnabled', () => {
    for (const rel of filesOf({ dir: 'scripts/split', ext: /\.mjs$/ })) expect(handRolledKeyReads(read(rel)), rel).toEqual([]);
  });

  it('the SH-11 library modules never read config — the answer arrives as the honorBinding port', () => {
    for (const rel of SWITCH_LIBRARY) {
      expect(fs.existsSync(path.join(PLUGIN_ROOT, rel)), `${rel} must exist`).toBe(true);
      expect(configReads(read(rel)), rel).toEqual([]);
    }
  });
});

describe('SH-11 switch gate — the scanners can say "1 hit" (a mutated copy goes RED)', () => {
  it('positive control: the real call sites are FOUND, and they carry the port', () => {
    const write = callSites(read('scripts/split/lane-state.mjs'), 'writeWorkerState');
    expect(write).toHaveLength(1);
    expect(write[0].args).toMatch(/\bhonorBinding\b/);
    // The declaration in task-feed.mjs is not a call, so exactly the one real call remains.
    expect(callSites(read('scripts/split/task-feed.mjs'), 'resolveRunMission')).toHaveLength(1);
    expect(callSites(read('scripts/split/lane-lease.mjs'), 'resolveRunMission')).toHaveLength(1);
  });

  it('a call without the port is reported: the port removed from the real lane-state call', () => {
    const src = read('scripts/split/lane-state.mjs');
    const mutated = src.replace(/honorBinding: \(\) => missionBindingEnabled\(opts\),/, '');
    expect(mutated).not.toBe(src);
    const [site] = callSites(mutated, 'writeWorkerState');
    expect(site.args).not.toMatch(/\bhonorBinding\b/);
  });

  it('a fourth caller is reported by the list: a namespace call in a new file is a call', () => {
    expect(callSites('import * as s from "./x.js";\ns.writeWorkerState({ runDir });', 'writeWorkerState')).toHaveLength(1);
  });

  it('the call scanner: declarations, comments and longer identifiers are not calls; the arguments are matched by depth', () => {
    expect(callSites('export function writeWorkerState({ a }) { return 1; }', 'writeWorkerState')).toEqual([]);
    expect(callSites('// writeWorkerState({})\n/* resolveRunMission({}) */\n', 'writeWorkerState')).toEqual([]);
    expect(callSites('writeWorkerStateLater({ a: 1 });', 'writeWorkerState')).toEqual([]);
    const [site] = callSites('const x = 1;\nwriteWorkerState({ a: f(1), b: [g(2)] }, 2); other(3);', 'writeWorkerState');
    expect(site).toEqual({ line: 2, args: '{ a: f(1), b: [g(2)] }, 2' });
  });

  it('a hardcoded switch is reported in both spellings, and prose or a derived value is not one', () => {
    expect(hardcodedSwitches('resolveRunMission({ honorBinding: true });')).toHaveLength(1);
    expect(hardcodedSwitches('feedLimb({ bind: true }, {});')).toHaveLength(1);
    expect(hardcodedSwitches('// bind: true is what it used to say\nconst x = { bind: bindingOn };')).toEqual([]);
    expect(hardcodedSwitches('const o = { honorBinding: () => missionBindingEnabled(opts) };')).toEqual([]);
  });

  it('the real dispatch.mjs mutated to `bind: true` is caught by the literal scan AND the derivation pin', () => {
    const src = read('scripts/split/dispatch.mjs');
    const mutated = src.replace(/\bbind: bindingOn\b/, 'bind: true');
    expect(mutated).not.toBe(src);
    expect(hardcodedSwitches(mutated).length).toBeGreaterThan(0);
    expect(stripComments(mutated)).not.toMatch(/\bbind\s*:\s*bindingOn\b/);
  });

  it('a config read in the library is reported, and a comment about one is not', () => {
    const src = read('lib/topology/split-state.js');
    for (const line of ["import { loadConfig } from '../core/config.js';", 'const root = getPluginRoot();', "const t = readJsonFileSync('artibot.config.json');"]) {
      expect(configReads(`${line}\n${src}`).length, line).toBeGreaterThan(0);
    }
    expect(configReads('// loadConfig() is what the CLI calls\nconst ok = 1;')).toEqual([]);
  });

  it('a hand-rolled read of the key is reported in each code spelling; prose, comments and the plan-side record are not one', () => {
    expect(handRolledKeyReads('const on = config?.split?.missionBinding?.enabled === true;')).toHaveLength(1);
    expect(handRolledKeyReads('const on = config.split.missionBinding.enabled;')).toHaveLength(1);
    expect(handRolledKeyReads("const on = config.split.missionBinding['enabled'];")).toHaveLength(1);
    expect(handRolledKeyReads('const plan = { missionBinding: binding };\nconst b = plan.missionBinding;')).toEqual([]);
    expect(handRolledKeyReads('// config.split.missionBinding.enabled is read by the shared reader\nconst ok = 1;')).toEqual([]);
    // A help text or an error message may name the key.
    expect(handRolledKeyReads('const HELP = `while artibot.config.json#split.missionBinding.enabled is true`;')).toEqual([]);
    expect(handRolledKeyReads("throw new Error('set split.missionBinding.enabled first');")).toEqual([]);
  });

  it('codeOnly blanks string content, keeps quotes and newlines, and survives an unterminated string', () => {
    // (a line comment is dropped, not padded — the stripper keeps only the newline)
    expect(codeOnly("const a = 'x.y'; // c\nconst b = `t\nu`;")).toBe("const a = '   '; \nconst b = ` \n `;");
    expect(codeOnly("const q = 'a\\'b'; z")).toBe("const q = '    '; z");
    expect(() => codeOnly("const open = 'never closed")).not.toThrow();
  });
});
