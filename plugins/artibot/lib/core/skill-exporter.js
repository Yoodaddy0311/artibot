/**
 * Skill/agent/command loaders.
 *
 * Pure filesystem + frontmatter readers for Artibot skills, agents, and
 * commands. Lives in lib/core (L1) with NO upward dependency: platform-specific
 * export orchestration (which needs the adapter system) lives in
 * lib/adapters/skill-export.js (L2) and imports these loaders downward.
 *
 * @module lib/core/skill-exporter
 */

import path from 'node:path';
import { listDirs, listFiles, readTextFile } from './file.js';
import { getPluginRoot } from './platform.js';

/**
 * Parse YAML frontmatter from a SKILL.md file content.
 * @param {string} content - Full file content
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter = parseSimpleYaml(yamlBlock);

  return { frontmatter, body };
}

/**
 * Simple YAML parser for SKILL.md frontmatter.
 * Handles: scalar values, multi-line strings (|), arrays ([...]).
 * Does NOT handle nested objects or complex YAML features.
 * @param {string} yaml
 * @returns {object}
 */
function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split('\n').map((l) => l.replace(/\r$/, ''));
  let currentKey = null;
  let currentValue = '';
  let isMultiLine = false;
  let isList = false;
  let listItems = [];

  for (const line of lines) {
    // Check if current line is a dash-list item (e.g., "  - value")
    const dashMatch = isList && line.match(/^\s+-\s+(.*)$/);

    if (isList) {
      if (dashMatch) {
        listItems.push(dashMatch[1].trim().replace(/^["']|["']$/g, ''));
        continue;
      } else {
        result[currentKey] = listItems;
        isList = false;
        listItems = [];
        currentKey = null;
      }
    }

    if (isMultiLine) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        currentValue += (currentValue ? '\n' : '') + line.replace(/^ {2}|\t/, '');
        continue;
      } else {
        result[currentKey] = currentValue;
        isMultiLine = false;
        currentKey = null;
        currentValue = '';
      }
    }

    const keyMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const rawValue = keyMatch[2].trim();

      if (rawValue === '|') {
        isMultiLine = true;
        currentValue = '';
      } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        result[currentKey] = rawValue
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''));
      } else if (rawValue === '') {
        // Empty value — next lines may be dash-list items or multi-line
        isList = true;
        listItems = [];
      } else {
        result[currentKey] = rawValue.replace(/^["']|["']$/g, '');
      }
    }
  }

  if (isMultiLine && currentKey) {
    result[currentKey] = currentValue;
  }
  if (isList && currentKey) {
    result[currentKey] = listItems;
  }

  return result;
}

/**
 * Load all skill definitions from the skills/ directory.
 * @param {string} [pluginRoot] - Override plugin root path
 * @returns {Promise<import('../adapters/base-adapter.js').SkillDefinition[]>}
 */
export async function loadSkills(pluginRoot) {
  const root = pluginRoot ?? getPluginRoot();
  const skillsRoot = path.join(root, 'skills');
  const skillDirs = await listDirs(skillsRoot);

  const skills = [];

  for (const dir of skillDirs) {
    const skillMdPath = path.join(dir, 'SKILL.md');
    const content = await readTextFile(skillMdPath);
    if (!content) continue;

    const { frontmatter, body } = parseFrontmatter(content);
    const dirName = path.basename(dir);

    const refsDir = path.join(dir, 'references');
    const refFiles = await listFiles(refsDir, '.md');

    skills.push({
      name: frontmatter.name ?? dirName,
      description: frontmatter.description ?? '',
      platforms: frontmatter.platforms ?? [],
      content: body,
      dirName,
      references: refFiles,
    });
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Lazy Loading API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SkillIndexEntry
 * @property {string} name - Skill name
 * @property {string} dirName - Directory name
 * @property {string} description - Short description
 * @property {string[]} triggers - Trigger keywords for matching
 * @property {string[]} platforms - Supported platforms
 * @property {string[]} lang - Languages this skill is authored in (e.g. ["en"], ["en","ko"])
 */

/**
 * Detect the user's preferred language code (lowercased two-letter, e.g. "ko", "en").
 * Reads CLAUDE_LOCALE > LC_ALL > LANG; defaults to "en" when unset/invalid.
 * Exported for testing.
 *
 * @returns {string}
 */
export function detectUserLocale() {
  const raw =
    process.env.CLAUDE_LOCALE ||
    process.env.LC_ALL ||
    process.env.LANG ||
    'en';
  const m = String(raw).toLowerCase().match(/^([a-z]{2})/);
  return m ? m[1] : 'en';
}

/**
 * Stable-sort skill index entries so that entries matching the user's locale
 * appear first. Entries lacking a `lang` array are treated as `["en"]`.
 *
 * @param {SkillIndexEntry[]} entries
 * @param {string} [locale] - Defaults to detectUserLocale()
 * @returns {SkillIndexEntry[]}
 */
export function prioritizeByLang(entries, locale) {
  const userLang = (locale ?? detectUserLocale()).toLowerCase();
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const aHit = (a.entry.lang ?? ['en']).includes(userLang) ? 0 : 1;
      const bHit = (b.entry.lang ?? ['en']).includes(userLang) ? 0 : 1;
      if (aHit !== bHit) return aHit - bHit;
      return a.i - b.i;
    })
    .map(({ entry }) => entry);
}

