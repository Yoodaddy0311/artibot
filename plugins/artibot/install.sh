#!/usr/bin/env bash
# Artibot Installer - Claude Code Plugin
# Copies agents, commands, skills, hooks to ~/.claude/ for native integration
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
ARTIBOT_DIR="${CLAUDE_DIR}/artibot"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[artibot]${NC} $1"; }
warn() { echo -e "${YELLOW}[artibot]${NC} $1"; }
err()  { echo -e "${RED}[artibot]${NC} $1" >&2; }

# ──────────────────────────────────────────────
# Prerequisites
# ──────────────────────────────────────────────
check_prerequisites() {
  if ! command -v claude &>/dev/null; then
    err "Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code"
    exit 1
  fi

  if ! command -v node &>/dev/null; then
    err "Node.js not found. Install: https://nodejs.org/ (v18+)"
    exit 1
  fi

  local node_version
  node_version=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$node_version" -lt 18 ]; then
    err "Node.js 18+ required. Current: $(node -v)"
    exit 1
  fi

  log "Prerequisites OK (Claude Code + Node.js $(node -v))"
}

# ──────────────────────────────────────────────
# Directory Setup
# ──────────────────────────────────────────────
setup_directories() {
  mkdir -p "${CLAUDE_DIR}/agents"
  mkdir -p "${CLAUDE_DIR}/commands"
  mkdir -p "${CLAUDE_DIR}/rules/artibot"
  mkdir -p "${ARTIBOT_DIR}"
  log "Directories ready"
}

