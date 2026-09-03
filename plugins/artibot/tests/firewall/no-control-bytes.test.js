/**
 * Firewall: no literal control bytes in first-party source.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * A raw control byte in a text file is not a cosmetic problem: it makes grep
 * and ripgrep classify the file as BINARY, and a binary file is silently
 * excluded from their output. Every later search of that file then returns a
 * confident, wrong "0 matches" — including searches run by an agent deciding
 * whether some symbol exists anywhere in the repo.
 *
 * Measured 2026-09-02: `lib/economics/usage-receipt.js` carried one literal NUL
 * at line 446 (a Map-key separator written as a raw byte). ripgrep stopped
 * reporting matches for the remaining ~35% of the file, and nothing failed.
 * The fix was one escape — `\0` instead of the byte — with identical runtime
 * semantics. This gate makes that class of mistake loud instead of invisible.
 *
 * THE RULE
 * --------
 * Forbidden as LITERAL bytes: 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F.
 * Allowed: tab (0x09), line feed (0x0A), carriage return (0x0D).
 *
 * Expressed in code as an allowlist of the three permitted bytes rather than a
 * denylist of the forbidden ones — a denylist of "the bad ones we know about"
 * is the shape that fails open. {@link FORBIDDEN_RANGES} pins the allowlist
 * back to the specified ranges mechanically, so the two cannot drift.
 *
 * THE FIX when this gate fails is never to delete the character: write it as an
 * escape (`\0`, `\x1b`, `\u0001`). The bytes the program sees are identical and
 * the file stays searchable.
 *
 * WHAT THIS GATE DOES NOT COVER (do not read a green run as more than this)
 * ------------------------------------------------------------------------
 *  - NON-SOURCE FILES. Only .js/.mjs/.cjs/.md/.json under the seven roots in
 *    {@link ROOTS} are read. A control byte in a .yml, .sh, .txt, .html, a
 *    dotfile, or anywhere outside those roots (docs/, schemas/, hooks/, bin/,
 *    .github/, repository root) is invisible here.
 *  - BINARY FIXTURES. Excluded by extension, not by inspection. A fixture that
 *    is genuinely binary but named .json WOULD be flagged, and the fix in that
 *    case is to rename it, not to weaken this gate.
 *  - DEL (0x7F) and the C1 range (U+0080-U+009F). Outside the specified rule.
 *  - BOM (EF BB BF). Explicitly out of scope — not a control byte, and a
 *    separate concern with a separate correct answer.
 *  - It says nothing about whether an ESCAPED control character is CORRECT.
 *    `\0` as a key separator can still be the wrong design; this only asserts
 *    it is written in a form that grep can read past.
 *  - It cannot see a control byte introduced after the run. The repo is edited
 *    concurrently; this is a snapshot, and a green run ages.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Package root (`plugins/artibot`). Every reported path is relative to this. */
const PACKAGE_ROOT = path.resolve(__dirname, '../..');

/**
 * Directories scanned, relative to {@link PACKAGE_ROOT}. Each one is asserted
 * to contribute at least one file below, so a rename that quietly removes a
 * directory from the gate fails instead of shrinking coverage in silence.
 * @type {readonly string[]}
 */
const ROOTS = Object.freeze([
  'lib',
  'scripts',
  'tests',
  'commands',
  'rules',
  'skills',
  'agents',
]);

/** File extensions read. Anything else is not looked at at all. */
const EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.md', '.json']);

/**
 * The three control bytes that may appear literally. This is the allowlist the
 * scanner actually consults.
 * @type {ReadonlySet<number>}
 */
const ALLOWED_CONTROL_BYTES = Object.freeze(
  new Set([0x09 /* tab */, 0x0a /* LF */, 0x0d /* CR */]),
);

/**
 * The forbidden ranges as specified, inclusive. Used ONLY by the self-check
 * that pins {@link isForbiddenByte} to the spec — never by the scanner itself,
 * so the two are independent statements of the same rule.
 * @type {readonly [number, number][]}
 */
const FORBIDDEN_RANGES = Object.freeze([
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
]);

/**
 * Is this byte a literal control byte that must not appear in source?
 *
 * @param {number} byte - 0-255.
 * @returns {boolean}
 */
function isForbiddenByte(byte) {
  return byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte);
}

/**
 * Every file the gate reads, as absolute paths. Skips `node_modules` (none of
 * the seven roots contains one today; skipping is insurance, not a workaround)
 * and follows no symlinks, since `readdirSync` reports a symlink as neither a
 * file nor a directory here.
 *
 * @param {string} dir - Absolute directory to walk.
 * @returns {string[]}
 */
function listFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const dirent of entries) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name === 'node_modules') continue;
      found.push(...listFiles(full));
    } else if (dirent.isFile() && EXTENSIONS.some((ext) => dirent.name.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Locate every forbidden byte in a buffer.
 *
 * `line` is 1-based and counts LF. `byte` is the 1-based byte offset within
 * that line — a byte offset, not a character column, because the whole point
 * is to name a position in the file as it exists on disk.
 *
 * @param {Buffer} buffer
 * @returns {{line: number, byte: number, code: number}[]}
 */
function scanBuffer(buffer) {
  const hits = [];
  let line = 1;
  let column = 1;
  for (let i = 0; i < buffer.length; i += 1) {
    const code = buffer[i];
    if (isForbiddenByte(code)) hits.push({ line, byte: column, code });
    if (code === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return hits;
}

/**
 * Scan a tree and return one flat violation list.
 *
 * The SAME function backs the repo assertion and the self-check below. A
 * self-check that reimplemented the scan would only prove the copy works.
 *
 * @param {string} root - Absolute directory.
 * @param {string} relativeTo - Absolute base for reported paths.
 * @returns {{files: number, violations: {path: string, line: number, byte: number, code: number}[]}}
 */
function scanTree(root, relativeTo) {
  const files = listFiles(root);
  const violations = [];
  for (const file of files) {
    const hits = scanBuffer(readFileSync(file));
    if (hits.length === 0) continue;
    const rel = path.relative(relativeTo, file).split(path.sep).join('/');
    for (const hit of hits) violations.push({ path: rel, ...hit });
  }
  return { files: files.length, violations };
}

/**
 * Render violations as `file:line:byte` lines, or '' when there are none, so a
 * failing assertion prints the whole list rather than an object diff.
 *
 * @param {{path: string, line: number, byte: number, code: number}[]} violations
 * @returns {string}
 */
function report(violations) {
  if (violations.length === 0) return '';
  const lines = violations.map(
    (v) => `${v.path}:${v.line}:${v.byte}  0x${v.code.toString(16).padStart(2, '0')}`,
  );
  return [
    `${violations.length} literal control byte(s) in first-party source.`,
    'grep/ripgrep treat such a file as binary and silently stop reporting',
    'matches in it. Replace the raw byte with an escape (\\0, \\x1b, \\u0001) —',
    'identical runtime bytes, searchable file. Do not delete the character.',
    '',
    ...lines,
  ].join('\n');
}

// One traversal, shared by every assertion below (~0.9s for ~1,480 files,
// measured 2026-09-02). Running it per test would multiply that by the test
// count for no added signal.
const scanned = ROOTS.map((root) => ({
  root,
  ...scanTree(path.join(PACKAGE_ROOT, root), PACKAGE_ROOT),
}));
const allViolations = scanned.flatMap((entry) => entry.violations);
const totalFiles = scanned.reduce((sum, entry) => sum + entry.files, 0);

describe('literal control bytes', () => {
  it('are absent from first-party source', () => {
    expect(report(allViolations)).toBe('');
  });
});

describe('the gate scans what it claims to scan', () => {
  it('reads at least one file', () => {
    expect(totalFiles).toBeGreaterThan(0);
  });

  it.each(ROOTS)('reads at least one file under %s', (root) => {
    // Per-root, not just in total: a directory renamed out from under this
    // list would otherwise remove itself from the gate with everything still
    // green. Failing here is the correct alarm — update ROOTS deliberately.
    const entry = scanned.find((e) => e.root === root);
    expect(entry.files).toBeGreaterThan(0);
  });

  it('reads a file whose path is known, proving the walk reaches nested dirs', () => {
    const files = listFiles(path.join(PACKAGE_ROOT, 'lib'))
      .map((f) => path.relative(PACKAGE_ROOT, f).split(path.sep).join('/'));
    expect(files).toContain('lib/core/model-catalog.js');
  });

  it('ignores an extension outside the list', () => {
    const files = listFiles(path.join(PACKAGE_ROOT, 'lib'));
    expect(files.every((f) => EXTENSIONS.some((ext) => f.endsWith(ext)))).toBe(true);
  });
});

describe('the rule matches the specification', () => {
  it('flags exactly the specified byte ranges, across all 256 values', () => {
    const inSpec = (byte) =>
      FORBIDDEN_RANGES.some(([lo, hi]) => byte >= lo && byte <= hi);
    const mismatched = [];
    for (let byte = 0; byte <= 0xff; byte += 1) {
      if (isForbiddenByte(byte) !== inSpec(byte)) mismatched.push(byte);
    }
    expect(mismatched).toEqual([]);
  });

  it('permits tab, line feed and carriage return', () => {
    expect([0x09, 0x0a, 0x0d].filter(isForbiddenByte)).toEqual([]);
  });

  it('permits printable ASCII and leaves high bytes alone', () => {
    expect(isForbiddenByte(0x20)).toBe(false);
    expect(isForbiddenByte(0x41)).toBe(false);
    expect(isForbiddenByte(0x7f)).toBe(false); // DEL: out of scope by design
    expect(isForbiddenByte(0xef)).toBe(false); // BOM lead byte: out of scope
  });
});

describe('the scanner actually detects a planted byte (self-check)', () => {
  // Every fixture lives in a throwaway temp tree. No repository file is
  // mutated to prove this gate works — a gate that has to damage the thing it
  // guards in order to test itself is not a gate.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-control-bytes-'));

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Write a fixture file into the temp tree from raw bytes.
   * @param {string} rel
   * @param {number[]} bytes
   * @returns {void}
   */
  function plant(rel, bytes) {
    const full = path.join(tmp, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, Buffer.from(bytes));
  }

  const text = (s) => [...s].map((c) => c.charCodeAt(0));

  it('finds a NUL planted in a copy of a real repository file, at the right position', () => {
    const original = readFileSync(
      path.join(PACKAGE_ROOT, 'lib/economics/usage-receipt.js'),
    );
    // The copy is the same bytes plus one NUL on a fresh final line, so the
    // expected position is computable rather than eyeballed.
    const withNul = Buffer.concat([original, Buffer.from([0x0a, 0x00])]);
    const full = path.join(tmp, 'copy/usage-receipt.js');
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, withNul);

    const clean = scanTree(path.join(tmp, 'copy'), tmp);
    expect(clean.violations).toHaveLength(1);
    expect(clean.violations[0]).toEqual({
      path: 'copy/usage-receipt.js',
      line: original.toString('utf-8').split('\n').length + 1,
      byte: 1,
      code: 0x00,
    });
    // And the unmodified original must NOT trip it, so the red above is caused
    // by the planted byte and not by the file it was planted in.
    expect(scanBuffer(original)).toEqual([]);
  });

  it('finds every forbidden byte class, one fixture per class', () => {
    plant('classes/nul.js', [...text('const a = 1;'), 0x00]);
    plant('classes/bel.md', [...text('# t'), 0x07]);
    plant('classes/vt.json', [...text('{}'), 0x0b]);
    plant('classes/ff.mjs', [...text('export {};'), 0x0c]);
    plant('classes/esc.cjs', [...text('module.exports={};'), 0x1b]);
    plant('classes/us.js', [...text('const b = 2;'), 0x1f]);

    const { files, violations } = scanTree(path.join(tmp, 'classes'), tmp);
    expect(files).toBe(6);
    expect(violations.map((v) => v.code).sort((a, b) => a - b)).toEqual([
      0x00, 0x07, 0x0b, 0x0c, 0x1b, 0x1f,
    ]);
  });

  it('stays green on a file that uses only tab, LF and CRLF', () => {
    plant('clean/tabs.js', text('const a = {\n\tb: 1,\r\n};\n'));
    const { files, violations } = scanTree(path.join(tmp, 'clean'), tmp);
    expect(files).toBe(1);
    expect(violations).toEqual([]);
  });

  it('reports line and byte offsets that count from 1', () => {
    plant('offsets/two.js', [...text('line1\nab'), 0x01, ...text('c\nline3')]);
    const { violations } = scanTree(path.join(tmp, 'offsets'), tmp);
    expect(violations).toEqual([
      { path: 'offsets/two.js', line: 2, byte: 3, code: 0x01 },
    ]);
  });

  it('skips a file whose extension is not scanned, even when it is full of NULs', () => {
    plant('skipped/blob.bin', [0x00, 0x00, 0x00]);
    plant('skipped/notes.txt', [0x00]);
    const { files, violations } = scanTree(path.join(tmp, 'skipped'), tmp);
    expect(files).toBe(0);
    expect(violations).toEqual([]);
    // Stated as a test rather than only in the header: this blind spot is a
    // deliberate choice, and it must break loudly if the extension list ever
    // grows to cover these.
  });

  it('renders a violation as file:line:byte with the byte value', () => {
    const rendered = report([{ path: 'a/b.js', line: 12, byte: 34, code: 0x00 }]);
    expect(rendered).toContain('a/b.js:12:34  0x00');
    expect(report([])).toBe('');
  });
});
