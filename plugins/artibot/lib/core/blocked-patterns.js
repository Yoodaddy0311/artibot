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
  // The three rules above miss two shapes: they all require `/` or `*` in the
  // command, and they read the flags as one combined token. So `rm -rf build`
  // (relative target) and `rm -r -f /tmp/x` (split flags) both walked through.
  // Two lookaheads demand a recursive flag AND a force flag anywhere in the
  // option tokens (`-rf`, `-r -f` and `--recursive --force` all count), then the
  // body requires at least one target token that is not an option — any target
  // shape qualifies, including `/`, `*` and `~`. `rm -rf` with no target at all
  // stays unmatched.
  {
    pattern: /\brm\b(?=(?:\s+-\S+)*\s+(?:-[a-z]*r[a-z]*|--recursive)\b)(?=(?:\s+-\S+)*\s+(?:-[a-z]*f[a-z]*|--force)\b)(?:\s+-\S+)*\s+(?!-)\S+/i,
    label: 'rm recursive+force (any target)',
    category: 'filesystem',
  },
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
  // Owner decision 2026-09-11 ④. Kept byte-identical to the `git-branch-delete`
  // rule in lib/autopilot/safety.js — the two layers judge the same shapes, and
  // a drift between them is exactly what this decision was cleaning up.
  // Case handling is deliberate and uneven: `git` case-insensitive (a shell
  // resolves `GIT branch`), `branch` lowercase (git rejects `git BRANCH` —
  // "is not a git command", measured 2026-09-11), `-D` case-sensitive (that
  // single letter is the whole point). The /i flag this rule used to carry
  // collapsed the last distinction and blocked the safe `git branch -d topic`
  // at PreToolUse (measured 2026-09-11). The old shape also required `-D` to
  // sit immediately after `branch`, so `-q -D`, `-Dv`, `--delete --force` and
  // `-fd` all walked through. Three force-delete shapes now match:
  //   1. a short-flag bundle containing uppercase D  (-D, -qD, -Dv, -Df)
  //   2. a delete flag AND a force flag anywhere     (-fd, -df, -f -d)
  //   3. --delete together with --force
  // "anywhere" includes after the branch name (`git branch -d topic -f`, which
  // git really does honour). A backslash line continuation (`\` + LF or CRLF)
  // keeps the run open — it is one command.
  // THE NEWLINE BOUND IN THIS PATTERN DOES NOT REACH L1 BEHAVIOUR. The pattern
  // stops an option run at a bare newline, but checkDangerousCommand below also
  // tests a normalizeCommand variant, and normalizeCommand collapses every \s+
  // run to one space (guard-registry.js#normalizeCommand). So the newline is
  // already gone by the time this pattern runs on the second variant, and
  // `git branch -d old\necho -f done` is still blocked here while L2 grades it
  // safe (measured 2026-09-11 through executeChain). Do NOT "fix" that by
  // loosening this pattern — the normalization is shared by all 38 rules and
  // changing `/\s+/g` to `/[^\S\n]+/g` is a separate piece of work. The
  // divergence is pinned as an owner-decision row in
  // tests/core/guard-registry-safe-override-scope.test.js.
  // Tokens and separators cannot parse two ways — the option branch demands a
  // dash then \w, the argument branch forbids a leading dash, the continuation
  // branch starts with a backslash (never whitespace) — so the scan is linear
  // (120KB adversarial input < 1ms, measured).
  {
    pattern: /\b[gG][iI][tT](?:[^\S\n]|\\\r?\n)+branch\b(?:(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+-[a-zA-Z]*D[a-zA-Z]*(?![\w-]))|(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+(?:--delete|-[a-z]*d[a-z]*)(?![\w-]))(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+(?:--force|-[a-z]*f[a-z]*)(?![\w-])))/,
    label: 'git branch -D (force delete)',
    category: 'git',
  },
  // `clear` deletes every stash entry at once — strictly more destructive than
  // `drop`, which takes one. `pop` and `push` stay out: they restore or create.
  // Trailing \b keeps the rule from firing on a longer word that merely starts
  // with the subcommand (`git stash clearance` was blocked before it was added).
  { pattern: /git\s+stash\s+(drop|clear)\b/i, label: 'git stash drop/clear', category: 'git' },

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
