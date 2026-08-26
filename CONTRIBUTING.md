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
model: opus          # must equal the agent's EFFECTIVE tier — see below
description: >
  One-line description of the agent's specialty.
---
```

### Model tier policy

The fleet currently runs a **single tier**: all 28 agents resolve to `opus`.
There is no per-agent tier choice to make — write `model: opus` and move on.

Tiers are named by tier, never by model ID. The tier → model ID mapping lives in
`plugins/artibot/lib/core/model-catalog.js#MODELS`; do not hardcode a model ID in
docs, prompts, or agent files.

| Bucket | Declared tier | Effective tier | Agents |
|--------|---------------|----------------|--------|
| `high` | `fable` | `opus` | 21 |
| `medium` | `opus` | `opus` | 7 |

**Declared vs effective.** The `high` bucket still *declares* `fable`, but the
opt-in gate `artibot.config.json#/agents/modelPolicy/fable/enabled` is `false`,
so every `fable` request is demoted to `opus`. Effective tier is therefore
`opus` for all 28 agents. Read the effective value with
`lib/core/model-policy.js#resolveModel` — the single source of truth — not from
the bucket's declared `model` field (`getPolicyModel(name, config)` returns the
*declared* tier and will say `fable` — and it needs that hydrated config as its
second argument, since a single-argument `getPolicyModel(name)` falls back to
`EMPTY_POLICY` and returns `null` for every agent).

**Pass a hydrated config, or you will read a fallback instead of the policy.**
Both functions take the config as a later argument and fall back to a frozen
`EMPTY_POLICY` (empty buckets, `defaultModel`) when it is missing. Measured
2026-08-19 across all 28 agents:

| Call | Result | Why |
|------|--------|-----|
| `getPolicyModel(name)` | `null` × 28 | EMPTY_POLICY has no bucket members |
| `getPolicyModel(name, config)` | `fable` × 21, `opus` × 7 | the declared tiers |
| `resolveModel(name, {}, config)` | `opus` × 28 | declared, then gated |

Note the trap in the last row's single-argument form: `resolveModel(name)` also
returns `opus` × 28, but it gets there from `EMPTY_POLICY.defaultModel`, not
from the policy — the right answer today for the wrong reason. Re-enable
`fable.enabled` and that call keeps saying `opus` for allowlisted agents while
the real effective tier has changed. Always pass the config.

**Frontmatter must match the effective tier**, not the declared one.
`scripts/ci/validate-model-policy.js` is the drift gate: it hydrates the config
first (`await loadConfig()`), then compares each `agents/<name>.md` `model:`
field against the effective tier — `resolveModel(name, {}, config)`, guarded by
`getPolicyModel(name, config) === null` so an agent in no policy bucket is
reported as unlisted rather than silently compared against a default. It exits
non-zero on a mismatch. Re-enabling `fable.enabled` therefore requires updating
the 20 allowlisted agents' frontmatter in the same change, or the gate fails.
(`security-reviewer` is excluded from the allowlist and hard-pinned to `opus` by
`FABLE_DENYLIST`, because fable's refusal classifier false-positives on
legitimate security work.)

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
- [ ] Agent frontmatter `model:` matches the effective tier from `resolveModel` (currently `opus` for all agents) — `scripts/ci/validate-model-policy.js` enforces this
- [ ] Command `description` starts with `(Artibot)`

### PR body

Describe what changed and why. Include sample input/output if relevant. Link any related issue.

## Landing changes on master

Outside contributors use the PR flow above. Maintainers pushing to `master`
directly should use the side-branch gate flow, for a reason worth understanding.

### Why direct pushes are rejected

`master` has branch protection with four required status checks, and
`enforce_admins` is on (enabled 2026-08-19). A required status check can only
pass on a commit that already exists on the server, and a commit being pushed
does not exist yet, so a direct push can never satisfy the four checks. With
`enforce_admins` on, the remote rejects such a push instead of letting it land.

This is not an occasional slip; it is every direct push, by construction. Before
`enforce_admins` was enabled the same pushes reported

```
remote: Bypassed rule violations for refs/heads/master:
remote: - 4 of 4 required status checks are expected.
```

and landed anyway, so a red CI result arrived after the code was already on the
remote. That is how commit `9f124441` failed CI on 2026-08-11 and stayed on
`master`. The side-branch gate below is now the only way to land on `master`.

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

That lockstep is enforced, not just requested:
`plugins/artibot/tests/firewall/workflow-branch-lockstep.test.js` fails if any
root workflow with an `on.push.branches` list disagrees with the others, if
either required-check workflow loses its push trigger, or if a job `name:`
template stops rendering one of the four required contexts. Its header lists
what it cannot see, the first item being that the required-contexts list is a
manual mirror of remote branch-protection state.

`--ff-only` is required. A merge commit is a new SHA with no check runs on it,
which puts you back to bypassing.

### Pre-push hook

The hook does two jobs. It runs the CI checks that are cheap enough to sit in
front of every push, and it refuses a push to `master` that did not come through
the side-branch gate flow above. `.git/` is not tracked, so no committed file can
install it for you. Every clone runs the installer once:

```bash
cd plugins/artibot
npm run hooks:install
npm run hooks:check
```

