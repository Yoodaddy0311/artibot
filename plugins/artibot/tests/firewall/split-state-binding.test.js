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
 *    canonical source reads `ARTIBOT_MISSION_ID` from `process.env`.
 *
 * THE SCANNER IS TESTED (rules §10). A gate that reads "0 hits" is only worth
 * something if it can say "1 hit": the last block mutates real sources —
 * an import, an aliased import, a dynamic import, a call, a re-export — and
 * demands each go red, checks the comment stripper on the inputs it is most
 * likely to get wrong, and demands the real legacy site be FOUND.
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
