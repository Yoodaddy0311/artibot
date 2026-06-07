#!/usr/bin/env bash
# Artibot Installer - Claude Code Plugin
# Copies agents, commands, skills, hooks to ~/.claude/ for native integration
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME:-${USERPROFILE:-$(eval echo ~)}}/.claude"
ARTIBOT_DIR="${CLAUDE_DIR}/artibot"

# Minimum Node major. Lockstep with package.json#/engines/node (">=20") and
# scripts/install.sh / scripts/install.ps1 MIN_NODE_MAJOR. Bumped 18 -> 20 to
# match the per-plugin installer and prevent split-policy installs where the
# bootstrap rejects the runtime that this installer would accept.
MIN_NODE_MAJOR=20

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
    err "Node.js not found. Install: https://nodejs.org/ (v${MIN_NODE_MAJOR}+)"
    exit 1
  fi

  local node_version
  node_version=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$node_version" -lt "$MIN_NODE_MAJOR" ]; then
    err "Node.js ${MIN_NODE_MAJOR}+ required. Current: $(node -v)"
    exit 1
  fi

  log "Prerequisites OK (Claude Code + Node.js $(node -v))"
}

# ──────────────────────────────────────────────
# Safe recursive copy (exclude node_modules / .git)
# ──────────────────────────────────────────────
# Fresh-machine install used to copy node_modules/ (hundreds of MB, sometimes
# with Windows-incompatible symlinks) which hung or failed with EPERM. Always
# exclude node_modules and .git from recursive copies. Prefer rsync when
# available; fall back to a find+cp loop that respects the exclude list.
safe_copy_dir() {
  local src="$1"
  local dst="$2"
  if command -v rsync &>/dev/null; then
    rsync -a --exclude='node_modules' --exclude='.git' "${src}/" "${dst}/"
    return $?
  fi
  mkdir -p "${dst}"
  local base
  base="$(cd "${src}" && pwd)"
  find "${base}" -mindepth 1 \( -name node_modules -o -name .git \) -prune -o -print 2>/dev/null | while IFS= read -r entry; do
    local rel="${entry#${base}/}"
    [ "${rel}" = "${base}" ] && continue
    if [ -d "${entry}" ]; then
      mkdir -p "${dst}/${rel}"
    else
      mkdir -p "$(dirname "${dst}/${rel}")"
      cp "${entry}" "${dst}/${rel}"
    fi
  done
}

# ──────────────────────────────────────────────
# Self-install guard
# ──────────────────────────────────────────────
# When update.js falls back to the INSTALLED copy of install.sh
# (~/.claude/artibot/install.sh) — e.g. the source repo pull failed — then
# SCRIPT_DIR resolves to ARTIBOT_DIR itself. Every `cp -r "${SCRIPT_DIR}/X"
# "${ARTIBOT_DIR}/"` becomes a copy-onto-self ("cp: 'a' and 'a' are the same
# file") which `set -e` turns into a hard install failure.
#
# Detect that case and skip the file-copy phases (the files are already in
# place — it's a no-op, not an error). Config/settings/seed steps below still
# run normally.
#
# Uses `-ef` (same inode/device) when available; falls back to canonicalized
# `pwd -P` comparison for Git Bash on Windows where `-ef` semantics can differ
# across mounted drives.
is_self_install() {
  if [ "${SCRIPT_DIR}" -ef "${ARTIBOT_DIR}" ] 2>/dev/null; then
    return 0
  fi
  local src_real dst_real
  src_real="$(cd "${SCRIPT_DIR}" 2>/dev/null && pwd -P)" || return 1
  dst_real="$(cd "${ARTIBOT_DIR}" 2>/dev/null && pwd -P)" || return 1
  [ -n "$src_real" ] && [ "$src_real" = "$dst_real" ]
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
# Copy Agents (28 agent .md files)
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
    safe_copy_dir "${SCRIPT_DIR}/skills" "${ARTIBOT_DIR}/skills"
    count=$(find "${SCRIPT_DIR}/skills" -maxdepth 1 -type d | wc -l)
    count=$((count - 1))
  fi
  log "Skills installed: ${count} skills → ~/.claude/artibot/skills/"
}

