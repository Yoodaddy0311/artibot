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
        modelPolicy: {
          type: 'object',
          description: 'Agent→model assignment tiers. Authoritative resolver: lib/core/model-policy.js',
          properties: {
            high: {
              type: 'object',
              properties: {
                model: { type: 'string' },
                agents: { type: 'array', items: { type: 'string' } },
              },
            },
            medium: {
              type: 'object',
              properties: {
                model: { type: 'string' },
                agents: { type: 'array', items: { type: 'string' } },
              },
            },
            // 4-tier step 2. Shape-only: model-policy.js#loadModelPolicy reads
            // just high+medium, so this bucket is declared and unread by design.
            low: {
              type: 'object',
              properties: {
                model: { type: 'string' },
                agents: { type: 'array', items: { type: 'string' } },
              },
            },
            advisorStrategy: { type: 'object' },
          },
        },
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
    swarm: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        optIn: { type: 'boolean' },
        serverUrl: { type: 'string' },
        syncInterval: { type: 'string' },
        localGlobalRatio: {
          type: 'array',
          items: { type: 'number', minimum: 0, maximum: 1 },
        },
        differentialPrivacy: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            epsilon: { type: 'number', minimum: 0 },
            delta: { type: 'number', minimum: 0 },
          },
        },
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
    git: {
      type: 'object',
      properties: {
        autopilot: {
          type: 'object',
          properties: {
            bypassPreCommitHooks: { type: 'boolean' },
            bypassPrePushHooks: { type: 'boolean' },
            closeOnStop: { type: 'boolean' },
            commitStrategy: {
              type: 'string',
              enum: ['semantic', 'interval', 'none'],
            },
            stashCheckpoint: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                intervalMinutes: { type: 'number', minimum: 1 },
                maxStashes: { type: 'number', minimum: 1, maximum: 100 },
                includeUntracked: { type: 'boolean' },
              },
            },
            semanticCommit: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                commitOnPhases: {
                  type: 'array',
                  items: { type: 'string' },
                },
                requireTestPass: { type: 'boolean' },
                requireLintClean: { type: 'boolean' },
              },
            },
            comment: { type: 'string' },
          },
        },
      },
    },
    // ── v5 Phase 0 declaration keys ──────────────────────────────────────
    // All five are DECLARATIONS: no lib/ module reads any of them as of
    // 2026-09-02, and their shipped values encode current behavior, so
    // validating them here constrains shape without granting them effect.
    // Shape/value pinning lives in tests/firewall/v5-config-firewall.test.js;
    // this schema is non-strict (extra properties allowed), so it can only
    // reject a WRONG type, never a missing or an added key.
    topology: {
      type: 'object',
      properties: {
        // One of the run-ledger topology.mode enum 6. Enumerated here so a
        // typo is a validation error rather than a silently unroutable value.
        default: {
          type: 'string',
          enum: ['solo', 'subagent', 'team', 'autopilot', 'autopilot_fast', 'split'],
        },
        // *Ref values are dot paths into this same config, never copied
        // values (design §3.5 forbids duplicate definition). Dangling-path
        // detection needs the whole document, so it lives in the firewall.
        autopilot_fast: {
          type: 'object',
          properties: {
            hardMaxAgentsRef: { type: 'string' },
            agentsPerCpuRef: { type: 'string' },
            maxWorktreesRef: { type: 'string' },
            maxRiskRef: { type: 'string' },
          },
        },
        split: {
          type: 'object',
          properties: {
            maxWindowsRef: { type: 'string' },
            minStemsRef: { type: 'string' },
            dispatchBudgetRef: { type: 'string' },
          },
        },
        reviewTierRef: { type: 'string' },
        comment: { type: 'string' },
      },
    },
    routing: {
      type: 'object',
      properties: {
        observe: { type: 'boolean' },
        canary: {
          type: 'object',
          properties: {
            // Allowlist of action classes whose recommendation is applied.
            // Empty = observe-only; fail-closed for future classes.
            actionClasses: { type: 'array', items: { type: 'string' } },
          },
        },
        comment: { type: 'string' },
      },
    },
    ledger: {
      type: 'object',
      properties: {
        // Relative to <projectRoot>, not pluginRoot (both have a runtime/).
        path: { type: 'string' },
        maxLineBytes: { type: 'number', minimum: 1 },
        comment: { type: 'string' },
      },
    },
    stateStore: {
      type: 'object',
      properties: {
        // 'sqlite' is interface-compatible only and deliberately NOT offered:
        // it would force engines >=22.13 against the current >=20 (OD-4/F1).
        backend: { type: 'string', enum: ['jsonl'] },
        location: { type: 'string', enum: ['git-common-dir'] },
        comment: { type: 'string' },
      },
    },
    missions: {
      type: 'object',
      properties: {
        // Allowlist, not a negative list — a negative list is fail-open in
        // the generating direction (design §3.1).
        substantiveSignals: { type: 'array', items: { type: 'string' } },
        idFormat: { type: 'string' },
        comment: { type: 'string' },
      },
    },
  },
};

