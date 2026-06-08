/**
 * Handoff Builder — collects current session state and renders a Korean
 * markdown handoff document for `/save`. Pure-data collection (no I/O on
 * the markdown side) plus a renderer that produces ANSI-free GFM.
 *
 * Public API:
 *   - collectHandoffData({ pluginRoot, projectRoot, gitRunner, taskList, now })
 *   - renderHandoffMarkdown(data, { now })
 *   - estimateStepDuration(step)
 *
 * All git/data collection is best-effort. Each helper traps errors and
 * returns a safe shape so render never breaks on a degraded environment.
 *
 * @module lib/handoff/handoff-builder
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { computeMachineId } from '../autopilot/cross-machine.js';
import {
  countWipCommits,
  formatAdvisoryLine,
  getOldestWipAgeMs,
  resolveThresholdsFromEnv,
} from '../autopilot/wip-stats.js';
import { getLastTestStatus } from '../core/test-status.js';
import { readPendingSuggestions } from '../learning/auto-spawn-advisor.js';
import { createSessionMemory } from '../learning/session-memory.js';

// ---------------------------------------------------------------------------
// Defaults / constants
// ---------------------------------------------------------------------------

// Safety #3: bound every git call so a stale .git/index.lock (or any
// long-running git) cannot stall /save. Mirrors the wip-stats execFileSync
// shape but adds a hard 5s timeout per invocation. Callers may override
// via the `gitRunner` option (used by tests + the cross-machine helpers).
const GIT_TIMEOUT_MS = 5_000;

const DEFAULT_GIT_RUNNER = (args, opts = {}) => execFileSync('git', args, {
  cwd: opts.cwd,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'ignore'],
  windowsHide: true,
  timeout: GIT_TIMEOUT_MS,
});

const ZERO_GIT_STATE = Object.freeze({
  branch: null,
  shortHash: null,
  modified: 0,
  staged: 0,
  untracked: 0,
  recentCommits: [],
  unpushed: null,
  // Sync-safety fields (v4.20 — /save commit+push guard). Each is null when the
  // corresponding git probe failed or there is no upstream, so the renderer can
  // distinguish "no upstream" from "in sync".
  hasUpstream: false,
  behind: null,
  localHeadAtMs: null,
  upstreamHeadAtMs: null,
  lockedOut: false,
});

// Heuristic threshold for the cross-machine staleness warning. A local HEAD
// older than STALE_HEAD_MS with a clean working tree is the exact shape of the
// "I worked on another machine and forgot to push" incident this guard targets.
const STALE_HEAD_MS = 24 * 60 * 60 * 1000; // 1 day

// Heuristic: identify a git failure caused by a timeout or an index lock so
// the renderer can flag §1 with a "잠금 감지" warning. Other failures (e.g.
// "not a git repo") leave lockedOut=false because they are environmental, not
// recoverable by waiting.
function isGitLockOrTimeout(err) {
  if (!err) return false;
  // Node's child_process surfaces timeouts as ETIMEDOUT or signal=SIGTERM.
  if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') return true;
  const text = String(err.message || err.stderr || '').toLowerCase();
  return text.includes('index.lock') || text.includes('unable to create') || text.includes('timed out');
}

// ---------------------------------------------------------------------------
// Project slug (mirrors session-end / worklog path convention)
// ---------------------------------------------------------------------------

/**
 * Convert an absolute project path to the slug used in
 * `~/.claude/projects/<slug>/memory/worklog.md`. Replaces drive separators
 * and path separators with `-`, matching Claude Code's directory layout.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function toProjectSlug(projectRoot) {
  if (!projectRoot) return '';
  return String(projectRoot)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):\//, '$1-')
    .replace(/:/g, '-')
    .replace(/\//g, '-');
}

// ---------------------------------------------------------------------------
// Git collection (best-effort)
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain` output into mod/staged/untracked counts.
 * @param {string} stdout
 * @returns {{ modified: number, staged: number, untracked: number }}
 */
function parsePorcelain(stdout) {
  let modified = 0;
  let staged = 0;
  let untracked = 0;
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const code = raw.slice(0, 2);
    if (code === '??') untracked += 1;
    else {
      if (code[0] && code[0] !== ' ' && code[0] !== '?') staged += 1;
      if (code[1] && code[1] !== ' ' && code[1] !== '?') modified += 1;
    }
  }
  return { modified, staged, untracked };
}

