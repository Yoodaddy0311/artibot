---
description: (Artibot) Automated health check — config, agents, skills, hooks, MCP, memory
argument-hint: '[scope] e.g. "config" | "skills" | "hooks" — or no argument for full check'
allowed-tools: [Read, Glob, Grep, Bash]
toolset: meta
lifecycle: diagnose
---

# /doctor

Run automated health checks on the Artibot plugin installation. Validates config integrity, agent files, skill hashes, hook dispatchers, MCP connectivity, and memory stores. Produces a single pass/fail summary.

## Arguments

Parse $ARGUMENTS:
- (no argument): Run all 7 checks
- `config`: Check 1 only — config validation
- `agents`: Check 2 only — agent file presence
- `skills`: Check 3 only — skill hash integrity
- `hooks`: Check 4 only — hook health
- `mcp`: Check 5 only — MCP connectivity
- `memory`: Check 6 only — memory store health
- `explainability`: Check 7 only — decision recording health
- `--verbose`: Show per-item details (not just summary lines)
- `--json`: Output results as a JSON object instead of the formatted report
- `--fix`: After diagnosing, apply SAFE automatic repairs for fixable failures (see Self-Heal below)
- `--dry-run`: Preview the repairs `--fix` would make without writing anything (this is the **default** for the self-heal layer — repairs only mutate the filesystem when `--fix` is passed explicitly)

## Paths

All paths are relative to the plugin root (`plugins/artibot/`):
- Config: `artibot.config.json`
- Agents: `agents/*.md`
- Skills: `skills/*/SKILL.md`
- Skill hash cache: `.claude-cache/skill-hashes.json`
- Hook definitions: `hooks/hooks.json`, `hooks/dispatch-table.json`
- Hook scripts: `scripts/hooks/*.js`
- MCP config: `.mcp.json`
- Memory scopes: defined in `artibot.config.json > learning.memoryScopes`

## Execution Flow

### Check 1: Config Validation

1. Read `plugins/artibot/artibot.config.json`
2. Parse as JSON — if parse fails, report FAIL immediately
3. Apply `validateConfig()` logic from `lib/core/config-schema.js`:
   - Verify root is a plain object
   - Verify required field `version` exists and matches semver pattern
   - Validate each known section against its schema constraints
4. Count from the parsed config:
   - `version`: value of `version` field
   - Agent count: unique agent names across `agents.modelPolicy.high.agents` + `agents.modelPolicy.medium.agents`
   - Skill count: count directories under `skills/` that contain `SKILL.md` (use Glob)
   - Command count: count `.md` files under `commands/` excluding `index.md` (use Glob)
5. Report: version, agent count, skill count, command count, validation errors (if any)

### Check 2: Agent Files

1. Collect all unique agent names referenced in `artibot.config.json`:
   - `agents.modelPolicy.high.agents[]`
   - `agents.modelPolicy.medium.agents[]`
   - `agents.categories.*[]` (flatten all arrays)
   - `agents.taskBased.*` (all values)
2. For each unique agent name, verify `agents/{name}.md` exists (use Glob or Read)
3. Report: total referenced, total present, list of missing agents (if any)

### Check 3: Skill Integrity

1. Load the skill hash cache from `.claude-cache/skill-hashes.json` (following the pattern in `lib/core/skill-hash-cache.js > loadSkillHashCache()`)
2. If cache is missing, scan `skills/*/SKILL.md` via Glob and report cache-missing warning
3. For each skill in the cache, verify the hash by:
   - Reading the SKILL.md file
   - Stripping YAML frontmatter (everything between opening `---` and closing `---`)
   - Computing SHA-256 of the body (normalized: CRLF to LF, trimmed), take first 8 hex chars
   - Comparing against the cached `hash` value (following `lib/core/skill-hash.js > verifyHash()`)
4. Also check for skills on disk that are NOT in the cache (orphaned skills)
5. Report: total verified, hash mismatches, missing-from-cache, missing-from-disk

### Check 4: Hook Health

