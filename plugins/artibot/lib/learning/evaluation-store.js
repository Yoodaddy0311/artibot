/**
 * Evaluation store primitives — persistence and rubric-regime selection.
 *
 * Extracted from `self-evaluator.js` so that module and `score-health.js` can
 * share the store and the rubric rules without importing each other (and
 * without pushing self-evaluator past the 800-line guideline).
 *
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/evaluation-store
 */

import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../core/file.js';
import { getHomeDir } from '../core/platform.js';

const EVALUATIONS_FILENAME = 'evaluations.json';
const MAX_EVALUATIONS = 500;

/**
 * Scoring rubric version stamped onto every new record.
 *
 * Bump this whenever a `scoreX()` function changes what a given score *means*.
 * Rows written before the field existed are read as version 1. Aggregations
 * group by it rather than averaging across it: on 2026-05-19 a regime change
 * silently blended two rubrics into one mean, and a score that mixes rubrics
 * is not a measurement of anything.
 */
export const RUBRIC_VERSION = 2;

/**
 * Get the evaluations file path (~/.claude/artibot/evaluations.json).
 * @returns {string}
 */
export function getEvaluationsPath() {
  return path.join(getHomeDir(), '.claude', 'artibot', EVALUATIONS_FILENAME);
}

/**
 * Load persisted evaluations from disk storage.
 * @returns {Promise<object[]>}
 */
export async function loadEvaluations() {
  const data = await readJsonFile(getEvaluationsPath());
  return Array.isArray(data) ? data : [];
}

/**
 * Save evaluations to disk, pruning old entries beyond MAX_EVALUATIONS.
 * @param {object[]} evaluations - Evaluations to save
 * @returns {Promise<void>}
 */
export async function saveEvaluations(evaluations) {
  const pruned = evaluations.length > MAX_EVALUATIONS
    ? evaluations.slice(evaluations.length - MAX_EVALUATIONS)
    : evaluations;
  await writeJsonFile(getEvaluationsPath(), pruned);
}

/**
 * Read a row's rubric version. Rows predating the field are version 1.
 * @param {object} row - Evaluation record
 * @returns {number}
 */
export function rowRubricVersion(row) {
  return typeof row?.rubricVersion === 'number' ? row.rubricVersion : 1;
}

/**
 * Restrict rows to a single scoring regime so aggregates never average across
 * rubric boundaries.
 *
 * Defaults to the newest version *present in the given rows* rather than to
 * {@link RUBRIC_VERSION}. Pinning to the constant would make every report empty
 * for the stretch between upgrading the code and writing the first new row.
 *
 * @param {object[]} rows - Candidate rows (already windowed by lookback)
 * @param {number} [requested] - Explicit rubric version to select
 * @returns {{ version: number, selected: object[], excludedByRubric: number }}
 */
export function selectByRubric(rows, requested) {
  const version = requested ?? rows.reduce((max, r) => Math.max(max, rowRubricVersion(r)), 1);
  const selected = rows.filter(r => rowRubricVersion(r) === version);
  return { version, selected, excludedByRubric: rows.length - selected.length };
}

/**
 * Whether any scoring signal reached this row.
 *
 * A row where nothing arrived carries neutral placeholder scores, not findings.
 * Averaging those into per-model or trend figures drags every comparison toward
 * the middle and lets a broken pipe read as mediocre work.
 *
 * Reads every boolean in `inputsPresent` except the `signalSource` label, which
 * is a string rather than a signal flag. Naming only that one exclusion — rather
 * than listing the signals to check — means a signal added later counts
 * automatically instead of defaulting to "absent". Rows predating the field
 * report true: unknown is not the same as empty, and silently dropping history
 * is its own distortion.
 *
 * @param {object} row - Evaluation record
 * @returns {boolean}
 */
export function hasAnySignal(row) {
  const present = row?.inputsPresent;
  if (!present) return true;
  return Object.entries(present).some(([key, value]) => key !== 'signalSource' && value === true);
}
