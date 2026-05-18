/**
 * Auto pull-request creation on Phase 6 success (Track H).
 *
 * Hard policy: PRs are only created for the repository the user is
 * currently working in, and only when the authenticated `gh` user has
 * push permission (ADMIN/MAINTAIN/WRITE). Any other repo is rejected
 * outright — this enforces the DATA POLICY ban on cross-repo writes.
 *
 * All shell-out goes through `execFileSync` with an array of args
 * (NEVER `shell: true`) so user input cannot escape into command flags.
 * The `ghRunner` injection point exists for tests; production callers
 * should leave it undefined and pick up the real `gh` binary.
 *
 * Public surface:
 *   - verifyRepoOwnership(opts)
 *   - createAutoPR(opts)
 *
 * @module lib/autopilot/auto-pr
 */

import { execFileSync as defaultExecFile } from 'node:child_process';

const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/**
 * Build a default ghRunner that wraps execFileSync with safe defaults.
 * Throws an Error with .stdout/.stderr attached on non-zero exit so
 * callers can surface gh diagnostics.
 * @param {{execFile?:Function, cwd?:string}} [opts]
 * @returns {(args:string[]) => string}
 */
function defaultGhRunner(opts = {}) {
  const execFile = typeof opts.execFile === 'function' ? opts.execFile : defaultExecFile;
  return (args) => {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new TypeError('gh args must be string[]');
    }
    return execFile('gh', args, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
  };
}

/**
 * Resolve the ghRunner from opts or build a default one.
 * @param {object} opts
 * @returns {(args:string[]) => string}
 */
function pickGhRunner(opts) {
  if (opts && typeof opts.ghRunner === 'function') return opts.ghRunner;
  return defaultGhRunner({ cwd: opts && opts.cwd });
}

/**
 * Parse the JSON output of `gh repo view --json owner,name,viewerPermission`.
 * Returns null on malformed input so callers can decide how to react.
 * @param {string} raw
 * @returns {{owner:string, name:string, perm:string}|null}
 */
function parseRepoView(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const owner = typeof parsed.owner === 'string'
    ? parsed.owner
    : (parsed.owner && typeof parsed.owner === 'object' && typeof parsed.owner.login === 'string'
      ? parsed.owner.login
      : null);
  const name = typeof parsed.name === 'string' ? parsed.name : null;
  const perm = typeof parsed.viewerPermission === 'string' ? parsed.viewerPermission : '';
  if (!owner || !name) return null;
  return { owner, name, perm };
}

/**
 * Inspect the current repo via `gh repo view` and decide whether the
 * caller is allowed to push (i.e. open a PR on the user's behalf).
 *
 * @param {{ghRunner?:Function, cwd?:string}} [opts]
 * @returns {{isOwner:boolean, canPush:boolean, owner:string|null, name:string|null,
 *            permission:string|null, error?:string}}
 */
export function verifyRepoOwnership(opts = {}) {
  const ghRunner = pickGhRunner(opts);
  let raw;
  try {
    raw = ghRunner(['repo', 'view', '--json', 'owner,name,viewerPermission']);
  } catch (err) {
    return {
      isOwner: false,
      canPush: false,
      owner: null,
      name: null,
      permission: null,
      error: `gh repo view failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const info = parseRepoView(raw);
  if (!info) {
    return {
      isOwner: false,
      canPush: false,
      owner: null,
      name: null,
      permission: null,
      error: 'gh repo view returned malformed JSON',
    };
  }
  const canPush = PUSH_PERMISSIONS.has(info.perm);
  const isOwner = info.perm === 'ADMIN';
  return {
    isOwner,
    canPush,
    owner: info.owner,
    name: info.name,
    permission: info.perm || null,
  };
}

/**
 * Coerce a value to a trimmed non-empty string, or return null.
 * @param {unknown} v
 * @returns {string|null}
 */
function nonEmptyStr(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Build the gh pr create arg list from validated inputs.
 * @param {{title:string, body:string, base?:string, head?:string, draft?:boolean}} input
 * @returns {string[]}
 */
function buildPrArgs(input) {
  const args = ['pr', 'create', '--title', input.title, '--body', input.body];
  if (input.base) { args.push('--base', input.base); }
  if (input.head) { args.push('--head', input.head); }
  if (input.draft === true) { args.push('--draft'); }
  return args;
}

/**
 * Parse stdout from `gh pr create` to extract the PR URL.
 * gh prints the URL as the final non-empty line on success.
 * @param {string} raw
 * @returns {string|null}
 */
function parsePrUrl(raw) {
  if (typeof raw !== 'string') return null;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^https:\/\/github\.com\//.test(lines[i])) return lines[i];
  }
  return null;
}

/**
 * Create a PR via `gh pr create`. Hard-gated on verifyRepoOwnership:
 * if `canPush` is false the call is rejected without ever invoking gh.
 *
 * @param {{
 *   title:string,
 *   body:string,
 *   base?:string,
 *   head?:string,
 *   draft?:boolean,
 *   ghRunner?:Function,
 *   cwd?:string,
 *   ownership?:ReturnType<typeof verifyRepoOwnership>,
 * }} opts
 * @returns {{ok:boolean, url:string|null, owner:string|null, name:string|null,
 *            permission:string|null, error?:string}}
 */
export function createAutoPR(opts = {}) {
  const title = nonEmptyStr(opts.title);
  const body = nonEmptyStr(opts.body);
  if (!title || !body) {
    return {
      ok: false, url: null, owner: null, name: null, permission: null,
      error: 'title and body are required non-empty strings',
    };
  }
  const ownership = opts.ownership || verifyRepoOwnership({
    ghRunner: opts.ghRunner, cwd: opts.cwd,
  });
  if (!ownership.canPush) {
    return {
      ok: false,
      url: null,
      owner: ownership.owner,
      name: ownership.name,
      permission: ownership.permission,
      error: ownership.error
        || `push permission required (got ${ownership.permission || 'none'})`,
    };
  }
  const ghRunner = pickGhRunner(opts);
  const args = buildPrArgs({
    title, body, base: opts.base, head: opts.head, draft: opts.draft,
  });
  let raw;
  try {
    raw = ghRunner(args);
  } catch (err) {
    return {
      ok: false,
      url: null,
      owner: ownership.owner,
      name: ownership.name,
      permission: ownership.permission,
      error: `gh pr create failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const url = parsePrUrl(raw);
  return {
    ok: true,
    url,
    owner: ownership.owner,
    name: ownership.name,
    permission: ownership.permission,
  };
}
