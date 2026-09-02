/**
 * Shared blocked/dangerous command patterns for sandbox and guard-registry.
 * Union of patterns from both modules, organized by category, deduplicated.
 * @module lib/core/blocked-patterns
 */

/**
 * @typedef {Object} BlockedPattern
 * @property {RegExp} pattern - Regex to match against command strings
 * @property {string} label - Human-readable description of the threat
 * @property {string} category - Pattern category for organization
 * @property {RegExp[]} [safeOverrides] - Flags that make THIS rule's match safe
 *   and so exempt it. Declared per rule on purpose: the exemption list used to
 *   be global and was tested against the whole command, which let
 *   `rm -rf / --force-with-lease` through the entire denylist (measured
 *   2026-08-30). Category scoping would not have been enough either —
 *   `--force-with-lease` is just as meaningless to `git reset --hard`, which
 *   shares the `git` category. Add one only where the flag genuinely changes
 *   what the matched command does.
 */

/**
 * All blocked command patterns, organized by category.
 * Frozen array - cannot be modified at runtime.
 * @type {ReadonlyArray<BlockedPattern>}
 */
const BLOCKED_PATTERNS = Object.freeze([
  // ── Filesystem destruction ──────────────────────────────────────────
  { pattern: /rm\s+(-\w*r\w*f|--recursive).*\//i, label: 'rm -rf with path', category: 'filesystem' },
  { pattern: /rm\s+-\w*f\w*r.*\//i, label: 'rm -fr with path', category: 'filesystem' },
  { pattern: /rm\s+-\w*[rf]\w*\s+\*/i, label: 'rm with wildcard', category: 'filesystem' },
  { pattern: /sudo\s+rm\s/i, label: 'sudo rm', category: 'filesystem' },
  { pattern: /del\s+\/s\s+\/q/i, label: 'del /s /q (Windows recursive delete)', category: 'filesystem' },
  { pattern: /del\s+\/s/i, label: 'Windows recursive delete', category: 'filesystem' },
  { pattern: /rmdir\s+\/s\s+\/q/i, label: 'rmdir /s /q (Windows recursive delete)', category: 'filesystem' },
  { pattern: /rmdir\s+\/s/i, label: 'Windows recursive rmdir', category: 'filesystem' },
  { pattern: /:\s*>\s*\//i, label: 'truncate file', category: 'filesystem' },

  // ── Disk / device ───────────────────────────────────────────────────
  { pattern: /mkfs\./i, label: 'format filesystem', category: 'disk' },
  { pattern: /dd\s+if=/i, label: 'dd raw disk write', category: 'disk' },
  { pattern: />\s*\/dev\/sd/i, label: 'write to disk device', category: 'disk' },
  { pattern: /format\s+[a-z]:/i, label: 'format drive (Windows)', category: 'disk' },
  { pattern: /diskpart/i, label: 'diskpart (Windows disk management)', category: 'disk' },

  // ── Permission escalation ───────────────────────────────────────────
  { pattern: /chmod\s+-R\s+777/i, label: 'chmod 777 recursive', category: 'permission' },
  { pattern: /chown\s+-R\s+root/i, label: 'chown to root recursive', category: 'permission' },

  // ── Git destructive ─────────────────────────────────────────────────
  // `--force-with-lease` / `--force-if-includes` turn a blind force push into a
  // checked one, so they exempt THESE two rules and nothing else.
  {
    pattern: /git\s+push\s+.*--force(?!-with-lease)/i,
    label: 'git push --force',
    category: 'git',
    safeOverrides: [/--force-with-lease/i, /--force-if-includes/i],
  },
  {
    pattern: /git\s+push\s+-f\b/i,
    label: 'git push -f',
    category: 'git',
    safeOverrides: [/--force-with-lease/i, /--force-if-includes/i],
  },
  { pattern: /git\s+reset\s+--hard/i, label: 'git reset --hard', category: 'git' },
  { pattern: /git\s+clean\s+-\w*f/i, label: 'git clean -f', category: 'git' },
  { pattern: /git\s+checkout\s+\.\s*$/i, label: 'git checkout . (discard all changes)', category: 'git' },
  { pattern: /git\s+restore\s+\.\s*$/i, label: 'git restore . (discard all changes)', category: 'git' },
  { pattern: /git\s+branch\s+-D\b/i, label: 'git branch -D (force delete)', category: 'git' },
  { pattern: /git\s+stash\s+drop/i, label: 'git stash drop', category: 'git' },

  // ── Database destruction ────────────────────────────────────────────
  { pattern: /drop\s+(database|table|schema)\b/i, label: 'DROP DATABASE/TABLE', category: 'database' },
  { pattern: /truncate\s+table\b/i, label: 'TRUNCATE TABLE', category: 'database' },
  { pattern: /delete\s+from\s+\w+\s*;?\s*$/i, label: 'DELETE FROM without WHERE', category: 'database' },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)/i, label: 'SQL destructive operation', category: 'database' },

  // ── Package publishing ──────────────────────────────────────────────
  { pattern: /npm\s+publish/i, label: 'npm publish', category: 'package' },

  // ── System shutdown / reboot ────────────────────────────────────────
  { pattern: /shutdown\s/i, label: 'system shutdown', category: 'system' },
  { pattern: /reboot\b/i, label: 'system reboot', category: 'system' },
  { pattern: /init\s+0\b/i, label: 'init 0 (halt)', category: 'system' },

  // ── Network abuse ───────────────────────────────────────────────────
  { pattern: /:(){ :\|:& };:/i, label: 'fork bomb', category: 'network' },
  { pattern: /wget\s+.*\|\s*(sh|bash|zsh|python[23]?|perl|ruby|node)/i, label: 'wget pipe to interpreter', category: 'network' },
  { pattern: /curl\s+.*\|\s*(sh|bash|zsh|python[23]?|perl|ruby|node)/i, label: 'curl pipe to interpreter', category: 'network' },

  // ── Environment destruction ─────────────────────────────────────────
  { pattern: /unset\s+(PATH|HOME|USER)\b/i, label: 'unset critical env var', category: 'environment' },
  { pattern: /export\s+PATH\s*=\s*$/i, label: 'empty PATH', category: 'environment' },
]);

/**
 * All unique categories present in BLOCKED_PATTERNS.
 * @type {ReadonlyArray<string>}
 */
const CATEGORIES = Object.freeze(
  [...new Set(BLOCKED_PATTERNS.map((p) => p.category))],
);

export { BLOCKED_PATTERNS, CATEGORIES };
