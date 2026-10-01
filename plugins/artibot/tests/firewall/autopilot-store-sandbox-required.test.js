/**
 * Firewall — the autopilot session store must be sandboxed for the whole suite.
 *
 * The store is `<state dir>/runtime/autopilot` — `resolveArtibotDir()`, i.e.
 * `~/.claude/artibot` — resolved by `lib/autopilot/session-store.js#getStoreDir`
 * (cited by symbol on purpose: a line number in that module has not survived
 * past edits). Until owner decision D2 (2026-09-30) it was
 * `<pluginRoot>/runtime/autopilot`; the paragraphs below that speak of the plugin
 * root describe the measurements made then, and are kept as measured. The store
 * is outside the repository now and was git-ignored before (`.gitignore` matched
 * `/runtime/`), so a stray test write does NOT dirty the working copy — it shows
 * up in no `git status`, which is what makes it worth a gate. The cost
 * is that test sessions share a directory with real ones and every reader of
 * the store population counts them: `session-store.js#listSessions`, and
 * through it `lib/autopilot/cross-session-learner.js:37` and
 * `scripts/hooks/bash-risk-guard.js:96`; `scripts/dev/prune-autopilot-store.mjs:303`
 * enumerates the same directory directly. Five writers reach it and all
 * five route through that one resolver: `saveSession`,
 * `lib/autopilot/telemetry.js`, `lib/autopilot/lock.js`,
 * `lib/autopilot/memory.js` and `lib/autopilot/worktree-manager.js`.
 *
 * TWO SEAMS NOW GUARD IT, and this gate pins the one that is its own. The
 * autopilot override below redirects the store into a temp directory; the
 * setup's `ARTIBOT_STATE_DIR` redirects `resolveArtibotDir()` for everything
 * else, which would catch a store whose override was dropped. The "real store" in
 * this file is therefore the one a user's machine has — under the real home,
 * not under the redirected state dir — and the default store a discarded
 * override falls back to is asserted against the state dir, which is where it
 * lands in the suite.
 *
 * WHY A GATE RATHER THAN PER-FILE ISOLATION. Most files under
 * `tests/autopilot/` set no override at all, so isolation was moved into the
 * global setup (`tests/setup/state-dir.js`) and made default-on. That turns the
 * whole suite green in one edit and leaves nothing for a NEW test file to
 * remember — but it also means the protection is a single line that a future
 * refactor can drop without any test noticing. This gate is what notices.
 *
 * THE OVERRIDE IS A PAIR, and the pairing is load-bearing rather than
 * decoration: `ARTIBOT_AUTOPILOT_STORE_DIR` is honored only while
 * `ARTIBOT_AUTOPILOT_STORE_DIR_ROOT` still names the plugin root in force
 * (compared through `sameDirPath`). Environment variables are inherited by
 * spawned children, so without the pair a child isolated by a different
 * `CLAUDE_PLUGIN_ROOT` would have the parent's override ride along and overrule
 * the more specific knob it was actually given. Case (b) pins the discard.
 *
 * THIS FILE RUNS IN THE `main` PROJECT; the suite it protects is the
 * `autopilot` one. `vitest.config.js` declares `setupFiles` once at the top
 * level and both projects inherit it through `extends: true`. Drop that
 * inheritance, or redeclare `setupFiles` inside the autopilot project, and
 * every live assertion here stays green while `tests/autopilot/**` writes into
 * the real store. Case (d) pins the config shape for that reason, and
 * `tests/autopilot/session-store.test.js` carries the one live assertion that
 * executes inside the autopilot project itself.
 *
 * MEASURED 2026-09-21 04:45–04:47Z, this worktree: `npx vitest run --project
 * autopilot` (71 files, 1834 tests) plus 10 targeted files outside that project
 * (123 tests) left `runtime/autopilot` at 0 entries before and after, with an
 * identical listing, and the count of per-worker sandbox directories in
 * `os.tmpdir()` unchanged (25 → 25 → 25; setup removes its own in `afterAll`).
 * The positive half: the same project run with an operator-supplied
 * `ARTIBOT_AUTOPILOT_STORE_DIR` — which setup never removes — left `locks/`,
 * `memory/`, `worktrees/` and `sess-own.events.ndjson` (18 files) in that
 * directory while the real store stayed at 0. The suite does write; the writes
 * go to the sandbox. A zero that came from a suite touching nothing would
 * prove neither. The module scan below covered `lib/` and
 * `scripts/` and found exactly two files naming the store path in code; both
 * are listed in `KNOWN_STORE_PATH_MODULES` with the reason they are there.
 * A THIRD was added 2026-09-22 — a read-only census CLI that mirrors the
 * resolver rather than importing it; see its entry for why. The "two" above is
 * the 2026-09-21 measurement and is left as measured; the list is the count.
 *
 * THE RULE IS AN ALLOWLIST on both axes — the module ratchet is an explicit
 * list, not a pattern that happens to match today. A denylist of known-bad
 * spellings fails open for the next one written.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - **Anything but a NEW top-level name, inside case (b)'s own milliseconds.**
 *     Case (b) lists the real store's top-level names (`null` when the directory
 *     does not exist) immediately before and after ONE `saveSession`, leaves out
 *     names containing `.tmp.` (a writer's in-flight temp file, not a leak), and
 *     asserts that the directory was not created and that no name was added.
 *     That catches a writer that creates the real store or drops a new
 *     top-level file into it — and the check is run against a stand-in directory
 *     by the self-verification block below, so it is known to go red.
 *     It does NOT detect a delete or a modify: a name that vanished, or a file
 *     whose bytes changed, reads as "nothing added". Neither did the entry-count
 *     comparison this replaced — a count also reads one delete plus one add as
 *     "unchanged". It does not look inside an existing subdirectory (`locks/`,
 *     `memory/`, `worktrees/`). And it sees only its own window: a different
 *     test leaking a different file at another time, in another worker, is
 *     caught by (a) and the setup assertions if it goes through the resolver,
 *     and by nothing here if it does not. The narrow window is also why a live
 *     autopilot run in another window should not turn the gate red: that run
 *     would have to create a NEW top-level name inside those milliseconds.
 *     Measured 2026-09-30 against a SIMULATED live writer (atomic rewrite of one
 *     session file plus an events append every few ms; in the second variant a
 *     new top-level name every tenth tick), with the home pointed at a scratch
 *     directory: 16 of 16 gate runs green. That is not a bound on the rate.
 *   - **A test that deletes or repoints the override and never restores it.**
 *     Nothing here runs between other people's tests. Setup re-runs per file,
 *     so the blast radius is the rest of that one file, unobserved.
 *   - **Subprocess tests that hand a child the real plugin root together with a
 *     matching pair.** That is a valid override and the resolver honors it; the
 *     child writes wherever the parent said, including the real store.
 *   - **Dynamically assembled paths.** The scan reads source text, so
 *     `path.join(root, a, b)` with the segments arriving in variables is
 *     invisible. Only literal spellings are caught.
 *   - **Whether the seam is wired, beyond case (a).** Case (a) proves one
 *     `saveSession` landed in tmp. The other four writers are asserted only by
 *     construction — they call the same resolver — not by this file.
 *   - **Stores outside this seam.** `~/.artibot/queues`
 *     (`lib/autopilot/goal-queue.js`) and `~/.artibot/failure-memory`
 *     (`lib/autopilot/failure-memory.js`) anchor on the home directory directly;
 *     neither this seam nor `ARTIBOT_STATE_DIR` moves them, and their tests
 *     isolate by injecting a store directory. `.artibot/runtime/decisions` is
 *     gated by `tests/firewall/decisions-store-sandbox-required.test.js`. None
 *     of the three is reachable from here.
 *   - **Which project the live cases run in.** Cases (a) and (b) execute in
 *     `main`. Nothing here can observe the autopilot project's own workers; the
 *     evidence for those is the config assertion in (d) plus the live `it` in
 *     `tests/autopilot/session-store.test.js`.
 *   - **A third vitest project that does not extend.** The config assertion in
 *     (d) counts the two projects by NAME. A new project declared without
 *     `extends: true` adds to neither count and stays green here while running
 *     with no setup at all.
 *   - **Comment-stripper fidelity.** The scan strips comments with a small
 *     scanner, not a parser. Two known divergences. A template literal
 *     containing a nested `${}` with its own backtick is not modelled; measured
 *     2026-09-21, no such case exists near a store-path spelling. And a REGEX
 *     LITERAL is treated as ordinary code, so a quote, backtick or `/*` inside
 *     one desynchronizes the scanner for the rest of the file — reviewer
 *     measurement 2026-09-21 found this happening in 12 files under `lib/` and
 *     `scripts/` (e.g. `lib/autopilot/safety.js`), with an empty intersection
 *     against the files that spell the store path. A real parser is the fix if
 *     that intersection ever stops being empty.
 *   - **An operator override outside tmp.** Exporting
 *     `ARTIBOT_AUTOPILOT_STORE_DIR` to somewhere outside `os.tmpdir()` turns
 *     case (a) red even though the store is isolated. That is deliberate: the
 *     gate asserts the shape the suite ships with, and failing toward "look at
 *     this" is the safe direction.
 */

