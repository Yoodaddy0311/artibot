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
 *   NO RULE CONSUMES THIS AS OF 2026-09-11: the two `git push` rules were its
 *   only users and they now exempt the checked force forms with a negative
 *   lookahead inside the pattern, which a second blind `--force` in the same
 *   line cannot bypass. The property and the loop that reads it
 *   (guard-registry.js#checkDangerousCommand) stay for the next rule that needs
 *   a genuine per-rule exemption; `tests/core/blocked-patterns.test.js` pins the
 *   zero-consumer state so this paragraph cannot rot silently.
 */

/**
 * All blocked command patterns, organized by category.
 * Frozen array - cannot be modified at runtime.
 * @type {ReadonlyArray<BlockedPattern>}
 */
const BLOCKED_PATTERNS = Object.freeze([
  // ── Filesystem destruction ──────────────────────────────────────────
  // WINDOW BOUND (ReDoS). Both rules used to end in `.*\/`. `.` never crosses a
  // newline, so `[^\n]{0,N}` preserves the meaning and only caps the width.
  // NOT BYTE-IDENTICAL, THOUGH: `.` also refuses lone `\r`, U+2028 and U+2029,
  // while `[^\n]` walks through all three. The direction is toward MORE
  // blocking, never less, and the verdict does not actually move — measured
  // 2026-09-11 22:3x over 11 cases comparing both shapes on the raw string AND
  // on normalizeCommand output (what executeChain really tests): 0 verdict
  // changes. The reason is that normalizeCommand folds a lone `\r` and both
  // separators to a space (`curl a\rb` -> `curl a b`), so the dot-based rule
  // already matched the normalized variant and already blocked. CRLF still
  // stops the run at the `\n` on both shapes.
  // Unbounded the shape is quadratic: every `rm` start rescans to the end of the
  // line hunting for a `/`.
  // 512 FOR THE rm PAIR (MAX_PATH 260 + margin, leader decision 2026-09-11); the
  // dd rule and both git push rules stay at 192, as do the two network pipe
  // rules below. The widths differ on purpose: a `rm` target is a PATH, and a
  // Windows path is allowed to run to MAX_PATH on its own, so a 192-wide window
  // would refuse to look at perfectly ordinary long paths. A `curl`-to-pipe
  // window measures options and a URL, which is a different distribution.
  // 512 was chosen over 192 because the narrower window turned
  // `rm --recursive <193+ chars>/x` — which the pre-bound rule DID block — into
  // an L1 approve, and the same command is `classifyRisk` safe (see below). That
  // is a regression in coverage, not merely a documented gap, so the window
  // moved instead.
  // Measured 2026-09-11, node v24.15.0, median of 3, reported as
  // `single regex / full PreToolUse path`, where the full path is
  // guard-registry.js#checkDangerousCommand via executeChain and so covers the
  // raw AND the normalizeCommand variant. Load differs per row and inflates the
  // absolute numbers, not the ratios: unbounded rows 21:0x KST / 56 concurrent
  // node.exe, `{0,192}` rows 21:13 / 64, `{0,512}` rows 21:33 / 73.
  //                 10,240B       20,480B        40,962B         122,880B
  //  -rf unbounded  10.7 / 25.2   45.6 / 105.9   179.4 / 377.6   1887.7 / 3731.9
  //  -rf {0,192}     1.0 /  3.8    1.9 /   5.1     4.3 /   8.7     12.9 /   22.7
  //  -rf {0,512}     2.1 /  4.2    3.0 /   8.4     7.4 /  15.3     29.1 /   55.1
  //  -fr unbounded   8.9 / 21.4   36.6 /  81.7   163.8 / 317.7   1408.1 / 3076.8
  //  -fr {0,192}     0.6 /  2.8    1.7 /   4.5     2.8 /   7.0      9.5 /   30.1
  //  -fr {0,512}     2.0 /  6.1    5.4 /   9.9    11.3 /  26.3     29.0 /   73.4
  // 512 costs roughly 2.4x over 192 and is still three orders of magnitude off
  // the unbounded row: the worst full-path cell is 73.4ms against a 5s
  // PreToolUse budget. It also stays inside the size-sweep gate — 122,880/20,480
  // on the single regex ran 4.76~8.99 over 10 repetitions against a gate of 18
  // (the gate's own noise envelope across seven rules is 3.15~8.44, and a
  // quadratic scores 34~41), measured 21:33.
  // WHAT THE BOUND GIVES UP: more than 512 characters between the recursive flag
  // and the first `/`. Most of that surface is caught elsewhere — measured
  // through executeChain 2026-09-11 21:33, `rm -rf <513 filler>/x`,
  // `rm -fr <513 filler>/x` and `rm --recursive --force <513 filler>/x` are all
  // STILL block, because the `rm recursive+force (any target)` rule below needs
  // no `/` at all and claims every shape carrying both a recursive and a force
  // flag (L2 grades those `caution`/rm-rf-path as well).
  // THE ONE RESIDUAL BLIND SPOT, AND IT IS FULL-STACK: a recursive delete with
  // NO force flag and a path longer than the window. `rm --recursive <513
  // filler>/x` matches no L1 rule and reaches approve, and L2 has no
  // recursive-only rule either (rm-rf-root needs a `/`-, `~`- or `$HOME`-leading
  // target; rm-rf-path needs a force flag — lib/autopilot/safety.js, ids
  // measured 2026-09-11 21:33), so it is `classifyRisk` safe too. Inside 512
  // characters the same command is L1 block, so this is a width gap, not a shape
  // gap, and 512 puts it past any real path. It is pinned in
  // tests/core/blocked-patterns.test.js under 'DOCUMENTED BLIND SPOT' — that pin
  // records the gap, it does not bless it. Closing it properly means giving L2 a
  // recursive-only rule (owner routed that to the safety.js stem), not widening
  // this window further on one layer alone.
  { pattern: /rm\s+(-\w*r\w*f|--recursive)[^\n]{0,512}\//i, label: 'rm -rf with path', category: 'filesystem' },
  { pattern: /rm\s+-\w*f\w*r[^\n]{0,512}\//i, label: 'rm -fr with path', category: 'filesystem' },
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
  //   {0,192}     40KB   8.3ms · 120KB   25.7ms   ← chosen FOR THIS RULE
  // READ THAT `← chosen` NARROWLY. It is a verdict about `dd`, not a repo-wide
  // ban on 512: with no coverage reason to prefer the wider window, the cheaper
  // one wins. The rm pair above deliberately runs `{0,512}` because there IS a
  // coverage reason (a `rm` target is a path and may legitimately reach
  // MAX_PATH; 192 turned `rm --recursive <193+>/x` from block into approve).
  // Its 512 rows are also cheaper than dd's were — 40,962B 7.4/11.3ms,
  // 122,880B 29.1/29.0ms single regex, measured 21:33. Widths are per-rule and
  // justified per-rule; do not harmonise them by grep.
  // WHAT THE BOUND GIVES UP: more than 192 characters between `dd` and the
  // ` of=` token (a very long image path, a pile of operands) evades THIS rule.
  // THIS IS NOW A FULL-STACK BLIND SPOT, NOT A PreToolUse GAP. The sentence
  // here used to read "L2 is unbounded and still grades such a command danger";
  // that stopped being true on 2026-09-11, when L2 bounded `dd-device-write`
  // (and `curl-external` / `wget-external`) to the same `[^\n]{0,192}` window —
  // see the dd-device-write comment in lib/autopilot/safety.js. Both layers now
  // share one window, so a command wide enough to evade this rule evades
  // `classifyRisk` too and nothing downstream re-checks it. Do not raise the
  // bound on one layer alone, and not without re-measuring 120KB — 256 already
  // lands at 43.6ms.
  { pattern: /\bdd\b[^\n]{0,192}\sof=\/dev\//i, label: 'dd write to block device', category: 'disk' },
  { pattern: />\s*\/dev\/sd/i, label: 'write to disk device', category: 'disk' },
  { pattern: /format\s+[a-z]:/i, label: 'format drive (Windows)', category: 'disk' },
  { pattern: /diskpart/i, label: 'diskpart (Windows disk management)', category: 'disk' },

  // ── Permission escalation ───────────────────────────────────────────
  { pattern: /chmod\s+-R\s+777/i, label: 'chmod 777 recursive', category: 'permission' },
  { pattern: /chown\s+-R\s+root/i, label: 'chown to root recursive', category: 'permission' },

  // ── Git destructive ─────────────────────────────────────────────────
  // `--force-with-lease` / `--force-if-includes` turn a blind force push into a
  // checked one, so they must not be blocked. The exemption lives INSIDE the
  // first pattern as a negative lookahead, not in a `safeOverrides` list.
  // Why it moved (measured through executeChain 2026-09-11): `safeOverrides` is
  // tested against the WHOLE command string (guard-registry.js
  // #checkDangerousCommand), so a single lease token anywhere in the line
  // exempted the rule even when a blind force was also present —
  // `git push --force-with-lease --force` and `git push -f --force-with-lease`
  // were L1 approve while L2 graded both danger. A lookahead cannot be bypassed
  // that way: it only exempts the `--force` occurrence it sits behind, so a
  // second, unqualified `--force` still matches.
  // The `-f` rule gained the same reach as L2: `git push origin main -f` puts
  // the flag after the refspec, which git honours and `git\s+push\s+-f` missed.
  // Both shapes are now isomorphic with lib/autopilot/safety.js
  // (`git-force-push`, `git-force-push-short`) apart from L1's lack of a
  // capture group.
  // THE OPTION RUN IS `[^\n;&|]` — it stops at a newline AND at the three shell
  // separators, the same convention the git-branch-delete rule uses with
  // `[^\s;&|]`. Owner decision 2026-09-11 17:4x KST, applied to both layers at
  // once. Written as `[^\n]` the run walked past a separator into the NEXT
  // command and read its flags as the push's own, so `git push origin main &&
  // rm -f x`, `git push origin main; ls -f` and `git push origin main | grep -f
  // pattern file` all blocked (measured 2026-09-11). The separator class ends
  // that class of false positive outright rather than accepting it.
  // THE `-f` TAIL IS `(?![\w-])`, not `(?=\s|$)`. A separator directly after
  // the flag is still a real blind force push, and the whitespace-or-end tail
  // missed it: `git push origin main -f; echo done` and `git push -f|cat` were
  // L1 approve / L2 safe until 2026-09-11 18:0x KST (found by the L2 side).
  // `-fu` stays approved and `-f-x` is NOW approved — a word character or a dash
  // after `f` means the token is not `-f`. (`-f-x` was L1 block before
  // 2026-09-11: the old `-f\b` saw a word boundary between `f` and `-`. git
  // rejects it as an unknown option, and L2 always graded it safe, so the two
  // layers converge rather than L1 losing protection.)
  // WINDOW BOUND (ReDoS). Unbounded, the run is quadratic: every `git push`
  // start rescans to the end of the line. Measured 2026-09-11 18:1x KST (node
  // v24.15.0, single regex, `'git push '.repeat` non-matching, 3 runs, all
  // shapes in ONE process so the rows are comparable):
  //          40,962B unbounded      40,962B final     9,216B unbounded  9,216B final
  //  --force 129.3/149.0/165.7 ms   5.1/6.1/5.2 ms    10.6/10.3/9.7 ms  1.3/1.0/1.1 ms
  //  -f      165.6/184.8/234.6 ms   5.2/5.1/6.4 ms     9.0/ 8.8/10.8 ms 1.0/1.0/1.1 ms
  // 192 is the window the dd rule above already uses, and L2 bounded its
  // git-force-push / -lease / -short rules to the same width on 2026-09-11, so
  // the two layers share one number.
  // WHAT THE BOUND GIVES UP — A FULL-STACK BLIND SPOT, NOT A PreToolUse GAP.
  // More than 192 characters between `git push` and the force token (a pile of
  // refspecs, a long remote URL spelled out in full) evades THESE rules, and
  // since L2 now carries the same window it evades `classifyRisk` too. Nothing
  // downstream re-checks it. Measured 2026-09-11 with filler between the two
  // tokens: 192 chars -> L1 block / L2 danger; 197 chars -> L1 APPROVE and L2
  // SAFE. Do not raise the bound on one layer alone.
  // THE BLIND SPOT THE SEPARATOR CLASS CREATES (do not read a green suite as
  // precision). The class cannot tell a separator that SPLITS commands from one
  // sitting inside a quoted argument, and it stops at both. So
  // `git push "a;b" --force` is L1 APPROVE and L2 SAFE (measured 2026-09-11):
  // the raw variant stops the run at the `;`, and normalizeCommand strips the
  // quotes before the second pass, so the normalized variant stops there too.
  // Both layers carry the class, so this is full-stack. Closing it needs real
  // quote-aware tokenization on both layers, not a wider class.
  {
    pattern: /\bgit\s+push\b[^\n;&|]{0,192}--force(?!-with-lease|-if-includes)\b/i,
    label: 'git push --force',
    category: 'git',
  },
  {
    pattern: /\bgit\s+push\b[^\n;&|]{0,192}\s-f(?![\w-])/i,
    label: 'git push -f',
    category: 'git',
  },
  { pattern: /git\s+reset\s+--hard/i, label: 'git reset --hard', category: 'git' },
  { pattern: /git\s+clean\s+-\w*f/i, label: 'git clean -f', category: 'git' },
  // These two used to end in `\.\s*$`. The anchor meant anything after the dot
  // let the command through: `git checkout -- .` (the separator form git's own
  // documentation recommends), `git checkout . && echo hi`, `git checkout . ;
  // git status` and `git checkout . foo` were all L1 approve while L2
  // (`git-checkout-discard` / `git-restore-discard`, lib/autopilot/safety.js)
  // graded every one of them danger — measured through executeChain on
  // 2026-09-11. The shapes below are byte-identical to L2 apart from L2's
  // leading `\b`. The `(?=\s|$)` lookahead is what keeps the scoped pathspecs
  // out: `git checkout -- ./` and `git checkout -- .gitignore` still pass,
  // because a `/` or a word character after the dot is not the whole tree.
  // NOTE the reach this buys: the rule is no longer confined to the last line,
  // so `git checkout .` followed by a newline and another command now blocks
  // (it did not before). That is the L2 verdict, and the pin moved with it in
  // tests/core/guard-registry.test.js.
  // AND THE OVER-BLOCK THAT COMES WITH IT: dropping the anchor also lets the
  // rule fire on PROSE that merely quotes the command —
  // `echo "git checkout . is dangerous"` is newly L1 block (approve before,
  // measured 2026-09-11; normalizeCommand strips the quotes first, so the
  // quoting does not protect it). This is the same failure mode as the
  // `grep -i "truncate"` block that owner decision ② cleaned up, and L2 has
  // carried it since its own rule landed. Fixing it means requiring a command
  // position on BOTH layers, not loosening this one.
  { pattern: /git\s+checkout\s+(?:--\s+)?\.(?=\s|$)/i, label: 'git checkout . (discard all changes)', category: 'git' },
  { pattern: /git\s+restore\s+(?:--\s+)?\.(?=\s|$)/i, label: 'git restore . (discard all changes)', category: 'git' },
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
  // WINDOW BOUND (ReDoS). Both rules used to read `\s+.*\|`, which is quadratic
  // for the same reason the rm and dd rules were: every `curl` / `wget` start
  // rescans to the end of the line looking for a pipe.
  // ON `.` vs `[^\n]` — see the same note over the rm pair. `[^\n]` crosses a
  // lone `\r` and U+2028/2029 where `.` would not, which can only ADD matches,
  // and the executeChain verdict is unchanged (11 cases, 0 changes, measured
  // 2026-09-11 22:3x): normalizeCommand folds those three to a space before the
  // second pass, so the dot-based rule already blocked them. Measured 2026-09-11
  // 21:0x (before) and 21:13 KST (after), node v24.15.0, 56 then 64 concurrent
  // node.exe — that load inflates the absolute values, not the ratios. Median
  // of 3, `single regex / full PreToolUse path` (executeChain = raw +
  // normalizeCommand variants):
  //                10,240B       20,480B        40,962B         122,880B
  //  curl before   13.5 / 29.5   64.7 / 117.0   262.1 / 468.7   2377.0 / 5122.6
  //  curl after     1.1 /  3.8    2.4 /   5.7     4.7 /  12.0     19.4 /   33.0
  //  wget before   19.0 / 42.7   80.8 / 147.9   315.7 / 647.0   2815.1 / 5512.2
  //  wget after     1.3 /  3.6    2.5 /   5.3     5.7 /  12.5     12.2 /   25.1
  // The before row at 122,880B is past the 5s PreToolUse budget on its own.
  // WHY `[^\n]{0,192}` AND NOT `[^\n|]{0,192}`. The narrower class cannot cross
  // a pipe, so it only ever reaches the FIRST `|` after the URL and loses every
  // multi-stage download chain: `curl x | grep y | sh`, `curl x | tar -xz |
  // bash` and `wget x | tee f | bash` all flipped block -> approve (11-command
  // corpus, 3 rows differ, measured 2026-09-11 21:0x). It is not even the
  // faster of the two on the filler input that motivated the bound (122,880B
  // single regex: 18.2ms for `[^\n]` vs 23.4ms for `[^\n|]`); it wins only on a
  // pipe-dense input (40,962B of `curl x | `: 0.2ms vs 4.3ms), and 4.3ms is
  // already far inside budget. Three real positives is the wrong price for 4ms.
  // THESE TWO STAY AT 192 WHILE THE rm PAIR MOVED TO 512 (leader decision
  // 2026-09-11). The widths are not meant to match: the rm window measures a
  // filesystem PATH, which legitimately runs to MAX_PATH, while this one
  // measures options and a URL. Widening here would also widen the co-blind
  // region shared with L2's `curl-external` / `wget-external`, which the rm
  // change does not touch. Do not "harmonise" the two numbers without measuring.
  // WHAT THE BOUND GIVES UP: more than 192 characters between `curl`/`wget` and
  // the `|`. Measured through executeChain 2026-09-11 21:2x — 192 filler chars
  // is L1 block, 193 is L1 APPROVE. Pinned in
  // tests/core/blocked-patterns.test.js under 'DOCUMENTED BLIND SPOT'; that pin
  // records the gap, it does not approve it.
  // HOW FAR L2 CATCHES THE FALLOUT — PARTIALLY, AND ONLY AT `caution`.
  // `curl-external` / `wget-external` (lib/autopilot/safety.js, measured
  // 2026-09-11 21:2x) carry the same `[^\n]{0,192}` width but anchor on the
  // URL, not the pipe, so they are not co-blind by construction:
  //   `curl <193 filler>|sh`                -> L1 approve, L2 SAFE  (co-blind)
  //   `curl https://x/i <193 filler> | sh`  -> L1 approve, L2 caution
  // A realistic install line puts the URL right after `curl`, so L2 usually
  // still raises caution — but caution is not danger, and nothing downstream
  // re-checks the pipe target. Do not raise the bound on one layer alone.
  { pattern: /wget\s+[^\n]{0,192}\|\s*(sh|bash|zsh|python[23]?|perl|ruby|node)/i, label: 'wget pipe to interpreter', category: 'network' },
  { pattern: /curl\s+[^\n]{0,192}\|\s*(sh|bash|zsh|python[23]?|perl|ruby|node)/i, label: 'curl pipe to interpreter', category: 'network' },

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
