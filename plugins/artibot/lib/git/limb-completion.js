/**
 * Limb completion evidence for `/split` — read from git, not from messages.
 *
 * A limb (줄기) is one window's share of a split plan: its own worktree, its
 * own branch, its own file ownership. The question "is this limb done?" has
 * exactly one answer that survives a dead session, a lost `SendMessage`, or a
 * report printed as plain text that never reached the leader: a commit on the
 * limb branch whose trailer block carries `Split-Limb: done`.
 *
 * Why a trailer and not a report contract: the 2026-08-26 live session
 * measured the report contract failing 5 times even after it was introduced
 * (PRD split-cross-session-multi-worktree §배경 통증 ③). The contract is kept
 * as an optimisation; this module is the line of defence. It reads
 * `git log --format=%(trailers:...)` on the limb range and nothing else —
 * no hooks, no runtime state, no session identity.
 *
 * Contract:
 *   - no branch          → not complete (`reason: 'no-branch'`)
 *   - branch, no commits → not complete (`reason: 'no-commits'`) — "커밋 없으면 완료 아님"
 *   - commits, no `Split-Limb: done` in range → not complete (`reason: 'no-trailer'`)
 *   - git failed / too old for `%(trailers:key=…)` → not complete (`reason: 'git-error'`)
 *   - `Split-Limb: done` on a commit inside `<base>..<branch>` → complete
 *
 * Every failure mode collapses to `complete: false`. A limb is never reported
 * done because the reader could not look.
 *
 * Follows `lib/git/git-dir.js` conventions: never throws on a bad cwd, shell-
 * free argv (`execFileSync`), `windowsHide`, short timeout.
 *
 * @module lib/git/limb-completion
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { splitLimbBranch, splitWorktreeName } from './repo-identity.js';

/** Trailer key a limb window writes on its finishing commit. */
export const SPLIT_LIMB_TRAILER = 'Split-Limb';
/** Trailer value that means "this limb is complete" (matched case-insensitively). */
export const SPLIT_LIMB_DONE = 'done';

/** Record / field separators for the log format (never appear in a subject). */
const RS = '\x1e';
const FS = '\x1f';

/**
 * `git log` format: `<sha> FS <trailer values> FS <subject> RS`.
 * `%(trailers:key=Split-Limb,valueonly)` needs git ≥ 2.22 (2019); an older
 * git errors out on the format string and the reader reports `git-error`.
 */
const LOG_FORMAT = `%H${FS}%(trailers:key=${SPLIT_LIMB_TRAILER},valueonly)${FS}%s${RS}`;

/**
 * Slug shape for `limb` (and `repoShort`) — same regex as
 * `tests/firewall/split-name-collision.test.js` / `commands/split.md` "open":
 * 2–31 chars, lowercase, digits, hyphens, no leading hyphen, no `/`
 * (`--worktree` name slash support is unverified — probe P2).
 */
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;

/**
 * Run git with argv (shell-free). Returns `{ ok, out }`; never throws.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: boolean, out: string }}
 */
function git(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, out: String(out) };
  } catch {
    return { ok: false, out: '' };
  }
}

/**
 * Names derived from one limb of a split plan. Pure; throws on a malformed
 * slug so a bad plan fails at planning time, not at `claude --worktree`.
 *
 * The naming itself is NOT defined here — `lib/git/repo-identity.js` is the
 * single source (leader decision 2026-08-26, ADR-002 built-in provider only):
 *   worktreeName = `splitWorktreeName(repoShort, limb)` → `split-<repo>-<limb>`
 *   branch       = `splitLimbBranch(repoShort, limb)`   → `worktree-split-<repo>-<limb>`
 * (the built-in worktree prepends `worktree-`; probe: `claude --worktree probe1`
 * → branch `worktree-probe1`. The PRD's bare `split/<repo>/<limb>` is rejected
 * by `isSplitLimbBranch` — it cannot have come from `/split`.)
 *
 * What this wrapper ADDS is strictness: `sanitizeSegment` in repo-identity
 * silently rewrites (`Auth/x` → `Auth-x`), which is right for identity keys
 * but wrong for a plan — a limb named `Auth/x` is a planning bug, so both
 * segments must already match {@link SLUG} or this throws.
 *
 * - `sessionPrefix` = `{worktreeName}-` — observed Claude Code session-name
 *   form is `{worktree dirname}-{hex2}` (n=4, a heuristic, not a contract).
 * - `teammatePrefix` = `{worktreeName}-` — teammates spawned INSIDE a limb
 *   window are `{worktreeName}-{sid}-{role}`; they share the session prefix,
 *   so session matching must not stop at the prefix
 *   (`split-dispatch.js#matchingSessions`).
 *
 * `repoShort` is mandatory: `ListAgents` is machine-wide and shows no cwd, so
 * two repositories each running a limb called `auth` would otherwise produce
 * indistinguishable session names. Obtain it with
 * `repoShortName(getRepoIdentity(parentRoot))`.
 *
 * Every name starts with `split-`/`worktree-split-`, so none can equal a
 * shipped agent or command name (`tests/firewall/split-limb-naming.test.js`).
 *
 * @param {{ repoShort: string, limb: string }} input
 * @returns {Readonly<{ worktreeName: string, branch: string, sessionPrefix: string, teammatePrefix: string }>}
 */
