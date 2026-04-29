/**
 * Tests for persona-distill skill (Adoption IDs AD-50, AD-51).
 * Validates frontmatter, body sections, and reference files.
 *
 * @see plugins/artibot/skills/persona-distill/SKILL.md
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve plugin root: tests/skills/ → tests/ → plugins/artibot/
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const SKILL_DIR = resolve(PLUGIN_ROOT, 'skills', 'persona-distill');
const SKILL_PATH = resolve(SKILL_DIR, 'SKILL.md');
const REF_SIX_LAYER = resolve(SKILL_DIR, 'references', 'six-layer-persona.md');
const REF_TAG_MAP = resolve(SKILL_DIR, 'references', 'tag-behavior-map.md');

let skillText;
let refSixLayerText;
let refTagMapText;

beforeAll(() => {
  skillText = readFileSync(SKILL_PATH, 'utf8');
  refSixLayerText = readFileSync(REF_SIX_LAYER, 'utf8');
  refTagMapText = readFileSync(REF_TAG_MAP, 'utf8');
});

// ---------------------------------------------------------------------------
// Frontmatter parsing helper (lightweight; avoids cross-test coupling)
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
      // Multi-line or array follows
      currentArray = [];
      fields[key] = currentArray;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      // Inline array
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

describe('persona-distill SKILL.md frontmatter', () => {
  it('has name = persona-distill', () => {
    const fm = parseFrontmatter(skillText);
    expect(fm).not.toBeNull();
    expect(fm.name).toBe('persona-distill');
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

  it('has triggers array including persona/distill keywords', () => {
    const fm = parseFrontmatter(skillText);
    expect(Array.isArray(fm.triggers)).toBe(true);
    expect(fm.triggers).toContain('persona');
    expect(fm.triggers).toContain('distill');
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

  it('has allowed-tools restricting to read/write/edit (no network)', () => {
    // allowed-tools may parse with the dash; just check raw text contains it
    expect(skillText).toContain('allowed-tools');
    expect(skillText).toContain('Read');
    expect(skillText).toContain('Write');
    expect(skillText).toContain('Edit');
    // No fetch / bash / http tools
    expect(skillText).not.toMatch(/allowed-tools[\s\S]{0,200}WebFetch/);
    expect(skillText).not.toMatch(/allowed-tools[\s\S]{0,200}Bash/);
  });
});

// ---------------------------------------------------------------------------
// Body sections (anti-rationalization + red flags pattern from Squad B)
// ---------------------------------------------------------------------------

describe('persona-distill SKILL.md body sections', () => {
  it('contains Common Rationalizations section', () => {
    expect(skillText).toMatch(/##\s*Common Rationalizations/);
  });

  it('contains Red Flags section', () => {
    expect(skillText).toMatch(/##\s*Red Flags/);
  });

  it('contains a Process section', () => {
    expect(skillText).toMatch(/##\s*Process/);
  });

  it('contains a Verification section', () => {
    expect(skillText).toMatch(/##\s*Verification/);
  });

  it('contains a See Also section linking persona-architect', () => {
    expect(skillText).toMatch(/##\s*See Also/);
    expect(skillText).toContain('persona-architect');
  });

  it('cites the 6-layer reference file', () => {
    expect(skillText).toContain('six-layer-persona');
  });

  it('cites the tag-behavior reference file', () => {
    expect(skillText).toContain('tag-behavior-map');
  });

  it('Common Rationalizations table has at least 5 rows', () => {
    const start = skillText.indexOf('## Common Rationalizations');
    const end = skillText.indexOf('## Red Flags', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = skillText.slice(start, end);
    // Count rows: lines that start with "|" and have at least 3 pipes (3-column table)
    const rows = section.split('\n').filter((l) => /^\s*\|/.test(l) && (l.match(/\|/g) || []).length >= 4);
    // Subtract 2: header row + separator row
    const dataRows = rows.length - 2;
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
});

// ---------------------------------------------------------------------------
// Reference files exist
// ---------------------------------------------------------------------------

describe('persona-distill reference files', () => {
  it('references/six-layer-persona.md exists', () => {
    expect(existsSync(REF_SIX_LAYER)).toBe(true);
  });

  it('references/tag-behavior-map.md exists', () => {
    expect(existsSync(REF_TAG_MAP)).toBe(true);
  });

  it('six-layer-persona.md describes all 6 layers (0..5)', () => {
    expect(refSixLayerText).toMatch(/Layer 0/);
    expect(refSixLayerText).toMatch(/Layer 1/);
    expect(refSixLayerText).toMatch(/Layer 2/);
    expect(refSixLayerText).toMatch(/Layer 3/);
    expect(refSixLayerText).toMatch(/Layer 4/);
    expect(refSixLayerText).toMatch(/Layer 5/);
  });

  it('six-layer-persona.md includes worked example for persona-architect', () => {
    expect(refSixLayerText).toMatch(/persona-architect/i);
    expect(refSixLayerText).toMatch(/Worked Example/i);
  });

  it('tag-behavior-map.md includes at least 12 active tags', () => {
    // Count rows in the active tags table by counting backtick-wrapped tag names
    const start = refTagMapText.indexOf('## Active Tags');
    const end = refTagMapText.indexOf('## Composition Examples', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = refTagMapText.slice(start, end);
    // Tag names appear as `tag-name` in the first column
    const tagMatches = section.match(/^\|\s*`[a-z][a-z0-9-]+`/gm) || [];
    expect(tagMatches.length).toBeGreaterThanOrEqual(12);
  });

  it('tag-behavior-map.md includes Artibot DNA tags', () => {
    expect(refTagMapText).toContain('dev-strict');
    expect(refTagMapText).toContain('tdd-first');
    expect(refTagMapText).toContain('ko-path-aware');
    expect(refTagMapText).toContain('zero-dep');
    expect(refTagMapText).toContain('refactor-first');
    expect(refTagMapText).toContain('swarm-coordinator');
    expect(refTagMapText).toContain('prompt-cache-aware');
    expect(refTagMapText).toContain('data-policy-strict');
    expect(refTagMapText).toContain('dev-protocol-strict');
  });

  it('tag-behavior-map.md has REJECTED Tags section', () => {
    expect(refTagMapText).toMatch(/##\s*Rejected Tags/i);
  });

  it('tag-behavior-map.md REJECTED section includes workplace-political tags', () => {
    expect(refTagMapText).toContain('PUA-master');
    expect(refTagMapText).toContain('blame-shifter');
    expect(refTagMapText).toContain('passive-aggressive');
  });

  it('tag-behavior-map.md REJECTED tags do NOT appear in active set', () => {
    const start = refTagMapText.indexOf('## Active Tags');
    const end = refTagMapText.indexOf('## Composition Examples', start);
    const activeSection = refTagMapText.slice(start, end);
    expect(activeSection).not.toContain('PUA-master');
    expect(activeSection).not.toContain('blame-shifter');
    expect(activeSection).not.toContain('passive-aggressive');
  });

  it('six-layer-persona.md cites colleague-skill source', () => {
    expect(refSixLayerText).toMatch(/AD-50|colleague-skill/);
  });

  it('tag-behavior-map.md cites adoption ID AD-51', () => {
    expect(refTagMapText).toMatch(/AD-51|colleague-skill-benchmark/);
  });
});

// ---------------------------------------------------------------------------
// Cross-link integrity
// ---------------------------------------------------------------------------

describe('persona-distill cross-links', () => {
  it('SKILL.md does not endorse external HTTP fetches (DATA POLICY)', () => {
    // External SaaS names may appear ONLY in REJECTED / DATA POLICY context.
    // Verify allowed-tools list contains no network-capable tools.
    expect(skillText).not.toMatch(/allowed-tools[\s\S]{0,200}WebFetch/);
    expect(skillText).not.toMatch(/allowed-tools[\s\S]{0,200}Bash/);
    // If external service names appear, they must be flagged as rejected or DATA POLICY.
    const externalRefs = /feishu|dingtalk|wechat|whisper-api|slack-bot/i.test(skillText);
    if (externalRefs) {
      expect(skillText).toMatch(/REJECTED|DATA POLICY|refuse|forbidden|never invoke/i);
    }
  });

  it('SKILL.md mentions DATA POLICY explicitly', () => {
    expect(skillText).toMatch(/DATA POLICY/);
  });
});
