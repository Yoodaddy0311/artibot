/**
 * Artibot Plugin Validation Script
 * Validates plugin structure, manifest, agents, skills, commands, and hooks.
 *
 * Usage: node scripts/validate.js
 *
 * ── Which validators span which plugin roots (2026-08-16) ───────────────────
 * `agents` / `skills` / `commands` scan EVERY project plugin root, because the
 * frontmatter contract they enforce is identical in each. Until this change
 * they scanned only `plugins/artibot/`, so cowork's 46 skills / 21 commands /
 * 12 agents were validated by nothing at all while the script printed PASS.
 *
 * The remaining validators stay deliberately main-plugin-only. Each exclusion
 * is a measured judgement, not an oversight:
 *
 *   manifest     — per-root data, but cowork's plugin.json is already covered
 *                  by `scripts/ci/sync-marketplace-meta.mjs`; duplicating the
 *                  check here would give two owners for one invariant.
 *   hooks        — cowork ships NO hooks by design (`plugins/artibot-cowork/
 *                  README.md`: "No hooks, no external scripts"). Verified: it
 *                  has no `hooks/` directory. Including it would emit a
 *                  permanent "hooks.json not found" warning for a file that is
 *                  correct to be absent.
 *   config       — `artibot.config.json` is the main plugin's runtime config;
 *                  cowork has none and is not supposed to.
 *   model-policy — the policy roster in `artibot.config.json#/agents/
 *                  modelPolicy` lists exactly the main plugin's 30 agents.
 *                  Measured: cowork's `case-study-writer` and
 *                  `long-form-writer` appear in no bucket, and
 *                  `findModelPolicyDrift` additionally errors on every policy
 *                  agent with no file — pointing it at cowork's 12-agent
 *                  directory would manufacture 16 false "missing agent"
 *                  errors. Cross-plugin model policy needs its own roster
 *                  before it can be gated; that is a separate change.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPolicyModel, resolveModel } from '../lib/core/model-policy.js';
import { assertEntityFloors, listEntityRoots, qualify } from './ci/skill-scan-roots.js';
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

/**
 * Label an entity for reporting: bare name inside the primary plugin, prefixed
 * with the root elsewhere, so `daily` and `artibot-cowork/daily` never read as
 * the same finding (31 skill names are shared between the two plugins).
 */
function label(rootName, entity) {
  return qualify(rootName, entity);
}

/**
 * Report per-root denominators and turn any floor miss into a hard error.
 * Without this, "0 problems" and "0 files examined" print identically — the
 * defect that let all of cowork sit outside these gates while they said PASS.
 *
 * @param {'skills'|'commands'|'agents'} kind - Entity kind.
 * @param {Record<string, number>} perRoot - Root name → entities validated.
 * @param {Record<string, number>} [candidatesByRoot] - Root name → entities
 *   *considered*. When given, the count prints as `validated/considered`; the
 *   gap is the interesting number (e.g. a skills/ subdirectory with no
 *   SKILL.md is counted as a candidate but never validates).
 */
function reportScan(kind, perRoot, candidatesByRoot = null) {
  const breakdown = Object.entries(perRoot).map(([r, n]) => `${r}=${n}`).join(' ') || '(none)';
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const count = candidatesByRoot ? `${sum(perRoot)}/${sum(candidatesByRoot)}` : `${sum(perRoot)}`;
  console.log(`  [${kind}] ${count} ${kind.slice(0, -1)}(s) validated across ${Object.keys(perRoot).length} root(s): ${breakdown}`);
  for (const f of assertEntityFloors(kind, perRoot)) error(`[${kind}] ${f}`);
}

async function validateAgents() {
  const roots = listEntityRoots('agents');
  const perRoot = {};

  for (const { name: rootName, dir } of roots) {
    const files = await readdir(dir);
    // Skip INDEX.md (and similar catalog/index files) — they are catalog files, not agent definitions.
    const mdFiles = files.filter(f => f.endsWith('.md') && f.toLowerCase() !== 'index.md');
    perRoot[rootName] = mdFiles.length;

    for (const file of mdFiles) {
      const content = await readFile(join(dir, file), 'utf-8');
      const id = label(rootName, file);
      if (!content.includes('---')) {
        error(`[agents] ${id} missing YAML frontmatter`);
      }
      if (!content.match(/^---\s*\n[\s\S]*?name:/m)) {
        warn(`[agents] ${id} missing "name" in frontmatter`);
      }
      // Validate modelTier field presence
      if (!content.match(/modelTier\s*:/)) {
        warn(`[agents] ${id} missing "modelTier" field in frontmatter`);
      }
    }
  }

  reportScan('agents', perRoot);
}

