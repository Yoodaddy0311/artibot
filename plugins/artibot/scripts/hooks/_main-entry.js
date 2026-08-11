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
 * @param {string} importMetaUrl `import.meta.url` of the caller
 * @returns {boolean}
 */
export function isMainEntry(importMetaUrl) {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return argv1 === path.resolve(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
