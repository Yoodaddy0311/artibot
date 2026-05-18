/**
 * Tests for lib/release/pr-description-builder.js
 *
 * Strategy:
 *   - Pure functions (composeMarkdown, classifyCommit, extractIssueRefs,
 *     bucketCommits) tested directly with fixture data.
 *   - I/O functions (getCommitsBetween, getDiffStat, buildPrDescription)
 *     tested via dependency-injected git runner + file reader — no real
 *     git or filesystem calls.
 *   - parseSessionNotes tested with both an injected reader and a real
 *     temp file to cover both code paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  bucketCommits,
  buildPrDescription,
  classifyCommit,
  composeMarkdown,
  extractIssueRefs,
  getCommitsBetween,
  getDiffStat,
  parseSessionNotes,
} from '../../lib/release/pr-description-builder.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRIMARY_COMMITS = [
  { sha: 'aaaaaaa1111111111111', subject: 'feat(api): add /v2/users endpoint', body: 'Closes #42.' },
  { sha: 'bbbbbbb2222222222222', subject: 'fix(auth): refresh token race', body: 'Refs #17.' },
];

const WIP_COMMITS = [
  { sha: 'ccccccc3333333333333', subject: 'wip: artibot auto-save', body: '' },
  { sha: 'ddddddd4444444444444', subject: 'wip(feat): drafting handler', body: '' },
];

const RELEASE_COMMITS = [
  {
    sha: 'eeeeeee5555555555555',
    subject: 'release: v4.7.6',
    body: 'Includes 3 WIP commits.',
  },
];

// ---------------------------------------------------------------------------
// classifyCommit
// ---------------------------------------------------------------------------

describe('classifyCommit', () => {
  it('classifies autopilot wip: prefix as "wip"', () => {
    expect(classifyCommit({ subject: 'wip: artibot auto-save' })).toBe('wip');
  });

  it('classifies wip(scope): prefix as "wip"', () => {
    expect(classifyCommit({ subject: 'wip(feat): drafting handler' })).toBe('wip');
  });

  it('classifies release: prefix as "release"', () => {
    expect(classifyCommit({ subject: 'release: v4.7.6' })).toBe('release');
  });

  it('classifies chore(release) prefix as "release"', () => {
    expect(classifyCommit({ subject: 'chore(release): bump version' })).toBe('release');
  });

  it('classifies squash bodies (Includes N WIP commit) as "release"', () => {
    expect(classifyCommit({
      subject: 'feat: rollup',
      body: 'Includes 5 WIP commits.',
    })).toBe('release');
  });

  it('classifies conventional commits as "primary"', () => {
    expect(classifyCommit({ subject: 'feat(api): add endpoint' })).toBe('primary');
    expect(classifyCommit({ subject: 'fix(bug): off-by-one' })).toBe('primary');
    expect(classifyCommit({ subject: 'docs: update readme' })).toBe('primary');
  });

  it('treats missing fields as empty string (defaults to primary)', () => {
    expect(classifyCommit({})).toBe('primary');
  });
});

// ---------------------------------------------------------------------------
// bucketCommits
// ---------------------------------------------------------------------------

describe('bucketCommits', () => {
  it('routes commits into primary/wip/release buckets', () => {
    const all = [...PRIMARY_COMMITS, ...WIP_COMMITS, ...RELEASE_COMMITS];
    const buckets = bucketCommits(all);
    expect(buckets.primary).toHaveLength(2);
    expect(buckets.wip).toHaveLength(2);
    expect(buckets.release).toHaveLength(1);
  });

  it('returns empty buckets when input is empty', () => {
    expect(bucketCommits([])).toEqual({ primary: [], wip: [], release: [] });
  });
});

// ---------------------------------------------------------------------------
// extractIssueRefs
// ---------------------------------------------------------------------------

describe('extractIssueRefs', () => {
  it('extracts and dedupes #NNN references from subjects and bodies', () => {
    const commits = [
      { subject: 'feat: thing (#42)', body: 'Closes #42.' },
      { subject: 'fix: other', body: 'Refs #17 and #99.' },
    ];
    expect(extractIssueRefs(commits)).toEqual(['17', '42', '99']);
  });

  it('returns empty array when no refs present', () => {
    expect(extractIssueRefs([{ subject: 'plain commit', body: 'no refs' }])).toEqual([]);
  });

  it('does not match hex SHAs that contain digits after #', () => {
    // The regex requires a word boundary after the digits — #abc123 should not match.
    // But #123abc *also* should not match because the lookahead requires \s/end/punct.
    expect(extractIssueRefs([
      { subject: 'feat: tag #abc123', body: '' },
      { subject: 'feat: tag #123abc', body: '' },
    ])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// composeMarkdown
// ---------------------------------------------------------------------------

describe('composeMarkdown', () => {
  it('produces an empty-range placeholder when no commits exist', () => {
    const md = composeMarkdown({
      baseBranch: 'master',
      headBranch: 'HEAD',
      buckets: { primary: [], wip: [], release: [] },
    });
    expect(md).toContain('## Summary');
    expect(md).toContain('No commits between `master` and `HEAD`');
    expect(md).toContain('## Test Plan');
    expect(md).toContain('_Generated by `artibot build-pr-description`._');
  });

  it('renders summary bullets from primary commits (max 3)', () => {
    const buckets = bucketCommits([
      ...PRIMARY_COMMITS,
      { sha: 'fff', subject: 'docs: update', body: '' },
      { sha: 'ggg', subject: 'test: add cases', body: '' },
    ]);
    const md = composeMarkdown({ baseBranch: 'master', headBranch: 'HEAD', buckets });
    // First 3 primary commits in Summary section.
    const summary = md.split('## Changes')[0];
    expect(summary).toContain('- feat(api): add /v2/users endpoint');
    expect(summary).toContain('- fix(auth): refresh token race');
    expect(summary).toContain('- docs: update');
    // 4th commit ("test: add cases") should NOT appear in Summary.
    expect(summary).not.toContain('- test: add cases');
  });

  it('renders Changes section with 7-char short SHAs', () => {
    const buckets = bucketCommits(PRIMARY_COMMITS);
    const md = composeMarkdown({ baseBranch: 'master', headBranch: 'HEAD', buckets });
    expect(md).toContain('## Changes');
    expect(md).toContain('`aaaaaaa` feat(api): add /v2/users endpoint');
    expect(md).toContain('`bbbbbbb` fix(auth): refresh token race');
  });

  it('groups WIP commits into a collapsed <details> block', () => {
    const buckets = bucketCommits([...PRIMARY_COMMITS, ...WIP_COMMITS]);
    const md = composeMarkdown({ baseBranch: 'master', headBranch: 'HEAD', buckets });
    expect(md).toContain('<details>');
    expect(md).toContain('<summary>WIP Activity (2)</summary>');
    expect(md).toContain('`ccccccc` wip: artibot auto-save');
    expect(md).toContain('</details>');
  });

  it('renders Release Commits section when squashes are present', () => {
    const buckets = bucketCommits(RELEASE_COMMITS);
    const md = composeMarkdown({ baseBranch: 'master', headBranch: 'HEAD', buckets });
    expect(md).toContain('## Release Commits');
    expect(md).toContain('`eeeeeee` release: v4.7.6');
  });

  it('falls back to release commits for Summary when no primary exist', () => {
    const buckets = bucketCommits(RELEASE_COMMITS);
    const md = composeMarkdown({ baseBranch: 'master', headBranch: 'HEAD', buckets });
    const summary = md.split('## Release Commits')[0];
    expect(summary).toContain('- release: v4.7.6');
  });

  it('embeds Session Timeline block verbatim when provided', () => {
    const buckets = bucketCommits(PRIMARY_COMMITS);
    const sessionEntry = '## 2026-05-16 14:32 UTC · `artibot/master`\n\n- **Commits** (1):\n  - `aaaaaaa` feat(api): add /v2/users endpoint';
    const md = composeMarkdown({
      baseBranch: 'master',
      headBranch: 'HEAD',
      buckets,
      sessionEntry,
    });
    expect(md).toContain('## Session Timeline');
    expect(md).toContain('2026-05-16 14:32 UTC');
  });

  it('renders Diff Stats code block when stat provided', () => {
    const buckets = bucketCommits(PRIMARY_COMMITS);
    const md = composeMarkdown({
      baseBranch: 'master',
      headBranch: 'HEAD',
      buckets,
      diffStat: ' lib/foo.js | 10 ++++++++++\n 1 file changed',
    });
    expect(md).toContain('## Diff Stats');
    expect(md).toMatch(/```\n lib\/foo\.js \| 10/);
  });

  it('renders Related section with issue refs', () => {
    const buckets = bucketCommits(PRIMARY_COMMITS);
    const md = composeMarkdown({
      baseBranch: 'master',
      headBranch: 'HEAD',
      buckets,
      issueRefs: ['17', '42'],
    });
    expect(md).toContain('## Related');
    expect(md).toContain('- #17');
    expect(md).toContain('- #42');
  });

  it('omits Related section when no issue refs present', () => {
    const buckets = bucketCommits(PRIMARY_COMMITS);
    const md = composeMarkdown({ baseBranch: 'master', headBranch: 'HEAD', buckets });
    expect(md).not.toContain('## Related');
  });

  it('shows WIP-only fallback when only WIP commits exist', () => {
    const buckets = bucketCommits(WIP_COMMITS);
    const md = composeMarkdown({ baseBranch: 'master', headBranch: 'HEAD', buckets });
    expect(md).toContain('_Autopilot WIP-only PR (no primary commits)._');
  });
});

// ---------------------------------------------------------------------------
// getCommitsBetween (with injected git runner)
// ---------------------------------------------------------------------------

describe('getCommitsBetween', () => {
  const RS = '\x1e';
  const US = '\x1f';

  it('parses TAB-delimited git log output into objects', async () => {
    const raw = [
      `${US}aaaaaaa1111111111111${US}feat: alpha${US}body alpha${RS}`,
      `${US}bbbbbbb2222222222222${US}fix: beta${US}${RS}`,
    ].join('\n');
    const fakeRunner = vi.fn().mockResolvedValue(raw);
    const commits = await getCommitsBetween('master', 'HEAD', fakeRunner);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: 'aaaaaaa1111111111111',
      subject: 'feat: alpha',
      body: 'body alpha',
    });
    expect(commits[1]).toEqual({
      sha: 'bbbbbbb2222222222222',
      subject: 'fix: beta',
      body: '',
    });
    expect(fakeRunner).toHaveBeenCalledWith(expect.arrayContaining(['log', 'master..HEAD']));
  });

  it('returns empty array when git output is empty', async () => {
    const fakeRunner = vi.fn().mockResolvedValue('');
    expect(await getCommitsBetween('master', 'HEAD', fakeRunner)).toEqual([]);
  });

  it('survives malformed lines without throwing', async () => {
    const raw = `${RS}${US}only-sha${RS}`;
    const fakeRunner = vi.fn().mockResolvedValue(raw);
    const commits = await getCommitsBetween('master', 'HEAD', fakeRunner);
    expect(commits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getDiffStat
// ---------------------------------------------------------------------------

describe('getDiffStat', () => {
  it('returns raw stat when under the cap', async () => {
    const stat = ' lib/foo.js | 10 ++++++++++\n 1 file changed';
    const fakeRunner = vi.fn().mockResolvedValue(stat);
    expect(await getDiffStat('master', 'HEAD', fakeRunner)).toBe(stat);
    expect(fakeRunner).toHaveBeenCalledWith(['diff', 'master...HEAD', '--stat']);
  });

  it('truncates and notes overflow when too many files', async () => {
    const big = Array.from({ length: 80 }, (_, i) => ` file-${i}.js | 1 +`).join('\n');
    const fakeRunner = vi.fn().mockResolvedValue(big);
    const out = await getDiffStat('master', 'HEAD', fakeRunner);
    expect(out).toContain('... (+20 more files)');
  });

  it('returns empty string on git failure (empty result)', async () => {
    const fakeRunner = vi.fn().mockResolvedValue('');
    expect(await getDiffStat('master', 'HEAD', fakeRunner)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseSessionNotes
// ---------------------------------------------------------------------------

describe('parseSessionNotes', () => {
  let tmp;

  beforeEach(async () => {
    tmp = path.join(tmpdir(), `pr-desc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns null when path is falsy', async () => {
    expect(await parseSessionNotes(null)).toBeNull();
    expect(await parseSessionNotes('')).toBeNull();
  });

  it('returns null when file does not exist', async () => {
    expect(await parseSessionNotes(path.join(tmp, 'missing.md'))).toBeNull();
  });

  it('returns null when file has no h2 entries', async () => {
    const file = path.join(tmp, 'SESSION-NOTES.md');
    await writeFile(file, '# Header only\n\nNo entries.\n', 'utf-8');
    expect(await parseSessionNotes(file)).toBeNull();
  });

  it('extracts the most recent entry from a multi-entry file', async () => {
    const file = path.join(tmp, 'SESSION-NOTES.md');
    const content = [
      '# Artibot Session Notes',
      '',
      '## 2026-05-15 09:00 UTC · `feature/old`',
      '',
      '- **Commits** (1):',
      '  - `aaaaaaa` old commit',
      '',
      '---',
      '',
      '## 2026-05-16 14:32 UTC · `artibot/master`',
      '',
      '- **Commits** (2):',
      '  - `bbbbbbb` new commit',
      '  - `ccccccc` newer commit',
      '',
      '---',
      '',
    ].join('\n');
    await writeFile(file, content, 'utf-8');
    const entry = await parseSessionNotes(file);
    expect(entry).toContain('2026-05-16 14:32 UTC');
    expect(entry).toContain('new commit');
    expect(entry).not.toContain('old commit');
  });

  it('honors an injected file reader (returns null when reader throws)', async () => {
    const reader = vi.fn().mockRejectedValue(new Error('boom'));
    const out = await parseSessionNotes('/fake/path', { readFile: reader });
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPrDescription (end-to-end with DI)
// ---------------------------------------------------------------------------

describe('buildPrDescription', () => {
  const RS = '\x1e';
  const US = '\x1f';

  it('throws when baseBranch/headBranch are missing', async () => {
    await expect(buildPrDescription({})).rejects.toThrow(/required/);
    await expect(buildPrDescription({ baseBranch: 'master' })).rejects.toThrow(/required/);
  });

  it('combines git + session notes + stats into a single body', async () => {
    const logRaw = `${US}aaaaaaa1111111111111${US}feat(api): hello${US}Closes #1.${RS}`;
    const statRaw = ' lib/x.js | 5 +++++';
    const gitRunner = vi.fn((args) => {
      if (args[0] === 'log') return Promise.resolve(logRaw);
      if (args[0] === 'diff') return Promise.resolve(statRaw);
      return Promise.resolve('');
    });
    const fileReader = vi.fn().mockResolvedValue(
      '# Header\n\n## 2026-05-16 UTC · `branch`\n\n- entry body\n\n---\n',
    );

    const md = await buildPrDescription({
      baseBranch: 'master',
      headBranch: 'HEAD',
      sessionNotesPath: '/fake/SESSION-NOTES.md',
      includeStats: true,
      gitRunner,
      fileReader,
    });

    expect(md).toContain('## Summary');
    expect(md).toContain('- feat(api): hello');
    expect(md).toContain('## Changes');
    expect(md).toContain('`aaaaaaa` feat(api): hello');
    expect(md).toContain('## Session Timeline');
    expect(md).toContain('2026-05-16 UTC');
    expect(md).toContain('## Diff Stats');
    expect(md).toContain('lib/x.js');
    expect(md).toContain('## Related');
    expect(md).toContain('- #1');
  });

  it('emits the empty-range placeholder when git log returns nothing', async () => {
    const gitRunner = vi.fn().mockResolvedValue('');
    const md = await buildPrDescription({
      baseBranch: 'master',
      headBranch: 'HEAD',
      gitRunner,
    });
    expect(md).toContain('No commits between `master` and `HEAD`');
  });

  it('skips Session Timeline when no path is provided', async () => {
    const logRaw = `${US}aaaaaaa1111111111111${US}feat: x${US}${RS}`;
    const gitRunner = vi.fn().mockResolvedValue(logRaw);
    const md = await buildPrDescription({
      baseBranch: 'master',
      headBranch: 'HEAD',
      gitRunner,
    });
    expect(md).not.toContain('## Session Timeline');
  });

  it('skips Diff Stats when includeStats is false', async () => {
    const logRaw = `${US}aaaaaaa1111111111111${US}feat: x${US}${RS}`;
    const gitRunner = vi.fn().mockResolvedValue(logRaw);
    const md = await buildPrDescription({
      baseBranch: 'master',
      headBranch: 'HEAD',
      gitRunner,
    });
    expect(md).not.toContain('## Diff Stats');
  });
});