import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtibotDir } from '../../lib/core/config.js';
import { getHomeDir, sameDirPath } from '../../lib/core/platform.js';
import { getStoreDir, saveSession } from '../../lib/autopilot/session-store.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETUP_FILE = path.join(PLUGIN_ROOT, 'tests', 'setup', 'state-dir.js');
const VITEST_CONFIG = path.join(PLUGIN_ROOT, 'vitest.config.js');

/**
 * The real store this gate keeps test writes out of — shared with live runs.
 *
 * Built from the REAL home, not from `resolveArtibotDir()`: the global setup
 * points `ARTIBOT_STATE_DIR` at a per-worker temp directory, so the resolver
 * itself answers "a temp dir" here, which is precisely the wrong thing to
 * compare a temp-dir assertion against.
 */
function realStoreDir() {
  return path.join(getHomeDir(), '.claude', 'artibot', 'runtime', 'autopilot');
}

/** Where a DISCARDED override falls back to: the state dir's store. */
function defaultStoreDir() {
  return path.join(resolveArtibotDir(), 'runtime', 'autopilot');
}

/**
 * A writer's in-flight temp file — `saveSession` names it `<file>.tmp.<pid>.<ms>.<rand>`
 * and renames it into place. It belongs to whichever process is mid-write, which
 * in the real store can be a live autopilot run, so it is not evidence of a leak.
 * Only this exact shape is left out: `leak.tmp` and `tmp.json` are still names.
 */
