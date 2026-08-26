/**
 * Repository identity — the *observational* kind.
 *
 * Answers one question: "which repository is this working directory part of?"
 * with a stable string that is the same from the main checkout and from every
 * linked worktree of that repository, and different across unrelated clones.
 * Consumers scope things by it: the autopilot feature lock (`lib/autopilot/
 * lock.js`), the `/split` limb branch name, and (Phase 4) the landing lock.
 *
 * ── Deliberately separate from `lib/autopilot/repo-identity.js` ────────────
 * That module is a SECURITY GATE (`isAutopilotAllowed`): it decides whether
 * this plugin may write git artifacts into a repository at all, and it answers
 * only "is the remote on the allowlist" — a repo with no remote is simply not
 * allowed. This module must answer for repos with no remote too (temp repos,
 * fresh `git init`, air-gapped clones), so it falls back to the root commit
 * SHA. Folding the fallback into the gate would widen what the gate accepts;
 * folding the gate into here would make lock scoping depend on an allowlist.
 * They share the URL normalisation *rule* (asserted equal in
 * `tests/firewall/lock-scope-repo-identity.test.js`) but not code, so this
 * file never imports `lib/autopilot/` — `lib/git/` sits beneath it.
 *
 * ── Identity resolution order ──────────────────────────────────────────────
 *   1. `remote.origin.url` → `owner/name`, lower-cased (GitHub owner/name are
 *      case-insensitive; two clones must not diverge on URL casing).
 *   2. No remote → `root-<first 16 hex of the lexically smallest root commit>`.
 *      Multi-root repos are rare; sorting makes the pick deterministic.
 *   3. No commits (unborn HEAD) or not a repository → `null`. Callers fall
 *      back to their unscoped/legacy behaviour; nothing here invents an id.
 *
 * ── Split limb naming (measured, not assumed) ──────────────────────────────
 * The PRD assumed limb branches `split/<repo-short>/<limb>`. The leader
 * measured on 2026-08-26 21:30 KST that `claude --worktree probe1` names the
 * branch `worktree-probe1` — the built-in worktree provider prepends
 * `worktree-` and we do not control it. Whether a `/` inside the `--worktree`
 * name is accepted is UNVERIFIED, so the canonical form here is the hyphen
 * form `split-<repo-short>-<limb>` (worktree name) → `worktree-split-<repo-
 * short>-<limb>` (branch), and the guard accepts the slash variant as well in
 * case the CLI does. Both start with `worktree-`, which is structurally
 * disjoint from `worktree-manager.js`'s `autopilot/` delete-allowlist — that
 * disjointness is the property `split-branch-prefix-guard.test.js` pins.
 *
 * @module lib/git/repo-identity
 */

import { execFileSync } from 'node:child_process';
import { getGitDir } from './git-dir.js';

const GIT_TIMEOUT_MS = 2000;
const ROOT_SHA_CHARS = 16;

/** Separator between the identity segment and the scoped segment of a key. */
export const SCOPE_SEPARATOR = '__';

/** Prefix the built-in `claude --worktree <name>` provider puts on branches (measured 2026-08-26). */
export const BUILTIN_WORKTREE_BRANCH_PREFIX = 'worktree-';

/** Worktree-name prefix `/split` uses; the branch is BUILTIN prefix + this. */
export const SPLIT_WORKTREE_NAME_PREFIX = 'split-';

/**
 * Branch prefixes recognised as split limbs. Hyphen form is canonical; the
 * slash form is accepted only because `/` in `--worktree` names is unverified.
 */
export const SPLIT_BRANCH_PREFIXES = Object.freeze([
  `${BUILTIN_WORKTREE_BRANCH_PREFIX}${SPLIT_WORKTREE_NAME_PREFIX}`, // worktree-split-
  `${BUILTIN_WORKTREE_BRANCH_PREFIX}split/`, // worktree-split/
]);

/**
 * Run git with an arg array, returning trimmed stdout or '' on any failure.
 * Never throws — identity is resolved from hooks and preflight paths that
 * must not take a session down.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function runGit(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return String(out).trim();
  } catch {
    return '';
  }
}

/**
 * Normalise a git remote URL to `owner/name` (case preserved).
 *
 * Same rule as `lib/autopilot/repo-identity.js#normalizeRepoId` — kept as a
 * separate function on purpose (see module header) and asserted equal by the
 * firewall test so the two cannot drift silently.
 *
 * @param {string} url
 * @returns {string} `owner/name`, or '' when unparseable.
 */
