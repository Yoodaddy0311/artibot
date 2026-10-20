#!/usr/bin/env node
/**
 * sync-rea.mjs -- move plugins/artibot/vendor/rea to ONE npm `rea-agents` release.
 *
 * WHY
 *   /rea (commands/rea.md) runs the unmodified npm package `rea-agents` through
 *   npx and follows the upstream skill. That skill text is vendored byte-for-byte
 *   from the SAME tarball, so instructions and engine are one version. This is
 *   the only supported way to move the pair forward; hand edits are not.
 *
 * USAGE
 *   node plugins/artibot/scripts/vendor/sync-rea.mjs <x.y.z>
 *   node plugins/artibot/scripts/vendor/sync-rea.mjs <x.y.z> --tarball <file.tgz> [--expect-integrity <sha512-...>]
 *   node plugins/artibot/scripts/vendor/sync-rea.mjs <x.y.z> --check
 *
 *   <x.y.z>   exact version only. A tag such as `latest` or a range is refused.
 *   --tarball use a tarball you already have instead of `npm pack`.
 *   --expect-integrity
 *             the registry's dist.integrity for that version. Without it the
 *             script asks the registry itself (`npm view`).
 *   --check   change nothing; exit 1 when vendor/rea or commands/rea.md differ
 *             from what that tarball would produce.
 *
 * WHAT IT DOES
 *   1. `npm pack rea-agents@<ver> --ignore-scripts` (download only; no package
 *      code and no install script runs), or reads --tarball.
 *   2. Refuses unless the tarball's sha512 equals the registry's dist.integrity.
 *   3. Reads the tarball IN MEMORY. Only an allowlist of entries is kept:
 *        package/skills/reverse-engineer-anything/**  ->  vendor/rea/skill/**
 *        package/LICENSE                              ->  vendor/rea/LICENSE
 *        package/DISCLAIMER.md                        ->  vendor/rea/DISCLAIMER.md
 *      Nothing else from the archive is ever written, whatever its path says.
 *   4. Refuses a tarball whose package.json is not rea-agents@<ver> under MIT,
 *      whose skill pins a different version, whose vendored text names a floating
 *      rea-agents (@latest, @next, any other tag or range, or a bare `npx rea-agents`),
 *      or two of whose vendored paths differ only by case.
 *   5. Rewrites vendor/rea (stale files removed), writes UPSTREAM.json, and
 *      re-pins every rea-agents@x.y.z in commands/rea.md to <ver>.
 *
 * WHAT IT DOES NOT DO
 *   - It does not judge the new text. A green run means the bytes equal the
 *     tarball, not that the instructions are right or safe: read the diff.
 *   - It does not touch the user's Claude config, run `rea setup`, or install
 *     anything.
 *
 * Exit codes: 0 ok / in sync, 1 failed or (--check) out of sync, 2 usage.
 *
 * @module scripts/vendor/sync-rea
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { isMainEntry } from '../hooks/_main-entry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The plugin root this script belongs to (`plugins/artibot`). */
export const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

export const PACKAGE_NAME = 'rea-agents';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** The 6.7.0 tarball unpacks to about 29 MB; this bounds a decompression bomb, not a real release. */
const MAX_TAR_BYTES = 512 * 1024 * 1024;

function assertExactVersion(version) {
  if (!VERSION_RE.test(String(version))) throw new Error(`"${version}" is not an exact x.y.z version`);
}
const SKILL_SRC = 'skills/reverse-engineer-anything/';
const SKILL_DST = 'skill/';
/** A path segment that cannot be `.`/`..`, hidden, or contain anything exotic. */
const SAFE_REL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const BLOCK = 512;

/**
 * Notes stored in UPSTREAM.json. Constants, so a sync can never change them by
 * accident and the vendor test can pin them.
 */
