# Contributing to Artibot

Thanks for your interest in improving Artibot. This guide covers how to add skills, agents, and commands, and how to submit changes.

## Quick start

1. Fork the repo
2. Create a feature branch (`feat/new-skill-name` or `fix/skill-name-issue`)
3. Make your changes
4. Run `npm run ci` to validate everything (lint, typecheck, tests, validation)
5. Open a PR

## Prerequisites

| Tool | Minimum | Verify with |
|------|---------|-------------|
| Node.js | >= 20 | `node -v` |
| Claude Code | Latest | `claude --version` |
| Git | Any recent | `git --version` |

## Adding a skill

### 1. Create the folder

Create a new directory under `plugins/artibot/skills/` with a lowercase hyphenated name matching the skill's `name` field.

```
plugins/artibot/skills/my-new-skill/
  SKILL.md
  references/        (optional, for large reference material)
```

### 2. Write the SKILL.md

Every skill requires YAML frontmatter. Minimum required fields:

```yaml
---
name: my-new-skill
description: >
  One or two sentences explaining what the skill does and when to use it.
  Include specific trigger phrases. The first word should be a verb or action.
  Must be under 200 characters.
---
```

Optional frontmatter fields:

| Field | Type | Description |
|-------|------|-------------|
| `context` | string | When this skill should auto-activate |
| `triggers` | string[] | Phrases that invoke this skill |
| `tools` | string[] | Tools the skill needs access to |

### 3. Write the skill body

Most skills follow this structure:

```markdown
# Skill Name

## CRITICAL: Auto-start on load

When this skill triggers, go straight to Step 1. Do not summarise.

## Step 1. Gather inputs
[Use AskUserQuestion where possible]

## Step 2. [Main work]

## Step 3. Output
[Code block showing the exact output format]

## Rules
[Non-negotiables. "Never" and "always" phrasing.]
```

### 4. File size and references

- Keep `SKILL.md` under 500 lines (4K chars ideal for context efficiency)
- Move reference material to `skills/my-new-skill/references/`
- Reference files are loaded on demand, not injected into context by default
- If the skill has templates or assets, put them in `skills/my-new-skill/assets/`

## Adding an agent

### 1. Create the agent file

Add a markdown file under `plugins/artibot/agents/` with kebab-case naming:

```
plugins/artibot/agents/my-agent.md
```

### 2. Required frontmatter

```yaml
---
name: my-agent
model: opus          # or sonnet
description: >
  One-line description of the agent's specialty.
---
```

### Model tier policy

| Tier | Model | Use for |
|------|-------|---------|
| opus (73%) | Claude Opus | Orchestration, architecture, security, development, code review |
| sonnet (27%) | Claude Sonnet | Documentation, content, data analysis, SEO, CRO, ads |

Choose the model tier based on the agent's complexity requirements. Code-writing and security agents should use opus. Content and documentation agents can use sonnet.

### 3. Agent body structure

```markdown
# Agent Name

## Role
[One paragraph: what this agent does]

## Responsibilities
[Bulleted list of specific tasks]

## Tools
[List of tools the agent can use, including team tools: SendMessage, TaskList, TaskGet, TaskUpdate]

## Output Format
[What the agent returns when done]
```

## Adding a command

### 1. Create the command file

Add a markdown file under `plugins/artibot/commands/`:

```
plugins/artibot/commands/my-command.md
```

### 2. Required frontmatter

```yaml
---
description: (Artibot) Short description of what the command does
argument-hint: '[args] e.g. "example usage"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep]
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Must start with `(Artibot)`. Under 120 characters. |
| `argument-hint` | Yes | Example arguments shown in command palette |
| `allowed-tools` | Yes | Tools the command is permitted to use |
| `toolset` | No | `code` or `team` (determines available tool categories) |
| `lifecycle` | No | `spec`, `review`, `ship`, or `marketing` |

### 3. Command body structure

```markdown
# /command-name

One-line description.

## Arguments

Parse $ARGUMENTS:
- `arg1`: Description
- `--flag`: What it does

## Execution Flow

[Steps the command performs]

## Output

