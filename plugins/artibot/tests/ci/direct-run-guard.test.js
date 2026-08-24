/**
 * Regression pins for the "run main() only when invoked directly" guards.
 *
 * Why this file exists: a direct-run guard that answers FALSE on a real direct
 * run is fail-OPEN in the quietest possible way — the script prints nothing and
 * exits 0, so every caller (CI step, npm script, cron) reads it as a pass. The
 * hook fleet already hit this twice and routed through
 * `scripts/hooks/_main-entry.js#isMainEntry`; the standalone scripts under
 * `scripts/` never did, and one of them still compared a percent-ENCODED
 * `import.meta.url` against a RAW `process.argv[1]`.
 *
 * Measured 2026-08-24 on node v24.15.0 (Windows) by running one probe per guard
 * shape out of a directory literally named `한글 경로 테스트`:
 *
 *   shape                                            ASCII    Korean
 *   path.resolve(argv1) === fileURLToPath(meta.url)  FIRED    FIRED
 *   path.basename(argv1) === '<name>'                FIRED    FIRED
 *   meta.url === `file://${argv1}` || endsWith(name) FIRED    FIRED
 *   meta.url === pathToFileURL(argv1).href           FIRED    FIRED
 *   meta.url.endsWith(argv1.replace(/\\/g,'/'))      FIRED    SILENT  <-- bug
 *   isMainEntry(import.meta.url)                     FIRED    FIRED
 *
 * Only the `endsWith` shape breaks, because it is the only one that compares the
 * two spellings without decoding either side. Note the bug is NOT dodged by
 * invoking the script with a relative path: node absolutises `process.argv[1]`
 * before the script sees it, so `node harness-ablation.js` from the repo root
 * still lands on the raw absolute Korean path.
 *
 * What these tests do NOT cover: the symlink/junction axis. `isMainEntry` falls
 * back to a realpath compare for it, but the ~20 scripts using the plain
 * `path.resolve` shape stay fail-open when reached through a link — measured the
 * same day, and out of scope here because no shipped install path is a link.
 *
 * @module tests/ci/direct-run-guard
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');
const MAIN_ENTRY = path.join(SCRIPTS_DIR, 'hooks', '_main-entry.js');

/** A directory name with both non-ASCII characters and a space — the shape that broke. */
const KOREAN_DIR_NAME = '한글 경로 테스트';

/**
 * The guard shape that fails: percent-encoded URL suffix-matched against a raw
 * filesystem path. Kept verbatim so the probe proves the bug still reproduces —
 * a detector that cannot demonstrate a failure proves nothing when it is green.
 */
const BROKEN_SHAPE =
  "const fired = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\\\/g, '/'));";

/** The canonical shape, exercising the REAL helper rather than a copy of it. */
const CANONICAL_SHAPE = [
  `import { isMainEntry } from ${JSON.stringify(pathToFileURL(MAIN_ENTRY).href)};`,
  'const fired = isMainEntry(import.meta.url);',
].join('\n');

const EMIT = "\nprocess.stdout.write(fired ? 'FIRED' : 'SILENT');\n";

let sandbox;

/**
 * Write a probe into `dir` and run it as a real child process, returning the
 * guard verdict. Any spawn failure throws rather than returning a falsy value —
 * a probe that silently reports SILENT on a crash would turn this whole file
 * into a rubber stamp.
 *
 * @param {string} dir directory to host the probe
 * @param {string} body guard source, must assign `fired`
 * @returns {'FIRED'|'SILENT'}
 */
function probe(dir, body) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'probe.mjs');
  writeFileSync(file, body + EMIT, 'utf8');
  const out = execFileSync(process.execPath, [file], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (out !== 'FIRED' && out !== 'SILENT') {
    throw new Error(`probe emitted unexpected output: ${JSON.stringify(out)}`);
  }
  return out;
}

/**
 * Every `.js`/`.mjs` under `scripts/`, walked recursively.
 *
 * Whether this actually reached the whole tree is asserted by the caller, not
 * promised here — see the coverage assertion in the scan test below.
 *
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function collectScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectScripts(full));
    else if (/\.(js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Flag the one unambiguously broken shape: `import.meta.url.endsWith(...)`
 * applied to something derived from `process.argv[1]`.
 *
 * Deliberately NOT flagged: `import.meta.url === \`file://${process.argv[1]}\``
 * when a decoded fallback sits beside it. That concat is dead on Windows (it
 * measured false even on an ASCII path, because argv[1] uses backslashes and no
 * `file:///` triple slash), but the `?.endsWith('<name>.js')` and
 * `pathToFileURL`-style fallbacks next to it carry those guards correctly.
 *
 * @param {string} source
 * @returns {boolean}
 */