export function limbNames({ repoShort, limb } = {}) {
  for (const [k, v] of [['repoShort', repoShort], ['limb', limb]]) {
    if (typeof v !== 'string' || !SLUG.test(v)) {
      throw new TypeError(`limbNames: ${k} must match ${SLUG} (got ${JSON.stringify(v)})`);
    }
  }
  const worktreeName = splitWorktreeName(repoShort, limb);
  return Object.freeze({
    worktreeName,
    branch: splitLimbBranch(repoShort, limb),
    sessionPrefix: `${worktreeName}-`,
    teammatePrefix: `${worktreeName}-`,
  });
}

/**
 * Parse raw `git log` output produced with {@link LOG_FORMAT}.
 * Exported so the parser is testable without git.
 *
 * @param {string} raw
 * @returns {ReadonlyArray<{ sha: string, subject: string, trailers: string[] }>}
 */
export function parseLimbLog(raw) {
  if (typeof raw !== 'string' || !raw) return Object.freeze([]);
  const records = [];
  for (const rec of raw.split(RS)) {
    const trimmed = rec.replace(/^\r?\n/, '');
    if (!trimmed.trim()) continue;
    const [sha = '', trailerBlock = '', subject = ''] = trimmed.split(FS);
    const trailers = trailerBlock
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    records.push(Object.freeze({ sha: sha.trim(), subject: subject.trim(), trailers: Object.freeze(trailers) }));
  }
  return Object.freeze(records);
}

/**
 * Does this trailer value list mark the limb done?
 * @param {ReadonlyArray<string>} trailers
 * @returns {boolean}
 */
function isDone(trailers) {
  return trailers.some((v) => v.toLowerCase() === SPLIT_LIMB_DONE);
}

/**
 * Read completion evidence for one limb branch.
 *
 * Range: `<base>..<branch>` when `base` is given and resolves; otherwise the
 * branch itself capped at `maxCount`. Pass `base` whenever you have it — a
 * `Split-Limb: done` that already landed on master (another limb, an earlier
 * run) must not count for this one, and only the range excludes it.
 *
 * @param {object} opts
 * @param {string} opts.cwd - Any directory inside the repository (main checkout or a worktree).
 * @param {string} opts.branch - Limb branch name (e.g. from {@link limbNames}).
 * @param {string} [opts.base] - Integration base (e.g. `master`).
 * @param {number} [opts.maxCount=500] - Cap when no base range is available.
 * @returns {Readonly<{
 *   branch: string, base: string|null, complete: boolean,
 *   reason: 'done'|'no-branch'|'no-commits'|'no-trailer'|'git-error'|'bad-input',
 *   commitCount: number,
 *   doneCommit: null | { sha: string, subject: string },
 * }>}
 */
export function readLimbCompletion({ cwd, branch, base, maxCount = 500 } = {}) {
  const result = (reason, extra = {}) => Object.freeze({
    branch: typeof branch === 'string' ? branch : '',
    base: typeof base === 'string' && base ? base : null,
    complete: reason === 'done',
    reason,
    commitCount: 0,
    doneCommit: null,
    ...extra,
  });

  if (!cwd || typeof cwd !== 'string' || !branch || typeof branch !== 'string') {
    return result('bad-input');
  }
  const cwdAbs = path.resolve(cwd);

  const ref = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwdAbs);
  if (!ref.ok || !ref.out.trim()) return result('no-branch');

  let range;
  if (typeof base === 'string' && base) {
    const baseRef = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwdAbs);
    if (!baseRef.ok || !baseRef.out.trim()) return result('git-error');
    range = [`${base}..refs/heads/${branch}`];
  } else {
    range = [`--max-count=${Math.max(1, Number(maxCount) || 500)}`, `refs/heads/${branch}`];
  }

  const log = git(['log', `--format=${LOG_FORMAT}`, ...range, '--'], cwdAbs);
  if (!log.ok) return result('git-error');

  const commits = parseLimbLog(log.out);
  if (commits.length === 0) return result('no-commits');

  const done = commits.find((c) => isDone(c.trailers));
  if (!done) return result('no-trailer', { commitCount: commits.length });
  return result('done', {
    commitCount: commits.length,
    doneCommit: Object.freeze({ sha: done.sha, subject: done.subject }),
  });
}

/**
 * Read completion for every limb of a plan. Order preserved; one bad limb
 * never hides the others.
 *
 * @param {{ cwd: string, base?: string, limbs: ReadonlyArray<{ limb: string, branch: string }> }} plan
 * @returns {ReadonlyArray<ReturnType<typeof readLimbCompletion> & { limb: string }>}
 */
export function readPlanCompletion({ cwd, base, limbs } = {}) {
  const list = Array.isArray(limbs) ? limbs : [];
  return Object.freeze(list.map((l) => Object.freeze({
    limb: l?.limb ?? '',
    ...readLimbCompletion({ cwd, branch: l?.branch, base }),
  })));
}
