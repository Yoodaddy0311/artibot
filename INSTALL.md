# Installation Guide

Step-by-step setup for Artibot, the cognitive orchestration plugin for Claude Code.

## Prerequisites

| Tool | Minimum Version | Verify with | Notes |
|------|----------------|-------------|-------|
| Node.js | >= 20 | `node -v` | LTS recommended |
| Claude Code | Latest | `claude --version` | Install from https://claude.ai/download |
| Git | Any recent | `git --version` | Required for clone-based installs |

Agent Teams is auto-enabled by Artibot on first session start. No manual setup needed.

## Installation Methods

### Option A: Claude Code Marketplace (Recommended)

```bash
claude plugin marketplace add https://github.com/Yoodaddy0311/artibot
claude plugin install artibot@artibot
```

This installs agents, commands, skills, hooks, and MCP config to `~/.claude/` automatically.

### Option B: Manual Install

```bash
git clone https://github.com/Yoodaddy0311/artibot.git
cd artibot/plugins/artibot
bash install.sh
```

The install script copies all plugin assets to `~/.claude/` and auto-generates a project-level `CLAUDE.md` with DEV protocol configuration.

### Option C: Development Mode

For contributors who want to modify and test Artibot:

```bash
git clone https://github.com/Yoodaddy0311/artibot.git
cd artibot/plugins/artibot
npm install
npm run ci          # validate + lint + test
bash install.sh     # install to ~/.claude/
```

## Post-Install Verification

### Step 1: Run the doctor check

Open a new Claude Code session in any project and run:

```
/doctor
```

Expected output: health check results showing agents, skills, commands, hooks, and MCP all detected and functional.

### Step 2: Browse available commands

```
/index
```

This lists all installed commands, agents, and skills. Verify the counts match:
- 30 agents
- 70+ commands
- 114 skills

### Step 3: Smoke test a command

```
/sc hello
```

The smart router should analyze your intent and respond. This confirms the cognitive routing pipeline is working.

### Step 4: Verify Agent Teams

```
/team --dry-run implement a sample feature
```

If Agent Teams is active, you will see a team plan with agent assignments. If not, Artibot will note that Agent Teams needs to be enabled.

## Cross-Platform Installation

Artibot works beyond Claude Code. Built-in adapters auto-convert agents, skills, and commands for each platform.

| Platform | Compatibility | Install method |
|----------|:------------:|----------------|
| Claude Code | 10/10 | Marketplace or `install.sh` |
| Gemini CLI | 9/10 | Clone + export script |
| Codex CLI | 8/10 | Clone + export script |
| Antigravity | 8/10 | Clone + export script |
| Cursor IDE | 6/10 | Clone + `/export cursor` |

See the [Cross-Platform Installation section in README.md](README.md#cross-platform-installation) for platform-specific export commands.

## Uninstall

```bash
cd artibot/plugins/artibot
bash install.sh uninstall
```

This removes all Artibot-installed assets from `~/.claude/`.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `/doctor` not recognized | Plugin not installed correctly | Re-run `bash install.sh` from `plugins/artibot/` |
| Agent Teams tools not available | Environment variable not set | Artibot auto-enables this on session start. If manual setup needed: add `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"` to `~/.claude/settings.json` under `env` |
| Skills don't trigger | Description keyword mismatch | Mention the task explicitly in your prompt (e.g., "implement login feature") |
| `node: command not found` | Node.js not installed or not in PATH | Install Node.js >= 20 from https://nodejs.org |
| `install.sh` permission denied | Script not executable | Run `chmod +x install.sh` first |
| Tests fail on Windows | `UV_HANDLE_CLOSING` assertion (known flake) | This affects only `update.test.js` and is skipped. All other tests should pass. |
| High token usage with teams | Team orchestration spawns multiple agents | Use `/sc` for auto-routing (simple tasks use cheaper sub-agents). Add `--agents 2` to limit team size. |
| MCP servers not connecting | MCP config not installed | Verify `.mcp.json` exists in plugin directory. Re-run `install.sh` to restore. |
| Hooks not firing | Hook scripts not in expected path | Check `~/.claude/hooks/` for hook files. Re-run `install.sh`. |

## Next Steps

After installation:

1. Run `/quickstart` for an interactive guide tailored to your project
2. Try `/implement [feature]` to see the full agent team pipeline in action
3. Use `/index` to explore all available commands and skills
4. Read the [README](README.md) for architecture details and usage patterns
