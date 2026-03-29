/**
 * Complexity-based agent split heuristics.
 * Estimates task complexity and suggests natural split points.
 *
 * @module lib/orchestration/complexity-budget
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @enum {string} */
const Level = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
});

/** @type {{lines: number, subtasks: number, files: number}} */
const DEFAULT_THRESHOLDS = Object.freeze({
  lines: 150,
  subtasks: 5,
  files: 7,
});

// ---------------------------------------------------------------------------
// Helpers (pure, no side effects)
// ---------------------------------------------------------------------------

/**
 * Count non-empty lines in a task description.
 *
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Count subtasks indicated by checkboxes or numbered lists.
 * Matches: `- [ ]`, `- [x]`, `1.`, `2)`, `- item`, `* item`
 *
 * @param {string} text
 * @returns {number}
 */
function countSubtasks(text) {
  const lines = text.split('\n');
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^- \[[ x]\]/i.test(trimmed)) {
      count++;
    } else if (/^\d+[.)]\s/.test(trimmed)) {
      count++;
    } else if (/^[-*]\s+\S/.test(trimmed) && !/^[-*]\s*\[/.test(trimmed)) {
      count++;
    }
  }

  return count;
}

/**
 * Extract file references from text (paths with extensions).
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractFileReferences(text) {
  const filePattern = /(?:^|\s|`|"|')([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})(?:\s|`|"|'|$|,|:)/gm;
  const seen = new Set();
  let match;

  while ((match = filePattern.exec(text)) !== null) {
    const filePath = match[1];
    if (!seen.has(filePath) && !isCommonNonFile(filePath)) {
      seen.add(filePath);
    }
  }

  return [...seen];
}

/**
 * Check if a matched string is likely not a file reference.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isCommonNonFile(str) {
  const nonFiles = ['e.g.', 'i.e.', 'etc.', 'vs.'];
  return nonFiles.includes(str.toLowerCase());
}

/**
 * Determine complexity level from a numeric score and threshold.
 *
 * @param {number} value
 * @param {number} threshold
 * @returns {string}
 */
function levelForValue(value, threshold) {
  if (value > threshold) return Level.HIGH;
  if (value > threshold * 0.6) return Level.MEDIUM;
  return Level.LOW;
}

/**
 * Pick the highest severity level from an array of levels.
 *
 * @param {string[]} levels
 * @returns {string}
 */
function maxLevel(levels) {
  if (levels.includes(Level.HIGH)) return Level.HIGH;
  if (levels.includes(Level.MEDIUM)) return Level.MEDIUM;
  return Level.LOW;
}

/**
 * Extract markdown headings as split candidates.
 *
 * @param {string} text
 * @returns {Array<{title: string, lineIndex: number}>}
 */
function extractHeadings(text) {
  const lines = text.split('\n');
  const headings = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{2,3})\s+(.+)/);
    if (match) {
      headings.push({ title: match[2].trim(), lineIndex: i });
    }
  }

  return headings;
}

/**
 * Extract numbered list groups as split candidates.
 *
 * @param {string} text
 * @returns {Array<{title: string, lineIndex: number}>}
 */
function extractNumberedGroups(text) {
  const lines = text.split('\n');
  const groups = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\d+)[.)]\s+(.+)/);
    if (match) {
      groups.push({ title: match[2].trim(), lineIndex: i });
    }
  }

  return groups;
}

/**
 * Group file references by directory.
 *
 * @param {string[]} files
 * @returns {Array<{directory: string, files: string[]}>}
 */
function groupFilesByDirectory(files) {
  const dirMap = new Map();

  for (const file of files) {
    const lastSlash = file.lastIndexOf('/');
    const dir = lastSlash > 0 ? file.slice(0, lastSlash) : '.';
    if (!dirMap.has(dir)) {
      dirMap.set(dir, []);
    }
    dirMap.get(dir).push(file);
  }

  return [...dirMap.entries()]
    .map(([directory, dirFiles]) => ({ directory, files: dirFiles }))
    .filter((g) => g.files.length > 0);
}

