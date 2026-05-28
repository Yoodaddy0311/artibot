---
description: (Artibot) SDK scaffolding for creating custom skills, agents, hooks, and middleware plugins
argument-hint: '<action> <name> e.g. "create-skill my-tool"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep]
---

# /sdk

Artibot SDK — create custom extensions for the Artibot ecosystem.

## Arguments

Parse $ARGUMENTS:
- `action`: Required. One of: `create-skill`, `create-agent`, `create-hook`, `create-middleware`, `validate`, `scaffold`
- `name`: Required for create actions. Must be kebab-case (e.g. `my-custom-skill`)
- `--category [name]`: Skill category (default: 'custom')
- `--model [tier]`: Agent model tier: opus, sonnet, haiku (default: 'sonnet')
- `--event [type]`: Hook event type (default: 'PostToolUse')
- `--dry-run`: Show what would be created without writing files

## Execution Flow

1. **Decompose**: Break user request into numbered items. Parse action, name, and flags.
2. **Validate Input**: Confirm action is recognized. For create actions, confirm name is provided and kebab-case.
3. **Execute Action**: Run the appropriate action handler (see below).
4. **Verify**: Re-read created files. Confirm content matches expectations. Check every item from step 1.
5. **Report**: Output creation summary with file paths and validation status.

## Actions

### create-skill

Creates a new skill directory with SKILL.md scaffolding.

**Steps:**
1. Validate name is kebab-case
2. Call `createSkill()` from `lib/sdk/artibot-sdk.js` with spec:
   - `name`: from argument
   - `description`: ask user or use default `"Custom skill: {name}"`
   - `category`: from `--category` flag or `'custom'`
   - `triggers`: `[name, name-with-spaces]` (convert kebab to space-separated)
   - `body`: default template (see below)
3. If `--dry-run`, display the generated `skillMd` and `dirName` — do NOT write files
4. Otherwise create directory: `skills/{name}/`
5. Write `skills/{name}/SKILL.md` with the returned `skillMd` content
6. Re-read the written file to verify correctness
7. Report: created file path, validation status

**Default body template for SKILL.md:**
```
# {Name}

TODO: Describe what this skill does.

## When to use
- TODO: Add trigger conditions

## Execution
1. TODO: Add execution steps

## Verification
- TODO: Define how to verify this skill's output
```

### create-agent

Creates a new agent definition .md file.

**Steps:**
1. Validate name is kebab-case
2. Call `createAgent()` from `lib/sdk/artibot-sdk.js` with spec:
   - `name`: from argument
   - `role`: `"{Name} Specialist"` (convert kebab to title case, e.g. `my-tool` -> `My Tool Specialist`)
   - `model`: from `--model` flag or `'sonnet'` — must be one of: opus, sonnet, haiku
   - `body`: default template (see below)
3. If `--dry-run`, display the generated `agentMd` and `fileName` — do NOT write files
4. Otherwise write `agents/{fileName}` using the returned `fileName` (e.g. `agents/my-tool.md`)
5. Re-read the written file to verify correctness
6. Report: created file path, validation status

**Default body template for agent:**
```
## Responsibilities
- TODO: Define this agent's primary responsibilities

## Process
1. TODO: Add execution steps

## Quality Checklist
- [ ] TODO: Add quality gates specific to this agent
```

### create-hook

Creates a new hook script with hooks.json registration guidance.

**Steps:**
1. Validate name is kebab-case
2. Call `createHook()` from `lib/sdk/artibot-sdk.js` with spec:
   - `event`: from `--event` flag or `'PostToolUse'` — must be one of: PreToolUse, PostToolUse, PreCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentSpawned, InstructionsLoaded
   - `name`: from argument
   - `description`: `"Custom hook: {name}"`
   - `script`: default ESM template (see below)
3. If `--dry-run`, display the generated `scriptContent` and `registration` JSON — do NOT write files
4. Otherwise write `scripts/hooks/{name}.js` with the returned `scriptContent`
5. Display the returned `registration` object as JSON so the user can add it to `hooks/hooks.json`
6. Re-read the written file to verify correctness
7. Report: created file path, registration JSON for manual addition

**Default ESM script template:**
```js
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));

// TODO: Implement hook logic
// Available input fields depend on the event type.
// See hooks/hooks.json for examples.

const result = {
  decision: 'approve',
  reason: 'Custom hook: {name} — no issues found',
};

process.stdout.write(JSON.stringify(result));
```

### create-middleware

Creates a new middleware module for the runtime pipeline.

**Steps:**
1. Validate name is kebab-case
2. Call `createMiddleware()` from `lib/sdk/artibot-sdk.js` with spec:
   - `name`: from argument
   - `position`: `'after'`
   - `factoryCode`: default ESM factory template (see below)
3. If `--dry-run`, display the generated `moduleContent` and `registration` object — do NOT write files
4. Otherwise write `lib/runtime/middleware/{name}.js` with the returned `moduleContent`
5. Display the returned `registration` object so the user can wire it into the pipeline
6. Re-read the written file to verify correctness
7. Report: created file path, registration object

