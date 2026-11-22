/**
 * Project-root pin for an autopilot session (M11, 2026-11-21).
 *
 * `options.projectRoot` names the directory the PRD, the report, the lock scope
 * and the REPORT gate's evidence root all use. This module fills it ONCE at
 * start ({@link pinProjectRoot}) and back-fills it on resume/abort for a
 * session stored before the pin existed ({@link backfillProjectRoot}).
 *
 * Moved verbatim out of `engine.js` (2026-11-22, behaviour-preserving): the
 * cluster touches the session only through `state.options` and `state.lockScope`
 * and reports only through `_engine-helpers.js#tick`, so it has no engine-private
 * dependency. The engine still owns WHEN these run (`engine.js#startAutopilot`,
 * `#resumeAutopilot`, `#abortAutopilot`); this module owns WHAT they decide.
 *
 * @module lib/autopilot/project-root-pin
 */

import { realpathSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { getPluginRoot } from '../core/platform.js';
import { resolveProjectRoot } from '../git/project-root.js';
import { tick } from './_engine-helpers.js';

/**
 * Pin `options.projectRoot` to the user's project when the caller left it
 * empty, ONCE at start, so the PRD, the report, the lock scope and the REPORT
 * gate's evidence root all name the same directory — and keep naming it on a
 * resume from another cwd. Resolved from the process cwd (the shell the command
 * driver runs in) by `lib/git/project-root.js#resolveProjectRoot`.
 *
 * M11 (2026-11-21): nothing filled this, and the generators then fell back to
 * `<pluginRoot>/../..` — inside `~/.claude/plugins/` for an installed plugin,
 * where a real run's PRD was measured landing.
 *
 * A caller value is kept verbatim only when it is a NATIVE absolute path
 * (tests point it at a tmpdir). Anything else — `.` or another relative path
 * (names wherever the next process stands), an MSYS `/c/Users/…` on win32
 * (rooted but drive-relative: it resolves to `C:\c\Users\…`) — is replaced
 * by the resolved project and reported with one `project-root-replaced` tick.
 * A final root inside the plugin tree is kept but reported with one
 * `project-root-in-plugin-tree` warn tick: it is the M11 symptom, and only
 * the operator can say whether it is intended.
 * @param {object} state
 * @returns {void}
 */
export function pinProjectRoot(state) {
  const given = state.options?.projectRoot;
  const supplied = given !== undefined && given !== null && !(typeof given === 'string' && given.trim() === '');
  if (!isNativeAbsolute(given)) {
    state.options = { ...state.options, projectRoot: resolveProjectRoot(process.cwd()) };
    if (supplied) {
      tick(state.sessionId, {
        phase: 'INTAKE',
        type: 'project-root-replaced',
        level: 'warn',
        message: `options.projectRoot ${JSON.stringify(given)} is not a native absolute path — using ${state.options.projectRoot}`,
        data: { given: typeof given === 'string' ? given : String(given), projectRoot: state.options.projectRoot },
      });
    }
  }
  reportPluginTreeRoot(state);
}

/**
 * A native absolute path for this platform. On win32 that means a drive
 * (`C:\` / `C:/`) or UNC (`\\host\share`) prefix — `path.isAbsolute` also
 * accepts the rooted, drive-relative `/c/Users` and `\foo`, which resolve
 * against the CURRENT drive. Elsewhere, `path.isAbsolute`.
 * @param {unknown} p
 * @returns {boolean}
 */
function isNativeAbsolute(p) {
  if (typeof p !== 'string' || p.trim() === '') return false;
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return nodePath.isAbsolute(p);
}

/**
 * True when `child` is `parent` or lies beneath it, compared in canonical
 * spelling (short names, symlinks); a path that does not exist compares as
 * resolved.
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isWithinDir(parent, child) {
  const canon = (p) => { try { return realpathSync.native(p); } catch { return nodePath.resolve(p); } };
  const rel = nodePath.relative(canon(parent), canon(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel));
}

/**
 * One warn tick when the pinned project root lies inside the plugin's own tree
 * (`getPluginRoot()`) or the host plugin store (`~/.claude/plugins`). Never
 * throws: an observation must not block a start.
 * @param {object} state
 * @returns {void}
 */
function reportPluginTreeRoot(state) {
  try {
    const root = state.options?.projectRoot;
    if (typeof root !== 'string' || !root) return;
    const trees = [getPluginRoot(), nodePath.join(os.homedir(), '.claude', 'plugins')];
    const hit = trees.find((t) => typeof t === 'string' && t && isWithinDir(t, root));
    if (!hit) return;
    tick(state.sessionId, {
      phase: 'INTAKE',
      type: 'project-root-in-plugin-tree',
      level: 'warn',
      message: `Project root ${root} is inside the plugin tree ${hit} — PRD and report will be written there`,
      data: { projectRoot: root, pluginTree: hit },
    });
  } catch { /* observation only */ }
}

/**
 * Back-fill `options.projectRoot` for a session stored before the pin existed,
 * from the directory it recorded at ITS start (`lockScope.cwd`), so resume and
 * abort write the PRD/report into that session's project rather than into
 * whatever repository the resuming process stands in. In memory only — the
 * next `persist` records it. Leaves `lockScope` untouched (the lock key must
 * not move) and does nothing when there is no usable `lockScope.cwd`
 * (non-git start): there is no record to back-fill from.
 * @param {object} state
 * @returns {void}
 */
export function backfillProjectRoot(state) {
  if (isNativeAbsolute(state.options?.projectRoot)) return;
  const scopeCwd = state.lockScope && typeof state.lockScope === 'object' ? state.lockScope.cwd : undefined;
  if (!isNativeAbsolute(scopeCwd)) return;
  state.options = { ...state.options, projectRoot: resolveProjectRoot(scopeCwd) };
}