/**
 * Parse `git log -5 --format=%h|%s|%ar` output into commit records.
 * @param {string} stdout
 * @returns {Array<{ hash: string, subject: string, ago: string }>}
 */
function parseRecentCommits(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    out.push({ hash: parts[0], subject: parts.slice(1, -1).join('|'), ago: parts[parts.length - 1] });
  }
  return out;
}

/**
 * Collect git state. Each step is independent and traps errors. Safety #3:
 * a per-call failure caused by a timeout or `.git/index.lock` flips
 * `state.lockedOut` so the renderer can surface a warning in §1 — but every
 * other section keeps writing on best-effort data.
 *
 * @param {(args: string[], opts?: object) => string} git
 * @param {string} cwd
 * @returns {{ branch, shortHash, modified, staged, untracked, recentCommits, unpushed, lockedOut }}
 */
function collectGitState(git, cwd) {
  const state = { ...ZERO_GIT_STATE, recentCommits: [] };
  const trap = (fn) => {
    try { fn(); } catch (err) {
      if (isGitLockOrTimeout(err)) state.lockedOut = true;
    }
  };
  trap(() => { state.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).trim() || null; });
  trap(() => { state.shortHash = git(['rev-parse', '--short', 'HEAD'], { cwd }).trim() || null; });
  trap(() => {
    const porcelain = git(['status', '--porcelain'], { cwd });
    Object.assign(state, parsePorcelain(porcelain));
  });
  trap(() => {
    const log = git(['log', '-5', '--format=%h|%s|%ar'], { cwd });
    state.recentCommits = parseRecentCommits(log);
  });
  // Detect whether the current branch has an upstream. `rev-parse @{u}` exits
  // non-zero with "no upstream configured" when none exists — we treat the
  // success path as the upstream gate for all subsequent ahead/behind probes.
  trap(() => {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd }).trim();
    state.hasUpstream = upstream.length > 0;
  });
  if (state.hasUpstream) {
    trap(() => {
      const ahead = git(['rev-list', '--count', '@{u}..HEAD'], { cwd }).trim();
      const n = Number(ahead);
      state.unpushed = Number.isFinite(n) ? n : null;
    });
    trap(() => {
      const behind = git(['rev-list', '--count', 'HEAD..@{u}'], { cwd }).trim();
      const n = Number(behind);
      state.behind = Number.isFinite(n) ? n : null;
    });
    trap(() => {
      // Committer date (epoch seconds) of the upstream tip — used to surface a
      // "GitHub is N days behind" message without a network fetch (reflects the
      // last-fetched remote-tracking ref, which is exactly what /resume sees).
      const sec = Number(git(['log', '-1', '--format=%ct', '@{u}'], { cwd }).trim());
      state.upstreamHeadAtMs = Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
    });
  }
  trap(() => {
    const sec = Number(git(['log', '-1', '--format=%ct', 'HEAD'], { cwd }).trim());
    state.localHeadAtMs = Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
  });
  return state;
}

// ---------------------------------------------------------------------------
// Sync status derivation (pure — testable without git)
// ---------------------------------------------------------------------------

/**
 * Pluralize a millisecond gap into a coarse day count, floored. Sub-day gaps
 * return 0. Used for human-readable "N일 전" messaging.
 * @param {number} ms
 * @returns {number}
 */
