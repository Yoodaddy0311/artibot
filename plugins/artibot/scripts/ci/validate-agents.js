#!/usr/bin/env node
/**
 * CI: Validate agents/*.md files.
 * Checks that each agent file has valid YAML frontmatter with required fields:
 *   name, description, model
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, getPluginRoot } from './ci-utils.js';

const REQUIRED_FIELDS = ['name', 'description', 'model'];

function main() {
  const agentsDir = path.join(getPluginRoot(), 'agents');
  if (!existsSync(agentsDir)) {
    console.log('No agents/ directory found. Skipping.');
    process.exit(0);
  }

  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('No agent .md files found. Skipping.');
    process.exit(0);
  }

  let errors = 0;

  for (const file of files) {
    const filePath = path.join(agentsDir, file);
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

    if (frontmatter.name && frontmatter.description && frontmatter.model) {
      console.log(`PASS: ${file}`);
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} validation error(s) found.`);
    process.exit(1);
  }

  console.log(`\nAll ${files.length} agent(s) validated successfully.`);
}

main();
