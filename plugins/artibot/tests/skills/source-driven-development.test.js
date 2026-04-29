/**
 * Tests for source-driven-development skill (Adoption ID AD-32).
 * Validates frontmatter, body sections, and integration with sdd-cache hook.
 *
 * @see plugins/artibot/skills/source-driven-development/SKILL.md
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve plugin root: tests/skills/ → tests/ → plugins/artibot/
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const SKILL_PATH = resolve(PLUGIN_ROOT, 'skills', 'source-driven-development', 'SKILL.md');

let skillText;

beforeAll(() => {
  skillText = readFileSync(SKILL_PATH, 'utf8');
});

// ---------------------------------------------------------------------------
// Frontmatter parsing helper (lightweight; intentionally local to this file)
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const body = match[1];
  const fields = {};
  const lines = body.split(/\r?\n/);
  let currentArray = null;
  for (const line of lines) {
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayItemMatch && currentArray) {
      currentArray.push(arrayItemMatch[1].replace(/^["']|["']$/g, ''));
      continue;
    }
    const kvMatch = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const [, key, rawVal] = kvMatch;
    const val = rawVal.trim();
    if (val === '' || val === '|') {
      currentArray = [];
      fields[key] = currentArray;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      fields[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      currentArray = null;
    } else {
      fields[key] = val.replace(/^["']|["']$/g, '');
      currentArray = null;
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe('source-driven-development SKILL.md frontmatter', () => {
  it('has name = source-driven-development', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm).not.toBeNull();
    expect(fm.name).toBe('source-driven-development');
  });

  it('has whenNotToUse field (Squad B schema requirement)', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm.whenNotToUse).toBeDefined();
    expect(typeof fm.whenNotToUse).toBe('string');
    expect(fm.whenNotToUse.length).toBeGreaterThan(20);
  });

  it('has description', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm.description).toBeDefined();
    expect(fm.description.length).toBeGreaterThan(20);
  });

  it('has triggers list', () => {
    const fm = parseFrontmatter(skillText);
    expect(Array.isArray(fm.triggers)).toBe(true);
    expect(fm.triggers.length).toBeGreaterThanOrEqual(8);
  });

  it('triggers list contains framework keywords', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm.triggers).toContain('framework');
    expect(fm.triggers).toContain('library');
    expect(fm.triggers).toContain('SDK');
    expect(fm.triggers).toContain('official docs');
    expect(fm.triggers).toContain('MDN');
    expect(fm.triggers).toContain('deprecated');
    expect(fm.triggers).toContain('migration');
  });

  it('has Korean triggers for Korean-primary user', () => {
    const fm = parseFrontmatter(skillText);
    const koTriggers = fm.triggers.filter((t) => /[\u3131-\uD79D]/u.test(t));
    expect(koTriggers.length).toBeGreaterThanOrEqual(2);
  });

  it('has level field', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm.level).toBeDefined();
  });

  it('declares allowed-tools including WebFetch and Context7 MCP', () => {
    expect(skillText).toContain('allowed-tools');
    expect(skillText).toContain('WebFetch');
    expect(skillText).toContain('context7');
  });
});

// ---------------------------------------------------------------------------
// Body sections
// ---------------------------------------------------------------------------

describe('source-driven-development SKILL.md body sections', () => {
  it('contains DETECT-FETCH-IMPLEMENT-CITE process flow', () => {
    expect(skillText).toContain('DETECT');
    expect(skillText).toContain('FETCH');
    expect(skillText).toContain('IMPLEMENT');
    expect(skillText).toContain('CITE');
  });

  it('contains Common Rationalizations section', () => {
    expect(skillText).toMatch(/##\s*Common Rationalizations/);
  });

  it('contains Red Flags section', () => {
    expect(skillText).toMatch(/##\s*Red Flags/);
  });

  it('contains Verification section', () => {
    expect(skillText).toMatch(/##\s*Verification/);
  });

  it('contains When NOT to Use section', () => {
    expect(skillText).toMatch(/##\s*When NOT to Use/);
  });

  it('contains Source Hierarchy table', () => {
    expect(skillText).toMatch(/##\s*Source Hierarchy/);
    expect(skillText).toContain('react.dev');
    expect(skillText).toContain('MDN');
  });

  it('contains Citation Rules section', () => {
    expect(skillText).toMatch(/##\s*Citation Rules/);
  });

  it('Common Rationalizations table has at least 5 rows', () => {
    const start = skillText.indexOf('## Common Rationalizations');
    const end = skillText.indexOf('## Red Flags', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = skillText.slice(start, end);
    const rows = section.split('\n').filter((l) => /^\s*\|/.test(l) && (l.match(/\|/g) || []).length >= 4);
    const dataRows = rows.length - 2; // minus header + separator
    expect(dataRows).toBeGreaterThanOrEqual(5);
  });

  it('Red Flags has at least 5 bullet items', () => {
    const start = skillText.indexOf('## Red Flags');
    const end = skillText.indexOf('## Verification', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = skillText.slice(start, end);
    const bullets = section.split('\n').filter((l) => /^\s*-\s+\S/.test(l));
    expect(bullets.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects Stack Overflow as primary source', () => {
    expect(skillText).toMatch(/Stack Overflow/i);
    expect(skillText).toMatch(/[Nn]ot authoritative|never.*primary|never authoritative/);
  });

  it('mandates UNVERIFIED markers when docs absent', () => {
    expect(skillText).toContain('UNVERIFIED');
  });
});

// ---------------------------------------------------------------------------
// sdd-cache hook integration (Squad C deliverable)
// ---------------------------------------------------------------------------

describe('source-driven-development sdd-cache integration', () => {
  it('cites Squad C webfetch-cache hook by name', () => {
    expect(skillText).toContain('webfetch-cache-pre.js');
    expect(skillText).toContain('webfetch-cache-post.js');
  });

  it('describes cache-aware operation', () => {
    expect(skillText).toMatch(/##\s*Cache-Aware Operation/);
  });

  it('references HTTP 304 revalidation pattern', () => {
    expect(skillText).toMatch(/304/);
    expect(skillText).toMatch(/If-None-Match|ETag/);
  });

  it('confirms cache stays local (DATA POLICY)', () => {
    expect(skillText).toContain('runtime/cache/webfetch');
    expect(skillText).toMatch(/local|never leaves|DATA POLICY/i);
  });

  it('cites adoption ID AD-24 (sdd-cache) and AD-32 (this skill)', () => {
    expect(skillText).toMatch(/AD-24|sdd-cache/);
    expect(skillText).toMatch(/AD-32|agent-skills/);
  });
});

// ---------------------------------------------------------------------------
// Cross-link integrity
// ---------------------------------------------------------------------------

describe('source-driven-development cross-links', () => {
  it('links to webfetch-cache documentation', () => {
    expect(skillText).toContain('webfetch-cache.md');
  });

  it('links to persona-distill (See Also section)', () => {
    expect(skillText).toContain('persona-distill');
  });

  it('does not introduce DATA POLICY violations (no external chat APIs)', () => {
    expect(skillText).not.toMatch(/feishu|dingtalk|slack-bot|wechat-api/i);
  });
});
