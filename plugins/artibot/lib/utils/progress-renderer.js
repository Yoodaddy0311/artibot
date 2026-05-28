/**
 * Team progress rendering utilities.
 * Produces text-based progress bars and team status blocks
 * for use by /team command and orchestrator agents.
 * @module lib/utils/progress-renderer
 */

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const FULL = '█';  // █
const EMPTY = '░'; // ░
const SEPARATOR = '─'.repeat(48); // ────────────────────────────────────────────────

const DEFAULT_BAR_WIDTH = 16;
const MAX_MEMBERS = 50;

// ─────────────────────────────────────────────
// Progress bar
// ─────────────────────────────────────────────

/**
 * @param {number} percent - 0-100
 * @param {number} [width=16]
 * @returns {string}
 */
export function renderProgressBar(percent, width = DEFAULT_BAR_WIDTH) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return FULL.repeat(filled) + EMPTY.repeat(empty);
}

// ─────────────────────────────────────────────
// Team progress
// ─────────────────────────────────────────────

/**
 * @param {string} teamName
 * @param {{ name: string, description: string, progress: number, status: string }[]} members
 * @returns {string}
 */
export function renderTeamProgress(teamName, members) {
  const safe = members.slice(0, MAX_MEMBERS);
  const lines = [
    `TEAM PROGRESS — ${teamName}`,
    SEPARATOR,
    '',
  ];

  const nameWidth = Math.max(...safe.map((m) => m.name.length), 4);
  const descWidth = Math.max(...safe.map((m) => m.description.length), 4);

  for (let i = 0; i < safe.length; i++) {
    const m = safe[i];
    const idx = `#${i + 1}`;
    const name = m.name.padEnd(nameWidth);
    const desc = `(${m.description})`.padEnd(descWidth + 2);
    const bar = renderProgressBar(m.progress);
    const pct = m.progress === 100 ? '100%' : `~${m.progress}%`;
    lines.push(`${idx} ${name} ${desc} ${bar} ${pct}`);
  }

  const completed = safe.filter((m) => m.progress === 100).length;
  const total = safe.length;
  const overallPercent = total > 0
    ? Math.round(safe.reduce((sum, m) => sum + m.progress, 0) / total)
    : 0;

  lines.push('');
  lines.push(
    `전체: ${renderProgressBar(overallPercent)}  ${completed}/${total} 완료 (${overallPercent}%)`,
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Autopilot progress
// ─────────────────────────────────────────────

/**
 * @param {string} goal
 * @param {{ iteration: number, total: number, status: string, description: string }[]} iterations
 * @returns {string}
 */
export function renderAutopilotProgress(goal, iterations) {
  const total = iterations.length;
  const completed = iterations.filter((it) => it.status === 'completed').length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  const lines = [
    `AUTOPILOT — ${goal}`,
    SEPARATOR,
    '',
  ];

  for (const it of iterations) {
    const marker = it.status === 'completed' ? '[x]' : '[ ]';
    lines.push(`  ${marker} Iteration ${it.iteration}/${it.total}: ${it.description}`);
  }

  lines.push('');
  lines.push(`진행: ${renderProgressBar(percent)}  ${completed}/${total} (${percent}%)`);

  return lines.join('\n');
}
