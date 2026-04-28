---
session: ap-20260428-094832
phase: 3
gate: CROSS_CHECK (security)
auditor: security-reviewer
created: 2026-04-28
---

# Phase 3 Security Report — ap-20260428-094832

## 1. Verdict

**PASS WITH NOTES**

No Critical findings. Phase 2 surface (Squad D residue currently in working tree + earlier-landed Squad A/B/C deliverables already on `artibot/master`) contains zero outbound HTTP egress in production code paths, zero hardcoded secrets, and no exploitable injection vectors. Three Important and four Note-level findings are listed below; none block Phase 4.

## 2. DATA POLICY confirmation

| Area | Phase 2 surface | Egress detected | Verdict |
|---|---|---|---|
| Cognitive router (modified) | `lib/cognitive/router.js` (+4 lines: persona/source-driven domain keywords) | none — pure regex/keyword matching, no I/O | PASS |
| Persona-architect skill (modified) | `skills/persona-architect/SKILL.md` (+6 lines: See Also block) | none — markdown only | PASS |
| Persona-distill references (new) | `skills/persona-distill/references/{six-layer-persona,tag-behavior-map}.md` | none — prose; tag dictionary explicitly includes `data-policy-strict` | PASS |
| Source-driven-development skill (new) | `skills/source-driven-development/SKILL.md` | none in code; SKILL declares `WebFetch` as an allowed-tool but defers all network I/O to the WebFetch tool itself which is governed by separate user consent | PASS |
| New tests | `tests/skills/{persona-distill,source-driven-development,anti-rationalization,when-not-to-use}.test.js` | none — `node:fs` reads only | PASS |
| Squad A — orchestration primitives | `lib/orchestration/{guardrails,tool-guardrails,agent-as-tool,handoff-filter}.js` | grep `\b(fetch\|axios\|node-fetch\|XMLHttpRequest\|http.request)\b` → 0 matches | PASS |
| Squad A — observability NDJSON | `lib/observability/exporters/ndjson.js` | no HTTP imports; only `node:fs/promises` + `node:path`. Writes to `runtime/traces/` only | PASS |
| Squad A — security allowlist | `lib/security/cmd-allowlist.js` | zero I/O; pure string parsing | PASS |
| Squad A — session ABC | `lib/learning/session.js` (`InMemorySession`, `JsonFileSession`) | local-disk only via `node:fs/promises`; no network | PASS |
| Squad C — webfetch cache hooks | `scripts/hooks/webfetch-cache-{pre,post}.js` | no `fetch`/`http`/`https` imports; cache-only on `runtime/cache/webfetch/`. JSDoc explicitly states "NO HTTP / fetch / external egress in this script" (pre.js:14, post.js:5) | PASS |
| Squad C — pre-compact hook | `scripts/hooks/pre-compact.js` | `child_process.execSync` for `git rev-parse` and `git status --short` only. Both calls have `timeout: 2000`, `stdio: ['ignore','pipe','ignore']`, fixed string commands, and `cwd: process.cwd()` | PASS |
| Squad C — ambiguity guard | `scripts/hooks/ambiguity-guard.js` | no I/O beyond stdin/stdout; pure string matching | PASS |
| Squad C — skill discovery inject | `scripts/hooks/skill-discovery-inject.js` | only `node:fs/promises` reads/writes; gate path constructed from `getPluginRoot()` (no user-controlled component) | PASS |

Net result: zero unauthorized egress in any Phase 2 production file. Squad A's own `tests/lib/observability/no-egress.test.js` enforces this at CI time for the orchestration/observability/security trees.

## 3. otel-exporter.js compliance assessment

`lib/observability/otel-exporter.js` is NOT a Phase 2 deliverable — it pre-exists and is owned by a separate observability surface — but the brief asks for explicit verification of its DATA POLICY posture.