function msToDays(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Derive the git-sync dashboard + recommended actions from a collected
 * gitState. Pure function — no git, no I/O — so the exact warning/action logic
 * is unit-testable. Every field is defensive against partial/degraded state.
 *
 * The cross-machine heuristic (`otherMachineRisk`) targets the real incident:
 * a clean working tree whose local HEAD is older than STALE_HEAD_MS while the
 * upstream tip is OLDER STILL (or unknown) strongly suggests work was committed
 * on another machine and never pushed here — so this checkout cannot see it.
 *
 * @param {object} gitState — shape of {@link ZERO_GIT_STATE}
 * @param {{ now?: () => Date }} [opts]
 * @returns {{
 *   dirty: boolean,
 *   dirtyCount: number,
 *   ahead: number,
 *   behind: number,
 *   hasUpstream: boolean,
 *   staleDays: number,
 *   githubLagDays: number,
 *   otherMachineRisk: boolean,
 *   warnings: string[],
 *   actions: Array<{ kind: string, label: string, confirm: boolean }>,
 * }}
 */
export function deriveGitSyncStatus(gitState, opts = {}) {
  const g = gitState ?? ZERO_GIT_STATE;
  const now = (opts.now ?? (() => new Date()))().getTime();

  const dirtyCount = (g.modified || 0) + (g.staged || 0) + (g.untracked || 0);
  const dirty = dirtyCount > 0;
  const ahead = Number.isFinite(g.unpushed) ? g.unpushed : 0;
  const behind = Number.isFinite(g.behind) ? g.behind : 0;
  const hasUpstream = g.hasUpstream === true;

  const staleDays = Number.isFinite(g.localHeadAtMs)
    ? msToDays(now - g.localHeadAtMs)
    : 0;
  const githubLagDays = (Number.isFinite(g.localHeadAtMs) && Number.isFinite(g.upstreamHeadAtMs))
    ? msToDays(g.localHeadAtMs - g.upstreamHeadAtMs)
    : 0;

  // Cross-machine risk: clean tree + nothing to push here + a stale local HEAD.
  // If upstream is also stale (or unknown), the freshest work is likely sitting
  // unpushed on another machine. We never assert it — we flag it for a manual
  // check (git fetch / log on the other box).
  const localHeadAgeMs = Number.isFinite(g.localHeadAtMs) ? now - g.localHeadAtMs : -1;
  const otherMachineRisk = !dirty
    && ahead === 0
    && localHeadAgeMs >= STALE_HEAD_MS;

  const warnings = [];
  const actions = [];

  if (dirty) {
    warnings.push(`커밋되지 않은 변경 ${dirtyCount}개 — 세션 종료 전 커밋 권장`);
    actions.push({ kind: 'commit', label: `변경 ${dirtyCount}개 커밋하기`, confirm: true });
  }
  if (ahead > 0) {
    warnings.push(`로컬에 미푸시 커밋 ${ahead}개 — GitHub에 아직 올라가지 않음`);
    actions.push({ kind: 'push', label: `미푸시 커밋 ${ahead}개 푸시하기`, confirm: true });
  }
  if (behind > 0) {
    warnings.push(`origin이 로컬보다 ${behind}개 앞섬 — pull 필요`);
    actions.push({ kind: 'pull', label: `origin에서 ${behind}개 가져오기 (pull)`, confirm: true });
  }
  if (githubLagDays >= 1) {
    warnings.push(`GitHub가 로컬보다 약 ${githubLagDays}일 전 상태 — 푸시 누락 가능성`);
  }
  if (otherMachineRisk) {
    warnings.push(
      `로컬 HEAD가 ${staleDays}일 전인데 워킹트리는 깨끗 — 다른 컴퓨터의 미푸시 작업이 있을 수 있음. `
      + '`git fetch` 후 다른 머신 상태 확인 권장',
    );
    actions.push({ kind: 'fetch', label: '다른 머신 작업 확인 (git fetch + 비교)', confirm: false });
  }
  if (!hasUpstream && (dirty || (g.localHeadAtMs !== null && g.localHeadAtMs !== undefined))) {
    warnings.push('upstream(origin) 추적 브랜치 없음 — 푸시 시 `-u`로 upstream 설정 필요');
  }

  return {
    dirty,
    dirtyCount,
    ahead,
    behind,
    hasUpstream,
    staleDays,
    githubLagDays,
    otherMachineRisk,
    warnings,
    actions,
  };
}

// ---------------------------------------------------------------------------
// WIP / Quality / Advisor / Worklog / Recall
// ---------------------------------------------------------------------------

function collectWipState(cwd) {
  try {
    const count = countWipCommits('HEAD', { cwd });
    const ageMs = getOldestWipAgeMs('HEAD', { cwd });
    const thresholds = resolveThresholdsFromEnv();
    const advisory = formatAdvisoryLine(count, ageMs, thresholds);
    return { count, oldestAgeMs: ageMs, advisory: advisory ?? null };
  } catch {
    return { count: 0, oldestAgeMs: 0, advisory: null };
  }
}

function collectQualityState(pluginRoot) {
  try {
    return getLastTestStatus(pluginRoot);
  } catch {
    return { exists: false, stale: false, ageHours: null, summary: null, warning: null };
  }
}

async function collectAdvisorState(pluginRoot) {
  try {
    const pending = await readPendingSuggestions(pluginRoot);
    return Array.isArray(pending) ? pending : [];
  } catch {
    return [];
  }
}

/**
 * Read the most recent `## YYYY-MM-DD` section from worklog.md. Returns the
 * raw section body lines (without the date heading) and the matched date.
 *
 * @param {string} projectRoot
 * @returns {{ date: string|null, lines: string[] }}
 */
function collectWorklog(projectRoot) {
  try {
    const slug = toProjectSlug(projectRoot);
    const home = os.homedir();
    const worklogPath = path.join(home, '.claude', 'projects', slug, 'memory', 'worklog.md');
    if (!existsSync(worklogPath)) return { date: null, lines: [] };
    const text = readFileSync(worklogPath, 'utf-8');
    const dateRe = /^##\s+(\d{4}-\d{2}-\d{2})/gm;
    const matches = [...text.matchAll(dateRe)];
    if (matches.length === 0) return { date: null, lines: [] };
    const last = matches[matches.length - 1];
    const start = last.index + last[0].length;
    const nextIdx = text.indexOf('\n## ', start);
    const body = nextIdx >= 0 ? text.slice(start, nextIdx) : text.slice(start);
    return { date: last[1], lines: body.split('\n').map((l) => l.trim()).filter(Boolean) };
  } catch {
    return { date: null, lines: [] };
  }
}

async function collectSessionRecall(projectRoot) {
  try {
    const mem = createSessionMemory();
    const out = await mem.recall(String(projectRoot || ''), 3);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Context files (recent touches)
// ---------------------------------------------------------------------------

/**
 * Top 5 recently-touched files derived from `git log --name-only -5` plus
 * working-tree modifications. Returns `file` strings without line numbers
 * since cheap line resolution is not always possible.
 *
 * @param {(args: string[], opts?: object) => string} git
 * @param {string} cwd
 * @returns {string[]}
 */
function collectContextFiles(git, cwd) {
  const counts = new Map();
  try {
    const out = git(['log', '-5', '--name-only', '--pretty=format:'], { cwd });
    for (const raw of out.split('\n')) {
      const f = raw.trim();
      if (!f) continue;
      counts.set(f, (counts.get(f) || 0) + 1);
    }
  } catch { /* noop */ }
  try {
    const porcelain = git(['status', '--porcelain'], { cwd });
    for (const raw of porcelain.split('\n')) {
      const f = raw.slice(3).trim();
      if (!f) continue;
      counts.set(f, (counts.get(f) || 0) + 5); // bias toward modified files
    }
  } catch { /* noop */ }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f]) => f);
}

