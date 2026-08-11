#!/usr/bin/env node
/**
 * PostToolUse hook for Edit.
 * Suggests prettier formatting for JS/TS files after edit.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import path from 'node:path';
import { createErrorHandler, extractFilePath, hasExtension } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

const FORMATTABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

export async function main() {
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

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('post-edit-format', { exit: true }));
}
