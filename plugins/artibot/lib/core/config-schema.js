/**
 * JSON Schema definition and lightweight validator for artibot.config.json.
 * Validates config structure without external dependencies.
 * @module lib/core/config-schema
 */

/**
 * JSON Schema for artibot.config.json.
 * Documents the expected structure and constraints for the plugin configuration.
 */
export const configSchema = {
  type: 'object',
  required: ['version'],
  properties: {
    version: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+',
      description: 'Semantic version string (e.g. "1.4.0")',
    },
    agents: {
      type: 'object',
      properties: {
        modelPolicy: { type: 'object' },
        categories: { type: 'object' },
        taskBased: { type: 'object' },
      },
    },
    team: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        engine: { type: 'string' },
        maxTeammates: { type: ['number', 'null'], minimum: 1, maximum: 15 },
        ctoAgent: { type: 'string' },
        delegationMode: { type: 'boolean' },
        displayMode: { type: 'string' },
        spawnStrategy: { type: 'string' },
      },
    },
    automation: {
      type: 'object',
      properties: {
        intentDetection: { type: 'boolean' },
        ambiguityThreshold: { type: 'number', minimum: 0, maximum: 100 },
        supportedLanguages: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
    context: {
      type: 'object',
      properties: {
        importCacheTTL: { type: 'number', minimum: 0 },
      },
    },
    cognitive: {
      type: 'object',
      properties: {
        router: {
          type: 'object',
          properties: {
            threshold: { type: 'number', minimum: 0, maximum: 1 },
            adaptRate: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
        system1: {
          type: 'object',
          properties: {
            maxLatency: { type: 'number', minimum: 0 },
            minConfidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
        system2: {
          type: 'object',
          properties: {
            maxRetries: { type: 'number', minimum: 0, maximum: 10 },
            sandboxEnabled: { type: 'boolean' },
          },
        },
      },
    },
    learning: {
      type: 'object',
      properties: {
        memoryScopes: { type: 'object' },
        lifelong: {
          type: 'object',
          properties: {
            batchSize: { type: 'number', minimum: 1 },
            grpoGroupSize: { type: 'number', minimum: 1 },
          },
        },
        knowledgeTransfer: {
          type: 'object',
          properties: {
            promotionThreshold: { type: 'number', minimum: 0 },
            demotionThreshold: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    output: {
      type: 'object',
      properties: {
        maxContextLength: { type: 'number', minimum: 1 },
        defaultStyle: { type: 'string' },
      },
    },
  },
};

/**
 * Validate a config value against a schema property definition.
 * @param {*} value - The value to validate
 * @param {object} schemaProp - The schema property definition
 * @param {string} path - Dot-separated path for error messages
 * @param {string[]} errors - Accumulator for error messages
 */
function validateProperty(value, schemaProp, propPath, errors) {
  if (value === undefined || value === null) {
    // null is allowed when type includes 'null'
    if (value === null && Array.isArray(schemaProp.type) && schemaProp.type.includes('null')) {
      return;
    }
    if (value === null && schemaProp.type !== 'null') {
      // null is only valid if type explicitly allows it
      if (!Array.isArray(schemaProp.type) || !schemaProp.type.includes('null')) {
        errors.push(`${propPath}: expected ${schemaProp.type}, got null`);
      }
    }
    return;
  }

  // Type check
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  const expectedTypes = Array.isArray(schemaProp.type)
    ? schemaProp.type
    : [schemaProp.type];

  if (!expectedTypes.includes(actualType)) {
    errors.push(`${propPath}: expected ${expectedTypes.join('|')}, got ${actualType}`);
    return; // Skip further checks if type is wrong
  }

  // String pattern check
  if (actualType === 'string' && schemaProp.pattern) {
    const regex = new RegExp(schemaProp.pattern);
    if (!regex.test(value)) {
      errors.push(`${propPath}: value "${value}" does not match pattern ${schemaProp.pattern}`);
    }
  }

  // Number range checks
  if (actualType === 'number') {
    if (schemaProp.minimum !== undefined && value < schemaProp.minimum) {
      errors.push(`${propPath}: value ${value} is below minimum ${schemaProp.minimum}`);
    }
    if (schemaProp.maximum !== undefined && value > schemaProp.maximum) {
      errors.push(`${propPath}: value ${value} exceeds maximum ${schemaProp.maximum}`);
    }
  }

  // Array items check
  if (actualType === 'array' && schemaProp.items) {
    for (let i = 0; i < value.length; i++) {
      validateProperty(value[i], schemaProp.items, `${propPath}[${i}]`, errors);
    }
  }

  // Nested object properties check
  if (actualType === 'object' && schemaProp.properties) {
    for (const [key, propSchema] of Object.entries(schemaProp.properties)) {
      if (value[key] !== undefined) {
        validateProperty(value[key], propSchema, `${propPath}.${key}`, errors);
      }
    }
  }
}

/**
 * Validate a config object against the artibot config schema.
 * Uses lightweight validation without external dependencies.
 * Extra properties are allowed (non-strict mode).
 *
 * @param {*} config - The configuration object to validate
 * @returns {{ valid: boolean, errors: string[] }}
 * @example
 * const { valid, errors } = validateConfig({ version: '1.4.0', team: { enabled: true } });
 * // valid: true, errors: []
 *
 * const bad = validateConfig({ version: 123 });
 * // bad.valid: false, bad.errors: ['version: expected string, got number']
 */
export function validateConfig(config) {
  const errors = [];

  // Root type check
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    errors.push('Config must be a plain object');
    return { valid: false, errors };
  }

  // Required fields check
  for (const field of configSchema.required) {
    if (config[field] === undefined) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate each known property
  for (const [key, propSchema] of Object.entries(configSchema.properties)) {
    if (config[key] !== undefined) {
      validateProperty(config[key], propSchema, key, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}
