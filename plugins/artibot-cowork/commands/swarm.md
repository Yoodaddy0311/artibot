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
Server:        [read from the profile — the CLI plugin defaults to
               http://localhost:3000 (self-hosted)]
Backend:       git (https://github.com/Yoodaddy0311/artibot-swarm.git)
Sync Interval: session
Note:          In Cowork, sync triggers at session boundaries when opted in.
```

No external endpoint ships as a default. A non-localhost server is used only
when the CLI plugin is given one explicitly via `ARTIBOT_SWARM_SERVER` and that
host is allowlisted there; Cowork cannot set either.

### health
Check swarm server health (informational).

**Output:**
```
SWARM HEALTH
============
Server:  [read from the profile — the CLI plugin defaults to
         http://localhost:3000 (self-hosted)]
Status:  [Guide the user to check that server's availability]
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
Explain that opt-in is not performed from Cowork, and where it is performed.

**Output:**
```
SWARM OPT-IN GUIDE
==================
Swarm participation cannot be enabled from Cowork.

Why: opting in requires writing a swarm profile and a swarm configuration
block, both of which are created and consumed by the full Artibot CLI
plugin. This Cowork package ships no configuration file, no runtime
scripts, and no background processes, so it has nothing to write or read
them with. This command is read-only by design.

To participate:

1. Install the full Artibot CLI plugin in Claude Code.
2. Run its `/swarm opt-in` command there and grant consent.
3. Return to Cowork — `/swarm status` here reports what it can read from a
   swarm profile, if one is present.

Privacy guarantees (these apply to the CLI plugin's uploads; Cowork itself
uploads nothing):
   - All patterns are anonymized (SHA-256, PII-stripped)
   - Differential privacy noise applied (Laplacian, ε=1.0)
   - Maximum 5MB per upload
   - Opt-out is instant and permanent until re-opted in
```

### opt-out
Explain the opt-out position of a Cowork-only user, and where opt-out is performed.

**Output:**
```
SWARM OPT-OUT GUIDE
===================
Swarm participation cannot be toggled from Cowork.

If you never opted in through the full Artibot CLI plugin, you are already
opted out. This Cowork package ships no runtime scripts and no background
processes, so it never uploads anything on its own.

If you did opt in from Claude Code, run `/swarm opt-out` there. Opt-out is
instant — no further patterns will be shared.
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
| 1 | Learn patterns | `swarm-intelligence` skill — understand what gets shared |
| 2 | Full management | Use CLI plugin for complete swarm control with live sync |
