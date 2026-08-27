/**
 * Plan Tracker — parse markdown plans, track progress and session history.
 * Stores boulder state alongside the plan file as `.plan-state.json`.
 *
 * @module lib/core/plan-tracker
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKBOX_UNCHECKED = /^(\s*)-\s\[\s\]\s+(.+)$/;
const CHECKBOX_CHECKED = /^(\s*)-\s\[x\]\s+(.+)$/i;

// ---------------------------------------------------------------------------
// Line handling
// ---------------------------------------------------------------------------

/**
 * Split content into lines, keeping each line's own terminator.
 *
 * `split('\n')` leaves a trailing `\r` on every CRLF line, and JS counts `\r`
 * as a line terminator that `.` refuses to match — so `(.+)$` in the checkbox
 * patterns never anchors and a CRLF plan parses as zero tasks. Normalizing the
 * whole document would fix parsing but make {@link PlanTracker#markCompleted}
 * rewrite every line ending, turning one checkbox flip into a whole-file diff.
 * So the terminator travels with its line and is re-attached on rejoin.
 *
 * @param {string} content
 * @returns {Array<{ text: string, ending: string }>} Terminator is `''` on a
 *   final line that the content does not end.
 */
function splitLines(content) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch !== '\n' && ch !== '\r') continue;
    const ending = ch === '\r' && content[i + 1] === '\n' ? '\r\n' : ch;
    lines.push({ text: content.slice(start, i), ending });
    i += ending.length - 1;
    start = i + 1;
  }
  if (start < content.length) lines.push({ text: content.slice(start), ending: '' });
  return lines;
}

// ---------------------------------------------------------------------------
// PlanTracker
// ---------------------------------------------------------------------------

export class PlanTracker {
  /** @type {Array<{ text: string, completed: boolean, indent: string }>} */
  #tasks;
  /** @type {Array<{ id: string, completedIndices: number[], startedAt: string }>} */
  #sessions;
  /** @type {string} */
  #rawContent;

  constructor() {
    this.#tasks = [];
    this.#sessions = [];
    this.#rawContent = '';
  }

  /**
   * Parse markdown content and extract checkbox tasks.
   *
   * @param {string} markdownContent
   * @returns {Array<{ text: string, completed: boolean }>}
   */
  parsePlan(markdownContent) {
    if (typeof markdownContent !== 'string') return [];

    this.#rawContent = markdownContent;
    const tasks = [];

    for (const { text: line } of splitLines(markdownContent)) {
      const checked = CHECKBOX_CHECKED.exec(line);
      if (checked) {
        tasks.push({ text: checked[2].trim(), completed: true, indent: checked[1] });
        continue;
      }
      const unchecked = CHECKBOX_UNCHECKED.exec(line);
      if (unchecked) {
        tasks.push({ text: unchecked[2].trim(), completed: false, indent: unchecked[1] });
      }
    }

    this.#tasks = tasks;
    return tasks.map(({ text, completed }) => ({ text, completed }));
  }

  /**
   * Get current progress summary.
   *
   * @returns {{ total: number, completed: number, percentage: number }}
   */
  getProgress() {
    const total = this.#tasks.length;
    const completed = this.#tasks.filter((t) => t.completed).length;
    const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
    return { total, completed, percentage };
  }

  /**
   * Mark a task as completed and return updated markdown (immutable).
   *
   * @param {number} taskIndex - Zero-based index into the parsed task list.
   * @returns {string} New markdown content with the task checked off.
   */
  markCompleted(taskIndex) {
    if (taskIndex < 0 || taskIndex >= this.#tasks.length) {
      return this.#rawContent;
    }

    const task = this.#tasks[taskIndex];
    if (task.completed) return this.#rawContent;

    let taskCounter = -1;
    const newContent = splitLines(this.#rawContent).map(({ text, ending }) => {
      const isChecked = CHECKBOX_CHECKED.test(text);
      const isUnchecked = CHECKBOX_UNCHECKED.test(text);
      if (isChecked || isUnchecked) {
        taskCounter++;
        if (taskCounter === taskIndex && isUnchecked) {
          return text.replace('- [ ]', '- [x]') + ending;
        }
      }
      return text + ending;
    }).join('');

    // Record in active session
    const activeSession = this.#sessions[this.#sessions.length - 1];
    if (activeSession && !activeSession.completedIndices.includes(taskIndex)) {
      activeSession.completedIndices.push(taskIndex);
    }

    // Update internal state immutably
    this.#tasks = this.#tasks.map((t, i) =>
      i === taskIndex ? { ...t, completed: true } : t,
    );
    this.#rawContent = newContent;

    return newContent;
  }

  /**
   * Register a new session.
   *
   * @param {string} sessionId
   */
  addSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return;
    this.#sessions = [
      ...this.#sessions,
      { id: sessionId, completedIndices: [], startedAt: new Date().toISOString() },
    ];
  }

  /**
   * Get session history — which sessions completed which tasks.
   *
   * @returns {Array<{ id: string, completedIndices: number[], startedAt: string }>}
   */
  getSessionHistory() {
    return this.#sessions.map((s) => ({ ...s, completedIndices: [...s.completedIndices] }));
  }

  /**
   * Export state for persistence as `.plan-state.json`.
   *
   * @param {string} planFile - Path to the plan markdown file.
   * @returns {{ planFile: string, tasks: Array<{ text: string, completed: boolean }>, sessions: Array, lastUpdated: string }}
   */
  toState(planFile) {
    return {
      planFile,
      tasks: this.#tasks.map(({ text, completed }) => ({ text, completed })),
      sessions: this.getSessionHistory(),
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Restore tracker from a previously saved state object.
   *
   * @param {{ tasks?: Array, sessions?: Array }} saved
   */
  fromState(saved) {
    if (!saved || typeof saved !== 'object') return;

    if (Array.isArray(saved.tasks)) {
      this.#tasks = saved.tasks.map((t) => ({
        text: t.text || '',
        completed: Boolean(t.completed),
        indent: '',
      }));
    }
    if (Array.isArray(saved.sessions)) {
      this.#sessions = saved.sessions.map((s) => ({
        id: s.id || '',
        completedIndices: Array.isArray(s.completedIndices) ? [...s.completedIndices] : [],
        startedAt: s.startedAt || '',
      }));
    }
  }
}
