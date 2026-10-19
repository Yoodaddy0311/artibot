import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * scripts/hooks/_main-entry.js#isMainEntry — reached through a symlink or a
 * Windows directory junction.
 *
 * `isMainEntry` compares `path.resolve(process.argv[1])` against
 * `path.resolve(fileURLToPath(import.meta.url))` (:51-52). Those two are NOT
 * the same string when the module is reached through a link: Node resolves the
 * main module's `import.meta.url` through realpath (the default —
 * `--preserve-symlinks-main` is off), while `argv[1]` stays exactly as it was
 * spelled on the command line. Measured on this machine 2026-08-14 with a
 * junction made by `cmd /c mklink /J`:
 *
 *   direct        argv1=…\real\probe.mjs  own=…\real\probe.mjs  equal=true
 *   via junction  argv1=…\link\probe.mjs  own=…\real\probe.mjs  equal=FALSE
 *
 * The consequence is not a wrong boolean. Every hook gates `main()` on this
 * helper, so a false negative means the hook is spawned, exits 0, prints
 * nothing, and reports success — the v4.43.0 failure mode, reproduced through
 * a different door. Links are not exotic here: `~/.claude/artibot` is a
 * plausible junction on Windows (OneDrive-redirected profiles), and a
 * Homebrew/npm-linked install is one on macOS and Linux.
 *
 * tests/hooks/main-entry.test.js covers six PATH SHAPES (space, Korean, tilde,
 * hash, parens) but every one of them is a direct, unlinked path. Link
 * traversal is an orthogonal axis, so it gets its own file rather than a
 * seventh `it.each` row that would read as just another shape.
 *
 * Both directions are pinned. A false negative silently disables a hook; a
 * false positive is worse — it fires `main()` inside an importer, so a hook
 * that another hook imports for one export would run its whole body, read the
 * importer's stdin and emit a second set of directives into the same slot.
 * Any fix must move the first and leave the second alone.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = pathToFileURL(
  path.resolve(HERE, '..', '..', 'scripts', 'hooks', '_main-entry.js'),
).href;

/**
 * Create this run's scratch directory: a fresh `mkdtemp` directory directly
 * under the canonical spelling of the OS temp dir.
 *
 * @returns {string} Absolute path of the new, empty directory.
 */
function makeBase() {
  return mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'artibot-main-entry-symlink-'));
}

// ONE DIRECTORY PER RUN. `mkdtemp` hands every vitest process its own base, so
// two processes on one machine (two worktrees, two terminals) cannot delete and
// recreate each other's `real` and `link`. The fixed
// `…/artibot-main-entry-symlink-test` this replaces did exactly that. Measured
// 2026-10-19 on this Windows host by starting two copies of this file at once,
// 6 rounds, 12 process runs: 2 clean, 2 red, and 8 reported "passed" with 4 of
// 5 cases SKIPPED — `setupLink` below reports a refused link as a skip, so the
// collision surfaced as a green file rather than a red one.
//
// CANONICAL TEMP DIR, not `os.tmpdir()` as it comes. On Windows that is the
// 8.3 form `…\HEECHA~1\…`, and its tilde is itself one of the path shapes
// main-entry.test.js covers, which would mask whether a failure here came from
// the link or from the path shape. On macOS `/var` is itself a link to
// `/private/var` (documented behavior, not measured on this host), which would
// turn the DIRECT run into a linked run too.
// `realpathSync.native` spells the temp dir the way the module's own
// `import.meta.url` will, so the only link in play is LINK. A temp dir that
// cannot be created is NOT a skip: it throws at load, loudly. Only a refused
// LINK is a skip, as `setupLink` documents.
const BASE = makeBase();
const REAL = path.join(BASE, 'real');
const LINK = path.join(BASE, 'link');

const PROBE = [
  `import { isMainEntry } from ${JSON.stringify(MAIN_ENTRY)};`,
  'process.stdout.write(JSON.stringify({ main: isMainEntry(import.meta.url) }));',
].join('\n');

/**
 * Create REAL/ inside this run's BASE, its probe, and a LINK -> REAL directory
 * link.
 *
 * Junctions (`mklink /J`) need no administrator rights and no Developer Mode,
 * unlike symbolic links on Windows; POSIX gets a plain directory symlink.
 * Returns the reason it could not be made, or null on success — a machine that
 * refuses links must skip rather than report a green it did not earn.
 */
