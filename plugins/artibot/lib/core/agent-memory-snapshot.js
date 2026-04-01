/**
 * Agent Memory Snapshot — creates compressed session snapshots
 * for injection into sub-agent prompts.
 * @module lib/core/agent-memory-snapshot
 */

/** Maximum snapshot budget in estimated tokens */
const MAX_TOKENS = 500;

/** Maximum character budget (MAX_TOKENS * 4) */
const MAX_CHARS = 2000;

/**
 * Truncate a string to maxLen, appending ellipsis if truncated.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str ?? '';
  return str.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Estimate token count for a string (chars/4 + 1).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4) + 1;
}

/**
 * Create a compressed snapshot from session state.
 * All fields are optional — missing fields produce empty arrays/strings.
 * @param {object} sessionState
 * @param {string} [sessionState.taskDescription] - Current task description
 * @param {Array<{path: string, changeType: string}>} [sessionState.files] - Changed files
 * @param {Array<string>} [sessionState.decisions] - Recent decisions
 * @param {Array<{name: string, role: string}>} [sessionState.teammates] - Active teammates
 * @param {Array<string>} [sessionState.pending] - Pending tasks
 * @returns {object} Compressed snapshot (frozen)
 */
export function createSnapshot(sessionState) {
  const state = sessionState ?? {};

  const task = truncate(state.taskDescription ?? '', 150);

  const files = (state.files ?? [])
    .slice(0, 8)
    .map(f => ({ path: String(f.path ?? ''), changeType: String(f.changeType ?? 'modified') }));

  const decisions = (state.decisions ?? [])
    .slice(0, 3)
    .map(d => truncate(String(d), 160));

  const teammates = (state.teammates ?? [])
    .map(t => ({ name: String(t.name ?? ''), role: String(t.role ?? '') }));

  const pending = (state.pending ?? [])
    .map(p => truncate(String(p), 100));

  return Object.freeze({ task, files, decisions, teammates, pending });
}

/**
 * Format a snapshot as a prompt-injectable XML block.
 * @param {object} snapshot - Output from createSnapshot()
 * @returns {string} Formatted prompt string
 */
export function formatForPrompt(snapshot) {
  const s = snapshot ?? {};

  const filesStr = (s.files ?? [])
    .map(f => `  - ${f.path} (${f.changeType})`)
    .join('\n');

  const decisionsStr = (s.decisions ?? [])
    .map((d, i) => `  ${i + 1}. ${d}`)
    .join('\n');

  const teammatesStr = (s.teammates ?? [])
    .map(t => `  - ${t.name}: ${t.role}`)
    .join('\n');

  const pendingStr = (s.pending ?? [])
    .map(p => `  - ${p}`)
    .join('\n');

  const lines = [
    '<session-context>',
    `현재 작업: ${s.task ?? '(없음)'}`,
    `주요 파일:\n${filesStr || '  (없음)'}`,
    `최근 결정:\n${decisionsStr || '  (없음)'}`,
    `팀원:\n${teammatesStr || '  (없음)'}`,
    `미완료:\n${pendingStr || '  (없음)'}`,
    '</session-context>',
  ];

  let result = lines.join('\n');

  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS - 20) + '\n</session-context>';
  }

  return result;
}

/**
 * Estimate token cost of a snapshot object.
 * @param {object} snapshot - Output from createSnapshot()
 * @returns {number} Estimated token count
 */
export function estimateSnapshotTokens(snapshot) {
  return estimateTokens(formatForPrompt(snapshot));
}

/** Maximum token budget for snapshots */
export const SNAPSHOT_MAX_TOKENS = MAX_TOKENS;
