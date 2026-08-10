/**
 * bash-compat.js — does the `bash` on PATH understand THIS platform's paths?
 *
 * WHY THIS EXISTS (measured 2026-08-10, same repo / same commit / same machine):
 *   Whether a bash-dependent check works on Windows depends on which shell
 *   LAUNCHED the process, not on the machine. From PowerShell, `bash` resolves
 *   to C:\WINDOWS\system32\bash.exe — the WSL launcher — because this box's
 *   PowerShell PATH carries `Git\cmd` (git.exe, gitk.exe … but no bash.exe) and
 *   not `Git\bin`. WSL bash starts fine yet cannot see a Windows path:
 *
 *     bash "C:/Users/.../probe.sh"        -> No such file or directory, exit 127
 *     bash -c "ls /mnt/c/Users/..."       -> exit 0
 *
 *   From Git Bash the identical call resolves to MSYS bash, which DOES accept
 *   `C:/Users/...`. Measured delta: 14 tests failed under PowerShell and 0
 *   under Git Bash, with no code difference between the two runs.
 *
 * WHY EXISTENCE PROBES ARE NOT ENOUGH (the bug this replaces):
 *   `bash --version` and `bash -c 'echo ok'` both SUCCEED under WSL. Every
 *   guard built on them therefore reports "bash available", lets the suite run,
 *   and collects exit 127. The only probe that discriminates is executing a
 *   real script FILE through the same path conversion the caller will use —
 *   which is exactly what {@link probeBash} does.
 *
 * SCOPE: this module reports capability, nothing more. Teaching WSL to run
 * these scripts (a /mnt/c translation layer) is deliberately out of scope —
 * skipping with a stated reason is the correct outcome, because the scripts
 * under test are already covered natively on Linux CI and under Git Bash.
 *
 * Placement note: this lives under `scripts/` rather than `tests/` because
 * `scripts/ci/validate-install.js` is production release-gate code and must
 * never import from `tests/`. Test files importing `../../scripts/**` is an
 * established pattern in this repo (tests/ci/lint-skill-size.test.js and
 * four siblings do it), so one definition here serves both sides.
 *
 * Zero dependencies beyond node built-ins. ESM only.
 * @module scripts/utils/bash-compat
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Convert a native path to the forward-slash form MSYS/Git Bash accepts.
 * On POSIX this is the identity. Exported so callers never re-declare it —
 * the previous four copies of this one-liner are what let the probe and the
 * actual invocation drift apart.
 * @param {string} p
 * @returns {string}
 */
export function toBashPath(p) {
  return String(p).replace(/\\/g, '/');
}

/** Token the probe script echoes; presence in stdout is the success signal. */
const PROBE_MARKER = 'artibot_bash_path_ok';

/** Memoized {@link probeBash} result — the probe spawns processes, so run once. */
let cached = null;

/**
 * Can the `bash` on PATH execute a script addressed by a converted native path?
 *
 * Two stages, because the two failures need different messages:
 *   1. Is there a `bash` at all?            (`bash -c` smoke)
 *   2. Can it open a {@link toBashPath} path? (real temp script file)
 *
 * Never throws: a probe that blows up must degrade to "not usable", never take
 * the caller down with it.
 *
 * @returns {{ ok: boolean, bash: string|null, reason: string }}
 *   `ok` true only when stage 2 passed. `reason` is '' when ok, otherwise a
 *   human-readable explanation suitable for a skip message or a CI warning.
 */
export function probeBash() {
  if (cached) return cached;

  // Stage 1 — existence. Deliberately the same weak check the old guards used,
  // kept only to separate "no bash" from "bash that cannot see my paths".
  let smoke;
  try {
    smoke = spawnSync('bash', ['-c', `echo ${PROBE_MARKER}`], { encoding: 'utf8' });
  } catch {
    cached = { ok: false, bash: null, reason: 'bash could not be spawned' };
    return cached;
  }
  if (!smoke || smoke.status !== 0 || !(smoke.stdout || '').includes(PROBE_MARKER)) {
    cached = { ok: false, bash: null, reason: 'bash not found on PATH' };
    return cached;
  }

  // Stage 2 — path compatibility. This is the whole point of the module.
  let dir = null;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-bashprobe-'));
    const script = path.join(dir, 'probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash\necho ${PROBE_MARKER}\n`);

    const run = spawnSync('bash', [toBashPath(script)], { encoding: 'utf8' });
    if (run.status === 0 && (run.stdout || '').includes(PROBE_MARKER)) {
      cached = { ok: true, bash: 'bash', reason: '' };
      return cached;
    }

    const detail = String(run.stderr || '').trim().split('\n')[0] || `exit ${run.status}`;
    cached = {
      ok: false,
      bash: null,
      reason: `bash on PATH cannot resolve native paths (likely WSL bash on Windows): ${detail}`,
    };
    return cached;
  } catch (err) {
    cached = { ok: false, bash: null, reason: `bash path probe failed: ${err.message}` };
    return cached;
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  }
}

/** Labels already announced, so a multi-suite run prints each reason once. */
const announced = new Set();

/**
 * Print why a bash-dependent suite is being skipped.
 *
 * A silent skip is indistinguishable from a passing run in CI output, which is
 * how the 127 failures stayed mislabelled as "environment noise" for months.
 * Lives here rather than in the test files because `no-console` is `off` for
 * `scripts/**` and `warn` for `tests/**` — the lint target is zero warnings.
 *
 * @param {string} label - Suite or check name to attribute the skip to.
 * @param {string} [reason] - Defaults to the live {@link probeBash} reason.
 * @returns {void}
 */
export function announceBashSkip(label, reason = probeBash().reason) {
  const key = `${label}::${reason}`;
  if (announced.has(key)) return;
  announced.add(key);
  console.warn(`[artibot:bash-compat] SKIP ${label} — ${reason}`);
}

/**
 * Reset memoized state. Test-only seam; production callers want the cache.
 * @returns {void}
 */
export function resetBashProbeCache() {
  cached = null;
  announced.clear();
}