| Property | Source line | Status |
|---|---|---|
| Default disabled | `createOtelExporter()` line 454: `const enabled = options.enabled !== undefined ? options.enabled : Boolean(endpoint)` — disabled unless `endpoint` is configured | PASS |
| `LOOPBACK_HOSTS` allowlist | line 43: `Set(['127.0.0.1', 'localhost', '::1', '[::1]'])` — frozen | PASS |
| Loopback gate reachable | `isLoopbackEndpoint()` (line 136) is called by the constructor at line 463; cannot be bypassed without explicit operator-supplied non-loopback endpoint | PASS |
| Non-loopback emits stderr warning | line 463–468: `warn(\`WARNING: OTEL endpoint '${endpoint}' is not loopback. Telemetry will leave this machine\`)` | PASS |
| 4xx no-retry policy (besides 429) | line 486: prevents retry storms toward unauthorised endpoints | PASS |
| Buffer cap | `DEFAULT_BUFFER_MAX_ENTRIES = 500` (line 41), enforced at `appendToBuffer` line 382 | PASS |
| Test coverage of loopback path | `tests/lib/observability/no-egress.test.js` deliberately scopes its scan to Squad A's allowlist (`OWNED_FILES`); `otel-exporter.js` is correctly NOT in that allowlist (test lines 26–34, comment lines 7–10). The exporter's own dedicated tests live elsewhere | NOTE — see Important #2 |

**Verdict on otel-exporter.js**: PASS for the current configuration. The exporter is gated, default-off, loopback-preferred, and emits a visible warning when an operator opts into non-loopback egress. The brief's concern about bypassability is addressed: the gate is in the constructor, not per-call, so it cannot be turned off mid-flight; any non-loopback URL surfaces immediately at construction time.

## 4. Findings

### 4.1 Critical

None.

### 4.2 Important

**I-1. `cmd-allowlist.js` does not block shell metacharacter chains.** `lib/security/cmd-allowlist.js:36-54` (`parseLeadingBinary`) extracts the first token and matches it against the allowlist, but does not inspect the rest of the command. A caller passing `ls; rm -rf /` would see `bin = 'ls'` and `isAllowedCommand` returns `true`, yet the actual shell would still execute the trailing `rm`. The current file does not itself execute commands (it only diagnoses them), but if a future PreToolUse hook wires `isAllowedCommand` directly to a Bash gate without an additional metacharacter rejection step, the allowlist would be bypassable. Mitigation that already exists: the PreToolUse Bash gate in `hooks.json` (out of Phase 2 scope) is the actual enforcement point; cmd-allowlist is the policy library only. Recommend adding to `lib/security/cmd-allowlist.js`:

```javascript
const SHELL_META_RE = /[;&|`$()<>]|\|\||&&/;
export function hasShellMetacharacters(cmd) {
  return SHELL_META_RE.test(String(cmd ?? ''));
}
export function isAllowedCommand(cmd, allowlist = DEFAULT_BASH_ALLOWLIST) {
  if (hasShellMetacharacters(cmd)) return false;
  const bin = parseLeadingBinary(cmd);
  return bin != null && allowlist.includes(bin);
}
```

Severity: Important (not Critical) because the file is policy-only; no live exploit path exists in the current Phase 2 surface.

**I-2. `no-egress.test.js` allowlist scope is narrow.** `tests/lib/observability/no-egress.test.js:26-34` restricts the egress scan to seven `OWNED_FILES`. This is correct as Squad A's contract surface, but it does NOT prevent a future contributor from adding a new `.js` file to `lib/orchestration/` that imports `node-fetch`. Recommend either (a) drop the `OWNED_FILES` filter so the scan covers any new files, or (b) keep the current allowlist for Squad A's contract and add a complementary "all files in these dirs" scan to `tests/security/`. Phase 4 should pick one; for now this is informational.

**I-3. `pre-compact.js` `execSync` runs in `process.cwd()` without sandboxing.** Lines 217 and 227 call `git rev-parse --abbrev-ref HEAD` and `git status --short` respectively in the user's current working directory. Both commands are fixed strings (no string interpolation of user input), have a 2-second timeout, and pipe stderr to `'ignore'`, so command injection is not feasible. Residual risk: a malicious git config (`.git/config` `core.fsmonitor` etc.) at `process.cwd()` can cause `git status` to execute arbitrary code. This is a known git posture, not a code defect, but is worth flagging because hooks run silently on PreCompact. Mitigation: pre-compact.js currently swallows errors silently — that's the correct behavior here. No change required for Phase 2; document in INCIDENT.md (deferred AD-43) for future hardening.

### 4.3 Note

**N-1. `webfetch-cache-pre.js` SHA-1 cache key is path-traversal safe.** `cacheKey()` at line 42 produces a 40-hex-char filename. `cacheDir()` at line 32 resolves to `runtime/cache/webfetch/`. The final path `path.join(dir, ${key}.json)` cannot escape the cache dir because hex chars contain no `/` or `..`. Verified by inspection: a malicious URL like `../../etc/passwd` hashes to a benign hex string. PASS.

**N-2. `JsonFileSession` does NOT enforce a per-session size cap.** `lib/learning/session.js:110-118` (`addItems`) appends to disk without a size bound. An attacker who controls items written to a session could grow the JSON file unbounded. Risk is low because session ids are caller-supplied and writes are bounded by available disk; but if Squad A wires `JsonFileSession` to user-controlled inputs in Phase 4, add a `MAX_ITEMS` or `MAX_BYTES` constant. Phase 2 ledger AD-05 marks this acceptable for the current "foundation only" scope.

**N-3. `ambiguity-guard.js` regex DoS risk is bounded.** Line 67 builds a fresh `RegExp` per token with literal anchors `(^|[^a-z])${token}([^a-z]|$)`. The token set (`DESTRUCTIVE_TOKENS`, line 26) is a fixed 14-element list, all literals, no user input flows into the pattern. Catastrophic backtracking is not possible against fixed literal alternations. PASS.

**N-4. Pre-existing `http-notify.js` is opt-in and out of Phase 2 scope.** `scripts/hooks/http-notify.js:111` performs `fetch(config.url, ...)` for Slack/Discord/generic webhooks. Activation requires `ARTIBOT_WEBHOOK_URL` env var or `artibot.config.json#hooks.webhook.url`. This file pre-dates Phase 2 (last touched in Apr 1 commit `df355dc`), is correctly excluded from Squad A's `no-egress.test.js` allowlist, and respects DATA POLICY because it is opt-in. **However**, unlike `otel-exporter.js`, it does NOT enforce loopback-preference and does NOT warn on non-loopback. Recommend Phase 4 pick this up and apply the same `LOOPBACK_HOSTS` + warn pattern as `otel-exporter.js`. Out of Phase 2 scope; informational only.