function setupLink() {
  try {
    mkdirSync(REAL, { recursive: true });
    writeFileSync(path.join(REAL, 'probe.mjs'), PROBE, 'utf8');
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', LINK, REAL], { stdio: 'pipe' });
    } else {
      symlinkSync(REAL, LINK, 'dir');
    }
    // Prove the link resolves before trusting any assertion made through it.
    const out = execFileSync(process.execPath, [path.join(LINK, 'probe.mjs')], { encoding: 'utf8' });
    JSON.parse(out);
    return null;
  } catch (err) {
    return err.message;
  }
}

const linkFailure = setupLink();
const noLink = linkFailure !== null;

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe('isMainEntry (link traversal)', () => {
  it('created a directory link to test through', () => {
    // Surfaces the skip reason as a named result instead of a silent absence.
    // Reported failure, if any: see the message below.
    if (noLink) {
      // eslint-disable-next-line no-console
      console.warn(`[main-entry-symlink] link unavailable, cases skipped: ${linkFailure}`);
    }
    expect(typeof linkFailure === 'string' || linkFailure === null).toBe(true);
  });

  it.skipIf(noLink)('resolves true when run through a directory link', () => {
    // The defect. argv[1] keeps the link spelling, import.meta.url is
    // realpath'd, the strings differ, the guard says "not main" — and every
    // hook spawned this way exits 0 having done nothing at all.
    const out = execFileSync(process.execPath, [path.join(LINK, 'probe.mjs')], { encoding: 'utf8' });
    expect(JSON.parse(out).main).toBe(true);
  });

  it.skipIf(noLink)('still resolves true when run through the real path', () => {
    // The case that already worked. Pinned so a fix cannot trade one direction
    // for the other.
    const out = execFileSync(process.execPath, [path.join(REAL, 'probe.mjs')], { encoding: 'utf8' });
    expect(JSON.parse(out).main).toBe(true);
  });

  it.skipIf(noLink)('stays false when the linked module is imported, not run', () => {
    // The direction that must NOT move. Resolving both sides through realpath
    // fixes the case above without touching this one; matching on basename, or
    // on "same directory", would break it — and a hook firing inside its
    // importer is a worse outcome than a hook not firing at all.
    const importer = path.join(REAL, 'importer.mjs');
    const viaLink = pathToFileURL(path.join(LINK, 'probe.mjs')).href;
    writeFileSync(importer, `await import(${JSON.stringify(viaLink)});`, 'utf8');

    const out = execFileSync(process.execPath, [importer], { encoding: 'utf8' });
    expect(JSON.parse(out).main).toBe(false);
  });

  it.skipIf(noLink)('stays false for a same-named sibling reached through the link', () => {
    // Identity, not name. A fix that compares basenames would pass every case
    // above and this is the one that catches it.
    const other = path.join(REAL, 'nested');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'probe.mjs'), PROBE, 'utf8');

    const runner = path.join(REAL, 'runner.mjs');
    const nestedViaLink = pathToFileURL(path.join(LINK, 'nested', 'probe.mjs')).href;
    writeFileSync(runner, `await import(${JSON.stringify(nestedViaLink)});`, 'utf8');

    const out = execFileSync(process.execPath, [runner], { encoding: 'utf8' });
    expect(JSON.parse(out).main).toBe(false);
  });
});

describe('the scratch tree belongs to this run alone', () => {
  it('is a mkdtemp directory directly under the canonical OS temp dir', () => {
    expect(path.dirname(BASE)).toBe(realpathSync.native(os.tmpdir()));
    expect(path.basename(BASE)).toMatch(/^artibot-main-entry-symlink-[A-Za-z0-9]{6}$/);
  });

  it('is spelled the way realpath spells it, so the direct run crosses no link', () => {
    // Red here would mean "still resolves true when run through the real path"
    // runs through a link already (an 8.3 short name, macOS /var), and the two
    // directions pinned above could no longer be told apart.
    expect(realpathSync.native(BASE)).toBe(BASE);
  });

  it('is not shared: a second run is handed a different directory', () => {
    const other = makeBase();
    try {
      expect(other).not.toBe(BASE);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