# ──────────────────────────────────────────────
# Copy Hooks & Scripts
# ──────────────────────────────────────────────
install_hooks() {
  # Clean before copy to prevent stale files from previous versions
  for dir in hooks scripts lib output-styles; do
    [ -d "${ARTIBOT_DIR}/${dir}" ] && rm -rf "${ARTIBOT_DIR}/${dir}"
  done

  safe_copy_dir "${SCRIPT_DIR}/hooks" "${ARTIBOT_DIR}/hooks"
  safe_copy_dir "${SCRIPT_DIR}/scripts" "${ARTIBOT_DIR}/scripts"
  safe_copy_dir "${SCRIPT_DIR}/lib" "${ARTIBOT_DIR}/lib"
  [ -d "${SCRIPT_DIR}/output-styles" ] && safe_copy_dir "${SCRIPT_DIR}/output-styles" "${ARTIBOT_DIR}/output-styles"

  # Copy .claude-plugin metadata (plugin.json, swarm-profile.json, etc.)
  # This is needed so swarm-autodetect can find swarm-profile.json after update.
  if [ -d "${SCRIPT_DIR}/.claude-plugin" ]; then
    safe_copy_dir "${SCRIPT_DIR}/.claude-plugin" "${ARTIBOT_DIR}/.claude-plugin"
  fi

  # Copy config files
  cp "${SCRIPT_DIR}/artibot.config.json" "${ARTIBOT_DIR}/"
  [ -f "${SCRIPT_DIR}/package.json" ] && cp "${SCRIPT_DIR}/package.json" "${ARTIBOT_DIR}/"

  # Copy install.sh itself so update.js can find it after cache clear
  cp "${SCRIPT_DIR}/install.sh" "${ARTIBOT_DIR}/"

  log "Hooks & scripts installed → ~/.claude/artibot/"
}

# ──────────────────────────────────────────────
# Mirror to Claude Code marketplace install
# ──────────────────────────────────────────────
# Claude Code's plugin system maintains its own install copy at
#   ~/.claude/plugins/marketplaces/artibot/plugins/artibot/
# Every project session reads hooks from THAT path (via CLAUDE_PLUGIN_ROOT),
# not from ~/.claude/artibot/. Skipping this mirror leaves the marketplace
# at whatever version Claude Code last fetched (often months stale), causing
# silent hook regressions in other projects after a manual update here.
#
# Legacy-stub policy: when a hook file is removed across versions (e.g.
# check-console-log.js was consolidated into dev-verify-gate.js in v4.7.2),
# leave a no-op stub at its original path. Existing Claude Code sessions
# cache the v3.0.0 hooks.json in memory and will try to exec the removed
# file on the next Stop event — MODULE_NOT_FOUND crashes the dispatcher.
# Stubs keep those in-flight sessions alive until they restart.
install_marketplace_mirror() {
  local mkt_root="${CLAUDE_DIR}/plugins/marketplaces/artibot/plugins/artibot"
  if [ ! -d "${mkt_root}" ]; then
    log "Marketplace install not present (skip mirror)"
    return 0
  fi

  # Mirror the hot paths from the direct install we just wrote.
  # Same clean-before-copy contract as install_hooks for parity.
  for dir in scripts hooks lib skills output-styles .claude-plugin; do
    if [ -d "${ARTIBOT_DIR}/${dir}" ]; then
      [ -d "${mkt_root}/${dir}" ] && rm -rf "${mkt_root}/${dir}"
      safe_copy_dir "${ARTIBOT_DIR}/${dir}" "${mkt_root}/${dir}"
    fi
  done

  # Commands and agents live only in the source repo (direct install omits
  # them — Claude Code reads them straight from marketplace path). Pull them
  # from the source repo, not from ${ARTIBOT_DIR}.
  for dir in commands agents; do
    if [ -d "${SCRIPT_DIR}/${dir}" ]; then
      [ -d "${mkt_root}/${dir}" ] && rm -rf "${mkt_root}/${dir}"
      safe_copy_dir "${SCRIPT_DIR}/${dir}" "${mkt_root}/${dir}"
    fi
  done

  cp "${SCRIPT_DIR}/artibot.config.json" "${mkt_root}/"
  [ -f "${SCRIPT_DIR}/package.json" ] && cp "${SCRIPT_DIR}/package.json" "${mkt_root}/"
  log "Marketplace mirror updated → ${mkt_root}"
}