export const UPSTREAM_NOTES = Object.freeze([
  'Vendored byte-for-byte from the npm tarball named above (MIT, see LICENSE). Never edit by hand: run scripts/vendor/sync-rea.mjs <version>.',
  'Mapping: package/skills/reverse-engineer-anything/** -> skill/**, package/LICENSE -> LICENSE, package/DISCLAIMER.md -> DISCLAIMER.md. THIRD_PARTY_NOTICES.md, which DISCLAIMER.md links to, is not vendored: it covers the engine components and the engine is not vendored.',
  'GATE COVERAGE: nothing under vendor/ is scanned by the Artibot doc and text gates (validate-doc-links, validate-md-rendering, the citation gate, unicode-hygiene, the skill lint): they walk commands/, skills/, docs/, agents/ and the root docs only. This tree is third-party text protected by the sha256 pins in "files" and by the hidden-character scan, both in tests/vendor/rea-vendor.test.js. Green proves the bytes equal what is pinned here, not that the text is correct or safe.',
  'Version pin: "version" above must equal every rea-agents@x.y.z in commands/rea.md and in skill/SKILL.md.',
]);

/** A fresh global regex per call, so no caller can inherit `lastIndex`. */
const specifierRegex = () => /rea-agents@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;

/**
 * Every `rea-agents@x.y.z` version found in `text`, in order (duplicates kept).
 * @param {string} text
 * @returns {string[]}
 */
export function findSpecifiers(text) {
  return [...String(text).matchAll(specifierRegex())].map((m) => m[1]);
}

/**
 * Re-pin every `rea-agents@x.y.z` in `text` to `version`.
 * @param {string} text
 * @param {string} version
 * @returns {{ text: string, changed: number, total: number }} `changed` counts
 *   specifiers that were not already `version`.
 */
export function substitutePins(text, version) {
  let changed = 0;
  let total = 0;
  const out = String(text).replace(specifierRegex(), (_match, found) => {
    total += 1;
    if (found !== version) changed += 1;
    return `${PACKAGE_NAME}@${version}`;
  });
  return { text: out, changed, total };
}

/** The one documentation literal that spells a version slot without being a specifier (UPSTREAM.json "Version pin" note). */
export const DOC_PLACEHOLDER = `${PACKAGE_NAME}@x.y.z`;

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** What may follow `rea-agents@` before the specifier ends: version characters and range operators. */
const SPEC_RUN_RE = /^[0-9A-Za-z._+~^*=<>-]*/;
/**
 * The text before a bare `rea-agents` ends in a package runner or installer followed only by flags.
 * A flag that takes a separate value (`--registry URL`) breaks the chain and hides the package, so
 * this under-reports, and so does a quoted name (`npx -y "rea-agents"`); it never reports prose
 * that merely names the package. The flag token is `-` then `[^\s=]*` so `--yes` has one parse:
 * `-{1,2}` let a run of `--` flags split two ways each and backtrack exponentially.
 */
