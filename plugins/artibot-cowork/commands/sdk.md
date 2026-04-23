---
description: (Artibot Cowork) SDK scaffolding — create custom skills and agents for the Artibot Cowork plugin
argument-hint: '<action> <name> e.g. "create-skill my-research" or "create-agent my-specialist"'
allowed-tools: [Read, Write, Glob, Grep]
toolset: sdk
---

# /sdk

Artibot Cowork SDK — create custom skills and agents for your Cowork plugin.

> **Cowork Note**: This is the Cowork-adapted SDK. It supports `create-skill` and `create-agent` only. Hook and middleware creation require the full CLI plugin (`artibot`).

## Arguments

Parse $ARGUMENTS:
- `action`: Required. One of: `create-skill`, `create-agent`, `validate`
- `name`: Required for create actions. Must be kebab-case (e.g. `my-research-skill`)
- `--category [name]`: Skill category (default: `custom`)
- `--model [tier]`: Agent model tier: `opus`, `sonnet`, `haiku` (default: `sonnet`)
- `--dry-run`: Show what would be created without writing files

## Execution Flow

1. **Decompose**: Parse action, name, and flags.
2. **Validate Input**: Confirm action is recognized. For create actions, confirm name is provided and kebab-case.
3. **Execute Action**: Run the appropriate action handler (see below).
4. **Verify**: Re-read created files. Confirm content matches expectations.
5. **Report**: Output creation summary with file paths.

## Actions

### create-skill

Creates a new skill directory with SKILL.md scaffolding.

**Steps:**
1. Validate name is kebab-case (error if not: `"my-skill" is valid, "mySkill" is not`)
2. If `--dry-run`, display the generated content without writing files
3. Create directory: `skills/{name}/`
4. Write `skills/{name}/SKILL.md` with the template below
5. Re-read the written file to verify correctness
6. Report: created file path, next steps

**SKILL.md Template:**
```markdown
---
name: {name}
description: "TODO: One-line description used for auto-detection. Include triggers like: Use when user asks about X, Y, Z."
platforms: [claude-cowork, claude-code]
level: 2
triggers:
  - "TODO: add trigger phrase"
category: "custom"
---

# {Name}

## When This Skill Applies
- TODO: List specific trigger conditions

## Core Guidance

### Process
1. TODO: Step 1
2. TODO: Step 2
3. TODO: Step 3

## Output Format
```
TODO: Define expected output structure
```

## Quick Reference
**Key concepts**: TODO
```

### create-agent

Creates a new agent definition .md file.

**Steps:**
1. Validate name is kebab-case
2. Determine model: from `--model` flag or default `sonnet`
3. If `--dry-run`, display the generated content without writing files
4. Write `agents/{name}.md` with the template below
5. Re-read the written file to verify correctness
6. Report: created file path, next steps

**Agent Template:**
```markdown
---
name: {name}
description: |
  {Name} specialist for [domain]. [2-line capability summary]

  Use proactively when [trigger conditions].

  Triggers: [keyword list], [한국어 키워드]

  Do NOT use for: [exclusions]
model: {model}
tools:
  - Read
  - Write
  - WebSearch
  - SendMessage
  - TaskUpdate
  - TaskList
  - TaskGet
permissionMode: default
maxTurns: 20
category: support
---

## Core Responsibilities

1. **[Responsibility 1]**: TODO
2. **[Responsibility 2]**: TODO

## Process

| Step | Action | Output |
|------|--------|--------|
| 1. Research | TODO | TODO |
| 2. Analyze | TODO | TODO |
| 3. Deliver | TODO | TODO |

## Output Format

```
TODO: Define output format
```

## Team Collaboration

When running as a teammate in an agent team:

1. **On Start**: Call `TaskList()` to find tasks assigned to you
2. **Claim Work**: `TaskUpdate(taskId, status="in_progress")`
3. **Report Progress**: `SendMessage(type="message", recipient="<team-lead>")`
4. **Complete Work**: `TaskUpdate(taskId, status="completed")` then `SendMessage` summary
5. **Shutdown**: On `shutdown_request`, complete task and respond with `shutdown_response`

## Anti-Patterns

- Do NOT [anti-pattern 1]
- Do NOT [anti-pattern 2]
```

### validate

Validates all custom extensions in the current plugin.

**Steps:**
1. Scan `skills/` for `SKILL.md` files
2. Scan `agents/` for `.md` files
3. For each skill: check frontmatter has `name`, `description`, `triggers`
4. For each agent: check frontmatter has `name`, `description`, `model`
5. Report: validation results per item — `PASS` or `FAIL` with specific errors

## Error Handling

- **Invalid kebab-case name**: `"my-custom-skill" is valid, "myCustomSkill" is not`
- **Missing action**: Show available actions: `create-skill`, `create-agent`, `validate`
- **Missing name**: `Name is required. Usage: /sdk create-skill my-tool`
- **Invalid --model value**: Valid options: `opus`, `sonnet`, `haiku`

## Output Format

```
SDK RESULT
==========
Action:     [action performed]
Name:       [extension name]
Status:     [CREATED|VALIDATED|FAILED]
File:       [created file path]
Validation: [PASS|FAIL] (errors listed if any)

NEXT STEPS
----------
[Context-specific guidance]
```

## Examples

```
/sdk create-skill competitor-tracker
/sdk create-skill competitor-tracker --category research --dry-run
/sdk create-agent brand-analyst --model opus
/sdk validate
```

## Next Steps

| # | Action | Description |
|---|--------|-------------|
| 1 | Edit the scaffold | Fill in TODO placeholders |
| 2 | Validate | `/sdk validate` — confirm extension passes validation |
| 3 | Test | Use the skill or mention the agent to trigger it |