/**
 * Validate one SKILL.md's frontmatter contract.
 * @param {string} id - Reporting label (root-qualified outside the main plugin).
 * @param {string} content - Raw file content.
 */
function validateSkillContent(id, content) {
  if (!content.includes('---')) {
    error(`[skills] ${id}/SKILL.md missing YAML frontmatter`);
    return;
  }
  // Validate Progressive Disclosure frontmatter block (opening --- block)
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    warn(`[skills] ${id}/SKILL.md frontmatter block not properly closed`);
    return;
  }
  const frontmatter = frontmatterMatch[1];
  if (!frontmatter.includes('name:')) {
    warn(`[skills] ${id}/SKILL.md missing "name" in frontmatter`);
  }
  if (!frontmatter.includes('description:') && !frontmatter.includes('purpose:')) {
    warn(`[skills] ${id}/SKILL.md missing "description" or "purpose" in frontmatter`);
  }
}

async function validateSkills() {
  const perRoot = {};
  const candidates = {};

  for (const { name: rootName, dir } of listEntityRoots('skills')) {
    const entries = await readdir(dir, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory());
    candidates[rootName] = skillDirs.length;
    let valid = 0;

    for (const d of skillDirs) {
      const id = label(rootName, d.name);
      const skillMd = join(dir, d.name, 'SKILL.md');
      if (!await exists(skillMd)) {
        error(`[skills] ${id}/ missing SKILL.md`);
        continue;
      }
      validateSkillContent(id, await readFile(skillMd, 'utf-8'));
      valid++;
    }
    perRoot[rootName] = valid;
  }

  reportScan('skills', perRoot, candidates);
}

/**
 * Validate one command file's frontmatter contract.
 * @param {string} id - Reporting label (root-qualified outside the main plugin).
 * @param {string} content - Raw file content.
 */
function validateCommandContent(id, content) {
  // A command must OPEN with a properly closed YAML fence — a stray '---'
  // anywhere in the body must not satisfy the gate (2026-07 test-gap scan).
  const fence = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) {
    error(`[commands] ${id} missing or unclosed leading YAML frontmatter block`);
    return;
  }
  const frontmatter = fence[1];
  if (!/^description\s*:/m.test(frontmatter)) {
    error(`[commands] ${id} missing "description" in frontmatter`);
  }
  if (!/^allowed-tools\s*:/m.test(frontmatter)) {
    warn(`[commands] ${id} missing "allowed-tools" in frontmatter`);
  }
  if (!/^argument-hint\s*:/m.test(frontmatter)) {
    warn(`[commands] ${id} missing "argument-hint" in frontmatter`);
  }
}

async function validateCommands() {
  // Test seam: lets the frontmatter-gate regression tests point this validator
  // at a throwaway fixture dir instead of mutating the live commands/ tree
  // (a live-tree temp file races parallel test workers that count commands).
  // In seam mode ONLY the fixture is scanned and floors are not asserted — a
  // 2-file fixture legitimately cannot meet a 70-command floor.
  const seam = process.env.ARTIBOT_COMMANDS_DIR;
  if (seam) {
    if (!await exists(seam)) {
      warn('[commands] commands/ directory not found');
      return;
    }
    const files = (await readdir(seam)).filter(f => f.endsWith('.md'));
    for (const file of files) {
      validateCommandContent(file, await readFile(join(seam, file), 'utf-8'));
    }
    console.log(`  [commands] ${files.length} command(s) validated (fixture seam)`);
    return;
  }

  const perRoot = {};
  for (const { name: rootName, dir } of listEntityRoots('commands')) {
    const mdFiles = (await readdir(dir)).filter(f => f.endsWith('.md'));
    perRoot[rootName] = mdFiles.length;
    for (const file of mdFiles) {
      validateCommandContent(label(rootName, file), await readFile(join(dir, file), 'utf-8'));
    }
  }

  reportScan('commands', perRoot);
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
    // Gate-aware: getPolicyModel keeps the strict "unlisted → null" semantics,
    // but the comparison model must be the EFFECTIVE tier after the fable
    // opt-in gate/denylist (e.g. security-reviewer in a fable bucket → opus).
    resolvePolicyModel: (name) =>
      getPolicyModel(name, config) === null
        ? null
        : resolveModel(name, {}, config),
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
