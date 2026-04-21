#!/usr/bin/env node
/**
 * Artibot statusline renderer entrypoint.
 *
 * Writes a single-line status string to stdout for the Claude Code statusline.
 * Fails soft: any error => empty output (so the shell wrapper can no-op).
 *
 * Env:
 *   CLAUDE_PLUGIN_ROOT — preferred path resolution hint.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const line = await renderStatusLine({ pluginRoot, config });
    process.stdout.write(line || '');
  } catch {
    process.stdout.write('');
  }
}

main().catch(() => {
  // Belt-and-suspenders: never crash the statusline consumer.
  process.stdout.write('');
});
