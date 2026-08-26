/**
 * merge-tree pre-flight — pairwise conflict detection before any re-combination.
 *
 * Single owner of the `git merge-tree --write-tree` probe (ADR-005). Two real
 * consumers share it: `/git worktree check` (skills/git-unified/references/
 * worktree.md § check) and `/split integrate`. Before this module the matrix
 * existed only as prose in those two documents — `commands/git.md` § worktree
 * and `worktree.md:102-129` told the model which git command to type, and
 * nothing in `lib/` implemented it (measured 2026-08-26: `merge-tree` had zero
 * hits under `lib/`, `scripts/`, `tests/`).
 *
 * ── What green means, and what it does not ──────────────────────────────────
 * A clean merge-tree result (exit 0, no conflicted paths) proves only that git's
 * three-way TEXT merge produced a tree without conflict markers. It does NOT
 * prove the merged tree builds, passes tests, or is semantically coherent:
 * two limbs that each compile alone can rename a function on one side and add
 * a caller on the other with no textual overlap at all. **merge-tree green ≠
 * safe.** The batch landing in `batch-landing.js` therefore still routes the
 * combined SHA through CI; this module only decides whether it is worth trying.
 *
 * ── Version probe is fail-closed ─────────────────────────────────────────────
 * `--write-tree` exists from git 2.38. On an older git the legacy three-argument
 * `merge-tree <base> <a> <b>` still runs but prints a patch-like text whose
 * "conflict" signal is heuristic, and on an unknown/unparseable version we know
 * nothing at all. Both cases return `supported:false, degrade:'serial'` and NO
 * pair is examined — the caller must fall back to serial landing (one limb at a
 * time, each through its own CI), never to "assume clean".
 *
 * ── Exit-code trap (measured on git 2.54.0.windows.1) ────────────────────────
 * `git merge-tree --write-tree A B` exits **1 both** for a real conflict AND for
 * an unresolvable ref ("merge-tree: nope - not something we can merge"). The
 * two are told apart by the first stdout line: a conflict still prints the
 * merged tree OID first; an error prints nothing on stdout. Anything that is
 * neither exit 0 nor "exit 1 + OID" is classified `error` and blocks.
 *
 * ── Side effects ─────────────────────────────────────────────────────────────
 * `merge-tree --write-tree` writes loose objects into the object database but
 * touches neither the index nor the working tree nor any ref. It is safe to run
 * in a shared checkout while other sessions edit files. Nothing here calls
 * checkout, merge, rebase, or stash.
 *
 * @module lib/git/merge-preflight
 */

import { spawnSync } from 'node:child_process';

/** Oldest git that has `merge-tree --write-tree` (release notes 2.38.0). */
export const MIN_GIT_VERSION = Object.freeze({ major: 2, minor: 38 });

/** Signal the caller must honour when the probe fails: land one limb at a time. */
export const DEGRADE_SERIAL = 'serial';

const OID_RE = /^[0-9a-f]{40,64}$/;

/**
 * @typedef {Object} ExecResult
 * @property {number} status  - Exit code; -1 when the process could not spawn
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Run `git <args>` synchronously. The only process boundary in this module;
 * tests replace it to simulate old git versions without installing one.
 *
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {ExecResult}
 */
export function runGit(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    return { status: -1, stdout: '', stderr: String(r.error.message ?? r.error) };
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Parse `git --version` output. Returns null when it does not look like git.
 *
 * @param {string} text
 * @returns {{major:number, minor:number, patch:number}|null}
 */
export function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

/**
 * @param {{major:number, minor:number}|null} version
 * @returns {boolean}
 */
export function supportsWriteTree(version) {
  if (!version) return false;
  if (version.major !== MIN_GIT_VERSION.major) return version.major > MIN_GIT_VERSION.major;
  return version.minor >= MIN_GIT_VERSION.minor;
}

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} supported
 * @property {{major:number, minor:number, patch:number}|null} version
 * @property {string|null} degrade  - `'serial'` when unsupported, else null
 * @property {string|null} reason
 */

