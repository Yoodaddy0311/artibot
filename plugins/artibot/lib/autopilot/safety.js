/**
 * Autopilot safety guard.
 * Classifies tool calls by risk and decides when the engine should pause.
 *
 * Reference: PRD docs/PRD/autopilot-mode.md sections 5.5 and 13.3.
 *
 * @module lib/autopilot/safety
 */

import { blankPrinterSegments } from '../core/command-segments.js';

/**
 * Pattern catalogue used by classifyRisk. Each entry has:
 *  - id: unique identifier
 *  - level: 'caution' | 'danger'
 *  - test: RegExp to match against the command/text payload
 *  - reason: human readable reason
 *
 * lib/core/blocked-patterns.js (L1, PreToolUse) is the canonical block list;
 * this catalogue only grades severity on top of it and never widens what runs.
 * That still holds after 2026-09-14, when both layers gained the SAME printer-
 * segment preprocessing (lib/core/command-segments.js): it narrows what either
 * layer READS, identically on both, so the two cannot drift apart through it.
 * The rules below are matched against that preprocessed text — except the four
 * `secret-*` rules, which classifyRisk deliberately keeps on the raw text.
 */
export const DANGEROUS_PATTERNS = Object.freeze([
  // Owner decision 2026-09-11 ①: the lease/if-includes forms are a CHECKED
  // force push — L1 (blocked-patterns.js: the negative lookahead inside the
  // `git push --force` rule; it used to be a `safeOverrides` list until
  // 2026-09-11) lets them through on purpose. Grading them 'danger' here made the
  // two layers say opposite things about the same command, so the checked form
  // drops to 'caution' while a blind `--force` / `-f` stays 'danger'.
  // The negative lookahead is what splits them: `--force` followed by
  // `-with-lease` or `-if-includes` is not a blind force.
  // These three carry the same 192-character window bound as dd-device-write
  // below, for the same ReDoS reason and with the same blind spot — see that
  // comment. Here the token is the force flag, so a force flag more than 192
  // characters into the command is not graded.
  // The run also stops at a shell separator (; & |), like git-branch-delete
  // below: with a plain `[^\n]` the `-f` of a LATER command on the same line was
  // absorbed into the push's run, so `git push origin main && rm -f x`,
  // `git push origin main; ls -f` and `git push origin main | grep -f p f` were
  // all graded danger via git-force-push-short (3 false positives, measured
  // 2026-09-11). That flag belongs to the second command, not to the push.
  // git-force-push-short ends the `-f` token with `(?![\w-])` — the convention
  // git-branch-delete and the rm rules already use — so `;`, `&` and `|` count
  // as the end of the token too (2026-09-11) — and not only those three: any
  // character other than a word character or a hyphen ends it (`.`, `=`, `"`,
  // `)` included; 4 such rows moved safe -> danger, all fail-closed, measured
  // 2026-09-11). The old tail demanded whitespace
  // or end-of-string, which silently let a real blind force push through
  // whenever another command followed it: `git push origin main -f; echo done`
  // and `git push -f|cat` were graded safe (measured 2026-09-11).
  // `-fu` and `-f-x` stay safe — a longer bundle is a different flag.
  { id: 'git-force-push', level: 'danger', test: /\bgit\s+push\b[^\n;&|]{0,192}--force(?!-with-lease|-if-includes)\b/i, reason: 'Destructive git push --force' },
  { id: 'git-force-push-lease', level: 'caution', test: /\bgit\s+push\b[^\n;&|]{0,192}--force-(?:with-lease|if-includes)\b/i, reason: 'Checked force push (--force-with-lease/--force-if-includes) — allowed at PreToolUse, still rewrites remote history' },
  { id: 'git-force-push-short', level: 'danger', test: /\bgit\s+push\b[^\n;&|]{0,192}\s-f(?![\w-])/i, reason: 'Destructive git push -f' },
  // Owner decision 2026-09-11 ④: CASE HANDLING IS DELIBERATE AND UNEVEN.
  // `git` is matched case-insensitively ([gG][iI][tT]) because a shell resolves
  // `GIT branch` fine; `branch` stays lowercase because git itself rejects
  // `git BRANCH` ("is not a git command", measured 2026-09-11); `-D` stays
  // case-sensitive because that single letter is the whole point — `-D`
  // force-deletes an unmerged branch and `-d` refuses to. The /i flag this rule
  // used to carry collapsed the last distinction and made the safe everyday
  // `git branch -d topic` register as danger.
  // Three shapes count as a force delete:
  //   1. a short-flag bundle containing uppercase D  (-D, -qD, -Dv, -Df)
  //   2. a delete flag AND a force flag anywhere     (-fd, -df, -f -d)
  //   3. --delete together with --force
  // "anywhere" is literal: the option run also steps over non-option arguments,
  // so a flag AFTER the branch name counts (`git branch -d topic -f`, which git
  // really does honour). The run ends at a shell separator (; & |) and at a
  // NEWLINE, but a BACKSLASH line continuation (`\` + LF, or `\` + CRLF) is
  // whitespace inside one command, so it keeps the run open.
  // Without the newline bound a `-f` on a later line of a multi-line script
  // satisfied the force lookahead and `git branch -d old\nrm -rf build` was
  // graded danger (measured 2026-09-11, 2 false positives). Since 2026-09-11
  // guard-registry.js#normalizeCommand preserves bare newlines — it joins
  // backslash continuations, normalizes CRLF to LF and folds only intra-line
  // whitespace — so L1 and L2 share this boundary; see the git-branch-delete
  // comment in lib/core/blocked-patterns.js and the parity matrix row.
  // Run tokens stay unambiguous: the option branch demands a dash then \w, the
  // argument branch forbids a leading dash, the continuation branch starts with
  // a backslash, and each flag token's first run excludes its mandatory letter
  // (D / d / f, 2026-09-23 swap), so one long flag run is linear. A line of
  // repeated `git branch ` starts is STILL quadratic (open residual) — numbers
  // in the git-branch-delete comment of lib/core/blocked-patterns.js.
  {
    id: 'git-branch-delete',
    level: 'danger',
    test: /\b[gG][iI][tT](?:[^\S\n]|\\\r?\n)+branch\b(?:(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+-[a-zA-CE-Z]*D[a-zA-Z]*(?![\w-]))|(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+(?:--delete|-[a-ce-z]*d[a-z]*)(?![\w-]))(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+(?:--force|-[a-eg-z]*f[a-z]*)(?![\w-])))/,
    reason: 'Force-delete git branch (-D / --delete --force)',
  },
  { id: 'git-reset-hard', level: 'danger', test: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard discards work' },
  { id: 'git-clean-force', level: 'danger', test: /\bgit\s+clean\s+-[a-z]*f/i, reason: 'git clean -f deletes untracked files' },
  { id: 'git-checkout-discard', level: 'danger', test: /\bgit\s+checkout\s+(?:--\s+)?\.(?=\s|$)/i, reason: 'git checkout . discards all uncommitted changes' },
  { id: 'git-restore-discard', level: 'danger', test: /\bgit\s+restore\s+(?:--\s+)?\.(?=\s|$)/i, reason: 'git restore . discards all uncommitted changes' },
  { id: 'git-stash-drop', level: 'danger', test: /\bgit\s+stash\s+(?:drop|clear)\b/i, reason: 'git stash drop/clear deletes stash entries' },
  // A recursive flag anywhere in the option run is enough here (force stays
  // optional, preserving the older `rm -r /` verdict); the target decides.
  // The option token must stay `--?\w[\w-]*` — a shape that lets `--opt` split
  // two ways (e.g. `-{1,2}[\w-]+`) backtracks 2^n on a non-matching tail, and
  // the 5s PreToolUse hook would drop the verdict instead of failing loudly.
  // TARGET TERMINATORS (2026-09-14). The root branch used to be
  // `\/(?:\s|$|\*|\w)` — a `/` had to be followed by whitespace, end-of-input,
  // `*` or a word character. That rejected every OTHER way a shell can end the
  // token, so `rm -rf /"`, `/)`, `/;`, `/&`, `/|`, `/>x`, `//`, `/.` and `/..`
  // all graded SAFE. The `~` and `$HOME` branches carried the same shape and
  // the same holes. The cost was not cosmetic: `sh -c "rm -rf /"`,
  // `eval "rm -rf /"`, `` `rm -rf /` ``, `(rm -rf /)` and `{ rm -rf /; }` are
  // EXECUTING forms, not mentions, and all five were safe (measured rule-alone
  // 2026-09-14: 9 of 10 wrapper forms missed; heredoc was the only hit because
  // a newline happens to be in the old terminator set).
  // Three edits, nothing else:
  //   (a) root branch -> bare `\/`. A word starting with `/` is always an
  //       absolute path, so the terminator group was never load-bearing there;
  //       the old `\w` alternative already admitted `/tmp`.
  //   (b) `~` and `$HOME` keep a terminator, widened to shell separators:
  //       `(?:\s|$|\/|[;&|()<>"'`])`. They cannot drop it — `~user` and
  //       `$HOMEDIR` are different targets, unlike `/x` which is still root-relative.
  //   (c) an optional `["']?` before the target, so a quoted target is graded
  //       at the same level as the bare one. `rm -rf "/"` used to fall through
  //       to rm-rf-path (caution) while L1 normalizes the quotes away and
  //       blocks — L2 was the only layer reading it as merely scoped.
  // ACCEPTED OVER-MATCH: any quoted tilde-prefixed target — `rm -rf "~"`,
  // `rm -rf '~'`, `rm -rf "~/x"` — is graded danger. Inside quotes a tilde is
  // NOT expanded, so those commands touch a literal `./~` path, not $HOME.
  // The failure is toward blocking and the form is vanishingly rare; the real
  // frequency is unmeasured (no transcript census).
  //
  // 2026-09-21 (guard-l2-residual). The two shapes the 2026-09-14 note left
  // "out of scope" — `${HOME}` and `~user` — are now graded. The owner reopened
  // them; that note recorded the scope of THAT wave, not a prohibition.
  //   (d) `\$HOME` -> `\$(?:HOME|\{HOME\})`. Same target, two spellings, and
  //       they used to grade differently: the plain form was danger while every
  //       brace form fell through to rm-rf-path at CAUTION (17 of 17 forms
  //       measured 2026-09-21). The TERMINATOR SET IS REUSED UNCHANGED, which
  //       is what keeps `${HOME}x` and `${HOME}_old` off this rule — those are
  //       SIBLINGS of home (`/home/userx`), exactly as `$HOMEDIR` is.
  //   (e) the `~` branch gains an optional bounded USER NAME before the same
  //       terminator group. `~user` is a home directory, so it belongs to this
  //       rule and not to the path rules — and it could reach neither, because
  //       rm-rf-path and rm-recursive-path both excluded tilde-leading targets
  //       as "rm-rf-root's job" while this branch demanded a terminator
  //       immediately after the tilde. The shape fell between all three rules:
  //       22 of 22 forms were L2 SAFE (measured 2026-09-21).
  //       With a force flag L1 blocks them, so that was a direction-rule
  //       violation; the FORCELESS recursive forms (`rm -r ~user`,
  //       `rm --recursive ~user`, `rm -R ~user`) matched no L1 rule either and
  //       were a FULL-STACK miss.
  //
  // 2026-09-22 (guard-rm-flag-redos), TWO EDITS, AND THEY ARE A PAIR.
  //   (f) THE PATH RULES NO LONGER EXCLUDE TILDE AND `$HOME` TARGETS. Their
  //       shared negative lookahead was `(?![-/~*]|\$HOME\b)` and is now
  //       `(?![-/*])`. The `~` / `$HOME` half of that exclusion assumed this
  //       rule claimed every such target, and it never did: the DIFFERENCE SET
  //       reached no rule on either layer. Measured 2026-09-21/22 (node
  //       v24.15.0): `~user*`, `~*`, `~$USER`, `~.foo`, `~+1`, `~-1` were L1
  //       block / L2 SAFE, and `rm -r ~$USER` plus `rm -r $HOME*` were L1
  //       approve / L2 safe — a FULL-STACK miss, base included. `$HOME*`,
  //       `$HOME.bak` and `$HOME-old` were L1 block / L2 safe for the same
  //       reason. They are all SIBLINGS or GLOBS of home rather than home
  //       itself, so `caution` (not `danger`) is the honest level, and that is
  //       exactly what the two path rules give them now. Existing `danger`
  //       verdicts cannot move: classifyRisk returns on the first danger and
  //       both path rules are `caution`, so this edit can only raise a `safe`.
  //   (g) `[+-]` AND DIGIT-LEADING NAMES LEAVE THIS RULE. `~+` / `~-` / `~1`
  //       (PWD, OLDPWD, dirstack) are not home; they are the CURRENT or a
  //       stacked directory, the same kind of target as `.` / `./` / `$PWD`,
  //       which this catalogue has always graded `caution`. 28e37002 briefly
  //       graded them `danger` as a side effect of (e)'s `\w`-leading name
  //       class. Against THAT commit these three read as a deliberate
  //       danger -> caution DOWNGRADE; against b7924207 — the pre-limb
  //       baseline, since 256ef6b0 is the merge that folded guard-l2-residual
  //       and had already graded them danger — they are still a rise from
  //       safe. With (f) in the same commit they land on
  //       rm-rf-path / rm-recursive-path, so nothing returns to safe.
  //       DELIBERATE RESIDUAL: a digit-leading user name (`~1abc`) is now
  //       caution rather than danger — the name class starts at a letter or
  //       `_` to keep the dirstack forms out. Real-world frequency unmeasured.
  // NO NEW RULE OBJECT, still true after (f)/(g): the catalogue is 27 rules and
  // the static scanner's denominator (95) is untouched. Both branches of THIS
  // rule are graded 'danger', so the id list in lib/security/human-gates.js
  // (HG-09 `existingCoverage`, which names ids and holds no copy of this regex)
  // stays true as written.
  // ACCEPTED OVER-MATCH (e): a literal relative path whose name starts with a
  // tilde — `rm -rf ~backup` when no such user exists, so the shell leaves it
  // unexpanded — is graded danger. Same direction and same kind as the quoted
  // tilde above; frequency unmeasured.
  // DELIBERATE RESIDUAL: `${HOME:-/tmp}`, `${HOME:?}`, `${HOME-x}` stay
  // CAUTION, not danger. The plain branch does not grade `$HOME:-/tmp` either —
  // `:` is not in the terminator set — and reusing that set unchanged is what
  // makes (d) safe to make. Closing them means parsing the `${…}` body, which
  // costs a new quantifier to separate neighbours like `${HOMEBREW_PREFIX:-x}`.
  // L1 blocks the force forms, so this is under-grading, not a full-stack hole.
  // Linear, unchanged: the option run is untouched and (d) adds no quantifier.
  // (e) adds exactly ONE — `[\w.-]*` — and it is followed by a class DISJOINT
  // from it (whitespace, `/`, and the seven shell separators share no character
  // with word chars, `.` or `-`), so no input can split two ways and there are
  // no adjacent quantifiers over overlapping classes. (g) only NARROWS that
  // run's first character from `\w` to `[A-Za-z_]` and drops the `[+-]`
  // alternative, so it removes alternatives rather than adding any. (f) edits a
  // negative lookahead of fixed width. None of the three adds a quantifier.
  // THE FLAG LOOKAHEAD WAS QUADRATIC UNTIL 2026-09-22 (guard-rm-flag-redos).
  // It read `-[a-z]*[r][a-z]*`: a pair of star runs over ONE class around a
  // mandatory letter, so a payload made only of that letter splits n ways and
  // every split is retried. Measured twice (node v24.15.0, payload
  // `rm -` + 'r' x n + `_`, rule-alone median of 3, n = 2,500 / 5,000 /
  // 10,000):
  //   2026-09-21   6.5 /  25.7 / 118.3 ms   (and 930.7 ms at n = 20,000)
  //   2026-09-22   8.8 /  34.6 / 151.1 ms   whole classifyRisk 36.8 / 129.7 /
  //                                          657.8 ms
  // NEITHER EXISTING GATE SAW IT. The static scanner collects negated classes
  // and `.` only, so a POSITIVE class run is outside it by construction, and no
  // scaled payload built a run of the flag letter — dense repeating input
  // matches at the first position and never enters the run.
  // THE FIX IS A LANGUAGE-PRESERVING TOKEN SWAP, not a narrower language:
  // `-[a-z]*[r][a-z]*` -> `-[a-qs-z]*r[a-z]*`, and the force twin
  // `-[a-z]*[f][a-z]*` -> `-[a-eg-z]*f[a-z]*`. Forbidding the letter in the
  // FIRST run only forces the mandatory letter to bind to its leftmost
  // occurrence, which every match already had; the set of accepted strings is
  // unchanged. Under /i the class folds, so `[a-qs-z]` excludes `R` as well as
  // `r` while the mandatory `r` still matches both — uppercase handling is
  // preserved, not narrowed. Same token in rm-rf-broad, rm-rf-path,
  // rm-recursive-path and the L1 rules in lib/core/blocked-patterns.js.
  // After (same machine, same payloads): rule-alone 0.02 / 0.04 / 0.08 ms,
  // and 122,880B returns in 0.50 ms. Evidence that the language did not move:
  // 2,396,736 differential cases with 0 mismatches (flag tokens over
  // {r,f,x,R,F,9,_,-} at every length 0..5, 8 command templates, 8 rule pairs),
  // pinned in tests/autopilot/safety.test.js against a FROZEN copy of the old
  // fragment, plus a 20,920-string corpus whose level and matchedId are
  // byte-identical before and after (961,266 bytes each, 0 differing rows).
  // That 20,920 is the LANGUAGE corpus of this edit. Do not confuse it with
  // the 1,967-string corpus quoted for the 2026-09-22 tilde/$HOME edit above,
  // which measured LEVEL CHANGES and is a different harvest.
  // 122,880B TABLE — RE-MEASURED 2026-09-22 (guard-rm-flag-redos), node
  // v24.15.0, Windows, median of 3, on the CURRENT shape of every branch. It
  // replaces the 2026-09-14 table, which carried a "not re-measured" warning
  // after the 2026-09-21 tilde and home-variable edits.
  //   payload                    rm-rf-root alone   whole classifyRisk  level
  //   option run                       0.17 ms            4.75 ms       safe
  //   space run                        0.04               1.58          safe
  //   quote-root fill                  0.00               3.82          danger
  //   tilde-paren fill                 0.00               2.28          danger
  //   tilde-name run                   0.53               3.10          caution
  //   tilde-dot run                    0.23               1.11          caution
  //   brace-home near-miss             0.35               2.54          caution
  //   rm flag run (r)                  0.45               3.33          safe
  //   rm force run (reachable)         0.45               2.61          safe
  //   rm flag run (matching)           0.19               1.08          danger
  // The last three rows are new: they are the FLAG-token sweep this rule went
  // without until 2026-09-22. Dense repeating input matches at the first
  // position and never enters a run, so every branch with a quantifier needs a
  // LONG SINGLE RUN of its own — that is why `tilde-name run`, `tilde-dot run`
  // and now the flag rows exist in tests/autopilot/safety.test.js alongside the
  // 6x growth ratio and the 10K/20K/40K/120K structural sweep.
  // `rm force run` leads with `-r` on purpose: a payload of bare 'f' never
  // reaches the force lookahead, because the recursive one is evaluated first
  // and fails. Measured 2026-09-22 — an all-'f' run was 0.8 ms at 40,962B even
  // on the quadratic shape, a green that proves nothing.
  // The next change to any branch must re-measure these rows and date them.
  {
    id: 'rm-rf-root',
    level: 'danger',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-qs-z]*r[a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+["']?(?:\/|~(?:[A-Za-z_][\w.-]*)?(?:\s|$|\/|[;&|()<>"'`])|\$(?:HOME|\{HOME\})(?:\s|$|\/|[;&|()<>"'`]))/i,
    reason: 'rm -rf on root or home',
  },
  {
    id: 'rm-rf-broad',
    level: 'danger',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-qs-z]*r[a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+\*/i,
    reason: 'rm -rf with broad glob',
  },
  // Keep after rm-rf-root/rm-rf-broad: those two own the root and glob targets
  // and the home targets they actually claim.
  // Two lookaheads demand a recursive flag AND a force flag anywhere in the
  // option run, so combined (-rfv), split (-r -f) and long (--recursive) forms
  // all land here; the final guard skips option tokens, root-leading targets
  // and globs.
  // THE FINAL GUARD NO LONGER SKIPS TILDE OR `$HOME` (2026-09-22,
  // guard-rm-flag-redos). It was `(?![-/~*]|\$HOME\b)`. Both halves of that
  // deferral were written as "rm-rf-root's job", and rm-rf-root takes only part
  // of the set — see branch (f) in its comment above for the measured
  // difference set and why `caution` is the right level for it. Whatever
  // rm-rf-root DOES claim is `danger` and returns before this rule is reached,
  // so removing the deferral cannot lower a single existing verdict; it can
  // only raise a `safe`. Both path rules take the byte-identical edit — a pin
  // in tests/autopilot/safety.test.js compares the two `.source` strings with
  // the force lookahead removed, so a one-sided edit fails the suite.
  {
    id: 'rm-rf-path',
    level: 'caution',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-qs-z]*r[a-z]*)(?![\w-]))(?=(?:\s+--?\w[\w-]*)*\s+(?:--force|-[a-eg-z]*f[a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+(?![-/*])\S+/i,
    reason: 'recursive delete of a scoped path (blocked at PreToolUse by blocked-patterns)',
  },
  // Keep AFTER rm-rf-path. classifyRisk returns the FIRST caution it meets, so
  // catalogue order — not rule precision — decides which id a command reports.
  // Put this rule earlier and `rm -rf ./build` would start reporting
  // 'rm-recursive-path' instead of 'rm-rf-path', silently rewriting pins in
  // tests/autopilot/safety.test.js and the PARITY matrix.
  //
  // WHAT THIS CLOSES (measured 2026-09-14 through executeChain + classifyRisk,
  // node v24.15.0): a recursive delete with NO force flag was a FULL-STACK
  // blind spot, not a PreToolUse gap.
  //   L1 `rm -rf with path` / `rm -fr with path` (blocked-patterns.js) need a
  //   force flag in the combined token, and `rm recursive+force (any target)`
  //   needs one too; only the `--recursive` long form reaches L1 at all, and
  //   then only when a `/` sits inside its `[^\n]{0,512}` window.
  //   L2 `rm-rf-root` needed a `/`-, `~`- or `$HOME`-leading target and
  //   `rm-rf-path` needs a force flag. (That leading set was never the whole
  //   tilde/home family — see branch (f) above, 2026-09-22.)
  // So before this rule: `rm -r ./build` L1 approve / L2 safe · `rm -R x`
  // approve/safe · `rm --recursive <513 filler>/x` approve/safe. Only
  // `rm --recursive a/b/c` (short path) was caught, and by L1 alone.
  // The width half of that gap is documented in blocked-patterns.js
  // ("THE ONE RESIDUAL BLIND SPOT") and pinned in
  // tests/core/blocked-patterns.test.js under 'DOCUMENTED BLIND SPOT'; the
  // owner routed the fix to this stem rather than widening the L1 window.
  //
  // LEVEL IS `caution`, NOT `danger`. Inside its window L1 already blocks the
  // shape, so the direction rule (L1 block => L2 at least caution) only asks
  // for caution; and a forceless recursive delete stops at the first
  // write-protected file, which is a real difference from `rm -rf`.
  //
  // SHAPE = rm-rf-path minus the force lookahead. It carries NO window, so it
  // is out of the static scanner's scope by construction and must NOT appear
  // in the boundary-pair set (`hasBoundedWindow` is what keeps those two
  // assertions honest). The tail `\S+` and the nested `(?:\s+--?\w[\w-]*)*`
  // are the scanner's blind spots #2 and #3 — the `rm option run` scaled
  // payload and the `--opt` x26/40 probe in safety.test.js cover that place
  // instead, and both run whole classifyRisk, so they pick this rule up for
  // free. The option token must stay `--?\w[\w-]*` for the same reason
  // rm-rf-root gives above: a shape that lets `--opt` split two ways
  // backtracks 2^n.
  {
    id: 'rm-recursive-path',
    level: 'caution',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-qs-z]*r[a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+(?![-/*])\S+/i,
    reason: 'recursive delete of a scoped path without a force flag (L1 blocks it inside its 512-char window; this closes the full-stack gap past it)',
  },
  // Owner decision 2026-09-11 ③: L1 (blocked-patterns.js `dd\s+if=`, category
  // 'disk') blocks every dd invocation, so an L2 verdict of 'safe' broke the
  // "L1 block => L2 at least caution" direction rule. Only the raw-device
  // target is graded here — a file-to-file `dd if=a.img of=b.img` is still L1
  // block / L2 safe, which is a known open divergence, not a decided one.
  // WINDOW BOUND (ReDoS) — applies to this rule, to curl-external /
  // wget-external below, and to the three git-push rules above, all of which
  // share the "<word> <anything> <token>" shape.
  // `[^\n]*` between the word and the token is quadratic: every occurrence of
  // the word rescans the rest of the line, so a line made only of the word
  // costs O(n^2). Measured here (node v24.15.0, 2026-09-11 06:36-06:47 UTC,
  // classifyRisk on `'<word> '` repeated to the byte count, non-matching;
  // 3 runs at 40,962B, 1 run at 122,880B):
  //   dd        unbounded 852.1 / 863.7 / 759.9 ms · 120KB 6,306.1 ms
  //   dd        {0,192}    15.4 /  14.2 /  14.4 ms · 120KB    35.4 ms  <- chosen
  //   curl      unbounded 461.7 / 500.5 / 444.3 ms
  //   curl      {0,192}     7.6 /   7.4 /   7.6 ms · 120KB    21.5 ms
  //   wget      unbounded 483.3 / 498.2 / 504.8 ms
  //   wget      {0,192}     7.9 /   7.5 /   8.4 ms · 120KB    23.5 ms
  //   git push  unbounded 600.3 / 630.3 / 645.8 ms · 120KB 5,236.0 ms
  //   git push  {0,192}    15.7 /  16.5 /  13.8 ms · 120KB    41.5 ms
  // (the `git push` rows are the cost of all three git-push rules together)
  // HOW LINEARITY IS GATED (convention, revised 2026-09-11). The convention was
  // a flat "< 50 ms" wall clock until 2026-09-11, chosen because
  // bash-risk-guard.js runs inside a 5s PreToolUse hook. That single number was
  // doing two incompatible jobs: tight enough to catch a quadratic regression,
  // loose enough never to flake. It failed at both — a `< 50` assertion landed
  // at 50.54 ms on a Windows runner, and 120KB already sat close enough to 50
  // that the margin was noise. The bound is now three layers, in order of
  // authority:
  //   (i)   THE CANONICAL GATE IS A STATIC SCAN OF THE REGEX SOURCE
  //         (tests/autopilot/safety.test.js, describe 'ReDoS 정적 스캔').
  //         It walks every rule in this catalogue AND in
  //         lib/core/blocked-patterns.js and fails on an unbounded run — a `.`
  //         or a negated class quantified past the ceiling ALLOWED FOR THAT
  //         RULE that can match whitespace. The default ceiling is 192 and the
  //         rm pair is registered at 512 (`WINDOW_CEILING_OVERRIDES`); a rule
  //         that is not registered fails the moment it goes past 192, so a NEW
  //         rule cannot ship a wide window unnoticed. An earlier draft used one
  //         global ceiling of 512 and was fail-open: widening `wget-external`
  //         to 512 left the scan GREEN and only the boundary pair caught it
  //         (measured 2026-09-11). The registration is a permission to exceed
  //         192, not a statement of exact width. Exact widths are pinned by
  //         boundary pairs, and a third assertion checks that every windowed
  //         rule HAS one, so the three do not overlap: scanner = permission to
  //         exceed 192, boundary pair = exact width, completeness assertion =
  //         no rule missing a pair. If any two disagree, that RED is correct;
  //         do not edit the list to match.
  //         COVERAGE WAS NOT SYMMETRIC BETWEEN THE LAYERS, AND NOW IS.
  //         Audited 2026-09-11: L1 had exact-width pins for 4 of its 7 windowed
  //         rules — `dd write to block device` and the two `git push` rules had
  //         none, so widening any of the three inside the ceiling would have
  //         gone unnoticed on both layers. Closed the same day: the BOUNDARY
  //         table in tests/core/blocked-patterns.test.js now carries 7 rows
  //         (match at the width, miss one past it) plus its own completeness
  //         assertion. Both layers now pin every windowed rule, and both have a
  //         completeness assertion, so neither can gain a rule with a window
  //         and no pin. The lesson survives the fix: a claim like "the boundary
  //         pairs catch it" is true only of the catalogue it was measured on —
  //         check the other layer before repeating it repo-wide.
  //         No wall clock, so no flake. Read the "못 보는 것" list next to that
  //         scanner before treating a green scan as proof of anything.
  //   (ii)  40,962B wall clock is a `< 200 ms` SMOKE bound only. It catches a
  //         blow-up, not a slow drift.
  //   (iii) ONE growth gate: t(122,880) < 18 x t(20,480), 3-run medians, 4 ms
  //         floor. Adjacent 2x spans were inside the noise band (40,962/20,480
  //         up to 3.39, 122,880/40,962 up to 3.85 measured 2026-09-11 over
  //         7 rules x 10 runs), which overlaps or crowds the 3.0 / 4.5
  //         thresholds an earlier draft used. The 6x span separates noise
  //         (<= 8.44) from the quadratic signal (34-41, against the 6^2 = 36
  //         a quadratic predicts), so 18 sits in the empty gap between them.
  //         Ratios are near-invariant to machine speed, which is why they, not
  //         the absolute numbers, carry the verdict.
  // 122,880B IS NOT ASSERTED as a wall clock. Its measurements live in the
  // tables in this comment instead, and they are 3-run figures: a single dd run
  // hit 56.2 ms once in 5 on 2026-09-11, which is exactly the kind of tail a
  // flat threshold turns into a flaky gate. Re-measure 120KB whenever the
  // window, the separator class, or a preprocessing step (guard-registry.js
  // #normalizeCommand) changes — the tables above go stale silently otherwise.
  // The same 192 window and the same reasoning are in
  // lib/core/blocked-patterns.js on L1's twin dd rule.
  // WHAT THE BOUND GIVES UP — do not read a green suite as coverage for these:
  // more than 192 characters between the command word and the token evades the
  // rule entirely. For dd/curl/wget the token is ` of=/dev/` or ` http(s)://`,
  // so a long operand list, a huge image path, a URL buried after a pile of
  // flags, or a `| sh` far down the line all sit in that blind spot. For the
  // git-push rules the token is the force flag, so many refspecs or a long
  // remote URL ahead of `--force` / `-f` / `--force-with-lease` hides it the
  // same way. All of these are graded safe. The failure direction is toward
  // under-grading, and nothing else catches it at L2, so raising the bound is
  // a real option — but re-measure 120KB before doing it.
  // The git-push rules give up one more thing, because their run also stops at
  // a shell separator: a separator inside a QUOTED argument ends the run just
  // as a real one does. `git push "a;b" --force` is graded safe (measured
  // 2026-09-11 — it was danger before the separator stop). L2 reads the raw
  // command text and does no shell parsing, so it cannot tell a quoted `;`
  // from an operator. Trading that for the three false positives the stop
  // removes was the 2026-09-11 leader decision; both directions are real.
  { id: 'dd-device-write', level: 'danger', test: /\bdd\b[^\n]{0,192}\sof=\/dev\//i, reason: 'dd writing to a raw block device' },
  // Byte-identical to the 'fork bomb' rule in lib/core/blocked-patterns.js;
  // tests/autopilot/safety.test.js pins `source` and `flags` equality, so a
  // one-sided edit fails the suite. Keep them identical — the only value this
  // copy has is that both layers judge the same shapes.
  // LINEARITY — the invariant is NOT "each `\s*` is followed by a literal". It
  // is: no two `\s*` are separated only by an optional group. The single
  // LEADING `\s*` is shared by both branches, so one whitespace run is never
  // divided between two quantifiers. Moving it inside or outside the group is
  // not cosmetic — the first draft (`:\s*(?:\(\s*\))?\s*\{`) was QUADRATIC:
  // 40KB of spaces 1,255ms, 120KB 17,199ms (L1 review, 2026-09-11). Inputs
  // dense in colons never build a long whitespace run and stay green on the
  // quadratic shape, so they prove nothing on their own.
  { id: 'fork-bomb', level: 'danger', test: /:\s*(?:\(\s*\)\s*)?\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'Shell fork bomb (exhausts the local process table)' },
  { id: 'sql-drop-table', level: 'danger', test: /\bDROP\s+TABLE\b/i, reason: 'SQL DROP TABLE' },
  { id: 'sql-drop-database', level: 'danger', test: /\bDROP\s+DATABASE\b/i, reason: 'SQL DROP DATABASE' },
  // Owner decision 2026-09-11 ②: `/\bTRUNCATE\b/i` fired on any mention of the
  // word, so `grep -n -i "truncate\|force-with-lease" file` was blocked at
  // PreToolUse (measured 2026-09-11). The word alone proves nothing; a SQL
  // statement does. Two accepted shapes:
  //   1. TRUNCATE {TABLE|ONLY|DATABASE} <identifier>
  //   2. TRUNCATE <identifier list> followed by a statement terminator or a
  //      TRUNCATE-only keyword (; CASCADE RESTRICT RESTART/CONTINUE IDENTITY)
  // Both alternatives need whitespace then an identifier CHARACTER, which is
  // what rejects `truncate -s 0 file.log` (coreutils), `"truncate\|force"`
  // (grep argument), `--grep=truncate` and `fs.truncateSync(p)`.
  // WHAT THIS RULE STILL MISSES (do not read a green suite as coverage):
  // a bare `psql -c "TRUNCATE users"` — no keyword, no terminator — is NOT
  // matched. Adding the closing quote as a terminator would re-admit prose
  // like `echo "truncate cache"`, so the miss is deliberate.
  // WHAT THIS RULE GETS WRONG: prose that happens to be one word plus a
  // semicolon — `echo "truncate cache;"` — is graded danger. Rare, and the
  // failure is toward blocking rather than allowing, so it is accepted.
  // Linear by construction: the identifier class, \s and ',' are disjoint and
  // the repeat group needs a literal comma per iteration.
  { id: 'sql-truncate', level: 'danger', test: /\bTRUNCATE\s+(?:(?:TABLE|ONLY|DATABASE)\s+[\w."`]+|[\w."`]+(?:\s*,\s*[\w."`]+)*\s*(?:;|\bCASCADE\b|\bRESTRICT\b|\b(?:RESTART|CONTINUE)\s+IDENTITY\b))/i, reason: 'SQL TRUNCATE' },
  // 2026-09-14. The old body class `[\w."` ]+` contained a SPACE, so on
  // `DELETE FROM t WHERE id=1` it swallowed `t WHERE id`, stopped at the `=`,
  // and the `(?!.*\bWHERE\b)` lookahead then found no further WHERE and
  // succeeded. Every single-line WHERE clause was graded danger — 8 of 8
  // measured forms, including `psql -c "DELETE FROM t WHERE id=1"`. Dropping
  // the space from the class is the whole fix for that half.
  // The lookahead body changed `.*` -> `[^;]{0,192}` (and the `s` flag went
  // with the `.`). Two things follow:
  //   STATEMENT BOUNDARY. `[^;]` cannot cross a `;`, so a WHERE belonging to a
  //   LATER statement no longer defuses this one: `DELETE FROM t; SELECT 1
  //   WHERE x` is danger, and so is `DELETE FROM t; echo "WHERE"` — the latter
  //   from the rule source ALONE, with no help from printer-segment blanking.
  //   That bypass used to need preprocessing to close; now it is closed twice.
  //   WHAT IS GIVEN UP. The window is 192 (the 4.60.0 convention, same as
  //   dd/curl/wget/git-push). A WHERE more than 192 characters after the table
  //   name is not seen, so such a statement is graded DANGER. That is
  //   fail-closed — the give-up direction is toward blocking, not allowing —
  //   and the exact width is pinned by the 192/193 boundary pair in
  //   tests/autopilot/safety.test.js, which is the canonical source for it.
  // `[` and `]` are still NOT in the body class: `[dbo].[t]` stays a miss.
  // Widening coverage there is a separate decision, not a bug fix.
  // TIMING — this is why the old shape could not stay. Rule-alone medians of 3
  // at 20,480 / 40,962 / 122,880B (node v24.15.0, Windows, 2026-09-14) on
  // `fill('DELETE FROM t=1 WHERE x ', n)`, an input that fails at every
  // attempt position:
  //   old `[\w."` ]+(?!.*\bWHERE\b)`   6.10 /  26.00 / 257.00 ms  -> raw 42x
  //   new `[\w."`]+(?![^;]{0,192}…)`   0.38 /   0.74 /   3.09 ms  -> raw 5.6x
  // Absolute values swing a lot on this machine (the old rule's 122,880B figure
  // ranged 132-257ms over five runs) but the SHAPE does not: the old raw ratio
  // stayed 16-60x across every run and the new one 3-9x. Quadratic vs linear.
  // Full classifyRisk path at 122,880B with the new rule: 2.70-4.05 ms on this
  // machine (same session); the 1.2 ms figure in the recon brief was a
  // different machine, so only the ratio is portable, not the absolute.
  // The old rule sat in the static scanner's SCAN_ALLOWLIST on the strength of
  // a "measured linear" note. That note was measured on `'DELETE FROM t '`
  // repeats, which match on the FIRST attempt and therefore never exercise the
  // backtracking; both statements were true and the generalisation was not.
  // The new shape has no unbounded run at all, so the allowlist is now empty.
  { id: 'sql-delete-no-where', level: 'danger', test: /\bDELETE\s+FROM\s+[\w."`]+(?![^;]{0,192}\bWHERE\b)/i, reason: 'DELETE FROM without WHERE' },
  { id: 'secret-openai', level: 'danger', test: /\bsk-[A-Za-z0-9]{16,}\b/, reason: 'Possible OpenAI secret key' },
  { id: 'secret-stripe-pub', level: 'caution', test: /\bpk_(live|test)_[A-Za-z0-9]{16,}\b/, reason: 'Possible Stripe key literal' },
  { id: 'secret-private-key', level: 'danger', test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'PEM private key block' },
  { id: 'secret-aws', level: 'danger', test: /\baws_secret_access_key\b/i, reason: 'AWS secret access key reference' },
  // Same window bound and the same blind spot as dd-device-write above — see
  // that comment. A URL more than 192 characters into the command is not graded.
  { id: 'curl-external', level: 'caution', test: /\bcurl\b[^\n]{0,192}\shttps?:\/\//i, reason: 'curl to external host' },
  { id: 'wget-external', level: 'caution', test: /\bwget\b[^\n]{0,192}\shttps?:\/\//i, reason: 'wget from external host' },
  { id: 'npm-publish', level: 'danger', test: /\bnpm\s+publish\b/i, reason: 'npm publish (release-grade action)' },
  { id: 'docker-prune', level: 'caution', test: /\bdocker\s+system\s+prune\b/i, reason: 'docker prune deletes resources' },
]);

/**
 * Extract a probe string from a tool call payload.
 * Accepts strings, or objects with command/code/content/input.
 * @param {*} toolCall
 * @returns {string}
 */
function probeText(toolCall) {
  if (toolCall === null || toolCall === undefined) return '';
  if (typeof toolCall === 'string') return toolCall;
  if (typeof toolCall !== 'object') return String(toolCall);
  const candidates = [
    toolCall.command,
    toolCall.cmd,
    toolCall.code,
    toolCall.content,
    toolCall.text,
    toolCall.input,
    toolCall.body,
    toolCall.url,
  ];
  return candidates.filter((v) => typeof v === 'string').join('\n');
}

/**
 * Classify the risk level of a tool call.
 * @param {*} toolCall - String command, or object with command/code/content fields
 * @returns {{ level: 'safe'|'caution'|'danger', reason: string, matchedId?: string }}
 */
export function classifyRisk(toolCall) {
  const text = probeText(toolCall);
  if (!text) return { level: 'safe', reason: 'empty payload' };

  // Printer-segment preprocessing, shared with L1 (lib/core/command-segments.js,
  // 2026-09-14): `echo "…"`, `# …`, `printf`, `grep`, `git commit -m` segments
  // are blanked before grading, so a pure mention is no longer danger. It is
  // segment-level and allowlist-only (fail-closed): `echo x; rm -rf /` keeps
  // its `rm -rf /`, and a pipe / `$(…)` / redirect out of a printer vetoes the
  // exemption. The four `secret-*` rules deliberately read the RAW text —
  // echoing a secret still leaks it. Heredoc bodies and `$(…)` are never
  // blanked (intended residual over-grading).
  const scanned = blankPrinterSegments(text);

  let cautionHit = null;
  for (const rule of DANGEROUS_PATTERNS) {
    const subject = rule.id.startsWith('secret-') ? text : scanned;
    if (rule.test.test(subject)) {
      if (rule.level === 'danger') {
        return { level: 'danger', reason: rule.reason, matchedId: rule.id };
      }
      if (!cautionHit) cautionHit = rule;
    }
  }
  if (cautionHit) {
    return { level: 'caution', reason: cautionHit.reason, matchedId: cautionHit.id };
  }
  return { level: 'safe', reason: 'no dangerous pattern matched' };
}

const DEFAULT_THRESHOLDS = Object.freeze({
  buildFailures: 3,
  testFailures: 5,
  contextRatio: 0.85,
});

/**
 * Parse a duration string like "4h", "30m", "8h", "120s" into milliseconds.
 * @param {string|number|undefined} input
 * @returns {number|null} milliseconds, or null if unparseable
 */
export function parseDuration(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const m = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/i.exec(String(input));
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'ms' ? 1
    : unit === 's' ? 1000
    : unit === 'm' ? 60_000
    : unit === 'h' ? 3_600_000
    : 86_400_000;
  return value * mult;
}

const BUDGET_UNKNOWN = Object.freeze({
  tokens: null, usd: null, known: false, source: null, measuredAt: null,
});

/**
 * Coerce a value into a positive finite limit, or null.
 * Strings are rejected on purpose: a limit that arrived as text means the
 * caller never parsed it, and silently coercing hides that bug.
 * @param {unknown} n
 * @returns {number|null}
 */
function positiveLimit(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the session's budget limits into explicit units.
 *
 * `options.budget` is the legacy field. `commands/autopilot.md` documents it as
 * `--budget <tokens>`, so it is read AS TOKENS here — that is the documented
 * contract, and the USD reading it used to get was the bug (F03). This compat
 * read is non-destructive and scheduled for removal one release after
 * `budgetTokens` ships; this function is the only place in the plugin that
 * reads `options.budget`.
 *
 * `budgetUsd` is an independent second limit, not a conversion of the first.
 *
 * @param {object|null|undefined} options - state.options
 * @returns {{budgetTokens:number|null, budgetUsd:number|null,
 *            source:'budgetTokens'|'budget-compat'|'none'}}
 */
export function normalizeBudget(options) {
  const o = options && typeof options === 'object' ? options : {};
  const canonical = positiveLimit(o.budgetTokens);
  const legacy = canonical === null ? positiveLimit(o.budget) : null;
  const budgetTokens = canonical !== null ? canonical : legacy;
  const source = canonical !== null ? 'budgetTokens'
    : (legacy !== null ? 'budget-compat' : 'none');
  return { budgetTokens, budgetUsd: positiveLimit(o.budgetUsd), source };
}

/**
 * Read what the session has actually consumed, distinguishing "zero" from
 * "not measured". An unmeasured session returns `known:false` with every
 * number null — never 0, because a 0 that means "no telemetry yet" reads as
 * "plenty of budget left" and is exactly how an exhausted run keeps going.
 *
 * @param {object|null|undefined} state
 * @returns {{tokens:number|null, usd:number|null, known:boolean,
 *            source:string|null, measuredAt:string|null}}
 */
export function readUsage(state) {
  if (!state || typeof state !== 'object') return { ...BUDGET_UNKNOWN };
  const usage = state.usage && typeof state.usage === 'object' ? state.usage : null;
  const totals = usage && usage.totals && typeof usage.totals === 'object' ? usage.totals : null;
  const counter = Number(state.tokenUsage);
  const counterKnown = Number.isFinite(counter) && counter > 0;
  if (!totals && !counterKnown) return { ...BUDGET_UNKNOWN };

  const totalsIn = Number(totals?.tokensIn);
  const totalsOut = Number(totals?.tokensOut);
  const fromTotals = (Number.isFinite(totalsIn) ? totalsIn : 0)
    + (Number.isFinite(totalsOut) ? totalsOut : 0);
  const fromCounter = counterKnown ? counter : 0;
  const tokens = Math.max(fromTotals, fromCounter);
  const costUsd = Number(totals?.costUsd);
  const phases = usage && usage.phases && typeof usage.phases === 'object' ? usage.phases : {};
  const stamps = Object.values(phases)
    .map((p) => (p && typeof p.lastTs === 'string' ? p.lastTs : null))
    .filter((ts) => ts !== null)
    .sort();
  return {
    tokens,
    usd: totals && Number.isFinite(costUsd) ? costUsd : null,
    known: true,
    source: fromCounter > fromTotals ? 'tokenUsage' : 'usage.totals',
    measuredAt: stamps[stamps.length - 1]
      ?? (typeof state.updatedAt === 'string' ? state.updatedAt : null),
  };
}

/**
 * Round a ratio to a one-decimal percentage.
 * @param {number} used
 * @param {number} limit
 * @returns {number}
 */
function pct(used, limit) {
  return Math.round((used / limit) * 1000) / 10;
}

/**
 * Build one `{unit, limit, used, percent, exceeded}` block, or null when the
 * unit has no limit configured.
 * @param {'tokens'|'usd'} unit
 * @param {number|null} limit
 * @param {number|null} used
 * @returns {{unit:string, limit:number, used:number|null, percent:number|null, exceeded:boolean}|null}
 */
function unitBlock(unit, limit, used) {
  if (limit === null) return null;
  if (used === null || !Number.isFinite(used)) {
    return {
      unit, limit, used: null, percent: null, exceeded: false,
    };
  }
  return {
    unit, limit, used, percent: pct(used, limit), exceeded: used >= limit,
  };
}

/**
 * Budget status per unit.
 *
 * `exceeded` is `used >= limit`, not `>`: the documented contract is
 * "초과 시 pause", and a run that has consumed exactly its allowance has
 * nothing left to spend. Treating exhaustion as a pause is the fail-closed
 * reading — the failure mode of the strict `>` reading is a run that keeps
 * spending forever at exactly 100%.
 *
 * With `usageKnown:false` no unit is ever `exceeded` — an unmeasured session
 * is unknown, not safe, and the caller decides what to do about that
 * (the engine's budget gate emits a `budget-usage-unknown` warning).
 *
 * @param {object} state
 * @returns {{tokens:object|null, usd:object|null, usageKnown:boolean,
 *            source:string, measuredAt:string|null}}
 */
export function budgetStatus(state) {
  const { budgetTokens, budgetUsd, source } = normalizeBudget(state?.options);
  const usage = readUsage(state);
  return {
    tokens: unitBlock('tokens', budgetTokens, usage.known ? usage.tokens : null),
    usd: unitBlock('usd', budgetUsd, usage.known ? usage.usd : null),
    usageKnown: usage.known,
    source,
    measuredAt: usage.measuredAt,
  };
}

/**
 * True when any configured budget unit is exhausted.
 * @param {object} state
 * @returns {boolean}
 */
export function budgetExceeded(state) {
  const status = budgetStatus(state);
  return status.tokens?.exceeded === true || status.usd?.exceeded === true;
}

/**
 * Decide whether the autopilot session should be paused.
 * Triggers per PRD section 5.5:
 *  - build failures >= 3
 *  - test failures >= 5
 *  - context usage > 85%
 *  - duration exceeded options.maxDuration
 *  - budget exhausted in any configured unit (F03)
 *
 * @param {object} state - Session state
 * @returns {boolean}
 */
export function shouldPause(state) {
  if (!state || typeof state !== 'object') return false;

  const counters = state.counters || {};
  const buildFailures = Number(counters.buildFailures || 0);
  const testFailures = Number(counters.testFailures || 0);
  if (buildFailures >= DEFAULT_THRESHOLDS.buildFailures) return true;
  if (testFailures >= DEFAULT_THRESHOLDS.testFailures) return true;

  const ratio = Number(state.contextUsage ?? counters.contextRatio ?? 0);
  if (Number.isFinite(ratio) && ratio > DEFAULT_THRESHOLDS.contextRatio) return true;

  const maxDur = parseDuration(state.options?.maxDuration);
  if (maxDur && state.createdAt) {
    const started = Date.parse(state.createdAt);
    if (Number.isFinite(started) && Date.now() - started > maxDur) return true;
  }

  if (budgetExceeded(state)) return true;

  // Runtime feeder: severity-tagged errors are written by engine-state.js
  // #recordRiskEvent, which the Bash PreToolUse risk guard
  // (scripts/hooks/bash-risk-guard.js) calls when classifyRisk returns
  // 'danger' during an active autopilot session. Before that wiring this
  // branch was unreachable (no code path recorded `severity`).
  if (Array.isArray(state.errors) && state.errors.some((e) => e?.severity === 'danger')) {
    return true;
  }
  return false;
}

/**
 * Produce a human-readable pause reason. Returns null if no trigger is hit.
 * @param {object} state
 * @returns {string|null}
 */
export function pauseReason(state) {
  if (!shouldPause(state)) return null;
  const counters = state?.counters || {};
  if (Number(counters.buildFailures || 0) >= DEFAULT_THRESHOLDS.buildFailures) return 'build-failures-threshold';
  if (Number(counters.testFailures || 0) >= DEFAULT_THRESHOLDS.testFailures) return 'test-failures-threshold';
  const ratio = Number(state.contextUsage ?? counters.contextRatio ?? 0);
  if (Number.isFinite(ratio) && ratio > DEFAULT_THRESHOLDS.contextRatio) return 'context-window-exceeded';
  const maxDur = parseDuration(state.options?.maxDuration);
  if (maxDur && state.createdAt) {
    const started = Date.parse(state.createdAt);
    if (Number.isFinite(started) && Date.now() - started > maxDur) return 'max-duration-exceeded';
  }
  if (budgetExceeded(state)) return 'budget-exceeded';
  if (Array.isArray(state.errors) && state.errors.some((e) => e?.severity === 'danger')) return 'danger-error-recorded';
  return 'unknown';
}
