/**
 * Structured error code system for Artibot (E001-E999).
 * Provides categorized error codes, human-readable messages,
 * and lookup utilities for consistent error handling across the plugin.
 *
 * Categories:
 *   E1xx - Configuration errors
 *   E2xx - Hook system errors
 *   E3xx - Agent / Team errors
 *   E4xx - Privacy / PII errors
 *   E5xx - Cache errors
 *   E6xx - Intent detection errors
 *   E7xx - Cognitive engine errors
 *   E8xx - Learning pipeline errors
 *   E9xx - Swarm / network errors
 *
 * Zero dependencies. ESM only.
 * @module lib/core/error-codes
 */

// ---------------------------------------------------------------------------
// Error Code Enum
// ---------------------------------------------------------------------------

/**
 * Enum of all Artibot error codes.
 * Frozen object to prevent runtime modification.
 * @type {Readonly<Record<string, string>>}
 * @example
 * import { ErrorCodes } from './error-codes.js';
 * throw new Error(ErrorCodes.CONFIG_NOT_FOUND); // 'E101'
 */
export const ErrorCodes = Object.freeze({
  // E1xx - Configuration
  CONFIG_NOT_FOUND:       'E101',
  CONFIG_PARSE_ERROR:     'E102',
  CONFIG_VALIDATION:      'E103',
  CONFIG_SCHEMA_MISMATCH: 'E104',
  CONFIG_PERMISSION:      'E105',
  CONFIG_VERSION_MISMATCH:'E106',

  // E2xx - Hooks
  HOOK_LOAD_FAILED:       'E201',
  HOOK_EXECUTION_ERROR:   'E202',
  HOOK_TIMEOUT:           'E203',
  HOOK_INVALID_MATCHER:   'E204',
  HOOK_SCRIPT_NOT_FOUND:  'E205',
  HOOK_INVALID_OUTPUT:    'E206',
  HOOK_BLOCKED:           'E207',

  // E3xx - Agents / Teams
  AGENT_NOT_FOUND:        'E301',
  AGENT_SPAWN_FAILED:     'E302',
  AGENT_TIMEOUT:          'E303',
  TEAM_CREATE_FAILED:     'E304',
  TEAM_COMM_ERROR:        'E305',
  TASK_ASSIGN_FAILED:     'E306',
  AGENT_SHUTDOWN_FAILED:  'E307',
  TEAM_LIMIT_EXCEEDED:    'E308',

  // E4xx - Privacy / PII
  PII_SCRUB_FAILED:       'E401',
  PII_PATTERN_INVALID:    'E402',
  PII_VALIDATION_FAILED:  'E403',
  HOMOGLYPH_DETECTED:     'E404',
  PII_RESIDUAL_FOUND:     'E405',

  // E5xx - Cache
  CACHE_INIT_FAILED:      'E501',
  CACHE_READ_ERROR:       'E502',
  CACHE_WRITE_ERROR:      'E503',
  CACHE_EVICTION_ERROR:   'E504',
  CACHE_CAPACITY_EXCEEDED:'E505',

  // E6xx - Intent Detection
  INTENT_PARSE_FAILED:    'E601',
  INTENT_AMBIGUOUS:       'E602',
  INTENT_LANGUAGE_UNSUPPORTED: 'E603',
  INTENT_TRIGGER_NOT_FOUND: 'E604',

  // E7xx - Cognitive Engine
  COGNITIVE_ROUTE_FAILED: 'E701',
  SYSTEM1_FAILURE:        'E702',
  SYSTEM2_TIMEOUT:        'E703',
  SANDBOX_EVAL_ERROR:     'E704',
  THRESHOLD_ADAPT_ERROR:  'E705',

  // E8xx - Learning Pipeline
  LEARNING_COLLECT_FAILED:'E801',
  GRPO_OPTIMIZE_ERROR:    'E802',
  KNOWLEDGE_TRANSFER_FAILED:'E803',
  SELF_EVAL_ERROR:        'E804',
  TOOL_LEARN_ERROR:       'E805',
  MEMORY_PERSIST_FAILED:  'E806',

  // E9xx - Swarm / Network
  SWARM_CONNECTION_FAILED:'E901',
  SWARM_UPLOAD_ERROR:     'E902',
  SWARM_DOWNLOAD_ERROR:   'E903',
  SWARM_CHECKSUM_MISMATCH:'E904',
  SWARM_PAYLOAD_TOO_LARGE:'E905',
  SWARM_OFFLINE_QUEUE_FULL:'E906',
});

// ---------------------------------------------------------------------------
// Error Messages
// ---------------------------------------------------------------------------

/**
 * Human-readable messages for each error code.
 * @type {Readonly<Record<string, string>>}
 */