/**
 * Probe whether the local git can run `merge-tree --write-tree`. Fail-closed:
 * every failure mode (git missing, unparseable banner, too old) is
 * `supported:false` with `degrade:'serial'`.
 *
 * @param {{cwd?: string, exec?: typeof runGit}} [opts]
 * @returns {ProbeResult}
 */
export function probeMergeTreeSupport(opts = {}) {
  const exec = opts.exec ?? runGit;
  const r = exec(['--version'], { cwd: opts.cwd });
  if (r.status !== 0) {
    return { supported: false, version: null, degrade: DEGRADE_SERIAL, reason: `git --version exited ${r.status}` };
  }
  const version = parseGitVersion(r.stdout);
  if (!version) {
    return { supported: false, version: null, degrade: DEGRADE_SERIAL, reason: 'git --version output unparseable' };
  }
  if (!supportsWriteTree(version)) {
    return {
      supported: false,
      version,
      degrade: DEGRADE_SERIAL,
      reason: `git ${version.major}.${version.minor}.${version.patch} < ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} (no merge-tree --write-tree)`,
    };
  }
  return { supported: true, version, degrade: null, reason: null };
}

/**
 * @typedef {Object} MergeTreeOutcome
 * @property {'clean'|'conflict'|'error'} kind
 * @property {string|null} tree            - Merged tree OID (clean or conflict), null on error
 * @property {string[]} conflictFiles      - Paths git reported as conflicted
 * @property {string[]} messages           - Informational lines after the blank separator
 */

/**
 * Classify `merge-tree --write-tree --name-only` output.
 *
 * Layout (git ≥ 2.38, measured 2.54): line 1 = tree OID; then one conflicted
 * path per line; then a blank line; then informational messages. Exit 0 with
 * an OID = clean. Exit 1 with an OID = conflict. Anything else = error.
 *
 * @param {string} stdout
 * @param {number} status
 * @returns {MergeTreeOutcome}
 */
export function parseMergeTreeOutput(stdout, status) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const first = (lines[0] ?? '').trim();
  const hasOid = OID_RE.test(first);
  if (status === 0 && hasOid) {
    return { kind: 'clean', tree: first, conflictFiles: [], messages: [] };
  }
  if (status === 1 && hasOid) {
    const conflictFiles = [];
    const messages = [];
    let inMessages = false;
    for (const line of lines.slice(1)) {
      if (!inMessages) {
        if (line.trim() === '') { inMessages = true; continue; }
        conflictFiles.push(line.trim());
      } else if (line.trim() !== '') {
        messages.push(line.trim());
      }
    }
    return { kind: 'conflict', tree: first, conflictFiles, messages };
  }
  return { kind: 'error', tree: null, conflictFiles: [], messages: [] };
}

/**
 * @typedef {Object} PairResult
 * @property {string} ours
 * @property {string} theirs
 * @property {'clean'|'conflict'|'error'} kind
 * @property {string|null} tree
 * @property {string[]} conflictFiles
 * @property {string[]} messages
 * @property {string} stderr
 */

/**
 * Dry-run merge of two refs. Does not verify git support — call
 * {@link probeMergeTreeSupport} first or use {@link preflightBranches}.
 *
 * @param {string} ours
 * @param {string} theirs
 * @param {{cwd?: string, exec?: typeof runGit}} [opts]
 * @returns {PairResult}
 */
export function mergeTreePair(ours, theirs, opts = {}) {
  const exec = opts.exec ?? runGit;
  const r = exec(['merge-tree', '--write-tree', '--name-only', ours, theirs], { cwd: opts.cwd });
  const parsed = parseMergeTreeOutput(r.stdout, r.status);
  return { ours, theirs, ...parsed, stderr: r.stderr ?? '' };
}

/**
 * Order branches so the ones with the fewest predicted conflicts land first
 * (ties broken by name for determinism). Mirrors the "권장 머지 순서" the
 * worktree.md matrix has always promised.
 *
 * @param {string[]} branches
 * @param {PairResult[]} pairs
 * @returns {string[]}
 */