1. Read `hooks/hooks.json` — verify valid JSON, count event slots and total hook entries
2. Read `hooks/dispatch-table.json` — verify valid JSON, count dispatcher slots and handler entries
3. For each handler script referenced in `dispatch-table.json > slots.*.handlers[].script`:
   - Verify the file exists at `scripts/hooks/{script}` (use Glob)
4. For each dispatcher script referenced in `dispatch-table.json > slots.*.dispatcher`:
   - Verify the file exists (skip null dispatchers like PreCompact)
5. For each hook command in `hooks.json`, extract the script path and verify the file exists
6. Check syntactic validity of each hook script: run `node --check {script}` via Bash (parse-only, no execution)
7. Report: dispatcher count, total script count, missing scripts, syntax errors

### Check 5: MCP Connectivity

1. Read `.mcp.json` — verify valid JSON
2. List all configured MCP server names and their types (`command` vs `http`)
3. For `command`-type servers: verify the command is available (e.g., `npx` exists on PATH)
4. For `http`-type servers: verify the URL is well-formed; optionally attempt a lightweight HTTP HEAD request (timeout 5s) to check reachability
5. Report: server names, types, and connectivity status (connected / unreachable / unknown)

### Check 6: Memory Health

1. Read memory scope paths from `artibot.config.json > learning.memoryScopes`
2. For each file-based scope (`user`, `project` — skip `session` which is in-memory):
   - Resolve the path (expand `~` to home directory)
   - List files in the directory (use Glob)
   - For each `.md` or `.json` file, measure file size
   - Count entries: for `.json` files parse and count top-level keys/array items; for `.md` files count `## ` or `- [` lines as rough entry proxies
3. Flag oversized files (> 500KB) or empty stores (0 entries)
4. Report: store count, total entries, total size, warnings

### Check 7: Explainability Health

Read-only. This check exists because the decision record had no reader at all:
`getDecisionStats` and `queryDecisions` were exported from `lib/core/index.js`
and consumed by nothing, so the trail sat empty in production and nobody
noticed. A store nobody reads cannot report its own outage.

1. **Decision trail** — import `getDecisionStats` from `lib/core/decision-trail.js`
   and read `totalDecisions`, `last24h`, and `bySubsystem`. It is `async`
   (`decision-trail.js#getDecisionStats`) — **await it**. Reading the returned
   promise's properties directly yields `undefined` for every field, and
   `undefined === 0` is false, so S3's conjunct would silently never fire again
   while the step still printed a plausible-looking line.
   It never throws: a missing or unparseable trail is caught and returned as
   `{ totalDecisions: 0, bySubsystem: {}, byAction: {}, last24h: 0 }` (verified
   2026-08-30 against an empty plugin root), so a zero here does not distinguish
   "no trail file" from "trail present but empty" — step 5 reports the file's
   existence separately for that reason.
2. **Decision events** — resolve `runtime/decisions/`
   (`lib/observability/decision-events.js#getDecisionStoreDir`) and record which
   of three states it is in: `absent` (no directory) / `empty` (directory but no
   `*.events.ndjson`) / `populated`. `getDecisionStoreDir` only joins a path, so
   the directory comes into existence on the first write — `absent` and `empty`
   therefore mean the same thing here, "nothing was ever recorded under this
   root", and neither is the more reassuring of the two.

   Then count, SEPARATELY, the files and lines whose `sessionId` does NOT begin
   with `diag-`. Only those are evidence of live firing. A diagnostic run writes
   byte-identical lines through the same code path, so counting them would let a
   single verification run flip this store out of every "nothing was recorded"
   condition below. Measured 2026-08-30, that is exactly what happened: the
   store's first and only file was `diag-installed-verify-01.events.ndjson`,
   written to confirm the wiring fix.

   For lines that qualify, note how many fall in the last 24h and the newest
   `ts` across files.
