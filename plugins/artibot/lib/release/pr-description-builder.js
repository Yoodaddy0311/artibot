/**
 * PR Description Builder — auto-synthesize a Pull Request body from local
 * artifacts: git history between base..head, optional SESSION-NOTES.md
 * timeline entry, and (optionally) a diff stat block.
 *
 * Designed for `/ship --auto-description` and the companion CLI
 * `scripts/build-pr-description.mjs`. Pure logic + DI for git so the
 * function is unit-testable without subprocesses.
 *
 * Sections rendered (in order):
 *   1. Summary           — one bullet per primary commit (squash/release)
 *   2. Changes           — itemised list of feature/fix commits
 *   3. WIP Activity      — fold-out section with autopilot WIP commits
 *   4. Session Timeline  — extracted from SESSION-NOTES.md (if present)
 *   5. Diff Stats        — `git diff --stat` output (if includeStats)
 *   6. Test Plan         — boilerplate checklist
 *   7. Related           — issue numbers parsed from commit bodies
 *
 * Error policy: every git call is wrapped — failures emit a single stderr
 * line and return empty results. The composer always produces a valid
 * markdown body, even with zero commits.
 *
 * @module lib/release/pr-description-builder
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Max commits to render in the Summary/Changes sections. */
const MAX_COMMITS = 50;
/** Cap for raw diff-stat lines (keeps PR body under GitHub's 65 KB limit). */
const MAX_STAT_LINES = 60;

// ---------------------------------------------------------------------------
// Git helpers (default implementations — overridable for tests)
// ---------------------------------------------------------------------------

/**
 * Execute git with argv-array. Returns trimmed stdout; on failure emits a
 * single stderr warning and returns empty string so callers can fall through.
 *
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<string>}
 */
async function runGit(args, opts = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: opts.cwd ?? process.cwd(),
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      timeout: 5000,
    });
    return stdout.trim();
  } catch (err) {
    process.stderr.write(
      `[artibot:pr-description] git ${args.join(' ')} failed: ${err.message?.split('\n')[0] ?? err}\n`,
    );
    return '';
  }
}

/**
 * Resolve commits in `base..head` range with a TAB-delimited format so the
 * parser is robust against commit messages containing pipes / colons.
 *
 * Output: array of `{sha, subject, body}`.
 *
 * @param {string} base
 * @param {string} head
 * @param {Function} [gitRunner] dependency-injected runner for tests
 * @returns {Promise<Array<{sha:string, subject:string, body:string}>>}
 */
export async function getCommitsBetween(base, head, gitRunner = runGit) {
  // Use a 0x1E (record separator) between commits and 0x1F (unit separator)
  // between fields. These bytes never appear in normal commit text.
  const RS = '\x1e';
  const US = '\x1f';
  const raw = await gitRunner([
    'log',
    `${base}..${head}`,
    `--format=${US}%H${US}%s${US}%b${RS}`,
    `-${MAX_COMMITS}`,
  ]);
  if (!raw) return [];
  return raw
    .split(RS)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk.split(US).filter(Boolean);
      if (parts.length < 2) return null;
      const [sha, subject, body = ''] = parts;
      return { sha, subject: subject.trim(), body: body.trim() };
    })
    .filter(Boolean);
}

/**
 * Run `git diff base...head --stat` using the 3-dot syntax so the stat is
 * computed against the merge-base — the same comparison GitHub uses.
 *
 * @param {string} base
 * @param {string} head
 * @param {Function} [gitRunner]
 * @returns {Promise<string>}
 */
export async function getDiffStat(base, head, gitRunner = runGit) {
  const raw = await gitRunner(['diff', `${base}...${head}`, '--stat']);
  if (!raw) return '';
  const lines = raw.split('\n');
  if (lines.length <= MAX_STAT_LINES) return raw;
  const trimmed = lines.slice(0, MAX_STAT_LINES);
  trimmed.push(`... (+${lines.length - MAX_STAT_LINES} more files)`);
  return trimmed.join('\n');
}

// ---------------------------------------------------------------------------
// SESSION-NOTES parser
// ---------------------------------------------------------------------------

