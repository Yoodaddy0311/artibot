#!/usr/bin/env node
/**
 * PostToolUse hook for Edit.
 * Suggests prettier formatting for JS/TS files after edit.
 */

import { readStdin, writeStdout, parseJSON } from '../utils/index.js';
import path from 'node:path';

const FORMATTABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const filePath = hookData?.tool_input?.file_path || hookData?.tool_input?.path || '';
  if (!filePath) return;

  const ext = path.extname(filePath).toLowerCase();

  if (FORMATTABLE_EXTENSIONS.has(ext)) {
    const basename = path.basename(filePath);
    writeStdout({
      message: `[format] Consider running prettier on ${basename}: npx prettier --write "${filePath}"`,
    });
    return;
  }

  // No suggestion needed for non-JS/TS files
}

main().catch((err) => {
  process.stderr.write(`[artibot:post-edit-format] ${err.message}\n`);
  process.exit(0);
});
