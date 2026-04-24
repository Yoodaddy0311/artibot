#!/usr/bin/env node
/**
 * validate-bin.js — Guard against silent loss of `package.json` bin entries.
 *
 * Historical context: an auto-commit / external linter was suspected of
 * stripping the `artibot-dashboard` entry between writes. This check locks in
 * the required bin set so any future drift fails CI fast.
 *
 * Exit codes:
 *   0 — all required bin entries present and point to existing files
 *   1 — missing entry, wrong target, or missing target file
 *
 * Zero dependencies. Node 18+ built-ins only.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(scriptDir, '..');
const PKG_PATH = path.join(PLUGIN_ROOT, 'package.json');

/**
 * Canonical bin entries. Add new CLIs here; CI will enforce them.
 * @type {Readonly<Record<string, string>>}
 */
const REQUIRED_BIN = Object.freeze({
  artibot: './bin/artibot.js',
  'artibot-dashboard': './bin/artibot-dashboard.mjs',
});

const errors = [];

if (!existsSync(PKG_PATH)) {
  console.error(`[validate-bin] package.json not found at ${PKG_PATH}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
const bin = pkg.bin || {};

for (const [name, expected] of Object.entries(REQUIRED_BIN)) {
  const actual = bin[name];
  if (!actual) {
    errors.push(`Missing bin entry: "${name}" (expected "${expected}")`);
    continue;
  }
  if (actual !== expected) {
    errors.push(`Bin entry "${name}" points to "${actual}" (expected "${expected}")`);
  }
  const target = path.join(PLUGIN_ROOT, actual);
  if (!existsSync(target)) {
    errors.push(`Bin target missing on disk: ${actual}`);
  }
}

if (errors.length > 0) {
  console.error('[validate-bin] Failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`[validate-bin] OK — ${Object.keys(REQUIRED_BIN).length} bin entries verified`);
