/**
 * bash-compat.js — can THIS launcher's POSIX shell run our scripts?
 *
 * Two shells, two verdicts. {@link probeBash} answers for `bash`;
 * {@link probeSh} answers for `sh`, which is a genuinely different question on
 * Windows (from PowerShell, `bash` resolves and `sh` does not) and so must
 * never be inferred from the bash verdict. The history below is the bash case;
 * the `sh` section carries its own measurements.
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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Same capability question as {@link probeBash}, asked about a SPECIFIC binary
 * instead of whatever `bash` resolves to on PATH.
 *
 * WHY THIS EXISTS: `findBash()` in scripts/update-platform.js picks the shell
 * that runs install.sh, and it used to accept a candidate on `bash --version`
 * alone — the exact probe this module's header documents as succeeding under
 * WSL. Measured 2026-08-11: called from PowerShell it returned bare `'bash'`,
 * which is C:\WINDOWS\system32\bash.exe, and that bash reports GNU/Linux and
 * cannot open the `C:/...` paths the installer hands it.
 *
 * The check is deliberately a CAPABILITY test, not a denylist of known-bad
 * launcher paths: "can this binary execute a script addressed the way we will
 * address it". A path denylist fails open on the next launcher that appears;
 * this cannot, because it asks for the property we actually depend on.
 *
 * Not memoized — callers probe several different candidates in one pass, and
 * the answer is per-binary. Never throws, for the same reason probeBash does
 * not: a probe that blows up must degrade to "unusable", not take the caller
 * down with it.
 *
 * @param {string} bin - Path to (or name of) a bash executable.
 * @returns {{ ok: boolean, reason: string }} `reason` is '' when ok.
 */
export function probeBashCandidate(bin) {
  if (!bin) return { ok: false, reason: 'no candidate given' };

  let dir = null;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-bashprobe-'));
    const script = path.join(dir, 'probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash\necho ${PROBE_MARKER}\n`);

    const run = spawnSync(bin, [toBashPath(script)], {
      encoding: 'utf8', timeout: 5000,
    });
    if (run && run.status === 0 && (run.stdout || '').includes(PROBE_MARKER)) {
      return { ok: true, reason: '' };
    }
    const detail = String((run && run.stderr) || '').trim().split('\n')[0]
      || `exit ${run ? run.status : 'unknown'}`;
    return {
      ok: false,
      reason: `cannot execute a script at a native path (likely WSL bash on Windows): ${detail}`,
    };
  } catch (err) {
    return { ok: false, reason: `probe failed: ${err.message}` };
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  }
}

/* ── `sh` (POSIX shell) ─────────────────────────────────────────────────── */

/**
 * What a caller spawning `sh` actually depends on, expressed as a script.
 *
 * Existence is not the property under test — see the module header, and note
 * that the failure this guards against is WORSE for `sh` than it was for bash.
 * Measured 2026-08-15 from a PowerShell with a registry-only PATH:
 *
 *   Git\usr\bin\sh.exe   starts, exits 0, delivers NO stdin, and resolves
 *                        none of grep/sed/awk/cut/tr.
 *   Git\bin\sh.exe       sets up /usr/bin, delivers stdin, resolves everything.
 *
 * Both "exist". Accepting the first would have produced a suite that runs and
 * fails for invented reasons — a false red dressed as a real one. So the probe
 * asserts the two properties a hook harness cannot work without: stdin reaches
 * the script, and the POSIX text tools the scripts under test call are on PATH.
 */
const SH_PROBE_STDIN = 'artibot_sh_stdin_ok';
const SH_PROBE_TOOLS = ['grep', 'sed', 'awk', 'head', 'cat'];
const SH_PROBE_SCRIPT = [
  '#!/bin/sh',
  `for t in ${SH_PROBE_TOOLS.join(' ')}; do`,
  '  command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t" >&2; exit 3; }',
  'done',
  `[ "$(cat)" = "${SH_PROBE_STDIN}" ] || { echo "stdin not delivered" >&2; exit 4; }`,
  `echo ${PROBE_MARKER}`,
  '',
].join('\n');

