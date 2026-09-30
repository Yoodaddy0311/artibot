#!/usr/bin/env node
/**
 * Artibot statusline renderer entrypoint.
 *
 * Writes a single-line status string to stdout for the Claude Code statusline.
 * Fails soft: any error => empty output (so the shell wrapper can no-op).
 *
 * Claude Code hands a statusLine command its payload on stdin. The only field read
 * here is `session_id`: the hooks keep per-session state under
 * `~/.claude/artibot/runtime/sessions/<session_id>/` (`lib/core/runtime-state.js`),
 * and a renderer that does not know its session can only show the flat fallback.
 * Reading stdin is best-effort and time-boxed: a terminal, a closed pipe or a parent
 * that never closes stdin must not stall the bar — the answer is then "no session".
 *
 * Env:
 *   CLAUDE_PLUGIN_ROOT — preferred path resolution hint.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How long to wait for the statusLine payload before rendering without a session. */
const STDIN_TIMEOUT_MS = 500;

/**
 * @returns {Promise<string|null>} the payload's `session_id`, or null when stdin is a
 *   terminal, is empty, is not JSON, or does not finish inside {@link STDIN_TIMEOUT_MS}.
 */
async function readSessionId() {
  if (process.stdin.isTTY) return null;
  let timer;
  try {
    const raw = await Promise.race([
      (async () => {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf-8');
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(''), STDIN_TIMEOUT_MS);
      }),
    ]);
    const id = JSON.parse(raw)?.session_id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // A parent that never closes stdin would otherwise keep this process alive after
    // the line is printed: the read above is still pending when the timeout wins.
    try { process.stdin.destroy(); } catch { /* already closed */ }
  }
}

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

  let config;
  try {
    const configPath = path.join(pluginRoot, 'artibot.config.json');
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // Missing / unreadable config => dashboard disabled, empty output.
    process.stdout.write('');
    return;
  }

  let renderStatusLine;
  try {
    ({ renderStatusLine } = await import('../lib/tui/dashboard.js'));
  } catch {
    process.stdout.write('');
    return;
  }

  try {
    const sessionId = await readSessionId();
    const line = await renderStatusLine({ pluginRoot, config, sessionId });
    process.stdout.write(line || '');
  } catch {
    process.stdout.write('');
  }
}

main().catch(() => {
  // Belt-and-suspenders: never crash the statusline consumer.
  process.stdout.write('');
});
