/**
 * The `readStateVersion` port `/save` hands to `collectHandoffData`.
 *
 * ── Why a module and not a line of prose ─────────────────────────────────
 * `lib/handoff/handoff-builder.js` has accepted an optional `readStateVersion`
 * port since Safety #2, and renders `derived-from: state@<n>` from it —
 * falling back to `state@unmeasured` when no port is supplied. Nothing
 * supplied one, so every handoff on disk says `state@unmeasured`. Closing
 * that with a sentence in `commands/save.md` alone would leave the failure
 * silent: a port that quietly returns `null` renders exactly like no port at
 * all, and no test could tell the two apart. A module can be tested; prose
 * cannot.
 *
 * ── The value domain (and why `0` is not a version) ──────────────────────
 *   git-common-dir store, version n > 0   -> n
 *   git-common-dir store, version 0       -> null
 *   project-root-fallback store           -> null, whatever it holds
 *   anything throws / is missing / is torn -> null
 *
 * `0` is the empty-snapshot sentinel (`lib/project-state/journal.js#emptySnapshot`),
 * so a never-written store and a store that recorded a zeroth version are the
 * same bytes. `state@0` would assert provenance that does not exist;
 * `state@unmeasured` is the honest rendering.
 *
 * The `project-root-fallback` location is rejected for a different reason:
 * it is per-worktree by construction (`lib/project-state/store-location.js`,
 * decision F3), so two `/split` windows hold divergent counters. A number
 * from there is a local artifact, not the project's state version — and
 * stamping it into a handoff that travels between machines would make
 * `derived-from` mean different things in different trees.
 *
 * ── Read-only, and structurally so ───────────────────────────────────────
 * The store is opened with `renderProjectionFile: false` and an `appendEvent`
 * that REFUSES rather than no-ops, the same posture as
 * `scripts/checkpoint/resume-report.mjs#openStores`. A refusal makes an
 * accidental write path fail closed instead of committing silently; a no-op
 * would swallow it. `createStateStore` creates no directory at construction
 * and `getState` only reads, so the store directory is byte-identical across
 * a call — pinned by the paired test, which hashes the tree.
 *
 * ── Layer ────────────────────────────────────────────────────────────────
 * L3 (`handoff`) importing L2 (`project-state`) — downward, allowed by the
 * layer blocks in `eslint.config.js`. Do not invert it.
 *
 * @module lib/handoff/state-version-port
 */

import { resolveGitCommonDir as defaultResolveGitCommonDir } from '../project-state/git-common-dir.js';
import { createStateStore } from '../project-state/state-manager.js';

/**
 * The session id stamped on the (never-written) store envelopes. Named after
 * the caller so a stray ledger line, if one ever escaped, is traceable here.
 */
const SESSION_ID = 'handoff-state-version';

/**
 * Build a `readStateVersion` port bound to one project root.
 *
 * The returned function is synchronous, takes no arguments, and never throws
 * — `collectHandoffData` awaits it and degrades any failure to `null`, but
 * this port does not rely on that: it fails soft on its own so the same
 * function is safe to call from a script or a test.
 *
 * @param {object} [params] - Port options.
 * @param {string} [params.projectRoot] - Absolute project root. Anything else yields a port that returns null.
 * @param {() => (string|null)} [params.resolveGitCommonDir] - Git port; defaults to the real resolver.
 * @returns {() => number|null} The port: the recorded state version, or null when it cannot be measured.
 * @example
 * const readStateVersion = createStateVersionPort({ projectRoot });
 * const data = await collectHandoffData({ pluginRoot, projectRoot, taskList, firstPrompts, readStateVersion });
 * // data.meta.stateVersion === 30  -> `derived-from: state@30`
 */
export function createStateVersionPort(params) {
  const projectRoot = params?.projectRoot;
  const gitPort = typeof params?.resolveGitCommonDir === 'function'
    ? params.resolveGitCommonDir
    : () => defaultResolveGitCommonDir(projectRoot);

  return () => {
    if (typeof projectRoot !== 'string' || projectRoot === '') return null;
    try {
      const store = createStateStore({
        projectRoot,
        sessionId: SESSION_ID,
        renderProjectionFile: false,
        resolveGitCommonDir: gitPort,
        // Refusal, not a no-op: an accidental write path fails closed here.
        appendEvent: () => ({ ok: false, reason: 'read-only: the handoff state-version port binds no ledger writer' }),
      });
      if (store.location.source !== 'git-common-dir') return null;
      const version = store.getState()?.state_version;
      return Number.isSafeInteger(version) && version > 0 ? version : null;
    } catch {
      return null;
    }
  };
}