function hasEncodedVsRawCompare(source) {
  return /import\.meta\.url\s*\.endsWith\s*\([^;]*process\.argv\[1\]/.test(source);
}

beforeAll(() => {
  // Canonicalise: on Windows `tmpdir()` frequently reports an 8.3 short name
  // (`C:\Users\HEECHA~1\...`). Node resolves the main module to its realpath for
  // `import.meta.url` but leaves `process.argv[1]` short, so a short-name temp
  // dir makes even a pure-ASCII probe go SILENT — which would let the Korean
  // case "pass" for the wrong reason and prove nothing about encoding.
  // `.native` is not guaranteed on every platform, so fall back the same way
  // scripts/hooks/_main-entry.js:93 does rather than diverging from it.
  const canonicalise = realpathSync.native || realpathSync;
  sandbox = canonicalise(mkdtempSync(path.join(tmpdir(), 'artibot-direct-run-')));
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('direct-run guard behaviour under a non-ASCII path', () => {
  it('reproduces the fail-open: the encoded-vs-raw shape goes silent on a Korean path', () => {
    const asciiDir = path.join(sandbox, 'plain');
    const koreanDir = path.join(sandbox, KOREAN_DIR_NAME);

    // Both halves matter. ASCII FIRED proves the probe is wired up at all;
    // Korean SILENT proves the defect is real and not an artifact of the probe.
    expect(probe(asciiDir, BROKEN_SHAPE)).toBe('FIRED');
    expect(probe(koreanDir, BROKEN_SHAPE)).toBe('SILENT');
  });

  it('isMainEntry fires on a Korean path with a space', () => {
    const koreanDir = path.join(sandbox, `${KOREAN_DIR_NAME} 2`);
    expect(probe(koreanDir, CANONICAL_SHAPE)).toBe('FIRED');
  });

  it('isMainEntry still refuses to fire for a module that is not the entry point', () => {
    // The direction that must never regress: a false positive would run main()
    // on a plain import, which is the hazard the guard exists to prevent.
    const koreanDir = path.join(sandbox, `${KOREAN_DIR_NAME} 3`);
    mkdirSync(koreanDir, { recursive: true });
    const other = path.join(koreanDir, 'other.mjs');
    writeFileSync(
      other,
      `import { isMainEntry } from ${JSON.stringify(pathToFileURL(MAIN_ENTRY).href)};\n` +
        "export const fired = isMainEntry(import.meta.url);\n",
      'utf8',
    );
    const body =
      `import { fired as otherFired } from ${JSON.stringify(pathToFileURL(other).href)};\n` +
      'const fired = otherFired;';
    expect(probe(koreanDir, body)).toBe('SILENT');
  });
});

describe('no encoded-vs-raw direct-run guards remain under scripts/', () => {
  it('detects the broken shape when it is present (detector self-check)', () => {
    expect(hasEncodedVsRawCompare(BROKEN_SHAPE)).toBe(true);
    expect(
      hasEncodedVsRawCompare('const ok = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);'),
    ).toBe(false);
  });

  it('scans every part of scripts/ that holds a direct-run guard', () => {
    const files = collectScripts(SCRIPTS_DIR);
    const buckets = new Set(
      files.map((f) => {
        const rel = path.relative(SCRIPTS_DIR, f);
        const seg = rel.split(path.sep);
        return seg.length === 1 ? '(root)' : seg[0];
      }),
    );

    // Named, not counted. A bare file-count floor cannot express this: measured
    // 2026-08-24 the tree holds 139 files but scripts/hooks/ alone holds 68, so
    // a walk that regressed to hooks-only would still clear any floor below 68
    // while seeing none of the guards in ci/, cron/, evals/ or the root.
    // These five are every location that currently contains a direct-run guard.
    for (const required of ['(root)', 'hooks', 'ci', 'cron', 'evals']) {
      expect(buckets, `scan missed scripts/${required}`).toContain(required);
    }

    // theme/, media/, git-hooks/ and utils/ are deliberately NOT required: 1-3
    // files each and no direct-run guard among them, so pinning them would turn
    // a routine reorganisation into a failure here for no detection gain.

    // Secondary floor, set against the measured 139 with ~19 of headroom. This
    // catches a walk that keeps reaching every directory but stops matching most
    // files. A legitimate bulk deletion under scripts/ would trip it — that is a
    // deliberate prompt to re-measure, not a bug.
    expect(files.length).toBeGreaterThan(120);
  });

  it('finds no offending guard in any script', () => {
    const files = collectScripts(SCRIPTS_DIR);
    const offenders = files
      .filter((f) => hasEncodedVsRawCompare(readFileSync(f, 'utf8')))
      .map((f) => path.relative(PLUGIN_ROOT, f));

    expect(offenders).toEqual([]);
  });
});
