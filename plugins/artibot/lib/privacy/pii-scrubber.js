/**
 * PII (Personally Identifiable Information) scrubber for federated learning.
 * Masks sensitive data in text before transmission to aggregation servers.
 * Uses regex-based pattern matching with configurable categories.
 *
 * Zero dependencies. ESM only.
 * @module lib/privacy/pii-scrubber
 */

import { getPlatform } from '../core/platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Replacement tokens for each PII category */
const TOKENS = {
  USER_HOME: '{USER_HOME}',
  PROJECT: '{PROJECT}',
  REDACTED_KEY: '[REDACTED_KEY]',
  REDACTED_SECRET: '[REDACTED_SECRET]',
  REDACTED_TOKEN: '[REDACTED_TOKEN]',
  IP: '[IP]',
  HOST: '[HOST]',
  PARAMS: '[PARAMS]',
  EMAIL: '[EMAIL]',
  PHONE: '[PHONE]',
  ENV_VAR: '[ENV_VAR]',
  STRING: '[STRING]',
  PATH: '[PATH]',
  UUID: '[UUID]',
  CREDIT_CARD: '[CREDIT_CARD]',
  SSN: '[SSN]',
  MAC_ADDR: '[MAC_ADDR]',
  PRIVATE_KEY: '[PRIVATE_KEY]',
  CONNECTION_STRING: '[CONNECTION_STRING]',
  HASH: '[HASH]',
};

// ---------------------------------------------------------------------------
// Platform-Aware Path Detection
// ---------------------------------------------------------------------------

const { isWindows } = getPlatform();

/**
 * Build home directory patterns for the current platform.
 * @returns {RegExp[]}
 * @example
 * const patterns = buildHomePathPatterns();
 * // On Windows: patterns match C:\Users\<username>\...
 * // On Unix: patterns match /home/<username>/...
 */