**Default ESM factory template:**
```js
/**
 * Factory function for {name} middleware.
 *
 * @param {object} config - Pipeline configuration
 * @returns {function} Middleware handler
 */
export function create(config) {
  return async (context, next) => {
    // TODO: Implement pre-processing logic

    const result = await next(context);

    // TODO: Implement post-processing logic

    return result;
  };
}
```

### validate

Validates all custom extensions in the current project.

**Steps:**
1. Scan for custom skills in `skills/` (look for `SKILL.md` files)
2. Scan for custom agents in `agents/` (look for `.md` files)
3. Scan for custom hooks in `scripts/hooks/` (look for `.js` files)
4. Scan for custom middleware in `lib/runtime/middleware/` (look for `.js` files)
5. Collect specs and call `validatePackage()` from `lib/sdk/artibot-sdk.js` with:
   - `{ skills, agents, hooks, middleware }` arrays
6. Report: validation results per item — show `valid: true/false` and any `errors`

## Error Handling

- **Invalid kebab-case name**: Show error with valid example: `"my-custom-skill" is valid, "myCustomSkill" is not`
- **Missing action**: Show available actions: `create-skill`, `create-agent`, `create-hook`, `create-middleware`, `validate`, `scaffold`
- **Missing name for create actions**: Show error: `Name is required. Usage: /sdk create-skill my-tool`
- **Invalid --model value**: Show valid options: `opus, sonnet, haiku`
- **Invalid --event value**: Show valid options: `PreToolUse, PostToolUse, PreCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentSpawned, InstructionsLoaded`
- **SDK validation failure**: Show specific errors from the SDK response with fix guidance

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
[Context-specific guidance for what to do after creation]
```

### scaffold

Creates a complete project scaffolding from a template. All scaffolding is performed via command `.md` logic — no shell scripts.

**Steps:**
1. Parse `--template` flag. Must be one of: `feature`, `security-audit`, `migration`, `marketing-campaign`
2. Parse `name` argument. Must be kebab-case.
3. If `--dry-run`, display the directory tree and CLAUDE.md preview — do NOT write files.
4. Create the directory structure and template files (see below).
5. Re-read created files to verify correctness.
6. Report: created file paths, validation status.

**Templates:**

#### `feature`
```
{name}/
  CLAUDE.md           — Project context with feature spec reference
  spec.md             — Requirements, acceptance criteria, edge cases
  tests/              — Test files directory
    {name}.test.ts    — Test scaffold with describe/it blocks
  src/                — Source files directory
    {name}.ts         — Implementation scaffold with TODO markers
```

#### `security-audit`
```
{name}/
  CLAUDE.md           — Engagement context with scope and workflow
  scope.md            — In-scope assets, OOS list, bounty bands
  findings/           — One markdown file per finding
    README.md         — Finding naming convention and template
  evidence/           — Screenshots, HARs (gitignored)
  .gitignore          — Excludes evidence/, *.har, *.pem, .env
```

#### `migration`
```
{name}/
  CLAUDE.md           — Migration context with rollback reference
  rollback.md         — Step-by-step rollback procedure
  scripts/            — Migration and verification scripts
    migrate.ts        — Migration entry point with TODO markers
    verify.ts         — Post-migration verification checks
  verification/       — Verification evidence and reports
    checklist.md      — Pre/post migration verification checklist
```

#### `marketing-campaign`
```
{name}/
  CLAUDE.md           — Campaign context with brief reference
  brief.md            — Campaign brief: objective, audience, channels, KPIs
  assets/             — Creative assets directory
    copy.md           — Ad copy variants and A/B test versions
  metrics/            — Performance tracking
    dashboard.md      — KPI definitions and measurement plan
```

**CLAUDE.md generation for all templates:**
Each generated `CLAUDE.md` includes:
- Project name and creation date
- Template type and purpose
- File inventory with descriptions
- Relevant workflow commands (`/test`, `/verify`, `/code-review`, etc.)
- Links to related Artibot skills

**Usage:**
```
/sdk scaffold my-feature --template feature
/sdk scaffold q2-launch --template marketing-campaign
/sdk scaffold db-v3 --template migration --dry-run
/sdk scaffold api-pentest --template security-audit
```

## Examples

```
/sdk create-skill api-monitor
/sdk create-skill api-monitor --category monitoring --dry-run
/sdk create-agent security-checker --model opus
/sdk create-hook pre-deploy --event PreToolUse
/sdk create-middleware rate-limiter
/sdk scaffold my-feature --template feature
/sdk scaffold api-pentest --template security-audit --dry-run
/sdk validate
```

## Next Steps

After creating an extension:

| # | Action | Command | Description |
|---|--------|---------|-------------|
| 1 | Edit the scaffold | Open the created file | Fill in TODO placeholders with real logic |
| 2 | Validate | `/sdk validate` | Confirm the extension passes SDK validation |
| 3 | Test | `/test` | Write and run tests for the new extension |
| 4 | Review | `/code-review` | Get a code review on the new extension |
| 5 | Commit | `/git` | Commit the new extension to version control |
