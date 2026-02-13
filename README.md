# Artibot

![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-7C3AED?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkM2LjQ4IDIgMiA2LjQ4IDIgMTJzNC40OCAxMCAxMCAxMCAxMC00LjQ4IDEwLTEwUzE3LjUyIDIgMTIgMnoiIGZpbGw9IndoaXRlIi8+PC9zdmc+)
![Version](https://img.shields.io/badge/version-1.1.0-blue?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen?style=flat-square)
![Agent Teams](https://img.shields.io/badge/Agent_Teams-Native-orange?style=flat-square)

An intelligent orchestration plugin for [Claude Code](https://github.com/anthropics/claude-code) powered by the **native Agent Teams API**. Artibot assembles specialized agent teams with P2P communication, shared task management, and CTO-led coordination to maximize development productivity.

## Overview

Most Claude Code plugins use simple sub-agent (`Task()`) delegation -- fire-and-forget with one-way result reporting. Artibot takes a fundamentally different approach by using Claude's **native Agent Teams API** as its core engine, enabling true team orchestration:

| Capability | Sub-Agent (Task) | Agent Teams (Artibot) |
|------------|------------------|----------------------|
| Communication | Return result to parent only | P2P bidirectional messaging (SendMessage) |
| Task Management | Parent manages everything | Shared task list (TaskCreate/TaskList) |
| Self-Assignment | Not possible | Teammates self-claim from task list |
| Peer Communication | Not possible | Direct DM + broadcast |
| Plan Approval | Not possible | plan_approval_response |
| Lifecycle | One-shot | Create → Work → Shutdown → Cleanup |

## Key Features

- **CTO-Led Orchestration** -- `orchestrator` agent leads 17 specialist agents as a team coordinator (delegation mode: no direct coding)
- **Intelligent Delegation** -- Auto-selects Sub-Agent (simple) vs Agent Team (complex) based on weighted complexity scoring
- **5 Orchestration Patterns** -- Leader, Council, Swarm, Pipeline, Watchdog
- **4 Playbooks** -- Feature, Bugfix, Refactor, Security with predefined team workflows
- **27 Slash Commands** -- `/sc` smart router, `/orchestrate`, `/spawn`, `/implement`, `/analyze`, and more
- **18 Specialized Agents** -- Architecture, security, frontend, backend, testing, DevOps, and more
- **25 Domain Skills** -- 11 persona skills, 6 core skills, 8 utility skills with auto-activation
- **11 Event Hooks** -- Session lifecycle, dangerous command blocking, auto-formatting, team tracking
- **Zero Dependencies** -- Pure Node.js built-in modules only (`node:fs`, `node:path`, `node:os`)

## Get Started

### Prerequisites

**Enable Agent Teams** (required):

Add to `~/.claude/settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### Installation

**From Claude Code Marketplace (recommended):**
```bash
claude plugin install artibot
```

**Manual installation:**
```bash
git clone https://github.com/Yoodaddy0311/artibot.git
cp -r artibot/plugins/artibot ~/.claude/plugins/artibot
```

### Requirements

- [Claude Code](https://github.com/anthropics/claude-code) CLI
- Node.js >= 18.0.0
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` environment variable

## Usage

### Smart Routing

The `/sc` command analyzes natural language intent and routes to the optimal command:

```
/sc implement login feature
→ routes to /implement → TeamCreate → spawns planner + architect + developer + reviewer
```

```
/sc analyze security vulnerabilities in auth module
→ routes to /analyze --focus security → delegates to security-reviewer sub-agent
```

### Direct Commands

```bash
/implement user authentication API --type api --tdd
/code-review @src/auth/
/test --coverage
/git commit
```

### Team Orchestration

For complex tasks, Artibot assembles a full Agent Team:

```bash
/orchestrate payment system --pattern feature
```

This triggers the full team lifecycle:
1. `TeamCreate("payment-feature")` -- create the team
2. `Task(planner, team, "planner")` + `Task(architect, team, "architect")` + ... -- spawn teammates
3. `TaskCreate` per phase (plan → design → implement → review) -- populate task list
4. `TaskUpdate` -- set dependencies and assign teammates
5. `SendMessage` -- P2P coordination between teammates
6. `shutdown_request` → `TeamDelete` -- graceful cleanup

### Parallel Execution

```bash
/spawn full codebase security audit --mode parallel --agents 5
```

Spawns 5 teammates that self-claim tasks from the shared task list and report findings via `SendMessage`.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  User Request                    │
└──────────────────┬──────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────┐
│           /sc Router (Intent Analysis)           │
│       keyword 40% + context 40% + flags 20%      │
└──────────────────┬──────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────┐
│       Delegation Mode (Complexity Scoring)        │
│    score < 0.6 → Sub-Agent  |  >= 0.6 → Team     │
└───────┬─────────────────────────────┬───────────┘
        ▼                             ▼
┌───────────────┐         ┌───────────────────────┐
│   Sub-Agent   │         │   Agent Teams Engine   │
│   Task()      │         │                       │
│   one-way     │         │  TeamCreate           │
│               │         │    → Task(spawn)      │
│               │         │    → TaskCreate       │
│               │         │    → SendMessage(P2P) │
│               │         │    → TeamDelete       │
└───────────────┘         └───────────┬───────────┘
                                      ▼
                          ┌───────────────────────┐
                          │  orchestrator (CTO)    │
                          │  Leader | Council |    │
                          │  Swarm | Pipeline |    │
                          │  Watchdog              │
                          └───────────┬───────────┘
                                      ▼
                          ┌───────────────────────┐
                          │  17 Specialist Agents  │
                          │  TaskList → self-claim │
                          │  SendMessage → P2P     │
                          │  TaskUpdate → report   │
                          └───────────────────────┘
```

### Agent Teams API Tools

| Tool | Purpose |
|------|---------|
| `TeamCreate` | Create a named team with description |
| `Task(type, team_name, name)` | Spawn teammates into the team |
| `TaskCreate` | Add work items to shared task list |
| `TaskUpdate` | Set status, owner, dependencies (blockedBy/blocks) |
| `TaskList` / `TaskGet` | View and read tasks |
| `SendMessage` | DM, broadcast, shutdown request/response, plan approval |
| `TeamDelete` | Clean up team resources |

### Team Levels

| Level | Mode | Agents | When |
|-------|------|--------|------|
| **Solo** | Sub-Agent | 0 | Single file edit, quick fix |
| **Squad** | Agent Team | up to 3 | Feature implementation, bugfix, refactoring |
| **Platoon** | Agent Team | up to 5 | Large feature, architecture change, security audit |

### Playbooks

**Feature:**
```
TeamCreate → [Leader] plan → [Council] design → [Swarm] implement → [Council] review → [Leader] merge → TeamDelete
```

**Bugfix:**
```
TeamCreate → [Leader] analyze → [Pipeline] fix → [Council] verify → TeamDelete
```

**Refactor:**
```
TeamCreate → [Council] assess → [Pipeline] refactor → [Swarm] test → [Council] review → TeamDelete
```

**Security:**
```
TeamCreate → [Leader] scan → [Council] assess → [Pipeline] fix → [Council] verify → TeamDelete
```

## Agents

### Orchestrator (Team Leader / CTO)

| Agent | Model | Role | Team API Tools |
|-------|-------|------|----------------|
| **orchestrator** | opus | CTO-level team leader. Coordination only (delegation mode). | TeamCreate, SendMessage, TaskCreate, TaskUpdate, TaskList, TaskGet, TeamDelete, Task() |

The orchestrator **never writes code directly**. It assembles the team, distributes tasks, coordinates between teammates, and synthesizes results.

### Specialist Agents (17 Teammates)

All teammates have their specialist tools + team collaboration tools (`SendMessage`, `TaskList`, `TaskGet`, `TaskUpdate`).

**Design & Analysis:**

| Agent | Model | Specialty |
|-------|-------|-----------|
| architect | opus | System architecture, ADR, trade-off analysis |
| planner | opus | Implementation planning, risk assessment |
| llm-architect | opus | LLM architecture, prompt design, RAG |

**Quality & Security:**

| Agent | Model | Specialty |
|-------|-------|-----------|
| code-reviewer | opus | Code review (4 severity levels, 5 dimensions) |
| security-reviewer | opus | OWASP Top 10, threat modeling |
| tdd-guide | opus | TDD (RED→GREEN→REFACTOR), 80%+ coverage |
| e2e-runner | opus | Playwright E2E testing |

**Development:**

| Agent | Model | Specialty |
|-------|-------|-----------|
| frontend-developer | sonnet | UI/UX, WCAG accessibility, Core Web Vitals |
| backend-developer | sonnet | API, database, services |
| database-reviewer | opus | SQL optimization, schema design |
| typescript-pro | sonnet | Advanced types, strict mode |
| build-error-resolver | opus | Build error diagnosis and auto-fix |

**Utilities:**

| Agent | Model | Specialty |
|-------|-------|-----------|
| refactor-cleaner | opus | Dead code removal, refactoring |
| doc-updater | haiku | Documentation sync, changelog |
| content-marketer | sonnet | Blog, SEO, social media |
| devops-engineer | sonnet | CI/CD, Docker, monitoring |
| mcp-developer | sonnet | MCP server development |

## Commands

### Development

| Command | Description |
|---------|-------------|
| `/sc [request]` | Smart router entry point with auto-routing |
| `/build [target]` | Project builder with framework auto-detection |
| `/build-fix` | Build error auto-diagnosis and fix |
| `/implement [feature]` | Feature implementation pipeline |
| `/improve [target]` | Evidence-based code enhancement |
| `/design [domain]` | System design and architecture |

### Analysis & Debugging

| Command | Description |
|---------|-------------|
| `/analyze [target]` | Multi-dimensional code/system analysis |
| `/troubleshoot [symptoms]` | Root cause analysis |
| `/explain [topic]` | Educational explanations |

### Quality

| Command | Description |
|---------|-------------|
| `/code-review [target]` | Code review (CRITICAL/HIGH/MEDIUM/LOW) |
| `/test [type]` | Test runner with auto-detection |
| `/tdd [feature]` | TDD workflow (RED→GREEN→REFACTOR) |
| `/verify` | Validation pipeline (lint→type→test→build) |
| `/refactor-clean [target]` | Refactoring and dead code removal |

### Team Orchestration

| Command | Description |
|---------|-------------|
| `/orchestrate [workflow]` | Agent Teams multi-agent workflow |
| `/spawn [mode]` | Team spawn with parallel task execution |

### Workflow

| Command | Description |
|---------|-------------|
| `/plan [feature]` | Implementation planning |
| `/task [operation]` | Task management (CRUD) |
| `/git [operation]` | Git workflow automation |
| `/checkpoint` | State snapshot save/restore |

### Documentation & Content

| Command | Description |
|---------|-------------|
| `/document [target]` | Documentation generation |
| `/content [type]` | Content marketing and SEO |
| `/learn [pattern]` | Pattern extraction and memory storage |

### Utilities

| Command | Description |
|---------|-------------|
| `/cleanup [target]` | Technical debt reduction |
| `/estimate [target]` | Evidence-based estimation |
| `/index [query]` | Command catalog search |
| `/load [path]` | Project context loading |

## Skills

25 auto-activating domain skills organized in three categories:

**Core Skills (6):** orchestration, token-efficiency, principles, coding-standards, security-standards, testing-standards

**Persona Skills (11):** architect, frontend, backend, security, analyzer, performance, qa, refactorer, devops, mentor, scribe

**Utility Skills (8):** git-workflow, tdd-workflow, delegation, mcp-context7, mcp-playwright, mcp-coordination, continuous-learning, strategic-compact

## Hooks

11 automation scripts across 10 event types:

| Event | Script | Purpose |
|-------|--------|---------|
| SessionStart | `session-start.js` | Environment detection, config loading |
| PreToolUse (Write) | `pre-write.js` | Block writes to sensitive files (.env, .pem) |
| PreToolUse (Bash) | `pre-bash.js` | Block dangerous commands (rm -rf, force push) |
| PostToolUse (Edit) | `post-edit-format.js` | Auto-format suggestion for JS/TS |
| PostToolUse (Bash) | `post-bash.js` | Auto-detect PR URLs after git push |
| PreCompact | `pre-compact.js` | State snapshot before context compression |
| Stop | `check-console-log.js` | Detect leftover console.log statements |
| UserPromptSubmit | `user-prompt-handler.js` | Intent detection and agent suggestion |
| SubagentStart/Stop | `subagent-handler.js` | Teammate registration/deregistration tracking |
| TeammateIdle | `team-idle-handler.js` | Alert idle teammates about pending tasks |
| SessionEnd | `session-end.js` | Persist session state |

## MCP Integration

Artibot integrates with MCP servers for extended capabilities:

**Context7** -- Library and framework documentation lookup
```json
{
  "context7": {
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp@latest"]
  }
}
```

**Playwright** -- Cross-browser E2E testing, performance metrics, visual testing
```json
{
  "playwright": {
    "command": "npx",
    "args": ["-y", "@executeautomation/playwright-mcp-server"]
  }
}
```

## Plugin Structure

```
plugins/artibot/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── agents/                      # 18 agent definitions
│   ├── orchestrator.md          #   CTO / Team leader (Agent Teams API)
│   └── [17 specialists].md     #   Teammates (SendMessage + TaskUpdate)
├── commands/                    # 27 slash commands
│   ├── sc.md                    #   Smart router
│   ├── orchestrate.md           #   Team orchestration (TeamCreate)
│   ├── spawn.md                 #   Team spawn (parallel execution)
│   └── [24 commands].md
├── skills/                      # 25 skill directories
│   ├── orchestration/           #   Delegation mode + team routing
│   ├── delegation/              #   Sub-Agent/Team strategies
│   └── [23 skills]/
├── hooks/
│   └── hooks.json               # Hook event mappings
├── scripts/
│   ├── hooks/                   # 11 hook scripts (ESM)
│   ├── ci/                      # 4 CI validation scripts
│   └── utils/
├── lib/
│   ├── core/                    # Core modules (platform, config, cache)
│   ├── intent/                  # Intent detection (language, trigger)
│   └── context/                 # Context management (hierarchy, session)
├── output-styles/               # 3 output styles
├── templates/                   # 3 writing templates
├── artibot.config.json          # Plugin config (Agent Teams settings)
├── package.json                 # Node.js ESM runtime
└── .mcp.json                    # MCP server configuration
```

## Configuration

Key settings in `artibot.config.json`:

| Setting | Description | Default |
|---------|-------------|---------|
| `team.engine` | Team engine | `claude-agent-teams` |
| `team.delegationMode` | Leader coordination-only mode | `true` |
| `team.maxTeammates` | Max concurrent teammates | `7` |
| `team.ctoAgent` | CTO agent name | `orchestrator` |
| `automation.intentDetection` | Auto intent detection | `true` |
| `automation.supportedLanguages` | Supported languages | `en, ko, ja` |

## Validation

```bash
node scripts/validate.js              # Full validation
node scripts/ci/validate-agents.js    # Agent validation
node scripts/ci/validate-skills.js    # Skill validation
node scripts/ci/validate-commands.js  # Command validation
node scripts/ci/validate-hooks.js     # Hook validation
```

## Best Practices

- **Use `/sc` for auto-routing** -- Let the smart router pick the optimal command and delegation mode
- **Trust the delegation scoring** -- Simple tasks use fast sub-agents; complex tasks get full teams
- **Enable Agent Teams** -- Without `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, team features won't work
- **Let teammates self-claim** -- The Swarm pattern works best when teammates pick tasks from the shared list
- **Use playbooks for common workflows** -- Feature, bugfix, refactor, and security playbooks provide proven team patterns

## When to Use Artibot

**Use for:**
- Complex feature implementation spanning multiple files and domains
- Security audits requiring multi-perspective analysis
- Large-scale refactoring with coordinated testing
- Architecture decisions needing specialist input
- Any task benefiting from parallel agent collaboration

**Don't use for:**
- Single-line bug fixes
- Trivial edits or formatting changes
- Tasks where a single agent is sufficient
- Quick questions or explanations (unless you want team discussion)

## Troubleshooting

### Agent Teams not working

**Issue**: TeamCreate or SendMessage not available

**Solution**: Ensure the environment variable is set:
```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### Teammates not picking up tasks

**Issue**: Tasks stay in "pending" status

**Solution**:
- Verify tasks have no unresolved `blockedBy` dependencies
- Check that teammates are spawned with correct `team_name`
- Use `TaskUpdate` to explicitly assign if self-claim isn't working

### High token usage

**Issue**: Team orchestration consuming too many tokens

**Solution**:
- Use Sub-Agent mode for simpler tasks (score < 0.6)
- Reduce team size with `--agents` flag
- Enable token efficiency with `--uc` flag

## Contributing

1. Fork this repository
2. Create a feature branch
3. Follow the existing plugin structure and conventions
4. Test with `node scripts/validate.js`
5. Submit a pull request

## Author

**Artience** ([@Yoodaddy0311](https://github.com/Yoodaddy0311))

## Version

1.1.0 -- Agent Teams API native integration

## License

MIT License -- See [LICENSE](LICENSE) for details.
