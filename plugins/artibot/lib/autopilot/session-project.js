/**
 * Which project a stored autopilot session belongs to (owner decision D2).
 *
 * The store used to sit inside the plugin root — shared by every project on the
 * machine, but only within one plugin version. It is now ONE store per user,
 * across projects and across versions, so "the most recent session" and "every
 * session" no longer mean "this project's". Two consumers ask that question
 * without naming a session — `engine.getStatus()` with no id and the `list`
 * command (`engine.listSessions()` in `commands/autopilot.md`) — and a third
 * WRITES on the strength of the answer: `scripts/hooks/bash-risk-guard.js`
 * records a danger event into "the active session", which can pause a run. This
 * module is the one place that answers it.
 *
 * WHAT A SESSION RECORDS ABOUT ITS PROJECT. Measured 2026-09-30 on the four real
 * sessions in the owner's plugin cache: all four carry `lockScope`
 * (`{ repoIdentity, cwd }`, pinned at start by `engine.js#resolveLockScope`;
 * `null` outside a git repository), none carries `options.projectRoot`, and none
 * has a top-level `cwd`. `prdPath` is deliberately NOT used as a key: all four
 * point into the plugin's own tree (`.../marketplaces/artibot/docs/PRD/...`)
 * because `generatePRD` defaults its root to `<pluginRoot>/../..` when the
 * caller omits `projectRoot`, so it says where the PRD landed, not whose it is.
 *
 * THE THREE ANSWERS:
 *   match     the session's repo identity equals the asker's, OR the asker is
 *             working inside (never above) a directory the session recorded
 *   foreign   the session recorded a project and that project is provably
 *             someone else's
 *   unscoped  it recorded none (sessions from before lock scoping, non-git
 *             directories, an unreadable record)
 *
 * UNSCOPED IS VISIBLE, NOT HIDDEN. A filter that hid everything it could not
 * place would make a legitimate session vanish the moment it lacked a field the
 * filter reads, and "cannot prove it is someone else's" is the honest state. The
 * price is stated rather than hidden: an unscoped session shows up in every
 * project's list. The alternative — show only what is provably ours — would
 * silently drop the pre-scoping sessions the owner already has.
 *
 * NAMING A SESSION IS NOT DISCOVERY. `getStatus(id)`, `resumeAutopilot(id)` and
 * `abortAutopilot(id)` take an explicit id and work on any session from any
 * directory: resuming from outside the repository is a documented capability
 * (`engine.js#resolveLockScope`), and a typed id is an explicit act. Only the
 * paths that PICK a session for the caller are scoped here.
 *
 * @module lib/autopilot/session-project
 */

import path from 'node:path';
import { normalizeDirPath } from '../core/platform.js';
import { getRepoIdentity as defaultGetRepoIdentity } from '../git/repo-identity.js';
import { listSessions as defaultListSessions, loadSession as defaultLoadSession } from './session-store.js';

/** @typedef {'match'|'foreign'|'unscoped'} ProjectMatch */

/**
 * @typedef {object} ProjectQuery
 * @property {string|undefined} cwd - Where the asker is working.
 * @property {string|null|undefined} repoIdentity - That directory's repo
 *   identity (`lib/git/repo-identity.js`), or null when it has none.
 */

/**
 * The project a session recorded, as far as it recorded one.
 *
 * @param {unknown} state
 * @returns {{ repoIdentity: string|null, dirs: string[] }}
 */
function recordedProject(state) {
  if (!state || typeof state !== 'object') return { repoIdentity: null, dirs: [] };
  const scope = state.lockScope && typeof state.lockScope === 'object' ? state.lockScope : null;
  const repoIdentity = typeof scope?.repoIdentity === 'string' && scope.repoIdentity !== ''
    ? scope.repoIdentity
    : null;
  const dirs = [scope?.cwd, state.options?.projectRoot]
    .filter((dir) => typeof dir === 'string' && dir.trim() !== '');
  return { repoIdentity, dirs };
}

/**
 * True when `child` is `parent` or lies beneath it. `path.relative`, never a
 * string prefix: `/x/app` is not an ancestor of `/x/app2`.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function within(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  const up = rel === '..' || rel.startsWith(`..${path.sep}`);
  return !up && !path.isAbsolute(rel);
}

/**
 * Whether the asker is working INSIDE the project directory a session recorded:
 * the same directory, or one beneath it. ONE-WAY, on purpose. The reverse — an
 * asker standing in an ANCESTOR of the recorded directory — used to match too,
 * which made a prompt opened in the home directory a member of every child
 * project at once, and this answer drives writes (the danger recorder pauses the
 * run it picks). A session recorded from a subdirectory is still reached from
 * the repository root through the repo identity; the price is paid only by a
 * project with no identity (not a git repository), which has to be asked from
 * inside the directory it recorded.
 *
 * Case-insensitive on Windows, where `C:\Repo` and `c:\repo` are one directory.
 *
 * @param {string} projectDir - A directory the session recorded.
 * @param {string|undefined} askerDir - Where the asker is working.
 * @returns {boolean}
 */