3. **Wiring probe (S4)** — read the two call sites in the INSTALLED tree:
   `lib/runtime/middleware/router.js` and `lib/runtime/middleware/tasks.js`.
   Each must hand `resolveDecisionRunId` an object that actually carries the hook
   payload — `state.input`, which holds `hookData`. Warn when either passes
   `state.context` instead: that object carries neither `hookData` nor
   `sessionId`, so every call resolves to `null`, is counted as `skipped`, and
   nothing is ever written. This warns regardless of every timestamp below,
   because it is a structural fact rather than an inference from absence.
   The probe exists because /doctor reads the INSTALLED plugin while the test
   suite runs against the repo. Measured 2026-08-30: the repo was fixed and fully
   green while the install still carried the broken call sites, and no
   timestamp-based step could tell the two apart.
4. **Absence check (S3)** — absence of records means nothing unless something
   should have been recorded, so judge it against an activity timestamp. Take the
   NEWEST of the following, skipping any that cannot be read:
   - `runtime/current-effort.json` — the `updatedAt` field, written by
     `persistEffortMeta` (`scripts/hooks/runtime-prompt.js#persistEffortMeta`) on
     every slash-command prompt.
   - `runtime/current-effort.json` — the file's own mtime.
   - `runtime/decision-trail.json` — `metadata.lastUpdated`.

   Use the newest rather than any single source. Measured 2026-08-29, that file's
   mtime (2026-08-23) and its `updatedAt` (2026-07-10) disagreed by 44 days even
   though the sole writer stamps both in one call, so the mtime is moving without
   the writer. The mechanism was traced to test fixtures rewriting the file's
   original bytes in `afterEach` — see the S3 entry under "What this check cannot
   see" for how far that tracing goes. Either way at least one source is
   unreliable, so take the maximum: that fails toward "there was activity", which
   can only make this check warn more readily, never less.

   Warn when that newest timestamp is within 24h AND step 1 reports
   `last24h === 0` AND step 2 counts zero non-`diag-` event lines in the same
   window.
5. Report: the resolved plugin root (absolute), whether
   `runtime/decision-trail.json` exists, trail entries (total / last 24h), the
   `runtime/decisions/` state, its total and non-`diag-` line counts for the last
   24h, the newest record timestamp, which activity source was newest, which
   activity sources were missing, and any S3 / S4 / S5 / S6 warning.

Status for this check — **first matching row wins**:

| Condition | Status |
|---|---|
| A store exists but cannot be read or parsed | **fail** |
| S4 — either call site passes `state.context` | **warn** |
| S5 — no `*.events.ndjson` with a non-`diag-` `sessionId` has ever been written under this root | **warn** |
| S6 — live records exist but `runtime/decision-trail.json` does not | **warn** |
| S3 — activity within 24h, but zero trail entries and zero non-`diag-` event lines in it | **warn** |
| Otherwise | **pass** |

S5 covers `absent`, `empty`, and diag-only in one condition, and it is NOT
conditioned on S4 passing: a store with no live record is worth saying out loud
whether or not the wiring reads correctly, because wiring that looks right and
has still never fired is the more interesting of the two. When S5 fires, say in
the report whether `runtime/decision-trail.json` also exists — S5 plus a missing
trail means this root holds no recording evidence of any kind, which is as much a
sign of reading the wrong tree as of a broken recorder.

Trail absence is deliberately not an UNCONDITIONAL warn. It has never existed
under `~/.claude/artibot/` (measured 2026-08-30), so a bare row for it would fire
forever on the installed tree — the desensitization this check is trying to
avoid. S6 conditions it on live records already existing, and that condition is
what turns it from noise into a signal: both stores are written under the same
resolved root, so records landing in one while the other was never even created
means that writer is dead rather than that the root is new. On a root with no
live records S6 cannot fire and S5 covers the case instead.

Also deliberately NOT a warn: a store holding real (non-`diag-`) records whose
newest entry predates the 24h window, with no activity signal inside it either.
That is an idle machine.

**What this check cannot see** (§9 — state it next to the gate):

- **That any particular decision was recorded.** It reads counts and timestamps.
  Two decision points are wired (routing classification and workflow plan), so a
  green result says the path is alive, not that coverage is complete.
- **Whether a real session or a diagnostic produced the records — beyond the
  naming convention.** S5 separates them by the `diag-` prefix, which holds only
  as long as diagnostics keep using it. A synthetic `preparePrompt` run writes
  byte-identical lines through the same code path, so a diagnostic that forgets
  the prefix is indistinguishable from a live session and will silence S5. When
  writing a verification run, prefix the session id.
