#!/usr/bin/env node
/**
 * CI: Validate hooks/hooks.json.
 * Checks that the file is valid JSON and has the expected structure.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const VALID_HOOK_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PostCompact',
  'Stop',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'SubAgentTurn',
  'TeammateIdle',
  'Notification',
  'TaskCompleted',
  'PermissionRequest',
]);

function getPluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return path.resolve(process.env.CLAUDE_PLUGIN_ROOT);
  const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
  return path.resolve(thisDir, '..', '..');
}

function main() {
  const hooksPath = path.join(getPluginRoot(), 'hooks', 'hooks.json');

  if (!existsSync(hooksPath)) {
    console.error('FAIL: hooks/hooks.json not found.');
    process.exit(1);
  }

  let data;
  try {
    const content = readFileSync(hooksPath, 'utf-8');
    data = JSON.parse(content);
  } catch (err) {
    console.error(`FAIL: hooks/hooks.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  let errors = 0;

  // Check top-level structure
  if (!data.hooks || typeof data.hooks !== 'object') {
    console.error('FAIL: hooks/hooks.json missing "hooks" object at top level.');
    errors++;
  } else {
    for (const [eventName, entries] of Object.entries(data.hooks)) {
      if (!VALID_HOOK_EVENTS.has(eventName)) {
        console.warn(`WARN: Unknown hook event "${eventName}".`);
      }

      if (!Array.isArray(entries)) {
        console.error(`FAIL: hooks.${eventName} must be an array.`);
        errors++;
        continue;
      }

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.hooks || !Array.isArray(entry.hooks)) {
          console.error(`FAIL: hooks.${eventName}[${i}] missing "hooks" array.`);
          errors++;
          continue;
        }

        for (let j = 0; j < entry.hooks.length; j++) {
          const hook = entry.hooks[j];
          if (!hook.type) {
            console.error(`FAIL: hooks.${eventName}[${i}].hooks[${j}] missing "type".`);
            errors++;
          }
          if (!hook.command) {
            console.error(`FAIL: hooks.${eventName}[${i}].hooks[${j}] missing "command".`);
            errors++;
          }
        }
      }

      console.log(`PASS: hooks.${eventName} (${entries.length} entry/entries)`);
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} validation error(s) found.`);
    process.exit(1);
  }

  console.log('\nhooks/hooks.json validated successfully.');
}

main();
