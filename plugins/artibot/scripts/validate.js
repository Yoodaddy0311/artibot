/**
 * Artibot Plugin Validation Script
 * Validates plugin structure, manifest, agents, skills, commands, and hooks.
 *
 * Usage: node scripts/validate.js
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const errors = [];
const warnings = [];

function error(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function readJson(path) {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
}

// --- Validators ---

async function validateManifest() {
  const manifestPath = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
  if (!await exists(manifestPath)) {
    error('[manifest] .claude-plugin/plugin.json not found');
    return;
  }

  try {
    const manifest = await readJson(manifestPath);

    if (!manifest.name || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(manifest.name)) {
      error(`[manifest] Invalid name: "${manifest.name}" (must be kebab-case)`);
    }

    if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      error(`[manifest] Invalid version: "${manifest.version}" (must be semver)`);
    }

    if (!manifest.description) {
      warn('[manifest] Missing description field');
    }

    // Validate path fields use ./ prefix
    for (const field of ['agents', 'commands', 'hooks', 'mcpServers', 'outputStyles']) {
      const value = manifest[field];
      if (typeof value === 'string' && !value.startsWith('./')) {
        error(`[manifest] ${field} path must start with "./" (got "${value}")`);
      }
      if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string' && !v.startsWith('./')) {
            error(`[manifest] ${field} path must start with "./" (got "${v}")`);
          }
        }
      }
    }

    console.log('  [manifest] plugin.json validated');
  } catch (e) {
    error(`[manifest] Invalid JSON: ${e.message}`);
  }
}

async function validateAgents() {
  const agentsDir = join(PLUGIN_ROOT, 'agents');
  if (!await exists(agentsDir)) {
    warn('[agents] agents/ directory not found');
    return;
  }

  const files = await readdir(agentsDir);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  if (mdFiles.length === 0) {
    warn('[agents] No agent .md files found');
    return;
  }

  for (const file of mdFiles) {
    const content = await readFile(join(agentsDir, file), 'utf-8');
    if (!content.includes('---')) {
      error(`[agents] ${file} missing YAML frontmatter`);
    }
    if (!content.match(/^---\s*\n[\s\S]*?name:/m)) {
      warn(`[agents] ${file} missing "name" in frontmatter`);
    }
  }

  console.log(`  [agents] ${mdFiles.length} agent(s) validated`);
}

async function validateSkills() {
  const skillsDir = join(PLUGIN_ROOT, 'skills');
  if (!await exists(skillsDir)) {
    warn('[skills] skills/ directory not found');
    return;
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillDirs = entries.filter(e => e.isDirectory());
  let valid = 0;

  for (const dir of skillDirs) {
    const skillMd = join(skillsDir, dir.name, 'SKILL.md');
    if (!await exists(skillMd)) {
      error(`[skills] ${dir.name}/ missing SKILL.md`);
      continue;
    }

    const content = await readFile(skillMd, 'utf-8');
    if (!content.includes('---')) {
      error(`[skills] ${dir.name}/SKILL.md missing YAML frontmatter`);
    }
    valid++;
  }

  console.log(`  [skills] ${valid}/${skillDirs.length} skill(s) validated`);
}

async function validateCommands() {
  const commandsDir = join(PLUGIN_ROOT, 'commands');
  if (!await exists(commandsDir)) {
    warn('[commands] commands/ directory not found');
    return;
  }

  const files = await readdir(commandsDir);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  for (const file of mdFiles) {
    const content = await readFile(join(commandsDir, file), 'utf-8');
    if (!content.includes('---')) {
      warn(`[commands] ${file} missing YAML frontmatter`);
    }
  }

  console.log(`  [commands] ${mdFiles.length} command(s) validated`);
}

async function validateHooks() {
  const hooksPath = join(PLUGIN_ROOT, 'hooks', 'hooks.json');
  if (!await exists(hooksPath)) {
    warn('[hooks] hooks/hooks.json not found');
    return;
  }

  try {
    const config = await readJson(hooksPath);
    const validEvents = [
      'SessionStart', 'PreToolUse', 'PostToolUse',
      'PreCompact', 'Stop', 'UserPromptSubmit',
      'SubagentStart', 'SubagentStop', 'TeammateIdle', 'SessionEnd'
    ];

    const events = Object.keys(config.hooks || {});
    for (const event of events) {
      if (!validEvents.includes(event)) {
        warn(`[hooks] Unknown hook event: "${event}"`);
      }
    }

    console.log(`  [hooks] ${events.length} hook event(s) validated`);
  } catch (e) {
    error(`[hooks] Invalid JSON: ${e.message}`);
  }
}

async function validateConfig() {
  const configPath = join(PLUGIN_ROOT, 'artibot.config.json');
  if (!await exists(configPath)) {
    warn('[config] artibot.config.json not found');
    return;
  }

  try {
    const config = await readJson(configPath);

    if (!config.version) {
      warn('[config] Missing version field');
    }
    if (!config.team) {
      warn('[config] Missing team configuration');
    }
    if (!config.agents?.taskBased) {
      warn('[config] Missing agents.taskBased mapping');
    }

    console.log('  [config] artibot.config.json validated');
  } catch (e) {
    error(`[config] Invalid JSON: ${e.message}`);
  }
}

// --- Main ---

console.log('Artibot Plugin Validation');
console.log('========================\n');

await validateManifest();
await validateAgents();
await validateSkills();
await validateCommands();
await validateHooks();
await validateConfig();

console.log('');

if (warnings.length > 0) {
  console.log(`Warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  WARN: ${w}`);
  console.log('');
}

if (errors.length > 0) {
  console.log(`Errors (${errors.length}):`);
  for (const e of errors) console.log(`  ERROR: ${e}`);
  console.log('');
  process.exit(1);
}

console.log('Validation passed.');
