/**
 * Extension API for Artibot plugin.
 * Provides a registry for dynamically adding skills and hooks.
 *
 * @module lib/core/extension
 */

/**
 * Required fields for a skill registration config.
 * @type {string[]}
 */
const REQUIRED_SKILL_FIELDS = ['name', 'description'];

/**
 * Create a new extension registry.
 *
 * @returns {{
 *   registerSkill: (name: string, config: object) => object,
 *   registerHook: (event: string, handler: Function) => object,
 *   listExtensions: () => { skills: object[], hooks: object[] },
 *   getSkill: (name: string) => object | undefined,
 *   getHooksForEvent: (event: string) => Function[],
 *   unregisterSkill: (name: string) => boolean,
 *   unregisterHook: (id: string) => boolean,
 *   reset: () => void
 * }}
 * @example
 * const reg = createExtensionRegistry();
 * reg.registerSkill('my-skill', { name: 'my-skill', description: 'Does things' });
 * reg.registerHook('pre-command', (ctx) => console.log(ctx));
 * reg.listExtensions(); // { skills: [...], hooks: [...] }
 */
export function createExtensionRegistry() {
  /** @type {Map<string, object>} */
  const skills = new Map();

  /** @type {Array<{ id: string, event: string, handler: Function, registeredAt: string }>} */
  const hooks = [];

  let hookIdCounter = 0;

  /**
   * Register a new skill extension.
   *
   * @param {string} name - Unique skill name
   * @param {object} config - Skill configuration
   * @param {string} config.name - Skill name (must match the name parameter)
   * @param {string} config.description - Skill description
   * @returns {{ name: string, config: object, registeredAt: string }}
   */
  function registerSkill(name, config) {
    if (!name || typeof name !== 'string') {
      throw new Error('Skill name must be a non-empty string');
    }

    if (!config || typeof config !== 'object') {
      throw new Error('Skill config must be an object');
    }

    for (const field of REQUIRED_SKILL_FIELDS) {
      if (!config[field]) {
        throw new Error(`Skill config missing required field: "${field}"`);
      }
    }

    if (config.name !== name) {
      throw new Error(`Skill config.name ("${config.name}") must match the registered name ("${name}")`);
    }

    if (skills.has(name)) {
      throw new Error(`Skill "${name}" is already registered`);
    }

    const entry = {
      name,
      config: { ...config },
      registeredAt: new Date().toISOString(),
    };
    skills.set(name, entry);
    return { ...entry, config: { ...entry.config } };
  }

  /**
   * Register a new hook handler for an event.
   *
   * @param {string} event - Event name (e.g. 'pre-command', 'post-execute')
   * @param {Function} handler - Hook handler function
   * @returns {{ id: string, event: string, registeredAt: string }}
   */
  function registerHook(event, handler) {
    if (!event || typeof event !== 'string') {
      throw new Error('Hook event must be a non-empty string');
    }

    if (typeof handler !== 'function') {
      throw new Error('Hook handler must be a function');
    }

    const id = `hook-${++hookIdCounter}`;
    const entry = {
      id,
      event,
      handler,
      registeredAt: new Date().toISOString(),
    };
    hooks.push(entry);
    return { id: entry.id, event: entry.event, registeredAt: entry.registeredAt };
  }

  /**
   * List all registered extensions.
   *
   * @returns {{ skills: object[], hooks: object[] }}
   */
  function listExtensions() {
    return {
      skills: [...skills.values()].map((s) => ({
        name: s.name,
        config: { ...s.config },
        registeredAt: s.registeredAt,
      })),
      hooks: hooks.map((h) => ({
        id: h.id,
        event: h.event,
        registeredAt: h.registeredAt,
      })),
    };
  }

  /**
   * Get a registered skill by name.
   *
   * @param {string} name - Skill name
   * @returns {object | undefined}
   */
  function getSkill(name) {
    const entry = skills.get(name);
    if (!entry) return undefined;
    return { ...entry, config: { ...entry.config } };
  }

  /**
   * Get all hook handlers registered for a specific event.
   *
   * @param {string} event - Event name
   * @returns {Function[]}
   */
  function getHooksForEvent(event) {
    return hooks
      .filter((h) => h.event === event)
      .map((h) => h.handler);
  }

  /**
   * Unregister a skill by name.
   *
   * @param {string} name - Skill name
   * @returns {boolean} true if found and removed
   */
  function unregisterSkill(name) {
    return skills.delete(name);
  }

  /**
   * Unregister a hook by id.
   *
   * @param {string} id - Hook id
   * @returns {boolean} true if found and removed
   */
  function unregisterHook(id) {
    const idx = hooks.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    hooks.splice(idx, 1);
    return true;
  }

  /**
   * Reset the registry (for testing).
   */
  function reset() {
    skills.clear();
    hooks.length = 0;
    hookIdCounter = 0;
  }

  return {
    registerSkill,
    registerHook,
    listExtensions,
    getSkill,
    getHooksForEvent,
    unregisterSkill,
    unregisterHook,
    reset,
  };
}

/** Singleton extension registry for the plugin */
export const defaultRegistry = createExtensionRegistry();