- **Whether the S3 activity signal reflects prompts or file churn.** Measured
  2026-08-30 on the repo tree, `current-effort.json` had an mtime from that same
  morning while its `updatedAt` still read 2026-07-10. The best available account
  is that test fixtures refresh the mtime by rewriting the file's original bytes
  in `afterEach`: the mechanism was reproduced in an equivalent standalone
  experiment, and all 5 files a suite restores that way match the observed
  cluster, down to identical nanosecond mtimes. What was NOT done is the direct
  reproduction — running the suite and watching this file's mtime move. So treat
  the cause as well-evidenced, not measured end to end.
  Whatever the cause, the consequence is what matters here: because S3 takes the
  maximum, a tree whose tests run often reads as "active" almost always, so on an
  otherwise idle tree S3 can degrade into a standing warn. That is the fail-safe
  direction, but it is the same desensitization risk this check warns about
  elsewhere; prefer S4 and S5 as the load-bearing signals and treat a lone S3
  warn as a prompt to check which activity source was newest.
- **Whether the activity sources are themselves telling the truth.** S3 assumes
  at least one of its three timestamps reflects real prompt activity. The bullet
  above shows one of them moving for a reason unrelated to prompts; the mirror
  failure is equally possible — if all three went stale while prompts kept
  arriving, S3 would stay silent while recording was broken. S4 and S5 are the
  steps that depend on no timestamp at all.
- **Anything when none of the activity sources exists.** Measured 2026-08-30,
  the installed tree (`~/.claude/artibot/runtime/`) has neither
  `current-effort.json` nor `decision-trail.json`, while the repo tree has both.
  Under a plugin root like that, S3 can never fire and only S4 and S5 are
  load-bearing. Report which activity sources were missing rather than reporting
  "no activity".
- **A recorder that stops after it once worked.** S5 is a latch: it asks whether
  a live record has EVER appeared under this root, so the first real one silences
  it permanently, even if recording breaks the next day. Ongoing detection is
  S3's job — and on a root with no activity sources (the case directly above) S3
  cannot fire at all, which leaves that root with no continuous watcher once S5
  has latched. Closing this would take a time-windowed row, and a time window
  needs activity evidence, which is the thing that root does not have. Until
  something supplies it, re-run the wiring probe rather than trusting a pass.
- **Which runtime directory it read.** Every path here resolves through
  `getPluginRoot()`, and the /doctor process does not necessarily resolve it to
  the same tree the prompt hooks write to. State the resolved absolute path in
  the report so a reader can tell whether an empty store means "nothing was
  recorded" or "you looked in the other tree".
- **Anything about the repo working tree.** A fixed repo and a stale install are
  indistinguishable to every step except S4.

## Output Format

```
ARTIBOT HEALTH CHECK
=====================

[check-1-icon] Config: v{version}, {n} agents, {n} skills, {n} commands
[check-2-icon] Agents: {present}/{referenced} files present
[check-3-icon] Skills: {n} verified ({n} hash mismatches)
[check-4-icon] Hooks: {n} dispatchers, {n} scripts
[check-5-icon] MCP: {server1} ({status}), {server2} ({status})
[check-6-icon] Memory: {n} stores, {n} entries, {size} total
[check-7-icon] Explainability: {n} trail entries (24h), {n} event lines (24h), last {timestamp}

Status: {HEALTHY|DEGRADED|UNHEALTHY} ({passed}/{total} checks passed)
```

Status logic:
- **HEALTHY**: All 7 checks passed (zero errors)
- **DEGRADED**: 5-6 checks passed (warnings present)
- **UNHEALTHY**: 4 or fewer checks passed

Use checkmark for passed checks, cross for failed checks, warning sign for checks with non-critical issues.

If `--verbose` is set, expand each check section with per-item details (e.g., list every agent file, every skill hash comparison, every hook script parse result).