## 5. Test strength evaluation

| Test | Asserts what | Verdict |
|---|---|---|
| `tests/lib/observability/no-egress.test.js` | Strips comments + string literals from any `.js`/`.mjs` in `lib/{observability,orchestration,security}` whose basename is in `OWNED_FILES`, then greps `EGRESS_REGEX = /\b(fetch\|http\|https\|XMLHttpRequest\|axios\|node-fetch)\b/`. Any match throws with a per-line diagnostic. Also verifies the orchestration and observability dirs are non-empty so the test cannot silently pass on a deleted tree | STRONG for Squad A's contract, NARROW for the broader codebase (see I-2) |
| `tests/skills/anti-rationalization.test.js` | For each of 20 Squad-B skills, asserts `## Common Rationalizations` and `## Red Flags` headers exist | STRONG (40 assertions, exact-string match) |
| `tests/skills/when-not-to-use.test.js` | Counts SKILL.md files with `whenNotToUse:` in frontmatter, asserts ≥20; separately enumerates 20 Squad-B targets and asserts the field on each | STRONG |
| `tests/skills/persona-distill.test.js` | 26 assertions: frontmatter shape, anti-rationalization sections, reference file existence, all 6 layers documented, ≥12 active tags, REJECTED tags absent from active set, no external-SaaS endorsement, DATA POLICY mention | STRONG; the DATA POLICY check at line 267-281 is the right shape |
| `tests/skills/source-driven-development.test.js` | 22 assertions: frontmatter, DETECT-FETCH-IMPLEMENT-CITE flow, sdd-cache integration, AD-24/AD-32 citation, Stack Overflow rejected, no external-chat-API references | STRONG |

Recommendation for Phase 4: extend `no-egress.test.js` to drop the `OWNED_FILES` filter (or run a sibling "any-file" scan) so newly added files in those dirs cannot regress the policy without a deliberate test edit. Tracked as Important I-2.

## 6. Sign-off

PASS WITH NOTES — Phase 2 introduces zero outbound HTTP, zero secrets, zero exploitable injection paths; advance to Phase 4 with three Important items tracked for follow-up sprint.

