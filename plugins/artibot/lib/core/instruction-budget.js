/**
 * Instruction Content Budget monitor.
 * Tracks CLAUDE.md / CLAUDE.local.md file sizes against Claude Code's
 * instruction budget limits (4K chars/file, 12K chars total).
 *
 * @module lib/core/instruction-budget
 */

import path from 'node:path';
import { exists, readTextFile } from './file.js';
import { estimateTokens } from './index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters per individual instruction file */
const PER_FILE_LIMIT = 4_000;

/** Maximum total characters across all instruction files */
const TOTAL_LIMIT = 12_000;

/** Known instruction file names to scan */
const INSTRUCTION_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
];

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate token count from character content.
 * Delegates to the canonical estimateTokens in core/index.js.
 *
 * @param {string} content - Raw text content
 * @returns {number} Estimated token count
 */
export function getSkillTokenEstimate(content) {
  if (typeof content !== 'string' || content.length === 0) return 0;
  return estimateTokens(content);
}

// ---------------------------------------------------------------------------
// Budget analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a single instruction file's budget usage.
 *
 * @param {string} filePath - Absolute path to the instruction file
 * @returns {Promise<Readonly<object>>}
 */
async function analyzeFile(filePath) {
  const fileExists = await exists(filePath);
  if (!fileExists) {
    return Object.freeze({
      path: filePath,
      name: path.basename(filePath),
      exists: false,
      chars: 0,
      tokens: 0,
      usage: 0,
      overBudget: false,
    });
  }

  const content = await readTextFile(filePath);
  const chars = content ? content.length : 0;
  const tokens = getSkillTokenEstimate(content ?? '');
  const usage = chars / PER_FILE_LIMIT;

  return Object.freeze({
    path: filePath,
    name: path.basename(filePath),
    exists: true,
    chars,
    tokens,
    usage: Math.round(usage * 1000) / 1000,
    overBudget: chars > PER_FILE_LIMIT,
  });
}

/**
 * Check instruction budget for a plugin root directory.
 * Scans all known instruction files and computes per-file and total usage.
 *
 * @param {string} pluginRoot - Absolute path to the plugin root directory
 * @returns {Promise<Readonly<object>>} Budget analysis with files, totals, and warnings
 */
export async function checkInstructionBudget(pluginRoot) {
  if (typeof pluginRoot !== 'string' || !pluginRoot) {
    throw new TypeError('pluginRoot must be a non-empty string');
  }

  const filePaths = INSTRUCTION_FILES.map((name) => path.join(pluginRoot, name));
  const files = await Promise.all(filePaths.map(analyzeFile));

  const totalChars = files.reduce((sum, f) => sum + f.chars, 0);
  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  const totalUsage = totalChars / TOTAL_LIMIT;

  const warnings = [];

  for (const file of files) {
    if (file.overBudget) {
      warnings.push(
        `${file.name}: ${file.chars} chars exceeds ${PER_FILE_LIMIT} per-file limit (+${file.chars - PER_FILE_LIMIT})`,
      );
    }
  }

  if (totalChars > TOTAL_LIMIT) {
    warnings.push(
      `Total: ${totalChars} chars exceeds ${TOTAL_LIMIT} total limit (+${totalChars - TOTAL_LIMIT})`,
    );
  }

  return Object.freeze({
    pluginRoot,
    files: Object.freeze(files),
    totalChars,
    totalTokens,
    totalUsage: Math.round(totalUsage * 1000) / 1000,
    overBudget: totalChars > TOTAL_LIMIT,
    warnings: Object.freeze(warnings),
    limits: Object.freeze({
      perFile: PER_FILE_LIMIT,
      total: TOTAL_LIMIT,
    }),
  });
}

/**
 * Generate a human-readable budget report for a plugin root.
 *
 * @param {string} pluginRoot - Absolute path to the plugin root directory
 * @returns {Promise<string>} Formatted budget report
 */
export async function budgetReport(pluginRoot) {
  const budget = await checkInstructionBudget(pluginRoot);
  const lines = [
    'INSTRUCTION BUDGET REPORT',
    '========================',
    '',
  ];

  for (const file of budget.files) {
    const status = !file.exists ? 'N/A' : file.overBudget ? 'OVER' : 'OK';
    const bar = file.exists ? `${Math.round(file.usage * 100)}%` : '-';
    lines.push(
      `${file.name.padEnd(20)} ${String(file.chars).padStart(6)} / ${PER_FILE_LIMIT}  (${bar.padStart(4)})  [${status}]`,
    );
  }

  lines.push('');
  lines.push(
    `${'TOTAL'.padEnd(20)} ${String(budget.totalChars).padStart(6)} / ${TOTAL_LIMIT}  (${String(Math.round(budget.totalUsage * 100) + '%').padStart(4)})  [${budget.overBudget ? 'OVER' : 'OK'}]`,
  );
  lines.push(`Estimated tokens:    ${budget.totalTokens}`);

  if (budget.warnings.length > 0) {
    lines.push('');
    lines.push('WARNINGS:');
    for (const w of budget.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join('\n');
}