# ──────────────────────────────────────────────
# Copy Agents (26 agent .md files)
# ──────────────────────────────────────────────
install_agents() {
  local count=0
  for agent in "${SCRIPT_DIR}"/agents/*.md; do
    [ -f "$agent" ] || continue
    cp "$agent" "${CLAUDE_DIR}/agents/"
    count=$((count + 1))
  done
  log "Agents installed: ${count} files → ~/.claude/agents/"
}

# ──────────────────────────────────────────────
# Copy Commands (slash commands .md files)
# ──────────────────────────────────────────────
install_commands() {
  local count=0
  for cmd in "${SCRIPT_DIR}"/commands/*.md; do
    [ -f "$cmd" ] || continue
    cp "$cmd" "${CLAUDE_DIR}/commands/"
    count=$((count + 1))
  done
  log "Commands installed: ${count} files → ~/.claude/commands/"
}

# ──────────────────────────────────────────────
# Copy Skills (skill directories with SKILL.md + references/)
# ──────────────────────────────────────────────
install_skills() {
  local count=0
  if [ -d "${SCRIPT_DIR}/skills" ]; then
    cp -r "${SCRIPT_DIR}/skills" "${ARTIBOT_DIR}/"
    count=$(find "${SCRIPT_DIR}/skills" -maxdepth 1 -type d | wc -l)
    count=$((count - 1))
  fi
  log "Skills installed: ${count} skills → ~/.claude/artibot/skills/"
}

# ──────────────────────────────────────────────
# Copy Hooks & Scripts
# ──────────────────────────────────────────────
install_hooks() {
  cp -r "${SCRIPT_DIR}/hooks" "${ARTIBOT_DIR}/"
  cp -r "${SCRIPT_DIR}/scripts" "${ARTIBOT_DIR}/"
  cp -r "${SCRIPT_DIR}/lib" "${ARTIBOT_DIR}/"

  # Copy config files
  cp "${SCRIPT_DIR}/artibot.config.json" "${ARTIBOT_DIR}/"
  [ -f "${SCRIPT_DIR}/package.json" ] && cp "${SCRIPT_DIR}/package.json" "${ARTIBOT_DIR}/"

  log "Hooks & scripts installed → ~/.claude/artibot/"
}

# ──────────────────────────────────────────────
# Copy Rules (project-level .claude/rules/)
# ──────────────────────────────────────────────
install_rules() {
  local count=0
  if [ -d "${SCRIPT_DIR}/rules" ]; then
    for rule in "${SCRIPT_DIR}"/rules/*.md; do
      [ -f "$rule" ] || continue
      cp "$rule" "${CLAUDE_DIR}/rules/artibot/"
      count=$((count + 1))
    done
  fi
  log "Rules installed: ${count} files → ~/.claude/rules/artibot/"
  log "  These rules auto-activate when Claude reads matching files (no /sc needed)"
}

# ──────────────────────────────────────────────
# Seed Project CLAUDE.md (Artibot methodology)
# ──────────────────────────────────────────────
seed_project_claude_md() {
  local target_dir="${2:-.}"
  local claude_md="${target_dir}/CLAUDE.md"

  if [ -f "$claude_md" ]; then
    # Check if Artibot section already exists
    if grep -q "## Artibot Integration" "$claude_md" 2>/dev/null; then
      log "Project CLAUDE.md already has Artibot section — skipping"
      return
    fi
    # Append Artibot section to existing CLAUDE.md
    cat >> "$claude_md" <<'ARTIBOT_SECTION'

## Artibot Integration

### DEV Protocol (Mandatory for all code changes)
1. **DECOMPOSE**: Break request into numbered atomic items before any action
2. **EXECUTE**: Read target file → Make change → Re-read to confirm
3. **VERIFY**: Report with evidence per item (file:line + what changed)

### Zero-Skip Policy
- Never silently skip any part of a multi-part request
- Never claim completion without re-reading the modified file
- If blocked, explain WHY and propose alternatives

### Agent Delegation
- Complex features: use planner agent first
- After writing code: use code-reviewer agent
- Bug fixes / new features: use tdd-guide agent
- Architecture decisions: use architect agent
- Multiple independent tasks: launch agents in parallel

### Quality Gates
- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (create new objects, never mutate)
- 80%+ test coverage target
ARTIBOT_SECTION
    log "Artibot section appended to existing CLAUDE.md"
  else
    cat > "$claude_md" <<'PROJECT_CLAUDE'
# Project Instructions

## Artibot Integration

### DEV Protocol (Mandatory for all code changes)
1. **DECOMPOSE**: Break request into numbered atomic items before any action
2. **EXECUTE**: Read target file → Make change → Re-read to confirm
3. **VERIFY**: Report with evidence per item (file:line + what changed)

### Zero-Skip Policy
- Never silently skip any part of a multi-part request
- Never claim completion without re-reading the modified file
- If blocked, explain WHY and propose alternatives

### Agent Delegation
- Complex features: use planner agent first
- After writing code: use code-reviewer agent
- Bug fixes / new features: use tdd-guide agent
- Architecture decisions: use architect agent
- Multiple independent tasks: launch agents in parallel

### Quality Gates
- Read before write (no blind modifications)
- Functions < 50 lines, files < 800 lines
- Immutable patterns (create new objects, never mutate)
- 80%+ test coverage target
PROJECT_CLAUDE
    log "Project CLAUDE.md created with Artibot methodology"
  fi
}

# ──────────────────────────────────────────────
# Seed CLAUDE.local.md template
# ──────────────────────────────────────────────
seed_local_config() {
  local target_dir="${2:-.}"
  local local_md="${target_dir}/CLAUDE.local.md"
  local gitignore="${target_dir}/.gitignore"

  if [ -f "$local_md" ]; then
    log "CLAUDE.local.md already exists — skipping"
    return
  fi

  if [ -f "${SCRIPT_DIR}/templates/CLAUDE.local.md.template" ]; then
    cp "${SCRIPT_DIR}/templates/CLAUDE.local.md.template" "$local_md"
    log "CLAUDE.local.md created from template (personalize it!)"

    # Ensure CLAUDE.local.md is in .gitignore
    if [ -f "$gitignore" ]; then
      if ! grep -q "CLAUDE.local.md" "$gitignore" 2>/dev/null; then
        echo "CLAUDE.local.md" >> "$gitignore"
        log "Added CLAUDE.local.md to .gitignore"
      fi
    fi
  fi
}

# ──────────────────────────────────────────────
# Seed Auto-Memory for new users
# ──────────────────────────────────────────────
seed_auto_memory() {
  local memory_dir="${CLAUDE_DIR}/projects"
  # Find the current project's memory directory
  local project_hash
  project_hash=$(echo "$PWD" | sed 's/[\/:\\]/-/g' | sed 's/^-//')
  local project_memory="${memory_dir}/${project_hash}/memory"

  # Only seed if no MEMORY.md exists yet
  if [ -d "$project_memory" ] && [ -f "${project_memory}/MEMORY.md" ]; then
    log "Auto-memory already exists — skipping seed"
    return
  fi

  mkdir -p "$project_memory"
  cat > "${project_memory}/MEMORY.md" <<'SEED_MEMORY'
# Project Memory (Seeded by Artibot)

## Artibot Quick Reference
- **Agents**: 26 specialized agents — use `Task()` to delegate
- **Commands**: `/sc` routes to optimal command/agent/skill automatically
- **DEV Protocol**: Decompose → Execute → Verify (mandatory for all code changes)
- **Quality**: 80%+ test coverage, immutable patterns, functions < 50 lines

## Workflow Tips
- Complex features: start with `/sc plan [feature]` or use planner agent
- After implementation: code-reviewer agent runs automatically via rules
- Parallel work: launch multiple agents with `Task()` for independent tasks
- Vibe coding: rules auto-activate on file access (no /sc needed after install)

## Key Paths
- Agents: `~/.claude/agents/` (26 .md files)
- Commands: `~/.claude/commands/` (43 .md files)
- Skills: `~/.claude/artibot/skills/` (79 skill directories)
- Rules: `~/.claude/rules/artibot/` (auto-activate on file access)
- Config: `~/.claude/artibot/artibot.config.json`
SEED_MEMORY
  log "Auto-memory seeded with Artibot quickstart → ${project_memory}/MEMORY.md"
}

# ──────────────────────────────────────────────
# Configure MCP Servers
# ──────────────────────────────────────────────
install_mcp() {
  local mcp_file="${CLAUDE_DIR}/.mcp.json"

  if [ -f "$mcp_file" ]; then
    warn "MCP config exists at ~/.claude/.mcp.json — merging manually recommended"
    warn "Artibot MCP config: ${SCRIPT_DIR}/.mcp.json"
  else
    if [ -f "${SCRIPT_DIR}/.mcp.json" ]; then
      cp "${SCRIPT_DIR}/.mcp.json" "$mcp_file"
      log "MCP servers configured (Context7, Playwright)"
    fi
  fi
}

# ──────────────────────────────────────────────
# Configure Settings (Agent Teams env var)
# ──────────────────────────────────────────────
configure_settings() {
  local settings_file="${CLAUDE_DIR}/settings.json"

  if [ -f "$settings_file" ]; then
    # Check if AGENT_TEAMS env var already set
    if grep -q "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" "$settings_file" 2>/dev/null; then
      log "Agent Teams already enabled in settings.json"
    else
      warn "Add this to ~/.claude/settings.json manually:"
      echo -e "${BLUE}  \"env\": { \"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\": \"1\" }${NC}"
    fi
  else
    cat > "$settings_file" <<'SETTINGS'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
SETTINGS
    log "Settings created with Agent Teams enabled"
  fi
}

# ──────────────────────────────────────────────
# Verify Installation
# ──────────────────────────────────────────────
verify_install() {
  echo ""
  log "━━━ Installation Summary ━━━"

  local agent_count cmd_count skill_count hook_count rule_count
  agent_count=$(find "${CLAUDE_DIR}/agents" -name "*.md" -type f 2>/dev/null | wc -l)
  cmd_count=$(find "${CLAUDE_DIR}/commands" -name "*.md" -type f 2>/dev/null | wc -l)
  skill_count=$(find "${ARTIBOT_DIR}/skills" -maxdepth 1 -type d 2>/dev/null | wc -l)
  skill_count=$((skill_count - 1))
  hook_count=$(find "${ARTIBOT_DIR}/scripts/hooks" -name "*.js" -type f 2>/dev/null | wc -l)
  rule_count=$(find "${CLAUDE_DIR}/rules/artibot" -name "*.md" -type f 2>/dev/null | wc -l)

  echo -e "  Agents:   ${GREEN}${agent_count}${NC} files in ~/.claude/agents/"
  echo -e "  Commands: ${GREEN}${cmd_count}${NC} files in ~/.claude/commands/"
  echo -e "  Skills:   ${GREEN}${skill_count}${NC} dirs in ~/.claude/artibot/skills/"
  echo -e "  Rules:    ${GREEN}${rule_count}${NC} files in ~/.claude/rules/artibot/ (auto-activate)"
  echo -e "  Hooks:    ${GREEN}${hook_count}${NC} scripts in ~/.claude/artibot/scripts/"
  echo ""

  # Check memory extensions
  [ -f "./CLAUDE.md" ] && echo -e "  Project:  ${GREEN}CLAUDE.md${NC} seeded with Artibot methodology"
  [ -f "./CLAUDE.local.md" ] && echo -e "  Local:    ${GREEN}CLAUDE.local.md${NC} ready for personalization"
  echo ""
  log "Installation complete! Start Claude Code and type: /sc hello"
  log ""
  log "Memory extensions installed:"
  log "  - Project CLAUDE.md: DEV protocol auto-loads for all sessions"
  log "  - Path rules: domain-specific rules load only for matching files"
  log "  - CLAUDE.local.md: personalize your preferences (auto-gitignored)"
  log "  - Auto-memory: quickstart guide seeded for new users"
}

# ──────────────────────────────────────────────
# Uninstall
# ──────────────────────────────────────────────
uninstall() {
  warn "Removing Artibot..."

  # Remove agents that came from artibot
  for agent in "${SCRIPT_DIR}"/agents/*.md; do
    [ -f "$agent" ] || continue
    local basename
    basename=$(basename "$agent")
    rm -f "${CLAUDE_DIR}/agents/${basename}"
  done

  # Remove commands that came from artibot
  for cmd in "${SCRIPT_DIR}"/commands/*.md; do
    [ -f "$cmd" ] || continue
    local basename
    basename=$(basename "$cmd")
    rm -f "${CLAUDE_DIR}/commands/${basename}"
  done

  # Remove artibot rules
  rm -rf "${CLAUDE_DIR}/rules/artibot"

  # Remove artibot directory
  rm -rf "${ARTIBOT_DIR}"

  # Note: CLAUDE.md, CLAUDE.local.md, and auto-memory are left intact
  # (they may contain user customizations)
  log "Artibot uninstalled. MCP config, settings.json, CLAUDE.md, and auto-memory left unchanged."
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
main() {
  echo -e "${BLUE}━━━ Artibot Installer v1.6.0 ━━━${NC}"
  echo ""

  case "${1:-install}" in
    install)
      check_prerequisites
      setup_directories
      install_agents
      install_commands
      install_skills
      install_hooks
      install_rules
      install_mcp
      configure_settings
      seed_project_claude_md
      seed_local_config
      seed_auto_memory
      verify_install
      ;;
    uninstall)
      uninstall
      ;;
    *)
      echo "Usage: ./install.sh [install|uninstall]"
      exit 1
      ;;
  esac
}

main "$@"