const IN_FLIGHT_NAME = /\.tmp\./;

/**
 * The top-level names in a store directory, or `null` when it does not exist.
 *
 * `null` is not `[]`. A directory that is absent and one that exists but is empty
 * are different states, and creating the real store is itself a leak this gate
 * exists to catch. Only ENOENT reads as absent: a listing that fails for any
 * other reason (a file where the directory should be, no permission) throws, so
 * the gate goes red instead of reading "cannot look" as "nothing there".
 *
 * @param {string} dir
 * @returns {string[]|null} sorted names, in-flight temp names excluded
 */
function topLevelNames(dir) {
  try {
    return fsSync.readdirSync(dir).filter((name) => !IN_FLIGHT_NAME.test(name)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * What appeared between two {@link topLevelNames} snapshots: the directory
 * itself, or top-level names. Absent before and after is clean.
 *
 * Deliberately blind to deletes and modifies (a name that is gone is not an
 * addition) and to anything below the top level — see WHAT THIS GATE CANNOT SEE.
 *
 * @param {string[]|null} before
 * @param {string[]|null} after
 * @returns {{created: boolean, added: string[]}}
 */
function appearedBetween(before, after) {
  if (after === null) return { created: false, added: [] };
  if (before === null) return { created: true, added: [...after] };
  const known = new Set(before);
  return { created: false, added: after.filter((name) => !known.has(name)) };
}

/**
 * Run `act` and report what it left in `dir` that was not there before.
 *
 * The window is exactly `act()`: nothing else runs between the two listings, so
 * it is milliseconds wide whatever `act` is.
 *
 * @param {string} dir
 * @param {() => void} act
 * @returns {{created: boolean, added: string[]}}
 */
function leakedBy(dir, act) {
  const before = topLevelNames(dir);
  act();
  return appearedBetween(before, topLevelNames(dir));
}

/**
 * Bring a path to one comparable spelling, resolving 8.3 short names.
 *
 * `os.tmpdir()` on Windows commonly returns a shortened user segment while the
 * same directory reached another way is spelled long, and a raw `startsWith`
 * then reports two names for one directory as unrelated. `realpathSync` throws
 * for a path that does not exist yet — the store directory usually does not —
 * so this realpaths the longest EXISTING ancestor and re-appends the rest,
 * which gives both sides of a comparison the same prefix either way.
 *
 * @param {string} p - Absolute or relative path.
 * @returns {string} Absolute path with every existing segment canonicalized.
 */
function canonical(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fsSync.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * True when `child` lies strictly under `parent`.
 *
 * `path.relative` rather than `startsWith`: the latter reads `/tmp/ab` as being
 * inside `/tmp/a`, and on win32 `path.relative` also folds drive-letter and
 * segment case, which a string compare does not.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = path.relative(canonical(parent), canonical(child));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Blank out comments so the scan sees code only.
 *
 * Replaces comment bytes with spaces rather than deleting them, so a match's
 * position still lines up with the original source. String and template bodies
 * are preserved: a path spelled inside a user-facing message IS code for this
 * gate's purpose, and deciding otherwise would have hidden
 * `lib/core/doctor-fix.js` below instead of listing it.
 *
 * @param {string} src
 * @returns {string} Same length, comments replaced by spaces.
 */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end === -1 ? src.length : end + 2;
      blank(i, j);
      i = j;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j += 1; break; }
        if (c !== '`' && src[j] === '\n') break;
        j += 1;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Literal spellings of the store path in code.
 *
 * Both forms are needed. Adjacent `path.join` arguments are how the resolver
 * itself builds the path and are the shape a copy of it would take; the joined
 * literal is how a message or a config default spells it. Matching only the
 * first would have missed `doctor-fix.js`, and a narrower pattern that happened
 * to exclude it would be a gate tuned to pass rather than a gate.
 */
const STORE_PATH_PATTERNS = [
  /(['"`])runtime\1\s*,\s*(['"`])autopilot\2/,
  /runtime[/\\]+autopilot/,
];

/** True when `src` spells the store path in code (comments excluded). */
function spellsStorePath(src) {
  const code = stripComments(src);
  return STORE_PATH_PATTERNS.some((re) => re.test(code));
}

/**
 * Modules under `lib/` and `scripts/` that name the store path in code.
 *
 * A ratchet, not documentation. The whole seam rests on every writer going
 * through one resolver, so a second module assembling the path is the failure
 * this list exists to make loud. Measured 2026-09-21: every other match
 * repo-wide is a comment or JSDoc and is stripped before the scan.
 */
const KNOWN_STORE_PATH_MODULES = [
  // The resolver itself — the one legitimate assembly site, and the reason
  // every writer can be redirected by a single pair of variables.
  'lib/autopilot/session-store.js',
  // A user-facing Korean guidance string naming `runtime/autopilot/locks/` so a
  // reader can find a stale lock by hand. It is code, but it builds no path and
  // reaches no writer. Listed rather than pattern-excluded: narrowing the
  // pattern to skip it would also skip a real assembler spelled the same way.
  'lib/core/doctor-fix.js',
  // A READ-ONLY census of `state.recoveryJournal` (V5-BACKLOG §4-b CA-03 b).
  // It genuinely is a SECOND assembly site and that is the cost being recorded
  // here, not waived: it cannot import the resolver, because the resolver
  // lives in the writer module and that reader's paired test enforces a
  // writer-import allowlist. It mirrors the env PAIR with the same
  // fail-closed semantics (`tests/ledger/recovery-journal-census.test.js`
  // pins the unpaired and wrong-root discards), and it opens nothing for
  // writing — so it can reach no store, sandboxed or real. It mirrors the list
  // of old locations the store adopts from (`getLegacyStoreDirs`) the same way;
  // `tests/ledger/recovery-journal-census-store.test.js` runs both over the
  // same layouts. If the resolver's pairing rule ever changes, THIS copy is the
  // one that will not notice.
  'scripts/ledger/recovery-journal-census.mjs',
];

/** Repo-relative POSIX paths of `lib/` + `scripts/` sources spelling the path. */
function modulesSpellingStorePath() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      if (spellsStorePath(fsSync.readFileSync(full, 'utf-8'))) {
        found.push(path.relative(PLUGIN_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  for (const root of ['lib', 'scripts']) walk(path.join(PLUGIN_ROOT, root));
  return found.sort();
}

describe('the autopilot store is sandboxed for every test in the suite', () => {
  const savedEnv = { ...process.env };
  /** @type {string|null} */
  let fakeRoot = null;

  /**
   * A discarded override falls back to the DEFAULT store, and the first call per
   * process for the default store adopts the legacy store under the plugin root
   * in force. These cases only resolve paths, so they run against an empty fake
   * root rather than this checkout's own `runtime/autopilot`.
   */
  function useFakePluginRoot() {
    fakeRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-fw-root-'));
    fsSync.writeFileSync(path.join(fakeRoot, 'artibot.config.json'), '{}', 'utf-8');
    process.env.CLAUDE_PLUGIN_ROOT = fakeRoot;
  }

  afterEach(() => {
    for (const key of [
      'ARTIBOT_AUTOPILOT_STORE_DIR', 'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT', 'CLAUDE_PLUGIN_ROOT',
    ]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    if (fakeRoot) fsSync.rmSync(fakeRoot, { recursive: true, force: true });
    fakeRoot = null;
  });

  it('resolves the store into a temp directory, not the real one', () => {
    const dir = getStoreDir();
    expect(isInside(os.tmpdir(), dir)).toBe(true);
    expect(isInside(realStoreDir(), dir)).toBe(false);
    expect(sameDirPath(dir, realStoreDir())).toBe(false);
  });

  it('writes a real session to temp and leaves the real store untouched', () => {
    // A resolver assertion alone is a necessary condition, not the claim. This
    // drives the actual writer and then looks at both directories on disk.
    const sessionId = `fw-autopilot-store-${process.pid}-${Date.now()}`;
    let written = null;
    const leaked = leakedBy(realStoreDir(), () => {
      written = saveSession({ sessionId, phase: 'FIREWALL' });
    });
    try {
      expect(fsSync.existsSync(written)).toBe(true);
      expect(isInside(os.tmpdir(), written)).toBe(true);
      expect(isInside(realStoreDir(), written)).toBe(false);
      // The real store is the user's shared `~/.claude/artibot/runtime/autopilot`,
      // which a live autopilot run in another window may be writing to. Two
      // checks, because they fail differently:
      //   - this run's OWN id is absent — exact, and immune to that live run;
      //   - no NEW top-level name appeared, and the directory was not created,
      //     in the milliseconds around the write — broad, so it also catches a
      //     writer that leaks a differently named file or makes the directory
      //     without writing one. A live run would have to create a new
      //     top-level name inside that window to turn it red; if one does,
      //     re-run.
      // Names, not a count: a count reads one delete plus one add as "no
      // change", and an in-flight temp file of a live run moves it.
      expect(fsSync.existsSync(path.join(realStoreDir(), `${sessionId}.json`))).toBe(false);
      expect(fsSync.existsSync(path.join(realStoreDir(), `${sessionId}.events.ndjson`))).toBe(false);
      expect(leaked).toEqual({ created: false, added: [] });
    } finally {
      try { fsSync.unlinkSync(written); } catch { /* best effort */ }
    }
  });

  it('discards the override when the recorded plugin root no longer matches', () => {
    // The inherited-env hazard: a child handed a different CLAUDE_PLUGIN_ROOT
    // must fall back to the default store rather than keep writing into the
    // parent's sandbox. Path resolution only.
    const override = getStoreDir();
    expect(sameDirPath(override, path.resolve(process.env.ARTIBOT_AUTOPILOT_STORE_DIR))).toBe(true);
    useFakePluginRoot();
    expect(sameDirPath(getStoreDir(), override)).toBe(false);
    expect(sameDirPath(getStoreDir(), defaultStoreDir())).toBe(true);
    // ...and the fallback is the state dir's store, which the setup has also
    // redirected — never the real home's.
    expect(sameDirPath(getStoreDir(), realStoreDir())).toBe(false);
  });

  it('discards an override that carries no recorded root at all', () => {
    // The fail-open shape the pairing exists to refuse: "cannot place" must not
    // read as "trust".
    const override = getStoreDir();
    useFakePluginRoot();
    delete process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT;
    expect(sameDirPath(getStoreDir(), override)).toBe(false);
    expect(sameDirPath(getStoreDir(), defaultStoreDir())).toBe(true);
  });

  it('follows the state dir, not the plugin root, when the override is discarded (D2)', () => {
    useFakePluginRoot();
    delete process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT;
    expect(sameDirPath(getStoreDir(), path.join(fakeRoot, 'runtime', 'autopilot'))).toBe(false);
  });

  it('knows every module naming the store path in code (module ratchet)', () => {
    expect(modulesSpellingStorePath()).toEqual([...KNOWN_STORE_PATH_MODULES].sort());
  });
});

describe('the sandbox is set by global setup, not by this file', () => {
  // Without these the live assertions above could be green because something
  // incidental in this process set the variables, rather than because the
  // suite-wide seam is in place.

  it('sets both variables in tests/setup/state-dir.js', () => {
    const src = fsSync.readFileSync(SETUP_FILE, 'utf-8');
    const code = stripComments(src);
    // `(?!_)` so the override assertion cannot be satisfied by the pair's line.
    expect(code).toMatch(/process\.env\.ARTIBOT_AUTOPILOT_STORE_DIR(?!_)\s*=/);
    expect(code).toMatch(/process\.env\.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT\s*=/);
  });

  it('registers that setup file with vitest, once, inherited by every project', () => {
    // Read-only. This is the only evidence in this FILE that the autopilot
    // project is covered at all: the live cases above run in `main`, and the
    // seam reaches `tests/autopilot/**` solely because the top-level
    // `setupFiles` is inherited through `extends: true`. Drop that inheritance
    // or redeclare `setupFiles` inside the autopilot project and this gate
    // would otherwise stay green while the suite it protects goes unprotected.
    const src = stripComments(fsSync.readFileSync(VITEST_CONFIG, 'utf-8'));
    expect(src).toMatch(/setupFiles\s*:\s*\[[^\]]*state-dir\.js/);

    // Exactly one declaration: a second one inside a project would SHADOW the
    // top-level array rather than add to it, so counting is the assertion.
    expect(src.match(/setupFiles\s*:/g)).toHaveLength(1);

    // One `extends: true` per NAMED project, so both inherit it. The project
    // match is name-pinned (`autopilot`, `main`): a new project that extends
    // turns this red and forces an update here, but a new project that does
    // NOT extend is invisible to this assertion — see WHAT THIS GATE CANNOT SEE.
    const projects = src.match(/\bname\s*:\s*['"](?:autopilot|main)['"]/g) ?? [];
    expect(projects).toHaveLength(2);
    expect(src.match(/\bextends\s*:\s*true\b/g)).toHaveLength(projects.length);
  });
});

describe('scanner self-verification', () => {
  // A scanner that reads nothing passes forever. Each control is a source
  // string, so nothing touches disk.

  it('scans a non-empty set of modules', () => {
    expect(modulesSpellingStorePath().length).toBeGreaterThan(0);
  });

  it('flags a joined-argument assembly', () => {
    expect(spellsStorePath("const d = path.join(getPluginRoot(), 'runtime', 'autopilot');")).toBe(true);
    expect(spellsStorePath('const d = path.join(root, `runtime`, `autopilot`);')).toBe(true);
  });

  it('flags a joined path literal in either separator', () => {
    expect(spellsStorePath("const d = resolveFromRoot('runtime/autopilot');")).toBe(true);
    expect(spellsStorePath("const d = `${root}\\\\runtime\\\\autopilot`;")).toBe(true);
  });

  it('does not flag the same text inside a comment', () => {
    // The negative half. A control that only ever proves "flagged" cannot tell
    // a working scanner from one that matches everything.
    expect(spellsStorePath("// persists to runtime/autopilot/{id}.json\nconst d = getStoreDir();")).toBe(false);
    // A whole JSDoc block, not a bare ` * ` continuation line: standalone, that
    // line is a backtick string in code and the scanner is right to flag it.
    // The first draft of this control got that wrong and went red, which is the
    // evidence that it reads the stripper rather than asserting into the void.
    const jsdoc = ['/**', ' * `runtime/autopilot` holds one file per session.', ' */'].join('\n');
    expect(spellsStorePath(jsdoc)).toBe(false);
    expect(spellsStorePath("/* path.join(root, 'runtime', 'autopilot') */\nconst d = getStoreDir();")).toBe(false);
  });

  it('does not flag either segment on its own', () => {
    expect(spellsStorePath("path.join(root, 'runtime', 'decisions');")).toBe(false);
    expect(spellsStorePath("path.join(root, 'autopilot');")).toBe(false);
  });

  it('keeps a code spelling that follows a comment on the same line', () => {
    // Guards the blanking loop's bounds: a line comment must end at the
    // newline, not swallow the rest of the file.
    const src = "// see below\nconst d = path.join(r, 'runtime', 'autopilot');";
    expect(spellsStorePath(src)).toBe(true);
  });
});

describe('real-store leak check self-verification', () => {
  // The check behind case (b) is a few lines over a directory listing, and its
  // first version could not go red: it looked only at the id the test wrote
  // itself, so a saveSession that also created the real store, or dropped a
  // `leak-<ms>.json` into it, left it green (reviewer mutation, 2026-09-30).
  // Each control builds a stand-in for the real store under os.tmpdir() and runs
  // the SAME functions case (b) runs, so what the gate must catch is reproduced
  // by hand and the real home is never touched.
  /** @type {string} */
  let scratch;

  beforeEach(() => {
    scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-fw-leak-'));
  });

  afterEach(() => {
    fsSync.rmSync(scratch, { recursive: true, force: true });
  });

  const storeIn = () => path.join(scratch, '.claude', 'artibot', 'runtime', 'autopilot');
  const touch = (...parts) => fsSync.writeFileSync(path.join(...parts), '{}\n', 'utf-8');

  /** A store that already exists and holds one session, as a user's does. */
  function existingStore() {
    const dir = storeIn();
    fsSync.mkdirSync(dir, { recursive: true });
    touch(dir, 'real-session.json');
    return dir;
  }

  /** Aim the real `saveSession` at `dir` through the override pair, then restore. */
  function saveInto(dir, sessionId) {
    const saved = process.env.ARTIBOT_AUTOPILOT_STORE_DIR;
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR = dir;
    try {
      return saveSession({ sessionId, phase: 'FIREWALL' });
    } finally {
      if (saved === undefined) delete process.env.ARTIBOT_AUTOPILOT_STORE_DIR;
      else process.env.ARTIBOT_AUTOPILOT_STORE_DIR = saved;
    }
  }

  it('flags a writer that creates the store directory and nothing else', () => {
    const dir = storeIn();
    const leaked = leakedBy(dir, () => fsSync.mkdirSync(dir, { recursive: true }));
    expect(leaked).toEqual({ created: true, added: [] });
  });

  it('flags a writer that drops a new top-level file into an existing store', () => {
    const dir = existingStore();
    const leaked = leakedBy(dir, () => touch(dir, 'leak-1757000000000.json'));
    expect(leaked).toEqual({ created: false, added: ['leak-1757000000000.json'] });
  });

  it('flags a writer that creates the directory and a file in one go', () => {
    const dir = storeIn();
    const leaked = leakedBy(dir, () => {
      fsSync.mkdirSync(dir, { recursive: true });
      touch(dir, 'leak-2.json');
    });
    expect(leaked).toEqual({ created: true, added: ['leak-2.json'] });
  });

  it('flags an added name even when the same window deletes another (a count reads no change)', () => {
    const dir = existingStore();
    const leaked = leakedBy(dir, () => {
      fsSync.unlinkSync(path.join(dir, 'real-session.json'));
      touch(dir, 'leak-3.json');
    });
    expect(leaked.added).toEqual(['leak-3.json']);
    // One entry before, one after: the comparison this gate replaced saw 1 === 1.
    expect(fsSync.readdirSync(dir)).toHaveLength(1);
  });

  it('sees the real writer: a saveSession aimed at the watched directory is flagged', () => {
    // The positive control through the actual code path, not a hand-made file.
    // Unless the real writer's output is visible to this check — including its
    // `<file>.tmp.<pid>…` rename — a green case (b) means nothing.
    const absent = storeIn();
    const firstId = `fw-seen-${process.pid}-${Date.now()}`;
    const first = leakedBy(absent, () => saveInto(absent, firstId));
    expect(first.created).toBe(true);
    expect(first.added).toContain(`${firstId}.json`);

    const secondId = `fw-seen-again-${process.pid}-${Date.now()}`;
    const second = leakedBy(absent, () => saveInto(absent, secondId));
    expect(second.created).toBe(false);
    expect(second.added).toEqual([`${secondId}.json`]);
  });

  it('is clean when the store is absent before and after (a machine that never ran autopilot)', () => {
    const dir = storeIn();
    expect(topLevelNames(dir)).toBeNull();
    expect(leakedBy(dir, () => {})).toEqual({ created: false, added: [] });
  });

  it('is clean when the window changes nothing in an existing store', () => {
    const dir = existingStore();
    expect(leakedBy(dir, () => {})).toEqual({ created: false, added: [] });
  });

  it("ignores another process's in-flight temp file, and only that shape", () => {
    const dir = existingStore();
    const inFlight = leakedBy(dir, () => touch(dir, 'live-run.json.tmp.4242.1757000000000.k3j9x2'));
    expect(inFlight).toEqual({ created: false, added: [] });
    // `.tmp.` inside a name is the whole rule: these are names, and are flagged.
    const lookalikes = leakedBy(dir, () => {
      touch(dir, 'leak.tmp');
      touch(dir, 'tmp.json');
      touch(dir, 'leak.tmp-1.json');
    });
    expect(lookalikes.added).toEqual(['leak.tmp', 'leak.tmp-1.json', 'tmp.json']);
  });

  it('does NOT see a delete, a modify, or a file added below the top level', () => {
    // Stated limits, pinned so a green run is not read as more than it is. If
    // the check ever learns one of these, this case goes red and the WHAT THIS
    // GATE CANNOT SEE note in the header has to change with it.
    const dir = existingStore();
    fsSync.mkdirSync(path.join(dir, 'locks'));
    touch(dir, 'kept.json');
    const clean = { created: false, added: [] };

    expect(leakedBy(dir, () => fsSync.unlinkSync(path.join(dir, 'real-session.json')))).toEqual(clean);
    expect(leakedBy(dir, () => {
      fsSync.writeFileSync(path.join(dir, 'kept.json'), '{"tampered":true}\n', 'utf-8');
    })).toEqual(clean);
    expect(leakedBy(dir, () => touch(dir, 'locks', 'leak.lock'))).toEqual(clean);
  });

  it('reads only ENOENT as absent: a file where the directory should be is an error', () => {
    // "Cannot look" must not read as "nothing there".
    const dir = storeIn();
    fsSync.mkdirSync(path.dirname(dir), { recursive: true });
    touch(dir);
    expect(() => topLevelNames(dir)).toThrow();
  });

  it('tells the snapshots apart without touching disk', () => {
    expect(appearedBetween(null, null)).toEqual({ created: false, added: [] });
    expect(appearedBetween(null, [])).toEqual({ created: true, added: [] });
    expect(appearedBetween([], [])).toEqual({ created: false, added: [] });
    expect(appearedBetween(['a.json'], ['a.json', 'b.json'])).toEqual({ created: false, added: ['b.json'] });
    expect(appearedBetween(['a.json', 'b.json'], ['a.json'])).toEqual({ created: false, added: [] });
    expect(appearedBetween(['a.json'], null)).toEqual({ created: false, added: [] });
  });
});
