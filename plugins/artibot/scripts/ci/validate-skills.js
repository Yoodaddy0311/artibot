#!/usr/bin/env node
/**
 * CI: Validate skills SKILL.md files.
 * Checks that each skill directory has a SKILL.md with required fields:
 *   name, description
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, getPluginRoot } from './ci-utils.js';

const REQUIRED_FIELDS = ['name', 'description'];

function main() {
  const skillsDir = path.join(getPluginRoot(), 'skills');
  if (!existsSync(skillsDir)) {
    console.log('No skills/ directory found. Skipping.');
    process.exit(0);
  }

  const entries = readdirSync(skillsDir).filter((e) => {
    const full = path.join(skillsDir, e);
    return statSync(full).isDirectory();
  });

  if (entries.length === 0) {
    console.log('No skill directories found. Skipping.');
    process.exit(0);
  }

  let errors = 0;

  for (const dir of entries) {
    const skillPath = path.join(skillsDir, dir, 'SKILL.md');

    if (!existsSync(skillPath)) {
      console.error(`FAIL: skills/${dir}/ - Missing SKILL.md`);
      errors++;
      continue;
    }

    const content = readFileSync(skillPath, 'utf-8');
    const frontmatter = extractFrontmatter(content);

    if (!frontmatter) {
      console.error(`FAIL: skills/${dir}/SKILL.md - Missing YAML frontmatter`);
      errors++;
      continue;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!frontmatter[field]) {
        console.error(`FAIL: skills/${dir}/SKILL.md - Missing required field: ${field}`);
        errors++;
      }
    }

    if (frontmatter.name && frontmatter.description) {
      console.log(`PASS: skills/${dir}/`);
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} validation error(s) found.`);
    process.exit(1);
  }

  console.log(`\nAll ${entries.length} skill(s) validated successfully.`);
}

main();
