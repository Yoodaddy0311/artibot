/**
 * Skill export orchestration.
 *
 * Converts Artibot skills/commands/agents into platform-specific bundles using
 * the adapter system (Gemini / Codex / Cursor / Antigravity). This is the
 * adapter-layer (L2) home for the export API: it depends on the export-target
 * adapters (same layer) and on the pure loaders in lib/core (lower layer), so
 * it keeps lib/core free of any upward dependency on lib/adapters.
 *
 * The shipped `/export` command runs scripts/export-to-tool.mjs (a standalone
 * node-builtin implementation); these functions are the equivalent library API
 * for programmatic callers.
 *
 * @module lib/adapters/skill-export
 */

import path from 'node:path';
import { readTextFile } from '../core/file.js';
import { getPluginRoot } from '../core/platform.js';
import { loadConfig } from '../core/config.js';
import { loadAgents, loadCommands, loadSkills } from '../core/skill-exporter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { AntigravityAdapter } from './antigravity-adapter.js';
import { stripClaudeSpecificRefs } from './adapter-utils.js';

/**
 * Create an adapter instance for the given platform.
 * @param {string} platform - Platform identifier
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('./base-adapter.js').BaseAdapter>}
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
 * @returns {Promise<import('./base-adapter.js').AdapterResult>}
 */
export async function exportForGemini(options = {}) {
  const adapter = await createAdapter('gemini-cli', options);
  return exportForPlatform(adapter, options);
}

/**
 * Export all skills for Codex CLI format.
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('./base-adapter.js').AdapterResult>}
 */
export async function exportForCodex(options = {}) {
  const adapter = await createAdapter('codex-cli', options);
  return exportForPlatform(adapter, options);
}

/**
 * Export all skills for Cursor IDE format.
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('./base-adapter.js').AdapterResult>}
 */
export async function exportForCursor(options = {}) {
  const adapter = await createAdapter('cursor', options);
  return exportForPlatform(adapter, options);
}

/**
 * Export all skills for Google Antigravity format.
 * @param {object} [options] - Override pluginRoot and config
 * @returns {Promise<import('./base-adapter.js').AdapterResult>}
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
 * @param {import('./base-adapter.js').BaseAdapter} adapter
 * @param {object} [options]
 * @returns {Promise<import('./base-adapter.js').AdapterResult>}
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
 * @returns {Promise<Record<string, import('./base-adapter.js').AdapterResult>>}
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