const RUNNER_BEFORE_RE = /(?:^|[\s`"'(;&|])(?:npx|bunx|pnpx|npm\s+(?:exec|x|install|i|add|view|info|show|pack|update|up)|pnpm\s+(?:dlx|exec|add|install|i|update|up)|yarn\s+(?:dlx|add|global\s+add|up))(?:\s+-[^\s=]*(?:=\S*)?)*[\s=]+$/;
const BEFORE_WINDOW = 512;
const SPEC_WINDOW = 256;

/** True when the name ending at `end` is really a longer word (`rea-agents-extra`, `rea-agents/dist`, `rea-agents.json`). */
const continuesName = (src, end) => /^(?:[\w/-]|\.\w)/.test(src.slice(end, end + 2));

/**
 * Every floating `rea-agents` specifier in `text`, in order (duplicates kept):
 *   - `rea-agents@<anything but an exact x.y.z[-pre]>`: @latest, @next, any other dist-tag, a range
 *     (`^6.7.0`, `6.x`, `*`) or an empty `rea-agents@`;
 *   - a bare `rea-agents` handed to a package runner or installer (`npx -y rea-agents`,
 *     `npm i -g rea-agents`, `pnpm dlx rea-agents`), which resolves to @latest.
 * `rea-agents@x.y.z` (DOC_PLACEHOLDER) is documentation, not a specifier. A bare name anywhere else,
 * such as the JSON "package" value or a sentence about the package, runs nothing and is not reported.
 * @param {string} text
 * @returns {string[]}
 */
export function floatingSpecifiers(text) {
  const src = String(text);
  const found = [];
  let at = src.indexOf(PACKAGE_NAME);
  while (at !== -1) {
    const end = at + PACKAGE_NAME.length;
    if (src[end] === '@') {
      const spec = SPEC_RUN_RE.exec(src.slice(end + 1, end + 1 + SPEC_WINDOW))[0].replace(/\.+$/, '');
      const specifier = `${PACKAGE_NAME}@${spec}`;
      if (!EXACT_VERSION_RE.test(spec) && specifier !== DOC_PLACEHOLDER) found.push(specifier);
    } else if (!continuesName(src, end) && RUNNER_BEFORE_RE.test(src.slice(Math.max(0, at - BEFORE_WINDOW), at))) {
      found.push(PACKAGE_NAME);
    }
    at = src.indexOf(PACKAGE_NAME, end);
  }
  return found;
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
export const sriSha512 = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;

// ---------------------------------------------------------------------------
// tar reader (in memory, read-only)
// ---------------------------------------------------------------------------

function cString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

/** POSIX ustar magic: "ustar" and a NUL at bytes 257-262 (an old-GNU header has "ustar  \0" there, a V7 header nothing). */
const USTAR_MAGIC = Buffer.from('ustar\0', 'latin1');

function checksumOk(header) {
  const stored = parseInt(cString(header, 148, 8).trim() || '0', 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === stored;
}

/** The `path` record of a pax extended header, or null. */
function paxPath(data) {
  let off = 0;
  let found = null;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const len = parseInt(data.subarray(off, space).toString('ascii'), 10);
    if (!Number.isInteger(len) || len <= 0) break;
    const record = data.subarray(space + 1, off + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') found = record.slice(eq + 1);
    off += len;
  }
  return found;
}

/**
 * Regular-file entries of an uncompressed tar. Directories, links and devices
 * are skipped; pax `path` and GNU long names are honoured; a header whose
 * checksum is wrong aborts the read (a mis-parse must never look like success).
 *
 * @param {Buffer} buf
 * @returns {Array<{ path: string, data: Buffer }>}
 */
export function readTar(buf) {
  const entries = [];
  let off = 0;
  let nextPath = null;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break;
    if (!checksumOk(header)) throw new Error(`tar header checksum mismatch at byte ${off}`);
    if (header[124] & 0x80) throw new Error('tar entry size uses base-256 encoding (unsupported)');
    const size = parseInt(cString(header, 124, 12).trim() || '0', 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const data = buf.subarray(off + BLOCK, off + BLOCK + size);
    if (data.length !== size) throw new Error(`tar entry truncated at byte ${off}`);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') nextPath = paxPath(data) ?? nextPath;
    else if (type === 'L') nextPath = cString(data, 0, data.length);
    else if (type !== 'g') {
      // ('g' is a global pax header: it names no single entry, so it is skipped.)
      // Only a POSIX ustar header has a prefix at byte 345; there an old-GNU header keeps atime/ctime bytes.
      const prefix = header.subarray(257, 263).equals(USTAR_MAGIC) ? cString(header, 345, 155) : '';
      const name = cString(header, 0, 100);
      const entryPath = nextPath ?? (prefix ? `${prefix}/${name}` : name);
      nextPath = null;
      if (type === '0' || type === '7') entries.push({ path: entryPath, data });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// plan: tarball -> the exact set of files to vendor
// ---------------------------------------------------------------------------

/**
 * Where an archive path goes in vendor/rea, or null when it is not vendored.
 * @param {string} rel archive path with the leading `package/` removed
 * @returns {string|null}
 */
export function mapVendorPath(rel) {
  if (rel === 'LICENSE' || rel === 'DISCLAIMER.md') return rel;
  if (!rel.startsWith(SKILL_SRC)) return null;
  const rest = rel.slice(SKILL_SRC.length);
  return SAFE_REL_RE.test(rest) ? `${SKILL_DST}${rest}` : null;
}

function repositoryUrl(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return url ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null;
}

function pickPackageJson(tarEntries) {
  const raw = tarEntries.find((e) => e.path === 'package/package.json');
  if (!raw) throw new Error('tarball has no package/package.json');
  return JSON.parse(raw.data.toString('utf8'));
}

/**
 * Two vendored paths that are one path on a case-insensitive disk (Windows, default macOS) would
 * overwrite each other, so what the tree holds would depend on archive order and the disk. Folders
 * count too. Segments are ASCII (SAFE_REL_RE), so lowercasing is exact case folding.
 */
function assertNoCaseCollision(dests) {
  const spelled = new Map();
  for (const dest of dests) {
    const parts = dest.split('/');
    for (let n = 1; n <= parts.length; n += 1) {
      const prefix = parts.slice(0, n).join('/');
      const first = spelled.get(prefix.toLowerCase());
      if (first === undefined) spelled.set(prefix.toLowerCase(), prefix);
      else if (first !== prefix) throw new Error(`tarball has ${first} and ${prefix}, which are one path on a case-insensitive disk`);
    }
  }
}

function collectVendored(tarEntries) {
  const files = new Map();
  for (const entry of tarEntries) {
    if (!entry.path.startsWith('package/')) continue;
    const dest = mapVendorPath(entry.path.slice('package/'.length));
    if (dest === null) continue;
    if (files.has(dest)) throw new Error(`tarball repeats ${dest}`);
    files.set(dest, Buffer.from(entry.data));
  }
  assertNoCaseCollision(files.keys());
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function assertCoherent(version, pkg, files) {
  if (pkg.name !== PACKAGE_NAME) throw new Error(`tarball is ${pkg.name}, not ${PACKAGE_NAME}`);
  if (pkg.version !== version) throw new Error(`tarball is ${PACKAGE_NAME}@${pkg.version}, you asked for ${version}`);
  if (pkg.license !== 'MIT') throw new Error(`license is ${pkg.license}, not MIT: a human must review this before it is vendored`);
  for (const required of ['skill/SKILL.md', 'LICENSE', 'DISCLAIMER.md']) {
    if (!files.has(required)) throw new Error(`tarball lacks ${required}`);
  }
  if (!/^MIT License/m.test(files.get('LICENSE').toString('utf8'))) throw new Error('LICENSE is not the MIT License text');
  const skill = files.get('skill/SKILL.md').toString('utf8');
  const pins = findSpecifiers(skill);
  if (pins.length === 0) throw new Error('skill/SKILL.md pins no rea-agents@x.y.z version');
  const stray = [...new Set(pins.filter((p) => p !== version))];
  if (stray.length > 0) throw new Error(`skill/SKILL.md pins ${stray.join(', ')} but the tarball is ${version}`);
  for (const [dest, buf] of files) {
    const floating = [...new Set(floatingSpecifiers(buf.toString('utf8')))];
    if (floating.length > 0) throw new Error(`${dest} has a floating specifier (${floating.join(', ')}); the pin test forbids it`);
  }
}

/**
 * Everything a sync would write, computed without touching the disk.
 *
 * @param {object} args
 * @param {string} args.version exact x.y.z
 * @param {Buffer} args.tgz the .tgz bytes
 * @param {string} [args.expectedIntegrity] registry dist.integrity; mismatch throws
 * @returns {{ version: string, integrity: string, files: Map<string, Buffer>, upstream: object }}
 */
export function buildPlan({ version, tgz, expectedIntegrity }) {
  assertExactVersion(version);
  const integrity = sriSha512(tgz);
  if (expectedIntegrity !== undefined && expectedIntegrity !== integrity) {
    throw new Error(`integrity mismatch: tarball is ${integrity}, registry says ${expectedIntegrity}`);
  }
  const tarEntries = readTar(gunzipSync(tgz, { maxOutputLength: MAX_TAR_BYTES }));
  const pkg = pickPackageJson(tarEntries);
  const files = collectVendored(tarEntries);
  assertCoherent(version, pkg, files);
  const upstream = {
    package: PACKAGE_NAME,
    version,
    integrity,
    repository: repositoryUrl(pkg),
    license: pkg.license,
    files: Object.fromEntries([...files].map(([dest, buf]) => [dest, sha256Hex(buf)])),
    notes: [...UPSTREAM_NOTES],
  };
  return { version, integrity, files, upstream };
}

/** UPSTREAM.json exactly as written (LF, trailing newline). */
export const renderUpstream = (upstream) => `${JSON.stringify(upstream, null, 2)}\n`;

// ---------------------------------------------------------------------------
// disk: apply / compare
// ---------------------------------------------------------------------------

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current, rel) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), next);
      else out.push(next);
    }
  };
  walk(dir, '');
  return out.sort();
}

function pruneEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Compare the plan with the disk without writing.
 * @returns {{ ok: boolean, missing: string[], changed: string[], extra: string[], pins: string[] }}
 *   `pins` lists versions in the command file that differ from the plan.
 */
export function diffPlan(plan, { vendorDir, commandFile }) {
  const wanted = new Map([...plan.files, ['UPSTREAM.json', Buffer.from(renderUpstream(plan.upstream))]]);
  const onDisk = listFiles(vendorDir);
  const missing = [...wanted.keys()].filter((p) => !onDisk.includes(p));
  const extra = onDisk.filter((p) => !wanted.has(p));
  const changed = [...wanted]
    .filter(([p]) => onDisk.includes(p))
    .filter(([p, buf]) => !readFileSync(path.join(vendorDir, ...p.split('/'))).equals(buf))
    .map(([p]) => p);
  const text = existsSync(commandFile) ? readFileSync(commandFile, 'utf8') : null;
  const pins = text === null ? ['<commands/rea.md missing>'] : [...new Set(findSpecifiers(text).filter((v) => v !== plan.version))];
  if (text !== null && findSpecifiers(text).length === 0) pins.push('<no rea-agents@x.y.z in commands/rea.md>');
  return { ok: !missing.length && !changed.length && !extra.length && !pins.length, missing, changed, extra, pins };
}

/**
 * Write the plan: vendor/rea (stale files removed, never a recursive delete),
 * UPSTREAM.json, and the pins in the command file.
 * @returns {{ written: number, removed: string[], pinsChanged: number, commandFile: 'repinned'|'unchanged'|'missing' }}
 */
export function applyPlan(plan, { vendorDir, commandFile }) {
  const wanted = new Map([...plan.files, ['UPSTREAM.json', Buffer.from(renderUpstream(plan.upstream))]]);
  const removed = listFiles(vendorDir).filter((p) => !wanted.has(p));
  for (const stale of removed) unlinkSync(path.join(vendorDir, ...stale.split('/')));
  for (const [rel, buf] of wanted) {
    const target = path.join(vendorDir, ...rel.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, buf);
  }
  pruneEmptyDirs(vendorDir);

  if (!existsSync(commandFile)) return { written: wanted.size, removed, pinsChanged: 0, commandFile: 'missing' };
  const before = readFileSync(commandFile, 'utf8');
  const { text, changed } = substitutePins(before, plan.version);
  if (text !== before) writeFileSync(commandFile, text);
  return { written: wanted.size, removed, pinsChanged: changed, commandFile: text === before ? 'unchanged' : 'repinned' };
}

// ---------------------------------------------------------------------------
// npm (download only)
// ---------------------------------------------------------------------------

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpm(args, cwd) {
  // Every argument is built from VERSION_RE-validated digits and fixed words, so
  // the shell that Windows needs for `npm.cmd` has nothing to interpret.
  const r = spawnSync(npmBin(), args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed (exit ${r.status}): ${String(r.stderr).trim().slice(0, 400)}`);
  return r.stdout;
}

