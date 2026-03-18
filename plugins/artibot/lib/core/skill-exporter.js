/**
 * Skill exporter module.
 * Reads Artibot skills from skills/<name>/SKILL.md and exports them
 * to platform-specific formats using the adapter system.
 *
 * @module lib/core/skill-exporter
 */

import path from 'node:path';
import { listDirs, listFiles, readTextFile } from './file.js';
import { getPluginRoot } from './platform.js';
import { loadConfig } from './config.js';
import { GeminiAdapter } from '../adapters/gemini-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { CursorAdapter } from '../adapters/cursor-adapter.js';
import { AntigravityAdapter } from '../adapters/antigravity-adapter.js';
import { stripClaudeSpecificRefs } from '../adapters/adapter-utils.js';

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
  const lines = yaml.split('\n');
  let currentKey = null;
  let currentValue = '';
  let isMultiLine = false;

  for (const line of lines) {
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
      } else {
        result[currentKey] = rawValue.replace(/^["']|["']$/g, '');
      }
    }
  }

  if (isMultiLine && currentKey) {
    result[currentKey] = currentValue;
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

/**
 * Create an adapter instance for the given platform.
 * @param {string} platform - Platform identifier
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('../adapters/base-adapter.js').BaseAdapter>}
 */
async function createAdapter(platform, options = {}) {
  const pluginRoot = options.pluginRoot ?? getPluginRoot();
  const config = options.config ?? (await loadConfig());

  const adapterOptions = { pluginRoot, config };

  switch (platform) {
    case 'gemini-cli':
    case 'gemini':
      return new GeminiAdapter(adapterOptions);
    case 'codex-cli':
    case 'codex':
      return new CodexAdapter(adapterOptions);
    case 'cursor':
      return new CursorAdapter(adapterOptions);
    case 'antigravity':
      return new AntigravityAdapter(adapterOptions);
    default:
      throw new Error(`Unknown platform: ${platform}. Supported: gemini-cli, codex-cli, cursor, antigravity`);
  }
}

/**
 * Export all skills for Gemini CLI format.
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('../adapters/base-adapter.js').AdapterResult>}
 */
export async function exportForGemini(options = {}) {
  const adapter = await createAdapter('gemini-cli', options);
  return exportForPlatform(adapter, options);
}

/**
 * Export all skills for Codex CLI format.
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('../adapters/base-adapter.js').AdapterResult>}
 */
export async function exportForCodex(options = {}) {
  const adapter = await createAdapter('codex-cli', options);
  return exportForPlatform(adapter, options);
}

/**
 * Export all skills for Cursor IDE format.
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('../adapters/base-adapter.js').AdapterResult>}
 */
export async function exportForCursor(options = {}) {
  const adapter = await createAdapter('cursor', options);
  return exportForPlatform(adapter, options);
}

/**
 * Export all skills for Google Antigravity format.
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('../adapters/base-adapter.js').AdapterResult>}
 */
export async function exportForAntigravity(options = {}) {
  const adapter = await createAdapter('antigravity', options);
  return exportForPlatform(adapter, options);
}

async function collectSkillArtifacts(adapter, skills, files, warnings) {
  for (const skill of skills) {
    try {
      const converted = adapter.convertSkill(skill);
      files.push(converted);
      const references = await convertSkillReferences(adapter, skill);
      files.push(...references);
    } catch (err) {
      warnings.push(`Skill ${skill.name}: ${err.message}`);
    }
  }
}

function collectCommandArtifacts(adapter, commands, files, warnings) {
  for (const command of commands) {
    try {
      const converted = adapter.convertCommand(command);
      if (converted) files.push(converted);
    } catch (err) {
      warnings.push(`Command ${command.name}: ${err.message}`);
    }
  }
}

function collectAgentArtifacts(adapter, agents, agentArtifacts, warnings) {
  if (typeof adapter.convertAgent !== 'function') return;
  for (const agent of agents) {
    try {
      const converted = adapter.convertAgent(agent);
      if (converted) agentArtifacts.push(converted);
    } catch (err) {
      warnings.push(`Agent ${agent.name}: ${err.message}`);
    }
  }
}

function appendStandaloneAgentArtifacts(adapter, agentArtifacts, files) {
  const consumesModeArtifacts = typeof adapter.generateModesJson === 'function';
  const consumesAgentSections = typeof adapter.generateAgentsMd === 'function';

  for (const artifact of agentArtifacts) {
    const isModeArtifact = artifact.path.startsWith('_mode_');
    const isAgentSection = artifact.path.startsWith('_agents_section_');

    if ((isModeArtifact && consumesModeArtifacts) || (isAgentSection && consumesAgentSections)) {
      continue;
    }

    files.push(artifact);
  }

  return { consumesModeArtifacts, consumesAgentSections };
}

function appendGeneratedArtifact(files, warnings, label, generator) {
  try {
    const artifact = generator();
    if (artifact) files.push(artifact);
  } catch (err) {
    warnings.push(`${label}: ${err.message}`);
  }
}

/**
 * Export all skills using a specific adapter.
 * @param {import('../adapters/base-adapter.js').BaseAdapter} adapter
 * @param {object} [options]
 * @returns {Promise<import('../adapters/base-adapter.js').AdapterResult>}
 */
async function exportForPlatform(adapter, options = {}) {
  const pluginRoot = options.pluginRoot ?? getPluginRoot();
  const skills = await loadSkills(pluginRoot);
  const commands = await loadCommands(pluginRoot);
  const agents = await loadAgents(pluginRoot);
  const files = [];
  const warnings = [];
  const agentArtifacts = [];

  await collectSkillArtifacts(adapter, skills, files, warnings);
  collectCommandArtifacts(adapter, commands, files, warnings);
  collectAgentArtifacts(adapter, agents, agentArtifacts, warnings);

  const { consumesModeArtifacts, consumesAgentSections } = appendStandaloneAgentArtifacts(
    adapter,
    agentArtifacts,
    files,
  );

  if (consumesModeArtifacts) {
    appendGeneratedArtifact(files, warnings, 'Modes JSON', () => adapter.generateModesJson(agentArtifacts));
  }

  if (consumesAgentSections) {
    appendGeneratedArtifact(files, warnings, 'AGENTS.md', () => adapter.generateAgentsMd(agentArtifacts));
  }

  appendGeneratedArtifact(files, warnings, 'Manifest', () => adapter.generateManifest());

  const result = {
    platform: adapter.platformId,
    files,
    warnings,
  };

  // Validate
  const validation = adapter.validate(result);
  if (!validation.valid) {
    warnings.push(...validation.errors);
  }

  return result;
}

function extractAgentRole(content, fallback) {
  const roleHeading = content.match(/^#+\s*Role:\s*(.+)$/m);
  if (roleHeading?.[1]) {
    return roleHeading[1].trim();
  }

  return fallback;
}

function getSkillTextMapping(adapter) {
  switch (adapter.platformId) {
    case 'gemini-cli':
      return {
        skillsPath: '.agent/skills/',
        platformName: 'AI Agent',
        instructionFile: 'GEMINI.md',
      };
    case 'codex-cli':
      return {
        skillsPath: '.agents/skills/',
        platformName: 'AI Agent',
        instructionFile: 'AGENTS.md',
      };
    case 'cursor':
      return {
        skillsPath: '.cursor/skills/',
        platformName: 'AI Agent',
        instructionFile: '.cursorrules',
      };
    case 'antigravity':
      return {
        skillsPath: '.antigravity/skills/',
        platformName: 'AI Agent',
        instructionFile: '.antigravity/rules.md',
      };
    default:
      return null;
  }
}

async function convertSkillReferences(adapter, skill) {
  const mapping = getSkillTextMapping(adapter);
  const references = [];

  for (const referencePath of skill.references ?? []) {
    const content = await readTextFile(referencePath);
    if (!content) continue;

    references.push({
      path: path.join(adapter.skillsDir, skill.dirName, 'references', path.basename(referencePath)),
      content: mapping ? stripClaudeSpecificRefs(content, mapping) : content,
    });
  }

  return references;
}

/**
 * Export skills for all supported platforms.
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<Record<string, import('../adapters/base-adapter.js').AdapterResult>>}
 */
export async function exportForAll(options = {}) {
  const [gemini, codex, cursor, antigravity] = await Promise.all([
    exportForGemini(options),
    exportForCodex(options),
    exportForCursor(options),
    exportForAntigravity(options),
  ]);

  return {
    'gemini-cli': gemini,
    'codex-cli': codex,
    cursor,
    antigravity,
  };
}
