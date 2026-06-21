/**
 * Unit tests for the pure loaders in lib/core/skill-exporter.
 *
 * Covers parseFrontmatter (the simple YAML reader) plus the filesystem loaders
 * (loadSkills / loadSkillIndex / loadSkillsByNames / loadAgents / loadCommands)
 * and the locale helpers (detectUserLocale / prioritizeByLang). All loaders run
 * against a throwaway plugin root built under the OS temp dir — no real plugin
 * state is touched.
 *
 * @module tests/core/skill-exporter
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectUserLocale,
  loadAgents,
  loadCommands,
  loadSkillIndex,
  loadSkills,
  loadSkillsByNames,
  parseFrontmatter,
  prioritizeByLang,
} from '../../lib/core/skill-exporter.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-skill-exporter-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(dirName, frontmatter, body = 'Skill body.', refs = {}) {
  const dir = path.join(root, 'skills', dirName);
  mkdirSync(dir, { recursive: true });
  const fm = ['---', ...frontmatter, '---', '', body].join('\n');
  writeFileSync(path.join(dir, 'SKILL.md'), fm, 'utf-8');
  if (Object.keys(refs).length > 0) {
    const refsDir = path.join(dir, 'references');
    mkdirSync(refsDir, { recursive: true });
    for (const [name, content] of Object.entries(refs)) {
      writeFileSync(path.join(refsDir, name), content, 'utf-8');
    }
  }
}

function writeAgent(name, body) {
  const dir = path.join(root, 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), body, 'utf-8');
}

function writeCommand(name, frontmatter, body = 'Command body.') {
  const dir = path.join(root, 'commands');
  mkdirSync(dir, { recursive: true });
  const md = ['---', ...frontmatter, '---', '', body].join('\n');
  writeFileSync(path.join(dir, `${name}.md`), md, 'utf-8');
}

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------
describe('parseFrontmatter()', () => {
  it('returns empty frontmatter and full body when no fence present', () => {
    const { frontmatter, body } = parseFrontmatter('just text, no fence');
    expect(frontmatter).toEqual({});
    expect(body).toBe('just text, no fence');
  });

  it('parses scalar values and strips surrounding quotes', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nname: my-skill\ndescription: "quoted value"\n---\nThe body.',
    );
    expect(frontmatter.name).toBe('my-skill');
    expect(frontmatter.description).toBe('quoted value');
    expect(body).toBe('The body.');
  });

  it('parses inline [..] arrays', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nplatforms: [gemini, codex, cursor]\n---\nbody',
    );
    expect(frontmatter.platforms).toEqual(['gemini', 'codex', 'cursor']);
  });

  it('parses dash-list blocks', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nlang:\n  - en\n  - ko\n---\nbody',
    );
    expect(frontmatter.lang).toEqual(['en', 'ko']);
  });

  it('parses multi-line | scalar blocks', () => {
    const { frontmatter } = parseFrontmatter(
      '---\ndescription: |\n  line one\n  line two\n---\nbody',
    );
    expect(frontmatter.description).toBe('line one\nline two');
  });

  it('tolerates CRLF line endings', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\r\nname: crlf-skill\r\n---\r\nbody here',
    );
    expect(frontmatter.name).toBe('crlf-skill');
    expect(body).toBe('body here');
  });
});

// ---------------------------------------------------------------------------
// loadSkills / loadSkillsByNames
// ---------------------------------------------------------------------------
describe('loadSkills()', () => {
  it('loads every skill with normalized fields', async () => {
    writeSkill('alpha', ['name: alpha', 'description: Alpha skill', 'platforms: [gemini]'], 'Alpha body.');
    writeSkill('beta', ['name: beta', 'description: Beta skill'], 'Beta body.');

    const skills = await loadSkills(root);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

    expect(skills).toHaveLength(2);
    expect(byName.alpha.description).toBe('Alpha skill');
    expect(byName.alpha.platforms).toEqual(['gemini']);
    expect(byName.alpha.content.trim()).toBe('Alpha body.');
    expect(byName.alpha.dirName).toBe('alpha');
    expect(byName.beta.platforms).toEqual([]);
  });

  it('falls back to the directory name when frontmatter omits name', async () => {
    writeSkill('gamma', ['description: no explicit name'], 'body');
    const skills = await loadSkills(root);
    expect(skills[0].name).toBe('gamma');
  });

  it('collects reference files from the references/ subdir', async () => {
    writeSkill('delta', ['name: delta'], 'body', { 'guide.md': '# guide' });
    const skills = await loadSkills(root);
    expect(skills[0].references).toHaveLength(1);
    expect(skills[0].references[0]).toContain('guide.md');
  });

  it('returns [] when the skills dir is absent', async () => {
    const skills = await loadSkills(root);
    expect(skills).toEqual([]);
  });
});

describe('loadSkillsByNames()', () => {
  it('loads only the requested skills and skips unknown names', async () => {
    writeSkill('one', ['name: one'], 'b1');
    writeSkill('two', ['name: two'], 'b2');

    const skills = await loadSkillsByNames(['one', 'missing'], root);
    expect(skills.map((s) => s.name)).toEqual(['one']);
  });
});

// ---------------------------------------------------------------------------
// loadSkillIndex
// ---------------------------------------------------------------------------
describe('loadSkillIndex()', () => {
  it('returns lightweight entries (no body) with lowercased triggers', async () => {
    writeSkill(
      'idx',
      ['name: idx', 'description: indexed', 'triggers: [Build, DEPLOY]', 'lang: [en]'],
      'heavy body that should not appear',
    );
    const index = await loadSkillIndex(root);
    expect(index).toHaveLength(1);
    expect(index[0]).not.toHaveProperty('content');
    expect(index[0].triggers).toEqual(['build', 'deploy']);
    expect(index[0].lang).toEqual(['en']);
  });

  it('defaults lang to ["en"] when absent', async () => {
    writeSkill('nolang', ['name: nolang', 'description: x'], 'b');
    const index = await loadSkillIndex(root);
    expect(index[0].lang).toEqual(['en']);
  });
});

// ---------------------------------------------------------------------------
// locale helpers
// ---------------------------------------------------------------------------
describe('detectUserLocale()', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.CLAUDE_LOCALE = saved.CLAUDE_LOCALE;
    process.env.LC_ALL = saved.LC_ALL;
    process.env.LANG = saved.LANG;
  });

  it('reads CLAUDE_LOCALE first and lowercases the two-letter code', () => {
    process.env.CLAUDE_LOCALE = 'KO_KR.UTF-8';
    expect(detectUserLocale()).toBe('ko');
  });

  it('falls back to "en" when nothing valid is set', () => {
    delete process.env.CLAUDE_LOCALE;
    delete process.env.LC_ALL;
    process.env.LANG = '123-invalid';
    expect(detectUserLocale()).toBe('en');
  });
});

describe('prioritizeByLang()', () => {
  it('moves locale-matching entries first while preserving relative order', () => {
    const entries = [
      { name: 'a', lang: ['en'] },
      { name: 'b', lang: ['ko'] },
      { name: 'c', lang: ['en', 'ko'] },
    ];
    const ordered = prioritizeByLang(entries, 'ko');
    expect(ordered.map((e) => e.name)).toEqual(['b', 'c', 'a']);
  });

  it('treats a missing lang array as ["en"]', () => {
    const entries = [{ name: 'x' }, { name: 'y', lang: ['ko'] }];
    expect(prioritizeByLang(entries, 'en').map((e) => e.name)).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// loadAgents / loadCommands
// ---------------------------------------------------------------------------
describe('loadAgents()', () => {
  it('extracts the role from a "# Role:" heading', async () => {
    writeAgent('builder', '---\nname: builder\n---\n# Role: Build things\n\nBody.');
    const agents = await loadAgents(root);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('builder');
    expect(agents[0].role).toBe('Build things');
  });

  it('falls back to the frontmatter name when no Role heading is present', async () => {
    writeAgent('plain', '---\nname: Plain Agent\n---\nNo role heading here.');
    const agents = await loadAgents(root);
    expect(agents[0].role).toBe('Plain Agent');
  });
});

describe('loadCommands()', () => {
  it('loads commands with their parsed frontmatter', async () => {
    writeCommand('deploy', ['name: deploy', 'description: Ship it'], 'Run the deploy.');
    const commands = await loadCommands(root);
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('deploy');
    expect(commands[0].frontmatter.description).toBe('Ship it');
    expect(commands[0].content.trim()).toBe('Run the deploy.');
  });
});
