#!/usr/bin/env node
/**
 * SessionStart helper — a once-per-local-day gate for the using-agent-skills
 * meta-skill. Two entry points, and only the first one runs today:
 *   - `maybeInject()`: called in-process by session-start.js. It ONLY writes the
 *     day gate and answers true on the day's first call; it injects nothing.
 *   - `main()`: the stand-alone hook that WOULD inject the meta-skill prose as
 *     SessionStart additionalContext (`decide`). It is not registered in
 *     hooks/hooks.json or hooks/dispatch-table.json (grep, 2026-11-22), so the
 *     prose is not injected anywhere at present.
 * (The skill count is not hard-coded here — scripts/ci/readme-claims-registry.js
 * #collectActuals derives it from a live scan of `skills/`.)
 *
 * Gating: `<state dir>/runtime/last-session-date.txt` holds today's local date
 * (YYYY-MM-DD). When the file already contains today's value, this hook
 * exits with a benign continue so session-start.js can carry on without
 * additional context cost. The gate is GLOBAL state — one user, one day, any
 * project, any plugin build — so it lives in the artibot state dir
 * (`lib/core/runtime-state.js`), never beside the plugin root: an installed
 * plugin's `<pluginRoot>/../..` is the marketplace cache dir (2026-11-22, a
 * stray `~/.claude/plugins/cache/artibot/runtime/state/` was measured there).
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
import { resolveGlobalStatePath } from '../../lib/core/runtime-state.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'skill-discovery-inject';

/**
 * Absolute path of the once-per-day gate: `<state dir>/runtime/last-session-date.txt`.
 * Not migrated from the old `<pluginRoot>/../../runtime/state/` copy — a missing gate
 * costs at most one extra first-of-day surfacing.
 * @returns {string}
 */
function gatePath() {
  return resolveGlobalStatePath('runtime/last-session-date.txt');
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
 * Programmatic entry — used by session-start.js in-process. Writes the day gate
 * only; it does NOT inject the meta-skill (only the unregistered `main()` would).
 * Returns true on the first call of the local day, false otherwise.
 * @param {string} [_pluginRoot] - accepted for the session-start.js call; it no
 *   longer decides where the gate lives (see {@link gatePath}).
 * @returns {Promise<boolean>}
 */
export async function maybeInject(_pluginRoot) {
  try {
    const stamp = todayStamp();
    const filePath = gatePath();
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
  const filePath = gatePath();
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
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME, { exit: true }));
}
