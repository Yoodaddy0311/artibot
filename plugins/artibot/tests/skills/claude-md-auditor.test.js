/**
 * claude-md-auditor skill — frontmatter + structural smoke tests.
 *
 * Validates that the skill file exists, has required frontmatter fields,
 * and includes the 6-criteria rubric + anti-patterns the GRPO loop
 * depends on. Pure file-read tests; no IO beyond reading the SKILL.md.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = path.resolve(__dirname, '../../skills/claude-md-auditor/SKILL.md');

function extractFrontmatter(content) {
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.slice(3, end);
}

describe('claude-md-auditor SKILL.md', () => {
  it('skill file exists', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('has required frontmatter fields', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    const fm = extractFrontmatter(content);
    expect(fm).toContain('name: claude-md-auditor');
    expect(fm).toContain('user-invocable: true');
    expect(fm).toContain('level: 2');
    expect(fm).toContain('category: "quality"');
    expect(fm).toContain('whenNotToUse:');
  });

  it('lists the canonical trigger phrases', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    const fm = extractFrontmatter(content);
    for (const trigger of ['"claude.md"', '"audit memory"', '"memory quality"', '"project context"', '"메모리 품질"']) {
      expect(fm).toContain(trigger);
    }
  });

  it('documents all 6 rubric criteria with max points', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    expect(content).toMatch(/Commands.*Workflows.*\|\s*20/);
    expect(content).toMatch(/Architecture Clarity.*\|\s*20/);
    expect(content).toMatch(/Non-Obvious Patterns.*\|\s*15/);
    expect(content).toMatch(/Conciseness.*\|\s*15/);
    expect(content).toMatch(/Currency.*\|\s*15/);
    expect(content).toMatch(/Actionability.*\|\s*15/);
  });

  it('defines all A–F grade thresholds', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    expect(content).toContain('**A** 90+');
    expect(content).toContain('**B** 70');
    expect(content).toContain('**C** 50');
    expect(content).toContain('**D** 30');
    expect(content).toContain('**F**');
  });

  it('forbids Edit before approval (Phase 5 gate)', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    expect(content).toMatch(/explicit.*yes/i);
    expect(content).toMatch(/SKIPPED/);
  });

  it('uses Glob (Windows portability), never find', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    expect(content).toContain('Glob');
    expect(content).toContain('not find');
  });

  it('writes audit-cache.json so nightly GRPO can pick it up', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    expect(content).toContain('~/.claude/artibot/audit-cache.json');
    expect(content).toContain('avgScore');
    expect(content).toContain('claudeMdQuality');
  });

  it('includes 4 Bad/Good anti-patterns', async () => {
    const content = await readFile(SKILL_PATH, 'utf-8');
    expect(content).toContain('Obvious code info');
    expect(content).toContain('Generic best practices');
    expect(content).toContain('One-off fixes');
    expect(content).toContain('Verbose explanations');
    const badCount = (content.match(/\*\*Bad\*\*/g) ?? []).length;
    const goodCount = (content.match(/\*\*Good\*\*/g) ?? []).length;
    expect(badCount).toBeGreaterThanOrEqual(4);
    expect(goodCount).toBeGreaterThanOrEqual(4);
  });
});
