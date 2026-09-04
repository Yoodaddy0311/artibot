/**
 * Firewall — a test that spawns a dispatcher or a git-autopilot hook must hand
 * it a sandboxed working directory.
 *
 * WHY. `spawnHook` passes no `cwd` (`scripts/hooks/_dispatcher-utils.js:126`),
 * so every hook the dispatcher spawns inherits the cwd the TEST chose, and the
 * git-autopilot hooks resolve the repository from that cwd alone
 * (`git-autopilot-setup.js:105`, `git-autopilot-session.js:61` — both run
 * `git rev-parse --show-toplevel` with no `cwd` option). Pointing a suite at
 * the checkout therefore aims production git writes at the developer's own
 * repository. That is not hypothetical: on 2026-09-04 a full-repo `vitest` run
 * created four `artibot/worktree-split-*` branches and rewrote
 * `.git/autopilot.json` in four linked worktrees, which made `/split status`
 * read every limb as missing and `land` report `no-commits` on finished work
 * (`.artibot/split/gotchas.md` #18, #22).
 *
 * ISOLATION BY TOPOLOGY, NOT BY DATA. The repair is a cwd with no repository
 * above it, so `getRepoRoot()` fails and the hooks return before any git read
 * or write. Gating on `autopilot.json` `enabled` instead would gate on a
 * mutable runtime flag that `/autopilot` setup rewrites — and in a linked
 * worktree there is no `autopilot.json` at all, so setup creates one with
 * `enabled:true` (`git-autopilot-setup.js:45`). That is precisely how the
 * incident happened.
 *
 * ALLOWLIST, NOT DENYLIST. A matched file must carry one of the mechanisms in
 * `MECHANISMS`. A new mechanism is red until someone registers it here,
 * deliberately. A denylist of "bad cwd values" would fail open for every
 * future variant — the failure mode `~/.claude/rules/artibot/` calls out.
 *
 * A MISSING `cwd` KEY IS ALSO RED. Omitting `cwd` is not neutral: the child
 * then inherits vitest's own cwd, which is the checkout. The absent case and
 * the wrong case have the same blast radius, so they share a verdict.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - **Indirect spawns.** Only a `process.execPath` spawn written in the test
 *     file's own source is seen. A helper module that spawns on the file's
 *     behalf, or a shell/`npm` indirection, looks clean here.
 *   - **Whether the mechanism actually isolates.** This checks that the cwd is
 *     bound to an identifier the file derived from `mkdtemp`. It does not run
 *     the suite, does not verify the directory still exists at spawn time, and
 *     cannot see a `beforeAll` that assigns the variable to something else.
 *     The per-suite "leaves the real repository untouched" tests are what
 *     prove real isolation; this only proves the wiring is declared.
 *   - **One level of indirection, no more.** A spread of a local options
 *     builder (`{ ...spawnOptions(env) }`) is followed into that function's
 *     body. A second hop, or a builder imported from another module, is not.
 *   - **Non-cwd blast radius.** `CLAUDE_PLUGIN_ROOT` still points at the real
 *     plugin in every one of these suites, so writes under
 *     `plugins/artibot/runtime/` still land in the repo. They are gitignored
 *     (`plugins/artibot/.gitignore:10`) and cannot dirty git, which is why
 *     they are out of scope here rather than fixed.
 *   - **Hooks spawned standalone.** The writer axis is dispatchers and
 *     git-autopilot hooks only — see `SCOPE_EXCLUSIONS` for the two measured
 *     suites that spawn a single hook directly and why they are out.
 *   - **Non-test spawners.** Only `*.test.js` under `tests/` is scanned;
 *     benchmarks, scripts and `tests/**\/*.bench.js` are not.
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS_DIR = path.join(PLUGIN_ROOT, 'tests');
const SELF = 'tests/firewall/dispatcher-cwd-sandbox-required.test.js';

/** Any synchronous or asynchronous child-process spawn of the node binary. */
const EXECPATH_SPAWN = /(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*process\.execPath/;

/**
 * Writer axis. A test is in scope when it builds a path to a dispatcher or a
 * git-autopilot hook AND spawns the node binary.
 *
 * The path-construction requirement is what keeps the axis precise: measured
 * 2026-09-04T05:2xZ, a bare "filename appears anywhere in the source" rule
 * swept in three innocent files that merely NAME a dispatcher —
 * `tests/hooks/import-safety.test.js:153` and `tests/hooks/main-entry.test.js:172`
 * assert on a directory listing, and `tests/hooks/tool-tracker.test.js:765`
 * mentions one in a comment. None of them spawns a dispatcher.
 *
 * `git-autopilot` is assembled at runtime rather than written as one literal
 * so this file cannot match its own source during the self-scan.
 */
const AUTOPILOT_PREFIX = `git-auto${'pilot'}`;
const SPAWNED_SCRIPT_PATH = new RegExp(
  `path\\.(?:join|resolve)\\([^)]*['"\`](?:_[a-z]+-dispatcher|${AUTOPILOT_PREFIX}-[a-z]+)\\.js['"\`]`,
);

/**
 * Ratchet on the writer axis itself. If a new suite starts spawning a
 * dispatcher, this list stops matching and the gate goes red, forcing whoever
 * added it to decide how that suite reaches the hook. Without the ratchet the
 * axis fails open: a brand-new spawner would simply not be scanned for.
 *
 * Measured 2026-09-04T05:2xZ: 6 of 620 `*.test.js` files.
 */
const KNOWN_DISPATCHER_SPAWNERS = [
  'tests/dispatcher/posttooluse-dispatcher.test.js',
  'tests/dispatcher/sessionend-dispatcher.test.js',
  'tests/dispatcher/sessionstart-dispatcher.test.js',
  'tests/dispatcher/stop-dispatcher.test.js',
  'tests/dispatcher/subagentstop-dispatcher.test.js',
  'tests/hooks/userprompt-dispatcher.test.js',
];

/**
 * Suites deliberately OUT of the writer axis, with the reason each is judged
 * low risk. Registered rather than merely omitted so that the judgement is
 * visible and revisitable — an unwritten exclusion is indistinguishable from
 * an oversight.
 *
 * Both spawn ONE hook directly rather than a dispatcher, and neither hook
 * touches git: the only writes go to `<home>/.claude/artibot/`, and both
 * suites already redirect HOME/USERPROFILE at the spawn. Their cwd is the
 * checkout (inherited, no `cwd` key), which is why they would be red if the
 * axis were widened to "any hook spawn" — that widening is a separate
 * decision, not this gate's.
 */
const SCOPE_EXCLUSIONS = [
  {
    file: 'tests/hooks/zero-result-guard.test.js',
    why: 'spawns zero-result-guard.js alone; its only write is the counter under '
      + 'getHomeDir() and the spawn redirects HOME/USERPROFILE',
    homeRedirected: true,
  },
  {
    file: 'tests/hooks/tool-tracker.test.js',
    why: 'spawns tool-tracker.js alone; writes tool-history.json under '
      + 'getHomeDir() and the spawn redirects HOME/USERPROFILE',
    homeRedirected: true,
  },
];

/**
 * ALLOWLIST of recognized cwd-isolation mechanisms. A spawn's resolved option
 * text must show at least one. Anything else is red — including a mechanism
 * that works but is not listed, which is the point.
 */
const MECHANISMS = [
  {
    id: 'mkdtemp-cwd',
    why: 'cwd is bound to an identifier the file derived from mkdtemp, so no '
      + 'repository sits above it and getRepoRoot() fails structurally',
    test: (optionText, src) => cwdIdentifiers(optionText)
      .some((id) => mkdtempIdentifiers(src).has(id)),
  },
  {
    id: 'mkdtemp-git-repo-cwd',
    why: 'cwd is a throwaway repo the file created with `git init` in a mkdtemp '
      + 'directory — for suites that need a real repo rather than none',
    test: (optionText, src) => cwdIdentifiers(optionText)
      .some((id) => mkdtempIdentifiers(src).has(id))
      && /['"`]init['"`]/.test(src),
  },
];

/** Every `*.test.js` under `tests/`, as plugin-relative POSIX paths. */
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

function readTest(rel) {
  return fsSync.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');
}

/**
 * Source with `//` and block comments blanked out, quotes preserved.
 *
 * Every scan below runs on this, for two reasons, both measured:
 *
 *  1. An apostrophe in prose opens a phantom string. The first draft of this
 *     gate read `tests/hooks/userprompt-dispatcher.test.js` spawn #1 as
 *     `no-cwd-key` — that spawn passes `cwd: sandboxCwd` correctly, but the
 *     comment above it contains "this suite's", and the quote-aware bracket
 *     scanner treated everything from that apostrophe onward as a string
 *     literal. A gate that reports a compliant file is as broken as one that
 *     misses a violation.
 *  2. A comment that merely NAMES a dispatcher must not put a file on the
 *     writer axis (`tests/hooks/tool-tracker.test.js:765` does exactly that).
 *
 * Comment bodies are replaced by spaces rather than deleted so that every
 * offset — and therefore every line number in a failure message — is preserved.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (; i < stop; i += 1) out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Identifiers this source assigns from `mkdtemp` / `mkdtempSync`. */
function mkdtempIdentifiers(src) {
  const ids = new Set();
  const re = /([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:fsSync\.|fs\.)?mkdtemp(?:Sync)?\s*\(/g;
  for (const m of src.matchAll(re)) ids.add(m[1]);
  return ids;
}

/** Identifiers (or member expressions) any `cwd:` in this text is bound to. */
function cwdIdentifiers(text) {
  return [...text.matchAll(/cwd\s*:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

/**
 * Slice the balanced `{...}` or `[...]` starting at `open`.
 *
 * Quote-aware so a brace inside a string literal cannot end the slice early.
 * Deliberately not a parser: it is enough to bound one options object.
 *
 * @param {string} src
 * @param {number} open index of the opening bracket
 * @returns {string} the bracketed text, or '' when unbalanced
 */
function balanced(src, open) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const close = pairs[src[open]];
  if (!close) return '';
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === src[open]) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

/** Body of `function name(...) { ... }` in this source, or ''. */
function functionBody(src, name) {
  const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) return '';
  const brace = src.indexOf('{', src.indexOf(')', at));
  return brace < 0 ? '' : balanced(src, brace);
}

/**
 * Option text for every `process.execPath` spawn in this source, with one hop
 * of `...builder()` spread resolved.
 *
 * @param {string} src
 * @returns {string[]} one entry per spawn; '' when no options object is passed
 */
function spawnOptionTexts(raw) {
  const src = stripComments(raw);
  const out = [];
  for (const m of src.matchAll(new RegExp(EXECPATH_SPAWN, 'g'))) {
    const callOpen = src.indexOf('(', m.index);
    const args = balanced(src, callOpen);
    // The options object is the last `{...}` at depth 1 of the argument list.
    let text = '';
    let depth = 0;
    let quote = null;
    for (let i = 1; i < args.length - 1; i += 1) {
      const ch = args[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      else if (ch === '{' && depth === 0) {
        const obj = balanced(args, i);
        if (obj) { text = obj; i += obj.length - 1; }
      }
    }
    for (const spread of text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      text += `\n${functionBody(src, spread[1])}`;
    }
    out.push(text);
  }
  return out;
}

/** True when this source is on the writer axis. */
function spawnsDispatcher(raw) {
  const src = stripComments(raw);
  return EXECPATH_SPAWN.test(src) && SPAWNED_SCRIPT_PATH.test(src);
}

/**
 * Verdicts for one file's spawns.
 *
 * @param {string} src
 * @returns {{index: number, verdict: 'ok'|'no-cwd-key'|'unregistered-mechanism',
 *            mechanisms: string[]}[]}
 */
function auditSpawns(raw) {
  const src = stripComments(raw);
  return spawnOptionTexts(raw).map((text, index) => {
    if (!/\bcwd\s*:/.test(text)) return { index, verdict: 'no-cwd-key', mechanisms: [] };
    const mechanisms = MECHANISMS.filter((mech) => mech.test(text, src)).map((mech) => mech.id);
    return {
      index,
      verdict: mechanisms.length > 0 ? 'ok' : 'unregistered-mechanism',
      mechanisms,
    };
  });
}

describe('tests spawning a dispatcher must sandbox the working directory', () => {
  const files = testFiles();

  it('scans a non-empty set of test files (self-check)', () => {
    // A scanner that silently found nothing to scan would pass forever.
    expect(files.length).toBeGreaterThan(400);
  });

  it('knows every test that spawns a dispatcher (writer-axis ratchet)', () => {
    // This file is excluded from its own scan: the positive controls below are
    // real source strings, so the scanner sees them and would list itself as a
    // seventh spawner. The controls exercise the same functions directly, so
    // nothing is lost by the exclusion.
    const found = files
      .filter((rel) => rel !== SELF)
      .filter((rel) => spawnsDispatcher(readTest(rel)));
    expect(found.sort()).toEqual([...KNOWN_DISPATCHER_SPAWNERS].sort());
  });

  it('every dispatcher spawn passes a cwd carrying an allowlisted mechanism', () => {
    const violations = [];
    for (const rel of KNOWN_DISPATCHER_SPAWNERS) {
      const src = readTest(rel);
      for (const { index, verdict } of auditSpawns(src)) {
        if (verdict !== 'ok') violations.push(`${rel} spawn#${index}: ${verdict}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the registered scope exclusions honest (they must still redirect HOME)', () => {
    // The exclusions are justified by HOME redirection, not by cwd. If one of
    // them stops redirecting HOME, the stated reason is false and the entry
    // must be re-decided rather than silently inherited.
    for (const { file, homeRedirected } of SCOPE_EXCLUSIONS) {
      const src = readTest(file);
      expect(spawnsDispatcher(src), `${file} entered the writer axis`).toBe(false);
      if (homeRedirected) {
        expect(/USERPROFILE\s*:/.test(src) && /HOME\s*:/.test(src), file).toBe(true);
      }
    }
  });
});

describe('scanner self-verification (positive controls)', () => {
  // Without these the gate could pass because its matchers are broken rather
  // than because the repo is clean. Each control is a source string, so nothing
  // touches disk and no fixture can be left behind.

  const SPAWNER_HEAD = [
    "const SCRIPT = path.join(ROOT, 'scripts', 'hooks', '_sessionstart-dispatcher.js');",
    'let sandboxCwd;',
    "beforeAll(() => { sandboxCwd = mkdtempSync(path.join(tmpdir(), 'x-')); });",
  ].join('\n');

  it('flags a spawn aimed at the checkout', () => {
    const bad = `${SPAWNER_HEAD}\nexecFileSync(process.execPath, [SCRIPT], { cwd: PLUGIN_ROOT });`;
    expect(spawnsDispatcher(bad)).toBe(true);
    expect(auditSpawns(bad).map((r) => r.verdict)).toEqual(['unregistered-mechanism']);
  });

  it('flags a spawn with no cwd key at all (absence is not neutral)', () => {
    const bad = `${SPAWNER_HEAD}\nexecFileSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });`;
    expect(auditSpawns(bad).map((r) => r.verdict)).toEqual(['no-cwd-key']);
  });

  it('accepts a mkdtemp cwd', () => {
    const ok = `${SPAWNER_HEAD}\nexecFileSync(process.execPath, [SCRIPT], { cwd: sandboxCwd });`;
    expect(auditSpawns(ok)).toEqual([{ index: 0, verdict: 'ok', mechanisms: ['mkdtemp-cwd'] }]);
  });

  it('accepts a mkdtemp cwd reached through one options-builder hop', () => {
    // The shape the three dispatcher suites use, so the indirection that makes
    // their own self-checks non-vacuous does not blind this gate.
    const ok = [
      SPAWNER_HEAD,
      'function spawnOptions(env = {}) {',
      '  return { cwd: sandboxCwd, env: { ...process.env, ...env } };',
      '}',
      'execFileSync(process.execPath, [SCRIPT], { ...spawnOptions(), input: "{}" });',
    ].join('\n');
    expect(auditSpawns(ok).map((r) => r.verdict)).toEqual(['ok']);
  });

  it('recognizes the git-init repo mechanism', () => {
    const ok = [
      "const SCRIPT = path.join(ROOT, 'scripts', 'hooks', '_stop-dispatcher.js');",
      "let repo;\nbeforeAll(() => { repo = mkdtempSync(p); execFileSync('git', ['init'], { cwd: repo }); });",
      'execFileSync(process.execPath, [SCRIPT], { cwd: repo });',
    ].join('\n');
    expect(auditSpawns(ok)[0].mechanisms).toContain('mkdtemp-git-repo-cwd');
  });

  it('does not sweep in a file that merely names a dispatcher', () => {
    // Measured false positives of the looser rule: import-safety.test.js:153,
    // main-entry.test.js:172, tool-tracker.test.js:765.
    const ok = [
      "expect(files).toContain('_posttooluse-dispatcher.js');",
      'execFileSync(process.execPath, [TRACKER], { encoding: "utf8" });',
    ].join('\n');
    expect(spawnsDispatcher(ok)).toBe(false);
  });

  it('does not mistake a non-spawn cwd for the spawn cwd', () => {
    // posttooluse-dispatcher.test.js reads `git status` with `cwd: PLUGIN_ROOT`
    // on purpose — observing the checkout is the point of that helper. Only
    // the process.execPath spawn's own options may be judged.
    const ok = [
      SPAWNER_HEAD,
      "execFileSync('git', ['status'], { cwd: PLUGIN_ROOT });",
      'execFileSync(process.execPath, [SCRIPT], { cwd: sandboxCwd });',
    ].join('\n');
    expect(auditSpawns(ok).map((r) => r.verdict)).toEqual(['ok']);
  });

  it('is not fooled by an apostrophe in a comment (regression control)', () => {
    // The bug this control exists for: the scanner's quote tracking treated
    // "suite's" as the start of a string literal and swallowed the rest of the
    // options object, reporting a compliant spawn in
    // tests/hooks/userprompt-dispatcher.test.js:317 as `no-cwd-key`.
    const ok = [
      SPAWNER_HEAD,
      'execFileSync(process.execPath, [SCRIPT], {',
      "  // NOT PLUGIN_ROOT: that put this suite's fixtures in the real store.",
      '  cwd: sandboxCwd,',
      '});',
    ].join('\n');
    expect(auditSpawns(ok).map((r) => r.verdict)).toEqual(['ok']);
  });

  it('has a positive control for every registered mechanism', () => {
    // Otherwise the controls are silently narrower than the allowlist.
    const covered = ['mkdtemp-cwd', 'mkdtemp-git-repo-cwd'];
    expect(covered.sort()).toEqual(MECHANISMS.map((m) => m.id).sort());
  });
});
