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
   and read `totalDecisions`, `last24h`, and `bySubsystem`.
2. **Decision events** — list `runtime/decisions/*.events.ndjson`
   (`lib/observability/decision-events.js`). Count lines written in the last 24h
   and note the newest `ts` across files.
3. **Absence check (S3)** — read `runtime/current-effort.json`. Its `updatedAt`
   is written by `persistEffortMeta` on every slash-command prompt
   (`scripts/hooks/runtime-prompt.js:62-74`), so it dates the last prompt that
   should have produced a trail entry. Warn when that timestamp is within 24h
   but step 1 reports `last24h === 0` — that pairing means recording is broken,
   not merely idle. Absence of records is only meaningful against evidence that
   something should have been recorded.
4. Report: trail entries (total / last 24h), decision-event lines (last 24h),
   newest record timestamp, and any S3 warning.

Status for this check:
- **pass** — records exist in the last 24h, or no slash command fired in that window
- **warn** — zero records but a slash command fired within 24h (S3), or the stores are missing entirely
- **fail** — reserved for an unreadable/corrupt store; a merely empty one is a warning, not a failure

Do not treat a green result as proof that every decision is recorded. Only two
decision points are wired (routing classification and workflow plan); this check
reports whether the recording path is alive, not whether its coverage is complete.

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
