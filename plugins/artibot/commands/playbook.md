---
description: (Artibot) Browse, inspect, and manage orchestration playbooks
argument-hint: 'list|info <name> [--domain development|marketing|security|quality]'
allowed-tools: [Read]
---

# /sc playbook

Browse and inspect Artibot orchestration playbooks. Playbooks define multi-phase team workflows such as feature implementation, security audits, and marketing campaigns.

## Arguments

Parse $ARGUMENTS:
- `list` - List all available playbooks (default action)
- `info <name>` - Show detailed information and phase diagram for a named playbook
- `--domain [domain]` - Filter by domain: `development` | `marketing` | `security` | `quality` | `general`

## Execution Flow

### `list` (default)
1. **Load**: Read system playbooks from `artibot.config.json` → `team.playbooks`
2. **Load**: Read user playbooks from `~/.claude/artibot/playbooks/`
3. **Filter**: Apply `--domain` filter if provided
4. **Format**: Output table with name, domain, phase count, and patterns

### `info <name>`
1. **Find**: Locate playbook by name across system and user sources
2. **Parse**: Display parsed phases with pattern and action labels
3. **Diagram**: Render ASCII phase flow diagram
4. **Validate**: Show validation status

## Output Format

### list
```
PLAYBOOKS
=========
Filter: [domain or "all"]
Source: system + user

NAME                  DOMAIN        PHASES  PATTERNS
----                  ------        ------  --------
feature               development   5       leader, council, swarm
bugfix                development   3       leader, pipeline, council
refactor              development   4       council, pipeline, swarm
security              security      4       leader, council, pipeline
marketing-campaign    marketing     5       leader, council, swarm
...

Total: [n] playbooks ([s] system, [u] user)
```

### info <name>
```
PLAYBOOK: [name]
================
Description: [description]
Domain:      [domain]
Source:      [system|user]
Phases:      [n]
Patterns:    [pattern1, pattern2, ...]
Tags:        [tag1, tag2, ...]

PHASE DIAGRAM
-------------
[leader] plan → [council] design → [swarm] implement → [council] review → [leader] merge
  Phase 0          Phase 1            Phase 2              Phase 3          Phase 4

VALIDATION
----------
Status: valid / [error list]
```