export function recommendMergeOrder(branches, pairs) {
  const score = new Map(branches.map((b) => [b, 0]));
  for (const p of pairs) {
    if (p.kind === 'clean') continue;
    score.set(p.ours, (score.get(p.ours) ?? 0) + 1);
    score.set(p.theirs, (score.get(p.theirs) ?? 0) + 1);
  }
  return [...branches].sort((a, b) => (score.get(a) - score.get(b)) || a.localeCompare(b));
}

/**
 * @typedef {Object} PreflightResult
 * @property {boolean} supported        - git can run --write-tree
 * @property {string|null} degrade      - 'serial' when unsupported
 * @property {ProbeResult} probe
 * @property {PairResult[]} pairs       - Every unordered pair, empty when unsupported
 * @property {PairResult[]} conflicts   - Pairs that are not clean (conflict OR error)
 * @property {boolean} blocked          - true when unsupported or any pair is not clean
 * @property {string[]} mergeOrder      - Recommended order (input order when unsupported)
 */

/**
 * Check every unordered pair of branches. Fail-closed on both axes: an
 * unsupported git blocks without examining anything, and an `error` pair
 * (bad ref, crashed git) blocks exactly like a conflict.
 *
 * @param {string[]} branches
 * @param {{cwd?: string, exec?: typeof runGit}} [opts]
 * @returns {PreflightResult}
 */
export function preflightBranches(branches, opts = {}) {
  const list = [...new Set((branches ?? []).filter((b) => typeof b === 'string' && b.trim()))];
  const probe = probeMergeTreeSupport(opts);
  if (!probe.supported) {
    return {
      supported: false,
      degrade: probe.degrade,
      probe,
      pairs: [],
      conflicts: [],
      blocked: true,
      mergeOrder: list,
    };
  }
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      pairs.push(mergeTreePair(list[i], list[j], opts));
    }
  }
  const conflicts = pairs.filter((p) => p.kind !== 'clean');
  return {
    supported: true,
    degrade: null,
    probe,
    pairs,
    conflicts,
    blocked: conflicts.length > 0,
    mergeOrder: recommendMergeOrder(list, pairs),
  };
}

/**
 * Render the matrix in the shape `worktree.md` § check documents.
 *
 * @param {PreflightResult} result
 * @returns {string}
 */
export function formatConflictMatrix(result) {
  const out = ['CONFLICT PREDICTION MATRIX', '============================'];
  if (!result.supported) {
    out.push(`UNSUPPORTED — ${result.probe?.reason ?? 'unknown'}`);
    out.push(`degrade=${result.degrade}: land limbs one at a time, each through CI.`);
    return out.join('\n');
  }
  const names = result.mergeOrder;
  const cell = (a, b) => {
    if (a === b) return '—';
    const p = result.pairs.find((x) => (x.ours === a && x.theirs === b) || (x.ours === b && x.theirs === a));
    if (!p) return '?';
    if (p.kind === 'clean') return 'SAFE O';
    if (p.kind === 'conflict') return 'CONFLICT !';
    return 'ERROR ?';
  };
  const w = Math.max(12, ...names.map((n) => n.length + 2));
  out.push(''.padEnd(w) + names.map((n) => n.padEnd(w)).join(''));
  for (const a of names) {
    out.push(a.padEnd(w) + names.map((b) => cell(a, b).padEnd(w)).join(''));
  }
  for (const p of result.conflicts) {
    out.push('');
    out.push(`${p.kind === 'conflict' ? '충돌 예상 파일' : '예측 불가'} (${p.ours} <-> ${p.theirs}):`);
    if (p.kind === 'conflict') {
      for (const f of p.conflictFiles) out.push(`  ${f} — 양쪽에서 수정됨`);
    } else {
      out.push(`  ${p.stderr.trim() || 'git merge-tree failed'}`);
    }
  }
  out.push('');
  out.push('권장 머지 순서:');
  names.forEach((n, i) => out.push(`  ${i + 1}) ${n}`));
  out.push('');
  out.push('주의: merge-tree 초록은 텍스트 병합 성공만 뜻한다 — 의미적 충돌은 CI 가 본다.');
  return out.join('\n');
}
