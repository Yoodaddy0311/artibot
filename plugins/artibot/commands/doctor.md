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
- (no argument): Run all 6 checks
- `config`: Check 1 only — config validation
- `agents`: Check 2 only — agent file presence
- `skills`: Check 3 only — skill hash integrity
- `hooks`: Check 4 only — hook health
- `mcp`: Check 5 only — MCP connectivity
- `memory`: Check 6 only — memory store health
- `--verbose`: Show per-item details (not just summary lines)
- `--json`: Output results as a JSON object instead of the formatted report

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

Status: {HEALTHY|DEGRADED|UNHEALTHY} ({passed}/{total} checks passed)
```

Status logic:
- **HEALTHY**: All 6 checks passed (zero errors)
- **DEGRADED**: 4-5 checks passed (warnings present)
- **UNHEALTHY**: 3 or fewer checks passed

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
    "memory": { "status": "pass", "details": {} }
  },
  "summary": { "passed": 6, "total": 6, "status": "HEALTHY" }
}
```

## Error Handling

- If `artibot.config.json` cannot be read or parsed, abort all checks and report a critical error — config is the foundation for checks 2-6
- If a specific check fails mid-execution (e.g., file I/O error), mark that check as FAIL and continue to the next check
- Never let a single check failure prevent the remaining checks from running

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Fix config issues | `/setup` | Re-run setup wizard to correct config |
| 2 | Rebuild skill cache | Run `buildSkillHashCache()` | Refresh stale or missing hash cache |
| 3 | Investigate failures | `/troubleshoot` | Deep-dive into specific failing checks |
| 4 | Full verification | `/verify` | Run lint + typecheck + test pipeline |
