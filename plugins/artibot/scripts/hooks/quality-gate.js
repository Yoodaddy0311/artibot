#!/usr/bin/env node
/**
 * PostToolUse hook: Quality gate for Edit/Write operations.
 * Performs zero-cost static pattern matching to detect common code issues.
 *
 * Checks:
 *   - console.log / console.error / console.debug usage
 *   - Hardcoded secret patterns (API keys, passwords, tokens)
 *   - File size exceeding 800 lines
 *
 * No LLM calls. Pure pattern matching — maintenance cost: $0.
 *
 * Hook attachment (hooks.json): PostToolUse matcher "Edit|Write"
 * Stdin: Claude Code hook data JSON
 * Stdout: JSON { decision?, message? } — decision "block" to abort, omit to allow
 */

import { readStdin, writeStdout, parseJSON } from '../utils/index.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/** console.* usage (JS/TS). Allow legitimate logger calls. */
const CONSOLE_LOG_PATTERN = /\bconsole\.(log|debug|info|warn|error|trace)\s*\(/g;

/**
 * Hardcoded secret heuristics.
 * Match assignments like: apiKey = "sk-...", password = "hunter2", etc.
 * False-positive resistant: require quote-enclosed values >=8 chars.
 */
const SECRET_PATTERNS = [
  // Generic key/secret/token/password assignment
  /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|password|passwd|credentials?)\s*[=:]\s*["'][^"']{8,}["']/gi,
  // AWS access key IDs (AKIA...)
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Generic base64-looking secrets 32+ chars (crude but cheap)
  /(?:["'])[A-Za-z0-9+/]{32,}={0,2}["']/g,
  // GitHub personal access tokens
  /\bghp_[A-Za-z0-9]{36}\b/g,
  // Anthropic API keys
  /\bsk-ant-[A-Za-z0-9-]{20,}\b/g,
  // OpenAI API keys
  /\bsk-[A-Za-z0-9]{20,}\b/g,
];

/** Lines that are clearly comments (skip secret scan on these). */
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*)/;

/** File extensions we actively inspect (source code only). */
const INSPECTABLE_EXTS = new Set([
  'js', 'ts', 'mjs', 'cjs', 'jsx', 'tsx',
  'py', 'rb', 'go', 'java', 'cs', 'php', 'rs',
  'sh', 'bash', 'zsh',
]);

const MAX_FILE_LINES = 800;

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

/**
 * Count console.log occurrences in source text.
 * @param {string} text
 * @returns {number}
 */
function countConsoleLogs(text) {
  const matches = text.match(CONSOLE_LOG_PATTERN);
  return matches ? matches.length : 0;
}

/**
 * Find lines with potential hardcoded secrets.
 * Returns array of { line: number, snippet: string }.
 * @param {string} text
 * @returns {Array<{line: number, snippet: string}>}
 */
function findSecretLines(text) {
  const lines = text.split('\n');
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;

    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.push({
          line: i + 1,
          snippet: line.trim().slice(0, 80),
        });
        break; // One finding per line is enough
      }
    }
  }

  return findings;
}

/**
 * Count lines in a text.
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  return text.split('\n').length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  if (!hookData) return;

  const toolName = hookData?.tool_name || hookData?.tool;
  const toolInput = hookData?.tool_input || {};

  // Only inspect Edit and Write tool results
  if (toolName !== 'Edit' && toolName !== 'Write') return;

  const filePath = toolInput.file_path || toolInput.path || '';
  if (!filePath) return;

  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  if (!INSPECTABLE_EXTS.has(ext)) return;

  // Skip node_modules, .git, lock files
  const normalised = filePath.replace(/\\/g, '/');
  if (normalised.includes('/node_modules/') || normalised.includes('/.git/')) return;
  if (normalised.endsWith('.lock') || normalised.endsWith('-lock.json')) return;

  // Read the file from disk (tool already wrote it)
  if (!existsSync(filePath)) return;

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return; // Unreadable — skip silently
  }

  const issues = [];
  const warnings = [];

  // 1. console.log check
  const consoleCount = countConsoleLogs(content);
  if (consoleCount > 0) {
    warnings.push(`console.log/debug found (${consoleCount} occurrence${consoleCount > 1 ? 's' : ''}) in ${path.basename(filePath)}`);
  }

  // 2. Hardcoded secret check
  const secretLines = findSecretLines(content);
  if (secretLines.length > 0) {
    for (const { line, snippet } of secretLines.slice(0, 3)) {
      issues.push(`Potential hardcoded secret at line ${line}: ${snippet}`);
    }
    if (secretLines.length > 3) {
      issues.push(`...and ${secretLines.length - 3} more potential secret(s)`);
    }
  }

  // 3. File size check
  const lineCount = countLines(content);
  if (lineCount > MAX_FILE_LINES) {
    warnings.push(`File exceeds ${MAX_FILE_LINES} lines (${lineCount} lines). Consider splitting into smaller modules.`);
  }

  // Build output message
  if (issues.length === 0 && warnings.length === 0) return;

  const lines = [];

  if (issues.length > 0) {
    lines.push('[quality-gate] ISSUES (review required):');
    for (const issue of issues) {
      lines.push(`  - ${issue}`);
    }
  }

  if (warnings.length > 0) {
    lines.push('[quality-gate] WARNINGS:');
    for (const warn of warnings) {
      lines.push(`  - ${warn}`);
    }
  }

  // Secrets are blocking; warnings are informational only
  const hasBlockingIssue = issues.some(i => i.toLowerCase().includes('secret'));

  if (hasBlockingIssue) {
    writeStdout({
      decision: 'block',
      message: lines.join('\n') + '\n\nRemove hardcoded secrets before proceeding.',
    });
  } else {
    writeStdout({
      message: lines.join('\n'),
    });
  }
}

main().catch((err) => {
  process.stderr.write(`[artibot:quality-gate] ${err.message}\n`);
  process.exit(0); // Never block the tool pipeline on hook errors
});
