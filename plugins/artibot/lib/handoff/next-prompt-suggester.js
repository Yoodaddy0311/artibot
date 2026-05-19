/**
 * Next-Prompt Suggester — derives 1-3 first-session prompts from the
 * current handoff signals (tasks, WIP, advisor pending, git status,
 * recent commits). Pure function — no I/O.
 *
 * Priority ladder (mirrors `/daily` Next Steps algorithm):
 *   P0  in_progress task                → `/team P0 <subject>`
 *   P0  recent `PR #N` reference        → `/team P0 PR #N 리뷰 응답`
 *   P1  pending task without blockedBy  → `/team <subject>`
 *   P2  WIP overflow (count or age)     → `/squash`
 *   P3  untracked > 5                   → `/git status 확인 후 정리`
 *
 * Stable sort: priority asc, then input order.
 *
 * @module lib/handoff/next-prompt-suggester
 */

const PRIORITY_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });
const DEFAULT_MAX = 3;
const WIP_COUNT_THRESHOLD = 10;
const WIP_AGE_MS_THRESHOLD = 4 * 60 * 60 * 1000;
const UNTRACKED_THRESHOLD = 5;
const PR_PATTERN = /\bPR\s*#(\d+)\b/i;

// ---------------------------------------------------------------------------
// Per-source collectors (each returns 0..N suggestions in input order)
// ---------------------------------------------------------------------------

/**
 * @param {Array<object>} tasks
 * @returns {Array<{ prompt, rationale, priority, _ord }>}
 */
function suggestFromTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  const out = [];
  let ord = 0;
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    const subject = String(t.subject ?? t.title ?? t.id ?? '').trim();
    if (!subject) continue;
    if (t.status === 'in_progress') {
      out.push({
        prompt: `/team P0 ${subject}`,
        rationale: `진행 중 task #${t.id ?? '?'}`,
        priority: 'P0',
        _ord: ord,
      });
    } else if (t.status === 'pending' && (!Array.isArray(t.blockedBy) || t.blockedBy.length === 0)) {
      out.push({
        prompt: `/team ${subject}`,
        rationale: `대기 task #${t.id ?? '?'} (blocker 없음)`,
        priority: 'P1',
        _ord: ord,
      });
    }
    ord += 1;
  }
  return out;
}

/**
 * @param {Array<{ hash?: string, subject?: string }>} commits
 * @returns {Array<{ prompt, rationale, priority, _ord }>}
 */
function suggestFromCommits(commits) {
  if (!Array.isArray(commits)) return [];
  const out = [];
  let ord = 0;
  for (const c of commits) {
    const subject = String(c?.subject ?? '');
    const m = subject.match(PR_PATTERN);
    if (m) {
      out.push({
        prompt: `/team P0 PR #${m[1]} 리뷰 응답`,
        rationale: `recent commit \`${c?.hash ?? ''}\` PR #${m[1]} 참조`,
        priority: 'P0',
        _ord: ord,
      });
    }
    ord += 1;
  }
  return out;
}

/**
 * @param {{ count?: number, oldestAgeMs?: number }|undefined} wip
 * @returns {Array<{ prompt, rationale, priority, _ord }>}
 */
function suggestFromWip(wip) {
  if (!wip || typeof wip !== 'object') return [];
  const count = Number(wip.count) || 0;
  const age = Number(wip.oldestAgeMs) || 0;
  if (count < WIP_COUNT_THRESHOLD && age < WIP_AGE_MS_THRESHOLD) return [];
  const reason = count >= WIP_COUNT_THRESHOLD
    ? `WIP 누적 ${count}개`
    : `oldest WIP ${(age / 3_600_000).toFixed(1)}h`;
  return [{
    prompt: '/squash',
    rationale: `${reason} → 푸시 전 정리`,
    priority: 'P2',
    _ord: 0,
  }];
}

/**
 * @param {{ untracked?: number }|undefined} gitStatus
 * @returns {Array<{ prompt, rationale, priority, _ord }>}
 */
function suggestFromGit(gitStatus) {
  if (!gitStatus || typeof gitStatus !== 'object') return [];
  const untracked = Number(gitStatus.untracked) || 0;
  if (untracked <= UNTRACKED_THRESHOLD) return [];
  return [{
    prompt: '/git status 확인 후 정리',
    rationale: `untracked ${untracked}개 (>${UNTRACKED_THRESHOLD})`,
    priority: 'P3',
    _ord: 0,
  }];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose first-prompt candidates from the supplied signals.
 *
 * @param {object} signals
 * @param {Array<object>} [signals.unresolved] — reserved for future use
 * @param {{ count?: number, oldestAgeMs?: number }} [signals.wip]
 * @param {Array<object>} [signals.advisorSignals] — reserved for future use
 * @param {Array<{ id?, subject?, status?, blockedBy? }>} [signals.tasks]
 * @param {{ untracked?: number }} [signals.gitStatus]
 * @param {Array<{ hash?, subject? }>} [signals.recentCommits]
 * @param {{ max?: number }} [options]
 * @returns {Array<{ prompt: string, rationale: string, priority: 'P0'|'P1'|'P2'|'P3' }>}
 */
export function suggestFirstPrompts(signals, options = {}) {
  const max = Number.isFinite(options?.max) && options.max > 0 ? Math.floor(options.max) : DEFAULT_MAX;
  const s = signals ?? {};

  const combined = [
    ...suggestFromTasks(s.tasks),
    ...suggestFromCommits(s.recentCommits),
    ...suggestFromWip(s.wip),
    ...suggestFromGit(s.gitStatus),
  ];

  // Stable sort: priority asc, then preserve input order via index tag.
  const tagged = combined.map((item, idx) => ({ item, idx }));
  tagged.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.item.priority] ?? 9;
    const pb = PRIORITY_ORDER[b.item.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.idx - b.idx;
  });

  return tagged.slice(0, max).map(({ item }) => ({
    prompt: item.prompt,
    rationale: item.rationale,
    priority: item.priority,
  }));
}

// Internal constants exposed for test introspection.
export const _internals = Object.freeze({
  PRIORITY_ORDER,
  DEFAULT_MAX,
  WIP_COUNT_THRESHOLD,
  WIP_AGE_MS_THRESHOLD,
  UNTRACKED_THRESHOLD,
  PR_PATTERN,
});
