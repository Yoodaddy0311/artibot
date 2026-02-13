#!/usr/bin/env node
/**
 * Stop hook.
 * Scans modified files for console.log statements and warns.
 */

import { readStdin, writeStdout, parseJSON } from '../utils/index.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

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
    const ext = path.extname(filePath).toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(ext)) continue;
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

main().catch((err) => {
  process.stderr.write(`[artibot:check-console-log] ${err.message}\n`);
});