```json
{
  "verdict": "warning",
  "summary": "No critical or high-severity findings. DATA POLICY upheld across all Phase 2 surfaces (Squad A/B/C/D). Three Important items deferred to Phase 4: cmd-allowlist metacharacter rejection, no-egress.test.js scope widening, http-notify.js loopback-preference parity with otel-exporter.js.",
  "findings": [
    {
      "id": "I-1",
      "severity": "important",
      "category": "A04-Insecure-Design",
      "file": "plugins/artibot/lib/security/cmd-allowlist.js",
      "line": 62,
      "confidence": "high",
      "description": "isAllowedCommand parses only the leading binary; shell metacharacters (;, &&, ||, |, backtick, $(), <, >) are not rejected. Library is policy-only today (no live execution), but will be bypassable if wired naively to a Bash gate.",
      "suggestion": "Add hasShellMetacharacters() pre-check that returns false on /[;&|`$()<>]|\\|\\||&&/ before parseLeadingBinary."
    },
    {
      "id": "I-2",
      "severity": "important",
      "category": "A04-Insecure-Design",
      "file": "plugins/artibot/tests/lib/observability/no-egress.test.js",
      "line": 26,
      "confidence": "high",
      "description": "OWNED_FILES allowlist limits the scan to seven Squad A files; new files added to lib/orchestration/ or lib/observability/ that import node-fetch would not fail the test.",
      "suggestion": "Drop the OWNED_FILES filter, or add a sibling test under tests/security/ that scans every .js/.mjs in those directories."
    },
    {
      "id": "I-3",
      "severity": "important",
      "category": "A05-Security-Misconfiguration",
      "file": "plugins/artibot/scripts/hooks/pre-compact.js",
      "line": 227,
      "confidence": "low",
      "description": "execSync('git status --short') in process.cwd() honors the local repo's .git/config, which can include arbitrary fsmonitor/aliases. No code-injection vector via this hook itself; residual risk is git's own posture in malicious repos.",
      "suggestion": "Document this dependence in docs/INCIDENTS.md (AD-43, deferred). No code change required for Phase 2."
    },
    {
      "id": "N-1",
      "severity": "low",
      "category": "A03-Injection",
      "file": "plugins/artibot/scripts/hooks/webfetch-cache-pre.js",
      "line": 42,
      "confidence": "high",
      "description": "SHA-1 url hashing prevents path traversal; verified that hex-only output cannot escape runtime/cache/webfetch/.",
      "suggestion": "No change required. PASS."
    },
    {
      "id": "N-2",
      "severity": "low",
      "category": "A04-Insecure-Design",
      "file": "plugins/artibot/lib/learning/session.js",
      "line": 110,
      "confidence": "medium",
      "description": "JsonFileSession.addItems has no MAX_BYTES/MAX_ITEMS bound; foundation-only API per AD-05.",
      "suggestion": "When Phase 4 wires JsonFileSession to user-controlled inputs, add a MAX_BYTES (e.g., 10MB) or MAX_ITEMS (e.g., 10000) bound and reject overflow."
    },
    {
      "id": "N-3",
      "severity": "low",
      "category": "A04-Insecure-Design",
      "file": "plugins/artibot/scripts/hooks/ambiguity-guard.js",
      "line": 67,
      "confidence": "high",
      "description": "RegExp built per fixed-literal token from a 14-element constant set; no user input enters the pattern. Catastrophic backtracking not possible.",
      "suggestion": "No change required. PASS."
    },
    {
      "id": "N-4",
      "severity": "low",
      "category": "A02-Cryptographic-Failures",
      "file": "plugins/artibot/scripts/hooks/http-notify.js",
      "line": 111,
      "confidence": "medium",
      "description": "Pre-existing opt-in webhook hook (Apr 1 commit, out of Phase 2 scope). Activation requires explicit env var; no loopback-preference or stderr-warn parity with otel-exporter.js.",
      "suggestion": "Phase 4: apply otel-exporter.js's LOOPBACK_HOSTS + warn pattern to http-notify.js so non-loopback webhook URLs surface visibly at config-load time."
    }
  ],
  "next_steps": [
    "Phase 4 picks up I-1 (cmd-allowlist metacharacter check) before any PreToolUse Bash gate is wired",
    "Phase 4 picks up I-2 (broaden no-egress.test.js scope) to prevent future regressions",
    "Phase 4 considers N-4 (http-notify loopback parity)",
    "Defer N-2 (JsonFileSession bounds) until AD-10 (run-state) lands and JsonFileSession is wired to user input"
  ]
}
```
