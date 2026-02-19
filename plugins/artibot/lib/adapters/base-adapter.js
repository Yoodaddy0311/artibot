/**
 * Base adapter interface for cross-platform skill/command/agent conversion.
 * All platform adapters extend this class and implement the conversion methods.
 *
 * Claude Agent Teams API remains the core engine for team orchestration.
 * Adapters focus on converting skill/command/agent definitions to platform-specific formats.
 *
 * @module lib/adapters/base-adapter
 */

/**
 * @typedef {object} SkillDefinition
 * @property {string} name - Skill name from YAML frontmatter
 * @property {string} description - Skill description from YAML frontmatter
 * @property {string[]} [platforms] - Supported platforms
 * @property {string} content - Full markdown content (body after frontmatter)
 * @property {string} dirName - Directory name (e.g. 'persona-architect')
 * @property {string[]} [references] - Reference file paths
 */

/**
 * @typedef {object} AgentDefinition
 * @property {string} name - Agent filename without extension
 * @property {string} content - Full markdown content
 * @property {string} role - Extracted role/title from first heading
 */

/**
 * @typedef {object} CommandDefinition
 * @property {string} name - Command filename without extension
 * @property {string} content - Full markdown content
 * @property {object} [frontmatter] - Parsed YAML frontmatter
 */

/**
 * @typedef {object} AdapterResult
 * @property {string} platform - Platform identifier
 * @property {object[]} files - Array of { path, content } to write
 * @property {string[]} warnings - Non-fatal conversion notes
 */

export class BaseAdapter {
  /**
   * @param {object} options
   * @param {string} options.pluginRoot - Absolute path to plugin root
   * @param {object} options.config - Parsed artibot.config.json
   */
  constructor({ pluginRoot, config }) {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter is abstract and cannot be instantiated directly');
    }
    this.pluginRoot = pluginRoot;
    this.config = config;
  }

  /** @returns {string} Platform identifier (e.g. 'gemini-cli', 'codex-cli', 'cursor') */
  get platformId() {
    throw new Error(`${this.constructor.name} must implement platformId`);
  }

  /** @returns {string} Display name for the platform */
  get platformName() {
    throw new Error(`${this.constructor.name} must implement platformName`);
  }

  /** @returns {string} Target instruction file name (e.g. 'GEMINI.md', 'AGENTS.md') */
  get instructionFileName() {
    throw new Error(`${this.constructor.name} must implement instructionFileName`);
  }

  /** @returns {string} Skills directory path relative to project root on target platform */
  get skillsDir() {
    throw new Error(`${this.constructor.name} must implement skillsDir`);
  }

  /**
   * Convert a SKILL.md to the platform's skill format.
   * @param {SkillDefinition} skill
   * @returns {{ path: string, content: string }} Converted file
   */
  convertSkill(skill) {
    throw new Error(`${this.constructor.name} must implement convertSkill()`);
  }

  /**
   * Convert an agent definition to the platform's agent format.
   * @param {AgentDefinition} agent
   * @returns {{ path: string, content: string }|null} Converted file or null if unsupported
   */
  convertAgent(agent) {
    throw new Error(`${this.constructor.name} must implement convertAgent()`);
  }

  /**
   * Convert a command definition to the platform's command format.
   * @param {CommandDefinition} command
   * @returns {{ path: string, content: string }|null} Converted file or null if unsupported
   */
  convertCommand(command) {
    throw new Error(`${this.constructor.name} must implement convertCommand()`);
  }

  /**
   * Generate the platform-specific manifest file.
   * @returns {{ path: string, content: string }|null} Manifest file or null
   */
  generateManifest() {
    throw new Error(`${this.constructor.name} must implement generateManifest()`);
  }

  /**
   * Validate the conversion output for platform-specific constraints.
   * @param {AdapterResult} result
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(result) {
    const errors = [];
    if (!result.platform) errors.push('Missing platform identifier');
    if (!result.files || result.files.length === 0) errors.push('No files generated');
    for (const file of result.files ?? []) {
      if (!file.path) errors.push('File entry missing path');
      if (typeof file.content !== 'string') errors.push(`File ${file.path}: content must be a string`);
    }
    return { valid: errors.length === 0, errors };
  }
}