# ──────────────────────────────────────────────
# Mirror to Claude Code plugin cache (per-version dirs)
# ──────────────────────────────────────────────
# Claude Code maintains a per-version plugin cache at
#   ~/.claude/plugins/cache/artibot/artibot/<version>/
# At session start it loads hooks.json from THE CACHE DIR — not the
# marketplace mirror or the direct install. The cache is populated lazily
# from the marketplace mirror on first plugin activation and is NOT
# refreshed by install.sh writing only to the marketplace path. The
# v4.6.4 → v4.8.2 hook regression went unnoticed for so long precisely
# because users' caches held v4.6.4 args[] schema while the marketplace
# mirror had moved on.
#
# Mirroring the hot paths into every cache version dir keeps future
# sessions (post-restart) consistent. We do NOT touch .claude-plugin/plugin.json
# inside the cache (its version field is the cache routing key — overwriting
# it would orphan the cache entry from Claude Code's perspective). We also
# do NOT delete the cache dir here — clearCache() in scripts/update.js
# handles invalidation after an install. The split keeps install.sh
# non-destructive on a fresh-install path while still propagating runtime
# files to whatever cache versions already exist.
install_plugin_cache() {
  local cache_root="${CLAUDE_DIR}/plugins/cache/artibot/artibot"
  if [ ! -d "${cache_root}" ]; then
    log "Plugin cache not present (skip cache sync)"
    return 0
  fi

  local synced=0
  for version_dir in "${cache_root}"/*/; do
    [ -d "${version_dir}" ] || continue
    local v_root="${version_dir%/}"

    # Mirror runtime hot paths only (NOT .claude-plugin to preserve plugin.json
    # version routing key). Same clean-before-copy contract as the marketplace
    # mirror for parity.
    for dir in scripts hooks lib output-styles; do
      if [ -d "${ARTIBOT_DIR}/${dir}" ]; then
        [ -d "${v_root}/${dir}" ] && rm -rf "${v_root}/${dir}"
        safe_copy_dir "${ARTIBOT_DIR}/${dir}" "${v_root}/${dir}"
      fi
    done

    # Config files are version-tagged but the cache dir name is the routing
    # key — overwriting these is safe (cache invariant lives in plugin.json
    # which we deliberately leave alone).
    [ -f "${SCRIPT_DIR}/artibot.config.json" ] && cp "${SCRIPT_DIR}/artibot.config.json" "${v_root}/"
    [ -f "${SCRIPT_DIR}/package.json" ] && cp "${SCRIPT_DIR}/package.json" "${v_root}/"

    synced=$((synced + 1))
  done

  if [ "$synced" -gt 0 ]; then
    log "Plugin cache synced: ${synced} version dir(s) → ${cache_root}/"
  else
    log "Plugin cache directory present but contained no version dirs (skip)"
  fi
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
  local target_dir="${1:-.}"
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
  local target_dir="${1:-.}"
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
    else
      warn "No .gitignore found — CLAUDE.local.md may be accidentally committed"
    fi
  else
    warn "CLAUDE.local.md.template not found at ${SCRIPT_DIR}/templates/ — skipping seed"
  fi
}

# ──────────────────────────────────────────────
# Seed Auto-Memory for new users
# ──────────────────────────────────────────────
seed_auto_memory() {
  local memory_dir="${CLAUDE_DIR}/projects"
  # Find the current project's memory directory
  # Claude Code hashes paths: replace / \ : with -, strip leading -
  # On Git Bash, $PWD is /c/Users/... so normalize to C:\Users\... first
  local normalized_path="$PWD"
  if [[ "$normalized_path" =~ ^/([a-zA-Z])/ ]]; then
    normalized_path="${BASH_REMATCH[1]^^}:${normalized_path:2}"
  fi
  local project_hash
  # Include space in the char class — Claude Code's projects/ hash also
  # replaces spaces (Korean paths like "바탕 화면" contain a space + non-ASCII).
  # Without this, the computed hash dir won't exist and seeding silently misses.
  project_hash=$(echo "$normalized_path" | sed 's/[ \/:\\]/-/g' | sed 's/^-//')

  # Fallback: if computed hash dir doesn't exist, search for existing match
  if [ ! -d "${memory_dir}/${project_hash}" ] && [ -d "$memory_dir" ]; then
    local existing_match
    existing_match=$(find "$memory_dir" -maxdepth 1 -type d -name "*$(basename "$PWD")" 2>/dev/null | head -1)
    if [ -n "$existing_match" ]; then
      project_hash=$(basename "$existing_match")
    fi
  fi
  local project_memory="${memory_dir}/${project_hash}/memory"

  # Only seed if no MEMORY.md exists yet
  if [ -d "$project_memory" ] && [ -f "${project_memory}/MEMORY.md" ]; then
    log "Auto-memory already exists — skipping seed"
    return
  fi

  # Count actual installed assets for accurate memory seed
  local mem_agent_count mem_cmd_count mem_skill_count
  mem_agent_count=$(find "${CLAUDE_DIR}/agents" -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
  mem_cmd_count=$(find "${CLAUDE_DIR}/commands" -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
  mem_skill_count=$(find "${ARTIBOT_DIR}/skills" -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  mem_skill_count=$((mem_skill_count - 1))

  mkdir -p "$project_memory"
  cat > "${project_memory}/MEMORY.md" <<SEED_MEMORY
# Project Memory (Seeded by Artibot)

## Artibot Quick Reference
- **Agents**: ${mem_agent_count} specialized agents — use \`Task()\` to delegate
- **Commands**: \`/sc\` routes to optimal command/agent/skill automatically
- **DEV Protocol**: Decompose → Execute → Verify (mandatory for all code changes)
- **Quality**: 80%+ test coverage, immutable patterns, functions < 50 lines

## Workflow Tips
- Complex features: start with \`/sc plan [feature]\` or use planner agent
- After implementation: code-reviewer agent runs automatically via rules
- Parallel work: launch multiple agents with \`Task()\` for independent tasks
- Vibe coding: rules auto-activate on file access (no /sc needed after install)

## Key Paths
- Agents: \`~/.claude/agents/\` (${mem_agent_count} .md files)
- Commands: \`~/.claude/commands/\` (${mem_cmd_count} .md files)
- Skills: \`~/.claude/artibot/skills/\` (${mem_skill_count} skill directories)
- Rules: \`~/.claude/rules/artibot/\` (auto-activate on file access)
- Config: \`~/.claude/artibot/artibot.config.json\`
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
    # Register statusLine if not already present
    _register_statusline "$settings_file"
  else
    cat > "$settings_file" <<'SETTINGS'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/artibot/scripts/hooks/statusline.sh",
    "padding": 2
  }
}
SETTINGS
    chmod 600 "$settings_file"
    log "Settings created with Agent Teams enabled and statusLine registered"
  fi
}

# ──────────────────────────────────────────────
# Register statusLine in an existing settings.json
# Skips if statusLine key already present.
# Uses jq if available, falls back to Node.js.
# ──────────────────────────────────────────────
_register_statusline() {
  local settings_file="$1"

  # Skip if already registered
  if grep -q '"statusLine"' "$settings_file" 2>/dev/null; then
    log "statusLine already registered in settings.json — skipping"
    return
  fi

  local statusline_json='"statusLine": { "type": "command", "command": "bash ~/.claude/artibot/scripts/hooks/statusline.sh", "padding": 2 }'

  if command -v jq &>/dev/null; then
    # jq available: merge cleanly
    local tmp_file="${settings_file}.tmp.$$"
    jq '. + {"statusLine": {"type": "command", "command": "bash ~/.claude/artibot/scripts/hooks/statusline.sh", "padding": 2}}' \
      "$settings_file" > "$tmp_file" && mv "$tmp_file" "$settings_file"
    log "statusLine registered in settings.json (via jq)"
  elif command -v node &>/dev/null; then
    # Node.js fallback: read, merge, write atomically
    ARTIBOT_SETTINGS="$settings_file" node --input-type=commonjs -e "
      const fs = require('fs');
      const path = process.env.ARTIBOT_SETTINGS;
      const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (!cfg.statusLine) {
        cfg.statusLine = { type: 'command', command: 'bash ~/.claude/artibot/scripts/hooks/statusline.sh', padding: 2 };
        const tmp = path + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
        fs.renameSync(tmp, path);
      }
    "
    log "statusLine registered in settings.json (via node)"
  else
    warn "Neither jq nor node available — add statusLine manually to ~/.claude/settings.json:"
    echo -e "${BLUE}  ${statusline_json}${NC}"
  fi
}

# ──────────────────────────────────────────────
# Swarm Intelligence Opt-In
# ──────────────────────────────────────────────
setup_swarm_consent() {
  # Skip if already configured (prevent repeated prompts on re-install)
  if [ -f "${ARTIBOT_DIR}/swarm-consent.json" ]; then
    log "Swarm consent already configured — skipping"
    return
  fi

  # Skip in non-interactive mode (CI, piped input, etc.)
  if [ ! -t 0 ]; then
    warn "Non-interactive mode — swarm disabled by default. Use '/sc swarm opt-in' later."
    return
  fi

  echo ""
  echo -e "${BLUE}━━━ Swarm Intelligence ━━━${NC}"
  echo "Share anonymized learning patterns with the Artibot community."
  echo "  • Tool usage success rates (anonymized)"
  echo "  • Error pattern signatures (SHA-256 hashed)"
  echo "  • Differential privacy noise applied (ε=1.0)"
  echo "  • No source code, file paths, or PII shared"
  echo ""
  read -p "Enable Swarm Intelligence? [y/N] " swarm_choice

  if [[ "$swarm_choice" =~ ^[Yy]$ ]]; then
    local consent_dir="${ARTIBOT_DIR}"
    mkdir -p "$consent_dir"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    cat > "${consent_dir}/swarm-consent.json" <<SWARMEOF
{
  "optedIn": true,
  "optedInAt": "$timestamp",
  "optedOutAt": null
}
SWARMEOF

    # Enable swarm in installed config so isSwarmActive() returns true
    local config_file="${ARTIBOT_DIR}/artibot.config.json"
    if [ -f "$config_file" ] && command -v node &>/dev/null; then
      ARTIBOT_CONFIG_FILE="$config_file" node --input-type=commonjs -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync(process.env.ARTIBOT_CONFIG_FILE, 'utf8'));
        if (cfg.swarm) { cfg.swarm.enabled = true; cfg.swarm.optIn = true; }
        fs.writeFileSync(process.env.ARTIBOT_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
      "
    fi

    log "Swarm Intelligence enabled. Use '/sc swarm opt-out' to disable."
  else
    echo -e "  ${GREEN}✓${NC} Swarm Intelligence skipped. Use '/sc swarm opt-in' to enable later."
  fi
}

# ──────────────────────────────────────────────
# Auto-Learning Pipeline Setup (zero-config auto-register)
# Priority: claude schedule > crontab > schtasks > hint-only
# ──────────────────────────────────────────────

# Read schedule cron expression from config
_get_auto_learning_schedule() {
  ARTIBOT_CFG="${ARTIBOT_DIR}/artibot.config.json" node --input-type=commonjs -e \
    "const c=JSON.parse(require('fs').readFileSync(process.env.ARTIBOT_CFG,'utf8')); console.log(c.autoLearning?.schedule||'0 3 * * *')" 2>/dev/null || echo "0 3 * * *"
}

# Check if autoLearning is enabled in config
_is_auto_learning_enabled() {
  ARTIBOT_CFG="${ARTIBOT_DIR}/artibot.config.json" node --input-type=commonjs -e \
    "const c=JSON.parse(require('fs').readFileSync(process.env.ARTIBOT_CFG,'utf8')); process.exit(c.autoLearning?.enabled===true?0:1)" 2>/dev/null
}

# Write marker file to prevent duplicate registration
_write_auto_learning_marker() {
  local marker="$1" method="$2" schedule="$3"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  MARKER_FILE="$marker" MARKER_TS="$timestamp" MARKER_SCHED="$schedule" MARKER_METHOD="$method" \
  node --input-type=commonjs -e "
    const fs = require('fs');
    fs.writeFileSync(process.env.MARKER_FILE, JSON.stringify({
      registeredAt: process.env.MARKER_TS,
      schedule: process.env.MARKER_SCHED,
      method: process.env.MARKER_METHOD
    }, null, 2) + '\n');
  " 2>/dev/null || true
}

# Strategy 1: claude schedule (persistent, cross-platform)
_try_claude_schedule() {
  local schedule="$1"
  if ! command -v claude &>/dev/null; then
    return 1
  fi

  # Build the pipeline prompt
  local prompt
  prompt="Run the Artibot auto-learning pipeline: self-scan, pattern-extract, knowledge-update, skill-refinement. Auto-commit and push if changes found."

  claude schedule create \
    --cron "$schedule" \
    --project "${ARTIBOT_DIR}" \
    --prompt "$prompt" \
    &>/dev/null

  return $?
}

# Strategy 2: crontab (Linux/macOS)
_try_crontab() {
  local schedule="$1"
  if ! command -v crontab &>/dev/null; then
    return 1
  fi

  local runner_path="${ARTIBOT_DIR}/scripts/run-auto-learning.js"
  if [ ! -f "$runner_path" ]; then
    return 1
  fi

  local cron_comment="# artibot-auto-learning"
  local cron_line="${schedule} cd ${ARTIBOT_DIR} && node scripts/run-auto-learning.js >> /tmp/artibot-auto-learning.log 2>&1 ${cron_comment}"

  # Check if already in crontab (idempotent)
  if crontab -l 2>/dev/null | grep -q "artibot-auto-learning"; then
    return 0
  fi

  # Append to existing crontab
  ( crontab -l 2>/dev/null; echo "$cron_line" ) | crontab - 2>/dev/null
  return $?
}

# Strategy 3: schtasks (Windows)
_try_schtasks() {
  if ! command -v schtasks.exe &>/dev/null && ! command -v schtasks &>/dev/null; then
    return 1
  fi

  local runner_path="${ARTIBOT_DIR}/scripts/run-auto-learning.js"
  if [ ! -f "$runner_path" ]; then
    return 1
  fi

  local task_name="ArtibotAutoLearning"

  # Check if already registered (idempotent)
  if schtasks.exe /Query /TN "$task_name" &>/dev/null 2>&1 || schtasks /Query /TN "$task_name" &>/dev/null 2>&1; then
    return 0
  fi

  # Convert ARTIBOT_DIR to Windows path for schtasks
  local win_artibot_dir
  win_artibot_dir=$(cygpath -w "$ARTIBOT_DIR" 2>/dev/null || echo "$ARTIBOT_DIR")

  local node_path
  node_path=$(which node 2>/dev/null || command -v node 2>/dev/null)
  local win_node_path
  win_node_path=$(cygpath -w "$node_path" 2>/dev/null || echo "$node_path")

  local win_runner
  win_runner=$(cygpath -w "$runner_path" 2>/dev/null || echo "$runner_path")

  # Create daily task at 03:00
  local schtasks_cmd="schtasks.exe"
  command -v schtasks.exe &>/dev/null || schtasks_cmd="schtasks"

  $schtasks_cmd /Create \
    /TN "$task_name" \
    /TR "\"${win_node_path}\" \"${win_runner}\"" \
    /SC DAILY \
    /ST 03:00 \
    /F \
    &>/dev/null 2>&1

  return $?
}

setup_auto_learning() {
  local marker="${ARTIBOT_DIR}/auto-learning-registered.json"

  # Skip if already registered
  if [ -f "$marker" ]; then
    log "Auto-learning schedule already registered — skipping"
    return
  fi

  # Check if auto-learning is enabled
  if ! _is_auto_learning_enabled; then
    log "Auto-learning pipeline disabled in config — skipping"
    return
  fi

  local schedule
  schedule=$(_get_auto_learning_schedule)
  local method="none"
  local success=false

  echo ""
  echo -e "${BLUE}━━━ Auto-Learning Pipeline ━━━${NC}"
  echo "Setting up automatic learning schedule: ${schedule}"

  # Strategy 1: claude schedule
  if _try_claude_schedule "$schedule" 2>/dev/null; then
    method="claude-schedule"
    success=true
    log "Auto-learning registered via claude schedule (persistent)"
  fi

  # Strategy 2: crontab (Linux/macOS)
  if [ "$success" = false ] && _try_crontab "$schedule" 2>/dev/null; then
    method="crontab"
    success=true
    log "Auto-learning registered via crontab"
  fi

  # Strategy 3: schtasks (Windows)
  if [ "$success" = false ] && _try_schtasks 2>/dev/null; then
    method="schtasks"
    success=true
    log "Auto-learning registered via Windows Task Scheduler"
  fi

  # Fallback: hint only
  if [ "$success" = false ]; then
    method="hint-only"
    warn "Could not auto-register schedule. Options:"
    echo -e "  ${BLUE}1)${NC} In Claude session: use CronCreate tool"
    echo -e "  ${BLUE}2)${NC} Manual: node ~/.claude/artibot/scripts/setup-auto-learning.js --schedule"
    echo -e "  ${BLUE}3)${NC} CI: node ~/.claude/artibot/scripts/setup-auto-learning.js --webhook"
  fi

  # Write marker regardless (prevents re-prompting)
  _write_auto_learning_marker "$marker" "$method" "$schedule"

  if [ "$success" = true ]; then
    log "Auto-learning pipeline active: ${schedule} via ${method}"
  fi
}

# ──────────────────────────────────────────────
# Save Source Repo Path (for auto-update git pull)
# ──────────────────────────────────────────────
save_source_path() {
  local source_json="${ARTIBOT_DIR}/source-repo.json"
  local git_root
  git_root="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null)" || true

  if [ -n "$git_root" ]; then
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    REPO_ROOT="$git_root" PLUGIN_DIR="$SCRIPT_DIR" SAVE_AT="$timestamp" SOURCE_JSON="$source_json" \
    node --input-type=commonjs -e "
      const fs = require('fs');
      fs.writeFileSync(process.env.SOURCE_JSON, JSON.stringify({
        repoRoot: process.env.REPO_ROOT,
        pluginDir: process.env.PLUGIN_DIR,
        savedAt: process.env.SAVE_AT
      }, null, 2) + '\n');
    "
    log "Source repo path saved for auto-updates: ${git_root}"
  else
    warn "Not a git repo — source path not saved (manual git pull needed for updates)"
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
  local version
  version=$(ARTIBOT_CFG="${SCRIPT_DIR}/artibot.config.json" node --input-type=commonjs -e \
    "console.log(JSON.parse(require('fs').readFileSync(process.env.ARTIBOT_CFG,'utf8')).version)" 2>/dev/null || echo "unknown")
  echo -e "${BLUE}━━━ Artibot Installer v${version} ━━━${NC}"
  echo ""

  case "${1:-install}" in
    install)
      check_prerequisites
      setup_directories
      if is_self_install; then
        warn "Running from the installed location (${ARTIBOT_DIR}) — files already in place."
        warn "Skipping copy phase (no-op); continuing with config & seed steps."
      else
        install_agents
        install_commands
        install_skills
        install_hooks
        install_marketplace_mirror
        install_plugin_cache
        install_rules
      fi
      install_mcp
      configure_settings
      seed_project_claude_md
      seed_local_config
      seed_auto_memory
      setup_swarm_consent
      setup_auto_learning
      save_source_path
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
