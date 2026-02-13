#!/usr/bin/env node
/**
 * CI: Validate commands/*.md files.
 * Checks that each command file has required fields:
 *   description, argument-hint
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const REQUIRED_FIELDS = ['description', 'argument-hint'];

function getPluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return path.resolve(process.env.CLAUDE_PLUGIN_ROOT);
  const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
  return path.resolve(thisDir, '..', '..');
}

function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([\w][\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1].trim()] = kv[2].trim();
  }
  return fields;
}

function main() {
  const commandsDir = path.join(getPluginRoot(), 'commands');
  if (!existsSync(commandsDir)) {
    console.log('No commands/ directory found. Skipping.');
    process.exit(0);
  }

  const files = readdirSync(commandsDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('No command .md files found. Skipping.');
    process.exit(0);
  }

  let errors = 0;

  for (const file of files) {
    const filePath = path.join(commandsDir, file);
    const content = readFileSync(filePath, 'utf-8');
    const frontmatter = extractFrontmatter(content);

    if (!frontmatter) {
      console.error(`FAIL: ${file} - Missing YAML frontmatter (--- block)`);
      errors++;
      continue;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!frontmatter[field]) {
        console.error(`FAIL: ${file} - Missing required field: ${field}`);
        errors++;
      }
    }

    if (frontmatter.description && frontmatter['argument-hint']) {
      console.log(`PASS: ${file}`);
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} validation error(s) found.`);
    process.exit(1);
  }

  console.log(`\nAll ${files.length} command(s) validated successfully.`);
}

main();