/**
 * Load a lightweight skill index (frontmatter only, no body content).
 * Used for lazy loading: match triggers first, then load full skill on demand.
 *
 * Entries are returned in locale-preferred order: skills whose `lang` field
 * matches the active locale (CLAUDE_LOCALE / LC_ALL / LANG) come first, with
 * the original directory order preserved within each tier. This biases the
 * downstream substring matcher toward locale-appropriate skills without
 * dropping any candidate.
 *
 * @param {string} [pluginRoot] - Override plugin root path
 * @returns {Promise<SkillIndexEntry[]>}
 */
export async function loadSkillIndex(pluginRoot) {
  const root = pluginRoot ?? getPluginRoot();
  const skillsRoot = path.join(root, 'skills');
  const skillDirs = await listDirs(skillsRoot);

  const index = [];

  for (const dir of skillDirs) {
    const skillMdPath = path.join(dir, 'SKILL.md');
    const content = await readTextFile(skillMdPath);
    if (!content) continue;

    const { frontmatter } = parseFrontmatter(content);
    const dirName = path.basename(dir);
    const triggers = Array.isArray(frontmatter.triggers) ? frontmatter.triggers : [];
    const lang = Array.isArray(frontmatter.lang) && frontmatter.lang.length > 0
      ? frontmatter.lang.map((l) => String(l).toLowerCase())
      : ['en'];

    index.push({
      name: frontmatter.name ?? dirName,
      dirName,
      description: frontmatter.description ?? '',
      triggers: triggers.map((t) => t.toLowerCase()),
      platforms: frontmatter.platforms ?? [],
      lang,
    });
  }

  return prioritizeByLang(index);
}

/**
 * Load specific skills by name from the skills/ directory.
 *
 * @param {string[]} names - Skill names (or dirNames) to load
 * @param {string} [pluginRoot] - Override plugin root path
 * @returns {Promise<import('../adapters/base-adapter.js').SkillDefinition[]>}
 */
export async function loadSkillsByNames(names, pluginRoot) {
  const root = pluginRoot ?? getPluginRoot();
  const skillsRoot = path.join(root, 'skills');
  const nameSet = new Set(names);
  const skills = [];

  for (const name of nameSet) {
    const dir = path.join(skillsRoot, name);
    const skillMdPath = path.join(dir, 'SKILL.md');
    const content = await readTextFile(skillMdPath);
    if (!content) continue;

    const { frontmatter, body } = parseFrontmatter(content);
    const refsDir = path.join(dir, 'references');
    const refFiles = await listFiles(refsDir, '.md');

    skills.push({
      name: frontmatter.name ?? name,
      description: frontmatter.description ?? '',
      platforms: frontmatter.platforms ?? [],
      content: body,
      dirName: name,
      references: refFiles,
    });
  }

  return skills;
}

/**
 * Load all agent definitions from the agents/ directory.
 * @param {string} [pluginRoot] - Override plugin root path
 * @returns {Promise<import('../adapters/base-adapter.js').AgentDefinition[]>}
 */
export async function loadAgents(pluginRoot) {
  const root = pluginRoot ?? getPluginRoot();
  const agentsRoot = path.join(root, 'agents');
  const agentFiles = await listFiles(agentsRoot, '.md');

  const agents = [];

  for (const filePath of agentFiles) {
    const content = await readTextFile(filePath);
    if (!content) continue;

    const { frontmatter, body } = parseFrontmatter(content);
    const name = path.basename(filePath, '.md');

    agents.push({
      name,
      content: body,
      role: extractAgentRole(body, frontmatter.name ?? name),
    });
  }

  return agents;
}

/**
 * Load all command definitions from the commands/ directory.
 * @param {string} [pluginRoot] - Override plugin root path
 * @returns {Promise<import('../adapters/base-adapter.js').CommandDefinition[]>}
 */
export async function loadCommands(pluginRoot) {
  const root = pluginRoot ?? getPluginRoot();
  const commandsRoot = path.join(root, 'commands');
  const commandFiles = await listFiles(commandsRoot, '.md');

  const commands = [];

  for (const filePath of commandFiles) {
    const content = await readTextFile(filePath);
    if (!content) continue;

    const { frontmatter, body } = parseFrontmatter(content);

    commands.push({
      name: path.basename(filePath, '.md'),
      content: body,
      frontmatter,
    });
  }

  return commands;
}

function extractAgentRole(content, fallback) {
  const roleHeading = content.match(/^#+\s*Role:\s*(.+)$/m);
  if (roleHeading?.[1]) {
    return roleHeading[1].trim();
  }

  return fallback;
}
