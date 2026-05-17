#!/usr/bin/env node
/**
 * Pre-execute hook — Autopilot Intent Detector (v4.11.0 Track I).
 *
 * Detects user intent in plain prompts (queue / schedule / dry-run / template /
 * rollback) and writes the result to stdout as `metadata.autopilotIntents` so
 * downstream orchestrator components can silently auto-apply Track E/F/G/H
 * features WITHOUT the user typing any slash command.
 *
 * Contract:
 *   stdin  : Claude Code hook JSON payload (UserPromptSubmit / PreExecute).
 *   stdout : `{ "metadata": { "autopilotIntents": {...} } }` on success, or
 *            `{}` on parse/import failure (silent best-effort, never blocks).
 *
 * Registration:
 *   NOT wired in hooks.json. The orchestrator wires this hook into the chain
 *   later — keep this module purely standalone so it can be invoked stand-alone
 *   or via dispatch-table without configuration drift.
 *
 * DATA POLICY: pure local execution — no network, no external storage.
 *
 * @module hooks/autopilot-intent-detector
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOK_NAME = 'autopilot-intent-detector';

/**
 * Read all stdin and return raw UTF-8 text.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.resume();
  });
}

/**
 * Build a Korean-path-safe file:// URL for dynamic import on Windows.
 * @param {string} absPath
 * @returns {string}
 */
function toFileUrl(absPath) {
  try {
    return pathToFileURL(absPath).href;
  } catch {
    // Fallback for Windows + non-ASCII paths
    const norm = absPath.replace(/\\/g, '/');
    return `file:///${norm}`;
  }
}

/**
 * Locate `lib/cognitive/autopilot-intent.js` relative to this hook file.
 * @returns {string}
 */
function resolveIntentModulePath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // hooks/ sits beside lib/. If the hook is moved into scripts/hooks/, climb
  // one extra level. Resolve by checking the closer candidate first.
  return path.resolve(here, '..', 'lib', 'cognitive', 'autopilot-intent.js');
}

/**
 * Best-effort dynamic import — returns null on any failure.
 * @returns {Promise<{ detectAllIntents: Function } | null>}
 */
async function loadIntentModule() {
  try {
    const url = toFileUrl(resolveIntentModulePath());
    return await import(url);
  } catch {
    return null;
  }
}

/**
 * Pure handler: take a parsed hook payload, return the output envelope.
 * Exported for direct unit-testing without spawning a subprocess.
 *
 * @param {object|null} hookData - Parsed JSON payload (may be null/empty).
 * @returns {Promise<object>} Hook output envelope. `{}` on no-op.
 */
export async function handlePreExecute(hookData) {
  const prompt = extractPrompt(hookData);
  if (!prompt) return {};

  const mod = await loadIntentModule();
  if (!mod || typeof mod.detectAllIntents !== 'function') {
    // Silent fail — never block user flow on import errors.
    return {};
  }

  let intents;
  try {
    intents = mod.detectAllIntents(prompt);
  } catch {
    return {};
  }

  return {
    metadata: {
      autopilotIntents: intents,
      source: HOOK_NAME,
    },
  };
}

/**
 * Extract the user prompt from a hook payload, tolerating multiple shapes.
 * @param {object|null} hookData
 * @returns {string}
 */
function extractPrompt(hookData) {
  if (!hookData || typeof hookData !== 'object') return '';
  const candidates = [
    hookData.user_prompt,
    hookData.prompt,
    hookData.content,
    hookData?.message?.content,
    hookData?.input?.prompt,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

/**
 * Parse JSON without throwing.
 * @param {string} raw
 * @returns {object|null}
 */
function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Stdin → stdout main entrypoint. Always emits valid JSON (empty `{}` on
 * any failure path) so callers never see a parse error.
 */
async function main() {
  let envelope = {};
  try {
    const raw = await readStdin();
    const hookData = raw ? safeParseJson(raw) : null;
    envelope = await handlePreExecute(hookData);
  } catch {
    envelope = {};
  }
  process.stdout.write(JSON.stringify(envelope));
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(fileURLToPath(import.meta.url));
    return argv1 === here;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch(() => {
    // Final safety net — never throw out of a hook.
    process.stdout.write('{}');
  });
}
