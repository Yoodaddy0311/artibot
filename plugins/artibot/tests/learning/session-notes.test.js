import { describe, expect, it } from 'vitest';
import {
  buildAppendBlock,
  fileHeader,
  formatEntry,
  shouldSkipEntry,
} from '../../lib/learning/session-notes.js';

describe('session-notes — formatEntry', () => {
  const baseMeta = {
    timestamp: '2026-05-16T14:32:11Z',
    branch: 'artibot/master',
    commits: [
      { sha: '0a1401cabcdef1234567890', subject: 'fix(autopilot): drift fix' },
      { sha: '26e3044bbbbbbbbbbbbbbbb', subject: 'docs(prd): telegram MCP PRD' },
    ],
    filesChanged: 8,
    wipSquashed: 0,
  };

  it('renders a header with UTC timestamp and branch in backticks', () => {
    const out = formatEntry(baseMeta);
    expect(out).toMatch(/^## 2026-05-16 14:32 UTC · `artibot\/master`/);
  });

  it('renders each commit with a 7-char short SHA', () => {
    const out = formatEntry(baseMeta);
    expect(out).toContain('`0a1401c` fix(autopilot): drift fix');
    expect(out).toContain('`26e3044` docs(prd): telegram MCP PRD');
    // Full SHA should NOT appear
    expect(out).not.toContain('0a1401cabcdef1234567890');
  });

  it('shows "Commits: none" when commit list is empty', () => {
    const out = formatEntry({ ...baseMeta, commits: [] });
    expect(out).toContain('- **Commits**: none');
  });

  it('omits WIP squashed line when 0', () => {
    const out = formatEntry({ ...baseMeta, wipSquashed: 0 });
    expect(out).not.toContain('WIP commits squashed');
  });

  it('includes WIP squashed line when > 0', () => {
    const out = formatEntry({ ...baseMeta, wipSquashed: 3 });
    expect(out).toContain('- **WIP commits squashed**: 3');
  });

  it('appends a Korean memo hint comment', () => {
    const out = formatEntry(baseMeta);
    expect(out).toContain('<!-- 메모:');
  });

  it('falls back to raw ISO when timestamp is invalid', () => {
    const out = formatEntry({ ...baseMeta, timestamp: 'not-a-date' });
    expect(out).toContain('not-a-date');
  });
});

describe('session-notes — shouldSkipEntry', () => {
  it('returns true when commits, filesChanged, and wipSquashed are all empty/0', () => {
    expect(shouldSkipEntry({ commits: [], filesChanged: 0, wipSquashed: 0 })).toBe(true);
  });

  it('returns false when there are commits', () => {
    expect(shouldSkipEntry({
      commits: [{ sha: 'a', subject: 's' }],
      filesChanged: 0,
      wipSquashed: 0,
    })).toBe(false);
  });

  it('returns false when files changed', () => {
    expect(shouldSkipEntry({ commits: [], filesChanged: 5, wipSquashed: 0 })).toBe(false);
  });

  it('returns false when WIP was squashed', () => {
    expect(shouldSkipEntry({ commits: [], filesChanged: 0, wipSquashed: 2 })).toBe(false);
  });

  it('treats undefined wipSquashed as 0', () => {
    expect(shouldSkipEntry({ commits: [], filesChanged: 0 })).toBe(true);
  });
});

describe('session-notes — fileHeader', () => {
  it('explains the file purpose and contrasts with memory', () => {
    const header = fileHeader();
    expect(header).toContain('# Artibot Session Notes');
    expect(header).toContain('Memory');
    expect(header).toMatch(/timeline|시간|시계열/i);
  });

  it('ends with a separator line so the first entry has visual spacing', () => {
    expect(fileHeader()).toMatch(/---\s*\n\s*$/);
  });
});

describe('session-notes — buildAppendBlock', () => {
  it('starts with a leading blank line so it does not collide with prior entry', () => {
    const out = buildAppendBlock({
      timestamp: '2026-05-16T14:32:11Z',
      branch: 'main',
      commits: [],
      filesChanged: 1,
      wipSquashed: 0,
    });
    expect(out.startsWith('\n')).toBe(true);
  });

  it('ends with a trailing separator and newline', () => {
    const out = buildAppendBlock({
      timestamp: '2026-05-16T14:32:11Z',
      branch: 'main',
      commits: [],
      filesChanged: 1,
      wipSquashed: 0,
    });
    expect(out).toMatch(/---\n$/);
  });
});
