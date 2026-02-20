#!/usr/bin/env node
/**
 * PostToolUse hook for Bash.
 * Detects PR URLs from git push output and logs them.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

const PR_URL_PATTERNS = [
  /https:\/\/github\.com\/[^\s]+\/pull\/\d+/g,
  /https:\/\/gitlab\.com\/[^\s]+\/merge_requests\/\d+/g,
  /https:\/\/bitbucket\.org\/[^\s]+\/pull-requests\/\d+/g,
  /https:\/\/dev\.azure\.com\/[^\s]+\/pullrequest\/\d+/g,
];

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const stdout = hookData?.tool_result?.stdout || '';
  const stderr = hookData?.tool_result?.stderr || '';
  const combined = `${stdout}\n${stderr}`;

  const urls = [];
  for (const pattern of PR_URL_PATTERNS) {
    const matches = combined.match(pattern);
    if (matches) urls.push(...matches);
  }

  if (urls.length > 0) {
    const unique = [...new Set(urls)];
    writeStdout({
      message: `[git] PR URL detected:\n${unique.map((u) => `  ${u}`).join('\n')}`,
    });
    return;
  }

  // No PR URLs found, nothing to report
}

main().catch(createErrorHandler('post-bash', { exit: true }));
