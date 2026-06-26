/**
 * PII detection patterns and matching logic for federated learning.
 * Contains all built-in regex patterns, tokens, and hint-matching helpers.
 * Used by pii-scrubber.js for the actual scrubbing/masking pass.
 *
 * Zero dependencies. ESM only.
 * @module lib/privacy/pii-detector
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Replacement tokens for each PII category */
export const TOKENS = {
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
export const BUILTIN_PATTERNS = [
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
    // Azure Storage / Cosmos account keys = base64 of 64 bytes = 86 data chars
    // + '=='. The char class includes base64 '+'/'/' (the old [a-zA-Z0-9] class
    // dropped them, so real keys leaked), and there is NO end-of-line anchor so
    // the key is matched mid-string — e.g. inside a JSON-serialized ledger line
    // (the old `\s*$` never matched there). min 86 keeps short base64 out:
    // Basic-auth payloads and 44-char SHA-256 single-'=' hashes are intentionally
    // NOT matched here (handled by basic_auth / preserved as context elsewhere).
    regex: /[A-Za-z0-9+/]{86,}==/g,
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
// Validation Patterns
// ---------------------------------------------------------------------------

/**
 * Quick-check patterns for residual PII validation.
 * Used by validateScrubbed() to verify scrubbing completeness.
 * @type {Array<{name: string, regex: RegExp}>}
 */
export const VALIDATION_CHECKS = [
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
export function hintMatches(hint, text, lower, caseInsensitive) {
  if (hint === null || hint === undefined) return true;
  const haystack = caseInsensitive ? lower : text;
  if (typeof hint === 'string') return haystack.includes(hint);
  for (let i = 0; i < hint.length; i++) {
    if (haystack.includes(hint[i])) return true;
  }
  return false;
}
