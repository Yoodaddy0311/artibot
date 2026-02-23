/**
 * Visual validation module re-exports.
 * @module lib/visual
 */

export { validateComponent, validatePage, createBaseline } from './visual-validator.js';
export { compareScreenshots, calculateSSIM, generateDiffMap } from './screenshot-differ.js';
export { analyzeDiffRegions, generateFixTasks, categorizeIssue } from './style-fixer.js';
