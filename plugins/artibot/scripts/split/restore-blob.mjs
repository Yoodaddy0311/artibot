#!/usr/bin/env node
/**
 * `split restore-blob <file...>` — byte-exact restore of tracked files from a
 * ref, for sha-fingerprint procedures (reverse-injection proofs, `/save`
 * handoff-slot reuse).
 *
 * Why not `git checkout -- <f>` (proposal A7, measured 2026-09-01
 * inspector-ste): under `core.autocrlf` checkout re-encodes line endings, so
 * the file's sha256 differs from before the injection even though the
 * content is "the same" (`git hash-object` agrees, the fingerprint does not).
 * The canonical restore is `git cat-file -p <ref>:<path> > <path>` followed
 * by `git update-index --refresh` to clear the stale ` M`.
 *
 * Per file: `git ls-files --full-name --error-unmatch -z` (untracked → refused,
 * never written), `git cat-file -p` with a Buffer (no decoding), write the
 * bytes exactly, then one `git update-index --refresh` at the end (exit code
 * ignored — it is non-zero whenever anything else is modified). Prints sha256
 * before/after per file. Exit 1 when any file was refused or failed.
 *
 * `-z` on `ls-files` is load-bearing (measured 2026-09-04): without it
 * `core.quotepath` C-quotes non-ASCII paths, and the quoted string handed to
 * `cat-file -p <ref>:<path>` names no blob — every Korean path came back
 * `failed`. NUL output is never quoted, so the field is taken verbatim; no
 * trim, because a tracked path may legitimately end in a space.
 *
 * This is the only script under `scripts/split/` that writes tracked files.
 *
 * @module scripts/split/restore-blob
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isMainEntry } from '../hooks/_main-entry.js';

export const HELP = `usage: node scripts/split/restore-blob.mjs <file...> [--ref <ref>] [--json]

  --ref <ref>   tree-ish to restore from (default: HEAD)
  --json        machine output

Byte-exact: writes \`git cat-file -p <ref>:<path>\` and runs \`git update-index --refresh\`.
Untracked files are refused. Nothing else in the tree is touched.`;

/**
 * @param {string[]} argv
 * @returns {{ files: string[], ref: string, json: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { files: [], ref: 'HEAD', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--ref') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error('--ref requires a value');
      out.ref = v;
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else out.files.push(a);
  }
  return out;
}

/**
 * Default git runner: shell-free, `windowsHide`, 15s timeout. Returns a Buffer
 * when `buffer` is set, else a UTF-8 string.
 *
 * @param {string[]} args
 * @param {{ cwd: string, buffer?: boolean }} opts
 * @returns {Buffer|string}
 */
export function gitRun(args, { cwd, buffer = false }) {
  return execFileSync('git', args, {
    cwd, windowsHide: true, timeout: 15000, encoding: buffer ? 'buffer' : 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Restore one file. Never throws for per-file problems — returns a status row.
 *
 * @param {{ cwd: string, file: string, ref?: string, git?: typeof gitRun }} input
 * @returns {{ file: string, repoPath: string|null, status: 'restored'|'refused'|'failed', before: string|null, after: string|null, blob: string|null, changed: boolean|null, reason?: string }}
 */
export function restoreBlob({ cwd, file, ref = 'HEAD', git = gitRun }) {
  const abs = path.resolve(cwd, file);
  let repoPath;
  try {
    repoPath = String(git(['ls-files', '--full-name', '--error-unmatch', '-z', '--', file], { cwd })).split('\0')[0] || null;
  } catch {
    return { file, repoPath: null, status: 'refused', before: null, after: null, blob: null, changed: null, reason: 'untracked (git ls-files --error-unmatch failed) — nothing written' };
  }
  if (!repoPath) {
    return { file, repoPath: null, status: 'refused', before: null, after: null, blob: null, changed: null, reason: 'git ls-files returned no path' };
  }
  let bytes;
  try {
    bytes = git(['cat-file', '-p', `${ref}:${repoPath}`], { cwd, buffer: true });
  } catch (e) {
    return { file, repoPath, status: 'failed', before: null, after: null, blob: null, changed: null, reason: `git cat-file -p ${ref}:${repoPath} failed: ${String(e.message).split('\n')[0]}` };
  }
  const before = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null;
  const blob = sha256(bytes);
  try {
    fs.writeFileSync(abs, bytes);
  } catch (e) {
    return { file, repoPath, status: 'failed', before, after: null, blob, changed: null, reason: `write failed: ${e.message}` };
  }
  const after = sha256(fs.readFileSync(abs));
  return { file, repoPath, status: after === blob ? 'restored' : 'failed', before, after, blob, changed: before !== after, reason: after === blob ? undefined : 'post-write sha256 differs from blob' };
}

/**
 * Restore several files, then refresh the index once.
 *
 * @param {{ cwd: string, files: string[], ref?: string, git?: typeof gitRun }} input
 * @returns {{ ref: string, rows: ReturnType<typeof restoreBlob>[], refreshed: boolean }}
 */
export function restoreAll({ cwd, files, ref = 'HEAD', git = gitRun }) {
  const rows = files.map((file) => restoreBlob({ cwd, file, ref, git }));
  let refreshed = false;
  if (rows.some((r) => r.status === 'restored')) {
    try { git(['update-index', '--refresh'], { cwd }); } catch { /* non-zero whenever other files are modified — expected */ }
    refreshed = true;
  }
  return { ref, rows, refreshed };
}

/**
 * CLI entry. Returns exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, git?: typeof gitRun, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {number}
 */
export function main(argv, opts = {}) {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    out(`${HELP}\n`);
    return 0;
  }
  if (!args.files.length) {
    err(`at least one file is required\n${HELP}\n`);
    return 1;
  }
  const result = restoreAll({ cwd: path.resolve(opts.cwd ?? process.cwd()), files: args.files, ref: args.ref, git: opts.git });
  const bad = result.rows.filter((r) => r.status !== 'restored');
  if (args.json) out(`${JSON.stringify({ ...result, ok: bad.length === 0 }, null, 2)}\n`);
  else {
    for (const r of result.rows) {
      out(`${r.status.padEnd(8)} ${r.file}\n  before: ${r.before ?? '(absent)'}\n  after:  ${r.after ?? '(not written)'}\n  blob:   ${r.blob ?? '(n/a)'}${r.reason ? `\n  reason: ${r.reason}` : ''}\n`);
    }
    out(`${result.refreshed ? 'git update-index --refresh run' : 'index not refreshed (nothing restored)'}\n`);
  }
  return bad.length ? 1 : 0;
}

if (isMainEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
