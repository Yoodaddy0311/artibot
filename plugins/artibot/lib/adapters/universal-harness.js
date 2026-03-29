/**
 * Universal Harness Adapter — multi-harness abstraction layer.
 * Detects the current AI coding harness at runtime and provides a unified
 * interface for hooks, agent definitions, and skill delivery across all
 * supported platforms.
 *
 * Goal: "One Artibot config works on every AI agent tool."
 *
 * @module lib/adapters/universal-harness
 */

import { BaseAdapter } from './base-adapter.js';

// ---------------------------------------------------------------------------
// Harness Registry
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HarnessDescriptor
 * @property {string} id - Unique harness identifier
 * @property {string} name - Display name
 * @property {string} hookSystem - Hook mechanism type
 * @property {string} instructionFile - Primary instruction file name
 * @property {string} rulesDir - Rules/instructions directory
 * @property {string[]} envSignals - Environment variables that indicate this harness
 * @property {string[]} fileSignals - Files whose presence indicates this harness
 */

/** @type {readonly HarnessDescriptor[]} */
const HARNESS_REGISTRY = Object.freeze([
  {
    id: 'claude-code',
    name: 'Claude Code',
    hookSystem: 'settings-hooks',
    instructionFile: 'CLAUDE.md',
    rulesDir: '.claude/rules',
    envSignals: ['CLAUDE_CODE', 'CLAUDE_PROJECT_DIR'],
    fileSignals: ['.claude/settings.json', 'CLAUDE.md'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    hookSystem: 'cursor-rules',
    instructionFile: '.cursor/rules',
    rulesDir: '.cursor/rules',
    envSignals: ['CURSOR_SESSION'],
    fileSignals: ['.cursor/rules', '.cursorrules'],
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    hookSystem: 'codex-instructions',
    instructionFile: 'AGENTS.md',
    rulesDir: '.codex',
    envSignals: ['CODEX_CLI'],
    fileSignals: ['AGENTS.md', '.codex/config.json'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    hookSystem: 'kiro-hooks',
    instructionFile: '.kiro/instructions.md',
    rulesDir: '.kiro/rules',
    envSignals: ['KIRO_SESSION'],
    fileSignals: ['.kiro/instructions.md'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    hookSystem: 'opencode-config',
    instructionFile: 'OPENCODE.md',
    rulesDir: '.opencode',
    envSignals: ['OPENCODE_SESSION'],
    fileSignals: ['OPENCODE.md', '.opencode/config.json'],
  },
  {
    id: 'trae',
    name: 'Trae',
    hookSystem: 'trae-rules',
    instructionFile: '.trae/rules',
    rulesDir: '.trae/rules',
    envSignals: ['TRAE_SESSION'],
    fileSignals: ['.trae/rules'],
  },
]);

// ---------------------------------------------------------------------------
// Runtime Detection
// ---------------------------------------------------------------------------

/**
 * Detect which harness is currently running by checking environment variables
 * and file system signals.
 *
 * @param {object} [deps]
 * @param {object} [deps.env] - Environment variables (defaults to process.env)
 * @param {(path: string) => boolean} [deps.fileExists] - File existence check
 * @returns {{ harness: HarnessDescriptor | null, confidence: number, signals: string[] }}
 */
export function detectHarness(deps = {}) {
  const env = deps.env || {};
  const fileExists = deps.fileExists || (() => false);
  let bestMatch = null;
  let bestScore = 0;
  let bestSignals = [];

  for (const harness of HARNESS_REGISTRY) {
    const signals = [];
    let score = 0;

    for (const envVar of harness.envSignals) {
      if (env[envVar]) {
        signals.push(`env:${envVar}`);
        score += 2;
      }
    }

    for (const filePath of harness.fileSignals) {
      if (fileExists(filePath)) {
        signals.push(`file:${filePath}`);
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = harness;
      bestSignals = signals;
    }
  }

  const maxPossible = bestMatch
    ? bestMatch.envSignals.length * 2 + bestMatch.fileSignals.length
    : 1;
  const confidence = bestScore > 0 ? Math.round((bestScore / maxPossible) * 100) / 100 : 0;

  return {
    harness: bestScore > 0 ? bestMatch : null,
    confidence,
    signals: bestSignals,
  };
}

// ---------------------------------------------------------------------------
// Hook System Mapping
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HookMapping
 * @property {string} sourceEvent - Artibot canonical hook event name
 * @property {string} targetEvent - Platform-specific hook event name
 * @property {string} mechanism - How the hook is registered on this platform
 */

/** Canonical Artibot hook events */
const CANONICAL_HOOKS = [
  'PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart',
  'SessionEnd', 'UserPromptSubmit', 'SubagentSpawned',
];

/**
 * Map canonical Artibot hook events to a target harness's hook system.
 *
 * @param {string} harnessId
 * @returns {HookMapping[]}
 */
export function mapHooks(harnessId) {
  const harness = HARNESS_REGISTRY.find((h) => h.id === harnessId);
  if (!harness) return [];

  return CANONICAL_HOOKS.map((event) => ({
    sourceEvent: event,
    targetEvent: translateHookEvent(event, harnessId),
    mechanism: harness.hookSystem,
  }));
}

/**
 * Translate a canonical hook event to the target platform's naming.
 *
 * @param {string} event
 * @param {string} harnessId
 * @returns {string}
 */
function translateHookEvent(event, harnessId) {
  if (harnessId === 'claude-code') return event;
  if (harnessId === 'cursor') return `cursor:${camelToKebab(event)}`;
  if (harnessId === 'codex-cli') return `codex:${camelToKebab(event)}`;
  if (harnessId === 'kiro') return `kiro:${event.toLowerCase()}`;
  if (harnessId === 'opencode') return `opencode:${event}`;
  if (harnessId === 'trae') return `trae:${camelToKebab(event)}`;
  return event;
}

/**
 * Convert CamelCase to kebab-case.
 *
 * @param {string} str
 * @returns {string}
 */
function camelToKebab(str) {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

// ---------------------------------------------------------------------------
// Agent Definition Conversion
// ---------------------------------------------------------------------------

/**
 * Convert an Artibot agent .md definition to the target harness format.
 *
 * @param {object} agentDef - { name, content, role }
 * @param {string} harnessId
 * @returns {{ path: string, content: string, format: string }}
 */
export function convertAgentDefinition(agentDef, harnessId) {
  const harness = HARNESS_REGISTRY.find((h) => h.id === harnessId);
  if (!harness) {
    return { path: `agents/${agentDef.name}.md`, content: agentDef.content, format: 'markdown' };
  }

  const content = agentDef.content;

  switch (harnessId) {
    case 'claude-code':
      return { path: `agents/${agentDef.name}.md`, content, format: 'markdown' };
    case 'cursor':
      return {
        path: `.cursor/rules/${agentDef.name}.mdc`,
        content: wrapAsMdc(agentDef.name, content),
        format: 'mdc',
      };
    case 'codex-cli':
      return {
        path: `.codex/agents/${agentDef.name}.md`,
        content: `# Agent: ${agentDef.role}\n\n${content}`,
        format: 'markdown',
      };
    case 'kiro':
      return {
        path: `.kiro/agents/${agentDef.name}.md`,
        content,
        format: 'markdown',
      };
    default:
      return { path: `agents/${agentDef.name}.md`, content, format: 'markdown' };
  }
}

/**
 * Wrap markdown content in Cursor's .mdc rule format.
 *
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
function wrapAsMdc(name, content) {
  return `---\ndescription: Artibot agent — ${name}\nglobs: \nalwaysApply: false\n---\n\n${content}`;
}

// ---------------------------------------------------------------------------
// Universal Adapter (extends BaseAdapter)
// ---------------------------------------------------------------------------

/**
 * Universal adapter that delegates to the detected (or specified) harness.
 * Provides a single entry point for skill/agent/command conversion
 * regardless of the active platform.
 */
export class UniversalHarnessAdapter extends BaseAdapter {
  #targetHarnessId;
  #harnessDescriptor;

  /**
   * @param {object} options
   * @param {string} options.pluginRoot
   * @param {object} options.config
   * @param {string} [options.targetHarness] - Override auto-detection
   * @param {object} [options.detectionDeps] - Dependencies for detectHarness
   */
  constructor(options) {
    super(options);
    if (options.targetHarness) {
      this.#targetHarnessId = options.targetHarness;
      this.#harnessDescriptor = HARNESS_REGISTRY.find((h) => h.id === options.targetHarness) || null;
    } else {
      const detected = detectHarness(options.detectionDeps);
      this.#targetHarnessId = detected.harness?.id || 'claude-code';
      this.#harnessDescriptor = detected.harness || HARNESS_REGISTRY[0];
    }
  }

  get platformId() {
    return this.#targetHarnessId;
  }

  get platformName() {
    return this.#harnessDescriptor?.name || 'Unknown';
  }

  get instructionFileName() {
    return this.#harnessDescriptor?.instructionFile || 'CLAUDE.md';
  }

  get skillsDir() {
    return `${this.#harnessDescriptor?.rulesDir || '.claude/rules'}/skills`;
  }

  convertSkill(skill) {
    const dir = this.skillsDir;
    return {
      path: `${dir}/${skill.dirName}/SKILL.md`,
      content: skill.content,
    };
  }

  convertAgent(agent) {
    return convertAgentDefinition(agent, this.#targetHarnessId);
  }

  convertCommand(command) {
    return {
      path: `commands/${command.name}.md`,
      content: command.content,
    };
  }

  generateManifest() {
    return {
      path: `${this.#harnessDescriptor?.rulesDir || '.'}/artibot-manifest.json`,
      content: JSON.stringify({
        platform: this.#targetHarnessId,
        version: this.config?.version || '0.0.0',
        generatedAt: new Date().toISOString(),
      }, null, 2),
    };
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  HARNESS_REGISTRY as _HARNESS_REGISTRY,
  CANONICAL_HOOKS as _CANONICAL_HOOKS,
  camelToKebab as _camelToKebab,
  translateHookEvent as _translateHookEvent,
  wrapAsMdc as _wrapAsMdc,
};
