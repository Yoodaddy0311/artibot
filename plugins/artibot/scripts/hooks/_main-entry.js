/**
 * Canonical direct-run guard for hook modules.
 *
 * Every hook is spawned as its own Node process with its payload on stdin, and
 * is ALSO imported directly by tests and by sibling hooks reusing an export.
 * Those two facts conflict: a bare top-level `main()` blocks on stdin forever
 * under import and hangs the suite. So each hook gates `main()` on this helper.
 *
 * This lives in its own leaf module — not in `_dispatcher-utils.js` — because
 * ~50 hooks import it on the spawn hot path and must not pay for that module's
 * `node:child_process` and `lib/core/hook-utils.js` graph just to answer one
 * boolean. `_dispatcher-utils.js` re-exports it, so the dispatcher import sites
 * and their tests keep working unchanged.
 *
 * @module scripts/hooks/_main-entry
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Detect whether the current module was invoked as the main entry point.
 * Cross-platform — handles Windows drive-letter URLs.
 *
 * Decodes with `fileURLToPath`, never `new URL(...).pathname`. A URL pathname is
 * percent-ENCODED while `process.argv[1]` is a raw filesystem path, so the two
 * stop matching the moment the install path holds anything URL-unsafe — and the
 * hook then silently does nothing when spawned. Measured 2026-08-10 by
 * comparing both forms from the same module under each path shape:
 *
 *   plain           current=true   fixed=true
 *   "with space"    current=FALSE  fixed=true   (%20)
 *   "바탕 화면"      current=FALSE  fixed=true   (%EB%B0%94…)
 *   "tilde~name"    current=FALSE  fixed=true   (%7E — hits Windows 8.3 short
 *                                                names such as HEECHA~1)
 *   "hash#tag"      current=FALSE  fixed=true   (# opens a URL fragment, which
 *                                                truncates the pathname)
 *   "paren(1)"      current=true   fixed=true   (parens are not encoded)
 *
 * The default install path (`C:\Users\<name>\…`) is ASCII and space-free, so the
 * bug was latent there — but every hook routes through this helper, so a user
 * whose profile name contains a space or non-ASCII character would lose all of
 * them at once. `scripts\utils\index.js` documents the same trap from the
 * opposite direction (path -> URL).
 *
 * Second spelling gap, same failure mode, found 2026-08-14: Node resolves the
 * MAIN module to its realpath before handing it to `import.meta.url`, while
 * `process.argv[1]` stays exactly as the command spelled it. Reach a hook
 * through a symlink or a Windows junction and the two disagree, so the guard
 * returns false and the hook exits 0 having done nothing — the same silent
 * shape as the encoding bug above, from the opposite cause. Measured with a
 * junction (link -> me) over one probe file:
 *
 *   node <dir>\me\probe.js     fired=true
 *   node <dir>\link\probe.js   fired=FALSE  (argv[1] keeps `link`,
 *                                             import.meta.url says `me`)
 *
 * So the string compare is a fast path and a miss falls through to a realpath
 * compare of both sides. Identity remains the contract: a DIFFERENT file has a
 * different realpath and still returns false. That direction is the one to
 * protect — a false negative loses a hook, but a false positive would fire
 * main() on a plain import, which is what this guard exists to prevent.
 *
 * @param {string} importMetaUrl `import.meta.url` of the caller
 * @returns {boolean}
 */
export function isMainEntry(importMetaUrl) {
  try {
    if (!process.argv[1]) return false;
    const self = path.resolve(fileURLToPath(importMetaUrl));
    const argv1 = path.resolve(process.argv[1]);
    if (argv1 === self) return true; // no fs call on the common path
    return realpath(argv1) === realpath(self);
  } catch {
    return false;
  }
}

/**
 * Canonical spelling of a path, or the path as given when it cannot be resolved
 * (does not exist yet, permission denied). `realpathSync.native` also collapses
 * Windows 8.3 short names; it is not guaranteed on every platform, hence the
 * fallback to the JS implementation.
 *
 * `node:fs` does not reintroduce the graph cost the module header guards
 * against: the loader has already instantiated it in every Node process, unlike
 * `node:child_process` and `lib/core/hook-utils.js`.
 *
 * @param {string} p
 * @returns {string}
 */
function realpath(p) {
  try {
    return (realpathSync.native || realpathSync)(p);
  } catch {
    return p;
  }
}
