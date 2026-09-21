/**
 * Firewall — the autopilot session store must be sandboxed for the whole suite.
 *
 * The store is `<pluginRoot>/runtime/autopilot`, resolved by
 * `lib/autopilot/session-store.js#getStoreDir` (cited by symbol on purpose: a
 * line number in that module has not survived past edits). Unlike the user
 * state tree this directory is SHIPPED — it lives inside the plugin build — so
 * a test that reaches a writer dirties the working copy. Five writers reach it
 * and all five route through that one resolver: `saveSession`,
 * `lib/autopilot/telemetry.js`, `lib/autopilot/lock.js`,
 * `lib/autopilot/memory.js` and `lib/autopilot/worktree-manager.js`.
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
 * MEASURED 2026-09-21, this worktree. Before and after a full run of the three
 * suites this limb is allowed to run, `runtime/autopilot` held 0 entries. The
 * module scan below covered `lib/` and `scripts/` and found exactly two files
 * that name the store path in code; both are listed in
 * `KNOWN_STORE_PATH_MODULES` with the reason they are there.
 *
 * THE RULE IS AN ALLOWLIST on both axes — the module ratchet is an explicit
 * list, not a pattern that happens to match today. A denylist of known-bad
 * spellings fails open for the next one written.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
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
 *   - **Comment-stripper fidelity.** The scan strips comments with a small
 *     scanner, not a parser. A template literal containing a nested `${}` with
 *     its own backtick is not modelled; measured 2026-09-21, no such case
 *     exists near a store-path spelling.
 */

import {
  afterEach, describe, expect, it,
} from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPluginRoot, sameDirPath } from '../../lib/core/platform.js';
import { getStoreDir, saveSession } from '../../lib/autopilot/session-store.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETUP_FILE = path.join(PLUGIN_ROOT, 'tests', 'setup', 'state-dir.js');
const VITEST_CONFIG = path.join(PLUGIN_ROOT, 'vitest.config.js');

/** The shipped store this gate keeps test writes out of. */
function realStoreDir() {
  return path.join(getPluginRoot(), 'runtime', 'autopilot');
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
 * Entry count for a directory, with absence distinguished from emptiness.
 *
 * Returning -1 rather than 0 for a missing directory is what lets the
 * before/after comparison pin "absent stayed absent" as strictly as "empty
 * stayed empty". Folding both to 0 would let a run that CREATED the real store
 * pass.
 *
 * @param {string} dir
 * @returns {number} Entry count, or -1 when the directory does not exist.
 */
function entryCount(dir) {
  try {
    return fsSync.readdirSync(dir).length;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return -1;
    throw err;
  }
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

  afterEach(() => {
    for (const key of ['ARTIBOT_AUTOPILOT_STORE_DIR', 'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('resolves the store into a temp directory, not the shipped one', () => {
    const dir = getStoreDir();
    expect(isInside(os.tmpdir(), dir)).toBe(true);
    expect(isInside(realStoreDir(), dir)).toBe(false);
    expect(sameDirPath(dir, realStoreDir())).toBe(false);
  });

  it('writes a real session to temp and leaves the shipped store untouched', () => {
    // A resolver assertion alone is a necessary condition, not the claim. This
    // drives the actual writer and then looks at both directories on disk.
    const before = entryCount(realStoreDir());
    const sessionId = `fw-autopilot-store-${process.pid}-${Date.now()}`;
    const written = saveSession({ sessionId, phase: 'FIREWALL' });
    try {
      expect(fsSync.existsSync(written)).toBe(true);
      expect(isInside(os.tmpdir(), written)).toBe(true);
      expect(isInside(realStoreDir(), written)).toBe(false);
      // Absent must stay absent and empty must stay empty; `entryCount`
      // distinguishes the two so neither drifts into the other.
      expect(entryCount(realStoreDir())).toBe(before);
    } finally {
      try { fsSync.unlinkSync(written); } catch { /* best effort */ }
    }
  });

  it('discards the override when the recorded plugin root no longer matches', () => {
    // The inherited-env hazard: a child handed a different CLAUDE_PLUGIN_ROOT
    // must fall back to its own store rather than keep writing into the
    // parent's. Path resolution only — nothing here touches disk.
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT = path.join(os.tmpdir(), 'some-other-plugin-root');
    expect(sameDirPath(getStoreDir(), realStoreDir())).toBe(true);
  });

  it('discards an override that carries no recorded root at all', () => {
    // The fail-open shape the pairing exists to refuse: "cannot place" must not
    // read as "trust".
    delete process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT;
    expect(sameDirPath(getStoreDir(), realStoreDir())).toBe(true);
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

  it('registers that setup file with vitest for every project', () => {
    // Read-only. If `setupFiles` is renamed or the entry dropped, the seam is
    // off for the whole suite and every live assertion above would go quiet.
    const src = stripComments(fsSync.readFileSync(VITEST_CONFIG, 'utf-8'));
    expect(src).toMatch(/setupFiles\s*:\s*\[[^\]]*state-dir\.js/);
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
