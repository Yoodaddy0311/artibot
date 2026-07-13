/**
 * update-verify.js - Update pre/post-condition verification for update.js.
 *
 * Extracted into its own module to keep update.js under the 800-line guideline
 * AND to give the "never silently no-op" guarantees a single, unit-testable
 * home. update.js imports FROM this module (one-directional — this module never
 * imports update.js, avoiding a cycle).
 *
 * Root incident this guards: the artibot/master dead-branch rename made
 * `git pull` fail, install.sh then ran from the installed copy and its
 * self-install guard skipped the file-copy phase (a no-op), yet update.js still
 * printed "Update complete". A false success. These helpers turn every silent
 * no-op into a loud, recoverable failure.
 *
 * Termination invariants (asserted before update.js prints "complete"):
 *   INV-1 version landing        — installed >= latest when an update was due
 *   INV-2 source freshness (pre) — block install when no fresh source exists
 *   INV-3 hooks copy completeness — source hooks.json hash == installed
 *   INV-4 marketplace mirror      — mirror hooks.json hash == installed
 *   INV-5 cache no-drift          — every cache version hooks.json == installed
 *   INV-6 no-op direct detection  — .last-install-noop marker absent when due
 *   (INV-7 git health is asserted pre-pull in update-git.js)
 *
 * Zero dependencies. Node 18+ built-ins only. ESM module format.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isNewerVersion } from '../lib/core/version-checker.js';

// ---------------------------------------------------------------------------
// Local hashing (self-contained — no import from update.js to avoid a cycle)
// ---------------------------------------------------------------------------

/**
 * SHA-1 digest of a file's bytes, or null when missing/unreadable. SHA-1 is
 * deliberate — this is integrity (not cryptographic) and keeps the fingerprint
 * format aligned with update.js#fileHash.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
export function hashFile(filePath) {
  try {
    return createHash('sha1').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// INV-1 — version landing (absorbed from update.js#installLanded)
// ---------------------------------------------------------------------------

/**
 * Decide whether a just-run install actually landed the expected version.
 *
 * A forced/drift reinstall legitimately keeps the same version, so only a
 * pending real update (updateAvailable) is held to the bar.
 *
 * @param {string} installedVersion - version on disk AFTER install
 * @param {string} latestVersion    - latest release tag (may carry a 'v' prefix)
 * @param {boolean} updateAvailable - whether a newer release was pending
 * @returns {boolean} true when the install is considered successful
 */
export function installLanded(installedVersion, latestVersion, updateAvailable) {
  if (!updateAvailable) return true; // forced/drift reinstall — no version bump expected
  return !isNewerVersion(installedVersion, latestVersion);
}

// ---------------------------------------------------------------------------
// INV-2 / pre-condition — block a guaranteed no-op BEFORE running the installer
// ---------------------------------------------------------------------------

/**
 * Detect, BEFORE the installer runs, that a real update is physically
 * impossible — so update.js can refuse instead of running a no-op installer and
 * then falsely reporting success.
 *
 * The dangerous combination: a pending update (`updateAvailable`) where the
 * source pull did NOT happen (`pulled === false`) AND the only installer we can
 * run is the installed copy itself (`installTargetDir` resolves under
 * `~/.claude/artibot`, i.e. self-install). install.sh / install.ps1 will skip
 * the copy phase there and exit 0 — guaranteed no-op.
 *
 * @param {object} args
 * @param {boolean} args.updateAvailable
 * @param {boolean} args.pulled            - did a git pull bring fresh source?
 * @param {string|null} args.sourcePluginDir - fresh source plugin dir, if any
 * @param {string} args.installTargetDir   - dir of the installer about to run
 * @param {string} args.home               - resolved home dir
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function assertUpdatePrecondition({ updateAvailable, pulled, sourcePluginDir, installTargetDir, home }) {
  if (!updateAvailable) return { ok: true, reason: null }; // force/drift — no fresh source needed
  if (pulled && sourcePluginDir) return { ok: true, reason: null }; // fresh source pulled — fine

  // No fresh source. Is the installer we are about to run the installed copy?
  const installedRoot = path.join(home, '.claude', 'artibot');
  const target = path.resolve(installTargetDir || '');
  const selfInstall = target === path.resolve(installedRoot) ||
    target.startsWith(path.resolve(installedRoot) + path.sep);

  if (selfInstall) {
    return { ok: false, reason: 'no-fresh-source' };
  }
  // A non-self-install target without a pull is unusual but not provably a
  // no-op (e.g. a tarball checkout) — let the post-install gate catch it.
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// INV-3/4/5/6 — post-install invariants
// ---------------------------------------------------------------------------

/**
 * Resolve the marketplace mirror's hooks.json path, or null when absent.
 *
 * Git-managed marketplace clones are excluded on purpose: install.sh /
 * install.ps1 skip the mirror there (writing into a Claude Code-managed
 * clone dirties it and silently blocks `claude plugin marketplace update`
 * — the 2026-07-13 v4.32.0-stuck incident), so comparing it against the
 * installed copy would be a guaranteed false INV-4 failure.
 *
 * @param {string} home
 * @returns {string|null}
 */