// ---------------------------------------------------------------------------
// estimateStepDuration
// ---------------------------------------------------------------------------

/**
 * Heuristic duration bucket for a next-step description string.
 *
 * Buckets:
 *   - `~5m`  : "PR 응답" / "PR response"
 *   - `~15m` : "리뷰", "review", "승인", "approval"
 *   - `~30m` : "릴리스", "release", "배포", "deploy", or fallback
 *   - `~1h`  : "구현", "implement"
 *   - `~2h+` : "refactor", "리팩토"
 *
 * @param {string} step
 * @returns {'~5m'|'~15m'|'~30m'|'~1h'|'~2h+'}
 */
export function estimateStepDuration(step) {
  const s = String(step ?? '').toLowerCase();
  if (!s) return '~30m';
  if (/\bpr\b.*응답|pr response|respond to pr/.test(s)) return '~5m';
  if (/refactor|리팩토/.test(s)) return '~2h+';
  if (/구현|implement/.test(s)) return '~1h';
  if (/리뷰|review|승인|approval/.test(s)) return '~15m';
  if (/릴리스|release|배포|deploy/.test(s)) return '~30m';
  return '~30m';
}

// ---------------------------------------------------------------------------
// Public: collectHandoffData
// ---------------------------------------------------------------------------

/**
 * Collect every data source needed to render a handoff doc. All branches
 * fail soft — caller never has to wrap in try/catch.
 *
 * @param {object} options
 * @param {string} options.pluginRoot
 * @param {string} options.projectRoot
 * @param {(args: string[], opts?: object) => string} [options.gitRunner]
 * @param {Array<object>} [options.taskList]
 * @param {Array<{ prompt: string, rationale: string, priority: string }>} [options.firstPrompts]
 * @param {() => Date} [options.now]
 * @returns {Promise<object>}
 */
