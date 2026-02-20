#!/usr/bin/env node
/**
 * PostToolUse hook for Edit.
 * Suggests prettier formatting for JS/TS files after edit.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import path from 'node:path';
import { createErrorHandler, extractFilePath, hasExtension } from '../../lib/core/hook-utils.js';

const FORMATTABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const filePath = extractFilePath(hookData);
  if (!filePath) return;

  if (hasExtension(filePath, FORMATTABLE_EXTENSIONS)) {
    const basename = path.basename(filePath);
    writeStdout({
      message: `[format] Consider running prettier on ${basename}: npx prettier --write "${filePath}"`,
    });
    return;
  }

  // No suggestion needed for non-JS/TS files
}

main().catch(createErrorHandler('post-edit-format', { exit: true }));
