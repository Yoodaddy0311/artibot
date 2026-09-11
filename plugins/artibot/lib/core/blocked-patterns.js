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
  // The rule above only sees `if=` sitting immediately after `dd`, so
  // `dd of=/dev/sda` and `sudo dd bs=4M if=img of=/dev/sdb` walked through L1
  // while L2 (`dd-device-write`, lib/autopilot/safety.js) graded both danger
  // (measured 2026-09-11). This rule closes that direction. It stays BELOW the
  // `dd\s+if=` rule on purpose: callers take the first match, and
  // tests/hooks/pre-bash.test.js pins `dd if=/dev/zero of=/dev/sda` to the
  // 'dd raw disk write' label.
  // WINDOW BOUND (ReDoS). L2 writes this as `\bdd\b[^\n]*\sof=\/dev\/`. That
  // shape is quadratic: every `dd` start scans the rest of the line. Measured
  // 2026-09-11 (node v24.15.0, single regex, `'dd '.repeat(n)` non-matching):
  //   unbounded   40KB 456.6ms · 120KB 3808.1ms   ← blows the 50ms convention
  //   {0,512}     40KB  29.7ms · 120KB   72.0ms
  //   {0,192}     40KB   8.3ms · 120KB   25.7ms   ← chosen
  // WHAT THE BOUND GIVES UP: more than 192 characters between `dd` and the
  // ` of=` token (a very long image path, a pile of operands) evades THIS rule.
  // L2 is unbounded and still grades such a command danger, so the miss is a
  // PreToolUse gap, not a full-stack one. Do not raise the bound without
  // re-measuring 120KB — 256 already lands at 43.6ms.
  { pattern: /\bdd\b[^\n]{0,192}\sof=\/dev\//i, label: 'dd write to block device', category: 'disk' },
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
  // THE NEWLINE BOUND IN THIS PATTERN NOW REACHES L1 BEHAVIOUR. The pattern
  // stops an option run at a bare newline, and normalizeCommand
  // (guard-registry.js#normalizeCommand) preserves that newline: it joins a
  // backslash continuation (`\` + LF or CRLF) into one space, normalizes CRLF
  // to LF, and folds only intra-line whitespace. It used to collapse every \s+
  // run — including bare newlines — to one space, which made this pattern's
  // newline bound invisible on the normalized variant. So L1 and L2 now share
  // the newline boundary: `git branch -d old\necho -f done` is L1 approve /
  // L2 safe, pinned through executeChain in tests/core/guard-registry.test.js
  // and as a row in the parity matrix.
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

  // ── System shutdown / reboot / local DoS ────────────────────────────
  { pattern: /shutdown\s/i, label: 'system shutdown', category: 'system' },
  { pattern: /reboot\b/i, label: 'system reboot', category: 'system' },
  { pattern: /init\s+0\b/i, label: 'init 0 (halt)', category: 'system' },
  // This rule used to read `/:(){ :\|:& };:/i` and sit under 'Network abuse'.
  // Two defects, both latent from the start (measured 2026-09-11 through
  // executeChain, not a regression):
  //   1. `()` was an EMPTY CAPTURE GROUP, not a literal pair of parentheses.
  //      The string the regex actually demanded was `:{ :|:& };:` — a name
  //      the shell cannot run. The real fork bomb `:(){ :|:& };:` was
  //      APPROVED, and so were `: () { :|:& };:` and `:(){:|:&};:`.
  //   2. It exhausts local process slots; nothing about it is network abuse.
  //      Hence category 'system'. No consumer keys on the category value
  //      (verified 2026-09-11), and 'network' survives on the wget/curl rules.
  // The parentheses are now escaped and optional, so the paren-less shape the
  // old regex caught stays caught — this is a strict superset, no loosening.
  // Separators are `\s*` (newline included: a function body may span lines).
  // LINEARITY — the invariant is NOT "each `\s*` is followed by a literal".
  // The first draft of this rule read `:\s*(?:\(\s*\))?\s*\{` and was QUADRATIC
  // (review found it 2026-09-11): the optional group sits between two `\s*`, so
  // a run of N spaces could be split N ways between them before `\{` failed.
  // Measured on the old shape: `':' + ' '.repeat(40000) + 'x'` 1255ms, the same
  // with newlines 1077ms, 120KB spaces 17199ms — 3x the input, 13.7x the time.
  // The colon-dense inputs the tests used at the time never built a long
  // whitespace run, so they were green on a quadratic regex.
  // THE INVARIANT THAT ACTUALLY HOLDS HERE: no two `\s*` are separated only by
  // an optional group. The single leading `\s*` is shared by both branches and
  // every other `\s*` is followed by a distinct literal, so one whitespace run
  // is never divided between two quantifiers. Keep it that way when editing:
  // moving that `\s*` inside or outside the group is not cosmetic.
  // Measured after the fix (single regex): 40KB spaces 0.1ms, 40KB newlines
  // 0.1ms, 120KB spaces 0.5ms, 120KB newlines 0.4ms.
  {
    pattern: /:\s*(?:\(\s*\)\s*)?\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    label: 'fork bomb',
    category: 'system',
  },

  // ── Network abuse ───────────────────────────────────────────────────
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
