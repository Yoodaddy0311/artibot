# AGENTS.md — Cross-Tool Parity Seed

**Scope:** Artibot plugin (`plugins/artibot/`)
**Purpose:** make Artibot's 28 agents + 113 skills + 72 commands usable not just from Claude Code but also from Cursor, Codex CLI, OpenCode, Windsurf, and Antigravity.

`AGENTS.md` is a cross-tool convention adopted by `everything-claude-code` and similar ecosystems. Each consumer tool reads this file (directly or via export) to register agents locally. Artibot's source of truth remains `plugins/artibot/agents/*.md` with Claude Code–style frontmatter; everything else is a projection of that.

---

## 1. Overview

| Fact | Value |
|---|---|
| Source of truth | `plugins/artibot/agents/*.md` (YAML frontmatter + body) |
| Agent count | 28 (21 opus / 7 sonnet) |
| Skill count | 113 |
| Command count | 72 |
| Native orchestration | Claude Agent Teams API (`TeamCreate`, `SendMessage`, `TaskCreate/Update/List/Get`) |
| Cross-tool export | `scripts/export-to-tool.mjs` |
| Graceful-degradation modes | `agent-teams` → `sub-agent` → `direct` (see `artibot.config.json`) |

The `direct` degradation mode already lists the supported non–Claude Code platforms: **cursor**, **codex-cli**, **windsurf**, **antigravity** (plus **gemini-cli**). `AGENTS.md` is the portable contract those runtimes consume.

---

## 2. Tool-by-tool mapping

| Tool | Reads | Writes-back | Supports Tasks API? | Notes |
|---|---|---|---|---|
| Claude Code | native `agents/*.md` + `commands/*.md` + `skills/*/SKILL.md` | via plugin hooks | **yes** (TeamCreate etc.) | Only tool with full Agent Teams |
| Cursor | `.cursor/rules/*.mdc` | n/a | no | Agents map to rules + custom modes |
| Codex CLI | `AGENTS.md` (root) + `.codex/agents/*.md` | optional `.codex/memory.json` | no | Sequential execution only |
| OpenCode | `.opencode/agents.json` | n/a | no | JSON-manifest based |
| Windsurf | `.windsurfrules` + `.windsurf/workflows/*.md` | n/a | no | Cascade runs workflows |
| Antigravity | `AGENTS.md` (root) + `.antigravity/config.yaml` | n/a | no | Inherits Codex-style convention |

### 2.1 Cursor

- Target path: `.cursor/rules/<agent-name>.mdc`
- Frontmatter: `description`, `globs`, `alwaysApply`
- Body: the agent's system prompt, verbatim.

### 2.2 Codex CLI

- Target: `AGENTS.md` at repo root (plain Markdown index) plus `.codex/agents/<agent-name>.md` for each agent body.
- Codex CLI auto-discovers `AGENTS.md` in the working tree.

### 2.3 OpenCode

- Target: `.opencode/agents.json` — single JSON array, one object per agent with `name`, `model`, `systemPrompt`, `tools`.

### 2.4 Windsurf

- Target: `.windsurfrules` for global guidance, `.windsurf/workflows/<name>.md` per command-equivalent.

### 2.5 Antigravity

- Target: same convention as Codex CLI (`AGENTS.md` + body files). Additional `.antigravity/config.yaml` maps Artibot categories to Antigravity roles.

---

## Skills, Personas, Commands — How / Who / When

Artibot's three-layer behavioral model. Every agent interaction activates one or more of these layers:

| Layer | What it is | When it fires | Example |
|---|---|---|---|
| Skills (how) | Process recipes — step-by-step discipline guides with rationalization guards and verification checklists | Auto-activated by trigger keywords in skill frontmatter | `tdd-workflow` activates when user says "fix bug" or "add tests" |
| Personas (who) | Role-specialized decision frameworks — each persona owns a lifecycle phase and applies domain-specific judgment | Routed by lifecycle phase + request intent via `lib/cognitive/router.js` | `persona-architect` for system design questions; `persona-frontend` for UI questions |
| Commands (when) | Lifecycle phase entrypoints — structured workflows that orchestrate agents and skills for a specific phase | User types slash-command, or orchestrator auto-triggers from context detection | `/spec` for requirements, `/plan` for architecture, `/build` for implementation, `/test` for verification, `/review` for code quality, `/ship` for deployment, `/marketing` for post-ship |

