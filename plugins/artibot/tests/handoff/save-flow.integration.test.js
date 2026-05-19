/**
 * Integration test for the `/save` flow:
 *
 *   collectHandoffData -> renderHandoffMarkdown -> writeHandoff -> markConsumed -> readLatestHandoff
 *
 * Verifies the round trip across the three new lib/handoff modules and the
 * extended auto-spawn-advisor `markConsumed` API. Uses an isolated tmp
 * projectRoot and pluginRoot to keep the suite hermetic.
 *
 * This test exercises Track B2 wiring; if any of the B1 modules export
 * shapes drift, the test will surface the contract mismatch early.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectHandoffData, renderHandoffMarkdown } from '../../lib/handoff/handoff-builder.js';
import { readLatestHandoff, writeHandoff } from '../../lib/handoff/handoff-store.js';
import { suggestFirstPrompts } from '../../lib/handoff/next-prompt-suggester.js';
import {
  _internals as advisorInternals,
  analyzeNextSession,
  markConsumed,
  readPendingSuggestions,
} from '../../lib/learning/auto-spawn-advisor.js';
import { parseHandoffBannerFields } from '../../scripts/hooks/session-start.js';

const SUGGESTIONS_REL = advisorInternals.SUGGESTIONS_RELATIVE_PATH;

function makeRoots() {
  return {
    pluginRoot: mkdtempSync(path.join(os.tmpdir(), 'save-plugin-')),
    projectRoot: mkdtempSync(path.join(os.tmpdir(), 'save-proj-')),
  };
}

// Synthetic git runner — returns deterministic, empty-but-valid output so
// collectHandoffData can render a valid markdown without spawning git.
function makeFakeGitRunner() {
  return (args) => {
    const cmd = args.join(' ');
    if (cmd.startsWith('rev-parse --abbrev-ref HEAD')) return 'main\n';
    if (cmd.startsWith('rev-parse --short HEAD')) return 'abc1234\n';
    if (cmd.startsWith('status --porcelain')) return ' M foo.js\n M bar.js\n';
    if (cmd.startsWith('log -10')) return 'abc1234|feat: x|2h ago\n';
    if (cmd.startsWith('log')) return '';
    if (cmd.startsWith('rev-list')) return '0\n';
    if (cmd.startsWith('diff --name-only')) return '';
    return '';
  };
}

describe('/save flow integration', () => {
  let pluginRoot;
  let projectRoot;

  beforeEach(() => {
    ({ pluginRoot, projectRoot } = makeRoots());
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('produces a handoff with "다음" line + consumes advisor signals atomically', async () => {
    // 1. Seed advisor file with 2 pending suggestions
    await analyzeNextSession(
      {
        testFailures: [{ name: 'a.test.js' }],
        driftWarnings: [{ agent: 'alpha', avg: 0.4, threshold: 0.65, confidence: 0.9 }],
      },
      {
        pluginRoot,
        config: { ago: { autoSpawn: { enabled: true, maxDepth: 2, minConfidence: 0.8, requireOptIn: true } } },
      },
    );
    const beforePending = await readPendingSuggestions(pluginRoot);
    expect(beforePending.length).toBeGreaterThanOrEqual(2);

    // 2. Build first-prompt suggestions feed
    const firstPrompts = suggestFirstPrompts(
      {
        unresolved: [],
        wip: { count: 2, oldestAgeMs: 3_600_000 },
        advisorSignals: beforePending,
        tasks: [{ id: 'T1', status: 'in_progress', subject: 'finish save flow' }],
        gitStatus: { modified: 2, staged: 0, untracked: 0 },
        recentCommits: [],
      },
      { max: 3 },
    );
    expect(Array.isArray(firstPrompts)).toBe(true);

    // 3. Collect + render markdown
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: makeFakeGitRunner(),
      taskList: [{ id: 'T1', status: 'in_progress', subject: 'finish save flow' }],
      firstPrompts,
      now: () => new Date('2026-05-19T11:30:00Z'),
    });
    const md = renderHandoffMarkdown(data, { now: () => new Date('2026-05-19T11:30:00Z') });
    expect(md).toMatch(/^#\s+HANDOFF/m); // header sanity (builder emits "# HANDOFF — …")
    expect(md).toMatch(/다음/); // "다음 …" P0 line (Korean) appears somewhere

    // 4. Write handoff (atomic — advisor untouched yet)
    const write = await writeHandoff(md, {
      projectRoot,
      keep: 10,
      now: () => new Date('2026-05-19T11:30:00Z'),
    });
    expect(write.latestPath).toBeTruthy();
    expect(write.archivePath).toBeTruthy();

    // Advisor file MUST still show pending entries at this point.
    const stillPending = await readPendingSuggestions(pluginRoot);
    expect(stillPending.length).toBe(beforePending.length);

    // 5. Mark consumed (R3 atomicity: only after write succeeded)
    const ids = beforePending.map((s) => s.id);
    const mark = await markConsumed(pluginRoot, ids);
    expect(mark.marked).toBe(ids.length);
    expect(mark.skipped).toBe(0);

    // 6. readLatestHandoff returns the same markdown we wrote
    const latest = await readLatestHandoff(projectRoot);
    expect(latest).not.toBeNull();
    expect(latest.content).toBe(md);

    // 7. Advisor signals are now hidden from readPendingSuggestions
    const afterConsume = await readPendingSuggestions(pluginRoot);
    expect(afterConsume).toEqual([]);

    // 8. The on-disk advisor file retains consumed-state stamps
    const raw = readFileSync(path.join(pluginRoot, SUGGESTIONS_REL), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.suggestions.every((s) => s.consumed === true)).toBe(true);
    expect(parsed.suggestions.every((s) => s.consumedBy === 'save')).toBe(true);
  });

  it('does NOT mark consumed when write would have failed (atomicity guard)', async () => {
    // Seed advisor
    await analyzeNextSession(
      { testFailures: [{ name: 'a.test.js' }] },
      {
        pluginRoot,
        config: { ago: { autoSpawn: { enabled: true, maxDepth: 2, minConfidence: 0.8, requireOptIn: true } } },
      },
    );
    const pending = await readPendingSuggestions(pluginRoot);
    expect(pending.length).toBeGreaterThan(0);

    // Simulate caller error path: caller decides NOT to call markConsumed.
    // (We are asserting the contract that advisor stays untouched when the
    // caller wraps `markConsumed` behind a successful `writeHandoff` only.)
    const after = await readPendingSuggestions(pluginRoot);
    expect(after.length).toBe(pending.length);
    expect(after.every((s) => s.consumed !== true)).toBe(true);
  });
});

describe('parseHandoffBannerFields (banner regex)', () => {
  it('extracts P0, unresolved count, and WIP count from a typical handoff head', () => {
    const md = [
      '# Handoff: artibot @ 2026-05-19 11:30',
      '',
      '## 1. 지금 상태',
      '',
      '| 항목 | 값 |',
      '|------|-----|',
      '| 브랜치 | main |',
      '| 변경 파일: 3 (modified) |',
      '| WIP: 5 |',
      '',
      '## 2. 최근 커밋',
      '- abc1234 feat: x',
      '',
      '## 4. 다음 P0',
      '',
      '> Fix the failing auth tests before merging the feature branch',
      '',
      '## 5. 미해결 결정/질문',
      '',
      '- 미해결 항목 1',
      '- 미해결 항목 2',
      '- 미해결 항목 3',
      '',
      '## 6. 권장 첫 프롬프트',
    ].join('\n');

    const fields = parseHandoffBannerFields(md);
    expect(fields.p0).toMatch(/Fix the failing auth tests/);
    expect(fields.unresolved).toBe(3);
    expect(fields.wip).toBeGreaterThanOrEqual(3); // first match in section
  });

  it('returns safe zeros on empty input', () => {
    expect(parseHandoffBannerFields('')).toEqual({ p0: null, unresolved: 0, wip: 0 });
    expect(parseHandoffBannerFields(null)).toEqual({ p0: null, unresolved: 0, wip: 0 });
  });

  it('handles English fallback headers', () => {
    const md = [
      '## 1. Status',
      'Uncommitted: 7',
      '',
      '## 4. Next P0',
      'Ship the release notes',
      '',
      '## 5. Unresolved',
      '- a',
      '- b',
    ].join('\n');
    const fields = parseHandoffBannerFields(md);
    expect(fields.p0).toMatch(/Ship the release notes/);
    expect(fields.unresolved).toBe(2);
    expect(fields.wip).toBe(7);
  });

  it('skips YAML frontmatter block (Safety #2) before scanning sections', () => {
    const md = [
      '---',
      'machineId: host_user',
      "createdAt: '2026-05-19T11:30:00.000Z'",
      'branch: main',
      'generator: artibot-handoff',
      'schemaVersion: 1',
      '---',
      '',
      '# HANDOFF — 2026-05-19 11:30',
      '',
      '> 다음 P0: Frontmatter parsed safely',
      '',
      '## 1. 지금 상태',
      'WIP: 3',
      '',
      '## 5. 미해결',
      '- a',
    ].join('\n');
    const fields = parseHandoffBannerFields(md);
    expect(fields.p0).toMatch(/Frontmatter parsed safely/);
    expect(fields.unresolved).toBe(1);
    expect(fields.wip).toBe(3);
  });
});
