/**
 * Git conflict block parser.
 * Parses raw file content with conflict markers into structured blocks.
 *
 * @module lib/git/conflict-parser
 */

import { logError } from '../core/error.js';

/** @type {RegExp} Matches the start of a conflict block (<<<<<<< label) */
const MARKER_OURS = /^<{7} (.+)$/;

/** @type {RegExp} Matches the separator between ours and theirs (||||||| or =======) */
const MARKER_BASE = /^\|{7} (.+)$/;

/** @type {RegExp} Matches the separator ======= */
const MARKER_SEP = /^={7}$/;

/** @type {RegExp} Matches the end of a conflict block (>>>>>>> label) */
const MARKER_THEIRS = /^>{7} (.+)$/;

/**
 * @typedef {Object} ConflictBlock
 * @property {number} startLine  - 0-based line index of <<<<<<< marker
 * @property {number} endLine    - 0-based line index of >>>>>>> marker
 * @property {string[]} ours     - Lines from HEAD / current branch
 * @property {string[]} base     - Lines from common ancestor (diff3 only, may be empty)
 * @property {string[]} theirs   - Lines from incoming branch
 * @property {string} oursLabel  - Branch label from <<<<<<< line
 * @property {string} theirsLabel - Branch label from >>>>>>> line
 */

/**
 * Check whether raw content contains git conflict markers.
 *
 * @param {string} content - Raw file content
 * @returns {boolean}
 */
export function hasConflictMarkers(content) {
  return content.includes('<<<<<<<') && content.includes('>>>>>>>');
}

/**
 * Extract all lines that are NOT inside any conflict block.
 *
 * @param {string} content - Raw file content
 * @returns {string[]} Non-conflict lines
 */
export function extractNonConflictLines(content) {
  const fileLines = content.split('\n');
  const blocks = parseConflictBlocks(content);
  const conflictLineSet = buildConflictLineSet(blocks);
  return fileLines.filter((_, idx) => !conflictLineSet.has(idx));
}

/**
 * Parse all conflict blocks from raw file content.
 * Returns a plain array of ConflictBlock objects (frozen).
 *
 * @param {string} content - Raw file content
 * @returns {ConflictBlock[]}
 */
export function parseConflictBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    const oursMatch = MARKER_OURS.exec(lines[i]);
    if (oursMatch) {
      const block = parseOneBlock(lines, i, oursMatch[1]);
      if (block) {
        blocks.push(Object.freeze(block));
        i = block.endLine + 1;
        continue;
      }
    }
    i++;
  }

  return blocks;
}

/**
 * Split file content into original lines.
 * Convenience helper used by conflict-resolver.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function splitLines(content) {
  return content.split('\n');
}

/**
 * Parse a single conflict block starting at startIdx.
 *
 * @param {string[]} lines
 * @param {number} startIdx - Index of the <<<<<<< line
 * @param {string} oursLabel
 * @returns {ConflictBlock|null} null if markers are malformed
 */
function parseOneBlock(lines, startIdx, oursLabel) {
  const ours = [];
  const base = [];
  const theirs = [];
  /** @type {'ours'|'base'|'theirs'} */
  let section = 'ours';
  let hasBase = false;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];

    if (MARKER_BASE.test(line)) {
      section = 'base';
      hasBase = true;
      continue;
    }

    if (MARKER_SEP.test(line)) {
      section = 'theirs';
      continue;
    }

    const theirsMatch = MARKER_THEIRS.exec(line);
    if (theirsMatch) {
      return {
        startLine: startIdx,
        endLine: i,
        ours: [...ours],
        base: hasBase ? [...base] : [],
        theirs: [...theirs],
        oursLabel,
        theirsLabel: theirsMatch[1],
      };
    }

    if (section === 'ours') ours.push(line);
    else if (section === 'base') base.push(line);
    else theirs.push(line);
  }

  logError('conflict-parser', `Malformed conflict block starting at line ${startIdx}`);
  return null;
}

/**
 * Build a Set of line indices that belong to conflict blocks (including markers).
 *
 * @param {ConflictBlock[]} blocks
 * @returns {Set<number>}
 */
function buildConflictLineSet(blocks) {
  const set = new Set();
  for (const block of blocks) {
    for (let i = block.startLine; i <= block.endLine; i++) {
      set.add(i);
    }
  }
  return set;
}
