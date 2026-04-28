/**
 * Anti-rationalization section presence test.
 *
 * Asserts that each of the 20 Squad-B target SKILL.md files contains both
 * "## Common Rationalizations" and "## Red Flags" headers required by AD-22.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '../../skills');

const TARGET_SKILLS = [
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

describe('Anti-rationalization sections (AD-22)', () => {
  for (const skillName of TARGET_SKILLS) {
    it(`${skillName}/SKILL.md has ## Common Rationalizations`, async () => {
      const filePath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toContain('## Common Rationalizations');
    });

    it(`${skillName}/SKILL.md has ## Red Flags`, async () => {
      const filePath = path.join(SKILLS_ROOT, skillName, 'SKILL.md');
      const content = await readFile(filePath, 'utf-8');
      expect(content).toContain('## Red Flags');
    });
  }
});
