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

  local agent_count cmd_count skill_count hook_count
  agent_count=$(find "${CLAUDE_DIR}/agents" -name "*.md" -type f 2>/dev/null | wc -l)
  cmd_count=$(find "${CLAUDE_DIR}/commands" -name "*.md" -type f 2>/dev/null | wc -l)
  skill_count=$(find "${ARTIBOT_DIR}/skills" -maxdepth 1 -type d 2>/dev/null | wc -l)
  skill_count=$((skill_count - 1))
  hook_count=$(find "${ARTIBOT_DIR}/scripts/hooks" -name "*.js" -type f 2>/dev/null | wc -l)

  echo -e "  Agents:   ${GREEN}${agent_count}${NC} files in ~/.claude/agents/"
  echo -e "  Commands: ${GREEN}${cmd_count}${NC} files in ~/.claude/commands/"
  echo -e "  Skills:   ${GREEN}${skill_count}${NC} dirs in ~/.claude/artibot/skills/"
  echo -e "  Hooks:    ${GREEN}${hook_count}${NC} scripts in ~/.claude/artibot/scripts/"
  echo ""
  log "Installation complete! Start Claude Code and type: /sc hello"
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

  # Remove artibot directory
  rm -rf "${ARTIBOT_DIR}"

  log "Artibot uninstalled. MCP config and settings.json left unchanged."
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
      install_mcp
      configure_settings
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