/**
 * Extract the most recent timeline entry from SESSION-NOTES.md.
 * Returns `null` when the file is missing, unreadable, or contains no
 * entries (so the composer can simply skip the section).
 *
 * Entry boundary: lines starting with `## ` (h2 headers). The last entry
 * is everything from the final `## ` through the file end (or the next
 * `---` separator, whichever comes first).
 *
 * @param {string} sessionNotesPath
 * @param {{readFile?: Function}} [deps]
 * @returns {Promise<string|null>}
 */
export async function parseSessionNotes(sessionNotesPath, deps = {}) {
  if (!sessionNotesPath) return null;
  const reader = deps.readFile ?? readFile;
  let raw;
  try {
    raw = await reader(sessionNotesPath, 'utf-8');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'string') return null;

  // Find every h2 header (## ...). The last one starts the most recent entry.
  const headerRegex = /^## .+$/gm;
  const matches = [...raw.matchAll(headerRegex)];
  if (matches.length === 0) return null;

  const lastMatch = matches[matches.length - 1];
  const start = lastMatch.index ?? 0;
  // End: stop at the next standalone `---` separator (matches the format
  // emitted by buildAppendBlock in lib/learning/session-notes.js).
  const tail = raw.slice(start);
  const sepIdx = tail.search(/\n---\s*$/m);
  const slice = sepIdx >= 0 ? tail.slice(0, sepIdx) : tail;
  return slice.trim() || null;
}

// ---------------------------------------------------------------------------
// Commit classification
// ---------------------------------------------------------------------------

/**
 * Classify a commit into a bucket so the composer can render it under the
 * right section.
 *
 * Buckets:
 *   - "wip":      autopilot work-in-progress saves
 *   - "release":  squashed-WIP / release commits
 *   - "primary":  user-authored feature/fix/docs/etc.
 *
 * @param {{subject:string, body?:string}} commit
 * @returns {"wip"|"release"|"primary"}
 */
export function classifyCommit(commit) {
  const subj = (commit.subject ?? '').toLowerCase();
  const body = (commit.body ?? '').toLowerCase();
  if (subj.startsWith('wip:') || subj.startsWith('wip(') || subj.includes('artibot auto-save')) {
    return 'wip';
  }
  if (
    subj.startsWith('release:')
    || subj.startsWith('chore(release)')
    || body.includes('includes ') && body.includes('wip commit')
  ) {
    return 'release';
  }
  return 'primary';
}

/**
 * Group commits into the three buckets. Order is preserved within each
 * bucket (newest first, matching `git log` default).
 *
 * @param {Array<{sha:string, subject:string, body:string}>} commits
 * @returns {{primary:Array, wip:Array, release:Array}}
 */
