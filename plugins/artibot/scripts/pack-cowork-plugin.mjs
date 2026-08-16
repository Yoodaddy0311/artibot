#!/usr/bin/env node
/**
 * Regenerate `artibot-cowork.plugin` (a ZIP) from the `plugins/artibot-cowork/`
 * tree.
 *
 * Why this exists: `plugins/artibot-cowork/README.md` advertises drag-and-drop
 * of this file as **Option 1** — the recommended install path for Cowork. The
 * artifact was committed once (2026-04-20) and never regenerated, so everything
 * added to the tree afterwards silently failed to reach Option 1 installers.
 * There was no packaging step anywhere in the repo and no gate over it.
 *
 * Design notes:
 *  - **Zero-dep.** ZIP is written by hand with `node:zlib` only (deflate-raw +
 *    crc32). No `archiver`/`adm-zip`/`Compress-Archive`/`zip` — the first two
 *    break the zero-runtime-dep constraint and the last two are OS-specific
 *    (dev is Windows, CI is Linux).
 *  - **Deterministic across machines.** Entries are sorted, the DOS timestamp is
 *    a fixed constant, no extra fields are written, and text files are
 *    line-ending normalized ({@link NORMALIZE_EXTENSIONS}) so a Windows working
 *    tree (CRLF) and a Linux CI checkout (LF) of the same commit produce the
 *    same bytes. Without that last part "deterministic" held only within one OS
 *    — the first CI run of the drift gate proved it.
 *  - **Allowlist, not deny-list.** {@link PACK_ALLOWLIST} names what ships. A
 *    deny-list ("everything except .git") would silently ship whatever new
 *    development directory someone adds later.
 *
 * Usage:
 *   node plugins/artibot/scripts/pack-cowork-plugin.mjs [--check] [--list]
 *     (default)  write the archive
 *     --check    compute what would be written and report drift; write nothing
 *     --list     print the entry list that would be packed
 *
 * @module scripts/pack-cowork-plugin
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const COWORK_DIR = path.join(REPO_ROOT, 'plugins', 'artibot-cowork');
const OUT_FILE = path.join(REPO_ROOT, 'artibot-cowork.plugin');

/**
 * What ships inside the plugin archive — the runtime surface Cowork loads.
 *
 * Each entry is either a single file or a directory packed recursively. Kept in
 * sync with what the original 2026-04-20 archive contained, made explicit.
 * Anything not listed here is a development artifact and must stay out:
 * `_reports/` (session outputs), `scripts/` (release tooling), `tests/`,
 * `RELEASE.md` and `CHANGELOG.md` (maintainer docs).
 *
 * @type {ReadonlyArray<{ path: string, kind: 'file' | 'dir' }>}
 */
export const PACK_ALLOWLIST = Object.freeze([
  { path: '.claude-plugin', kind: 'dir' },
  { path: '.mcp.json', kind: 'file' },
  { path: 'README.md', kind: 'file' },
  { path: 'agents', kind: 'dir' },
  { path: 'commands', kind: 'dir' },
  { path: 'skills', kind: 'dir' },
]);

/**
 * Extensions whose bytes are line-ending normalized (CRLF → LF) before packing.
 *
 * Why this exists: on Windows the working tree is checked out with CRLF while
 * git stores LF, so packing on Windows and packing on Linux CI produced
 * *different archives from the same commit* — 4,816 bytes vs 4,704 for a single
 * 112-line agent file. The drift gate caught it on its first CI run
 * (`missing: []` with CRC32 mismatches: same file list, different bytes).
 * Normalizing here makes the archive a function of the commit rather than of
 * the packer's OS, which is what "deterministic" has to mean for a shipped
 * artifact.
 *
 * **Allowlist, deliberately.** Only listed extensions are touched; everything
 * else is packed byte-for-byte. A deny-list would corrupt the first image or
 * font someone adds — normalization rewrites bytes, and in a binary those bytes
 * are not line endings. Adding a text format here is a conscious act.
 *
 * Only `\r\n` → `\n` is rewritten, never a lone `\r`, matching what git itself
 * normalizes on commit.
 *
 * @type {ReadonlySet<string>}
 */
export const NORMALIZE_EXTENSIONS = Object.freeze(
  new Set(['.md', '.json', '.txt', '.yml', '.yaml', '.toml', '.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.sh']),
);

/**
 * Fixed DOS date/time stamp (1980-01-01 00:00:00), the earliest the ZIP format
 * can express. Using a constant instead of mtime is what makes the output
 * reproducible across machines and checkouts.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/**
 * Read one packed file exactly as it will appear inside the archive.
 *
 * The single source of truth for "what bytes ship" — the packer writes these
 * and the drift gate compares against these. If the two ever read the file
 * differently the gate would validate something that is not what shipped.
 *
 * @param {string} rel - POSIX-style path relative to the cowork plugin root.
 * @returns {Buffer} File bytes, line-ending normalized when the extension opts in.
 */
