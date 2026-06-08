/**
 * Tests for lib/handoff/handoff-builder.js
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectHandoffData,
  deriveGitSyncStatus,
  estimateStepDuration,
  renderHandoffMarkdown,
  toProjectSlug,
} from '../../lib/handoff/handoff-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'handoff-builder-'));
}

/**
 * Build a mock git runner that responds to a fixed command map. Args are
 * joined with spaces to form the lookup key.
 */
function mockGit(responses) {
  return (args) => {
    const key = args.join(' ');
    for (const [pattern, value] of Object.entries(responses)) {
      if (key.startsWith(pattern)) {
        if (typeof value === 'function') return value();
        return value;
      }
    }
    throw new Error(`mockGit: unmatched args: ${key}`);
  };
}

const FROZEN_NOW = () => new Date(Date.UTC(2026, 4, 19, 12, 30, 0));

const HAPPY_GIT = mockGit({
  'rev-parse --abbrev-ref HEAD': 'feat/handoff\n',
  'rev-parse --short HEAD': 'abc1234\n',
  'status --porcelain': ' M file-a.js\n?? file-b.js\nA  file-c.js\n',
  'log -5 --format=%h|%s|%ar': [
    'abc1234|feat: add handoff (PR #42)|2 hours ago',
    'def5678|fix: typo|5 hours ago',
  ].join('\n') + '\n',
  'rev-list --count @{u}..HEAD': '3\n',
  'log -5 --name-only --pretty=format:': 'lib/handoff/handoff-builder.js\nlib/handoff/handoff-store.js\nlib/handoff/handoff-builder.js\n',
});

// ---------------------------------------------------------------------------
// estimateStepDuration
// ---------------------------------------------------------------------------

describe('handoff-builder / estimateStepDuration', () => {
  it('maps known buckets correctly', () => {
    expect(estimateStepDuration('PR #42 응답')).toBe('~5m');
    expect(estimateStepDuration('release v4.13.0 배포')).toBe('~30m');
    expect(estimateStepDuration('/team P0 PR review')).toBe('~15m');
    expect(estimateStepDuration('handoff 모듈 구현')).toBe('~1h');
    expect(estimateStepDuration('lib refactor')).toBe('~2h+');
    expect(estimateStepDuration('something totally unknown')).toBe('~30m');
  });
});

// ---------------------------------------------------------------------------
// toProjectSlug
// ---------------------------------------------------------------------------

