---
description: (Artibot) Federated Swarm Intelligence - manage collective learning participation
argument-hint: '<action> e.g. "status", "sync", "health", "stats", "opt-in", "opt-out"'
allowed-tools: [Read, Bash, Glob, Grep]
argument-hint: '[action] e.g. "스웜 동기화 상태 확인"'
allowed-tools: [Read, Bash, TaskCreate]
disable-model-invocation: true
toolset: team
---

# /swarm

Manage Artibot's federated swarm intelligence — cross-machine pattern sharing.

## Arguments

Parse $ARGUMENTS:
- `action`: Required. One of: `status`, `sync`, `health`, `stats`, `opt-in`, `opt-out`
- `--force`: Force sync even if recently synced

## Current State Detection

Before any action, check the current swarm state:
1. Import `isSwarmActive` and `getSwarmConfig` from `lib/swarm/swarm-config.js`
2. Import `loadConfig` from `lib/core/config.js`
3. Load config, check opt-in status

## Actions

### status
Show current swarm sync status.

**Steps:**
1. Import `getSyncStatus` from `lib/swarm/sync-scheduler.js`
2. Import `getSwarmConfig` from `lib/swarm/swarm-config.js`
3. Display:
   - Opt-in status (active/inactive)
   - Last sync timestamp
   - Sync interval (session/hourly/daily)
   - Pending uploads/downloads
   - Server URL (if configured)

### sync
Force a full bidirectional sync cycle (upload + download + merge).

**Steps:**
1. Check opt-in first — refuse if not opted in
2. Import `forceSync` from `lib/swarm/sync-scheduler.js`
3. Run `forceSync({ config: swarmCfg })`
4. Report: uploaded version, downloaded version, merge result

### health
Check swarm server health.

**Steps:**
1. Import `checkHealth` from `lib/swarm/swarm-client.js`
2. Call `checkHealth({ config: swarmCfg })` — resolves server URL from config internally
3. Report: server status (healthy/degraded/unreachable), latency in ms

### stats
Show contribution statistics.

**Steps:**
1. Import `getContributionStats` from `lib/swarm/swarm-client.js`
2. Call `getContributionStats(clientId, { config: swarmCfg })` — clientId from swarm config
3. Display:
   - Patterns contributed (uploads)
   - Patterns received (downloads)
   - Contribution rank
   - Success indicator

### opt-in
Enable swarm participation.

**Steps:**
1. Import `optIn` from `lib/swarm/swarm-config.js`
2. Call `optIn()`
3. Confirm: "Swarm participation enabled. Patterns will be shared anonymously."

### opt-out
Disable swarm participation.

**Steps:**
1. Import `optOut` from `lib/swarm/swarm-config.js`
2. Call `optOut()`
3. Confirm: "Swarm participation disabled. No patterns will be shared."

## Privacy Notice
Always show when discussing swarm:
- All shared patterns are anonymized (SHA-256 hashed, only first 12 chars used)
- PII is automatically stripped (user, email, hostname, IP, path)
- Only patterns with sufficient sample size and confidence qualify for upload
- Differential privacy noise applied (Laplacian mechanism, epsilon=1.0)
- Maximum 5MB per upload
- Opt-out is instant and permanent until re-opted in

## Error Handling

- **Not opted in**: Refuse sync/stats operations with clear message directing to `opt-in`
- **Network unavailable**: Queue upload for later, report offline status
- **Server unhealthy**: Show degraded status, skip sync
- **Sync already in progress**: Report and wait — do not start a second sync
- **Missing client ID**: Report error from `getContributionStats` — client ID required

## Output Format

```
SWARM STATUS
Participation: [active/inactive]
Last Sync:     [timestamp or "never"]
Sync Interval: [session/hourly/daily]
Pending:       [count] uploads, [count] downloads
Server:        [URL] ([healthy/degraded/unreachable], [latency]ms)
```

## Examples

```
/swarm status        -- check current swarm state
/swarm sync          -- force sync (upload + download + merge)
/swarm health        -- check server health and latency
/swarm stats         -- view contribution statistics
/swarm opt-in        -- enable swarm participation
/swarm opt-out       -- disable swarm participation
```

## Next Steps

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Review patterns | `/learn` | Inspect patterns received from swarm |
| 2 | Save checkpoint | `/checkpoint` | Checkpoint after sync |
| 3 | Apply patterns | `/improve` | Apply received patterns to codebase |
