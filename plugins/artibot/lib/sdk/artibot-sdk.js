/**
 * Artibot SDK — enables external developers to extend the Artibot ecosystem
 * by creating custom skills, agents, hooks, and middleware.
 *
 * Provides factory functions with schema validation, scaffolding,
 * and auto-registration into the Artibot plugin system.
 *
 * Goal: "Artibot as a platform — plugin-of-plugins."
 *
 * @module lib/sdk/artibot-sdk
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteText } from '../core/file.js';

// ---------------------------------------------------------------------------
// Schema Definitions
// ---------------------------------------------------------------------------

/** Required fields for a valid SKILL.md frontmatter */
const SKILL_REQUIRED_FIELDS = ['name', 'description', 'category'];

/** Required fields for an agent definition */
const AGENT_REQUIRED_FIELDS = ['name', 'role', 'model'];

/** Valid model tiers (fable is opt-in via the model-policy gate) */
const VALID_MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku']);

/** Valid hook event types */
const VALID_HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart', 'SessionEnd',
  'UserPromptSubmit', 'SubagentSpawned', 'InstructionsLoaded',
]);

/** Valid middleware positions */
const VALID_MIDDLEWARE_POSITIONS = new Set(['before', 'after', 'replace']);

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Validate an object against required fields.
 *
 * @param {object} obj
 * @param {string[]} requiredFields
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateRequired(obj, requiredFields) {
  const errors = [];
  for (const field of requiredFields) {
    if (!obj[field] || (typeof obj[field] === 'string' && obj[field].trim() === '')) {
      errors.push(`Missing required field: "${field}"`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a name follows kebab-case convention.
 *
 * @param {string} name
 * @returns {{ valid: boolean, error: string | null }}
 */
function validateKebabCase(name) {
  if (typeof name !== 'string') return { valid: false, error: 'Name must be a string' };
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    return { valid: false, error: `"${name}" is not valid kebab-case` };
  }
  return { valid: true, error: null };
}

// ---------------------------------------------------------------------------
// createSkill
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SkillSpec
 * @property {string} name - Skill name (kebab-case)
 * @property {string} description - One-line description
 * @property {string} category - Category (e.g. 'engineering', 'marketing')
 * @property {string[]} [triggers] - Activation trigger phrases
 * @property {string[]} [agents] - Agents this skill delegates to
 * @property {string} [tokens] - Estimated token usage (e.g. '~2K')
 * @property {string[]} [platforms] - Supported platforms
 * @property {number} [level] - Skill complexity level (1-3)
 * @property {string} body - Markdown body content
 */

/**
 * Create a skill definition with validation and SKILL.md generation.
 *
 * @param {SkillSpec} spec
 * @returns {{ valid: boolean, errors: string[], skillMd: string | null, dirName: string }}
 */
export function createSkill(spec) {
  const errors = [];

  const nameCheck = validateKebabCase(spec.name);
  if (!nameCheck.valid) errors.push(nameCheck.error);

  const reqCheck = validateRequired(spec, SKILL_REQUIRED_FIELDS);
  errors.push(...reqCheck.errors);

  if (!spec.body || typeof spec.body !== 'string') {
    errors.push('Missing required field: "body"');
  }

  if (errors.length > 0) {
    return { valid: false, errors, skillMd: null, dirName: spec.name || '' };
  }

  const frontmatter = [
    '---',
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    `category: "${spec.category}"`,
  ];

  if (spec.triggers?.length) {
    frontmatter.push('triggers:');
    for (const t of spec.triggers) frontmatter.push(`  - "${t}"`);
  }
  if (spec.agents?.length) {
    frontmatter.push('agents:');
    for (const a of spec.agents) frontmatter.push(`  - "${a}"`);
  }
  if (spec.tokens) frontmatter.push(`tokens: "${spec.tokens}"`);
  if (spec.platforms?.length) {
    frontmatter.push(`platforms: [${spec.platforms.join(', ')}]`);
  }
  if (spec.level) frontmatter.push(`level: ${spec.level}`);

  frontmatter.push('---');

  const skillMd = `${frontmatter.join('\n')}\n${spec.body}`;

  const result = {
    valid: true,
    errors: [],
    skillMd,
    dirName: spec.name,
  };
  result.commit = (pluginRoot, options) => _commitSkill(result, spec, pluginRoot, options);
  return result;
}

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AgentSpec
 * @property {string} name - Agent name (kebab-case)
 * @property {string} role - Agent role/title
 * @property {string} model - Model tier ('fable' | 'opus' | 'sonnet' | 'haiku')
 * @property {string} [systemPrompt] - System-level instructions
 * @property {string[]} [tools] - Allowed tools
 * @property {string[]} [skills] - Skills this agent can invoke
 * @property {string} body - Markdown body content
 */

/**
 * Create an agent definition with validation and .md generation.
 *
 * @param {AgentSpec} spec
 * @returns {{ valid: boolean, errors: string[], agentMd: string | null, fileName: string }}
 */
export function createAgent(spec) {
  const errors = [];

  const nameCheck = validateKebabCase(spec.name);
  if (!nameCheck.valid) errors.push(nameCheck.error);

  const reqCheck = validateRequired(spec, AGENT_REQUIRED_FIELDS);
  errors.push(...reqCheck.errors);

  if (spec.model && !VALID_MODELS.has(spec.model)) {
    errors.push(`Invalid model "${spec.model}" — must be one of: ${[...VALID_MODELS].join(', ')}`);
  }

  if (!spec.body || typeof spec.body !== 'string') {
    errors.push('Missing required field: "body"');
  }

  if (errors.length > 0) {
    return { valid: false, errors, agentMd: null, fileName: `${spec.name || 'unknown'}.md` };
  }

  const lines = [
    `# ${spec.role}`,
    '',
    `**Model**: ${spec.model}`,
  ];

  if (spec.tools?.length) {
    lines.push(`**Tools**: ${spec.tools.join(', ')}`);
  }
  if (spec.skills?.length) {
    lines.push(`**Skills**: ${spec.skills.join(', ')}`);
  }
  if (spec.systemPrompt) {
    lines.push('', '## System Prompt', '', spec.systemPrompt);
  }

  lines.push('', spec.body);

  const result = {
    valid: true,
    errors: [],
    agentMd: lines.join('\n'),
    fileName: `${spec.name}.md`,
  };
  result.commit = (pluginRoot, options) => _commitAgent(result, spec, pluginRoot, options);
  return result;
}

// ---------------------------------------------------------------------------
// createHook
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HookSpec
 * @property {string} event - Hook event type (e.g. 'PreToolUse')
 * @property {string} name - Hook script name (kebab-case)
 * @property {string} [description] - What the hook does
 * @property {string} script - ESM script content (the hook body)
 */

/**
 * Create a hook script with validation and hooks.json registration entry.
 *
 * @param {HookSpec} spec
 * @returns {{ valid: boolean, errors: string[], scriptContent: string | null, registration: object | null }}
 */
export function createHook(spec) {
  const errors = [];

  if (!spec.event || !VALID_HOOK_EVENTS.has(spec.event)) {
    errors.push(`Invalid event "${spec.event}" — must be one of: ${[...VALID_HOOK_EVENTS].join(', ')}`);
  }

  const nameCheck = validateKebabCase(spec.name);
  if (!nameCheck.valid) errors.push(nameCheck.error);

  if (!spec.script || typeof spec.script !== 'string') {
    errors.push('Missing required field: "script"');
  }

  if (errors.length > 0) {
    return { valid: false, errors, scriptContent: null, registration: null };
  }

  const scriptContent = [
    '#!/usr/bin/env node',
    `// Hook: ${spec.name} (${spec.event})`,
    spec.description ? `// ${spec.description}` : '',
    '',
    spec.script,
  ].filter(Boolean).join('\n');

  const registration = {
    event: spec.event,
    script: `scripts/hooks/${spec.name}.js`,
    description: spec.description || `Custom hook: ${spec.name}`,
  };

  const result = { valid: true, errors: [], scriptContent, registration };
  result.commit = (pluginRoot, options) => _commitHook(result, spec, pluginRoot, options);
  return result;
}

// ---------------------------------------------------------------------------
// createMiddleware
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MiddlewareSpec
 * @property {string} name - Middleware name (kebab-case)
 * @property {string} [position='after'] - Pipeline position ('before' | 'after' | 'replace')
 * @property {string} [target] - Target middleware to position relative to
 * @property {string} factoryCode - ESM factory function code
 */

/**
 * Create a runtime pipeline middleware with validation.
 *
 * @param {MiddlewareSpec} spec
 * @returns {{ valid: boolean, errors: string[], moduleContent: string | null, registration: object | null }}
 */
export function createMiddleware(spec) {
  const errors = [];

  const nameCheck = validateKebabCase(spec.name);
  if (!nameCheck.valid) errors.push(nameCheck.error);

  const position = spec.position || 'after';
  if (!VALID_MIDDLEWARE_POSITIONS.has(position)) {
    errors.push(`Invalid position "${position}" — must be one of: ${[...VALID_MIDDLEWARE_POSITIONS].join(', ')}`);
  }

  if (!spec.factoryCode || typeof spec.factoryCode !== 'string') {
    errors.push('Missing required field: "factoryCode"');
  }

  if (errors.length > 0) {
    return { valid: false, errors, moduleContent: null, registration: null };
  }

  const moduleContent = [
    `/**`,
    ` * Custom middleware: ${spec.name}`,
    ` * @module lib/runtime/middleware/${spec.name}`,
    ` */`,
    '',
    spec.factoryCode,
  ].join('\n');

  const registration = {
    name: spec.name,
    module: `lib/runtime/middleware/${spec.name}.js`,
    position,
    target: spec.target || null,
  };

  const result = { valid: true, errors: [], moduleContent, registration };
  result.commit = (pluginRoot, options) => _commitMiddleware(result, spec, pluginRoot, options);
  return result;
}

// ---------------------------------------------------------------------------
// Batch Validation
// ---------------------------------------------------------------------------

/**
 * Validate a full extension package (skills + agents + hooks + middleware).
 *
 * @param {object} pkg
 * @param {SkillSpec[]} [pkg.skills]
 * @param {AgentSpec[]} [pkg.agents]
 * @param {HookSpec[]} [pkg.hooks]
 * @param {MiddlewareSpec[]} [pkg.middleware]
 * @returns {{ valid: boolean, results: object[], errorCount: number }}
 */
export function validatePackage(pkg) {
  const results = [];
  let errorCount = 0;

  for (const skill of pkg.skills || []) {
    const r = createSkill(skill);
    results.push({ type: 'skill', name: skill.name, ...r });
    if (!r.valid) errorCount += r.errors.length;
  }

  for (const agent of pkg.agents || []) {
    const r = createAgent(agent);
    results.push({ type: 'agent', name: agent.name, ...r });
    if (!r.valid) errorCount += r.errors.length;
  }

  for (const hook of pkg.hooks || []) {
    const r = createHook(hook);
    results.push({ type: 'hook', name: hook.name, ...r });
    if (!r.valid) errorCount += r.errors.length;
  }

  for (const mw of pkg.middleware || []) {
    const r = createMiddleware(mw);
    results.push({ type: 'middleware', name: mw.name, ...r });
    if (!r.valid) errorCount += r.errors.length;
  }

  return { valid: errorCount === 0, results, errorCount };
}

// ---------------------------------------------------------------------------
// Commit Helpers (disk I/O)
// ---------------------------------------------------------------------------

/** Regex patterns that may indicate DATA POLICY violations (warn, not block). */
const DATA_POLICY_PATTERNS = [
  /\bfetch\s*\(/,
  /https\.request\b/,
  /child_process\b/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
];

/**
 * Scan a body/script string for patterns that suggest external network access,
 * subprocess spawning, or dynamic code evaluation. Returns warnings (non-blocking).
 *
 * @param {string} body
 * @returns {string[]}
 */
export function scanDataPolicyViolations(body) {
  const warnings = [];
  if (typeof body !== 'string' || body.length === 0) return warnings;
  for (const pattern of DATA_POLICY_PATTERNS) {
    if (pattern.test(body)) {
      warnings.push(`data-policy: body matches pattern ${pattern.source}`);
    }
  }
  return warnings;
}

/**
 * Check whether a path exists.
 *
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file, guarding against overwrite unless explicitly allowed.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {boolean} overwrite
 * @returns {Promise<boolean>} true if the target already existed
 */
async function writeWithOverwrite(filePath, content, overwrite) {
  const existed = await pathExists(filePath);
  if (existed && !overwrite) {
    throw new Error(
      `file exists, pass overwrite:true to replace: ${filePath}`,
    );
  }
  // Atomic: a crash mid-scaffold leaves the previous file intact rather than a
  // truncated one. Creates the parent directory itself.
  await atomicWriteText(filePath, content);
  return existed;
}

/**
 * Read, mutate, and write a JSON file. The mutator receives the parsed value
 * (or an empty object if the file was missing) and returns the new value.
 *
 * @param {string} filePath
 * @param {(data: any) => any} mutate
 * @returns {Promise<void>}
 */
async function updateJsonFile(filePath, mutate) {
  let data = {};
  if (await pathExists(filePath)) {
    const raw = await readFile(filePath, 'utf-8');
    data = raw.trim() === '' ? {} : JSON.parse(raw);
  }
  const next = mutate(data);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

/**
 * Commit a skill scaffold to disk under <pluginRoot>/skills/<name>/SKILL.md.
 * Also creates a references/ subdirectory for convenience.
 *
 * @param {{ skillMd: string, dirName: string }} result
 * @param {object} spec
 * @param {string} pluginRoot
 * @param {{ overwrite?: boolean }} [options]
 * @returns {Promise<{ path: string, overwritten: boolean, warnings: string[] }>}
 */
async function _commitSkill(result, spec, pluginRoot, options = {}) {
  if (!pluginRoot || typeof pluginRoot !== 'string') {
    throw new Error('commit: pluginRoot must be a non-empty string');
  }
  const overwrite = options.overwrite === true;
  const warnings = scanDataPolicyViolations(spec.body);
  const skillDir = path.join(pluginRoot, 'skills', result.dirName);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const existed = await writeWithOverwrite(skillFile, result.skillMd, overwrite);
  await mkdir(path.join(skillDir, 'references'), { recursive: true });
  return { path: skillFile, overwritten: existed, warnings };
}

/**
 * Commit an agent to <pluginRoot>/agents/<name>.md and register it in
 * .claude-plugin/plugin.json (idempotent push).
 *
 * @param {{ agentMd: string, fileName: string }} result
 * @param {object} spec
 * @param {string} pluginRoot
 * @param {{ overwrite?: boolean }} [options]
 * @returns {Promise<{ path: string, overwritten: boolean, warnings: string[] }>}
 */
async function _commitAgent(result, spec, pluginRoot, options = {}) {
  if (!pluginRoot || typeof pluginRoot !== 'string') {
    throw new Error('commit: pluginRoot must be a non-empty string');
  }
  const overwrite = options.overwrite === true;
  const warnings = scanDataPolicyViolations(spec.body);
  const agentFile = path.join(pluginRoot, 'agents', result.fileName);
  const existed = await writeWithOverwrite(agentFile, result.agentMd, overwrite);
  const manifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  const entry = `./agents/${result.fileName}`;
  await updateJsonFile(manifest, (data) => {
    const next = { ...data };
    const agents = Array.isArray(next.agents) ? [...next.agents] : [];
    if (!agents.includes(entry)) agents.push(entry);
    next.agents = agents;
    return next;
  });
  return { path: agentFile, overwritten: existed, warnings };
}

/**
 * Commit a hook script to <pluginRoot>/scripts/hooks/<name>.js and register
 * it in hooks/hooks.json under the correct event array.
 *
 * @param {{ scriptContent: string, registration: object }} result
 * @param {object} spec
 * @param {string} pluginRoot
 * @param {{ overwrite?: boolean }} [options]
 * @returns {Promise<{ path: string, overwritten: boolean, warnings: string[] }>}
 */
async function _commitHook(result, spec, pluginRoot, options = {}) {
  if (!pluginRoot || typeof pluginRoot !== 'string') {
    throw new Error('commit: pluginRoot must be a non-empty string');
  }
  const overwrite = options.overwrite === true;
  const warnings = scanDataPolicyViolations(spec.script);
  const scriptFile = path.join(pluginRoot, 'scripts', 'hooks', `${spec.name}.js`);
  const existed = await writeWithOverwrite(scriptFile, result.scriptContent, overwrite);
  const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
  await updateJsonFile(hooksFile, (data) => {
    const next = { ...data };
    const hooks = (next.hooks && typeof next.hooks === 'object') ? { ...next.hooks } : {};
    const eventList = Array.isArray(hooks[spec.event]) ? [...hooks[spec.event]] : [];
    const entry = {
      matcher: '*',
      hooks: [{ type: 'command', command: `node \${CLAUDE_PLUGIN_ROOT}/scripts/hooks/${spec.name}.js` }],
      category: 'sdk',
    };
    const already = eventList.some((h) => JSON.stringify(h) === JSON.stringify(entry));
    if (!already) eventList.push(entry);
    hooks[spec.event] = eventList;
    next.hooks = hooks;
    return next;
  });
  return { path: scriptFile, overwritten: existed, warnings };
}

/**
 * Commit a middleware module to <pluginRoot>/lib/runtime/middleware/<name>.js
 * and register the name in artibot.config.json runtime.middleware array.
 *
 * @param {{ moduleContent: string, registration: object }} result
 * @param {object} spec
 * @param {string} pluginRoot
 * @param {{ overwrite?: boolean }} [options]
 * @returns {Promise<{ path: string, overwritten: boolean, warnings: string[] }>}
 */
async function _commitMiddleware(result, spec, pluginRoot, options = {}) {
  if (!pluginRoot || typeof pluginRoot !== 'string') {
    throw new Error('commit: pluginRoot must be a non-empty string');
  }
  const overwrite = options.overwrite === true;
  const warnings = scanDataPolicyViolations(spec.factoryCode);
  const moduleFile = path.join(pluginRoot, 'lib', 'runtime', 'middleware', `${spec.name}.js`);
  const existed = await writeWithOverwrite(moduleFile, result.moduleContent, overwrite);
  const configFile = path.join(pluginRoot, 'artibot.config.json');
  await updateJsonFile(configFile, (data) => {
    const next = { ...data };
    const runtime = (next.runtime && typeof next.runtime === 'object') ? { ...next.runtime } : {};
    const middleware = Array.isArray(runtime.middleware) ? [...runtime.middleware] : [];
    if (!middleware.includes(spec.name)) middleware.push(spec.name);
    runtime.middleware = middleware;
    next.runtime = runtime;
    return next;
  });
  return { path: moduleFile, overwritten: existed, warnings };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  SKILL_REQUIRED_FIELDS as _SKILL_REQUIRED_FIELDS,
  AGENT_REQUIRED_FIELDS as _AGENT_REQUIRED_FIELDS,
  VALID_MODELS as _VALID_MODELS,
  VALID_HOOK_EVENTS as _VALID_HOOK_EVENTS,
  VALID_MIDDLEWARE_POSITIONS as _VALID_MIDDLEWARE_POSITIONS,
  validateRequired as _validateRequired,
  validateKebabCase as _validateKebabCase,
  _commitSkill,
  _commitAgent,
  _commitHook,
  _commitMiddleware,
};
