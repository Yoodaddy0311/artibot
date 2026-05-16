/**
 * Frontmatter structure tests for /adr + /migrate commands and their backing
 * skills (adr-format, zero-downtime-migration).
 *
 * Why these matter: commands without proper frontmatter silently fail to
 * register with the Claude Code dispatcher — `/adr` would simply not appear
 * in the slash-command list, and the auto-command-suggest hook's advisory
 * would point users at a command that does not exist. SKILL.md without a
 * `name` field cannot be discovered by the skill loader, breaking
 * progressive disclosure. Each assertion below blocks a specific class of
 * production regression.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '../..');

/**
 * Extract the YAML frontmatter block (between the leading `---` fences) and
 * return raw key→string-value pairs. Intentionally minimal: we only need to
 * verify presence and rough shape of required fields, not parse arbitrary YAML.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const block = match[1];
  const fields = {};
  let currentKey = null;
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      fields[currentKey] = kv[2];
    } else if (currentKey && line.trim()) {
      fields[currentKey] += '\n' + line.trim();
    }
  }
  return fields;
}

describe('/adr command frontmatter', () => {
  // Blocks: /adr disappearing from the slash-command palette.
  it('commands/adr.md exists and has a frontmatter block', async () => {
    const p = path.join(PLUGIN_ROOT, 'commands/adr.md');
    const content = await readFile(p, 'utf-8');
    expect(parseFrontmatter(content)).not.toBeNull();
  });

  // Blocks: command listed without a tooltip in the palette.
  it('has a non-empty description', async () => {
    const p = path.join(PLUGIN_ROOT, 'commands/adr.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm.description).toBeTruthy();
    expect(fm.description.length).toBeGreaterThan(10);
  });

  // Blocks: user invokes /adr with no args and gets a confusing failure
  // instead of an argument hint.
  it('has an argument-hint', async () => {
    const p = path.join(PLUGIN_ROOT, 'commands/adr.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm['argument-hint']).toBeTruthy();
  });

  // Blocks: command receives unrestricted tool access at runtime.
  it('declares allowed-tools', async () => {
    const p = path.join(PLUGIN_ROOT, 'commands/adr.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm['allowed-tools']).toBeTruthy();
    expect(fm['allowed-tools']).toMatch(/Read|Write|Task/);
  });
});

describe('/migrate command frontmatter', () => {
  // Blocks: /migrate disappearing from the slash-command palette.
  it('commands/migrate.md exists with frontmatter', async () => {
    const p = path.join(PLUGIN_ROOT, 'commands/migrate.md');
    const content = await readFile(p, 'utf-8');
    expect(parseFrontmatter(content)).not.toBeNull();
  });

  // Blocks: command listed without a tooltip.
  it('has a non-empty description', async () => {
    const p = path.join(PLUGIN_ROOT, 'commands/migrate.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm.description).toBeTruthy();
    expect(fm.description.length).toBeGreaterThan(10);
  });

  // Blocks: invocation without `source → target` left unguided.
  it('has an argument-hint', async () => {
    const p = path.join(PLUGIN_ROOT, 'commands/migrate.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm['argument-hint']).toBeTruthy();
  });

  // Blocks: unrestricted tool access during migration planning.
  it('declares allowed-tools including Task delegation', async () => {
    const p = path.join(PLUGIN_ROOT, 'commands/migrate.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm['allowed-tools']).toBeTruthy();
    expect(fm['allowed-tools']).toMatch(/Task/);
  });
});

describe('adr-format skill frontmatter', () => {
  // Blocks: skill loader silently skipping the skill (no `name` → no entry).
  it('SKILL.md exists with name = adr-format', async () => {
    const p = path.join(PLUGIN_ROOT, 'skills/adr-format/SKILL.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm).not.toBeNull();
    expect(fm.name).toBe('adr-format');
  });

  // Blocks: skill discovery hook failing to inject the skill into the model's
  // context — `description` is the field the discovery uses for relevance.
  it('has a description suitable for skill discovery', async () => {
    const p = path.join(PLUGIN_ROOT, 'skills/adr-format/SKILL.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm.description).toBeTruthy();
    expect(fm.description.length).toBeGreaterThan(40);
  });
});

describe('zero-downtime-migration skill frontmatter', () => {
  // Blocks: skill not discoverable when /migrate fires.
  it('SKILL.md exists with name = zero-downtime-migration', async () => {
    const p = path.join(PLUGIN_ROOT, 'skills/zero-downtime-migration/SKILL.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm).not.toBeNull();
    expect(fm.name).toBe('zero-downtime-migration');
  });

  // Blocks: skill discovery hook failing to load the 6-section checklist.
  it('has a description suitable for skill discovery', async () => {
    const p = path.join(PLUGIN_ROOT, 'skills/zero-downtime-migration/SKILL.md');
    const fm = parseFrontmatter(await readFile(p, 'utf-8'));
    expect(fm.description).toBeTruthy();
    expect(fm.description.length).toBeGreaterThan(40);
  });
});