export function normalizeRemoteUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url
    .trim()
    .replace(/\.git\/?$/i, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/(?:[^@/]+@)?[^/]+\//i, '')
    .replace(/^ssh:\/\/(?:[^@/]+@)?[^/]+\//i, '')
    .replace(/\/+$/, '');
}

/**
 * Resolve the repository identity for a working directory.
 *
 * @param {string} cwd - Any directory inside the repository (worktrees included).
 * @returns {{ id: string|null, source: 'remote'|'root-commit'|'none', remote: string, gitDir: string|null }}
 */
export function resolveRepoIdentity(cwd) {
  const none = { id: null, source: 'none', remote: '', gitDir: null };
  if (!cwd || typeof cwd !== 'string') return none;
  const gitDir = getGitDir(cwd);
  if (!gitDir) return none;

  const remote = runGit(['config', '--get', 'remote.origin.url'], cwd);
  const canonical = normalizeRemoteUrl(remote);
  if (canonical) {
    return { id: canonical.toLowerCase(), source: 'remote', remote, gitDir };
  }

  const roots = runGit(['rev-list', '--max-parents=0', 'HEAD'], cwd)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{40}$/i.test(s))
    .sort();
  if (roots.length) {
    return { id: `root-${roots[0].slice(0, ROOT_SHA_CHARS).toLowerCase()}`, source: 'root-commit', remote, gitDir };
  }
  return { ...none, gitDir };
}

/**
 * Convenience: identity string only.
 * @param {string} cwd
 * @returns {string|null}
 */
export function getRepoIdentity(cwd) {
  return resolveRepoIdentity(cwd).id;
}

/**
 * Make a string safe to be one segment of a file name or a branch name:
 * `/`, `\`, `:` and any other symbol become `-`; runs collapse; ends trim.
 * Letters/digits in any script survive (Korean feature keys are a supported
 * input — see `lib/autopilot/memory.js#extractKey`).
 *
 * @param {string} value
 * @returns {string} sanitised segment, '' for empty/non-string input.
 */
export function sanitizeSegment(value) {
  if (!value || typeof value !== 'string') return '';
  const cleaned = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned;
}

/**
 * Compose a single-string scoped key: `${identity}__${segment}` with both
 * halves sanitised. This is the shape the PRD fixes for every identity-scoped
 * key (feature lock now, landing lock in Phase 4) — one string, never a
 * composite payload, so a key is a file name and a file name is a key.
 *
 * @param {string} repoIdentity
 * @param {string} segment - feature key, branch name, …
 * @returns {string}
 */
export function composeScopedKey(repoIdentity, segment) {
  const id = sanitizeSegment(repoIdentity);
  const seg = sanitizeSegment(segment);
  if (!id) throw new TypeError('repoIdentity must sanitise to a non-empty segment');
  if (!seg) throw new TypeError('segment must sanitise to a non-empty segment');
  return `${id}${SCOPE_SEPARATOR}${seg}`;
}

/**
 * Short repository name used inside limb names: the `name` half of
 * `owner/name`, or the whole id for root-commit identities.
 * @param {string} repoIdentity
 * @returns {string}
 */
export function repoShortName(repoIdentity) {
  if (!repoIdentity || typeof repoIdentity !== 'string') return '';
  const last = repoIdentity.split('/').filter(Boolean).pop() || '';
  return sanitizeSegment(last);
}

/**
 * Worktree name to pass to `claude --worktree <name>` for a limb.
 * Hyphen form only — see module header for why `/` is not used.
 * @param {string} repoShort
 * @param {string} limb
 * @returns {string}
 */
export function splitWorktreeName(repoShort, limb) {
  const r = sanitizeSegment(repoShort);
  const l = sanitizeSegment(limb);
  if (!r || !l) throw new TypeError('repoShort and limb must sanitise to non-empty segments');
  return `${SPLIT_WORKTREE_NAME_PREFIX}${r}-${l}`;
}

/**
 * Branch the built-in provider will create for {@link splitWorktreeName}.
 * @param {string} repoShort
 * @param {string} limb
 * @returns {string}
 */
export function splitLimbBranch(repoShort, limb) {
  return `${BUILTIN_WORKTREE_BRANCH_PREFIX}${splitWorktreeName(repoShort, limb)}`;
}

/**
 * Is `branch` a split limb branch? Prefix allowlist, non-empty remainder.
 * Bare `split/...` is NOT accepted: the built-in provider always prepends
 * `worktree-`, so a bare `split/` branch cannot have come from `/split`.
 * @param {string} branch
 * @returns {boolean}
 */
export function isSplitLimbBranch(branch) {
  if (!branch || typeof branch !== 'string') return false;
  return SPLIT_BRANCH_PREFIXES.some((p) => branch.startsWith(p) && branch.length > p.length);
}
