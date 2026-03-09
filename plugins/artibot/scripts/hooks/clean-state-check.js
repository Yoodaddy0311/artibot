#!/usr/bin/env node
/**
 * TaskCompleted hook: Clean State reminder.
 * Checks if completed task involved JS/TS files and reminds
 * the agent/user to verify lint + test before considering it done.
 *
 * This hook does NOT run lint/test itself — it is an advisory reminder.
 * @module scripts/hooks/clean-state-check
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, hasExtension } from '../../lib/core/hook-utils.js';

const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

/**
 * Extract the list of changed files from hook data.
 * Supports multiple field names used by different event sources.
 * @param {object} hookData - Parsed hook input
 * @returns {string[]}
 */
function extractChangedFiles(hookData) {
  const files = hookData?.changed_files
    ?? hookData?.modified_files
    ?? hookData?.files
    ?? [];
  return Array.isArray(files) ? files : [];
}

/**
 * Filter file list to only code files (JS/TS).
 * @param {string[]} files
 * @returns {string[]}
 */
function filterCodeFiles(files) {
  return files.filter((f) => hasExtension(f, CODE_EXTENSIONS));
}

/**
 * Build the result object for the clean state check.
 * @param {boolean} hasCodeChanges - Whether code files were changed
 * @param {string[]} codeFiles - List of changed code files
 * @returns {{ cleanState: boolean, lint: string, tests: string }}
 */
function buildResult(hasCodeChanges, codeFiles) {
  if (!hasCodeChanges) {
    return { cleanState: true, lint: 'skip', tests: 'skip' };
  }
  return {
    cleanState: false,
    lint: 'pending',
    tests: 'pending',
    codeFiles,
  };
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  if (!hookData) return;

  const changedFiles = extractChangedFiles(hookData);

  if (changedFiles.length === 0) {
    writeStdout({
      message: '\u2705 Clean State: no files changed, nothing to verify.',
    });
    return;
  }

  const codeFiles = filterCodeFiles(changedFiles);

  if (codeFiles.length === 0) {
    writeStdout({
      message: '\u2705 Clean State: no JS/TS files changed, skipping lint/test check.',
    });
    return;
  }

  const result = buildResult(true, codeFiles);
  const fileList = codeFiles.map((f) => `  - ${f}`).join('\n');

  writeStdout({
    message: [
      '\u26a0\ufe0f Clean State check: JS/TS files were modified.',
      'Please verify before marking complete:',
      '  1. Run lint: npm run lint (0 errors)',
      '  2. Run tests: npm test (all passing)',
      `Changed code files (${codeFiles.length}):`,
      fileList,
    ].join('\n'),
    result,
  });
}

main().catch(createErrorHandler('clean-state-check', { exit: true }));
