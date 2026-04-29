/**
 * whenNotToUse frontmatter coverage test.
 *
 * Reads all SKILL.md files under plugins/artibot/skills/ and asserts that
 * at least 20 of them contain the `whenNotToUse:` frontmatter field (AD-26).
 *
 * The 20 Squad-B target skills must all have this field.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '../../skills');

/** Parse frontmatter block from SKILL.md content. Returns the raw frontmatter string. */
function extractFrontmatter(content) {
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.slice(3, end);
}

/** Recursively collect all SKILL.md paths under the skills directory. */
async function collectSkillFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        const skillMd = path.join(fullPath, 'SKILL.md');
        try {
          await stat(skillMd);
          results.push(skillMd);
        } catch {
          // No SKILL.md in this directory — skip
        }
      }
    } catch {
      // Inaccessible entry — skip
    }
  }
  return results;
}

const SQUAD_B_SKILLS = [
  'spec-format',
  'tdd-workflow',
  'production-code-audit',
  'code-slop-reviewer',
  'systematic-debugging',
  'verification-completion',
  'quality-framework',
  'coding-standards',
  'security-standards',
  'testing-standards',
  'tool-design',
  'prompt-engineering',
  'delegation',
  'multi-agent-patterns',
  'memory-management',
  'strategic-compact',
  'fp-refactor',
  'ddd-tactical-design',
  'clarify',
  'polish',
];

describe('whenNotToUse frontmatter coverage (AD-26)', () => {
  it('at least 20 skills have whenNotToUse in frontmatter', async () => {
    const skillFiles = await collectSkillFiles(SKILLS_ROOT);
    let count = 0;
    for (const filePath of skillFiles) {
      const content = await readFile(filePath, 'utf-8');
      const frontmatter = extractFrontmatter(content);
      if (frontmatter.includes('whenNotToUse:')) {
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(20);
  });

  it('all 20 Squad-B target skills have whenNotToUse in frontmatter', async () => {
    const missing = [];
    for (const skillName of SQUAD_B_SKILLS) {
      const filePath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
      let content;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        missing.push(`${skillName} (file not found)`);
        continue;
      }
      const frontmatter = extractFrontmatter(content);
      if (!frontmatter.includes('whenNotToUse:')) {
        missing.push(skillName);
      }
    }
    expect(missing).toEqual([]);
  });
});
