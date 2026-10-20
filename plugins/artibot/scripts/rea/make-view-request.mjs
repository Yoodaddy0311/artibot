#!/usr/bin/env node
/**
 * make-view-request.mjs -- wrap saved `rea-agents` CLI evidence as an
 * `inspect-analysis-view` request.
 *
 * WHY
 *   Upstream's recipe for a large JavaScript analysis (references/connection-and-recovery.md
 *   in the vendored skill) saves the CLI JSON to a file and wraps it with jq:
 *     jq -c '{source: {kind: "inline", evidence: .}, view: {kind: "summary"}}' app-evidence.json > app-view.json
 *   jq may be absent and must not be installed just for this. Node is always there (REA
 *   itself needs it), so this is that one filter in plain Node and nothing more.
 *
 * USAGE
 *   node scripts/rea/make-view-request.mjs <evidence.json> <request.json> [--view '<json object>']
 *
 *   <evidence.json>  the file that `rea-agents analyze-javascript-application <path> --json > <evidence.json>` wrote
 *   <request.json>   the request file to write (one line); never the same file as the evidence
 *   --view           ask for another view than {"kind":"summary"}: a JSON object with a string "kind"
 *
 * WHAT IT DOES
 *   Reads one file and writes one file. It starts no process and uses no network. The
 *   evidence text is copied into the request as it is, not parsed and printed again, so
 *   numbers and escapes stay byte-identical to what the CLI printed. The one thing it
 *   checks is that the evidence is a single JSON object, so cut-off or error output fails
 *   here and not inside the next command.
 *
 * WHAT IT DOES NOT SEE
 *   - Whether the object is a REA Evidence record at all, or whether the view is one the
 *     connected REA version accepts: `inspect-analysis-view` judges both.
 *   - A file past V8's string limit (about 512 MB): that fails with the engine's own message.
 *
 * Exit codes: 0 ok, 1 failed, 2 usage.
 *
 * @module scripts/rea/make-view-request
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainEntry } from '../hooks/_main-entry.js';

export const DEFAULT_VIEW = Object.freeze({ kind: 'summary' });

export const USAGE = `usage: node scripts/rea/make-view-request.mjs <evidence.json> <request.json> [--view '<json object>']

  <evidence.json>   the file the rea-agents CLI wrote with --json
  <request.json>    the inspect-analysis-view request to write (not the same file)
  --view '<json>'   a view other than {"kind":"summary"}, as a JSON object with a string "kind"`;

const describe = (value) => (Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`);

/** Evidence text from file bytes or a string: no UTF-8 BOM, and UTF-16 refused rather than guessed at. */
function evidenceText(input) {
  if (typeof input !== 'string' && ((input[0] === 0xff && input[1] === 0xfe) || (input[0] === 0xfe && input[1] === 0xff))) {
    throw new Error('evidence file is UTF-16 (Windows PowerShell 5.1 redirection writes that); redo the redirect from a POSIX shell so the bytes stay UTF-8');
  }
  const text = typeof input === 'string' ? input : input.toString('utf8');
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
}

/**
 * The request file's text for these evidence bytes: `{"source":{"kind":"inline","evidence":<evidence>},"view":<view>}`.
 * @param {Buffer|string} input the evidence file's bytes
 * @param {object} [view] the view to ask for
 * @returns {string} one line plus a newline (the evidence part keeps its own line breaks)
 */
export function buildViewRequest(input, view = DEFAULT_VIEW) {
  const text = evidenceText(input);
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`evidence file is not JSON: ${err.message}`, { cause: err });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`evidence file must be one JSON object (the CLI prints one Evidence record), got ${describe(value)}`);
  }
  return `{"source":{"kind":"inline","evidence":${text}},"view":${JSON.stringify(view)}}\n`;
}

/** @param {string} text the --view value; returns the view object */
export function parseView(text) {
  let view;
  try {
    view = JSON.parse(text);
  } catch (err) {
    throw new Error(`--view is not JSON: ${err.message}`, { cause: err });
  }
  if (view === null || typeof view !== 'object' || Array.isArray(view) || typeof view.kind !== 'string' || view.kind === '') {
    throw new Error('--view must be a JSON object with a string "kind"');
  }
  return view;
}

const sameFile = (a, b) => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * @param {string[]} argv arguments after the script name
 * @returns {{ evidence: string|null, request: string|null, view: string|null, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { evidence: null, request: null, view: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--view') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--view requires a value');
      out.view = value;
      i += 1;
    } else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (out.evidence === null) out.evidence = arg;
    else if (out.request === null) out.request = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (out.help) return out;
  if (out.evidence === null || out.request === null) throw new Error('need an evidence file and a request file');
  if (sameFile(out.evidence, out.request)) throw new Error('the request file is the same file as the evidence file; pick another path');
  return out;
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: {write: Function}, stderr?: {write: Function} }} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`[make-view-request] ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const view = args.view === null ? DEFAULT_VIEW : parseView(args.view);
    const request = buildViewRequest(readFileSync(args.evidence), view);
    // The request embeds the whole evidence; on POSIX keep it owner-only (mode is ignored on Windows).
    writeFileSync(args.request, request, { mode: 0o600 });
    stdout.write(`[make-view-request] wrote ${args.request} (view: ${view.kind})\n`);
    return 0;
  } catch (err) {
    stderr.write(`[make-view-request] failed: ${err.message}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
