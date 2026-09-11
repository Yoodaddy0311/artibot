/**
 * Autopilot safety guard.
 * Classifies tool calls by risk and decides when the engine should pause.
 *
 * Reference: PRD docs/PRD/autopilot-mode.md sections 5.5 and 13.3.
 *
 * @module lib/autopilot/safety
 */

/**
 * Pattern catalogue used by classifyRisk. Each entry has:
 *  - id: unique identifier
 *  - level: 'caution' | 'danger'
 *  - test: RegExp to match against the command/text payload
 *  - reason: human readable reason
 *
 * lib/core/blocked-patterns.js (L1, PreToolUse) is the canonical block list;
 * this catalogue only grades severity on top of it and never widens what runs.
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
  // argument branch forbids a leading dash, and the continuation branch starts
  // with a backslash (never whitespace), so no token or separator can parse two
  // ways and the scan is linear (120KB adversarial input < 5ms, measured).
  {
    id: 'git-branch-delete',
    level: 'danger',
    test: /\b[gG][iI][tT](?:[^\S\n]|\\\r?\n)+branch\b(?:(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+-[a-zA-Z]*D[a-zA-Z]*(?![\w-]))|(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+(?:--delete|-[a-z]*d[a-z]*)(?![\w-]))(?=(?:(?:[^\S\n]|\\\r?\n)+(?:--?\w[^\s;&|]*|[^\s;&|-][^\s;&|]*))*(?:[^\S\n]|\\\r?\n)+(?:--force|-[a-z]*f[a-z]*)(?![\w-])))/,
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
  {
    id: 'rm-rf-root',
    level: 'danger',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+(?:\/(?:\s|$|\*|\w)|~(?:\s|$|\/)|\$HOME(?:\s|$|\/))/i,
    reason: 'rm -rf on root or home',
  },
  {
    id: 'rm-rf-broad',
    level: 'danger',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+\*/i,
    reason: 'rm -rf with broad glob',
  },
  // Keep after rm-rf-root/rm-rf-broad: those two own the root/home/glob targets.
  // Two lookaheads demand a recursive flag AND a force flag anywhere in the
  // option run, so combined (-rfv), split (-r -f) and long (--recursive) forms
  // all land here; the final guard skips root/home/glob targets.
  {
    id: 'rm-rf-path',
    level: 'caution',
    test: /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?=(?:\s+--?\w[\w-]*)*\s+(?:--force|-[a-z]*[f][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+(?![-/~*]|\$HOME\b)\S+/i,
    reason: 'recursive delete of a scoped path (blocked at PreToolUse by blocked-patterns)',
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
  { id: 'sql-delete-no-where', level: 'danger', test: /\bDELETE\s+FROM\s+[\w."` ]+(?!.*\bWHERE\b)/is, reason: 'DELETE FROM without WHERE' },
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

  let cautionHit = null;
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.test.test(text)) {
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

/**
 * Decide whether the autopilot session should be paused.
 * Triggers per PRD section 5.5:
 *  - build failures >= 3
 *  - test failures >= 5
 *  - context usage > 85%
 *  - duration exceeded options.maxDuration
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
  if (Array.isArray(state.errors) && state.errors.some((e) => e?.severity === 'danger')) return 'danger-error-recorded';
  return 'unknown';
}
