---
description: (Artibot) Browse, inspect, and manage orchestration playbooks
argument-hint: 'list|info <name> [--domain marketing]'
allowed-tools: [Read]
---

# /playbook

Browse and inspect Artibot orchestration playbooks. Playbooks define multi-phase team workflows such as campaign execution, marketing audits, and competitive analysis.

## Arguments

Parse $ARGUMENTS:
- `list` - List all available playbooks (default action)
- `info <name>` - Show detailed information and phase diagram for a named playbook
- `--domain [domain]` - Filter by domain. Every playbook bundled with this plugin is `marketing`, so this filter only narrows results once you have added your own playbooks under `~/.claude/artibot/playbooks/`.

## Execution Flow

### `list` (default)
1. **Load**: Read the bundled playbooks from `agents/orchestrator.md` → the `## Playbooks` section. This plugin ships no `artibot.config.json`, so there is no `team.playbooks` config block to read — the orchestrator agent file is the only bundled source.
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
marketing-campaign    marketing     5       leader, council, swarm, pipeline, watchdog
marketing-audit       marketing     4       leader, swarm, council
content-launch        marketing     4       leader, swarm, pipeline
competitive-analysis  marketing     4       leader, swarm, council
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
[leader] plan → [council] design → [swarm] do → [pipeline] check → [watchdog] act
  Phase 0          Phase 1            Phase 2       Phase 3            Phase 4

VALIDATION
----------
Status: valid / [error list]
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 실행 계획 전개 | `/ultraplan` | 선택한 플레이북을 실행 계획으로 |
| 2 | 플레이북 분석 | `/analyze` | 플레이북 성과 및 효율 분석 |
| 3 | 진행 모니터링 | `/monitor` | 실행 상태와 지표 추적 |