/**
 * Build the `meta` block emitted into the handoff. Safety #2 stamps a stable
 * `machineId`, an ISO `createdAt`, the current branch, and a `schemaVersion`
 * so the YAML frontmatter is purely deterministic. Failures are soft —
 * computeMachineId() already returns `'unknown'` on lookup errors.
 *
 * @param {{ branch: string|null }} gitState
 * @param {() => Date} now
 * @param {number} tsStart
 * @returns {object}
 */
function buildMetaBlock(gitState, now, tsStart) {
  let machineId = 'unknown';
  try {
    const id = computeMachineId();
    if (typeof id === 'string' && id) machineId = id;
  } catch { /* keep default */ }
  const createdAt = now().toISOString();
  return {
    generatedAt: createdAt,
    generator: 'artibot/handoff-builder',
    elapsedMs: Date.now() - tsStart,
    sources: ['git', 'wip', 'quality', 'tasks', 'advisor', 'worklog', 'session-recall'],
    machineId,
    createdAt,
    branch: gitState.branch ?? null,
    schemaVersion: 1,
  };
}

export async function collectHandoffData(options) {
  const { pluginRoot, projectRoot } = options ?? {};
  const git = options?.gitRunner ?? DEFAULT_GIT_RUNNER;
  const taskList = Array.isArray(options?.taskList) ? options.taskList : [];
  const firstPrompts = Array.isArray(options?.firstPrompts) ? options.firstPrompts : [];
  const now = options?.now ?? (() => new Date());
  const tsStart = Date.now();
  const cwd = projectRoot || pluginRoot;

  const gitState = collectGitState(git, cwd);
  const gitSync = deriveGitSyncStatus(gitState, { now });
  const wip = collectWipState(cwd);
  const quality = collectQualityState(pluginRoot);
  const advisor = await collectAdvisorState(pluginRoot);
  const worklog = collectWorklog(projectRoot);
  const sessionRecall = await collectSessionRecall(projectRoot);
  const contextFiles = collectContextFiles(git, cwd);
  const meta = buildMetaBlock(gitState, now, tsStart);

  return {
    meta,
    gitState,
    gitSync,
    wip,
    quality,
    tasks: taskList,
    advisor,
    worklog,
    sessionRecall,
    contextFiles,
    firstPrompts,
  };
}

// ---------------------------------------------------------------------------
// Markdown render
// ---------------------------------------------------------------------------

/**
 * Pad a number with a leading zero for time formatting.
 * @param {number} n
 * @returns {string}
 */
function pad2(n) { return String(n).padStart(2, '0'); }

function formatHeaderTimestamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function summaryLineFromPrompts(firstPrompts) {
  if (!firstPrompts || firstPrompts.length === 0) return '다음 P0: (없음 — 작업 마감 가능)';
  const top = firstPrompts[0];
  return `다음 ${top.priority || 'P0'}: ${top.prompt}`;
}

function renderStateTable(data) {
  const g = data.gitState ?? ZERO_GIT_STATE;
  const tree = `mod ${g.modified} / staged ${g.staged} / untracked ${g.untracked}`;
  const wipCell = data.wip?.count > 0
    ? `${data.wip.count}개 (oldest ${Math.round((data.wip.oldestAgeMs || 0) / 60000)}m)`
    : '0';
  const testCell = data.quality?.summary
    ? `${data.quality.summary.passed}/${data.quality.summary.totalTests} pass`
    : '(no data)';
  const lintCell = data.quality?.summary && data.quality.summary.failed === 0 ? 'OK' : '(check)';
  const unpushed = data.gitState?.unpushed !== null && data.gitState?.unpushed !== undefined
    ? String(data.gitState.unpushed)
    : '(no-upstream)';
  const rows = [
    '| 항목 | 값 |',
    '|---|---|',
    `| Branch | \`${g.branch ?? '(unknown)'}\` @ \`${g.shortHash ?? '----'}\` |`,
    `| Tree | ${tree} |`,
    `| WIP | ${wipCell} |`,
    `| Tests | ${testCell} |`,
    `| Lint | ${lintCell} |`,
    `| Unpushed | ${unpushed} |`,
  ];
  // Safety #3: surface git lock / timeout so the user sees that §1 may be
  // partial. The warning sits above the table so it cannot be missed.
  if (g.lockedOut) {
    return [
      '> [!WARNING] Git 잠금 감지 — 일부 정보 누락 (index.lock 또는 timeout)',
      '',
      ...rows,
    ].join('\n');
  }
  return rows.join('\n');
}

