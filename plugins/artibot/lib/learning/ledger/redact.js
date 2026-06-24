/**
 * Secret redaction for the Ambient Conversation Ledger.
 *
 * Thin adapter over the verified `lib/privacy` scrubber — NO new redactor
 * (PRD F-04 / Open Decision #1 = reuse). Scoped to SECRET-bearing categories
 * only (credentials / auth / secrets / env) so genuine secrets (API keys, AWS
 * keys, Bearer/JWT, dotenv KEY=value) are masked to [REDACTED_KEY] /
 * [REDACTED_SECRET], while non-secret conversation context (emails, IPs, file
 * paths) is PRESERVED — masking those would degrade the ledger's whole purpose
 * (context retention).
 *
 * Redaction runs on the verbatim slimmed JSONL line strings BEFORE they touch
 * disk (F-04 R3). [REDACTED_*] replacements are valid JSON string content, so
 * the line stays valid JSONL.
 *
 * @module lib/learning/ledger/redact
 */

import { createScopedScrubber } from '../../privacy/pii-scrubber.js';

/**
 * Secret-bearing categories from `lib/privacy/pii-detector.js`. Excludes
 * `network` (IP), `personal` (email/phone), `paths`, `identifiers`, `git`,
 * `code` — those are useful conversation context and must survive into the
 * ledger.
 * @type {readonly string[]}
 */
export const SECRET_CATEGORIES = Object.freeze(['credentials', 'auth', 'secrets', 'env']);

const scrubber = createScopedScrubber([...SECRET_CATEGORIES]);

/**
 * Redact secrets from a single string (e.g. one raw JSONL line).
 *
 * @param {string} text
 * @returns {string} Text with secrets replaced by [REDACTED_*] tokens.
 */
export function redactSecrets(text) {
  return scrubber.scrub(text);
}

/**
 * Redact secrets from each line in an array.
 *
 * @param {string[]} lines
 * @returns {string[]} Redacted lines (same length / order).
 */
export function redactLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((l) => (typeof l === 'string' ? scrubber.scrub(l) : l));
}