/**
 * Check whether a null value is permitted by a schema property definition.
 * Returns true if null is allowed, false and pushes an error if not.
 * @param {object} schemaProp - The schema property definition
 * @param {string} propPath - Dot-separated path for error messages
 * @param {string[]} errors - Accumulator for error messages
 * @returns {boolean} Whether null is permitted
 */
function isNullAllowed(schemaProp, propPath, errors) {
  const typeAllowsNull = Array.isArray(schemaProp.type)
    ? schemaProp.type.includes('null')
    : schemaProp.type === 'null';
  if (!typeAllowsNull) {
    errors.push(`${propPath}: expected ${schemaProp.type}, got null`);
  }
  return typeAllowsNull;
}

/**
 * Validate string-specific constraints (pattern).
 * @param {string} value
 * @param {object} schemaProp
 * @param {string} propPath
 * @param {string[]} errors
 */
function validateStringConstraints(value, schemaProp, propPath, errors) {
  if (schemaProp.pattern) {
    const regex = new RegExp(schemaProp.pattern);
    if (!regex.test(value)) {
      errors.push(`${propPath}: value "${value}" does not match pattern ${schemaProp.pattern}`);
    }
  }
}

/**
 * Validate number-specific constraints (minimum, maximum).
 * @param {number} value
 * @param {object} schemaProp
 * @param {string} propPath
 * @param {string[]} errors
 */
function validateNumberConstraints(value, schemaProp, propPath, errors) {
  if (schemaProp.minimum !== undefined && value < schemaProp.minimum) {
    errors.push(`${propPath}: value ${value} is below minimum ${schemaProp.minimum}`);
  }
  if (schemaProp.maximum !== undefined && value > schemaProp.maximum) {
    errors.push(`${propPath}: value ${value} exceeds maximum ${schemaProp.maximum}`);
  }
}

/**
 * Validate array items against a schema.
 * @param {Array} value
 * @param {object} schemaProp
 * @param {string} propPath
 * @param {string[]} errors
 */
function validateArrayItems(value, schemaProp, propPath, errors) {
  if (schemaProp.items) {
    for (let i = 0; i < value.length; i++) {
      validateProperty(value[i], schemaProp.items, `${propPath}[${i}]`, errors);
    }
  }
}

/**
 * Validate nested object properties against a schema.
 * @param {object} value
 * @param {object} schemaProp
 * @param {string} propPath
 * @param {string[]} errors
 */
function validateObjectProperties(value, schemaProp, propPath, errors) {
  if (schemaProp.properties) {
    for (const [key, propSchema] of Object.entries(schemaProp.properties)) {
      if (value[key] !== undefined) {
        validateProperty(value[key], propSchema, `${propPath}.${key}`, errors);
      }
    }
  }
}

/**
 * Validate a config value against a schema property definition.
 * @param {*} value - The value to validate
 * @param {object} schemaProp - The schema property definition
 * @param {string} path - Dot-separated path for error messages
 * @param {string[]} errors - Accumulator for error messages
 */
function validateProperty(value, schemaProp, propPath, errors) {
  if (value === undefined) return;

  if (value === null) {
    isNullAllowed(schemaProp, propPath, errors);
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

  // Enum check (applies to any type, but typically string)
  if (schemaProp.enum && !schemaProp.enum.includes(value)) {
    errors.push(`${propPath}: value "${value}" is not one of [${schemaProp.enum.join(', ')}]`);
    return;
  }

  if (actualType === 'string') validateStringConstraints(value, schemaProp, propPath, errors);
  if (actualType === 'number') validateNumberConstraints(value, schemaProp, propPath, errors);
  if (actualType === 'array') validateArrayItems(value, schemaProp, propPath, errors);
  if (actualType === 'object') validateObjectProperties(value, schemaProp, propPath, errors);
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