/**
 * Render the Git 동기화 상태 dashboard + recommended actions. Lives inside §1
 * so the existing `## 1.` / `## 5.` banner regex stays stable. Returns an empty
 * string only when there is genuinely nothing to report AND no upstream data —
 * otherwise it always emits a one-line "in sync" affirmation so the user gets a
 * positive signal that the push state was checked.
 *
 * @param {{ gitSync?: object, gitState?: object }} data
 * @returns {string}
 */
function renderSyncDashboard(data) {
  const sync = data.gitSync;
  if (!sync) return '';

  const cell = (v) => (v === true ? '⚠️ 예' : '아니오');
  const aheadCell = sync.ahead > 0 ? `⚠️ ${sync.ahead}` : '0';
  const behindCell = sync.behind > 0 ? `⚠️ ${sync.behind}` : '0';
  const upstreamCell = sync.hasUpstream ? '있음' : '⚠️ 없음';
  const lagCell = sync.githubLagDays >= 1 ? `⚠️ ~${sync.githubLagDays}일` : '최신';

  const table = [
    '### Git 동기화 상태',
    '',
    '| 점검 항목 | 상태 |',
    '|---|---|',
    `| 커밋 안 된 변경 | ${cell(sync.dirty)}${sync.dirty ? ` (${sync.dirtyCount}개)` : ''} |`,
    `| 미푸시 커밋 (ahead) | ${aheadCell} |`,
    `| pull 필요 (behind) | ${behindCell} |`,
    `| upstream 추적 | ${upstreamCell} |`,
    `| GitHub 최신성 | ${lagCell} |`,
    `| 다른 머신 미동기화 의심 | ${cell(sync.otherMachineRisk)} |`,
  ];

  const blocks = [table.join('\n')];

  if (sync.warnings.length > 0) {
    const warnLines = sync.warnings.map((w) => `> [!WARNING] ${w}`);
    blocks.push(warnLines.join('\n'));
  }

  if (sync.actions.length > 0) {
    const actLines = ['**권장 액션** (push/commit은 반드시 확인 후 실행):'];
    for (const a of sync.actions) {
      const guard = a.confirm ? ' _(확인 필요)_' : '';
      actLines.push(`- ${a.label}${guard}`);
    }
    blocks.push(actLines.join('\n'));
  } else if (sync.warnings.length === 0) {
    blocks.push('> ✅ 커밋·푸시 동기화 정상 — 유실 위험 없음');
  }

  return blocks.join('\n\n');
}

function renderRecentCommits(commits) {
  if (!commits || commits.length === 0) return '_커밋 없음_';
  const rows = commits.map((c) => `- \`${c.hash}\` ${c.subject} _(${c.ago})_`);
  return rows.join('\n');
}

function renderImmediateSteps(firstPrompts) {
  if (!firstPrompts || firstPrompts.length === 0) {
    return '_(없음 — 다음 세션 시작 시 추가 추론)_';
  }
  const rows = ['| 우선순위 | 항목 | 근거 | 예상 |', '|---|---|---|---|'];
  for (const p of firstPrompts) {
    rows.push(`| ${p.priority || 'P2'} | ${p.prompt} | ${p.rationale || '(추론)'} | ${estimateStepDuration(p.prompt)} |`);
  }
  return rows.join('\n');
}

function renderUnresolved(data) {
  const lines = [];
  for (const s of data.advisor ?? []) {
    if (s?.resolved) continue;
    lines.push(`- [advisor:${s.category}] ${s.reason}`);
  }
  for (const l of data.worklog?.lines ?? []) {
    if (/보류|pending|blocked|todo/i.test(l)) lines.push(`- [worklog] ${l}`);
  }
  if (data.wip?.advisory) lines.push(`- [wip] ${data.wip.advisory} → \`/squash\` 권장`);
  return lines.length > 0 ? lines.join('\n') : '_(없음)_';
}

