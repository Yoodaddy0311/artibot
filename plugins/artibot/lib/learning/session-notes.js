/**
 * Session Notes — append-only timeline log of artibot working sessions.
 *
 * Companion to Claude's auto-memory system:
 *   - Memory (`~/.claude/projects/<p>/memory/`) holds PERMANENT facts:
 *     user profile, feedback rules, project decisions.
 *   - SESSION-NOTES.md holds TIMELINE EVENTS: which commits, which files,
 *     which branch. One entry per Stop hook firing.
 *
 * The file is committed to git, so it propagates across machines via the
 * normal autopilot push/pull cycle — unlike memory which is per-machine.
 *
 * Pure logic only — file I/O and git invocations live in the hook script
 * so this module stays unit-testable without subprocesses.
 *
 * @module lib/learning/session-notes
 */

/**
 * Render a single session entry as markdown.
 *
 * @param {object} meta
 * @param {string} meta.timestamp ISO-8601 (e.g. "2026-05-16T14:32:11Z")
 * @param {string} meta.branch current git branch
 * @param {Array<{sha:string, subject:string}>} meta.commits NEW commits since last entry
 * @param {number} meta.filesChanged count of unique files touched in those commits
 * @param {number} meta.wipSquashed WIP commits squashed by close hook (0 if none)
 * @returns {string} markdown fragment (no leading/trailing newlines)
 */
export function formatEntry(meta) {
  const { timestamp, branch, commits, filesChanged, wipSquashed } = meta;
  const displayTs = formatTimestamp(timestamp);
  const lines = [];
  lines.push(`## ${displayTs} · \`${branch}\``);
  lines.push('');
  if (commits.length > 0) {
    lines.push(`- **Commits** (${commits.length}):`);
    for (const c of commits) {
      const shortSha = c.sha.slice(0, 7);
      lines.push(`  - \`${shortSha}\` ${c.subject}`);
    }
  } else {
    lines.push('- **Commits**: none');
  }
  lines.push(`- **Files touched**: ${filesChanged}`);
  if (wipSquashed > 0) {
    lines.push(`- **WIP commits squashed**: ${wipSquashed}`);
  }
  lines.push('');
  lines.push('<!-- 메모: 결정·의도를 한 줄로 여기에 추가 가능 -->');
  return lines.join('\n');
}

/**
 * Convert ISO timestamp to a human-readable display form.
 * Uses UTC + "Z" suffix to avoid timezone confusion across machines.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * Standard header inserted when SESSION-NOTES.md is first created.
 * Includes a brief explainer so future readers (or other PCs) know what
 * this file is for without reading the module source.
 *
 * @returns {string}
 */
export function fileHeader() {
  return [
    '# Artibot Session Notes',
    '',
    '> Auto-generated timeline of artibot sessions. **Memory** holds permanent',
    '> facts (user profile, feedback rules); **this file** holds per-session',
    '> events (commits, files, branch). Committed to git → shared across machines.',
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * Decide whether to skip writing an entry. Empty sessions (no commits, no
 * file changes, no squashed WIP) get skipped to avoid polluting the file
 * with content-free entries during exploratory/read-only sessions.
 *
 * @param {{commits:Array, filesChanged:number, wipSquashed:number}} meta
 * @returns {boolean} true → caller should skip the append
 */
export function shouldSkipEntry(meta) {
  return meta.commits.length === 0
    && meta.filesChanged === 0
    && (meta.wipSquashed ?? 0) === 0;
}

/**
 * Build the full text to append to an existing SESSION-NOTES.md file.
 * Returns the entry preceded by a blank line so entries don't collide.
 *
 * @param {object} meta see formatEntry
 * @returns {string}
 */
export function buildAppendBlock(meta) {
  return `\n${formatEntry(meta)}\n\n---\n`;
}