`hooks:install` copies `plugins/artibot/scripts/git-hooks/pre-push` to
`.git/hooks/pre-push` and sets the exec bit. It is idempotent, it moves a
pre-existing non-Artibot `pre-push` aside to `pre-push.backup` instead of
overwriting it, and it refuses to run while `core.hooksPath` is set, because
that setting overrides `.git/hooks` and would leave an installed-looking hook
that never executes. `hooks:check` reports drift and exits non-zero without
writing anything, which is the only way to confirm your clone is current.

The content checks take roughly 11-15 seconds and block the push on failure.
ESLint dominates that, so the number moves with its cache state. Bypass the whole
hook with `git push --no-verify` or `ARTIBOT_SKIP_PREPUSH=1`. Prefer the former.
`--no-verify` is scoped to the command you typed; the environment variable is
not, and once it reaches a shell rc or a CI job env every later push is
silently ungated. The hook announces the skip on stderr for that reason.

#### Landing-flow gate

The content gates check what you are pushing. This one checks how, and it runs
first, so a push on the wrong route fails in under a second rather than after
the lint pass.

It looks only at pushes to `master` or `main`. For those it asks the question
branch protection is about to ask: is the SHA the branch is being moved to
already green on the server? It answers that two ways, in order.

With `gh` available it reads the SHA's check runs, and requires all four
required contexts to be present and green **by name**, plus no other check run
on the SHA to be red or unfinished. Counting runs is not enough. A commit
carrying one unrelated green check and none of the four satisfies every count
while satisfying no required check at all, which is exactly the landing this
gate exists to stop. The four names are mirrored in the hook, and a test in
`plugins/artibot/tests/firewall/workflow-branch-lockstep.test.js` parses that
mirror and fails when it disagrees with the list kept there.

`gh` answering HTTP 422 for the SHA is a verdict rather than an error: the
remote does not have the commit, which is the direct-push case itself. Any other
gh failure (offline, unauthenticated, rate limited, timed out) leaves the
question open, and the hook falls back to local evidence, requiring the SHA to
equal the tip of a remote-tracking `ci/**` ref. Equality and not ancestry,
because a push runs the workflows against the branch tip, so an ancestor of a
pushed tip carries no check runs of its own. Your own
`git push -u origin ci/topic` writes that ref, so it is there when you push
`master`; the flow's last step deletes the branch afterwards.

Waive it for one push with `ARTIBOT_ALLOW_DIRECT_PUSH=1`. That is deliberately a
different switch from `ARTIBOT_SKIP_PREPUSH=1`, because it is a different
decision: this one waives the route and leaves all the content gates running,
while `ARTIBOT_SKIP_PREPUSH` waives the content checks and the route together.
Both announce themselves on stderr.

What this gate does not see:

- **CI colour, whenever the offline fallback is the one that answered.** A
  `ci/**` ref proves the SHA reached a branch CI runs on, not that the run went
  green. Offline, a red SHA passes. Every such run says so on stderr.
- **Which branches the remote actually protects.** That list is a manual copy
  inside the hook with no automated lockstep, unlike the required contexts.
  Protect another branch on GitHub and the gate keeps ignoring it until someone
  edits the list.
- **Clones that never ran the installer.** They have no hook at all, and
  `--no-verify` skips it. This gate removes a slip you can make while paying
  attention. What makes the bypass impossible is `enforce_admins` on the remote
  (on since 2026-08-19), and no local hook substitutes for that.

#### Trust boundary

Do **not** install the hook with
`git config core.hooksPath plugins/artibot/scripts/git-hooks`. Earlier revisions
of this document recommended exactly that, and it is the wrong shape. Unlike
`.git/hooks/`, the work tree is supplied by whichever branch is checked out. Two
things follow. A hostile branch can put arbitrary code in `pre-push`, and it
runs on your machine the moment you push while reviewing that branch. The same
branch can also put `exit 0` at the top and delete the gate entirely.

Both were measured on 2026-08-15 in a throwaway repo. With `core.hooksPath`
aimed at the work tree, a branch whose `pre-push` was replaced by `exit 0`
pushed successfully. With the copy installed under `.git/hooks/`, the same
branch was blocked.

The copy is pinned at install time, so checking out a branch cannot rewrite it,
and the hook compares itself against the source file in the work tree on every
run. That comparison is against the checked-out bytes, not against the blob git
has stored, which is deliberate: hashing with filters applied would mismatch on
every Windows checkout under `core.autocrlf`. A mismatch stops the push with
both readings spelled out: either you need to re-run the installer, or the
checked-out branch modified the hook and you should read that diff before
trusting it.

What this does **not** fix: the hook still runs `scripts/ci/validate-*.js` and
`npx eslint` from the work tree, so a hostile branch that edits one of those
scripts still gets code execution at push time. Copying the hook removes the
self-disabling property and stops the gate itself from being attacker-supplied.
It does not make pushing from a hostile checkout safe, and nothing that still
runs repo scripts could. Having such a branch checked out is already dangerous
for the same reason `npm ci`, `npm test`, and most editor plugins are.

The installer is deliberately not a `postinstall` or `prepare` script. This
plugin gets installed onto other people's machines, and writing to their
`.git/hooks/` from a dependency install is precisely the behaviour a security
gate should not model.

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