If `--json` is set, output a structured JSON object:
```json
{
  "timestamp": "ISO-8601",
  "version": "4.13.1",
  "checks": {
    "config": { "status": "pass", "details": {} },
    "agents": { "status": "pass", "details": {} },
    "skills": { "status": "pass", "details": {} },
    "hooks":  { "status": "pass", "details": {} },
    "mcp":    { "status": "warn", "details": {} },
    "memory": { "status": "pass", "details": {} },
    "explainability": { "status": "pass", "details": {} }
  },
  "summary": { "passed": 7, "total": 7, "status": "HEALTHY" }
}
```

## Error Handling

- If `artibot.config.json` cannot be read or parsed, abort all checks and report a critical error — config is the foundation for checks 2-7
- If a specific check fails mid-execution (e.g., file I/O error), mark that check as FAIL and continue to the next check
- Never let a single check failure prevent the remaining checks from running

## Self-Heal (`--fix` / `--dry-run`)

When `--fix` (or `--dry-run`) is passed, after the 7 diagnostic checks above complete, route the collected failures through the self-heal layer in `lib/core/doctor-fix.js`. This is built for the non-developer ("vibe coder") who hits a sudden "it stopped working" wall and wants a one-shot recovery.

### Invocation

Import the module with a Korean-path-safe `file://` URL (the plugin root contains non-ASCII path segments — never pass a bare relative path to `import()`; build `file:///` manually as in `scripts/utils/index.js > toFileUrl()`):

```js
const { runDoctorFix } = await import(toFileUrl(join(pluginRoot, 'lib/core/doctor-fix.js')));
// dryRun defaults to TRUE — pass { dryRun: false } only under --fix.
const report = runDoctorFix(diagnostics, { dryRun: !hasFixFlag });
```

`diagnostics` is the array of failed-check codes (or `{ code, ...payload }` objects) gathered from checks 1-6. Map each failure to its self-heal code:

| Diagnostic code | From check | Severity | Repair action |
|---|---|---|---|
| `missing-runtime-dir` / `missing-memory-dir` / `missing-dir` | 1, 6 | auto | Recreate the directory (mkdir recursive) |
| `broken-config-json` / `broken-json` | 1, 6 | auto | Back up the corrupt file to `<file>.broken-<ts>`, then rewrite the default |
| `marketplace-mirror-stale` | 4 | auto | Re-sync the marketplace mirror (degrades to manual guidance if no mirror routine is injected) |
| `orphan-lock` | 4 | auto | Release a stale autopilot lock (degrades to manual guidance if no releaser is injected) |
| `hook-registration-missing` | 4 | **manual** | NEVER auto-applied — surfaces candidate `settings.json` paths for the user to wire |

### Safety contract (hard rules)

- **dryRun defaults to TRUE** — the filesystem is mutated only when `--fix` is passed (i.e. `{ dryRun: false }`). `--dry-run` and bare invocation both preview only.
- **Never destructive** — no deletes, no overwrite-without-backup, no git operations. Corrupt JSON is always backed up to `<file>.broken-<ts>` before any rewrite.
- **Never touches user settings** — `~/.claude/settings.json` is read-only to the self-heal layer; hook-registration gaps are surfaced as MANUAL guidance only.
- **100% local** — zero external network calls (DATA POLICY).
- **Never throws** — each repair is try-isolated; one failure cannot abort the rest of the pass.

### Output

`runDoctorFix` returns `{ dryRun, fixed[], skipped[], manual[] }`. Render it as a Korean-facing summary after the health-check report:

- `fixed[]` — repairs applied (or, under dry-run, what would be applied)
- `skipped[]` — no-ops (already healthy / no mapped action / unknown code)
- `manual[]` — actions requiring the user (hook registration, missing mirror/lock routines)

Under `--dry-run`, prefix the section with a clear "미리보기 (아무것도 변경하지 않음)" banner so the user knows nothing was written.

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Fix config issues | `/setup` | Re-run setup wizard to correct config |
| 2 | Rebuild skill cache | Run `buildSkillHashCache()` | Refresh stale or missing hash cache |
| 3 | Investigate failures | `/troubleshoot` | Deep-dive into specific failing checks |
| 4 | Full verification | `/verify` | Run lint + typecheck + test pipeline |