function findMirrorHooks(home) {
  const mpRoot = path.join(home, '.claude', 'plugins', 'marketplaces');
  if (!existsSync(mpRoot)) return null;
  let entries;
  try {
    entries = readdirSync(mpRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (existsSync(path.join(mpRoot, e.name, '.git'))) continue; // git clone — mirror intentionally not written
    const candidate = path.join(mpRoot, e.name, 'plugins', 'artibot', 'hooks', 'hooks.json');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Collect the post-install termination invariants as a flat, renderable array.
 * Each entry is { id, label, ok, detail }. A check whose inputs are absent is
 * reported ok:true (absence of data is not a violation — mirrors update.js's
 * detectHookDrift philosophy) EXCEPT INV-1 and INV-6, which are strict.
 *
 * @param {object} args
 * @param {string} args.home
 * @param {string} args.installedRoot     - ~/.claude/artibot
 * @param {string|null} args.sourcePluginRoot - fresh source plugin dir, if pulled
 * @param {string} args.installedVersion
 * @param {string} args.latestVersion
 * @param {boolean} args.updateAvailable
 * @returns {Array<{id:string,label:string,ok:boolean,detail:string}>}
 */
export function collectPostInstallInvariants({
  home, installedRoot, sourcePluginRoot, installedVersion, latestVersion, updateAvailable,
}) {
  const out = [];
  const installedHooks = path.join(installedRoot, 'hooks', 'hooks.json');
  const installedHash = hashFile(installedHooks);

  // INV-1 — version landing (strict)
  const v1 = installLanded(installedVersion, latestVersion, updateAvailable);
  out.push({
    id: 'INV-1', label: 'version landing', ok: v1,
    detail: v1 ? `installed v${installedVersion}` : `still v${installedVersion}, expected ${latestVersion}`,
  });

  // INV-3 — hooks copy completeness (source vs installed). Skipped if no source.
  if (sourcePluginRoot) {
    const sourceHash = hashFile(path.join(sourcePluginRoot, 'hooks', 'hooks.json'));
    const ok3 = sourceHash === null || installedHash === null || sourceHash === installedHash;
    out.push({
      id: 'INV-3', label: 'hooks copy completeness', ok: ok3,
      detail: ok3 ? 'source == installed' : `source(${(sourceHash || '').slice(0, 8)}) != installed(${(installedHash || '').slice(0, 8)})`,
    });
  }

  // INV-4 — marketplace mirror consistency. Skipped if no mirror.
  const mirrorHooks = findMirrorHooks(home);
  if (mirrorHooks && installedHash !== null) {
    const mirrorHash = hashFile(mirrorHooks);
    const ok4 = mirrorHash === null || mirrorHash === installedHash;
    out.push({
      id: 'INV-4', label: 'marketplace mirror consistency', ok: ok4,
      detail: ok4 ? 'mirror == installed' : `mirror(${(mirrorHash || '').slice(0, 8)}) != installed(${(installedHash || '').slice(0, 8)})`,
    });
  }

  // INV-5 — cache no-drift across every cached version dir.
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot');
  if (existsSync(cacheRoot) && installedHash !== null) {
    const mismatches = [];
    let entries = [];
    try { entries = readdirSync(cacheRoot, { withFileTypes: true }); } catch { /* unreadable */ }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cacheHash = hashFile(path.join(cacheRoot, e.name, 'hooks', 'hooks.json'));
      if (cacheHash !== null && cacheHash !== installedHash) mismatches.push(e.name);
    }
    const ok5 = mismatches.length === 0;
    out.push({
      id: 'INV-5', label: 'cache no-drift', ok: ok5,
      detail: ok5 ? 'all cache versions == installed' : `drift in: ${mismatches.join(', ')}`,
    });
  }

  // INV-6 — no-op direct detection via the install marker (strict).
  const marker = path.join(installedRoot, '.last-install-noop');
  const markerPresent = existsSync(marker);
  const ok6 = !(markerPresent && updateAvailable);
  out.push({
    id: 'INV-6', label: 'no-op direct detection', ok: ok6,
    detail: ok6 ? 'no self-install no-op for a pending update' : 'installer ran as a no-op (self-install) while an update was pending',
  });

  return out;
}

/**
 * Assert all collected invariants hold. Returns { ok, failures } where failures
 * is the subset with ok:false. Never throws — the caller decides how to surface.
 *
 * @param {Array<{id:string,label:string,ok:boolean,detail:string}>} invariants
 * @returns {{ ok: boolean, failures: Array }}
 */
export function assertPostInstall(invariants) {
  const failures = (invariants || []).filter((i) => !i.ok);
  return { ok: failures.length === 0, failures };
}

/**
 * Render the invariants as a GFM table (project report-format policy — never
 * ASCII boxes). Used by update.js for the from->to self-check summary.
 *
 * @param {Array<{id:string,label:string,ok:boolean,detail:string}>} invariants
 * @returns {string}
 */
export function renderInvariantTable(invariants) {
  const rows = (invariants || []).map(
    (i) => `| ${i.id} | ${i.label} | ${i.ok ? 'PASS' : 'FAIL'} | ${i.detail} |`,
  );
  return [
    '| INV | check | result | detail |',
    '|-----|-------|--------|--------|',
    ...rows,
  ].join('\n');
}