/** The registry's dist.integrity for rea-agents@version. */
export function registryIntegrity(version, npm = runNpm) {
  assertExactVersion(version);
  const parsed = JSON.parse(npm(['view', `${PACKAGE_NAME}@${version}`, 'dist.integrity', '--json'], process.cwd()));
  if (typeof parsed !== 'string' || !parsed.startsWith('sha512-')) throw new Error(`registry returned no sha512 integrity for ${PACKAGE_NAME}@${version}`);
  return parsed;
}

/** `npm pack --ignore-scripts` into a private temp dir; returns the tarball bytes. */
export function packFromRegistry(version, npm = runNpm) {
  assertExactVersion(version);
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-rea-'));
  let file = null;
  try {
    const out = JSON.parse(npm(['pack', `${PACKAGE_NAME}@${version}`, '--ignore-scripts', '--json', '--pack-destination', '.'], dir));
    const name = out?.[0]?.filename;
    if (typeof name !== 'string' || path.basename(name) !== name) throw new Error('npm pack returned no usable filename');
    file = path.join(dir, name);
    return readFileSync(file);
  } finally {
    if (file !== null && existsSync(file)) unlinkSync(file);
    for (const left of existsSync(dir) ? readdirSync(dir) : []) unlinkSync(path.join(dir, left));
    if (existsSync(dir)) rmdirSync(dir);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `usage: node scripts/vendor/sync-rea.mjs <x.y.z> [--tarball <file.tgz>] [--expect-integrity <sha512-...>] [--check]

  <x.y.z>               exact rea-agents version (never a tag or range)
  --tarball <file>      use this tarball instead of \`npm pack\`
  --expect-integrity    registry dist.integrity (default: ask the registry)
  --check               change nothing; exit 1 if vendor/rea or commands/rea.md differ`;

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ version: string|null, tarball: string|null, expectIntegrity: string|null, check: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { version: null, tarball: null, expectIntegrity: null, check: false, help: false };
  const withValue = { '--tarball': 'tarball', '--expect-integrity': 'expectIntegrity' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--check') out.check = true;
    else if (withValue[arg]) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      out[withValue[arg]] = value;
      i += 1;
    } else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (out.version === null) out.version = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!out.help && !VERSION_RE.test(String(out.version))) {
    throw new Error(`need an exact x.y.z version, got ${out.version === null ? 'nothing' : `"${out.version}"`}`);
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: {write: Function}, stderr?: {write: Function}, pluginRoot?: string, npm?: Function }} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const root = io.pluginRoot ?? PLUGIN_ROOT;
  const npm = io.npm ?? runNpm;
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`[sync-rea] ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const tgz = args.tarball ? readFileSync(args.tarball) : packFromRegistry(args.version, npm);
    const plan = buildPlan({
      version: args.version,
      tgz,
      expectedIntegrity: args.expectIntegrity ?? registryIntegrity(args.version, npm),
    });
    const paths = { vendorDir: path.join(root, 'vendor', 'rea'), commandFile: path.join(root, 'commands', 'rea.md') };
    if (args.check) {
      const d = diffPlan(plan, paths);
      stdout.write(`[sync-rea] ${PACKAGE_NAME}@${plan.version} ${plan.integrity}\n`);
      for (const [label, list] of [['missing', d.missing], ['changed', d.changed], ['extra', d.extra], ['pins', d.pins]]) {
        if (list.length) stdout.write(`  ${label}: ${list.join(', ')}\n`);
      }
      stdout.write(d.ok ? '  in sync\n' : '  OUT OF SYNC\n');
      return d.ok ? 0 : 1;
    }
    const r = applyPlan(plan, paths);
    stdout.write(
      `[sync-rea] ${PACKAGE_NAME}@${plan.version} ${plan.integrity}\n` +
        `  wrote ${r.written} file(s) under vendor/rea, removed ${r.removed.length} stale\n` +
        `  commands/rea.md: ${r.commandFile} (${r.pinsChanged} pin(s) changed)\n` +
        '  review the diff before committing: the sync proves the bytes, not the text\n',
    );
    return 0;
  } catch (err) {
    stderr.write(`[sync-rea] failed: ${err.message}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
