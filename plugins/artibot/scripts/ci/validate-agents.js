#!/usr/bin/env node
/**
 * CI: Validate agents/*.md files.
 * Checks that each agent file has valid YAML frontmatter with required fields:
 *   name, description, model
 *
 * It also holds every file to the strict dialect (`checkStrictAgentFrontmatter`):
 * no comment and no three-dash run inside the block. The host closes frontmatter at
 * the first `---` it sees, comment or not, so a comment inside `tools:` silently
 * drops every key after it. This is the same function the firewall gate
 * (`tests/firewall/frontmatter-tool-names.test.js`) calls, so the two cannot drift.
 * The gate of record is that vitest file; this check is a second consumer of the
 * same oracle. The runtime registry stays lenient on purpose (extension agents).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  checkStrictAgentFrontmatter,
  extractFrontmatter,
  getPluginRoot,
  STRICT_AGENT_RULE_HINTS,
} from './ci-utils.js';

const REQUIRED_FIELDS = ['name', 'description', 'model'];

function main() {
  const agentsDir = path.join(getPluginRoot(), 'agents');
  if (!existsSync(agentsDir)) {
    console.log('No agents/ directory found. Skipping.');
    process.exit(0);
  }

  // Exclude documentation files (INDEX.md, README.md) — they live in agents/
  // for discoverability but are not agent definitions.
  const files = readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'README.md');
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

    let fileErrors = 0;

    for (const field of REQUIRED_FIELDS) {
      if (!frontmatter[field]) {
        console.error(`FAIL: ${file} - Missing required field: ${field}`);
        errors++;
        fileErrors++;
      }
    }

    for (const v of checkStrictAgentFrontmatter(content).violations) {
      console.error(
        `FAIL: ${file}:${v.line} - strict frontmatter [${v.rule}] ${STRICT_AGENT_RULE_HINTS[v.rule]}: ${v.text.trim()}`,
      );
      errors++;
      fileErrors++;
    }

    // A file that failed any check never prints PASS (the log is read by people).
    if (fileErrors === 0) {
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