[What the user sees when complete]
```

## Style rules

These rules apply to every file in the repo:

- Use hyphens, not em dashes. Write `--` for flags and CLI, `-` for prose ranges.
- Short sentences. No semicolons in prose.
- Never use: "leverage" (as a verb), "deep dive", "unlock", "game-changer", "groundbreaking"
- No emojis in code or documentation files
- Folder name = YAML `name` field = lowercase, hyphen-separated, no spaces
- Skill/agent names read as verb-object or noun phrases (`code-reviewer`, not `reviewing-code`)
- Keep names short. Three words max where possible.

## Testing locally

### Skills

Copy your skill into Claude's skill directory and trigger it:

```bash
cp -r plugins/artibot/skills/my-new-skill ~/.claude/skills/
```

Then trigger it in a new Claude conversation with the phrases listed in the description. Confirm:

- Claude picks up the skill on the trigger phrase
- Inputs are collected correctly
- Output matches the format in the skill
- All external dependencies are checked before use

### Agents and commands

Run the validation suite:

```bash
npm run ci
```

This runs:
- `node scripts/validate.js` -- full structural validation
- `node scripts/ci/validate-agents.js` -- agent frontmatter and structure
- `node scripts/ci/validate-skills.js` -- skill frontmatter and references
- `node scripts/ci/validate-commands.js` -- command frontmatter and allowed-tools
- `node scripts/ci/validate-hooks.js` -- hook event mappings
- `npm run lint` -- ESLint (0 errors/warnings target)
- `npm test` -- vitest test suite

## Submitting a PR

### Title format

```
feat: add [component-name]
fix: [component-name] [brief description]
refactor: [component-name] [brief description]
docs: [brief description]
```

### PR checklist

Before submitting, verify:

- [ ] `npm run ci` passes with 0 errors
- [ ] YAML frontmatter fields are correct and complete
- [ ] `name` field matches the folder/file name
- [ ] Description is under 200 characters
- [ ] No em dashes used anywhere
- [ ] No emojis in files
- [ ] Skill files are under 500 lines
- [ ] Reference material is in `references/` subdirectory
- [ ] Agent model tier follows the policy (opus for complex, sonnet for content)
- [ ] Command `description` starts with `(Artibot)`

### PR body

Describe what changed and why. Include sample input/output if relevant. Link any related issue.

## Landing changes on master

Outside contributors use the PR flow above. Maintainers pushing to `master`
directly should use the side-branch gate flow, for a reason worth understanding.

### Why direct pushes are not gated

`master` has branch protection with four required status checks. It also has
`enforce_admins` turned off. A required status check can only pass on a commit
that already exists on the server, and a commit being pushed does not exist yet,
so every direct push reports this and lands anyway:

```
remote: Bypassed rule violations for refs/heads/master:
remote: - 4 of 4 required status checks are expected.
```

This is not an occasional slip. Every direct push bypasses, by construction. CI
still runs afterwards, so a red result arrives after the code is already on the
remote. On 2026-08-11 commit `9f124441` failed CI and stayed on `master`.

### The side-branch gate flow

Check runs attach to a commit SHA, not to a branch. So if the SHA is already
green when `master` fast-forwards onto it, the required checks are satisfied and
the push is accepted with no bypass.

```bash
git switch -c ci/short-topic          # ci/** is the staging prefix
git push -u origin ci/short-topic     # CI and Plugin Validation run here
# wait for all four required contexts to go green on that SHA
git switch master
git merge --ff-only ci/short-topic
git push origin master                # accepted without a bypass
git push origin --delete ci/short-topic
```

The prefix matters. `.github/workflows/ci.yml` and
`.github/workflows/plugin-validate.yml` both trigger on
`[master, main, "artibot/**", "ci/**"]`. A branch outside that list produces no
check runs, so the fast-forward would bypass exactly as a direct push does. Keep
the two branch lists in lockstep when either changes.

`--ff-only` is required. A merge commit is a new SHA with no check runs on it,
which puts you back to bypassing.

### Pre-push hook

The hook runs the CI checks that are cheap enough to sit in front of every push.
Enable it once per clone. `core.hooksPath` is local config and is not committed.

```bash
git config core.hooksPath plugins/artibot/scripts/git-hooks
```

If pushes go through without the hook printing anything, check that the file is
executable. This repo is worked on with `core.filemode=false`, so a local
`chmod +x` is not recorded, and the mode has to be committed deliberately with
`git add --chmod=+x plugins/artibot/scripts/git-hooks/pre-push`.

```bash
chmod +x plugins/artibot/scripts/git-hooks/pre-push
```

It takes roughly 11-15 seconds and blocks the push on failure. ESLint dominates
that, so the number moves with its cache state. Bypass with
`git push --no-verify` or `ARTIBOT_SKIP_PREPUSH=1`.

It does not run the vitest suite, coverage thresholds, the runtime eval gate, or
the two plugin.json structure checks. The full list of what it does not cover is
at the top of `plugins/artibot/scripts/git-hooks/pre-push`. Read it before
treating a green hook as a green CI. The hook predicts CI, it does not replace
it.

### Plugin cache does not refresh without a version bump

`claude plugin update artibot@artibot` compares versions and no-ops when they
match, reporting `already at latest`. Editing a command, agent, or skill without
bumping the version in `.claude-plugin/plugin.json` leaves the installed cache on
the old definitions, so local edits will not appear in Claude Code. Bump the
version, or reinstall, when you need the change to take effect before a release.

## Forbidden patterns

| Pattern | Why | Instead |
|---------|-----|---------|
| Em dashes | Inconsistent rendering across platforms | Use hyphens or commas |
| Emojis in files | Clutters diffs, accessibility issues | Plain text markers |
| `console.log` in hooks | Leftover debug output | Remove or use proper logging |
| Mutable state in middleware | Race conditions in concurrent hooks | Spread/create new objects |
| Functions > 50 lines | Readability and testability | Extract helper functions |
| Files > 800 lines | Context window pressure | Split into modules |
| Skill YAML > 200 chars | Claude truncates long descriptions | Shorten to essentials |

## Questions?

Open a GitHub issue at [github.com/Yoodaddy0311/artibot/issues](https://github.com/Yoodaddy0311/artibot/issues).
