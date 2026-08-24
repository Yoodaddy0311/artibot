#!/usr/bin/env node
/**
 * build-pr-description.mjs — CLI entry point for the PR description builder.
 *
 * Combines `git log base..head`, optional SESSION-NOTES.md timeline, and
 * an optional `git diff --stat` block into a markdown body suitable for
 * `gh pr create --body "$(node scripts/build-pr-description.mjs ...)"`.
 *
 * USAGE
 *   node plugins/artibot/scripts/build-pr-description.mjs \
 *     --base master \
 *     --head HEAD \
 *     [--session-notes .artibot/SESSION-NOTES.md] \
 *     [--stats]
 *
 * Exit codes
 *   0 — markdown emitted to stdout
 *   1 — invalid args / git failure surfaced via builder
 *
 * DATA POLICY
 *   Local-only. Reads git + filesystem; emits to stdout. No network.
 *
 * @module scripts/build-pr-description
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Korean-path-safe import resolution: build the absolute `file://` URL via
// fileURLToPath round-trip on import.meta.url. The builder module is
// imported statically (ESM); no dynamic file:// construction needed.
import { buildPrDescription } from '../lib/release/pr-description-builder.js';
import { isMainEntry } from './hooks/_main-entry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse argv (without the leading "node" / script-path entries).
 *
 * Recognised flags:
 *   --base <ref>           base branch (default: "master")
 *   --head <ref>           head ref (default: "HEAD")
 *   --session-notes <path> path to SESSION-NOTES.md (default: none)
 *   --stats                include `git diff --stat` block (default: false)
 *   --help / -h            print usage and exit 0
 *
 * @param {string[]} argv
 * @returns {{
 *   base: string,
 *   head: string,
 *   sessionNotes: string|null,
 *   stats: boolean,
 *   help: boolean,
 * }}
 */
export function parseArgs(argv) {
  const args = {
    base: 'master',
    head: 'HEAD',
    sessionNotes: null,
    stats: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--base':
        args.base = argv[++i];
        break;
      case '--head':
        args.head = argv[++i];
        break;
      case '--session-notes':
        args.sessionNotes = argv[++i];
        break;
      case '--stats':
        args.stats = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        // Silently ignore unknown flags — keeps the CLI forward-compatible
        // with wrapper scripts that might pass extra context.
        break;
    }
  }
  return args;
}

/**
 * Usage text — emitted on --help or when required args are missing.
 * @returns {string}
 */
export function usage() {
  return [
    'Usage: build-pr-description.mjs [options]',
    '',
    'Options:',
    '  --base <ref>            Base branch (default: master)',
    '  --head <ref>            Head ref (default: HEAD)',
    '  --session-notes <path>  Optional SESSION-NOTES.md path',
    '  --stats                 Include git diff --stat block',
    '  -h, --help              Show this message',
    '',
    'Output: PR description markdown on stdout.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Execute the CLI. Exposed for tests so they can call main() directly with
 * an argv slice and capture stdout via an injected writer.
 *
 * @param {string[]} argv
 * @param {{
 *   stdout?: {write: Function},
 *   stderr?: {write: Function},
 *   build?: Function,
 * }} [io] dependency-injected I/O for tests
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const build = io.build ?? buildPrDescription;

  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    const md = await build({
      baseBranch: args.base,
      headBranch: args.head,
      sessionNotesPath: args.sessionNotes,
      includeStats: args.stats,
    });
    stdout.write(md);
    if (!md.endsWith('\n')) stdout.write('\n');
    return 0;
  } catch (err) {
    stderr.write(`[build-pr-description] failed: ${err.message ?? err}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Entry guard — only invoke main() when run directly, not when imported.
// Korean path AND junction/symlink safe: see scripts/hooks/_main-entry.js.
// ---------------------------------------------------------------------------

const invokedDirectly = isMainEntry(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[build-pr-description] fatal: ${err.stack ?? err}\n`);
      process.exit(1);
    },
  );
}

// Expose __dirname for tests that need to resolve fixtures relative to this
// script (kept as an export so eslint doesn't flag it as unused).
export const SCRIPT_DIR = __dirname;
