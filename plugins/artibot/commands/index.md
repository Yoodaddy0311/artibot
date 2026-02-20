---
description: Browse and search available commands, agents, skills, and plugin capabilities
argument-hint: '[query] e.g. "사용 가능한 명령어 검색"'
allowed-tools: [Read, Glob, Grep]
---

# /index

Interactive catalog for discovering available commands, agents, skills, and their capabilities. Provides quick lookup and cross-referencing.

## Arguments

Parse $ARGUMENTS:
- `query`: Search term to filter results (optional, shows all if omitted)
- `--category [type]`: `commands` | `agents` | `skills` | `flags` | `all` (default: `all`)
- `--verbose`: Show full descriptions instead of summaries

## Execution Flow

1. **Parse**: Extract query and category filter
2. **Scan**: Read available plugin resources:
   - Commands: `plugins/artibot/commands/*.md` frontmatter
   - Agents: `plugins/artibot/agents/*.md` frontmatter
   - Skills: `plugins/artibot/skills/*/SKILL.md` frontmatter
3. **Filter**: If query provided, match against names, descriptions, and triggers
4. **Format**: Output organized catalog with cross-references
5. **Suggest**: If query matches no exact results, suggest closest alternatives

## Catalog Structure

### Commands
Extract from each command file:
- Name (from filename)
- Description (from frontmatter)
- Argument hint (from frontmatter)
- Related agents and skills

### Agents
Extract from each agent file:
- Name and role
- Specialization areas
- Activation triggers

### Skills
Extract from each SKILL.md:
- Name and description
- Auto-activation triggers
- Related commands

## Output Format

```
ARTIBOT INDEX
=============
Query: [search term or "all"]

COMMANDS ([n] available)
------------------------
/[name]        [description]
  args: [argument-hint]

AGENTS ([n] available)
----------------------
[name]         [role/specialization]
  triggers: [activation keywords]

SKILLS ([n] available)
----------------------
[name]         [description]
  triggers: [auto-activation conditions]

FLAGS
-----
[flag]         [purpose]
```
