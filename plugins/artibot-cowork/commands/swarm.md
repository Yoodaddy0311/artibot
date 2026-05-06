---
description: (Artibot Cowork) Federated Swarm Intelligence — manage collective learning participation
argument-hint: '<action> e.g. "status", "opt-in", "opt-out", "health", "stats"'
allowed-tools: [Read, WebSearch]
toolset: learning
---

# /swarm

Manage Artibot Cowork's federated swarm intelligence — cross-instance pattern sharing.

> **Cowork Note**: In Cowork, swarm operations are guide-based. Background sync scripts are not available. Use this command to understand your swarm status and manage participation.

## Arguments

Parse $ARGUMENTS:
- `action`: Required. One of: `status`, `health`, `stats`, `opt-in`, `opt-out`

## Current State Detection

Before any action, check the current swarm state by reading:
1. `.claude-plugin/swarm-profile.json` (if present) — portable swarm profile
2. User settings or environment for opt-in status

## Actions

### status
Show current swarm participation status.

**Output:**
```
SWARM STATUS
============
Participation: [active/inactive]
Profile:       [swarm-profile.json found/not found]
Server:        https://artibot-swarm-154860486472.asia-northeast3.run.app
Backend:       git (https://github.com/Yoodaddy0311/artibot-swarm.git)
Sync Interval: session
Note:          In Cowork, sync triggers at session boundaries when opted in.
```

### health
Check swarm server health (informational).

**Output:**
```
SWARM HEALTH
============
Server:  https://artibot-swarm-154860486472.asia-northeast3.run.app
Status:  [Guide the user to check the server URL for availability]
Note:    Full health check requires CLI plugin with network access.
```

### stats
Show contribution statistics (informational summary).

**Output:**
```
SWARM STATS
===========
Participation: [active/inactive based on swarm-profile.json]
Contributions: Patterns shared anonymously when opted in
Privacy:       SHA-256 hashed, PII-stripped, Laplacian noise (ε=1.0)
Note:          Detailed stats require CLI plugin with server access.
```

### opt-in
Explain how to enable swarm participation.

**Output:**
```
SWARM OPT-IN GUIDE
==================
To enable swarm participation in Cowork:

1. Ensure .claude-plugin/swarm-profile.json exists (auto-created by artibot CLI)
2. In artibot.config.json, set:
   {
     "swarm": {
       "enabled": true,
       "optIn": true,
       "syncInterval": "session"
     }
   }
3. Privacy guarantees:
   - All patterns are anonymized (SHA-256, PII-stripped)
   - Differential privacy noise applied (Laplacian, ε=1.0)
   - Maximum 5MB per upload
   - Opt-out is instant and permanent until re-opted in

Note: Full opt-in management available via CLI plugin `/swarm opt-in` command.
```

### opt-out
Explain how to disable swarm participation.

**Output:**
```
SWARM OPT-OUT GUIDE
===================
To disable swarm participation:

1. In artibot.config.json, set:
   {
     "swarm": {
       "enabled": false,
       "optIn": false
     }
   }
2. Or delete .claude-plugin/swarm-profile.json to remove the portable profile.

Note: Full opt-out management available via CLI plugin `/swarm opt-out` command.
Opt-out is instant — no further patterns will be shared.
```

## Privacy Notice

Always show when discussing swarm:
- All shared patterns are anonymized (SHA-256 hashed, only first 12 chars used)
- PII is automatically stripped (user, email, hostname, IP, path)
- Only patterns with sufficient sample size and confidence qualify for upload
- Differential privacy noise applied (Laplacian mechanism, epsilon=1.0)
- Maximum 5MB per upload
- Opt-out is instant and permanent until re-opted in

## Output Format

```
SWARM STATUS
Participation: [active/inactive]
Profile:       [found/not found]
Server:        [URL]
Privacy:       SHA-256 + Laplacian DP (ε=1.0)
```

## Examples

```
/swarm status        -- check current participation state
/swarm health        -- check server availability
/swarm stats         -- view contribution summary
/swarm opt-in        -- guide to enable swarm participation
/swarm opt-out       -- guide to disable swarm participation
```

## Next Steps

| # | Action | Description |
|---|--------|-------------|
| 1 | Learn patterns | `/swarm-intelligence` skill — understand what gets shared |
| 2 | Full management | Use CLI plugin for complete swarm control with live sync |
