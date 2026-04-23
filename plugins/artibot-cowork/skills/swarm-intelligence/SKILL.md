---
context: fork
name: swarm-intelligence
description: |
  Federated Swarm Intelligence for collective learning across Artibot instances.
  Shares anonymized learning patterns (tool success rates, team compositions, workflow effectiveness)
  with the swarm network while preserving privacy through PII scrubbing and differential privacy.
  Enables all participants to benefit from collective experience without exposing individual data.
  Triggers: swarm, collective, federated, sync patterns, share learning, opt-in, contribution, 스웜, 집단지성
platforms: [claude-cowork, claude-code]
level: 2
triggers:
  - "swarm"
  - "collective"
  - "federated"
  - "sync patterns"
  - "share learning"
  - "스웜"
  - "집단지성"
agents:
  - "orchestrator"
tokens: "~2K"
category: "learning"
---

# Federated Swarm Intelligence

## When This Skill Applies
- User wants to understand or participate in collective learning across Artibot instances
- Checking contribution stats or sync status via `/swarm`
- Understanding how pattern sharing works with privacy protections
- Configuring swarm participation settings

## Core Guidance

### What Is Swarm Intelligence?

Federated learning approach where individual Artibot instances share anonymized learning patterns. Each instance contributes its local experience (what works, what fails) to a global pool, and in return receives the collective wisdom of all participants.

**Analogy**: Like a beehive where each bee shares information about flower locations without revealing its home.

### Data Flow

```
Local Patterns → PII Scrubber → Differential Privacy → Upload → Server Aggregation
                                                                       |
Local Merge ← Weight Conversion ← Integrity Check ← Download ←--------+
```

### What Gets Shared

| Category | Local Data | Shared Form |
|----------|-----------|-------------|
| Tool Usage | WebSearch: 92% success | `tools.WebSearch: {successRate: 0.92}` |
| Workflows | "campaign took 45m, 3 agents" | `workflows.campaign: {effectiveness: 0.85}` |
| Commands | "mkt used 30 times/session" | `commands.mkt: {frequency: 0.8, satisfaction: 0.9}` |
| Teams | "swarm pattern, 4 agents" | `teams.swarm: {effectiveness: 0.88, optimalSize: 4}` |

### Privacy Protections

1. **PII Scrubber**: Removes file paths, usernames, project names, API keys, URLs
2. **Differential Privacy**: Laplacian noise mechanism (epsilon = 1.0 default)
3. **Key Anonymization**: SHA-256 hashing of all identifiers (12-char prefix only)
4. **No Source Content**: Only statistical aggregates, never raw content
5. **Size Limit**: Maximum 5MB per upload
6. **Opt-in Only**: Zero data leaves the machine without explicit user consent

### Sync Lifecycle

**Session Start**:
1. Download latest global weights (delta from current version)
2. Verify checksum integrity
3. Merge into local patterns (30% local, 70% global by default)

**Session End**:
1. Package local patterns into normalized weights
2. Apply PII scrubber and differential privacy noise
3. Upload to swarm server (or queue if offline)

### Merge Strategy

| Setting | Default | Description |
|---------|---------|-------------|
| Local ratio | 30% | Weight given to this instance's own patterns |
| Global ratio | 70% | Weight given to collective patterns |
| Sync interval | session | When to sync: `session`, `hourly`, or `daily` |

### Cowork Usage (Guide-Only Mode)

In Cowork, swarm management is done via the `/swarm` command which provides a guide interface. Since Cowork runs without background scripts, sync operations happen at session boundaries when the command is invoked.

| Command | Action |
|---------|--------|
| `/swarm status` | View sync state and opt-in status |
| `/swarm opt-in` | Enable participation with consent |
| `/swarm opt-out` | Disable participation |
| `/swarm health` | Check server health |
| `/swarm stats` | View contribution statistics |

## Quick Reference

**Privacy guarantees**: PII-stripped, SHA-256 anonymized, Laplacian noise (ε=1.0), opt-in only
**Swarm server**: `https://artibot-swarm-154860486472.asia-northeast3.run.app`
**Backend**: git (`https://github.com/Yoodaddy0311/artibot-swarm.git`)
**Profile file**: `.claude-plugin/swarm-profile.json` (portable, safe to commit)

## Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "my instance's learnings are private" | anonymized patterns carry no PII — sharing success rates is epidemiology, not surveillance |
| "other instances learn different things" | that's the point — diversity exposes you to patterns your session never encountered |
| "swarm updates might degrade my experience" | validation gates and version pinning prevent poisoning; "might degrade" is an excuse for zero updates |
| "I'll join once the swarm is mature" | the swarm matures BY people joining; waiting is a coordination failure |
