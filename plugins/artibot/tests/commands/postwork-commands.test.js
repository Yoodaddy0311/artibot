/**
 * Frontmatter structure tests for /blindspot + /teach-back commands.
 *
 * These two commands replace the former post-work Stop hooks
 * (blindspot-check.js, teach-back.js) that auto-fired on every turn end. The
 * behaviour is now on-demand: the user invokes the command when they want the
 * blindspot scan or the learning corner, instead of the hook injecting it
 * automatically. Each assertion below blocks a specific regression:
 *   - missing frontmatter → command silently absent from the slash palette
 *   - missing description  → validate-commands.js CI fails (required field)
 *   - missing argument-hint → validate-commands.js CI fails (required field)
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '../..');

/**
 * Extract the YAML frontmatter block (between the leading `---` fences) and
 * return raw key→string-value pairs. Minimal parser: presence/shape only.
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

describe.each([
  ['blindspot', '사각지대', '🔍 사각지대 점검'],
  ['teach-back', '학습', '📚 학습 코너'],
])('/%s command frontmatter', (name, trigger, header) => {
  const cmdPath = path.join(PLUGIN_ROOT, `commands/${name}.md`);

  // Blocks: command disappearing from the slash-command palette.
  it('exists and has a frontmatter block', async () => {
    const content = await readFile(cmdPath, 'utf-8');
    expect(parseFrontmatter(content)).not.toBeNull();
  });

  // Blocks: validate-commands.js CI failure (description is a required field)
  // and a command listed without a tooltip.
  it('has a non-empty description carrying the Korean trigger', async () => {
    const fm = parseFrontmatter(await readFile(cmdPath, 'utf-8'));
    expect(fm.description).toBeTruthy();
    expect(fm.description.length).toBeGreaterThan(10);
    expect(fm.description).toContain(trigger);
  });

  // Blocks: validate-commands.js CI failure (argument-hint is required).
  it('has an argument-hint', async () => {
    const fm = parseFrontmatter(await readFile(cmdPath, 'utf-8'));
    expect(fm['argument-hint']).toBeTruthy();
  });

  // Blocks: command receiving unrestricted tool access at runtime.
  it('declares read-only allowed-tools (no Write)', async () => {
    const fm = parseFrontmatter(await readFile(cmdPath, 'utf-8'));
    expect(fm['allowed-tools']).toBeTruthy();
    expect(fm['allowed-tools']).toContain('Read');
    expect(fm['allowed-tools']).not.toContain('Write');
  });

  // Blocks: the migrated directive losing its distinct output header — the
  // whole reason the hook version was reworked (plain prose was invisible).
  it('body retains the distinct output header block', async () => {
    const content = await readFile(cmdPath, 'utf-8');
    expect(content).toContain(header);
  });
});