function renderFirstPrompts(firstPrompts) {
  if (!firstPrompts || firstPrompts.length === 0) return '_(다음 세션 시작 시 자동 생성됨)_';
  return firstPrompts.map((p, i) => `${i + 1}. **${p.priority}** — \`${p.prompt}\`\n   > ${p.rationale || '(추론)'}`).join('\n');
}

function renderContextFiles(files) {
  if (!files || files.length === 0) return '_(없음)_';
  return files.map((f) => `- \`${f}\``).join('\n');
}

function renderMeta(data, now) {
  const m = data.meta || {};
  const stamp = formatHeaderTimestamp(now());
  return `> 생성: ${stamp} · 소요: ${m.elapsedMs ?? 0}ms · sources: ${(m.sources || []).join('+')}`;
}

/**
 * Sanitize a YAML scalar value so frontmatter parsers can read it safely.
 * Strips control chars + newlines and clamps length to 256 — values that
 * exceed that limit are uncommon and not worth quoting/escaping.
 * @param {unknown} v
 * @returns {string}
 */
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  // Strip ASCII control chars (0x00-0x1F) and clamp length to 256.
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\x00-\x1f]+/g, ' ').slice(0, 256);
  if (s === '') return "''";
  // Wrap in single quotes only when it contains YAML-significant chars
  // or starts/ends with whitespace (YAML 1.2 chomping ambiguity).
  // eslint-disable-next-line no-useless-escape
  if (/[:#\[\]{}&*!|>'"%@`,?\-]/.test(s) || /^\s|\s$/.test(s)) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

/**
 * Build the YAML frontmatter block consumed by /resume and external audit
 * tools. Fields stay schema-stable: bumping anything beyond the documented
 * keys requires a `schemaVersion` increment.
 * @param {object} meta
 * @returns {string}
 */
function renderFrontmatter(meta) {
  const m = meta || {};
  return [
    '---',
    `machineId: ${yamlScalar(m.machineId ?? 'unknown')}`,
    `createdAt: ${yamlScalar(m.createdAt ?? new Date().toISOString())}`,
    `branch: ${yamlScalar(m.branch ?? null)}`,
    'generator: artibot-handoff',
    `schemaVersion: ${Number.isFinite(m.schemaVersion) ? m.schemaVersion : 1}`,
    '---',
    '',
  ].join('\n');
}

/**
 * Render the complete handoff markdown. No ANSI codes, no shell escapes.
 * Output begins with a YAML frontmatter block (Safety #2) followed by the
 * existing Korean section layout — downstream parsers must skip frontmatter
 * before scanning for `## N.` headings.
 *
 * @param {object} data — from {@link collectHandoffData}
 * @param {{ now?: () => Date }} [options]
 * @returns {string}
 */
export function renderHandoffMarkdown(data, options = {}) {
  const now = options.now ?? (() => new Date());
  const ts = formatHeaderTimestamp(now());
  const summary = summaryLineFromPrompts(data?.firstPrompts);
  const frontmatter = renderFrontmatter(data?.meta);

  const sections = [
    frontmatter,
    `# HANDOFF — ${ts}`,
    '',
    `> ${summary}`,
    '',
    '## 1. 지금 상태',
    '',
    renderStateTable(data),
    '',
    renderSyncDashboard(data),
    '',
    '## 2. 이번 세션 한 일',
    '',
    renderRecentCommits(data?.gitState?.recentCommits),
    '',
    '## 3. 의도/현재 가설',
    '',
    '_(다음 세션 시작 시 채우거나 git/task에서 추론)_',
    '',
    '## 4. 즉시 진행할 일',
    '',
    renderImmediateSteps(data?.firstPrompts),
    '',
    '## 5. 미해결 결정/질문',
    '',
    renderUnresolved(data),
    '',
    '## 6. 다음 세션 첫 프롬프트 후보',
    '',
    renderFirstPrompts(data?.firstPrompts),
    '',
    '## 7. 컨텍스트 복원 핵심 파일',
    '',
    renderContextFiles(data?.contextFiles),
    '',
    '## 8. 메타',
    '',
    renderMeta(data, now),
    '',
  ];
  return sections.join('\n');
}