const ERROR_MESSAGES = Object.freeze({
  // E1xx - Configuration
  E101: 'Configuration file not found (artibot.config.json)',
  E102: 'Failed to parse configuration file (invalid JSON)',
  E103: 'Configuration validation failed',
  E104: 'Configuration schema version mismatch',
  E105: 'Insufficient permissions to read configuration file',
  E106: 'Plugin version does not match configuration version',

  // E2xx - Hooks
  E201: 'Failed to load hook configuration (hooks.json)',
  E202: 'Hook script execution error',
  E203: 'Hook script exceeded timeout',
  E204: 'Invalid hook matcher expression',
  E205: 'Hook script file not found',
  E206: 'Hook script returned invalid output',
  E207: 'Operation blocked by security hook',

  // E3xx - Agents / Teams
  E301: 'Agent definition not found',
  E302: 'Failed to spawn agent teammate',
  E303: 'Agent did not respond within timeout',
  E304: 'Failed to create agent team',
  E305: 'Team communication error (SendMessage failed)',
  E306: 'Failed to assign task to agent',
  E307: 'Agent shutdown did not complete cleanly',
  E308: 'Maximum team size limit exceeded',

  // E4xx - Privacy / PII
  E401: 'PII scrubbing operation failed',
  E402: 'Invalid PII detection pattern',
  E403: 'PII validation check failed (residual data detected)',
  E404: 'Unicode homoglyph characters detected in input',
  E405: 'Residual PII found after scrubbing',

  // E5xx - Cache
  E501: 'Cache initialization failed',
  E502: 'Cache read operation failed',
  E503: 'Cache write operation failed',
  E504: 'Cache eviction error during cleanup',
  E505: 'Cache capacity limit exceeded',

  // E6xx - Intent Detection
  E601: 'Failed to parse user intent from input',
  E602: 'Ambiguous intent detected (multiple matches)',
  E603: 'Input language not supported for intent detection',
  E604: 'No matching trigger found for input',

  // E7xx - Cognitive Engine
  E701: 'Cognitive routing failed for input',
  E702: 'System 1 (fast path) processing failure',
  E703: 'System 2 (deep analysis) exceeded time limit',
  E704: 'Sandboxed evaluation error in System 2',
  E705: 'Adaptive threshold adjustment error',

  // E8xx - Learning Pipeline
  E801: 'Failed to collect learning experiences',
  E802: 'GRPO optimization cycle error',
  E803: 'Knowledge transfer (promote/demote) failed',
  E804: 'Self-evaluation scoring error',
  E805: 'Tool learner recording error',
  E806: 'Memory persistence write failed',

  // E9xx - Swarm / Network
  E901: 'Cannot connect to swarm aggregation server',
  E902: 'Failed to upload patterns to swarm server',
  E903: 'Failed to download patterns from swarm server',
  E904: 'Checksum verification failed on swarm data',
  E905: 'Swarm upload payload exceeds 5MB limit',
  E906: 'Offline queue is full (max 100 entries)',
});

// ---------------------------------------------------------------------------
// Lookup Functions
// ---------------------------------------------------------------------------

/**
 * Get the human-readable message for an error code.
 *
 * @param {string} code - Error code (e.g., 'E101', 'E302')
 * @returns {string} Error message, or 'Unknown error code: {code}' if not found
 * @example
 * getErrorMessage('E101');
 * // 'Configuration file not found (artibot.config.json)'
 *
 * getErrorMessage('E999');
 * // 'Unknown error code: E999'
 */
export function getErrorMessage(code) {
  if (!code || typeof code !== 'string') return 'Unknown error code: (invalid)';
  return ERROR_MESSAGES[code] ?? `Unknown error code: ${code}`;
}

/**
 * Check whether a string is a valid Artibot error code.
 *
 * @param {string} code - String to check
 * @returns {boolean} True if code exists in the error code registry
 * @example
 * isError('E101'); // true
 * isError('E999'); // false
 * isError('hello'); // false
 */
export function isError(code) {
  if (!code || typeof code !== 'string') return false;
  return code in ERROR_MESSAGES;
}

/**
 * Get the category name for an error code.
 *
 * @param {string} code - Error code (e.g., 'E101')
 * @returns {string} Category name or 'unknown'
 * @example
 * getErrorCategory('E101'); // 'config'
 * getErrorCategory('E302'); // 'agent'
 */
export function getErrorCategory(code) {
  if (!code || typeof code !== 'string' || !code.startsWith('E') || code.length < 4) {
    return 'unknown';
  }
  const prefix = code[1];
  const categories = {
    '1': 'config',
    '2': 'hook',
    '3': 'agent',
    '4': 'privacy',
    '5': 'cache',
    '6': 'intent',
    '7': 'cognitive',
    '8': 'learning',
    '9': 'swarm',
  };
  return categories[prefix] ?? 'unknown';
}

/**
 * Get all error codes for a specific category.
 *
 * @param {string} category - Category name (config, hook, agent, privacy, cache, intent, cognitive, learning, swarm)
 * @returns {Array<{ code: string, message: string }>}
 * @example
 * const configErrors = getErrorsByCategory('config');
 * // [{ code: 'E101', message: 'Configuration file not found...' }, ...]
 */
export function getErrorsByCategory(category) {
  const prefixMap = {
    config: '1',
    hook: '2',
    agent: '3',
    privacy: '4',
    cache: '5',
    intent: '6',
    cognitive: '7',
    learning: '8',
    swarm: '9',
  };

  const prefix = prefixMap[category];
  if (!prefix) return [];

  return Object.entries(ERROR_MESSAGES)
    .filter(([code]) => code[1] === prefix)
    .map(([code, message]) => ({ code, message }));
}

/**
 * List all registered error codes with their messages.
 *
 * @returns {Array<{ code: string, message: string, category: string }>}
 * @example
 * const all = listAllErrors();
 * // all[0]: { code: 'E101', message: '...', category: 'config' }
 */
export function listAllErrors() {
  return Object.entries(ERROR_MESSAGES)
    .map(([code, message]) => ({
      code,
      message,
      category: getErrorCategory(code),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