function askerInside(projectDir, askerDir) {
  const parent = normalizeDirPath(projectDir);
  const child = normalizeDirPath(askerDir);
  if (!parent || !child) return false;
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return within(fold(parent), fold(child));
}

/**
 * Whether a stored session belongs to the asker's project. Pure: no disk, and no
 * git of its own — the asker's identity arrives on `query`.
 *
 * The directory test runs FIRST and the identity is read only if it fails,
 * because reading it can cost a git spawn (measured 2026-09-30, Windows: 160-370
 * ms per lookup) and the usual case — asking from the project the session was
 * started in — is decided by the directory alone.
 *
 * A recorded repo identity that EQUALS the asker's is a match whatever the
 * directories say (a linked worktree has a different path and the same
 * identity). A DIFFERENT identity does not veto a matching directory: a repo
 * that gained a remote after the session started changes identity
 * (`root-<sha>` to `owner/name`) while staying the same directory.
 *
 * @param {unknown} state - A session state, or anything `loadSession` returned.
 * @param {ProjectQuery} [query]
 * @returns {ProjectMatch}
 */
export function classifySessionProject(state, query = {}) {
  const { repoIdentity, dirs } = recordedProject(state);
  if (!repoIdentity && dirs.length === 0) return 'unscoped';
  if (dirs.some((dir) => askerInside(dir, query.cwd))) return 'match';
  if (repoIdentity && query.repoIdentity && repoIdentity === query.repoIdentity) return 'match';
  return 'foreign';
}

/**
 * The asker's project. `repoIdentity` is a LAZY, memoized getter: nothing is
 * looked up until a scoped session's directory fails to match, so listing an
 * empty store, or a store whose sessions all belong to the directory asking,
 * spawns nothing — and a dangerous command blocked with no autopilot session
 * running costs the hook nothing extra.
 *
 * @param {string|undefined} cwd
 * @param {{ getRepoIdentity?: (cwd: string) => string|null }} deps
 * @returns {ProjectQuery}
 */
function createQuery(cwd, deps) {
  const resolveIdentity = deps.getRepoIdentity ?? defaultGetRepoIdentity;
  let looked = false;
  let identity = null;
  return {
    cwd,
    get repoIdentity() {
      if (!looked) {
        looked = true;
        try {
          identity = cwd ? resolveIdentity(cwd) ?? null : null;
        } catch {
          identity = null; // no identity is a legitimate answer; the directory test already ran
        }
      }
      return identity;
    },
  };
}

/**
 * `load(id)`, or null when it throws — a record that cannot be read is a
 * session with no recorded project, not a reason to fail the whole listing.
 *
 * @param {(id: string) => unknown} load
 * @param {string} id
 * @returns {unknown}
 */
function tryLoad(load, id) {
  try {
    return load(id);
  } catch {
    return null;
  }
}

/**
 * Every stored session with its project answer — foreign ones included, so a
 * caller that prefers to LABEL rather than hide can.
 *
 * Reads each session (the list command used to read none), which is what a
 * project answer costs. A record that cannot be read is `unscoped`: it cannot be
 * proven foreign, and hiding a corrupt file would hide the problem.
 *
 * @param {string} [cwd] - Defaults to the process working directory.
 * @param {{ listSessions?: () => string[], loadSession?: (id: string) => unknown,
 *   getRepoIdentity?: (cwd: string) => string|null }} [deps] - Test seams.
 * @returns {Array<{ id: string, project: ProjectMatch }>} in store order
 */
export function classifyStoredSessions(cwd = process.cwd(), deps = {}) {
  const list = deps.listSessions ?? defaultListSessions;
  const load = deps.loadSession ?? defaultLoadSession;
  let ids;
  try {
    ids = list();
  } catch {
    return [];
  }
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const query = createQuery(cwd, deps);
  return ids.map((id) => ({ id, project: classifySessionProject(tryLoad(load, id), query) }));
}

/**
 * The ids of the sessions that are this project's or carry no project — the
 * list a user standing in this directory should be shown. Store order kept.
 *
 * @param {string} [cwd] - Defaults to the process working directory.
 * @param {Parameters<typeof classifyStoredSessions>[1]} [deps]
 * @returns {string[]}
 */
export function listSessionsForProject(cwd = process.cwd(), deps = {}) {
  return classifyStoredSessions(cwd, deps)
    .filter((entry) => entry.project !== 'foreign')
    .map((entry) => entry.id);
}

/**
 * A predicate over loaded session states: "is this one this project's (or
 * unscoped)?". For a caller that already iterates sessions and acts on one, and
 * must not pick another project's — `bash-risk-guard.js#findActiveSession`.
 *
 * @param {string} [cwd] - Defaults to the process working directory.
 * @param {{ getRepoIdentity?: (cwd: string) => string|null }} [deps]
 * @returns {(state: unknown) => boolean}
 */
export function sessionFilterFor(cwd = process.cwd(), deps = {}) {
  const query = createQuery(cwd, deps);
  return (state) => classifySessionProject(state, query) !== 'foreign';
}
