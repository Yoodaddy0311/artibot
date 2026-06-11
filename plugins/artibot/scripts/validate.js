/**
 * Artibot Plugin Validation Script
 * Validates plugin structure, manifest, agents, skills, commands, and hooks.
 *
 * Usage: node scripts/validate.js
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPolicyModel } from '../lib/core/model-policy.js';
import {
  collectPolicyAgents,
  findModelPolicyDrift,
  readAgentModels,
} from './ci/validate-model-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
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

function collectHooks(hooksObj) {
  const result = [];
  for (const [eventName, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) result.push({ eventName, hook });
    }
  }
  return result;
}

function validatePathPrefix(field, value) {
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
      validatePathPrefix(field, manifest[field]);
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
  // Skip INDEX.md (and similar catalog/index files) — they are catalog files, not agent definitions.
  const mdFiles = files.filter(f => f.endsWith('.md') && f.toLowerCase() !== 'index.md');

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
    // Validate modelTier field presence
    if (!content.match(/modelTier\s*:/)) {
      warn(`[agents] ${file} missing "modelTier" field in frontmatter`);
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
    } else {
      // Validate Progressive Disclosure frontmatter block (opening --- block)
      const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) {
        warn(`[skills] ${dir.name}/SKILL.md frontmatter block not properly closed`);
      } else {
        const frontmatter = frontmatterMatch[1];
        if (!frontmatter.includes('name:')) {
          warn(`[skills] ${dir.name}/SKILL.md missing "name" in frontmatter`);
        }
        if (!frontmatter.includes('description:') && !frontmatter.includes('purpose:')) {
          warn(`[skills] ${dir.name}/SKILL.md missing "description" or "purpose" in frontmatter`);
        }
      }
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
      'SessionStart', 'SessionEnd',
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'PreCompact', 'PostCompact',
      'InstructionsLoaded',
      'Stop', 'UserPromptSubmit',
      'SubagentStart', 'SubagentStop', 'SubAgentTurn',
      'TeammateIdle', 'Notification',
      'TaskCompleted', 'PermissionRequest',
      // Anthropic Agent SDK extension events (Artibot AD-07): reserved for future
      // SDK-side wiring. Not registered in hooks.json since v4.5.4 — Claude Code's
      // native hook loader rejects snake_case event keys at startup. Whitelisted
      // here so the validator stays quiet if SDK config files reintroduce them.
      'on_handoff', 'on_llm_start', 'on_llm_end'
    ];
    const validHookTypes = ['command', 'prompt', 'agent'];

    // Validate hookTypes metadata field if present
    if (config.hookTypes && !Array.isArray(config.hookTypes)) {
      error('[hooks] hookTypes must be an array');
    }
    if (Array.isArray(config.hookTypes)) {
      for (const ht of config.hookTypes) {
        if (!validHookTypes.includes(ht)) warn(`[hooks] Unknown hookType: "${ht}"`);
      }
    }

    const events = Object.keys(config.hooks || {});
    for (const event of events) {
      if (!validEvents.includes(event)) warn(`[hooks] Unknown hook event: "${event}"`);
    }

    // Validate hook type field on individual hooks
    const allHooks = collectHooks(config.hooks || {});
    for (const { eventName, hook } of allHooks) {
      if (hook.type && !validHookTypes.includes(hook.type)) {
        warn(`[hooks] ${eventName}: unknown hook type "${hook.type}"`);
      }
      // type:prompt blocks carry a "prompt" field instead of "command".
      // Default (unset) type is treated as "command" for backwards compatibility.
      const hookType = hook.type || 'command';
      if (hookType === 'prompt') {
        if (typeof hook.prompt !== 'string' || hook.prompt.trim().length === 0) {
          warn(`[hooks] ${eventName}: type:prompt hook missing or empty "prompt" field`);
        }
      } else {
        if (!hook.command) {
          warn(`[hooks] ${eventName}: hook missing "command" field`);
        }
      }
    }

    console.log(`  [hooks] ${events.length} hook event(s), ${allHooks.length} hook(s) validated`);
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

/**
 * Cross-check agent frontmatter `model:` against the central modelPolicy
 * (artibot.config.json#/agents/modelPolicy) via lib/core/model-policy.js.
 * Catches silent drift between frontmatter, config, and the rules doc.
 *
 * Single source of truth: delegates to the reusable drift functions exported by
 * scripts/ci/validate-model-policy.js (readAgentModels / collectPolicyAgents /
 * findModelPolicyDrift) instead of re-implementing the comparison inline. This
 * is the actual "wiring" the CHANGELOG claims — the standalone CI validator and
 * `npm run validate` now share one drift implementation.
 *
 * ERROR: frontmatter↔config mismatch, or a policy agent with no file.
 * WARN:  an agent file whose name is in no policy bucket.
 */
async function validateModelPolicy() {
  const agentsDir = join(PLUGIN_ROOT, 'agents');
  if (!await exists(agentsDir)) return; // validateAgents already warns on absence

  // Read config directly and pass it explicitly to the resolver — avoids
  // depending on the loadConfig() cache lifecycle inside this standalone script.
  let config = null;
  const configPath = join(PLUGIN_ROOT, 'artibot.config.json');
  if (await exists(configPath)) {
    try { config = await readJson(configPath); } catch { /* validateConfig reports JSON errors */ }
  }

  const agentModels = readAgentModels(agentsDir);
  const policyAgents = collectPolicyAgents(config);
  const { errors: driftErrors, warnings: driftWarnings } = findModelPolicyDrift({
    agentModels,
    resolvePolicyModel: (name) => getPolicyModel(name, config),
    policyAgents,
  });

  for (const e of driftErrors) error(`[model-policy] ${e}`);
  for (const w of driftWarnings) warn(`[model-policy] ${w}`);

  console.log(`  [model-policy] ${agentModels.length} agent(s) cross-checked against config policy`);
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
await validateModelPolicy();

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