export function readPackedBytes(rel) {
  const raw = readFileSync(path.join(COWORK_DIR, rel));
  if (!NORMALIZE_EXTENSIONS.has(path.extname(rel).toLowerCase())) return raw;
  // CRLF -> LF only; a lone CR is left alone, as git does.
  return Buffer.from(raw.toString('binary').replace(/\r\n/g, '\n'), 'binary');
}

/**
 * Recursively collect file paths under `dir`, relative to {@link COWORK_DIR}.
 *
 * @param {string} absDir - Absolute directory to walk.
 * @returns {string[]} POSIX-style relative paths.
 */
function walk(absDir) {
  const out = [];
  for (const name of readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(path.relative(COWORK_DIR, abs).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Resolve {@link PACK_ALLOWLIST} into the sorted list of files to pack.
 *
 * @returns {string[]} Sorted POSIX-style relative paths.
 */
export function collectEntries() {
  const files = [];
  for (const item of PACK_ALLOWLIST) {
    const abs = path.join(COWORK_DIR, item.path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`allowlist entry missing from tree: ${item.path}`);
    }
    if (item.kind === 'dir') {
      if (!st.isDirectory()) throw new Error(`allowlist says dir, tree says file: ${item.path}`);
      files.push(...walk(abs));
    } else {
      if (st.isDirectory()) throw new Error(`allowlist says file, tree says dir: ${item.path}`);
      files.push(item.path);
    }
  }
  return files.sort();
}

/**
 * Derive the directory entries implied by a file list. ZIP readers tolerate
 * their absence, but the original archive carried them and the installer is
 * not something this repo can exercise — so we keep the same shape.
 *
 * @param {string[]} files - Sorted relative file paths.
 * @returns {string[]} Sorted directory names, each with a trailing slash.
 */
export function deriveDirs(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  return [...dirs].sort();
}

/**
 * Build the ZIP archive bytes for the given tree.
 *
 * @param {string[]} files - Sorted relative file paths.
 * @returns {{ buffer: Buffer, entries: Array<{name: string, crc: number, size: number}> }}
 */
export function buildZip(files) {
  const dirs = deriveDirs(files);
  /** @type {Array<{name: string, data: Buffer, raw: Buffer, crc: number, method: number}>} */
  const records = [];

  for (const name of dirs) {
    records.push({ name, data: Buffer.alloc(0), raw: Buffer.alloc(0), crc: 0, method: 0 });
  }
  for (const name of files) {
    const raw = readPackedBytes(name);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store uncompressed when deflate does not actually help.
    const useDeflate = deflated.length < raw.length;
    records.push({
      name,
      data: useDeflate ? deflated : raw,
      raw,
      crc: crc32(raw),
      method: useDeflate ? 8 : 0,
    });
  }
  // Directories first, then files — both already sorted within their group.
  records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const rec of records) {
    const nameBuf = Buffer.from(rec.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(rec.method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(rec.crc, 14);
    local.writeUInt32LE(rec.data.length, 18);
    local.writeUInt32LE(rec.raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, rec.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(rec.method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(rec.crc, 16);
    cd.writeUInt32LE(rec.data.length, 20);
    cd.writeUInt32LE(rec.raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(rec.name.endsWith('/') ? 0x10 : 0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + rec.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return {
    buffer: Buffer.concat([...chunks, centralBuf, eocd]),
    entries: records.map((r) => ({ name: r.name, crc: r.crc, size: r.raw.length })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const files = collectEntries();

  if (args.includes('--list')) {
    for (const f of files) console.log(f);
    console.log(`FILES=${files.length} DIRS=${deriveDirs(files).length}`);
    return;
  }

  const { buffer, entries } = buildZip(files);

  let prevSize = null;
  try {
    prevSize = readFileSync(OUT_FILE).length;
  } catch {
    /* first run — no previous archive */
  }

  if (args.includes('--check')) {
    const same = prevSize !== null && readFileSync(OUT_FILE).equals(buffer);
    console.log(`files=${files.length} entries=${entries.length} bytes=${buffer.length}`);
    console.log(same ? 'IN SYNC' : 'DRIFT — run without --check to regenerate');
    process.exitCode = same ? 0 : 1;
    return;
  }

  writeFileSync(OUT_FILE, buffer);
  console.log(`wrote ${path.relative(REPO_ROOT, OUT_FILE)}`);
  console.log(`  files=${files.length} entries=${entries.length}`);
  console.log(`  bytes=${buffer.length}${prevSize !== null ? ` (was ${prevSize})` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