export function buildHomePathPatterns() {
  const patterns = [];

  if (isWindows) {
    // C:\Users\<username>\... -> {USER_HOME}\...
    patterns.push(/[A-Z]:\\Users\\[^\\:*?"<>|\s]+/gi);
    // C:\Documents and Settings\<username>\...
    patterns.push(/[A-Z]:\\Documents and Settings\\[^\\:*?"<>|\s]+/gi);
  } else {
    // /home/<username>/... -> {USER_HOME}/...
    patterns.push(/\/home\/[a-zA-Z0-9._-]+/g);
    // /Users/<username>/... (macOS)
    patterns.push(/\/Users\/[a-zA-Z0-9._-]+/g);
  }

  // $HOME, %USERPROFILE%, %HOMEPATH%
  patterns.push(/\$HOME/g);
  patterns.push(/%USERPROFILE%/gi);
  patterns.push(/%HOMEPATH%/gi);

  return patterns;
}

// ---------------------------------------------------------------------------
// Pattern Categories
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ScrubPattern
 * @property {string} name - Pattern identifier
 * @property {string} category - Category grouping
 * @property {RegExp} regex - Detection pattern
 * @property {string} replacement - Replacement token
 * @property {number} priority - Lower = applied first (0-100)
 * @property {string|string[]|null} [hint] - Fast pre-test: literal substring(s) that must
 *   be present in the input for the regex to possibly match. When set, `includes()` is
 *   checked before running the expensive regex. Use lowercase strings for case-insensitive
 *   regexes. `null` means always run the regex (no viable fast hint).
 */

/**
 * Built-in scrubbing patterns, ordered by category.
 * Priority determines application order (lower first).
 * @type {ScrubPattern[]}
 */
const BUILTIN_PATTERNS = [
  // ----- Private Keys & Certificates (Priority 0-9) -----
  {
    name: 'pem_private_key',
    category: 'credentials',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: TOKENS.PRIVATE_KEY,
    priority: 0,
    hint: 'PRIVATE KEY-----',
  },
  {
    name: 'pgp_private_key',
    category: 'credentials',
    regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g,
    replacement: TOKENS.PRIVATE_KEY,
    priority: 1,
    hint: 'PGP PRIVATE KEY',
  },

  // ----- API Keys & Tokens (Priority 10-29) -----
  {
    name: 'openai_key',
    category: 'auth',
    regex: /sk-[a-zA-Z0-9_-]{20,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 10,
    hint: 'sk-',
  },
  {
    name: 'github_pat',
    category: 'auth',
    regex: /ghp_[a-zA-Z0-9]{36,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 11,
    hint: 'ghp_',
  },
  {
    name: 'github_oauth',
    category: 'auth',
    regex: /gho_[a-zA-Z0-9]{36,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 12,
    hint: 'gho_',
  },
  {
    name: 'github_user_to_server',
    category: 'auth',
    regex: /ghu_[a-zA-Z0-9]{36,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 13,
    hint: 'ghu_',
  },
  {
    name: 'github_server_to_server',
    category: 'auth',
    regex: /ghs_[a-zA-Z0-9]{36,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 14,
    hint: 'ghs_',
  },
  {
    name: 'github_refresh',
    category: 'auth',
    regex: /ghr_[a-zA-Z0-9]{36,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 15,
    hint: 'ghr_',
  },
  {
    name: 'aws_access_key',
    category: 'auth',
    regex: /AKIA[A-Z0-9]{16}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 16,
    hint: 'AKIA',
  },
  {
    name: 'aws_secret_key',
    category: 'auth',
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 17,
    hint: 'secret_access_key',
  },
  {
    name: 'azure_key',
    category: 'auth',
    regex: /[a-zA-Z0-9]{32,}==\s*$/gm,
    replacement: TOKENS.REDACTED_KEY,
    priority: 18,
    hint: '==',
  },
  {
    name: 'gcp_api_key',
    category: 'auth',
    regex: /AIza[a-zA-Z0-9_-]{35}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 19,
    hint: 'AIza',
  },
  {
    name: 'slack_token',
    category: 'auth',
    regex: /xox[bporas]-[a-zA-Z0-9-]{10,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 20,
    hint: 'xox',
  },
  {
    name: 'stripe_key',
    category: 'auth',
    regex: /(?:sk|pk|rk)_(?:test|live)_[a-zA-Z0-9]{20,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 21,
    hint: ['_test_', '_live_'],
  },
  {
    name: 'twilio_key',
    category: 'auth',
    regex: /SK[a-f0-9]{32}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 22,
    hint: 'SK',
  },
  {
    name: 'sendgrid_key',
    category: 'auth',
    regex: /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{43}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 23,
    hint: 'SG.',
  },
  {
    name: 'npm_token',
    category: 'auth',
    regex: /npm_[a-zA-Z0-9]{36,}/g,
    replacement: TOKENS.REDACTED_KEY,
    priority: 24,
    hint: 'npm_',
  },
  {
    name: 'bearer_token',
    category: 'auth',
    regex: /Bearer\s+[a-zA-Z0-9._\-/+=]{20,}/g,
    replacement: `Bearer ${TOKENS.REDACTED_TOKEN}`,
    priority: 25,
    hint: 'Bearer',
  },
  {
    name: 'basic_auth',
    category: 'auth',
    regex: /Basic\s+[A-Za-z0-9+/=]{10,}/g,
    replacement: `Basic ${TOKENS.REDACTED_TOKEN}`,
    priority: 26,
    hint: 'Basic',
  },
  {
    name: 'jwt_token',
    category: 'auth',
    regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    replacement: TOKENS.REDACTED_TOKEN,
    priority: 27,
    hint: 'eyJ',
  },
  {
    name: 'generic_api_key_assignment',
    category: 'auth',
    regex: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*['"]?[a-zA-Z0-9_\-/+=]{16,}['"]?/gi,
    replacement: `api_key=${TOKENS.REDACTED_KEY}`,
    priority: 28,
    hint: 'api',
  },

  // ----- Passwords & Secrets (Priority 30-39) -----
  {
    name: 'password_assignment',
    category: 'secrets',
    regex: /(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{4,}['"]?/gi,
    replacement: `password=${TOKENS.REDACTED_SECRET}`,
    priority: 30,
    hint: ['password', 'passwd', 'pwd'],
  },
  {
    name: 'secret_assignment',
    category: 'secrets',
    regex: /(?:secret|client_secret|app_secret)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
    replacement: `secret=${TOKENS.REDACTED_SECRET}`,
    priority: 31,
    hint: 'secret',
  },
  {
    name: 'credential_assignment',
    category: 'secrets',
    regex: /(?:credential|credentials)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
    replacement: `credential=${TOKENS.REDACTED_SECRET}`,
    priority: 32,
    hint: 'credential',
  },
  {
    name: 'private_key_assignment',
    category: 'secrets',
    regex: /(?:private[_-]?key)\s*[=:]\s*['"]?[^\s'"]{16,}['"]?/gi,
    replacement: `private_key=${TOKENS.REDACTED_SECRET}`,
    priority: 33,
    hint: 'private',
  },
  {
    name: 'access_token_assignment',
    category: 'secrets',
    regex: /(?:access[_-]?token|auth[_-]?token|refresh[_-]?token)\s*[=:]\s*['"]?[^\s'"]{10,}['"]?/gi,
    replacement: `token=${TOKENS.REDACTED_TOKEN}`,
    priority: 34,
    hint: 'token',
  },
  {
    name: 'connection_string',
    category: 'secrets',
    regex: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|mssql):\/\/[^\s'"]+/gi,
    replacement: TOKENS.CONNECTION_STRING,
    priority: 35,
    hint: '://',
  },
  {
    name: 'dsn_string',
    category: 'secrets',
    regex: /(?:sentry|bugsnag|rollbar)_dsn\s*[=:]\s*['"]?https?:\/\/[^\s'"]+['"]?/gi,
    replacement: `dsn=${TOKENS.CONNECTION_STRING}`,
    priority: 36,
    hint: '_dsn',
  },

  // ----- Environment Variables (Priority 40-44) -----
  {
    name: 'dotenv_secret_line',
    category: 'env',
    regex: /^(?:export\s+)?(?:[A-Z_]+(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|DSN|PRIVATE))\s*=\s*.*$/gm,
    replacement: TOKENS.ENV_VAR,
    priority: 40,
    hint: null,
  },
  {
    name: 'process_env_access',
    category: 'env',
    regex: /process\.env\.([A-Z_]+(?:KEY|SECRET|TOKEN|PASSWORD|AUTH))/g,
    replacement: `process.env.${TOKENS.ENV_VAR}`,
    priority: 41,
    hint: 'process.env.',
  },
  {
    name: 'env_interpolation',
    category: 'env',
    regex: /\$\{([A-Z_]+(?:KEY|SECRET|TOKEN|PASSWORD|AUTH))\}/g,
    replacement: `\${${TOKENS.ENV_VAR}}`,
    priority: 42,
    hint: '${',
  },

  // ----- Network: IP Addresses (Priority 45-49) -----
  {
    name: 'ipv4_address',
    category: 'network',
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    replacement: TOKENS.IP,
    priority: 45,
    hint: null,
  },
  {
    name: 'ipv6_address',
    category: 'network',
    regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    replacement: TOKENS.IP,
    priority: 46,
    hint: null,
  },
  {
    name: 'ipv6_compressed',
    category: 'network',
    regex: /\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g,
    replacement: TOKENS.IP,
    priority: 47,
    hint: null,
  },
  {
    name: 'mac_address',
    category: 'network',
    regex: /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g,
    replacement: TOKENS.MAC_ADDR,
    priority: 48,
    hint: null,
  },

  // ----- Network: URLs & Domains (Priority 50-54) -----
  {
    name: 'url_with_credentials',
    category: 'network',
    regex: /https?:\/\/[^:]+:[^@]+@[^\s'"]+/g,
    replacement: TOKENS.CONNECTION_STRING,
    priority: 50,
    hint: '://',
  },
  {
    name: 'url_query_params',
    category: 'network',
    regex: /(\bhttps?:\/\/[^\s?'"]+)\?[^\s'"]+/g,
    replacement: `$1?${TOKENS.PARAMS}`,
    priority: 51,
    hint: '://',
  },
  {
    name: 'internal_hostname',
    category: 'network',
    regex: /\b[a-z0-9-]+\.(?:internal|local|corp|intranet|private)\b/gi,
    replacement: TOKENS.HOST,
    priority: 52,
    hint: ['.internal', '.local', '.corp', '.intranet', '.private'],
  },
  {
    name: 'ip_with_port',
    category: 'network',
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b/g,
    replacement: `${TOKENS.IP}:PORT`,
    priority: 53,
    hint: null,
  },

  // ----- Personal Information (Priority 55-64) -----
  {
    name: 'email_address',
    category: 'personal',
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    replacement: TOKENS.EMAIL,
    priority: 55,
    hint: '@',
  },
  {
    name: 'phone_international',
    category: 'personal',
    regex: /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g,
    replacement: TOKENS.PHONE,
    priority: 56,
    hint: '+',
  },
  {
    name: 'phone_us',
    category: 'personal',
    regex: /\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: TOKENS.PHONE,
    priority: 57,
    hint: null,
  },
  {
    name: 'ssn_us',
    category: 'personal',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: TOKENS.SSN,
    priority: 58,
    hint: null,
  },
  {
    name: 'credit_card_visa_mc',
    category: 'personal',
    regex: /\b(?:4\d{3}|5[1-5]\d{2})[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    replacement: TOKENS.CREDIT_CARD,
    priority: 59,
    hint: null,
  },
  {
    name: 'credit_card_amex',
    category: 'personal',
    regex: /\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g,
    replacement: TOKENS.CREDIT_CARD,
    priority: 60,
    hint: null,
  },

  // ----- UUIDs (Priority 65) -----
  {
    name: 'uuid_v4',
    category: 'identifiers',
    regex: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
    replacement: TOKENS.UUID,
    priority: 65,
    hint: '-4',
  },

  // ----- Paths (Priority 70-74) -----
  // Home directory patterns are dynamically generated and injected at init time.
  // These cover generic project path leakage.
  {
    name: 'windows_user_path',
    category: 'paths',
    regex: /[A-Z]:\\Users\\[^\\:*?"<>|\s]+\\[^\s'"]+/gi,
    replacement: `${TOKENS.USER_HOME}\\${TOKENS.PATH}`,
    priority: 70,
    hint: ':\\users\\',
  },
  {
    name: 'unix_home_path',
    category: 'paths',
    regex: /\/(?:home|Users)\/[a-zA-Z0-9._-]+\/[^\s'"]+/g,
    replacement: `${TOKENS.USER_HOME}/${TOKENS.PATH}`,
    priority: 71,
    hint: ['/home/', '/Users/'],
  },
  {
    name: 'tilde_home_path',
    category: 'paths',
    regex: /~\/[^\s'"]+/g,
    replacement: `${TOKENS.USER_HOME}/${TOKENS.PATH}`,
    priority: 72,
    hint: '~/',
  },

  // ----- Hashes & Encoded Data (Priority 75-79) -----
  {
    name: 'hex_hash_long',
    category: 'identifiers',
    regex: /\b[a-fA-F0-9]{64}\b/g,
    replacement: TOKENS.HASH,
    priority: 75,
    hint: null,
  },
  {
    name: 'base64_long_block',
    category: 'identifiers',
    regex: /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
    replacement: TOKENS.STRING,
    priority: 76,
    hint: null,
  },

  // ----- Git (Priority 80-84) -----
  // Commit hashes are preserved. Only author emails are scrubbed (covered by email pattern above).
  {
    name: 'git_remote_url_ssh',
    category: 'git',
    regex: /git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+\.git/g,
    replacement: `git@${TOKENS.HOST}:${TOKENS.PATH}.git`,
    priority: 80,
    hint: 'git@',
  },
  {
    name: 'git_remote_url_https',
    category: 'git',
    regex: /https:\/\/[a-zA-Z0-9.-]+\/[a-zA-Z0-9._/-]+\.git/g,
    replacement: `https://${TOKENS.HOST}/${TOKENS.PATH}.git`,
    priority: 81,
    hint: '.git',
  },

  // ----- Code String Literals with Secrets (Priority 85-89) -----
  {
    name: 'inline_password_string',
    category: 'code',
    regex: /(['"])(?:password|secret|token|apiKey|api_key|private_key)\1\s*:\s*(['"])[^'"]{8,}\2/g,
    replacement: `$1password$1: $2${TOKENS.REDACTED_SECRET}$2`,
    priority: 85,
    hint: null,
  },
  {
    name: 'config_sensitive_value',
    category: 'code',
    regex: /(?:password|secret|token|key|credential|auth)['"]?\s*[=:]\s*['"][^'"]{8,}['"]/gi,
    replacement: `key: '${TOKENS.REDACTED_SECRET}'`,
    priority: 86,
    hint: null,
  },
];

// ---------------------------------------------------------------------------
// Scrubber State
// ---------------------------------------------------------------------------

/** @type {ScrubPattern[]} */
let activePatterns = [...BUILTIN_PATTERNS];

/** Patterns pre-sorted by priority for scrub(). Rebuilt when activePatterns changes. */
let sortedPatterns = [...activePatterns].sort((a, b) => a.priority - b.priority);

/** Rebuild the cached sorted array after any mutation to activePatterns. */
function rebuildSortedPatterns() {
  sortedPatterns = [...activePatterns].sort((a, b) => a.priority - b.priority);
}

/** @type {{ totalScrubs: number, byCategory: Record<string, number>, byPattern: Record<string, number> }} */
let stats = createEmptyStats();

/**
 * Create empty statistics object.
 * @returns {{ totalScrubs: number, byCategory: Record<string, number>, byPattern: Record<string, number> }}
 */
function createEmptyStats() {
  return { totalScrubs: 0, byCategory: {}, byPattern: {} };
}

// ---------------------------------------------------------------------------
// Hint Pre-Test Helper
// ---------------------------------------------------------------------------

/**
 * Fast pre-test: check if at least one hint substring is present in the text.
 * Returns true if the pattern should be tested (hint matches or no hint defined).
 *
 * For case-insensitive regexes, hints must be stored in lowercase and
 * the caller must pass a lowercased version of the text.
 *
 * @param {string|string[]|null|undefined} hint - Literal hint(s) from the pattern
 * @param {string} text - The current text to search (original case)
 * @param {string} lower - The lowercased text (for case-insensitive hints)
 * @param {boolean} caseInsensitive - Whether the regex has the 'i' flag
 * @returns {boolean} true if the regex should be executed
 */
function hintMatches(hint, text, lower, caseInsensitive) {
  if (hint === null || hint === undefined) return true;
  const haystack = caseInsensitive ? lower : text;
  if (typeof hint === 'string') return haystack.includes(hint);
  for (let i = 0; i < hint.length; i++) {
    if (haystack.includes(hint[i])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core Scrubbing Functions
// ---------------------------------------------------------------------------

/**
 * Scrub all PII from a text string.
 * Applies patterns in priority order (lowest number first).
 * Uses indexOf/includes pre-tests to skip expensive regex when possible.
 *
 * @param {string} text - Input text to scrub
 * @returns {string} Scrubbed text with PII replaced by tokens
 * @example
 * const cleaned = scrub('Contact: user@example.com');
 * // cleaned: 'Contact: [EMAIL]'
 *
 * const safe = scrub('Server at 192.168.1.100:3000');
 * // safe: 'Server at [IP]:PORT'
 */
export function scrub(text) {
  if (!text || typeof text !== 'string') return text ?? '';

  let result = text;
  let lower = text.toLowerCase();

  for (const pat of sortedPatterns) {
    // Fast path: skip regex if hint substring is not present
    if (!hintMatches(pat.hint, result, lower, pat.regex.ignoreCase)) continue;

    // Reset regex lastIndex for global patterns
    if (pat.regex.global) {
      pat.regex.lastIndex = 0;
    }

    const before = result;
    result = result.replace(pat.regex, pat.replacement);

    if (result !== before) {
      stats.totalScrubs += 1;
      stats.byCategory[pat.category] = (stats.byCategory[pat.category] || 0) + 1;
      stats.byPattern[pat.name] = (stats.byPattern[pat.name] || 0) + 1;
      // Update lowercased copy after replacement
      lower = result.toLowerCase();
    }
  }

  return result;
}

/**
 * Scrub sensitive information from a pattern object.
 * Recursively walks object properties and scrubs string values.
 *
 * @param {object} pattern - Object that may contain PII in string values
 * @returns {object} New object with PII scrubbed (immutable)
 * @example
 * const result = scrubPattern({ email: 'user@example.com', score: 0.9 });
 * // result: { email: '[EMAIL]', score: 0.9 }
 */
export function scrubPattern(pattern) {
  if (pattern === null || pattern === undefined) return pattern;

  if (typeof pattern === 'string') {
    return scrub(pattern);
  }

  if (Array.isArray(pattern)) {
    return pattern.map(scrubPattern);
  }

  if (typeof pattern === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(pattern)) {
      result[key] = scrubPattern(value);
    }
    return result;
  }

  // Primitives (numbers, booleans) pass through
  return pattern;
}

/**
 * Batch scrub an array of pattern objects.
 *
 * @param {object[]} patterns - Array of objects to scrub
 * @returns {object[]} New array with all PII scrubbed
 * @example
 * const results = scrubPatterns([
 *   { author: 'user@example.com', content: 'hello' },
 *   { author: 'admin@corp.io', content: 'world' },
 * ]);
 * // results[0].author === '[EMAIL]'
 * // results[1].author === '[EMAIL]'
 */
export function scrubPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns.map(scrubPattern);
}

/**
 * Add a custom scrubbing pattern.
 *
 * @param {string} name - Unique pattern identifier
 * @param {RegExp} regex - Detection regex (should have 'g' flag)
 * @param {string} replacement - Replacement text
 * @param {object} [options]
 * @param {string} [options.category='custom'] - Category grouping
 * @param {number} [options.priority=90] - Application priority (0-100)
 * @returns {{ name: string, added: boolean }}
 * @example
 * const result = addCustomPattern('internal_id', /PROJ-\d{6}/g, '[INTERNAL_ID]', { category: 'identifiers' });
 * // result: { name: 'internal_id', added: true }
 */
export function addCustomPattern(name, regex, replacement, options = {}) {
  if (!name || !(regex instanceof RegExp) || typeof replacement !== 'string') {
    return { name, added: false };
  }

  // Remove existing pattern with same name
  activePatterns = activePatterns.filter((p) => p.name !== name);

  activePatterns.push({
    name,
    category: options.category || 'custom',
    regex,
    replacement,
    priority: options.priority ?? 90,
  });

  rebuildSortedPatterns();
  return { name, added: true };
}

/**
 * Remove a custom pattern by name.
 * Built-in patterns cannot be removed (only disabled).
 *
 * @param {string} name - Pattern identifier
 * @returns {{ name: string, removed: boolean }}
 * @example
 * const result = removeCustomPattern('internal_id');
 * // result: { name: 'internal_id', removed: true }
 */
export function removeCustomPattern(name) {
  const before = activePatterns.length;
  activePatterns = activePatterns.filter((p) => p.name !== name);
  if (activePatterns.length < before) rebuildSortedPatterns();
  return { name, removed: activePatterns.length < before };
}

/**
 * Get current scrubbing statistics.
 *
 * @returns {{ totalScrubs: number, byCategory: Record<string, number>, byPattern: Record<string, number>, patternCount: number }}
 * @example
 * const stats = getScrubStats();
 * // stats.totalScrubs === 15
 * // stats.byCategory === { auth: 8, personal: 5, paths: 2 }
 * // stats.patternCount === 43
 */
export function getScrubStats() {
  return {
    ...stats,
    patternCount: activePatterns.length,
  };
}

/**
 * Reset scrubbing statistics.
 *
 * @example
 * resetStats();
 * // getScrubStats().totalScrubs === 0
 */
export function resetStats() {
  stats = createEmptyStats();
}

/**
 * Validate that text has been properly scrubbed.
 * Checks for residual sensitive patterns that may have been missed.
 *
 * @param {string} text - Previously scrubbed text to validate
 * @returns {{ clean: boolean, residual: string[] }}
 * @example
 * const result = validateScrubbed('All clean, key=[REDACTED_KEY]');
 * // result: { clean: true, residual: [] }
 *
 * const bad = validateScrubbed('Leaked: user@company.com');
 * // bad: { clean: false, residual: ['email'] }
 */
export function validateScrubbed(text) {
  if (!text || typeof text !== 'string') return { clean: true, residual: [] };

  const residual = [];

  // Quick-check patterns for common residual PII
  const checks = [
    { name: 'api_key_pattern', regex: /sk-[a-zA-Z0-9_-]{20,}/g },
    { name: 'github_token', regex: /gh[pours]_[a-zA-Z0-9]{36,}/g },
    { name: 'aws_key', regex: /AKIA[A-Z0-9]{16}/g },
    { name: 'email', regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
    { name: 'bearer_token_raw', regex: /Bearer\s+(?![[{])[a-zA-Z0-9._/+=-]{20,}/g },
    { name: 'jwt', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
    { name: 'connection_string', regex: /(?:mongodb|postgres|mysql|redis):\/\/[^[\s]+/gi },
    { name: 'pem_key', regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
    { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
    { name: 'credit_card', regex: /\b(?:4\d{3}|5[1-5]\d{2})[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
  ];

  for (const check of checks) {
    check.regex.lastIndex = 0;
    if (check.regex.test(text)) {
      residual.push(check.name);
    }
  }

  return { clean: residual.length === 0, residual };
}

/**
 * List all active patterns with metadata.
 *
 * @returns {Array<{ name: string, category: string, priority: number }>}
 * @example
 * const patterns = listPatterns();
 * // patterns[0]: { name: 'pem_private_key', category: 'credentials', priority: 0 }
 */
export function listPatterns() {
  return activePatterns
    .map(({ name, category, priority }) => ({ name, category, priority }))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Restore active patterns to built-in defaults.
 * Removes all custom patterns.
 *
 * @example
 * addCustomPattern('my-pattern', /test/g, '[TEST]');
 * resetPatterns();
 * // Custom pattern removed, only built-in patterns active
 */
export function resetPatterns() {
  activePatterns = [...BUILTIN_PATTERNS];
  rebuildSortedPatterns();
}

/**
 * Create a scoped scrubber with a subset of categories.
 * Useful for applying only path scrubbing or only auth scrubbing.
 *
 * @param {string[]} categories - Categories to include (e.g. ['auth', 'secrets'])
 * @returns {{ scrub: (text: string) => string }}
 * @example
 * const personalScrubber = createScopedScrubber(['personal']);
 * const result = personalScrubber.scrub('Email: user@example.com');
 * // result: 'Email: [EMAIL]'
 */
export function createScopedScrubber(categories) {
  const categorySet = new Set(categories);
  const scoped = activePatterns
    .filter((p) => categorySet.has(p.category))
    .sort((a, b) => a.priority - b.priority);

  return {
    scrub(text) {
      if (!text || typeof text !== 'string') return text ?? '';
      let result = text;
      let lower = text.toLowerCase();
      for (const pat of scoped) {
        if (!hintMatches(pat.hint, result, lower, pat.regex.ignoreCase)) continue;
        if (pat.regex.global) pat.regex.lastIndex = 0;
        const before = result;
        result = result.replace(pat.regex, pat.replacement);
        if (result !== before) lower = result.toLowerCase();
      }
      return result;
    },
  };
}
