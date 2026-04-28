#!/usr/bin/env node
/**
 * SessionStart helper hook — injects the using-agent-skills meta-skill prose
 * into systemContext exactly once per local-day so the agent rediscovers
 * Artibot's 102 skills at the top of each fresh day without bloating every
 * session start.
 *
 * Gating: `runtime/state/last-session-date.txt` holds today's local date
 * (YYYY-MM-DD). When the file already contains today's value, this hook
 * exits with a benign continue so session-start.js can carry on without
 * additional context cost.
 *
 * Adoption: AD-23 (`using-agent-skills` meta-skill auto-injection).
 *
 * Constraints:
 *   - ESM only, Node>=18, zero new deps.
 *   - NO HTTP / fetch / external egress.
 *   - All file ops via node:fs/promises (Korean-path safe).
 *   - Best-effort: any failure is swallowed and produces a `{ continue: true }`.
 *
 * @module scripts/hooks/skill-discovery-inject
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'skill-discovery-inject';

/**
 * Resolve the absolute path to the gate state file.
 * @param {string} pluginRoot
 * @returns {string}
 */
function gatePath(pluginRoot) {
  // Repo-root-relative runtime dir (parent of plugin root). Fallback to
  // pluginRoot/runtime if the structure is unfamiliar.
  const repoRoot = path.resolve(pluginRoot, '..', '..');
  return path.join(repoRoot, 'runtime', 'state', 'last-session-date.txt');
}

/**
 * Today's local date as YYYY-MM-DD.
 * @returns {string}
 */
export function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Read the last-session-date file. Returns empty string when missing.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function readLastDate(filePath) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return raw.trim();
  } catch {
    return '';
  }
}

/**
 * Persist today's date as the gate marker. Best-effort.
 * @param {string} filePath
 * @param {string} stamp
 * @returns {Promise<void>}
 */
export async function writeGate(filePath, stamp) {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, stamp + '\n', 'utf-8');
  } catch {
    // Best effort — never block session start
  }
}

/**
 * Load the using-agent-skills SKILL.md body. Returns empty string if missing.
 * @param {string} pluginRoot
 * @returns {Promise<string>}
 */
export async function loadMetaSkill(pluginRoot) {
  const skillPath = path.join(pluginRoot, 'skills', 'using-agent-skills', 'SKILL.md');
  try {
    return await readFile(skillPath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Build the systemContext payload for the inject. Strips the YAML frontmatter
 * to keep prose-only context for the model.
 * @param {string} skillBody
 * @returns {string}
 */
export function formatInjectContext(skillBody) {
  if (!skillBody) return '';
  const stripped = skillBody.replace(/^---[\s\S]*?---\s*/m, '').trim();
  return [
    '[artibot:skill-discovery] First session today — surfacing the skill discovery meta-prose.',
    'Use this only as orientation; jump into the relevant skill once you have picked one.',
    '',
    stripped,
  ].join('\n');
}

/**
 * Decide whether to inject and produce the resulting hook output.
 * Pure function for testability — accepts injected dependencies.
 * @param {object} params
 * @param {string} params.pluginRoot
 * @param {string} params.stamp
 * @param {string} params.lastDate
 * @param {string} params.skillBody
 * @returns {{ output: object, shouldWriteGate: boolean }}
 */
export function decide({ pluginRoot: _pluginRoot, stamp, lastDate, skillBody }) {
  if (lastDate === stamp) {
    return { output: { continue: true }, shouldWriteGate: false };
  }
  const context = formatInjectContext(skillBody);
  if (!context) {
    return { output: { continue: true }, shouldWriteGate: true };
  }
  return {
    output: {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
      systemMessage: '[artibot:skill-discovery] meta-skill injected (first session today).',
    },
    shouldWriteGate: true,
  };
}

/**
 * Programmatic entry — used by session-start.js to chain in-process without
 * spawning a second hook process. Returns true when the inject ran.
 * @param {string} [pluginRoot]
 * @returns {Promise<boolean>}
 */
export async function maybeInject(pluginRoot = getPluginRoot()) {
  try {
    const stamp = todayStamp();
    const filePath = gatePath(pluginRoot);
    const lastDate = await readLastDate(filePath);
    if (lastDate === stamp) return false;
    await writeGate(filePath, stamp);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const raw = await readStdin();
  parseJSON(raw); // Tolerate malformed payloads — pass-through is the default.

  const pluginRoot = getPluginRoot();
  const stamp = todayStamp();
  const filePath = gatePath(pluginRoot);
  const lastDate = await readLastDate(filePath);
  const skillBody = await loadMetaSkill(pluginRoot);

  const { output, shouldWriteGate } = decide({ pluginRoot, stamp, lastDate, skillBody });
  if (shouldWriteGate) {
    await writeGate(filePath, stamp);
  }
  writeStdout(output);
}

// CLI entry guard — only run main() when invoked as a script, not when
// imported by session-start.js or unit tests.
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return argv1 === here;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
}
