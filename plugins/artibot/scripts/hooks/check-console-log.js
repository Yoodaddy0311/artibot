#!/usr/bin/env node
/**
 * Stop hook.
 * Scans modified files for console.log statements and warns.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createErrorHandler, hasExtension } from '../../lib/core/hook-utils.js';

const SCANNABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const CONSOLE_PATTERN = /\bconsole\.(log|debug|info)\s*\(/g;

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  // Collect modified file paths from hook data
  const modifiedFiles = hookData?.modified_files || hookData?.files || [];

  if (!Array.isArray(modifiedFiles) || modifiedFiles.length === 0) return;

  const warnings = [];

  for (const filePath of modifiedFiles) {
    if (!hasExtension(filePath, SCANNABLE_EXTENSIONS)) continue;
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const hits = [];

      for (let i = 0; i < lines.length; i++) {
        if (CONSOLE_PATTERN.test(lines[i])) {
          hits.push(i + 1);
        }
        // Reset regex lastIndex since we use /g flag
        CONSOLE_PATTERN.lastIndex = 0;
      }

      if (hits.length > 0) {
        const basename = path.basename(filePath);
        warnings.push(`  ${basename}: line(s) ${hits.join(', ')}`);
      }
    } catch {
      // Skip unreadable files
    }
  }

  if (warnings.length > 0) {
    writeStdout({
      message: `[audit] console.log found in modified files:\n${warnings.join('\n')}\nConsider removing before commit.`,
    });
  }
}

main().catch(createErrorHandler('check-console-log', { exit: true }));