export function bucketCommits(commits) {
  const buckets = { primary: [], wip: [], release: [] };
  for (const c of commits) {
    buckets[classifyCommit(c)].push(c);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Issue extraction
// ---------------------------------------------------------------------------

const ISSUE_REGEX = /(?:^|\s)#(\d+)(?=\s|$|[.,;:!?)])/g;

/**
 * Pull `#123`-style issue references out of every commit subject/body.
 * Returns a deduped, sorted list of issue numbers (as strings).
 *
 * @param {Array<{subject:string, body:string}>} commits
 * @returns {string[]}
 */
export function extractIssueRefs(commits) {
  const seen = new Set();
  for (const c of commits) {
    const haystack = `${c.subject ?? ''}\n${c.body ?? ''}`;
    for (const match of haystack.matchAll(ISSUE_REGEX)) {
      seen.add(match[1]);
    }
  }
  return [...seen].sort((a, b) => Number(a) - Number(b));
}

// ---------------------------------------------------------------------------
// Markdown composition
// ---------------------------------------------------------------------------

/**
 * Render a 7-char short SHA.
 * @param {string} sha
 * @returns {string}
 */
function shortSha(sha) {
  return (sha ?? '').slice(0, 7);
}

/**
 * Compose the full markdown body from already-resolved parts. Pure function
 * for easy unit testing — no I/O.
 *
 * @param {object} parts
 * @param {string} parts.baseBranch
 * @param {string} parts.headBranch
 * @param {{primary:Array, wip:Array, release:Array}} parts.buckets
 * @param {string} [parts.diffStat]
 * @param {string|null} [parts.sessionEntry]
 * @param {string[]} [parts.issueRefs]
 * @returns {string}
 */
export function composeMarkdown(parts) {
  const {
    baseBranch,
    headBranch,
    buckets,
    diffStat = '',
    sessionEntry = null,
    issueRefs = [],
  } = parts;
  const totalCommits = buckets.primary.length + buckets.wip.length + buckets.release.length;

  // ── Empty range — bail with a friendly placeholder so the PR isn't blank.
  if (totalCommits === 0) {
    return [
      '## Summary',
      '',
      `_No commits between \`${baseBranch}\` and \`${headBranch}\`._`,
      '',
      '## Test Plan',
      '',
      '- [ ] Manual verification',
      '',
      '---',
      '_Generated by `artibot build-pr-description`._',
      '',
    ].join('\n');
  }

  const lines = [];

  // ── Summary: top primary commits as terse bullets.
  lines.push('## Summary', '');
  const summarySource = buckets.primary.length > 0 ? buckets.primary : buckets.release;
  if (summarySource.length === 0) {
    lines.push('_Autopilot WIP-only PR (no primary commits)._');
  } else {
    for (const c of summarySource.slice(0, 3)) {
      lines.push(`- ${c.subject}`);
    }
  }
  lines.push('');

  // ── Changes: full primary commit list with short SHAs.
  if (buckets.primary.length > 0) {
    lines.push('## Changes', '');
    for (const c of buckets.primary) {
      lines.push(`- \`${shortSha(c.sha)}\` ${c.subject}`);
    }
    lines.push('');
  }

  // ── Release commits (squashes).
  if (buckets.release.length > 0) {
    lines.push('## Release Commits', '');
    for (const c of buckets.release) {
      lines.push(`- \`${shortSha(c.sha)}\` ${c.subject}`);
    }
    lines.push('');
  }

  // ── WIP activity (collapsed by default to keep the PR scannable).
  if (buckets.wip.length > 0) {
    lines.push('<details>', `<summary>WIP Activity (${buckets.wip.length})</summary>`, '');
    for (const c of buckets.wip) {
      lines.push(`- \`${shortSha(c.sha)}\` ${c.subject}`);
    }
    lines.push('', '</details>', '');
  }

  // ── Session timeline (verbatim block from SESSION-NOTES.md).
  if (sessionEntry) {
    lines.push('## Session Timeline', '');
    lines.push(sessionEntry);
    lines.push('');
  }

  // ── Diff stats (optional).
  if (diffStat) {
    lines.push('## Diff Stats', '', '```', diffStat, '```', '');
  }

  // ── Test Plan boilerplate — kept deliberately generic; teams customise.
  lines.push('## Test Plan', '');
  lines.push('- [ ] `npm run lint` passes');
  lines.push('- [ ] `npm test` passes');
  lines.push('- [ ] Manual verification of changed paths');
  lines.push('');

  // ── Related (issue refs).
  if (issueRefs.length > 0) {
    lines.push('## Related', '');
    for (const ref of issueRefs) {
      lines.push(`- #${ref}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('_Generated by `artibot build-pr-description`._');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build a PR description by combining git history, SESSION-NOTES, and
 * (optionally) diff stats.
 *
 * @param {object} opts
 * @param {string} opts.baseBranch base branch (e.g. "master")
 * @param {string} opts.headBranch head ref (e.g. "HEAD" or "feature/foo")
 * @param {string} [opts.sessionNotesPath] path to SESSION-NOTES.md
 * @param {boolean} [opts.includeStats=false] include `git diff --stat` block
 * @param {Function} [opts.gitRunner] DI override for git execution
 * @param {Function} [opts.fileReader] DI override for file reads (tests)
 * @returns {Promise<string>}
 */
export async function buildPrDescription(opts) {
  const {
    baseBranch,
    headBranch,
    sessionNotesPath = null,
    includeStats = false,
    gitRunner = runGit,
    fileReader = readFile,
  } = opts;

  if (!baseBranch || !headBranch) {
    throw new Error('buildPrDescription: baseBranch and headBranch are required');
  }

  const commits = await getCommitsBetween(baseBranch, headBranch, gitRunner);
  const buckets = bucketCommits(commits);
  const issueRefs = extractIssueRefs(commits);
  const diffStat = includeStats ? await getDiffStat(baseBranch, headBranch, gitRunner) : '';
  const sessionEntry = sessionNotesPath
    ? await parseSessionNotes(sessionNotesPath, { readFile: fileReader })
    : null;

  return composeMarkdown({
    baseBranch,
    headBranch,
    buckets,
    diffStat,
    sessionEntry,
    issueRefs,
  });
}