### Layer interaction rules

- A single request can activate one Skill, one Persona, and one Command simultaneously.
- Skills fire first (they gate the how), then Personas apply judgment within that process, then Commands provide the lifecycle wrapper.
- Skills are reusable across commands — `tdd-workflow` runs inside both `/build` and `/test`.
- Personas are reusable across skills — `persona-architect` applies judgment within `spec-format`, `tool-design`, and `multi-agent-patterns`.
- Commands are not reusable — each command owns its lifecycle phase and is entered once per phase boundary.

### Distinguishing Skills from Personas

| Question | Skills answer it | Personas answer it |
|---|---|---|
| "What process should I follow?" | Yes — skills are checklists and workflow guides | No |
| "What would an expert in this domain decide?" | No | Yes — personas encode expert judgment |
| "Can I skip step 4?" | Yes — skills carry rationalization guards to answer this | No |
| "Should I use REST or GraphQL here?" | No | Yes — `persona-architect` evaluates this in context |

---

## 3. Conversion rules — Claude Code frontmatter → other tools

### 3.1 Source frontmatter (Claude Code)

```yaml
---
name: backend-developer
description: Production-grade backend implementation with TDD.
model: opus
category: expert
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---
```

### 3.2 Per-tool projection

| Source field | Cursor `.mdc` | Codex `AGENTS.md` entry | OpenCode JSON | Windsurf `.windsurfrules` |
|---|---|---|---|---|
| `name` | filename stem | `## <name>` heading | `"name": "<name>"` | heading in section |
| `description` | `description:` frontmatter | first paragraph under heading | `"description": "..."` | bullet under section |
| `model` | dropped (Cursor picks) | annotated as `**Model:** opus` | `"model": "opus"` | annotated as `> Model: opus` |
| `category` | dropped | annotated as `**Category:** expert` | `"category": "..."` | annotated |
| `tools[]` | dropped (Cursor-managed) | `**Tools:** Read, Write, ...` | `"tools": [...]` | `**Tools:** ...` |
| body (system prompt) | body of `.mdc` | body under heading | `"systemPrompt": "..."` | body under heading |

### 3.3 Model policy mapping

| Artibot tier | Claude Code model | Cursor | Codex CLI | OpenCode | Windsurf |
|---|---|---|---|---|---|
| `high` | `opus` | (user-controlled) | `gpt-5` (or user-pref) | `opus` literal | (user-controlled) |
| `medium` | `sonnet` | (user-controlled) | `gpt-5-mini` | `sonnet` literal | (user-controlled) |

Exporters that target non-Anthropic runtimes substitute a sane default; users override in the destination tool's config.

> **Single source of truth:** the per-agent tier→model resolution is owned by `lib/core/model-policy.js` (`resolveModel` / `resolveModelForPhase`), reading `artibot.config.json#/agents/modelPolicy`. The table above is a projection of that resolver for export targets — do not treat it as an independent source.

---

## 4. Constraints & non-portable surface

| Feature | Portable? | Fallback |
|---|---|---|
| `TeamCreate` / `SendMessage` / `TaskCreate` | **Claude Code only** | Export as sequential steps; teammate becomes a section in the prompt |
| `SlashCommand` auto-invoke | **Claude Code only** | Exported as `.md` workflow the user runs manually |
| Hooks (`PreToolUse`, `UserPromptSubmit`, …) | **Claude Code only** | Not exported; runtime-specific |
| Skills (`SKILL.md` + `references/`) | Partially | Flatten to single prompt; reference files inlined by length budget |
| Memory (`memory/MEMORY.md`) | **Claude Code only** | Non-Claude tools get a snapshot export at conversion time |
| Tool permission lists | Partially | Cursor/Windsurf ignore; Codex/OpenCode honour subsets |

**Rule of thumb:** if a feature depends on the Agent Teams API, it collapses to sequential execution on export. Users of non–Claude Code tools see `graceful-degradation.mode = "direct"` behavior described in `artibot.config.json`.

---

## 5. Install / activation guides

