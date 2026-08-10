#!/usr/bin/env node
/**
 * PermissionRequest auto-approve hook.
 *
 * Reads `artibot.config.json.permissions` (an allowlist of `{tool, command?}`
 * patterns) and silently auto-approves matching tool calls so non-developer
 * users don't see permission dialogs for routine, safe operations.
 *
 * Defaults are conservative: ONLY the user-defined allowlist auto-approves.
 * All other requests fall through (no decision emitted), preserving the
 * default Claude Code permission flow.
 *
 * Hook attachment (hooks.json): PermissionRequest
 * Stdin: { tool_name, tool_input, permission_suggestions, ... }
 * Stdout: optional { hookSpecificOutput: { hookEventName, decision: { behavior } } }
 */

import { readFileSync } from 'node:fs';
import { parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadAllowlist() {
  try {
    const cfgPath = resolveConfigPath('artibot.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const list = cfg?.permissions?.autoApprove;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Test whether a tool call matches an allowlist entry.
 * @param {object} entry - { tool: string, commandPattern?: string (regex) }
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {boolean}
 */
export function matchesAllowEntry(entry, toolName, toolInput) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.tool && entry.tool !== '*' && entry.tool !== toolName) return false;
  if (entry.commandPattern) {
    try {
      const re = new RegExp(entry.commandPattern);
      const cmd = toolInput?.command ?? toolInput?.file_path ?? '';
      if (typeof cmd !== 'string' || !re.test(cmd)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = parseJSON(raw);
  } catch {
    return; // No decision — fall through
  }

  const toolName = payload?.tool_name;
  const toolInput = payload?.tool_input ?? {};
  if (!toolName) return;

  const allowlist = loadAllowlist();
  if (allowlist.length === 0) return;

  const matched = allowlist.find((e) => matchesAllowEntry(e, toolName, toolInput));
  if (!matched) return;

  writeStdout({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
      },
    },
  });
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(() => {
    // Silent — never block on hook failure.
  });
}
