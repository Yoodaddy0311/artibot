/**
 * Sandbox command allowlist (read-only by default).
 * Pattern adopted from openai-agents-python sandbox manifest (AD-09).
 * Used by pre-bash hook gates and any future sandbox surface.
 * @module lib/security/cmd-allowlist
 */

export const DEFAULT_BASH_ALLOWLIST = Object.freeze([
  'ls',
  'find',
  'stat',
  'cat',
  'less',
  'head',
  'tail',
  'du',
  'grep',
  'rg',
  'wc',
  'sort',
  'cut',
  'cp',
  'tee',
  'echo',
  'mkdir',
  'rm',
]);

/**
 * Extract the leading binary name from a bash command string.
 * Handles: leading env-var assignments, sudo, simple quoting.
 * Returns null when no binary can be parsed.
 * @param {string} cmd
 * @returns {string | null}
 */
export function parseLeadingBinary(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return null;
  const tokens = cmd.trim().split(/\s+/);
  let i = 0;
  // Skip leading FOO=bar assignments
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    i += 1;
  }
  // Skip sudo / sudo -E etc.
  if (tokens[i] === 'sudo') {
    i += 1;
    while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
  }
  if (i >= tokens.length) return null;
  const raw = tokens[i].replace(/^["']|["']$/g, '');
  // basename: strip path prefix
  const slashIdx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  return slashIdx >= 0 ? raw.slice(slashIdx + 1) : raw;
}

const SHELL_META_RE = /[;&|`$()<>]|\|\||&&/;

/**
 * Detect shell metacharacters that could chain commands or expand variables.
 * Used to reject `ls; rm -rf /` even when the leading binary is allowlisted.
 * @param {string} cmd
 * @returns {boolean}
 */
export function hasShellMetacharacters(cmd) {
  return SHELL_META_RE.test(String(cmd ?? ''));
}

/**
 * Check whether a command's leading binary is allowed.
 * Rejects commands containing shell metacharacters even if the leading binary matches.
 * @param {string} cmd
 * @param {string[]} [allowlist]
 * @returns {boolean}
 */
export function isAllowedCommand(cmd, allowlist = DEFAULT_BASH_ALLOWLIST) {
  if (hasShellMetacharacters(cmd)) return false;
  const bin = parseLeadingBinary(cmd);
  if (!bin) return false;
  return allowlist.includes(bin);
}

/**
 * Diagnose a command: returns the parsed binary, metacharacter flag, and allow decision.
 * @param {string} cmd
 * @param {string[]} [allowlist]
 * @returns {{bin: string|null, hasMeta: boolean, allowed: boolean}}
 */
export function diagnose(cmd, allowlist = DEFAULT_BASH_ALLOWLIST) {
  const hasMeta = hasShellMetacharacters(cmd);
  const bin = parseLeadingBinary(cmd);
  return { bin, hasMeta, allowed: !hasMeta && bin !== null && allowlist.includes(bin) };
}