### 5.1 Claude Code (native)

```bash
# Already works — just enable the plugin
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
# plugins/artibot/ is auto-discovered
```

### 5.2 Cursor

```bash
node plugins/artibot/scripts/export-to-tool.mjs --tool cursor --out ./.cursor/rules/
# Restart Cursor; agents appear under Rules for AI.
```

### 5.3 Codex CLI

```bash
node plugins/artibot/scripts/export-to-tool.mjs --tool codex --out ./
# Codex CLI will read AGENTS.md at next `codex` invocation.
codex agents list
```

### 5.4 OpenCode

```bash
node plugins/artibot/scripts/export-to-tool.mjs --tool opencode --out ./.opencode/
opencode agents reload
```

### 5.5 Windsurf

```bash
# Windsurf export is planned for v0.5.2.
# Manual bridge today: copy AGENTS.md content into .windsurfrules.
cp plugins/artibot/AGENTS.md .windsurfrules
```

### 5.6 Antigravity

```bash
# Antigravity reads AGENTS.md natively; no export needed beyond symlink.
ln -s plugins/artibot/AGENTS.md ./AGENTS.md
```

---

## 6. Agent catalogue (summary)

| Category | Count | Examples |
|---|---|---|
| Manager | 3 | orchestrator, planner, architect |
| Expert | 9 | security-reviewer, frontend-developer, backend-developer, database-reviewer, performance-engineer, mcp-developer, llm-architect, typescript-pro, devops-engineer |
| Builder | 4 | code-reviewer, tdd-guide, build-error-resolver, refactor-cleaner |
| Support | 12 | doc-updater, content-marketer, e2e-runner, marketing-strategist, data-analyst, presentation-designer, seo-specialist, cro-specialist, ad-specialist, repo-benchmarker, … |

Full list: `plugins/artibot/agents/*.md` or `artibot.config.json` → `agents.categories`.

---

## 7. Community contribution

- Add a new target tool: create a converter in `scripts/export-to-tool.mjs` following the existing stub layout; add a row to §2 and §3.
- Improve an existing conversion: open a PR touching the converter + a fixture in `test/fixtures/export-<tool>/`.
- Report parity gaps: file an issue titled `[parity] <tool>: <feature>` with the Claude Code behaviour and what the other tool produced.

All contributions must respect Artibot's **local-only data policy** — exports happen on the contributor's machine, never via a hosted service.

---

## 8. Version alignment

| File | Field | Must equal |
|---|---|---|
| `plugins/artibot/package.json` | `version` | plugin version |
| `plugins/artibot/.claude-plugin/plugin.json` | `version` | plugin version |
| `plugins/artibot/artibot.config.json` | `version` | plugin version |
| `plugins/artibot/.well-known/mcp-server.json` | `version` | plugin version |
| `plugins/artibot/AGENTS.md` | this section | plugin version |

Current plugin version: **4.25.0**. Keep the five in lockstep — `scripts/release-check.js` enforces all five.

### Release gate: install & update verification

Every release MUST also pass install/update integrity checks — `npm run ci`
(and therefore `npm run release`) runs `scripts/ci/validate-install.js`, which:

- asserts **install.sh ↔ install.ps1 feature parity** (a capability matrix — adding
  a post-install step to one installer without the other fails the release; this
  is the drift that historically broke cross-machine `/update` on Windows)
- verifies `scripts/update.js` / `scripts/update-platform.js` still reference both
  installers and pass `node --check`
- best-effort `bash -n install.sh` and PowerShell parse of `install.ps1` when those
  hosts are available (skipped with a warning on CI runners that lack them)

When you add or rename an install/update step, update `PARITY_MATRIX` in
`scripts/ci/validate-install.js` so the parity check stays meaningful.

---

## 9. References

- Cross-tool seed project: https://github.com/stretchcloud/everything-claude-code
- Cursor rules format: https://docs.cursor.com/context/rules-for-ai
- Codex CLI agents: https://developers.openai.com/codex/cli
- OpenCode: https://opencode.ai
- Windsurf cascade: https://docs.codeium.com/windsurf
- Artibot degradation modes: `plugins/artibot/artibot.config.json` → `team.gracefulDegradation.modes`