/**
 * Can this specific binary run a POSIX script the way our harnesses run one?
 *
 * Same capability-not-denylist reasoning as {@link probeBashCandidate}: a list
 * of known-bad shells fails open on the next one that appears, while asking for
 * the property we depend on cannot. Never throws.
 *
 * @param {string} bin - Path to (or name of) an `sh`.
 * @returns {{ ok: boolean, reason: string }} `reason` is '' when ok.
 */
export function probeShCandidate(bin) {
  if (!bin) return { ok: false, reason: 'no candidate given' };

  let dir = null;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-shprobe-'));
    const script = path.join(dir, 'probe.sh');
    writeFileSync(script, SH_PROBE_SCRIPT);

    const run = spawnSync(bin, [toBashPath(script)], {
      input: `${SH_PROBE_STDIN}\n`,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (run && run.status === 0 && (run.stdout || '').includes(PROBE_MARKER)) {
      return { ok: true, reason: '' };
    }
    // `run.error` is the spawn failure itself (ENOENT/EACCES). Reporting it as
    // `exit ${status}` — status is null here — is how "there is no sh on PATH"
    // gets mistaken for "sh ran and rejected the script".
    const detail = (run && run.error)
      ? (run.error.code || run.error.message)
      : String((run && run.stderr) || '').trim().split('\n')[0]
        || `exit ${run ? run.status : 'unknown'}`;
    return { ok: false, reason: `${bin}: ${detail}` };
  } catch (err) {
    return { ok: false, reason: `${bin}: probe failed: ${err.message}` };
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  }
}

/**
 * Windows-only `sh.exe` candidates, DERIVED from the git already on PATH.
 *
 * No absolute path is hardcoded. `git --exec-path` answers with a directory
 * inside the Git installation (…/Git/mingw64/libexec/git-core, measured
 * 2026-08-15), so walking its ancestors and looking for `bin/sh.exe` and
 * `usr/bin/sh.exe` locates the shell wherever Git was installed. The remaining
 * structural assumption — "sh.exe lives under bin/ or usr/bin/ of an ancestor
 * of the exec-path" — is checked, not trusted: every candidate still has to
 * pass {@link probeShCandidate}, so a wrong guess is rejected rather than used.
 *
 * `bin/` precedes `usr/bin/` at each level because only the former sets up the
 * MSYS environment; see {@link SH_PROBE_SCRIPT} for the measurement.
 *
 * @returns {string[]}
 */
function windowsShCandidates() {
  let execPath;
  try {
    execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 10000 });
  } catch {
    return [];
  }
  if (!execPath || execPath.status !== 0) return [];

  const out = [];
  let dir = path.resolve(String(execPath.stdout || '').trim());
  for (let i = 0; i < 6 && dir; i += 1) {
    out.push(path.join(dir, 'bin', 'sh.exe'), path.join(dir, 'usr', 'bin', 'sh.exe'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out.filter((p) => existsSync(p));
}

/** Memoized {@link probeSh} result — the probe spawns processes, so run once. */
let shCached = null;

/**
 * Find an `sh` that can actually run this repo's POSIX scripts.
 *
 * `sh` is a different question from `bash` and must not reuse that verdict.
 * Measured 2026-08-15 on this machine from a registry-only PATH: `bash`
 * resolves (to C:\WINDOWS\system32\bash.exe, the WSL launcher) while `sh` does
 * not resolve at all. A caller that consulted {@link probeBash} would get the
 * wrong answer in both directions.
 *
 * Order: plain `sh` first, so POSIX and Git Bash take one cheap probe and the
 * derived Windows candidates are never even considered there.
 *
 * @returns {{ ok: boolean, sh: string|null, reason: string }}
 *   `sh` is the validated executable to spawn; '' reason when ok.
 */
export function probeSh() {
  if (shCached) return shCached;

  const tried = [];
  const candidates = ['sh', ...(process.platform === 'win32' ? windowsShCandidates() : [])];
  for (const candidate of candidates) {
    const res = probeShCandidate(candidate);
    if (res.ok) {
      shCached = { ok: true, sh: candidate, reason: '' };
      return shCached;
    }
    tried.push(res.reason);
  }

  shCached = {
    ok: false,
    sh: null,
    reason: `no usable POSIX sh found (${tried.join(' | ')})`,
  };
  return shCached;
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
  shCached = null;
  announced.clear();
}