// ---------------------------------------------------------------------------
// ComplexityBudget class
// ---------------------------------------------------------------------------

/**
 * Estimates task complexity and suggests natural split points.
 *
 * Analyzes task descriptions by line count, subtask count, and
 * file reference count against configurable thresholds.
 * All methods are pure — no internal state mutation after construction.
 */
export class ComplexityBudget {
  /** @type {{lines: number, subtasks: number, files: number}} */
  #thresholds;

  /**
   * @param {object} [thresholds]
   * @param {number} [thresholds.lines=150]
   * @param {number} [thresholds.subtasks=5]
   * @param {number} [thresholds.files=7]
   */
  constructor(thresholds = {}) {
    this.#thresholds = Object.freeze({
      lines: thresholds.lines ?? DEFAULT_THRESHOLDS.lines,
      subtasks: thresholds.subtasks ?? DEFAULT_THRESHOLDS.subtasks,
      files: thresholds.files ?? DEFAULT_THRESHOLDS.files,
    });
  }

  /**
   * Estimate complexity of a task description.
   *
   * @param {string} taskDescription
   * @returns {{lines: number, subtasks: number, files: number, level: string}}
   */
  estimateComplexity(taskDescription) {
    if (typeof taskDescription !== 'string') {
      throw new Error('Task description must be a string');
    }

    const lines = countLines(taskDescription);
    const subtasks = countSubtasks(taskDescription);
    const files = extractFileReferences(taskDescription).length;

    const lineLevel = levelForValue(lines, this.#thresholds.lines);
    const subtaskLevel = levelForValue(subtasks, this.#thresholds.subtasks);
    const fileLevel = levelForValue(files, this.#thresholds.files);

    return Object.freeze({
      lines,
      subtasks,
      files,
      level: maxLevel([lineLevel, subtaskLevel, fileLevel]),
    });
  }

  /**
   * Determine whether a task should be split.
   *
   * @param {string} taskDescription
   * @returns {{shouldSplit: boolean, reasons: string[]}}
   */
  shouldSplit(taskDescription) {
    const score = this.estimateComplexity(taskDescription);
    const reasons = [];

    if (score.lines > this.#thresholds.lines) {
      reasons.push(`Line count (${score.lines}) exceeds threshold (${this.#thresholds.lines})`);
    }
    if (score.subtasks > this.#thresholds.subtasks) {
      reasons.push(`Subtask count (${score.subtasks}) exceeds threshold (${this.#thresholds.subtasks})`);
    }
    if (score.files > this.#thresholds.files) {
      reasons.push(`File count (${score.files}) exceeds threshold (${this.#thresholds.files})`);
    }

    return Object.freeze({
      shouldSplit: reasons.length > 0,
      reasons,
    });
  }

  /**
   * Suggest natural split points in the task description.
   *
   * @param {string} taskDescription
   * @returns {{headings: Array<{title: string, lineIndex: number}>, numberedGroups: Array<{title: string, lineIndex: number}>, fileGroups: Array<{directory: string, files: string[]}>}}
   */
  suggestSplits(taskDescription) {
    if (typeof taskDescription !== 'string') {
      throw new Error('Task description must be a string');
    }

    const headings = extractHeadings(taskDescription);
    const numberedGroups = extractNumberedGroups(taskDescription);
    const fileRefs = extractFileReferences(taskDescription);
    const fileGroups = groupFilesByDirectory(fileRefs);

    return Object.freeze({ headings, numberedGroups, fileGroups });
  }

  /**
   * Get the complexity score (alias for estimateComplexity).
   *
   * @param {string} taskDescription
   * @returns {{lines: number, subtasks: number, files: number, level: string}}
   */
  getScore(taskDescription) {
    return this.estimateComplexity(taskDescription);
  }
}

// Export helpers for testing
export {
  countLines,
  countSubtasks,
  extractFileReferences,
  extractHeadings,
  extractNumberedGroups,
  groupFilesByDirectory,
  Level,
  DEFAULT_THRESHOLDS,
};
