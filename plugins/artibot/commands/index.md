---
description: (Artibot) Browse and search available commands, agents, skills, and plugin capabilities
argument-hint: '[query] e.g. "사용 가능한 명령어 검색"'
allowed-tools: [Read, Glob, Grep]
toolset: meta
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
2. **Scan**: Read available plugin resources under the plugin root (see **Plugin root** below):
   - Commands: `<pluginRoot>/commands/*.md` frontmatter
   - Agents: `<pluginRoot>/agents/*.md` frontmatter
   - Skills: `<pluginRoot>/skills/*/SKILL.md` frontmatter
3. **Filter**: If query provided, match against names, descriptions, and triggers
4. **Format**: Output organized catalog with cross-references
5. **Suggest**: If query matches no exact results, suggest closest alternatives

### Plugin root

The working directory is usually the user's project, not this plugin, so the source-repo layout (`plugins/artibot/commands/`, `plugins/artibot/agents/`, `plugins/artibot/skills/`) only exists inside the Artibot source repo and would give an empty catalog anywhere else. This command has no Bash tool, so find `<pluginRoot>` with `Glob`; the first hit wins:

1. The plugin root the host filled in when this command loaded: `${CLAUDE_PLUGIN_ROOT}`. Use it when it is an absolute path that holds `commands/index.md`; if it still shows a variable reference instead of a path, go to 2
2. `Glob` `plugins/artibot/commands/index.md`. A hit means the working directory is the Artibot source repo, so `<pluginRoot>` is `plugins/artibot`
3. `Glob` `*/commands/index.md` with `path` `~/.claude/plugins/cache/artibot/artibot`. `<pluginRoot>` is the version directory of the hit; with several hits take the highest version number
4. `Glob` `*/plugins/artibot/commands/index.md` with `path` `~/.claude/plugins/marketplaces`. `<pluginRoot>` is the `plugins/artibot` directory of the hit

If none of these hits, say `artibot plugin root not found - run /update` and stop. Do not print an empty catalog.

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

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 상세 설명 | `/explain` | 선택한 기능 상세 설명 |
| 2 | 기능 구현 | `/implement` | 선택한 기능 구현 시작 |
| 3 | 프로젝트 로드 | `/load` | 프로젝트 컨텍스트 로드 |
