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

  // Claude Code's PostToolUse payload exposes Bash output under `tool_response`
  // (see scripts/hooks/event-emitter.mjs:84 and tool-tracker.js:153). For Bash
  // this is frequently a bare string (combined stdout), so the string branch is
  // mandatory — the legacy `tool_result` object is never populated by Claude
  // Code, which previously starved this hook (always no-op / DEAD).
  const tr = hookData?.tool_response ?? hookData?.tool_result ?? '';
  const stdout = typeof tr === 'string' ? tr : (tr?.stdout || '');
  const stderr = typeof tr === 'string' ? '' : (tr?.stderr || '');
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