describe('handoff-builder / toProjectSlug', () => {
  it('converts a Windows path with drive letter and separators', () => {
    expect(toProjectSlug('C:\\Users\\foo\\Artibot')).toBe('C-Users-foo-Artibot');
  });
  it('converts a POSIX path', () => {
    expect(toProjectSlug('/home/foo/Artibot')).toBe('-home-foo-Artibot');
  });
  it('returns empty for falsy input', () => {
    expect(toProjectSlug('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// collectHandoffData + renderHandoffMarkdown (full happy-path)
// ---------------------------------------------------------------------------

describe('handoff-builder / full render', () => {
  let pluginRoot;
  let projectRoot;

  beforeEach(() => {
    pluginRoot = makeTempRoot();
    projectRoot = makeTempRoot();
    // Seed a fake last-test-result for the quality section.
    mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
    writeFileSync(
      path.join(pluginRoot, 'runtime', 'last-test-result.json'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        totalTests: 100,
        passed: 100,
        failed: 0,
        failedFiles: [],
      }),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('renders all 8 sections and contains no ANSI escape sequences', async () => {
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: HAPPY_GIT,
      taskList: [{ id: '1', subject: 'do thing', status: 'in_progress' }],
      firstPrompts: [
        { prompt: '/team P0 do thing', rationale: '진행 중', priority: 'P0' },
      ],
      now: FROZEN_NOW,
    });
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });

    expect(md).toContain('# HANDOFF — ');
    expect(md).toContain('## 1. 지금 상태');
    expect(md).toContain('## 2. 이번 세션 한 일');
    expect(md).toContain('## 3. 의도/현재 가설');
    expect(md).toContain('## 4. 즉시 진행할 일');
    expect(md).toContain('## 5. 미해결 결정/질문');
    expect(md).toContain('## 6. 다음 세션 첫 프롬프트 후보');
    expect(md).toContain('## 7. 컨텍스트 복원 핵심 파일');
    expect(md).toContain('## 8. 메타');
    // git data flowed in
    expect(md).toContain('feat/handoff');
    expect(md).toContain('abc1234');
    // first prompt flowed in
    expect(md).toContain('/team P0 do thing');
    // No ANSI codes
    // eslint-disable-next-line no-control-regex
    expect(md).not.toMatch(/\x1b\[/);
  });

  it('gracefully degrades when git runner throws', async () => {
    const badGit = () => { throw new Error('not a git repo'); };
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: badGit,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    // Renders an "(unknown)" branch placeholder rather than throwing.
    expect(md).toContain('(unknown)');
    expect(data.gitState.recentCommits).toEqual([]);
  });

  it('shows "(없음)" when advisor has no pending suggestions', async () => {
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: HAPPY_GIT,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    // Section 5 should fall back to the empty placeholder
    const sec5 = md.split('## 5. 미해결 결정/질문')[1].split('## 6.')[0];
    expect(sec5).toContain('(없음)');
  });

  it('omits WIP entry in section 5 when WIP count is zero', async () => {
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: HAPPY_GIT,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    // No WIP advisory in section 5
    const sec5 = renderHandoffMarkdown(data, { now: FROZEN_NOW })
      .split('## 5. 미해결 결정/질문')[1]
      .split('## 6.')[0];
    expect(sec5).not.toMatch(/\/squash 권장/);
  });

  it('keeps the output free of ANSI codes even with rich data', async () => {
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: HAPPY_GIT,
      taskList: [
        { id: '1', subject: 'thing one', status: 'in_progress' },
        { id: '2', subject: 'thing two', status: 'pending' },
      ],
      firstPrompts: [
        { prompt: '/team P0 thing one', rationale: '진행 중', priority: 'P0' },
        { prompt: '/team thing two', rationale: '대기', priority: 'P1' },
      ],
      now: FROZEN_NOW,
    });
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    // eslint-disable-next-line no-control-regex
    expect(md).not.toMatch(/\x1b\[/);
  });

  // -------------------------------------------------------------------------
  // Safety #3: git timeout / lock graceful fail
  // -------------------------------------------------------------------------
  it('flags gitState.lockedOut=true and renders a §1 warning when git throws ETIMEDOUT', async () => {
    const timeoutGit = () => {
      const err = new Error('Command failed: git rev-parse');
      err.code = 'ETIMEDOUT';
      throw err;
    };
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: timeoutGit,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    expect(data.gitState.lockedOut).toBe(true);
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    expect(md).toContain('Git 잠금 감지');
    // Other sections still render
    expect(md).toContain('## 1. 지금 상태');
    expect(md).toContain('## 8. 메타');
  });

  it('partial git failure: log throws but branch/status succeed → lockedOut=false, branch present', async () => {
    const partialGit = mockGit({
      'rev-parse --abbrev-ref HEAD': 'feat/handoff\n',
      'rev-parse --short HEAD': 'abc1234\n',
      'status --porcelain': ' M file-a.js\n',
      'log -5 --format=%h|%s|%ar': () => {
        // Plain error (not a lock/timeout) — should NOT flip lockedOut.
        throw new Error('fatal: bad revision');
      },
      'rev-list --count @{u}..HEAD': '0\n',
      'log -5 --name-only --pretty=format:': '',
    });
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: partialGit,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    expect(data.gitState.lockedOut).toBe(false);
    expect(data.gitState.branch).toBe('feat/handoff');
    expect(data.gitState.recentCommits).toEqual([]);
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    expect(md).not.toContain('Git 잠금 감지');
  });

  // -------------------------------------------------------------------------
  // Safety #2: frontmatter (machineId + createdAt + branch)
  // -------------------------------------------------------------------------
  it('renders YAML frontmatter as the very first lines with 5 required fields', async () => {
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: HAPPY_GIT,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    expect(md.startsWith('---\n')).toBe(true);
    // Extract frontmatter slice
    const second = md.indexOf('\n---\n', 4);
    expect(second).toBeGreaterThan(0);
    const fm = md.slice(0, second + 5);
    expect(fm).toMatch(/^machineId:\s+/m);
    expect(fm).toMatch(/^createdAt:\s+/m);
    expect(fm).toMatch(/^branch:\s+/m);
    expect(fm).toMatch(/^generator:\s+artibot-handoff/m);
    expect(fm).toMatch(/^schemaVersion:\s+1/m);
    // Body still contains the # HANDOFF heading after frontmatter
    expect(md.slice(second + 5)).toMatch(/^#\s+HANDOFF/m);
    // Meta on the data object exposes the same fields
    expect(data.meta.machineId).toBeTruthy();
    expect(data.meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.meta.branch).toBe('feat/handoff');
    expect(data.meta.schemaVersion).toBe(1);
  });

  it('falls back to machineId="unknown" in frontmatter (degrades gracefully)', async () => {
    // We cannot easily make computeMachineId throw, but we CAN verify that
    // when its result would be falsy, the renderer still emits a usable
    // YAML scalar. Render directly with a synthetic meta to lock the
    // contract — exercising the renderer's default branch.
    const synthetic = {
      meta: {
        machineId: '',
        createdAt: '2026-05-19T11:30:00.000Z',
        branch: null,
        schemaVersion: 1,
      },
      gitState: { ...{ branch: null, shortHash: null, modified: 0, staged: 0, untracked: 0, recentCommits: [], unpushed: null, lockedOut: false } },
      wip: { count: 0, oldestAgeMs: 0, advisory: null },
      quality: { exists: false, stale: false, ageHours: null, summary: null, warning: null },
      advisor: [],
      worklog: { date: null, lines: [] },
      sessionRecall: [],
      contextFiles: [],
      firstPrompts: [],
    };
    const md = renderHandoffMarkdown(synthetic, { now: FROZEN_NOW });
    expect(md).toMatch(/^machineId:\s+(unknown|'')/m);
  });
});

// ---------------------------------------------------------------------------
// deriveGitSyncStatus (pure — the commit/push guard core, v4.20)
// ---------------------------------------------------------------------------

describe('handoff-builder / deriveGitSyncStatus', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // Fixed clock so staleDays math is deterministic.
  const NOW = () => new Date(Date.UTC(2026, 5, 8, 12, 0, 0));
  const nowMs = NOW().getTime();

  function baseState(over = {}) {
    return {
      branch: 'master',
      shortHash: 'abc1234',
      modified: 0,
      staged: 0,
      untracked: 0,
      recentCommits: [],
      unpushed: 0,
      hasUpstream: true,
      behind: 0,
      localHeadAtMs: nowMs - 60_000, // fresh
      upstreamHeadAtMs: nowMs - 60_000,
      lockedOut: false,
      ...over,
    };
  }

  it('reports a fully clean, in-sync repo with no warnings or actions', () => {
    const s = deriveGitSyncStatus(baseState(), { now: NOW });
    expect(s.dirty).toBe(false);
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.otherMachineRisk).toBe(false);
    expect(s.warnings).toEqual([]);
    expect(s.actions).toEqual([]);
  });

  it('accepts now as a number, Date, function, or undefined without throwing (footgun guard)', () => {
    // Regression: callers naturally pass Date.now() (a number); the module treats
    // `now` as a clock function internally. asClock() must bridge both so /save
    // never crashes on the intuitive number input.
    const stale = baseState({ modified: 0, staged: 0, untracked: 0, localHeadAtMs: nowMs - 3 * DAY });
    const fromNumber = deriveGitSyncStatus(stale, { now: nowMs });
    const fromDate = deriveGitSyncStatus(stale, { now: new Date(nowMs) });
    const fromFn = deriveGitSyncStatus(stale, { now: NOW });
    expect(fromNumber.staleDays).toBe(3);
    expect(fromNumber.staleDays).toBe(fromFn.staleDays);
    expect(fromDate.staleDays).toBe(fromFn.staleDays);
    expect(() => deriveGitSyncStatus(stale, {})).not.toThrow();
  });

  it('flags a dirty working tree and proposes a commit action', () => {
    const s = deriveGitSyncStatus(baseState({ modified: 2, untracked: 1 }), { now: NOW });
    expect(s.dirty).toBe(true);
    expect(s.dirtyCount).toBe(3);
    expect(s.warnings.some((w) => /커밋되지 않은 변경 3개/.test(w))).toBe(true);
    const commit = s.actions.find((a) => a.kind === 'commit');
    expect(commit).toBeTruthy();
    expect(commit.confirm).toBe(true);
  });

  it('flags unpushed (ahead) commits and proposes a confirm-gated push action', () => {
    const s = deriveGitSyncStatus(baseState({ unpushed: 4 }), { now: NOW });
    expect(s.ahead).toBe(4);
    expect(s.warnings.some((w) => /미푸시 커밋 4개/.test(w))).toBe(true);
    const push = s.actions.find((a) => a.kind === 'push');
    expect(push).toBeTruthy();
    expect(push.confirm).toBe(true);
  });

  it('flags behind and proposes a pull action', () => {
    const s = deriveGitSyncStatus(baseState({ behind: 2 }), { now: NOW });
    expect(s.behind).toBe(2);
    expect(s.warnings.some((w) => /origin이 로컬보다 2개 앞섬/.test(w))).toBe(true);
    expect(s.actions.find((a) => a.kind === 'pull')).toBeTruthy();
  });

  it('surfaces a "GitHub is N days behind" warning when local HEAD outruns upstream', () => {
    const s = deriveGitSyncStatus(baseState({
      unpushed: 3,
      localHeadAtMs: nowMs,
      upstreamHeadAtMs: nowMs - 3 * DAY,
    }), { now: NOW });
    expect(s.githubLagDays).toBe(3);
    expect(s.warnings.some((w) => /GitHub가 로컬보다 약 3일 전/.test(w))).toBe(true);
  });

  it('detects the cross-machine risk: clean tree + nothing to push + stale local HEAD', () => {
    const s = deriveGitSyncStatus(baseState({
      modified: 0,
      staged: 0,
      untracked: 0,
      unpushed: 0,
      localHeadAtMs: nowMs - 3 * DAY,
      upstreamHeadAtMs: nowMs - 3 * DAY,
    }), { now: NOW });
    expect(s.otherMachineRisk).toBe(true);
    expect(s.staleDays).toBe(3);
    expect(s.warnings.some((w) => /다른 컴퓨터의 미푸시 작업/.test(w))).toBe(true);
    const fetch = s.actions.find((a) => a.kind === 'fetch');
    expect(fetch).toBeTruthy();
    expect(fetch.confirm).toBe(false); // advisory only, never auto-writes
  });

  it('does NOT flag cross-machine risk when the tree is dirty (active local work)', () => {
    const s = deriveGitSyncStatus(baseState({
      modified: 1,
      localHeadAtMs: nowMs - 5 * DAY,
    }), { now: NOW });
    expect(s.otherMachineRisk).toBe(false);
  });

  it('handles a missing upstream gracefully and advises -u push', () => {
    const s = deriveGitSyncStatus(baseState({
      hasUpstream: false,
      unpushed: 0,
      behind: 0,
      upstreamHeadAtMs: null,
    }), { now: NOW });
    expect(s.hasUpstream).toBe(false);
    expect(s.warnings.some((w) => /upstream\(origin\) 추적 브랜치 없음/.test(w))).toBe(true);
  });

  it('returns safe zeros for a null/degraded gitState', () => {
    const s = deriveGitSyncStatus(null, { now: NOW });
    expect(s.dirty).toBe(false);
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
    expect(s.otherMachineRisk).toBe(false);
    expect(s.warnings).toEqual([]);
    expect(s.actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Git sync collection + dashboard render (end-to-end through collectHandoffData)
// ---------------------------------------------------------------------------

describe('handoff-builder / git sync collection + render', () => {
  let pluginRoot;
  let projectRoot;

  beforeEach(() => {
    pluginRoot = makeTempRoot();
    projectRoot = makeTempRoot();
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('collects ahead/behind/timestamps and renders the §1 sync dashboard', async () => {
    const ahead2Git = mockGit({
      'rev-parse --abbrev-ref HEAD': 'master\n',
      'rev-parse --short HEAD': 'abc1234\n',
      'status --porcelain': '',
      'log -5 --format=%h|%s|%ar': 'abc1234|feat: x|2 hours ago\n',
      'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/master\n',
      'rev-list --count @{u}..HEAD': '2\n',
      'rev-list --count HEAD..@{u}': '0\n',
      'log -1 --format=%ct @{u}': '1000\n',
      'log -1 --format=%ct HEAD': '1000\n',
      'log -5 --name-only --pretty=format:': '',
    });
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: ahead2Git,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    expect(data.gitState.hasUpstream).toBe(true);
    expect(data.gitState.unpushed).toBe(2);
    expect(data.gitState.behind).toBe(0);
    expect(data.gitSync.ahead).toBe(2);

    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    expect(md).toContain('### Git 동기화 상태');
    expect(md).toContain('미푸시 커밋 (ahead)');
    expect(md).toMatch(/미푸시 커밋 2개/);
  });

  it('renders the in-sync affirmation when everything is clean', async () => {
    const cleanGit = mockGit({
      'rev-parse --abbrev-ref HEAD': 'master\n',
      'rev-parse --short HEAD': 'abc1234\n',
      'status --porcelain': '',
      'log -5 --format=%h|%s|%ar': 'abc1234|feat: x|2 hours ago\n',
      'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/master\n',
      'rev-list --count @{u}..HEAD': '0\n',
      'rev-list --count HEAD..@{u}': '0\n',
      'log -1 --format=%ct @{u}': String(Math.floor(FROZEN_NOW().getTime() / 1000)) + '\n',
      'log -1 --format=%ct HEAD': String(Math.floor(FROZEN_NOW().getTime() / 1000)) + '\n',
      'log -5 --name-only --pretty=format:': '',
    });
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: cleanGit,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    expect(data.gitSync.warnings).toEqual([]);
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    expect(md).toContain('커밋·푸시 동기화 정상');
  });

  it('degrades to a safe dashboard when git has no upstream', async () => {
    const noUpstreamGit = mockGit({
      'rev-parse --abbrev-ref HEAD': 'feat/local\n',
      'rev-parse --short HEAD': 'abc1234\n',
      'status --porcelain': ' M foo.js\n',
      'log -5 --format=%h|%s|%ar': 'abc1234|wip|1 hour ago\n',
      'rev-parse --abbrev-ref --symbolic-full-name @{u}': () => {
        throw new Error('fatal: no upstream configured for branch');
      },
      'log -1 --format=%ct HEAD': String(Math.floor(FROZEN_NOW().getTime() / 1000)) + '\n',
      'log -5 --name-only --pretty=format:': '',
    });
    const data = await collectHandoffData({
      pluginRoot,
      projectRoot,
      gitRunner: noUpstreamGit,
      taskList: [],
      firstPrompts: [],
      now: FROZEN_NOW,
    });
    expect(data.gitState.hasUpstream).toBe(false);
    const md = renderHandoffMarkdown(data, { now: FROZEN_NOW });
    expect(md).toContain('### Git 동기화 상태');
    expect(md).toMatch(/upstream 추적 \| ⚠️ 없음/);
  });
});
